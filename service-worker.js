// Background worker. Three jobs, reuse an already open tab when the same file
// is opened again (the VS Code binding lands here), read files from disk for
// live reload, and list directories for the folder crumbs.

const LOG_PREFIX = "[browser-markdown-viewer]";
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown"];
const FRESH_TAB_WINDOW_MS = 3000;

// tab id -> creation time, tabs that were just created and may still receive their url
const freshTabs = new Map();
const handledTabs = new Set();

function isMarkdownFileUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") {
      return false;
    }
    const path = parsed.pathname.toLowerCase();
    return MARKDOWN_EXTENSIONS.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

function keyOf(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

function forgetTab(tabId) {
  freshTabs.delete(tabId);
  handledTabs.delete(tabId);
}

async function reuseExistingTab(newTab, url) {
  const key = keyOf(url);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(
    (tab) => tab.id !== newTab.id && isMarkdownFileUrl(tab.url) && keyOf(tab.url) === key
  );
  if (!existing) {
    return false;
  }
  console.log(LOG_PREFIX, "reusing tab", existing.id, "for", key);
  await chrome.tabs.update(existing.id, { active: true });
  try {
    await chrome.windows.update(existing.windowId, { focused: true });
  } catch (error) {
    console.log(LOG_PREFIX, "window focus failed", error?.message);
  }
  try {
    await chrome.tabs.remove(newTab.id);
  } catch (error) {
    console.log(LOG_PREFIX, "closing the new tab failed", error?.message);
  }
  const hash = new URL(url).hash;
  try {
    await chrome.tabs.sendMessage(existing.id, { type: "refresh", hash });
  } catch {
    // No content script in that tab yet, a plain reload gets it there.
    await chrome.tabs.reload(existing.id);
  }
  return true;
}

async function handleFreshTab(tab, url) {
  if (handledTabs.has(tab.id) || !isMarkdownFileUrl(url)) {
    return;
  }
  handledTabs.add(tab.id);
  freshTabs.delete(tab.id);
  try {
    await reuseExistingTab(tab, url);
  } catch (error) {
    console.log(LOG_PREFIX, "tab reuse failed", error?.message);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  freshTabs.set(tab.id, Date.now());
  const url = tab.pendingUrl || tab.url;
  if (url) {
    handleFreshTab(tab, url);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const createdAt = freshTabs.get(tabId);
  if (createdAt === undefined) {
    return;
  }
  if (Date.now() - createdAt > FRESH_TAB_WINDOW_MS) {
    freshTabs.delete(tabId);
    return;
  }
  const url = changeInfo.url || tab.pendingUrl || tab.url;
  if (url) {
    handleFreshTab(tab, url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

async function readFile(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok && response.status !== 0) {
    throw new Error("status " + response.status);
  }
  return response.text();
}

// Chromium renders a directory as a page that calls addRow(name, urlName, isDir, ...)
// once per entry. The names are JSON escaped strings.
function parseDirectoryListing(html) {
  const entries = [];
  const rowPattern = /addRow\("((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)",(\d)/g;
  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    try {
      entries.push({
        name: JSON.parse('"' + match[1] + '"'),
        href: JSON.parse('"' + match[2] + '"'),
        isDir: match[3] === "1"
      });
    } catch {
      // skip rows that do not parse
    }
  }
  return entries;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }
  if (message.type === "read") {
    readFile(message.url)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message.type === "listDir") {
    readFile(message.url)
      .then((html) => sendResponse({ ok: true, entries: parseDirectoryListing(html) }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  return false;
});
