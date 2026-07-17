/* ═══════════════════════════════════════════════════════════════════════════
   FableCut MCP server — connects Claude (Code / Desktop) to the video editor.
   Zero-dependency stdio JSON-RPC (Model Context Protocol).

   Register once for all Claude Code sessions:
     claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"

   Tools: fablecut_status, fablecut_docs, fablecut_get_project,
          fablecut_set_project, fablecut_patch_project, fablecut_import_media,
          fablecut_analyze_reference
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const PROJECT_FILE = path.join(ROOT, "project.json");
const MEDIA_DIR = path.join(ROOT, "media");
const PORT = process.env.FABLECUT_PORT || 7777;
const BASE = `http://localhost:${PORT}`;

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
    description: "Apply targeted edits to the FableCut project WITHOUT round-tripping the whole document — PREFER THIS over get+set for every edit (it is ~10-100x cheaper in tokens and merge-safe by design: it re-reads the latest document from disk, applies your ops in order, bumps revision once, saves atomically). Ops: {op:'addClip', clip:{…}} (id auto-generated if omitted) · {op:'updateClip', id, set:{…}} · {op:'removeClip', id} · {op:'addMedia', media:{…}} · {op:'removeMedia', id} · {op:'setProject', set:{name|width|height|fps|background|markers|disabledTracks}}. updateClip merge rules: top-level keys are replaced (keyframes/transitionIn/transitionOut wholesale), `props` merges key-by-key, and setting any key to null deletes it. All-or-nothing: an invalid op aborts the whole patch unsaved.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: { type: "object" },
          description: "Edit operations, applied in order (see tool description for shapes)",
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
    description: "Copy a local media file (video/audio/image) into FableCut's media library and register it in the project. Returns the created media entry (use its id in clips).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to the source file on disk" } },
      required: ["path"],
    },
  },
];

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
        const dir = path.join(ROOT, "library", d);
        const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
        return `${d}: ${n}`;
      }).join(", ");
      const cap = (arr, n) => arr.length > n ? arr.slice(0, n).concat(`… +${arr.length - n} more`) : arr;
      return [
        `Editor server: ${up ? "RUNNING — open " + BASE + " in a browser to watch edits live" : "FAILED TO START (check node / port " + PORT + ")"}`,
        `Project: "${proj.name}" — ${proj.width}x${proj.height} @ ${proj.fps}fps, ${proj.clips.length} clip(s), ${dur.toFixed(2)}s, revision ${proj.revision}`,
        `Registered media: ${cap(proj.media.map((m) => `${m.id} (${m.kind}, ${m.name}${m.duration ? ", " + m.duration + "s" : ""})`), 25).join("; ") || "none"}`,
        `Files in media/: ${cap(files, 25).join(", ") || "none"}`,
        `Library assets (./library): ${libSummary}`,
        `Project file: ${PROJECT_FILE}`,
        `Tips: fablecut_docs (use \`section\`) for the schema · fablecut_get_project {compact:true} to see the timeline · fablecut_patch_project for edits (cheapest).`,
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
        x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1, speed: 1,
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
          if (hex(DEFAULTS[k]) !== hex(v)) kept[k] = v;
        }
        return Object.keys(kept).length ? " " + JSON.stringify(kept) : "";
      };
      const lines = [
        `"${doc.name}" ${doc.width}x${doc.height}@${doc.fps} rev:${doc.revision}` +
        (doc.background ? ` bg:${doc.background}` : "") +
        (doc.markers?.length ? ` markers:${doc.markers.length} [${doc.markers.slice(0, 12).map((m) => m.t).join(",")}${doc.markers.length > 12 ? ",…" : ""}]` : ""),
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
              (c.name ? ` "${c.name}"` : "") + fmtProps(c.props, c.kind) + kf + tr;
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
            if (c.kind !== "text" && c.kind !== "adjust" && !proj.media.some((m) => m.id === c.mediaId))
              throw new Error(`addClip: unknown mediaId ${c.mediaId}`);
            proj.clips.push(c);
            notes.push("+" + c.id);
            break;
          }
          case "updateClip": {
            const c = proj.clips.find((x) => x.id === op.id);
            if (!c) throw new Error("updateClip: no clip " + op.id);
            mergeInto(c, op.set);
            notes.push("~" + op.id);
            break;
          }
          case "removeClip": {
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
          case "setProject": {
            const allowed = ["name", "width", "height", "fps", "background", "markers", "disabledTracks"];
            for (const [k, v] of Object.entries(op.set || {})) {
              if (!allowed.includes(k)) throw new Error(`setProject: '${k}' not settable (allowed: ${allowed.join(", ")})`);
              if (v === null) delete proj[k]; else proj[k] = v;
            }
            notes.push("~project");
            break;
          }
          default:
            throw new Error("Unknown op: " + op.op + " (addClip|updateClip|removeClip|addMedia|removeMedia|setProject)");
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
      writeProject(doc);
      lastReadRevision = doc.revision;
      return `Saved (revision ${doc.revision}). ${doc.clips.length} clip(s). The editor UI (if open at ${BASE}) has hot-reloaded.`;
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
      const dir = path.join(ROOT, "analysis");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, path.basename(file, path.extname(file)) + ".json"),
        JSON.stringify(bp, null, 2));
      return JSON.stringify(bp, null, 2) + "\n\n" + [
        musicNote,
        `REMAKE RECIPE: 1) set project width/height/fps to ${bp.width}x${bp.height} @ ${bp.fps} — 2) write beats[] into project markers — 3) extracted music on A1 — 4) one clip per shots[] entry at the same start/duration on V1 (hard cuts; footage energy should track each shot's energy value) — 5) biggest moment on drop (${bp.drop}s)${bp.bpm ? ` — tempo ${bp.bpm} BPM` : ""}. Full recipe: fablecut_docs → "Remake a reference video".`,
      ].join("\n");
    }
    case "fablecut_import_media": {
      const src = args.path;
      if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile())
        throw new Error("File not found: " + src);
      const ext = path.extname(src).toLowerCase();
      const kind = KIND_BY_EXT[ext];
      if (!kind) throw new Error(`Unsupported extension ${ext}`);
      if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
      let base = path.basename(src).replace(/[^\w.\- ()\[\]]+/g, "_");
      let target = path.join(MEDIA_DIR, base);
      let i = 1;
      const stem = path.basename(base, ext);
      while (fs.existsSync(target)) target = path.join(MEDIA_DIR, `${stem}_${i++}${ext}`);
      fs.copyFileSync(src, target);
      const entry = {
        id: "m_" + uid(),
        name: path.basename(target),
        kind,
        src: "/media/" + encodeURIComponent(path.basename(target)),
        duration: kind === "image" ? undefined : ffprobeDuration(target),
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
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fablecut", version: "1.6.0" },
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
