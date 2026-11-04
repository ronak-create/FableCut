/* focus.js — after the mouse uses a button, select or slider, Space plays the
   timeline instead of pressing that control again, and the control gives focus
   back to the page. Dialogs and popovers keep normal keyboard behaviour, and so
   does a control reached with Tab. Runs against a tiny stand-in for the DOM;
   the real thing is checked in the browser by hand. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./helpers");
const F = require("../focus.js");

/* Just enough of an element: tag, type, attributes, a parent chain for
   closest() (class and [role=…] selectors), blur(). */
function el(tag, { type, attrs = {}, cls = "", parent = null } = {}) {
  const e = {
    tagName: tag.toUpperCase(), type, parent, blurred: false,
    classList: new Set(cls.split(/\s+/).filter(Boolean)),
    hasAttribute: (a) => Object.hasOwn(attrs, a),
    getAttribute: (a) => (Object.hasOwn(attrs, a) ? attrs[a] : null),
    blur() { this.blurred = true; },
    closest(selectors) {
      const list = selectors.split(",").map((s) => s.trim());
      for (let n = this; n; n = n.parent) {
        for (const s of list) {
          if (s.startsWith(".") && n.classList.has(s.slice(1))) return n;
          const role = /^\[role=(\w+)\]$/.exec(s);
          if (role && n.getAttribute("role") === role[1]) return n;
        }
      }
      return null;
    },
  };
  return e;
}

test("buttons, selects, sliders, checkboxes and tabs are click controls; text fields are not", () => {
  for (const c of [el("button"), el("select"), el("summary"), el("a", { attrs: { href: "#" } }),
    el("div", { attrs: { role: "tab" } }), el("span", { attrs: { role: "button" } })])
    assert.equal(F.isClickControl(c), true, c.tagName);
  for (const t of ["range", "checkbox", "radio", "button", "color", "file"])
    assert.equal(F.isClickControl(el("input", { type: t })), true, t);
  for (const t of ["text", "number", "search", "url", undefined])
    assert.equal(F.isClickControl(el("input", { type: t })), false, String(t));
  for (const c of [el("textarea"), el("div"), el("a"), null, undefined])
    assert.equal(F.isClickControl(c), false);
});

test("Space plays after a click on a control in the editor", () => {
  const panel = el("div", { cls: "timeline-toolbar" });
  assert.equal(F.spaceShouldPlay(el("button", { parent: panel })), true);
  assert.equal(F.spaceShouldPlay(el("select", { parent: panel })), true);
  assert.equal(F.spaceShouldPlay(el("input", { type: "range", parent: panel })), true);
  assert.equal(F.spaceShouldPlay(el("input", { type: "checkbox", parent: panel })), true);
});

test("Space still presses the control in dialogs, popovers and after Tab", () => {
  for (const scope of [el("div", { cls: "overlay" }), el("div", { cls: "ctx-menu" }), el("div", { cls: "style-menu" }),
    el("div", { attrs: { role: "dialog" } }), el("div", { attrs: { role: "menu" } })])
    assert.equal(F.spaceShouldPlay(el("button", { parent: el("div", { parent: scope }) })), false);
  const tabbed = el("button");
  F.noteFocus(tabbed, true);
  assert.equal(F.spaceShouldPlay(tabbed), false, "reached with Tab: Space presses it");
  F.noteFocus(tabbed, false);
  assert.equal(F.spaceShouldPlay(tabbed), true, "then clicked: Space plays");
  assert.equal(F.spaceShouldPlay(el("input", { type: "text" })), false, "text field: Space types");
  assert.equal(F.spaceShouldPlay(el("textarea")), false);
  assert.equal(F.spaceShouldPlay(null), false);
});

test("release() gives focus back only outside dialogs", () => {
  const b = el("button");
  assert.equal(F.release(b), true);
  assert.equal(b.blurred, true);
  const inDialog = el("button", { parent: el("div", { cls: "overlay" }) });
  assert.equal(F.release(inDialog), false);
  assert.equal(inDialog.blurred, false);
  const field = el("input", { type: "number" });
  assert.equal(F.release(field), false);
  assert.equal(field.blurred, false);
});

test("the editor's Space handler asks focus.js first, and the page loads it before app.js", () => {
  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const space = src.indexOf("FableCutFocus.spaceShouldPlay(document.activeElement)");
  const typing = src.indexOf('if (k === " ") { e.preventDefault(); toggleTransportPlay(); }');
  assert.ok(space > 0 && typing > space, "Space checks focus.js before the plain Space shortcut");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const a = html.indexOf('<script src="focus.js">'), b = html.indexOf('<script src="app.js">');
  assert.ok(a > 0 && a < b, "focus.js loads before app.js");
});
