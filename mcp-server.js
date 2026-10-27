/* ═══════════════════════════════════════════════════════════════════════════
   FableCut MCP server — connects Claude (Code / Desktop) to the video editor.
   Zero-dependency stdio JSON-RPC (Model Context Protocol).

   Register once for all Claude Code sessions:
     claude mcp add -s user fablecut -- npx -y fablecut mcp
   or, from a clone:
     claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"

    Tools: fablecut_status, fablecut_docs, fablecut_get_project,
           fablecut_set_project, fablecut_patch_project, fablecut_import_media,
           fablecut_analyze_reference, fablecut_frame, fablecut_encode_profiles,
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
  APP_DIR, DATA_DIR, MEDIA_DIR, EXPORTS_DIR, ANALYSIS_DIR, LIBRARY_DIR, PROJECT_FILE, PROXIES_DIR, ensureDirs, readSaved, writeSaved,
} = require("./paths");
const { downloadImportUrl, kindFromName, maybeFaststart } = require("./import-url");
const FX = require("./audio-fx");
const EditOps = require("./edit-ops");
const ProjectOps = require("./project-ops");
const Denoise = require("./denoise");
const { createProjects } = require("./projects");
const { createHistory } = require("./history");
const Color = require("./color");
const FrameStats = require("./frame-stats");
const Mask = require("./mask");
const Tracker = require("./tracker");
const Motion = require("./motion");
const CompLib = require("./comp");
const SeqLib = require("./sequences");
const Templates = require("./templates");
const Delivery = require("./delivery");
const { probeFile, infoForEntry } = require("./media-probe");
const { findProxies } = require("./proxy");
/** The user's saved presets / templates (library/presets, library/templates), validated; bad files skipped. */
const savedItems = (kind) => readSaved(kind).map((x) => (kind === "presets" ? Templates.normalizePreset(x.data) : Templates.normalizeTemplate(x.data))).filter(Boolean);

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
/** JSON request to the editor server → {status, body}. Extra headers are for
 *  endpoints that gate on them — /api/frame?path= needs X-FableCut-Client. */
function apiJSON(method, urlPath, payload, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(API + urlPath, { method, headers: { "Content-Type": "application/json", ...headers } }, (r) => {
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
  /* Tests (and nothing else) may set FABLECUT_NO_AUTOSTART=1: the auto-start
     below spawns a detached server.js the test harness cannot stop — it
     inherits the test's port and data dir and keeps running after the test.
     With the flag set, report the missing server instead of starting one. */
  if (process.env.FABLECUT_NO_AUTOSTART === "1") return false;
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
    description: "Apply targeted edits to the FableCut project WITHOUT round-tripping the whole document — PREFER THIS over get+set for every edit (it is ~10-100x cheaper in tokens and merge-safe by design: it re-reads the latest document from disk, applies your ops in order, bumps revision once, saves atomically). Ops: {op:'addClip', clip:{…}} (id auto-generated if omitted) · {op:'updateClip', id, set:{…}} · {op:'removeClip', id} · {op:'addMedia', media:{…}} · {op:'removeMedia', id} · MEDIA BIN: {op:'updateMedia', id | ids, set:{name?, favorite?:true|false, tags?:[…], folderId?}, addTags?:[…], removeTags?:[…]} (organize media; fps, codec, audio channels and size are probed from the file and read-only) · {op:'setCollection', id?, name?, media?:[…ids] (replaces), add?:[…], remove?:[…]} (a collection groups media across folders; a new id or name creates it) · {op:'removeCollection', id} · {op:'relinkMedia', id, src:'/media/…'} (the same footage found elsewhere — an OFFLINE file in the compact view; clips keep their In points) · {op:'replaceMedia', id, src, name?} (a different file behind the media — every clip using it switches, keeping its timing, trimmed to fit a shorter file; import the new file first with fablecut_import_media) · {op:'setProject', set:{name|width|height|fps|background|markers|disabledTracks|lockedTracks|untargetedTracks|encodeProfile|delivery|outputs|master}} (markers = the full list [{t, label?, color?}], color: gold|red|orange|green|cyan|blue|purple|pink; master = {gain}, the master fader in dB; delivery = a delivery preset id or spec — see fablecut_export — that exports use by default; outputs = the batch list, [preset id | spec, …] up to 16, exported together by fablecut_export {outputs:true}) · {op:'setTrack', id:'A1', set:{gain?, pan?, out?}} (audio-track fader in dB −60…+12, pan −1…1, out = a submix bus id or 'master'; null or 0 resets) · {op:'setBus', id:'B1', set:{name?, gain?, pan?, mute?}} (submix bus, created if missing; route tracks into it with setTrack out) · {op:'removeBus', id} · {op:'setFx', target:'clip'|'track'|'bus'|'master', id?, preset?:'podcast'|… OR fx:[{type,…params}], append?:true} (audio effects — validated; presets: clean-voice, podcast, radio, deep-voice, telephone, cinematic, wide, muffled; fx:null clears; on a clip it applies to its linked stems too) · {op:'setFxKeys', target, id?, index?|type?, param, keys:[{t, v, ease?}]|null} (automate one effect parameter: t is clip-local for a clip's effects, timeline seconds otherwise; see the 'Audio mix' docs section) · {op:'setGrade', id | ids:[…], grade:{exposure?, temp?, tint?, lift?, gamma?, gain?, offset?, contrast?, pivot?, blacks?, shadows?, midtones?, highlights?, whites?, lowSoft?, highSoft?, saturation?, curves?:{y?, r?, g?, b?}, hueHue?, hueSat?, hueLuma?, satLuma?, layers?:[…], on?}, replace?:true} (color grade on video / image / svg / adjust clips — wheels are [r, g, b, master]; curves are [[x, y], …] point lists on 0…1 and merge per channel; hue curves are [[hue°, value], …] — one point = a ±40° band; layers replaces the whole layer list; merges key by key, null resets a key, replace:true starts from neutral, grade:null clears; see the 'Color' docs section; measure the result with fablecut_scopes) · {op:'setGradeLayer', id | ids, layer: index | 'name', set:{name?, on?, qualifier?:{hue?:[centre°, width°, soft°], sat?:[lo, hi, soft], luma?:[lo, hi, soft], invert?}, mask?:{shape:'ellipse'|'rect'|'poly', x, y, w, h, rotation?, feather?, invert?, points?, keys?:[{t, x?, y?, …}]}, …any grade key}, replace?:true, remove?:true} (a secondary: a grade applied only where the qualifier × mask select; a new name or index = length adds a layer; qualifier and mask merge key by key; check what it selects with fablecut_scopes matte:{clip, layer}) · {op:'setMask', id | ids, mask?: index | 'name', set:{shape?:'rect'|'ellipse'|'bezier'|'freehand', mode?:'add'|'subtract'|'intersect'|'difference', invert?, opacity?, feather? (px), expand? (px, − shrinks), x?, y? (centre, 0…1 of the clip's picture), w?, h?, scale?, rotation?, points?:[[dx, dy, inX?, inY?, outX?, outY?], …] (bezier, around x, y), stroke?:[[u, v], …] (freehand: fitted into a bezier), keys?:[{t, ease?, x?, y?, w?, h?, scale?, rotation?, feather?, expand?, opacity?, points?}], name?, on?}, replace?:true, remove?:true} (clip masks on video / image / svg / text / adjust clips: the clip shows only where its masks combine to, bottom-up; mask left out, an unknown name or index = length adds one — a new mask needs shape; set merges key by key; masks follow the clip's transform; check with fablecut_scopes mask:{clip}) · {op:'removeMask', id, mask} · {op:'setMaskKeys', id, mask, keys:[…]|null} (animate a mask; t = seconds from the clip's start) · {op:'setMatte', id | ids, matte:'alpha'|'alpha-inverted'|'luma'|'luma-inverted'|null, track?:'V3'|null} (track matte: the picture on the video track directly above — or track — cuts the clip by its alpha or its brightness, inverted or not; that track stops drawing while it is a matte; null clears). · {op:'removeTrack', id, track: name | index} (delete a motion track stored by fablecut_track; what follows it keeps its keys). MOTION GRAPHICS: a shape layer is addClip {kind:'shape', track, start, duration, props:{shapes:[…]}} (no mediaId); a null is addClip {kind:'null', …} — invisible, a parent for other clips. {op:'setShape', id | ids, shape?: index | 'name' | '2.0' (path into a group), set:{type?:'rect'|'ellipse'|'polygon'|'star'|'line'|'path'|'group', name?, on?, x?, y? (px from the layer's origin), rotation?, scale?, opacity?, w?, h?, radius? (rect corners), sides?, inner? (star 0.05…1), points?:[[x, y, inX?, inY?, outX?, outY?], …] (line: 2, path: 2…128, px around x, y), closed? (path), fill?, stroke? ('#rrggbb' | '#rrggbbaa' | 'none'), strokeWidth?, lineCap?, lineJoin?, dash?:[on, off…], trimStart?, trimEnd? (0…100 — a draw-on), trimOffset?, items?:[…] (group), keys?:[{t, ease?, …any of x y rotation scale opacity w h radius inner strokeWidth trimStart trimEnd trimOffset fill stroke points}]}, replace?:true, remove?:true} (shape left out, an unknown name or index = length adds one — a new shape needs type; set merges key by key) · {op:'removeShape', id, shape} · {op:'setParent', id | ids, parent: clip id | null, keep?: true, at?} (the clip moves, turns and scales with its parent; keep:true — the default — keeps it where it is at time at, default its start; opacity and effects are not inherited). COMPOSITIONS (nested sequences): project.comps = [{id, name, width, height, duration, background?, tracks?, clips:[…]}]; a clip {kind:'comp', compId, start, in, duration} places one (draws like a picture of the comp's size — transform, masks, grade, blend, blur all apply — and its media plays and exports). {op:'addComp', comp:{id?, name, duration, width?, height?, background?, clips?:[…]}} · {op:'updateComp', id, set:{name?, width?, height?, duration?, background?, tracks?}} · {op:'removeComp', id} (refused while used) · {op:'precompose', ids:[…], name?, id?} (the clips move into a new comp; a comp clip takes their place) · {op:'inComp', comp, ops:[…]} (run clip and timeline ops on the comp's own clips — addClip, updateClip, setShape, split, …; nests). SEQUENCES (several timelines in one project — e.g. a 16:9 cut and a 9:16 cut sharing the media and comps; the open one is the top level of the document, which every op, export and the compact view use): {op:'addSequence', name?, from?:'empty'|'open'|<sequence id> (empty takes the open one's canvas and frame rate; a copy takes its whole timeline), width?, height?, fps?, open?:true} · {op:'openSequence', id} (changes what the user's editor shows — only when asked, or to work on it) · {op:'updateSequence', id, set:{name?, index?}} · {op:'removeSequence', id} (only when the user asked) · {op:'inSequence', sequence, ops:[…]} (run any clip, timeline, track or setProject op on a sequence without opening it). PRESETS AND TEMPLATES: {op:'applyPreset', id | ids, preset, length?, at?} keys a named animation onto visual clips, relative to where they sit (in: fade-in, pop-in, slide-up-in, slide-down-in, slide-left-in, slide-right-in, drop-in, zoom-in, spin-in, whip-in, rise-blur, draw-on · out: fade-out, pop-out, slide-up-out, slide-down-out, slide-left-out, slide-right-out, zoom-out, spin-out, whip-out, sink-blur, draw-off · at (an emphasis at timeline time at): pulse, shake, wobble, bounce, flash · loop (the whole clip): float, breathe, sway, spin, wiggle — or a saved one, or an inline {anchor:'in'|'out'|'at'|'whole', length, keys:{channel:[{t, v, ease?}]}} where scale / opacity multiply and the rest add). {op:'addTemplate', template, start?, track?, duration?, fields?:{key: value}, id?, compId?, name?} places a template as its own comp + a comp clip (lower-third-bar, lower-third-underline, lower-third-boxes [name, title, accent…] · logo-ring, logo-slam, logo-lines [logo = a media id, brand / tagline, accent] · social-story 1080x1920, social-quote 1080x1080, social-end-card [text fields, accent, background]); {op:'setTemplate', id: its clip or comp, fields?, duration?} changes the fields or the length (the exit keeps its timing). {op:'savePreset', id, name, anchor?} / {op:'saveTemplate', comp, name?, fields?} save to library/presets and library/templates for every project.MOTION PATHS: x and y keyed at the same time are a position key; curve handles pin / pout (px) on those x and y keys bend the path between keys ({op:'setMotionPath', id | ids, path:'smooth'|'straight', autoOrient?:bool} sets them for you; props.autoOrient turns the clip along its path). props.motionBlur = shutter angle 0…720 (180 = film look), props.motionBlurSamples 2…32. TEXT ON A PATH: {op:'setTextPath', id | ids, path:'line'|'arc'|'circle'|'wave'|{type:'path'|'line'|'ellipse'|'rect'|'polygon'|'star', …shape item geometry, keys?}|null, offset? (% along, keyable as pathOffset), align?:'start'|'center'|'end'} — the title runs along the path (more lines on parallel curves below it), every textAnim plays along it. Every visual clip also has props.anchorX / anchorY (px from its picture's centre: the point x / y place and rotation / scale turn around) and shape clips props.trimStart / trimEnd / trimOffset (trim every path in the layer) — all keyframable. props.blend: normal · multiply · screen · overlay · darken · lighten · color-dodge · color-burn · hard-light · soft-light · difference · exclusion · hue · saturation · color · luminosity · lighter. TIMELINE EDITS — the editor's own split / ripple / trim code, so linked stems, track targeting (untargetedTracks) and locks behave exactly as in the UI; times in seconds: {op:'split', at, ids?} (no ids: every targeted track) · {op:'rippleDelete', ids} (later clips close the hole) · {op:'closeGap', at} · {op:'lift'|'extract', from?, to?} (remove a range; extract closes it; default = project inPoint/outPoint, which then clear) · {op:'insert'|'overwrite', mediaId, at, in?, duration?} (three-point edit: insert pushes later clips right, overwrite replaces what is there; a video brings one audio stem per channel) · {op:'rippleTrim'|'roll', id, side:'in'|'out', delta} · {op:'slip'|'slide', id, delta} (clamped to the media; the note says what was applied) · {op:'crossfade', ids? | at, duration?} (constant-power audio crossfade, borrowing handles from both sides). Any of these takes tracks:[…] to target lanes for that op only. setProject also takes inPoint / outPoint. updateClip merge rules: top-level keys are replaced (keyframes/transitionIn/transitionOut wholesale), `props` merges key-by-key, and setting any key to null deletes it. LOCKS: the user can lock clips (`locked:true`) and tracks (`lockedTracks`); updateClip / removeClip on a locked clip — or on a clip linked to one — and addClip onto a locked track are refused. Leave locked material alone; only if the user asked you to change it, pass force:true on that op (or unlock first: updateClip set:{locked:null}, which is always allowed). All-or-nothing: an invalid op aborts the whole patch unsaved. Optional baseRevision: the revision your ops were planned against (from fablecut_get_project, fablecut_status or the previous patch result) — if the project has moved past it (e.g. the user edited in the UI meanwhile), the patch is refused with CONFLICT and the current revision, nothing saved; re-check the clips you touch, then retry with the new revision. Omit it to apply on top of whatever is latest.",
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
    name: "fablecut_frame",
    description: "LOOK at the footage — returns an actual image, not just numbers. REQUIRES A VISION-CAPABLE MODEL: if you cannot read images, pass `text:true` instead (or skip this tool and use fablecut_analyze_reference). Three modes. (1) One frame of a source clip: pass `path` (an absolute file path, or a '/media/…' src — read where it lies, never copied) and `t` in seconds. (2) A contact sheet: pass `frames` (2–60) for one grid image with that many moments spread across the clip (`from`/`to` to survey part of it) — the cheap way to see what a whole clip holds. (3) With no `path`, `time` renders the COMPOSED TIMELINE at that moment through the editor's own compositor, graded and multi-track, exactly as export would. Use it before choosing a clip's `in` point, or to pick footage matching a blueprint's shots[] energy — seeing beats guessing. Needs ffmpeg on PATH (timeline mode runs in the open editor tab, else a headless browser).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source clip to look at: an absolute file path or a '/media/…' src. Read in place — nothing is copied into media/. Omit to render the timeline instead." },
        t: { type: "number", description: "Seconds into the source clip (default 0). Ignored when `frames` is passed." },
        time: { type: "number", description: "TIMELINE seconds to render, when `path` is omitted (default: the editor's playhead)" },
        frames: { type: "number", description: "Contact-sheet mode: number of moments to sample across the clip, 2–60 (default 12)" },
        cols: { type: "number", description: "Contact-sheet columns (omit for the squarest layout — 6 frames give 3×2, 12 give 4×3)" },
        from: { type: "number", description: "Contact sheet: start of the range to survey (default 0)" },
        to: { type: "number", description: "Contact sheet: end of the range (default: the clip's duration)" },
        width: { type: "number", description: "Pixel width of the returned image (default 768 for one frame, 320 per cell for a sheet)" },
        text: { type: "boolean", description: "Return TEXT measurements instead of the image, for a client or model that cannot see one: brightness and luma levels, dominant named colours with their share, texture (detail within the frame, 0–100), and for a contact sheet a per-cell line with change-since-the-previous-cell. Measurements, NOT a caption — they say what the picture is made of, never what is in it. Use when you have no vision." },
        where: { type: "string", enum: ["auto", "tab", "headless"], description: "Timeline mode only: auto (default): an open editor tab, else headless · tab · headless" },
        timeout: { type: "number", description: "Timeline mode: seconds to wait for the render (default 60)" },
      },
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
    description: "List what fablecut_export can make. DELIVERY PRESETS (structured settings, the Export dialog's Preset list): youtube, youtube-shorts, instagram-reels, tiktok, x, linkedin, master (project size), broadcast (ProRes 422 HQ), web (720p), archive (lossless FFV1), custom — plus presets the user saved — each a spec of resolution, fps, codec (h264, hevc, av1, vp9, prores, dnxhr, mpeg2 XDCAM, ffv1), rate control (crf / vbr / cbr), keyframe interval, pixel format, color, container, audio, a file-name template and metadata. {preset:'youtube'} returns one preset's full spec; the encoders this ffmpeg can use are listed (hardware ones only when they work on this machine). ENCODING PROFILES (encoding-profiles.json): raw ffmpeg argument lists plus jpegQuality, extension and color, for anything the presets do not cover; edit the file on disk (hot-reloaded); {profile:'hq'} returns one, detail:true includes every args array. Both are dry-run against ffmpeg when an export starts, so bad settings are refused before rendering.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "boolean", description: "Include the full ffmpeg args array per encoding profile (default: a truncated summary)" },
        profile: { type: "string", description: "Return one encoding profile by id instead of the full list" },
        preset: { type: "string", description: "Return one delivery preset's full spec (youtube, broadcast, a saved preset id …)" },
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
    name: "fablecut_silence",
    description: "Find the silences in speech and, with cut:true, cut them out. Listens to the given clips (a video's linked audio stems, after channel routing, gain and volume) and reports every stretch where none of them is above `threshold` for at least `minSilence` seconds, keeping `padding` seconds of quiet beside each phrase so words aren't clipped. Gaps between clips are left alone. With cut:true each silence is removed with an `extract` on the targeted tracks (or `tracks`), last first, in one revision: later material moves up, linked stems stay in sync, locked tracks and clips stay put — lock the music bed first if it should keep running. A version is saved before the cut. Without cut it only reports, so check the spans (and fablecut_frame them) first. The same as the inspector's Silence section. Needs ffmpeg + ffprobe on PATH.",
    inputSchema: {
      type: "object",
      properties: {
        clipIds: { type: "array", items: { type: "string" }, description: "The speech clips to listen to (a video clip brings its linked stems)" },
        threshold: { type: "number", description: "Below this level (dBFS) counts as silence, -80…-10 (default -40; raise it toward -30 for a noisy room)" },
        minSilence: { type: "number", description: "Shortest silence to report or cut, seconds 0.1…10 (default 0.5)" },
        padding: { type: "number", description: "Quiet kept beside each phrase, seconds 0…2 (default 0.15)" },
        cut: { type: "boolean", description: "Cut the silences out (default false: only report them)" },
        tracks: { type: "array", items: { type: "string" }, description: "cut: the lanes to cut on (default: the targeted tracks)" },
        force: { type: "boolean", description: "cut: also cut through locked clips (only when the user asked)" },
      },
      required: ["clipIds"],
    },
  },
  {
    name: "fablecut_beats",
    description: "The music's beat on the timeline, and cuts that land on it. Listens to a music clip (an audio clip, or a video's sound) and finds its tempo (BPM), a steady beat grid phased to the hits, and the drop — all in timeline seconds, through the clip's in point and speed. Then, in one revision: markers:true puts a cyan marker on every beat; snap:true rolls each cut on the video tracks (the targeted ones, or snap:{tracks}) to the nearest beat within half a beat (snap:{maxShift} seconds) — nothing else moves, linked stems follow; retime:{track?, every?, from?} lays the clips on a track (default the lowest video track with clips) back to back on the beat, `every` beats each (1, 2, 4, 8 or 16; default 2), from the first beat at or after `from` (default the music's start) — a clip whose footage runs out gets fewer beats, and the order is kept. Locked clips are left alone (snap) or refuse (retime) unless force:true. A version is saved before snap or retime (if that fails the edit still goes ahead and the reply warns). Without markers / snap / retime it only reports. The same as the Inspector's Beats section. Needs ffmpeg on PATH.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The music clip to listen to" },
        markers: { type: "boolean", description: "Put a cyan marker on every beat (other markers stay)" },
        snap: { description: "true, or {tracks?:[…], maxShift?: seconds}: roll each cut on those video tracks to the nearest beat" },
        retime: { description: "true, or {track?: 'V1', every?: 1|2|4|8|16, from?: seconds}: re-cut that track's clips to the beat, `every` beats each" },
        every: { type: "number", description: "Beats per shot for retime (1, 2, 4, 8 or 16; default 2)" },
        force: { type: "boolean", description: "Also move locked clips (only when the user asked)" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "fablecut_reframe",
    description: "Reframe for another shape, following the subject: a 16:9 edit made 9:16 (Reels, Shorts, TikTok), 1:1 or 4:5. With aspect, a copy of the open sequence is made on that canvas (the project's shorter side kept, e.g. 1920×1080 → 1080×1920) and opened, so the original cut stays as it was; without aspect, the open sequence is reframed on its own canvas. Each full-frame shot (a video or still that isn't moved, scaled, cropped or animated by hand) is fitted to cover the canvas, and its position follows what matters in it: frames are sampled 5 times a second, the subject is found by motion against the shot's own movement, detail and colour, and a virtual camera operator holds still until the subject leaves a dead zone, then eases after it no faster than a pan speed. The result is ordinary x (or y) keyframes, thinned to a few, or one steady position — edit them like any keys. Shots without a clear subject are centred. Titles, picture-in-picture, clips placed by hand and locked clips are left alone (listed in the reply) — check them with fablecut_frame on the new canvas. clipIds limits it to some clips; follow:false only fits and centres; smooth 0…1 (default 0.5) — higher holds longer and pans slower. A version is saved first. Needs ffmpeg on PATH.",
    inputSchema: {
      type: "object",
      properties: {
        aspect: { type: "string", enum: ["9:16", "1:1", "4:5", "16:9", "4:3", "2:3"], description: "Make a copy of the open sequence on this canvas shape and reframe it (default: reframe the open sequence as it is)" },
        name: { type: "string", description: "With aspect: the new sequence's name (default: the open one's name and the shape)" },
        clipIds: { type: "array", items: { type: "string" }, description: "Only these clips (default: every full-frame shot)" },
        follow: { type: "boolean", description: "Follow the subject (default true); false only fits and centres" },
        smooth: { type: "number", description: "0…1, default 0.5: higher holds longer and pans slower" },
        force: { type: "boolean", description: "Also reframe locked clips (only when the user asked)" },
      },
    },
  },
  {
    name: "fablecut_transcribe",
    description: "What is said, word by word, with times — and text-based editing. Transcribes the clips' speech with Whisper in the editor (an open tab, else headless Chrome / Edge; the speech model downloads once, the audio never leaves the machine), keeps one transcript per file (analysis/transcripts/), and answers with the timeline's words as timed lines (timeline seconds), so you can read an interview, pick the good takes, or find where something is said. find:\"phrase\" (or a list) reports every place it is said — case, punctuation and spacing ignored, whole words only — with the exact span; cut:true then extracts each of them on the targeted tracks (or `tracks`), the words and the pause after them, last first, in one revision: later material moves up, linked stems stay in sync, locked clips stay put (lock the music bed first). A version is saved before a cut. Files already transcribed aren't done again unless again:true. Default clips: every video / audio clip with sound on the open timeline. mediaIds reads whole files instead (file seconds; no cut). The same as the editor's Transcript tab.",
    inputSchema: {
      type: "object",
      properties: {
        clipIds: { type: "array", items: { type: "string" }, description: "Clips to transcribe and read (a video brings its linked stems). Default: every clip with sound on the timeline" },
        mediaIds: { type: "array", items: { type: "string" }, description: "Instead of clips: whole files, read in file seconds (find works, cut doesn't)" },
        model: { type: "string", enum: ["base", "small"], description: "Whisper model: base (default, 77 MB, quick) or small (250 MB, more accurate, slower)" },
        language: { type: "string", description: "The spoken language as a Whisper code (en, es, hi, ja, …) or auto (default: detected)" },
        again: { type: "boolean", description: "Transcribe again even when a transcript exists (another model or language)" },
        find: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "A word or phrase (or several) to find; matches are reported with their timeline spans" },
        from: { type: "number", description: "Only words from this time on (timeline seconds; file seconds with mediaIds)" },
        to: { type: "number", description: "Only words before this time" },
        cut: { type: "boolean", description: "Cut every match of `find` out (default false: only report)" },
        tracks: { type: "array", items: { type: "string" }, description: "cut: the lanes to cut on (default: the targeted tracks)" },
        force: { type: "boolean", description: "cut: also cut through locked clips (only when the user asked)" },
        where: { type: "string", enum: ["auto", "tab", "headless"], description: "Where to transcribe: auto (default): an open editor tab, else headless · tab · headless" },
        timeout: { type: "number", description: "Seconds to wait for the transcription (default 1800)" },
      },
    },
  },
  {
    name: "fablecut_captions",
    description: "Captions from what is said: makes caption clips on the timeline from the clips' transcripts (transcribing first when there is none, like fablecut_transcribe), each one a text clip with `wordTimes` so its words follow the speech. Captions are cut at pauses and sentences, one or two lines as wide as the canvas allows. Styles: subtitle (plain, on a dark bar), karaoke (words light up as they are said), highlight (bold, the word being said in a colour — the reel look), pop (one to three big words at a time, each popping in). They go on the lane captions are already on, else the top video lane, else a new lane above it, and replace the captions there (replace:false keeps them). export:\"srt\"|\"vtt\" writes the timeline's captions to a subtitle file in exports/; import: a path to an SRT / WebVTT file (or its text) places its captions instead of the transcript's. remove:true deletes the captions. Captions are text clips: restyle them with updateClip, and make them after the cutting is done (a cut through a caption doesn't re-time its words — run this again). The same as the Transcript tab's Captions row.",
    inputSchema: {
      type: "object",
      properties: {
        style: { type: "string", enum: ["subtitle", "karaoke", "highlight", "pop"], description: "The look (default subtitle)" },
        clipIds: { type: "array", items: { type: "string" }, description: "Caption only these clips' speech (default: every clip with sound)" },
        from: { type: "number", description: "Only speech from this time on (timeline seconds)" },
        to: { type: "number", description: "Only speech before this time" },
        lines: { type: "number", description: "Lines per caption, 1–3 (default: the style's)" },
        words: { type: "number", description: "At most this many words per caption (pop and highlight have their own default)" },
        size: { type: "number", description: "Scale the style's text size, e.g. 1.2 (default 1)" },
        track: { type: "string", description: "The video lane to put them on (default: chosen as described)" },
        replace: { type: "boolean", description: "Remove the captions already on the timeline first (default true)" },
        export: { type: "string", enum: ["srt", "vtt"], description: "Write the timeline's captions to exports/ as SubRip or WebVTT, and change nothing" },
        import: { type: "string", description: "An SRT or WebVTT file (absolute path, or a /media/… src) or its text: place its captions" },
        remove: { type: "boolean", description: "Delete every caption clip" },
        force: { type: "boolean", description: "Also replace or remove locked captions (only when the user asked)" },
        model: { type: "string", enum: ["base", "small"], description: "Transcribing first: the Whisper model (see fablecut_transcribe)" },
        language: { type: "string", description: "Transcribing first: the spoken language (default: detected)" },
        where: { type: "string", enum: ["auto", "tab", "headless"], description: "Transcribing first: where (see fablecut_transcribe)" },
      },
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
    name: "fablecut_projects",
    description: "Several projects in one FableCut: the projects dashboard. ./project.json (what every other tool reads and edits) is always the OPEN project; the others are stored beside it and share media/, exports/ and the library, so a duplicate or a template copies no footage. Actions: list (default; archived:'only'|'all' to see archived ones) · open {id} — switches the editor to that project (the open one is saved first; editor tabs reload; your next fablecut_get_project reads the new one) · new {name, template?, fps?, width?, height?, notes?, tags?, open?:true} — template is a built-in canvas (landscape-1080 default, vertical-1080, square-1080, portrait-1350, uhd-4k, landscape-720) or a saved template id · duplicate {id, name?, open?:false} · update {id, name?, notes?, tags?} · archive / unarchive {id} · delete {id} (archived projects only) · templates · save_template {id, name} (the project's canvas, tracks, clips and media references) · delete_template {template}. Opening another project changes what the user sees — only open, archive or delete when the user asked for it.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "open", "new", "duplicate", "update", "archive", "unarchive", "delete", "templates", "save_template", "delete_template"], description: "What to do (default list)" },
        id: { type: "string", description: "The project (p_…), from list" },
        name: { type: "string", description: "new / duplicate / update: the project's name · save_template: the template's name" },
        template: { type: "string", description: "new: the template to start from · delete_template: the saved template's id" },
        fps: { type: "number", description: "new: frame rate (default: the template's)" },
        width: { type: "integer", description: "new: canvas width (default: the template's)" },
        height: { type: "integer", description: "new: canvas height (default: the template's)" },
        notes: { type: "string", description: "new / update: free-text notes (brief, client, deadline …)" },
        tags: { type: "array", items: { type: "string" }, description: "new / update: labels (replaces the list)" },
        open: { type: "boolean", description: "new (default true) / duplicate (default false): open it afterwards" },
        archived: { type: "string", enum: ["exclude", "only", "all"], description: "list: archived projects too, or only them" },
      },
    },
  },
  {
    name: "fablecut_versions",
    description: "A project's version history: saved copies you can go back to, never destructive. Actions: list (default) · save {name?, note?, final?} — keep the project as it is now (do this before big or risky edits, and when the user is happy with a cut) · diff {version, to?} — what changed from that version to now (or to another version): clips added / removed / changed, length, media, settings · restore {version} — put that version back; the current state is saved as a version first, so a restore can itself be undone · update {version, name?, note?, final?} — rename, annotate, or mark the one final cut · delete {version}. project defaults to the open one (fablecut_projects lists ids). Versions are also made on their own: every 10 minutes while the project changes, and before an agent's first edit of a session or a fablecut_set_project rewrite. Restoring changes what the user sees: only when they asked.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "save", "diff", "restore", "update", "delete"], description: "What to do (default list)" },
        project: { type: "string", description: "The project (p_…); default the open one" },
        version: { description: "The version: its number (3) or \"v3\"", anyOf: [{ type: "integer" }, { type: "string" }] },
        to: { description: "diff: compare to this version instead of the current project", anyOf: [{ type: "integer" }, { type: "string" }] },
        name: { type: "string", description: "save / update: the version's name (default \"Version NN\")" },
        note: { type: "string", description: "save / update: what this version is (\"client cut, shorter intro\")" },
        final: { type: "boolean", description: "save / update: mark it the final cut (one per project)" },
      },
    },
  },
  {
    name: "fablecut_proxy",
    description: "Proxies: light H.264 copies (540p by default, 720p or 1080p; never larger than the source) of heavy footage — 4K, HEVC, ProRes, long phone clips — that the editor plays while the user edits, so playback and scrubbing stay smooth. Export, fablecut_frame, fablecut_scopes and every measurement always read the original, so a proxy never changes the result. Without create or delete it reports each video's proxy (ready, being made with its progress, failed, none). create:true makes them (one at a time, in the background on the server) and waits until they are done unless wait:false; delete:true removes them. mediaIds defaults to every video in the project. The user turns proxy playback on or off with the monitor's Proxy button. Needs ffmpeg on PATH.",
    inputSchema: {
      type: "object",
      properties: {
        mediaIds: { type: "array", items: { type: "string" }, description: "Video media ids (default: all video media)" },
        create: { type: "boolean", description: "Make proxies for these files" },
        delete: { type: "boolean", description: "Delete their proxies" },
        height: { type: "number", enum: [540, 720, 1080], description: "Proxy height in pixels (default 540)" },
        wait: { type: "boolean", description: "With create: wait until every proxy is done (default true)" },
        timeout: { type: "number", description: "Seconds to wait with create (default 900)" },
      },
    },
  },
  {
    name: "fablecut_export",
    description: "Render the timeline to a video file in exports/ — the editor's own Fast export (same compositor, audio mix and encoding profile as the Export button), so the file matches what the user sees. It runs in a browser: an open editor tab takes the job (the user sees the progress bar), or with no tab open the server starts headless Chrome / Edge (set FABLECUT_CHROME to pick one) and closes it afterwards. Waits for the file by default and returns its path. Range: the project's inPoint→outPoint when set, else the whole timeline (or pass range). Needs ffmpeg on PATH. One export at a time. Long edits: pass wait:false, then poll with {job}; {cancel:job} stops one.",
    inputSchema: {
      type: "object",
      properties: {
        range: { type: "string", enum: ["entire", "in-out"], description: "Whole timeline, or the project's inPoint→outPoint (default: in-out when either is set)" },
        preset: { type: "string", description: "Delivery preset: youtube, youtube-shorts, instagram-reels, tiktok, x, linkedin, master, broadcast, web, archive, custom, or a saved preset's id (fablecut_encode_profiles lists them). The output is reframed to the preset's size — cropped from the middle (or from the project's exportFrame), or padded with reframe:'fit'" },
        delivery: { type: "object", description: "Delivery settings over the preset (or over custom): {width, height (null = the picture's size), fps (null = the project's), reframe:'fill'|'fit'|'stretch', container:'mp4'|'mov'|'mkv'|'webm'|'mxf', video:{codec:'h264'|'hevc'|'av1'|'vp9'|'prores'|'dnxhr'|'mpeg2'|'ffv1', encoder?, rate:'crf'|'vbr'|'cbr', crf, bitrate (kb/s), maxrate (kb/s), keyint (s), pixFmt, speed:'fast'|'balanced'|'best', profile (prores: proxy|lt|standard|hq|4444|4444xq · dnxhr: lb|sq|hq|hqx|444)}, audio:{codec:'aac'|'opus'|'mp3'|'pcm16'|'pcm24'|'flac'|'none', bitrate (kb/s), sampleRate, channels, loudness (LUFS target: -14 streaming/social, -16 podcast, -23 EBU R128, -24 ATSC; null = as mixed), truePeak (dBTP ceiling, default -1)}, color:'bt709'|'bt709-full'|'bt601-625'|'bt601-525', filename:'{project}_{preset}_{res}' (tokens {project} {preset} {res} {w} {h} {fps} {codec} {date} {time} {range} {n}), metadata:{title, artist, description, copyright, date, keywords}}. Anything left out comes from the preset; impossible combinations are corrected and the reply says how. Every finished file is checked against what was asked (size, fps, frames, codecs, length, loudness, true peak, file size) and the reply lists the checks" },
        outputs: { description: "Several files, rendered once per frame rate (up to 8 outputs per render): true = the project's checked batch outputs (project.outputs, set with setProject {outputs:[…]}), or a list like [{preset:'master'}, {preset:'youtube'}, {preset:'instagram-reels'}, {preset:'custom', width:1080, height:1080, filename:'{project}_square_{res}'}, {preset:'web', filename:'{project}_preview_{res}'}]. Outputs with the same fps share one render; the reply lists every file", anyOf: [{ type: "boolean" }, { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] } }] },
        profile: { type: "string", description: "Encoding profile id (raw ffmpeg args, fablecut_encode_profiles) instead of a preset. With neither: project.delivery, else project.encodeProfile, else the server's default profile" },
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
  {
    name: "fablecut_track",
    description: "Follow something in a video clip frame by frame (motion tracking, in the editor: an open tab, else headless Chrome / Edge) and store it on the clip as a named track (props.tracks). Then, in the same call, make a mask follow it (apply:{mask}) or pin another clip to it (apply:{clip} — a title, sticker, blur box… its x / y, and optionally scale / rotation, get keyframes that ride on the track, keeping where it is at `at`). What to follow: region {x, y, w, h} or point {x, y} (+ size), as fractions of the clip's picture (0…1, y down) at time `at`; or leave both out with apply:{mask} to follow what that mask covers. To re-apply an existing track, pass its name with apply and no region. Pick something with detail (a corner, a logo, text, an eye), not a flat area; the result reports match quality (≥ 0.8 is solid) and where the region was lost, if it was. Check the outcome with fablecut_scopes or by looking at the keyed clip.",
    inputSchema: {
      type: "object",
      properties: {
        clip: { type: "string", description: "The video clip to track in" },
        region: { type: "object", description: "The area to follow at `at`: centre x, y and size w, h, fractions of the clip's picture", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, required: ["x", "y", "w", "h"] },
        point: { type: "object", description: "A spot to follow at `at` (fractions of the picture); a square region of `size` around it is matched", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
        size: { type: "number", description: "With point: the region's width, fraction of the picture's width (default 0.08)" },
        at: { type: "number", description: "Timeline seconds where the region is as given (default: the clip's start)" },
        direction: { type: "string", enum: ["forward", "backward", "both"], description: "Track from `at` to the clip's end (default), to its start, or both" },
        to: { type: "number", description: "Timeline seconds to stop at (default: the clip's end / start)" },
        scale: { type: "boolean", description: "Also follow the region's size (zooms, objects moving closer)" },
        rotation: { type: "boolean", description: "Also follow the region's rotation" },
        name: { type: "string", description: "The track's name (default: the mask's name, or Track n). An existing name is extended / replaced over the tracked range" },
        apply: {
          type: "object",
          description: "Bake the track into keys: {mask: index | name} (the mask's x / y — and scale / rotation when tracked — follow) or {clip: id, scale?, rotation?, at?} (that clip rides on the track)",
          properties: { mask: { type: ["integer", "string"] }, clip: { type: "string" }, scale: { type: "boolean" }, rotation: { type: "boolean" }, at: { type: "number" } },
        },
        force: { type: "boolean", description: "Allow changing locked clips — only when the user asked" },
        where: { type: "string", enum: ["auto", "tab", "headless"], description: "auto (default): an open editor tab, else headless · tab · headless" },
        timeout: { type: "number", description: "Seconds to wait (default 300)" },
      },
      required: ["clip"],
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
async function voiceRegions(proj, voices, threshold, minLen, heard) {
  const L = require("./loudness.js"), D = require("./ducking.js");
  const lists = [];
  for (const v of voices) {
    let env = null;
    await streamClipAudio(proj, v, (nCh) => { env = new D.EnvelopeMeter(nCh, NORM_SR); },
      (chs) => env.push(L.routeChannels(chs, v.props || {})));
    if (!env) continue;   // no audio stream
    if (heard) heard.add(v.id);
    const sp = Math.min(8, Math.max(0.1, +v.props?.speed || 1));
    const gain = Math.pow(10, (+v.props?.gain || 0) / 20) * Math.min(2, Math.max(0, +(v.props?.volume ?? 1)));
    lists.push(D.activeRegions(env.result(), { t0: v.start, speed: sp, gain, threshold, ...(minLen != null ? { minLen } : {}) }));
  }
  return D.mergeRegions(lists, minLen != null ? 0 : undefined);
}
/** The clips that carry a selection's sound, one list per linked group: its
 *  audio stems, else the clip itself (audio, or a video without stems). */
function speechGroups(proj, ids) {
  const groups = new Map();
  for (const id of ids) {
    const c = proj.clips.find((x) => x.id === id);
    if (!c) throw new Error("no clip " + id);
    if (c.kind !== "audio" && c.kind !== "video") throw new Error(`clip ${id} is ${c.kind} — no sound to listen to`);
    const key = c.linkGroup || c.id;
    if (groups.has(key)) continue;
    const members = c.linkGroup ? proj.clips.filter((x) => x.linkGroup === c.linkGroup) : [c];
    const stems = members.filter((x) => x.kind === "audio");
    groups.set(key, stems.length ? stems : [c]);
  }
  return [...groups.values()];
}
const fmtClock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const fmtDur = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
/* fablecut_silence: silence.js on the clips' sound, then (cut:true) its extract ops. */
async function silenceTool(args) {
  const S = require("./silence.js");
  const ids = Array.isArray(args.clipIds) ? args.clipIds.map(String) : [];
  if (!ids.length) throw new Error("`clipIds` must list the speech clip(s) to listen to");
  const opts = S.options(args);
  const doc = readProject();
  const readRev = doc.revision || 0;
  const groups = speechGroups(doc, ids);
  const disabled = new Set(Array.isArray(doc.disabledTracks) ? doc.disabledTracks : []);
  const enabled = groups.map((g) => g.filter((x) => !disabled.has(x.track) && x.disabled !== true)).filter((g) => g.length);
  if (!enabled.length) throw new Error("those clips are disabled (or on disabled tracks) — nothing to listen to");
  // a speed ramp moves the sound along the timeline unevenly: those clips are left alone
  const live = enabled.filter((g) => !g.some(S.ramped));
  const rampedN = enabled.length - live.length;
  if (!live.length) throw new Error("those clips have a speed ramp (speed keyframes) — silence removal works on clips at a steady speed");
  const heard = new Set();
  const sound = await voiceRegions(doc, live.flat(), opts.threshold, S.MIN_SOUND, heard);
  // only time that was actually listened to can be silent: a clip with no audio stream is left alone
  const usable = live.filter((g) => g.every((x) => heard.has(x.id)));
  if (!usable.length) throw new Error("those clips have no audio stream — nothing to listen to");
  const ranges = usable.map((g) => [Math.min(...g.map((x) => x.start)), Math.max(...g.map((x) => x.start + x.duration))]);
  const spans = S.silentSpans(sound, ranges, { ...opts, fps: doc.fps });
  const listen = S.union(ranges).reduce((n, [a, b]) => n + b - a, 0);
  const head = `${spans.length} silence${spans.length === 1 ? "" : "s"}, ${S.total(spans).toFixed(1)} s of ${fmtDur(listen)} ` +
    `(threshold ${opts.threshold} dBFS, at least ${opts.minSilence} s, ${opts.padding} s kept beside speech` +
    (usable.length < live.length ? `; ${live.length - usable.length} clip(s) with no audio stream left alone` : "") +
    (rampedN ? `; ${rampedN} clip(s) with a speed ramp left alone` : "") + ")";
  const list = spans.slice(0, 60).map((s) => `  ${fmtClock(s.from)} → ${fmtClock(s.to)}  (${(s.to - s.from).toFixed(2)} s)`)
    .concat(spans.length > 60 ? [`  … +${spans.length - 60} more`] : []);
  if (args.cut !== true) return [head + (spans.length ? ":" : "."), ...list,
    ...(spans.length ? ["Nothing cut yet: call again with cut:true to remove them (lock the music bed first if it should keep running)."] : [])].join("\n");
  if (!spans.length) return head + " — nothing to cut.";
  // the timeline must be the one that was listened to
  const proj = readProject();
  if ((proj.revision || 0) !== readRev)
    throw new Error(`the project changed while listening (revision ${readRev} → ${proj.revision}) — nothing cut; run fablecut_silence again`);
  const end = (p) => p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const before = end(proj);
  ProjectOps.applyPatch(proj, S.cutOps(spans, { tracks: args.tracks, force: args.force === true }), { savedItems });
  // a cut this size always keeps the project as it was, not once per session like other edits
  let verWarn = "";
  try { createHistory({ projects: createProjects({ dataDir: DATA_DIR, projectFile: PROJECT_FILE, libraryDir: LIBRARY_DIR }) }).beforeAgent("Before cutting silences"); }
  catch (e) { verWarn = ` Warning: no version was saved before the cut (${e.message}).`; }
  const diskRev = readProject().revision || 0;   // a failed read stops it: never write over what we can't see
  if (diskRev !== readRev) throw new Error(`the project changed while cutting (revision ${readRev} → ${diskRev}) — nothing cut; run fablecut_silence again`);
  proj.revision = readRev + 1;
  writeProject(proj);
  lastReadRevision = proj.revision;
  return `Cut ${head} — timeline ${fmtDur(before)} → ${fmtDur(end(proj))} (revision ${proj.revision}). UI hot-reloaded.` +
    (verWarn || ` The project as it was is kept as a version (fablecut_versions lists it; restore undoes the cut).`);
}
/* fablecut_beats: beats.js on the music clip's sound, then its ops (markers, snap, retime). */
const BEATS_MAX_SECS = 20 * 60;
async function beatsTool(args) {
  const Bt = require("./beats.js");
  const doc = readProject();
  const readRev = doc.revision || 0;
  const clip = doc.clips.find((c) => c.id === String(args.clipId || ""));
  if (!clip) throw new Error("`clipId` must name the music clip on the timeline (fablecut_get_project {compact:true} lists them)");
  if (clip.kind !== "audio" && clip.kind !== "video") throw new Error(`clip ${clip.id} is ${clip.kind} — no sound to find a beat in`);
  if (Bt.ramped(clip)) throw new Error(`clip ${clip.id} has a speed ramp — beats follow music playing at a steady speed`);
  const sp = Math.min(8, Math.max(0.1, +clip.props?.speed || 1));
  if (clip.duration * sp > BEATS_MAX_SECS) throw new Error(`clip ${clip.id} is longer than ${BEATS_MAX_SECS / 60} minutes of music — split it, or find the beat on a part of it`);
  const parts = [];
  const nCh = await streamClipAudio(doc, clip, () => true, (chs) => parts.push(Bt.mono(chs)));
  if (!nCh) throw new Error(`clip ${clip.id} has no audio stream — nothing to listen to`);
  const len = parts.reduce((n, p) => n + p.length, 0), all = new Float32Array(len);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const a = Bt.analyze(Bt.resample(all, NORM_SR));
  const src0 = clip.in || 0;
  const abs = { beats: a.beats.map((t) => t + src0), bpm: a.bpm, drop: a.drop != null ? a.drop + src0 : null };
  const acts = { markers: args.markers === true, snap: args.snap || false, retime: args.retime || false, every: args.every, force: args.force === true };
  const r = Bt.plan(doc, clip, abs, acts);
  if (!r.ops.length) return Bt.describe(r);
  const proj = readProject();
  if ((proj.revision || 0) !== readRev)
    throw new Error(`the project changed while listening (revision ${readRev} → ${proj.revision}) — nothing changed; run fablecut_beats again`);
  ProjectOps.applyPatch(proj, r.ops, { savedItems });
  let verWarn = "";
  if (acts.snap || acts.retime) {
    try { createHistory({ projects: createProjects({ dataDir: DATA_DIR, projectFile: PROJECT_FILE, libraryDir: LIBRARY_DIR }) }).beforeAgent(acts.retime ? "Before re-cutting to the beat" : "Before snapping cuts to the beat"); }
    catch (e) { verWarn = ` Warning: no version was saved first (${e.message}).`; }
  }
  const diskRev = readProject().revision || 0;   // a failed read stops it: never write over what we can't see
  if (diskRev !== readRev) throw new Error(`the project changed meanwhile (revision ${readRev} → ${diskRev}) — nothing changed; run fablecut_beats again`);
  proj.revision = readRev + 1;
  writeProject(proj);
  lastReadRevision = proj.revision;
  return Bt.describe(r, { applied: true }) + ` (revision ${proj.revision}; UI hot-reloaded.)` +
    (acts.snap || acts.retime ? verWarn || " The project as it was is kept as a version (fablecut_versions; restore undoes it)." : "");
}
/* fablecut_reframe: a new sequence on the canvas asked for (or the open one), then reframe.js on frames
   ffmpeg samples from each full-frame shot's window. */
const REFRAME_MAX_SECS = 15 * 60;
function sampleFrames(file, c, w, h) {
  const R = require("./reframe.js");
  const sp = Math.min(8, Math.max(0.1, +c.props?.speed || 1));
  const len = Math.max(0.1, Math.min(REFRAME_MAX_SECS, c.duration * sp));
  const args = c.kind === "image"
    ? ["-v", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    : ["-v", "error", "-ss", String(Math.max(0, +c.in || 0)), "-t", String(len), "-i", file, "-an",
       "-vf", `fps=${R.SAMPLE_FPS},scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
  const r = require("child_process").spawnSync("ffmpeg", args, { maxBuffer: 1 << 29, timeout: Math.max(120000, len * 2000) });
  if (r.error?.code === "ENOENT") throw new Error("ffmpeg not found on PATH — needed to look at the footage");
  if (r.error) throw new Error(`ffmpeg couldn't read ${c.id}: ${r.error.code === "ETIMEDOUT" ? "it took too long" : r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg couldn't read ${c.id}: ${String(r.stderr).trim().split("\n").pop()}`);
  const fb = w * h * 3, frames = [];
  for (let o = 0; o + fb <= r.stdout.length; o += fb) frames.push(r.stdout.subarray(o, o + fb));
  return frames;
}
async function reframeTool(args) {
  const R = require("./reframe.js");
  const doc = readProject();
  const readRev = doc.revision || 0;
  const smooth = args.smooth == null ? 0.5 : +args.smooth;
  if (!(smooth >= 0 && smooth <= 1)) throw new Error("smooth must be 0…1");
  const ids = Array.isArray(args.clipIds) && args.clipIds.length ? args.clipIds.map(String) : null;
  const ops = [];
  // the sequence as it will be: a copy on the new canvas, opened — or the open one
  let work = doc, made = "";
  if (args.aspect) {
    const canvas = R.canvasFor(args.aspect, doc.width, doc.height);
    const open = (doc.sequences || []).find((s) => s.id === doc.sequence);
    const seqName = String(args.name || `${open?.name || "Main"} ${args.aspect}`).slice(0, 80);
    const add = { op: "addSequence", from: "open", name: seqName, width: canvas.width, height: canvas.height, open: true };
    work = JSON.parse(JSON.stringify(doc));
    ProjectOps.applyPatch(work, [add], { savedItems });
    ops.push(add);
    made = `New sequence "${seqName}" ${canvas.width}×${canvas.height}, opened. `;
  }
  const canvas = { width: work.width, height: work.height };
  const { take, skip } = R.targets(work, { ids, force: args.force === true });
  if (!take.length) throw new Error("no full-frame shots to reframe" + (skip.length ? ` (${skip.map((x) => `${x.id}: ${x.why}`).join("; ")})` : ""));
  const lines = [];
  for (const c of take) {
    const m = work.media.find((x) => x.id === c.mediaId);
    const file = m && mediaFile(m.src);
    if (!file) { skip.push({ id: c.id, why: "media file not found" }); continue; }
    let src = m.width > 0 && m.height > 0 ? { width: m.width, height: m.height } : null;
    if (!src) {
      const pr = require("child_process").spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { timeout: 10000 });
      const [w, h] = String(pr.stdout).trim().split(",").map(Number);
      if (w > 0 && h > 0) src = { width: w, height: h };
    }
    if (!src) { skip.push({ id: c.id, why: "couldn't read its size" }); continue; }
    let samples = null;
    if (args.follow !== false) {
      const w = R.SAMPLE_W, h = Math.max(8, Math.round(w * src.height / src.width / 2) * 2);
      try { samples = R.subjectTrack(sampleFrames(file, c, w, h), w, h); }
      catch (e) { skip.push({ id: c.id, why: e.message }); continue; }
    }
    const p = R.clipPlan(c, samples, src, canvas, { smooth, fps: work.fps || 30, follow: args.follow !== false });
    ops.push({ op: "updateClip", id: c.id, set: p.set, ...(args.force === true ? { force: true } : {}) });
    lines.push(`  ${c.id}: ${p.note}`);
  }
  if (!lines.length) throw new Error("nothing could be reframed: " + skip.map((x) => `${x.id}: ${x.why}`).join("; "));
  const proj = readProject();
  if ((proj.revision || 0) !== readRev)
    throw new Error(`the project changed while looking at the footage (revision ${readRev} → ${proj.revision}) — nothing changed; run fablecut_reframe again`);
  let verWarn = "";
  try { createHistory({ projects: createProjects({ dataDir: DATA_DIR, projectFile: PROJECT_FILE, libraryDir: LIBRARY_DIR }) }).beforeAgent("Before reframing"); }
  catch (e) { verWarn = ` Warning: no version was saved first (${e.message}).`; }
  const diskRev = readProject().revision || 0;   // a failed read stops it: never write over what we can't see
  if (diskRev !== readRev) throw new Error(`the project changed meanwhile (revision ${readRev} → ${diskRev}) — nothing changed; run fablecut_reframe again`);
  ProjectOps.applyPatch(proj, ops, { savedItems });
  proj.revision = readRev + 1;
  writeProject(proj);
  lastReadRevision = proj.revision;
  return `${made}Reframed ${lines.length} shot${lines.length === 1 ? "" : "s"} for ${canvas.width}×${canvas.height} (revision ${proj.revision}):\n` + lines.join("\n") +
    (skip.length ? `\nLeft as they were: ${skip.map((x) => `${x.id} (${x.why})`).join(", ")} — check them on the new canvas with fablecut_frame {time}.` : "") +
    (verWarn || "\nThe project as it was is kept as a version (fablecut_versions; restore undoes it).");
}
/** What words are placed by and cuts land on: where each clip sits and plays from, the track
 *  switches and the frame rate. An editor saving probed media details while a transcription runs
 *  doesn't change it; a moved, trimmed or cut clip does. */
function timelineSig(doc) {
  return JSON.stringify([doc.fps, doc.lockedTracks || [], doc.untargetedTracks || [], doc.disabledTracks || [],
    (doc.clips || []).map((c) => [c.id, c.track, c.start, c.in, c.duration, c.mediaId, c.props?.speed ?? 1, c.keyframes?.speed ?? null, !!c.locked, !!c.disabled])]);
}
/* The words said on the timeline (or in whole files, mediaIds): transcribes what has no
   transcript yet as a job in an open tab, else headless, then lays the words out. Shared by
   fablecut_transcribe and fablecut_captions. */
async function speechWords(args, fileMode) {
  const T = require("./transcribe.js");
  const model = T.model(args.model), language = T.language(args.language);
  const doc = readProject();
  const readRev = doc.revision || 0;
  const mediaById = new Map((doc.media || []).map((m) => [m.id, m]));
  const disabled = new Set(Array.isArray(doc.disabledTracks) ? doc.disabledTracks : []);
  let entries = [], files = [], rampedN = 0;
  if (fileMode) {
    for (const id of args.mediaIds.map(String)) {
      const m = mediaById.get(id);
      if (!m) throw new Error("no media " + id);
      if (m.kind !== "audio" && m.kind !== "video") throw new Error(`media ${id} is ${m.kind} — no sound to transcribe`);
      files.push(m);
    }
  } else {
    const ids = Array.isArray(args.clipIds) && args.clipIds.length ? args.clipIds.map(String)
      : doc.clips.filter((c) => (c.kind === "audio" || c.kind === "video") && mediaById.get(c.mediaId) && mediaById.get(c.mediaId).audioChannels !== 0
        // a picture whose sound is on linked stems (they are read instead), or one with its sound off
        && !(c.kind === "video" && (c.linkGroup ? doc.clips.some((x) => x.linkGroup === c.linkGroup && x.kind === "audio") : +(c.props?.volume ?? 1) === 0))).map((c) => c.id);
    if (!ids.length) throw new Error("the timeline has no clips with sound — add some, or pass mediaIds");
    const groups = speechGroups(doc, ids).map((g) => g.filter((x) => !disabled.has(x.track) && x.disabled !== true)).filter((g) => g.length);
    if (!groups.length) throw new Error("those clips are disabled (or on disabled tracks) — nothing to read");
    for (const g of groups) {
      if (g.some(T.ramped)) { rampedN++; continue; }
      const m = mediaById.get(g[0].mediaId);
      if (m) entries.push({ clip: g[0], media: m });
    }
    if (!entries.length) throw new Error("those clips have a speed ramp (speed keyframes) — their words can't be placed on the timeline");
    files = [...new Map(entries.map((e) => [e.media.src, e.media])).values()];
  }
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  const srcs = files.map((m) => m.src);
  const st = await apiJSON("POST", "/api/transcript/status", { srcs });
  if (st.status !== 200) throw new Error(st.body?.error || "could not read the transcripts");
  const gone = srcs.filter((s) => st.body.status[s] === null);
  if (gone.length) throw new Error("these files are missing (offline): " + gone.join(", "));
  const todo = args.again === true ? srcs : srcs.filter((s) => !st.body.status[s]);
  let note = "";
  if (todo.length) {
    const r = await apiJSON("POST", "/api/transcribe/request", { where: args.where || "auto", transcribe: { srcs: todo, model, language, again: args.again === true } });
    if (r.status !== 200) throw new Error(r.body?.error || `transcribe request failed (${r.status})`);
    let job = r.body;
    const deadline = Date.now() + 1000 * (Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 1800);
    while (job.status === "pending" || job.status === "running") {
      if (Date.now() > deadline) {
        await apiJSON("POST", "/api/export/job/cancel?id=" + encodeURIComponent(job.id));
        throw new Error("timed out waiting for the transcription — try fewer clips, or a larger timeout");
      }
      await sleep(1000);
      const q = await apiJSON("GET", "/api/export/job?id=" + encodeURIComponent(job.id));
      if (q.status !== 200) throw new Error(q.body?.error || "lost track of the transcription job");
      job = q.body;
    }
    if (job.status !== "done") throw new Error(`transcription ${job.status}: ${job.error || "no reason given"}`);
    const res = job.result || {};
    note = `Transcribed ${(res.done || []).length} file${(res.done || []).length === 1 ? "" : "s"} (${model}${language ? ", " + language : ""}, in ${job.via === "headless" ? "a headless browser" : "the open editor tab"})` +
      ((res.failed || []).length ? `; failed: ${res.failed.map((f) => `${f.src} (${f.error})`).join(", ")}` : "") + ".\n";
  }
  const docs = new Map();
  for (const src of srcs) {
    const g = await apiJSON("GET", "/api/transcript?src=" + encodeURIComponent(src));
    if (g.status === 200 && g.body?.transcript) docs.set(src, T.validate(g.body.transcript));
  }
  const langs = [...new Set([...docs.values()].map((d) => d.language === "auto" ? "detected" : d.language).filter(Boolean))];
  const without = srcs.filter((s) => !docs.has(s));
  let words, scope;
  if (fileMode) {
    // file seconds, one file after another
    words = [];
    for (const m of files) { const d = docs.get(m.src); if (d) words.push(...d.words.map(([w, s, e]) => ({ w, s, e, clip: m.id, r: [0, d.duration || e] }))); }
    scope = `${files.length} file${files.length === 1 ? "" : "s"} (file seconds)`;
  } else {
    words = T.layout(entries.filter((e) => docs.has(e.media.src)).map((e) => ({ clip: e.clip, words: docs.get(e.media.src).words })));
    scope = `${entries.length} clip${entries.length === 1 ? "" : "s"} on the timeline (timeline seconds)`;
  }
  return { doc, readRev, sig: timelineSig(doc), words, scope, note, langs, without, rampedN };
}
/* fablecut_transcribe: transcripts from the editor (a job), read on the timeline, found, cut. */
async function transcribeTool(args) {
  const T = require("./transcribe.js");
  const model = T.model(args.model), language = T.language(args.language);
  const finds = (args.find == null ? [] : Array.isArray(args.find) ? args.find : [args.find]).map(String).filter((q) => T.norm(q));
  if (args.find != null && !finds.length) throw new Error("find needs a word or phrase with letters or digits in it");
  const fileMode = Array.isArray(args.mediaIds) && args.mediaIds.length;
  if (args.cut === true && !finds.length) throw new Error("cut:true needs find — the words or phrases to cut");
  if (args.cut === true && fileMode) throw new Error("cut works on the timeline — pass clipIds (or nothing), not mediaIds");
  const { doc, sig, words, scope, note, langs, without, rampedN } = await speechWords(args, fileMode);
  const fmtT = (x) => fmtClock(Math.max(0, x));
  const lo = Number.isFinite(args.from) ? args.from : -Infinity, hi = Number.isFinite(args.to) ? args.to : Infinity;
  const inWin = (w) => w.e >= lo && w.s <= hi;
  const head = note + `${words.filter(inWin).length} words, ${scope}` + (langs.length ? `, language ${langs.join("/")}` : "") +
    (without.length ? `; no transcript for ${without.join(", ")}` : "") + (rampedN ? `; ${rampedN} clip(s) with a speed ramp left out` : "");
  if (!finds.length) {
    const segs = T.segments(words).filter((sg) => sg.to >= lo && sg.from <= hi);
    const MAX = 300;
    const lines = segs.slice(0, MAX).map((sg) => `[${fmtT(sg.from)}] ${sg.text}`);
    return [head + (segs.length ? ":" : "."), ...lines,
      ...(segs.length > MAX ? [`… ${segs.length - MAX} more lines — pass from (e.g. ${segs[MAX].from.toFixed(1)}) to read on`] : []),
      ...(segs.length ? ["find:\"…\" locates a phrase; with cut:true it is cut out."] : [])].join("\n");
  }
  // find (and cut)
  const runs = [], report = [];
  for (const q of finds) {
    const hits = T.find(words, q).filter((r) => inWin(words[r.i]) && inWin(words[r.j]));
    const spans = T.cutSpans(words, hits, { fps: doc.fps });
    report.push(`"${q}": ${hits.length} match${hits.length === 1 ? "" : "es"}` + (hits.length ? ":" : ""));
    for (const r of hits.slice(0, 50)) {
      const ctx = `${T.text(words, Math.max(0, r.i - 4), r.i - 1)} «${T.text(words, r.i, r.j)}» ${T.text(words, r.j + 1, Math.min(words.length - 1, r.j + 4))}`.trim();
      report.push(`  ${fmtT(words[r.i].s)} → ${fmtT(words[r.j].e)}  ${ctx}`);
    }
    if (hits.length > 50) report.push(`  … +${hits.length - 50} more`);
    runs.push(...hits);
    if (!spans.length && hits.length) report.push("  (each is too short to cut on its own)");
  }
  const spans = T.cutSpans(words, runs, { fps: doc.fps });
  if (args.cut !== true) return [head + ".", ...report,
    ...(spans.length && !fileMode ? [`Cutting them would remove ${spans.length} span${spans.length === 1 ? "" : "s"}, ${T.total(spans).toFixed(1)} s (the words and the pause after each): call again with cut:true.`] : [])].join("\n");
  if (!spans.length) return [head + ".", ...report, "Nothing to cut."].join("\n");
  const proj = readProject(), readRev = proj.revision || 0;
  if (timelineSig(proj) !== sig)
    throw new Error("the timeline changed while transcribing (a clip was moved, trimmed or cut) — nothing cut; run fablecut_transcribe again");
  const end = (p) => p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const before = end(proj);
  ProjectOps.applyPatch(proj, T.cutOps(spans, { tracks: args.tracks, force: args.force === true }), { savedItems });
  let verWarn = "";
  try { createHistory({ projects: createProjects({ dataDir: DATA_DIR, projectFile: PROJECT_FILE, libraryDir: LIBRARY_DIR }) }).beforeAgent("Before cutting words"); }
  catch (e) { verWarn = ` Warning: no version was saved before the cut (${e.message}).`; }
  const diskRev = readProject().revision || 0;   // a failed read stops it: never write over what we can't see
  if (diskRev !== readRev) throw new Error(`the project changed while cutting (revision ${readRev} → ${diskRev}) — nothing cut; run fablecut_transcribe again`);
  proj.revision = readRev + 1;
  writeProject(proj);
  lastReadRevision = proj.revision;
  return [head + ".", ...report,
    `Cut ${spans.length} span${spans.length === 1 ? "" : "s"}, ${T.total(spans).toFixed(1)} s — timeline ${fmtDur(before)} → ${fmtDur(end(proj))} (revision ${proj.revision}). UI hot-reloaded.` +
    (verWarn || " The project as it was is kept as a version (fablecut_versions lists it; restore undoes the cut).")].join("\n");
}
/* fablecut_captions: caption clips from the transcripts (captions.js), subtitle files out and in. */
async function captionsTool(args) {
  const C = require("./captions.js");
  const st = C.style(args.style);
  const ownLocks = (proj, c) => c.locked === true || (Array.isArray(proj.lockedTracks) && proj.lockedTracks.includes(c.track));
  if (args.export != null) {
    if (args.export !== "srt" && args.export !== "vtt") throw new Error("export must be srt or vtt");
    const proj = readProject(), list = C.fromClips(proj.clips, proj.disabledTracks);
    if (!list.length) throw new Error("there are no captions on the timeline to export — make them first (fablecut_captions {})");
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    const base = String(proj.name || "captions").replace(/[^\w\- ]+/g, "_").trim().slice(0, 80) || "captions";
    let file = path.join(EXPORTS_DIR, `${base}.${args.export}`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(EXPORTS_DIR, `${base} ${n}.${args.export}`);
    fs.writeFileSync(file, args.export === "srt" ? C.toSRT(list) : C.toVTT(list));
    return `Wrote ${list.length} caption${list.length === 1 ? "" : "s"} to ${file} (${args.export === "srt" ? "SubRip" : "WebVTT"}, ${fmtClock(list[0].start)} → ${fmtClock(list[list.length - 1].end)}).`;
  }
  if (args.remove === true) {
    const proj = readProject(), caps = proj.clips.filter(C.isCaption);
    if (!caps.length) return "There are no captions on the timeline.";
    const locked = caps.filter((c) => ownLocks(proj, c));
    if (locked.length && args.force !== true) throw new Error(`${locked.length} caption(s) are locked — nothing removed (pass force:true only if the user asked)`);
    ProjectOps.applyPatch(proj, caps.map((c) => ({ op: "removeClip", id: c.id, ...(args.force === true ? { force: true } : {}) })), { savedItems });
    proj.revision = (proj.revision || 0) + 1;
    writeProject(proj);
    lastReadRevision = proj.revision;
    return `Removed ${caps.length} caption${caps.length === 1 ? "" : "s"} (revision ${proj.revision}). UI hot-reloaded.`;
  }
  let list, note = "", sig;
  const first = readProject();
  const m = C.metrics(st, first.width || 1920, first.height || 1080, { lines: args.lines, words: args.words, scale: args.size });
  if (args.import != null) {
    let text = String(args.import);
    const asFile = text.length < 1024 && !text.includes("-->");
    if (asFile) {
      const file = text.startsWith("/media/") ? path.join(MEDIA_DIR, decodeURIComponent(text.slice(7))) : path.resolve(text);
      if (!fs.existsSync(file)) throw new Error("no such subtitle file: " + text);
      text = fs.readFileSync(file, "utf8");
    }
    list = C.fit(C.parse(text), m.chars, m.lines);
    sig = timelineSig(first);
    note = `Read ${list.length} caption${list.length === 1 ? "" : "s"} from the ${/^WEBVTT/m.test(text) ? "WebVTT" : "SubRip"} file.\n`;
  } else {
    const r = await speechWords(args, false);
    const lo = Number.isFinite(args.from) ? args.from : -Infinity, hi = Number.isFinite(args.to) ? args.to : Infinity;
    const words = r.words.filter((w) => w.s >= lo && w.e <= hi);
    if (!words.length) throw new Error("no words to caption" + (r.without.length ? ` — no transcript for ${r.without.join(", ")}` : " in that stretch"));
    list = C.cues(words, { chars: m.chars, lines: m.lines, words: m.words, maxDur: m.maxDur, fps: r.doc.fps });
    sig = r.sig;
    note = r.note;
  }
  const proj = readProject(), readRev = proj.revision || 0;
  if (timelineSig(proj) !== sig)
    throw new Error("the timeline changed while transcribing (a clip was moved, trimmed or cut) — nothing added; run fablecut_captions again");
  const old = args.replace === false ? [] : proj.clips.filter(C.isCaption);
  const lockedOld = old.filter((c) => ownLocks(proj, c));
  if (lockedOld.length && args.force !== true) throw new Error(`${lockedOld.length} existing caption(s) are locked — nothing changed (pass replace:false to keep them, or force:true if the user asked)`);
  const from = list[0].start, to = list[list.length - 1].end;
  let lane = args.track ? { track: String(args.track), add: false } : C.trackFor(old.length ? proj : { ...proj, clips: proj.clips.filter((c) => !C.isCaption(c)) }, from, to);
  if (!/^V\d+$/.test(lane.track)) throw new Error("track must be a video lane such as V3");
  if (args.track && !(proj.tracks || C.DEFAULT_TRACKS).some((t) => t.id === lane.track)) lane.add = true;
  if (Array.isArray(proj.lockedTracks) && proj.lockedTracks.includes(lane.track) && args.force !== true) throw new Error(`${lane.track} is locked — pick another track, or unlock it`);
  if (lane.add) proj.tracks = [{ id: lane.track, kind: "video" }, ...(Array.isArray(proj.tracks) && proj.tracks.length ? proj.tracks : C.DEFAULT_TRACKS)];
  const ops = [
    ...old.map((c) => ({ op: "removeClip", id: c.id, ...(args.force === true ? { force: true } : {}) })),
    ...list.map((cue) => ({ op: "addClip", clip: C.clip(cue, { style: st, width: proj.width, height: proj.height, track: lane.track, scale: args.size }), ...(args.force === true ? { force: true } : {}) })),
  ];
  ProjectOps.applyPatch(proj, ops, { savedItems });
  proj.revision = readRev + 1;
  writeProject(proj);
  lastReadRevision = proj.revision;
  const sample = list.slice(0, 3).map((c) => `  [${fmtClock(c.start)}] ${c.text.replace(/\n/g, " / ")}`);
  return note + `Added ${list.length} caption${list.length === 1 ? "" : "s"} (${C.STYLES[st].label}, ${m.fontSize} px) on ${lane.track}${lane.add ? " (a new lane)" : ""}, ${fmtClock(from)} → ${fmtClock(to)}` +
    (old.length ? `, replacing ${old.length}` : "") + ` (revision ${proj.revision}). UI hot-reloaded.\n` + sample.join("\n") +
    (list.length > 3 ? `\n  … ${list.length - 3} more` : "") + "\nfablecut_frame {time} shows how one looks; export:\"srt\" writes a subtitle file.";
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
/** Saved delivery presets (library/delivery/), as the server lists them. */
function savedDeliveryPresets() { return Delivery.savedPresets(readSaved("delivery")); }
function describeExportJob(j) {
  const pct = Math.round((j.progress || 0) * 100);
  if (j.status === "done") {
    const file = path.join(EXPORTS_DIR, path.basename(decodeURIComponent(j.src || "")));
    let size = "";
    try { size = ` (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`; } catch {}
    const outs = j.result && Array.isArray(j.result.outputs) ? j.result.outputs : null;
    if (outs && outs.length > 1) {
      return `Export ${j.id} done — ${outs.filter((o) => o.ok).length} of ${outs.length} files:\n` + outs.map((o) => o.ok
        ? `✓ ${path.join(EXPORTS_DIR, o.file)}${o.summary ? ` — ${o.summary}` : ""}${o.report ? `\n    ${o.report.ok ? "checks passed" : "CHECK"}: ${o.report.line}` : ""}`
        : `✗ ${o.file}: ${o.error}`).join("\n");
    }
    const rep = outs && outs[0] && outs[0].report;
    return `Export ${j.id} done → ${file}${size}${j.result && j.result.summary ? `\n${j.result.summary}` : ""}` +
      `${rep ? `\n${rep.ok ? "Checks passed" : "CHECK"}: ${rep.line}` : ""}\nServed at ${BASE}${j.src}`;
  }
  if (j.status === "failed" || j.status === "cancelled") return `Export ${j.id} ${j.status}: ${j.error || "no reason given"}`;
  return `Export ${j.id} ${j.status}${j.status === "running" ? ` — ${pct}%` : ""} (in ${j.via === "headless" ? "a headless browser" : "the open editor tab"}). ` +
    `Check again with fablecut_export {job:"${j.id}"}, or stop it with {cancel:"${j.id}"}.`;
}
/* fablecut_proxy: the server makes proxies (proxy.js); this asks it, and waits. */
/* fablecut_projects: through the editor server, so it is the only process that
   switches ./project.json and its tabs hear about it at once. */
function describeProject(p) {
  const dur = p.duration == null ? "?" : `${Math.floor(p.duration / 60)}:${String(Math.round(p.duration % 60)).padStart(2, "0")}`;
  return `${p.id} "${p.name}"${p.active ? " (OPEN)" : ""}${p.archived ? " [archived]" : ""} — ` +
    (p.unreadable ? "project file unreadable" : `${p.width}x${p.height}@${p.fps} ${dur}, ${p.clips} clip(s), ${p.media} media`) +
    (p.modified ? `, modified ${p.modified.slice(0, 16).replace("T", " ")}` : "") +
    (p.tags?.length ? " " + p.tags.map((t) => "#" + t).join(" ") : "") +
    (p.notes ? `\n    notes: ${p.notes.length > 300 ? p.notes.slice(0, 300) + "…" : p.notes}` : "");
}
const describeTemplate = (t) => `${t.id} "${t.name}" ${t.width}x${t.height}@${t.fps}${t.builtin ? " (built-in)" : ` — ${t.clips} clip(s)`}`;
async function projectsTool(args) {
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  const action = args.action || "list";
  if (action === "list") {
    const r = await apiJSON("GET", "/api/projects?archived=" + encodeURIComponent(args.archived || "exclude"));
    if (r.status !== 200) throw new Error(r.body?.error || `projects request failed (${r.status})`);
    const { projects, templates } = r.body;
    return [`${projects.length} project(s):`, ...projects.map(describeProject),
      `Templates (action:"new", template): ${templates.map((t) => t.id).join(", ")}`].join("\n");
  }
  const r = await apiJSON("POST", "/api/projects", { ...args, action });
  if (r.status !== 200) throw new Error(r.body?.error || `projects request failed (${r.status})`);
  const out = r.body;
  if (action === "templates") return out.templates.map(describeTemplate).join("\n");
  if (action === "save_template") return `Saved template ${describeTemplate(out.template)}. Start a project from it: {action:"new", template:"${out.template.id}", name}.`;
  if (action === "delete_template") return `Deleted template ${out.template}.`;
  if (action === "delete") return `Deleted project ${out.id} (its media stay in media/).`;
  if (out.already) return `${describeProject(out.project)}\nAlready open.`;
  if (out.from) return `Opened ${describeProject(out.project)}\nThe editor switched to it (${out.from} was saved first). Read it with fablecut_get_project {compact:true} before editing.`;
  return describeProject(out.project);
}
/* fablecut_versions: through the editor server, like fablecut_projects. */
const KIND_LABEL = { manual: "", auto: " (auto)", agent: " (before agent edits)", restore: " (before a restore)" };
function describeVersion(e) {
  const when = e.created ? e.created.slice(0, 16).replace("T", " ") : "?";
  return `v${e.v}${e.final ? " FINAL" : ""} "${e.name}"${KIND_LABEL[e.kind] || ""} — ${when}, ${e.clips} clip(s), ` +
    `${Math.floor(Math.round(e.duration) / 60)}:${String(Math.round(e.duration) % 60).padStart(2, "0")}, revision ${e.revision}` +
    (e.note ? `\n    note: ${e.note.length > 300 ? e.note.slice(0, 300) + "…" : e.note}` : "");
}
async function versionsTool(args) {
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  const action = args.action || "list";
  const r = action === "list"
    ? await apiJSON("GET", "/api/versions" + (args.project ? "?project=" + encodeURIComponent(args.project) : ""))
    : await apiJSON("POST", "/api/versions", { ...args, action });
  if (r.status !== 200) throw new Error(r.body?.error || `versions request failed (${r.status})`);
  const out = r.body;
  if (action === "list") return out.versions.length
    ? [`${out.versions.length} version(s) of ${out.project}, newest first:`, ...out.versions.map(describeVersion)].join("\n")
    : `No versions of ${out.project} yet. {action:"save", name, note} keeps one.`;
  if (action === "save") return `Saved ${describeVersion(out.version)}`;
  if (action === "update") return describeVersion(out.version);
  if (action === "delete") return `Deleted v${out.deleted}.`;
  if (action === "restore") return `Restored v${out.restored.v} "${out.restored.name}". What was there is kept as v${out.saved.v} "${out.saved.name}" (restore it to undo). ` +
    (out.open === false
      ? `${out.project} is not the open project, so the editor didn't change; open it (fablecut_projects {action:"open", id:"${out.project}"}) before reading or editing it.`
      : `The editor reloaded; re-read the project (fablecut_get_project {compact:true}) before editing.`);
  if (action === "diff") return out.same
    ? `No difference between ${out.from === "current" ? "now" : "v" + String(out.from).replace(/^v/, "")} and ${out.to === "current" ? "now" : "v" + String(out.to).replace(/^v/, "")}.`
    : [`From v${String(out.from).replace(/^v/, "")} to ${out.to === "current" ? "now" : "v" + String(out.to).replace(/^v/, "")}:`, ...out.lines.map((l) => "- " + l)].join("\n");
  return JSON.stringify(out);
}
/* Before an agent changes the project: a version to go back to. Once per session start
   (or after 10 quiet minutes), and before every whole-document rewrite. */
let lastAgentVersion = 0;
/** "" when the version was kept (or wasn't due), else a warning for the tool's answer:
 *  a version is a safety net, so the edit itself goes ahead either way. */
function versionBeforeAgent(rewrite) {
  if (!rewrite && Date.now() - lastAgentVersion < 10 * 60_000) return "";
  try {
    const pj = createProjects({ dataDir: DATA_DIR, projectFile: PROJECT_FILE, libraryDir: LIBRARY_DIR });
    createHistory({ projects: pj }).beforeAgent(rewrite ? "Before an agent rewrote the project" : "Before agent edits");
    lastAgentVersion = Date.now();
    return "";
  } catch (e) {
    return ` Warning: no version was saved before this edit (${e.message}) — fablecut_versions {action:"save"} keeps one.`;
  }
}
async function proxyTool(args) {
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  const proj = readProject();
  const ids = Array.isArray(args.mediaIds) && args.mediaIds.length ? args.mediaIds : proj.media.filter((m) => m.kind === "video").map((m) => m.id);
  const list = ids.map((id) => {
    const m = proj.media.find((x) => x.id === id);
    if (!m) throw new Error(`no media ${id}`);
    if (m.kind !== "video") throw new Error(`${id} is ${m.kind === "audio" || m.kind === "image" ? "an" : "a"} ${m.kind} — only video gets a proxy`);
    return m;
  });
  if (!list.length) return "No video in the project.";
  const srcs = list.map((m) => m.src);
  if (args.delete) {
    const r = await apiJSON("POST", "/api/proxy/delete", { srcs });
    if (r.status !== 200) throw new Error(r.body?.error || "delete failed");
    return list.map((m) => `${m.id} "${m.name}": ${r.body.deleted[m.src] ? "proxy deleted" : "had no proxy"}`).join("\n");
  }
  let r = await apiJSON("POST", args.create ? "/api/proxy" : "/api/proxy/status", { srcs, height: args.height });
  if (r.status !== 200) throw new Error(r.body?.error || `proxy request failed (${r.status})`);
  let status = r.body.status;
  const busy = () => Object.values(status).some((s) => s && (s.state === "queued" || s.state === "running"));
  if (args.create && args.wait !== false) {
    const deadline = Date.now() + 1000 * (Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 900);
    while (busy() && Date.now() < deadline) {
      await sleep(1000);
      r = await apiJSON("POST", "/api/proxy/status", { srcs });
      if (r.status === 200) status = r.body.status;
    }
  }
  const line = (m) => {
    const s = status[m.src];
    if (!s) return `${m.id} "${m.name}": OFFLINE — the file is missing`;
    if (s.state === "ready") return `${m.id} "${m.name}": proxy ready — ${s.width ? s.width + "×" + s.height : s.height + "p"}, ${(s.size / 1048576).toFixed(1)} MB (${s.src})`;
    if (s.state === "running" || s.state === "queued") return `${m.id} "${m.name}": proxy ${s.state}${s.state === "running" ? ` ${Math.round(s.progress * 100)}%` : ""} (${s.height}p)`;
    if (s.state === "failed") return `${m.id} "${m.name}": proxy FAILED — ${s.error}`;
    return `${m.id} "${m.name}": no proxy${m.height ? ` (source ${m.width}×${m.height})` : ""}`;
  };
  return list.map(line).join("\n") + (busy() ? "\nStill working — call fablecut_proxy again (without create) to check." : "");
}
async function exportTool(args) {
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  let startNote = "";
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
    const r = await apiJSON("POST", "/api/export/request", { range: args.range, profile: args.profile, preset: args.preset, delivery: args.delivery, outputs: args.outputs, where: args.where || "auto" });
    if (r.status !== 200) throw new Error(r.body?.error || `export request failed (${r.status})`);
    job = r.body;
    if (job.notes && job.notes.length) startNote = `Settings adjusted: ${job.notes.join("; ")}\n`;
    if (args.wait === false) return (job.delivery ? `Output: ${job.delivery}\n` : "") + startNote + describeExportJob(job);
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
  return startNote + describeExportJob(job);
}

/* ── Frames (fablecut_frame) ──
   The tool is the only one that answers with an image, so it returns content
   blocks rather than a string. Text comes FIRST: it carries the coordinates of
   what is in the picture (src, timestamp, dimensions), which is the part an
   agent would otherwise have to guess at, and it keeps the existing
   content[0].text reading in the test harness valid. */

/** {mimeType, data:Buffer} → an MCP image content block. */
function imageBlock(mimeType, buf) {
  return { type: "image", data: buf.toString("base64"), mimeType };
}
/** A data: URL from the compositor → an image content block, or null. */
function imageBlockFromDataUrl(url) {
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(String(url || ""));
  return m ? { type: "image", data: m[2], mimeType: m[1] } : null;
}

/** Raw GET to the editor server → {status, headers, buffer}.
 *  Sends the MCP client header: /api/frame?path= only answers requests that
 *  carry it, so a web page in the user's browser can neither render frames of
 *  arbitrary files nor probe which ones exist. */
function apiBytes(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(API + urlPath, { method: "GET", headers: { "X-FableCut-Client": "mcp" } }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("the editor server did not answer")));
    req.end();
  });
}

async function frameTool(args) {
  /* Timeline mode: no path. The compositor lives in the browser, so this rides
     the same job queue the scopes reading uses, with image:true. Text mode
     needs no image at all here — the scopes reading already measures the frame,
     and those numbers describe the composed picture. */
  if (!args.path) {
    if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
    const body = { where: args.where || "auto", image: true };
    if (args.time != null) body.time = args.time;
    const r = await apiJSON("POST", "/api/scopes/request", body);
    if (r.status !== 200) throw new Error(r.body?.error || `frame request failed (${r.status})`);
    let job = r.body;
    const deadline = Date.now() + 1000 * (Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 60);
    while (job.status === "pending" || job.status === "running") {
      if (Date.now() > deadline) {
        await apiJSON("POST", "/api/export/job/cancel?id=" + encodeURIComponent(job.id));
        throw new Error("timed out waiting for the editor to render the frame");
      }
      await sleep(300);
      const q = await apiJSON("GET", "/api/export/job?id=" + encodeURIComponent(job.id));
      if (q.status !== 200) throw new Error(q.body?.error || "lost track of the frame render");
      job = q.body;
    }
    if (job.status !== "done") throw new Error(`frame render ${job.status}: ${job.error || "no reason given"}`);
    const res = job.result || {};
    const onScreen = (res.clips || []).map((c) => `${c.id} ${c.track} ${c.kind}`).join(", ") || "nothing";
    const head = `Timeline at ${res.time}s (${res.frame?.w}x${res.frame?.h}) — on screen: ${onScreen}`;

    /* Text mode: the scopes reading measured this exact frame already, and its
       numbers are the same family as the source-frame measurements — so a
       text-only agent gets the composed picture described, not nothing. */
    if (args.text) {
      const st = res.stats, st_ = st ? describeScopeLines(st) : null;
      return [{ type: "text", text: head + "\n" + (st_ || "The editor returned no measurements for this frame.") + "\n\n" + TEXT_ONLY_NOTE }];
    }
    const img = imageBlockFromDataUrl(res.image);
    if (!img) throw new Error("the editor rendered the frame but could not encode it as an image (a cross-origin source taints the canvas)");
    return [{ type: "text", text: head }, img];
  }

  /* Source mode: ffmpeg on the server. Looking must not have side effects, so
     the file is read where it is — an absolute path is passed through as
     `path`, and a /media/… or /library/… src is passed through as `src`. The
     server never copies anything into media/ on our behalf. */
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  const raw = String(args.path);
  const served = /^\/(media|library)\//i.test(raw);
  // A served src is resolved by the server against its own data dir, which may
  // be somewhere this process cannot see (FABLECUT_DATA_DIR) — so let it decide
  // and report the 404. A filesystem path we can check ourselves is checked.
  if (!served && (!fs.existsSync(raw) || !fs.statSync(raw).isFile()))
    throw new Error("File not found: " + raw);

  const q = new URLSearchParams(served ? { src: raw } : { path: path.resolve(raw) });
  if (args.frames != null) {
    q.set("frames", String(Math.round(Number(args.frames))));
    // No cols → the server picks the squarest layout (6 frames give 3×2).
    if (args.cols != null) q.set("cols", String(Math.round(Number(args.cols))));
    if (args.from != null) q.set("from", String(args.from));
    if (args.to != null) q.set("to", String(args.to));
    q.set("w", String(args.width || 320));
  } else {
    q.set("t", String(Number.isFinite(args.t) ? args.t : 0));
    q.set("w", String(args.width || 768));
  }
  if (args.quality != null) q.set("q", String(args.quality));

  /* text mode asks the server for measurements instead of the picture, in the
     one request — not the picture and then a second call for the numbers. */
  if (args.text) {
    q.set("text", "1");
    const j = await apiJSON("GET", "/api/frame?" + q.toString(), undefined, { "X-FableCut-Client": "mcp" });
    if (j.status !== 200) throw new Error(j.body?.error || `frame description failed (${j.status})`);
    const st = j.body.stats, b = j.body;
    const where = b.frames > 1
      ? `${b.frames} moments across ${b.source || raw}, left→right then top→bottom, at ${(b.times || []).join("s, ")}s.`
      : `Frame at ${(b.times || [])[0] ?? 0}s of ${b.source || raw}.`;
    const body = !st
      ? "The server returned no measurements for this frame (does it have a video track?)."
      : b.frames > 1 ? FrameStats.gridLines(st).join("\n") : FrameStats.frameLines("Frame", st).join("\n");
    return [{ type: "text", text: where + "\n" + body + "\n\n" + TEXT_ONLY_NOTE }];
  }

  const res = await apiBytes("/api/frame?" + q.toString());
  if (res.status !== 200) {
    let msg = `frame request failed (${res.status})`;
    try { msg = JSON.parse(res.body.toString("utf8")).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const times = (res.headers["x-fablecut-frame-times"] || "").split(",").filter(Boolean);
  const type = res.headers["content-type"] || "image/jpeg";
  const source = decodeURI(res.headers["x-fablecut-frame-source"] || "") || raw;
  const head = args.frames != null
    ? `Contact sheet — ${times.length} moments across ${source}, left→right then top→bottom, at ${times.join("s, ")}s.`
    : `Frame at ${times[0] ?? 0}s of ${source}.`;

  if (res.body.length < 4 || res.body[0] !== 0xff || res.body[1] !== 0xd8)
    throw new Error("the server did not return a JPEG");
  return [{ type: "text", text: head }, imageBlock(type, res.body)];
}

/* Appended to every text: true answer, because a measurement is not a caption:
   it says what the picture is made of, never what is in it. */
const { TEXT_ONLY_NOTE, describeScopeLines, describeScopes } = ProjectOps;

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

/* ── Tracking (fablecut_track): runs in the editor, which saves the result ── */
async function trackTool(args) {
  if (typeof args.clip !== "string") throw new Error("fablecut_track needs clip");
  const proj = readProject(), c = proj.clips.find((x) => x.id === args.clip);
  if (!c) throw new Error("no clip " + args.clip);
  if (c.kind !== "video") throw new Error(`${c.id} is a ${c.kind} clip — tracking follows a video clip's picture`);
  for (const k of ["region", "point"]) if (args[k] != null && (typeof args[k] !== "object" || !(k === "region" ? ["x", "y", "w", "h"] : ["x", "y"]).every((q) => Number.isFinite(args[k][q])))) throw new Error(`${k} needs numbers x, y${k === "region" ? ", w, h" : ""} (fractions of the picture)`);
  if (args.apply != null && (typeof args.apply !== "object" || (args.apply.mask == null && args.apply.clip == null))) throw new Error("apply must be {mask: index | name} or {clip: id}");
  if (!(await ensureUIServer())) throw new Error(`the editor server is not running and could not be started on port ${PORT}`);
  const track = {};
  for (const k of ["clip", "region", "point", "size", "at", "direction", "to", "scale", "rotation", "name", "apply", "force"]) if (args[k] != null) track[k] = args[k];
  const r = await apiJSON("POST", "/api/track/request", { where: args.where || "auto", track });
  if (r.status !== 200) throw new Error(r.body?.error || `track request failed (${r.status})`);
  let job = r.body;
  const deadline = Date.now() + 1000 * (Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 300);
  while (job.status === "pending" || job.status === "running") {
    if (Date.now() > deadline) {
      await apiJSON("POST", "/api/export/job/cancel?id=" + encodeURIComponent(job.id));
      throw new Error("timed out waiting for the editor to track — try a shorter range (to), or a larger timeout");
    }
    await sleep(500);
    const q = await apiJSON("GET", "/api/export/job?id=" + encodeURIComponent(job.id));
    if (q.status !== 200) throw new Error(q.body?.error || "lost track of the tracking job");
    job = q.body;
  }
  if (job.status !== "done") throw new Error(`tracking ${job.status}: ${job.error || "no reason given"}`);
  return ProjectOps.describeTrack(job.result || {});
}

/* ── Tool implementations ── */
async function callTool(name, args, attempt = 0) {
  switch (name) {
    case "fablecut_track":
      return trackTool(args);
    case "fablecut_export":
      return exportTool(args);
    case "fablecut_scopes":
      return scopesTool(args);
    case "fablecut_frame":
      return frameTool(args);
    case "fablecut_silence":
      return silenceTool(args);
    case "fablecut_beats":
      return beatsTool(args);
    case "fablecut_reframe":
      return reframeTool(args);
    case "fablecut_transcribe":
      return transcribeTool(args);
    case "fablecut_captions":
      return captionsTool(args);
    case "fablecut_denoise":
      return denoiseTool(args);
    case "fablecut_proxy":
      return proxyTool(args);
    case "fablecut_projects":
      return projectsTool(args);
    case "fablecut_versions":
      return versionsTool(args);
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
      if (proj.delivery) {
        try {
          const { spec } = Delivery.normalize(proj.delivery, { presets: savedDeliveryPresets() });
          encLine = `Export: project.delivery — ${spec.preset} · ${Delivery.describe(spec)} (fablecut_export uses it unless you pass profile or preset)`;
        } catch { }
      }
      if (Array.isArray(proj.outputs) && proj.outputs.length) {
        const on = proj.outputs.filter((o) => o.on !== false);
        encLine += `\nBatch outputs (fablecut_export {outputs:true}): ${on.length} of ${proj.outputs.length} checked — ` +
          on.map((o) => Delivery.projectFilename(o, proj)).join(", ");
      }
      return [
        `Editor server: ${up ? "RUNNING — open " + BASE + " in a browser to watch edits live" : "FAILED TO START (check node / port " + PORT + ")"}`,
        `Project: "${proj.name}" — ${proj.width}x${proj.height} @ ${proj.fps}fps, ${proj.clips.length} clip(s), ${dur.toFixed(2)}s, revision ${proj.revision}`,
        ...(SeqLib.entries(proj).length > 1 ? [`Sequences (${SeqLib.entries(proj).length}; the numbers above are the open one's): ${SeqLib.list(proj).map(SeqLib.describe).join(" · ")}`] : []),
        encLine,
        `Registered media: ${cap(proj.media.map((m) => `${m.id} (${m.kind}, ${m.name}${m.duration ? ", " + m.duration + "s" : ""})`), 25).join("; ") || "none"}`,
        ...(() => {
          const off = proj.media.filter((m) => /^\/(media|library)\//.test(m.src || "") && !mediaFile(m.src));
          return off.length ? [`OFFLINE media (file missing — find it and relinkMedia): ${cap(off.map((m) => `${m.id} ${m.src}`), 25).join("; ")}`] : [];
        })(),
        `Files in media/: ${cap(files, 25).join(", ") || "none"}`,
        `Library assets (./library): ${libSummary}`,
        ...(() => {
          try {
            const pj = createProjects({ dataDir: DATA_DIR, projectFile: PROJECT_FILE, libraryDir: LIBRARY_DIR });
            if (!pj.peekActive()) return [];
            const { projects: all } = pj.list();
            const nv = createHistory({ projects: pj }).list(pj.peekActive()).versions.length;
            return [`Projects: ${all.length} (fablecut_projects lists, opens and creates them; this one is ${pj.peekActive()}, with ${nv} saved version(s): fablecut_versions)`];
          } catch { return []; }
        })(),
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
      return ProjectOps.compactView(doc, {
        offline: (m) => /^\/(media|library)\//.test(m.src || "") && !mediaFile(m.src),
        proxy: (m) => { const f = mediaFile(m.src); const p = f && findProxies(PROXIES_DIR, f)[0]; return p ? p.height : null; },
      });
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
      const { notes, toSave } = ProjectOps.applyPatch(proj, ops, {
        savedItems,
        audioChannels: (m) => { const f = mediaFile(m.src); return f ? probeChannels(f) || 0 : null; },
        checkProfile: resolveProfile,
        deliveryPresets: savedDeliveryPresets(),
        mediaInfo: (src) => { const f = mediaFile(src); return f ? probeFile(f) : null; },
      });
      // a version of the project as it was, kept before the last check so the write follows that check at once
      const verWarn = versionBeforeAgent(false);
      // Someone else saved while the ops ran: writing now would drop their change.
      // Without a baseRevision the ops just re-apply on the newer document.
      const diskRev = readProject().revision || 0;   // a failed read stops it: never write over what we can't see
      if (diskRev !== readRev) {
        if (base == null && attempt < 3) return callTool(name, args, attempt + 1);
        throw conflict(diskRev);
      }
      proj.revision = readRev + 1;
      writeProject(proj);
      lastReadRevision = proj.revision;
      for (const [kind, item] of toSave) writeSaved(kind, item.id, item);
      return `Patched (revision ${proj.revision}): ${notes.join(" ")}. Now ${proj.clips.length} clip(s), ${proj.media.length} media. UI hot-reloaded.${verWarn}`;
    }
    case "fablecut_set_project": {
      const doc = args.project;
      if (!doc || typeof doc !== "object") throw new Error("`project` must be an object");
      if (!Array.isArray(doc.clips) || !Array.isArray(doc.media))
        throw new Error("project must contain `clips` and `media` arrays");
      ProjectOps.checkProject(doc);
      const verWarn = versionBeforeAgent(true);   // before the conflict check, so the write follows it at once
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
      return `Saved (revision ${doc.revision}). ${doc.clips.length} clip(s). The editor UI (if open at ${BASE}) has hot-reloaded.${verWarn}`;
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
      Object.assign(entry, infoForEntry(await probeFile(target), entry));
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
      if (args.preset) {
        const saved = savedDeliveryPresets();
        const id = String(args.preset);
        if (!Delivery.PRESETS[id] && !saved[id]) throw new Error(`no delivery preset "${id}" — built-in: ${Delivery.PRESET_IDS.join(", ")}${Object.keys(saved).length ? "; saved: " + Object.keys(saved).join(", ") : ""}`);
        const { spec } = Delivery.normalize(id, { presets: saved });
        const p = Delivery.PRESETS[id] || saved[id];
        return JSON.stringify({ preset: id, label: p.label, note: p.note || "", summary: Delivery.describe(spec), spec }, null, 2);
      }
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
      const saved = savedDeliveryPresets();
      let encoders = null;
      try { const r = await apiJSON("GET", "/api/export/presets"); if (r.status === 200) encoders = r.body.encoders; } catch {}
      const presets = {};
      for (const id of [...Delivery.PRESET_IDS, ...Object.keys(saved)]) {
        const p = Delivery.PRESETS[id] || saved[id];
        presets[id] = { label: p.label, ...(saved[id] ? { saved: true } : {}), summary: Delivery.describe(Delivery.normalize(id, { presets: saved }).spec) };
      }
      // the encoding-profile fields stay at the top level, as they always were
      return JSON.stringify({
        ...listProfilesPublic(!!args.detail),
        deliveryPresets: presets,
        encoders: encoders || "(start the editor server to list them)",
      }, null, 2);
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
          serverInfo: { name: "fablecut", version: "1.17.0" },
        },
      });
    }
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      pending++;
      try {
        const out = await callTool(params.name, params.arguments || {});
        /* A tool may answer with ready-made content blocks (fablecut_frame
           returns an image); everything else answers with a string. */
        const content = Array.isArray(out) ? out : [{ type: "text", text: String(out) }];
        send({ jsonrpc: "2.0", id, result: { content } });
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
