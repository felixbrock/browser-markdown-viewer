// Section search, modelled on VS Code's "Go to Symbol in Editor" quick pick
// (ctrl+t in Felix's keybindings). Opened through the extension command bound
// to ctrl+t, see service-worker.js. Type to filter the headings, up and down
// preview the section under the cursor, enter jumps, escape restores the view.

(() => {
  "use strict";

  const PAGE_STEP = 10;

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

  function isWordStart(text, index) {
    return index === 0 || /[\s\-_/(\[#.,]/.test(text[index - 1]);
  }

  // One search term against one label. A contiguous hit scores highest, then a
  // subsequence with bonuses for word starts and neighbouring characters.
  function matchTerm(term, label) {
    const lower = label.toLowerCase();
    const at = lower.indexOf(term);
    if (at >= 0) {
      const positions = [];
      for (let index = 0; index < term.length; index++) {
        positions.push(at + index);
      }
      return { score: 1000 + (isWordStart(lower, at) ? 100 : 0) - at, positions };
    }
    const positions = [];
    let from = 0;
    let previous = -2;
    let score = 0;
    for (const char of term) {
      const found = lower.indexOf(char, from);
      if (found === -1) {
        return null;
      }
      score += 10;
      if (isWordStart(lower, found)) {
        score += 8;
      }
      if (found === previous + 1) {
        score += 6;
      }
      positions.push(found);
      previous = found;
      from = found + 1;
    }
    return { score, positions };
  }

  // Every word must hit the heading, a word that misses the heading may hit the
  // parent heading instead (VS Code's container query), at half the score.
  function matchQuery(query, label, parentLabel) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return { score: 0, positions: [], parentPositions: [] };
    }
    let score = 0;
    const positions = new Set();
    const parentPositions = new Set();
    for (const term of terms) {
      let match = matchTerm(term, label);
      if (match) {
        score += match.score;
        match.positions.forEach((position) => positions.add(position));
        continue;
      }
      match = parentLabel ? matchTerm(term, parentLabel) : null;
      if (!match) {
        return null;
      }
      score += match.score / 2;
      match.positions.forEach((position) => parentPositions.add(position));
    }
    const sorted = (set) => Array.from(set).sort((a, b) => a - b);
    return { score, positions: sorted(positions), parentPositions: sorted(parentPositions) };
  }

  function renderLabel(label, positions) {
    const fragment = document.createDocumentFragment();
    const marks = new Set(positions);
    let run = "";
    let marked = false;
    const flush = () => {
      if (!run) {
        return;
      }
      fragment.appendChild(marked ? createElement("span", "mdv-hl", run) : document.createTextNode(run));
      run = "";
    };
    for (let index = 0; index < label.length; index++) {
      const isMark = marks.has(index);
      if (isMark !== marked) {
        flush();
        marked = isMark;
      }
      run += label[index];
    }
    flush();
    return fragment;
  }

  class SectionSearch {
    constructor(options) {
      this.getHeadings = options.getHeadings;
      this.getCurrent = options.getCurrent;
      this.reveal = options.reveal;
      this.onCancel = options.onCancel;
      this.root = null;
      this.input = null;
      this.list = null;
      this.rows = [];
      this.selected = -1;
      this.originalScroll = 0;
      this.onDocumentMouseDown = (event) => {
        if (this.root && !this.root.contains(event.target)) {
          this.cancel();
        }
      };
    }

    get open() {
      return this.root !== null;
    }

    // workbench.action.gotoSymbol, pressed again while open moves to the next row
    show() {
      if (this.open) {
        this.move(1);
        return;
      }
      this.originalScroll = window.scrollY;
      const root = createElement("div", "mdv-quick");
      const box = createElement("div", "mdv-quick-input");
      const prefix = createElement("span", "mdv-quick-prefix", "@");
      const input = createElement("input", "mdv-quick-field");
      input.type = "text";
      input.placeholder = "Go to section";
      input.spellcheck = false;
      input.setAttribute("aria-label", "Go to section");
      box.append(prefix, input);
      const list = createElement("div", "mdv-quick-list");
      root.append(box, list);
      document.body.appendChild(root);
      this.root = root;
      this.input = input;
      this.list = list;
      input.addEventListener("input", () => this.render(input.value, true));
      root.addEventListener("keydown", (event) => this.onKeyDown(event));
      document.addEventListener("mousedown", this.onDocumentMouseDown, true);
      this.render("", false);
      input.focus();
    }

    close() {
      if (!this.root) {
        return;
      }
      document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
      this.root.remove();
      this.root = null;
      this.input = null;
      this.list = null;
      this.rows = [];
      this.selected = -1;
    }

    cancel() {
      if (!this.open) {
        return;
      }
      this.close();
      window.scrollTo(0, this.originalScroll);
      this.onCancel();
    }

    accept() {
      const row = this.rows[this.selected];
      this.close();
      if (row) {
        this.reveal(row.heading);
      }
    }

    render(query, preview) {
      const headings = this.getHeadings();
      const before = this.rows[this.selected] ? this.rows[this.selected].heading : null;
      const rows = [];
      headings.forEach((heading, index) => {
        const label = "#".repeat(heading.level) + " " + heading.text;
        const parentLabel = heading.parent ? "#".repeat(heading.parent.level) + " " + heading.parent.text : "";
        const match = matchQuery(query, label, parentLabel);
        if (match) {
          rows.push({
            heading,
            label,
            parentLabel,
            index,
            score: match.score,
            positions: match.positions,
            parentPositions: match.parentPositions
          });
        }
      });
      if (query.trim()) {
        rows.sort((a, b) => b.score - a.score || a.index - b.index);
      }
      this.rows = rows;
      this.list.textContent = "";
      if (rows.length === 0) {
        this.list.appendChild(createElement("div", "mdv-quick-empty", "No matching sections"));
        this.selected = -1;
        return;
      }
      rows.forEach((row, position) => {
        const node = createElement("div", "mdv-quick-row");
        const label = createElement("span", "mdv-quick-label");
        label.appendChild(renderLabel(row.label, row.positions));
        node.appendChild(label);
        if (row.parentLabel) {
          const description = createElement("span", "mdv-quick-desc");
          description.appendChild(renderLabel(row.parentLabel, row.parentPositions));
          node.appendChild(description);
        }
        if (position === 0) {
          node.appendChild(createElement("span", "mdv-quick-count", "sections (" + rows.length + ")"));
        }
        node.title = row.parentLabel ? row.heading.text + "  in  " + row.parentLabel : row.heading.text;
        node.addEventListener("click", (event) => {
          event.preventDefault();
          this.selected = position;
          this.accept();
        });
        row.node = node;
        this.list.appendChild(node);
      });
      let target = 0;
      if (query.trim() === "") {
        const current = this.getCurrent();
        const currentIndex = rows.findIndex((row) => row.heading === current);
        target = currentIndex >= 0 ? currentIndex : 0;
      }
      this.selected = -1;
      const changed = rows[target].heading !== before;
      this.select(target, preview && changed);
    }

    select(position, preview) {
      if (this.selected >= 0 && this.rows[this.selected]) {
        this.rows[this.selected].node.classList.remove("selected");
      }
      this.selected = position;
      const row = this.rows[position];
      if (!row) {
        return;
      }
      row.node.classList.add("selected");
      row.node.scrollIntoView({ block: "nearest" });
      if (preview) {
        this.reveal(row.heading);
      }
    }

    move(delta) {
      if (this.rows.length === 0) {
        return;
      }
      let next = this.selected + delta;
      if (Math.abs(delta) === 1) {
        next = (next + this.rows.length) % this.rows.length;
      } else {
        next = Math.max(0, Math.min(this.rows.length - 1, next));
      }
      this.select(next, true);
    }

    onKeyDown(event) {
      let handled = true;
      switch (event.key) {
        case "ArrowDown":
          this.move(1);
          break;
        case "ArrowUp":
          this.move(-1);
          break;
        case "PageDown":
          this.move(PAGE_STEP);
          break;
        case "PageUp":
          this.move(-PAGE_STEP);
          break;
        case "Enter":
          this.accept();
          break;
        case "Escape":
          this.cancel();
          break;
        default:
          handled = false;
      }
      if (handled) {
        event.preventDefault();
      }
      event.stopPropagation();
    }
  }

  window.MdvSectionSearch = SectionSearch;
})();
