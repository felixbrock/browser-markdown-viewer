#!/usr/bin/env node
// Smoke test in a throwaway headless Brave (or Chrome) profile, driven over the
// DevTools protocol. Needs node 22 or newer, no packages.
//
//   node scripts/smoke-test.mjs --file /path/to/note.md [--browser /opt/brave/brave] [--port 9444] [--out /tmp/mdv-test]
//
// Copies the file into the output folder, loads the extension unpacked, opens the
// copy, then exercises rendering, the breadcrumb chord, the picker, the filter,
// the folder crumb, the jump back to the editor, live reload and tab reuse.
// Screenshots land in the output folder.

import { spawn } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, part, index, all) => {
    if (part.startsWith("--")) {
      pairs.push([part.slice(2), all[index + 1]]);
    }
    return pairs;
  }, [])
);
const browser = args.browser || "/opt/brave/brave";
const port = Number(args.port || 9444);
const out = resolve(args.out || "/tmp/mdv-smoke");
const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!args.file) {
  console.error("--file is required");
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "profile"), { recursive: true });
mkdirSync(join(out, "docs", "nested"), { recursive: true });
const testFile = join(out, "docs", basename(args.file));
copyFileSync(resolve(args.file), testFile);
writeFileSync(
  join(out, "docs", "nested", "other.md"),
  "# Other\n\nSecond file.\n\n```python\ndef greet(name):\n    return \"hi \" + name\n```\n\n- [ ] open task\n- [x] done task\n"
);
if (args.git) {
  mkdirSync(join(out, "docs", ".git"), { recursive: true });
}

// The ctrl+t suggestion is never applied automatically (Chromium keeps its own
// accelerators), so seed the profile with the assignment the shortcuts page
// would write. The unpacked extension id is derived from the folder path.
const extensionId = createHash("sha256")
  .update(extensionDir)
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
mkdirSync(join(out, "profile", "Default"), { recursive: true });
writeFileSync(
  join(out, "profile", "Default", "Preferences"),
  JSON.stringify({ extensions: { commands: { "linux:Ctrl+T": { command_name: "go-to-section", extension: extensionId, global: false } } } })
);
const fileUrl = "file://" + testFile;

// ctrl+shift+v runs bin/editor-host over native messaging. The browser looks
// for host manifests in its config dir under XDG_CONFIG_HOME (not under the
// profile given with --user-data-dir), so a throwaway config home is seeded
// with the manifest for Brave, Chrome and Chromium. The host talks to a fake
// VS Code main socket served below that records the requests, falls back to
// a stub editor that records its arguments in place of code, skips the i3
// focusing, and reads a seeded state file that records the folder the test
// file was launched from.
const editorStub = join(out, "editor-stub");
const editorArgsFile = join(out, "editor-args.txt");
writeFileSync(editorStub, "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + JSON.stringify(editorArgsFile) + "\n", { mode: 0o755 });
const stateFile = join(out, "workspaces.json");
writeFileSync(stateFile, JSON.stringify({ version: 1, files: { [testFile]: { folder: join(out, "docs"), time: Date.now() / 1000 } } }));
const hostPath = join(extensionDir, "bin", "editor-host");
const configHome = join(out, "config");
for (const vendor of ["BraveSoftware/Brave-Browser", "google-chrome", "chromium"]) {
  const hostsDir = join(configHome, vendor, "NativeMessagingHosts");
  mkdirSync(hostsDir, { recursive: true });
  writeFileSync(
    join(hostsDir, "browser_markdown_viewer.json"),
    JSON.stringify({ name: "browser_markdown_viewer", description: "smoke test host", path: hostPath, type: "stdio", allowed_origins: ["chrome-extension://" + extensionId + "/"] })
  );
}
// a Unix socket path holds about a hundred bytes, so the fake VS Code socket
// lives in the runtime dir (where VS Code keeps its own) and not under out
const vscodeSocket = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "mdv-smoke-" + process.pid + ".sock");
const hostEnv = {
  ...process.env,
  XDG_CONFIG_HOME: configHome,
  BROWSER_MARKDOWN_VIEWER_SOCKET: vscodeSocket,
  BROWSER_MARKDOWN_VIEWER_EDITOR: editorStub,
  BROWSER_MARKDOWN_VIEWER_STATE: stateFile,
  BROWSER_MARKDOWN_VIEWER_NO_FOCUS: "1"
};
// a socket path nothing listens on, the host then runs the stub editor
const cliEnv = { ...hostEnv, BROWSER_MARKDOWN_VIEWER_SOCKET: vscodeSocket + ".none" };

// The fake VS Code main socket, the wire format is described in
// bin/vscode_ipc.py. Every launch.start request lands in vscodeRequests.
function varint(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}
function vscSerialize(data) {
  if (data === undefined) {
    return Buffer.from([0]);
  }
  if (typeof data === "string") {
    const raw = Buffer.from(data);
    return Buffer.concat([Buffer.from([1]), varint(raw.length), raw]);
  }
  if (Array.isArray(data)) {
    return Buffer.concat([Buffer.from([4]), varint(data.length), ...data.map(vscSerialize)]);
  }
  if (Number.isInteger(data)) {
    return Buffer.concat([Buffer.from([6]), varint(data)]);
  }
  const raw = Buffer.from(JSON.stringify(data));
  return Buffer.concat([Buffer.from([5]), varint(raw.length), raw]);
}
function vscDeserialize(buf, pos) {
  const tag = buf[pos++];
  const readVarint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = buf[pos++];
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) {
        return value;
      }
    }
  };
  if (tag === 0) {
    return [undefined, pos];
  }
  if (tag === 1) {
    const length = readVarint();
    return [buf.subarray(pos, pos + length).toString(), pos + length];
  }
  if (tag === 4) {
    const count = readVarint();
    const items = [];
    for (let i = 0; i < count; i++) {
      const [item, next] = vscDeserialize(buf, pos);
      items.push(item);
      pos = next;
    }
    return [items, pos];
  }
  if (tag === 5) {
    const length = readVarint();
    return [JSON.parse(buf.subarray(pos, pos + length).toString()), pos + length];
  }
  if (tag === 6) {
    return [readVarint(), pos];
  }
  throw new Error("unexpected type tag " + tag);
}
function vscFrame(payload) {
  const header = Buffer.alloc(13);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}
const vscodeRequests = [];
const vscodeServer = createServer((connection) => {
  let pending = Buffer.alloc(0);
  let greeted = false;
  connection.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 13) {
      const length = pending.readUInt32BE(9);
      if (pending.length < 13 + length) {
        break;
      }
      const payload = pending.subarray(13, 13 + length);
      pending = pending.subarray(13 + length);
      if (!greeted) {
        greeted = true;
        connection.write(vscFrame(vscSerialize([200])));
        continue;
      }
      const [header, pos] = vscDeserialize(payload, 0);
      const [body] = vscDeserialize(payload, pos);
      vscodeRequests.push({ channel: header[2], name: header[3], args: body });
      connection.write(vscFrame(Buffer.concat([vscSerialize([201, header[1]]), vscSerialize(undefined)])));
    }
  });
  connection.on("error", () => {});
});
rmSync(vscodeSocket, { force: true });
await new Promise((listening) => vscodeServer.listen(vscodeSocket, listening));

const failures = [];
function check(name, ok, details) {
  console.log((ok ? "PASS " : "FAIL ") + name + (details !== undefined ? "  " + JSON.stringify(details) : ""));
  if (!ok) {
    failures.push(name);
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// one framed message to the host, the reply decoded, asynchronous so the
// fake VS Code socket can answer meanwhile
function callHost(message, env = hostEnv) {
  return new Promise((done) => {
    const body = Buffer.from(JSON.stringify(message));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    const child = spawn(hostPath, [], { env });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) => {
      const output = Buffer.concat(stdout);
      if (status !== 0 || output.length < 4) {
        done({ ok: false, error: "host exited with " + status + " " + Buffer.concat(stderr) });
        return;
      }
      done(JSON.parse(output.subarray(4, 4 + output.readUInt32LE(0)).toString()));
    });
    child.stdin.end(Buffer.concat([length, body]));
  });
}
const otherFile = join(out, "docs", "nested", "other.md");
check("host answers a ping", (await callHost({ action: "ping" })).ok === true);
const viaSocket = await callHost({ action: "open", url: fileUrl, line: 7, column: 1 });
const socketRequest = vscodeRequests.at(-1);
check(
  "host opens a launched file in its recorded folder over the VS Code socket",
  viaSocket.ok === true &&
    viaSocket.via === "socket" &&
    viaSocket.folder === join(out, "docs") &&
    socketRequest !== undefined &&
    socketRequest.channel === "launch" &&
    socketRequest.name === "start" &&
    JSON.stringify(socketRequest.args[0]) === JSON.stringify({ _: [join(out, "docs"), `${testFile}:7:1`], goto: true }) &&
    socketRequest.args[1].VSCODE_CLI === "1",
  { viaSocket, socketRequest: socketRequest && { channel: socketRequest.channel, name: socketRequest.name, args: socketRequest.args[0] } }
);
const viaCli = await callHost({ action: "open", url: fileUrl, line: 7, column: 1 }, cliEnv);
check(
  "host falls back to the code CLI without a VS Code socket",
  viaCli.ok === true && viaCli.via === "cli" && viaCli.command.join(" ") === `${editorStub} ${join(out, "docs")} --goto ${testFile}:7:1` && existsSync(editorArgsFile),
  viaCli
);
const unrecorded = await callHost({ action: "open", url: "file://" + otherFile, line: 3, column: 1 }, cliEnv);
check(
  "host falls back to the git root for a file it never launched" + (args.git ? "" : ", or to no folder outside a repository"),
  unrecorded.ok === true && unrecorded.folder === (args.git ? join(out, "docs") : null) && unrecorded.command.slice(-2).join(" ") === `--goto ${otherFile}:3:1`,
  unrecorded
);
const missing = await callHost({ action: "open", url: "file:///nowhere/missing.md", line: 1, column: 1 }, cliEnv);
check("host reports a missing file", missing.ok === false && /not a file/.test(missing.error), missing);
rmSync(editorArgsFile, { force: true });

const launchArgs = [
  "--headless=new",
  "--user-data-dir=" + join(out, "profile"),
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-size=1280,900",
  ...(args.dark ? ["--force-dark-mode"] : []),
  "--load-extension=" + extensionDir,
  "--remote-debugging-port=" + port,
  fileUrl
];
const proc = spawn(browser, launchArgs, { stdio: ["ignore", "pipe", "pipe"], env: hostEnv });
proc.stderr.on("data", (chunk) => appendFileSync(join(out, "browser.log"), chunk));
proc.stdout.on("data", (chunk) => appendFileSync(join(out, "browser.log"), chunk));

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function waitForTarget(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = (await targets()).find(predicate);
      if (found) {
        return found;
      }
    } catch {
      // browser not up yet
    }
    await sleep(200);
  }
  throw new Error("target not found");
}

class Session {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", resolveReady);
      this.ws.addEventListener("error", rejectReady);
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolveCall, rejectCall } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          rejectCall(new Error(message.error.message));
        } else {
          resolveCall(message.result);
        }
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolveCall, rejectCall }));
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + " " + JSON.stringify(result.exceptionDetails.exception));
    }
    return result.result.value;
  }
  async key(key, code, vk, modifiers = 0, text) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(80);
  }
  async screenshot(name) {
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, name), Buffer.from(result.data, "base64"));
  }
  // the back or forward button on a mouse
  async mouseButton(button) {
    const buttons = button === "back" ? 8 : 16;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 300, button, buttons, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 400, y: 300, button, buttons: 0, clickCount: 1 });
    await sleep(400);
  }
  close() {
    this.ws.close();
  }
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const CHORD = MOD.ctrl | MOD.shift | MOD.alt | MOD.meta;

async function waitFor(session, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await session.evaluate(expression)) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

try {
  const target = await waitForTarget((t) => t.type === "page" && t.url.startsWith(fileUrl));
  const session = new Session(target.webSocketDebuggerUrl);
  await session.ready;
  await session.send("Page.enable");
  await session.send("Runtime.enable");

  check("page is a text render", (await session.evaluate("document.contentType")).startsWith("text/"), await session.evaluate("document.contentType"));
  check("rendered content appears", await waitFor(session, "document.querySelector('.mdv-content h1') !== null"));
  check("breadcrumb bar shows the file name", (await session.evaluate("document.querySelector('.mdv-bar').textContent")).includes(basename(testFile)));
  const diagramCount = await session.evaluate("document.querySelectorAll('.mdv-mermaid').length");
  const rendered = await waitFor(session, `document.querySelectorAll('.mdv-mermaid.mdv-rendered svg').length === ${diagramCount}`, 60000);
  check("all mermaid diagrams rendered", rendered, { diagrams: diagramCount, rendered: await session.evaluate("document.querySelectorAll('.mdv-mermaid.mdv-rendered svg').length"), errors: await session.evaluate("document.querySelectorAll('.mdv-diagram-error').length") });
  await session.screenshot("01-top.png");

  // data-color-mode, set by the color mode toggle extension, wins over the
  // system setting. Diagrams draw again in the theme of the mark.
  const systemDark = await session.evaluate("matchMedia('(prefers-color-scheme: dark)').matches");
  const themeState = `({
    bg: getComputedStyle(document.body).backgroundColor,
    diagrams: document.querySelectorAll('.mdv-mermaid.mdv-rendered svg').length,
    darkDiagrams: Array.from(document.querySelectorAll('.mdv-mermaid svg')).filter(svg => svg.innerHTML.includes('#1f2020')).length
  })`;
  const themeMatches = (dark) => `(() => { const s = ${themeState}; return s.bg === ${JSON.stringify(dark ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)")} && s.diagrams === ${diagramCount} && s.darkDiagrams === ${dark ? diagramCount : 0}; })()`;
  await session.evaluate(`document.documentElement.dataset.colorMode = ${JSON.stringify(systemDark ? "light" : "dark")}`);
  check("color mode mark overrides the system theme", await waitFor(session, themeMatches(!systemDark), 30000), await session.evaluate(themeState));
  await session.evaluate("delete document.documentElement.dataset.colorMode");
  check("without the mark the system theme returns", await waitFor(session, themeMatches(systemDark), 30000), await session.evaluate(themeState));

  const anchors = await session.evaluate(`
    Array.from(document.querySelectorAll('.mdv-content a[href^="#"]')).map(a => decodeURIComponent(a.getAttribute('href').slice(1)))
  `);
  const unresolved = await session.evaluate(`
    Array.from(document.querySelectorAll('.mdv-content a[href^="#"]')).map(a => a.getAttribute('href').slice(1)).filter(id => !document.getElementById(id) && !document.getElementById(decodeURIComponent(id)))
  `);
  check("in-page anchors resolve", unresolved.length === 0, { anchors: anchors.length, unresolved: unresolved.slice(0, 5) });

  // scroll into the document and read the heading crumbs
  await session.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.4); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(300);
  const crumbsMid = await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("heading crumbs follow the scroll position", crumbsMid.some((c) => c.startsWith("#")), crumbsMid.slice(-3));

  // chord opens the picker on the last crumb
  await session.key("End", "End", 35, CHORD);
  check("chord opens the picker", await session.evaluate("document.querySelector('.mdv-picker') !== null"));
  const selectedLabel = await session.evaluate("document.querySelector('.mdv-row.selected')?.textContent");
  check("picker selects the current heading", selectedLabel === crumbsMid[crumbsMid.length - 1], { selectedLabel });
  const rowCounts = await session.evaluate("({ total: document.querySelectorAll('.mdv-row').length, visible: document.querySelectorAll('.mdv-row:not(.hidden)').length })");
  check("outline opens collapsed apart from the current path", rowCounts.visible < rowCounts.total && rowCounts.visible > 3, rowCounts);
  const pathExpanded = await session.evaluate("Array.from(document.querySelectorAll('.mdv-row.expanded')).map(r => r.textContent)");
  check("ancestors of the current heading are expanded", pathExpanded.length === crumbsMid.filter((c) => c.startsWith("#")).length - 1, pathExpanded);
  await session.screenshot("02-picker.png");

  // left collapses or walks to the parent, right expands or walks to the first child
  await session.key("ArrowLeft", "ArrowLeft", 37);
  const afterLeft = await session.evaluate("document.querySelector('.mdv-row.selected')?.textContent");
  check("left on a leaf selects the parent", afterLeft === crumbsMid[crumbsMid.length - 2], { afterLeft });
  await session.key("ArrowLeft", "ArrowLeft", 37);
  const collapsedNow = await session.evaluate("document.querySelector('.mdv-row.selected')?.classList.contains('expanded') === false && document.querySelectorAll('.mdv-row:not(.hidden)').length");
  check("left on an expanded parent collapses it", collapsedNow && collapsedNow < rowCounts.visible, { visibleAfterCollapse: collapsedNow });
  await session.key("ArrowRight", "ArrowRight", 39);
  check("right expands a collapsed parent", await session.evaluate("document.querySelector('.mdv-row.selected')?.classList.contains('expanded')"));
  const parentLabel = await session.evaluate("document.querySelector('.mdv-row.selected')?.textContent");
  await session.key("ArrowRight", "ArrowRight", 39);
  const childLabel = await session.evaluate("document.querySelector('.mdv-row.selected')?.textContent");
  check("right on an expanded parent selects its first child", childLabel !== parentLabel && childLabel.startsWith("#"), { parentLabel, childLabel });
  await session.key(" ", "Space", 32, 0, " ");
  const spaceOnChild = await session.evaluate("({ picker: document.querySelector('.mdv-picker') !== null, expandedChild: document.querySelector('.mdv-row.selected')?.classList.contains('expanded') })");
  check("space toggles a parent or picks a leaf", spaceOnChild.picker ? spaceOnChild.expandedChild === true : true, spaceOnChild);
  if (!spaceOnChild.picker) {
    await session.key("End", "End", 35, CHORD);
  }
  await sleep(200);

  // move down twice and pick
  await session.key("ArrowDown", "ArrowDown", 40);
  await session.key("ArrowDown", "ArrowDown", 40);
  const pickedLabel = await session.evaluate("document.querySelector('.mdv-row.selected')?.textContent");
  await session.key("Enter", "Enter", 13, 0, "\r");
  await sleep(200);
  const crumbsAfterPick = await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("enter closes the picker", await session.evaluate("document.querySelector('.mdv-picker') === null"));
  check("enter jumps to the picked heading", crumbsAfterPick[crumbsAfterPick.length - 1] === pickedLabel, { pickedLabel, last: crumbsAfterPick[crumbsAfterPick.length - 1] });
  const focusReturned = await session.evaluate("document.activeElement === document.body");
  check("focus returns to the page after enter", focusReturned);

  // filter with ctrl+f
  await session.key("End", "End", 35, CHORD);
  await session.key("f", "KeyF", 70, MOD.ctrl);
  check("ctrl+f opens the filter", await session.evaluate("document.activeElement?.classList.contains('mdv-filter-input')"));
  await session.send("Input.insertText", { text: "queue" });
  await sleep(150);
  const visibleRows = await session.evaluate("Array.from(document.querySelectorAll('.mdv-row:not(.hidden)')).map(r => r.textContent)");
  check("filter narrows the outline", visibleRows.length > 0 && visibleRows.length < 40, { visible: visibleRows.length, first: visibleRows.slice(0, 4) });
  await session.screenshot("03-filter.png");
  await session.key("Enter", "Enter", 13, 0, "\r");
  await sleep(200);
  const crumbsAfterFilter = await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("enter in the filter jumps to a matching heading", crumbsAfterFilter[crumbsAfterFilter.length - 1].toLowerCase().includes("queue"), crumbsAfterFilter.slice(-2));

  // ctrl+left with the picker open walks to the file crumb and lists the folder
  await session.key("End", "End", 35, CHORD);
  const crumbCount = await session.evaluate("document.querySelectorAll('.mdv-crumb').length");
  const headingCrumbs = await session.evaluate("document.querySelectorAll('.mdv-crumb-heading').length");
  for (let step = 0; step < headingCrumbs; step++) {
    await session.key("ArrowLeft", "ArrowLeft", 37, MOD.ctrl);
  }
  await sleep(500);
  const dirRows = await session.evaluate("Array.from(document.querySelectorAll('.mdv-row')).map(r => r.textContent)");
  check("file crumb picker lists the folder", dirRows.includes(basename(testFile)) && dirRows.includes("nested/"), { rows: dirRows, crumbCount });
  check("file crumb picker selects the current file", (await session.evaluate("document.querySelector('.mdv-row.selected')?.textContent")) === basename(testFile));
  await session.screenshot("04-folder.png");
  await session.key("Escape", "Escape", 27);
  check("escape closes the picker and the bar", await session.evaluate("document.querySelector('.mdv-picker') === null && document.querySelector('.mdv-crumb.focused') === null"));

  // ctrl+t opens the section search, the VS Code goto symbol quick pick
  await session.key("t", "KeyT", 84, MOD.ctrl);
  await sleep(500);
  const pagesAfterCtrlT = (await targets()).filter((t) => t.type === "page").length;
  check("ctrl+t opens the section search instead of a new tab", pagesAfterCtrlT === 1 && (await session.evaluate("document.querySelector('.mdv-quick') !== null && document.activeElement?.classList.contains('mdv-quick-field')")), { pages: pagesAfterCtrlT });
  const initialSelected = await session.evaluate("document.querySelector('.mdv-quick-row.selected .mdv-quick-label')?.textContent");
  const crumbsNow = await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("search preselects the current heading", initialSelected === crumbsNow[crumbsNow.length - 1], { initialSelected });
  const scrollBefore = await session.evaluate("window.scrollY");
  await session.send("Input.insertText", { text: "scal data" });
  await sleep(300);
  const searchRows = await session.evaluate("Array.from(document.querySelectorAll('.mdv-quick-row .mdv-quick-label')).map(r => r.textContent)");
  check("search filters fuzzily and ranks the best hit first", searchRows[0] === "### Scaling data pipelines", searchRows.slice(0, 3));
  const firstDescription = await session.evaluate("document.querySelector('.mdv-quick-row .mdv-quick-desc')?.textContent");
  check("results show their parent heading", firstDescription === "## Scaling and reliability", { firstDescription });
  check("first row shows the result count", (await session.evaluate("document.querySelector('.mdv-quick-row .mdv-quick-count')?.textContent")) === "sections (" + searchRows.length + ")");
  check("typing previews the first match", (await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)")).slice(-1)[0] === "### Scaling data pipelines");
  check("matched characters are highlighted", await session.evaluate("document.querySelectorAll('.mdv-quick-row.selected .mdv-hl').length > 0"));
  await session.screenshot("06-search.png");
  await session.key("Escape", "Escape", 27);
  await sleep(200);
  check("escape closes the search and restores the scroll position", (await session.evaluate("window.scrollY")) === scrollBefore && (await session.evaluate("document.querySelector('.mdv-quick') === null")));
  await session.key("t", "KeyT", 84, MOD.ctrl);
  await sleep(400);
  await session.send("Input.insertText", { text: "queue workflows" });
  await sleep(300);
  const parentMatches = await session.evaluate("Array.from(document.querySelectorAll('.mdv-quick-row')).map(r => r.querySelector('.mdv-quick-label').textContent + ' | ' + (r.querySelector('.mdv-quick-desc')?.textContent || ''))");
  check("a word that misses the heading may match the parent", parentMatches.some((r) => r.startsWith("#### Job through a queue") && r.endsWith("| ### Workflows")), parentMatches.slice(0, 3));
  check("parent matches are highlighted in the description", await session.evaluate("document.querySelectorAll('.mdv-quick-row .mdv-quick-desc .mdv-hl').length > 0"));
  await session.screenshot("07-search-parent.png");
  await session.key("ArrowDown", "ArrowDown", 40);
  const previewLabel = await session.evaluate("document.querySelector('.mdv-quick-row.selected .mdv-quick-label')?.textContent");
  await session.key("Enter", "Enter", 13, 0, "\r");
  await sleep(200);
  const crumbsAfterSearch = await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("enter jumps to the selected section", crumbsAfterSearch[crumbsAfterSearch.length - 1] === previewLabel && (await session.evaluate("document.querySelector('.mdv-quick') === null")), { previewLabel });

  // alt+left and alt+right walk the position history
  const positionBeforeJump = await session.evaluate("window.scrollY");
  await session.key("ArrowLeft", "ArrowLeft", 37, MOD.alt);
  await sleep(400);
  const positionAfterBack = await session.evaluate("window.scrollY");
  check("alt+left returns to the position before the search jump", Math.abs(positionAfterBack - scrollBefore) <= 4 && positionAfterBack !== positionBeforeJump, { positionBeforeJump, positionAfterBack, scrollBefore });
  await session.key("ArrowRight", "ArrowRight", 39, MOD.alt);
  await sleep(400);
  check("alt+right goes forward again", Math.abs((await session.evaluate("window.scrollY")) - positionBeforeJump) <= 4);
  await session.key("ArrowRight", "ArrowRight", 39, MOD.alt);
  await sleep(300);
  check("alt+right at the end changes nothing", Math.abs((await session.evaluate("window.scrollY")) - positionBeforeJump) <= 4);
  // a big manual move adds an entry, a small one does not
  await session.evaluate("window.scrollBy(0, 120)");
  await sleep(500);
  const smallMove = await session.evaluate("window.scrollY");
  await session.evaluate("window.scrollTo(0, 0)");
  await sleep(500);
  await session.key("ArrowLeft", "ArrowLeft", 37, MOD.alt);
  await sleep(400);
  check("a big manual move adds an entry, a small one updates in place", Math.abs((await session.evaluate("window.scrollY")) - smallMove) <= 4, { smallMove, now: await session.evaluate("window.scrollY") });
  // anchor links add an entry
  await session.evaluate("document.querySelector('.mdv-content a[href=\"#queue\"]').click()");
  await sleep(500);
  check("an anchor link jumps", (await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)")).slice(-1)[0] === "### Queue");
  // ctrl+shift+v hands the file and the source line at the reading position to
  // the editor, here the line of the heading just jumped to, counted in the
  // file on disk with any front matter
  const queueLine = readFileSync(testFile, "utf8").split("\n").findIndex((text) => /^###\s+Queue\s*$/.test(text)) + 1;
  const requestsBefore = vscodeRequests.length;
  await session.key("V", "KeyV", 86, MOD.ctrl | MOD.shift);
  // the wait ends on a request at the fake VS Code socket or on a failure
  // notice, whichever comes first, a notice lives long enough to be read here
  const editorDeadline = Date.now() + 8000;
  let editorNotice = null;
  while (vscodeRequests.length === requestsBefore && editorNotice === null && Date.now() < editorDeadline) {
    await sleep(100);
    editorNotice = await session.evaluate("document.querySelector('.mdv-notice')?.textContent ?? null");
  }
  const editorRequest = vscodeRequests.length > requestsBefore ? vscodeRequests.at(-1).args[0] : null;
  check("ctrl+shift+v opens the file in the editor at the current line", editorRequest !== null && JSON.stringify(editorRequest) === JSON.stringify({ _: [join(out, "docs"), `${testFile}:${queueLine}:1`], goto: true }), { editorRequest, queueLine });
  check("no failure notice after the jump to the editor", editorNotice === null, { editorNotice });
  await session.key("ArrowLeft", "ArrowLeft", 37, MOD.alt);
  await sleep(400);
  check("alt+left returns from an anchor link", Math.abs((await session.evaluate("window.scrollY")) - smallMove) <= 4);
  // previews in the search leave no trace
  await session.key("t", "KeyT", 84, MOD.ctrl);
  await sleep(300);
  await session.send("Input.insertText", { text: "data" });
  await sleep(300);
  await session.key("ArrowDown", "ArrowDown", 40);
  await session.key("Escape", "Escape", 27);
  await sleep(400);
  await session.key("ArrowRight", "ArrowRight", 39, MOD.alt);
  await sleep(400);
  check("search previews leave no history entries", (await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)")).slice(-1)[0] === "### Queue");

  // the browser back and forward buttons walk the same positions
  const sentinels = await session.evaluate(
    "({ state: history.state?.mdv, len: history.length, first: (navigation.entries()[0].getState() || {}).mdv, last: (navigation.entries()[navigation.entries().length - 1].getState() || {}).mdv, index: navigation.currentEntry.index })"
  );
  check(
    "spare entries surround the current one and hash clicks add none",
    sentinels.state === "cur" && sentinels.first === "back" && sentinels.last === "fwd" && sentinels.len === 3 && sentinels.index === 1,
    sentinels
  );
  const queuePosition = await session.evaluate("window.scrollY");
  await session.mouseButton("back");
  const afterMouseBack = await session.evaluate("window.scrollY");
  check("the mouse back button returns to the previous position", Math.abs(afterMouseBack - smallMove) <= 4, { smallMove, afterMouseBack });
  await session.mouseButton("forward");
  check("the mouse forward button goes forward again", Math.abs((await session.evaluate("window.scrollY")) - queuePosition) <= 4);
  await session.mouseButton("forward");
  const forwardExhausted = await session.evaluate("({ y: window.scrollY, state: history.state?.mdv, index: navigation.currentEntry.index })");
  check("forward with nothing ahead changes nothing", Math.abs(forwardExhausted.y - queuePosition) <= 4 && forwardExhausted.state === "cur" && forwardExhausted.index === 1, forwardExhausted);
  for (let step = 0; step < 10; step++) {
    await session.mouseButton("back");
  }
  const backExhausted = await session.evaluate("({ state: history.state?.mdv, index: navigation.currentEntry.index, url: location.href })");
  check(
    "back with nothing left stays on a page the tab has no history for",
    backExhausted.state === "cur" && backExhausted.index === 1 && backExhausted.url.startsWith(fileUrl),
    backExhausted
  );

  // space on a crumb reveals without a picker
  await session.evaluate("window.scrollTo(0, 0)");
  await sleep(200);

  // live reload after the file changes on disk
  appendFileSync(testFile, "\n\n## Smoke test heading\n\nAdded by the smoke test.\n");
  const reloaded = await waitFor(session, "document.getElementById('smoke-test-heading') !== null", 8000);
  check("live reload picks up a change on disk", reloaded);

  // opening the same file again in a new tab reuses the existing tab. A second
  // browser process cannot hand over in headless mode, so the tab is created
  // over the protocol instead, the extension sees the same tabs.onCreated event.
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserSession = new Session(version.webSocketDebuggerUrl);
  await browserSession.ready;
  await browserSession.send("Target.createTarget", { url: fileUrl + "#queue" });
  await sleep(2500);
  const pages = (await targets()).filter((t) => t.type === "page" && t.url.startsWith(fileUrl));
  check("second open reuses the existing tab", pages.length === 1, { pages: pages.length });
  const crumbsAfterReuse = await session.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("reuse honours the anchor of the second open", crumbsAfterReuse[crumbsAfterReuse.length - 1] === "### Queue", crumbsAfterReuse.slice(-2));
  browserSession.close();

  // navigating to another markdown file in the folder renders too
  await session.evaluate(`location.href = ${JSON.stringify("file://" + join(out, "docs", "nested", "other.md"))}`);
  await sleep(1500);
  const otherTarget = await waitForTarget((t) => t.type === "page" && t.url.endsWith("other.md"));
  const other = new Session(otherTarget.webSocketDebuggerUrl);
  await other.ready;
  await other.send("Page.enable");
  await other.send("Runtime.enable");
  await other.evaluate("new Promise(r => setTimeout(r, 300))");
  // ctrl+t on a page without the viewer still opens a new tab
  await other.evaluate("location.href = 'about:blank'");
  await sleep(800);
  const blankTarget = await waitForTarget((t) => t.type === "page" && t.url === "about:blank");
  const blank = new Session(blankTarget.webSocketDebuggerUrl);
  await blank.ready;
  const pagesBeforeBlank = (await targets()).filter((t) => t.type === "page").length;
  await blank.key("t", "KeyT", 84, MOD.ctrl);
  await sleep(800);
  const pagesAfterBlank = (await targets()).filter((t) => t.type === "page").length;
  check("ctrl+t on a non markdown tab still opens a new tab", pagesAfterBlank === pagesBeforeBlank + 1, { before: pagesBeforeBlank, after: pagesAfterBlank });
  blank.close();
  await other.evaluate(`location.href = ${JSON.stringify("file://" + join(out, "docs", "nested", "other.md"))}`);
  await sleep(1200);
  check("second file renders", await waitFor(other, "document.querySelector('.mdv-content h1')?.textContent === 'Other'", 8000));
  check("code fences are highlighted", await other.evaluate("document.querySelectorAll('.mdv-content pre code .hljs-keyword').length > 0"));
  check("task lists render as checkboxes", await other.evaluate("document.querySelectorAll('.mdv-content li.mdv-task input[type=checkbox]').length === 2 && document.querySelectorAll('.mdv-content li.mdv-task input:checked').length === 1"));
  const otherCrumbs = await other.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("path crumbs " + (args.git ? "start below the git root" : "show the full path"), args.git ? otherCrumbs[0] === "nested" : otherCrumbs[0] === "tmp", otherCrumbs);
  await other.screenshot("05-other.png");
  // back with no position left leaves for the page the tab visited before.
  // A real page, Chromium refuses history.go onto an about:blank entry.
  writeFileSync(join(out, "docs", "plain.html"), "<title>plain</title><p>not markdown</p>\n");
  await other.evaluate(`location.href = ${JSON.stringify("file://" + join(out, "docs", "plain.html"))}`);
  await sleep(800);
  await other.evaluate(`location.href = ${JSON.stringify("file://" + join(out, "docs", "nested", "other.md"))}`);
  await waitFor(other, "document.querySelector('.mdv-content h1') !== null", 8000);
  // the ctrl+t check left its new tab active, mouse buttons act on the active tab
  await fetch(`http://127.0.0.1:${port}/json/activate/${otherTarget.id}`);
  await sleep(400);
  await other.mouseButton("back");
  await sleep(800);
  const leftFor = (await targets()).find((t) => t.id === otherTarget.id);
  check("back with nothing left leaves for the previously visited page", leftFor !== undefined && leftFor.url.endsWith("plain.html"), { url: leftFor?.url });
  other.close();
  session.close();
} catch (error) {
  check("script ran to the end", false, String(error?.stack || error));
} finally {
  vscodeServer.close();
  rmSync(vscodeSocket, { force: true });
  proc.kill("SIGTERM");
  await sleep(500);
  proc.kill("SIGKILL");
}

console.log(failures.length === 0 ? "\nALL PASSED" : "\nFAILED " + failures.join(", "));
console.log("screenshots in " + out);
process.exit(failures.length === 0 ? 0 : 1);
