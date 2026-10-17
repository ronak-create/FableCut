/* ═══════════════════════════════════════════════════════════════════════════
   Encoding profiles — user-editable ffmpeg settings for Fast export.

   A profile is a raw ffmpeg argument list plus the things that are NOT ffmpeg
   arguments: jpegQuality, extension, and optional `color` (output matrix/range).
   There is deliberately no allow-list — encoding-profiles.json is a local file
   the user owns, the browser only ever sends a profile *id*, and args are
   passed to spawn() as an array (no shell), so validating codec names would buy
   nothing but a smaller set of usable formats. Typos are caught by dryRunProfile
   against the real ffmpeg build instead, which also knows which encoders it has.

   Export is ONE ffmpeg pass; this module owns the input side (JPEG image2pipe
   by default, or canvas RGBA when pixelFormat is "rgba") plus color conversion
   and tags from profile.color; the profile owns everything in between:

     ffmpeg -y -thread_queue_size 64 -f image2pipe -framerate <fps>
            -c:v mjpeg -i - [-i audio.wav]
            <jpeg-color vf+tags> <profile args…> <out><extension>
   `pixelFormat: "rgba"` switches stdin to `-f rawvideo -pix_fmt rgba`.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROFILES_FILE = path.join(__dirname, "encoding-profiles.json");

/* Used when encoding-profiles.json is missing or unparseable, so export still
   works out of the box. Not a merge base: profiles are taken as written. */
const BUILTIN_ID = "delivery";
const DEFAULT_COLOR = {
  matrix: "bt709",
  primaries: "bt709",
  trc: "bt709",
  range: "tv", // tv = limited, pc = full
};
const BUILTIN = {
  label: "Delivery · H.264 balanced",
  description: "Built-in fallback — good quality and compatibility.",
  jpegQuality: 0.95,
  extension: ".mp4",
  color: { ...DEFAULT_COLOR },
  args: ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest"],
};

/* Flags the engine injects from profile.color — strip from user args so the
   JPEG vf out_* and the stream tags cannot disagree. */
const COLOR_ARG_FLAGS = new Set([
  "-colorspace", "-color_primaries", "-color_trc", "-color_range",
]);

let cache = null;
let cacheMtime = -1;

function normalizeColor(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const token = (v, fallback) => {
    const s = String(v == null ? "" : v).trim().toLowerCase();
    return /^[a-z0-9._-]+$/.test(s) ? s : fallback;
  };
  let range = token(c.range, DEFAULT_COLOR.range);
  if (range === "full") range = "pc";
  if (range === "limited") range = "tv";
  if (range !== "tv" && range !== "pc") range = DEFAULT_COLOR.range;
  const matrix = token(c.matrix ?? c.colorspace, DEFAULT_COLOR.matrix);
  return {
    matrix,
    primaries: token(c.primaries, matrix),
    trc: token(c.trc ?? c.transfer, matrix),
    range,
  };
}

function stripColorArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (COLOR_ARG_FLAGS.has(args[i])) { i++; continue; } // skip flag + value
    out.push(args[i]);
  }
  return out;
}

function normalizeProfile(id, raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  // a string is split on whitespace as a convenience; the array form is
  // canonical because it needs no quoting (e.g. -vf drawtext=text='hi')
  const args = Array.isArray(p.args)
    ? p.args.map(String)
    : String(p.args || "").split(/\s+/).filter(Boolean);
  let ext = String(p.extension || BUILTIN.extension).trim().toLowerCase();
  if (ext && !ext.startsWith(".")) ext = `.${ext}`;
  // one suffix only (".mp4") — reject paths, extra dots, empty, or odd chars
  if (!/^\.[a-z0-9]+$/.test(ext)) ext = BUILTIN.extension;
  const q = Number(p.jpegQuality);
  return {
    id,
    label: String(p.label || id),
    description: String(p.description || p.desc || ""),
    jpegQuality: q >= 0.1 && q <= 1 ? q : BUILTIN.jpegQuality,
    extension: ext,
    color: normalizeColor(p.color),
    args,
  };
}

function profilesFileMtime() {
  try { return fs.statSync(PROFILES_FILE).mtimeMs; } catch { return 0; }
}

function loadEncodeProfiles(force) {
  /* mtime check instead of a plain memo: the MCP server is long-lived and has
     no file watcher, so a cache-only read would serve stale profiles forever */
  const mtime = profilesFileMtime();
  if (cache && !force && mtime === cacheMtime) return cache;

  let file = null;
  const issues = [];
  try {
    if (fs.existsSync(PROFILES_FILE))
      file = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8").replace(/^\uFEFF/, ""));
    else issues.push(`${path.basename(PROFILES_FILE)} not found — using the built-in profile`);
  } catch (e) {
    issues.push(`${path.basename(PROFILES_FILE)} could not be parsed (${e.message}) — using the built-in profile`);
  }

  const profiles = {};
  if (file?.profiles && typeof file.profiles === "object")
    for (const [id, raw] of Object.entries(file.profiles)) profiles[id] = normalizeProfile(id, raw);
  for (const [id, p] of Object.entries(profiles))
    if (!p.args.length) issues.push(`profile "${id}" has no args — ffmpeg will pick its own defaults`);
  if (!Object.keys(profiles).length) profiles[BUILTIN_ID] = normalizeProfile(BUILTIN_ID, BUILTIN);

  let defaultId = typeof file?.default === "string" ? file.default : BUILTIN_ID;
  if (!profiles[defaultId]) {
    const first = Object.keys(profiles)[0];
    if (file?.default) issues.push(`default "${file.default}" is not a defined profile — using ${first}`);
    defaultId = first;
  }

  cache = { default: defaultId, profiles, issues };
  cacheMtime = mtime;
  return cache;
}

function invalidateEncodeProfiles() {
  cache = null;
  cacheMtime = -1;
}

function resolveProfile(id) {
  const cfg = loadEncodeProfiles();
  const pid = id || cfg.default;
  const p = cfg.profiles[pid];
  if (!p) throw new Error(`Unknown encoding profile "${pid}"`);
  return p;
}

function profileSummary(p, max = 120) {
  const s = (p.args || []).join(" ") || "(no args — ffmpeg defaults)";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function listProfilesPublic(detail) {
  const cfg = loadEncodeProfiles();
  const out = {
    default: cfg.default, profiles: {},
    file: path.basename(PROFILES_FILE),
    issues: cfg.issues || [],
  };
  for (const [id, p] of Object.entries(cfg.profiles)) {
    // jpegQuality + color are needed by the UI / agents — always included
    const base = {
      label: p.label,
      description: p.description,
      jpegQuality: p.jpegQuality,
      extension: p.extension,
      color: p.color,
      summary: profileSummary(p),
    };
    out.profiles[id] = detail ? { ...base, args: p.args } : base;
  }
  return out;
}

/* Canvas RGBA is full-range BT.709-ish (sRGB). JPEG/JFIF is full-range BT.601.
   Convert to the profile's output matrix/range and tag the stream, otherwise
   x264 emits bt470bg/pc/unknown and players do the wrong YUV→RGB conversion.
   Independent of -pix_fmt (420 vs 422/10-bit). */
function inputColorVf(color, inMatrix) {
  const c = color || DEFAULT_COLOR;
  const matrix = inMatrix === "bt601" ? "bt601" : "bt709";
  // Primaries / transfer are stamped on the frames too: frame colour
  // properties win over the -color_* flags added below, so without this the
  // file is tagged primaries/transfer "unknown". setparams (not scale's
  // out_primaries / out_transfer, which need FFmpeg 7.1+) works on older builds.
  return `scale=in_range=full:in_color_matrix=${matrix}:out_range=${c.range}:out_color_matrix=${c.matrix},` +
    `setparams=color_primaries=${c.primaries}:color_trc=${c.trc}`;
}
function jpegColorTags(color) {
  const c = color || DEFAULT_COLOR;
  return [
    "-colorspace", c.matrix,
    "-color_primaries", c.primaries,
    "-color_trc", c.trc,
    "-color_range", c.range,
  ];
}

function withInputColor(profile, inMatrix) {
  const color = profile.color || DEFAULT_COLOR;
  const vf = inputColorVf(color, inMatrix);
  const args = stripColorArgs((profile.args || []).slice());
  const vfAt = args.indexOf("-vf");
  if (vfAt >= 0 && args[vfAt + 1] != null) args[vfAt + 1] = `${vf},${args[vfAt + 1]}`;
  else args.unshift("-vf", vf);
  args.push(...jpegColorTags(color));
  return args;
}

/* The single export pass. Fast export sends JPEG image2pipe by default;
   `pixelFormat: "rgba"` is uncompressed canvas frames. Audio mix is on disk
   before spawn. */
function buildExportArgs(profile, { fps, wavPath, outPath, pixelFormat, width, height } = {}) {
  const args = ["-y", "-hide_banner"];
  const raw = pixelFormat === "rgba";
  if (raw) {
    const w = Math.max(2, width | 0), h = Math.max(2, height | 0);
    // Small queue: each raw frame is width×height×4 bytes (1080p ≈ 8 MiB).
    args.push(
      "-thread_queue_size", "8",
      "-f", "rawvideo", "-pix_fmt", "rgba",
      "-s", `${w}x${h}`, "-framerate", String(fps), "-i", "-",
    );
  } else {
    args.push(
      "-thread_queue_size", "64",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    );
  }
  if (wavPath) args.push("-i", wavPath);
  args.push(...withInputColor(profile, raw ? "bt709" : "bt601"), outPath);
  return args;
}

const DRY_RUN_TIMEOUT_MS = 15_000;

/* Run the profile's args once against a synthetic input before the browser
   renders anything. Without this a typo (or an encoder this ffmpeg build lacks)
   would only surface when ffmpeg exits — i.e. after every frame was rendered.
   Async spawn so /api/export/begin does not block the event loop. */
function dryRunProfile(profile, { fps = 30, hasAudio = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-dry-"));
  const out = path.join(dir, `probe${profile.extension}`);
  // 256×144: hardware encoders refuse tiny frames (NVENC's minimum is about
  // 145×49), and a profile that can't pass the dry run can never export.
  const args = ["-y", "-hide_banner", "-f", "lavfi",
    "-i", `color=c=black:s=256x144:r=${fps}:d=0.1`];
  if (hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-t", "0.1", ...withInputColor(profile, "bt709"), out);
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let proc;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
      resolve(result);
    };
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      finish({ ok: false, error: e.message || String(e) });
      return;
    }
    timer = setTimeout(() => {
      try { proc.kill(); } catch { }
      finish({ ok: false, error: `ffmpeg dry-run timed out after ${DRY_RUN_TIMEOUT_MS}ms` });
    }, DRY_RUN_TIMEOUT_MS);
    proc.on("error", (e) => finish({ ok: false, error: e.message || String(e) }));
    proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on("close", (code) => {
      if (code === 0) { finish({ ok: true }); return; }
      // ffmpeg ends with generic lines ("Conversion failed!"); lead with the ones naming the cause
      const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      const cause = lines.filter((l) => /error|invalid|unknown|not found|unrecognized|failed|minimum|unsupported|no such/i.test(l)
        && !/^Conversion failed/i.test(l));
      const picked = cause.length ? cause.slice(0, 2).concat(lines.slice(-1)) : lines.slice(-3);
      finish({ ok: false, error: [...new Set(picked)].join(" · ") || `ffmpeg exited ${code}` });
    });
  });
}

module.exports = {
  PROFILES_FILE,
  DEFAULT_COLOR,
  loadEncodeProfiles,
  invalidateEncodeProfiles,
  resolveProfile,
  listProfilesPublic,
  profileSummary,
  buildExportArgs,
  dryRunProfile,
};
