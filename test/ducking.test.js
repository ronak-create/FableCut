/* ducking.js — voice detection and the `duck` keyframes Auto-duck writes
   (shared by the editor and fablecut_auto_duck). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../ducking.js");

const FS = 48000;
/** A clip of silence with tone bursts at [from, to] seconds (amplitude a). */
function bursts(sec, spans, a = 0.1) {
  const x = new Float32Array(Math.round(sec * FS));
  for (const [s, e] of spans)
    for (let i = Math.round(s * FS); i < Math.round(e * FS); i++) x[i] = a * Math.sin(i * 0.13);
  return x;
}
const pairs = (keys) => keys.map((k) => [k.t, k.v]);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("the envelope finds speech, offset onto the timeline", () => {
  const env = D.rmsEnvelope([bursts(6, [[1, 2.5]])], FS);
  const r = D.activeRegions(env, { t0: 10 });
  assert.equal(r.length, 1);
  near(r[0][0], 11, 0.1, "starts with the burst");
  near(r[0][1], 12.5, 0.12, "ends with it");
});

test("threshold, clip gain and speed shape what counts as voice", () => {
  const env = D.rmsEnvelope([bursts(4, [[1, 2]], 0.003)], FS); // ≈ −53 dBFS
  assert.equal(D.activeRegions(env, { threshold: -40 }).length, 0, "too quiet to be voice");
  assert.equal(D.activeRegions(env, { threshold: -40, gain: 10 }).length, 1, "+20 dB clip gain makes it count");
  const fast = D.activeRegions(D.rmsEnvelope([bursts(4, [[1, 2]])], FS), { speed: 2 });
  near(fast[0][0], 0.5, 0.06, "2× speed halves the timeline time");
});

test("blips shorter than minLen are ignored; close regions merge across short gaps", () => {
  assert.equal(D.activeRegions(D.rmsEnvelope([bursts(2, [[1, 1.03]])], FS)).length, 0);
  assert.deepEqual(D.mergeRegions([[[1, 2]], [[2.4, 3]], [[5, 6]]]), [[1, 3], [5, 6]]);
  assert.deepEqual(D.mergeRegions([[[1, 2], [2.4, 3]]], 0.2), [[1, 2], [2.4, 3]], "gap larger than the bridge");
});

test("duck keyframes ramp down before speech and back up after", () => {
  const keys = D.duckKeyframes([[11, 14]], { start: 8, duration: 10 }, { amount: -12, attack: 0.3, release: 0.6 });
  assert.deepEqual(pairs(keys), [[2.7, 0], [3, -12], [6, -12], [6.6, 0]]);
  assert.ok(keys.every((k) => k.ease === "linear"));
});

test("duck keyframes are cut cleanly at the clip edges", () => {
  const clip = { start: 8, duration: 10 };
  assert.deepEqual(pairs(D.duckKeyframes([[7, 9]], clip)), [[0, -12], [1, -12], [1.6, 0]], "speech already running");
  assert.deepEqual(pairs(D.duckKeyframes([[17.8, 30]], clip)), [[9.5, 0], [9.8, -12], [10, -12]], "runs past the end");
  assert.deepEqual(pairs(D.duckKeyframes([[17.5, 17.6]], clip)), [[9.2, 0], [9.5, -12], [9.6, -12], [10, -4]],
    "ends mid-release: the last key is the interpolated level");
  assert.deepEqual(D.duckKeyframes([[30, 31]], clip), [], "no speech under the clip");
  assert.deepEqual(D.duckKeyframes([[10, 11]], clip, { amount: 0 }), [], "amount 0 = no ducking");
});

test("overlapping ramps stay ducked instead of bouncing", () => {
  const keys = D.duckKeyframes([[10, 11], [11.5, 12]], { start: 8, duration: 10 });
  assert.deepEqual(pairs(keys), [[1.7, 0], [2, -12], [4, -12], [4.6, 0]]);
});

test("chunked envelope streaming matches one push", () => {
  const x = bursts(3, [[0.5, 2]]);
  const whole = D.rmsEnvelope([x], FS);
  const m = new D.EnvelopeMeter(1, FS);
  for (let i = 0; i < x.length; i += 4321) m.push([x.subarray(i, i + 4321)]);
  assert.deepEqual([...m.result()], [...whole]);
});
