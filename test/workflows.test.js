/* Saved workflows (workflows.js, /api/workflows, fablecut_workflows): recipes of
   plain-language steps, each with the tool call that did it, kept in
   library/workflows/ for an agent to follow again on another project. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const W = require("../workflows");
const { makeDataDir, startServer, startMcp } = require("./helpers");

const podcast = {
  name: "Podcast clean-up",
  description: "Voice level, no dead air, captions, a Shorts cut.",
  tags: ["podcast", "audio"],
  steps: [
    { text: "Reduce the room noise on the voice clips.", call: { tool: "fablecut_denoise", args: { clipIds: ["c_vo"], amount: "medium" } } },
    { text: "Normalize the voice to -16 LUFS.", call: { tool: "fablecut_normalize_audio", args: { clipIds: ["c_vo"], target: -16 } } },
    "Cut the pauses longer than half a second.",
    { text: "Export for YouTube Shorts.", call: { tool: "fablecut_export", args: { preset: "youtube-shorts" } } },
  ],
};

test("normalizeWorkflow: an id from the name, plain-string steps, calls kept as given", () => {
  const w = W.normalizeWorkflow(podcast, true);
  assert.equal(w.id, "podcast-clean-up");
  assert.equal(w.steps.length, 4);
  assert.deepEqual(w.steps[2], { text: "Cut the pauses longer than half a second." });
  assert.deepEqual(w.steps[1].call, { tool: "fablecut_normalize_audio", args: { clipIds: ["c_vo"], target: -16 } });
  assert.deepEqual(w.tags, ["podcast", "audio"]);
});

test("normalizeWorkflow refuses what it can't keep, and reading skips bad files instead", () => {
  const bad = [
    [{ steps: ["x"] }, /name is required/],
    [{ name: "x", steps: [] }, /at least one step/],
    [{ name: "x", steps: [{ text: "" }] }, /step 1: text is required/],
    [{ name: "x", steps: [{ text: "a", call: { tool: "rm", args: {} } }] }, /not a FableCut tool/],
    [{ name: "x", steps: [{ text: "a", call: { tool: "fablecut_workflows" } }] }, /not a FableCut tool/],
    [{ name: "x", steps: [{ text: "a", call: { tool: "fablecut_export", args: [1] } }] }, /args is an object/],
    [{ name: "x", steps: Array(51).fill("a") }, /at most 50 steps/],
    [{ name: "x".repeat(81), steps: ["a"] }, /longer than 80/],
  ];
  for (const [w, re] of bad) {
    assert.throws(() => W.normalizeWorkflow(w, true), re);
    assert.equal(W.normalizeWorkflow(w), null);
  }
  // a known-tools list narrows calls to the tools that exist
  assert.throws(() => W.normalizeWorkflow({ name: "x", steps: [{ text: "a", call: { tool: "fablecut_nope" } }] }, true, ["fablecut_export"]), /not a FableCut tool/);
});

test("findWorkflow by id or name; describeWorkflow lists the steps with last time's calls", () => {
  const all = [W.normalizeWorkflow(podcast)];
  assert.equal(W.findWorkflow(all, "podcast-clean-up").id, "podcast-clean-up");
  assert.equal(W.findWorkflow(all, "Podcast Clean-up").id, "podcast-clean-up");
  assert.equal(W.findWorkflow(all, "nope"), null);
  const text = W.describeWorkflow(all[0]);
  assert.match(text, /^Workflow "Podcast clean-up" \(podcast-clean-up\) #podcast #audio/);
  assert.match(text, /2\. Normalize the voice to -16 LUFS\.\n {3}last time: fablecut_normalize_audio \{"clipIds":\["c_vo"\],"target":-16\}/);
  assert.match(text, /3\. Cut the pauses longer than half a second\.\n4\./);
  assert.match(W.workflowLine(all[0]), /^podcast-clean-up — "Podcast clean-up", 4 steps #podcast #audio: Voice level/);
});

test("/api/workflows and fablecut_workflows: save, list, show, update keeps created, delete", async (t) => {
  const dir = makeDataDir(t);
  const { base, port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const saved = await (await post("/api/workflows", { workflow: podcast })).json();
  assert.equal(saved.id, "podcast-clean-up");
  assert.ok(saved.created && saved.updated);
  const file = path.join(dir, "library", "workflows", "podcast-clean-up.json");
  assert.ok(fs.existsSync(file));
  assert.equal((await post("/api/workflows", { workflow: { name: "x", steps: [] } })).status, 400);
  // a broken file in the folder is skipped, not fatal
  fs.writeFileSync(path.join(dir, "library", "workflows", "broken.json"), "{ nope");
  const list = await (await fetch(base + "/api/workflows")).json();
  assert.deepEqual(list.map((w) => w.id), ["podcast-clean-up"]);
  assert.equal((await fetch(base + "/api/workflows?id=Podcast%20clean-up")).status, 200);
  assert.equal((await fetch(base + "/api/workflows?id=nope")).status, 404);

  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: "1" });
  const text = async (args) => (await mcp.callTool("fablecut_workflows", args)).content[0].text;
  assert.match(await text({}), /1 saved workflow\(s\)[^\n]*\npodcast-clean-up — "Podcast clean-up", 4 steps/);
  assert.match(await text({ action: "show", id: "podcast-clean-up" }), /1\. Reduce the room noise[\s\S]*fit its ids, times and values/);
  const upd = await text({ action: "save", workflow: { ...podcast, steps: [...podcast.steps, "Add highlight captions."] } });
  assert.match(upd, /^Updated workflow "Podcast clean-up" \(podcast-clean-up\), 5 step\(s\)/);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.created, saved.created, "an update keeps when it was first saved");
  assert.equal(after.steps.length, 5);
  const refused = await mcp.callTool("fablecut_workflows", { action: "save", workflow: { name: "y", steps: [{ text: "a", call: { tool: "fablecut_nope" } }] } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not a FableCut tool/);
  assert.match(await text({ action: "delete", id: "Podcast clean-up" }), /Deleted workflow "Podcast clean-up"/);
  assert.ok(!fs.existsSync(file));
  assert.match(await text({}), /No saved workflows yet/);
  assert.equal((await post("/api/workflows/delete", { id: "podcast-clean-up" })).status, 404);
});

test("slug is stable after the cut, odd field types are refused (or skipped when reading), files are remembered", () => {
  const long = "a".repeat(59) + " b";
  const id = W.slug(long);
  assert.ok(!id.endsWith("-"), id);
  assert.equal(W.slug(id), id, "a slug of the slug is the same slug");
  const odd = { name: { toString: null }, steps: ["Inspect"] };
  assert.throws(() => W.normalizeWorkflow(odd, true), /name is text/);
  assert.equal(W.normalizeWorkflow(odd), null, "reading: skipped, not thrown");
  assert.throws(() => W.normalizeWorkflow({ name: "x", steps: [{ text: { a: 1 } }] }, true), /step 1: text is text/);
  assert.throws(() => W.normalizeWorkflow({ name: "x", tags: [{}], steps: ["a"] }, true), /tags are words/);
  const list = W.fromFiles([{ file: "old-name.json", data: podcast }, { file: "odd.json", data: odd }, { file: "x.json", data: null }]);
  assert.deepEqual(list.map((w) => w.id), ["podcast-clean-up"]);
  assert.equal(list[0].file, "old-name.json");
  assert.ok(!JSON.stringify(list[0]).includes("old-name"), "the file stays out of JSON");
  assert.deepEqual(W.manifestTools({ tools: [{ name: "fablecut_export" }, {}] }), ["fablecut_export"]);
  assert.equal(W.manifestTools({}), null);
});

test("REST checks calls against the real tools, and deletes a workflow saved under another file name", async (t) => {
  const dir = makeDataDir(t);
  const { base } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const nope = await post("/api/workflows", { workflow: { name: "x", steps: [{ text: "a", call: { tool: "fablecut_nope" } }] } });
  assert.equal(nope.status, 400);
  assert.match((await nope.json()).error, /not a FableCut tool/);
  assert.equal((await post("/api/workflows", { workflow: { name: "y", steps: [{ text: "a", call: { tool: "fablecut_export" } }] } })).status, 200);
  // a file whose name isn't its id (an older save, or written by hand)
  const wdir = path.join(dir, "library", "workflows");
  fs.writeFileSync(path.join(wdir, "hand-made.json"), JSON.stringify({ name: "Hand made", steps: ["Do it"] }));
  assert.equal((await post("/api/workflows/delete", { id: "hand-made" })).status, 200);
  assert.ok(!fs.existsSync(path.join(wdir, "hand-made.json")));
  fs.writeFileSync(path.join(wdir, "renamed.json"), JSON.stringify({ name: "Other name", steps: ["Do it"] }));
  assert.equal((await post("/api/workflows/delete", { id: "Other name" })).status, 200);
  assert.ok(!fs.existsSync(path.join(wdir, "renamed.json")), "deleted by the file it came from");
});

test("updating a workflow kept under another file name leaves one file; deleting it then removes it for good", async (t) => {
  const dir = makeDataDir(t);
  const { base, port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const wdir = path.join(dir, "library", "workflows");
  fs.mkdirSync(wdir, { recursive: true });
  const files = () => fs.readdirSync(wdir).sort();
  fs.writeFileSync(path.join(wdir, "renamed.json"), JSON.stringify({ name: "Other name", steps: ["Old step"], created: "2026-01-01T00:00:00.000Z" }));
  const up = await (await post("/api/workflows", { workflow: { name: "Other name", steps: ["New step"] } })).json();
  assert.equal(up.created, "2026-01-01T00:00:00.000Z", "created kept");
  assert.deepEqual(files(), ["other-name.json"], "the old file went with the update");
  assert.equal((await post("/api/workflows/delete", { id: "other-name" })).status, 200);
  assert.deepEqual(files(), []);
  assert.deepEqual(await (await fetch(base + "/api/workflows")).json(), [], "the old steps don't come back");
  // the same through MCP; and a normal id-named save stays one file
  fs.writeFileSync(path.join(wdir, "renamed.json"), JSON.stringify({ name: "Other name", steps: ["Old step"] }));
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: "1" });
  await mcp.callTool("fablecut_workflows", { action: "save", workflow: { name: "Other name", steps: ["New step"] } });
  await mcp.callTool("fablecut_workflows", { action: "save", workflow: { name: "Other name", steps: ["Newer step"] } });
  assert.deepEqual(files(), ["other-name.json"]);
  assert.match((await mcp.callTool("fablecut_workflows", { action: "delete", id: "other-name" })).content[0].text, /Deleted/);
  assert.deepEqual(files(), []);
});
