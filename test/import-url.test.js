/* import-url.js: SSRF guards and the download-to-disk path used by
   /api/import-url and fablecut_import_media. Happy-path download uses a local
   HTTP server with allowPrivate — production callers never pass that flag. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseImportUrl, isBlockedIp, isBlockedHostname, filenameFrom,
  kindFromName, downloadImportUrl,
} = require("../import-url");

test("parseImportUrl accepts https and rejects everything else", () => {
  const u = parseImportUrl("https://cdn.example.com/a.mp4");
  assert.equal(u.hostname, "cdn.example.com");
  assert.equal(u.pathname, "/a.mp4");

  for (const raw of ["http://cdn.example.com/a.mp4", "file:///etc/passwd",
    "ftp://cdn.example.com/a.mp4", "not a url", "", "https://user:pass@cdn.example.com/a.mp4"]) {
    assert.throws(() => parseImportUrl(raw), /https|invalid URL|credentials/i, raw);
  }
});

test("localhost and private hosts are blocked before any fetch", () => {
  for (const host of ["localhost", "foo.localhost", "metadata.google.internal",
    "box.local", "nas.internal", "127.0.0.1", "10.0.0.5", "192.168.1.9",
    "172.16.4.1", "169.254.169.254", "100.64.1.2", "[::1]"]) {
    assert.throws(() => parseImportUrl(`https://${host}/x.mp4`), /blocked/i, host);
  }
  assert.equal(isBlockedHostname("cdn.example.com"), false);
});

test("isBlockedIp covers IPv4 private, loopback, link-local, CGNAT, multicast", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1",
    "172.31.255.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fe80::1", "fc00::1", "fd12::1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp("1.1.1.1"), false);
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("2001:4860:4860::8888"), false);
  assert.equal(isBlockedIp("172.32.0.1"), false, "172.32 is public");
  assert.equal(isBlockedIp("100.63.255.1"), false, "below CGNAT");
});

test("filenameFrom prefers Content-Disposition then the URL path", () => {
  const u = new URL("https://cdn.example.com/guid/clip.mp4?sig=1");
  assert.equal(filenameFrom(u, {}), "clip.mp4");
  assert.equal(filenameFrom(u, { "content-disposition": 'attachment; filename="hero.mov"' }), "hero.mov");
  assert.equal(filenameFrom(new URL("https://cdn.example.com/guid"), {
    "content-type": "video/mp4",
  }), "guid.mp4");
  assert.equal(kindFromName("hero.mov"), "video");
  assert.equal(kindFromName("whoosh.mp3"), "audio");
  assert.equal(kindFromName("sticker.svg"), "svg");
  assert.equal(kindFromName("notes.txt"), null);
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("downloadImportUrl streams a file when allowPrivate is set (test hook)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-import-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, url } = await listen((req, res) => {
    if (req.url === "/clip.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end("fake-mp4-bytes");
      return;
    }
    if (req.url === "/go") {
      res.writeHead(302, { Location: "/renamed.bin" });
      res.end();
      return;
    }
    if (req.url === "/renamed.bin") {
      res.writeHead(200, {
        "Content-Type": "video/webm",
        "Content-Disposition": 'attachment; filename="from-header.webm"',
      });
      res.end("webm-bytes");
      return;
    }
    res.writeHead(404); res.end();
  });
  t.after(() => server.close());

  const a = await downloadImportUrl(url + "/clip.mp4", dir, { allowPrivate: true });
  assert.equal(a.name, "clip.mp4");
  assert.equal(fs.readFileSync(a.target, "utf8"), "fake-mp4-bytes");

  const b = await downloadImportUrl(url + "/go", dir, { allowPrivate: true });
  assert.equal(b.name, "from-header.webm");
  assert.equal(fs.readFileSync(b.target, "utf8"), "webm-bytes");
});

test("downloadImportUrl enforces maxBytes and rejects HTML", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-import-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, url } = await listen((req, res) => {
    if (req.url === "/big.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "100" });
      res.end("0123456789");
      return;
    }
    if (req.url === "/page.mp4") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>nope</html>");
      return;
    }
    if (req.url === "/sticker.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      return;
    }
    res.writeHead(404); res.end();
  });
  t.after(() => server.close());

  await assert.rejects(
    downloadImportUrl(url + "/big.mp4", dir, { allowPrivate: true, maxBytes: 4 }),
    /too large/);
  await assert.rejects(
    downloadImportUrl(url + "/page.mp4", dir, { allowPrivate: true }),
    /did not return a media file/);
  await assert.rejects(
    downloadImportUrl(url + "/sticker.svg", dir, { allowPrivate: true }),
    /remote SVG/i);
  assert.equal(fs.readdirSync(dir).length, 0, "failed downloads must not leave a file");
});

test("downloadImportUrl without allowPrivate still refuses http and loopback", async () => {
  await assert.rejects(downloadImportUrl("http://example.com/a.mp4", os.tmpdir()), /https/i);
  await assert.rejects(downloadImportUrl("https://127.0.0.1/a.mp4", os.tmpdir()), /blocked/i);
  await assert.rejects(downloadImportUrl("https://localhost/a.mp4", os.tmpdir()), /blocked/i);
});
