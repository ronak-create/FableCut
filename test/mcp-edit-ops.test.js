/* Timeline edit ops on fablecut_patch_project — split, ripple delete, close
   gap, lift / extract, insert / overwrite, trims and crossfade. They run the
   editor's own edit-ops.js, so these check the agent-facing contract: linked
   stems ride along, targeting and locks are honored, refusals abort the
   whole patch unsaved, and the note says what was actually applied. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeDataDir, readProject, seedProject, startMcp } = require("./helpers");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: expected ${b}, got ${a}`);

/* Two shots back to back on V1, each with a linked L/R stem pair on A1/A2:
   A [0,4) in 0 · B [4,8) in 20. Media is 60 s with spare handles. */
function reel(over = {}) {
  const shot = (tag, start, inn) => [
    { id: tag, mediaId: "m_a", kind: "video", track: "V1", start, in: inn, duration: 4, props: { volume: 0 } },
    { id: tag + "l", mediaId: "m_a", kind: "audio", track: "A1", start, in: inn, duration: 4, props: { audioChannel: 0, pan: -1 } },
    { id: tag + "r", mediaId: "m_a", kind: "audio", track: "A2", start, in: inn, duration: 4, props: { audioChannel: 1, pan: 1 } },
  ];
  return seedProject({
    media: [
      { id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 60 },
      { id: "m_t", name: "tone.wav", kind: "audio", src: "/media/tone.wav", duration: 30 },
    ],
    clips: [...shot("A", 0, 0), ...shot("B", 4, 20)],
    ...over,
  });
}
const boot = async (t, project = reel()) => {
  const dir = makeDataDir(t, project);
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  return { dir, mcp, patch, doc: () => readProject(dir), clip: (id) => readProject(dir).clips.find((c) => c.id === id) };
};

test("split cuts the targeted tracks and keeps each half linked to its stems", async (t) => {
  const { patch, doc } = await boot(t);
  const r = await patch({ op: "split", at: 2 });
  assert.equal(r.isError, false, r.text);
  const d = doc();
  assert.equal(d.clips.length, 9, "A and both stems split in two");
  const rights = d.clips.filter((c) => c.start === 2);
  assert.equal(rights.length, 3);
  assert.equal(new Set(rights.map((c) => c.linkGroup)).size, 1, "right halves share one new link group");
  for (const c of rights) near(c.in, 2, `${c.id} right half starts 2 s into the source`);
  assert.match(r.text, /split@2/);
});

test("split skips untargeted tracks unless the op names its own", async (t) => {
  const { patch, doc } = await boot(t, reel({ untargetedTracks: ["V1", "A1", "A2"] }));
  const none = await patch({ op: "split", at: 2 });
  assert.equal(none.isError, true, "nothing targeted → refused");
  assert.equal(doc().revision, 1, "a refused op saves nothing");
  const r = await patch({ op: "split", at: 2, tracks: ["A1"] });
  assert.equal(r.isError, false, r.text);
  assert.equal(doc().clips.length, 9, "sync lock: the A1 stem's partners split too");
});

test("rippleDelete removes the shot with its stems and pulls the next one left", async (t) => {
  const { patch, doc, clip } = await boot(t);
  const r = await patch({ op: "rippleDelete", ids: ["A"] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(doc().clips.map((c) => c.id).sort(), ["B", "Bl", "Br"]);
  for (const id of ["B", "Bl", "Br"]) near(clip(id).start, 0, `${id} closed up`);
});

test("rippleDelete refuses a locked clip unless forced", async (t) => {
  const { patch, doc } = await boot(t, reel({ lockedTracks: ["A2"] }));
  const r = await patch({ op: "rippleDelete", ids: ["A"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /locked/);
  assert.equal(doc().clips.length, 6);
  const forced = await patch({ op: "rippleDelete", ids: ["A"], force: true });
  assert.equal(forced.isError, false, forced.text);
  assert.equal(doc().clips.length, 3);
});

test("closeGap closes the gap under a time on every targeted track", async (t) => {
  const p = reel();
  for (const c of p.clips) if (c.id[0] === "B") c.start = 6; // 2 s hole at [4, 6)
  const { patch, clip } = await boot(t, p);
  const r = await patch({ op: "closeGap", at: 5 });
  assert.equal(r.isError, false, r.text);
  for (const id of ["B", "Bl", "Br"]) near(clip(id).start, 4, `${id} pulled into the gap`);
  assert.match(r.text, /closed 2s gap/);
});

test("extract removes a range and closes it; lift leaves the hole", async (t) => {
  const { patch, clip, doc } = await boot(t);
  const r = await patch({ op: "extract", from: 3, to: 5 });
  assert.equal(r.isError, false, r.text);
  near(clip("A").duration, 3, "A loses its last second");
  const bTail = doc().clips.find((c) => c.track === "V1" && c.id !== "A");
  near(bTail.start, 3, "B's remainder closes up to the cut");
  near(bTail.in, 21, "and starts one second into B");

  const { patch: patch2, clip: clip2, doc: doc2 } = await boot(t);
  await patch2({ op: "setProject", set: { inPoint: 3, outPoint: 5 } });
  const l = await patch2({ op: "lift" });
  assert.equal(l.isError, false, l.text);
  near(clip2("A").duration, 3, "lift trims A too");
  assert.ok(doc2().clips.some((c) => c.track === "V1" && c.start === 5), "B's remainder stays at 5 s");
  assert.equal(doc2().inPoint, undefined, "lifting from IN/OUT clears them, as in the editor");
});

test("insert puts media at a time and pushes later clips right; overwrite does not", async (t) => {
  const { patch, doc, clip } = await boot(t);
  const r = await patch({ op: "insert", mediaId: "m_t", at: 4, in: 1, duration: 2, tracks: ["A1", "V1", "A2"] });
  assert.equal(r.isError, false, r.text);
  const placed = doc().clips.find((c) => c.mediaId === "m_t");
  assert.equal(placed.track, "A1");
  near(placed.start, 4, "lands at 4 s");
  near(placed.in, 1, "from 1 s into the source");
  for (const id of ["B", "Bl", "Br"]) near(clip(id).start, 6, `${id} pushed right by 2 s`);

  const o = await patch({ op: "overwrite", mediaId: "m_t", at: 0, duration: 1 });
  assert.equal(o.isError, false, o.text);
  near(clip("Al").start, 1, "the stem under it is punched, not moved");
  near(clip("A").start, 1, "sync lock: its linked picture is punched with it");
});

test("insert checks the source window against the media length", async (t) => {
  const { patch, doc } = await boot(t);
  const r = await patch({ op: "insert", mediaId: "m_t", at: 0, in: 29, duration: 5 });
  assert.equal(r.isError, true);
  assert.match(r.text, /runs past the end/);
  assert.equal(doc().revision, 1);
});

test("trims report the clamped delta and move linked stems together", async (t) => {
  const { patch, clip } = await boot(t);
  const ripple = await patch({ op: "rippleTrim", id: "A", side: "out", delta: -1 });
  assert.equal(ripple.isError, false, ripple.text);
  near(clip("Ar").duration, 3, "stem trimmed with its picture");
  near(clip("B").start, 3, "B pulled left");

  const slip = await patch({ op: "slip", id: "A", delta: 5 });
  assert.equal(slip.isError, false, slip.text);
  assert.match(slip.text, /clamped/, "A starts at source 0 — nothing earlier to show");
  near(clip("Al").in, 0, "still at the head of the source");

  const roll = await patch({ op: "roll", id: "B", side: "in", delta: 0.5 });
  assert.equal(roll.isError, false, roll.text);
  near(clip("A").duration, 3.5, "A gains what B gives up");
  near(clip("B").start, 3.5, "the cut moved");
});

test("crossfade overlaps the stems at a cut with constant-power fades", async (t) => {
  const { patch, clip } = await boot(t);
  const r = await patch({ op: "crossfade", at: 4, duration: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /crossfaded 1 cut/, "a stereo pair counts as one cut");
  assert.equal(clip("Al").transitionOut.curve, "power");
  assert.equal(clip("Bl").transitionIn.curve, "power");
  near(clip("Bl").start, 3.5, "B borrows half a second of its head");
  assert.equal(clip("B").transitionIn.type, "fade", "the picture dissolves in");
});

test("setProject takes inPoint / outPoint and rejects a reversed range", async (t) => {
  const { patch, doc, mcp } = await boot(t);
  assert.equal((await patch({ op: "setProject", set: { inPoint: 1, outPoint: 3 } })).isError, false);
  assert.equal(doc().inPoint, 1);
  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(text, /in\/out:1→3/);
  const bad = await patch({ op: "setProject", set: { inPoint: 5 } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /outPoint must be after inPoint/);
});
