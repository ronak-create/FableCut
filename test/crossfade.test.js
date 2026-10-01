/* Shift+D crossfades, run against the stubbed timeline. A crossfade is the
   same-track overlap idiom: the overlap is borrowed from spare media on both
   sides of the cut, audio fades with constant-power curves, and picture
   linked to the incoming clip dissolves in over the outgoing one. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { world, clip } = require("./timeline-sandbox");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: expected ${b}, got ${a}`);
const fade = (d) => ({ type: "fade", duration: d, curve: "power" });

/* Two music clips butted on A3: a [0,4) in 2 · b [4,8) in 10 (media 60 s). */
function cut(extra = {}) {
  return world({
    clips: [clip("a", "A3", 0, 4, { in: 2 }), clip("b", "A3", 4, 4, { in: 10 })],
    trackIds: ["V1", "A1", "A2", "A3"], ...extra,
  });
}

test("a butt cut borrows half the crossfade from each side and fades both", () => {
  const w = cut();
  assert.equal(w.crossfadeCut(w.byId("a"), w.byId("b"), 1), null);
  near(w.byId("a").duration, 4.5, "a runs on 0.5 s past the cut");
  near(w.byId("b").start, 3.5, "b starts 0.5 s early");
  near(w.byId("b").in, 9.5, "…from 0.5 s earlier in its source");
  near(w.byId("b").duration, 4.5, "and lasts 0.5 s longer");
  assert.deepEqual(w.byId("a").transitionOut, fade(1));
  assert.deepEqual(w.byId("b").transitionIn, fade(1));
});

test("short handles shift the overlap to the side that has media", () => {
  const w = world({
    clips: [clip("a", "A3", 0, 4, { in: 2 }), clip("b", "A3", 4, 4, { in: 0.2 })],
    trackIds: ["A3"],
  });
  assert.equal(w.crossfadeCut(w.byId("a"), w.byId("b"), 1), null);
  near(w.byId("b").start, 3.8, "b only had 0.2 s of head");
  near(w.byId("a").duration, 4.8, "a gives the other 0.8 s");
  near(w.byId("a").transitionOut.duration, 1, "full-length crossfade");
});

test("no spare media on either side refuses", () => {
  const w = world({
    media: [{ id: "m1", kind: "audio", duration: 6 }],
    clips: [clip("a", "A3", 0, 6, { in: 0 }), clip("b", "A3", 6, 6, { in: 0 })],
    trackIds: ["A3"],
  });
  assert.match(w.crossfadeCut(w.byId("a"), w.byId("b"), 1), /no spare media/);
  near(w.byId("a").duration, 6, "nothing moved");
  assert.equal(w.byId("a").transitionOut, undefined);
});

test("clips that already overlap just get fades across the overlap", () => {
  const w = world({
    clips: [clip("a", "A3", 0, 4.6, { in: 2 }), clip("b", "A3", 4, 4, { in: 10 })],
    trackIds: ["A3"],
  });
  assert.equal(w.crossfadeCut(w.byId("a"), w.byId("b"), 1), null);
  near(w.byId("b").start, 4, "positions are kept");
  near(w.byId("a").transitionOut.duration, 0.6, "fade = the overlap");
});

test("a linked shot cut: both stems crossfade, the incoming picture dissolves", () => {
  const shot = (tag, start, inn) => [
    clip(tag, "V1", start, 3, { in: inn, linkGroup: "g" + tag }),
    clip(tag + "L", "A1", start, 3, { in: inn, linkGroup: "g" + tag, props: { audioChannel: 0 } }),
    clip(tag + "R", "A2", start, 3, { in: inn, linkGroup: "g" + tag, props: { audioChannel: 1 } }),
  ];
  const w = world({ clips: [...shot("A", 0, 5), ...shot("B", 3, 20)], trackIds: ["V1", "A1", "A2"] });
  w.state.selIds = new Set(["AL"]);
  w.crossfadeSelected(1);
  for (const id of ["A", "AL", "AR"]) near(w.byId(id).duration, 3.5, `${id} extended`);
  for (const id of ["B", "BL", "BR"]) near(w.byId(id).start, 2.5, `${id} starts early`);
  for (const id of ["AL", "AR"]) assert.deepEqual(w.byId(id).transitionOut, fade(1));
  for (const id of ["BL", "BR"]) assert.deepEqual(w.byId(id).transitionIn, fade(1));
  assert.deepEqual(w.byId("B").transitionIn, { type: "fade", duration: 1 }, "picture dissolves in");
  assert.equal(w.byId("A").transitionOut, undefined, "the outgoing picture stays opaque under it");
  assert.equal(w.calls.undo, 1, "one undo step");
  assert.match(w.calls.toast.at(-1), /Crossfaded 1 cut/, "a stereo pair is one cut");
});

test("locked clips are left alone", () => {
  const w = cut();
  w.byId("b").locked = true;
  assert.equal(w.crossfadeCut(w.byId("a"), w.byId("b"), 1), "locked");
  near(w.byId("a").duration, 4, "untouched");
});

test("with nothing selected, Shift+D takes the cut nearest the playhead on targeted tracks", () => {
  const w = cut({ time: 4.2 });
  assert.equal(w.crossfadeCuts([w.byId("a")]).length, 1, "a's next neighbour is b");
  w.crossfadeSelected(1);
  near(w.byId("b").start, 3.5, "the cut under the playhead was crossfaded");
  const far = cut({ time: 1 });
  far.crossfadeSelected(1);
  near(far.byId("b").start, 4, "no cut within half a second — nothing happens");
  assert.match(far.calls.toast.at(-1), /No audio cut near the playhead/);
});
