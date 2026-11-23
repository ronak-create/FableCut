/* Download a remote HTTPS file into ./media with SSRF guards.
   Used by POST /api/import-url and fablecut_import_media. The stored src is
   always a local /media/… path — the URL is not kept as the playback source.
   Remote SVG is refused (same-origin image/svg+xml would be a script sink).
   allowLoopback is a test-only carve-out for HTTP(S) to 127.0.0.1. */
"use strict";
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawnSync, execFile } = require("child_process");

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const TIMEOUT_MS = 180_000;
const MAX_REDIRECTS = 5;

const KIND_BY_EXT = {
  ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".m4v": "video", ".avi": "video",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "svg",
};
const EXT_BY_MIME = {
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "video/x-matroska": ".mkv", "video/x-m4v": ".m4v",
  "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
  "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac",
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "image/svg+xml": ".svg",
};
const FASTSTART_EXT = new Set([".mp4", ".mov", ".m4v"]);

function safeName(name) {
  return String(name).replace(/[^\w.\- ()\[\]]+/g, "_").slice(0, 120) || "file";
}
function kindFromName(name) {
  return KIND_BY_EXT[path.extname(name).toLowerCase()] || null;
}
/** Create `name` under dir with exclusive `wx`. On EEXIST, try name_1, name_2, …
 *  so two concurrent imports cannot both pick the same free path. */
function openUniqueFile(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let i = 0;
  for (;;) {
    const file = i === 0 ? name : `${base}_${i}${ext}`;
    i++;
    const target = path.join(dir, file);
    try { return { target, fd: fs.openSync(target, "wx") }; }
    catch (e) { if (e.code === "EEXIST") continue; throw e; }
  }
}

function isBlockedIp(ip) {
  if (!ip) return true;
  let addr = String(ip).toLowerCase();
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  if (net.isIPv4(addr)) {
    const p = addr.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(addr)) {
    if (addr === "::1" || addr === "::") return true;
    if (addr.startsWith("fe8") || addr.startsWith("fe9") ||
        addr.startsWith("fea") || addr.startsWith("feb")) return true;
    if (addr.startsWith("fc") || addr.startsWith("fd")) return true;
    if (addr.startsWith("ff")) return true;
    return false;
  }
  return true;
}

function isBlockedHostname(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h === "metadata.google.internal") return true;
  if (net.isIP(h)) return isBlockedIp(h);
  return false;
}

/* Test hook: HTTP(S) to 127.0.0.1 only. Does not open LAN, CGNAT, metadata, or
   other loopback addresses (127.0.0.2, ::1, localhost). */
function isTestLoopback(host) {
  return String(host || "").replace(/^\[|\]$/g, "").toLowerCase() === "127.0.0.1";
}

function parseImportUrl(raw, { allowLoopback = false } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new Error("invalid URL"); }
  const loopback = allowLoopback && isTestLoopback(u.hostname);
  if (loopback) {
    if (u.protocol !== "https:" && u.protocol !== "http:")
      throw new Error("URL must be http(s)");
  } else if (u.protocol !== "https:") {
    throw new Error("URL must be https");
  }
  if (u.username || u.password) throw new Error("URL must not include credentials");
  if (!u.hostname) throw new Error("invalid URL");
  if (!loopback && isBlockedHostname(u.hostname))
    throw new Error("blocked: local or private host");
  return u;
}

async function assertPublicTarget(u, { allowLoopback = false } = {}) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (allowLoopback && isTestLoopback(host)) return;
  if (isBlockedHostname(u.hostname)) throw new Error("blocked: local or private host");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("blocked: local or private address");
    return;
  }
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error("could not resolve host"); }
  if (!addrs.length) throw new Error("could not resolve host");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("blocked: host resolves to a private address");
  }
}

function filenameFrom(u, headers) {
  const cd = headers["content-disposition"] || "";
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(cd);
  if (star) {
    try { return safeName(path.basename(decodeURIComponent(star[1].trim().replace(/^"+|"+$/g, "")))); }
    catch { /* fall through */ }
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"])+)"/i.exec(cd);
  if (quoted) return safeName(path.basename(quoted[1].replace(/\\"/g, '"')));
  const bare = /filename\s*=\s*([^;]+)/i.exec(cd);
  if (bare) return safeName(path.basename(bare[1].trim().replace(/^"+|"+$/g, "")));

  let base = "";
  try { base = path.basename(decodeURIComponent(u.pathname)); } catch { base = path.basename(u.pathname); }
  if (base === "/" || base === "." || base === "..") base = "";
  const mime = (headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const mimeExt = EXT_BY_MIME[mime] || "";
  if (!base) base = "download" + mimeExt;
  else if (!path.extname(base) && mimeExt) base += mimeExt;
  return safeName(base);
}

function requestOnce(u, { signal, timeoutMs }) {
  const lib = u.protocol === "https:" ? https : http;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const opts = {
    protocol: u.protocol,
    hostname: host,
    port: u.port || undefined,
    path: u.pathname + u.search,
    method: "GET",
    headers: { "User-Agent": "FableCut", Accept: "*/*" },
  };
  if (u.protocol === "https:" && !net.isIP(host)) opts.servername = host;
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, resolve);
    const fail = (err) => { try { req.destroy(); } catch {} reject(err); };
    req.on("error", fail);
    req.setTimeout(timeoutMs, () => fail(new Error("download timed out")));
    if (signal) {
      if (signal.aborted) return fail(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      const onAbort = () => fail(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.end();
  });
}

function saveResponse(res, u, destDir, { signal, maxBytes, name: wanted }) {
  const mime = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/json") {
    res.resume();
    return Promise.reject(new Error("URL did not return a media file"));
  }
  let name = filenameFrom(u, res.headers);
  // a caller's name (e.g. "Title - Artist.mp3") keeps the served file's extension when it has a known one
  if (wanted) {
    const ext = kindFromName(name) ? path.extname(name) : path.extname(String(wanted));
    // no dotfile, and the stem is cut (not the extension) so the type is still known
    const stem = safeName(path.basename(String(wanted), path.extname(String(wanted))).trim().replace(/^\.+/, "")).replace(/^\.+/, "").slice(0, 100);
    name = (stem || "download") + ext.slice(0, 10);
  }
  const kind = kindFromName(name);
  // /media/*.svg is served same-origin as image/svg+xml. A remote file with
  // <script> opened as a document would run on the editor origin.
  if (kind === "svg" || mime === "image/svg+xml" || mime === "image/svg") {
    res.resume();
    return Promise.reject(new Error("unsupported media type (remote SVG is not imported)"));
  }
  if (!kind) {
    res.resume();
    return Promise.reject(new Error("unsupported media type (need a video, audio, or image URL)"));
  }
  const declared = parseInt(res.headers["content-length"], 10);
  if (declared > maxBytes) {
    res.resume();
    return Promise.reject(new Error("file too large"));
  }
  fs.mkdirSync(destDir, { recursive: true });
  let target, owned = false, out, fd;
  try {
    const opened = openUniqueFile(destDir, name);
    target = opened.target;
    fd = opened.fd;
    owned = true;
    out = fs.createWriteStream(target, { fd });
  } catch (e) {
    res.resume();
    if (fd != null && !out) try { fs.closeSync(fd); } catch {}
    if (owned) try { fs.rmSync(target, { force: true }); } catch {}
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const cleanup = (err) => {
      try { res.destroy(); } catch {}
      try { out.destroy(); } catch {}
      if (owned) try { fs.rmSync(target, { force: true }); } catch {}
      reject(err);
    };
    if (signal) {
      if (signal.aborted) return cleanup(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      signal.addEventListener("abort", () => cleanup(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })), { once: true });
    }
    res.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) cleanup(new Error("file too large"));
    });
    res.on("error", cleanup);
    out.on("error", cleanup);
    res.pipe(out);
    out.on("finish", () => {
      owned = false; // complete file belongs to the caller now
      resolve({ target, name: path.basename(target) });
    });
  });
}

async function downloadImportUrl(raw, destDir, opts = {}) {
  const allowLoopback = !!opts.allowLoopback;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const signal = opts.signal;
  let current = parseImportUrl(raw, { allowLoopback });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    await assertPublicTarget(current, { allowLoopback });
    const res = await requestOnce(current, { signal, timeoutMs });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      let next;
      try { next = new URL(res.headers.location, current); }
      catch { throw new Error("invalid redirect"); }
      current = parseImportUrl(next.href, { allowLoopback });
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error("download failed: HTTP " + res.statusCode);
    }
    return saveResponse(res, current, destDir, { signal, maxBytes, name: opts.name });
  }
  throw new Error("too many redirects");
}

let hasFfmpeg = null;
function ffmpegAvailable() {
  if (hasFfmpeg == null) {
    try { hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; }
    catch { hasFfmpeg = false; }
  }
  return hasFfmpeg;
}
function maybeFaststart(file) {
  if (!ffmpegAvailable() || !FASTSTART_EXT.has(path.extname(file).toLowerCase()))
    return Promise.resolve();
  const tmp = file + ".fs" + path.extname(file);
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-y", "-i", file, "-c", "copy", "-movflags", "+faststart", tmp],
      { maxBuffer: 1 << 24 }, (err) => {
        if (err) { try { fs.rmSync(tmp, { force: true }); } catch {} return resolve(); }
        try { fs.rmSync(file); fs.renameSync(tmp, file); } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
        resolve();
      });
  });
}

module.exports = {
  downloadImportUrl, parseImportUrl, isBlockedIp, isBlockedHostname,
  filenameFrom, kindFromName, KIND_BY_EXT, maybeFaststart, MAX_BYTES,
};
