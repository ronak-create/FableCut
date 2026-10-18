/* ═══════════════════════════════════════════════════════════════════════════
   FableCut server — zero-dependency Node.js
   Run:  node server.js   →  http://localhost:7777

   Adds to the browser editor:
     • persistent project      ./project.json      (GET/PUT /api/project)
     • media library folder    ./media/            (served at /media/*, POST /api/upload,
                                                    POST /api/import-url)
     • live reload             GET /api/events     (SSE: event "change" for
                                                    project/media/library;
                                                    event "profiles" for
                                                    encoding-profiles.json)

   Automation: any tool (e.g. Claude Code) can edit project.json or drop files
   into ./media — the browser UI reloads instantly. Schema: see CLAUDE.md.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFile } = require("child_process");

const { analyze, frame, frameGrid } = require("./analyze");
const {
  PROFILES_FILE,
  loadEncodeProfiles,
  invalidateEncodeProfiles,
  resolveProfile,
  listProfilesPublic,
  profileSummary,
  buildExportArgs,
  dryRunProfile,
} = require("./encode-profiles");
const { downloadImportUrl, maybeFaststart } = require("./import-url");
const { pruneCache } = require("./frame-cache");
const { createExportJobs } = require("./export-jobs");
const { denoiseFile, AMOUNT_IDS: DENOISE_AMOUNTS } = require("./denoise");

const {
  APP_DIR, DATA_DIR, MEDIA_DIR, EXPORTS_DIR, ANALYSIS_DIR, LIBRARY_DIR,
  PROJECT_FILE, LIBRARY_SUBDIRS, FRAMES_DIR, PROXIES_DIR, ensureDirs, readSaved, writeSaved,
} = require("./paths");
const Templates = require("./templates");
const { probeFile } = require("./media-probe");
const MediaLib = require("./media-lib");
const { createProxies } = require("./proxy");
const Delivery = require("./delivery");

/* Static app files are served from the install dir; everything the user creates
   lives under DATA_DIR. The two are the same unless FABLECUT_DATA_DIR is set. */
const ROOT = APP_DIR;
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

ensureDirs();
if (!fs.existsSync(PROJECT_FILE)) {
  fs.writeFileSync(PROJECT_FILE, JSON.stringify({
    name: "Untitled Project", width: 1280, height: 720, fps: 30,
    revision: 0, media: [], clips: [],
  }, null, 2));
}

/* ── SSE clients + file watching ── */
const sseClients = new Set();
function broadcast(event = "change", data = event) {
  const payload = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of sseClients) res.write(payload);
}
const proxies = createProxies({ dir: PROXIES_DIR, resolveSrc, probe: probeFile, broadcast: (ev, data) => broadcast(ev, data) });
let debounce = null;
let profilesDebounce = null;
function onFsChange() {
  clearTimeout(debounce);
  debounce = setTimeout(() => broadcast("change"), 150);
}
function onProfilesChange() {
  invalidateEncodeProfiles();
  clearTimeout(profilesDebounce);
  profilesDebounce = setTimeout(() => broadcast("profiles"), 150);
}
/* watch the directory, not the file — atomic tmp+rename writes would detach a
   direct file watcher on Windows */
if (process.env.FABLECUT_NO_FS_WATCH !== "1") {
  try { fs.watch(DATA_DIR, (ev, f) => { if (f === "project.json") onFsChange(); }); } catch {}
  try {
    fs.watch(ROOT, (ev, f) => {
      if (f === path.basename(PROFILES_FILE)) onProfilesChange();
    });
  } catch {}
  try { fs.watch(MEDIA_DIR, onFsChange); } catch {}
  for (const d of LIBRARY_SUBDIRS) {
    try { fs.watch(path.join(LIBRARY_DIR, d), onFsChange); } catch {}
  }
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
/** Claim final + sibling `.part` paths with exclusive create (`wx`) so concurrent
 *  exports cannot pick the same free name before either file exists. */
function reserveExportPaths(dir, baseName, ext) {
  const base = baseName.replace(/\.(mp4|mov|m4v|mkv|webm)$/i, "");
  let i = 0;
  for (;;) {
    const stem = i === 0 ? base : `${base}_${i}`;
    i++;
    const outPath = path.join(dir, stem + ext);
    const partPath = path.join(dir, stem + ".part" + ext);
    if (fs.existsSync(outPath)) continue;
    try {
      fs.closeSync(fs.openSync(partPath, "wx")); // exclusive create — claim the name
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
    if (fs.existsSync(outPath)) {
      try { fs.rmSync(partPath, { force: true }); } catch { }
      continue;
    }
    return { outPath, partPath };
  }
}
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, _out, stderr) =>
      err ? reject(new Error((stderr || String(err)).slice(-800))) : resolve());
  });
}

/** A "/media/…" or "/library/…" src → an existing file inside that root, or null.
 *  Every src-accepting endpoint resolves through here: basename alone is not
 *  enough (library has subfolders) and a bare join is a traversal hole. */
function resolveSrc(src) {
  const p = decodeURIComponent(String(src || "").split("?")[0]);
  const [root, rel] = p.startsWith("/media/") ? [MEDIA_DIR, p.slice(7)]
    : p.startsWith("/library/") ? [LIBRARY_DIR, p.slice(9)] : [null, null];
  if (!root || !rel) return null;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root + path.sep))) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

/** An explicit absolute/relative path argument → an existing file, or null.
 *  Used by /api/frame only. This deliberately reaches outside media/ and
 *  library/: looking at a clip must not require putting it in the project
 *  folder. The caller is the local MCP server or the user's own fetch, both
 *  already able to read any file the user can — and unlike resolveSrc() it
 *  never turns a request string into a path *inside* a served root, so there
 *  is no traversal to defend. It is deliberately NOT how a src is resolved. */
function resolvePathArg(p) {
  if (!p || typeof p !== "string") return null;
  let file = path.resolve(p);
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

/* Remux MP4-family uploads with `+faststart` so the moov atom leads the file —
   without it <video> stalls for seconds probing over Range requests. */
function faststart(file) { return maybeFaststart(file); }

/* ── Export sessions ──
   Two modes share the same HTTP session API:
     jpeg   — browser streams JPEGs (one POST may concatenate several);
              ffmpeg encodes via an encoding profile (Fast)
     annexb — browser streams Annex-B H.264 (one POST may concatenate several AUs);
              ffmpeg stream-copies (WebCodecs)
   Both spawn on the FIRST frame, not here: the audio mix is uploaded between
   /begin and the first frame, and a one-pass encode needs it on disk. */
const exportSessions = new Map();
/* Container + bitstream BT.709/tv for the WebCodecs (annexb) path.
   `-c copy` alone drops the colr atom; the bsf writes VUI so players see
   primaries/transfer, not "unknown". JPEG Fast export uses profile.color instead. */
const COLOR_TAGS = [
  "-colorspace", "bt709", "-color_primaries", "bt709",
  "-color_trc", "bt709", "-color_range", "tv",
];
const COLOR_BSF = "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0";
const EXPORT_IDLE_MS = 10 * 60 * 1000; // abandon sessions with no successful activity
const EXPORT_SWEEP_MS = 60 * 1000;
let exportSweepTimer = null;
function touchExport(sess) {
  if (sess) sess.lastTouch = Date.now();
}
function attachProc(sess, proc) {
  sess.proc = proc;
  sess.stderr = "";
  proc.stderr.on("data", (d) => { sess.stderr = (sess.stderr + d).slice(-2000); });
  proc.stdin.on("error", () => {}); // EPIPE if ffmpeg dies mid-stream
  sess.done = new Promise((res) => proc.on("close", res));
}
/* Delivery presets (delivery.js) — structured settings instead of raw args.
   Which encoders exist: `ffmpeg -encoders`, and for the hardware ones a 2-frame
   test encode, because a build lists h264_nvenc / _qsv / _amf whether or not
   this machine has the GPU. Asked once, in the background, on first use. */
let deliveryEncodersP = null;
function runFfmpeg(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile("ffmpeg", args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}
function deliveryEncoders() {
  if (!HAS_FFMPEG) return Promise.resolve(new Set());
  if (deliveryEncodersP) return deliveryEncodersP;
  deliveryEncodersP = (async () => {
    const listed = Delivery.parseEncoders((await runFfmpeg(["-hide_banner", "-encoders"])).stdout);
    const usable = new Set([...listed].filter((e) => !Delivery.ENCODERS[e]?.hw));
    await Promise.all([...listed].filter((e) => Delivery.ENCODERS[e]?.hw).map(async (e) => {
      const r = await runFfmpeg(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=30:d=0.1",
        "-frames:v", "2", "-c:v", e, "-pix_fmt", Delivery.ENCODERS[e].hw === "nvenc" ? "yuv420p" : "nv12", "-f", "null", "-"]);
      if (r.code === 0) usable.add(e);
    }));
    return usable;
  })();
  return deliveryEncodersP;
}
/** Saved delivery presets: library/delivery/<id>.json, each a spec plus a label. */
function savedDeliveryPresets() { return Delivery.savedPresets(readSaved("delivery")); }
/* One render, several files: `deliveries:[{delivery, name}, …]` (up to 8) or a
   single `delivery` + name. Every output gets its own ffmpeg, fed the same
   frames; the browser renders each frame once. Frames are raw RGBA when any
   output needs more than 4:2:0 8-bit, else JPEG at the highest quality asked. */
const MAX_OUTPUTS = 8;
async function beginDeliveryExport(rate, name, hasAudio, extra) {
  const available = await deliveryEncoders();
  const presets = savedDeliveryPresets();
  const list = Array.isArray(extra.deliveries) ? extra.deliveries : [{ delivery: extra.delivery, name }];
  if (!list.length) throw new Error("deliveries is empty");
  if (list.length > MAX_OUTPUTS) throw new Error(`at most ${MAX_OUTPUTS} outputs per render`);
  const canvasW = extra.canvasW | 0, canvasH = extra.canvasH | 0;
  if (canvasW < 2 || canvasH < 2 || canvasW > 16384 || canvasH > 16384) throw new Error("export width/height required (canvasW, canvasH)");
  const r = extra.region;
  const region = r && typeof r === "object" && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0 &&
    r.x >= 0 && r.y >= 0 && r.x + r.w <= canvasW + 0.5 && r.y + r.h <= canvasH + 0.5 ? r : null;
  const outs = list.map((d) => {
    const { spec, notes } = Delivery.normalize(d && d.delivery !== undefined ? d.delivery : d, { available, presets });
    return { spec, notes, name: d && typeof d.name === "string" ? d.name : name, frame: Delivery.reframe(spec, canvasW, canvasH, region) };
  });
  // one render has one frame rate: an output asking for another needs a render of its own
  const off = outs.map((o, i) => [o, i]).filter(([o]) => o.spec.fps != null && Math.abs(o.spec.fps - rate) > 0.01);
  if (off.length) throw new Error(off.map(([o, i]) => `output ${i + 1} asks for ${o.spec.fps} fps but this render is ${rate} fps`).join("; ") + " — render each frame rate separately");
  const input = outs.some((o) => Delivery.frameInput(o.spec) === "rgba") ? "rgba" : "jpeg";
  // check every output on a 0.1 s synthetic canvas before the browser renders anything
  const dryDir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-dry-"));
  try {
    const dry = await Promise.all(outs.map((o, i) => runFfmpeg(Delivery.ffmpegArgs(o.spec, { fps: rate, input, canvasW, canvasH, frame: o.frame,
      hasAudio, dry: true, outPath: path.join(dryDir, `probe${i}` + Delivery.CONTAINERS[o.spec.container].ext) }), 30000)));
    const bad = dry.map((d, i) => [d, outs[i]]).filter(([d]) => d.code !== 0);
    if (bad.length) {
      throw new Error(bad.map(([d, o]) => {
        const why = d.stderr.trim().split("\n").filter(Boolean).slice(-3).map((l) => l.trim()).join(" · ");
        return `ffmpeg rejected these settings (${Delivery.describe(o.spec)}): ${why || "exit " + d.code}`;
      }).join("\n"));
    }
  } finally { try { fs.rmSync(dryDir, { recursive: true, force: true }); } catch {} }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const dir = fs.mkdtempSync(path.join(EXPORTS_DIR, "fablecut-"));
  const duration = Number.isFinite(+extra.duration) && +extra.duration > 0 ? +extra.duration : null;
  for (const o of outs) {
    const ext = Delivery.CONTAINERS[o.spec.container].ext;
    Object.assign(o, reserveExportPaths(EXPORTS_DIR, safeName(o.name || "export"), ext), { proc: null, stderr: "", done: null, failed: null });
    o.err = () => o.stderr.trim().split("\n").filter(Boolean).slice(-3).map((l) => l.trim()).join(" · ");
  }
  const sess = {
    mode: "jpeg", proc: null, fps: rate, outputs: outs, input, canvasW, canvasH, duration,
    hasAudio: !!hasAudio, dir, wav: null, partPath: null, outPath: null,
    stderr: "", done: null, lastTouch: Date.now(), err: () => "",
  };
  sess.writeLock = Promise.resolve();
  exportSessions.set(id, sess);
  const jpegQuality = Math.max(...outs.map((o) => Delivery.jpegQuality(o.spec)));
  const view = outs.map((o) => ({ file: path.basename(o.outPath), spec: o.spec, notes: o.notes, summary: Delivery.describe(o.spec), size: { w: o.frame.outW, h: o.frame.outH } }));
  // the single-output fields stay as they were for one delivery
  return { id, mode: "jpeg", input, jpegQuality, outputs: view, ...view[0] };
}
/** Integrated loudness and true peak of a file's first audio stream (ffmpeg ebur128). */
async function measureLoudness(file, timeout = 10 * 60 * 1000) {
  const r = await runFfmpeg(Delivery.LOUDNESS_ARGS(file), timeout);
  return r.code === 0 ? Delivery.parseEbur128(r.stderr) : null;
}
function ffprobeJSON(file) {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => { try { resolve(err ? null : JSON.parse(stdout)); } catch { resolve(null); } });
  });
}
/** Check a finished output against its spec: size, frames, fps, codecs, length, loudness, file size. */
const VERIFY_LOUDNESS_MS = 120 * 1000;   // the file is already saved; a long re-measure must not hold the reply
async function verifyDeliveryOutput(sess, o, file) {
  const failed = (text) => ({ ok: false, checks: [{ ok: false, text }], line: "⚠ " + text });
  try {
    const loudWanted = o.spec.audio.codec !== "none" && !!sess.wav;
    const [probe, loud] = await Promise.all([ffprobeJSON(file), loudWanted ? measureLoudness(file, VERIFY_LOUDNESS_MS) : null]);
    if (!probe) return failed("could not read the file back to check it (ffprobe)");
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    return Delivery.verify(o.spec, probe, {
      fps: sess.fps, frames: sess.frames || (sess.duration ? Math.round(sess.duration * sess.fps) : null), duration: sess.duration,
      size, loud, loudWanted, frame: o.frame, hasAudio: !!sess.wav,
    });
  } catch (e) { return failed("could not check the file: " + (e.message || e)); }
}
/** Spawn one ffmpeg per output of a delivery session. */
function startDeliveryEncoders(sess) {
  for (const o of sess.outputs) {
    const proc = spawn("ffmpeg", Delivery.ffmpegArgs(o.spec, {
      fps: sess.fps, input: sess.input, canvasW: sess.canvasW, canvasH: sess.canvasH, frame: o.frame,
      wavPath: sess.wav, outPath: o.partPath, duration: sess.duration, loudnorm: o.loudnorm,
    }), { stdio: ["pipe", "ignore", "pipe"] });
    proc.stderr.on("data", (d) => { o.stderr = (o.stderr + d).slice(-2000); });
    proc.stdin.on("error", () => { });
    o.proc = proc;
    o.done = new Promise((res) => proc.on("close", res));
  }
  sess.proc = sess.outputs[0].proc; // "started"
}
/** The same frames to every output still running. One that fails is marked and
 *  left behind; the render goes on for the rest, and fails only when none is left. */
async function writeDeliveryFrame(sess, body) {
  const live = sess.outputs.filter((o) => !o.failed);
  await Promise.all(live.map((o) => writeExportFrame(o, body).catch((e) => { o.failed = String(e.message || e); })));
  if (!sess.outputs.some((o) => !o.failed))
    throw new Error(sess.outputs.map((o) => `${path.basename(o.outPath)}: ${o.failed}`).join(" · "));
}
async function beginExport(fps, name, profileId, hasAudio, mode, extra = {}) {
  const m = mode === "annexb" ? "annexb" : "jpeg";
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("export fps required (pass project.fps)");
  }
  const pixelFormat = extra.pixelFormat === "rgba" ? "rgba" : "jpeg";
  const width = Math.max(0, extra.width | 0);
  const height = Math.max(0, extra.height | 0);
  if (pixelFormat === "rgba" && (width < 2 || height < 2)) {
    throw new Error("export width/height required for rgba");
  }
  if (m === "jpeg" && (extra.delivery || extra.deliveries)) return beginDeliveryExport(rate, name, hasAudio, extra);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const safe = safeName(name || "export");
  // Same filesystem as the finished file so renameSync(partPath, out) cannot EXDEV.
  const dir = fs.mkdtempSync(path.join(EXPORTS_DIR, "fablecut-"));

  if (m === "annexb") {
    const { outPath, partPath } = reserveExportPaths(EXPORTS_DIR, safe, ".mp4");
    const sess = {
      mode: m, fps: rate, proc: null, dir,
      name: safe, hasAudio: !!hasAudio,
      wav: null, partPath, outPath,
      stderr: "", done: null, lastTouch: Date.now(),
      err: () => sess.stderr.trim().split("\n").filter(Boolean).slice(-3)
        .map((l) => l.trim()).join(" · "),
    };
    sess.writeLock = Promise.resolve();
    exportSessions.set(id, sess);
    return { id, mode: m };
  }

  const profile = resolveProfile(profileId);
  const dry = await dryRunProfile(profile, { fps: rate, hasAudio });
  if (!dry.ok) throw new Error(`profile "${profile.id}" was rejected by ffmpeg: ${dry.error}`);
  // Reserve the output name now (not at first frame) so concurrent exports
  // cannot both see the same free path. The empty .part file is overwritten by ffmpeg (-y).
  const { outPath, partPath } = reserveExportPaths(EXPORTS_DIR, safe, profile.extension);
  const sess = {
    mode: m, proc: null, fps: rate, profile, name: safe, hasAudio: !!hasAudio,
    pixelFormat, width, height,
    dir, wav: null, partPath, outPath,
    stderr: "", done: null, lastTouch: Date.now(),
    err: () => sess.stderr.trim().split("\n").filter(Boolean).slice(-3)
      .map((l) => l.trim()).join(" · "),
  };
  sess.writeLock = Promise.resolve();
  exportSessions.set(id, sess);
  return { id, mode: m, profile: profile.id, label: profile.label, summary: profileSummary(profile) };
}
/* Encode into the paths reserved at /begin; rename .part → final on clean exit
   so an aborted render never leaves something that looks like a finished file. */
function startEncoder(sess) {
  if (sess.outputs) return startDeliveryEncoders(sess);
  const args = buildExportArgs(sess.profile, {
    fps: sess.fps, wavPath: sess.wav, outPath: sess.partPath,
    pixelFormat: sess.pixelFormat, width: sess.width, height: sess.height,
  });
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  proc.stderr.on("data", (d) => { sess.stderr = (sess.stderr + d).slice(-2000); });
  // EPIPE on end()/late writes is normal once ffmpeg has exited; writeExportFrame
  // attaches its own error listener while a backpressured write is in flight.
  proc.stdin.on("error", () => { });
  sess.proc = proc;
  sess.done = new Promise((res) => proc.on("close", res));
  return proc;
}
/** Write one frame (JPEG or Annex-B NAL) to ffmpeg stdin. If the pipe is full,
 *  wait for drain — but also reject if ffmpeg exits or the stdin errors, so the
 *  HTTP request cannot hang forever after a failed encode. */
function writeExportFrame(sess, body) {
  const proc = sess.proc;
  return new Promise((resolve, reject) => {
    if (!proc || proc.exitCode !== null || proc.killed)
      return reject(new Error("ffmpeg exited: " + sess.err()));

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      proc.off("close", onClose);
      proc.stdin.off("error", onErr);
      proc.stdin.off("drain", onDrain);
      fn(arg);
    };
    const onClose = () => finish(reject, new Error("ffmpeg exited: " + (sess.err() || "closed")));
    const onErr = (e) => finish(reject, new Error(e?.message || "ffmpeg stdin error"));
    const onDrain = () => finish(resolve);

    proc.once("close", onClose);
    proc.stdin.once("error", onErr);
    let ok;
    try { ok = proc.stdin.write(body); }
    catch (e) { return finish(reject, e); }
    if (proc.exitCode !== null)
      return finish(reject, new Error("ffmpeg exited: " + sess.err()));
    if (ok) finish(resolve);
    else proc.stdin.once("drain", onDrain);
  });
}
/* One-pass mux for WebCodecs: H.264 elementary stream on stdin + optional WAV.
   Use input `-r` (not only `-framerate`): HW encoders stamp AUs with µs-rounded
   durations (e.g. 33333µs ≈ 1/30), which otherwise become avg_frame_rate
   1000000/33333. `-r` forces CFR PTS so the MP4 matches project.fps exactly. */
function startAnnexbEncoder(sess) {
  const fps = sess.fps;
  const args = [
    "-y", "-hide_banner",
    "-fflags", "+genpts",
    "-f", "h264", "-r", String(fps), "-i", "pipe:0",
  ];
  if (sess.wav) args.push("-i", sess.wav);
  args.push("-map", "0:v:0", "-c:v", "copy", "-bsf:v", COLOR_BSF, ...COLOR_TAGS);
  // do not use -shortest: with unset/generated PTS it drops the audio track
  if (sess.wav) args.push("-map", "1:a:0", "-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart+write_colr", sess.partPath);
  attachProc(sess, spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] }));
  return sess.proc;
}
function cleanupExport(id) {
  const s = exportSessions.get(id);
  if (!s) return;
  exportSessions.delete(id);
  try { s.proc?.kill(); } catch {}
  for (const o of s.outputs || []) {
    try { o.proc?.kill(); } catch {}
    if (o.partPath) try { fs.rmSync(o.partPath, { force: true }); } catch {}
  }
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
  if (s.partPath) try { fs.rmSync(s.partPath, { force: true }); } catch {}
}
function sweepIdleExports() {
  const now = Date.now();
  for (const [id, s] of [...exportSessions]) {
    if (now - (s.lastTouch || 0) > EXPORT_IDLE_MS) cleanupExport(id);
  }
}
function startExportSweep() {
  if (exportSweepTimer) return;
  exportSweepTimer = setInterval(sweepIdleExports, EXPORT_SWEEP_MS);
}
function stopExportSweep() {
  if (!exportSweepTimer) return;
  clearInterval(exportSweepTimer);
  exportSweepTimer = null;
}

/* Agent-requested exports: handed to an open editor tab over SSE, or to a
   headless browser the server starts (export-jobs.js). */
const exportJobs = createExportJobs({
  url: (id) => `http://localhost:${PORT}/?exportJob=${encodeURIComponent(id)}`,
  broadcast,
  editors: () => sseClients.size,
});

/* Static file with HTTP Range support (required for <video> seeking) */
function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const extra = {};
    if (ext === ".svg") {
      extra["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
      extra["X-Content-Type-Options"] = "nosniff";
    }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1]) : 0;
      let end = m && m[2] ? parseInt(m[2]) : st.size - 1;
      start = Math.min(start, st.size - 1); end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        "Content-Type": type, "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Content-Length": end - start + 1, ...extra,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": type, "Content-Length": st.size,
        "Accept-Ranges": "bytes", "Cache-Control": "no-cache", ...extra,
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

  /* API: media metadata (ffprobe; size only without it).
       GET  /api/media-info?src=/media/x.mp4 → {src, info} (info null = file missing)
       POST /api/media-info {srcs:[…], stat?} → {info:{src: info | null}} — up to 2000 per call;
       stat:true answers {size, mtimeMs} without ffprobe (the editor's offline check) */
  if (p === "/api/media-info" && (req.method === "GET" || req.method === "POST")) {
    try {
      if (req.method === "GET") {
        const src = url.searchParams.get("src") || "";
        const file = resolveSrc(src);
        sendJSON(res, 200, { src, info: file ? await probeFile(file) : null });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const srcs = Array.isArray(body.srcs) ? body.srcs.slice(0, 2000).map(String) : [];
      const info = Object.create(null);   // any src is a plain key, "__proto__" too
      // probed side by side (media-probe.js caps how many ffprobes run at once)
      await Promise.all(srcs.map(async (src) => {
        const file = resolveSrc(src);
        if (!file) { info[src] = null; return; }
        // stat:true only asks "is it there?" (offline checks) — no ffprobe
        if (body.stat) { const st = await fs.promises.stat(file); info[src] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) }; }
        else info[src] = await probeFile(file);
      }));
      sendJSON(res, 200, { info });
    } catch (e) { sendJSON(res, 400, { error: String(e.message || e) }); }
    return;
  }

  /* API: where might a missing file be now? Body {media:[{id, name, size?}]} →
     {candidates:{id:[{src, name, size, score, why}]}} — files under media/ and
     library/ ranked by name and size (MediaLib.relinkScore), best first, at most 5 each. */
  if (p === "/api/relink/candidates" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const want = Array.isArray(body.media) ? body.media.slice(0, 2000) : [];
      const files = [];
      const walk = (root, prefix, d, depth) => {
        let list = [];
        try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of list) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { if (depth < 6 && !(root === LIBRARY_DIR && /^(presets|templates|fonts)$/.test(e.name) && depth === 0)) walk(root, prefix, full, depth + 1); continue; }
          let size = 0;
          try { size = fs.statSync(full).size; } catch { continue; }
          const rel = path.relative(root, full).split(path.sep).map(encodeURIComponent).join("/");
          files.push({ src: prefix + rel, name: e.name, size });
        }
      };
      walk(MEDIA_DIR, "/media/", MEDIA_DIR, 0);
      walk(LIBRARY_DIR, "/library/", LIBRARY_DIR, 0);
      const candidates = Object.create(null);
      for (const m of want) {
        if (!m || !m.id) continue;
        candidates[m.id] = files.map((f) => ({ ...f, ...MediaLib.relinkScore(m, f) }))
          .filter((f) => f.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 5);
      }
      sendJSON(res, 200, { candidates });
    } catch (e) { sendJSON(res, 400, { error: String(e.message || e) }); }
    return;
  }

  /* API: proxies (see proxy.js).
       POST /api/proxy {srcs:[…], height?:540|720|1080} → {status:{src: status}} — queue them
       POST /api/proxy/status {srcs:[…]} → {status:{src: status | null}}
       POST /api/proxy/delete {srcs:[…]} → {deleted:{src: n}}
     Progress and results also arrive as SSE event "proxy". */
  if ((p === "/api/proxy" || p === "/api/proxy/status" || p === "/api/proxy/delete") && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const srcs = Array.isArray(body.srcs) ? body.srcs.slice(0, 2000).map(String) : [];
      if (p === "/api/proxy/delete") {
        const deleted = {};
        for (const src of srcs) deleted[src] = proxies.remove(src);
        sendJSON(res, 200, { deleted });
        return;
      }
      if (p === "/api/proxy" && !HAS_FFMPEG) { sendJSON(res, 503, { error: "proxies need ffmpeg on PATH" }); return; }
      const status = {};
      for (const src of srcs) status[src] = p === "/api/proxy" ? await proxies.start(src, body.height) : await proxies.status(src);
      sendJSON(res, 200, { status });
    } catch (e) { sendJSON(res, 400, { error: String(e.message || e) }); }
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

  /* API: saved animation presets and templates (library/presets, library/templates).
       GET  /api/presets | /api/templates  → [ …validated items… ] (bad files skipped)
       POST /api/presets {preset} | /api/templates {template} → saved as library/<kind>/<id>.json */
  if ((p === "/api/presets" || p === "/api/templates") && (req.method === "GET" || req.method === "POST")) {
    const kind = p.slice(5), norm = kind === "presets" ? Templates.normalizePreset : Templates.normalizeTemplate;
    try {
      if (req.method === "GET") {
        sendJSON(res, 200, readSaved(kind).map((x) => norm(x.data)).filter(Boolean));
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const item = Templates.asSaved(norm(kind === "presets" ? body.preset : body.template, true), kind);
      const file = writeSaved(kind, item.id, item);
      sendJSON(res, 200, { id: item.id, name: item.name, file: path.relative(DATA_DIR, file).split(path.sep).join("/") });
    } catch (e) { sendJSON(res, 400, { error: String(e.message || e) }); }
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

  /* API: download an HTTPS URL into ./media (same-origin src after import).
     Body {url}. Rejects http/file/local/private targets. Does not register
     project media — the client / MCP tool does that, matching /api/upload. */
  if (p === "/api/import-url" && req.method === "POST") {
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const ac = new AbortController();
      // IncomingMessage "close" also fires when the request body finishes, which
      // would abort a successful download. ServerResponse "close" with
      // writableEnded still false means the client dropped the connection.
      res.on("close", () => { if (!res.writableEnded) ac.abort(); });
      const { target, name } = await downloadImportUrl(opts.url, MEDIA_DIR, {
        signal: ac.signal,
        // test/rest-api.test.js: HTTP to 127.0.0.1 only (loopback fixture).
        // Does not disable SSRF for LAN / metadata / other private ranges.
        allowLoopback: process.env.FABLECUT_TEST_IMPORT_ALLOW_PRIVATE === "1",
      });
      await faststart(target);
      sendJSON(res, 200, { ok: true, src: "/media/" + encodeURIComponent(name), name });
    } catch (e) {
      if (e && e.code === "ABORT_ERR") { try { res.end(); } catch {} return; }
      const msg = e && e.message ? e.message : String(e);
      const code = /must be https|invalid URL|blocked:|credentials|unsupported|too large|did not return/i.test(msg) ? 400 : 502;
      sendJSON(res, code, { error: msg });
    }
    return;
  }

  /* API: agent-requested export jobs (see export-jobs.js).
     POST /api/export/request {range?, profile?, where?} → job; GET /api/export/job?id=
     polls it; the editor tab claims, reports and finishes it. */
  if (p === "/api/export/request" && req.method === "POST") {
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH — export needs it" }); return; }
      if (opts.profile) resolveProfile(String(opts.profile));
      if (opts.profile && (opts.preset || opts.delivery || opts.outputs)) { sendJSON(res, 400, { error: "pass a profile (raw ffmpeg args) or a preset / delivery spec / outputs, not both" }); return; }
      // several files from one render: outputs:true = the project's checked batch outputs, or a list of specs
      let deliveries = null, outNotes = [];
      if (opts.outputs) {
        let list = opts.outputs;
        if (list === true) {
          let proj = {};
          try { proj = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8").replace(/^\uFEFF/, "")); } catch {}
          list = (Array.isArray(proj.outputs) ? proj.outputs : []).filter((o) => o && o.on !== false);
          if (!list.length) { sendJSON(res, 400, { error: "the project has no checked batch outputs — pass outputs:[{preset…}, …], or add some with setProject {outputs}" }); return; }
        }
        if (!Array.isArray(list) || !list.length) { sendJSON(res, 400, { error: "outputs is true or a list of delivery specs" }); return; }
        if (list.length > 16) { sendJSON(res, 400, { error: "at most 16 outputs" }); return; }
        const available = await deliveryEncoders(), presets = savedDeliveryPresets();
        deliveries = list.map((o, i) => {
          const n = Delivery.normalize(typeof o === "string" ? o : o, { available, presets });
          for (const note of n.notes) outNotes.push(`output ${i + 1}: ${note}`);
          return n.spec;
        });
      }
      // a delivery preset with overrides → one complete spec, checked against this ffmpeg
      let delivery = null, notes = [];
      if (opts.preset || opts.delivery) {
        const d = opts.delivery && typeof opts.delivery === "object" ? opts.delivery : {};
        const n = Delivery.normalize({ ...d, preset: opts.preset || d.preset || undefined },
          { available: await deliveryEncoders(), presets: savedDeliveryPresets() });
        delivery = n.spec; notes = n.notes;
      }
      let revision = null;
      try { revision = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8").replace(/^\uFEFF/, "")).revision ?? null; } catch {}
      const job = exportJobs.request({ range: opts.range, profile: opts.profile, delivery: deliveries ? null : delivery, deliveries, where: opts.where, revision });
      sendJSON(res, 200, deliveries ? { ...job, delivery: `${deliveries.length} outputs from one render`, notes: outNotes }
        : delivery ? { ...job, delivery: Delivery.describe(delivery), notes } : job);
    } catch (e) {
      const code = e.code === 409 || e.code === 400 ? e.code : /^Unknown encoding profile/.test(e.message || "") ? 400 : 500;
      sendJSON(res, code, { error: String(e.message || e) });
    }
    return;
  }
  /* API: measure the graded program frame (fablecut_scopes) — a "scopes"
     job on the export-job queue, polled with GET /api/export/job?id=. */
  if (p === "/api/scopes/request" && req.method === "POST") {
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      let revision = null;
      try { revision = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8").replace(/^﻿/, "")).revision ?? null; } catch {}
      const ok = typeof opts.time === "number" || (typeof opts.time === "string" && opts.time.trim() !== "" && Number.isFinite(Number(opts.time)));
      if (opts.time != null && !ok) { sendJSON(res, 400, { error: "time must be seconds ≥ 0" }); return; }
      const time = opts.time == null ? null : Number(opts.time);
      const m = opts.matte;
      if (m != null && (typeof m !== "object" || typeof m.clip !== "string" || !Number.isInteger(m.layer) || m.layer < 0)) {
        sendJSON(res, 400, { error: "matte must be {clip: \"<clip id>\", layer: <index ≥ 0>}" }); return;
      }
      const mk = opts.mask;
      if (mk != null && (typeof mk !== "object" || typeof mk.clip !== "string")) {
        sendJSON(res, 400, { error: "mask must be {clip: \"<clip id>\"}" }); return;
      }
      sendJSON(res, 200, exportJobs.request({ kind: "scopes", time, where: opts.where, revision, matte: m || null, mask: mk || null, image: opts.image === true }));
    } catch (e) {
      sendJSON(res, e.code === 409 || e.code === 400 ? e.code : 500, { error: String(e.message || e) });
    }
    return;
  }
  /* API: follow a region of a clip (fablecut_track) — a "track" job on the
     same queue; the tab that runs it saves the track into the project. */
  if (p === "/api/track/request" && req.method === "POST") {
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      let revision = null;
      try { revision = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8").replace(/^﻿/, "")).revision ?? null; } catch {}
      const t = opts.track;
      if (!t || typeof t !== "object" || Array.isArray(t) || typeof t.clip !== "string") { sendJSON(res, 400, { error: "track must be {clip: \"<clip id>\", …}" }); return; }
      const body = JSON.stringify(t);
      if (body.length > 8192) { sendJSON(res, 400, { error: "track spec too large" }); return; }
      sendJSON(res, 200, exportJobs.request({ kind: "track", where: opts.where, revision, track: JSON.parse(body) }));
    } catch (e) {
      sendJSON(res, e.code === 409 || e.code === 400 ? e.code : 500, { error: String(e.message || e) });
    }
    return;
  }
  if (p.startsWith("/api/export/job")) {
    const id = url.searchParams.get("id") || "";
    const action = p.slice("/api/export/job".length);
    let got = false;
    try {
      got = action === "" && req.method === "GET" ? exportJobs.get(id)
        : action === "/ticket" && req.method === "GET" ? exportJobs.ticket(id)
        : action === "/claim" && req.method === "POST" ? (exportJobs.claim(id) ? { ok: true } : undefined)
        : action === "/report" && req.method === "POST" ? exportJobs.report(id, JSON.parse((await readBody(req)).toString("utf8") || "{}"))
        : action === "/cancel" && req.method === "POST" ? exportJobs.cancel(id)
        : false;
    } catch (e) { sendJSON(res, 400, { error: String(e.message || e) }); return; }
    if (got === false) { sendJSON(res, 404, { error: "unknown export job endpoint" }); return; }
    if (got === undefined) { sendJSON(res, 409, { error: "job is not pending — another tab took it, or it ended" }); return; }
    if (got === null) { sendJSON(res, 404, { error: "no such export job" }); return; }
    sendJSON(res, 200, got);
    return;
  }

  /* API: fast export (browser-rendered frames → ffmpeg encode) */
  if (p === "/api/export/ffmpeg" && req.method === "GET") {
    sendJSON(res, 200, { available: HAS_FFMPEG });
    return;
  }
  if (p === "/api/export/profiles" && req.method === "GET") {
    try {
      const detail = url.searchParams.get("detail") === "1";
      sendJSON(res, 200, listProfilesPublic(detail));
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  /* API: delivery presets — GET lists the saved ones and the encoders this
     ffmpeg can use (the built-in presets live in delivery.js, which the page
     loads too); POST {name, spec} saves one to library/delivery/; POST
     /api/export/presets/delete {id} removes it. */
  if (p === "/api/export/presets" && req.method === "GET") {
    const encoders = [...(await deliveryEncoders())].filter((e) => Delivery.ENCODERS[e]).sort();
    sendJSON(res, 200, { ffmpeg: HAS_FFMPEG, encoders, saved: savedDeliveryPresets(), builtin: Delivery.PRESET_IDS });
    return;
  }
  if ((p === "/api/export/presets" || p === "/api/export/presets/delete") && req.method === "POST") {
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (p.endsWith("/delete")) {
        const id = Delivery.presetId(opts.id);
        const file = path.join(LIBRARY_DIR, "delivery", id + ".json");
        if (!id || !fs.existsSync(file)) { sendJSON(res, 404, { error: "no saved delivery preset " + JSON.stringify(opts.id) }); return; }
        fs.unlinkSync(file);
        broadcast("delivery-presets");
        sendJSON(res, 200, { ok: true, id });
        return;
      }
      const label = String(opts.name || "").trim().slice(0, 60);
      const id = Delivery.presetId(label);
      if (!id) { sendJSON(res, 400, { error: "name the preset (letters or digits)" }); return; }
      if (Delivery.PRESETS[id]) { sendJSON(res, 400, { error: `"${label}" is a built-in preset — pick another name` }); return; }
      // what the spec leaves out comes from the preset it names (built-in or saved), not from Custom
      const { spec, notes } = Delivery.normalize(opts.spec || {}, { presets: savedDeliveryPresets() });
      delete spec.preset;
      writeSaved("delivery", id, { id, label, ...spec });
      broadcast("delivery-presets");
      sendJSON(res, 200, { ok: true, id, label, notes });
    } catch (e) { sendJSON(res, 400, { error: String(e.message || e) }); }
    return;
  }
  if (p === "/api/export/begin" && req.method === "POST") {
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const mode = opts.mode === "annexb" ? "annexb" : "jpeg";
      if (mode !== "annexb" && opts.profile) resolveProfile(opts.profile); // 400, not 500, on a bad id — even without ffmpeg
      if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH" }); return; }
      sendJSON(res, 200, await beginExport(opts.fps, opts.name, opts.profile, opts.hasAudio !== false, mode, opts));
    } catch (e) {
      // an unusable profile is the caller's problem, not a server fault
      const bad = /^Unknown encoding profile|was rejected by ffmpeg|ffmpeg rejected these settings|at most \d+ outputs|deliveries is empty|render each frame rate separately|export fps required|export width\/height required/.test(e.message || "");
      sendJSON(res, bad ? 400 : 500, { error: String(e.message || e) });
    }
    return;
  }
  if (p === "/api/export/frame" && req.method === "POST") {
    const id = url.searchParams.get("id");
    const sess = exportSessions.get(id);
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      const body = await readBody(req);
      if (!body || !body.length) throw new Error("empty frame");
      if (sess.hasAudio && !sess.wav) {
        sendJSON(res, 409, { error: "audio mix has not been uploaded yet" });
        return;
      }
      // queue behind any in-flight write so concurrent POSTs cannot interleave stdin
      const run = async () => {
        if (!sess.proc) sess.mode === "annexb" ? startAnnexbEncoder(sess) : startEncoder(sess);
        await (sess.outputs ? writeDeliveryFrame(sess, body) : writeExportFrame(sess, body));
      };
      const writeJob = sess.writeLock.then(run, run);
      sess.writeLock = writeJob.catch(() => {}); // keep the chain alive after a failed write
      await writeJob;
      touchExport(sess);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      cleanupExport(id);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (p === "/api/export/audio" && req.method === "POST") {
    const sess = exportSessions.get(url.searchParams.get("id"));
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      const wavPath = path.join(sess.dir, "audio.wav");
      fs.writeFileSync(wavPath, await readBody(req));
      // outputs that normalize loudness need the mix measured (loudnorm pass one) before ffmpeg starts
      const byTarget = new Map();
      for (const o of sess.outputs || []) {
        if (o.spec.audio.loudness == null || o.spec.audio.codec === "none") continue;
        const k = `${o.spec.audio.loudness}/${o.spec.audio.truePeak}`;
        if (!byTarget.has(k)) byTarget.set(k, runFfmpeg(Delivery.LOUDNORM_ARGS(wavPath, o.spec), 10 * 60 * 1000).then((r) => Delivery.parseLoudnorm(r.stderr)));
        o.loudnorm = await byTarget.get(k);
      }
      sess.wav = wavPath;
      touchExport(sess);
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
      touchExport(sess); // keep alive through final mux
      if (!sess.proc) throw new Error("no frames were uploaded");
      if (sess.outputs) {
        // every output finishes on its own; the reply lists each file or why it failed
        const results = await Promise.all(sess.outputs.map(async (o) => {
          const file = path.basename(o.outPath);
          if (!o.failed) {
            o.proc.stdin.end();
            const code = await o.done;
            if (code !== 0) o.failed = "ffmpeg encode failed: " + o.err();
          }
          if (o.failed) return { file, ok: false, error: o.failed };
          // a file that cannot be put in place fails alone; the others keep finishing
          try { fs.renameSync(o.partPath, o.outPath); }
          catch (e) { return { file, ok: false, error: "could not save the file: " + (e.message || e) }; }
          o.partPath = null; // renamed — cleanup must not delete the finished file
          const report = await verifyDeliveryOutput(sess, o, o.outPath);
          return { file, ok: true, src: "/exports/" + encodeURIComponent(file), ...(report ? { report } : {}),
            ...(o.loudnorm ? { mixLoudness: o.loudnorm.input_i } : {}) };
        }));
        cleanupExport(id);
        const ok = results.filter((x) => x.ok);
        if (!ok.length) throw new Error(results.map((x) => `${x.file}: ${x.error}`).join(" · "));
        sendJSON(res, 200, { ok: true, src: ok[0].src, outputs: results });
        return;
      }
      sess.proc.stdin.end();
      const code = await sess.done;
      if (code !== 0) throw new Error("ffmpeg encode failed: " + sess.err());
      const out = sess.outPath;
      fs.renameSync(sess.partPath, out);
      sess.partPath = null; // renamed — cleanup must not delete the finished file
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

  /* API: one frame of a source clip, or an N-up contact sheet across it —
     the "eyes" to go with /api/analyze's ears, so an agent can look at a
     moment instead of guessing from an energy number. JPEG in, JPEG out.

       GET /api/frame?src=/media/x.mp4&t=3.2[&w=768][&q=4]
       GET /api/frame?src=/media/x.mp4&frames=12[&cols=][&from=0][&to=30][&w=320]
     (cols omitted → the squarest layout: 6 frames give 3×2, 12 give 4×3)
       GET /api/frame?path=C:\clips\x.mp4&t=3.2

     `src` is a served /media/ or /library/ path. `path` is any readable path on
     this machine — it does NOT copy the file into media/, because looking at a
     clip must not change the user's project folder. `path` is answered only
     with the `X-FableCut-Client: mcp` request header, which only the local MCP
     client sends: without it a web page could otherwise probe which files
     exist (`onload` vs `onerror`), make ffmpeg decode them, and fill the cache
     below with junk. resolveSrc() remains the guard for anything that turns a
     request string into a path inside a served root.

     &text=1 returns JSON statistics instead of the image, for agents (or
     models) that cannot see one. Needs ffmpeg on PATH.

     Results are cached under analysis/frames/ by a hash of every argument, so
     polling the same timestamp costs nothing and the mtime/size of the cached
     file answers "did the source change underneath this?". The cache is capped
     (500 files / 128 MB, oldest mtime first — see frame-cache.js), so no
     combination of arguments can fill the disk. */
  if (p === "/api/frame" && req.method === "GET") {
    const pathArg = url.searchParams.get("path");
    /* `path=` reads any file on this machine, so it is only answered for the
       local MCP client, which proves itself with a custom header. An <img> or
       <form> on a web page cannot set one, and a cross-site fetch() that sets
       one needs a CORS preflight this server never grants — so a page in the
       user's browser can neither render a frame nor probe which files exist
       (a missing header is refused before the path is even resolved, so the
       answer leaks nothing). `src=` needs no header: those files are already
       served over HTTP at /media/ and /library/. */
    if (pathArg && req.headers["x-fablecut-client"] !== "mcp") {
      sendJSON(res, 403, { error: "path= needs the X-FableCut-Client: mcp request header — only the local MCP client may read files outside media/ and library/" });
      return;
    }
    /* The path is resolved next: whether a file is readable never depends on
       whether ffmpeg happens to be installed. */
    const src = url.searchParams.get("src") || "";
    const file = pathArg ? resolvePathArg(pathArg) : resolveSrc(src);
    if (!file) {
      sendJSON(res, 404, { error: pathArg
        ? "path must be an existing file on this machine"
        : "src must name an existing file under /media/ or /library/" });
      return;
    }
    if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH — frame extraction needs it" }); return; }
    const num = (k, dflt) => {
      const raw = url.searchParams.get(k);
      if (raw === null || raw === "") return dflt;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
      return n;
    };
    try {
      fs.mkdirSync(FRAMES_DIR, { recursive: true });
      const isSheet = url.searchParams.get("frames") != null;
      const opts = isSheet
        ? { frames: num("frames"), cols: num("cols", null), from: num("from", 0), to: num("to", undefined), width: num("w", 320), quality: url.searchParams.get("q") }
        : { t: num("t", 0), width: num("w", 768), quality: url.searchParams.get("q") };
      // Key on the source's identity + size + mtime so an overwritten file
      // never serves a stale grab.
      const st = fs.statSync(file);
      const key = crypto.createHash("sha1")
        .update(JSON.stringify([file, st.size, Math.round(st.mtimeMs), opts])).digest("hex");
      const cache = path.join(FRAMES_DIR, key + ".jpg");
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(cache.replace(/\.jpg$/, ".json"), "utf8"));
      } catch { /* render below */ }
      // Self-healing: if the JPEG exists but meta doesn't, re-render so both are
      // written together. A partial write (JPEG with no meta) otherwise serves
      // 500 forever because meta stays null.
      if (!fs.existsSync(cache) || !meta) {
        const r = isSheet ? await frameGrid(file, opts) : await frame(file, opts);
        meta = isSheet
          ? { frames: r.frames, cols: r.cols, rows: r.rows, times: r.times, duration: r.duration, cellWidth: r.width, stats: r.stats }
          : { frames: 1, times: [r.time], stats: r.stats };
        meta.source = pathArg ? pathArg : src;
        const tmp = cache + ".tmp";
        fs.writeFileSync(tmp, r.jpeg);
        fs.renameSync(tmp, cache); // atomic: a half-written jpeg never gets cached
        fs.writeFileSync(cache.replace(/\.jpg$/, ".json"), JSON.stringify(meta));
        /* Bound the cache: every distinct argument set mints a file, so cap
           the directory oldest-first rather than letting it grow forever. */
        try { pruneCache(FRAMES_DIR); } catch { /* a prune failure is not the request's problem */ }
      } else {
        // Refresh LRU order so hot entries survive the prune above.
        try { fs.utimesSync(cache, new Date(), new Date()); } catch {}
      }
      /* text=1 answers JSON measurements instead of the picture, for agents and
         models that cannot see one. Same decode, no pixels over the wire. */
      if (url.searchParams.get("text") === "1") {
        sendJSON(res, 200, {
          source: meta.source, frames: meta.frames, times: meta.times,
          cols: meta.cols || null, rows: meta.rows || null, duration: meta.duration ?? null,
          stats: meta.stats || null,
        });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": fs.statSync(cache).size,
        "Cache-Control": "no-cache",
        "X-FableCut-Frame-Times": (meta.times || []).join(","),
        "X-FableCut-Frame-Source": encodeURI(meta.source || src),
      });
      fs.createReadStream(cache).pipe(res);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      /* A bad argument, a missing file, or a timestamp past the end is the
         caller's problem; anything else is ours. */
      sendJSON(res, /must be|File not found|no video|no frame|past the end/.test(msg) ? 400 : 500, { error: msg });
    }
    return;
  }

  /* API: noise reduction — POST {src:"/media/…"|"/library/…", amount:"light"|"medium"|"strong"}
     writes a denoised FLAC of the whole file into media/ (reused if it exists)
     and returns {src, name, duration, channels}. Registering it is the caller's job. */
  if (p === "/api/denoise" && req.method === "POST") {
    if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH — noise reduction needs it" }); return; }
    try {
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!DENOISE_AMOUNTS.includes(opts.amount)) { sendJSON(res, 400, { error: `amount must be one of ${DENOISE_AMOUNTS.join(", ")}` }); return; }
      const file = resolveSrc(opts.src);
      if (!file) {
        sendJSON(res, 404, { error: "src must name an existing file under /media/ or /library/" });
        return;
      }
      const r = await denoiseFile(file, MEDIA_DIR, opts.amount);
      sendJSON(res, 200, { src: "/media/" + encodeURIComponent(r.name), name: r.name, duration: r.duration, channels: r.channels, cached: r.cached });
    } catch (e) { sendJSON(res, 500, { error: String(e.message || e) }); }
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

  /* Media files (subfolders too — relinked footage can sit in one) */
  if (p.startsWith("/media/")) {
    const file = path.normalize(path.join(MEDIA_DIR, p.slice("/media/".length)));
    if (!file.startsWith(MEDIA_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    serveFile(req, res, file);
    return;
  }

  /* Proxies (analysis/proxies) */
  if (p.startsWith("/proxies/")) {
    const file = proxies.file(p.slice("/proxies/".length));
    if (!file) { res.writeHead(404); res.end(); return; }
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
  if (DATA_DIR !== APP_DIR) console.log(`  app files    : ${APP_DIR}`);
  console.log(`  ffmpeg       : ${HAS_FFMPEG ? "found (fast export + faststart remux on)" : "not found (real-time export only)"}`);
  const enc = loadEncodeProfiles(true);
  console.log(`  encode prof. : ${PROFILES_FILE} (${Object.keys(enc.profiles).join(", ")} · default ${enc.default})`);
  for (const issue of enc.issues || []) console.log(`     ⚠ ${issue}`);
  console.log("");
  startExportSweep();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopExportSweep();
  for (const id of [...exportSessions.keys()]) cleanupExport(id);
  exportJobs.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);