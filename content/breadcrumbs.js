// Breadcrumb bar with a picker, modelled on the VS Code breadcrumbs widget.
//
// The chord below mirrors ~/.config/Code/User/keybindings.json, where
// ctrl+shift+alt+meta+end runs breadcrumbs.focusAndSelect. Everything else
// mirrors the VS Code defaults. With the bar focused and no picker, left and
// right move between crumbs, enter or down open the picker, space reveals.
// Inside the picker the list rules apply, up and down move, left collapses
// (or goes to the parent), right expands (or goes to the first child), space
// toggles a parent and picks a leaf, enter picks, ctrl+left and ctrl+right
// move the picker to the neighbouring crumb, ctrl+f opens the filter box,
// escape returns to the page. The outline opens collapsed apart from the path
// to the current heading, like VS Code's collapseByDefault picker.

(() => {
  "use strict";

  const FOCUS_AND_SELECT = { ctrl: true, shift: true, alt: true, meta: true, code: "End" };
  const PAGE_STEP = 10;
  const PIN_MS = 600;

  function matchesChord(event, chord) {
    return (
      event.ctrlKey === chord.ctrl &&
      event.shiftKey === chord.shift &&
      event.altKey === chord.alt &&
      event.metaKey === chord.meta &&
      event.code === chord.code
    );
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

  function headingLabel(heading) {
    return "#".repeat(heading.level) + " " + heading.text;
  }

  class Breadcrumbs {
    constructor(options) {
      this.bar = options.bar;
      this.fileSegments = options.fileSegments;
      this.listDir = options.listDir;
      this.readingOffset = options.readingOffset;
      this.headings = [];
      this.items = [];
      this.focused = null;
      this.pickerFor = null;
      this.current = null;
      this.pinUntil = 0;
      this.picker = null;
      this.list = null;
      this.rows = [];
      this.selectedRow = -1;
      this.expanded = new Set();
      this.filterInput = null;
      this.filterQuery = "";
      this.frame = 0;
      this.bar.tabIndex = -1;
      this.bar.setAttribute("role", "navigation");
      this.bar.setAttribute("aria-label", "Breadcrumbs");

      window.addEventListener("keydown", (event) => this.onKeyDown(event), true);
      window.addEventListener("scroll", () => this.scheduleUpdate(), { passive: true });
      window.addEventListener("resize", () => this.scheduleUpdate(), { passive: true });
      document.addEventListener("mousedown", (event) => {
        if (!this.active) {
          return;
        }
        const insideBar = this.bar.contains(event.target);
        const insidePicker = this.picker !== null && this.picker.contains(event.target);
        if (!insideBar && !insidePicker) {
          this.selectEditor();
        }
      });
    }

    get active() {
      return this.focused !== null || this.pickerFor !== null;
    }

    // headings, array of { level, text, id, el, parent } in document order
    setOutline(headings) {
      for (const heading of headings) {
        heading.children = [];
      }
      for (const heading of headings) {
        if (heading.parent) {
          heading.parent.children.push(heading);
        }
      }
      this.headings = headings;
      this.closePicker();
      this.current = null;
      this.update(true);
    }

    computeCurrent() {
      let current = null;
      for (const heading of this.headings) {
        if (heading.el.getBoundingClientRect().top <= this.readingOffset) {
          current = heading;
        } else {
          break;
        }
      }
      return current;
    }

    scheduleUpdate() {
      if (this.frame) {
        return;
      }
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.update(false);
      });
    }

    update(force) {
      if (!force && performance.now() < this.pinUntil) {
        return;
      }
      const current = this.computeCurrent();
      if (!force && current === this.current) {
        return;
      }
      this.current = current;
      this.rebuildItems();
    }

    rebuildItems() {
      const items = this.fileSegments.map((segment) => ({
        kind: segment.isFile ? "file" : "dir",
        label: segment.name,
        url: segment.url,
        dirUrl: segment.dirUrl,
        selectName: segment.selectName
      }));
      const chain = [];
      for (let heading = this.current; heading; heading = heading.parent) {
        chain.unshift(heading);
      }
      for (const heading of chain) {
        items.push({ kind: "heading", label: headingLabel(heading), heading });
      }
      this.items = items;
      if (this.focused !== null && this.focused >= items.length) {
        this.focused = items.length - 1;
      }
      if (this.pickerFor !== null && this.pickerFor >= items.length) {
        this.closePicker();
      }
      this.renderBar();
    }

    renderBar() {
      this.bar.textContent = "";
      this.items.forEach((item, index) => {
        if (index > 0) {
          this.bar.appendChild(createElement("span", "mdv-sep", "›"));
        }
        const crumb = createElement("span", "mdv-crumb mdv-crumb-" + item.kind, item.label);
        crumb.title = item.label;
        if (index === this.focused) {
          crumb.classList.add("focused");
        }
        if (index === this.pickerFor) {
          crumb.classList.add("selected");
        }
        crumb.addEventListener("click", (event) => {
          event.preventDefault();
          if (this.pickerFor === index) {
            this.closePicker();
            this.setFocused(index);
          } else {
            this.setFocused(index);
            this.openPicker(index);
          }
        });
        this.bar.appendChild(crumb);
      });
      if (this.focused !== null) {
        const node = this.bar.children[this.focused * 2];
        if (node && node.scrollIntoView) {
          node.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
    }

    setFocused(index) {
      this.focused = index;
      this.bar.focus({ preventScroll: true });
      this.renderBar();
    }

    // breadcrumbs.focusAndSelect
    focusAndSelect() {
      if (this.items.length === 0) {
        return;
      }
      const last = this.items.length - 1;
      this.setFocused(last);
      this.openPicker(last);
    }

    // breadcrumbs.focusNext and focusNextWithPicker
    focusNext() {
      if (this.items.length === 0) {
        return;
      }
      const next = this.focused === null ? 0 : Math.min(this.focused + 1, this.items.length - 1);
      this.moveFocus(next);
    }

    // breadcrumbs.focusPrevious and focusPreviousWithPicker
    focusPrevious() {
      if (this.items.length === 0) {
        return;
      }
      const previous = this.focused === null ? this.items.length - 1 : Math.max(this.focused - 1, 0);
      this.moveFocus(previous);
    }

    moveFocus(index) {
      const pickerWasOpen = this.pickerFor !== null;
      if (index === this.focused) {
        return;
      }
      this.setFocused(index);
      if (pickerWasOpen) {
        this.openPicker(index);
      }
    }

    // breadcrumbs.selectFocused, enter or down on a crumb
    selectFocused() {
      if (this.focused === null) {
        return;
      }
      this.openPicker(this.focused);
    }

    // breadcrumbs.revealFocused, space on a crumb
    revealFocused() {
      const item = this.focused === null ? null : this.items[this.focused];
      if (!item) {
        return;
      }
      if (item.kind === "heading") {
        this.revealHeading(item.heading);
        this.selectEditor();
      } else {
        location.href = item.url;
      }
    }

    // breadcrumbs.revealFocusedFromTreeAside, ctrl+enter on a crumb
    revealFocusedAside() {
      const item = this.focused === null ? null : this.items[this.focused];
      if (!item) {
        return;
      }
      window.open(item.kind === "heading" ? this.headingUrl(item.heading) : item.url, "_blank");
    }

    // breadcrumbs.selectEditor, escape
    selectEditor() {
      this.closePicker();
      this.focused = null;
      this.renderBar();
      this.bar.blur();
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    }

    headingUrl(heading) {
      const url = new URL(location.href);
      url.hash = "#" + heading.id;
      return url.href;
    }

    revealHeading(heading) {
      heading.el.scrollIntoView({ block: "start" });
      heading.el.classList.remove("mdv-flash");
      void heading.el.offsetWidth;
      heading.el.classList.add("mdv-flash");
      this.current = heading;
      this.pinUntil = performance.now() + PIN_MS;
      this.rebuildItems();
    }

    // picker

    closePicker() {
      if (this.picker) {
        this.picker.remove();
      }
      this.picker = null;
      this.list = null;
      this.rows = [];
      this.selectedRow = -1;
      this.filterInput = null;
      this.filterQuery = "";
      if (this.pickerFor !== null) {
        this.pickerFor = null;
        this.renderBar();
      }
    }

    async openPicker(index) {
      const item = this.items[index];
      if (!item) {
        return;
      }
      this.closePicker();
      this.pickerFor = index;
      this.focused = index;
      this.renderBar();

      const picker = createElement("div", "mdv-picker");
      picker.setAttribute("role", "tree");
      const list = createElement("div", "mdv-list");
      picker.appendChild(list);
      document.body.appendChild(picker);
      this.picker = picker;
      this.list = list;
      this.positionPicker(index);

      if (item.kind === "heading") {
        this.fillOutline(item.heading);
        return;
      }

      list.appendChild(createElement("div", "mdv-row mdv-row-muted", "Loading…"));
      let entries;
      try {
        entries = await this.listDir(item.dirUrl);
      } catch (error) {
        entries = null;
      }
      if (this.pickerFor !== index || this.list !== list) {
        return;
      }
      list.textContent = "";
      if (!entries) {
        list.appendChild(createElement("div", "mdv-row mdv-row-muted", "Directory listing unavailable"));
        return;
      }
      this.fillDirectory(entries, item);
    }

    positionPicker(index) {
      const crumb = this.bar.children[index * 2];
      const barRect = this.bar.getBoundingClientRect();
      const width = Math.min(560, window.innerWidth - 16);
      let left = crumb ? crumb.getBoundingClientRect().left : 8;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      this.picker.style.left = left + "px";
      this.picker.style.top = barRect.bottom + "px";
      this.picker.style.width = width + "px";
    }

    // outline rows, collapsed by default, expanded along the path to the selected heading
    fillOutline(selectedHeading) {
      const minLevel = this.headings.reduce((min, heading) => Math.min(min, heading.level), 6);
      this.expanded = new Set();
      for (let heading = selectedHeading.parent; heading; heading = heading.parent) {
        this.expanded.add(heading);
      }
      let selected = 0;
      this.headings.forEach((heading, index) => {
        const row = createElement("div", "mdv-row mdv-row-heading");
        row.style.setProperty("--indent", (heading.level - minLevel) * 14 + "px");
        row.title = heading.text;
        const twistie = createElement("span", "mdv-twistie");
        if (heading.children.length) {
          twistie.classList.add("mdv-twistie-parent");
          twistie.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.selectRow(index);
            this.toggleRow(index);
          });
        }
        row.append(twistie, createElement("span", "mdv-row-label", headingLabel(heading)));
        this.addRow(row, { kind: "heading", heading, label: headingLabel(heading) });
        if (heading === selectedHeading) {
          selected = index;
        }
      });
      this.refreshRows();
      this.selectRow(selected, "center");
    }

    fillDirectory(entries, item) {
      const sorted = entries
        .filter((entry) => entry.name !== "." && entry.name !== "..")
        .sort((a, b) => {
          if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
          }
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });
      const parentUrl = new URL("..", item.dirUrl).href;
      sorted.unshift({ name: "..", isDir: true, href: "..", url: parentUrl });
      let selected = 0;
      sorted.forEach((entry, index) => {
        const url = entry.url || new URL(entry.href + (entry.isDir ? "/" : ""), item.dirUrl).href;
        const label = entry.isDir ? entry.name + "/" : entry.name;
        const row = createElement("div", "mdv-row " + (entry.isDir ? "mdv-row-dir" : "mdv-row-file"));
        row.title = url;
        row.append(createElement("span", "mdv-twistie"), createElement("span", "mdv-row-label", label));
        this.addRow(row, { kind: entry.isDir ? "dir" : "file", url, label });
        if (entry.name === item.selectName) {
          selected = index;
        }
      });
      this.refreshRows();
      this.selectRow(selected, "center");
    }

    addRow(node, data) {
      const rowIndex = this.rows.length;
      node.setAttribute("role", "treeitem");
      node.addEventListener("click", (event) => {
        event.preventDefault();
        this.selectRow(rowIndex);
        this.pickRow();
      });
      this.rows.push({ node, data, hidden: false });
      this.list.appendChild(node);
    }

    // tree state helpers

    isParent(row) {
      return row.data.kind === "heading" && row.data.heading.children.length > 0;
    }

    isExpanded(row) {
      return this.isParent(row) && this.expanded.has(row.data.heading);
    }

    rowIndexOf(heading) {
      return this.rows.findIndex((row) => row.data.heading === heading);
    }

    matchesFilter(row) {
      return !this.filterQuery || row.data.label.toLowerCase().includes(this.filterQuery);
    }

    // Recompute which rows show. Without a filter a row shows when every ancestor
    // is expanded. With a filter, matches and their ancestors show regardless.
    refreshRows() {
      const keep = new Set();
      if (this.filterQuery) {
        this.rows.forEach((row, index) => {
          if (!this.matchesFilter(row)) {
            return;
          }
          keep.add(index);
          let heading = row.data.kind === "heading" ? row.data.heading.parent : null;
          while (heading) {
            keep.add(this.rowIndexOf(heading));
            heading = heading.parent;
          }
        });
      }
      this.rows.forEach((row, index) => {
        let visible;
        if (this.filterQuery) {
          visible = keep.has(index);
        } else if (row.data.kind === "heading") {
          visible = true;
          for (let heading = row.data.heading.parent; heading; heading = heading.parent) {
            if (!this.expanded.has(heading)) {
              visible = false;
              break;
            }
          }
        } else {
          visible = true;
        }
        row.hidden = !visible;
        row.node.classList.toggle("hidden", !visible);
        row.node.classList.toggle("match", Boolean(this.filterQuery) && this.matchesFilter(row));
        if (this.isParent(row)) {
          const open = Boolean(this.filterQuery) || this.expanded.has(row.data.heading);
          row.node.classList.toggle("expanded", open);
          row.node.setAttribute("aria-expanded", open ? "true" : "false");
        }
      });
    }

    expandRow(index) {
      const row = this.rows[index];
      if (!row || !this.isParent(row) || this.expanded.has(row.data.heading)) {
        return false;
      }
      this.expanded.add(row.data.heading);
      this.refreshRows();
      return true;
    }

    collapseRow(index) {
      const row = this.rows[index];
      if (!row || !this.isExpanded(row)) {
        return false;
      }
      this.expanded.delete(row.data.heading);
      this.refreshRows();
      return true;
    }

    toggleRow(index) {
      if (!this.collapseRow(index)) {
        this.expandRow(index);
      }
    }

    selectRow(index, block = "nearest") {
      if (this.selectedRow >= 0 && this.rows[this.selectedRow]) {
        this.rows[this.selectedRow].node.classList.remove("selected");
      }
      this.selectedRow = index;
      const row = this.rows[index];
      if (!row) {
        return;
      }
      row.node.classList.add("selected");
      row.node.scrollIntoView({ block });
    }

    visibleRowIndexes() {
      const indexes = [];
      this.rows.forEach((row, index) => {
        if (!row.hidden) {
          indexes.push(index);
        }
      });
      return indexes;
    }

    moveSelection(delta) {
      const visible = this.visibleRowIndexes();
      if (visible.length === 0) {
        return;
      }
      let position = visible.indexOf(this.selectedRow);
      if (position === -1) {
        position = delta > 0 ? -1 : visible.length;
      }
      position = Math.max(0, Math.min(visible.length - 1, position + delta));
      this.selectRow(visible[position]);
    }

    selectEdge(last) {
      const visible = this.visibleRowIndexes();
      if (visible.length === 0) {
        return;
      }
      this.selectRow(last ? visible[visible.length - 1] : visible[0]);
    }

    selectedData() {
      const row = this.rows[this.selectedRow];
      return row && !row.hidden ? row.data : null;
    }

    // list.collapse, left inside the picker
    collapseOrParent() {
      const row = this.rows[this.selectedRow];
      if (!row || this.filterQuery) {
        return;
      }
      if (this.collapseRow(this.selectedRow)) {
        return;
      }
      const parent = row.data.kind === "heading" ? row.data.heading.parent : null;
      if (parent) {
        this.selectRow(this.rowIndexOf(parent));
      }
    }

    // list.expand, right inside the picker
    expandOrFirstChild() {
      const row = this.rows[this.selectedRow];
      if (!row || this.filterQuery) {
        return;
      }
      if (this.expandRow(this.selectedRow)) {
        return;
      }
      if (this.isParent(row)) {
        this.selectRow(this.rowIndexOf(row.data.heading.children[0]));
      }
    }

    // list.toggleExpand, space inside the picker
    toggleOrPick() {
      const row = this.rows[this.selectedRow];
      if (!row) {
        return;
      }
      if (this.isParent(row) && !this.filterQuery) {
        this.toggleRow(this.selectedRow);
      } else {
        this.pickRow();
      }
    }

    // list.select, enter inside the picker
    pickRow() {
      const data = this.selectedData();
      if (!data) {
        return;
      }
      if (data.kind === "heading") {
        this.revealHeading(data.heading);
        this.selectEditor();
      } else {
        location.href = data.url;
      }
    }

    // ctrl+enter inside the picker
    openRowAside() {
      const data = this.selectedData();
      if (!data) {
        return;
      }
      window.open(data.kind === "heading" ? this.headingUrl(data.heading) : data.url, "_blank");
    }

    // filter box, ctrl+f inside the picker

    openFilter() {
      if (!this.picker) {
        return;
      }
      if (this.filterInput) {
        this.filterInput.focus();
        this.filterInput.select();
        return;
      }
      const wrapper = createElement("div", "mdv-filter");
      const input = createElement("input", "mdv-filter-input");
      input.type = "text";
      input.placeholder = "Filter";
      input.spellcheck = false;
      wrapper.appendChild(input);
      this.picker.insertBefore(wrapper, this.list);
      this.filterInput = input;
      input.addEventListener("input", () => this.applyFilter(input.value));
      input.focus();
    }

    closeFilter() {
      if (!this.filterInput) {
        return;
      }
      this.filterInput.parentElement.remove();
      this.filterInput = null;
      this.applyFilter("");
      this.bar.focus({ preventScroll: true });
    }

    applyFilter(query) {
      this.filterQuery = query.trim().toLowerCase();
      this.refreshRows();
      const current = this.rows[this.selectedRow];
      if (current && !current.hidden && this.matchesFilter(current)) {
        current.node.scrollIntoView({ block: "nearest" });
        return;
      }
      const firstMatch = this.rows.findIndex((row) => !row.hidden && this.matchesFilter(row));
      if (firstMatch >= 0) {
        this.selectRow(firstMatch);
      }
    }

    // keys

    onKeyDown(event) {
      if (event.target instanceof Element && event.target.closest(".mdv-quick")) {
        return;
      }
      if (matchesChord(event, FOCUS_AND_SELECT)) {
        event.preventDefault();
        event.stopPropagation();
        this.focusAndSelect();
        return;
      }
      if (!this.active) {
        return;
      }
      const inFilter = this.filterInput !== null && event.target === this.filterInput;
      const inPicker = this.pickerFor !== null;
      const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
      let handled = true;

      switch (event.key) {
        case "Escape":
          if (this.filterInput) {
            this.closeFilter();
          } else {
            this.selectEditor();
          }
          break;
        case "ArrowLeft":
          if (inFilter) {
            handled = false;
          } else if (!inPicker || ctrl) {
            this.focusPrevious();
          } else {
            this.collapseOrParent();
          }
          break;
        case "ArrowRight":
          if (inFilter) {
            handled = false;
          } else if (!inPicker || ctrl) {
            this.focusNext();
          } else {
            this.expandOrFirstChild();
          }
          break;
        case "ArrowDown":
          if (inPicker) {
            this.moveSelection(1);
          } else {
            this.selectFocused();
          }
          break;
        case "ArrowUp":
          if (inPicker) {
            this.moveSelection(-1);
          } else {
            handled = false;
          }
          break;
        case "PageDown":
          if (inPicker) {
            this.moveSelection(PAGE_STEP);
          } else {
            handled = false;
          }
          break;
        case "PageUp":
          if (inPicker) {
            this.moveSelection(-PAGE_STEP);
          } else {
            handled = false;
          }
          break;
        case "Home":
          if (inPicker && !inFilter) {
            this.selectEdge(false);
          } else {
            handled = false;
          }
          break;
        case "End":
          if (inPicker && !inFilter) {
            this.selectEdge(true);
          } else {
            handled = false;
          }
          break;
        case "Enter":
          if (inPicker) {
            if (event.ctrlKey) {
              this.openRowAside();
            } else {
              this.pickRow();
            }
          } else if (event.ctrlKey) {
            this.revealFocusedAside();
          } else {
            this.selectFocused();
          }
          break;
        case " ":
          if (inFilter) {
            handled = false;
          } else if (inPicker) {
            this.toggleOrPick();
          } else {
            this.revealFocused();
          }
          break;
        case "f":
        case "F":
          if (ctrl && !event.shiftKey && inPicker) {
            this.openFilter();
          } else {
            handled = false;
          }
          break;
        default:
          handled = false;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      } else if (!inFilter && plain && event.key.length === 1) {
        // Swallow stray typing while the bar is active so the page does not react.
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  window.MdvBreadcrumbs = Breadcrumbs;
})();
