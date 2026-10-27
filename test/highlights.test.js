"use strict";
const test = require("node:test");
const assert = require("node:assert");
const H = require("../highlights.js");

const W = 64, Hh = 36;
// a frame: flat grey of `level`, with a bright square at (x, 10) when x is given, plus a texture so it isn't blank
function frame(level, x = null) {
  const f = new Uint8Array(W * Hh * 3);
  for (let r = 0; r < Hh; r++) for (let c = 0; c < W; c++) {
    let v = level + ((r * 7 + c * 13) % 9) * 4;
    if (x != null && c >= x && c < x + 10 && r >= 10 && r < 20) v = 240;
    const i = (r * W + c) * 3;
    f[i] = f[i + 1] = f[i + 2] = Math.min(255, v);
  }
  return f;
}
// 60 s of footage at PIC_FPS: still until 20 s, a square racing back and forth 20–25 s, still again, a cut to a
// darker scene at 30 s; sound quiet except a loud burst 40–42 s
function source(id) {
  const pic = H.picture(W, Hh);
  const n = 60 * H.PIC_FPS;
  for (let i = 0; i < n; i++) {
    const t = i / H.PIC_FPS;
    const level = t < 30 ? 90 : 50;
    pic.push(frame(level, t >= 20 && t < 25 ? (i * 17) % (W - 10) : null));
  }
  const rate = 8000, aud = H.sound(rate);
  const x = new Float32Array(60 * rate);
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    x[i] = (t >= 40 && t < 42 ? 0.6 : 0.01) * Math.sin(2 * Math.PI * 220 * t);
  }
  aud.push(x);
  return { id, len: 60, pic, aud };
}

test("picture and sound meters measure what they see and hear", () => {
  const s = source("c1");
  assert.equal(s.pic.motion.length, 120);
  const at = (t) => s.pic.motion[Math.round(t * H.PIC_FPS)];
  assert.ok(at(22) > 10 * Math.max(0.5, at(10)), `movement at 22 s (${at(22)}) far above 10 s (${at(10)})`);
  assert.equal(s.aud.db.length, 600);
  assert.ok(s.aud.db[410] > s.aud.db[100] + 25, "the burst is loud");
});

test("shots: the cut in the footage is found, the movement isn't one", () => {
  const s = source("c1");
  const cuts = H.shots(s.pic.motion);
  assert.ok(cuts.some((t) => Math.abs(t - 30) < 0.6), `a cut near 30 s: ${cuts}`);
  assert.ok(!cuts.some((t) => t > 20.5 && t < 25), `no cuts inside the movement: ${cuts}`);
});

test("pick: the busy and the loud moments, in order, never across the cut, exactly the length", () => {
  const s = source("c1");
  const picks = H.pick([s], { duration: 6, shot: 2 });
  assert.ok(picks.length >= 3, JSON.stringify(picks));
  const total = picks.reduce((n, p) => n + (p.to - p.from), 0);
  assert.ok(Math.abs(total - 6) < 0.02, `total ${total}`);
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i].from >= picks[i - 1].to, "in story order, apart");
  assert.ok(picks.some((p) => p.from >= 19.5 && p.to <= 25.5), `a moment from the movement: ${JSON.stringify(picks)}`);
  assert.ok(picks.some((p) => p.from >= 39.5 && p.to <= 42.6), `the loud moment: ${JSON.stringify(picks)}`);
  assert.ok(picks.every((p) => !(p.from < 30 && p.to > 30.01)), "none across the cut");
  assert.match(H.describe(picks, { duration: 6 }), /moments, 6\.0 s/);
});

test("pick: a clip at 2× counts by its length on the timeline", () => {
  const s = { ...source("c1"), speed: 2 };
  const picks = H.pick([s], { duration: 6, shot: 2 });
  const edit = picks.reduce((n, p) => n + p.len, 0), footage = picks.reduce((n, p) => n + (p.to - p.from), 0);
  assert.ok(Math.abs(edit - 6) < 0.02, `edit ${edit}`);
  assert.ok(Math.abs(footage - 12) < 0.05, `footage ${footage}`);
  assert.ok(picks.every((p) => Math.abs(p.len - (p.to - p.from) / 2) < 0.002));
  const out = H.ops({ clips: [{ id: "c1", mediaId: "m", kind: "video", track: "V1", start: 0, in: 0, duration: 30, props: { speed: 2 } }] }, picks, { name: "x" });
  assert.ok(Math.abs(out.slice(1).reduce((n, o) => n + o.clip.duration, 0) - 6) < 0.02, "the clips add up to the edit");
});

test("options: limits and the default shot length", () => {
  assert.deepEqual(H.options({}), { duration: 30, shot: 3.75 });
  assert.deepEqual(H.options({ duration: 15 }), { duration: 15, shot: 1.875 });
  assert.equal(H.options({ duration: 60 }).shot, 4);
  assert.throws(() => H.options({ duration: 2 }), /duration must be/);
  assert.throws(() => H.options({ shot: 50 }), /shot must be/);
});

test("ops: a new sequence, the moments back to back with their linked sound", () => {
  const doc = {
    media: [{ id: "m_v", kind: "video", duration: 120 }],
    clips: [
      { id: "v", mediaId: "m_v", kind: "video", track: "V1", start: 10, in: 5, duration: 60, linkGroup: "g", props: { volume: 0, reframe: "follow" } },
      { id: "a", mediaId: "m_v", kind: "audio", track: "A1", start: 10, in: 5, duration: 60, linkGroup: "g", props: { pan: -1 } },
      { id: "t", kind: "text", track: "V2", start: 0, duration: 4, props: {} },
    ],
  };
  const picks = [{ source: "v", from: 20, to: 22 }, { source: "v", from: 40, to: 41.5 }, { source: "media:m_v", from: 100, to: 101 }];
  const out = H.ops(doc, picks, { name: "Highlights", width: 1080, height: 1920 });
  assert.deepEqual(out[0], { op: "addSequence", from: "empty", name: "Highlights", width: 1080, height: 1920, open: true });
  const clips = out.slice(1).map((o) => o.clip);
  assert.deepEqual(clips.map((c) => [c.id, c.track, c.start, c.in, c.duration]), [
    ["hl1", "V1", 0, 25, 2], ["hl1a1", "A1", 0, 25, 2],
    ["hl2", "V1", 2, 45, 1.5], ["hl2a1", "A1", 2, 45, 1.5],
    ["hl3", "V1", 3.5, 100, 1],
  ]);
  assert.equal(clips[0].linkGroup, clips[1].linkGroup);
  assert.equal(clips[0].props.reframe, undefined, "the new canvas is framed anew");
  assert.equal(clips[1].props.pan, -1);
  // a second run: ids no sequence has yet
  const again = H.ops({ ...doc, sequences: [{ id: "s1", clips: clips }] }, picks.slice(0, 1), { name: "Again" });
  assert.deepEqual(again.slice(1).map((o) => o.clip.id), ["hl1_2", "hl1_2a1"]);
});

test("sourcesOf: video clips only, not disabled or ramped", () => {
  const doc = { disabledTracks: ["V3"], clips: [
    { id: "a", kind: "video", track: "V1" }, { id: "b", kind: "video", track: "V3" },
    { id: "c", kind: "video", track: "V1", keyframes: { speed: [{ t: 0, v: 1 }] } },
    { id: "d", kind: "audio", track: "A1" }, { id: "e", kind: "video", track: "V2", disabled: true },
  ] };
  const r = H.sourcesOf(doc);
  assert.deepEqual(r.take.map((c) => c.id), ["a"]);
  assert.deepEqual(Object.fromEntries(r.skip.map((x) => [x.id, x.why])), { b: "disabled", c: "a speed ramp", e: "disabled" });
  assert.deepEqual(H.sourcesOf(doc, ["d"]).skip, [{ id: "d", why: "an audio clip" }]);
});
