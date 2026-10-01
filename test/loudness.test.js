/* loudness.js — the BS.1770 / EBU R128 meter behind Normalize (editor) and
   fablecut_normalize_audio (MCP). Reference values come from EBU Tech 3341:
   a 1 kHz sine at −23 dBFS on both channels reads −23 LUFS. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../loudness.js");

const FS = 48000;
function sine(db, sec, freq = 1000) {
  const a = Math.pow(10, db / 20), n = Math.round(sec * FS), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * freq * i / FS);
  return x;
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("EBU reference: stereo 1 kHz at −23 dBFS reads −23 LUFS", () => {
  const s = sine(-23, 10);
  const m = L.measure([s, s], FS);
  near(m.lufs, -23, 0.1, "integrated loudness");
  near(m.peakDb, -23, 0.01, "sample peak");
});

test("a mono 0 dBFS sine reads −3 LUFS, and works at 44.1 kHz too", () => {
  near(L.measure([sine(0, 5)], FS).lufs, -3.01, 0.1, "48 kHz");
  const n = 44100 * 5, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / 44100);
  near(L.measure([x], 44100).lufs, -3.01, 0.1, "44.1 kHz");
});

test("gating: silence does not drag the reading down, a quiet bed is gated out", () => {
  const tone = sine(-20, 5);
  const withSilence = new Float32Array(tone.length * 2);
  withSilence.set(tone);
  near(L.measure([withSilence], FS).lufs, L.measure([tone], FS).lufs, 0.2, "absolute gate (−70 LUFS)");
  // −50 dB bed after the tone: more than 10 LU below → removed by the relative gate.
  const bed = sine(-50, 5);
  const both = new Float32Array(tone.length + bed.length);
  both.set(tone); both.set(bed, tone.length);
  near(L.measure([both], FS).lufs, L.measure([tone], FS).lufs, 0.2, "relative gate (−10 LU)");
});

test("silence measures −∞ and normalizeGainDb declines it", () => {
  const m = L.measure([new Float32Array(FS)], FS);
  assert.equal(m.lufs, -Infinity);
  assert.equal(m.peak, 0);
  assert.equal(L.normalizeGainDb(m, { mode: "lufs", value: -14 }), null);
  assert.equal(L.normalizeGainDb(m, { mode: "peak", value: -1 }), null);
});

test("clips shorter than one 400 ms block still get a reading", () => {
  near(L.measure([sine(-23, 0.25), sine(-23, 0.25)], FS).lufs, -23, 0.5, "short clip");
});

test("streaming in chunks gives the same answer as one push", () => {
  const s = sine(-18, 3, 440);
  const whole = L.measure([s, s], FS);
  const meter = new L.LoudnessMeter(2, FS);
  for (let i = 0; i < s.length; i += 1777) meter.push([s.subarray(i, i + 1777), s.subarray(i, i + 1777)]);
  const parts = meter.result();
  near(parts.lufs, whole.lufs, 1e-9, "chunked LUFS");
  assert.equal(parts.peak, whole.peak);
});

test("normalizeGainDb is the distance to the target", () => {
  const s = sine(-23, 5);
  const m = L.measure([s, s], FS);
  near(L.normalizeGainDb(m, { mode: "lufs", value: -14 }), 9, 0.1, "LUFS");
  near(L.normalizeGainDb(m, { mode: "peak", value: -1 }), 22, 0.01, "peak");
});

test("routeChannels mirrors the editor graph: stems and mono modes are one channel", () => {
  const l = Float32Array.from([1, 1]), r = Float32Array.from([0, 0.5]);
  assert.deepEqual(L.routeChannels([l, r], {}), [l, r], "stereo passes through");
  assert.deepEqual(L.routeChannels([l, r], { channelMode: "nonsense" }), [l, r], "unknown mode = stereo");
  assert.deepEqual(L.routeChannels([l, r], { audioChannel: 1 }), [r], "an isolated stem is its channel");
  assert.deepEqual(L.routeChannels([l, r], { audioChannel: 1, channelMode: "left" }), [r], "audioChannel wins over channelMode");
  assert.deepEqual(L.routeChannels([l, r], { audioChannel: 4 }), [], "a missing channel is silent");
  assert.deepEqual(L.routeChannels([l, r], { channelMode: "left" }), [l]);
  assert.deepEqual(L.routeChannels([l, r], { channelMode: "right" }), [r]);
  assert.deepEqual(L.routeChannels([l, r], { channelMode: "swap" }), [r, l]);
  assert.deepEqual([...L.routeChannels([l, r], { channelMode: "mono" })[0]], [0.5, 0.75], "mono = ½(L+R)");
  assert.deepEqual(L.routeChannels([l], { channelMode: "right" }), [l], "a mono file plays as is");
});
