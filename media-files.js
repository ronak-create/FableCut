/* The project's files on disk: folders, moves and a trash, all inside media/.

   The media bin's folders and collections only organize entries in
   project.json; this is the folder itself — so an agent (or the user) can
   tidy downloads into subfolders, rename a file, and throw away what isn't
   used, without leaving the editor. Nothing here deletes a file: "trash"
   moves it into media/.trash/<id>/files/ beside a note of where it came from
   (<id>/item.json), and "restore" puts it back. Dot-folders are never listed,
   served as media or offered by Relink, so trashed files are out of the way
   but still there.

     createMediaFiles({mediaDir}) → {
       list(dir?)            → {dir, folders:[name], files:[{name, src, size}]}   (one level)
       mkdir(dir)            → {dir}                       (parents too; an existing one is fine)
       move(from, to, {exact}?) → {from, to, moved:[{from, to}]}  (srcs: the item, and every file in it;
                               exact: `to` is the new path itself, never a folder to go into)
       trash(paths)          → {trashed:[{id, src}], moved:[{from, to}]}
       trashList()           → [{id, src, kind, size, trashed}]
       restore(id)           → {restored:{id, src}, moved:[{from, to}]}
       filesOf(path)         → the /media/… srcs of the files at or under a path
       pathOf(src)           → the absolute path of a /media/… src inside media/, or null
     }
     canonicalSrc(src)       → a /media/… src decoded with doubled slashes folded,
                               the form two srcs of the same file share
   Paths are relative to media/ ("b-roll/day 1/a.mp4") or /media/… srcs; "..",
   dot-segments and symlinks on the way are refused. `moved` lists every file
   that changed place as /media/… srcs, so callers can repoint media entries. */
"use strict";
const fs = require("fs");
const path = require("path");

const TRASH = ".trash";
const toSrc = (rel) => "/media/" + rel.split(/[\\/]/).map(encodeURIComponent).join("/");
function canonicalSrc(src) {
  let s = String(src || "").split("?")[0];
  try { s = decodeURIComponent(s); } catch { }
  return s.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function createMediaFiles({ mediaDir }) {
  const root = path.resolve(mediaDir);
  const trashDir = path.join(root, TRASH);

  /** Throws when a path on the way from media/ to `abs` (as far as it exists) is a symlink. */
  function noLinks(abs) {
    const parts = path.relative(root, abs).split(path.sep).filter(Boolean);
    let cur = root;
    for (const part of parts) {
      cur = path.join(cur, part);
      let st;
      try { st = fs.lstatSync(cur); } catch { return; }   // nothing there yet: nothing to follow
      if (st.isSymbolicLink()) throw new Error(`${JSON.stringify(path.relative(root, cur).split(path.sep).join("/"))} is a link — FableCut only moves real files and folders in media/`);
    }
  }
  /** "a/b.mp4" or "/media/a/b.mp4" → {rel, abs}; throws on anything outside media/.
      raw: a path as stored (no "/media" / "media" shorthand for the folder itself). */
  function resolve(p, { allowRoot = false, raw = false } = {}) {
    let s = String(p == null ? "" : p).replace(/\\/g, "/");
    if (!raw) s = s.trim();   // a stored path keeps its spaces: " take.mp4" is a real name
    if (!raw) {
      if (s.startsWith("/media/")) { try { s = decodeURIComponent(s.slice(7)); } catch { throw new Error(`bad path ${JSON.stringify(p)}`); } }
      else if (s === "/media" || s === "media" || s === "media/") s = "";
    }
    s = s.replace(/^\/+|\/+$/g, "");
    const parts = s ? s.split("/") : [];
    if (parts.some((x) => !x || x === "." || x === ".." || x.startsWith(".")))
      throw new Error(`${JSON.stringify(p)} is not a path inside media/ (no "..", no dot-folders)`);
    if (parts.some((x) => /[<>:"|?*\x00-\x1f]/.test(x) || x.length > 120))
      throw new Error(`${JSON.stringify(p)} has a name that isn't allowed (< > : " | ? * or over 120 characters)`);
    if (!parts.length && !allowRoot) throw new Error("name a file or folder inside media/");
    const rel = parts.join("/");
    const abs = rel ? path.join(root, ...parts) : root;
    noLinks(abs);
    return { rel, abs };
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
        if (e.isSymbolicLink()) throw new Error(`${JSON.stringify(path.relative(root, full).split(path.sep).join("/"))} is a link — FableCut only moves real files and folders in media/`);
        if (e.isDirectory()) walk(full); else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(abs);
    return out;
  }
  const relOf = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const taken = (toAbs) => Object.assign(new Error(`${JSON.stringify(relOf(toAbs))} already exists — pick another name`), { code: "EEXIST" });
  /** Put `fromAbs` at `toAbs` without replacing anything there: a file is hard-linked to
      its new name (which fails if the name is taken) and then unlinked; a folder is
      renamed, which never lands on a folder with something in it. */
  function publish(fromAbs, toAbs) {
    if (fs.lstatSync(fromAbs).isFile()) {
      try { fs.linkSync(fromAbs, toAbs); }
      catch (e) {
        if (e.code === "EEXIST") throw taken(toAbs);
        if (e.code === "EXDEV") throw e;
        // a file system without hard links: check, then rename
        if (fs.existsSync(toAbs)) throw taken(toAbs);
        fs.renameSync(fromAbs, toAbs);
        return;
      }
      fs.unlinkSync(fromAbs);
      return;
    }
    // a folder: Windows never renames onto an existing folder; elsewhere an empty folder made
    // here first holds the name (mkdir fails if it is taken), and the rename replaces only it
    if (process.platform === "win32") {
      if (fs.existsSync(toAbs)) throw taken(toAbs);
      fs.renameSync(fromAbs, toAbs);
      return;
    }
    try { fs.mkdirSync(toAbs); } catch (e) { if (e.code === "EEXIST") throw taken(toAbs); throw e; }
    try { fs.renameSync(fromAbs, toAbs); }
    catch (e) { try { fs.rmdirSync(toAbs); } catch { } throw e.code === "ENOTEMPTY" || e.code === "EEXIST" ? taken(toAbs) : e; }
  }
  /** Move `fromAbs` to `toAbs` (both inside media/), creating the folder above; a name
      taken meanwhile is refused, never replaced. Across drives the copy goes to a staging
      name first (timestamps kept, so the file's transcript still matches it) and takes
      the final name only once it is complete. If removing the original then fails, the
      error says so with `published: true`: the copy is whole and stays. */
  function rename(fromAbs, toAbs) {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    try { publish(fromAbs, toAbs); return; }
    catch (e) { if (e.code !== "EXDEV") throw e; }
    const stage = path.join(path.dirname(toAbs), `.fc-move-${process.pid}-${Date.now().toString(36)}`);
    try {
      fs.cpSync(fromAbs, stage, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      publish(stage, toAbs);
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw e;
    }
    try { fs.rmSync(fromAbs, { recursive: true, force: true }); }
    catch (e) {
      throw Object.assign(new Error(`copied to ${relOf(toAbs)}, but the original could not be removed (${e.code || e.message}) — both copies are there`), { published: true });
    }
  }
  /** [{from, to}] srcs for what moved from `fromRel` to `toRel`, given the files that were under fromRel. */
  const pairs = (files, fromRel, toRel) => files.map((f) => ({ from: toSrc(f), to: toSrc(toRel + f.slice(fromRel.length)) }));
  const readItem = (id) => {
    if (!/^t[a-z0-9]{4,20}$/.test(String(id || ""))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(trashDir, id, "item.json"), "utf8")); } catch { return null; }
  };

  return {
    filesOf(p) { const r = resolve(p); if (!stat(r.abs)) throw new Error(`no file or folder ${JSON.stringify(r.rel)} in media/`); return filesUnder(r.abs).map(toSrc); },
    pathOf(src) { try { const r = resolve(src); return stat(r.abs)?.isFile() ? r.abs : null; } catch { return null; } },
    list(dir) {
      const { rel, abs } = resolve(dir, { allowRoot: true });
      const st = stat(abs);
      if (!st || !st.isDirectory()) throw new Error(`no folder ${rel ? JSON.stringify(rel) : "media/"}`);
      const folders = [], files = [];
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
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
    move(from, to, { exact = false } = {}) {
      if (to == null || String(to).trim() === "") throw new Error("say where to move it: a folder, a new name, or \"/media/\" for the top of media/");
      const a = resolve(from), b = resolve(to, { allowRoot: true });
      const st = stat(a.abs);
      if (!st) throw new Error(`no file or folder ${JSON.stringify(a.rel)} in media/`);
      // into an existing folder keeps the name; otherwise `to` is the new path
      const into = !exact && stat(b.abs)?.isDirectory();
      const destRel = into ? (b.rel ? b.rel + "/" : "") + path.basename(a.abs) : b.rel;
      const destAbs = into ? path.join(b.abs, path.basename(a.abs)) : b.abs;
      if (destAbs === a.abs) return { from: toSrc(a.rel), to: toSrc(a.rel), moved: [] };
      if (st.isDirectory() && (destAbs + path.sep).startsWith(a.abs + path.sep)) throw new Error(`can't move ${JSON.stringify(a.rel)} into itself`);
      if (stat(destAbs)) throw new Error(`${JSON.stringify(destRel)} already exists — pick another name`);
      noLinks(destAbs);
      const files = filesUnder(a.abs);
      const result = { from: toSrc(a.rel), to: toSrc(destRel), moved: pairs(files, a.rel, destRel) };
      // a copy that is whole at the new place but left part of the original: it moved (with a warning)
      try { rename(a.abs, destAbs); } catch (e) { if (e.published) e.result = result; throw e; }
      return result;
    },
    trash(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).map((p) => resolve(p));
      for (const r of list) if (!stat(r.abs)) throw new Error(`no file or folder ${JSON.stringify(r.rel)} in media/`);
      // one item inside another would be gone by the time its turn came
      for (const r of list) for (const o of list) {
        if (r === o) continue;
        if (r.rel === o.rel) throw new Error(`${JSON.stringify(r.rel)} is listed twice`);
        if ((r.rel + "/").startsWith(o.rel + "/")) throw new Error(`${JSON.stringify(r.rel)} is inside ${JSON.stringify(o.rel)} — trash the folder, or the file, not both`);
      }
      const trashed = [], moved = [];
      // a failure part-way through says what already went (`partial`), so those can be restored
      const fail = (e, src) => { throw Object.assign(e, { partial: { trashed, moved, failed: src } }); };
      fs.mkdirSync(trashDir, { recursive: true });
      for (const r of list) {
        const st = stat(r.abs);
        const files = filesUnder(r.abs);
        // each item's folder is made without `recursive`, so a taken id is never shared
        let id, box;
        for (let i = 0; ; i++) {
          id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          box = path.join(trashDir, id);
          try { fs.mkdirSync(box); break; }
          catch (e) { if (e.code !== "EEXIST" || i > 20) fail(e, toSrc(r.rel)); }
        }
        // the record goes first: if the move then fails it is removed, and nothing is lost either way
        try {
          fs.writeFileSync(path.join(box, "item.json"), JSON.stringify({
            id, src: toSrc(r.rel), rel: r.rel, kind: st.isDirectory() ? "folder" : "file",
            size: st.isDirectory() ? files.length : st.size, trashed: new Date().toISOString(),
          }, null, 2));
          rename(r.abs, path.join(box, "files", path.basename(r.abs)));
        } catch (e) {
          if (e.published) {
            // the trash holds a whole copy, and part of the original may be gone: keep the copy
            trashed.push({ id, src: toSrc(r.rel), warning: e.message });
            for (const f of files) moved.push({ from: toSrc(f), to: null });
            continue;
          }
          fs.rmSync(box, { recursive: true, force: true });
          fail(e, toSrc(r.rel));
        }
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
        const it = readItem(id);
        if (it) out.push({ id: it.id, src: it.src, kind: it.kind, size: it.size, trashed: it.trashed });
      }
      return out.sort((a, b) => String(b.trashed).localeCompare(String(a.trashed)));
    },
    restore(id) {
      const it = readItem(id);
      if (!it) throw new Error(`no trashed item ${JSON.stringify(id)} (list the trash first)`);
      const back = resolve(it.rel, { raw: true });
      if (stat(back.abs)) throw new Error(`${JSON.stringify(it.rel)} exists again — move it away first, then restore`);
      const src = path.join(trashDir, id, "files", path.basename(back.abs));
      if (!fs.existsSync(src)) throw new Error(`trashed item ${id} has no files left to restore`);
      const inner = filesUnder(src).map((f) => f.slice((TRASH + "/" + id + "/files/").length));
      let warning;
      try { rename(src, back.abs); }
      catch (e) { if (!e.published) throw e; warning = e.message; }
      // the file is back: a record left behind is only clutter in the trash list
      try { if (!warning) fs.rmSync(path.join(trashDir, id), { recursive: true, force: true }); }
      catch (e) { warning = `restored, but its trash entry ${id} couldn't be removed (${e.code || e.message})`; }
      const parent = back.rel.slice(0, back.rel.length - path.basename(back.abs).length);
      return { restored: { id, src: it.src, ...(warning ? { warning } : {}) }, moved: inner.map((f) => ({ from: null, to: toSrc(parent + f) })) };
    },
  };
}

module.exports = { createMediaFiles, canonicalSrc, TRASH };
