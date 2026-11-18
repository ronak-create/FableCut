/* The project's files on disk: folders, moves and a trash, all inside media/.

   The media bin's folders and collections only organize entries in
   project.json; this is the folder itself — so an agent (or the user) can
   tidy downloads into subfolders, rename a file, and throw away what isn't
   used, without leaving the editor. Nothing here deletes a file: "trash"
   moves it into media/.trash/<id>/ beside a note of where it came from, and
   "restore" puts it back. Dot-folders are never listed, served as media or
   offered by Relink, so trashed files are out of the way but still there.

     createMediaFiles({mediaDir}) → {
       list(dir?)            → {dir, folders:[name], files:[{name, src, size}]}   (one level)
       mkdir(dir)            → {dir}                       (parents too; an existing one is fine)
       move(from, to)        → {moved:[{from, to}]}        (srcs; a file or a folder, into a folder or to a new name)
       trash(paths)          → {trashed:[{id, src}], moved:[{from, to}]}
       trashList()           → [{id, src, kind, size, trashed}]
       restore(id)           → {restored:{id, src}, moved:[{from, to}]}
       filesOf(path)         → the /media/… srcs of the files at or under a path
       pathOf(src)           → the absolute path of a /media/… src inside media/, or null
     }
   Paths are relative to media/ ("b-roll/day 1/a.mp4") or /media/… srcs; ".."
   and dot-segments are refused. `moved` lists every file that changed place
   as /media/… srcs, so callers can repoint media entries at them. */
"use strict";
const fs = require("fs");
const path = require("path");

const TRASH = ".trash";
const toSrc = (rel) => "/media/" + rel.split(/[\\/]/).map(encodeURIComponent).join("/");

function createMediaFiles({ mediaDir }) {
  const root = path.resolve(mediaDir);
  const trashDir = path.join(root, TRASH);

  /** "a/b.mp4" or "/media/a/b.mp4" → {rel, abs}; throws on anything outside media/. */
  function resolve(p, { allowRoot = false } = {}) {
    let s = String(p == null ? "" : p).trim().replace(/\\/g, "/");
    if (s.startsWith("/media/")) { try { s = decodeURIComponent(s.slice(7)); } catch { throw new Error(`bad path ${JSON.stringify(p)}`); } }
    else if (s === "/media" || s === "media" || s === "media/") s = "";
    s = s.replace(/^\/+|\/+$/g, "");
    const parts = s ? s.split("/") : [];
    if (parts.some((x) => !x || x === "." || x === ".." || x.startsWith(".")))
      throw new Error(`${JSON.stringify(p)} is not a path inside media/ (no "..", no dot-folders)`);
    if (parts.some((x) => /[<>:"|?*\x00-\x1f]/.test(x) || x.length > 120))
      throw new Error(`${JSON.stringify(p)} has a name that isn't allowed (< > : " | ? * or over 120 characters)`);
    if (!parts.length && !allowRoot) throw new Error("name a file or folder inside media/");
    const rel = parts.join("/");
    return { rel, abs: rel ? path.join(root, ...parts) : root };
  }
  const stat = (abs) => { try { return fs.statSync(abs); } catch { return null; } };
  /** Every file under `abs` as paths relative to media/ (a file: itself). */
  function filesUnder(abs) {
    const st = stat(abs);
    if (!st) return [];
    if (st.isFile()) return [path.relative(root, abs).split(path.sep).join("/")];
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full); else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(abs);
    return out;
  }
  /** Move `fromAbs` to `toAbs` (both inside media/), creating the folder above. */
  function rename(fromAbs, toAbs) {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    try { fs.renameSync(fromAbs, toAbs); }
    catch (e) {
      if (e.code !== "EXDEV") throw e;
      fs.cpSync(fromAbs, toAbs, { recursive: true, errorOnExist: true, force: false });
      fs.rmSync(fromAbs, { recursive: true, force: true });
    }
  }
  /** [{from, to}] srcs for what moved from `fromRel` to `toRel`, given the files that were under fromRel. */
  const pairs = (files, fromRel, toRel) => files.map((f) => ({ from: toSrc(f), to: toSrc(toRel + f.slice(fromRel.length)) }));

  return {
    filesOf(p) { const r = resolve(p); if (!stat(r.abs)) throw new Error(`no file or folder ${JSON.stringify(r.rel)} in media/`); return filesUnder(r.abs).map(toSrc); },
    pathOf(src) { try { const r = resolve(src); return stat(r.abs)?.isFile() ? r.abs : null; } catch { return null; } },
    list(dir) {
      const { rel, abs } = resolve(dir, { allowRoot: true });
      const st = stat(abs);
      if (!st || !st.isDirectory()) throw new Error(`no folder ${rel ? JSON.stringify(rel) : "media/"}`);
      const folders = [], files = [];
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) folders.push(e.name);
        else if (e.isFile()) files.push({ name: e.name, src: toSrc(r), size: stat(path.join(abs, e.name))?.size || 0 });
      }
      const byName = (a, b) => String(a.name || a).localeCompare(String(b.name || b), undefined, { numeric: true });
      return { dir: rel, folders: folders.sort(byName), files: files.sort(byName) };
    },
    mkdir(dir) {
      const { rel, abs } = resolve(dir);
      const st = stat(abs);
      if (st && !st.isDirectory()) throw new Error(`${JSON.stringify(rel)} is a file`);
      fs.mkdirSync(abs, { recursive: true });
      return { dir: rel };
    },
    move(from, to) {
      const a = resolve(from), b = resolve(to, { allowRoot: true });
      const st = stat(a.abs);
      if (!st) throw new Error(`no file or folder ${JSON.stringify(a.rel)} in media/`);
      // into an existing folder keeps the name; otherwise `to` is the new path
      const into = stat(b.abs)?.isDirectory();
      const destRel = into ? (b.rel ? b.rel + "/" : "") + path.basename(a.abs) : b.rel;
      const destAbs = into ? path.join(b.abs, path.basename(a.abs)) : b.abs;
      if (destAbs === a.abs) return { moved: [] };
      if (st.isDirectory() && (destAbs + path.sep).startsWith(a.abs + path.sep)) throw new Error(`can't move ${JSON.stringify(a.rel)} into itself`);
      if (stat(destAbs)) throw new Error(`${JSON.stringify(destRel)} already exists — pick another name`);
      const files = filesUnder(a.abs);
      rename(a.abs, destAbs);
      return { moved: pairs(files, a.rel, destRel) };
    },
    trash(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).map((p) => resolve(p));
      for (const r of list) if (!stat(r.abs)) throw new Error(`no file or folder ${JSON.stringify(r.rel)} in media/`);
      const trashed = [], moved = [];
      for (const r of list) {
        const st = stat(r.abs);
        const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const files = filesUnder(r.abs);
        const dest = path.join(trashDir, id, path.basename(r.abs));
        rename(r.abs, dest);
        fs.writeFileSync(path.join(trashDir, id, "item.json"), JSON.stringify({
          id, src: toSrc(r.rel), rel: r.rel, kind: st.isDirectory() ? "folder" : "file",
          size: st.isDirectory() ? files.length : st.size, trashed: new Date().toISOString(),
        }, null, 2));
        trashed.push({ id, src: toSrc(r.rel) });
        for (const f of files) moved.push({ from: toSrc(f), to: null });
      }
      return { trashed, moved };
    },
    trashList() {
      let ids = [];
      try { ids = fs.readdirSync(trashDir); } catch { return []; }
      const out = [];
      for (const id of ids) {
        try {
          const it = JSON.parse(fs.readFileSync(path.join(trashDir, id, "item.json"), "utf8"));
          out.push({ id: it.id, src: it.src, kind: it.kind, size: it.size, trashed: it.trashed });
        } catch { }
      }
      return out.sort((a, b) => String(b.trashed).localeCompare(String(a.trashed)));
    },
    restore(id) {
      if (!/^t[a-z0-9]{4,20}$/.test(String(id || ""))) throw new Error(`no trashed item ${JSON.stringify(id)} (list the trash first)`);
      let it;
      try { it = JSON.parse(fs.readFileSync(path.join(trashDir, id, "item.json"), "utf8")); }
      catch { throw new Error(`no trashed item ${JSON.stringify(id)} (list the trash first)`); }
      const back = resolve(it.rel);
      if (stat(back.abs)) throw new Error(`${JSON.stringify(it.rel)} exists again — move it away first, then restore`);
      const src = path.join(trashDir, id, path.basename(back.abs));
      const inTrash = filesUnder(src).map((f) => f.slice((TRASH + "/" + id + "/").length));
      rename(src, back.abs);
      fs.rmSync(path.join(trashDir, id), { recursive: true, force: true });
      const prefix = path.basename(back.abs);
      const parent = back.rel.slice(0, back.rel.length - prefix.length);
      return { restored: { id, src: it.src }, moved: inTrash.map((f) => ({ from: null, to: toSrc(parent + f) })) };
    },
  };
}

module.exports = { createMediaFiles, TRASH };
