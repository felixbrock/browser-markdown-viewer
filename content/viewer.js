// Content script for local markdown files. Replaces the plain text view with
// rendered markdown, wires up the breadcrumb bar, renders mermaid fences and
// re-renders when the file changes on disk.

(() => {
  "use strict";

  const LOG_PREFIX = "[browser-markdown-viewer]";
  const EXTENSIONS = [".md", ".markdown", ".mdown"];
  const READING_OFFSET = 40;
  const POLL_MS = 1000;
  const POLL_FAILURE_LIMIT = 3;
  const SCROLL_STORE_PREFIX = "mdv-scroll:";

  if (window.__mdvBooted || location.protocol !== "file:") {
    return;
  }
  const lowerPath = location.pathname.toLowerCase();
  if (!EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
    return;
  }
  const contentType = document.contentType || "";
  if (contentType === "text/html" || !contentType.startsWith("text/")) {
    return;
  }
  window.__mdvBooted = true;

  // Hide the raw text until the rendered page replaces it.
  const hideStyle = document.createElement("style");
  hideStyle.textContent = "body > pre { visibility: hidden; }";
  document.documentElement.appendChild(hideStyle);

  const state = {
    text: "",
    md: null,
    breadcrumbs: null,
    sectionSearch: null,
    history: null,
    content: null,
    diagramCache: new Map(),
    diagramCounter: 0,
    userScrolled: false,
    polling: false,
    pollFailures: 0,
    pollTimer: null
  };

  function log(message, details) {
    if (details === undefined) {
      console.log(LOG_PREFIX, message);
    } else {
      console.log(LOG_PREFIX, message, details);
    }
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function prefersDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function hrefWithoutHash() {
    const url = new URL(location.href);
    url.hash = "";
    return url.href;
  }

  // Same rules as VS Code's githubSlugifier, so links inserted in VS Code resolve here.
  const SLUG_PUNCTUATION = /[\]\[\!\/\'\"\#\$\%\&\(\)\*\+\,\.\/\:\;\<\=\>\?\@\\\^\_\{\|\}\~\`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g;

  function slugify(text) {
    return encodeURI(
      text
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(SLUG_PUNCTUATION, "")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
    );
  }

  function inlinePlainText(children) {
    let text = "";
    for (const child of children || []) {
      if (child.type === "text" || child.type === "code_inline") {
        text += child.content;
      } else if (child.type === "softbreak" || child.type === "hardbreak") {
        text += " ";
      } else if (child.type === "image") {
        text += child.content;
      }
    }
    return text;
  }

  function stripFrontMatter(text) {
    return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  }

  function highlightCode(code, lang) {
    if (!lang || !window.hljs) {
      return "";
    }
    const language = window.hljs.getLanguage(lang) ? lang : null;
    if (!language) {
      return "";
    }
    try {
      return window.hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      return "";
    }
  }

  function createMarkdownIt() {
    const md = window.markdownit({
      html: true,
      linkify: true,
      typographer: false,
      highlight: highlightCode
    });

    md.core.ruler.push("mdv_heading_ids", (mdState) => {
      const counts = new Map();
      const tokens = mdState.tokens;
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.type !== "heading_open") {
          continue;
        }
        const inline = tokens[index + 1];
        const text = inline && inline.type === "inline" ? inlinePlainText(inline.children) : "";
        let slug = slugify(text);
        const seen = counts.get(slug);
        if (seen === undefined) {
          counts.set(slug, 0);
        } else {
          counts.set(slug, seen + 1);
          slug = slugify(text + "-" + (seen + 1));
        }
        token.attrSet("id", slug);
      }
    });

    md.core.ruler.push("mdv_task_lists", (mdState) => {
      const tokens = mdState.tokens;
      for (let index = 2; index < tokens.length; index++) {
        const inline = tokens[index];
        if (
          inline.type !== "inline" ||
          tokens[index - 1].type !== "paragraph_open" ||
          tokens[index - 2].type !== "list_item_open"
        ) {
          continue;
        }
        const match = /^\[([ xX])\]\s+/.exec(inline.content);
        const first = inline.children && inline.children[0];
        if (!match || !first || first.type !== "text" || !first.content.startsWith(match[0])) {
          continue;
        }
        first.content = first.content.slice(match[0].length);
        const box = new mdState.Token("html_inline", "", 0);
        box.content =
          '<input type="checkbox" class="mdv-task-box" disabled' +
          (match[1] === " " ? "" : " checked") +
          "> ";
        inline.children.unshift(box);
        tokens[index - 2].attrJoin("class", "mdv-task");
      }
    });

    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const lang = (token.info || "").trim().split(/\s+/)[0];
      if (lang === "mermaid") {
        return '<div class="mdv-mermaid"><pre>' + escapeHtml(token.content) + "</pre></div>\n";
      }
      return defaultFence(tokens, index, options, env, self);
    };

    return md;
  }

  function initMermaid() {
    if (!window.mermaid) {
      return;
    }
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: prefersDark() ? "dark" : "default",
      fontFamily: "system-ui, sans-serif"
    });
  }

  async function renderDiagrams() {
    if (!window.mermaid) {
      return;
    }
    const nodes = state.content.querySelectorAll(".mdv-mermaid:not(.mdv-rendered)");
    for (const node of nodes) {
      const pre = node.querySelector("pre");
      const code = pre ? pre.textContent : "";
      let svg = state.diagramCache.get(code);
      if (!svg) {
        try {
          const result = await window.mermaid.render("mdv-diagram-" + ++state.diagramCounter, code);
          svg = result.svg;
          state.diagramCache.set(code, svg);
        } catch (error) {
          node.classList.add("mdv-rendered", "mdv-diagram-error");
          node.prepend(createElement("div", "mdv-diagram-message", String(error?.message || error)));
          continue;
        }
      }
      if (!node.isConnected) {
        continue;
      }
      node.innerHTML = svg;
      node.classList.add("mdv-rendered");
    }
  }

  function pathParts() {
    return location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  }

  // Index of the first path part to show as a crumb. VS Code shows the path
  // relative to the workspace folder, the closest enclosing git repository
  // stands in for that here. Falls back to the full path.
  async function firstVisiblePart(parts) {
    const dirs = [];
    let url = "file:///";
    for (let index = 0; index < parts.length - 1; index++) {
      url += encodeURIComponent(parts[index]) + "/";
      dirs.push(url);
    }
    const timeout = new Promise((resolve) => window.setTimeout(() => resolve(null), 1500));
    const lookup = Promise.all(
      dirs.map((dirUrl) =>
        listDir(dirUrl)
          .then((entries) => entries.some((entry) => entry.name === ".git"))
          .catch(() => false)
      )
    );
    const flags = await Promise.race([lookup, timeout]);
    if (!flags) {
      return 0;
    }
    for (let index = flags.length - 1; index >= 0; index--) {
      if (flags[index]) {
        return index + 1;
      }
    }
    return 0;
  }

  // file crumbs, one per shown path segment, each with the directory to list and the child to select
  function fileSegments(parts, firstShown) {
    const segments = [];
    let url = "file:///";
    parts.forEach((name, index) => {
      const isFile = index === parts.length - 1;
      const parentUrl = url;
      url += encodeURIComponent(name) + (isFile ? "" : "/");
      if (index < firstShown) {
        return;
      }
      segments.push({
        name,
        isFile,
        url,
        dirUrl: isFile ? parentUrl : url,
        selectName: isFile ? name : parts[index + 1]
      });
    });
    return segments;
  }

  async function listDir(dirUrl) {
    const response = await chrome.runtime.sendMessage({ type: "listDir", url: dirUrl });
    if (!response || !response.ok) {
      throw new Error(response ? response.error : "no response");
    }
    return response.entries;
  }

  function collectHeadings() {
    const headings = [];
    const stack = [];
    for (const el of state.content.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      const level = Number(el.tagName.slice(1));
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const heading = {
        level,
        text: el.textContent.trim(),
        id: el.id,
        el,
        parent: stack.length ? stack[stack.length - 1] : null
      };
      headings.push(heading);
      stack.push(heading);
    }
    return headings;
  }

  // scroll position, expressed relative to the heading at the reading line

  function captureAnchor() {
    const heading = state.breadcrumbs ? state.breadcrumbs.computeCurrent() : null;
    if (heading) {
      return { id: heading.id, top: heading.el.getBoundingClientRect().top, y: window.scrollY };
    }
    return { id: null, y: window.scrollY };
  }

  function restoreAnchor(anchor) {
    if (!anchor) {
      return;
    }
    if (anchor.id) {
      const el = document.getElementById(anchor.id);
      if (el) {
        window.scrollBy(0, el.getBoundingClientRect().top - anchor.top);
        return;
      }
    }
    if (typeof anchor.y === "number") {
      window.scrollTo(0, anchor.y);
    }
  }

  function storeScroll() {
    try {
      sessionStorage.setItem(SCROLL_STORE_PREFIX + hrefWithoutHash(), JSON.stringify(captureAnchor()));
    } catch {
      // storage unavailable, nothing to do
    }
  }

  function restoreStoredScroll() {
    try {
      const raw = sessionStorage.getItem(SCROLL_STORE_PREFIX + hrefWithoutHash());
      if (raw) {
        restoreAnchor(JSON.parse(raw));
      }
    } catch {
      // ignore broken entries
    }
  }

  function scrollToHash() {
    if (!location.hash || location.hash.length < 2) {
      return false;
    }
    const raw = location.hash.slice(1);
    let id = raw;
    try {
      id = decodeURIComponent(raw);
    } catch {
      // keep the raw value
    }
    const el =
      document.getElementById(id) ||
      document.getElementById(raw) ||
      document.getElementById(id.replace(/^-+|-+$/g, ""));
    if (!el) {
      return false;
    }
    el.scrollIntoView({ block: "start" });
    return true;
  }

  function render(text, options = {}) {
    const anchor = options.initial ? null : captureAnchor();
    const env = {};
    state.content.innerHTML = state.md.render(stripFrontMatter(text), env);
    state.breadcrumbs.setOutline(collectHeadings());
    if (options.initial) {
      if (!scrollToHash()) {
        restoreStoredScroll();
      }
      state.history.reset();
    } else {
      restoreAnchor(anchor);
    }
    renderDiagrams().then(() => {
      if (options.initial && !state.userScrolled) {
        if (!scrollToHash()) {
          restoreStoredScroll();
        }
        state.history.reset();
      } else if (!options.initial) {
        restoreAnchor(anchor);
      }
      state.breadcrumbs.update(true);
    });
  }

  // live reload, the worker reads the file and the page re-renders on change

  async function pollOnce(force) {
    if (state.polling || (!force && document.visibilityState !== "visible")) {
      return;
    }
    state.polling = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "read", url: hrefWithoutHash() });
      if (!response || !response.ok) {
        registerPollFailure(response ? response.error : "no response");
        return;
      }
      state.pollFailures = 0;
      if (response.text !== state.text) {
        state.text = response.text;
        render(response.text);
      }
    } catch (error) {
      registerPollFailure(String(error?.message || error));
    } finally {
      state.polling = false;
    }
  }

  function registerPollFailure(reason) {
    state.pollFailures += 1;
    if (state.pollFailures >= POLL_FAILURE_LIMIT && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      log("live reload disabled", reason);
    }
  }

  function onMessage(message, sender, sendResponse) {
    if (!message) {
      return false;
    }
    if (message.type === "gotoSection") {
      state.breadcrumbs.selectEditor();
      state.sectionSearch.show();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "refresh") {
      return false;
    }
    pollOnce(true).then(() => {
      if (message.hash) {
        const url = new URL(location.href);
        url.hash = message.hash;
        history.replaceState(history.state, "", url.href);
        state.history.jump(() => scrollToHash());
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  function readRawText() {
    const pre = document.body ? document.body.querySelector("pre") : null;
    if (pre) {
      return pre.textContent;
    }
    return document.body ? document.body.textContent : "";
  }

  function buildShell(segments) {
    const fileName = decodeURIComponent(location.pathname.split("/").pop());
    document.head.textContent = "";
    const charset = createElement("meta");
    charset.setAttribute("charset", "utf-8");
    const colorScheme = createElement("meta");
    colorScheme.name = "color-scheme";
    colorScheme.content = "dark light";
    const viewport = createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    document.head.append(charset, colorScheme, viewport);
    document.title = fileName;

    document.body.textContent = "";
    document.body.className = "mdv-body";
    const bar = createElement("div", "mdv-bar");
    const content = createElement("main", "mdv-content");
    document.body.append(bar, content);
    state.content = content;
    // created first so its key listener runs before the breadcrumb one
    state.history = new window.MdvHistory({
      capture: captureAnchor,
      restore: restoreAnchor,
      bigMove: () => Math.max(2 * window.innerHeight, 1200)
    });
    state.breadcrumbs = new window.MdvBreadcrumbs({
      bar,
      fileSegments: segments,
      listDir,
      readingOffset: READING_OFFSET,
      jump: (action) => state.history.jump(action)
    });
    state.sectionSearch = new window.MdvSectionSearch({
      getHeadings: () => state.breadcrumbs.headings,
      getCurrent: () => state.breadcrumbs.computeCurrent(),
      onOpen: () => state.history.suspend(),
      reveal: (heading) => state.breadcrumbs.revealHeading(heading),
      commit: (heading) => {
        state.history.resume();
        state.history.jump(() => state.breadcrumbs.revealHeading(heading));
      },
      onCancel: () => {
        state.history.resume();
        state.breadcrumbs.pinUntil = 0;
        state.breadcrumbs.update(true);
      }
    });
    // Hash links jump through the position history. The hash is replaced in
    // place, a native hash click would add a tab history entry and detach the
    // spare entries the browser back and forward buttons rely on.
    content.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
      if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      history.replaceState(history.state, "", link.getAttribute("href"));
      state.history.jump(() => scrollToHash());
    });
  }

  async function boot() {
    if (!window.markdownit || !window.MdvBreadcrumbs || !window.MdvSectionSearch || !window.MdvHistory) {
      log("dependencies missing, leaving the page alone");
      hideStyle.remove();
      return;
    }
    history.scrollRestoration = "manual";
    state.text = readRawText();
    const parts = pathParts();
    const segments = fileSegments(parts, await firstVisiblePart(parts));
    buildShell(segments);
    state.md = createMarkdownIt();
    initMermaid();
    render(state.text, { initial: true });
    hideStyle.remove();

    const markUserScroll = () => {
      state.userScrolled = true;
    };
    window.addEventListener("wheel", markUserScroll, { passive: true });
    window.addEventListener("touchmove", markUserScroll, { passive: true });
    window.addEventListener("keydown", (event) => {
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) {
        state.userScrolled = true;
      }
    });

    let scrollStoreTimer = 0;
    window.addEventListener(
      "scroll",
      () => {
        if (scrollStoreTimer) {
          return;
        }
        scrollStoreTimer = window.setTimeout(() => {
          scrollStoreTimer = 0;
          storeScroll();
        }, 250);
      },
      { passive: true }
    );
    window.addEventListener("pagehide", storeScroll);

    state.pollTimer = window.setInterval(() => pollOnce(false), POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        pollOnce(false);
      }
    });
    chrome.runtime.onMessage.addListener(onMessage);

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      state.diagramCache.clear();
      initMermaid();
      for (const node of state.content.querySelectorAll(".mdv-mermaid")) {
        node.classList.remove("mdv-rendered", "mdv-diagram-error");
      }
      render(state.text);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
