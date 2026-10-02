/* Noise reduction — render and replace. The file's noise floor is measured
   first (astats: the level of its quietest stretches), then ffmpeg's FFT
   denoiser (afftdn) pulls everything near that floor down and writes a FLAC
   beside it in media/. Clips then play that file instead; the original
   stays registered, so switching back is instant. The whole file is
   processed, not just a clip's window, so `in` points stay valid and linked
   stems keep their timing (and their channel layout). Used by server.js
   (POST /api/denoise) and the MCP server (fablecut_denoise). */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

/* nr: how far the noise is pulled down, dB. The floor is measured per file —
   afftdn's own noise tracking (tn) left loud hiss untouched in testing. */
const AMOUNTS = {
  light: { nr: 10, label: "Light" },
  medium: { nr: 18, label: "Medium" },
  strong: { nr: 30, label: "Strong" },
};
const AMOUNT_IDS = Object.keys(AMOUNTS);

/** media/ file name for a denoised copy, e.g. "take 3.denoise-medium.flac". */
function denoiseName(srcName, amount) {
  const base = path.basename(decodeURIComponent(String(srcName).split("?")[0]));
  const stem = base.replace(/\.[^.]+$/, "").replace(/\.denoise-(light|medium|strong)$/, "");
  return `${stem}.denoise-${amount}.flac`;
}
function probe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=channels:format=duration", "-of", "json", file], { encoding: "utf8" });
  if (r.error) throw new Error("ffprobe not found on PATH — needed for noise reduction");
  try {
    const j = JSON.parse(r.stdout);
    return { channels: j.streams?.[0]?.channels || 0, duration: Math.round(+j.format?.duration * 1000) / 1000 || undefined };
  } catch { return { channels: 0, duration: undefined }; }
}
/** The file's noise floor, dB RMS: the 10th-percentile level of its 50 ms
 *  windows (mono, 16 kHz) — the room tone between words, steady from run to
 *  run where a single quietest window is not. Digital silence is skipped. */
function measureNoiseFloor(file) {
  return new Promise((resolve, reject) => {
    const SR = 16000, WIN = SR / 20;
    const proc = spawn("ffmpeg", ["-v", "error", "-i", file, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
    const levels = [];
    let sum = 0, n = 0, rest = Buffer.alloc(0);
    proc.stdout.on("data", (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const count = Math.floor(buf.length / 4);
      for (let i = 0; i < count; i++) {
        const x = buf.readFloatLE(i * 4);
        sum += x * x;
        if (++n === WIN) { if (sum > 1e-12) levels.push(sum / WIN); sum = 0; n = 0; }
      }
      rest = buf.subarray(count * 4);
    });
    proc.stderr.resume();
    proc.on("error", () => reject(new Error("ffmpeg not found on PATH — needed for noise reduction")));
    proc.on("close", () => {
      if (!levels.length) return resolve(-80);
      levels.sort((a, b) => a - b);
      resolve(10 * Math.log10(levels[Math.floor(levels.length * 0.1)]));
    });
  });
}
/* afftdn's nf sits a little above the measured RMS floor (its noise model
   reads louder than plain RMS); the result is clamped to its −80…−20 range. */
const FLOOR_OFFSET_DB = 4;
/** Denoise `file` into `outDir`. Resolves {file, name, duration, channels, cached}.
 *  An existing output with the same name is reused. */
function denoiseFile(file, outDir, amount) {
  const a = AMOUNTS[amount];
  if (!a) return Promise.reject(new Error(`amount must be one of ${AMOUNT_IDS.join(", ")}`));
  const name = denoiseName(file, amount);
  const out = path.join(outDir, name);
  if (fs.existsSync(out) && fs.statSync(out).size > 0)
    return Promise.resolve({ file: out, name, cached: true, ...probe(out) });
  const src = probe(file);
  if (!src.channels) return Promise.reject(new Error(`${path.basename(file)} has no audio to clean up`));
  const part = out + ".part.flac";
  return measureNoiseFloor(file).then((floor) => new Promise((resolve, reject) => {
    const nf = Math.round(Math.min(-20, Math.max(-80, floor + FLOOR_OFFSET_DB)) * 10) / 10;
    const proc = spawn("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-map", "0:a:0",
      "-af", `afftdn=nr=${a.nr}:nf=${nf}`, "-c:a", "flac", part]);
    let err = "";
    proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    proc.on("error", () => reject(new Error("ffmpeg not found on PATH — needed for noise reduction")));
    proc.on("close", (code) => {
      if (code !== 0) {
        try { fs.rmSync(part, { force: true }); } catch {}
        return reject(new Error("ffmpeg denoise failed: " + (err.trim().split("\n").pop() || code)));
      }
      fs.renameSync(part, out);
      resolve({ file: out, name, cached: false, noiseFloor: nf, ...probe(out) });
    });
  }));
}

/** The media a clip's sound comes from originally (a denoised copy points back). */
function baseMediaId(doc, id) {
  return doc.media.find((m) => m.id === id)?.derivedFrom || id;
}
/** The audio clips a selection's noise reduction applies to: an audio clip and
 *  its linked stems, or a video's stems. Throws for a picture that carries its
 *  own sound (no stems) — its file can't be swapped without the picture. */
function denoiseTargets(doc, clips) {
  const out = new Map();
  for (const c of clips) {
    const group = c.linkGroup ? doc.clips.filter((x) => x.linkGroup === c.linkGroup) : [c];
    const stems = group.filter((x) => x.kind === "audio" && x.mediaId);
    if (!stems.length) {
      if (c.kind === "video") throw new Error(`clip ${c.id}: its sound plays from the picture (no linked audio stems) — noise reduction works on audio clips`);
      throw new Error(`clip ${c.id} is ${c.kind} — no audio to clean up`);
    }
    for (const s of stems) out.set(s.id, s);
  }
  return [...out.values()];
}

module.exports = { AMOUNTS, AMOUNT_IDS, denoiseName, denoiseFile, measureNoiseFloor, baseMediaId, denoiseTargets };
