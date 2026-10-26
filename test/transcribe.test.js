/* transcribe.js — Whisper's word pieces → words, words → the timeline, finding
   a phrase, and the spans and extract ops the Transcript tab and
   fablecut_transcribe cut with. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../transcribe.js");
const ProjectOps = require("../project-ops.js");

test("model and language are defaulted and checked", () => {
  assert.equal(T.model(), "base");
  assert.equal(T.model("small"), "small");
  assert.throws(() => T.model("large"), /model must be base or small/);
  assert.equal(T.language(), null);
  assert.equal(T.language("auto"), null);
  assert.equal(T.language("EN"), "en");
  assert.equal(T.language("Hindi"), "hi");
  assert.equal(T.language("yue"), "yue");
  assert.throws(() => T.language("klingon"), /Whisper language code/);
});

test("joinChunks glues pieces without a leading space onto the word before", () => {
  const words = T.joinChunks([
    { text: " Free", timestamp: [44.12, 44.52] }, { text: " at", timestamp: [44.52, 44.86] },
    { text: " studio", timestamp: [44.86, 45.12] }, { text: ".fablecut", timestamp: [45.12, 46.02] },
    { text: ".space.", timestamp: [46.02, 46.66] }, { text: "  ", timestamp: [47, 47.2] },
  ], 10);
  assert.deepEqual(words, [["Free", 54.12, 54.52], ["at", 54.52, 54.86], ["studio.fablecut.space.", 54.86, 56.66]]);
});

test("joinChunks mends missing or backwards times and keeps CJK characters apart", () => {
  const w = T.joinChunks([{ text: " one", timestamp: [1, 1.5] }, { text: " two", timestamp: [0.9, null] }, { text: " three", timestamp: [null, 3] }]);
  assert.deepEqual(w, [["one", 1, 1.5], ["two", 1, 1.3], ["three", 1.3, 3]]);
  assert.equal(T.joinChunks([{ text: "你", timestamp: [0, 0.2] }, { text: "好", timestamp: [0.2, 0.4] }]).length, 2);
  assert.deepEqual(T.joinChunks([{ text: " end", timestamp: [9, 12] }], 0, 10), [["end", 9, 10]]);
});

test("plan splits long audio at its quietest moment, short audio in one piece", () => {
  const rate = 1000;
  const pcm = new Float32Array(70 * rate).fill(0.5);
  pcm.fill(0, 20 * rate, 20.2 * rate);   // a pause at 20 s
  pcm.fill(0, 45 * rate, 45.2 * rate);   // and at 45 s
  const p = T.plan(pcm, rate);
  assert.equal(p[0][0], 0);
  assert.equal(p[p.length - 1][1], pcm.length);
  for (let k = 1; k < p.length; k++) assert.equal(p[k][0], p[k - 1][1]);
  for (const [a, b] of p) assert.ok(b - a <= 28 * rate, "≤ 28 s each");
  assert.ok(Math.abs(p[0][1] - 20.1 * rate) < 0.15 * rate, `first split in the pause (${p[0][1]})`);
  assert.ok(Math.abs(p[1][1] - 45.1 * rate) < 0.15 * rate, `second split in the pause (${p[1][1]})`);
  assert.deepEqual(T.plan(new Float32Array(5 * rate), rate), [[0, 5 * rate]]);
  assert.deepEqual(T.plan(new Float32Array(0), rate), [[0, 0]]);
});

test("quiet() spots silence and leaves speech", () => {
  assert.equal(T.quiet(new Float32Array(1000)), true);
  assert.equal(T.quiet(new Float32Array(1000).fill(0.0005)), true);   // -66 dBFS
  assert.equal(T.quiet(new Float32Array(1000).fill(0.05)), false);
});

test("validate keeps a clean document and refuses a broken one", () => {
  const d = T.validate({ src: "/media/a.wav", model: "base", language: "en", duration: 5, words: [["hi", 0.5, 0.9], [" ", 1, 2], ["there", 0.4, 9]] });
  assert.deepEqual(d.words, [["hi", 0.5, 0.9], ["there", 0.5, 5]]);
  assert.equal(d.v, 1);
  assert.throws(() => T.validate({ words: [["a", "x", 1]] }), /\[text, start, end\]/);
  assert.throws(() => T.validate({}), /needs words/);
  assert.throws(() => T.validate(null), /object/);
});

const words = [["So", 1, 1.2], ["um,", 1.4, 1.7], ["this", 2, 2.3], ["is", 2.3, 2.4], ["A.I.", 2.5, 2.9], ["powered", 2.9, 3.4], ["editing.", 3.5, 4]];

test("clipWords maps file time onto the timeline through in and speed", () => {
  const clip = { id: "c1", start: 10, in: 1.9, duration: 1, props: { speed: 2 } };   // file 1.9…3.9
  const w = T.clipWords(clip, words);
  assert.deepEqual(w.map((x) => x.w), ["this", "is", "A.I.", "powered", "editing."]);
  assert.deepEqual([w[0].s, w[0].e], [10.05, 10.2]);
  assert.deepEqual(w[4].r, [10, 11]);
  assert.equal(w[4].e, 11, "clamped to the clip's end");
  assert.deepEqual(T.clipWords({ ...clip, keyframes: { speed: [{ t: 0, v: 1 }] } }, words), [], "a speed ramp is left out");
});

test("layout puts several clips' words in time order", () => {
  const a = { id: "a", start: 5, in: 0, duration: 1.8 }, b = { id: "b", start: 0, in: 2, duration: 2 };
  const w = T.layout([{ clip: a, words }, { clip: b, words }]);
  assert.deepEqual(w.map((x) => x.clip + ":" + x.w), ["b:this", "b:is", "b:A.I.", "b:powered", "b:editing.", "a:So", "a:um,"]);
});

test("find matches whole words, ignoring case, punctuation and spacing", () => {
  const w = T.layout([{ clip: { id: "c", start: 0, in: 0, duration: 10 }, words }]);
  assert.deepEqual(T.find(w, "um"), [{ i: 1, j: 1 }]);
  assert.deepEqual(T.find(w, "ai powered"), [{ i: 4, j: 5 }]);
  assert.deepEqual(T.find(w, "AI-Powered Editing!"), [{ i: 4, j: 6 }]);
  assert.deepEqual(T.find(w, "edit"), [], "not the start of a longer word");
  assert.deepEqual(T.find(w, "his"), [], "not the end of one");
  assert.deepEqual(T.find(w, "..."), []);
  const rep = T.layout([{ clip: { id: "c", start: 0, in: 0, duration: 10 }, words: [["no", 0, 1], ["no", 1, 2], ["no", 2, 3]] }]);
  assert.deepEqual(T.find(rep, "no no"), [{ i: 0, j: 1 }], "matches never overlap");
  assert.equal(T.find(rep, "no", { limit: 2 }).length, 2);
});

test("cutSpans takes the words and the pause after them, never a neighbour, on frames", () => {
  const w = T.layout([{ clip: { id: "c", start: 0, in: 0, duration: 10 }, words }]);
  const [s] = T.cutSpans(w, T.find(w, "um"), { fps: 10 });
  assert.deepEqual(s, { from: 1.4, to: 1.9 });   // the pause after "So" stays; up to just before "this" (2.0)
  assert.ok(s.from >= 1.2 && s.to <= 2, "So and this stay whole");
  const [e] = T.cutSpans(w, T.find(w, "editing"), { fps: 10 });
  assert.deepEqual(e, { from: 3.5, to: 4.1 }, "the last word: from its start, a short tail after it");
  // runs that touch merge into one span
  assert.deepEqual(T.cutSpans(w, [{ i: 2, j: 2 }, { i: 3, j: 3 }], { fps: 10 }), [{ from: 2, to: 2.4 }]);
});

test("cutSpans stays inside the clip, and a word in another clip isn't a neighbour", () => {
  const w = T.layout([{ clip: { id: "a", start: 0, in: 1.9, duration: 0.6 }, words }, { clip: { id: "b", start: 0.6, in: 0, duration: 1.3 }, words }]);
  // "is" ends clip a (0…0.6); the next word belongs to b
  const run = T.find(w, "is");
  const [s] = T.cutSpans(w, run, { fps: 10 });
  assert.ok(s.to <= 0.6 + 1e-9, `inside clip a (${s.to})`);
});

test("cutOps extracts last first, and the ops apply to a project", () => {
  const ops = T.cutOps([{ from: 1, to: 2 }, { from: 4, to: 5 }], { tracks: ["A1"], force: true });
  assert.deepEqual(ops, [{ op: "extract", from: 4, to: 5, tracks: ["A1"], force: true }, { op: "extract", from: 1, to: 2, tracks: ["A1"], force: true }]);
  const doc = { revision: 1, fps: 10, width: 640, height: 360, media: [{ id: "m", kind: "audio", src: "/media/a.wav", duration: 10 }],
    clips: [{ id: "c", kind: "audio", mediaId: "m", track: "A1", start: 0, in: 0, duration: 10 }] };
  ProjectOps.applyPatch(doc, T.cutOps([{ from: 1, to: 2 }, { from: 4, to: 5 }]));
  assert.equal(doc.clips.reduce((n, c) => n + c.duration, 0), 8);
});

test("segments break at sentences and pauses, not at abbreviations", () => {
  const w = T.layout([{ clip: { id: "c", start: 0, in: 0, duration: 10 }, words }]);
  const seg = T.segments(w, { min: 0.5, gap: 0.25 });
  assert.deepEqual(seg.map((s) => s.text), ["So um,", "this is A.I. powered editing."]);
  assert.deepEqual([seg[1].from, seg[1].to], [2, 4]);
  assert.equal(T.total([{ from: 1, to: 1.5 }, { from: 2, to: 3 }]), 1.5);
});
