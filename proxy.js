/* Proxies: light copies of heavy footage (4K, HEVC, ProRes, long-GOP phone
   video) that the editor plays while you cut. Export always reads the
   original, so a proxy only ever changes how smoothly the preview runs.

   A proxy is H.264 at 540p / 720p / 1080p (never larger than the source),
   with a short GOP (a keyframe every 12 frames) so scrubbing seeks fast, the
   source's own timestamps (no frames added or dropped) and its first audio
   stream. It lives in analysis/proxies/ — a disposable cache, like the frame
   grabs — named after the source file *and its size and mtime*: when the
   original changes, its old proxy simply stops matching.

     createProxies({dir, resolveSrc, probe, broadcast, ffmpeg?}) → {   (probe: async, media-probe.js)
       status(src)           → Promise of {state:"ready", src:"/proxies/…", height, width?, size}
                              | {state:"queued"|"running", progress 0…1, height}
                              | {state:"failed", error} | {state:"none"} | null (no such file)
       start(src, height?)   → Promise of a status (queued, or ready when one exists at that height)
       remove(src)           → number of proxy files deleted (a running job is stopped)
       file(name)            → the path of a proxy file to serve, or null
     }
   Jobs run one at a time; each broadcasts SSE event "proxy" ({src, status})
   as it starts, every ~0.5 s of progress, and when it ends. */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HEIGHTS = [540, 720, 1080];
const DEFAULT_HEIGHT = 540;

/** "<stem>-<hash of path, size and mtime>" — every proxy of this version of the file starts with it. */
function baseName(file) {
  const st = fs.statSync(file);
  const h = crypto.createHash("sha1").update(path.resolve(file) + "|" + st.size + "|" + Math.round(st.mtimeMs)).digest("hex").slice(0, 10);
  const stem = path.basename(file, path.extname(file)).replace(/[^\w\-]+/g, "_").slice(0, 40) || "media";
  return `${stem}-${h}`;
}
/** Existing proxies of this version of the file in dir, best (largest) first: [{name, height}]. */
function findProxies(dir, file) {
  let base;
  try { base = baseName(file) + "-"; } catch { return []; }
  let names = [];
  try { names = fs.readdirSync(dir); } catch { }
  return names.map((n) => { const m = n.startsWith(base) && /-(\d+)p\.mp4$/.exec(n); return m ? { name: n, height: +m[1] } : null; })
    .filter(Boolean).sort((a, b) => b.height - a.height);
}

function createProxies({ dir, resolveSrc, probe, broadcast = () => { }, ffmpeg = "ffmpeg" }) {
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();   // src → job {src, file, out, height, state, progress, error, proc}
  const queue = [];
  let running = null;
  let fpsModeFlag = ["-fps_mode", "passthrough"];   // ffmpeg ≥ 5.1; older builds get -vsync 0
  const existing = (file) => findProxies(dir, file);
  async function readyStatus(e) {
    const full = path.join(dir, e.name);
    let size = 0; try { size = fs.statSync(full).size; } catch { }
    const info = probe ? await probe(full) : null;
    return { state: "ready", src: "/proxies/" + encodeURIComponent(e.name), height: (info && info.height) || e.height, width: info && info.width, size };
  }
  function jobStatus(j) {
    if (j.state === "failed") return { state: "failed", error: j.error, height: j.height };
    return { state: j.state, progress: Math.round((j.progress || 0) * 1000) / 1000, height: j.height };
  }
  async function status(src) {
    const file = resolveSrc(src);
    if (!file) return null;
    const j = jobs.get(src);
    if (j && j.file === file && (j.state === "queued" || j.state === "running" || j.state === "failed")) return jobStatus(j);
    const e = existing(file)[0];
    return e ? readyStatus(e) : { state: "none" };
  }
  async function tell(j) {
    try { broadcast("proxy", JSON.stringify({ src: j.src, status: j.state === "done" ? await status(j.src) : jobStatus(j) })); } catch { }
  }

  async function start(src, height = DEFAULT_HEIGHT) {
    const file = resolveSrc(src);
    if (!file) return null;
    height = HEIGHTS.includes(+height) ? +height : DEFAULT_HEIGHT;
    const have = existing(file).find((e) => e.height === height);
    if (have) return readyStatus(have);
    const cur = jobs.get(src);
    if (cur && (cur.state === "queued" || cur.state === "running") && cur.height === height) return jobStatus(cur);
    if (cur && (cur.state === "queued" || cur.state === "running")) cancel(src);
    const j = { src, file, height, out: path.join(dir, `${baseName(file)}-${height}p.mp4`), state: "queued", progress: 0 };
    jobs.set(src, j);
    queue.push(j);
    tell(j);
    pump();
    return jobStatus(j);
  }

  function args(j, part, fpsMode) {
    return ["-y", "-hide_banner", "-v", "error", "-nostdin", "-i", j.file,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale=-2:'min(ih,${j.height})':flags=bicubic`,
      ...fpsMode,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-g", "12", "-keyint_min", "12", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart", "-map_metadata", "-1",
      "-progress", "pipe:1", "-nostats", "-f", "mp4", part];
  }
  async function pump() {
    if (running || !queue.length) return;
    const j = queue.shift();
    if (j.state !== "queued") return pump();
    running = j;
    j.state = "running";
    const info = probe ? await probe(j.file) : null;
    // cancelled (deleted, or asked again at another size) while the probe ran
    if (j.state !== "running") { finish(); return; }
    const dur = (info && info.duration) || 0;
    const part = j.out + ".part";
    let err = "", last = 0;
    const run = (fpsMode, retried) => {
      const proc = j.proc = spawn(ffmpeg, args(j, part, fpsMode), { windowsHide: true });
      proc.stdout.on("data", (d) => {
        const m = /out_time_(?:us|ms)=(\d+)/.exec(String(d).split("\n").reverse().join("\n"));
        if (m && dur > 0) {
          j.progress = Math.min(0.99, +m[1] / 1e6 / dur);
          const now = Date.now();
          if (now - last > 500) { last = now; tell(j); }
        }
      });
      proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
      proc.on("error", (e) => { err = String(e.message || e); });
      proc.on("close", (code) => {
        j.proc = null;
        if (j.state === "cancelled") { try { fs.unlinkSync(part); } catch { } finish(); return; }
        if (code !== 0 && !retried && /fps_mode|Unrecognized option/i.test(err)) {
          fpsModeFlag = ["-vsync", "0"]; err = "";
          return run(fpsModeFlag, true);
        }
        if (code === 0) {
          try { fs.renameSync(part, j.out); j.state = "done"; j.progress = 1; }
          catch (e) { j.state = "failed"; j.error = String(e.message || e); }
        } else {
          try { fs.unlinkSync(part); } catch { }
          j.state = "failed";
          j.error = (err.trim().split("\n").pop() || `ffmpeg exited with ${code}`).slice(0, 300);
        }
        tell(j);
        if (j.state === "done") jobs.delete(j.src);
        finish();
      });
    };
    tell(j);
    run(fpsModeFlag, false);
  }
  function finish() { running = null; pump(); }

  function cancel(src) {
    const j = jobs.get(src);
    if (!j) return;
    if (j.state === "queued") { j.state = "cancelled"; jobs.delete(src); }
    else if (j.state === "running") { j.state = "cancelled"; try { j.proc && j.proc.kill(); } catch { } jobs.delete(src); }
    else jobs.delete(src);
  }
  function remove(src) {
    cancel(src);
    const file = resolveSrc(src);
    if (!file) return 0;
    let n = 0;
    for (const e of existing(file)) { try { fs.unlinkSync(path.join(dir, e.name)); n++; } catch { } }
    broadcast("proxy", JSON.stringify({ src, status: { state: "none" } }));
    return n;
  }
  /** A proxy file to serve, by its name — only straight names inside dir. */
  function file(name) {
    if (!name || /[\\/]/.test(name) || name.startsWith(".") || !/\.mp4$/i.test(name)) return null;
    const full = path.join(dir, name);
    try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
  }

  return { status, start, remove, cancel, file, HEIGHTS, DEFAULT_HEIGHT };
}

module.exports = { createProxies, findProxies, HEIGHTS, DEFAULT_HEIGHT };
