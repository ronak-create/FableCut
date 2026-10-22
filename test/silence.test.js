/* silence.js — the spans the inspector's Silence section and
   fablecut_silence cut: gaps between sound inside the clips, padding kept
   beside speech, whole frames, and the extract ops that remove them. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../silence.js");
const ProjectOps = require("../project-ops.js");

test("options default, and refuse values out of range", () => {
  assert.deepEqual(S.options(), { threshold: -40, minSilence: 0.5, padding: 0.15 });
  assert.deepEqual(S.options({ threshold: -30, minSilence: 1, padding: 0 }), { threshold: -30, minSilence: 1, padding: 0 });
  assert.throws(() => S.options({ threshold: 0 }), /threshold must be -80…-10/);
  assert.throws(() => S.options({ minSilence: 0.01 }), /minSilence/);
  assert.throws(() => S.options({ padding: "x" }), /padding/);
});

test("gaps between phrases, less the padding; none at a clip's own edges", () => {
  // a 10 s clip: speech 1–3 s and 5–6 s
  const spans = S.silentSpans([[1, 3], [5, 6]], [[0, 10]], { minSilence: 0.5, padding: 0.2, fps: 10 });
  assert.deepEqual(spans, [{ from: 0, to: 0.8 }, { from: 3.2, to: 4.8 }, { from: 6.2, to: 10 }]);
});

test("a pause shorter than minSilence stays, and so does sound across the whole clip", () => {
  assert.deepEqual(S.silentSpans([[0, 2], [2.4, 5]], [[0, 5]], { minSilence: 0.5, padding: 0.1 }), []);
  assert.deepEqual(S.silentSpans([[0, 5]], [[0, 5]]), []);
});

test("cuts land on whole frames, inside the silence", () => {
  const [s] = S.silentSpans([[0, 1.01], [3.02, 4]], [[0, 4]], { minSilence: 0.5, padding: 0.1, fps: 30 });
  const frames = (t) => Math.abs(t * 30 - Math.round(t * 30)) < 0.01;   // times are kept to 4 decimals
  assert.ok(frames(s.from) && frames(s.to), JSON.stringify(s));
  assert.ok(s.from >= 1.11 - 1e-9 && s.to <= 2.92 + 1e-9, JSON.stringify(s));
});

test("a span that rounds to extract's minimum (0.05 s) is dropped, not sent to be refused", () => {
  assert.deepEqual(S.silentSpans([[0, 0.25], [0.4, 1]], [[0, 1]], { minSilence: 0.1, padding: 0.05, fps: 20 }), []);
});

test("only inside the clips: the gap between two clips is left alone", () => {
  const spans = S.silentSpans([[0, 2], [6, 8]], [[0, 3], [5, 8]], { minSilence: 0.5, padding: 0, fps: 10 });
  assert.deepEqual(spans, [{ from: 2, to: 3 }, { from: 5, to: 6 }]);
});

test("cutOps extract last first, with tracks and force passed on", () => {
  const ops = S.cutOps([{ from: 1, to: 2 }, { from: 5, to: 6 }], { tracks: ["V1", "A1"], force: true });
  assert.deepEqual(ops, [
    { op: "extract", from: 5, to: 6, tracks: ["V1", "A1"], force: true },
    { op: "extract", from: 1, to: 2, tracks: ["V1", "A1"], force: true },
  ]);
  assert.equal(S.total([{ from: 1, to: 2 }, { from: 5, to: 6.5 }]), 2.5);
});

test("the ops cut a linked shot and its stems in step, and close the gaps", () => {
  const shot = [
    { id: "v", mediaId: "m", kind: "video", track: "V1", start: 0, in: 0, duration: 10, props: { volume: 0 } },
    { id: "l", mediaId: "m", kind: "audio", track: "A1", start: 0, in: 0, duration: 10, props: { audioChannel: 0 } },
  ];
  const doc = {
    name: "t", width: 1280, height: 720, fps: 10, revision: 1,
    media: [{ id: "m", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 }], clips: shot,
  };
  const spans = S.silentSpans([[1, 3], [5, 6]], [[0, 10]], { minSilence: 0.5, padding: 0.2, fps: 10 });
  ProjectOps.applyPatch(doc, S.cutOps(spans));
  const end = doc.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  assert.ok(Math.abs(end - (10 - S.total(spans))) < 1e-6, `timeline ${end}`);
  const v = doc.clips.filter((c) => c.track === "V1").sort((a, b) => a.start - b.start);
  const a = doc.clips.filter((c) => c.track === "A1").sort((a, b) => a.start - b.start);
  assert.equal(v.length, 2, "speech 1–3 and 5–6 left as two pieces");
  assert.deepEqual(v.map((c) => [c.start, c.in, c.duration]), a.map((c) => [c.start, c.in, c.duration]), "stems stay in step");
  assert.ok(Math.abs(v[0].in - 0.8) < 1e-6 && Math.abs(v[1].in - 4.8) < 1e-6, JSON.stringify(v));
});
