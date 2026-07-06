/* ═══════════════════════════════════════════════════════════════════════════
   FableCut MCP server — connects Claude (Code / Desktop) to the video editor.
   Zero-dependency stdio JSON-RPC (Model Context Protocol).

   Register once for all Claude Code sessions:
     claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"

   Tools: fablecut_status, fablecut_docs, fablecut_get_project,
          fablecut_set_project, fablecut_import_media
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
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(doc, null, 2));
}
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
    description: "Return the FableCut project schema documentation: clips, tracks, props, keyframe animation, transitions, and editing recipes. Read this before calling fablecut_set_project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fablecut_get_project",
    description: "Get the full FableCut project JSON (the timeline document).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fablecut_set_project",
    description: "Replace the FableCut project JSON. Pass the COMPLETE document (read with fablecut_get_project, modify, send back whole). Revision is auto-bumped; the open editor UI hot-reloads instantly so the user sees the edit live.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "object", description: "The complete project document (see fablecut_docs for schema)" } },
      required: ["project"],
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
      return [
        `Editor server: ${up ? "RUNNING — open " + BASE + " in a browser to watch edits live" : "FAILED TO START (check node / port " + PORT + ")"}`,
        `Project: "${proj.name}" — ${proj.width}x${proj.height} @ ${proj.fps}fps, ${proj.clips.length} clip(s), ${dur.toFixed(2)}s, revision ${proj.revision}`,
        `Registered media: ${proj.media.map((m) => `${m.id} (${m.kind}, ${m.name}${m.duration ? ", " + m.duration + "s" : ""})`).join("; ") || "none"}`,
        `Files in media/: ${files.join(", ") || "none"}`,
        `Library assets (./library): ${libSummary}`,
        `Project file: ${PROJECT_FILE}`,
        `Tip: call fablecut_docs for the timeline schema before editing.`,
      ].join("\n");
    }
    case "fablecut_docs":
      return fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
    case "fablecut_get_project":
      return JSON.stringify(readProject(), null, 2);
    case "fablecut_set_project": {
      const doc = args.project;
      if (!doc || typeof doc !== "object") throw new Error("`project` must be an object");
      if (!Array.isArray(doc.clips) || !Array.isArray(doc.media))
        throw new Error("project must contain `clips` and `media` arrays");
      for (const c of doc.clips) {
        if (!c.id || !c.track || typeof c.start !== "number" || typeof c.duration !== "number")
          throw new Error(`clip ${c.id || "?"} needs id, track, numeric start and duration`);
        if (c.kind !== "text" && !doc.media.some((m) => m.id === c.mediaId))
          throw new Error(`clip ${c.id} references unknown mediaId ${c.mediaId}`);
      }
      let cur = { revision: 0 };
      try { cur = readProject(); } catch {}
      doc.revision = Math.max((cur.revision || 0) + 1, (doc.revision || 0));
      writeProject(doc);
      return `Saved (revision ${doc.revision}). ${doc.clips.length} clip(s). The editor UI (if open at ${BASE}) has hot-reloaded.`;
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
      proj.media.push(entry);
      proj.revision = (proj.revision || 0) + 1;
      writeProject(proj);
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
          serverInfo: { name: "fablecut", version: "1.1.0" },
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
