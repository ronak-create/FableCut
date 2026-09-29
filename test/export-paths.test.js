/* Fast vs WebCodecs — both must keep using the shared compositor loop.
   Re-run this whenever either engine is rewritten so a copied-back frame
   loop cannot silently drift. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./helpers");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

function between(start, end) {
  const a = SRC.indexOf(start);
  const b = SRC.indexOf(end, a);
  assert.ok(a >= 0, `missing ${start}`);
  assert.ok(b > a, `missing ${end} after ${start}`);
  return SRC.slice(a, b);
}

const RUNNER = between("async function runCompositorExport", "async function fastExport");
const FAST = between("async function fastExport", "/* ── WebCodecs export");
const WC = between("async function webCodecsExport", "/* ── Realtime export");

test("one compositor frame loop; engines only encode", () => {
  assert.match(RUNNER, /for \(let f = 0; f < frames; f\+\+\)/);
  assert.match(RUNNER, /engine\.encodeFrame/);
  assert.match(RUNNER, /composeExportTick/);
  assert.equal(FAST.includes("for (let f = 0"), false, "Fast must not own a frame loop");
  assert.equal(WC.includes("for (let f = 0"), false, "WebCodecs must not own a frame loop");
});

test("Fast and WebCodecs expose the same engine hooks", () => {
  for (const hook of ["queueBusy", "pauseDeep", "encodeFrame", "cleanup"]) {
    assert.match(FAST, new RegExp(hook), `Fast missing ${hook}`);
    assert.match(WC, new RegExp(hook), `WebCodecs missing ${hook}`);
  }
  assert.match(FAST, /wait:\s*async/);
  assert.match(WC, /wait:\s*async/);
  assert.match(FAST, /finish\s*\(/);
  assert.match(WC, /finish\s*\(/);
});
