// Platform modifiers, shared by the content scripts.
//
// Linux chords use ctrl, macOS chords use cmd, like the VS Code defaults on
// each platform. Felix's keyboard remap on macOS follows the same split.
//   primary     ctrl on Linux, cmd on macOS (ctrl+f, ctrl+enter, ctrl+shift+v)
//   crumbStep    ctrl+left and ctrl+right on Linux, option+left and
//                option+right on macOS, the picker moves to the next crumb
//   historyStep  alt+left and alt+right on Linux, cmd+[ and cmd+] on macOS
// macOS has no home and end in text, the remap sends cmd+left and cmd+right
// there and cmd+up and cmd+down for ctrl+home and ctrl+end.

(() => {
  "use strict";

  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  const IS_MAC = /^mac/i.test(platform);

  // The primary modifier alone, shift may come along.
  function primary(event) {
    return IS_MAC
      ? event.metaKey && !event.ctrlKey && !event.altKey
      : event.ctrlKey && !event.metaKey && !event.altKey;
  }

  function crumbStep(event) {
    return IS_MAC
      ? event.altKey && !event.ctrlKey && !event.metaKey
      : event.ctrlKey && !event.altKey && !event.metaKey;
  }

  // -1 for back, 1 for forward, 0 for any other key.
  function historyStep(event) {
    if (event.shiftKey) {
      return 0;
    }
    if (IS_MAC) {
      if (!event.metaKey || event.ctrlKey || event.altKey) {
        return 0;
      }
      return event.code === "BracketLeft" ? -1 : event.code === "BracketRight" ? 1 : 0;
    }
    if (!event.altKey || event.ctrlKey || event.metaKey) {
      return 0;
    }
    return event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  }

  window.MdvKeys = { IS_MAC, primary, crumbStep, historyStep };
})();
