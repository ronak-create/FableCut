/* select-menu.js — the themed list every <select> opens. These check the
   pieces that decide what the list shows and where the keys go (which selects
   get it, rows and optgroups, stepping over disabled options, type-to-find,
   placing it above or below). Opening and picking with the real mouse and
   keyboard is checked in the browser by hand. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./helpers");
const S = require("../select-menu.js");

const opt = (text, extra = {}) => ({ tagName: "OPTION", textContent: text, label: "", disabled: false, hidden: false, ...extra });
const group = (label, children, extra = {}) => ({ tagName: "OPTGROUP", label, disabled: false, children, ...extra });
const select = (children, extra = {}) => ({ tagName: "SELECT", multiple: false, size: 0, children, hasAttribute: (a) => !!(extra.attrs || {})[a], ...extra });

test("plain selects get the themed list; multiple, size>1 and data-native keep the native one", () => {
  assert.equal(S.isThemed(select([])), true);
  assert.equal(S.isThemed(select([], { multiple: true })), false);
  assert.equal(S.isThemed(select([], { size: 4 })), false);
  assert.equal(S.isThemed(select([], { attrs: { "data-native": true } })), false);
  assert.equal(S.isThemed({ tagName: "INPUT" }), false);
  assert.equal(S.isThemed(null), false);
});

test("rows: optgroups become headings, hidden options are left out, a disabled group disables its options", () => {
  const sel = select([
    opt("All media"),
    opt("secret", { hidden: true }),
    group("Kind", [opt("Video"), opt("Audio", { disabled: true })]),
    group("Tags", [opt("#day 1")], { disabled: true }),
  ]);
  const r = S.rows(sel);
  assert.deepEqual(r.map((x) => x.group !== undefined ? `[${x.group}]` : S.optionText(x.option) + (x.disabled ? " (off)" : "")),
    ["All media", "[Kind]", "Video", "Audio (off)", "[Tags]", "#day 1 (off)"]);
  assert.equal(r.find((x) => x.option && x.option.textContent === "Video").inGroup, true);
});

test("option text: label wins, whitespace collapses", () => {
  assert.equal(S.optionText(opt("  24\n   fps ")), "24 fps");
  assert.equal(S.optionText(opt("ignored", { label: "Shown" })), "Shown");
});

test("arrow keys step over disabled options and stop at the ends", () => {
  const items = [{ disabled: false }, { disabled: true }, { disabled: false }, { disabled: true }];
  assert.equal(S.step(items, 0, 1), 2);
  assert.equal(S.step(items, 2, 1), 2, "nothing enabled below: stay");
  assert.equal(S.step(items, 2, -1), 0);
  assert.equal(S.step(items, -1, 1), 0, "Home");
  assert.equal(S.step(items, items.length, -1), 2, "End");
});

test("type-to-find wraps around and skips disabled options", () => {
  const items = ["24 fps", "25 fps", "30 fps", "50 fps", "60 fps"].map((t) => ({ option: opt(t), disabled: t === "25 fps" }));
  assert.equal(S.findMatch(items, 0, "2"), 0);
  assert.equal(S.findMatch(items, 1, "2"), 0, "25 is disabled, wraps to 24");
  assert.equal(S.findMatch(items, 3, "3"), 2, "wraps from the end");
  assert.equal(S.findMatch(items, 0, "30"), 2);
  assert.equal(S.findMatch(items, 0, "9"), -1);
});

test("the list opens below the select, or above it when there is more room there", () => {
  const near = { top: 40, bottom: 64 };
  const below = S.placement(near, 800, 200);
  assert.equal(below.down, true);
  assert.equal(below.top, 66);
  const low = { top: 740, bottom: 764 };
  const above = S.placement(low, 800, 200);
  assert.equal(above.down, false);
  assert.ok(above.top + 200 <= low.top, "sits above the select");
  assert.ok(S.placement(near, 2000, 5000).maxH <= 340, "never taller than 340 px");
});

test("the page loads select-menu.js before app.js", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const a = html.indexOf('<script src="select-menu.js">'), b = html.indexOf('<script src="app.js">');
  assert.ok(a > 0 && a < b);
});

test("the list hands Space to focus.js and lets go of a Tab-focused button it opens over", () => {
  const src = fs.readFileSync(path.join(ROOT, "select-menu.js"), "utf8");
  const ask = src.indexOf('if (k === " " && win.FableCutFocus && win.FableCutFocus.spaceShouldPlay(sel)) return;');
  const opens = src.indexOf('if (k === " " || k === "Enter" || k === "ArrowDown"');
  assert.ok(ask > 0 && ask < opens, "a mouse-focused select lets Space play before Space opens the list");
  assert.match(src, /const control = !!prev && !!win\.FableCutFocus && win\.FableCutFocus\.isClickControl\(prev\);/);
  assert.match(src, /if \(\(typing \|\| control\) && prev !== sel && !inDialog\) prev\.blur\(\);/);
});
