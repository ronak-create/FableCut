/* ═══════════════════════════════════════════════════════════════════════════
   FableCut MCP server — connects Claude (Code / Desktop) to the video editor.
   Zero-dependency stdio JSON-RPC (Model Context Protocol).

   Register once for all Claude Code sessions:
     claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"

   Tools: fablecut_status, fablecut_docs, fablecut_get_project,
          fablecut_set_project, fablecut_patch_project, fablecut_import_media,
          fablecut_analyze_reference, fablecut_encode_profiles
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { loadEncodeProfiles, listProfilesPublic, resolveProfile, profileSummary } = require("./encode-profiles");

const {
  APP_DIR, DATA_DIR, MEDIA_DIR, ANALYSIS_DIR, LIBRARY_DIR, PROJECT_FILE, ensureDirs,
} = require("./paths");
const { downloadImportUrl, kindFromName, maybeFaststart } = require("./import-url");
const FX = require("./audio-fx");

/* ROOT is where the code lives (server.js, CLAUDE.md); the user's timeline and
   media live under DATA_DIR. Identical unless FABLECUT_DATA_DIR is set. */
const ROOT = APP_DIR;
ensureDirs();
const PORT = process.env.FABLECUT_PORT || 7777;
const BASE = `http://localhost:${PORT}`;

/* MCP initialize must echo a version we actually speak. Echoing an unknown
   client version (or crashing) fails handshake with stock SDK clients. */
const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];
const MCP_DEFAULT_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
function negotiateProtocolVersion(requested) {
  return MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_DEFAULT_PROTOCOL_VERSION;
}

/* ── Helpers ── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readProject() {
  const raw = fs.readFileSync(PROJECT_FILE, "utf8").replace(new RegExp("^\\uFEFF"), "");
  return JSON.parse(raw);
}
function writeProject(doc) {
  // atomic tmp+rename so the UI's file watcher never sees a half-written doc
  const tmp = PROJECT_FILE + ".mcp.tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, PROJECT_FILE);
}
/* Optimistic concurrency: revision of project.json when this session last read
   the full document. If the file has moved past it by write time, someone else
   (usually the user, in the editor UI) edited in between — refuse to clobber. */
let lastReadRevision = null;
function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (r) => { r.resume(); resolve(r.statusCode < 500); });
    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
  });
}
async function ensureUIServer() {
  if (await httpOk(BASE + "/api/project")) return true;
  spawn(process.execPath, [path.join(ROOT, "server.js")],
    { cwd: ROOT, detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 12; i++) {
    await sleep(300);
    if (await httpOk(BASE + "/api/project")) return true;
  }
  return false;
}
const KIND_BY_EXT = {
  ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".m4v": "video", ".avi": "video",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "svg",
};
function ffprobeDuration(file) {
  try {
    const r = spawnSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8", timeout: 10_000 });
    const d = parseFloat((r.stdout || "").trim());
    return isNaN(d) ? undefined : Math.round(d * 1000) / 1000;
  } catch { return undefined; }
}
const uid = () => Math.random().toString(36).slice(2, 9);

/* ── Tool definitions ── */
const TOOLS = [
  {
    name: "fablecut_status",
    description: "FableCut video editor: ensure the editor web server is running (auto-starts it), and get the editor URL, project summary and media library. Call this first in a session.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fablecut_docs",
    description: "Return the FableCut project schema documentation: clips, tracks, props, keyframe animation, transitions, and editing recipes. Read this before editing. TOKEN TIP: pass `section` to fetch only the '## …' section(s) you need (substring match, e.g. \"props\", \"Recipes\", \"Remake\") instead of the whole manual.",
    inputSchema: {
      type: "object",
      properties: { section: { type: "string", description: "Return only '## ' sections whose heading contains this text (case-insensitive). Omit for the full document." } },
    },
  },
  {
    name: "fablecut_get_project",
    description: "Get the FableCut project (the timeline document). TOKEN TIP: pass compact:true for a one-line-per-clip summary (ids, tracks, timings, non-default props) — usually all you need to plan an edit; fetch the full JSON only when you must inspect exact keyframes.",
    inputSchema: {
      type: "object",
      properties: { compact: { type: "boolean", description: "Return a compact human-readable summary instead of the full JSON" } },
    },
  },
  {
    name: "fablecut_patch_project",
    description: "Apply targeted edits to the FableCut project WITHOUT round-tripping the whole document — PREFER THIS over get+set for every edit (it is ~10-100x cheaper in tokens and merge-safe by design: it re-reads the latest document from disk, applies your ops in order, bumps revision once, saves atomically). Ops: {op:'addClip', clip:{…}} (id auto-generated if omitted) · {op:'updateClip', id, set:{…}} · {op:'removeClip', id} · {op:'addMedia', media:{…}} · {op:'removeMedia', id} · {op:'setProject', set:{name|width|height|fps|background|markers|disabledTracks|lockedTracks|untargetedTracks|encodeProfile|master}} (markers = the full list [{t, label?, color?}], color: gold|red|orange|green|cyan|blue|purple|pink; master = {gain}, the master fader in dB) · {op:'setTrack', id:'A1', set:{gain?, pan?}} (audio-track fader in dB −60…+12 and pan −1…1; null or 0 resets) · {op:'setFx', target:'clip'|'track'|'master', id?, preset?:'podcast'|… OR fx:[{type,…params}], append?:true} (audio effects — validated; presets: clean-voice, podcast, radio, deep-voice, telephone, cinematic, wide, muffled; fx:null clears; on a clip it applies to its linked stems too; see the 'Audio mix' docs section). updateClip merge rules: top-level keys are replaced (keyframes/transitionIn/transitionOut wholesale), `props` merges key-by-key, and setting any key to null deletes it. LOCKS: the user can lock clips (`locked:true`) and tracks (`lockedTracks`); updateClip / removeClip on a locked clip — or on a clip linked to one — and addClip onto a locked track are refused. Leave locked material alone; only if the user asked you to change it, pass force:true on that op (or unlock first: updateClip set:{locked:null}, which is always allowed). All-or-nothing: an invalid op aborts the whole patch unsaved.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: { type: "object" },
          description: "Edit operations, applied in order (see tool description for shapes). Any op may carry force:true to override a lock the user set.",
        },
      },
      required: ["ops"],
    },
  },
  {
    name: "fablecut_set_project",
    description: "Replace the FableCut project JSON. Pass the COMPLETE document (read with fablecut_get_project, modify, send back whole). Revision is auto-bumped; the open editor UI hot-reloads instantly so the user sees the edit live. CONFLICT-SAFE: if the project changed on disk since your last fablecut_get_project (e.g. the user tweaked something in the UI), the call errors instead of overwriting — re-read, re-apply your edit on top of the latest document, and retry.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "object", description: "The complete project document (see fablecut_docs for schema)" },
        force: { type: "boolean", description: "Overwrite even if the project changed since it was last read (discards those external/user changes). Only when the user explicitly asks." },
      },
      required: ["project"],
    },
  },
  {
    name: "fablecut_analyze_reference",
    description: "Analyze a reference video into an EDIT BLUEPRINT so a similar edit can be rebuilt with different footage over the same music. Returns: shot boundaries (cuts) with per-shot audio energy, music beats + BPM, a loudness curve, the detected drop, and extracts the reference's music track into media/ (registered in the project, ready to place on A1). Remake recipe: copy the reference's width/height/fps to the project, write `beats` into project `markers`, lay the extracted music on A1, then place one clip per blueprint `shot` at the same start/duration — pick calm footage for low-energy shots and action for high-energy ones, and make the biggest moment land on `drop`. See the 'Remake a reference video' section of fablecut_docs.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The reference video: an absolute file path (copied into media/ automatically) or an existing '/media/…' src" },
        threshold: { type: "number", description: "Scene-cut sensitivity 0–1 (default: adaptive 0.30→0.20→0.12). Lower it if obvious cuts are missed, raise it if too many false cuts." },
        registerMusic: { type: "boolean", description: "Extract the reference's music and register it as project media (default true)" },
      },
      required: ["path"],
    },
  },
  {
    name: "fablecut_import_media",
    description: "Import a media file into FableCut's media library and register it in the project. Pass a local absolute path (copied, including .svg) or an https:// URL (downloaded into ./media/; video/audio/image only — remote SVG is refused). The URL is never kept as the playback src — CORS would break export. Returns the created media entry (use its id in clips).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to a local file, or an https:// URL to download" } },
      required: ["path"],
    },
  },
  {
    name: "fablecut_encode_profiles",
    description: "List ffmpeg encoding profiles for Fast export (from encoding-profiles.json). Each profile is a raw ffmpeg argument list plus jpegQuality, extension, and optional color (output matrix/range — default BT.709 tv). Use to pick a profile id for project.encodeProfile. Edit encoding-profiles.json on disk to add custom profiles — anything the local ffmpeg supports works, and the server hot-reloads the file. Profiles are dry-run against ffmpeg when an export starts, so a bad argument is rejected before rendering.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "boolean", description: "Include the full ffmpeg args array per profile (default: a truncated summary)" },
        profile: { type: "string", description: "Return one profile by id instead of the full list" },
      },
    },
  },
  {
    name: "fablecut_normalize_audio",
    description: "Loudness-normalize clips: measures each clip's source audio (ITU-R BS.1770 integrated LUFS, or sample peak) after its channel routing and sets `props.gain` (clip gain, dB) so it lands on the target — the same measurement as the editor's Normalize button. Linked stems (a video's per-channel audio clips) are measured together and get one shared gain, so a stereo pair stays balanced; passing a video clip normalizes its stems. Volume keyframes / fades are untouched (they ride on top). Typical targets: -14 LUFS streaming/social, -16 LUFS podcast/dialogue, -23 LUFS broadcast, or mode 'peak' at -1 dBFS. Needs ffmpeg + ffprobe on PATH. Refuses locked clips unless force:true.",
    inputSchema: {
      type: "object",
      properties: {
        clipIds: { type: "array", items: { type: "string" }, description: "Clips to normalize (audio, or video with audio)" },
        mode: { type: "string", enum: ["lufs", "peak"], description: "Measure integrated loudness (default) or sample peak" },
        target: { type: "number", description: "Target level: LUFS for mode lufs (default -14), dBFS for mode peak (default -1)" },
        force: { type: "boolean", description: "Also change clips the user locked (only when they asked)" },
      },
      required: ["clipIds"],
    },
  },
  {
    name: "fablecut_auto_duck",
    description: "Duck music under dialogue: finds where the voice tracks have sound (RMS above `threshold`, short gaps bridged so the music doesn't pump between words) and writes `duck` keyframes (dB) on the given music clips — a dip of `amount` dB ramping down `attack` s before speech and back up `release` s after. The duck multiplies the clip's volume, so its own level, volume keyframes and fades are untouched, and re-running replaces the previous dips (amount 0 clears them). Voice = every audio clip on `under` tracks (default: all audio tracks the music isn't on). Linked stems of a music clip get the same keys. The same pipeline as the editor's Auto-duck. Needs ffmpeg + ffprobe on PATH. Refuses locked clips unless force:true.",
    inputSchema: {
      type: "object",
      properties: {
        clipIds: { type: "array", items: { type: "string" }, description: "The music / bed clips to duck" },
        under: { type: "array", items: { type: "string" }, description: "Audio tracks holding the voice, e.g. [\"A1\"] (default: every other audio track)" },
        amount: { type: "number", description: "Dip depth in dB, -40…0 (default -12; 0 removes the ducking)" },
        threshold: { type: "number", description: "Voice detection level in dBFS (default -40; raise it if room noise triggers ducks)" },
        attack: { type: "number", description: "Seconds to ramp down before speech (default 0.3)" },
        release: { type: "number", description: "Seconds to ramp back up after speech (default 0.6)" },
        force: { type: "boolean", description: "Also change clips the user locked (only when they asked)" },
      },
      required: ["clipIds"],
    },
  },
];

/* ── Loudness normalize (fablecut_normalize_audio) ──
   Decodes each clip's source window with ffmpeg and measures it with the same
   loudness.js the editor uses, so agent and UI land on identical gains. */
const DEFAULT_TRACKS = [
  { id: "V3", kind: "video" }, { id: "V2", kind: "video" }, { id: "V1", kind: "video" },
  { id: "A1", kind: "audio" }, { id: "A2", kind: "audio" }, { id: "A3", kind: "audio" }, { id: "A4", kind: "audio" },
];
const NORM_SR = 48000;
function mediaFile(src) {
  const p = decodeURIComponent(String(src || "").split("?")[0]);
  const [root, rel] = p.startsWith("/media/") ? [MEDIA_DIR, p.slice(7)]
    : p.startsWith("/library/") ? [LIBRARY_DIR, p.slice(9)] : [null, null];
  if (!root) return null;
  const file = path.normalize(path.join(root, rel));
  return file.startsWith(path.normalize(root + path.sep)) && fs.existsSync(file) ? file : null;
}
/** Source seconds a clip consumes: duration × speed, integrating speed keyframes. */
function clipSourceLen(c) {
  const base = Math.min(8, Math.max(0.1, +c.props?.speed || 1));
  const kf = c.keyframes?.speed;
  if (!Array.isArray(kf) || !kf.length) return c.duration * base;
  const at = (t) => {
    if (t <= kf[0].t) return kf[0].v;
    for (let i = 1; i < kf.length; i++)
      if (t <= kf[i].t) return kf[i - 1].v + (kf[i].v - kf[i - 1].v) * (t - kf[i - 1].t) / ((kf[i].t - kf[i - 1].t) || 1);
    return kf[kf.length - 1].v;
  };
  let sum = 0;
  const n = Math.max(2, Math.ceil(c.duration * 60));
  for (let i = 0; i < n; i++) sum += Math.min(8, Math.max(0.1, at((i + 0.5) * c.duration / n))) * c.duration / n;
  return sum;
}
function probeChannels(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
    "-of", "csv=p=0", file], { encoding: "utf8" });
  if (r.error) throw new Error("ffprobe not found on PATH — needed to measure audio");
  const n = parseInt(String(r.stdout).trim(), 10);
  return n > 0 ? n : 0;
}
/** Decode a clip's source window with ffmpeg and hand each chunk to
 *  `onChunk(channels)`. Resolves to the channel count (0 = no audio stream). */
function streamClipAudio(proj, c0, onStart, onChunk) {
  const media = proj.media.find((m) => m.id === c0.mediaId);
  const file = media && mediaFile(media.src);
  if (!file) return Promise.reject(new Error(`clip ${c0.id}: media file not found`));
  const nCh = probeChannels(file);
  if (!nCh || onStart(nCh) === false) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, +c0.in || 0)),
      "-t", String(Math.max(0.01, clipSourceLen(c0))), "-i", file, "-vn", "-map", "0:a:0",
      "-ar", String(NORM_SR), "-f", "f32le", "-acodec", "pcm_f32le", "-"]);
    let rest = Buffer.alloc(0), err = "";
    const frameBytes = 4 * nCh;
    proc.stdout.on("data", (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const frames = Math.floor(buf.length / frameBytes);
      rest = buf.subarray(frames * frameBytes);
      if (!frames) return;
      const chs = Array.from({ length: nCh }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < nCh; c++) chs[c][i] = buf.readFloatLE((i * nCh + c) * 4);
      onChunk(chs);
    });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", () => reject(new Error("ffmpeg not found on PATH — needed to read audio")));
    proc.on("close", (code) => code === 0 ? resolve(nCh)
      : reject(new Error(`ffmpeg failed reading ${c0.id}: ${err.trim().split("\n").pop() || code}`)));
  });
}
/** Measure clips that play together (one linked group: same file + window). */
async function measureClipGroup(proj, clips) {
  const L = require("./loudness.js");
  let meter = null;
  await streamClipAudio(proj, clips[0], (nCh) => {
    const routedCount = clips.reduce((n, c) =>
      n + L.routeChannels(Array.from({ length: nCh }, () => new Float32Array(0)), c.props || {}).length, 0);
    if (!routedCount) return false;
    meter = new L.LoudnessMeter(routedCount, NORM_SR);
  }, (chs) => meter.push(clips.flatMap((c) => L.routeChannels(chs, c.props || {}))));
  return meter ? meter.result() : null;
}
/** Timeline spans with sound on these voice clips (ducking.js pipeline). */
async function voiceRegions(proj, voices, threshold) {
  const L = require("./loudness.js"), D = require("./ducking.js");
  const lists = [];
  for (const v of voices) {
    let env = null;
    await streamClipAudio(proj, v, (nCh) => { env = new D.EnvelopeMeter(nCh, NORM_SR); },
      (chs) => env.push(L.routeChannels(chs, v.props || {})));
    if (!env) continue;
    const sp = Math.min(8, Math.max(0.1, +v.props?.speed || 1));
    const gain = Math.pow(10, (+v.props?.gain || 0) / 20) * Math.min(2, Math.max(0, +(v.props?.volume ?? 1)));
    lists.push(D.activeRegions(env.result(), { t0: v.start, speed: sp, gain, threshold }));
  }
  return D.mergeRegions(lists);
}
/** The clips that sound for a selection: a linked group's audio stems, else the clip. */
function normalizeGroups(proj, ids) {
  const groups = new Map();
  for (const id of ids) {
    const c = proj.clips.find((x) => x.id === id);
    if (!c) throw new Error("no clip " + id);
    if (c.kind !== "audio" && c.kind !== "video") throw new Error(`clip ${id} is ${c.kind} — no audio to normalize`);
    const key = c.linkGroup || c.id;
    if (groups.has(key)) continue;
    const members = c.linkGroup ? proj.clips.filter((x) => x.linkGroup === c.linkGroup) : [c];
    const stems = members.filter((x) => x.kind === "audio");
    groups.set(key, stems.length ? stems : members);
  }
  return [...groups.values()];
}

/* ── Tool implementations ── */
async function callTool(name, args) {
  switch (name) {
    case "fablecut_status": {
      const up = await ensureUIServer();
      const proj = readProject();
      const dur = proj.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const files = fs.existsSync(MEDIA_DIR)
        ? fs.readdirSync(MEDIA_DIR).filter((f) => fs.statSync(path.join(MEDIA_DIR, f)).isFile())
        : [];
      const libSummary = ["sfx", "elements", "svg", "fonts"].map((d) => {
        const dir = path.join(LIBRARY_DIR, d);
        const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
        return `${d}: ${n}`;
      }).join(", ");
      const cap = (arr, n) => arr.length > n ? arr.slice(0, n).concat(`… +${arr.length - n} more`) : arr;
      let encLine = "";
      try {
        const cfg = loadEncodeProfiles();
        const describe = (id) => {
          const p = cfg.profiles[id];
          return p ? `${id} (${p.label}) — ${profileSummary(p)}` : null;
        };
        const pinned = proj.encodeProfile;
        if (pinned && !cfg.profiles[pinned]) {
          /* a project pinning a since-deleted profile must not read as "nothing
             configured" — the bad id and the fallback are two separate facts */
          encLine = `Export profile: project encodeProfile "${pinned}" is NOT DEFINED in encoding-profiles.json` +
            ` — falling back to default ${describe(cfg.default) || `"${cfg.default}"`}`;
        } else {
          encLine = `Export profile: ${describe(pinned || cfg.default) || `server default "${cfg.default}"`}`;
        }
      } catch { encLine = "Export profile: (encoding-profiles.json unavailable)"; }
      return [
        `Editor server: ${up ? "RUNNING — open " + BASE + " in a browser to watch edits live" : "FAILED TO START (check node / port " + PORT + ")"}`,
        `Project: "${proj.name}" — ${proj.width}x${proj.height} @ ${proj.fps}fps, ${proj.clips.length} clip(s), ${dur.toFixed(2)}s, revision ${proj.revision}`,
        encLine,
        `Registered media: ${cap(proj.media.map((m) => `${m.id} (${m.kind}, ${m.name}${m.duration ? ", " + m.duration + "s" : ""})`), 25).join("; ") || "none"}`,
        `Files in media/: ${cap(files, 25).join(", ") || "none"}`,
        `Library assets (./library): ${libSummary}`,
        `Project file: ${PROJECT_FILE}`,
        `Tips: fablecut_docs (use \`section\`) for the schema · fablecut_get_project {compact:true} to see the timeline · fablecut_patch_project for edits (cheapest) · fablecut_encode_profiles for export presets.`,
      ].join("\n");
    }
    case "fablecut_docs": {
      const md = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
      if (!args.section) return md;
      const q = args.section.toLowerCase();
      const parts = md.split(/^(?=## )/m);
      const hits = parts.filter((s) => s.startsWith("## ") && s.slice(0, s.indexOf("\n")).toLowerCase().includes(q));
      return hits.length ? hits.join("\n") :
        `No '## ' section matches "${args.section}". Headings: ` +
        parts.filter((s) => s.startsWith("## ")).map((s) => s.slice(3, s.indexOf("\n"))).join(" · ");
    }
    case "fablecut_get_project": {
      const doc = readProject();
      lastReadRevision = doc.revision || 0;
      if (!args.compact) return JSON.stringify(doc);
      // the UI persists default-valued props on every clip; hide them so the
      // compact view only shows what actually deviates
      const DEFAULTS = {
        x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1, pan: 0, speed: 1,
        gain: 0, channelMode: "stereo", duck: 0,
        blend: "normal", fit: "contain", cropL: 0, cropR: 0, cropT: 0, cropB: 0,
        cornerRadius: 0, flipH: false, flipV: false, filterPreset: "none",
        brightness: 100, contrast: 100, saturation: 100, hue: 0, temperature: 0,
        tint: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0, vignette: 0,
        shake: 0, shakeSpeed: 8, rgbSplit: 0, grain: 0,
        chromaKey: "", chromaTolerance: 26, chromaSoftness: 12, bgRemove: false,
        text: "Title", fontSize: 72, color: "#ffffff", color2: "", font: "Segoe UI",
        bold: true, weight: 0, italic: false, uppercase: false, align: "center",
        letterSpacing: 0, lineHeight: 1.2, textShadow: 12, glow: 0, glowColor: "",
        strokeWidth: 0, strokeColor: "#000", bgColor: "#000", bgOpacity: 0,
        textAnim: "none", wordRate: 0.15,
      };
      const hex = (v) => typeof v === "string" && /^#[0-9a-f]{3}$/i.test(v)
        ? "#" + [...v.slice(1)].map((c) => c + c).join("").toLowerCase()
        : (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : v);
      const fmtProps = (o, kind) => {
        if (!o) return "";
        const kept = {};
        for (const [k, v] of Object.entries(o)) {
          if (kind !== "text" && k === "text" && v === "Title") continue;
          // Always keep pan on linked stems — pan:0 (center) is meaningful and
          // must not be stripped, or agents rebuilding from compact can lose it.
          if (k === "pan" && Number.isInteger(o.audioChannel) && o.audioChannel >= 0) {
            kept[k] = v;
            continue;
          }
          if (hex(DEFAULTS[k]) !== hex(v)) kept[k] = v;
        }
        return Object.keys(kept).length ? " " + JSON.stringify(kept) : "";
      };
      // Mixer: only off-default faders / pans, so a fresh project adds no line.
      const signed = (v) => (v > 0 ? "+" : "") + v;
      const fxTag = (fx) => Array.isArray(fx) && fx.length ? ` fx:${FX.summarizeFx(fx)}` : "";
      const mixLine = (d) => {
        const parts = (Array.isArray(d.tracks) ? d.tracks : [])
          .filter((t) => t && (+t.gain || +t.pan || t.fx?.length))
          .map((t) => t.id + (+t.gain ? ` ${signed(+t.gain)}dB` : "") + (+t.pan ? ` pan:${+t.pan}` : "") + fxTag(t.fx));
        if (d.master && (+d.master.gain || d.master.fx?.length))
          parts.push("master" + (+d.master.gain ? ` ${signed(+d.master.gain)}dB` : "") + fxTag(d.master.fx));
        return parts.length ? [`MIX: ${parts.join(" · ")}`] : [];
      };
      const lines = [
        `"${doc.name}" ${doc.width}x${doc.height}@${doc.fps} rev:${doc.revision}` +
        (doc.panSchema >= 1 ? " panSchema:1" : "") +
        (doc.background ? ` bg:${doc.background}` : "") +
        (doc.markers?.length ? ` markers:${doc.markers.length} [${doc.markers.slice(0, 12).map((m) => m.t).join(",")}${doc.markers.length > 12 ? ",…" : ""}]` : "") +
        (doc.lockedTracks?.length ? ` lockedTracks:[${doc.lockedTracks.join(",")}]` : "") +
        (doc.untargetedTracks?.length ? ` untargetedTracks:[${doc.untargetedTracks.join(",")}]` : "") +
        (doc.disabledTracks?.length ? ` disabledTracks:[${doc.disabledTracks.join(",")}]` : ""),
        ...mixLine(doc),
        `MEDIA (${doc.media.length}):`,
        ...doc.media.map((m) => `  ${m.id} ${m.kind} "${m.name}"${m.duration ? " " + m.duration + "s" : ""}`),
        `CLIPS (${doc.clips.length}), by track/time:`,
        ...doc.clips
          .slice()
          .sort((a, b) => (a.track === b.track ? a.start - b.start : String(a.track).localeCompare(b.track)))
          .map((c) => {
            const kf = c.keyframes ? " kf:" + Object.entries(c.keyframes).map(([k, v]) => `${k}(${v.length})`).join(",") : "";
            const tr = (c.transitionIn ? ` in:${c.transitionIn.type}/${c.transitionIn.duration}` : "") +
                       (c.transitionOut ? ` out:${c.transitionOut.type}/${c.transitionOut.duration}` : "");
            const r3 = (n) => Math.round(n * 1000) / 1000;
            return `  ${c.id} ${c.track} ${r3(c.start)}s+${r3(c.duration)}s ${c.kind}` +
              (c.mediaId ? `(${c.mediaId}${c.in ? ` in:${r3(c.in)}` : ""})` : "") +
              (c.name ? ` "${c.name}"` : "") + fmtProps(c.props, c.kind) + kf + tr +
              (c.locked === true ? " [locked]" : "") + (c.disabled === true ? " [disabled]" : "") +
              (c.unlinked === true ? " [unlinked]" : "") + fxTag(c.fx);
          }),
        `(compact view — full JSON: fablecut_get_project without compact; edit via fablecut_patch_project)`,
      ];
      return lines.join("\n");
    }
    case "fablecut_patch_project": {
      const ops = args.ops;
      if (!Array.isArray(ops) || !ops.length) throw new Error("`ops` must be a non-empty array");
      const proj = readProject();
      const notes = [];
      // Locks mirror the editor: a clip is locked by its own flag or its track,
      // and a linked A/V group with any locked member is locked as a whole.
      const lockedTracks = () => new Set(Array.isArray(proj.lockedTracks) ? proj.lockedTracks : []);
      const lockReason = (c) => {
        const group = c.linkGroup ? proj.clips.filter((x) => x.linkGroup === c.linkGroup) : [c];
        for (const x of group) {
          const who = x.id === c.id ? `clip ${c.id}` : `clip ${c.id} is linked to ${x.id}, which`;
          if (x.locked === true) return `${who} is locked`;
          if (lockedTracks().has(x.track)) return `${who} is on locked track ${x.track}`;
        }
        return null;
      };
      const refuseLocked = (opName, reason, op) => {
        if (reason && op.force !== true)
          throw new Error(`${opName}: ${reason} — the user locked it. Leave it alone, or pass force:true if they asked you to change it`);
      };
      const mergeInto = (target, set) => {
        for (const [k, v] of Object.entries(set || {})) {
          if (v === null) delete target[k];
          else if (k === "props" && target.props && typeof v === "object" && !Array.isArray(v)) {
            for (const [pk, pv] of Object.entries(v)) {
              if (pv === null) delete target.props[pk]; else target.props[pk] = pv;
            }
          } else target[k] = v;
        }
      };
      for (const op of ops) {
        switch (op.op) {
          case "addClip": {
            const c = op.clip;
            if (!c || !c.track || typeof c.start !== "number" || typeof c.duration !== "number")
              throw new Error("addClip needs clip{track, start, duration}");
            c.id = c.id || "c_" + uid();
            if (proj.clips.some((x) => x.id === c.id)) throw new Error("addClip: duplicate clip id " + c.id);
            refuseLocked("addClip", lockedTracks().has(c.track) ? `track ${c.track} is locked` : null, op);
            if (c.kind !== "text" && c.kind !== "adjust" && !proj.media.some((m) => m.id === c.mediaId))
              throw new Error(`addClip: unknown mediaId ${c.mediaId}`);
            proj.clips.push(c);
            notes.push("+" + c.id);
            break;
          }
          case "updateClip": {
            const c = proj.clips.find((x) => x.id === op.id);
            if (!c) throw new Error("updateClip: no clip " + op.id);
            // Toggling the lock itself is always allowed — that's how you unlock.
            const onlyLock = Object.keys(op.set || {}).every((k) => k === "locked");
            if (!onlyLock) {
              refuseLocked("updateClip", lockReason(c), op);
              if (op.set && op.set.track && lockedTracks().has(op.set.track))
                refuseLocked("updateClip", `track ${op.set.track} is locked`, op);
            }
            mergeInto(c, op.set);
            notes.push("~" + op.id);
            break;
          }
          case "removeClip": {
            const doomed = proj.clips.find((x) => x.id === op.id);
            if (doomed) refuseLocked("removeClip", lockReason(doomed), op);
            const n = proj.clips.length;
            proj.clips = proj.clips.filter((x) => x.id !== op.id);
            if (proj.clips.length === n) throw new Error("removeClip: no clip " + op.id);
            notes.push("-" + op.id);
            break;
          }
          case "addMedia": {
            const m = op.media;
            if (!m || !m.src || !m.kind) throw new Error("addMedia needs media{src, kind}");
            m.id = m.id || "m_" + uid();
            if (proj.media.some((x) => x.id === m.id)) throw new Error("addMedia: duplicate media id " + m.id);
            m.name = m.name || path.basename(decodeURIComponent(m.src));
            proj.media.push(m);
            notes.push("+" + m.id);
            break;
          }
          case "removeMedia": {
            const used = proj.clips.find((c) => c.mediaId === op.id);
            if (used) throw new Error(`removeMedia: media ${op.id} is used by clip ${used.id}`);
            const n = proj.media.length;
            proj.media = proj.media.filter((x) => x.id !== op.id);
            if (proj.media.length === n) throw new Error("removeMedia: no media " + op.id);
            notes.push("-" + op.id);
            break;
          }
          case "setFx": {
            // {op:"setFx", target:"clip"|"track"|"master", id?, fx?:[…] | preset?:"podcast", append?:true}
            const target = op.target || (op.id && /^A\d+$/.test(op.id) ? "track" : op.id ? "clip" : "master");
            let chain;
            if (op.preset != null) chain = FX.presetChain(String(op.preset));
            else if (op.fx === null) chain = [];
            else chain = FX.normalizeFx(op.fx, true);
            const merge = (cur) => op.append ? [...FX.normalizeFx(cur), ...chain] : chain;
            if (target === "clip") {
              const c = proj.clips.find((x) => x.id === op.id);
              if (!c) throw new Error("setFx: no clip " + op.id);
              if (c.kind !== "audio") throw new Error(`setFx: clip ${op.id} is ${c.kind} — effects go on audio clips (a video's sound is on its linked A-track clips)`);
              refuseLocked("setFx", lockReason(c), op);
              const group = c.linkGroup ? proj.clips.filter((x) => x.linkGroup === c.linkGroup && x.kind === "audio") : [c];
              const next = merge(c.fx);
              for (const x of group) { if (next.length) x.fx = next.map((e) => ({ ...e })); else delete x.fx; }
              notes.push("~" + group.map((x) => x.id).join("+") + ".fx");
            } else if (target === "track") {
              if (!/^A\d+$/.test(String(op.id || ""))) throw new Error("setFx: track id must be an audio track (A1, A2, …)");
              if (!Array.isArray(proj.tracks) || !proj.tracks.length) proj.tracks = DEFAULT_TRACKS.map((t) => ({ ...t }));
              let t = proj.tracks.find((x) => x.id === op.id);
              if (!t) { t = { id: op.id, kind: "audio" }; proj.tracks.push(t); }
              const next = merge(t.fx);
              if (next.length) t.fx = next; else delete t.fx;
              notes.push("~" + op.id + ".fx");
            } else if (target === "master") {
              const m = proj.master && typeof proj.master === "object" ? proj.master : {};
              const next = merge(m.fx);
              if (next.length) m.fx = next; else delete m.fx;
              if (Object.keys(m).length) proj.master = m; else delete proj.master;
              notes.push("~master.fx");
            } else throw new Error("setFx: target must be clip, track or master");
            break;
          }
          case "setTrack": {
            // Mixer settings on one lane: {op:"setTrack", id:"A1", set:{gain:-6, pan:0.2}}.
            if (!/^A\d+$/.test(String(op.id || ""))) throw new Error("setTrack: id must be an audio track (A1, A2, …)");
            if (!Array.isArray(proj.tracks) || !proj.tracks.length) proj.tracks = DEFAULT_TRACKS.map((t) => ({ ...t }));
            let t = proj.tracks.find((x) => x.id === op.id);
            if (!t) { t = { id: op.id, kind: "audio" }; proj.tracks.push(t); }
            for (const [k, v] of Object.entries(op.set || {})) {
              const range = k === "gain" ? [-60, 12] : k === "pan" ? [-1, 1] : null;
              if (!range) throw new Error(`setTrack: '${k}' not settable (gain, pan)`);
              if (v === null || v === 0) { delete t[k]; continue; }
              if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1])
                throw new Error(`setTrack: ${k} must be a number ${range[0]}…${range[1]}`);
              t[k] = v;
            }
            notes.push("~" + op.id);
            break;
          }
          case "setProject": {
            const allowed = ["name", "width", "height", "fps", "background", "markers", "disabledTracks", "lockedTracks", "untargetedTracks", "exportFrame", "encodeProfile", "master"];
            for (const [k, v] of Object.entries(op.set || {})) {
              if (!allowed.includes(k)) throw new Error(`setProject: '${k}' not settable (allowed: ${allowed.join(", ")})`);
              if (k === "encodeProfile" && v != null) {
                resolveProfile(String(v)); // validate id exists
              }
              if (k === "master" && v != null) {
                const g = v.gain;
                if (typeof v !== "object" || Object.keys(v).some((x) => x !== "gain") ||
                    (g != null && (typeof g !== "number" || !Number.isFinite(g) || g < -60 || g > 12)))
                  throw new Error("setProject: master is {gain} — master fader in dB, -60…+12");
              }
              if (v === null) delete proj[k]; else proj[k] = v;
            }
            notes.push("~project");
            break;
          }
          default:
            throw new Error("Unknown op: " + op.op + " (addClip|updateClip|removeClip|addMedia|removeMedia|setProject|setTrack|setFx)");
        }
      }
      proj.revision = (proj.revision || 0) + 1;
      writeProject(proj);
      lastReadRevision = proj.revision;
      return `Patched (revision ${proj.revision}): ${notes.join(" ")}. Now ${proj.clips.length} clip(s), ${proj.media.length} media. UI hot-reloaded.`;
    }
    case "fablecut_set_project": {
      const doc = args.project;
      if (!doc || typeof doc !== "object") throw new Error("`project` must be an object");
      if (!Array.isArray(doc.clips) || !Array.isArray(doc.media))
        throw new Error("project must contain `clips` and `media` arrays");
      for (const c of doc.clips) {
        if (!c.id || !c.track || typeof c.start !== "number" || typeof c.duration !== "number")
          throw new Error(`clip ${c.id || "?"} needs id, track, numeric start and duration`);
        if (c.kind !== "text" && c.kind !== "adjust" && !doc.media.some((m) => m.id === c.mediaId))
          throw new Error(`clip ${c.id} references unknown mediaId ${c.mediaId}`);
      }
      let cur = { revision: 0 };
      try { cur = readProject(); } catch {}
      const curRev = cur.revision || 0;
      // strict check when this session read via the tool; otherwise fall back to
      // the revision baked into the submitted doc (e.g. it was read as a file)
      const stale = lastReadRevision !== null
        ? curRev !== lastReadRevision
        : (doc.revision || 0) < curRev;
      if (stale && !args.force) {
        throw new Error(
          `CONFLICT — not saved. project.json is at revision ${curRev}, but this edit was based on ` +
          `revision ${lastReadRevision ?? (doc.revision || 0)}: the project changed in between ` +
          `(the user probably tweaked something in the editor UI). ` +
          `Call fablecut_get_project, re-apply your edit on top of the latest document, then save again. ` +
          `Pass force:true only if the user explicitly wants those changes discarded.`);
      }
      doc.revision = Math.max(curRev + 1, (doc.revision || 0));
      // Agents often omit top-level flags they don't know about. Keep panSchema
      // once established so a rewrite that drops pan:0 cannot re-trigger L/R migration.
      if (!(doc.panSchema >= 1) && (cur.panSchema >= 1)) doc.panSchema = 1;
      writeProject(doc);
      lastReadRevision = doc.revision;
      return `Saved (revision ${doc.revision}). ${doc.clips.length} clip(s). The editor UI (if open at ${BASE}) has hot-reloaded.`;
    }
    case "fablecut_normalize_audio": {
      const ids = Array.isArray(args.clipIds) ? args.clipIds.map(String) : [];
      if (!ids.length) throw new Error("`clipIds` must list at least one clip");
      const mode = args.mode === "peak" ? "peak" : "lufs";
      const target = Number.isFinite(args.target) ? args.target : mode === "peak" ? -1 : -14;
      if (mode === "lufs" && (target < -60 || target > 0)) throw new Error("target LUFS must be -60…0");
      if (mode === "peak" && (target < -60 || target > 0)) throw new Error("target peak must be -60…0 dBFS");
      const L = require("./loudness.js");
      const groups = normalizeGroups(readProject(), ids);
      const measured = [];
      for (const g of groups) measured.push({ ids: g.map((c) => c.id), m: await measureClipGroup(readProject(), g) });
      // Re-read after the (slow) measuring so concurrent UI edits are kept.
      const proj = readProject();
      const locked = new Set(Array.isArray(proj.lockedTracks) ? proj.lockedTracks : []);
      const report = [];
      let changed = 0;
      for (const { ids: gIds, m } of measured) {
        const clips = gIds.map((id) => proj.clips.find((x) => x.id === id)).filter(Boolean);
        const lockedBy = clips.find((c) => c.locked === true || locked.has(c.track));
        if (lockedBy && args.force !== true) {
          report.push(`${gIds.join("+")}: skipped — ${lockedBy.id} is locked (pass force:true if the user asked)`);
          continue;
        }
        const db = m && L.normalizeGainDb(m, { mode, value: target });
        if (db == null) { report.push(`${gIds.join("+")}: silent — left alone`); continue; }
        const gain = Math.round(Math.min(24, Math.max(-60, db)) * 10) / 10;
        for (const c of clips) { c.props = c.props || {}; c.props.gain = gain; }
        changed++;
        const level = mode === "peak" ? `${m.peakDb.toFixed(1)} dBFS peak` : `${m.lufs.toFixed(1)} LUFS`;
        report.push(`${gIds.join("+")}: ${level} → gain ${gain > 0 ? "+" : ""}${gain} dB`);
      }
      if (changed) {
        proj.revision = (proj.revision || 0) + 1;
        writeProject(proj);
        lastReadRevision = proj.revision;
      }
      return `Normalize to ${target} ${mode === "peak" ? "dBFS peak" : "LUFS"}${changed ? ` (revision ${proj.revision})` : " — nothing changed"}:\n` + report.join("\n");
    }
    case "fablecut_auto_duck": {
      const ids = Array.isArray(args.clipIds) ? args.clipIds.map(String) : [];
      if (!ids.length) throw new Error("`clipIds` must list the music clip(s) to duck");
      const amount = args.amount == null ? -12 : +args.amount;
      if (!Number.isFinite(amount) || amount < -40 || amount > 0) throw new Error("amount must be -40…0 dB");
      const threshold = args.threshold == null ? -40 : +args.threshold;
      const attack = args.attack == null ? 0.3 : Math.max(0, +args.attack || 0);
      const release = args.release == null ? 0.6 : Math.max(0, +args.release || 0);
      const D = require("./ducking.js");
      const doc = readProject();
      const musicGroups = [];
      const seen = new Set();
      for (const id of ids) {
        const c = doc.clips.find((x) => x.id === id);
        if (!c) throw new Error("no clip " + id);
        if (c.kind !== "audio" && c.kind !== "video") throw new Error(`clip ${id} is ${c.kind} — no audio to duck`);
        const key = c.linkGroup || c.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const members = c.linkGroup ? doc.clips.filter((x) => x.linkGroup === c.linkGroup) : [c];
        const stems = members.filter((x) => x.kind === "audio");
        if (stems.length) musicGroups.push(stems.map((x) => x.id));
      }
      if (!musicGroups.length) throw new Error("none of those clips carry audio on an A-track");
      const musicIds = new Set(musicGroups.flat());
      const musicClips = doc.clips.filter((x) => musicIds.has(x.id));
      const own = new Set(musicClips.map((x) => x.track));
      const lanes = Array.isArray(args.under) && args.under.length ? args.under.map(String)
        : [...new Set(doc.clips.filter((x) => x.kind === "audio").map((x) => x.track))].filter((t) => !own.has(t));
      const t0 = Math.min(...musicClips.map((x) => x.start));
      const t1 = Math.max(...musicClips.map((x) => x.start + x.duration));
      const disabled = new Set(Array.isArray(doc.disabledTracks) ? doc.disabledTracks : []);
      const voices = doc.clips.filter((x) => x.kind === "audio" && lanes.includes(x.track) && !musicIds.has(x.id) &&
        !disabled.has(x.track) && x.disabled !== true && x.start + x.duration > t0 && x.start < t1);
      const regions = amount && voices.length ? await voiceRegions(doc, voices, threshold) : [];
      if (amount && !voices.length) throw new Error(`no audio clips on ${lanes.join(", ") || "other tracks"} under the music — nothing to duck for`);
      // Re-read after the (slow) analysis so concurrent UI edits are kept.
      const proj = readProject();
      const locked = new Set(Array.isArray(proj.lockedTracks) ? proj.lockedTracks : []);
      const report = [];
      let changed = 0;
      for (const g of musicGroups) {
        const clips = g.map((id) => proj.clips.find((x) => x.id === id)).filter(Boolean);
        if (!clips.length) continue;
        const lockedBy = clips.find((c) => c.locked === true || locked.has(c.track));
        if (lockedBy && args.force !== true) {
          report.push(`${g.join("+")}: skipped — ${lockedBy.id} is locked (pass force:true if the user asked)`);
          continue;
        }
        const keys = amount ? D.duckKeyframes(regions, clips[0], { amount, attack, release }) : [];
        for (const c of clips) {
          if (keys.length) { c.keyframes = c.keyframes || {}; c.keyframes.duck = keys.map((k) => ({ ...k })); }
          else if (c.keyframes && c.keyframes.duck) {
            delete c.keyframes.duck;
            if (!Object.keys(c.keyframes).length) delete c.keyframes;
          }
        }
        changed++;
        const dips = keys.filter((k, i) => k.v === amount && (i === 0 || keys[i - 1].v !== amount)).length;
        report.push(`${g.join("+")}: ${amount ? `${dips} dip${dips === 1 ? "" : "s"} of ${amount} dB` : "ducking removed"}`);
      }
      if (changed) {
        proj.revision = (proj.revision || 0) + 1;
        writeProject(proj);
        lastReadRevision = proj.revision;
      }
      const head = amount ? `Auto-duck under ${lanes.join(", ")} — ${regions.length} voice span${regions.length === 1 ? "" : "s"}` : "Ducking cleared";
      return `${head}${changed ? ` (revision ${proj.revision})` : " — nothing changed"}:\n` + report.join("\n");
    }
    case "fablecut_analyze_reference": {
      let src = args.path || "";
      let file = /^\/media\//i.test(src)
        ? path.join(MEDIA_DIR, decodeURIComponent(src.replace(/^\/media\//i, "")))
        : src;
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new Error("File not found: " + src);
      // keep the reference inside media/ so the user can preview it in the UI
      if (path.dirname(path.resolve(file)).toLowerCase() !== MEDIA_DIR.toLowerCase()) {
        if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
        const ext = path.extname(file);
        const stem = path.basename(file, ext).replace(/[^\w.\- ()\[\]]+/g, "_");
        let target = path.join(MEDIA_DIR, stem + ext);
        let i = 1;
        while (fs.existsSync(target)) target = path.join(MEDIA_DIR, `${stem}_${i++}${ext}`);
        fs.copyFileSync(file, target);
        file = target;
      }
      const { analyze } = require("./analyze.js");
      const bp = await analyze(file, {
        threshold: args.threshold,
        music: args.registerMusic !== false,
        musicDir: MEDIA_DIR,
        srcUrl: "/media/" + encodeURIComponent(path.basename(file)),
      });
      let musicNote = "Reference has no audio track — no music extracted.";
      if (bp.music) {
        bp.music.src = "/media/" + encodeURIComponent(bp.music.name);
        // merge-safe append, same protocol as fablecut_import_media
        const entry = {
          id: "m_" + uid(), name: bp.music.name, kind: "audio",
          src: bp.music.src, duration: bp.duration,
        };
        const proj = readProject();
        const wasCurrent = lastReadRevision === (proj.revision || 0);
        proj.media.push(entry);
        proj.revision = (proj.revision || 0) + 1;
        writeProject(proj);
        if (wasCurrent) lastReadRevision = proj.revision;
        bp.music.mediaId = entry.id;
        musicNote = `Music extracted and registered as media "${entry.id}" — place it on A1 (in:0, duration:${bp.duration}).`;
      }
      const dir = ANALYSIS_DIR;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, path.basename(file, path.extname(file)) + ".json"),
        JSON.stringify(bp, null, 2));
      return JSON.stringify(bp, null, 2) + "\n\n" + [
        musicNote,
        `REMAKE RECIPE: 1) set project width/height/fps to ${bp.width}x${bp.height} @ ${bp.fps} — 2) write beats[] into project markers — 3) extracted music on A1 — 4) one clip per shots[] entry at the same start/duration on V1 (hard cuts; footage energy should track each shot's energy value) — 5) biggest moment on drop (${bp.drop}s)${bp.bpm ? ` — tempo ${bp.bpm} BPM` : ""}. Full recipe: fablecut_docs → "Remake a reference video".`,
      ].join("\n");
    }
    case "fablecut_import_media": {
      const src = args.path;
      if (!src) throw new Error("path is required");
      let target, kind;
      if (/^https?:\/\//i.test(src)) {
        if (!/^https:\/\//i.test(src)) throw new Error("URL must be https");
        const got = await downloadImportUrl(src, MEDIA_DIR);
        target = got.target;
        kind = kindFromName(got.name);
        await maybeFaststart(target);
      } else {
        if (!fs.existsSync(src) || !fs.statSync(src).isFile())
          throw new Error("File not found: " + src);
        const ext = path.extname(src).toLowerCase();
        kind = KIND_BY_EXT[ext];
        if (!kind) throw new Error(`Unsupported extension ${ext}`);
        if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
        let base = path.basename(src).replace(/[^\w.\- ()\[\]]+/g, "_");
        target = path.join(MEDIA_DIR, base);
        let i = 1;
        const stem = path.basename(base, ext);
        while (fs.existsSync(target)) target = path.join(MEDIA_DIR, `${stem}_${i++}${ext}`);
        fs.copyFileSync(src, target);
      }
      if (!kind) throw new Error("Unsupported media type");
      const entry = {
        id: "m_" + uid(),
        name: path.basename(target),
        kind,
        src: "/media/" + encodeURIComponent(path.basename(target)),
        duration: kind === "image" || kind === "svg" ? undefined : ffprobeDuration(target),
      };
      const proj = readProject();
      // import only appends a media entry (never touches clips), so it merges
      // into the live document; keep lastReadRevision in step only if it
      // already was — otherwise a later set_project must still re-read
      const wasCurrent = lastReadRevision === (proj.revision || 0);
      proj.media.push(entry);
      proj.revision = (proj.revision || 0) + 1;
      writeProject(proj);
      if (wasCurrent) lastReadRevision = proj.revision;
      return `Imported → ${JSON.stringify(entry)}\n` +
        (entry.duration == null && kind !== "image"
          ? "Note: duration unknown (no ffprobe). The browser UI will probe and fill it in; re-read the project before trimming this media."
          : "Ready to use in clips via mediaId.");
    }
    case "fablecut_encode_profiles": {
      if (args.profile) {
        const p = resolveProfile(String(args.profile));
        return JSON.stringify({
          default: loadEncodeProfiles().default,
          profile: args.profile,
          label: p.label,
          description: p.description,
          jpegQuality: p.jpegQuality,
          extension: p.extension,
          color: p.color,
          args: p.args,
        }, null, 2);
      }
      return JSON.stringify(listProfilesPublic(!!args.detail), null, 2);
    }
    default:
      throw new Error("Unknown tool: " + name);
  }
}

/* ── MCP stdio plumbing (newline-delimited JSON-RPC 2.0) ── */
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: "fablecut", version: "1.9.0" },
        },
      });
    }
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      pending++;
      try {
        const text = await callTool(params.name, params.arguments || {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
      } finally {
        if (--pending === 0 && stdinClosed) process.exit(0);
      }
      return;
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (!isRequest) return; // ignore other notifications (e.g. notifications/initialized)
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e) } });
  }
}

let buf = "", pending = 0, stdinClosed = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
});
process.stdin.on("end", () => { stdinClosed = true; if (pending === 0) process.exit(0); });
