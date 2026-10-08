/* frame-stats.js — the text-only fallback for fablecut_frame.

   The whole point of this module is that a model which cannot see an image
   still learns something about the footage, so every claim it makes is checked
   here against buffers built to be unambiguous: a solid red frame, a black one,
   a grid with a known edge in it, two cells that differ in a known way. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../frame-stats");

/** A w×h RGB24 buffer of one flat colour. */
const solid = (w, h, r, g, b) => {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b; }
  return buf;
};
/** Left half one colour, right half another — a single known hard edge. */
const split = (w, h, a, b) => {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, c = x < w / 2 ? a : b;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
  }
  return buf;
};

test("describe names the colour it was given", () => {
  const cases = [
    [[220, 20, 20], "red"], [[20, 200, 30], "green"], [[30, 40, 220], "blue"],
    [[245, 245, 245], "white"], [[12, 12, 14], "black"], [[130, 130, 132], "grey"],
  ];
  for (const [rgb, want] of cases) {
    const st = S.describe(solid(32, 32, ...rgb), 32, 32);
    assert.equal(st.colours.length, 1, `a flat frame must be one colour, got ${st.colours.length}`);
    assert.equal(st.colours[0].name, want, `${rgb} should read as ${want}, got ${st.colours[0].name}`);
    assert.equal(st.colours[0].pct, 100, "a flat frame is 100% one colour");
  }
});

test("brightness buckets follow the luma, and luma levels are Rec.709", () => {
  // Each value chosen to sit clearly inside its bucket, not on a boundary.
  assert.equal(S.describe(solid(16, 16, 0, 0, 0), 16, 16).brightness, "very dark");
  assert.equal(S.describe(solid(16, 16, 60, 60, 60), 16, 16).brightness, "dark");
  assert.equal(S.describe(solid(16, 16, 130, 130, 130), 16, 16).brightness, "mid");
  assert.equal(S.describe(solid(16, 16, 215, 215, 215), 16, 16).brightness, "bright");
  assert.equal(S.describe(solid(16, 16, 255, 255, 255), 16, 16).brightness, "very bright");

  // …and the boundaries themselves.
  assert.equal(S.describe(solid(16, 16, 89, 89, 89), 16, 16).brightness, "dark");
  assert.equal(S.describe(solid(16, 16, 90, 90, 90), 16, 16).brightness, "mid");

  // White is 1.0. Gamma-encoded mid grey sits near 0.502 on 0–1 — Rec.709's
  // weights sum to 1, so 128/255 is the answer. (0.216 would be the linear-light
  // value of the same pixel; the scopes read gamma-encoded, so this must match.)
  const white = S.describe(solid(8, 8, 255, 255, 255), 8, 8);
  assert.equal(white.luma.mean, 1);
  assert.ok(Math.abs(S.describe(solid(8, 8, 128, 128, 128), 8, 8).luma.mean - 128 / 255) < 0.005,
    "mid grey should be ~0.502 luma");
});

test("percentiles and range are reported, and a flat frame has no spread", () => {
  const flat = S.describe(solid(24, 24, 100, 100, 100), 24, 24).luma;
  assert.equal(flat.min, flat.max, "a flat frame's min and max must match");
  assert.equal(flat.p1, flat.p99);

  // Half black, half white: median splits, and p1/p99 hug the ends.
  const hard = S.describe(split(64, 64, [0, 0, 0], [255, 255, 255]), 64, 64).luma;
  assert.equal(hard.min, 0);
  assert.equal(hard.max, 255);
  assert.ok(hard.median >= 0 && hard.median <= 255);
  assert.ok(hard.p1 <= 5, `p1 should be near black, got ${hard.p1}`);
  assert.ok(hard.p99 >= 250, `p99 should be near white, got ${hard.p99}`);
});

test("texture separates a flat frame from a detailed one, and never NaNs", () => {
  const flat = S.describe(solid(64, 64, 120, 120, 120), 64, 64).texture;
  // A single hard vertical edge in a 64-wide frame: one step of 255 per row,
  // over 63 steps — a known, checkable value.
  const edge = S.describe(split(64, 64, [0, 0, 0], [255, 255, 255]), 64, 64).texture;
  assert.equal(flat, 0, "a flat frame has no texture");
  assert.ok(edge > flat, "an edge must out-score a flat frame");
  assert.ok(Math.abs(edge - 255 / 63 / 255 * 100) < 0.5,
    `one hard edge over 63 steps should be ~${(255 / 63 / 255 * 100).toFixed(1)}, got ${edge}`);

  // The bug this pins: reading one pixel before the row start yielded NaN, and
  // a NaN in this field would reach an agent as "texture undefined".
  for (const buf of [solid(1, 1, 10, 10, 10), solid(1, 8, 200, 30, 30), solid(64, 1, 5, 5, 5)]) {
    const st = S.describe(buf, buf.length / 3, 1);
    assert.ok(Number.isFinite(st.texture), `texture must be a number, got ${st.texture}`);
    assert.ok(Number.isFinite(st.luma.mean) && Number.isFinite(st.saturation));
  }
});

test("saturation is 0 for grey and high for pure colour", () => {
  assert.equal(S.describe(solid(16, 16, 128, 128, 128), 16, 16).saturation, 0);
  assert.ok(S.describe(solid(16, 16, 255, 0, 0), 16, 16).saturation > 0.9, "pure red is saturated");
  // Black carries no chroma, so saturation must not divide by zero.
  assert.equal(S.describe(solid(16, 16, 0, 0, 0), 16, 16).saturation, 0);
});

test("meanRgb survives a buffer whose height did not divide evenly", () => {
  /* ffmpeg's scale=-2 rounds height to an even number, so a decode can carry a
     partial trailing row — the byte count exceeds w*h*3. The height has to come
     from the bytes, not from an assumption, or the extra row is silently dropped
     (or read past the end). 96 pixels at width 32 is 3 rows: two red, one white. */
  const w = 32;
  const buf = Buffer.concat([solid(w, 2, 255, 0, 0), solid(w, 1, 255, 255, 255)]);
  assert.equal(buf.length, 32 * 3 * 3);
  const h = Math.round(buf.length / 3 / w);
  assert.equal(h, 3);
  const st = S.describe(buf, w, h);
  assert.equal(st.meanRgb[0], 255);
  assert.equal(st.meanRgb[1], Math.round(255 / 3));
  assert.ok(Number.isFinite(st.luma.mean), "a ragged buffer must not produce NaN");
});

test("motionScore is 0 for identical frames and 1 for opposite ones", () => {
  const a = solid(32, 32, 0, 0, 0);
  assert.equal(S.motionScore(a, solid(32, 32, 0, 0, 0), 32, 32), 0);
  assert.equal(S.motionScore(a, solid(32, 32, 255, 255, 255), 32, 32), 1);
  // Mismatched or short buffers report 0 rather than reading past the end.
  assert.equal(S.motionScore(a, Buffer.alloc(4), 32, 32), 0);
  assert.equal(S.motionScore(a, null, 32, 32), 0);
});

test("describeGrid reads cells left→right then top→bottom", () => {
  // A 2x1 grid: red cell then blue cell. Built as an explicit row-major buffer
  // rather than concatenated cells, because with cols=2 and h=10 the two 10x10
  // cells ARE the two halves of one row — and slicing that correctly is exactly
  // what is being tested.
  const w = 20, h = 10;
  const grid = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, c = x < w / 2 ? [255, 0, 0] : [0, 0, 255];
    grid[i] = c[0]; grid[i + 1] = c[1]; grid[i + 2] = c[2];
  }
  const g = S.describeGrid(grid, w, h, 2, 1, [0.5, 1.5]);
  assert.equal(g.cells.length, 2);
  assert.equal(g.cells[0].colours[0].name, "red", "cell 1 must be the left cell");
  assert.equal(g.cells[1].colours[0].name, "blue", "cell 2 must be the right cell");
  assert.equal(g.cells[0].motion, 0, "the first cell has nothing to compare against");
  // Red→blue differs in two of three channels, so the exact score is 510/3/255.
  assert.ok(Math.abs(g.cells[1].motion - 510 / 3 / 255) < 0.01,
    `red→blue should score ~0.667, got ${g.cells[1].motion}`);
});

test("describeGrid compares each cell against the previous real cell", () => {
  // A 2x2 grid: two reds on top, two blues below.
  const w = 16, h = 16;
  const grid = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, c = y < h / 2 ? [255, 0, 0] : [0, 0, 255];
    grid[i] = c[0]; grid[i + 1] = c[1]; grid[i + 2] = c[2];
  }
  const g = S.describeGrid(grid, w, h, 2, 2, [0, 1, 2, 3]);
  assert.deepEqual(g.cells.map((c) => c.colours[0].name), ["red", "red", "blue", "blue"]);
  assert.equal(g.cells[1].motion, 0, "red next to red is no change");
  assert.ok(Math.abs(g.cells[2].motion - 510 / 3 / 255) < 0.01, "row two changes colour");
});

test("describeGrid marks tile padding instead of describing it as a black frame", () => {
  // 5 moments in a 3x2 grid: tile pads the sixth cell with black. Reporting
  // that as "very dark, black 100%" would be a fabricated frame.
  const cell = solid(10, 10, 200, 30, 30);
  const grid = Buffer.concat([cell, cell, cell, cell, cell]);
  const g = S.describeGrid(grid, 30, 20, 3, 2, [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.equal(g.cells.length, 6);
  const padded = g.cells.filter((c) => c.padded);
  assert.equal(padded.length, 1, "exactly one cell is padding");
  assert.equal(padded[0].index, 5);
  assert.equal(g.cells.filter((c) => !c.padded).length, 5);
  assert.ok(!S.gridLines(g).join("\n").includes("cell 6 @ "), "a padded cell must not claim a timestamp");
});

test("the text lines carry the numbers and stay honest about what they are", () => {
  const single = S.frameLines("Frame at 2s", S.describe(solid(32, 32, 220, 20, 20), 32, 32));
  const text = single.join("\n");
  assert.match(text, /Frame at 2s/);
  assert.match(text, /brightness|luma mean/, "the line must state the brightness");
  assert.match(text, /red/, "the dominant colour must be named");
  assert.match(text, /texture/, "texture must be reported");
  assert.ok(single.length <= 4, "a text-only agent pays for every token here");

  const grid = S.describeGrid(Buffer.concat([solid(10, 10, 255, 0, 0), solid(10, 10, 0, 0, 255)]),
    20, 10, 2, 1, [0.5, 1.5]);
  const lines = S.gridLines(grid).join("\n");
  assert.match(lines, /cell 1 @ 0\.5s/);
  assert.match(lines, /cell 2 @ 1\.5s/);
  assert.match(lines, /change/, "each cell reports its change since the previous one");
});