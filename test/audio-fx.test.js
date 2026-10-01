/* Audio effects: the shared chain definitions / presets (audio-fx.js) and the
   gate + limiter processors (fx-worklet.js), run in Node with a stubbed
   AudioWorklet global scope like meter-worklet.test.js. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { ROOT } = require("./helpers");
const F = require("../audio-fx.js");

test("normalizeFx fills defaults, clamps ranges and keeps bypass", () => {
  const [eq] = F.normalizeFx([{ type: "eq", lowGain: 99, on: false }]);
  assert.equal(eq.lowGain, 18, "clamped to the max");
  assert.equal(eq.midFreq, 1000, "default filled");
  assert.equal(eq.on, false);
  assert.deepEqual(F.normalizeFx([{ type: "nope" }, { type: "lowpass" }]).map((e) => e.type), ["lowpass"],
    "unknown effects are dropped when loading");
  assert.throws(() => F.normalizeFx([{ type: "nope" }], true), /unknown effect "nope"/, "…and refused from an agent");
  assert.throws(() => F.normalizeFx({ type: "eq" }, true), /must be an array/);
  assert.deepEqual(F.normalizeFx(null), []);
});

test("every preset is a valid, distinct chain", () => {
  const seen = new Set();
  for (const id of F.PRESET_IDS) {
    const chain = F.presetChain(id);
    assert.ok(chain.length > 0, id);
    assert.deepEqual(F.normalizeFx(chain, true), chain, `${id} survives strict validation`);
    const sig = JSON.stringify(chain);
    assert.ok(!seen.has(sig), `${id} duplicates another preset`);
    seen.add(sig);
    assert.ok(["Voice", "Music"].includes(F.PRESETS[id].group));
  }
  for (const id of ["clean-voice", "podcast", "radio", "deep-voice", "telephone", "cinematic", "wide", "muffled"])
    assert.ok(F.PRESETS[id], `preset ${id} exists`);
  assert.throws(() => F.presetChain("loud"), /unknown preset/);
  assert.equal(F.summarizeFx([{ type: "eq" }, { type: "limiter", on: false }]), "eq·limiter(off)");
});

/* fx-worklet.js in a fake AudioWorkletGlobalScope */
const procs = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "fx-worklet.js"), "utf8"), {
  AudioWorkletProcessor: class { }, registerProcessor: (n, c) => { procs[n] = c; },
  sampleRate: 48000, Math, Float32Array, Array,
});
/** Run a processor over whole buffers in 128-frame blocks. */
function run(name, chans, params) {
  const p = new procs[name]();
  const desc = Object.fromEntries(procs[name].parameterDescriptors.map((d) => [d.name, d.defaultValue]));
  const prm = Object.fromEntries(Object.entries({ ...desc, ...params }).map(([k, v]) => [k, Float32Array.of(v)]));
  const n = chans[0].length, out = chans.map(() => new Float32Array(n));
  for (let i = 0; i < n; i += 128) {
    const inp = chans.map((c) => c.subarray(i, i + 128)), o = out.map((c) => c.subarray(i, i + 128));
    p.process([inp], [o], prm);
  }
  return out;
}
const sine = (a, n, f = 440) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / 48000));
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

test("limiter: nothing passes the ceiling, quiet audio passes untouched (delayed 5 ms)", () => {
  const loud = sine(1.5, 48000), quiet = sine(0.2, 48000);
  const [l, r] = run("fablecut-limiter", [loud, quiet], { ceiling: -1 });
  const ceil = Math.pow(10, -1 / 20);
  assert.ok(peak(l) <= ceil + 1e-6, `left peak ${peak(l)} over the ceiling ${ceil}`);
  assert.ok(peak(r) < 0.2, "stereo-linked: the quiet side dips with the loud one");
  const [q] = run("fablecut-limiter", [quiet], { ceiling: -1 });
  const d = 240; // 5 ms lookahead
  for (let i = d; i < 2000; i++) assert.ok(Math.abs(q[i] - quiet[i - d]) < 1e-6, "under the ceiling = a pure delay");
});

test("gate: closes on room noise, opens for the voice", () => {
  const n = 48000, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = i < 24000 ? 0.001 * Math.sin(i) : 0.3 * Math.sin(i * 0.05); // −60 dB hiss, then voice
  const [y] = run("fablecut-gate", [x], { threshold: -40, range: -40, release: 50, hold: 20 });
  assert.ok(rms(y.subarray(12000, 24000)) < rms(x.subarray(12000, 24000)) * 0.02, "noise pushed down ~40 dB");
  assert.ok(Math.abs(rms(y.subarray(30000)) - rms(x.subarray(30000))) < 0.01, "voice passes at full level");
});
