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
  const fns = new Function(...names, `${slice("function undoSnapshot()", "function redo()")}
    return { undoSnapshot, pushUndo, outsideEditStep, isOutsideStep, undo };`)(...names.map((k) => env[k]));
  return { ...fns, project, runtime, toasts };
}

const clip = (id, text) => ({ id, kind: "text", track: "V1", start: 0, duration: 3, props: { text } });
const text = (w, id) => w.project.clips.find((c) => c.id === id).props.text;
/* What syncFromServer does with a document written elsewhere. */
function outsideEdit(w, change) {
  const before = w.undoSnapshot();
  w.project.clips = JSON.parse(JSON.stringify(w.project.clips));
  change(w.project);
  const step = w.outsideEditStep(before, w.undoSnapshot());
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

test("an outside write that leaves the open timeline alone adds no undo step", () => {
  const w = world([clip("a", "x")]);
  w.pushUndo(); w.project.clips[0].props = { text: "y" };
  assert.equal(outsideEdit(w, () => {}), null);
  assert.equal(w.runtime.undo.length, 1);
  assert.equal(w.isOutsideStep(w.runtime.undo[0]), false, "a user step is not marked");
});

test("syncFromServer records the outside step for the open timeline only", () => {
  const body = slice("async function syncFromServer(", "/** Populate a media entry");
  assert.match(body, /const before = !state\.compCtx && SeqLib\.activeId\(data\) === SeqLib\.activeId\(project\) \? undoSnapshot\(\) : null;/);
  assert.match(body, /outsideEditStep\(before, undoSnapshot\(\)\)/);
  assert.ok(body.indexOf("const before") < body.indexOf("applyProject(data);\n    const step"), "taken before the document is applied");
});
