# Browser Markdown Viewer

Unpacked Chromium extension (Brave, Chrome) that renders local markdown files in the browser, with a VS Code style breadcrumb bar for jumping between sections. Built to replace the VS Code markdown preview, `ctrl+shift+v` in VS Code opens the current file in the running Brave window.

## What it does

- Renders `file:///…/*.md` (also `.markdown`, `.mdown`) with markdown-it, same options as the VS Code preview (html on, linkify on)
- Heading ids follow the VS Code slugifier, so `[text](#section)` links written in VS Code resolve
- Mermaid fences render as diagrams, code fences get highlight.js colours, `- [ ]` items render as checkboxes, YAML front matter is hidden
- Dark and light theme follow `prefers-color-scheme`
- Breadcrumb bar at the top, path crumbs relative to the enclosing git repository, then the heading chain at the current scroll position (`# Title › ## Section › ### Subsection`)
- Picker under any crumb, the full outline for heading crumbs, the folder listing for path crumbs
- Live reload, the page re-renders when the file changes on disk, scroll position stays put
- Opening a file that is already open switches to that tab instead of adding one
- Section search on `ctrl+t`, the VS Code "Go to Symbol in Editor" quick pick, fuzzy filter over the headings, up and down preview the section, enter jumps, escape restores the view

## Install in Brave

1. Open `brave://extensions`
2. Enable `Developer mode`
3. `Load unpacked`, pick `/home/felix/repos/browser-markdown-viewer`
4. Open `Details` for the extension and switch on `Allow access to file URLs` (without it the extension never runs on local files)
5. Open any `.md` file, for example `file:///home/felix/repos/notes/README.md`

6. Open `brave://extensions/shortcuts`, find `Go to section` under Browser Markdown Viewer and type `Ctrl+T` into its box (Chromium never applies the suggested key on its own because `Ctrl+T` is one of its own shortcuts, a manual assignment overrides it)

Same steps in Chrome at `chrome://extensions`. After editing the extension files press the reload icon on `brave://extensions`.

`Ctrl+T` keeps opening a new tab on every page without the viewer, the extension opens that tab itself. Only on rendered markdown pages it opens the section search instead.

## VS Code binding

`bin/open-markdown <file>` opens the file in Brave and switches i3 to the Brave window (i3 uses `focus_on_window_activation urgent`, so the script follows the urgency flag).

User `tasks.json`

```json
{
  "label": "open_markdown_in_browser",
  "type": "process",
  "command": "/home/felix/repos/browser-markdown-viewer/bin/open-markdown",
  "args": ["${file}"],
  "presentation": { "reveal": "never", "panel": "shared", "showReuseMessage": false },
  "runOptions": { "instanceLimit": 5 },
  "problemMatcher": []
}
```

`keybindings.json`, save first because the browser shows the file on disk

```json
{
  "key": "ctrl+shift+v",
  "command": "runCommands",
  "when": "editorFocus && !notebookEditorFocused && editorLangId =~ /^(markdown|prompt|instructions|chatagent|skill)$/",
  "args": {
    "commands": [
      "workbench.action.files.save",
      { "command": "workbench.action.tasks.runTask", "args": "open_markdown_in_browser" }
    ]
  }
}
```

## Keys

Mirrors the VS Code breadcrumb commands and the VS Code list defaults, verified against VS Code 1.133. The activation chord sits at the top of `content/breadcrumbs.js` (`FOCUS_AND_SELECT`).

Anywhere on the page

| Key | Does |
| --- | --- |
| `ctrl+shift+alt+meta+end` | `breadcrumbs.focusAndSelect`, focus the last crumb and open its picker |
| `ctrl+t` | `workbench.action.gotoSymbol`, open the section search (through the extension command, see Install step 6) |

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

The search opens with the current heading selected. Each result shows its parent heading as a dim description, the first row carries the result count, as the VS Code quick pick does. The outline picker opens collapsed apart from the path to the current heading, as VS Code's `collapseByDefault` picker does, with the current heading selected and its siblings visible. Mouse works too, click a crumb for its picker, click the triangle to fold or unfold, click a row to jump.

## Layout

- `manifest.json` runs the content scripts on `file:///*` urls ending in a markdown extension
- `service-worker.js` reuses open tabs, reads files for live reload, lists folders for the path crumbs, forwards the `ctrl+t` command or opens a new tab
- `content/viewer.js` replaces the plain text page with rendered markdown, mermaid, highlighting, scroll restore, polling
- `content/breadcrumbs.js` bar, picker, filter, key handling
- `content/sectionsearch.js` the section search quick pick
- `content/viewer.css` page and bar styles, light and dark
- `vendor/` markdown-it 15, highlight.js 11 (common languages build), mermaid 11, licenses next to them
- `bin/open-markdown` helper used by the VS Code task
- `scripts/smoke-test.mjs` end to end test in a throwaway headless profile

## Smoke test

```bash
node scripts/smoke-test.mjs --file /home/felix/repos/notes/notes/job/search/interview_prep/system_design_interview.md --git 1 --dark 1 --out /tmp/mdv-smoke
```

Launches a throwaway headless Brave with the extension loaded (the `Ctrl+T` assignment seeded into the profile, the unpacked extension id is derived from the folder path), drives it over the DevTools protocol, checks rendering, diagrams, anchors, the chord, picker, tree keys, filter, folder crumb, section search, live reload and tab reuse, and writes screenshots to `--out`. Pass `--browser` for another Chromium binary. Felix's own Brave profile is never touched.

## Notes

- The extension needs `Allow access to file URLs`, that is the only setting outside `Load unpacked`
- Only `file://` pages are matched, `http` and `https` would need `host_permissions` for those origins and a wider `matches` list
- Chromium will not run extensions on `brave://` pages, the folder listing of a path crumb is fetched by the worker, so it works for any readable folder
- Live reload polls the file once per second while the tab is visible, it stops after three failed reads
