/* server.js: the REST contract the editor UI and external tools rely on, plus
   the guards that keep a localhost file API from becoming a hole in the box.
   Each test gets its own port and data dir, so they are safe to run in parallel
   and never touch the developer's real project. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { makeDataDir, readProject, seedProject, startServer, rawGet } = require("./helpers");

const boot = async (t, project) => {
  const dir = makeDataDir(t, project);
  const { base } = await startServer(t, dir);
  return { dir, base };
};

test("GET /api/project serves the document on disk", async (t) => {
  const { base } = await boot(t);
  const res = await fetch(base + "/api/project");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await res.json(), seedProject());
});

test("PUT /api/project saves a newer revision", async (t) => {
  const { dir, base } = await boot(t);
  const doc = { ...seedProject(), revision: 2, name: "Saved" };
  const res = await fetch(base + "/api/project", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revision: 2 });
  assert.equal(readProject(dir).name, "Saved");
});

test("PUT /api/project rejects a stale write instead of clobbering it", async (t) => {
  const { dir, base } = await boot(t);
  // revision 1 is already on disk: an equal or lower revision is a stale read.
  for (const revision of [1, 0, undefined]) {
    const res = await fetch(base + "/api/project", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...seedProject(), revision, name: "Clobbered" }),
    });
    assert.equal(res.status, 409, `revision ${revision} should conflict`);
    const body = await res.json();
    assert.match(body.error, /stale revision/);
    assert.equal(body.revision, 1, "the response tells the client where disk actually is");
  }
  assert.equal(readProject(dir).name, "Test Project", "a rejected write must not land");
});

test("PUT /api/project?force=1 overwrites deliberately", async (t) => {
  const { dir, base } = await boot(t);
  const res = await fetch(base + "/api/project?force=1", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...seedProject(), revision: 1, name: "Forced" }),
  });
  assert.equal(res.status, 200);
  assert.equal(readProject(dir).name, "Forced");
});

test("PUT /api/project rejects malformed JSON without corrupting the file", async (t) => {
  const { dir, base } = await boot(t);
  const res = await fetch(base + "/api/project", { method: "PUT", body: "{not json" });
  assert.equal(res.status, 400);
  assert.deepEqual(readProject(dir), seedProject());
});

test("GET /api/library lists assets and validates the dir argument", async (t) => {
  const { base } = await boot(t);
  const res = await fetch(base + "/api/library?dir=svg");
  assert.equal(res.status, 200);
  const items = await res.json();
  assert.ok(items.length > 0, "the shipped SVG library should be seeded into the data dir");
  for (const item of items) {
    assert.ok(item.src.startsWith("/library/svg/"), `bad src: ${item.src}`);
    assert.equal(typeof item.size, "number");
  }
  // A served src must actually resolve — a listing that links to 404s is useless.
  const one = await fetch(base + items[0].src);
  assert.equal(one.status, 200);
  assert.match(one.headers.get("content-security-policy") || "", /sandbox/);
  await one.arrayBuffer();

  for (const bad of ["", "bogus", "../..", "sfx/../../.."]) {
    const r = await fetch(base + "/api/library?dir=" + encodeURIComponent(bad));
    assert.equal(r.status, 400, `dir=${bad} should be refused`);
    await r.text();
  }
});

test("POST /api/import-url rejects non-https and private targets", async (t) => {
  const { dir, base } = await boot(t);
  const reject = async (url, expect) => {
    const res = await fetch(base + "/api/import-url", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    assert.equal(res.status, 400, url);
    const body = await res.json();
    assert.match(body.error, expect, url);
  };
  await reject("http://example.com/a.mp4", /https/i);
  await reject("file:///etc/passwd", /https|invalid/i);
  await reject("https://127.0.0.1/a.mp4", /blocked/i);
  await reject("https://localhost/a.mp4", /blocked/i);
  await reject("https://192.168.1.9/a.mp4", /blocked/i);
  await reject("https://169.254.169.254/latest/meta-data", /blocked/i);
  assert.equal(fs.readdirSync(path.join(dir, "media")).length, 0);
});

test("POST /api/import-url downloads into media and returns a same-origin src", async (t) => {
  const dir = makeDataDir(t);
  const fixture = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/clip.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end("fake-mp4-bytes");
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
  t.after(() => fixture.server.close());
  const { base } = await startServer(t, dir, {
    FABLECUT_TEST_IMPORT_ALLOW_PRIVATE: "1",
    // libuv fs.watch on Windows aborts the process when a file is created under
    // a Temp data dir (uv assertion in fs-event.c). This test only needs the
    // HTTP handler to finish writing the file.
    FABLECUT_NO_FS_WATCH: "1",
  });
  const res = await fetch(base + "/api/import-url", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: fixture.url + "/clip.mp4" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, "clip.mp4");
  assert.equal(body.src, "/media/clip.mp4");
  assert.equal(fs.readFileSync(path.join(dir, "media", "clip.mp4"), "utf8"), "fake-mp4-bytes");
});

test("GET /api/media lists the media folder", async (t) => {
  const { base } = await boot(t);
  const res = await fetch(base + "/api/media");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("GET /api/export/ffmpeg reports encoder availability", async (t) => {
  const { base } = await boot(t);
  const body = await (await fetch(base + "/api/export/ffmpeg")).json();
  // Both answers are legitimate — CI may or may not have ffmpeg. What matters
  // is that the UI gets a definite boolean and can pick an export engine.
  assert.equal(typeof body.available, "boolean");
});

test("the app shell and its assets are served", async (t) => {
  const { base } = await boot(t);
  const index = await fetch(base + "/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(await index.text(), /<canvas|<body/i);

  const js = await fetch(base + "/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  await js.text();

  const missing = await fetch(base + "/nope.js");
  assert.equal(missing.status, 404);
  await missing.text();
});

test("requests from a foreign Host or Origin are refused (DNS-rebinding guard)", async (t) => {
  const dir = makeDataDir(t);
  const { port } = await startServer(t, dir);
  // A page on evil.example resolving its own hostname to 127.0.0.1 must not
  // reach the API — otherwise any website could read and rewrite the timeline.
  const byHost = await rawGet(port, "/api/project", { Host: "evil.example" });
  assert.equal(byHost.status, 403);
  assert.match(byHost.body, /forbidden/);

  const byOrigin = await rawGet(port, "/api/project",
    { Host: `127.0.0.1:${port}`, Origin: "http://evil.example" });
  assert.equal(byOrigin.status, 403);

  // The legitimate cases still work.
  for (const headers of [{ Host: `localhost:${port}` }, { Host: `127.0.0.1:${port}` },
    { Host: `localhost:${port}`, Origin: `http://localhost:${port}` }]) {
    const ok = await rawGet(port, "/api/project", headers);
    assert.equal(ok.status, 200, `legit request refused: ${JSON.stringify(headers)}`);
  }
});

test("traversal out of the served roots and dot-directories are refused", async (t) => {
  const dir = makeDataDir(t);
  const { port } = await startServer(t, dir);
  const host = { Host: `127.0.0.1:${port}` };

  // A file outside both the app dir and the data dir. The data dir is itself a
  // temp dir, so this sits one level up from it — a reachable target if the
  // path guards were missing.
  const canary = path.join(os.tmpdir(), "fablecut-canary-secret.txt");
  fs.writeFileSync(canary, "CANARY_MUST_NOT_BE_SERVED");
  t.after(() => fs.rmSync(canary, { force: true }));

  // Percent-encoded separators survive URL normalisation and reach the guard.
  const escapes = [
    "/library/..%2f..%2fproject.json",
    "/library/svg/..%2f..%2f..%2fserver.js",
    "/library/..%2f..%2f..%2f..%2ffablecut-canary-secret.txt",
  ];
  for (const p of escapes) {
    const res = await rawGet(port, p, host);
    assert.equal(res.status, 403, `${p} escaped the library root (got ${res.status})`);
  }

  // A backslash is a separator on Windows but an ordinary filename character on
  // POSIX, so the status legitimately differs by platform — what must hold
  // everywhere is that it never returns the file.
  const backslash = await rawGet(port, "/library/..%5c..%5cserver.js", host);
  assert.notEqual(backslash.status, 200, "backslash traversal served a file");
  assert.doesNotMatch(backslash.body, /createServer/, "backslash traversal leaked source");

  // Dot-directories and dotfiles are never served, however they are reached.
  for (const p of ["/.git/config", "/.env", "/library/../.env"]) {
    const res = await rawGet(port, p, host);
    assert.equal(res.status, 403, `${p} was not refused (got ${res.status})`);
  }

  // Whatever a payload normalises to, nothing outside the roots may come back.
  for (const p of [...escapes, "/%2e%2e/fablecut-canary-secret.txt",
    "/../fablecut-canary-secret.txt", "/library/%2e%2e/%2e%2e/project.json"]) {
    const res = await rawGet(port, p, host);
    assert.doesNotMatch(res.body, /CANARY_MUST_NOT_BE_SERVED/, `${p} leaked a file outside the roots`);
  }

  // The guard must not break legitimate nested library paths.
  const ok = await rawGet(port, "/library/svg/sparkles.svg", host);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /<svg/);
});
