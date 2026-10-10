/* ═══════════════════════════════════════════════════════════════════════════
   FableCut MCP server — connects Claude (Code / Desktop) to the video editor.
   Zero-dependency stdio JSON-RPC (Model Context Protocol).

   Register once for all Claude Code sessions:
     claude mcp add -s user fablecut -- npx -y fablecut mcp
   or, from a clone:
     claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"

   Tools: fablecut_status, fablecut_docs, fablecut_get_project,
          fablecut_set_project, fablecut_patch_project, fablecut_import_media,
          fablecut_analyze_reference, fablecut_encode_profiles,
          fablecut_normalize_audio, fablecut_auto_duck, fablecut_export,
          fablecut_scopes
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { loadEncodeProfiles, listProfilesPublic, resolveProfile, profileSummary } = require("./encode-profiles");

const {
  APP_DIR, DATA_DIR, MEDIA_DIR, EXPORTS_DIR, ANALYSIS_DIR, LIBRARY_DIR, PROJECT_FILE, ensureDirs,
} = require("./paths");
const { downloadImportUrl, kindFromName, maybeFaststart } = require("./import-url");
const FX = require("./audio-fx");
const EditOps = require("./edit-ops");
const Denoise = require("./denoise");
const Color = require("./color");
const Mask = require("./mask");

/* ROOT is where the code lives (server.js, CLAUDE.md); the user's timeline and
   media live under DATA_DIR. Identical unless FABLECUT_DATA_DIR is set. */
const ROOT = APP_DIR;
ensureDirs();
const PORT = process.env.FABLECUT_PORT || 7777;
const BASE = `http://localhost:${PORT}`;
// Requests go to the address the server binds: on Node 18, "localhost" can
// resolve to ::1 first and is not retried on 127.0.0.1.
const API = `http://${process.env.HOST === "::1" ? "[::1]" : "127.0.0.1"}:${PORT}`;

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
/** JSON request to the editor server → {status, body}. */
function apiJSON(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(API + urlPath, { method, headers: { "Content-Type": "application/json" } }, (r) => {
      let data = "";
      r.setEncoding("utf8");
      r.on("data", (d) => { data += d; });
      r.on("end", () => {
        let body = null;
        try { body = JSON.parse(data); } catch { body = { error: data }; }
        resolve({ status: r.statusCode, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("editor server did not answer")));
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}
async function ensureUIServer() {
  if (await httpOk(API + "/api/project")) return true;
  spawn(process.execPath, [path.join(ROOT, "server.js")],
    { cwd: ROOT, detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 12; i++) {
    await sleep(300);
    if (await httpOk(API + "/api/project")) return true;
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
    description: "Apply targeted edits to the FableCut project WITHOUT round-tripping the whole document — PREFER THIS over get+set for every edit (it is ~10-100x cheaper in tokens and merge-safe by design: it re-reads the latest document from disk, applies your ops in order, bumps revision once, saves atomically). Ops: {op:'addClip', clip:{…}} (id auto-generated if omitted) · {op:'updateClip', id, set:{…}} · {op:'removeClip', id} · {op:'addMedia', media:{…}} · {op:'removeMedia', id} · {op:'setProject', set:{name|width|height|fps|background|markers|disabledTracks|lockedTracks|untargetedTracks|encodeProfile|master}} (markers = the full list [{t, label?, color?}], color: gold|red|orange|green|cyan|blue|purple|pink; master = {gain}, the master fader in dB) · {op:'setTrack', id:'A1', set:{gain?, pan?, out?}} (audio-track fader in dB −60…+12, pan −1…1, out = a submix bus id or 'master'; null or 0 resets) · {op:'setBus', id:'B1', set:{name?, gain?, pan?, mute?}} (submix bus, created if missing; route tracks into it with setTrack out) · {op:'removeBus', id} · {op:'setFx', target:'clip'|'track'|'bus'|'master', id?, preset?:'podcast'|… OR fx:[{type,…params}], append?:true} (audio effects — validated; presets: clean-voice, podcast, radio, deep-voice, telephone, cinematic, wide, muffled; fx:null clears; on a clip it applies to its linked stems too) · {op:'setFxKeys', target, id?, index?|type?, param, keys:[{t, v, ease?}]|null} (automate one effect parameter: t is clip-local for a clip's effects, timeline seconds otherwise; see the 'Audio mix' docs section) · {op:'setGrade', id | ids:[…], grade:{exposure?, temp?, tint?, lift?, gamma?, gain?, offset?, contrast?, pivot?, blacks?, shadows?, midtones?, highlights?, whites?, lowSoft?, highSoft?, saturation?, curves?:{y?, r?, g?, b?}, hueHue?, hueSat?, hueLuma?, satLuma?, layers?:[…], on?}, replace?:true} (color grade on video / image / svg / adjust clips — wheels are [r, g, b, master]; curves are [[x, y], …] point lists on 0…1 and merge per channel; hue curves are [[hue°, value], …] — one point = a ±40° band; layers replaces the whole layer list; merges key by key, null resets a key, replace:true starts from neutral, grade:null clears; see the 'Color' docs section; measure the result with fablecut_scopes) · {op:'setGradeLayer', id | ids, layer: index | 'name', set:{name?, on?, qualifier?:{hue?:[centre°, width°, soft°], sat?:[lo, hi, soft], luma?:[lo, hi, soft], invert?}, mask?:{shape:'ellipse'|'rect'|'poly', x, y, w, h, rotation?, feather?, invert?, points?, keys?:[{t, x?, y?, …}]}, …any grade key}, replace?:true, remove?:true} (a secondary: a grade applied only where the qualifier × mask select; a new name or index = length adds a layer; qualifier and mask merge key by key; check what it selects with fablecut_scopes matte:{clip, layer}) · {op:'setMask', id | ids, mask?: index | 'name', set:{shape?:'rect'|'ellipse'|'bezier'|'freehand', mode?:'add'|'subtract'|'intersect'|'difference', invert?, opacity?, feather? (px), expand? (px, − shrinks), x?, y? (centre, 0…1 of the clip's picture), w?, h?, scale?, rotation?, points?:[[dx, dy, inX?, inY?, outX?, outY?], …] (bezier, around x, y), stroke?:[[u, v], …] (freehand: fitted into a bezier), keys?:[{t, ease?, x?, y?, w?, h?, scale?, rotation?, feather?, expand?, opacity?, points?}], name?, on?}, replace?:true, remove?:true} (clip masks on video / image / svg / text / adjust clips: the clip shows only where its masks combine to, bottom-up; mask left out, an unknown name or index = length adds one — a new mask needs shape; set merges key by key; masks follow the clip's transform; check with fablecut_scopes mask:{clip}) · {op:'removeMask', id, mask} · {op:'setMaskKeys', id, mask, keys:[…]|null} (animate a mask; t = seconds from the clip's start) · {op:'setMatte', id | ids, matte:'alpha'|'alpha-inverted'|'luma'|'luma-inverted'|null, track?:'V3'|null} (track matte: the picture on the video track directly above — or track — cuts the clip by its alpha or its brightness, inverted or not; that track stops drawing while it is a matte; null clears). props.blend: normal · multiply · screen · overlay · darken · lighten · color-dodge · color-burn · hard-light · soft-light · difference · exclusion · hue · saturation · color · luminosity · lighter. TIMELINE EDITS — the editor's own split / ripple / trim code, so linked stems, track targeting (untargetedTracks) and locks behave exactly as in the UI; times in seconds: {op:'split', at, ids?} (no ids: every targeted track) · {op:'rippleDelete', ids} (later clips close the hole) · {op:'closeGap', at} · {op:'lift'|'extract', from?, to?} (remove a range; extract closes it; default = project inPoint/outPoint, which then clear) · {op:'insert'|'overwrite', mediaId, at, in?, duration?} (three-point edit: insert pushes later clips right, overwrite replaces what is there; a video brings one audio stem per channel) · {op:'rippleTrim'|'roll', id, side:'in'|'out', delta} · {op:'slip'|'slide', id, delta} (clamped to the media; the note says what was applied) · {op:'crossfade', ids? | at, duration?} (constant-power audio crossfade, borrowing handles from both sides). Any of these takes tracks:[…] to target lanes for that op only. setProject also takes inPoint / outPoint. updateClip merge rules: top-level keys are replaced (keyframes/transitionIn/transitionOut wholesale), `props` merges key-by-key, and setting any key to null deletes it. LOCKS: the user can lock clips (`locked:true`) and tracks (`lockedTracks`); updateClip / removeClip on a locked clip — or on a clip linked to one — and addClip onto a locked track are refused. Leave locked material alone; only if the user asked you to change it, pass force:true on that op (or unlock first: updateClip set:{locked:null}, which is always allowed). All-or-nothing: an invalid op aborts the whole patch unsaved. Optional baseRevision: the revision your ops were planned against (from fablecut_get_project, fablecut_status or the previous patch result) — if the project has moved past it (e.g. the user edited in the UI meanwhile), the patch is refused with CONFLICT and the current revision, nothing saved; re-check the clips you touch, then retry with the new revision. Omit it to apply on top of whatever is latest.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: { type: "object" },
          description: "Edit operations, applied in order (see tool description for shapes). Any op may carry force:true to override a lock the user set.",
        },
        baseRevision: {
          type: "integer",
          description: "Revision these ops were planned against. If project.json has moved past it, the patch is refused with CONFLICT (nothing saved). Omit to apply on top of the latest revision.",
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
        force:{ type: "boolean", description: "Also change clips the user locked (only when they asked)" },
      },
      required: ["clipIds"],
    },
  },
  {
    name: "fablecut_denoise",
    description: "Reduce background noise (hiss, hum, room tone) on audio clips: ffmpeg's FFT denoiser renders a cleaned FLAC of each clip's whole source file into media/, and the clip — with its linked stems — switches to it (the picture keeps its own file, so links and timing stay intact). The same as the inspector's Noise control. amount 'off' switches back to the original. Re-running reuses a file already rendered. Needs ffmpeg + ffprobe on PATH. Refuses locked clips unless force:true.",
    inputSchema: {
      type: "object",
      properties: {
        clipIds: { type: "array", items: { type: "string" }, description: "Audio clips, or video clips with linked audio stems" },
        amount: { type: "string", enum: ["light", "medium", "strong", "off"], description: "How hard to pull the noise down (default medium); off restores the original audio" },
        force: { type: "boolean", description: "Also change clips the user locked (only when they asked)" },
      },
      required: ["clipIds"],
    },
  },
  {
    name: "fablecut_export",
    description: "Render the timeline to a video file in exports/ — the editor's own Fast export (same compositor, audio mix and encoding profile as the Export button), so the file matches what the user sees. It runs in a browser: an open editor tab takes the job (the user sees the progress bar), or with no tab open the server starts headless Chrome / Edge (set FABLECUT_CHROME to pick one) and closes it afterwards. Waits for the file by default and returns its path. Range: the project's inPoint→outPoint when set, else the whole timeline (or pass range). Needs ffmpeg on PATH. One export at a time. Long edits: pass wait:false, then poll with {job}; {cancel:job} stops one.",
    inputSchema: {
      type: "object",
      properties: {
        range: { type: "string", enum: ["entire", "in-out"], description: "Whole timeline, or the project's inPoint→outPoint (default: in-out when either is set)" },
        profile: { type: "string", description: "Encoding profile id (fablecut_encode_profiles); default: project.encodeProfile, else the server default" },
        where: { type: "string", enum: ["auto", "tab", "headless"], description: "auto (default): an open editor tab, else headless · tab: only an open tab · headless: always a background browser, leaving the user's tab alone" },
        wait: { type: "boolean", description: "Block until the file is written (default true)" },
        timeout: { type: "number", description: "Seconds to wait before returning the job's status instead (default 900); the export keeps running" },
        job: { type: "string", description: "Report on an export started earlier instead of starting one" },
        cancel: { type: "string", description: "Cancel this export job" },
      },
    },
  },
  {
    name: "fablecut_scopes",
    description: "Measure the graded picture at one moment — what the editor's scopes show, as numbers: luma levels (min, 1st percentile, median, mean, 99th percentile, max on 0–1), the % of pixels crushed to black / clipped to white, mean R/G/B, average saturation, and the colour cast of the midtones (hue name + strength; neutral below 0.01), plus the clips on screen with their grades, masks, track mattes and blend modes. Rendered by the same compositor as export (an open editor tab, else headless Chrome / Edge), over the export frame when one is set. Use it to check a grade: e.g. a cast strength above ~0.03 on footage that should be neutral, whitePct above ~1 (clipped highlights), or a median far from ~0.4 for a normally exposed shot. The user's playhead does not move.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "number", description: "Timeline seconds to measure (default: the editor's playhead)" },
        matte: {
          type: "object",
          description: "Also measure what one grade layer selects: {clip, layer} (layer = index into the clip's grade.layers). Adds the matte's coverage (% of that clip's picture) and the levels / colour of the selected pixels after grading",
          properties: { clip: { type: "string" }, layer: { type: "integer", minimum: 0 } },
          required: ["clip", "layer"],
        },
        mask: {
          type: "object",
          description: "Also measure a clip's masks: {clip}. Adds how much of that clip's picture the masks keep (coverage %, the feathered matte measured alone) and how much of the frame the masked clip covers",
          properties: { clip: { type: "string" } },
          required: ["clip"],
        },
        where: { type: "string", enum: ["auto", "tab", "headless"], description: "auto (default): an open editor tab, else headless · tab · headless" },
        timeout: { type: "number", description: "Seconds to wait (default 60)" },
      },
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

/* ── Timeline edits (patch ops split … crossfade) ──
   The editor's own edit code (edit-ops.js) run against the document, so an
   agent gets the same targeting (untargetedTracks, or the op's `tracks`), the
   same sync lock (linked partners ride along) and the same lock rules as the
   keyboard shortcuts. Returns a short note; throws to abort the patch. */
const relinkedDocs = new WeakSet();
function timelineEdit(proj, op, refuseLocked, lockReason) {
  const name = op.op;
  const E = EditOps.forDoc(proj, { tracks: op.tracks, force: op.force === true, uid: () => uid() });
  // Links are rebuilt from timing on every editor load; do the same once per
  // patch so clips an agent added (without linkGroup) ride along with their stems.
  if (!relinkedDocs.has(proj)) { E.relinkClips(); relinkedDocs.add(proj); }
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const signed = (n) => (n > 0 ? "+" : "") + r3(n);
  const num = (v, what) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name}: ${what} must be a number (seconds)`);
    return v;
  };
  const clipOf = (id) => {
    const c = proj.clips.find((x) => x.id === id);
    if (!c) throw new Error(`${name}: no clip ${id}`);
    return c;
  };
  const named = () => {
    if (!Array.isArray(op.ids) || !op.ids.length) throw new Error(`${name}: ids must list at least one clip`);
    const clips = op.ids.map(String).map(clipOf);
    for (const c of clips) refuseLocked(name, lockReason(c), op);
    return clips;
  };
  const refused = (why) => new Error(`${name}: ${why}` +
    (/locked/i.test(why) ? " — the user locked it; pass force:true only if they asked" : ""));
  const trimmed = (c, r, extra = "") => {
    if (typeof r === "string") throw refused(r);
    const asked = num(op.delta, "delta");
    return `${name} ${c.id}${extra} ${signed(r)}s` + (Math.abs(r - asked) > 1e-6 ? ` (asked ${signed(asked)}, clamped)` : "");
  };
  switch (name) {
    case "split": {
      const at = num(op.at, "at");
      const r = E.splitAt(at, op.ids ? named() : null);
      if (!r.split) throw refused(r.blocked ? "only locked clips under that time — left whole" : `no clip runs across ${at}s on the ${op.ids ? "given clips" : "targeted tracks"}`);
      return `split@${at} +${r.rights.map((x) => x.id).join("+")}` + (r.blocked ? " (locked clips left whole)" : "");
    }
    case "rippleDelete": {
      const r = E.rippleDelete(named());
      return `-${r.removed.map((x) => x.id).join("-")} (rippled)`;
    }
    case "closeGap": {
      const G = E.closeGapAt(num(op.at, "at"));
      if (typeof G === "string") throw refused(G.replace("at playhead", `at ${op.at}s`).replace("move the playhead", "pick another time"));
      return `closed ${r3(G)}s gap @${op.at}`;
    }
    case "lift": case "extract": {
      const usePoints = op.from == null && op.to == null;
      const t0 = op.from == null ? proj.inPoint : num(op.from, "from");
      const t1 = op.to == null ? proj.outPoint : num(op.to, "to");
      if (t0 == null || t1 == null) throw refused("give from and to (seconds), or set the project's inPoint and outPoint");
      const why = E.liftRange(t0, t1, name === "extract");
      if (why) throw refused(why.replace("Set IN and OUT first (I / O) to", "from→to must span more than a frame to"));
      if (usePoints) { delete proj.inPoint; delete proj.outPoint; } // as in the editor
      return `${name} ${r3(t0)}→${r3(t1)}s`;
    }
    case "rippleTrim": case "roll": {
      const c = clipOf(String(op.id));
      if (op.side !== "in" && op.side !== "out") throw new Error(`${name}: side must be "in" (head) or "out" (tail)`);
      const fn = name === "roll" ? E.rollEdit : E.rippleTrim;
      return trimmed(c, fn(c, op.side, num(op.delta, "delta")), "." + op.side);
    }
    case "slip": case "slide": {
      const c = clipOf(String(op.id));
      const fn = name === "slip" ? E.slipClip : E.slideClip;
      return trimmed(c, fn(c, num(op.delta, "delta")));
    }
    case "insert": case "overwrite": {
      const m = proj.media.find((x) => x.id === op.mediaId);
      if (!m) throw new Error(`${name}: unknown mediaId ${op.mediaId}`);
      const timed = m.kind === "video" || m.kind === "audio";
      const inn = op.in == null ? 0 : num(op.in, "in");
      if (inn < 0) throw new Error(`${name}: in must be ≥ 0`);
      const dur = op.duration != null ? num(op.duration, "duration")
        : timed && m.duration > 0 ? m.duration - inn : null;
      if (dur == null) throw new Error(`${name}: duration is required for ${timed ? "media with no known duration yet" : m.kind}`);
      if (!(dur >= EditOps.MIN_DUR)) throw new Error(`${name}: duration must be at least ${EditOps.MIN_DUR}s`);
      if (timed && m.duration > 0 && inn + dur > m.duration + 1e-3)
        throw new Error(`${name}: in + duration (${r3(inn + dur)}s) runs past the end of ${m.id} (${m.duration}s)`);
      let stems = 2;
      if (m.kind === "video") {
        try { const f = mediaFile(m.src); if (f) stems = probeChannels(f) || 0; } catch { /* no ffprobe: assume stereo */ }
      }
      const r = (name === "insert" ? E.insertAt : E.overwriteAt)(m, timed ? inn : 0, dur, num(op.at, "at"), stems);
      if (typeof r === "string") throw refused(r.replace(" — click a track name to target it (and unlock it)", " — every lane for it is untargeted or locked (pass tracks:[…])"));
      const placed = r.clip ? (r.clip.linkGroup ? proj.clips.filter((x) => x.linkGroup === r.clip.linkGroup) : [r.clip]) : [];
      return `${name}@${r3(r.at)} ` + placed.map((x) => `+${x.id}(${x.track})`).join("") + (name === "insert" ? ` · later clips moved +${r3(dur)}s` : "");
    }
    case "crossfade": {
      const dur = op.duration == null ? EditOps.CROSSFADE_DUR : num(op.duration, "duration");
      if (dur < EditOps.MIN_TRANS_DUR) throw new Error(`${name}: duration must be at least ${EditOps.MIN_TRANS_DUR}s`);
      const pairs = op.ids ? E.crossfadeCuts(E.withLinked(named())) : E.crossfadeCutsNear(num(op.at, "at"));
      if (!pairs.length) throw refused(op.ids ? "no audio cut next to those clips — they must touch or overlap on one track"
        : `no audio cut within 0.5s of ${op.at}s on the targeted audio tracks`);
      const { done, why } = E.crossfadePairs(pairs, dur);
      if (!done) throw refused(why.join(", "));
      return `crossfaded ${done} cut${done === 1 ? "" : "s"}` + (why.length ? ` (skipped: ${why.join(", ")})` : "");
    }
  }
  throw new Error("Unknown edit op " + name);
}

/* ── Noise reduction (fablecut_denoise) — denoise.js, as the editor's Noise control ── */
async function denoiseTool(args) {
  const ids = Array.isArray(args.clipIds) ? args.clipIds.map(String) : [];
  if (!ids.length) throw new Error("`clipIds` must list at least one clip");
  const amount = args.amount == null ? "medium" : String(args.amount);
  if (amount !== "off" && !Denoise.AMOUNT_IDS.includes(amount)) throw new Error(`amount must be one of ${Denoise.AMOUNT_IDS.join(", ")}, off`);
  let doc = readProject();
  const picked = ids.map((id) => {
    const c = doc.clips.find((x) => x.id === id);
    if (!c) throw new Error("no clip " + id);
    return c;
  });
  const targets = Denoise.denoiseTargets(doc, picked);
  const lockedTracks = new Set(Array.isArray(doc.lockedTracks) ? doc.lockedTracks : []);
  const isLocked = (c) => (c.linkGroup ? doc.clips.filter((x) => x.linkGroup === c.linkGroup) : [c])
    .some((x) => x.locked === true || lockedTracks.has(x.track));
  if (args.force !== true && targets.some(isLocked))
    throw new Error(`${targets.filter(isLocked).map((c) => c.id).join(", ")} locked — the user locked it. Leave it alone, or pass force:true if they asked you to change it`);
  const bases = [...new Set(targets.map((c) => Denoise.baseMediaId(doc, c.mediaId)))];
  const rendered = new Map(); // base id → {r, base}
  if (amount !== "off") {
    for (const id of bases) {
      const base = doc.media.find((m) => m.id === id);
      const file = base && mediaFile(base.src);
      if (!file) throw new Error(`media ${id}: file not found`);
      rendered.set(id, { base, r: await Denoise.denoiseFile(file, MEDIA_DIR, amount) });
    }
  }
  // Re-read after the (slow) render so concurrent UI edits are kept.
  const proj = readProject();
  const report = [];
  const swap = new Map();
  for (const id of bases) {
    if (amount === "off") { swap.set(id, id); continue; }
    const { base, r } = rendered.get(id);
    const src = "/media/" + encodeURIComponent(r.name);
    let m = proj.media.find((x) => x.src === src);
    if (!m) {
      m = { id: "m_" + uid(), name: r.name, kind: "audio", src, duration: r.duration, folderId: base.folderId || null,
        derivedFrom: base.id, denoise: amount };
      proj.media.push(m);
    }
    swap.set(id, m.id);
    report.push(`${id} → ${m.id} "${r.name}"${r.cached ? " (already rendered)" : ""}`);
  }
  let changed = 0;
  for (const t of targets) {
    const c = proj.clips.find((x) => x.id === t.id);
    if (!c) continue;
    const next = swap.get(Denoise.baseMediaId(proj, c.mediaId));
    if (next && next !== c.mediaId) { c.mediaId = next; changed++; }
  }
  proj.revision = (proj.revision || 0) + 1;
  writeProject(proj);
  lastReadRevision = proj.revision;
  return `Noise reduction ${amount} on ${targets.map((c) => c.id).join(", ")} (revision ${proj.revision}, ${changed} clip${changed === 1 ? "" : "s"} switched)` +
    (report.length ? ":\n" + report.join("\n") : "");
}

/* ── Export (fablecut_export) ── */
function describeExportJob(j) {
  const pct = Math.round((j.progress || 0) * 100);
  if (j.status === "done") {
    const file = path.join(EXPORTS_DIR, path.basename(decodeURIComponent(j.src || "")));
    let size = "";
    try { size = ` (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`; } catch {}
    return `Export ${j.id} done → ${file}${size}\nServed at ${BASE}${j.src}`;
  }
  if (j.status === "failed" || j.status === "cancelled") return `Export ${j.id} ${j.status}: ${j.error || "no reason given"}`;
  return `Export ${j.id} ${j.status}${j.status === "running" ? ` — ${pct}%` : ""} (in ${j.via === "headless" ? "a headless browser" : "the open editor tab"}). ` +
    `Check again with fablecut_export {job:"${j.id}"}, or stop it with {cancel:"${j.id}"}.`;
}
async function exportTool(args) {
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  if (args.cancel) {
    const r = await apiJSON("POST", "/api/export/job/cancel?id=" + encodeURIComponent(args.cancel));
    if (r.status !== 200) throw new Error(r.body?.error || "cancel failed");
    return describeExportJob(r.body);
  }
  let job;
  if (args.job) {
    const r = await apiJSON("GET", "/api/export/job?id=" + encodeURIComponent(args.job));
    if (r.status !== 200) throw new Error(r.body?.error || "no such export job");
    job = r.body;
  } else {
    const r = await apiJSON("POST", "/api/export/request", { range: args.range, profile: args.profile, where: args.where || "auto" });
    if (r.status !== 200) throw new Error(r.body?.error || `export request failed (${r.status})`);
    job = r.body;
    if (args.wait === false) return describeExportJob(job);
  }
  const deadline = Date.now() + 1000 * (Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 900);
  while (job.status === "pending" || job.status === "running") {
    if (args.job && args.wait !== true) break; // a status check answers right away
    if (Date.now() > deadline) break;
    await sleep(1000);
    const r = await apiJSON("GET", "/api/export/job?id=" + encodeURIComponent(job.id));
    if (r.status !== 200) throw new Error(r.body?.error || "lost track of the export job");
    job = r.body;
  }
  return describeExportJob(job);
}

/* ── Scopes (fablecut_scopes): one graded still, measured in the editor ── */
function describeScopes(j) {
  if (j.status !== "done") return `Scope reading ${j.id} ${j.status}${j.error ? ": " + j.error : ""}`;
  const r = j.result || {}, st = r.stats;
  if (!st) return `Frame at ${r.time}s is empty (nothing drawn).`;
  const L = st.luma, cast = st.cast;
  const lines = [
    `Frame at ${r.time}s (${r.frame?.w}x${r.frame?.h}):`,
    `  luma min ${L.min} · p1 ${L.p1} · median ${L.median} · mean ${L.mean} · p99 ${L.p99} · max ${L.max}`,
    `  clipped: black ${st.clipped.blackPct}% · white ${st.clipped.whitePct}%`,
    `  rgb mean [${st.rgbMean.join(", ")}] · saturation ${st.saturation}`,
    `  cast: ${cast.tone === "neutral" ? "neutral" : `${cast.tone} (hue ${cast.hue}°)`} · strength ${cast.strength}`,
    `On screen (bottom → top): ${(r.clips || []).map((c) => `${c.id} ${c.track} ${c.kind}${c.grade !== "neutral" ? " grade:" + c.grade : ""}${c.masks ? ` masks:[${c.masks}]` : ""}${c.matte ? ` matte:${c.matte}` : ""}${c.isMatte ? " (a matte — not drawn)" : ""}${c.blend ? " blend:" + c.blend : ""}`).join(" | ") || "nothing"}`,
  ];
  const m = r.matte;
  if (m) {
    lines.push(m.error ? `Matte ${m.clip} layer ${m.layer}: ${m.error}` : `Matte of ${m.clip} layer ${m.layer}: covers ${m.coverage}% of the clip's picture` +
      (m.selected ? ` · selected pixels: luma median ${m.selected.luma.median} (p1 ${m.selected.luma.p1}, p99 ${m.selected.luma.p99}) · rgb mean [${m.selected.rgbMean.join(", ")}] · saturation ${m.selected.saturation} · cast ${m.selected.cast.tone === "neutral" ? "neutral" : `${m.selected.cast.tone} (hue ${m.selected.cast.hue}°)`}` : " · nothing selected"));
  }
  const k = r.mask;
  if (k) lines.push(k.error ? `Masks of ${k.clip}: ${k.error}` : `Masks of ${k.clip} (${k.masks}): keep ${k.coverage}% of the clip's picture · the masked clip covers ${k.frameCoverage}% of the frame`);
  return lines.join("\n") + "\n" + JSON.stringify({ time: r.time, stats: st, ...(m ? { matte: m } : {}), ...(k ? { mask: k } : {}) });
}
async function scopesTool(args) {
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  const body = { where: args.where || "auto" };
  if (args.time != null) body.time = args.time;
  if (args.matte != null) body.matte = args.matte;
  if (args.mask != null) body.mask = args.mask;
  const r = await apiJSON("POST", "/api/scopes/request", body);
  if (r.status !== 200) throw new Error(r.body?.error || `scope request failed (${r.status})`);
  let job = r.body;
  const deadline = Date.now() + 1000 * (Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 60);
  while (job.status === "pending" || job.status === "running") {
    if (Date.now() > deadline) {
      await apiJSON("POST", "/api/export/job/cancel?id=" + encodeURIComponent(job.id));
      throw new Error("timed out waiting for the editor to measure the frame");
    }
    await sleep(300);
    const q = await apiJSON("GET", "/api/export/job?id=" + encodeURIComponent(job.id));
    if (q.status !== 200) throw new Error(q.body?.error || "lost track of the scope reading");
    job = q.body;
  }
  if (job.status !== "done") throw new Error(`scope reading ${job.status}: ${job.error || "no reason given"}`);
  return describeScopes(job);
}

/* ── Tool implementations ── */
async function callTool(name, args, attempt = 0) {
  switch (name) {
    case "fablecut_export":
      return exportTool(args);
    case "fablecut_scopes":
      return scopesTool(args);
    case "fablecut_denoise":
      return denoiseTool(args);
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
        textAnim: "none", wordRate: 0.15, direction: "auto", boxW: 0, boxH: 0, boxFit: false, vAlign: "middle",
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
          if (k === "masks") continue;   // summarized below — bezier point lists are long
          if (hex(DEFAULTS[k]) !== hex(v)) kept[k] = v;
        }
        const masks = Mask.describe(Mask.normalizeMasks(o.masks));
        return (Object.keys(kept).length ? " " + JSON.stringify(kept) : "") + (masks ? ` [${masks}]` : "");
      };
      // Mixer: only off-default faders / pans, so a fresh project adds no line.
      const signed = (v) => (v > 0 ? "+" : "") + v;
      const fxTag = (fx) => Array.isArray(fx) && fx.length ? ` fx:${FX.summarizeFx(fx)}` : "";
      const mixLine = (d) => {
        const parts = (Array.isArray(d.tracks) ? d.tracks : [])
          .filter((t) => t && (+t.gain || +t.pan || t.fx?.length || t.out))
          .map((t) => t.id + (t.out ? `→${t.out}` : "") + (+t.gain ? ` ${signed(+t.gain)}dB` : "") + (+t.pan ? ` pan:${+t.pan}` : "") + fxTag(t.fx));
        for (const b of Array.isArray(d.buses) ? d.buses : [])
          parts.push(`bus ${b.id}${b.name ? ` "${b.name}"` : ""}` + (+b.gain ? ` ${signed(+b.gain)}dB` : "") + (+b.pan ? ` pan:${+b.pan}` : "") +
            (b.mute ? " muted" : "") + fxTag(b.fx));
        if (d.master && (+d.master.gain || d.master.fx?.length))
          parts.push("master" + (+d.master.gain ? ` ${signed(+d.master.gain)}dB` : "") + fxTag(d.master.fx));
        return parts.length ? [`MIX: ${parts.join(" · ")}`] : [];
      };
      const lines = [
        `"${doc.name}" ${doc.width}x${doc.height}@${doc.fps} rev:${doc.revision}` +
        (doc.panSchema >= 1 ? " panSchema:1" : "") +
        (doc.background ? ` bg:${doc.background}` : "") +
        (doc.inPoint != null || doc.outPoint != null ? ` in/out:${doc.inPoint ?? "-"}→${doc.outPoint ?? "-"}` : "") +
        (doc.markers?.length ? ` markers:${doc.markers.length} [${doc.markers.slice(0, 12).map((m) => m.t).join(",")}${doc.markers.length > 12 ? ",…" : ""}]` : "") +
        (doc.lockedTracks?.length ? ` lockedTracks:[${doc.lockedTracks.join(",")}]` : "") +
        (doc.untargetedTracks?.length ? ` untargetedTracks:[${doc.untargetedTracks.join(",")}]` : "") +
        (doc.disabledTracks?.length ? ` disabledTracks:[${doc.disabledTracks.join(",")}]` : ""),
        ...mixLine(doc),
        `MEDIA (${doc.media.length}):`,
        ...doc.media.map((m) => `  ${m.id} ${m.kind} "${m.name}"${m.duration ? " " + m.duration + "s" : ""}` +
          (m.derivedFrom ? ` (${m.denoise ? "denoised " + m.denoise : "derived"} from ${m.derivedFrom})` : "")),
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
      if (!Array.isArray(args.ops) || !args.ops.length) throw new Error("`ops` must be a non-empty array");
      const base = args.baseRevision;
      if (base != null && !Number.isInteger(base))
        throw new Error("`baseRevision` must be an integer revision (from fablecut_get_project, fablecut_status or the last patch result)");
      // ops get filled in as they apply (auto ids …); a retry must start from the originals
      const ops = structuredClone(args.ops);
      const proj = readProject();
      const readRev = proj.revision || 0;
      const conflict = (rev) => new Error(
        `CONFLICT — not saved. project.json is at revision ${rev}, but this patch was based on ` +
        `revision ${base ?? readRev}: the project changed in between (the user probably edited in the UI). ` +
        `Re-read the clips you touch (fablecut_get_project {compact:true}), then retry with baseRevision:${rev} — ` +
        `or omit baseRevision to apply on top of the latest anyway.`);
      if (base != null && readRev !== base) throw conflict(readRev);
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
      /* The effect chain an op names: a clip (and its linked stems), an
         A-track, a submix bus or the master → {label, read(), write(list)}. */
      const fxTarget = (op, name) => {
        const target = op.target || (op.id && /^A\d+$/.test(op.id) ? "track" : op.id && /^B\d+$/.test(op.id) ? "bus" : op.id ? "clip" : "master");
        if (target === "clip") {
          const c = proj.clips.find((x) => x.id === op.id);
          if (!c) throw new Error(`${name}: no clip ${op.id}`);
          if (c.kind !== "audio") throw new Error(`${name}: clip ${op.id} is ${c.kind} — effects go on audio clips (a video's sound is on its linked A-track clips)`);
          refuseLocked(name, lockReason(c), op);
          const group = c.linkGroup ? proj.clips.filter((x) => x.linkGroup === c.linkGroup && x.kind === "audio") : [c];
          return { label: group.map((x) => x.id).join("+"), read: () => c.fx, write(next) {
            for (const x of group) { if (next.length) x.fx = next.map((e) => JSON.parse(JSON.stringify(e))); else delete x.fx; }
          } };
        }
        if (target === "track") {
          if (!/^A\d+$/.test(String(op.id || ""))) throw new Error(`${name}: track id must be an audio track (A1, A2, …)`);
          if (!Array.isArray(proj.tracks) || !proj.tracks.length) proj.tracks = DEFAULT_TRACKS.map((t) => ({ ...t }));
          let t = proj.tracks.find((x) => x.id === op.id);
          if (!t) { t = { id: op.id, kind: "audio" }; proj.tracks.push(t); }
          return { label: op.id, read: () => t.fx, write(next) { if (next.length) t.fx = next; else delete t.fx; } };
        }
        if (target === "bus") {
          const b = (proj.buses || []).find((x) => x.id === op.id);
          if (!b) throw new Error(`${name}: no bus ${JSON.stringify(op.id)} — create it with {op:"setBus", id:"B1"}`);
          return { label: op.id, read: () => b.fx, write(next) { if (next.length) b.fx = next; else delete b.fx; } };
        }
        if (target === "master") {
          return { label: "master", read: () => proj.master?.fx, write(next) {
            const m = proj.master && typeof proj.master === "object" ? proj.master : {};
            if (next.length) m.fx = next; else delete m.fx;
            if (Object.keys(m).length) proj.master = m; else delete proj.master;
          } };
        }
        throw new Error(`${name}: target must be clip, track, bus or master`);
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
      // props.masks written wholesale (addClip / updateClip) is validated like setMask
      const checkMasks = (c, label) => {
        if (!c.props || c.props.masks == null) return;
        if (c.kind === "audio") throw new Error(`${label}: masks go on video, image, svg, text or adjust clips`);
        let n;
        try { n = Mask.normalizeMasks(c.props.masks, true); } catch (err) { throw new Error(`${label}: props.${err.message}`); }
        if (n) c.props.masks = n; else delete c.props.masks;
      };
      // blend / matte / matteTrack: checked when the op writes them
      const videoTrackIds = () => {
        const ids = (Array.isArray(proj.tracks) && proj.tracks.length ? proj.tracks : DEFAULT_TRACKS).filter((t) => t.kind === "video").map((t) => t.id);
        for (const x of proj.clips) if (/^V\d+$/.test(x.track) && !ids.includes(x.track)) ids.push(x.track);
        return ids;
      };
      const checkCompositing = (c, label, props) => {
        if (!props || !["blend", "matte", "matteTrack"].some((k) => props[k] != null)) return;
        if (c.kind === "audio") throw new Error(`${label}: blend and track mattes go on video, image, svg, text or adjust clips`);
        try { Mask.checkCompositing(c.props, videoTrackIds(), c.track, true); } catch (err) { throw new Error(`${label}: props.${err.message}`); }
        if (!c.props.matte) delete c.props.matteTrack;
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
            checkMasks(c, "addClip");
            checkCompositing(c, "addClip", c.props);
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
            checkMasks(c, "updateClip");
            // a track move re-checks the matte too (a clip can't be its own matte)
            checkCompositing(c, "updateClip", op.set && op.set.track ? c.props : op.set && op.set.props);
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
            // {op:"setFx", target:"clip"|"track"|"bus"|"master", id?, fx?:[…] | preset?:"podcast", append?:true}
            const t = fxTarget(op, "setFx");
            let chain;
            if (op.preset != null) chain = FX.presetChain(String(op.preset));
            else if (op.fx === null) chain = [];
            else chain = FX.normalizeFx(op.fx, true);
            t.write(op.append ? [...FX.normalizeFx(t.read()), ...chain] : chain);
            notes.push("~" + t.label + ".fx");
            break;
          }
          case "setFxKeys": {
            // {op:"setFxKeys", target, id?, index?|type?, param, keys:[{t, v, ease?}] | null}
            const t = fxTarget(op, "setFxKeys");
            const list = FX.normalizeFx(t.read()).map((e) => ({ ...e }));
            let i = Number.isInteger(op.index) ? op.index : op.type != null ? list.findIndex((e) => e.type === op.type) : list.length === 1 ? 0 : -1;
            if (!list[i]) throw new Error(`setFxKeys: pick the effect with index (0…${list.length - 1}) or type — ${t.label} has ${FX.summarizeFx(list) || "no effects"}`);
            const e = list[i];
            if (!FX.FX_DEFS[e.type].params[op.param]) throw new Error(`setFxKeys: ${e.type} has no parameter ${JSON.stringify(op.param)} (has: ${Object.keys(FX.FX_DEFS[e.type].params).join(", ")})`);
            const keys = { ...(e.keys || {}) };
            if (op.keys == null || (Array.isArray(op.keys) && !op.keys.length)) delete keys[op.param];
            else Object.assign(keys, FX.normalizeKeys(e.type, { [op.param]: op.keys }, true) || {});
            if (Object.keys(keys).length) e.keys = keys; else delete e.keys;
            t.write(list);
            notes.push(`~${t.label}.fx[${i}].${op.param}` + (keys[op.param] ? `(${keys[op.param].length} keys)` : "(keys cleared)"));
            break;
          }
          case "setGrade": {
            // {op:"setGrade", id | ids, grade:{…} | null, replace?:true}
            const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
            if (!ids.length) throw new Error("setGrade needs id or ids");
            if (op.grade !== null && (typeof op.grade !== "object" || Array.isArray(op.grade)))
              throw new Error("setGrade needs grade:{…} (or grade:null to clear)");
            if (op.grade) Color.normalizeGrade(Object.fromEntries(Object.entries(op.grade).filter(([, v]) => v !== null)), true); // validate first
            for (const id of ids) {
              const c = proj.clips.find((x) => x.id === id);
              if (!c) throw new Error("setGrade: no clip " + id);
              if (!["video", "image", "svg", "adjust"].includes(c.kind)) throw new Error(`setGrade: ${id} is a ${c.kind} clip — grades go on video, image, svg or adjust clips`);
              refuseLocked("setGrade", lockReason(c), op);
              const next = op.grade === null ? null : Color.mergeGrade(op.replace ? null : c.props?.grade, op.grade, true);
              c.props = c.props || {};
              if (next) c.props.grade = next; else delete c.props.grade;
              notes.push(`~${id}.grade(${Color.summarizeGrade(next)})`);
            }
            break;
          }
          case "setGradeLayer": {
            // {op:"setGradeLayer", id | ids, layer: index | "name", set?:{…}, replace?:true, remove?:true}
            const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
            if (!ids.length) throw new Error("setGradeLayer needs id or ids");
            const byName = typeof op.layer === "string" && op.layer.trim() !== "";
            if (!byName && !(Number.isInteger(op.layer) && op.layer >= 0)) throw new Error("setGradeLayer needs layer: an index (0 = first) or a layer name");
            if (!op.remove && (op.set == null || typeof op.set !== "object" || Array.isArray(op.set))) throw new Error("setGradeLayer needs set:{…} (or remove:true)");
            for (const id of ids) {
              const c = proj.clips.find((x) => x.id === id);
              if (!c) throw new Error("setGradeLayer: no clip " + id);
              if (!["video", "image", "svg", "adjust"].includes(c.kind)) throw new Error(`setGradeLayer: ${id} is a ${c.kind} clip — grades go on video, image, svg or adjust clips`);
              refuseLocked("setGradeLayer", lockReason(c), op);
              const layers = (c.props?.grade?.layers || []).map((l) => ({ ...l }));
              let i = byName ? layers.findIndex((l) => l.name === op.layer.trim()) : op.layer;
              if (op.remove) {
                if (i < 0 || i >= layers.length) throw new Error(`setGradeLayer: ${id} has no layer ${JSON.stringify(op.layer)}`);
                layers.splice(i, 1);
              } else {
                if (i < 0 || i === layers.length) { // a new layer
                  if (layers.length >= Color.MAX_LAYERS) throw new Error(`setGradeLayer: at most ${Color.MAX_LAYERS} layers`);
                  i = layers.length; layers.push({ name: byName ? op.layer.trim() : `Layer ${i + 1}` });
                } else if (i > layers.length) throw new Error(`setGradeLayer: ${id} has ${layers.length} layer(s) — use layer:${layers.length} to add one`);
                const base = op.replace ? { name: layers[i].name } : layers[i];
                let next;
                try { next = Color.mergeLayer(base, op.set, true); } catch (err) { throw new Error(`setGradeLayer: ${err.message.replace(/^grade\.layers\[0\]\.?/, "")}`); }
                if (!next.name) next.name = layers[i].name || `Layer ${i + 1}`;
                layers[i] = next;
              }
              const g = Color.mergeGrade(c.props?.grade, { layers: layers.length ? layers : null }, true);
              c.props = c.props || {};
              if (g) c.props.grade = g; else delete c.props.grade;
              notes.push(`~${id}.grade(${Color.summarizeGrade(g)})`);
            }
            break;
          }
          case "setMask":
          case "removeMask":
          case "setMaskKeys": {
            // {op:"setMask", id | ids, mask?: index | "name", set:{…}, replace?:true, remove?:true}
            // {op:"removeMask", id | ids, mask} · {op:"setMaskKeys", id | ids, mask, keys:[…] | null}
            const name = op.op;
            const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
            if (!ids.length) throw new Error(`${name} needs id or ids`);
            const remove = name === "removeMask" || op.remove === true;
            const byName = typeof op.mask === "string" && op.mask.trim() !== "";
            if (op.mask != null && !byName && !(Number.isInteger(op.mask) && op.mask >= 0)) throw new Error(`${name}: mask is an index (0 = first) or a mask name`);
            if ((remove || name === "setMaskKeys") && op.mask == null) throw new Error(`${name} needs mask: an index or a name`);
            let set;
            if (name === "setMaskKeys") {
              if (op.keys !== null && !Array.isArray(op.keys)) throw new Error("setMaskKeys needs keys:[{t, x?, y?, …}] (or keys:null to stop animating)");
              set = { keys: op.keys && op.keys.length ? op.keys : null };
            } else if (!remove) {
              if (op.set == null || typeof op.set !== "object" || Array.isArray(op.set)) throw new Error("setMask needs set:{shape?, x?, y?, …} (or remove:true)");
              set = op.set;
            }
            for (const id of ids) {
              const c = proj.clips.find((x) => x.id === id);
              if (!c) throw new Error(`${name}: no clip ${id}`);
              if (c.kind === "audio") throw new Error(`${name}: ${id} is an audio clip — masks go on video, image, svg, text or adjust clips`);
              refuseLocked(name, lockReason(c), op);
              const list = (Mask.normalizeMasks(c.props?.masks) || []).slice();
              let i = op.mask == null ? list.length : byName ? list.findIndex((m) => m.name === op.mask.trim()) : op.mask;
              const where = `${name}: ${id}`;
              if (remove) {
                if (i < 0 || i >= list.length) throw new Error(`${where} has no mask ${JSON.stringify(op.mask)}`);
                list.splice(i, 1);
              } else {
                const adding = i < 0 || i === list.length;
                if (adding && name === "setMaskKeys") throw new Error(`${where} has no mask ${JSON.stringify(op.mask)}`);
                if (!adding && i > list.length) throw new Error(`${where} has ${list.length} mask(s) — use mask:${list.length} (or leave mask out) to add one`);
                if (adding && list.length >= Mask.MAX_MASKS) throw new Error(`${where}: at most ${Mask.MAX_MASKS} masks`);
                const base = adding ? (byName ? { name: op.mask.trim() } : null) : op.replace ? { name: list[i].name } : list[i];
                if (adding && !set.shape && !(base && base.shape)) throw new Error(`${where}: a new mask needs set.shape (rect | ellipse | bezier | freehand)`);
                let next;
                try { next = Mask.mergeMask(base, set, true); }
                catch (err) { throw new Error(`${where}: ${err.message.replace(/^mask\.?/, "mask.")}`); }
                if (adding) { i = list.length; list.push(next); } else list[i] = next;
              }
              c.props = c.props || {};
              if (list.length) c.props.masks = list; else delete c.props.masks;
              notes.push(`~${id}.masks(${Mask.describe(list) || "none"})`);
            }
            break;
          }
          case "setMatte": {
            // {op:"setMatte", id | ids, matte:"alpha"|"alpha-inverted"|"luma"|"luma-inverted"|null, track?:"V3"|null}
            const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
            if (!ids.length) throw new Error("setMatte needs id or ids");
            if (op.matte !== null && !Mask.MATTES.includes(op.matte)) throw new Error(`setMatte needs matte: ${Mask.MATTES.join(" | ")} (or null for none)`);
            for (const id of ids) {
              const c = proj.clips.find((x) => x.id === id);
              if (!c) throw new Error("setMatte: no clip " + id);
              if (c.kind === "audio") throw new Error(`setMatte: ${id} is an audio clip — track mattes go on video, image, svg, text or adjust clips`);
              refuseLocked("setMatte", lockReason(c), op);
              c.props = c.props || {};
              if (op.matte === null) { delete c.props.matte; delete c.props.matteTrack; notes.push(`~${id}.matte(none)`); continue; }
              c.props.matte = op.matte;
              if (op.track === null) delete c.props.matteTrack;
              else if (op.track != null) c.props.matteTrack = op.track;
              try { Mask.checkCompositing(c.props, videoTrackIds(), c.track, true); } catch (err) { throw new Error(`setMatte: ${id}: ${err.message.replace(/^matteTrack/, "track")}`); }
              const from = Mask.matteTrackFor(c, videoTrackIds());
              if (!from) throw new Error(`setMatte: ${id} is on ${c.track} and there is no video track above it — pass track:"Vn" (or add a track)`);
              notes.push(`~${id}.matte(${op.matte} from ${from})`);
            }
            break;
          }
          case "setTrack": {
            // Mixer settings on one lane: {op:"setTrack", id:"A1", set:{gain:-6, pan:0.2}}.
            if (!/^A\d+$/.test(String(op.id || ""))) throw new Error("setTrack: id must be an audio track (A1, A2, …)");
            if (!Array.isArray(proj.tracks) || !proj.tracks.length) proj.tracks = DEFAULT_TRACKS.map((t) => ({ ...t }));
            let t = proj.tracks.find((x) => x.id === op.id);
            if (!t) { t = { id: op.id, kind: "audio" }; proj.tracks.push(t); }
            for (const [k, v] of Object.entries(op.set || {})) {
              if (k === "out") { // route into a submix bus, or back to the master
                if (v == null || v === "master") { delete t.out; continue; }
                if (!(proj.buses || []).some((b) => b.id === v)) throw new Error(`setTrack: no bus ${JSON.stringify(v)} — create it first with {op:"setBus", id:"B1"}`);
                t.out = v;
                continue;
              }
              const range = k === "gain" ? [-60, 12] : k === "pan" ? [-1, 1] : null;
              if (!range) throw new Error(`setTrack: '${k}' not settable (gain, pan, out)`);
              if (v === null || v === 0) { delete t[k]; continue; }
              if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1])
                throw new Error(`setTrack: ${k} must be a number ${range[0]}…${range[1]}`);
              t[k] = v;
            }
            notes.push("~" + op.id);
            break;
          }
          case "setBus": {
            // {op:"setBus", id:"B1", set:{name?, gain?, pan?, mute?}} — creates the bus if needed
            if (!/^B\d+$/.test(String(op.id || ""))) throw new Error("setBus: id must be B1, B2, …");
            proj.buses = Array.isArray(proj.buses) ? proj.buses : [];
            let b = proj.buses.find((x) => x.id === op.id);
            if (!b) {
              if (proj.buses.length >= 8) throw new Error("setBus: up to 8 buses");
              b = { id: op.id };
              proj.buses.push(b);
              proj.buses.sort((x, y) => parseInt(x.id.slice(1), 10) - parseInt(y.id.slice(1), 10));
            }
            for (const [k, v] of Object.entries(op.set || {})) {
              if (k === "name") { if (v == null || v === "") delete b.name; else b.name = String(v).slice(0, 40); continue; }
              if (k === "mute") { if (v === true) b.mute = true; else delete b.mute; continue; }
              const range = k === "gain" ? [-60, 12] : k === "pan" ? [-1, 1] : null;
              if (!range) throw new Error(`setBus: '${k}' not settable (name, gain, pan, mute; effects via setFx target:"bus")`);
              if (v === null || v === 0) { delete b[k]; continue; }
              if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1])
                throw new Error(`setBus: ${k} must be a number ${range[0]}…${range[1]}`);
              b[k] = v;
            }
            notes.push("~" + op.id);
            break;
          }
          case "removeBus": {
            const n = (proj.buses || []).length;
            proj.buses = (proj.buses || []).filter((b) => b.id !== op.id);
            if (proj.buses.length === n) throw new Error("removeBus: no bus " + op.id);
            if (!proj.buses.length) delete proj.buses;
            for (const t of proj.tracks || []) if (t.out === op.id) delete t.out; // back to the master
            notes.push("-" + op.id);
            break;
          }
          case "setProject": {
            const allowed = ["name", "width", "height", "fps", "background", "markers", "disabledTracks", "lockedTracks", "untargetedTracks", "exportFrame", "encodeProfile", "master", "inPoint", "outPoint"];
            for (const [k, v] of Object.entries(op.set || {})) {
              if (!allowed.includes(k)) throw new Error(`setProject: '${k}' not settable (allowed: ${allowed.join(", ")})`);
              if ((k === "inPoint" || k === "outPoint") && v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0))
                throw new Error(`setProject: ${k} must be seconds ≥ 0 (null clears it)`);
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
            if (proj.inPoint != null && proj.outPoint != null && !(proj.outPoint > proj.inPoint))
              throw new Error("setProject: outPoint must be after inPoint");
            notes.push("~project");
            break;
          }
          case "split": case "rippleDelete": case "closeGap": case "lift": case "extract":
          case "rippleTrim": case "roll": case "slip": case "slide":
          case "insert": case "overwrite": case "crossfade":
            notes.push(timelineEdit(proj, op, refuseLocked, lockReason));
            break;
          default:
            throw new Error("Unknown op: " + op.op + " (addClip|updateClip|removeClip|addMedia|removeMedia|setProject|setTrack|setBus|removeBus|setFx|setFxKeys|setGrade|setGradeLayer|setMask|removeMask|setMaskKeys|setMatte|" +
              "split|rippleDelete|closeGap|lift|extract|rippleTrim|roll|slip|slide|insert|overwrite|crossfade)");
        }
      }
      // Someone else saved while the ops ran: writing now would drop their change.
      // Without a baseRevision the ops just re-apply on the newer document.
      let diskRev = readRev;
      try { diskRev = readProject().revision || 0; } catch {}
      if (diskRev !== readRev) {
        if (base == null && attempt < 3) return callTool(name, args, attempt + 1);
        throw conflict(diskRev);
      }
      proj.revision = readRev + 1;
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
          serverInfo: { name: "fablecut", version: "1.12.1" },
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
