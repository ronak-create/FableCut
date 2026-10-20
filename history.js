/* ═══════════════════════════════════════════════════════════════════════════
   Versions: a project's history, kept beside it, never destructive.

     projects/<id>/history/v0007.json        the document as it was
     projects/<id>/history/v0007.meta.json   {v, name, note, kind, created,
                                              revision, clips, duration, final}

   One pair of files per version, created with an exclusive open, so the
   editor server and an MCP server can both save versions without a shared
   index to race on. Kinds: manual (the user or an agent), auto (every few
   minutes while the project changes), agent (before an agent rewrites or
   starts editing it), restore (what was there before a restore).

   Restoring a version first saves the current document as a version, then
   writes the old one back with a new revision: nothing is ever lost.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KINDS = ["manual", "auto", "agent", "restore"];
const MAX_NAME = 120, MAX_NOTE = 2000;
const pad = (n) => String(n).padStart(4, "0");
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
function writeJSON(file, obj) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const timelineEnd = (doc) => (Array.isArray(doc.clips) ? doc.clips : [])
  .reduce((m, c) => Math.max(m, (+c.start || 0) + (+c.duration || 0)), 0);
const fmtDur = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

/* What changed from document a (older) to b (newer), for people and agents. */
function diffDocs(a, b) {
  const byId = (arr) => new Map((Array.isArray(arr) ? arr : []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const label = (c) => `${c.name ? `"${c.name}"` : c.kind || "clip"} (${c.id})`;
  const ca = byId(a.clips), cb = byId(b.clips);
  const added = [...cb.values()].filter((c) => !ca.has(c.id));
  const removed = [...ca.values()].filter((c) => !cb.has(c.id));
  const changed = [];
  for (const [id, cn] of cb) {
    const co = ca.get(id);
    if (!co || JSON.stringify(co) === JSON.stringify(cn)) continue;
    const what = [];
    if (co.track !== cn.track) what.push(`track ${co.track}→${cn.track}`);
    if (co.start !== cn.start || co.duration !== cn.duration || co.in !== cn.in) what.push("timing");
    if (JSON.stringify(co.props || {}) !== JSON.stringify(cn.props || {})) {
      const keys = new Set([...Object.keys(co.props || {}), ...Object.keys(cn.props || {})]);
      const ks = [...keys].filter((k) => JSON.stringify((co.props || {})[k]) !== JSON.stringify((cn.props || {})[k]));
      what.push(ks.length > 4 ? `${ks.length} props` : ks.join(", "));
    }
    if (JSON.stringify(co.keyframes || {}) !== JSON.stringify(cn.keyframes || {})) what.push("keyframes");
    if (JSON.stringify(co.fx || []) !== JSON.stringify(cn.fx || [])) what.push("effects");
    if (JSON.stringify([co.transitionIn, co.transitionOut]) !== JSON.stringify([cn.transitionIn, cn.transitionOut])) what.push("transitions");
    if (co.mediaId !== cn.mediaId) what.push("source");
    if (!what.length) what.push("other fields");
    changed.push({ id, name: cn.name || null, kind: cn.kind, what });
  }
  const ma = byId(a.media), mb = byId(b.media);
  const mediaAdded = [...mb.values()].filter((m) => !ma.has(m.id)), mediaRemoved = [...ma.values()].filter((m) => !mb.has(m.id));
  const settings = [];
  for (const k of ["name", "width", "height", "fps", "background", "inPoint", "outPoint"])
    if ((a[k] ?? null) !== (b[k] ?? null)) settings.push(`${k} ${JSON.stringify(a[k] ?? null)}→${JSON.stringify(b[k] ?? null)}`);
  for (const k of ["tracks", "markers", "comps", "master", "buses", "delivery", "outputs", "exportFrame", "collections", "folders"])
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) settings.push(k);
  const lenA = timelineEnd(a), lenB = timelineEnd(b);
  const lines = [];
  if (added.length) lines.push(`${added.length} clip(s) added: ${added.slice(0, 8).map(label).join(", ")}${added.length > 8 ? ", …" : ""}`);
  if (removed.length) lines.push(`${removed.length} clip(s) removed: ${removed.slice(0, 8).map(label).join(", ")}${removed.length > 8 ? ", …" : ""}`);
  if (changed.length) lines.push(`${changed.length} clip(s) changed: ${changed.slice(0, 8).map((c) => `${label(c)} ${c.what.join("/")}`).join("; ")}${changed.length > 8 ? "; …" : ""}`);
  if (mediaAdded.length || mediaRemoved.length) lines.push(`media ${mediaAdded.length ? "+" + mediaAdded.length : ""}${mediaAdded.length && mediaRemoved.length ? " " : ""}${mediaRemoved.length ? "−" + mediaRemoved.length : ""}`);
  if (Math.abs(lenA - lenB) > 0.005) lines.push(`length ${fmtDur(lenA)} → ${fmtDur(lenB)}`);
  if (settings.length) lines.push(`project: ${settings.join(", ")}`);
  return {
    same: !lines.length, lines,
    added: added.map((c) => ({ id: c.id, name: c.name || null, kind: c.kind })),
    removed: removed.map((c) => ({ id: c.id, name: c.name || null, kind: c.kind })),
    changed, mediaAdded: mediaAdded.map((m) => m.id), mediaRemoved: mediaRemoved.map((m) => m.id), settings,
  };
}

function createHistory({ projects, autoMinutes = 10, keepAuto = 30 }) {
  const dir = (pid) => path.join(projects.DIR, pid, "history");
  const docPath = (pid, v) => path.join(dir(pid), `v${pad(v)}.json`);
  const metaPath = (pid, v) => path.join(dir(pid), `v${pad(v)}.meta.json`);
  const resolve = (pid) => {
    const id = pid || projects.activeId();
    projects.mustExist(id);
    return id;
  };

  function entries(pid) {
    let files = [];
    try { files = fs.readdirSync(dir(pid)).filter((f) => /^v\d+\.meta\.json$/.test(f)); } catch { }
    const out = [];
    for (const f of files) { try { out.push(readJSON(path.join(dir(pid), f))); } catch { } }
    return out.sort((x, y) => y.v - x.v);   // newest first
  }
  const entry = (pid, v) => {
    const n = Number(String(v).replace(/^v/i, ""));
    const e = Number.isInteger(n) && entries(pid).find((x) => x.v === n);
    if (!e) throw new Error(`no version ${JSON.stringify(v)} of this project (versions lists them)`);
    return e;
  };

  /* Save the project as it is now. */
  function save(pid, { name, note, kind = "manual", final = false, doc } = {}) {
    pid = resolve(pid);
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    const cur = doc || projects.readDoc(pid);
    fs.mkdirSync(dir(pid), { recursive: true });
    const have = entries(pid);
    let v = (have[0]?.v || 0) + 1;
    // an exclusive create claims the number; another process may have taken it
    for (;; v++) {
      try { fs.writeFileSync(docPath(pid, v), JSON.stringify(cur, null, 2), { flag: "wx" }); break; }
      catch (e) { if (e.code !== "EEXIST") throw e; }
    }
    const meta = {
      v, name: String(name || "").trim().slice(0, MAX_NAME) || defaultName(kind, v),
      note: String(note || "").slice(0, MAX_NOTE), kind, created: new Date().toISOString(),
      revision: cur.revision || 0, clips: (cur.clips || []).length, duration: +timelineEnd(cur).toFixed(2), final: false,
    };
    writeJSON(metaPath(pid, v), meta);
    if (final) markFinal(pid, v, true);
    if (kind === "auto") prune(pid);
    return { project: pid, version: final ? entry(pid, v) : meta };
  }
  const defaultName = (kind, v) => ({ manual: `Version ${String(v).padStart(2, "0")}`, auto: "Auto-save", agent: "Before agent edits", restore: "Before restore" })[kind];

  function prune(pid) {
    const autos = entries(pid).filter((e) => e.kind === "auto" && !e.final);
    for (const e of autos.slice(keepAuto)) remove(pid, e.v, { force: true });
  }

  function list(pid) {
    pid = resolve(pid);
    return { project: pid, versions: entries(pid) };
  }
  function get(pid, v) {
    pid = resolve(pid);
    return readJSON(docPath(pid, entry(pid, v).v));
  }

  /* Write a version back. What was there is saved first, so a restore can be undone by restoring that. */
  function restore(pid, v) {
    pid = resolve(pid);
    const e = entry(pid, v);
    const old = readJSON(docPath(pid, e.v));
    const before = save(pid, { kind: "restore", name: `Before restoring v${e.v}` }).version;
    const cur = projects.readDoc(pid);
    // writeDoc lifts the open project's revision past this one, so tabs and agents see the change
    projects.writeDoc(pid, { ...old, revision: Math.max(cur.revision || 0, old.revision || 0) });
    return { project: pid, restored: e, saved: before };
  }

  /* What changed between two versions, or from a version to now (b default "current"). */
  function diff(pid, a, b = "current") {
    pid = resolve(pid);
    const load = (x) => (x === "current" || x == null ? projects.readDoc(pid) : get(pid, x));
    return { project: pid, from: a, to: b, ...diffDocs(load(a), load(b)) };
  }

  function markFinal(pid, v, on = true) {
    const e = entry(pid, v);
    if (on) for (const o of entries(pid)) if (o.final && o.v !== e.v) writeJSON(metaPath(pid, o.v), { ...o, final: false });
    writeJSON(metaPath(pid, e.v), { ...e, final: !!on });
    return entry(pid, e.v);
  }
  function update(pid, v, { name, note, final } = {}) {
    pid = resolve(pid);
    let e = entry(pid, v);
    if (name != null || note != null) {
      e = { ...e };
      if (name != null) { const n = String(name).trim().slice(0, MAX_NAME); if (!n) throw new Error("name can't be empty"); e.name = n; }
      if (note != null) e.note = String(note).slice(0, MAX_NOTE);
      writeJSON(metaPath(pid, e.v), e);
    }
    if (final != null) e = markFinal(pid, e.v, !!final);
    return { project: pid, version: e };
  }
  function remove(pid, v, { force = false } = {}) {
    pid = resolve(pid);
    const e = entry(pid, v);
    if (e.final && !force) throw new Error(`v${e.v} is marked final — unmark it first`);
    for (const f of [docPath(pid, e.v), metaPath(pid, e.v)]) { try { fs.unlinkSync(f); } catch { } }
    return { project: pid, deleted: e.v };
  }

  /* Auto-save the open project when it changed and the last version is old enough. */
  function maybeAuto(now = Date.now()) {
    let cur;
    try { cur = projects.readRoot(); } catch { return null; }
    let pid = projects.peekActive();
    if (!pid) {
      if (!(cur.clips || []).length) return null;   // nothing worth keeping yet
      pid = projects.activeId();                    // versions need the project's folder
    }
    const last = entries(pid)[0];
    if (last && (last.revision === (cur.revision || 0) || now - new Date(last.created).getTime() < autoMinutes * 60000)) return null;
    if (!last && !(cur.clips || []).length) return null;   // nothing worth keeping yet
    return save(pid, { kind: "auto", doc: cur }).version;
  }

  /* Before an agent changes the project: one version per session start / rewrite, not one per edit. */
  function beforeAgent(name) {
    const pid = projects.activeId();
    const cur = projects.readDoc(pid);
    const last = entries(pid)[0];
    if (last && last.revision === (cur.revision || 0)) return null;   // already saved as it is
    return save(pid, { kind: "agent", name, doc: cur }).version;
  }

  /* A whole project with its versions, as one JSON file. */
  function backup(pid) {
    pid = resolve(pid);
    const meta = projects.list({ archived: "all" }).projects.find((p) => p.id === pid) || {};
    return {
      fablecut: "backup", format: 1, created: new Date().toISOString(),
      name: meta.name, notes: meta.notes || "", tags: meta.tags || [],
      project: projects.readDoc(pid),
      versions: entries(pid).reverse().map((e) => ({ ...e, project: readJSON(docPath(pid, e.v)) })),
    };
  }
  function importBackup(b, { name, open = false } = {}) {
    if (!b || b.fablecut !== "backup" || !b.project) throw new Error("not a FableCut backup");
    const out = projects.importDoc(b.project, { name: name || b.name, open: false });
    projects.update(out.id, { notes: b.notes || "", tags: b.tags || [] });
    fs.mkdirSync(dir(out.id), { recursive: true });
    // each version is checked like a project, and its details are worked out again from it
    const isDoc = (d) => d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.clips) && Array.isArray(d.media);
    const good = (Array.isArray(b.versions) ? b.versions : []).filter((e) => e && Number.isInteger(e.v) && e.v > 0 && isDoc(e.project));
    const finalV = good.filter((e) => e.final === true).map((e) => e.v).pop();   // one final cut: the newest one marked
    let n = 0;
    for (const e of good) {
      const created = typeof e.created === "string" && !isNaN(Date.parse(e.created)) ? e.created : new Date().toISOString();
      writeJSON(docPath(out.id, e.v), e.project);
      writeJSON(metaPath(out.id, e.v), {
        v: e.v, name: String(e.name || "").trim().slice(0, MAX_NAME) || `Version ${String(e.v).padStart(2, "0")}`,
        note: String(e.note || "").slice(0, MAX_NOTE), kind: KINDS.includes(e.kind) ? e.kind : "manual", created,
        revision: e.project.revision || 0, clips: e.project.clips.length, duration: +timelineEnd(e.project).toFixed(2), final: e.v === finalV,
      });
      n++;
    }
    const res = open ? projects.open(out.id) : { id: out.id, project: projects.list({ archived: "all" }).projects.find((p) => p.id === out.id) };
    return { ...res, versions: n };
  }

  /* project.json can't be read at startup: keep the broken file, put back the newest good copy. */
  function recover(projectFile) {
    const pid = projects.peekActive();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = projectFile.replace(/\.json$/, `.corrupt-${stamp}.json`);
    fs.renameSync(projectFile, aside);
    const cands = [];
    if (pid) {
      for (const e of entries(pid)) cands.push({ t: new Date(e.created).getTime(), file: docPath(pid, e.v), from: `version v${e.v}` });
      const parked = path.join(projects.DIR, pid, "project.json");
      try { cands.push({ t: fs.statSync(parked).mtimeMs, file: parked, from: "its last saved copy" }); } catch { }
    }
    cands.sort((x, y) => y.t - x.t);
    for (const c of cands) {
      try {
        const doc = readJSON(c.file);
        // only a document the editor can open: the next candidate otherwise
        if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.clips) || !Array.isArray(doc.media)) continue;
        writeJSON(projectFile, { ...doc, revision: (doc.revision || 0) + 1 });
        return { recovered: true, from: c.from, aside };
      } catch { }
    }
    return { recovered: false, aside };
  }

  function act(a = {}) {
    const pid = a.project || null;
    switch (a.action || "list") {
      case "list": return list(pid);
      case "save": return save(pid, { name: a.name, note: a.note, final: !!a.final });
      case "restore": return restore(pid, a.version);
      case "diff": return diff(pid, a.version, a.to || "current");
      case "update": return update(pid, a.version, a);
      case "delete": return remove(pid, a.version);
      default: throw new Error(`unknown action ${JSON.stringify(a.action)} (list|save|restore|diff|update|delete)`);
    }
  }

  return { list, get, save, restore, diff, update, remove, maybeAuto, beforeAgent, backup, importBackup, recover, act };
}

module.exports = { createHistory, diffDocs, KINDS };
