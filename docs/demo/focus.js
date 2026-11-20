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
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    // a dropdown is clicked; a list box (multiple, or size > 1) is worked from the keyboard (Space selects in it)
    if (tag === "SELECT") return !el.multiple && !(el.size > 1);
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
  /* The slider a pointer is dragging right now (set by install). */
  let dragHeld = null;
  /** Record how `el` got focus: true = keyboard / code, false = pointer. */
  function noteFocus(el, byKeyboard) { keyFocused = byKeyboard ? el : null; }
  /** Space with focus on `el` should play the timeline, not press `el`. */
  function spaceShouldPlay(el) {
    // a slider still under the pointer keeps its focus: released mid-drag, playback would move its thumb under the pointer
    return isClickControl(el) && !inKeyboardScope(el) && el !== keyFocused && el !== dragHeld;
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
    // the slider a pointer is dragging and that pointer's id, until that same pointer
    // lifts or cancels (a key pressed mid-drag, or a second finger, doesn't end it)
    let dragging = null, dragPointer = null;
    // bumped by each new drag, so a release left pending by the last one can't blur it
    let dragGen = 0;
    // The pointerdown a click comes from. byPointer only says what the last input was;
    // a screen reader's virtual-cursor click fires `click` with no pointerdown, so a
    // click counts as a mouse click only when a pointerdown on that same element came
    // just before it.
    let downOn = null, downAt = 0;
    const CLICK_MS = 1500;   // a press held longer than this isn't paired (the click is left to the keyboard path)
    win.addEventListener("pointerdown", (e) => {
      // only the primary button: a right-click opens a menu, it doesn't use the control
      if (e.button > 0) return;
      byPointer = true;
      downOn = e.target; downAt = Date.now();
      // clicking a control that already had keyboard focus (no new focusin): it is now a mouse focus
      if (keyFocused && (e.target === keyFocused || (keyFocused.contains && keyFocused.contains(e.target)))) keyFocused = null;
      const t = e.target;
      if (dragging) return;   // another pointer is already dragging a slider
      if (t && t.tagName === "INPUT" && t.type === "range") { dragging = dragHeld = t; dragPointer = e.pointerId; dragGen++; }
    }, { capture: true, passive: true });
    // a press the browser cancelled (a touch that became a scroll) clicks nothing
    win.addEventListener("pointercancel", () => { downOn = null; }, { capture: true, passive: true });
    win.addEventListener("keydown", () => { byPointer = false; }, { capture: true, passive: true });
    /** True when `t` is the element a recent mouse press landed on (or its label / control):
        the focus or click on `t` comes from that press. Anything else (Tab, a screen reader's
        virtual cursor, el.focus() / el.click() from code) is not from the mouse. */
    const fromPress = (t) => byPointer && !!downOn && !!t && Date.now() - downAt < CLICK_MS &&
      (downOn === t || (downOn.contains && downOn.contains(t)) || (t.contains && t.contains(downOn)) ||
       (t.control && (t.control === downOn || (t.control.contains && t.control.contains(downOn)))) ||
       (downOn.control && downOn.control === t) || pressedLabelOf(t));
    // a press on the text inside a <label> focuses the label's control
    const pressedLabelOf = (t) => {
      const lab = downOn.closest && downOn.closest("label");
      return !!lab && (lab.control === t || (lab.contains && lab.contains(t)));
    };
    doc.addEventListener("focusin", (e) => noteFocus(e.target, !fromPress(e.target)), true);
    // Bubble phase: the control's own click handler has run by now.
    win.addEventListener("click", (e) => {
      const paired = fromPress(e.target);
      // A click on a label is passed on to its control (focus, then a click of its own)
      // after this listener has run: keep the press for that one.
      const lab = paired && e.target && e.target.closest && e.target.closest("label");
      const passesOn = !!(lab && lab.control && lab.control !== e.target && !(lab.control.contains && lab.control.contains(e.target)));
      if (!passesOn) downOn = null;
      if (!paired) return;   // a click with no mouse press (screen reader, el.click() in code): focus stays
      const el = doc.activeElement;
      // a <select> stays focused while its list is open; a text field is typed into
      if (!el || !isClickControl(el) || el.tagName === "SELECT") return;
      const t = e.target;
      const label = t && t.closest && t.closest("label");
      if (el === t || el.contains(t) || (label && (label.contains(el) || label.control === el))) release(el);
    });
    // A slider lets go when the drag ends; a select once a value is picked.
    // that pointer lifting, or the browser cancelling it (a touch turned into a scroll), ends the drag
    const endDrag = (e) => {
      if (!dragging || e.pointerId !== dragPointer) return;
      const el = dragging;
      dragging = dragHeld = null; dragPointer = null;
      const gen = dragGen;
      setTimeout(() => { if (gen === dragGen && doc.activeElement === el) release(el); }, 0);
    };
    win.addEventListener("pointerup", endDrag, true);
    win.addEventListener("pointercancel", endDrag, true);
    win.addEventListener("change", (e) => {
      const el = e.target;
      // picked from a select the mouse focused (a key held meanwhile, Shift say, doesn't change that)
      if (el === doc.activeElement && el.tagName === "SELECT" && el !== keyFocused) release(el);
    });
    // A native select picker closed without a change (Esc, a click outside, the
    // same option) leaves the select focused, and ←/→ would change its value
    // instead of moving the playhead. An arrow key on a select still focused from
    // the mouse lets it go first, so the editor's arrow shortcuts run (Space is
    // handled by the editor's Space check). The picker is closed by then: while
    // it is open the browser keeps the keys, so nothing here closes it early.
    win.addEventListener("keydown", (e) => {
      const el = doc.activeElement;
      if (!el || el.tagName !== "SELECT" || el === keyFocused || inKeyboardScope(el)) return;
      // the editor's themed list (select-menu.js) is open on it: the arrows move through the list
      if (el.classList && el.classList.contains("fc-open")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") release(el);
    }, true);
  }

  /** True while a pointer is dragging slider `el`: Space neither plays nor presses it then. */
  function isDragging(el) { return el != null && el === dragHeld; }

  return { isClickControl, inKeyboardScope, spaceShouldPlay, isDragging, noteFocus, release, install, KEYBOARD_SCOPE };
});
