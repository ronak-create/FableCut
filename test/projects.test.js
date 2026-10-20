/* Projects (projects.js): several projects in one data folder, ./project.json
   always the open one. The module, the REST API the dashboard uses, and the
   fablecut_projects MCP tool. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProjects } = require("../projects");
const { makeDataDir, readProject, seedProject, startServer, startMcp } = require("./helpers");

const NO_WATCH = { FABLECUT_NO_FS_WATCH: "1" };
const make = (t, project) => {
  const dir = makeDataDir(t, project);
  return { dir, P: createProjects({ dataDir: dir, projectFile: path.join(dir, "project.json"), libraryDir: path.join(dir, "library") }) };
};
const post = (base, body) => fetch(base + "/api/projects", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("the existing project.json becomes the first project, without being rewritten", (t) => {
  const { dir, P } = make(t);
  assert.equal(P.peekActive(), null, "nothing exists before the first use");
  const before = fs.readFileSync(path.join(dir, "project.json"), "utf8");
  const id = P.activeId();
  assert.match(id, /^p_[a-z0-9]+$/);
  assert.equal(P.peekActive(), id);
  assert.equal(fs.readFileSync(path.join(dir, "project.json"), "utf8"), before);
  const { projects } = P.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "Test Project");
  assert.equal(projects[0].active, true);
  assert.equal(projects[0].duration, 5);
});

test("opening a project parks the open one and lifts the revision past both", (t) => {
  const { dir, P } = make(t, seedProject({ revision: 40 }));
  const first = P.activeId();
  const made = P.create({ name: "Vertical", template: "vertical-1080", open: false });
  assert.equal(readProject(dir).name, "Test Project", "open:false leaves the open project alone");

  const out = P.open(made.id);
  assert.equal(out.from, first);
  const now = readProject(dir);
  assert.equal(now.name, "Vertical");
  assert.deepEqual([now.width, now.height, now.fps], [1080, 1920, 30]);
  assert.equal(now.revision, 41, "a save based on the old project (revision ≤ 40) must be refused");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "projects", first, "project.json"), "utf8")).clips.length, 1,
    "the old project was saved into its folder");

  P.open(first);
  const back = readProject(dir);
  assert.equal(back.name, "Test Project");
  assert.equal(back.clips.length, 1);
  assert.equal(back.revision, 42);
  assert.equal(P.open(first).already, true);
});

test("duplicate, rename, notes and tags; archive and delete take two steps", (t) => {
  const { dir, P } = make(t);
  const first = P.activeId();
  const dup = P.duplicate(first);
  assert.equal(dup.project.name, "Test Project copy");
  assert.equal(dup.project.clips, 1);
  assert.equal(readProject(dir).name, "Test Project", "duplicate does not open by default");

  P.update(dup.id, { name: "  Cut B  ", notes: "Client wants it shorter", tags: "acme, #Reel, acme" });
  const row = P.list().projects.find((p) => p.id === dup.id);
  assert.equal(row.name, "Cut B");
  assert.equal(row.notes, "Client wants it shorter");
  assert.deepEqual(row.tags, ["acme", "Reel"]);

  // renaming the open project writes ./project.json with a new revision, so tabs reload
  P.update(first, { name: "Cut A" });
  assert.equal(readProject(dir).name, "Cut A");
  assert.equal(readProject(dir).revision, 2);

  assert.throws(() => P.archive(first), /open project can't be archived/);
  assert.throws(() => P.remove(dup.id), /archive the project first/);
  P.archive(dup.id);
  assert.equal(P.list().projects.length, 1, "archived projects leave the list");
  assert.equal(P.list({ archived: "only" }).projects.length, 1);
  P.remove(dup.id);
  assert.equal(P.list({ archived: "all" }).projects.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "projects", dup.id)), false);
  assert.throws(() => P.open(dup.id), /no project/);
});

test("templates: built-in canvases, and a saved project as a template", (t) => {
  const { dir, P } = make(t);
  const first = P.activeId();
  assert.ok(P.templates().some((x) => x.id === "square-1080" && x.builtin));
  const saved = P.saveTemplate(first, { name: "House style" }).template;
  assert.equal(saved.id, "house-style");
  assert.equal(saved.clips, 1);
  assert.throws(() => P.saveTemplate(first, { name: "Square 1080" }), /built-in/);

  const made = P.create({ name: "From house", template: "house-style", fps: 25 });
  const doc = readProject(dir);
  assert.equal(doc.name, "From house");
  assert.equal(doc.fps, 25);
  assert.equal(doc.clips.length, 1, "the template's clips come along");
  assert.equal(made.project.active, true);

  assert.throws(() => P.create({ template: "nope" }), /no project template "nope"/);
  assert.throws(() => P.create({ width: 1001 }), /even number/);
  P.deleteTemplate("house-style");
  assert.ok(!P.templates().some((x) => x.id === "house-style"));
  assert.throws(() => P.deleteTemplate("landscape-1080"), /built-in/);
});

test("import takes a project file from elsewhere; a non-project is refused", (t) => {
  const { P } = make(t);
  P.activeId();
  const out = P.importDoc(seedProject({ name: "Old backup", revision: 300 }));
  assert.equal(out.project.name, "Old backup");
  assert.throws(() => P.importDoc({ hello: 1 }), /not a FableCut project/);
});

test("a project that can't be read is never switched over", (t) => {
  const { dir, P } = make(t);
  P.activeId();
  const other = P.create({ name: "Other", open: false });
  fs.writeFileSync(path.join(dir, "project.json"), "{ broken");
  assert.throws(() => P.open(other.id), /project.json can't be read/);
  assert.equal(fs.readFileSync(path.join(dir, "project.json"), "utf8"), "{ broken", "nothing was overwritten");
});

test("a switch that fails halfway puts the open project back", (t) => {
  const { dir, P } = make(t, seedProject({ revision: 9 }));
  const first = P.activeId();
  const other = P.create({ name: "Other", open: false });
  const rename = fs.renameSync;
  // the index write fails (Windows: EPERM while something holds the file)
  fs.renameSync = (from, to) => { if (to === P.INDEX) throw Object.assign(new Error("EPERM: busy"), { code: "EPERM" }); return rename(from, to); };
  try {
    assert.throws(() => P.open(other.id), new RegExp(`switching to ${other.id} failed .*${first} is still open`));
  } finally { fs.renameSync = rename; }
  const doc = readProject(dir);
  assert.equal(doc.name, "Test Project", "./project.json is the open project again");
  assert.ok(doc.revision > 10, "with a revision above the one the failed switch wrote, so tabs reload it");
  assert.equal(P.activeId(), first);
});

test("REST: list, create and open; GET /api/project names the open project", async (t) => {
  const dir = makeDataDir(t);
  const { base } = await startServer(t, dir, NO_WATCH);

  let res = await fetch(base + "/api/project");
  assert.equal(res.headers.get("X-FableCut-Projects"), "1");
  assert.equal(res.headers.get("X-FableCut-Project"), null, "no id before projects are used");

  const list = await (await fetch(base + "/api/projects")).json();
  assert.equal(list.projects.length, 1);
  assert.ok(list.templates.length >= 6);
  res = await fetch(base + "/api/project");
  assert.equal(res.headers.get("X-FableCut-Project"), list.active);

  res = await post(base, { action: "new", name: "Reel", template: "vertical-1080" });
  assert.equal(res.status, 200);
  const made = await res.json();
  assert.equal(made.from, list.active);
  assert.equal(readProject(dir).name, "Reel");
  res = await fetch(base + "/api/project");
  assert.equal(res.headers.get("X-FableCut-Project"), made.id);

  // a tab that still holds the old project can't save over the new one
  res = await fetch(base + "/api/project", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...seedProject(), revision: 2 }),
  });
  assert.equal(res.status, 409);
  assert.equal(readProject(dir).name, "Reel");

  // even a newer revision is refused when the editor says it was made for another project
  res = await fetch(base + "/api/project", {
    method: "PUT", headers: { "Content-Type": "application/json", "X-FableCut-Project": list.active },
    body: JSON.stringify({ ...seedProject(), revision: 999 }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /another project is open/);
  assert.equal(readProject(dir).name, "Reel");
  res = await fetch(base + "/api/project", {
    method: "PUT", headers: { "Content-Type": "application/json", "X-FableCut-Project": made.id },
    body: JSON.stringify({ ...readProject(dir), revision: 999 }),
  });
  assert.equal(res.status, 200, "a save for the open project goes through");

  res = await post(base, { action: "open", id: "p_nope" });
  assert.equal(res.status, 404);
  res = await post(base, { action: "fly" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown action/);
});

test("REST: thumbnails are JPEG only", async (t) => {
  const dir = makeDataDir(t);
  const { base } = await startServer(t, dir, NO_WATCH);
  const { active } = await (await fetch(base + "/api/projects")).json();
  const url = base + "/api/projects/thumb?id=" + active;
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(url, { method: "PUT", body: "not a jpeg" })).status, 400);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  assert.equal((await fetch(url, { method: "PUT", body: jpeg })).status, 200);
  const got = await fetch(url);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), jpeg);
  const listed = (await (await fetch(base + "/api/projects")).json()).projects[0];
  assert.ok(listed.thumb > 0, "the list says a thumbnail exists (and its version)");
});

test("fablecut_projects: list, new, open and refusals, through the editor server", async (t) => {
  const dir = makeDataDir(t);
  const { port } = await startServer(t, dir, NO_WATCH);
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: "1" });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });

  let r = await mcp.callTool("fablecut_projects", {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /1 project\(s\)/);
  assert.match(r.text, /"Test Project" \(OPEN\)/);
  assert.match(r.text, /landscape-1080/);

  r = await mcp.callTool("fablecut_projects", { action: "new", name: "Teaser", template: "square-1080", notes: "for IG" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Opened p_\w+ "Teaser" \(OPEN\) — 1080x1080@30/);
  assert.match(r.text, /notes: for IG/);
  assert.equal(readProject(dir).name, "Teaser");

  const doc = JSON.parse((await mcp.callTool("fablecut_get_project")).text);
  assert.equal(doc.width, 1080, "the other tools now see the new project");

  r = await mcp.callTool("fablecut_projects", { action: "archive", id: "p_nope" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no project "p_nope"/);

  r = await mcp.callTool("fablecut_projects", { action: "save_template", id: JSON.parse(fs.readFileSync(path.join(dir, "projects", "index.json"), "utf8")).active, name: "Square IG" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Saved template square-ig/);
});
