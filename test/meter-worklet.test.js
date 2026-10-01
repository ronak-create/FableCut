/* Unit tests for the meter worklet. We mock the AudioWorkletProcessor base
   class and registerProcessor so the worklet can run in Node. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { ROOT } = require("./helpers");

class FakeAudioWorkletProcessor {
  constructor() {}
}

let RegisteredProcessor = null;
function fakeRegisterProcessor(name, cls) {
  cls.registeredName = name;
  RegisteredProcessor = cls;
}

const workletPath = path.join(ROOT, "meter-worklet.js");
const workletCode = fs.readFileSync(workletPath, "utf8");
vm.runInNewContext(workletCode, {
  AudioWorkletProcessor: FakeAudioWorkletProcessor,
  registerProcessor: fakeRegisterProcessor,
  sampleRate: 48000,
  Math, Float32Array, Float64Array, Array, console,
});

function makeProcessor(opts = {}) {
  return new RegisteredProcessor({
    processorOptions: {
      hopBlocks: 1,
      nTracks: 2,
      nAudioTracks: 1,
      trackIds: ["A1"],
      ...opts,
    },
  });
}

function runHop(p, { L, R, spillL, spillR }) {
  const size = 128;
  const l = L || new Float32Array(size);
  const r = R || new Float32Array(size);
  const sl = spillL || new Float32Array(size);
  const sr = spillR || new Float32Array(size);
  const outL = new Float32Array(size);
  const outR = new Float32Array(size);
  const messages = [];
  p.port = { postMessage: (msg) => messages.push(msg) };
  p.process([[l, r], [sl, sr]], [[outL, outR]]);
  return { messages, outL, outR };
}

test("mono stem panned left: track RMS matches active channel", () => {
  const p = makeProcessor();
  const size = 128;
  const L = new Float32Array(size).fill(0.5);
  const R = new Float32Array(size); // silent
  const { messages } = runHop(p, { L, R });
  assert.equal(messages.length, 1);
  const msg = messages[0];
  // Old mono mixdown would give 0.25 (-12 dBFS). New max(L,R) gives 0.5 (-6 dBFS).
  assert.ok(Math.abs(msg.rms[0] - 0.5) < 0.001, `rms was ${msg.rms[0]}`);
  assert.ok(Math.abs(msg.peak[0] - 0.5) < 0.001, `peak was ${msg.peak[0]}`);
});

test("stereo centered track: track RMS matches per-channel master", () => {
  const p = makeProcessor();
  const size = 128;
  const L = new Float32Array(size).fill(0.5);
  const R = new Float32Array(size).fill(-0.5); // anti-phase, same amplitude
  const { messages } = runHop(p, { L, R });
  const msg = messages[0];
  // Mono mixdown would cancel to 0. Track meter should follow the louder channel.
  assert.ok(Math.abs(msg.rms[0] - 0.5) < 0.001, `rms was ${msg.rms[0]}`);
  assert.ok(Math.abs(msg.peak[0] - 0.5) < 0.001, `peak was ${msg.peak[0]}`);
});

test("single track: master LUFS equals per-track LUFS", () => {
  const p = makeProcessor();
  const size = 128;
  const L = new Float32Array(size).fill(0.5);
  const R = new Float32Array(size).fill(-0.3);
  const { messages } = runHop(p, { L, R });
  const msg = messages[0];
  assert.ok(Number.isFinite(msg.lufs[0]), `track lufs was ${msg.lufs[0]}`);
  assert.ok(Number.isFinite(msg.masterLufs), `master lufs was ${msg.masterLufs}`);
  assert.ok(Math.abs(msg.lufs[0] - msg.masterLufs) < 0.1,
    `track lufs ${msg.lufs[0]} vs master lufs ${msg.masterLufs}`);
});

test("output is the sum of inputs", () => {
  const p = makeProcessor({ nAudioTracks: 1, nTracks: 2 });
  const size = 128;
  const L = new Float32Array(size).fill(0.3);
  const R = new Float32Array(size).fill(0.4);
  const spillL = new Float32Array(size).fill(0.1);
  const spillR = new Float32Array(size).fill(0.2);
  const { outL, outR } = runHop(p, { L, R, spillL, spillR });
  assert.ok(Math.abs(outL[0] - 0.4) < 0.001, `outL[0] was ${outL[0]}`);
  assert.ok(Math.abs(outR[0] - 0.6) < 0.001, `outR[0] was ${outR[0]}`);
});

test("programInput: only the program reaches the output; the other inputs are meter taps", () => {
  const p = makeProcessor({ programInput: 1 });
  const size = 128;
  const L = new Float32Array(size).fill(0.5);   // track tap
  const spillL = new Float32Array(size).fill(0.1); // the finished program
  const { messages, outL } = runHop(p, { L, spillL });
  assert.ok(Math.abs(outL[0] - 0.1) < 1e-6, `output was ${outL[0]} — a tap leaked into the program`);
  assert.ok(Math.abs(messages[0].rms[0] - 0.5) < 0.001, "the track tap is still metered");
  assert.ok(messages[0].masterLufs < messages[0].lufs[0], "master LUFS follows the program, not the tap");
});
