/* Versions (history.js): saved copies of a project, never destructive — the
   module, the REST API, recovery of an unreadable project.json at startup,
   and the fablecut_versions MCP tool with its automatic agent versions. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProjects } = require("../projects");
const { createHistory, diffDocs } = require("../history");
const { makeDataDir, readProject, writeProject, seedProject, startServer, startMcp } = require("./helpers");

const NO_WATCH = { FABLECUT_NO_FS_WATCH: "1" };
const make = (t, project, opts) => {
  const dir = makeDataDir(t, project);
  const P = createProjects({ dataDir: dir, projectFile: path.join(dir, "project.json"), libraryDir: path.join(dir, "library") });
  return { dir, P, H: createHistory({ projects: P, ...opts }) };
};
const post = (base, body) => fetch(base + "/api/versions", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("save, list and diff: what changed since a version", (t) => {
  const { dir, H } = make(t);
  const v1 = H.save(null, { name: "Rough cut", note: "first pass" }).version;
  assert.deepEqual([v1.v, v1.name, v1.kind, v1.clips, v1.revision], [1, "Rough cut", "manual", 1, 1]);
  assert.equal(H.save(null).version.name, "Version 02", "a version without a name is numbered");

  writeProject(dir, seedProject({ revision: 4, clips: [
    { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 8, props: { opacity: 0.5 } },
    { id: "c_t", name: "Title", kind: "text", track: "V2", start: 1, in: 0, duration: 2 },
  ] }));
  const d = H.diff(null, 1);
  assert.equal(d.same, false);
  assert.deepEqual(d.added.map((c) => c.id), ["c_t"]);
  assert.deepEqual(d.changed[0].what, ["timing", "opacity"]);
  assert.ok(d.lines.some((l) => /length 0:05 → 0:08/.test(l)));
  assert.equal(H.diff(null, 1, 2).same, true, "two versions of the same document");
  assert.deepEqual(H.list().versions.map((e) => e.v), [2, 1], "newest first");
  assert.throws(() => H.diff(null, 9), /no version 9/);
});

test("restore is never destructive: what was there becomes a version first", (t) => {
  const { dir, H } = make(t);
  H.save(null, { name: "Good" });
  writeProject(dir, seedProject({ name: "Broken edit", revision: 7, clips: [] }));
  const out = H.restore(null, "v1");
  assert.equal(out.restored.v, 1);
  assert.equal(out.saved.kind, "restore");
  assert.equal(out.saved.name, "Before restoring v1");
  const now = readProject(dir);
  assert.equal(now.name, "Test Project");
  assert.equal(now.clips.length, 1);
  assert.equal(now.revision, 8, "a new revision, so tabs and agents see the change");
  // and the restore itself can be undone
  H.restore(null, out.saved.v);
  assert.equal(readProject(dir).name, "Broken edit");
});

test("one final version; a final one can't be deleted; old auto-saves are pruned", (t) => {
  const { dir, H } = make(t, undefined, { keepAuto: 2 });
  H.save(null); H.save(null);
  H.update(null, 1, { final: true });
  H.update(null, 2, { final: true });
  assert.deepEqual(H.list().versions.filter((e) => e.final).map((e) => e.v), [2]);
  assert.throws(() => H.remove(null, 2), /marked final/);
  H.update(null, 2, { name: "Picture lock", note: "approved" });
  assert.equal(H.list().versions[0].name, "Picture lock");
  for (let i = 0; i < 4; i++) {
    writeProject(dir, seedProject({ revision: 10 + i }));
    H.save(null, { kind: "auto" });
  }
  const autos = H.list().versions.filter((e) => e.kind === "auto");
  assert.equal(autos.length, 2, "only the newest auto-saves are kept");
  assert.equal(H.list().versions.filter((e) => e.kind === "manual").length, 2, "manual versions are never pruned");
});

test("auto-save: only when the project changed and the last version is old enough", (t) => {
  const { dir, H } = make(t, seedProject({ clips: [] }));
  assert.equal(H.maybeAuto(), null, "an empty project that was never used: nothing to keep");
  writeProject(dir, seedProject({ revision: 2 }));
  const first = H.maybeAuto();
  assert.equal(first.kind, "auto");
  writeProject(dir, seedProject({ revision: 3 }));
  assert.equal(H.maybeAuto(), null, "too soon after the last version");
  assert.equal(H.maybeAuto(Date.now() + 11 * 60000).v, 2, "ten minutes later it saves");
  assert.equal(H.maybeAuto(Date.now() + 30 * 60000), null, "unchanged since: nothing new");
});

test("before an agent edits: one version, not one per edit", (t) => {
  const { dir, H } = make(t);
  assert.equal(H.beforeAgent("Before agent edits").kind, "agent");
  assert.equal(H.beforeAgent("Before agent edits"), null, "the same revision is already kept");
  writeProject(dir, seedProject({ revision: 2 }));
  assert.equal(H.beforeAgent("Before an agent rewrote the project").v, 2);
});

test("backup carries the versions; importing it brings them back", (t) => {
  const { H, P } = make(t);
  H.save(null, { name: "A" }); H.save(null, { name: "B", final: true });
  const b = H.backup();
  assert.equal(b.fablecut, "backup");
  assert.equal(b.versions.length, 2);
  const out = H.importBackup(JSON.parse(JSON.stringify(b)), { name: "Restored copy" });
  assert.equal(out.versions, 2);
  const vs = H.list(out.id).versions;
  assert.deepEqual(vs.map((e) => [e.v, e.name, e.final]), [[2, "B", true], [1, "A", false]]);
  assert.equal(P.list().projects.find((p) => p.id === out.id).name, "Restored copy");
  assert.throws(() => H.importBackup({ hello: 1 }), /not a FableCut backup/);
});

test("diffDocs reads project settings too", () => {
  const a = seedProject(), b = { ...seedProject(), fps: 25, markers: [{ t: 1 }], media: [] };
  const d = diffDocs(a, b);
  assert.ok(d.settings.includes("fps 30→25"));
  assert.ok(d.settings.includes("markers"));
  assert.deepEqual(d.mediaRemoved, ["m_a"]);
});

test("REST: list, save, diff, restore, update, delete and the version file", async (t) => {
  const dir = makeDataDir(t);
  const { base } = await startServer(t, dir, NO_WATCH);
  let res = await post(base, { action: "save", name: "First", note: "n" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version.v, 1);
  writeProject(dir, seedProject({ name: "Changed", revision: 5 }));
  const diff = await (await post(base, { action: "diff", version: 1 })).json();
  assert.ok(diff.lines.some((l) => /name "Test Project"→"Changed"/.test(l)));
  const r = await (await post(base, { action: "restore", version: 1 })).json();
  assert.equal(r.saved.v, 2);
  assert.equal(readProject(dir).name, "Test Project");
  const list = await (await fetch(base + "/api/versions")).json();
  assert.deepEqual(list.versions.map((e) => e.kind), ["restore", "manual"]);
  const file = await fetch(base + "/api/versions/file?version=2");
  assert.match(file.headers.get("content-disposition"), /attachment/);
  assert.equal((await file.json()).name, "Changed");
  assert.equal((await post(base, { action: "delete", version: 2 })).status, 200);
  assert.equal((await post(base, { action: "restore", version: 2 })).status, 404);
  assert.equal((await post(base, { action: "fly" })).status, 400);
});

test("REST: a downloaded backup imports with its versions", async (t) => {
  const dir = makeDataDir(t);
  const { base } = await startServer(t, dir, NO_WATCH);
  await post(base, { action: "save", name: "Keep" });
  const { active } = await (await fetch(base + "/api/projects")).json();
  const backup = await (await fetch(base + "/api/projects/backup?id=" + active)).json();
  const res = await fetch(base + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import", project: backup }),
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.versions, 1);
  const vs = await (await fetch(base + "/api/versions?project=" + out.id)).json();
  assert.equal(vs.versions[0].name, "Keep");
});

test("an unreadable project.json at startup is kept aside and the newest version restored", async (t) => {
  const { dir, H } = make(t, seedProject({ name: "Precious" }));
  H.save(null, { name: "Safe" });
  fs.writeFileSync(path.join(dir, "project.json"), "{ half a fi");
  const { base } = await startServer(t, dir, NO_WATCH);
  const doc = await (await fetch(base + "/api/project")).json();
  assert.equal(doc.name, "Precious");
  const aside = fs.readdirSync(dir).filter((f) => /^project\.corrupt-.*\.json$/.test(f));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), "{ half a fi", "the broken file is kept as it was");
});

test("fablecut_versions, and a version before an agent's first edit", async (t) => {
  const dir = makeDataDir(t);
  const { port } = await startServer(t, dir, NO_WATCH);
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: "1" });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });

  let r = await mcp.callTool("fablecut_versions", {});
  assert.match(r.text, /No versions of p_\w+ yet/);

  r = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setProject", set: { name: "Agent cut" } }] });
  assert.equal(r.isError, false, r.text);
  r = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setProject", set: { fps: 25 } }] });
  r = await mcp.callTool("fablecut_versions", {});
  assert.match(r.text, /1 version\(s\)/, "one version for the session, not one per edit");
  assert.match(r.text, /v1 "Before agent edits" \(before agent edits\)/);

  r = await mcp.callTool("fablecut_versions", { action: "diff", version: 1 });
  assert.match(r.text, /name "Test Project"→"Agent cut"/);
  assert.match(r.text, /fps 30→25/);

  r = await mcp.callTool("fablecut_versions", { action: "save", name: "Approved", final: true });
  assert.match(r.text, /Saved v2 FINAL "Approved"/);
  r = await mcp.callTool("fablecut_versions", { action: "restore", version: 1 });
  assert.match(r.text, /Restored v1 .* kept as v3/);
  assert.equal(readProject(dir).name, "Test Project");
  r = await mcp.callTool("fablecut_versions", { action: "delete", version: 2 });
  assert.equal(r.isError, true);
  assert.match(r.text, /marked final/);
});

test("lengths round up into the next minute; imported versions are checked and rebuilt", (t) => {
  const { dir, H } = make(t);
  H.save(null);
  writeProject(dir, seedProject({ revision: 3, clips: [{ id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 119.7 }] }));
  assert.ok(H.diff(null, 1).lines.includes("length 0:05 → 2:00"));

  const b = H.backup();
  b.versions.push(
    { v: 7, name: "not a project", project: "oops" },
    { v: 8, name: "no clips", project: { media: [] } },
    { v: 0, name: "bad number", project: seedProject() },
    { v: 9, name: "", final: true, kind: "weird", revision: 999, clips: 42, project: seedProject({ revision: 5 }) },
    { v: 10, name: "Also final", final: true, project: seedProject({ revision: 6 }) });
  b.versions[0].final = true;
  const out = H.importBackup(JSON.parse(JSON.stringify(b)));
  assert.equal(out.versions, 3, "only versions that are projects come in");
  const vs = H.list(out.id).versions;
  assert.deepEqual(vs.map((e) => e.v), [10, 9, 1]);
  assert.deepEqual(vs.filter((e) => e.final).map((e) => e.v), [10], "one final cut");
  const v9 = vs.find((e) => e.v === 9);
  assert.deepEqual([v9.name, v9.kind, v9.revision, v9.clips], ["Version 09", "manual", 5, 1], "details come from the document");
});

test("fablecut_versions: restoring a project that isn't open says so", async (t) => {
  const dir = makeDataDir(t);
  const { base, port } = await startServer(t, dir, NO_WATCH);
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: "1" });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const first = (await (await fetch(base + "/api/projects")).json()).active;
  await post(base, { action: "save", name: "Keep" });
  await fetch(base + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "new", name: "Other" }) });
  const r = await mcp.callTool("fablecut_versions", { action: "restore", version: 1, project: first });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`${first} is not the open project, so the editor didn't change; open it`));
});

test("recovery skips a version that isn't a project and uses the next good one", async (t) => {
  const { dir, H } = make(t, seedProject({ name: "Good one" }));
  H.save(null, { name: "Good" });
  writeProject(dir, seedProject({ name: "Later", revision: 3 }));
  const v2 = H.save(null, { name: "Broken" }).version;
  // the newest version's file is valid JSON but not a project
  fs.writeFileSync(path.join(dir, "projects", H.list().project, "history", `v${String(v2.v).padStart(4, "0")}.json`), JSON.stringify({ hello: 1 }));
  fs.rmSync(path.join(dir, "projects", H.list().project, "project.json"), { force: true });
  fs.writeFileSync(path.join(dir, "project.json"), "{ nope");
  const { base } = await startServer(t, dir, NO_WATCH);
  const doc = await (await fetch(base + "/api/project")).json();
  assert.equal(doc.name, "Good one");
  assert.ok(Array.isArray(doc.clips));
});
