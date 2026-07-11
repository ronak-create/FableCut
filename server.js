/* ═══════════════════════════════════════════════════════════════════════════
   FableCut server — zero-dependency Node.js
   Run:  node server.js   →  http://localhost:7777

   Adds to the browser editor:
     • persistent project      ./project.json      (GET/PUT /api/project)
     • media library folder    ./media/            (served at /media/*, POST /api/upload)
     • live reload             GET /api/events     (SSE; fires when project.json
                                                    or ./media changes on disk)

   Automation: any tool (e.g. Claude Code) can edit project.json or drop files
   into ./media — the browser UI reloads instantly. Schema: see CLAUDE.md.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync, execFile } = require("child_process");

const { analyze } = require("./analyze");

const ROOT = __dirname;
const MEDIA_DIR = path.join(ROOT, "media");
const EXPORTS_DIR = path.join(ROOT, "exports");
const ANALYSIS_DIR = path.join(ROOT, "analysis");
const LIBRARY_DIR = path.join(ROOT, "library");
const LIBRARY_SUBDIRS = ["sfx", "elements", "svg", "fonts"];
const PROJECT_FILE = path.join(ROOT, "project.json");
const PORT = process.env.PORT || 7777;
const HOST = process.env.HOST || "127.0.0.1";

/* Requests must come from the local machine (or an explicitly allowed host).
   The Host check stops DNS rebinding; the Origin check stops malicious web
   pages firing blind cross-origin writes at the API. Opt into LAN use with
   HOST=0.0.0.0 and FABLECUT_ALLOWED_HOSTS=192.168.1.20,mybox.local */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", HOST.toLowerCase()]);
for (const h of (process.env.FABLECUT_ALLOWED_HOSTS || "").split(","))
  if (h.trim()) ALLOWED_HOSTS.add(h.trim().toLowerCase());

function hostAllowed(value) {
  if (!value) return false;
  // strip a :port suffix, but not the colons inside a bare IPv6 address
  const host = value.replace(/^(\[[^\]]*\]|[^:]+)(:\d+)?$/, "$1").toLowerCase();
  return ALLOWED_HOSTS.has(host);
}
function requestAllowed(req) {
  if (!hostAllowed(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { return hostAllowed(new URL(origin).host); } catch { return false; }
  }
  return true;
}

/* ffmpeg powers optional niceties (faststart remux on upload, fast export).
   Everything else works without it. */
let HAS_FFMPEG = false;
try { HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; } catch {}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".m4v": "video/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR);
if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR);
for (const d of LIBRARY_SUBDIRS) fs.mkdirSync(path.join(LIBRARY_DIR, d), { recursive: true });
if (!fs.existsSync(PROJECT_FILE)) {
  fs.writeFileSync(PROJECT_FILE, JSON.stringify({
    name: "Untitled Project", width: 1280, height: 720, fps: 30,
    revision: 0, media: [], clips: [],
  }, null, 2));
}

/* ── SSE clients + file watching ── */
const sseClients = new Set();
function broadcast() {
  for (const res of sseClients) res.write(`data: change\n\n`);
}
let debounce = null;
function onFsChange() {
  clearTimeout(debounce);
  debounce = setTimeout(broadcast, 150);
}
/* watch the directory, not the file — atomic tmp+rename writes would detach a
   direct file watcher on Windows */
try { fs.watch(ROOT, (ev, f) => { if (f === "project.json") onFsChange(); }); } catch {}
try { fs.watch(MEDIA_DIR, onFsChange); } catch {}
for (const d of LIBRARY_SUBDIRS) {
  try { fs.watch(path.join(LIBRARY_DIR, d), onFsChange); } catch {}
}

/* ── Helpers ── */
function safeName(name) {
  return name.replace(/[^\w.\- ()\[\]]+/g, "_").slice(0, 120) || "file";
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function uniquePath(dir, name) {
  let target = path.join(dir, name);
  const ext = path.extname(name), base = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${base}_${i++}${ext}`);
  return target;
}
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, _out, stderr) =>
      err ? reject(new Error((stderr || String(err)).slice(-800))) : resolve());
  });
}

/* Remux MP4-family uploads with `+faststart` so the moov atom leads the file —
   without it <video> stalls for seconds probing over Range requests. */
const FASTSTART_EXT = new Set([".mp4", ".mov", ".m4v"]);
async function faststart(file) {
  if (!HAS_FFMPEG || !FASTSTART_EXT.has(path.extname(file).toLowerCase())) return;
  const tmp = file + ".fs" + path.extname(file);
  try {
    await run("ffmpeg", ["-y", "-i", file, "-c", "copy", "-movflags", "+faststart", tmp]);
    fs.rmSync(file);
    fs.renameSync(tmp, file);
  } catch { try { fs.rmSync(tmp); } catch {} }
}

/* ── Fast export sessions ──
   The browser renders frames with its own compositor and streams them here as
   JPEGs; ffmpeg encodes them (plus an optional WAV mix) into a real MP4. */
const exportSessions = new Map();
function beginExport(fps, name) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-"));
  const videoPath = path.join(dir, "video.mp4");
  const proc = spawn("ffmpeg", [
    "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    videoPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  proc.stdin.on("error", () => {}); // EPIPE if ffmpeg dies mid-stream; surfaced via exit code
  const sess = {
    proc, dir, videoPath, name: safeName(name || "export"),
    wav: null, err: () => stderr,
    done: new Promise((res) => proc.on("close", res)),
  };
  exportSessions.set(id, sess);
  return id;
}
function cleanupExport(id) {
  const s = exportSessions.get(id);
  if (!s) return;
  exportSessions.delete(id);
  try { s.proc.kill(); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
}

/* Static file with HTTP Range support (required for <video> seeking) */
function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1]) : 0;
      let end = m && m[2] ? parseInt(m[2]) : st.size - 1;
      start = Math.min(start, st.size - 1); end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        "Content-Type": type, "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": type, "Content-Length": st.size,
        "Accept-Ranges": "bytes", "Cache-Control": "no-cache",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

/* ── Server ── */
const server = http.createServer(async (req, res) => {
  if (!requestAllowed(req)) {
    sendJSON(res, 403, { error: "forbidden: request must come from this machine (bad Host or Origin header)" });
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);
  // never serve dotfiles/dot-directories (.git, .gitignore, …)
  if (p.split(/[\\/]/).some((seg) => seg.startsWith("."))) { res.writeHead(403); res.end(); return; }

  /* API: project */
  if (p === "/api/project" && req.method === "GET") {
    // strip UTF-8 BOM some editors/PowerShell prepend, which breaks JSON.parse
    try { sendJSON(res, 200, JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8").replace(new RegExp("^\\uFEFF"), ""))); }
    catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/project" && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body.toString("utf8")); // validate JSON
      /* Optimistic concurrency: a write whose revision isn't newer than what's
         on disk was based on a stale read (someone else — the UI or an external
         tool — saved in between). Reject it instead of clobbering their work.
         ?force=1 skips the check for deliberate overwrites. */
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8").replace(new RegExp("^\\uFEFF"), "")); } catch {}
      if ((data.revision || 0) <= (cur.revision || 0) && url.searchParams.get("force") !== "1") {
        sendJSON(res, 409, { error: "stale revision — project changed since it was read", revision: cur.revision || 0 });
        return;
      }
      const tmp = PROJECT_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, PROJECT_FILE);
      sendJSON(res, 200, { ok: true, revision: data.revision });
    } catch (e) { sendJSON(res, 400, { error: String(e) }); }
    return;
  }

  /* API: media library listing */
  if (p === "/api/media" && req.method === "GET") {
    try {
      const files = fs.readdirSync(MEDIA_DIR)
        .filter((f) => fs.statSync(path.join(MEDIA_DIR, f)).isFile())
        .map((f) => ({ name: f, src: "/media/" + encodeURIComponent(f), size: fs.statSync(path.join(MEDIA_DIR, f)).size }));
      sendJSON(res, 200, files);
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: default-asset library listing (./library/{sfx,elements,svg,fonts}) */
  if (p === "/api/library" && req.method === "GET") {
    const dir = url.searchParams.get("dir");
    if (!LIBRARY_SUBDIRS.includes(dir)) { sendJSON(res, 400, { error: "dir must be one of " + LIBRARY_SUBDIRS.join("|") }); return; }
    try {
      const base = path.join(LIBRARY_DIR, dir);
      const out = [];
      const walk = (d, rel) => {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f), r = rel ? rel + "/" + f : f;
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(full, r);
          else out.push({
            name: f, rel: r, size: st.size,
            src: "/library/" + dir + "/" + r.split("/").map(encodeURIComponent).join("/"),
          });
        }
      };
      walk(base, "");
      sendJSON(res, 200, out);
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: upload → saved into ./media */
  if (p === "/api/upload" && req.method === "POST") {
    try {
      let name = safeName(url.searchParams.get("name") || "upload.bin");
      let target = path.join(MEDIA_DIR, name);
      let i = 1;
      const ext = path.extname(name), base = path.basename(name, ext);
      while (fs.existsSync(target)) target = path.join(MEDIA_DIR, `${base}_${i++}${ext}`);
      const body = await readBody(req);
      fs.writeFileSync(target, body);
      await faststart(target);
      sendJSON(res, 200, { ok: true, src: "/media/" + encodeURIComponent(path.basename(target)) });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: fast export (browser-rendered frames → ffmpeg encode) */
  if (p === "/api/export/ffmpeg" && req.method === "GET") {
    sendJSON(res, 200, { available: HAS_FFMPEG });
    return;
  }
  if (p === "/api/export/begin" && req.method === "POST") {
    if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH" }); return; }
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      sendJSON(res, 200, { id: beginExport(opts.fps || 30, opts.name) });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/export/frame" && req.method === "POST") {
    const sess = exportSessions.get(url.searchParams.get("id"));
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      const body = await readBody(req);
      if (sess.proc.exitCode !== null) throw new Error("ffmpeg exited: " + sess.err());
      if (!sess.proc.stdin.write(body))
        await new Promise((r) => sess.proc.stdin.once("drain", r));
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/export/audio" && req.method === "POST") {
    const sess = exportSessions.get(url.searchParams.get("id"));
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      sess.wav = path.join(sess.dir, "audio.wav");
      fs.writeFileSync(sess.wav, await readBody(req));
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/export/end" && req.method === "POST") {
    const id = url.searchParams.get("id");
    const sess = exportSessions.get(id);
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      if (url.searchParams.get("discard")) { cleanupExport(id); sendJSON(res, 200, { ok: true }); return; }
      sess.proc.stdin.end();
      const code = await sess.done;
      if (code !== 0) throw new Error("ffmpeg encode failed: " + sess.err());
      const out = uniquePath(EXPORTS_DIR, sess.name.replace(/\.mp4$/i, "") + ".mp4");
      if (sess.wav && fs.existsSync(sess.wav))
        await run("ffmpeg", ["-y", "-i", sess.videoPath, "-i", sess.wav,
          "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
          "-movflags", "+faststart", out]);
      else
        await run("ffmpeg", ["-y", "-i", sess.videoPath, "-c", "copy", "-movflags", "+faststart", out]);
      cleanupExport(id);
      sendJSON(res, 200, { ok: true, src: "/exports/" + encodeURIComponent(path.basename(out)) });
    } catch (e) { cleanupExport(id); sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: reference analysis → edit blueprint (shots, beats, BPM, energy, music).
     POST body {src:"/media/ref.mp4", threshold?, music?} runs the analysis
     (seconds to ~a minute — decode-bound); GET ?src= returns the cached result. */
  if (p === "/api/analyze" && req.method === "GET") {
    const src = decodeURIComponent(url.searchParams.get("src") || "");
    const f = path.join(ANALYSIS_DIR, path.basename(src, path.extname(src)) + ".json");
    if (!src || !fs.existsSync(f)) { sendJSON(res, 404, { error: "no cached analysis for that src — POST /api/analyze first" }); return; }
    try { sendJSON(res, 200, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/analyze" && req.method === "POST") {
    if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH" }); return; }
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const name = path.basename(decodeURIComponent(opts.src || ""));
      const file = path.join(MEDIA_DIR, name);
      if (!name || !fs.existsSync(file)) { sendJSON(res, 404, { error: "src must name an existing file under /media/" }); return; }
      const bp = await analyze(file, {
        threshold: opts.threshold,
        music: opts.music !== false,
        musicDir: MEDIA_DIR,
        srcUrl: "/media/" + encodeURIComponent(name),
      });
      if (bp.music) bp.music.src = "/media/" + encodeURIComponent(bp.music.name);
      fs.writeFileSync(path.join(ANALYSIS_DIR, path.basename(name, path.extname(name)) + ".json"),
        JSON.stringify(bp, null, 2));
      sendJSON(res, 200, bp);
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: SSE live-reload channel */
  if (p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("data: hello\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  /* Media files */
  if (p.startsWith("/media/")) {
    const file = path.join(MEDIA_DIR, path.basename(p));
    serveFile(req, res, file);
    return;
  }

  /* Finished exports */
  if (p.startsWith("/exports/")) {
    serveFile(req, res, path.join(EXPORTS_DIR, path.basename(p)));
    return;
  }

  /* Library assets (supports subfolders) */
  if (p.startsWith("/library/")) {
    const file = path.normalize(path.join(LIBRARY_DIR, p.slice("/library/".length)));
    if (!file.startsWith(LIBRARY_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    serveFile(req, res, file);
    return;
  }

  /* Static app files */
  let file = p === "/" ? "/index.html" : p;
  file = path.normalize(path.join(ROOT, file));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  serveFile(req, res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  FableCut running →  http://localhost:${PORT}\n`);
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST))
    console.log(`  ⚠ WARNING: HOST=${HOST} exposes the editor (and its file APIs) to the network.\n`);
  console.log(`  project file : ${PROJECT_FILE}`);
  console.log(`  media folder : ${MEDIA_DIR}`);
  console.log(`  library      : ${LIBRARY_DIR} (${LIBRARY_SUBDIRS.join(", ")})`);
  console.log(`  ffmpeg       : ${HAS_FFMPEG ? "found (fast export + faststart remux on)" : "not found (real-time export only)"}\n`);
});
