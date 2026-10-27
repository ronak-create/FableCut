/* beats.js — the music's beat (analyze, grid) and cuts on it (snapOps, retimePlan). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../beats");

/** A kick-drum track: a 60 Hz thump decaying over ~0.1 s at `at + k·60/bpm`, mono at `sr`. */
function clicks({ bpm = 120, at = 0.3, secs = 20, sr = B.SR } = {}) {
  const x = new Float32Array(Math.round(secs * sr));
  for (let t = at; t < secs - 0.3; t += 60 / bpm) {
    const i0 = Math.round(t * sr);
    for (let j = 0; j < 0.25 * sr; j++) x[i0 + j] += Math.sin(2 * Math.PI * 60 * j / sr) * Math.exp(-j / (0.1 * sr)) * 0.9;
  }
  return x;
}

test("analyze + grid: a 120 BPM kick track gives 120 BPM and a grid on the clicks", () => {
  const a = B.analyze(clicks());
  assert.ok(Math.abs(a.bpm - 120) < 0.6, `bpm ${a.bpm}`);
  const g = B.grid(a.beats, a.bpm, 0, 20);
  assert.ok(g.length >= 38, `${g.length} beats`);
  for (const t of g) {
    const k = Math.round((t - 0.3) / 0.5);
    assert.ok(Math.abs(t - (0.3 + k * 0.5)) < 0.017, `grid beat ${t} is off the kicks by more than half a frame`);
  }
});

test("resample: a 48 kHz kick track analyzes like the 22.05 kHz one", () => {
  const a = B.analyze(B.resample(clicks({ bpm: 100, sr: 48000 }), 48000));
  assert.ok(Math.abs(a.bpm - 100) < 0.6, `bpm ${a.bpm}`);
  assert.equal(B.resample(new Float32Array(10), B.SR).length, 10, "the analysis rate passes through");
  assert.throws(() => B.resample(new Float32Array(4), 0), /sample rate/);
});

test("mono averages channels", () => {
  assert.deepEqual([...B.mono([Float32Array.from([1, 0]), Float32Array.from([0, 1])])], [0.5, 0.5]);
});

test("grid without a tempo, or with too few onsets, is the onsets themselves", () => {
  assert.deepEqual(B.grid([1, 2, 3], 120, 0, 10), [1, 2, 3]);
  assert.deepEqual(B.grid([1, 2, 3, 4, 5], null, 1.5, 4), [2, 3, 4]);
});

test("toTimeline maps source seconds through in, start and speed, inside the clip", () => {
  const c = { start: 10, in: 2, duration: 4, props: { speed: 2 } };
  assert.deepEqual(B.toTimeline([1, 2, 4, 9, 10, 11], c), [10, 11, 13.5, 14]);
});

test("every accepts 1, 2, 4, 8, 16 beats", () => {
  assert.equal(B.every(), 2);
  assert.equal(B.every(4), 4);
  assert.throws(() => B.every(3), /every must be one of/);
});

const clip = (id, track, start, duration, extra = {}) => ({ id, track, start, duration, in: 0, kind: "video", props: {}, ...extra });

test("snapOps rolls each cut to the nearest beat within half a beat, at whole frames", () => {
  const g = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  const clips = [clip("a", "V1", 0, 0.9), clip("b", "V1", 0.9, 1.25), clip("c", "V1", 2.15, 2), clip("t", "V2", 0, 3)];
  const ops = B.snapOps(clips, ["V1"], g, { fps: 30, bpm: 120 });
  assert.deepEqual(ops.map((o) => [o.id, o.side]), [["a", "out"], ["b", "out"]]);
  assert.ok(Math.abs(ops[0].delta - 0.1) < 1e-6 && Math.abs(ops[1].delta + 0.15) < 1e-6, JSON.stringify(ops));
  assert.deepEqual(B.snapOps(clips, ["V1"], g, { fps: 30, bpm: 120, maxShift: 0.12 }).map((o) => o.id), ["a"], "maxShift limits the move");
  assert.deepEqual(B.snapOps([clip("a", "V1", 0, 1), clip("b", "V1", 1, 1)], ["V1"], g, { fps: 30 }), [], "a cut already on the beat stays");
  assert.deepEqual(B.snapOps([clip("a", "V1", 0, 1), clip("b", "V1", 1.2, 1)], ["V1"], g, { fps: 30 }), [], "a gap is not a cut");
});

test("retimePlan lays a track's clips back to back, n beats each, from the first beat", () => {
  const g = [0.2, 0.7, 1.2, 1.7, 2.2, 2.7, 3.2];
  const clips = [clip("a", "V1", 0, 3), clip("b", "V1", 3, 3), clip("x", "V2", 0, 9)];
  const r = B.retimePlan(clips, "V1", g, { n: 2, fps: 1000 });
  assert.deepEqual(r.plan, [{ id: "a", start: 0.2, duration: 1, beats: 2 }, { id: "b", start: 1.2, duration: 1, beats: 2 }]);
  assert.deepEqual([r.short, r.skipped], [[], []]);
});

test("retimePlan gives a clip with little source fewer beats, and skips one too short for a beat", () => {
  const g = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  const clips = [clip("a", "V1", 0, 1), clip("b", "V1", 1, 1), clip("c", "V1", 2, 1)];
  const left = { a: 0.6, b: 0.2, c: 5 };
  const r = B.retimePlan(clips, "V1", g, { n: 2, fps: 1000, mediaDur: (c) => left[c.id] });
  assert.deepEqual(r.plan, [{ id: "a", start: 0, duration: 0.5, beats: 1 }, { id: "c", start: 0.5, duration: 1, beats: 2 }]);
  assert.deepEqual([r.short, r.skipped], [["a"], ["b"]]);
});

test("retimePlan: clips past the music follow on at their own length", () => {
  const g = [0, 1, 2];
  const r = B.retimePlan([clip("a", "V1", 0, 3), clip("b", "V1", 3, 3), clip("c", "V1", 6, 1.5)], "V1", g, { n: 2, fps: 30 });
  assert.deepEqual(r.plan, [{ id: "a", start: 0, duration: 2, beats: 2 }, { id: "b", start: 2, duration: 3 }, { id: "c", start: 5, duration: 1.5 }]);
});

test("retimePlan only takes the clips from `from` on", () => {
  const g = [0, 1, 2, 3, 4, 5];
  const r = B.retimePlan([clip("a", "V1", 0, 2.5), clip("b", "V1", 2.5, 3)], "V1", g, { n: 1, from: 2.5, fps: 30 });
  assert.deepEqual(r.plan, [{ id: "b", start: 3, duration: 1, beats: 1 }]);
});

test("snapOps plans the rolls one after another: two cuts can't both take a short clip's time", () => {
  const g = [0, 0.5, 1, 1.5, 2];
  // b runs 0.4 → 0.55; both cuts' nearest beat is 0.5, so together they would squeeze b to nothing
  const clips = [clip("a", "V1", 0, 0.4, { in: 5 }), clip("b", "V1", 0.4, 0.15, { in: 5 }), clip("c", "V1", 0.55, 2, { in: 5 })];
  const blocked = { n: 0 };
  const ops = B.snapOps(clips, ["V1"], g, { fps: 30, bpm: 120, blocked });
  assert.deepEqual(ops.map((o) => o.id), ["a"], "the first cut moves; the second would leave b shorter than allowed");
  assert.equal(blocked.n, 1);
});

test("fitTimed drops keyframes past a shorter end and clamps transitions", () => {
  const c = { duration: 4, keyframes: { opacity: [{ t: 0, v: 0 }, { t: 3, v: 1 }], scale: [{ t: 3.5, v: 2 }] }, transitionOut: { type: "fade", duration: 1.5 } };
  assert.deepEqual(B.fitTimed(c, 1), { keyframes: { opacity: [{ t: 0, v: 0 }] }, transitionOut: { type: "fade", duration: 1 } });
  assert.deepEqual(B.fitTimed({ duration: 4, keyframes: { x: [{ t: 3, v: 1 }] } }, 1), { keyframes: null }, "no keys left: removed");
  assert.deepEqual(B.fitTimed(c, 5), {}, "longer: nothing to change");
});

const doc = (clips, extra = {}) => ({ fps: 30, clips, media: [{ id: "m1", duration: 60 }], tracks: [{ id: "V1", kind: "video" }, { id: "A1", kind: "audio" }], ...extra });
const kicks = { beats: Array.from({ length: 20 }, (_, k) => 0.25 + k * 0.5), bpm: 120, drop: null };

test("plan: markers keep every marker the user had, and add none where one already sits", () => {
  const music = { id: "m", kind: "audio", mediaId: "m1", track: "A1", start: 0, in: 0, duration: 10, props: {} };
  const r = B.plan(doc([music], { markers: [{ t: 2.25, label: "drop", color: "red" }] }), music, kicks, { markers: true });
  const list = r.ops[0].set.markers;
  assert.ok(list.some((m) => m.label === "drop" && m.t === 2.25), "the labeled marker stays");
  assert.equal(list.filter((m) => Math.abs(m.t - 2.25) < 0.01).length, 1, "no cyan marker on top of it");
});

test("plan: retime never moves the music clip, even on the track it re-cuts", () => {
  const music = { id: "mv", kind: "video", mediaId: "m1", track: "V1", start: 0, in: 0, duration: 10, props: {} };
  const shots = [clip("s1", "V1", 10, 2), clip("s2", "V1", 12, 2)];
  const r = B.plan(doc([music, ...shots]), music, kicks, { retime: { from: 0, every: 2 } });
  assert.ok(!r.ops.some((o) => o.id === "mv"), JSON.stringify(r.ops));
  assert.deepEqual(r.ops.map((o) => o.id), ["s1", "s2"]);
});

test("plan: a re-cut shot carries its trimmed keyframes and transitions in the op", () => {
  const music = { id: "m", kind: "audio", mediaId: "m1", track: "A1", start: 0, in: 0, duration: 10, props: {} };
  const shot = clip("s", "V1", 0, 3, { keyframes: { opacity: [{ t: 0, v: 0 }, { t: 2.5, v: 1 }] }, transitionIn: { type: "fade", duration: 2 } });
  const r = B.plan(doc([music, shot]), music, kicks, { retime: { every: 2 } });
  assert.deepEqual(r.ops[0].set.keyframes, { opacity: [{ t: 0, v: 0 }] });
  assert.equal(r.ops[0].set.transitionIn.duration, 1);
});

test("plan: snap counts a linked stem's footage — a stem on a shorter file keeps the cut where it is", () => {
  const music = { id: "m", kind: "audio", mediaId: "m1", track: "A1", start: 0, in: 0, duration: 10, props: {} };
  // the cut at 1.4 wants 1.25: the clip after it must show 0.15 s more of its head
  const a = clip("a", "V1", 0, 1.4, { in: 5, mediaId: "mv" });
  const b = clip("b", "V1", 1.4, 3, { in: 5, mediaId: "mv", linkGroup: "g" });
  const stem = { id: "bs", kind: "audio", mediaId: "ma", track: "A2", start: 1.4, in: 0.05, duration: 3, linkGroup: "g", props: {} };
  const d = doc([music, a, b, stem], { media: [{ id: "m1", duration: 60 }, { id: "mv", duration: 60 }, { id: "ma", duration: 60 }] });
  const r = B.plan(d, music, kicks, { snap: { tracks: ["V1"] } });
  assert.equal(r.ops.length, 0, JSON.stringify(r.ops));
  assert.match(r.done[0], /1 without spare footage/);
  stem.in = 1;
  assert.equal(B.plan(d, music, kicks, { snap: { tracks: ["V1"] } }).ops.length, 1, "with room on the stem it rolls");
});

test("plan: the tempo on the timeline follows the music clip's speed", () => {
  const music = { id: "m", kind: "audio", mediaId: "m1", track: "A1", start: 0, in: 0, duration: 10, props: { speed: 0.5 } };
  assert.equal(B.plan(doc([music]), music, kicks, {}).bpm, 60, "120 BPM played at half speed is 60 BPM on the timeline");
});

test("plan: marking twice adds nothing and says so plainly", () => {
  const music = { id: "m", kind: "audio", mediaId: "m1", track: "A1", start: 0, in: 0, duration: 10, props: {} };
  const d = doc([music]);
  d.markers = B.plan(d, music, kicks, { markers: true }).ops[0].set.markers;
  const again = B.plan(d, music, kicks, { markers: true });
  assert.match(again.done[0], /^marked 0 beats \(cyan markers\) \(\d+ already had a marker\)$/);
});

test("plan: re-cut gives a shot no more beats than its linked stem's footage allows", () => {
  const music = { id: "m", kind: "audio", mediaId: "m1", track: "A1", start: 0, in: 0, duration: 10, props: {} };
  const shot = clip("s", "V1", 0, 3, { mediaId: "mv", in: 0, linkGroup: "g" });
  const stem = { id: "ss", kind: "audio", mediaId: "ma", track: "A2", start: 0, in: 0, duration: 3, linkGroup: "g", props: {} };
  const d = doc([music, shot, stem], { media: [{ id: "m1", duration: 60 }, { id: "mv", duration: 60 }, { id: "ma", duration: 0.6 }] });
  const r = B.plan(d, music, kicks, { retime: { every: 4 } });
  assert.equal(r.ops.find((o) => o.id === "s").set.duration, 0.5, "the stem has 0.6 s: one beat");
  assert.equal(r.ops.find((o) => o.id === "ss").set.duration, 0.5);
});

test("snapOps leaves a hairline gap alone: only clips that really meet make a cut a roll can move", () => {
  const g = [0, 0.5, 1, 1.5];
  const clips = [clip("a", "V1", 0, 0.52), clip("b", "V1", 0.525, 1)];
  assert.deepEqual(B.snapOps(clips, ["V1"], g, { fps: 30, bpm: 120 }), []);
});
