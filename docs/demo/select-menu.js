/* FableCut select menus — every <select> in the editor opens a list drawn in
   the editor's theme instead of the browser's native popup (which ignores the
   dark theme and differs per OS).

   The <select> stays in the page and stays the source of truth: code that
   builds options, reads .value or listens for input / change works unchanged,
   including selects rebuilt with innerHTML (one set of listeners on window
   serves them all). Opening one with the mouse does not focus it, so Space
   still plays the timeline after a pick.

   Keyboard: on a focused select, Space / Enter / ↑ / ↓ / Alt+↓ / F4 open the
   list. In the list ↑ ↓ Home End PageUp PageDown move, typing jumps to the
   next match, Enter / Space pick, Esc closes, Tab closes and moves on.
   Optgroups show as headings; disabled and hidden options are respected.
   <select multiple>, <select size="n"> and <select data-native> keep the
   browser's own control.

   Loaded by the editor as a plain script (global `FableCutSelect`, installed
   on load) and required by the tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.FableCutSelect = api;
    if (typeof document !== "undefined") api.install(root, document);
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_H = 340;   // px, the list's tallest
  const PAGE = 8;      // items a PageUp / PageDown moves

  /** Selects that get the themed list. */
  function isThemed(sel) {
    return !!sel && sel.tagName === "SELECT" && !sel.multiple && !(sel.size > 1) && !sel.hasAttribute("data-native");
  }
  /** An option's label as shown in the list (its label, else its text), whitespace collapsed. */
  function optionText(o) {
    return String(o.label || o.textContent || "").replace(/\s+/g, " ").trim();
  }
  /** The select's rows in order: { group } headings and { option } entries (hidden options dropped). */
  function rows(sel) {
    const out = [];
    for (const child of sel.children) {
      if (child.tagName === "OPTGROUP") {
        out.push({ group: child.label || "", disabled: !!child.disabled });
        for (const o of child.children)
          if (o.tagName === "OPTION" && !o.hidden) out.push({ option: o, inGroup: true, disabled: !!(o.disabled || child.disabled) });
      } else if (child.tagName === "OPTION" && !child.hidden) out.push({ option: child, inGroup: false, disabled: !!child.disabled });
    }
    return out;
  }
  /** Index of the next enabled item from `from` going `dir` (±1); `from` when there is none. */
  function step(items, from, dir) {
    for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (!items[i].disabled) return i;
    return from;
  }
  /** Type-to-find: the first enabled item from `start` (wrapping) whose text starts with `q`; -1 if none. */
  function findMatch(items, start, q) {
    q = q.toLowerCase();
    const n = items.length;
    for (let k = 0; k < n; k++) {
      const i = (((start + k) % n) + n) % n;
      if (!items[i].disabled && optionText(items[i].option).toLowerCase().startsWith(q)) return i;
    }
    return -1;
  }
  /** Where the list goes: under the select, or above it when there is more room there. */
  function placement(rect, viewH, listH, pad = 6) {
    const below = viewH - rect.bottom - pad, above = rect.top - pad;
    const down = below >= Math.min(listH, 200) || below >= above;
    const maxH = Math.min(MAX_H, Math.max(80, down ? below : above));
    const h = Math.min(listH, maxH);
    return { down, maxH, top: down ? rect.bottom + 2 : Math.max(pad, rect.top - 2 - h) };
  }

  /** Wire the themed lists to every <select> on the page through listeners on `win` (once). */
  function install(win, doc) {
    if (install.done) return;
    install.done = true;
    let open = null;   // { sel, list, items, active, byKey }
    let typed = "", typedAt = 0;

    /** Build the list element for `sel`: group headings and one row per visible option. Returns { list, items }. */
    function draw(sel) {
      const list = doc.createElement("div");
      list.className = "fc-select-list";
      list.setAttribute("role", "listbox");
      if (sel.id) list.id = sel.id + "-list";
      const items = [];
      for (const r of rows(sel)) {
        const d = doc.createElement("div");
        if (r.group !== undefined) {
          d.className = "fc-select-group";
          d.textContent = r.group;
        } else {
          const o = r.option;
          d.className = "fc-select-opt" + (r.inGroup ? " in-group" : "") + (r.disabled ? " disabled" : "") + (o.selected ? " selected" : "");
          d.setAttribute("role", "option");
          d.setAttribute("aria-selected", String(o.selected));
          if (r.disabled) d.setAttribute("aria-disabled", "true");
          d.textContent = optionText(o) || "\u00a0";
          if (o.title) d.title = o.title;
          if (sel.dataset.k === "font" && o.value) d.style.fontFamily = `"${o.value}", system-ui, sans-serif`;   // preview each font
          d.dataset.i = items.length;
          items.push({ el: d, option: o, disabled: r.disabled });
        }
        list.appendChild(d);
      }
      if (!items.length) {
        const d = doc.createElement("div");
        d.className = "fc-select-empty";
        d.textContent = "No options";
        list.appendChild(d);
      }
      return { list, items };
    }
    /** Size and position the open list beside its select, above it when there's more room there. */
    function place() {
      const { sel, list } = open;
      const r = sel.getBoundingClientRect(), pad = 6;
      list.style.minWidth = Math.max(r.width, 120) + "px";
      list.style.maxWidth = Math.max(r.width, Math.min(480, win.innerWidth - pad * 2)) + "px";
      const p = placement(r, win.innerHeight, list.scrollHeight, pad);
      list.style.maxHeight = p.maxH + "px";
      list.style.left = Math.max(pad, Math.min(r.left, win.innerWidth - list.offsetWidth - pad)) + "px";
      list.style.top = p.top + "px";
      list.classList.toggle("up", !p.down);
    }
    /** Highlight item `i` (clamped) as the keyboard's current row and point aria-activedescendant at it. */
    function activate(i, scroll = true) {
      if (!open || !open.items.length) return;
      i = Math.max(0, Math.min(open.items.length - 1, i));
      if (open.items[open.active]) open.items[open.active].el.classList.remove("active");
      open.active = i;
      const el = open.items[i].el;
      el.classList.add("active");
      if (el.id === "") el.id = "fc-opt-" + i;
      open.sel.setAttribute("aria-activedescendant", el.id);
      if (scroll) el.scrollIntoView({ block: "nearest" });
    }
    /** Open the list for `sel` (a second open on the same select closes it). `byKey`: opened from the keyboard. */
    function show(sel, byKey) {
      const again = open && open.sel === sel;
      close();
      if (again || sel.disabled || !sel.isConnected) return;
      const { list, items } = draw(sel);
      doc.body.appendChild(list);
      open = { sel, list, items, active: -1, byKey };
      sel.classList.add("fc-open");
      sel.setAttribute("aria-expanded", "true");
      if (list.id) sel.setAttribute("aria-controls", list.id);
      place();
      const cur = items.findIndex((x) => x.option.selected);
      activate(cur >= 0 ? cur : step(items, -1, 1));
      list.addEventListener("mousemove", (e) => {
        const d = e.target.closest(".fc-select-opt");
        if (d && !d.classList.contains("disabled")) activate(+d.dataset.i, false);
      });
      list.addEventListener("click", (e) => {
        const d = e.target.closest(".fc-select-opt");
        if (d && !d.classList.contains("disabled")) pick(+d.dataset.i);
      });
    }
    /** Close the open list, if any, and reset its select's open state. */
    function close() {
      if (!open) return;
      const { sel, list } = open;
      open = null;
      list.remove();
      sel.classList.remove("fc-open");
      sel.setAttribute("aria-expanded", "false");
      sel.removeAttribute("aria-activedescendant");
    }
    /** Choose item `i`: select its option, fire input + change when it changed, then close the list. */
    function pick(i) {
      if (!open) return;
      const { sel, items, byKey } = open;
      const it = items[i];
      close();
      if (!it || it.disabled || !sel.isConnected) return;
      if (!it.option.selected) {
        it.option.selected = true;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // picked with the keys outside a dialog: hand the keys back to the editor (focus.js)
      if (byKey && doc.activeElement === sel && win.FableCutFocus) win.FableCutFocus.release(sel);
    }

    // Mouse: open the list without focusing the select (and without the native popup).
    win.addEventListener("mousedown", (e) => {
      if (open && open.list.contains(e.target)) { e.preventDefault(); return; }   // keep focus where it is while picking
      const sel = e.target.closest && e.target.closest("select");
      if (e.button !== 0 || !isThemed(sel)) { close(); return; }
      e.preventDefault();
      // preventDefault keeps focus where it was: a text field typed into
      // before would keep it, and swallow Space after the pick
      const prev = doc.activeElement;
      const typing = !!prev && (prev.tagName === "INPUT" || prev.tagName === "TEXTAREA" || prev.isContentEditable);
      const inDialog = !!(sel.closest && sel.closest(".overlay, .ctx-menu, [role=dialog]"));
      if (typing && prev !== sel && !inDialog) prev.blur();
      show(sel, false);
    }, true);
    // A pick inside the list is not a click outside an open popover (those close on pointerdown).
    win.addEventListener("pointerdown", (e) => {
      if (open && open.list.contains(e.target)) e.stopPropagation();
    }, true);
    win.addEventListener("keydown", (e) => {
      if (open) {
        const k = e.key, items = open.items;
        let used = true;
        if (k === "Escape") close();   // only the list: not the dialog behind it
        else if (k === "Tab") { close(); used = false; }
        else if (k === "ArrowDown") activate(step(items, open.active, 1));
        else if (k === "ArrowUp") activate(step(items, open.active, -1));
        else if (k === "Home") activate(step(items, -1, 1));
        else if (k === "End") activate(step(items, items.length, -1));
        else if (k === "PageDown") activate(Math.min(items.length - 1, open.active + PAGE));
        else if (k === "PageUp") activate(Math.max(0, open.active - PAGE));
        else if (k === "Enter" || (k === " " && Date.now() - typedAt > 700)) pick(open.active);
        else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typed = now - typedAt > 700 ? k : typed + k;
          typedAt = now;
          const i = findMatch(items, typed.length > 1 ? open.active : open.active + 1, typed);
          if (i >= 0) activate(i);
        } else used = !(e.ctrlKey || e.metaKey);   // browser chords pass; other keys stop here
        if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
        return;
      }
      const sel = e.target;
      if (!isThemed(sel) || sel.disabled || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      if (k === " " || k === "Enter" || k === "ArrowDown" || k === "ArrowUp" || k === "F4") {
        e.preventDefault(); e.stopImmediatePropagation();
        show(sel, true);
      }
    }, true);
    const outside = (e) => { if (open && !open.list.contains(e.target)) close(); };
    win.addEventListener("scroll", outside, true);
    win.addEventListener("wheel", outside, { capture: true, passive: true });
    win.addEventListener("resize", () => { if (open) open.sel.isConnected ? place() : close(); });
    win.addEventListener("blur", close);
  }

  return { isThemed, optionText, rows, step, findMatch, placement, install };
});
