# Browser Markdown Viewer

Unpacked Chromium extension (Brave, Chrome) that renders local markdown files in the browser, with a VS Code style breadcrumb bar for jumping between sections. Built to replace the VS Code markdown preview, `ctrl+shift+v` in VS Code opens the current file in the running Brave window, `ctrl+shift+v` in the browser goes back to VS Code at the section being read.

## What it does

- Renders `file:///…/*.md` (also `.markdown`, `.mdown`) with markdown-it, same options as the VS Code preview (html on, linkify on)
- Heading ids follow the VS Code slugifier, so `[text](#section)` links written in VS Code resolve
- Mermaid fences render as diagrams, code fences get highlight.js colours, `- [ ]` items render as checkboxes, YAML front matter is hidden
- Dark and light theme
  - The system setting (`prefers-color-scheme`) decides by default
  - `ctrl+shift+z` from the sibling extension `browser-color-mode-toggle` switches every open markdown tab, the mark `data-color-mode` on the html element wins over the system setting
- Breadcrumb bar at the top, path crumbs relative to the enclosing git repository, then the heading chain at the current scroll position (`# Title › ## Section › ### Subsection`)
- Picker under any crumb, the full outline for heading crumbs, the folder listing for path crumbs
- Live reload, the page re-renders when the file changes on disk, scroll position stays put
- Opening a file that is already open switches to that tab instead of adding one
- Section search on `ctrl+t`, the VS Code "Go to Symbol in Editor" quick pick, fuzzy filter over the headings, up and down preview the section, enter jumps, escape restores the view
- Way back to VS Code on `ctrl+shift+v`
  - The cursor lands on the source line of the block at the top of the page
  - The file opens in the VS Code window it was launched from, that window gets the focus
  - With the window gone, the folder of that window reopens with the file, never a window of another repository

## Install in Brave

1. Open `brave://extensions`
2. Enable `Developer mode`
3. `Load unpacked`, pick `/home/felix/repos/browser-markdown-viewer`
4. Open `Details` for the extension and switch on `Allow access to file URLs` (without it the extension never runs on local files)
5. Open any `.md` file, for example `file:///home/felix/repos/notes/README.md`

6. Open `brave://extensions/shortcuts`, find `Go to section` under Browser Markdown Viewer and type `Ctrl+T` into its box (Chromium never applies the suggested key on its own because `Ctrl+T` is one of its own shortcuts, a manual assignment overrides it)
7. Run `bin/install-editor-host` and press the reload icon of the extension on `brave://extensions`, the way back to VS Code needs it, see below

Same steps in Chrome at `chrome://extensions`. After editing the extension files press the reload icon on `brave://extensions`.

`Ctrl+T` keeps opening a new tab on every page without the viewer, the extension opens that tab itself. Only on rendered markdown pages it opens the section search instead.

## VS Code binding

`bin/open-markdown <file> [<workspace folder>]` opens the file in Brave and switches i3 to the Brave window (i3 uses `focus_on_window_activation urgent`, so the script follows the urgency flag). The folder is the one open in the VS Code window, the script records it under `~/.local/state/browser-markdown-viewer/workspaces.json` so the way back can find that window again.

User `tasks.json`, the second task serves windows without a folder, where `${workspaceFolder}` has no value

```json
{
  "label": "open_markdown_in_browser",
  "type": "process",
  "command": "/home/felix/repos/browser-markdown-viewer/bin/open-markdown",
  "args": ["${file}", "${workspaceFolder}"],
  "presentation": { "reveal": "never", "panel": "shared", "showReuseMessage": false },
  "runOptions": { "instanceLimit": 5 },
  "problemMatcher": []
},
{
  "label": "open_markdown_in_browser_no_folder",
  "type": "process",
  "command": "/home/felix/repos/browser-markdown-viewer/bin/open-markdown",
  "args": ["${file}"],
  "presentation": { "reveal": "never", "panel": "shared", "showReuseMessage": false },
  "runOptions": { "instanceLimit": 5 },
  "problemMatcher": []
}
```

`keybindings.json`, save first because the browser shows the file on disk, `workspaceFolderCount` picks the task

```json
{
  "key": "ctrl+shift+v",
  "command": "runCommands",
  "when": "editorFocus && !notebookEditorFocused && editorLangId =~ /^(markdown|prompt|instructions|chatagent|skill)$/ && workspaceFolderCount > 0",
  "args": {
    "commands": [
      "workbench.action.files.save",
      { "command": "workbench.action.tasks.runTask", "args": "open_markdown_in_browser" }
    ]
  }
},
{
  "key": "ctrl+shift+v",
  "command": "runCommands",
  "when": "editorFocus && !notebookEditorFocused && editorLangId =~ /^(markdown|prompt|instructions|chatagent|skill)$/ && workspaceFolderCount == 0",
  "args": {
    "commands": [
      "workbench.action.files.save",
      { "command": "workbench.action.tasks.runTask", "args": "open_markdown_in_browser_no_folder" }
    ]
  }
}
```

## Back to VS Code

`ctrl+shift+v` on a rendered page opens the file in VS Code at the line being read and switches i3 to that VS Code window.

- Source line
  - Every block element carries the line it starts on in the markdown source, as the VS Code preview does (`data-line`)
  - The block at the top of the page wins, the heading right after a jump, otherwise the paragraph, list item or code block under the reading position
  - Front matter is hidden in the page but counted, the line matches the file on disk
- Native messaging host
  - Extension pages cannot start programs, so the worker sends `{action, url, line, column}` to `bin/editor-host` over Chromium native messaging
  - The browser starts the host from a manifest in `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` (`google-chrome` and `chromium` likewise), `bin/install-editor-host` writes it with the extension id read from the browser preferences
  - The manifest lives in the browser config dir under `XDG_CONFIG_HOME`, never in a profile given with `--user-data-dir`
- Editor command
  - The host asks the running VS Code for the equivalent of `code <folder> --goto <file>:<line>:<column>`
  - The folder is the one recorded at launch by `bin/open-markdown`, failing that the enclosing git repository, failing that none
  - The ask goes straight to the main socket of the running VS Code (`$XDG_RUNTIME_DIR/vscode-<hash>-<version>-main.sock`, the socket the `code` CLI itself connects to), so the round trip takes a few milliseconds, `bin/vscode_ipc.py` speaks the wire format
  - Without a reachable socket the host runs the `code` CLI instead, which starts a whole Electron process first and takes about a second, and which also starts VS Code when none runs
  - VS Code reuses the window with that folder open, or opens the folder in a new window with the file, so the file lands in the right session and never in whatever window was active last
  - The host then follows the urgency flag of the VS Code window and focuses it, preferring the window whose title names the folder or the file
- Failure notice
  - A failed jump shows a notice at the bottom right of the page for a few seconds, for example when the host is not installed yet

## Keys

Mirrors the VS Code breadcrumb commands and the VS Code list defaults, verified against VS Code 1.133. The activation chord sits at the top of `content/breadcrumbs.js` (`FOCUS_AND_SELECT`).

Anywhere on the page

| Key | Does |
| --- | --- |
| `ctrl+shift+alt+meta+end` | `breadcrumbs.focusAndSelect`, focus the last crumb and open its picker |
| `ctrl+t` | `workbench.action.gotoSymbol`, open the section search (through the extension command, see Install step 6) |
| `ctrl+shift+v` | back to VS Code, the file opens at the source line of the block at the top of the page, in the window it was launched from |
| `ctrl+shift+z` | light or dark theme, owned by `browser-color-mode-toggle`, that extension needs `Allow access to file URLs` |
| `alt+left`, `alt+right` | `workbench.action.navigateBack` and `navigateForward` over the positions visited in this document, with nothing left in that direction the browser's own back or forward runs |
| back and forward buttons | toolbar or mouse, same as `alt+left` and `alt+right` on markdown pages, with no position left the tab leaves for the page it really visited before |

Bar focused, no picker

| Key | Does |
| --- | --- |
| `left`, `right` | previous or next crumb |
| `enter`, `down` | open the picker of the focused crumb |
| `space` | jump to the focused crumb without a picker |
| `ctrl+enter` | open the focused crumb in a new tab |
| `escape` | leave the bar, focus returns to the page |

Picker open (the VS Code list rules, `list.collapse`, `list.expand`, `list.toggleExpand`, `list.select`)

| Key | Does |
| --- | --- |
| `up`, `down`, `pageup`, `pagedown`, `home`, `end` | move the selection over the visible rows |
| `left` | collapse the selected heading, on a collapsed heading or a leaf move to the parent |
| `right` | expand the selected heading, on an expanded heading move to its first child |
| `space` | toggle a heading with children, pick a leaf |
| `enter` | jump to the selected heading or open the selected file, close the picker |
| `ctrl+enter` | open the selected entry in a new tab |
| `ctrl+left`, `ctrl+right` | previous or next crumb, the picker follows (`focusPreviousWithPicker`, `focusNextWithPicker`) |
| `ctrl+f` | filter box, matches and their ancestors stay visible, `escape` closes the box |
| `escape` | close the picker, focus returns to the page |

Section search open

| Key | Does |
| --- | --- |
| typing | fuzzy filter, every word must match the heading or, failing that, its parent heading (VS Code's container query), contiguous hits and word starts rank first, matched characters highlighted |
| `up`, `down` | move and preview the section in the page, wraps around at the ends |
| `pageup`, `pagedown` | move by ten |
| `enter` | jump to the selected section and close |
| `ctrl+t` | move to the next row |
| `escape` | close and scroll back to where the page was |

Position history, VS Code adds an entry when the cursor jumps more than ten lines and updates the current entry for smaller moves. Here a deliberate jump (picker enter, crumb space, search enter, an anchor link) adds an entry, so does a manual move of more than two screens between pauses, smaller scrolling updates the current entry, previews while typing in the search never count and escape puts the page back. Fifty entries, going back and then jumping somewhere new drops the forward entries.

The browser back and forward buttons only fire when the tab has a history entry on that side, so the page keeps one spare entry on each side of the current one and cancels the traversal onto a spare entry through the Navigation API, moving through the positions instead. Anchor clicks replace the hash in place for the same reason. Canceling a traversal needs a prior interaction with the page, before the first click or key press the toolbar buttons fall back to the browser's own history walk.

The search opens with the current heading selected. Each result shows its parent heading as a dim description, the first row carries the result count, as the VS Code quick pick does. The outline picker opens collapsed apart from the path to the current heading, as VS Code's `collapseByDefault` picker does, with the current heading selected and its siblings visible. Mouse works too, click a crumb for its picker, click the triangle to fold or unfold, click a row to jump.

## Layout

- `manifest.json` runs the content scripts on `file:///*` urls ending in a markdown extension
- `service-worker.js` reuses open tabs, reads files for live reload, lists folders for the path crumbs, forwards the `ctrl+t` command or opens a new tab, hands a file and line to the native messaging host on `ctrl+shift+v`
- `content/viewer.js` replaces the plain text page with rendered markdown, mermaid, highlighting, scroll restore, polling, source line tracking and the `ctrl+shift+v` key
- `content/breadcrumbs.js` bar, picker, filter, key handling
- `content/sectionsearch.js` the section search quick pick
- `content/history.js` position history for alt+left, alt+right and the browser back and forward buttons
- `content/viewer.css` page and bar styles, light and dark
- `vendor/` markdown-it 15, highlight.js 11 (common languages build), mermaid 11, licenses next to them
- `bin/open-markdown` helper used by the VS Code task, records the workspace folder
- `bin/editor-host` native messaging host, opens the file in VS Code at a line and focuses the window
- `bin/vscode_ipc.py` the VS Code main socket protocol, sends the launch request the `code` CLI would send
- `bin/install-editor-host` writes the host manifest into the browser config dirs
- `bin/mdv_common.py` state file and i3 helpers shared by the two scripts
- `scripts/smoke-test.mjs` end to end test in a throwaway headless profile

## Smoke test

```bash
node scripts/smoke-test.mjs --file /home/felix/repos/notes/notes/job/search/interview_prep/system_design_interview.md --git 1 --dark 1 --out /tmp/mdv-smoke
```

Launches a throwaway headless Brave with the extension loaded (the `Ctrl+T` assignment seeded into the profile, the unpacked extension id is derived from the folder path), drives it over the DevTools protocol, checks rendering, diagrams, the `data-color-mode` theme mark, anchors, the chord, picker, tree keys, filter, folder crumb, section search, position history, live reload, tab reuse and the way back to VS Code, and writes screenshots to `--out`. Pass `--browser` for another Chromium binary. Felix's own Brave profile is never touched.

The way back runs against a fake VS Code main socket served by the test (it answers the handshake and records every launch request) and a stub editor that records its arguments, `XDG_CONFIG_HOME` points into `--out` so the host manifest seeded there is the one the browser finds, and the host reads the overrides below. Five direct host checks (ping, recorded folder over the socket, CLI fallback with a dead socket path, git root fallback, missing file) run before the browser starts, then `ctrl+shift+v` in the page must reach the fake socket with the line of the heading just jumped to.

| Variable | Does |
| --- | --- |
| `BROWSER_MARKDOWN_VIEWER_SOCKET` | VS Code main socket to use instead of the discovered ones |
| `BROWSER_MARKDOWN_VIEWER_EDITOR` | command to run instead of `code` |
| `BROWSER_MARKDOWN_VIEWER_STATE` | state file instead of the one under `~/.local/state` |
| `BROWSER_MARKDOWN_VIEWER_NO_FOCUS` | set to skip the i3 focusing |

## Notes

- The extension needs `Allow access to file URLs`, that is the only setting outside `Load unpacked`
- Only `file://` pages are matched, `http` and `https` would need `host_permissions` for those origins and a wider `matches` list
- Chromium will not run extensions on `brave://` pages, the folder listing of a path crumb is fetched by the worker, so it works for any readable folder
- Live reload polls the file once per second while the tab is visible, it stops after three failed reads
- The way back needs the host manifest and a reload of the extension after `bin/install-editor-host`, the notice on the page says which of the two is missing
- Multi root workspaces are a limitation, `${workspaceFolder}` in a user task is the first folder of the workspace, so the way back reopens that folder when the window is gone
- Window ids are never stored, the file plus the recorded folder identify the VS Code session, so the way back survives a VS Code restart
- The socket wire format is VS Code internal, read from the 1.136 bundle, a VS Code release may change it, the host then falls back to the `code` CLI and the way back only gets slower, never broken
