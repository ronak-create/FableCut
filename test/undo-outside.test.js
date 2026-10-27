/* Undo around edits made outside the tab (an agent, another tab): such an edit
   becomes an undo step of its own, so Ctrl+Z takes it back first instead of
   replaying an older step that predates it (which silently dropped the agent's
   work). The undo functions are sliced out of app.js, like timeline-sandbox.js. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SRC } = require("./timeline-sandbox");

function slice(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `markers not found: ${a} … ${b}`);
  return SRC.slice(i, j);
}

function world(clips) {
  const project = { clips, markers: [], comps: [], media: [] };
  const runtime = { undo: [], redo: [] };
  const toasts = [];
  const env = {
    project, runtime, toast: (m) => toasts.push(m), pruneSelection() {}, scheduleSave() {}, renderInspector() {},
    SeqLib: { others: () => [], activeId: () => "main", find: () => null }, seqRoot: () => project,
    reloadMediaSource() {}, renderBin() {}, scheduleOfflineCheck() {},
  };
  const names = Object.keys(env);
  const fns = new Function(...names, `${slice("function undoSnapshot()", "function defaultTrackFor(")}
    return { undoSnapshot, pushUndo, outsideEditStep, isOutsideStep, undo, redo };`)(...names.map((k) => env[k]));
  return { ...fns, project, runtime, toasts };
}

const clip = (id, text) => ({ id, kind: "text", track: "V1", start: 0, duration: 3, props: { text } });
const text = (w, id) => w.project.clips.find((c) => c.id === id).props.text;
/* What syncFromServer does with a document written elsewhere. */
function outsideEdit(w, change) {
  const before = w.undoSnapshot(), mediaBefore = w.project.media;
  w.project.clips = JSON.parse(JSON.stringify(w.project.clips));
  w.project.media = JSON.parse(JSON.stringify(w.project.media));
  change(w.project);
  const step = w.outsideEditStep(before, w.undoSnapshot(), mediaBefore, w.project.media);
  if (step) w.pushUndo(step);
  return step;
}

test("Ctrl+Z after an agent edit takes back the agent's edit, then the user's", () => {
  const w = world([clip("a", "user"), clip("b", "original")]);
  w.pushUndo(); w.project.clips[0].props = { text: "user edit" };            // the user's edit
  outsideEdit(w, (p) => { p.clips[1].props = { text: "agent" }; });          // then an agent's
  w.undo();
  assert.equal(text(w, "b"), "original", "the agent's edit is taken back");
  assert.equal(text(w, "a"), "user edit", "the user's edit stays");
  assert.match(w.toasts.at(-1), /outside this tab/);
  w.undo();
  assert.equal(text(w, "a"), "user", "the next Ctrl+Z takes back the user's edit");
  assert.equal(w.toasts.length, 1, "only the outside step says so");
});

test("undoing an outside edit that removed media brings the media back with its clips; redo removes it again", () => {
  const w = world([{ ...clip("v", "x"), kind: "video", mediaId: "m1" }, clip("t", "title")]);
  w.project.media = [{ id: "m1", name: "a.mp4", kind: "video", src: "/media/a.mp4" }];
  const step = outsideEdit(w, (p) => { p.clips = p.clips.filter((c) => c.id !== "v"); p.media = []; });
  assert.ok(step.includes('"media":'), "the step carries the media list");
  w.undo();
  assert.deepEqual(w.project.clips.map((c) => c.id), ["v", "t"]);
  assert.deepEqual(w.project.media.map((m) => m.id), ["m1"], "the clip's file is back in the project");
  w.redo();
  assert.deepEqual(w.project.clips.map((c) => c.id), ["t"], "redo takes the clip out again");
  assert.deepEqual(w.project.media, [], "and its media");
});

test("an outside edit that only changes clips keeps the step small (no media)", () => {
  const w = world([clip("a", "x")]);
  w.project.media = [{ id: "m1", name: "a.mp4", kind: "video", src: "/media/a.mp4" }];
  const step = outsideEdit(w, (p) => { p.clips[0].props = { text: "y" }; });
  assert.ok(!step.includes('"media":'));
});

test("an outside write that leaves the open timeline alone adds no undo step", () => {
  const w = world([clip("a", "x")]);
  w.pushUndo(); w.project.clips[0].props = { text: "y" };
  assert.equal(outsideEdit(w, () => {}), null);
  assert.equal(w.runtime.undo.length, 1);
  assert.equal(w.isOutsideStep(w.runtime.undo[0]), false, "a user step is not marked");
});

/* syncFromServer itself, run against a stubbed fetch: a document written elsewhere arrives. */
function synced(clips) {
  const project = { clips, markers: [], comps: [], media: [], revision: 1, sequence: undefined };
  const runtime = { undo: [], redo: [], projectId: "p1", saveTimer: null, syncSeq: 0, pendingSync: false, audioBufs: new Map() };
  const state = { gesture: false, exporting: false, binTab: "project", compCtx: null };
  const toasts = [];
  let disk = null;
  const env = {
    project, runtime, state, toast: (m) => toasts.push(m), pruneSelection() {}, scheduleSave() {}, renderInspector() {},
    SeqLib: { others: () => [], activeId: () => "main", find: () => null }, seqRoot: () => project,
    reloadMediaSource() {}, renderBin() {}, scheduleOfflineCheck() {},
    fetchSaved: () => Promise.resolve(), fetchLibrary: () => Promise.resolve(), renderLibrary() {}, renderTemplatesTab() {},
    loadLibraryFonts() {}, fetchEncodeProfiles() {}, onProjectSwitched() {}, setTime() {}, syncCompCrumb() {},
    projectsOpen: () => false, pjLoad() {}, probeMissingMeta: async () => {}, renderProjectGrid() {},
    pj: { verOf: null, verDiff: new Map() }, pjDropDiffs() {},
    applyProject: (d) => Object.assign(project, { clips: d.clips, markers: d.markers || [], comps: d.comps || [], media: d.media || [], revision: d.revision }),
    fetch: async () => ({ ok: true, headers: { get: () => "p1" }, json: async () => JSON.parse(JSON.stringify(disk)) }),
    clearTimeout() {},
  };
  const names = Object.keys(env);
  const fns = new Function(...names, `${slice("function undoSnapshot()", "function defaultTrackFor(")}
    ${slice("async function syncFromServer(", "/** Populate a media entry")}
    return { pushUndo, undo, redo, syncFromServer };`)(...names.map((k) => env[k]));
  const write = (change) => {
    disk = JSON.parse(JSON.stringify({ ...project, revision: project.revision + 1 }));
    change(disk);
  };
  return { ...fns, project, runtime, toasts, write };
}

test("syncFromServer: an agent's edit becomes an undo step of its own; undo and redo walk through it in order", async () => {
  const w = synced([clip("a", "user"), clip("b", "original")]);
  w.pushUndo(); w.project.clips = [{ ...w.project.clips[0], props: { text: "user edit" } }, w.project.clips[1]];   // the user's edit
  w.write((d) => { d.clips[1].props = { text: "agent" }; });
  assert.equal(await w.syncFromServer(), true);
  assert.equal(text(w, "b"), "agent", "the agent's edit is applied");
  assert.equal(w.runtime.undo.length, 2, "and recorded as a step");
  w.undo();
  assert.deepEqual([text(w, "a"), text(w, "b")], ["user edit", "original"], "Ctrl+Z takes back the agent's edit only");
  assert.match(w.toasts.at(-1), /outside this tab/);
  w.undo();
  assert.equal(text(w, "a"), "user");
  w.redo(); w.redo();
  assert.deepEqual([text(w, "a"), text(w, "b")], ["user edit", "agent"], "redo puts both back");
});

test("syncFromServer: a write that leaves the timeline alone adds no step; a collision lets Ctrl+Z put the user's version back", async () => {
  const w = synced([clip("a", "x")]);
  w.write((d) => { d.name = "renamed"; });
  await w.syncFromServer();
  assert.equal(w.runtime.undo.length, 0, "no step for a change outside the timeline");

  w.project.clips = [{ ...w.project.clips[0], props: { text: "unsaved" } }];   // the user's edit, not saved yet
  w.runtime.saveTimer = 1;
  w.write((d) => { d.clips[0].props = { text: "agent" }; });
  await w.syncFromServer();
  assert.equal(text(w, "a"), "agent", "the outside write wins");
  assert.match(w.toasts.at(-1), /Ctrl\+Z puts your version back/);
  w.undo();
  assert.equal(text(w, "a"), "unsaved", "Ctrl+Z puts the user's version back");
});
