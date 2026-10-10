/* The tracker (tracker.js): template matching on synthetic footage — a
   textured patch moving, scaling and turning over a textured background —
   plus the stored-track helpers (validation, lookup, re-basing, simplify). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../tracker.js");

/** Smooth value noise, deterministic. */
function noise(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const N = 64, g = Float32Array.from({ length: N * N }, rnd);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const at = (i, j) => g[((j & (N - 1)) * N) + (i & (N - 1))];
    const sm = (t) => t * t * (3 - 2 * t), u = sm(fx), v = sm(fy);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
const W = 320, H = 180, bg = noise(1), fg = noise(7);
/** A frame with a 40×40 textured patch at (cx, cy), scaled s, turned r radians. */
function frame(cx, cy, s = 1, r = 0) {
  const img = new Float32Array(W * H), cs = Math.cos(-r) / s, sn = Math.sin(-r) / s;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy, u = dx * cs - dy * sn, v = dx * sn + dy * cs;
    img[y * W + x] = Math.abs(u) < 20 && Math.abs(v) < 20 ? 40 + 200 * fg(u / 5 + 50, v / 5 + 50) : 60 * bg(x / 9, y / 9);
  }
  return img;
}

test("follows a patch moving along a curve to within a fraction of a pixel", () => {
  const path = (i) => [80 + i * 4 + Math.sin(i / 3) * 6, 90 + Math.cos(i / 4) * 20];
  const [x0, y0] = path(0);
  const tr = T.createTracker(frame(x0, y0), W, H, { cx: x0, cy: y0, w: 40, h: 40 });
  let worst = 0;
  for (let i = 1; i <= 30; i++) {
    const [x, y] = path(i), r = tr.step(frame(x, y));
    assert.equal(r.lost, false, `lost at frame ${i}`);
    worst = Math.max(worst, Math.hypot(r.cx - x, r.cy - y));
  }
  assert.ok(worst < 0.6, `worst error ${worst.toFixed(3)} px`);
});

test("follows scale and rotation when asked", () => {
  const tr = T.createTracker(frame(160, 90), W, H, { cx: 160, cy: 90, w: 40, h: 40 }, { scale: true, rotation: true });
  let r;
  for (let i = 1; i <= 15; i++) r = tr.step(frame(160 + i, 90, 1 + i * 0.012, i * 0.02));
  assert.ok(Math.abs(r.s - 1.18) < 0.05, `scale ${r.s}`);
  assert.ok(Math.abs(r.r - 0.3 * 180 / Math.PI) < 3, `rotation ${r.r}°`);
  assert.ok(Math.abs(r.cx - 175) < 1.5);
});

test("reports a lost region instead of guessing", () => {
  const tr = T.createTracker(frame(100, 90), W, H, { cx: 100, cy: 90, w: 40, h: 40 });
  const empty = new Float32Array(W * H).map((_, i) => 60 * bg((i % W) / 9, Math.floor(i / W) / 9));
  assert.equal(tr.step(empty).lost, true);
  const flat = T.createTracker(new Float32Array(W * H), W, H, { cx: 100, cy: 90, w: 40, h: 40 });
  assert.equal(flat.step(frame(100, 90)).lost, true, "a featureless region can't be tracked");
});

test("stored tracks: validation, lookup between samples, re-basing on trims, simplify", () => {
  const list = T.normalizeTracks([{ name: "Logo", kind: "box", w: 0.1, h: 0.08, samples: [[1, 0.5, 0.5], [0, 0.4, 0.5, 1, 0, 0.9], [2, 0.6, 0.7, 1.2, 10]] }]);
  assert.deepEqual(list[0].samples[0], [0, 0.4, 0.5, 1, 0, 0.9], "sorted, defaults filled");
  const mid = T.trackAt(list[0], 1.5);
  assert.ok(Math.abs(mid.x - 0.55) < 1e-9 && Math.abs(mid.y - 0.6) < 1e-9 && Math.abs(mid.r - 5) < 1e-9);
  assert.equal(T.trackAt(list[0], 5).inside, false, "past the end: held, but outside");
  assert.throws(() => T.normalizeTracks([{ name: "a", samples: [] }], true), /has no samples/);
  assert.throws(() => T.normalizeTracks([{ name: "a", samples: [[0, 1, 1]] }, { name: "a", samples: [[0, 1, 1]] }], true), /used twice/);
  const shifted = T.shiftTracks(list, 1, 0.5);
  assert.deepEqual(shifted[0].samples.map((s) => s[0]), [0], "a head trim drops what went and re-bases the rest (dur 0.5)");
  const line = Array.from({ length: 50 }, (_, i) => [i / 30, 0.2 + i * 0.01, 0.5, 1, 0, 1]);
  assert.equal(T.simplify(line, 0.001).length, 2, "a straight move needs two keys");
  line[25][2] = 0.6;
  assert.equal(T.simplify(line, 0.001).length, 5, "a bump keeps its corners");
  assert.match(T.describe(list), /^"Logo" box 0\.00–2\.00 s \(3 samples\)$/);
});

const { makeDataDir, readProject, seedProject, startMcp } = require("./helpers");

test("agents: tracks are validated on updateClip, summarized in the compact view, removed with removeTrack; fablecut_track checks its input", async (t) => {
  const dir = makeDataDir(t, seedProject({
    media: [{ id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 }],
    clips: [
      { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 5 },
      { id: "c_txt", mediaId: null, kind: "text", track: "V2", start: 0, duration: 5, props: { text: "Hi" } },
    ],
  }));
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const samples = Array.from({ length: 40 }, (_, i) => [i / 30, 0.3 + i * 0.005, 0.5, 1, 0, 0.97]);
  let r = await patch({ op: "updateClip", id: "c_a", set: { props: { tracks: [{ name: "Logo", samples }, { name: "Dot", samples: [[0, 0.5, 0.5]] }] } } });
  assert.equal(r.isError, false, r.text);
  const compact = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(compact.text, /\[tracks: "Logo" point 0\.00–1\.30 s \(40 samples\), "Dot" point 0\.00–0\.00 s \(1 samples\)\]/);
  assert.doesNotMatch(compact.text, /0\.305/, "samples never reach the compact view");
  r = await patch({ op: "updateClip", id: "c_a", set: { props: { tracks: [{ name: "Bad", samples: [["x"]] }] } } });
  assert.match(r.text, /props\.tracks\[0\]\.samples/);
  r = await patch({ op: "updateClip", id: "c_txt", set: { props: { tracks: [{ name: "T", samples }] } } });
  assert.match(r.text, /tracks belong to video clips/);
  r = await patch({ op: "removeTrack", id: "c_a", track: "Dot" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(readProject(dir).clips[0].props.tracks.map((x) => x.name), ["Logo"]);
  r = await patch({ op: "removeTrack", id: "c_a", track: "Nope" });
  assert.match(r.text, /has no track "Nope" \(it has "Logo"/);

  r = await mcp.callTool("fablecut_track", { clip: "c_txt", point: { x: 0.5, y: 0.5 } });
  assert.match(r.text, /text clip — tracking follows a video clip's picture/);
  r = await mcp.callTool("fablecut_track", { clip: "c_a", point: { x: "a" } });
  assert.match(r.text, /point needs numbers x, y/);
  r = await mcp.callTool("fablecut_track", { clip: "c_a", region: { x: 0.5, y: 0.5 } });
  assert.match(r.text, /region needs numbers x, y, w, h/);
  r = await mcp.callTool("fablecut_track", { clip: "c_a", apply: {} });
  assert.match(r.text, /apply must be \{mask/);
});
