// Position history for alt+left and alt+right, modelled on VS Code's
// workbench.action.navigateBack and navigateForward. An entry is a viewport
// position. Deliberate jumps (picker, section search, anchor links) add an
// entry, so do big manual moves, small moves update the current entry in
// place. While the section search previews sections nothing is recorded. With
// no entry left in a direction the key is left to the browser, which then
// walks its own page history.

(() => {
  "use strict";

  const MAX_ENTRIES = 50;
  const SETTLE_MS = 250;
  const IDENTICAL_PX = 4;
  const NAVIGATE_TIMEOUT_MS = 600;

  class NavigationHistory {
    constructor(options) {
      this.capture = options.capture;
      this.restore = options.restore;
      this.bigMove = options.bigMove;
      this.entries = [];
      this.index = -1;
      this.navigating = false;
      this.skipNextSettle = false;
      this.suspended = false;
      this.timer = 0;
      this.navigateTimer = 0;
      window.addEventListener("scroll", () => this.onScroll(), { passive: true });
      window.addEventListener("keydown", (event) => this.onKeyDown(event), true);
      window.addEventListener("hashchange", () => this.record());
    }

    get current() {
      return this.entries[this.index];
    }

    get canGoBack() {
      return this.index > 0;
    }

    get canGoForward() {
      return this.index >= 0 && this.index < this.entries.length - 1;
    }

    reset() {
      this.entries = [this.capture()];
      this.index = 0;
    }

    // Previews in flight, nothing gets recorded until resume.
    suspend() {
      this.suspended = true;
    }

    resume() {
      this.suspended = false;
      this.clearTimer();
    }

    // A deliberate jump, run it and record where it landed.
    jump(action) {
      this.settleNow();
      action();
      this.record();
    }

    record() {
      if (this.suspended || this.index < 0) {
        return;
      }
      const position = this.capture();
      if (Math.abs(position.y - this.current.y) <= IDENTICAL_PX) {
        this.entries[this.index] = position;
        return;
      }
      this.push(position);
      this.skipNextSettle = true;
    }

    push(position) {
      this.entries.splice(this.index + 1);
      this.entries.push(position);
      if (this.entries.length > MAX_ENTRIES) {
        this.entries.shift();
      }
      this.index = this.entries.length - 1;
    }

    clearTimer() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = 0;
      }
    }

    settleNow() {
      if (this.timer) {
        this.clearTimer();
        this.onSettle();
      }
    }

    onScroll() {
      this.clearTimer();
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        this.onSettle();
      }, SETTLE_MS);
    }

    onSettle() {
      if (this.suspended || this.index < 0) {
        return;
      }
      if (this.navigating || this.skipNextSettle) {
        this.navigating = false;
        this.skipNextSettle = false;
        this.entries[this.index] = this.capture();
        return;
      }
      const position = this.capture();
      if (Math.abs(position.y - this.current.y) >= this.bigMove()) {
        this.push(position);
      } else {
        this.entries[this.index] = position;
      }
    }

    go(delta) {
      const target = this.index + delta;
      if (this.index < 0 || target < 0 || target >= this.entries.length) {
        return false;
      }
      this.settleNow();
      this.entries[this.index] = this.capture();
      this.index = target;
      const before = window.scrollY;
      this.navigating = true;
      this.restore(this.current);
      if (Math.abs(window.scrollY - before) <= IDENTICAL_PX) {
        this.navigating = false;
      } else {
        clearTimeout(this.navigateTimer);
        this.navigateTimer = window.setTimeout(() => {
          this.navigating = false;
        }, NAVIGATE_TIMEOUT_MS);
      }
      return true;
    }

    // workbench.action.navigateBack
    back() {
      return this.go(-1);
    }

    // workbench.action.navigateForward
    forward() {
      return this.go(1);
    }

    onKeyDown(event) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      let handled = false;
      if (event.key === "ArrowLeft") {
        handled = this.back();
      } else if (event.key === "ArrowRight") {
        handled = this.forward();
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  window.MdvHistory = NavigationHistory;
})();
