#!/usr/bin/env node
// Smoke test in a throwaway headless Brave (or Chrome) profile, driven over the
// DevTools protocol. Needs node 22 or newer, no packages.
//
//   node scripts/smoke-test.mjs --file /path/to/note.md [--browser /opt/brave/brave] [--port 9444] [--out /tmp/mdv-test]
//
// Copies the file into the output folder, loads the extension unpacked, opens the
// copy, then exercises rendering, the breadcrumb chord, the picker, the filter,
// the folder crumb, live reload and tab reuse. Screenshots land in the output folder.

import { spawn } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
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
const fileUrl = "file://" + testFile;

const failures = [];
function check(name, ok, details) {
  console.log((ok ? "PASS " : "FAIL ") + name + (details !== undefined ? "  " + JSON.stringify(details) : ""));
  if (!ok) {
    failures.push(name);
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
const proc = spawn(browser, launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
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
  check("second file renders", await waitFor(other, "document.querySelector('.mdv-content h1')?.textContent === 'Other'", 8000));
  check("code fences are highlighted", await other.evaluate("document.querySelectorAll('.mdv-content pre code .hljs-keyword').length > 0"));
  check("task lists render as checkboxes", await other.evaluate("document.querySelectorAll('.mdv-content li.mdv-task input[type=checkbox]').length === 2 && document.querySelectorAll('.mdv-content li.mdv-task input:checked').length === 1"));
  const otherCrumbs = await other.evaluate("Array.from(document.querySelectorAll('.mdv-crumb')).map(c => c.textContent)");
  check("path crumbs " + (args.git ? "start below the git root" : "show the full path"), args.git ? otherCrumbs[0] === "nested" : otherCrumbs[0] === "tmp", otherCrumbs);
  await other.screenshot("05-other.png");
  other.close();
  session.close();
} catch (error) {
  check("script ran to the end", false, String(error?.stack || error));
} finally {
  proc.kill("SIGTERM");
  await sleep(500);
  proc.kill("SIGKILL");
}

console.log(failures.length === 0 ? "\nALL PASSED" : "\nFAILED " + failures.join(", "));
console.log("screenshots in " + out);
process.exit(failures.length === 0 ? 0 : 1);
