/* The mixer graph: preview (AudioContext) and the export mix
   (OfflineAudioContext) are both built from the same app.js helpers, so this
   checks the topology those helpers produce against a recording fake context.
   app.js has no exports — the functions are sliced out by name markers, like
   timeline-sandbox.js; a rename fails loudly instead of passing vacuously. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { ROOT } = require("./helpers");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  assert.ok(a >= 0, `start marker not found: ${startMarker}`);
  assert.ok(b > a, `end marker not found after it: ${endMarker}`);
  return SRC.slice(a, b);
}
const CODE = [
  slice("const VIDEO_TRACK_COLORS", "const DEFAULT_TRACK_DEFS"),
  slice("function makeTrack(", "/** Live track list"),
  slice("/* ── Mixer levels (dB).", "const TRACK_IDS"),
  slice("function serializeTracks(", "/** Ensure every clip.track exists"),
  slice("function clipPan(", "/** Grow A-tracks"),
  slice("/* ═══ Audio mixer — one graph", "function ensureAudio("),
  slice("function rewireClipChain(", "function disposeClipChain("),
  slice("function driveClipChain(", "function muteClipChain("),
  slice("const FADER_TAPER", "function setSideTab("),
].join("\n");
const EXPORTS = ["dbToGain", "clampFaderDb", "normalizeMaster", "serializeTracks", "applyTracksFromProject",
  "wireClipInput", "buildClipChain", "rewireClipChain", "buildMixBuses", "applyMixLevels", "busOut",
  "driveClipChain", "faderPosToDb", "faderDbToPos", "fmtPan", "parseDbInput"];

function world({ tracks = [{ id: "A1", kind: "audio" }, { id: "A2", kind: "audio" }], master = null, media = [] } = {}) {
  const TRACKS = [];
  const project = { master, media };
  const env = {
    TRACKS, project, TRACK_IDS: new Set(),
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    applyTrackHeights() {}, syncTrackIds() {},
    getMedia: (id) => media.find((m) => m.id === id),
  };
  const names = Object.keys(env);
  const fns = new Function(...names, `${CODE}\nreturn { ${EXPORTS.join(", ")} };`)(...names.map((k) => env[k]));
  fns.applyTracksFromProject(tracks);
  return { ...fns, TRACKS, project };
}

/* A context that records every connect(): edges are [from, to, output, input]. */
function fakeCtx() {
  const edges = [];
  let n = 0;
  const node = (kind, extra = {}) => {
    const self = {
      kind, id: kind + ++n, channelCount: 2, channelCountMode: "max", channelInterpretation: "speakers",
      connect(to, out = 0, inp = 0) { edges.push([self, to, out, inp]); return to; },
      disconnect() { for (let i = edges.length - 1; i >= 0; i--) if (edges[i][0] === self) edges.splice(i, 1); },
      ...extra,
    };
    return self;
  };
  const param = (value) => ({ value, setTargetAtTime(v) { this.value = v; } });
  return {
    edges, currentTime: 0,
    createGain: () => node("gain", { gain: param(1) }),
    createStereoPanner: () => node("pan", { pan: param(0) }),
    createChannelSplitter: (k) => node("split", { outputs: k }),
    createChannelMerger: (k) => node("merge", { inputs: k }),
    source: () => node("src"),
    outs: (from) => edges.filter((e) => e[0] === from),
  };
}
/* Follow single outgoing edges from a node; returns the kinds visited. */
function walk(ctx, from, stop) {
  const seen = [from.kind];
  let cur = from;
  for (let i = 0; i < 20 && cur !== stop; i++) {
    const out = ctx.outs(cur);
    assert.equal(out.length, 1, `${cur.id} should have one output, has ${out.length}`);
    cur = out[0][1];
    seen.push(cur.kind);
  }
  return seen;
}

test("dB helpers: unity, −6 dB, the floor is silence, junk is unity", () => {
  const w = world();
  assert.equal(w.dbToGain(0), 1);
  assert.ok(Math.abs(w.dbToGain(-6) - 0.501) < 0.001);
  assert.equal(w.dbToGain(-60), 0, "a fader at its floor is −∞");
  assert.equal(w.dbToGain(NaN), 1);
  assert.equal(w.clampFaderDb(40), 12);
  assert.equal(w.clampFaderDb("x"), 0);
  assert.equal(w.normalizeMaster({ gain: 0 }), null, "a 0 dB master is not written");
  assert.deepEqual(w.normalizeMaster({ gain: -3 }), { gain: -3 });
  assert.equal(w.normalizeMaster(undefined), null);
});

test("fader taper: unity at ¾ throw, −∞ at the bottom, and it inverts", () => {
  const w = world();
  assert.equal(w.faderPosToDb(0.75), 0);
  assert.equal(w.faderPosToDb(0), -60);
  assert.equal(w.faderPosToDb(1), 12);
  for (const db of [-60, -40, -18, -6, -0.5, 0, 3, 12])
    assert.ok(Math.abs(w.faderPosToDb(w.faderDbToPos(db)) - db) < 1e-9, `round trip ${db}`);
  assert.equal(w.fmtPan(0), "C");
  assert.equal(w.fmtPan(-0.4), "L40");
  assert.equal(w.fmtPan(1), "R100");
  assert.equal(w.parseDbInput("-inf"), -60);
  assert.equal(w.parseDbInput("−6 dB"), -6);
  assert.equal(w.parseDbInput("+3.5"), 3.5);
  assert.equal(w.parseDbInput("loud"), null);
});

test("track mixer settings round-trip through project.tracks, written only off-default", () => {
  const w = world({ tracks: [{ id: "V1", kind: "video", gain: -6 }, { id: "A1", kind: "audio", gain: -6, pan: 0.5 },
    { id: "A2", kind: "audio", gain: 99, pan: -7 }, { id: "A3", kind: "audio", gain: 0 }] });
  assert.deepEqual(w.serializeTracks(), [
    { id: "V1", kind: "video" },                     // video lanes have no fader
    { id: "A1", kind: "audio", gain: -6, pan: 0.5 },
    { id: "A2", kind: "audio", gain: 12, pan: -1 },  // clamped on load
    { id: "A3", kind: "audio" },                     // 0 dB is the default: omitted
  ]);
});

test("one graph: clip → trim → vol → pan → track fader → track pan → master sum → master fader", () => {
  const w = world({ tracks: [{ id: "A1", kind: "audio", gain: -6, pan: 0.25 }], master: { gain: 3 } });
  const ctx = fakeCtx();
  const mix = w.buildMixBuses(ctx, ["A1"]);
  w.applyMixLevels(mix);
  const src = ctx.source();
  const c = { id: "c1", track: "A1", props: { gain: -12 } };
  const chain = w.buildClipChain(ctx, src, c, 2);
  chain.out.connect(mix.trackBus.A1);
  assert.deepEqual(walk(ctx, src, mix.masterOut), ["src", "gain", "gain", "pan", "gain", "pan", "gain", "gain"]);
  assert.equal(chain.trim.gain.value, w.dbToGain(-12), "clip gain lands on the trim");
  assert.equal(mix.trackBus.A1.gain.value, w.dbToGain(-6), "track fader");
  assert.equal(mix.trackBus.A1._fcPan.pan.value, 0.25, "track pan");
  assert.equal(mix.masterOut.gain.value, w.dbToGain(3), "master fader");
  assert.equal(w.busOut(mix.trackBus.A1), mix.trackBus.A1._fcPan, "the bus output is its pan");
  // A live frame drives volume / pan / clip gain from the evaluated props.
  w.driveClipChain(chain, c, { volume: 0.5, pan: -1 });
  assert.equal(chain.vol.gain.value, 0.5);
  assert.equal(chain.pan.pan.value, -1);
});

test("channel modes: what each one wires in front of the clip's trim", () => {
  const w = world();
  const ctx = fakeCtx();
  const route = (props, nCh = 2) => {
    const src = ctx.source(), trim = ctx.createGain();
    w.wireClipInput(ctx, src, trim, { props }, nCh);
    return { src, trim };
  };
  // stereo: straight in
  let { src, trim } = route({});
  assert.equal(ctx.outs(src)[0][1], trim);
  // mono: a one-channel speakers downmix
  ({ src, trim } = route({ channelMode: "mono" }));
  const down = ctx.outs(src)[0][1];
  assert.equal(down.channelCount, 1);
  assert.equal(down.channelCountMode, "explicit");
  assert.equal(down.channelInterpretation, "speakers");
  assert.equal(ctx.outs(down)[0][1], trim);
  // right: splitter output 1 only
  ({ src, trim } = route({ channelMode: "right" }));
  const split = ctx.outs(src)[0][1];
  assert.deepEqual(ctx.outs(split).map((e) => [e[1], e[2]]), [[trim, 1]]);
  // right on a mono file would be silence — it plays as is
  ({ src, trim } = route({ channelMode: "right" }, 1));
  assert.equal(ctx.outs(src)[0][1], trim);
  // swap: L → merger input 1, R → input 0
  ({ src, trim } = route({ channelMode: "swap" }));
  const sp = ctx.outs(src)[0][1];
  const m = ctx.outs(sp)[0][1];
  assert.deepEqual(ctx.outs(sp).map((e) => [e[2], e[3]]), [[0, 1], [1, 0]]);
  assert.equal(ctx.outs(m)[0][1], trim);
  // a linked stem taps its channel, whatever channelMode says
  ({ src, trim } = route({ audioChannel: 4, channelMode: "mono" }, 6));
  const s6 = ctx.outs(src)[0][1];
  assert.equal(s6.outputs, 6);
  assert.deepEqual(ctx.outs(s6).map((e) => [e[1], e[2]]), [[trim, 4]]);
});

test("changing channelMode re-routes a live chain in place", () => {
  const w = world();
  const ctx = fakeCtx();
  const src = ctx.source();
  const c = { props: { channelMode: "stereo" } };
  const chain = w.buildClipChain(ctx, src, c, 2);
  assert.equal(ctx.outs(src)[0][1], chain.trim);
  c.props.channelMode = "left";
  w.rewireClipChain(chain, c);
  const split = ctx.outs(src)[0][1];
  assert.equal(split.kind, "split");
  assert.deepEqual(ctx.outs(split).map((e) => [e[1], e[2]]), [[chain.trim, 0]]);
  assert.equal(ctx.outs(src).length, 1, "the old direct path is gone");
  // A media element hooked before its channel count was known: a mono file
  // must fall back to playing as is once the probe lands.
  const w2 = world({ media: [{ id: "m1", channels: 1 }] });
  const ctx2 = fakeCtx(), src2 = ctx2.source();
  const c2 = { mediaId: "m1", props: { channelMode: "right" } };
  const ch2 = w2.buildClipChain(ctx2, src2, c2, 2);
  assert.equal(ctx2.outs(src2)[0][1].kind, "split");
  w2.driveClipChain(ch2, c2, { volume: 1, pan: 0 });
  assert.equal(ctx2.outs(src2)[0][1], ch2.trim);
});
