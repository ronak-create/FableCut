/* reframe.js — the subject in sampled frames, the virtual camera, keys on the canvas, which clips. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../reframe");

/** Frames of a dark picture with a bright square whose centre moves along `xs` (fractions of the width). */
function frames(xs, w = 96, h = 54, side = 10) {
  return xs.map((u) => {
    const f = new Uint8Array(w * h * 3).fill(20);
    const cx = Math.round(u * w), cy = Math.round(h / 2);
    for (let y = cy - side / 2; y < cy + side / 2; y++) for (let x = cx - side / 2; x < cx + side / 2; x++) {
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const i = (y * w + x) * 3; f[i] = 250; f[i + 1] = 160; f[i + 2] = 30;
    }
    return f;
  });
}

test("subjectTrack finds a moving square, sure of it", () => {
  const xs = Array.from({ length: 20 }, (_, i) => 0.15 + i * 0.035);
  const s = R.subjectTrack(frames(xs), 96, 54);
  assert.equal(s.length, 20);
  for (let i = 2; i < s.length; i++) assert.ok(Math.abs(s[i][1] - xs[i]) < 0.08, `frame ${i}: ${s[i][1].toFixed(3)} vs ${xs[i].toFixed(3)}`);
  assert.ok(s.slice(2).every((x) => x[3] > 0.3), "confident");
  assert.equal(s[5][0], 1, "five samples a second");
});

test("camera holds inside the dead zone, then follows without jumping", () => {
  const still = Array.from({ length: 10 }, (_, i) => [i / 5, 0.52, 0.5, 1]);
  assert.ok(R.camera(still).every((p) => Math.abs(p[1] - 0.52) < 1e-9), "a subject that stays put: the camera stays put");
  const moving = Array.from({ length: 40 }, (_, i) => [i / 5, 0.2 + i * 0.015, 0.5, 1]);
  const cam = R.camera(moving, 1, { smooth: 0.5 });
  const steps = cam.slice(1).map((p, i) => Math.abs(p[1] - cam[i][1]));
  assert.ok(Math.max(...steps) <= (0.6 - 0.4 * 0.5) * 0.2 + 1e-9, "never faster than the pan speed");
  assert.ok(cam[cam.length - 1][1] > 0.6, "it got there");
  const unsure = moving.map((p, i) => (i > 10 ? [p[0], 0.9, 0.5, 0.01] : p));
  const held = R.camera(unsure);
  assert.ok(held[held.length - 1][1] < 0.5, "unsure samples don't drag the camera");
});

test("coverRect / offsetFor / keysFor stay inside the picture", () => {
  const r = R.coverRect(1920, 1080, 1080, 1920);
  assert.ok(Math.abs(r.pw - 3413.33) < 0.1 && r.maxY === 0 && Math.abs(r.maxX - 1166.67) < 0.1);
  assert.equal(R.offsetFor(0, r.pw, r.maxX), r.maxX, "the far left edge: clamped");
  assert.equal(R.offsetFor(0.5, r.pw, r.maxX), 0);
  const path = Array.from({ length: 30 }, (_, i) => [i / 5, 0.3 + i * 0.01]);
  const k = R.keysFor(path, r.pw, r.maxX, { speed: 2 });
  assert.ok(k.keys.length >= 2 && k.keys.length < 30, "thinned");
  assert.ok(Math.abs(k.keys[k.keys.length - 1].t - (29 / 5) / 2) < 1 / 30 + 1e-9, "source seconds / speed = clip seconds");
  assert.ok(k.keys.every((q) => Math.abs(q.v) <= r.maxX + 0.5));
  const still = R.keysFor([[0, 0.5], [1, 0.501]], r.pw, r.maxX);
  assert.ok(!still.keys && Math.abs(still.static) <= 2, "hardly moves: one value near the centre");
});

test("canvasFor keeps the project's shorter side, even sizes", () => {
  assert.deepEqual(R.canvasFor("9:16", 1920, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(R.canvasFor("1:1", 1920, 1080), { width: 1080, height: 1080 });
  assert.deepEqual(R.canvasFor("4:5", 1280, 720), { width: 720, height: 900 });
  assert.deepEqual(R.canvasFor("16:9", 1080, 1920), { width: 1920, height: 1080 });
  assert.throws(() => R.canvasFor("5:7", 1920, 1080), /aspect must be one of/);
});

test("targets: full-frame shots only; reframed ones can be redone", () => {
  const c = (id, extra = {}) => ({ id, kind: "video", track: "V1", props: {}, ...extra });
  const doc = { lockedTracks: ["V9"], clips: [
    c("ok"), c("moved", { props: { x: 200 } }), c("small", { props: { scale: 0.4 } }), c("keyed", { keyframes: { x: [{ t: 0, v: 1 }] } }),
    c("cropped", { props: { cropL: 10 } }), c("none", { props: { fit: "none" } }), c("locked", { locked: true }), c("lane", { track: "V9" }),
    c("again", { props: { fit: "cover", reframe: "follow" }, keyframes: { x: [{ t: 0, v: 300 }] } }),
    { id: "title", kind: "text", track: "V2", props: {} },
  ] };
  const r = R.targets(doc);
  assert.deepEqual(r.take.map((x) => x.id), ["ok", "again"]);
  assert.deepEqual(Object.fromEntries(r.skip.map((x) => [x.id, x.why])), {
    moved: "placed by hand (moved or scaled)", small: "placed by hand (moved or scaled)", title: "a title", keyed: "animated by hand (position or scale keys)",
    cropped: "cropped", none: "fit:none", locked: "locked", lane: "locked" });
  assert.deepEqual(R.targets(doc, { force: true }).take.map((x) => x.id).includes("locked"), true);
});

test("clipPlan: follows, holds, centres — and redoing replaces its own keys", () => {
  const src = { width: 1920, height: 1080 }, canvas = { width: 1080, height: 1920 };
  const moving = Array.from({ length: 30 }, (_, i) => [i / 5, 0.25 + i * 0.018, 0.5, 0.9]);
  const c = { id: "a", kind: "video", props: {}, keyframes: { opacity: [{ t: 0, v: 1 }] } };
  const p = R.clipPlan(c, moving, src, canvas);
  assert.match(p.note, /^follows the subject/);
  assert.equal(p.set.props.fit, "cover");
  assert.equal(p.set.props.reframe, "follow");
  assert.ok(p.set.keyframes.x.length >= 2 && p.set.keyframes.opacity, "x keys, other keys kept");
  const again = R.clipPlan({ ...c, props: { reframe: "follow", fit: "cover" }, keyframes: p.set.keyframes }, null, src, canvas, { follow: false });
  assert.equal(again.note, "centred");
  assert.deepEqual(again.set.keyframes, { opacity: [{ t: 0, v: 1 }] }, "its x keys go, the rest stay");
  const unsure = moving.map((s) => [s[0], s[1], s[2], 0.02]);
  assert.match(R.clipPlan(c, unsure, src, canvas).note, /no clear subject/);
  assert.match(R.clipPlan(c, moving, src, { width: 1920, height: 1080 }).note, /already this shape/);
});
