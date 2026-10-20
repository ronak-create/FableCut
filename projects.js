/* ═══════════════════════════════════════════════════════════════════════════
   Projects: several projects in one data folder.

   ./project.json stays THE open project — the editor, the MCP server, agents
   and scripts all keep reading and writing that one file. Every project also
   has its own folder:

     projects/index.json          {active: "<id>"}
     projects/<id>/meta.json      {id, created, opened, archived, notes, tags}
     projects/<id>/project.json   the document (stale while that project is open:
                                  the live copy is ./project.json)
     projects/<id>/thumb.jpg      the editor's last picture of it
     library/project-templates/<id>.json   saved templates {name, created, project}

   Opening another project parks ./project.json in the open project's folder,
   then copies the chosen one over it with a revision above both, so a save
   from an editor tab or agent that read the old project is refused (409 /
   CONFLICT) instead of landing on the new one. media/, exports/ and analysis/
   are shared, so a duplicate or a template copies no footage.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/* Canvas presets offered next to the user's saved templates. */
const BUILTIN_TEMPLATES = [
  { id: "landscape-1080", name: "Landscape 16:9 · 1080p", width: 1920, height: 1080, fps: 30 },
  { id: "vertical-1080", name: "Vertical 9:16 · Reels, Shorts, TikTok", width: 1080, height: 1920, fps: 30 },
  { id: "square-1080", name: "Square 1:1", width: 1080, height: 1080, fps: 30 },
  { id: "portrait-1350", name: "Portrait 4:5 · feed post", width: 1080, height: 1350, fps: 30 },
  { id: "uhd-4k", name: "4K UHD 16:9", width: 3840, height: 2160, fps: 30 },
  { id: "landscape-720", name: "Landscape 16:9 · 720p", width: 1280, height: 720, fps: 30 },
];
const FPS_CHOICES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const MAX_NOTES = 4000, MAX_TAGS = 12, MAX_NAME = 120;

const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // unique tmp: the editor and the MCP server may write at once
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const newId = () => "p_" + crypto.randomBytes(5).toString("hex");
const validId = (id) => typeof id === "string" && /^p_[a-z0-9]{4,24}$/.test(id);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_NAME);
function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(",");
  const out = [];
  for (const t of list) {
    const s = String(t ?? "").trim().replace(/^#+/, "").trim().slice(0, 32);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, MAX_TAGS);
}
const timelineEnd = (doc) => (Array.isArray(doc.clips) ? doc.clips : [])
  .reduce((m, c) => Math.max(m, (+c.start || 0) + (+c.duration || 0)), 0);
const blankProject = (name, t) => ({
  name, width: t.width, height: t.height, fps: t.fps, revision: 0, media: [], clips: [],
});

function createProjects({ dataDir, projectFile, libraryDir }) {
  const DIR = path.join(dataDir, "projects");
  const INDEX = path.join(DIR, "index.json");
  const TEMPLATES = path.join(libraryDir, "project-templates");
  const folder = (id) => path.join(DIR, id);
  const metaFile = (id) => path.join(folder(id), "meta.json");
  const docFile = (id) => path.join(folder(id), "project.json");
  const thumbFile = (id) => path.join(folder(id), "thumb.jpg");

  const readRoot = () => {
    try { return readJSON(projectFile); }
    catch (e) { throw new Error(`project.json can't be read (${e.message}) — fix or replace it before switching projects`); }
  };
  const readMeta = (id) => { try { return readJSON(metaFile(id)); } catch { return null; } };
  const writeMeta = (id, meta) => writeJSON(metaFile(id), meta);
  const exists = (id) => validId(id) && fs.existsSync(metaFile(id));

  /* The open project's id. The first call gives the existing ./project.json
     a folder of its own, so a data folder from before projects just works. */
  function activeId() {
    let id = null;
    try { id = readJSON(INDEX).active; } catch { }
    if (exists(id)) return id;
    id = newId();
    let created = new Date().toISOString();
    try { created = fs.statSync(projectFile).mtime.toISOString(); } catch { }
    writeMeta(id, { id, created, opened: new Date().toISOString(), archived: false, notes: "", tags: [] });
    writeJSON(INDEX, { active: id });
    return id;
  }
  /* The open project's id without creating anything (null before the first dashboard use). */
  function peekActive() {
    try { const id = readJSON(INDEX).active; return exists(id) ? id : null; } catch { return null; }
  }
  const mustExist = (id) => {
    if (!exists(id)) throw new Error(`no project ${JSON.stringify(id)} (fablecut_projects {action:"list"} lists them)`);
  };
  /* The document of a project: ./project.json for the open one. */
  const readDoc = (id) => (id === activeId() ? readRoot() : readJSON(docFile(id)));
  const writeDoc = (id, doc) => {
    if (id !== activeId()) { writeJSON(docFile(id), doc); return; }
    // the open project: bump the revision like any other save, so tabs reload
    const cur = readRoot();
    writeJSON(projectFile, { ...doc, revision: Math.max(cur.revision || 0, doc.revision || 0) + 1 });
  };

  function summary(id, active) {
    const meta = readMeta(id) || { id };
    let doc = null, modified = null;
    const file = id === active ? projectFile : docFile(id);
    try { doc = readJSON(file); modified = fs.statSync(file).mtime.toISOString(); } catch { }
    let thumb = null;
    try { thumb = Math.round(fs.statSync(thumbFile(id)).mtimeMs); } catch { }
    return {
      id, name: doc?.name || "Untitled Project", active: id === active,
      archived: !!meta.archived, notes: meta.notes || "", tags: meta.tags || [],
      created: meta.created || null, opened: meta.opened || null, modified,
      width: doc?.width ?? null, height: doc?.height ?? null, fps: doc?.fps ?? null,
      duration: doc ? +timelineEnd(doc).toFixed(2) : null,
      clips: doc?.clips?.length ?? 0, media: doc?.media?.length ?? 0,
      thumb, unreadable: !doc,
    };
  }

  function list({ archived = "exclude" } = {}) {
    const active = activeId();
    let ids = [];
    try { ids = fs.readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && exists(e.name)).map((e) => e.name); } catch { }
    let projects = ids.map((id) => summary(id, active));
    if (archived === "exclude") projects = projects.filter((p) => !p.archived || p.active);
    else if (archived === "only") projects = projects.filter((p) => p.archived);
    projects.sort((a, b) => String(b.opened || b.modified || "").localeCompare(String(a.opened || a.modified || "")));
    return { active, projects };
  }

  /* Park the open project in its folder, then put `id` in ./project.json. */
  function open(id) {
    mustExist(id);
    const cur = activeId();
    if (id === cur) return { id, already: true, project: summary(id, cur) };
    const root = readRoot();
    let next;
    try { next = readJSON(docFile(id)); }
    catch (e) { throw new Error(`project ${id} can't be read (${e.message})`); }
    writeJSON(docFile(cur), root);
    next.revision = Math.max(root.revision || 0, next.revision || 0) + 1;
    try {
      writeJSON(projectFile, next);
      writeJSON(INDEX, { active: id });
    } catch (e) {
      // ./project.json and index.json must agree: put the open project back
      try { writeJSON(projectFile, { ...root, revision: next.revision + 1 }); } catch { }
      throw new Error(`switching to ${id} failed (${e.message}) — ${cur} is still open`);
    }
    const meta = readMeta(id) || { id };
    writeMeta(id, { ...meta, opened: new Date().toISOString(), archived: false });
    return { id, from: cur, project: summary(id, id) };
  }

  function add(doc, { name, notes, tags, template } = {}) {
    const id = newId();
    const now = new Date().toISOString();
    const out = { ...doc, name: cleanName(name) || doc.name || "Untitled Project", revision: 0 };
    writeJSON(docFile(id), out);
    const meta = { id, created: now, opened: null, archived: false, notes: String(notes || "").slice(0, MAX_NOTES), tags: cleanTags(tags) };
    if (template) meta.template = template;
    writeMeta(id, meta);
    return id;
  }

  function findTemplate(tid) {
    const b = BUILTIN_TEMPLATES.find((t) => t.id === tid);
    if (b) return { builtin: true, ...b };
    const s = templates().find((t) => t.id === tid);
    if (!s) throw new Error(`no project template ${JSON.stringify(tid)} (built-in: ${BUILTIN_TEMPLATES.map((t) => t.id).join(", ")}${templates().some((t) => !t.builtin) ? "; saved: " + templates().filter((t) => !t.builtin).map((t) => t.id).join(", ") : ""})`);
    return s;
  }

  /* A new project from a template (default: 1080p landscape), optionally opened. */
  function create({ name, template = "landscape-1080", fps, width, height, notes, tags, open: andOpen = true } = {}) {
    const t = findTemplate(template);
    let doc;
    if (t.builtin) doc = blankProject("", t);
    else doc = structuredClone(readJSON(path.join(TEMPLATES, t.id + ".json")).project);
    if (fps != null) {
      if (!(Number(fps) > 0 && Number(fps) <= 120)) throw new Error("fps must be a frame rate between 1 and 120");
      doc.fps = Number(fps);
    }
    for (const [k, v] of [["width", width], ["height", height]]) {
      if (v == null) continue;
      if (!Number.isInteger(v) || v < 16 || v > 8192 || v % 2) throw new Error(`${k} must be an even number of pixels, 16…8192`);
      doc[k] = v;
    }
    const id = add(doc, { name: cleanName(name) || "Untitled Project", notes, tags, template: t.id });
    return andOpen ? open(id) : { id, project: summary(id, activeId()) };
  }

  function duplicate(id, { name, open: andOpen = false } = {}) {
    mustExist(id);
    const src = readDoc(id);
    const meta = readMeta(id) || {};
    const nid = add(structuredClone(src), { name: cleanName(name) || `${src.name || "Untitled Project"} copy`, notes: meta.notes, tags: meta.tags });
    try { fs.copyFileSync(thumbFile(id), thumbFile(nid)); } catch { }
    return andOpen ? open(nid) : { id: nid, project: summary(nid, activeId()) };
  }

  /* Rename / notes / tags. */
  function update(id, { name, notes, tags } = {}) {
    mustExist(id);
    if (name != null) {
      const n = cleanName(name);
      if (!n) throw new Error("name can't be empty");
      const doc = readDoc(id);
      if (doc.name !== n) writeDoc(id, { ...doc, name: n });
    }
    if (notes != null || tags != null) {
      const meta = readMeta(id) || { id };
      if (notes != null) meta.notes = String(notes).slice(0, MAX_NOTES);
      if (tags != null) meta.tags = cleanTags(tags);
      writeMeta(id, meta);
    }
    return { id, project: summary(id, activeId()) };
  }

  function archive(id, on = true) {
    mustExist(id);
    if (on && id === activeId()) throw new Error("the open project can't be archived — open another project first");
    writeMeta(id, { ...(readMeta(id) || { id }), archived: !!on });
    return { id, project: summary(id, activeId()) };
  }

  /* Deleting is for archived projects only, so it always takes two steps. */
  function remove(id) {
    mustExist(id);
    if (id === activeId()) throw new Error("the open project can't be deleted");
    if (!readMeta(id)?.archived) throw new Error("archive the project first — only archived projects can be deleted");
    fs.rmSync(folder(id), { recursive: true, force: true });
    return { id, deleted: true };
  }

  /* A project file from elsewhere (an old backup, another machine). */
  function importDoc(doc, { name, open: andOpen = false } = {}) {
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.clips) || !Array.isArray(doc.media))
      throw new Error("not a FableCut project (it needs clips and media arrays)");
    const id = add(structuredClone(doc), { name: cleanName(name) || doc.name });
    return andOpen ? open(id) : { id, project: summary(id, activeId()) };
  }

  function templates() {
    const out = BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true, clips: 0 }));
    let files = [];
    try { files = fs.readdirSync(TEMPLATES).filter((f) => f.toLowerCase().endsWith(".json")).sort(); } catch { }
    for (const f of files) {
      try {
        const t = readJSON(path.join(TEMPLATES, f));
        const p = t.project || {};
        out.push({ id: f.slice(0, -5), name: t.name || f.slice(0, -5), builtin: false, created: t.created || null,
          width: p.width, height: p.height, fps: p.fps, clips: (p.clips || []).length, duration: +timelineEnd(p).toFixed(2) });
      } catch { }
    }
    return out;
  }

  /* Save a project — its canvas, tracks, clips and media references — as a template. */
  function saveTemplate(id, { name } = {}) {
    mustExist(id);
    const doc = structuredClone(readDoc(id));
    const label = cleanName(name) || doc.name || "Template";
    const tid = slug(label);
    if (!tid) throw new Error("name the template (letters or digits)");
    if (BUILTIN_TEMPLATES.some((t) => t.id === tid)) throw new Error(`"${label}" is a built-in template — pick another name`);
    delete doc.revision;
    writeJSON(path.join(TEMPLATES, tid + ".json"), { name: label, created: new Date().toISOString(), project: doc });
    return { template: templates().find((t) => t.id === tid) };
  }

  function deleteTemplate(tid) {
    if (BUILTIN_TEMPLATES.some((t) => t.id === tid)) throw new Error("built-in templates can't be deleted");
    const file = path.join(TEMPLATES, slug(tid) + ".json");
    if (!slug(tid) || !fs.existsSync(file)) throw new Error(`no saved template ${JSON.stringify(tid)}`);
    fs.unlinkSync(file);
    return { template: tid, deleted: true };
  }

  function setThumb(id, buf) {
    mustExist(id);
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("thumbnail must be a JPEG");
    if (buf.length > 1024 * 1024) throw new Error("thumbnail too large (1 MB max)");
    const tmp = `${thumbFile(id)}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, thumbFile(id));
    return { id, ok: true };
  }
  const thumbPath = (id) => (exists(id) && fs.existsSync(thumbFile(id)) ? thumbFile(id) : null);

  /* One entry point for the REST API and the MCP tool. */
  function act(a = {}) {
    switch (a.action) {
      case "list": return { ...list({ archived: a.archived }), templates: templates() };
      case "open": return open(a.id);
      case "new": return create(a);
      case "duplicate": return duplicate(a.id, a);
      case "update": case "rename": return update(a.id, a);
      case "archive": return archive(a.id, true);
      case "unarchive": return archive(a.id, false);
      case "delete": return remove(a.id);
      case "import": return importDoc(a.project, a);
      case "templates": return { templates: templates() };
      case "save_template": return saveTemplate(a.id, a);
      case "delete_template": return deleteTemplate(a.template);
      default:
        throw new Error(`unknown action ${JSON.stringify(a.action)} (list|open|new|duplicate|update|archive|unarchive|delete|import|templates|save_template|delete_template)`);
    }
  }

  return { DIR, INDEX, TEMPLATES, activeId, peekActive, mustExist, readRoot, readDoc, writeDoc, list, open, create, duplicate, update, archive, remove, importDoc,
    templates, saveTemplate, deleteTemplate, setThumb, thumbPath, act };
}

module.exports = { createProjects, BUILTIN_TEMPLATES, FPS_CHOICES };
