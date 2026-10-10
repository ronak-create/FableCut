/* The Keyboard shortcuts dialog (index.html #helpOverlay) stays in step with
   the keys the editor actually handles: every key a global keydown handler in
   app.js reacts to has a <kbd> in the dialog, and every single-key <kbd> in
   the dialog is handled somewhere. A new shortcut without a dialog row (or a
   dialog row for a key that was removed) fails here. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./helpers");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/* Keys handled on purpose without a dialog row, with the reason. */
const UNLISTED = {
  Backspace: "an alias of Del",
  "=": "an alias of + (the unshifted key)",
};

/* Key names as the dialog prints them. */
const NAMES = { " ": "Space", Escape: "Esc", Delete: "Del", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Shift: "⇧" };
const norm = (k) => NAMES[k] || (k.length === 1 ? k.toUpperCase() : k);
const isKeyName = (k) => k.length === 1 || /^[A-Z][A-Za-z]+$/.test(k);   // "a", "Escape" — not a variable compared to "hue"

/** Bodies of the keydown listeners on window / document (the global shortcuts). */
function globalHandlers() {
  const out = [];
  const re = /(?:window|document)\.addEventListener\(\s*"keydown"\s*,\s*(?:\([^)]*\)|\w+)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(SRC))) {
    let i = m.index + m[0].length, depth = 1;
    for (; i < SRC.length && depth; i++) {
      const ch = SRC[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === '"' || ch === "'" || ch === "`") {   // skip strings (keys like "{" would miscount)
        const q = ch;
        for (i++; i < SRC.length && SRC[i] !== q; i++) if (SRC[i] === "\\") i++;
      }
    }
    out.push(SRC.slice(m.index, i));
  }
  return out;
}

function handledKeys() {
  const keys = new Set();
  for (const body of globalHandlers()) {
    for (const [, k] of body.matchAll(/\b(?:k|key|e\.key)\s*===\s*"([^"]+)"/g)) if (isKeyName(k)) keys.add(norm(k));
    for (const [, k] of body.matchAll(/\be\.code\s*===\s*"(?:Key|Digit)(\w)"/g)) keys.add(norm(k));
  }
  // table-driven: the edit tools' letters
  const tools = /const EDIT_TOOLS = \{([\s\S]*?)\n\};/.exec(SRC);
  if (tools) for (const [, k] of tools[1].matchAll(/key:\s*"([^"]+)"/g)) keys.add(norm(k));
  return keys;
}

function dialogKeys() {
  const help = /<div class="overlay hidden" id="helpOverlay">([\s\S]*?)<div class="dialog-actions">/.exec(HTML);
  assert.ok(help, "the shortcuts dialog (#helpOverlay) was not found in index.html");
  const keys = new Set();
  for (const [, k] of help[1].matchAll(/<kbd>([^<]+)<\/kbd>/g)) {
    keys.add(k.trim());
    // ranges like 0–9 cover each digit
    const r = /^(\d)$/.exec(k.trim());
    if (r) keys.add(r[1]);
  }
  if (keys.has("0") && keys.has("9")) for (let d = 0; d <= 9; d++) keys.add(String(d));
  return keys;
}

test("every key the editor handles has a row in the Keyboard shortcuts dialog", () => {
  const handled = handledKeys(), shown = dialogKeys();
  assert.ok(handled.size > 20, `found only ${handled.size} handled keys — has the keydown handler moved?`);
  const missing = [...handled].filter((k) => !shown.has(k) && !UNLISTED[k] && !["Ctrl", "Alt", "Cmd", "Ctrl/Cmd", "Enter", "Tab"].includes(k));
  assert.deepEqual(missing, [], `keys handled in app.js but not shown in the shortcuts dialog: ${missing.join(" ")} — add a row to #helpOverlay in index.html (or to UNLISTED here, with the reason)`);
});

test("every single key the dialog shows is handled somewhere in app.js", () => {
  const all = new Set();
  for (const [, k] of SRC.matchAll(/\b(?:k|key|e\.key)\s*===\s*"([^"]+)"/g)) all.add(norm(k));
  for (const [, k] of SRC.matchAll(/\be\.code\s*===\s*"(?:Key|Digit)(\w)"/g)) all.add(norm(k));
  for (const k of handledKeys()) all.add(k);
  const digits = /\/\^\[0-9|\\d/.test(SRC);
  const stale = [...dialogKeys()].filter((k) => /^[A-Z0-9;'.,\[\]+\-]$/.test(k) && !all.has(k) && !(digits && /^\d$/.test(k)));
  assert.deepEqual(stale, [], `the shortcuts dialog shows keys nothing handles: ${stale.join(" ")}`);
});
