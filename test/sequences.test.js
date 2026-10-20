/* Sequences (sequences.js): several timelines in one project — the module, the
   patch ops, media and comp usage across sequences, validation, version diffs
   and the MCP tools. The open sequence is the document's top level. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const SeqLib = require("../sequences");
const ProjectOps = require("../project-ops");
const MediaLib = require("../media-lib");
const { diffDocs } = require("../history");
const { makeDataDir, readProject, seedProject, startServer, startMcp } = require("./helpers");

const patch = (doc, ops) => ProjectOps.applyPatch(doc, ops, {});

test("a project without sequences has one, Main, and stays as it was", () => {
  const doc = seedProject();
  assert.deepEqual(SeqLib.list(doc).map((r) => [r.id, r.name, r.active, r.clips]), [["main", "Main", true, 1]]);
  SeqLib.normalize(doc);
  assert.equal("sequences" in doc, false);
  assert.equal("sequence" in doc, false);
});

test("add, open and come back: each sequence keeps its own timeline, canvas and settings", () => {
  const doc = seedProject({ markers: [{ t: 1 }], inPoint: 1, outPoint: 4 });
  const v = SeqLib.add(doc, { name: "Vertical", width: 1080, height: 1920 });
  assert.deepEqual([v.name, v.width, v.height, v.fps, v.clips.length], ["Vertical", 1080, 1920, 30, 0]);
  assert.equal(doc.clips.length, 1, "adding doesn't open it");

  SeqLib.open(doc, v.id);
  assert.equal(doc.sequence, v.id);
  assert.deepEqual([doc.width, doc.height, doc.clips.length], [1080, 1920, 0]);
  assert.equal(doc.markers, undefined, "markers and IN / OUT belong to the other sequence");
  assert.equal(doc.inPoint, undefined);
  doc.clips.push({ id: "c_v", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 2, duration: 3 });

  SeqLib.open(doc, "main");
  assert.deepEqual([doc.width, doc.height, doc.clips.map((c) => c.id), doc.inPoint], [1280, 720, ["c_a"], 1]);
  assert.deepEqual(doc.markers, [{ t: 1 }]);
  const parked = SeqLib.find(doc, v.id);
  assert.deepEqual(parked.clips.map((c) => c.id), ["c_v"]);
  assert.equal(SeqLib.find(doc, "main").clips, undefined, "the open one's timeline lives at the top level only");
});

test("copies, renames, reorders and deletes", () => {
  const doc = seedProject();
  const copy = SeqLib.add(doc, { from: "open" });
  assert.equal(copy.name, "Main copy");
  assert.deepEqual(copy.clips.map((c) => c.id), ["c_a"]);
  copy.clips[0].start = 9;
  assert.equal(doc.clips[0].start, 0, "a copy, not the same objects");
  const third = SeqLib.add(doc, { from: copy.id, name: "Short", width: 1080, height: 1080 });
  assert.deepEqual([third.width, third.height, third.clips[0].start], [1080, 1080, 9]);
  assert.deepEqual(SeqLib.entries(doc).map((s) => s.name), ["Main", "Main copy", "Short"], "added after its source");

  SeqLib.rename(doc, copy.id, "Client cut");
  SeqLib.move(doc, third.id, 0);
  assert.deepEqual(SeqLib.entries(doc).map((s) => s.name), ["Short", "Main", "Client cut"]);
  assert.throws(() => SeqLib.rename(doc, copy.id, "  "), /needs a name/);

  // deleting the open one opens a neighbour
  SeqLib.remove(doc, "main");
  assert.equal(SeqLib.activeId(doc), copy.id);
  assert.equal(doc.clips[0].start, 9);
  SeqLib.remove(doc, third.id);
  assert.throws(() => SeqLib.remove(doc, copy.id), /at least one sequence/);
  assert.equal(SeqLib.entries(doc).length, 1);
});

test("patch ops: addSequence, inSequence, openSequence, updateSequence, removeSequence", () => {
  const doc = seedProject();
  let r = patch(doc, [{ op: "addSequence", id: "vert", name: "Vertical", width: 1080, height: 1920 }]);
  assert.match(r.notes[0], /\+sequence vert "Vertical" 1080x1920@30/);
  // edit a sequence that isn't open: clips, timeline edits and its own settings
  r = patch(doc, [{ op: "inSequence", sequence: "vert", ops: [
    { op: "addClip", clip: { id: "c_v", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 6 } },
    { op: "split", at: 2, ids: ["c_v"] },
    { op: "setProject", set: { markers: [{ t: 2, label: "hook" }], fps: 25 } },
  ] }]);
  assert.match(r.notes[0], /^vert\{\+c_v .* ~project\}$/);
  assert.equal(SeqLib.activeId(doc), "main", "still on Main");
  assert.equal(doc.fps, 30);
  const vert = SeqLib.find(doc, "vert");
  assert.equal(vert.clips.length, 2);
  assert.equal(vert.fps, 25);

  patch(doc, [{ op: "openSequence", id: "vert" }, { op: "updateSequence", id: "vert", set: { name: "Reel" } }]);
  assert.deepEqual([doc.sequence, doc.width, doc.fps, doc.clips.length], ["vert", 1080, 25, 2]);
  assert.equal(SeqLib.find(doc, "vert").name, "Reel");
  assert.throws(() => patch(doc, [{ op: "updateSequence", id: "vert", set: { width: 5 } }]), /setProject/);
  assert.throws(() => patch(doc, [{ op: "inSequence", sequence: "main", ops: [{ op: "openSequence", id: "vert" }] }]), /can't run inside inSequence/);
  assert.throws(() => patch(doc, [{ op: "openSequence", id: "nope" }]), /no sequence nope \(main, vert\)/);

  r = patch(doc, [{ op: "removeSequence", id: "vert" }]);
  assert.match(r.notes[0], /-sequence vert \(opened main\)/);
  assert.equal("sequences" in doc, false, "back to one sequence: the keys go");
  assert.equal(doc.width, 1280);
});

test("media and comps used by another sequence are counted and protected", () => {
  const doc = seedProject({ comps: [{ id: "lt", name: "Lower third", width: 1280, height: 720, duration: 2, clips: [] }] });
  patch(doc, [{ op: "addMedia", media: { id: "m_b", name: "b.mp4", kind: "video", src: "/media/b.mp4", duration: 8 } }]);
  patch(doc, [{ op: "addSequence", id: "alt", name: "Alt" }, { op: "inSequence", sequence: "alt", ops: [
    { op: "addClip", clip: { id: "c_b", mediaId: "m_b", kind: "video", track: "V1", start: 0, in: 0, duration: 8 } },
    { op: "addClip", clip: { id: "c_lt", kind: "comp", compId: "lt", track: "V2", start: 0, duration: 2 } },
  ] }]);
  assert.equal(MediaLib.usageCounts(doc).get("m_b"), 1);
  const where = MediaLib.placements(doc, "m_b");
  assert.deepEqual(where.map((p) => [p.clipId, p.sequence, p.sequenceName]), [["c_b", "alt", "Alt"]]);
  assert.throws(() => patch(doc, [{ op: "removeMedia", id: "m_b" }]), /used by clip c_b in sequence alt/);
  assert.throws(() => patch(doc, [{ op: "removeComp", id: "lt" }]), /c_lt \(in sequence alt\)/);
  // replacing a file trims clips everywhere
  const r = ProjectOps.applyPatch(doc, [{ op: "replaceMedia", id: "m_b", src: "/media/c.mp4" }], { mediaInfo: () => ({ duration: 5 }) });
  assert.match(r.notes[0], /trimmed/);
  assert.equal(SeqLib.find(doc, "alt").clips.find((c) => c.id === "c_b").duration, 5);
});

test("the compact view lists the sequences; a whole document is checked across them", () => {
  const doc = seedProject();
  patch(doc, [{ op: "addSequence", id: "sq", name: "Square", width: 1080, height: 1080 }]);
  const view = ProjectOps.compactView(doc);
  assert.match(view, /SEQUENCES \(2\)/);
  assert.match(view, /main "Main" \(open\) 1280x720@30, 1 clip\(s\), 0:05/);
  assert.match(view, /sq "Square" 1080x1080@30, 0 clip\(s\)/);

  const bad = JSON.parse(JSON.stringify(doc));
  bad.sequences[1].clips = [{ id: "x", mediaId: "m_nope", kind: "video", track: "V1", start: 0, duration: 1 }];
  assert.throws(() => ProjectOps.checkProject(bad), /sequence sq: clip x references unknown mediaId m_nope/);
  const dup = { ...seedProject(), sequences: [{ id: "a", name: "A" }, { id: "a", name: "B", clips: [] }], sequence: "a" };
  assert.throws(() => ProjectOps.checkProject(dup), /two sequences have the id a/);
  // an open entry carrying a timeline is tidied: the top level is the open one
  const odd = { ...seedProject(), sequences: [{ id: "a", name: "A", clips: [{ id: "ghost", start: 0, duration: 1 }] }, { id: "b", name: "B", clips: [] }], sequence: "a" };
  ProjectOps.checkProject(odd);
  assert.equal(odd.sequences[0].clips, undefined);
});

test("compare: each sequence against itself, whichever was open", () => {
  const a = seedProject();
  patch(a, [{ op: "addSequence", id: "v", name: "Vertical", width: 1080, height: 1920 }]);
  const b = JSON.parse(JSON.stringify(a));
  patch(b, [{ op: "inSequence", sequence: "v", ops: [{ op: "addClip", clip: { id: "c_new", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 2 } }] },
    { op: "openSequence", id: "v" }, { op: "addSequence", id: "x", name: "Extra" }]);
  const d = diffDocs(a, b);
  assert.ok(d.lines.includes(`"Vertical": 1 clip(s) added: video (c_new)`), d.lines.join("\n"));
  assert.ok(d.lines.includes(`sequence "Extra" added`));
  assert.ok(d.lines.includes(`open sequence "Main" → "Vertical"`));
  assert.ok(!d.lines.some((l) => /"Main":/.test(l)), "Main didn't change, even though it is no longer open");
  assert.deepEqual(d.added.map((c) => c.id), ["c_new"]);
  assert.equal(diffDocs(b, JSON.parse(JSON.stringify(b))).same, true);
});

test("MCP: sequence ops through fablecut_patch_project, the status and the compact view", async (t) => {
  const dir = makeDataDir(t);
  const { port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: "1" });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  let r = await mcp.callTool("fablecut_patch_project", { ops: [
    { op: "addSequence", id: "reel", name: "Reel", from: "open", width: 1080, height: 1920 },
    { op: "inSequence", sequence: "reel", ops: [{ op: "updateClip", id: "c_a", set: { props: { scale: 1.8 } } }] },
  ] });
  assert.equal(r.isError, false, r.text);
  const doc = readProject(dir);
  assert.equal(doc.sequence, "main");
  assert.equal(doc.clips[0].props, undefined, "Main's clip is untouched");
  assert.equal(doc.sequences[1].clips[0].props.scale, 1.8);

  r = await mcp.callTool("fablecut_status", {});
  assert.match(r.text, /Sequences \(2; the numbers above are the open one's\): main "Main" \(open\).* · reel "Reel" 1080x1920@30, 1 clip\(s\)/);
  r = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(r.text, /SEQUENCES \(2\)/);
  r = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "openSequence", id: "reel" }] });
  assert.equal(readProject(dir).width, 1080);
  // a whole-document rewrite is checked across the sequences too
  const bad = readProject(dir);
  bad.sequences[0].clips = [{ id: "z", mediaId: "m_zz", kind: "video", track: "V1", start: 0, duration: 1 }];
  await mcp.callTool("fablecut_get_project", {});
  r = await mcp.callTool("fablecut_set_project", { project: { ...bad, revision: bad.revision + 1 } });
  assert.equal(r.isError, true);
  assert.match(r.text, /sequence main: clip z references unknown mediaId m_zz/);
});
