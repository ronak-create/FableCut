/* FableCut focus hygiene — keyboard shortcuts keep working after the mouse
   uses a control.

   A button, checkbox, slider or <select> keeps keyboard focus after it is
   clicked. Space then pressed that control again (re-toggling Snap, say)
   instead of playing the timeline, and ←/→ nudged the last slider instead of
   stepping the playhead. Here:

   - a control used with the mouse gives focus back to the page once the click
     or drag is over (its own handler runs first; if that moves focus on, into
     a popover's field say, it is left alone);
   - Space on a control that still has focus from the mouse plays the timeline
     (spaceShouldPlay, used by the editor's Space handler).

   Inside a dialog or a popover nothing changes: Tab / Space / Enter work there
   as usual. A control reached with Tab keeps its focus and Space presses it,
   so the editor stays usable from the keyboard. Text fields are never touched.

   Loaded by the editor as a plain script (global `FableCutFocus`, installed on
   load) and required by the tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.FableCutFocus = api;
    if (typeof document !== "undefined") api.install(root, document);
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Where keys belong to the UI under focus (dialogs, popovers, menus). */
  const KEYBOARD_SCOPE = ".overlay, .ctx-menu, .style-menu, [role=dialog], [role=menu], [role=listbox]";
  /* <input> types that are clicked or dragged, not typed into. */
  const CLICK_INPUTS = ["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"];
  const CLICK_ROLES = ["button", "tab", "checkbox", "switch"];

  /** A control that is clicked or dragged, not typed into. */
  function isClickControl(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === "BUTTON" || tag === "SELECT" || tag === "SUMMARY") return true;
    if (tag === "INPUT") return CLICK_INPUTS.includes(String(el.type || "text").toLowerCase());
    if (tag === "A") return !!(el.hasAttribute && el.hasAttribute("href"));
    const role = el.getAttribute && el.getAttribute("role");
    return CLICK_ROLES.includes(role);
  }
  /** Inside a dialog, popover or menu, where keys belong to that UI. */
  function inKeyboardScope(el) {
    return !!(el && el.closest && el.closest(KEYBOARD_SCOPE));
  }
  /* The element that last got focus from the keyboard (Tab) or from code, not a click.
     :focus-visible can't tell: Chrome turns it on for a focused <select> as soon as a key is pressed. */
  let keyFocused = null;
  /** Record how `el` got focus: true = keyboard / code, false = pointer. */
  function noteFocus(el, byKeyboard) { keyFocused = byKeyboard ? el : null; }
  /** Space with focus on `el` should play the timeline, not press `el`. */
  function spaceShouldPlay(el) {
    return isClickControl(el) && !inKeyboardScope(el) && el !== keyFocused;
  }
  /** Give focus back to the page when `el` is a click control outside a dialog. */
  function release(el) {
    if (!isClickControl(el) || inKeyboardScope(el)) return false;
    el.blur();
    return true;
  }

  function install(win, doc) {
    if (install.done) return;
    install.done = true;
    let byPointer = false;
    win.addEventListener("pointerdown", () => { byPointer = true; }, { capture: true, passive: true });
    win.addEventListener("keydown", () => { byPointer = false; }, { capture: true, passive: true });
    doc.addEventListener("focusin", (e) => noteFocus(e.target, !byPointer), true);
    // Bubble phase: the control's own click handler has run by now.
    win.addEventListener("click", (e) => {
      if (!byPointer) return;
      const el = doc.activeElement;
      // a <select> stays focused while its list is open; a text field is typed into
      if (!el || !isClickControl(el) || el.tagName === "SELECT") return;
      const t = e.target;
      const label = t && t.closest && t.closest("label");
      if (el === t || el.contains(t) || (label && (label.contains(el) || label.control === el))) release(el);
    });
    // A slider lets go when the drag ends; a select once a value is picked.
    win.addEventListener("pointerup", () => {
      const el = doc.activeElement;
      if (byPointer && el && el.tagName === "INPUT" && el.type === "range")
        setTimeout(() => { if (doc.activeElement === el) release(el); }, 0);
    }, true);
    win.addEventListener("change", (e) => {
      const el = e.target;
      if (byPointer && el === doc.activeElement && el.tagName === "SELECT") release(el);
    });
  }

  return { isClickControl, inKeyboardScope, spaceShouldPlay, noteFocus, release, install, KEYBOARD_SCOPE };
});
