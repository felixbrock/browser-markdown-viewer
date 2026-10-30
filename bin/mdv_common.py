"""Shared helpers for the bin scripts.

Two things live here. The state file that remembers which VS Code folder a
markdown file was launched from, written by open-markdown and read by
editor-host. And the window focusing. i3 runs with
focus_on_window_activation urgent, so an activated window only carries the
urgency flag and the scripts follow that flag themselves. macOS has no i3,
activate_app brings an application to the front there.

The scripts run under the python3 of macOS too, which is 3.9, so nothing
here may need a newer Python.
"""

import json
import os
import shutil
import subprocess
import sys
import time

STATE_ENV = "BROWSER_MARKDOWN_VIEWER_STATE"
MAX_ENTRIES = 500
POLL_S = 0.1
MACOS = sys.platform == "darwin"


# state file, file path -> folder open in the VS Code window that launched it


def state_path():
    override = os.environ.get(STATE_ENV)
    if override:
        return override
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "browser-markdown-viewer", "workspaces.json")


def load_state():
    try:
        with open(state_path(), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    files = data.get("files") if isinstance(data, dict) else None
    return files if isinstance(files, dict) else {}


def record_workspace(path, folder):
    """Remember that `path` was opened from the VS Code window showing `folder`."""
    files = load_state()
    files[path] = {"folder": folder, "time": time.time()}
    if len(files) > MAX_ENTRIES:
        oldest_first = sorted(files, key=lambda key: files[key].get("time", 0))
        for key in oldest_first[: len(files) - MAX_ENTRIES]:
            del files[key]
    target = state_path()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temporary = target + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump({"version": 1, "files": files}, handle, indent=1)
        handle.write("\n")
    os.replace(temporary, target)


def recorded_workspace(path):
    """The folder recorded for `path`, None when unknown or gone."""
    entry = load_state().get(path)
    if not isinstance(entry, dict):
        return None
    folder = entry.get("folder")
    if isinstance(folder, str) and os.path.isdir(folder):
        return folder
    return None


def git_root(path):
    """The closest enclosing git repository of `path`, None outside any."""
    current = os.path.dirname(os.path.abspath(path))
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


# i3


def i3_tree():
    if not shutil.which("i3-msg"):
        return None
    result = subprocess.run(["i3-msg", "-t", "get_tree"], capture_output=True, text=True, check=False)
    if result.returncode != 0 or not result.stdout:
        return None
    try:
        return json.loads(result.stdout)
    except ValueError:
        return None


def find_windows(node, predicate, found=None):
    if found is None:
        found = []
    if node.get("window") is not None and predicate(node):
        found.append(node)
    for child in node.get("nodes", []) + node.get("floating_nodes", []):
        find_windows(child, predicate, found)
    return found


def window_class(node):
    props = node.get("window_properties") or {}
    return (props.get("class") or "").lower()


def window_title(node):
    return node.get("name") or ""


def i3_focus(con_id):
    subprocess.run(["i3-msg", f"[con_id={con_id}] focus"], capture_output=True, check=False)


def focus_window(is_app, timeout_s, choose=None):
    """Focus the window of an application that was just activated.

    Polls the i3 tree until `timeout_s`. A focused window of the app means the
    activation already went through. An urgent one is the activated window,
    it gets focused. After the timeout the app's windows go through `choose`,
    which returns one of them or None, and the first window is the last resort.
    Returns True when a window of the app ended up focused.
    """
    if not shutil.which("i3-msg"):
        return False
    deadline = time.time() + timeout_s
    tree = None
    while time.time() < deadline:
        tree = i3_tree()
        if tree is None:
            return False
        if find_windows(tree, lambda node: is_app(node) and node.get("focused")):
            return True
        urgent = find_windows(tree, lambda node: is_app(node) and node.get("urgent"))
        if urgent:
            i3_focus(urgent[0]["id"])
            return True
        time.sleep(POLL_S)
    if tree is None:
        return False
    windows = find_windows(tree, is_app)
    if not windows:
        return False
    chosen = choose(windows) if choose else None
    i3_focus((chosen or windows[0])["id"])
    return True


# macOS


def activate_app(bundle_id):
    """Bring the application with `bundle_id` to the front, True when open succeeded.

    macOS raises the frontmost window of the app, the window the app focused last.
    """
    result = subprocess.run(["open", "-b", bundle_id], capture_output=True, check=False)
    return result.returncode == 0
