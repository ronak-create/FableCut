/* The files in media/ (media-files.js, POST /api/files, fablecut_files): folders,
   moves that repoint every project's media entries, and a trash that never
   deletes. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createMediaFiles } = require("../media-files");
const { makeDataDir, readProject, seedProject, startServer, startMcp } = require("./helpers");

function mediaDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const put = (root, rel, body = "x") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

test("list, mkdir and move: files and folders, renames, srcs of everything that moved", (t) => {
  const root = mediaDir(t);
  put(root, "WhatsApp Video 1.mp4", "abc");
  put(root, "b.png");
  const F = createMediaFiles({ mediaDir: root });

  assert.deepEqual(F.mkdir("b-roll/day 1"), { dir: "b-roll/day 1" });
  const top = F.list();
  assert.deepEqual(top.folders, ["b-roll"]);
  assert.deepEqual(top.files.map((f) => f.name), ["b.png", "WhatsApp Video 1.mp4"]);
  assert.equal(top.files[1].src, "/media/WhatsApp%20Video%201.mp4");
  assert.equal(top.files[1].size, 3);

  // into an existing folder keeps the name
  assert.deepEqual(F.move("/media/WhatsApp%20Video%201.mp4", "b-roll/day 1").moved,
    [{ from: "/media/WhatsApp%20Video%201.mp4", to: "/media/b-roll/day%201/WhatsApp%20Video%201.mp4" }]);
  // a new path renames
  assert.deepEqual(F.move("b-roll/day 1/WhatsApp Video 1.mp4", "b-roll/day 1/salon.mp4").moved,
    [{ from: "/media/b-roll/day%201/WhatsApp%20Video%201.mp4", to: "/media/b-roll/day%201/salon.mp4" }]);
  // a folder moves with everything in it
  assert.deepEqual(F.move("b-roll", "footage").moved, [{ from: "/media/b-roll/day%201/salon.mp4", to: "/media/footage/day%201/salon.mp4" }]);
  assert.ok(fs.existsSync(path.join(root, "footage", "day 1", "salon.mp4")));

  assert.throws(() => F.move("b.png", "footage/day 1/salon.mp4"), /already exists/);
  assert.throws(() => F.move("footage", "footage/day 1"), /into itself/);
  assert.throws(() => F.move("nope.mp4", "x.mp4"), /no file or folder/);
  for (const bad of ["../escape.mp4", "a/../../b", ".trash/x", "/media/..%2Fx", "a:b.mp4"])
    assert.throws(() => F.move("b.png", bad), /not a path inside media|isn't allowed|bad path/, bad);
  assert.throws(() => F.list("../"), /not a path inside media/);
});

test("trash moves into media/.trash and restore puts it back; nothing is deleted, the trash is not listed", (t) => {
  const root = mediaDir(t);
  put(root, "old/a.mp4", "aaaa");
  put(root, "old/b.mp4");
  put(root, "c.wav", "cc");
  const F = createMediaFiles({ mediaDir: root });

  assert.deepEqual(F.filesOf("old"), ["/media/old/a.mp4", "/media/old/b.mp4"]);
  const r = F.trash(["old", "c.wav"]);
  assert.equal(r.trashed.length, 2);
  assert.ok(!fs.existsSync(path.join(root, "old")) && !fs.existsSync(path.join(root, "c.wav")));
  assert.deepEqual(F.list().folders, [], "the trash is a dot-folder: not listed");
  const items = F.trashList();
  assert.deepEqual(items.map((i) => i.src).sort(), ["/media/c.wav", "/media/old"]);
  assert.equal(items.find((i) => i.src === "/media/old").kind, "folder");
  assert.equal(items.find((i) => i.src === "/media/c.wav").size, 2);

  const folder = items.find((i) => i.src === "/media/old");
  put(root, "old/new.txt");
  assert.throws(() => F.restore(folder.id), /exists again/);
  fs.rmSync(path.join(root, "old"), { recursive: true });
  assert.deepEqual(F.restore(folder.id).restored, { id: folder.id, src: "/media/old" });
  assert.equal(fs.readFileSync(path.join(root, "old", "a.mp4"), "utf8"), "aaaa");
  assert.equal(F.trashList().length, 1);
  assert.throws(() => F.restore("../x"), /no trashed item/);
  assert.throws(() => F.restore(folder.id), /no trashed item/);
});

test("POST /api/files and fablecut_files: a move repoints every project and keeps the transcript; trash refuses a used file", async (t) => {
  const dir = makeDataDir(t, seedProject({
    media: [
      { id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 },
      { id: "m_s", name: "Spare take", kind: "video", src: "/media/spare.mp4", duration: 4 },
    ],
  }));
  fs.mkdirSync(path.join(dir, "media"));
  fs.writeFileSync(path.join(dir, "media", "a.mp4"), "video");
  fs.writeFileSync(path.join(dir, "media", "spare.mp4"), "spare");
  fs.writeFileSync(path.join(dir, "media", "unused.mp4"), "u");
  // a parked project that uses the same file
  fs.mkdirSync(path.join(dir, "projects", "p_0000000001"), { recursive: true });
  fs.writeFileSync(path.join(dir, "projects", "p_0000000001", "meta.json"), JSON.stringify({ id: "p_0000000001", created: "2026-01-01T00:00:00Z" }));
  fs.writeFileSync(path.join(dir, "projects", "p_0000000001", "project.json"), JSON.stringify(seedProject({ name: "Other" })));
  const { base, port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const post = (body) => fetch(base + "/api/files", { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // a transcript for a.mp4, saved the way the tab saves one
  const tr = { v: 1, src: "/media/a.mp4", model: "base", language: "en", duration: 10, created: "2026-01-01T00:00:00Z", words: [["hello", 0, 0.5]] };
  assert.equal((await fetch(base + "/api/transcript?src=/media/a.mp4", { method: "POST", body: JSON.stringify(tr) })).status, 200);

  const rev = readProject(dir).revision;
  const moved = await post({ action: "move", from: "a.mp4", to: "footage/salon promo.mp4" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body.moved, [{ from: "/media/a.mp4", to: "/media/footage/salon%20promo.mp4" }]);
  assert.deepEqual(moved.body.repointed.map((x) => [x.project, x.open, x.media]).sort(), [["Other", false, 1], ["Test Project", true, 1]]);
  const doc = readProject(dir);
  assert.equal(doc.media[0].src, "/media/footage/salon%20promo.mp4");
  assert.equal(doc.media[0].name, "salon promo.mp4", "a name that was the file name follows it");
  assert.equal(doc.revision, rev + 1, "the open project gets a new revision");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "projects", "p_0000000001", "project.json"), "utf8")).media[0].src, "/media/footage/salon%20promo.mp4");
  const after = await fetch(base + "/api/transcript?src=" + encodeURIComponent("/media/footage/salon promo.mp4")).then((r) => r.json());
  assert.deepEqual(after.transcript.words, [["hello", 0, 0.5]], "the transcript follows the file");

  // a used file is refused, an unused one goes, force trashes a used one
  const refused = await post({ action: "trash", paths: ["footage"] });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /in use — "salon promo.mp4" in the open project \(1 clip\)/);
  assert.ok(fs.existsSync(path.join(dir, "media", "footage", "salon promo.mp4")), "nothing moved");
  assert.equal((await post({ action: "trash", paths: ["unused.mp4"] })).status, 200);

  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: "1" });
  const list = await mcp.callTool("fablecut_files", {});
  assert.match(list.content[0].text, /media\/ — 1 folder, 1 file\n {2}footage\/\n {2}spare\.mp4/);
  const tr2 = await mcp.callTool("fablecut_files", { action: "trash", paths: ["spare.mp4"], force: true });
  assert.match(tr2.content[0].text, /Trashed spare\.mp4 \(id t\w+/);
  assert.match(tr2.content[0].text, /Now OFFLINE: "Spare take" in the open project/);
  const trash = await mcp.callTool("fablecut_files", { action: "trash-list" });
  const id = /^(t\w+)\s+spare\.mp4/m.exec(trash.content[0].text)[1];
  assert.match((await mcp.callTool("fablecut_files", { action: "restore", id })).content[0].text, /Restored spare\.mp4/);
  assert.equal(fs.readFileSync(path.join(dir, "media", "spare.mp4"), "utf8"), "spare");
  const bad = await mcp.callTool("fablecut_files", { action: "move", from: "../project.json", to: "x.json" });
  assert.equal(bad.isError, true);
});

test("trash keeps a file named item.json intact, refuses overlaps and links; move needs a destination; an empty folder's move is reported", (t) => {
  const root = mediaDir(t);
  put(root, "item.json", "the user's own file");
  put(root, "shoot/a.mp4");
  put(root, "media/b.mp4");
  fs.mkdirSync(path.join(root, "empty"));
  const F = createMediaFiles({ mediaDir: root });

  const { trashed: [it] } = F.trash(["item.json"]);
  F.restore(it.id);
  assert.equal(fs.readFileSync(path.join(root, "item.json"), "utf8"), "the user's own file", "the payload and the note never share a name");

  assert.throws(() => F.trash(["shoot", "shoot/a.mp4"]), /inside "shoot"/);
  assert.throws(() => F.trash(["shoot", "shoot"]), /listed twice/);
  assert.ok(fs.existsSync(path.join(root, "shoot", "a.mp4")), "nothing moved");

  assert.throws(() => F.move("shoot/a.mp4"), /say where to move it/);
  assert.equal(F.move("shoot/a.mp4", "/media/").to, "/media/a.mp4", "\"/media/\" is the top of media/");
  const empty = F.move("empty", "still-empty");
  assert.deepEqual([empty.from, empty.to, empty.moved.length], ["/media/empty", "/media/still-empty", 0]);

  // a folder literally named "media" restores to itself, not to the top
  const { trashed: [m] } = F.trash(["/media/media"]);
  assert.deepEqual(F.restore(m.id).restored, { id: m.id, src: "/media/media" });
  assert.ok(fs.existsSync(path.join(root, "media", "b.mp4")));

  let linked = false;
  try { fs.symlinkSync(os.tmpdir(), path.join(root, "out"), "junction"); linked = true; } catch { }
  if (linked) {
    assert.throws(() => F.move("out/anything", "x"), /is a link/);
    assert.throws(() => F.mkdir("out/new"), /is a link/);
    assert.ok(!F.list().folders.includes("out"), "links aren't listed");
  }
});

test("POST /api/files: force must be true, and a project that can't be read blocks an unforced trash", async (t) => {
  const dir = makeDataDir(t, seedProject({ media: [] }));
  fs.mkdirSync(path.join(dir, "media"));
  fs.writeFileSync(path.join(dir, "media", "x.mp4"), "x");
  fs.mkdirSync(path.join(dir, "projects", "p_0000000002"), { recursive: true });
  fs.writeFileSync(path.join(dir, "projects", "p_0000000002", "meta.json"), JSON.stringify({ id: "p_0000000002" }));
  fs.writeFileSync(path.join(dir, "projects", "p_0000000002", "project.json"), "{ not json");
  const { base } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const post = (body) => fetch(base + "/api/files", { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await post({ action: "trash", paths: ["x.mp4"], force: "false" })).status, 400);
  const r = await post({ action: "trash", paths: ["x.mp4"] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /can't check project p_0000000002/);
  assert.equal((await post({ action: "trash", paths: ["x.mp4"], force: true })).status, 200);
});
