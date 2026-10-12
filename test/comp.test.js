/* Compositions: the shared logic in comp.js (validation, flattening a comp
   clip's contents onto the timeline, precompose, loops) and the agent's
   addComp / updateComp / removeComp / precompose / inComp ops. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../comp.js");
const M = require("../motion.js");
const { makeDataDir, readProject, startMcp } = require("./helpers");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const docWithComp = () => ({
  width: 1280, height: 720,
  clips: [{ id: "k", kind: "comp", compId: "intro", track: "V1", start: 10, in: 1, duration: 3 }],
  comps: [{ id: "intro", name: "Intro", width: 1280, height: 720, duration: 5, clips: [
    { id: "v", kind: "video", mediaId: "m", track: "V1", start: 0, in: 2, duration: 5 },
    { id: "t", kind: "text", track: "V2", start: 0.5, duration: 2, keyframes: { x: [{ t: 0, v: 0 }, { t: 2, v: 100, ease: "linear" }] } },
    { id: "late", kind: "text", track: "V2", start: 4.5, duration: 0.5 },
    { id: "a", kind: "audio", mediaId: "m", track: "A1", start: 0, in: 0, duration: 5, disabled: true },
  ] }],
});

test("flatten: a comp clip's contents land at timeline times, trimmed to its window", () => {
  const v = C.flatten(docWithComp());
  const by = Object.fromEntries(v.map((x) => [x._src, x]));
  // the comp clip starts 1 s into the comp, at timeline 10, for 3 s → comp time 1…4
  assert.equal(by.v.id, "k>v");
  near(by.v.start, 10); near(by.v.duration, 3); near(by.v.in, 3);   // 1 s into the clip's media at in 2
  near(by.t.start, 10); near(by.t.duration, 1.5);                      // comp 1…2.5 of the title
  near(M.channelAt(by.t, "x", 0, 0), 25);                             // its animation carries on: 0.5 s into a 2 s 0→100 slide
  assert.equal(by.late, undefined, "outside the clip's window: gone");
  assert.equal(by.a._on, false, "a disabled clip in the comp stays silent");
  assert.ok(v.every((x) => x._comp === "k"));
});

test("flatten: nested comps, loops cut off, parents and links renamed per instance", () => {
  const doc = docWithComp();
  doc.comps.push({ id: "outer", name: "Outer", width: 640, height: 360, duration: 6, clips: [
    { id: "inner", kind: "comp", compId: "intro", track: "V1", start: 1, in: 0, duration: 5 },
    { id: "n", kind: "null", track: "V2", start: 0, duration: 6 },
    { id: "s", kind: "shape", track: "V3", start: 0, duration: 6, parent: "n" },
  ] });
  doc.clips = [{ id: "o", kind: "comp", compId: "outer", track: "V1", start: 0, in: 0, duration: 6 }];
  const ids = C.flatten(doc).map((x) => x.id);
  assert.ok(ids.includes("o>inner>v"), "two levels deep");
  assert.equal(C.flatten(doc).find((x) => x.id === "o>s").parent, "o>n");
  assert.equal(C.wouldCycle(doc, "intro", "outer"), true, "intro can't contain outer, which contains intro");
  doc.comps[0].clips.push({ id: "loop", kind: "comp", compId: "outer", track: "V3", start: 0, duration: 5 });
  assert.ok(C.flatten(doc).length < 200, "a loop written by hand is cut off, not followed forever");
});

test("precompose moves clips into a new comp and leaves a comp clip in their place", () => {
  const doc = { width: 1280, height: 720, tracks: [{ id: "V2", kind: "video" }, { id: "V1", kind: "video" }, { id: "A1", kind: "audio" }], comps: [],
    clips: [
      { id: "a", kind: "video", track: "V1", start: 2, duration: 3 },
      { id: "b", kind: "text", track: "V2", start: 3, duration: 4, parent: "z" },
      { id: "z", kind: "null", track: "V2", start: 0, duration: 1 },
      { id: "c", kind: "text", track: "V2", start: 9, duration: 1, parent: "a" },
    ] };
  const { comp, clip } = C.precompose(doc, ["a", "b"], { id: "pc", name: "Pre" });
  assert.deepEqual(comp.clips.map((x) => [x.id, x.start]), [["a", 0], ["b", 1]]);
  assert.equal(comp.duration, 5);
  assert.deepEqual(comp.tracks.map((t) => t.id), ["V2", "V1"]);
  assert.equal(comp.clips[1].parent, undefined, "its parent stayed outside");
  assert.equal(doc.clips.find((x) => x.id === "c").parent, undefined, "a clip parented to a moved one lets go");
  assert.deepEqual([clip.start, clip.duration, clip.track, clip.compId, clip.props.fit], [2, 5, "V1", "pc", "none"]);
  assert.deepEqual(doc.clips.map((x) => x.id).sort(), ["c", clip.id, "z"].sort());
  assert.equal(comp.disabledTracks, undefined, "no hidden tracks, no list");
  const hid = { width: 1280, height: 720, comps: [], disabledTracks: ["V2", "V3"], clips: [
    { id: "a", kind: "video", track: "V1", start: 0, duration: 2 }, { id: "b", kind: "text", track: "V2", start: 0, duration: 2 }] };
  assert.deepEqual(C.precompose(hid, ["a", "b"], { id: "h" }).comp.disabledTracks, ["V2"], "a hidden track stays hidden inside the comp");
});

test("trims treat a comp clip's in as a window into its comp", () => {
  const E = require("../edit-ops.js");
  const mk = () => ({ media: [], tracks: [{ id: "V1", kind: "video" }], comps: [{ id: "q", name: "Q", width: 640, height: 360, duration: 6, clips: [] }],
    clips: [{ id: "k", kind: "comp", compId: "q", track: "V1", start: 2, in: 1, duration: 3, props: { speed: 3 } }] });
  let doc = mk(), ed = E.forDoc(doc), k = doc.clips[0];
  assert.equal(E.clipSpeed(k), 1, "comps run at 1×");
  ed.rippleTrim(k, "in", 0.5);
  near(k.in, 1.5); near(k.duration, 2.5);
  ed.rippleTrim(k, "in", -5);                       // the head can go back only to comp time 0
  near(k.in, 0); near(k.duration, 4);
  ed.rippleTrim(k, "out", 10);                      // the tail stops at the comp's end
  near(k.in + k.duration, 6);
  doc = mk(); ed = E.forDoc(doc); k = doc.clips[0];
  ed.slipClip(k, -9);                               // later comp time, clamped to the comp's length
  near(k.in, 3); near(k.duration, 3); near(k.start, 2);
  doc = mk(); ed = E.forDoc(doc); k = doc.clips[0];
  ed.liftRange(2, 2.75, false);                     // lifting the head keeps the comp aligned
  near(k.start, 2.75); near(k.in, 1.75);
  doc = mk(); ed = E.forDoc(doc); k = doc.clips[0];
  k.keyframes = { speed: [{ t: 0, v: 4 }, { t: 3, v: 4 }] };   // speed keys on a comp clip are ignored
  near(E.mediaTimeAt(k, 3), 2);
  ed.splitClipAt(k, 3);
  near(doc.clips.find((x) => x.id !== "k").in, 2);                // the right half carries on at comp time 2
});

test("normalizeComp: defaults and strict refusals", () => {
  const n = C.normalizeComp({ id: "x", duration: 3 }, true, { width: 1920, height: 1080 });
  assert.deepEqual([n.name, n.width, n.height, n.clips.length], ["x", 1920, 1080, 0]);
  assert.throws(() => C.normalizeComp({ id: "x" }, true), /duration/);
  assert.throws(() => C.normalizeComp({ id: "x", duration: 2, width: 5 }, true), /width/);
  assert.throws(() => C.normalizeComp({ id: "x", duration: 2, clips: [{ id: "q" }] }, true), /needs id, numeric start and duration/);
});

const project = () => ({
  name: "Comps", width: 1280, height: 720, fps: 30, revision: 1,
  media: [{ id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 }],
  clips: [
    { id: "c_v", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 4 },
    { id: "c_t", kind: "text", track: "V2", start: 1, duration: 2, props: { text: "Hi" } },
    { id: "c_l", kind: "text", track: "V3", start: 0, duration: 1, locked: true, props: { text: "locked" } },
  ],
});

test("agent: addComp, inComp, precompose, updateComp, removeComp and the compact view", async (t) => {
  const dir = makeDataDir(t, project());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const doc = () => readProject(dir);
  const comp = (id) => doc().comps.find((c) => c.id === id);

  let r = await patch(
    { op: "addComp", comp: { id: "badge", name: "Badge", width: 400, height: 400, duration: 3,
      clips: [{ id: "ring", kind: "shape", track: "V1", start: 0, duration: 3, props: { shapes: [{ type: "ellipse", w: 300, h: 300, fill: "none", stroke: "#fff" }] } }] } },
    { op: "addClip", clip: { id: "c_b", kind: "comp", compId: "badge", track: "V3", start: 2, duration: 3 } },
    { op: "inComp", comp: "badge", ops: [
      { op: "addClip", clip: { id: "star", kind: "shape", track: "V2", start: 0.5, duration: 2, props: { shapes: [{ type: "star" }] } } },
      { op: "split", at: 1.5, ids: ["star"] },
      { op: "setShape", id: "ring", shape: 0, set: { stroke: "#ffd166" } },
    ] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /\+comp badge/);
  assert.match(r.text, /badge\{.*\+star/);
  assert.equal(doc().clips.find((c) => c.id === "c_b").props.fit, "none", "a comp clip shows at its own size by default");
  assert.equal(comp("badge").clips.length, 3, "ring + the two halves of star");
  assert.equal(comp("badge").clips.find((c) => c.id === "ring").props.shapes[0].stroke, "#ffd166");
  assert.equal(doc().clips.length, 4, "nothing leaked onto the main timeline");

  r = await patch({ op: "precompose", ids: ["c_v", "c_t"], name: "Intro", id: "intro" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(comp("intro").clips.map((c) => c.id).sort(), ["c_t", "c_v"]);
  assert.ok(doc().clips.some((c) => c.kind === "comp" && c.compId === "intro"));
  r = await patch({ op: "inComp", comp: "intro", ops: [{ op: "addClip", clip: { kind: "comp", compId: "badge", track: "V3", start: 0, duration: 2 } }] });
  assert.equal(r.isError, false, "a comp inside a comp: " + r.text);
  r = await patch({ op: "updateComp", id: "intro", set: { name: "Opening", background: "#101018" } });
  assert.equal(comp("intro").name, "Opening");

  // refusals
  r = await patch({ op: "inComp", comp: "badge", ops: [{ op: "addClip", clip: { kind: "comp", compId: "intro", track: "V1", start: 0, duration: 1 } }] });
  assert.match(r.text, /would contain itself/, "intro holds badge, so badge can't hold intro");
  r = await patch({ op: "inComp", comp: "badge", ops: [{ op: "setProject", set: { width: 10 } }] });
  assert.match(r.text, /can't run inside a comp/);
  r = await patch({ op: "addClip", clip: { kind: "comp", compId: "nope", track: "V1", start: 0, duration: 1 } });
  assert.match(r.text, /compId must name a comp/);
  r = await patch({ op: "removeComp", id: "badge" });
  assert.match(r.text, /is used by/);
  r = await patch({ op: "precompose", ids: ["c_l"] });
  assert.match(r.text, /locked/);
  r = await patch({ op: "updateComp", id: "badge", set: { clips: [] } });
  assert.match(r.text, /edit its clips with inComp/);

  const compact = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(compact.text, /c_b V3 2s\+3s comp\(badge\)/);
  assert.match(compact.text, /COMPS \(2\)/);
  assert.match(compact.text, /badge "Badge" 400x400 3s, 3 clips/);
  assert.match(compact.text, / {4}ring V1 0s\+3s shape/);

  // a whole document with a comp loop is refused
  const bad = doc();
  bad.comps.find((c) => c.id === "badge").clips.push({ id: "x", kind: "comp", compId: "intro", track: "V1", start: 0, duration: 1 });
  r = await mcp.callTool("fablecut_set_project", { project: bad, force: true });
  assert.match(r.text, /missing or would contain itself/);
  // clips inside comps get the same checks as timeline clips, and comps are saved normalized
  const ghost = doc();
  ghost.comps.find((c) => c.id === "badge").clips.push({ id: "g", kind: "video", mediaId: "m_nope", track: "V1", start: 0, duration: 1 });
  r = await mcp.callTool("fablecut_set_project", { project: ghost, force: true });
  assert.match(r.text, /comp badge: clip g references unknown mediaId m_nope/);
  const loose = doc();
  loose.comps.push({ id: " extra ", duration: 2.123456, clips: [] });
  r = await mcp.callTool("fablecut_set_project", { project: loose, force: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual((({ id, name, width, height, duration }) => ({ id, name, width, height, duration }))(comp("extra")),
    { id: "extra", name: "extra", width: 1280, height: 720, duration: 2.1235 });
  const twin = doc();
  twin.comps.push({ id: " extra", duration: 1, clips: [] });
  r = await mcp.callTool("fablecut_set_project", { project: twin, force: true });
  assert.match(r.text, /two comps have the id extra/);
  // media still used inside a comp can't be removed
  r = await patch({ op: "inComp", comp: "badge", ops: [{ op: "addClip", clip: { id: "bv", kind: "video", mediaId: "m_a", track: "V1", start: 0, in: 0, duration: 1 } }] });
  assert.equal(r.isError, false, r.text);
  r = await patch({ op: "removeMedia", id: "m_a" });
  assert.match(r.text, /used by clip .* in comp/);
});
