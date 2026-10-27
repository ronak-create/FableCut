/* ═══════════════════════════════════════════════════════════════════════════
   FableCut reference analyzer — zero-dependency Node.js (needs ffmpeg on PATH)

   Turns a reference video into an "edit blueprint": shot boundaries (cuts),
   music beats + BPM, an audio-energy curve, the drop, and the extracted music
   track — everything an agent needs to rebuild the same edit with new footage.

   Use as a module:   const { analyze, frame, frameGrid } = require("./analyze");
   Use from the CLI:  node analyze.js media/ref.mp4 [--threshold=0.3] [--no-music]
                      node analyze.js --frame=3.2 media/ref.mp4 > frame.jpg
                      node analyze.js --sheet=12 media/ref.mp4 > sheet.jpg
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Stats = require("./frame-stats");
const Beats = require("./beats");

const SR = 22050;      // analysis sample rate
const HOP = 512;       // onset-envelope hop size (~23 ms)
const WIN = 1024;      // energy window

function run(cmd, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    const out = [], err = [];
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => err.push(c));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({
      code,
      stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

/* ── ffprobe: container + stream facts ── */
async function probe(file) {
  const r = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  if (r.code !== 0) throw new Error("ffprobe failed: " + r.stderr.slice(-400));
  const info = JSON.parse(r.stdout);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  const dur = parseFloat(info.format?.duration || v?.duration || a?.duration || 0);
  let fps = 0;
  if (v?.avg_frame_rate && v.avg_frame_rate !== "0/0") {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    if (d) fps = n / d;
  }
  return {
    duration: Math.round(dur * 1000) / 1000,
    fps: Math.round(fps * 100) / 100,
    width: v?.width || 0, height: v?.height || 0,
    hasVideo: !!v, hasAudio: !!a,
  };
}

/* ── Shot boundaries via ffmpeg scene-change scores ── */
async function detectCuts(file, threshold) {
  const r = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file,
    "-vf", `select='gt(scene,${threshold})',metadata=print:file=-`,
    "-an", "-f", "null", "-",
  ]);
  // stdout pairs: "frame:0 pts:… pts_time:4.100" then "lavfi.scene_score=0.482"
  const cuts = [];
  let t = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const mT = /pts_time:([\d.]+)/.exec(line);
    if (mT) { t = parseFloat(mT[1]); continue; }
    const mS = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (mS && t !== null) {
      cuts.push({ t: Math.round(t * 1000) / 1000, score: Math.round(parseFloat(mS[1]) * 1000) / 1000 });
      t = null;
    }
  }
  return cuts;
}

/* ── Audio: decode → onset envelope → beats + BPM + energy curve ── */
async function decodePCM(file) {
  const r = await run("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { binary: true });
  if (r.code !== 0 || r.stdout.length < WIN * 2) return null;
  const buf = r.stdout;
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/* beats, BPM, energy curve and drop: beats.js, shared with the editor's Beats section and fablecut_beats */
function analyzeAudio(pcm) {
  return Beats.analyze(pcm, { scale: 1 / 32768 });
}

/* ── Extract the reference's music track into its own audio file ── */
async function extractMusic(file, outDir) {
  const stem = path.basename(file, path.extname(file)).replace(/[^\w.\- ()\[\]]+/g, "_");
  let out = path.join(outDir, stem + "-music.m4a");
  let i = 1;
  while (fs.existsSync(out)) out = path.join(outDir, `${stem}-music_${i++}.m4a`);
  const r = await run("ffmpeg", ["-y", "-i", file, "-vn", "-c:a", "aac", "-b:a", "192k", out]);
  if (r.code !== 0) { try { fs.rmSync(out); } catch {} return null; }
  return out;
}

/* ── Frames: one JPEG still, or an N-up contact sheet ──
   The analyzer above is the "ears" — cuts, beats, energy. These are the "eyes":
   what is actually on screen at a given moment, so an agent picks a shot by
   looking instead of guessing from an energy number.

   A single frame is an input seek (-ss before -i): ffmpeg jumps to the keyframe
   at or before t and decodes forward, which is accurate and far cheaper than
   decoding everything up to t. Output goes to a pipe, not a temp file.

   Every grab also returns measurements (frame-stats.js) alongside the pixels,
   because the model on the other end of the MCP socket may not be able to see
   the image. One decode, two answers: the JPEG and the numbers. */

const MAX_SHEET_FRAMES = 60;   // one tile filter pass; more is a wall of thumbnails
const MAX_SHEET_COLS = 12;
const MIN_WIDTH = 32;
const MAX_WIDTH = 3840;
/* Measurements are taken from a decode this size, independent of the JPEG's:
   a colour histogram over a few thousand pixels says exactly as much as one
   over a few hundred thousand, and the mean luma of a downscaled frame is
   cleaner (no JPEG ringing around edges). */
const STATS_WIDTH = 64;
/* …and one contact-sheet cell's width, for the same reason. */
const STATS_CELL_W = 48;

function checkWidth(w) {
  const n = Math.round(Number(w) || 0);
  if (!Number.isFinite(n) || n < MIN_WIDTH || n > MAX_WIDTH)
    throw new Error(`width must be ${MIN_WIDTH}–${MAX_WIDTH} px`);
  return n;
}
function checkQuality(q) {
  const n = q == null ? 4 : Math.round(Number(q));
  if (!Number.isFinite(n) || n < 1 || n > 31) throw new Error("quality must be 1–31 (ffmpeg -q:v, lower is better)");
  return n;
}
/** Run an ffmpeg graph and hand back raw bytes.
 *  `pre` sits BEFORE -i (input seek), `post` after it (-t bounds the decode);
 *  `filter` is -vf. */
async function pipeOut(file, pre, filter, post, fmtArgs) {
  const args = ["-hide_banner", "-nostats", "-loglevel", "error", ...(pre || []), "-i", file];
  args.push(...(post || []), "-an", "-sn", "-dn", "-vf", filter, ...fmtArgs);
  const r = await run("ffmpeg", args, { binary: true });
  if (!r.stdout || !r.stdout.length) throw new Error("ffmpeg produced nothing — is the timestamp inside the clip? (has video?)");
  return r.stdout;
}
/** One JPEG of a frame, for the model to look at. */
const jpegOut = (file, pre, filter, quality, post) =>
  pipeOut(file, pre, filter, post, ["-frames:v", "1", "-c:v", "mjpeg", "-q:v", String(quality), "-f", "image2pipe", "-"])
    .then((buf) => {
      if (buf[0] !== 0xff || buf[1] !== 0xd8)
        throw new Error("ffmpeg produced no frame — is the timestamp inside the clip? (has video?)");
      return buf;
    });
/** One raw RGB24 decode of the same frame, to measure. */
const rgbOut = (file, pre, filter, post) =>
  pipeOut(file, pre, filter, post, ["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);

/** The graph every single-frame call shares, at two sizes. */
/** One still at `t` seconds. Returns {jpeg, time, stats, …}. */
async function frame(file, { t = 0, width = 768, quality, stats = true } = {}) {
  if (!fs.existsSync(file)) throw new Error("File not found: " + file);
  const at = Number(t);
  if (!Number.isFinite(at) || at < 0) throw new Error("t must be seconds ≥ 0");
  const w = checkWidth(width), q = checkQuality(quality);
  /* ffmpeg clamps an out-of-range seek and hands back the LAST frame, so an
     agent asking for a moment past the end would get a plausible-looking but
     wrong picture. Refuse instead of lying about where this is. */
  const info = await probe(file);
  if (!info.hasVideo) throw new Error("the file has no video track — there is no frame to look at");
  if (at >= info.duration) throw new Error(`t=${at} is past the end of the clip (${info.duration}s)`);
  const pre = ["-ss", String(at)]; // seek to the keyframe before t, decode forward
  const jpeg = await jpegOut(file, pre, `scale=${w}:-2:flags=bilinear`, q);
  let measured = null;
  if (stats) {
    /* -2 rounds the height to an even number, so the real pixel count can
       differ from width*height by one row; derive the height from the bytes
       rather than assuming it. */
    const raw = await rgbOut(file, pre, `scale=${STATS_WIDTH}:-2:flags=bilinear`);
    const h = Math.max(1, Math.round(raw.length / 3 / STATS_WIDTH));
    if (raw.length >= 3 * STATS_WIDTH) measured = Stats.describe(raw, STATS_WIDTH, h);
  }
  return { jpeg, time: at, width: w, frames: 1, duration: info.duration, stats: measured };
}

/** N frames spread across the whole clip in one grid image (left→right, top→bottom).
    Returns {jpeg, times[], cols, rows, …}. Cell i is the frame at times[i]. */
async function frameGrid(file, { frames = 12, cols = null, from = 0, to, width = 320, quality, stats = true } = {}) {
  if (!fs.existsSync(file)) throw new Error("File not found: " + file);
  const info = await probe(file);
  if (!info.hasVideo) throw new Error("the file has no video track — there is no frame to look at");
  const n = Math.round(Number(frames));
  if (!Number.isFinite(n) || n < 2 || n > MAX_SHEET_FRAMES)
    throw new Error(`frames must be 2–${MAX_SHEET_FRAMES}`);
  /* No cols given → the squarest layout: 6 frames give 3×2, not 4×2 with two
     black cells. ceil(√n) always fits MAX_SHEET_COLS for n ≤ 60, and an
     explicit cols still wins. */
  const c = cols == null ? Math.ceil(Math.sqrt(n)) : Math.round(Number(cols));
  if (!Number.isFinite(c) || c < 1 || c > MAX_SHEET_COLS) throw new Error(`cols must be 1–${MAX_SHEET_COLS}`);
  const rows = Math.ceil(n / c);
  const start = Number.isFinite(Number(from)) ? Math.max(0, Number(from)) : 0;
  const end = Number.isFinite(Number(to)) ? Number(to) : info.duration;
  if (!(end > start)) throw new Error("to must be greater than from");
  const w = checkWidth(width), q = checkQuality(quality);

  // One sample per bin, mid-bin: fps= gives us exactly n frames across the span.
  const times = Array.from({ length: n }, (_, i) => Math.round((start + (i + 0.5) * (end - start) / n) * 1000) / 1000);
  const fps = n / (end - start);
  // -ss to the start of the range and -t to bound it, so a survey of 30–90 s in
  // a 10-minute file doesn't decode the ten minutes. fps= then samples n
  // frames evenly across what is left.
  const pre = start > 0 ? ["-ss", String(start)] : [];
  const span = end - start;
  /* tile packs cols×rows input frames into one output frame and pads the final
     row with black if the input runs out — the mid-bin sampling above only
     misses by a frame at the very end, never a whole cell. */
  const graph = `fps=${fps.toFixed(6)},scale=${w}:-2:flags=bilinear,tile=${c}x${rows}`;
  const jpeg = await jpegOut(file, pre, graph, q, ["-t", String(span)]);

  let measured = null;
  if (stats !== false) {
    /* Measure the same grid with tiny cells — 48px wide is plenty for a
       histogram, a mean luma and a per-cell difference, and keeps the second
       decode cheap. scale=-2 keeps the cell's aspect, so the cell height
       follows from the pixel count: the grid holds cols×rows cells of
       STATS_CELL_W, and the byte count says how tall they came out. */
    const graph2 = `fps=${fps.toFixed(6)},scale=${STATS_CELL_W}:-2:flags=bilinear,tile=${c}x${rows}`;
    const raw = await rgbOut(file, pre, graph2, ["-t", String(span)]);
    const gw = c * STATS_CELL_W;
    const gh = Math.round(raw.length / 3 / gw);
    measured = gh >= rows
      ? Stats.describeGrid(raw, gw, gh, c, rows, times)
      : null;
  }
  return { jpeg, times, cols: c, rows, width: w, frames: n, duration: info.duration, stats: measured };
}

/* ── Main entry ──
   opts: threshold  — scene-cut sensitivity (default: adaptive 0.30→0.20→0.12)
         music      — extract the audio track (default true)
         musicDir   — where the extracted music file goes (default: next to file)
         srcUrl     — how `source`/`music` are reported (e.g. "/media/ref.mp4") */
async function analyze(file, opts = {}) {
  if (!fs.existsSync(file)) throw new Error("File not found: " + file);
  const info = await probe(file);

  // shots — adaptive threshold: relax until the cut density looks like an edit
  let cuts = [], threshold = null;
  if (info.hasVideo) {
    const tries = opts.threshold ? [opts.threshold] : [0.30, 0.20, 0.12];
    for (const t of tries) {
      threshold = t;
      cuts = await detectCuts(file, t);
      if (cuts.length >= Math.max(1, info.duration / 12)) break;
    }
    // drop first-frame artifacts and duplicate detections closer than 0.15 s
    cuts = cuts.filter((c) => c.t > 0.3);
    cuts = cuts.filter((c, i) => i === 0 || c.t - cuts[i - 1].t > 0.15);
  }

  // audio
  let audio = { beats: [], bpm: null, energy: { step: 0.5, values: [] }, drop: null };
  if (info.hasAudio) {
    const pcm = await decodePCM(file);
    if (pcm) audio = analyzeAudio(pcm);
  }

  // shot list with per-shot audio energy (intensity hint for footage mapping)
  const bounds = [0, ...cuts.map((c) => c.t), info.duration];
  const shots = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (end - start < 0.05) continue;
    const { step, values } = audio.energy;
    let e = null;
    if (values.length) {
      let s = 0, k = 0;
      for (let j = Math.floor(start / step); j < Math.min(values.length, Math.max(Math.floor(start / step) + 1, Math.ceil(end / step))); j++) { s += values[j]; k++; }
      e = k ? Math.round(s / k) : null;
    }
    shots.push({
      index: shots.length,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      duration: Math.round((end - start) * 1000) / 1000,
      energy: e,
    });
  }

  // music extraction
  let music = null;
  if (info.hasAudio && opts.music !== false) {
    const dir = opts.musicDir || path.dirname(file);
    const out = await extractMusic(file, dir);
    if (out) music = { file: out, name: path.basename(out) };
  }

  const avgShotLen = shots.length ? Math.round(shots.reduce((s, x) => s + x.duration, 0) / shots.length * 100) / 100 : null;
  return {
    source: opts.srcUrl || file,
    analyzedAt: new Date().toISOString(),
    duration: info.duration, fps: info.fps, width: info.width, height: info.height,
    hasAudio: info.hasAudio,
    sceneThreshold: threshold,
    cuts: cuts.map((c) => c.t),
    cutScores: cuts.map((c) => c.score),
    shots,
    avgShotLen,
    cutsPerSecond: info.duration ? Math.round(cuts.length / info.duration * 100) / 100 : 0,
    bpm: audio.bpm,
    beats: audio.beats,
    energy: audio.energy,
    drop: audio.drop,
    music: music ? { name: music.name, file: music.file } : null,
  };
}

module.exports = { analyze, frame, frameGrid };

/* ── CLI ── */
if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("Usage: node analyze.js <video> [--threshold=0.3] [--no-music]\n" +
    "       node analyze.js --frame=3.2 <video> > frame.jpg\n" +
    "       node analyze.js --sheet=12 --cols=4 <video> > sheet.jpg"); process.exit(1); }
  const arg = (k) => { const a = args.find((x) => x.startsWith("--" + k + "=")); return a ? a.slice(k.length + 3) : undefined; };
  const tArg = arg("threshold");
  const p = path.resolve(file);
  const write = (buf) => process.stdout.write(buf);
  if (args.some((a) => a.startsWith("--frame=") || a.startsWith("--sheet=")))
    (arg("sheet")
      ? frameGrid(p, { frames: +arg("sheet"), cols: arg("cols") == null ? null : +arg("cols"), from: arg("from"), to: arg("to"), width: +(arg("width") || 320), quality: arg("quality") })
      : frame(p, { t: +arg("frame"), width: +(arg("width") || 768), quality: arg("quality") })
    ).then((r) => write(r.jpeg))
      .catch((e) => { console.error("frame extraction failed: " + e.message); process.exit(1); });
  else
    analyze(p, {
      threshold: tArg ? parseFloat(tArg) : undefined,
      music: !args.includes("--no-music"),
    }).then((bp) => console.log(JSON.stringify(bp, null, 2)))
      .catch((e) => { console.error("analyze failed: " + e.message); process.exit(1); });
}
