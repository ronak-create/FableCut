/* server.js: the REST contract the editor UI and external tools rely on, plus
   the guards that keep a localhost file API from becoming a hole in the box.
   Each test gets its own port and data dir, so they are safe to run in parallel
   and never touch the developer's real project. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
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
    // HTTP to 127.0.0.1 only — LAN / metadata stay blocked (see SECURITY.md).
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

  const lan = await fetch(base + "/api/import-url", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://192.168.1.9/a.mp4" }),
  });
  assert.equal(lan.status, 400);
  assert.match((await lan.json()).error, /blocked/i);
});

test("GET /api/media lists the media folder", async (t) => {
  const { base } = await boot(t);
  const res = await fetch(base + "/api/media");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("GET /api/video-index serves safe H.264 sample ranges for VideoDecoder", async (t) => {
  const dir = makeDataDir(t);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures", "video-index.mp4"),
    path.join(dir, "media", "indexed.mp4"));
  const { base } = await startServer(t, dir);
  const res = await fetch(base + "/api/video-index?src=" +
    encodeURIComponent("/media/indexed.mp4"));
  assert.equal(res.status, 200);
  const index = await res.json();
  assert.equal(index.src, "/media/indexed.mp4");
  assert.equal(index.width, 32);
  assert.equal(index.height, 24);
  assert.equal(index.samples.length, 2);
  assert.match(index.codec, /^avc1\./);

  const sample = index.samples[0];
  const bytes = await fetch(base + index.src, {
    headers: { Range: `bytes=${sample.offset}-${sample.offset + sample.size - 1}` },
  });
  assert.equal(bytes.status, 206);
  assert.equal((await bytes.arrayBuffer()).byteLength, sample.size);

  const traversal = await fetch(base + "/api/video-index?src=" +
    encodeURIComponent("/media/../../server.js"));
  assert.equal(traversal.status, 404);
});

test("GET /api/export/ffmpeg reports encoder availability", async (t) => {
  const { base } = await boot(t);
  const body = await (await fetch(base + "/api/export/ffmpeg")).json();
  // Both answers are legitimate — CI may or may not have ffmpeg. What matters
  // is that the UI gets a definite boolean and can pick an export engine.
  assert.equal(typeof body.available, "boolean");
});

test("POST /api/export/begin validates the encoding profile", async (t) => {
  const { base } = await boot(t);

  const listed = await (await fetch(base + "/api/export/profiles")).json();
  assert.ok(listed.profiles.delivery, "GET /api/export/profiles must list the shipped delivery profile");
  assert.equal(listed.profiles.delivery.args, undefined, "the compact listing omits args");

  const unknown = await fetch(base + "/api/export/begin", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fps: 30, name: "t", profile: "no-such-profile", hasAudio: false }),
  });
  assert.equal(unknown.status, 400, "an unknown profile id is a client error, not a 500");
  const unknownBody = await unknown.json();
  assert.match(unknownBody.error, /Unknown encoding profile/i);

  const ffmpeg = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ffmpeg.available) return;

  const ok = await fetch(base + "/api/export/begin", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fps: 30, name: "profile-test", profile: "draft", hasAudio: false }),
  });
  const body = await ok.json();
  assert.equal(ok.status, 200, body.error);
  assert.equal(body.profile, "draft");
  assert.ok(body.id, "a valid profile starts a session");
  const end = await fetch(base + "/api/export/end?id=" + encodeURIComponent(body.id) + "&discard=1",
    { method: "POST" });
  assert.equal(end.status, 200);
});

test("buildExportArgs uses raw RGBA when the client asks for it", () => {
  const { buildExportArgs, resolveProfile } = require("../encode-profiles");
  const args = buildExportArgs(resolveProfile("draft"), {
    fps: 50, outPath: "out.mp4", pixelFormat: "rgba", width: 1920, height: 1080,
  });
  assert.ok(args.includes("rawvideo"));
  assert.equal(args[args.indexOf("-s") + 1], "1920x1080");
  assert.ok(args.indexOf("-f") < args.indexOf("-i"));
});

test("buildExportArgs still accepts JPEG image2pipe for older clients", () => {
  const { buildExportArgs, resolveProfile } = require("../encode-profiles");
  const args = buildExportArgs(resolveProfile("draft"), { fps: 30, outPath: "out.mp4" });
  const i = args.indexOf("-thread_queue_size");
  assert.ok(i >= 0);
  assert.equal(args[args.indexOf("-c:v") + 1], "mjpeg");
  assert.ok(args.indexOf("-c:v") < args.indexOf("-i"));
});

test("POST /api/export/frame accepts concatenated RGBA frames", async (t) => {
  const { dir, base } = await boot(t);
  const ffmpeg = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ffmpeg.available) return;

  const w = 64, h = 64;
  const frame = Buffer.alloc(w * h * 4, 0);
  for (let i = 3; i < frame.length; i += 4) frame[i] = 255;

  const begin = await fetch(base + "/api/export/begin", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fps: 30, name: "batch-rgba", profile: "draft", hasAudio: false,
      pixelFormat: "rgba", width: w, height: h,
    }),
  });
  const sess = await begin.json();
  assert.equal(begin.status, 200, sess.error);

  const posted = await fetch(base + "/api/export/frame?id=" + encodeURIComponent(sess.id), {
    method: "POST", body: Buffer.concat([frame, frame, frame]),
  });
  assert.equal(posted.status, 200, (await posted.json().catch(() => ({}))).error);

  const end = await fetch(base + "/api/export/end?id=" + encodeURIComponent(sess.id), { method: "POST" });
  const out = await end.json();
  assert.equal(end.status, 200, out.error);
  assert.match(out.src, /^\/exports\//);
  const file = path.join(dir, "exports", decodeURIComponent(out.src.split("/").pop()));
  assert.ok(fs.existsSync(file), "batched RGBA frames should mux into a finished file");
});

test("Fast JPEG image2pipe does not duplicate unique frames", async (t) => {
  const { dir, base } = await boot(t);
  const ffmpeg = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ffmpeg.available) return;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fc-jpeg-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const n = 12;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const jpg = path.join(tmp, `in${i}.jpg`);
    const hex = (v) => v.toString(16).padStart(2, "0");
    const c = `${hex(i * 18)}${hex(40)}${hex(255 - i * 12)}`;
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=#${c}:s=64x64:d=0.04`,
      "-frames:v", "1", jpg,
    ]);
    parts.push(fs.readFileSync(jpg));
  }

  const begin = await fetch(base + "/api/export/begin", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fps: 30, name: "unique-jpeg", profile: "draft", hasAudio: false }),
  });
  const sess = await begin.json();
  assert.equal(begin.status, 200, sess.error);

  const posted = await fetch(base + "/api/export/frame?id=" + encodeURIComponent(sess.id), {
    method: "POST", body: Buffer.concat(parts),
  });
  assert.equal(posted.status, 200, (await posted.json().catch(() => ({}))).error);

  const end = await fetch(base + "/api/export/end?id=" + encodeURIComponent(sess.id), { method: "POST" });
  const out = await end.json();
  assert.equal(end.status, 200, out.error);
  const file = path.join(dir, "exports", decodeURIComponent(out.src.split("/").pop()));

  const ex = path.join(tmp, "ex");
  fs.mkdirSync(ex);
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", file, path.join(ex, "f%02d.png"),
  ]);
  const pngs = fs.readdirSync(ex).filter((f) => f.endsWith(".png")).sort();
  assert.equal(pngs.length, n, "output frame count should match unique JPEGs posted");
  const hashes = pngs.map((f) => crypto.createHash("md5").update(fs.readFileSync(path.join(ex, f))).digest("hex"));
  assert.equal(new Set(hashes).size, n, "ffmpeg must not duplicate unique JPEG frames");
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
