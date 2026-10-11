/* app.js is one classic script: two top-level functions with the same name do
   not fail to load, the later one silently replaces the earlier everywhere. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("app.js declares every top-level function once", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const names = [...src.matchAll(/^(?:async\s+)?function\s+([\w$]+)/gm)].map((m) => m[1]);
  const seen = new Set(), dup = new Set();
  for (const n of names) (seen.has(n) ? dup : seen).add(n);
  assert.deepEqual([...dup], [], `declared more than once: ${[...dup].join(", ")}`);
});
