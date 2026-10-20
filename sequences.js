/* FableCut sequences — several timelines in one project. Zero dependencies.
   Loaded by the editor as a plain script (global `FableCutSeq`) and required
   by the MCP server, project-ops and the tests.

   The OPEN sequence is the project's top level, as it always was: `clips`,
   `tracks`, `markers`, the canvas, the mix and the delivery settings. Every
   tool, agent and export keeps reading and writing those. The others are kept
   in `project.sequences`, each with its own copy of the same keys:

     "sequence": "main",                      // the open one
     "sequences": [
       { "id": "main", "name": "Main" },      // the open one: its timeline is the top level
       { "id": "seq_v", "name": "Vertical", "width": 1080, "height": 1920, "fps": 30, "clips": [ … ], … }
     ]

   Opening another sequence parks the top-level keys in the open one's entry
   and brings the other's up. Media, folders, collections and compositions
   are the project's, shared by every sequence. A project with one sequence
   has neither key: untouched projects stay byte-identical. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api;
  else root.FableCutSeq = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** What a sequence owns: its timeline, canvas, frame rate, mix and delivery. */
  const KEYS = ["width", "height", "fps", "background", "exportFrame", "clips", "tracks", "markers", "inPoint", "outPoint",
    "disabledTracks", "lockedTracks", "untargetedTracks", "master", "buses", "delivery", "outputs", "encodeProfile"];
  const MAIN = { id: "main", name: "Main" };
  const MAX = 64;
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const uid = () => Math.random().toString(36).slice(2, 8);
  const r2 = (v) => Math.round(v * 100) / 100;

  /** The sequence entries, the open one included (a project without the key has one: Main). */
  function entries(doc) {
    return doc && Array.isArray(doc.sequences) && doc.sequences.length ? doc.sequences : [{ ...MAIN }];
  }
  function activeId(doc) {
    const list = entries(doc);
    return doc && list.some((s) => s.id === doc.sequence) ? doc.sequence : list[0].id;
  }
  function find(doc, id) { return entries(doc).find((s) => s.id === id) || null; }
  /** The sequences that are not open: [{id, name, clips, …}] — media and comp usage scans read these too. */
  function others(doc) {
    const act = activeId(doc);
    return entries(doc).filter((s) => s.id !== act);
  }
  const lengthOf = (clips) => (Array.isArray(clips) ? clips : []).reduce((m, c) => Math.max(m, (+c.start || 0) + (+c.duration || 0)), 0);

  /** One row per sequence, in order: {id, name, active, width, height, fps, clips, duration}. */
  function list(doc) {
    const act = activeId(doc);
    return entries(doc).map((s) => {
      const src = s.id === act ? doc : s;
      return { id: s.id, name: s.name || s.id, active: s.id === act, width: src.width, height: src.height, fps: src.fps,
        clips: Array.isArray(src.clips) ? src.clips.length : 0, duration: r2(lengthOf(src.clips)) };
    });
  }

  /** Check and tidy doc.sequences in place (throws on a bad entry). One sequence named Main → both keys go. */
  function normalize(doc) {
    if (doc.sequences == null) { delete doc.sequence; return doc; }
    if (!Array.isArray(doc.sequences)) throw new Error("sequences must be a list of {id, name, …}");
    if (doc.sequences.length > MAX) throw new Error(`a project holds up to ${MAX} sequences`);
    const seen = new Set();
    const out = [];
    for (const s of doc.sequences) {
      if (!isObj(s)) throw new Error("every sequence is an object {id, name, …}");
      const id = typeof s.id === "string" ? s.id.trim().slice(0, 40) : "";
      if (!id) throw new Error("every sequence needs an id");
      if (seen.has(id)) throw new Error(`two sequences have the id ${id} — sequence ids must be unique`);
      seen.add(id);
      const name = typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 120) : id;
      out.push({ ...s, id, name });
    }
    if (!out.length) { delete doc.sequences; delete doc.sequence; return doc; }
    const act = out.some((s) => s.id === doc.sequence) ? doc.sequence : out[0].id;
    for (const s of out) {
      if (s.id === act) { for (const k of KEYS) delete s[k]; continue; }
      // a parked sequence carries its own timeline
      if (s.clips == null) s.clips = [];
      if (!Array.isArray(s.clips)) throw new Error(`sequence ${s.id}: clips must be a list`);
      for (const c of s.clips) if (!isObj(c) || typeof c.id !== "string" || typeof c.start !== "number" || typeof c.duration !== "number")
        throw new Error(`sequence ${s.id}: every clip needs id, numeric start and duration`);
      for (const k of ["width", "height", "fps"]) if (s[k] != null && !(typeof s[k] === "number" && s[k] > 0)) throw new Error(`sequence ${s.id}: ${k} must be a positive number`);
    }
    if (out.length === 1 && out[0].id === MAIN.id && out[0].name === MAIN.name) { delete doc.sequences; delete doc.sequence; return doc; }
    doc.sequences = out;
    doc.sequence = act;
    return doc;
  }

  /** Make the list explicit (before adding to it). */
  function materialize(doc) {
    if (!Array.isArray(doc.sequences) || !doc.sequences.length) doc.sequences = [{ ...MAIN }];
    doc.sequence = activeId(doc);
    return doc;
  }
  /** The open sequence's keys, copied out of the top level. */
  function takeTop(doc) {
    const out = {};
    for (const k of KEYS) if (doc[k] !== undefined) out[k] = clone(doc[k]);
    if (!Array.isArray(out.clips)) out.clips = [];
    return out;
  }

  /** Open sequence `id`: the open one's timeline is parked in its entry, `id`'s comes up. */
  function open(doc, id) {
    const target = find(doc, id);
    if (!target) throw new Error(`no sequence ${id} (${entries(doc).map((s) => s.id).join(", ")})`);
    const act = activeId(doc);
    if (id === act) return doc;
    materialize(doc);
    const parked = takeTop(doc);
    const keep = { width: doc.width, height: doc.height, fps: doc.fps };
    doc.sequences = doc.sequences.map((s) => {
      if (s.id === act) return { id: s.id, name: s.name, ...parked };
      if (s.id === id) return { id: s.id, name: s.name };
      return s;
    });
    for (const k of KEYS) {
      if (target[k] !== undefined) doc[k] = target[k];
      else delete doc[k];
    }
    // a sequence always has a canvas and a timeline
    for (const k of ["width", "height", "fps"]) if (!(doc[k] > 0)) doc[k] = keep[k];
    if (!Array.isArray(doc.clips)) doc.clips = [];
    doc.sequence = id;
    return doc;
  }

  /** A new sequence: {name?, id?, from?: "empty" | "open" | <sequence id>, width?, height?, fps?}.
   *  Empty takes the open one's canvas, frame rate and background; a copy takes everything.
   *  It is added after the open one (or after `from`) and not opened. */
  function add(doc, opts = {}) {
    materialize(doc);
    const from = opts.from || "empty";
    const id = opts.id ? String(opts.id).trim().slice(0, 40) : "seq_" + uid();
    if (!id) throw new Error("addSequence: the id is empty");
    if (find(doc, id)) throw new Error(`addSequence: sequence ${id} already exists`);
    if (doc.sequences.length >= MAX) throw new Error(`addSequence: a project holds up to ${MAX} sequences`);
    const act = activeId(doc);
    let body, after = act;
    if (from === "empty") {
      body = { width: doc.width, height: doc.height, fps: doc.fps, clips: [] };
      if (doc.background) body.background = doc.background;
    } else if (from === "open" || from === act) {
      body = takeTop(doc);
    } else {
      const src = find(doc, from);
      if (!src) throw new Error(`addSequence: no sequence ${from} to copy`);
      const { id: _i, name: _n, ...rest } = clone(src);
      body = rest;
      after = src.id;
    }
    for (const k of ["width", "height", "fps"]) if (opts[k] != null) {
      const v = +opts[k];
      if (!(v > 0) || (k !== "fps" && (v < 16 || v > 8192)) || (k === "fps" && v > 240)) throw new Error(`addSequence: ${k} ${opts[k]} is out of range`);
      body[k] = k === "fps" ? v : Math.round(v);
    }
    if (from !== "empty" && (opts.width != null || opts.height != null)) delete body.exportFrame;   // the crop was for the other size
    const srcName = from === "empty" ? null : (find(doc, from === "open" ? act : from) || {}).name;
    const name = typeof opts.name === "string" && opts.name.trim() ? opts.name.trim().slice(0, 120)
      : srcName ? `${srcName} copy` : `Sequence ${doc.sequences.length + 1}`;
    const entry = { id, name, ...body };
    const at = doc.sequences.findIndex((s) => s.id === after);
    doc.sequences.splice(at + 1, 0, entry);
    return entry;
  }

  /** Rename (the only thing set on an entry — the open one's timeline is edited at the top level). */
  function rename(doc, id, name) {
    const s = find(doc, id);
    if (!s) throw new Error(`no sequence ${id}`);
    const n = String(name == null ? "" : name).trim().slice(0, 120);
    if (!n) throw new Error("a sequence needs a name");
    materialize(doc);
    doc.sequences = doc.sequences.map((x) => (x.id === id ? { ...x, name: n } : x));
    return normalize(doc);
  }
  /** Move sequence `id` to position `index` (0-based) in the list. */
  function move(doc, id, index) {
    materialize(doc);
    const i = doc.sequences.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`no sequence ${id}`);
    const [s] = doc.sequences.splice(i, 1);
    doc.sequences.splice(Math.max(0, Math.min(doc.sequences.length, Math.round(+index) || 0)), 0, s);
    return doc;
  }
  /** Delete sequence `id`. The last one stays; deleting the open one opens its neighbour first. */
  function remove(doc, id) {
    const list = entries(doc);
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`no sequence ${id}`);
    if (list.length === 1) throw new Error("a project keeps at least one sequence");
    if (activeId(doc) === id) open(doc, (list[i + 1] || list[i - 1]).id);
    doc.sequences = doc.sequences.filter((s) => s.id !== id);
    return normalize(doc);
  }

  /** One line per sequence, for status readouts. */
  function describe(row) {
    const m = Math.floor(row.duration / 60), s = Math.round(row.duration % 60);
    return `${row.id} "${row.name}"${row.active ? " (open)" : ""} ${row.width}x${row.height}@${row.fps}, ${row.clips} clip(s), ${m}:${String(s).padStart(2, "0")}`;
  }

  return { KEYS, MAIN, MAX, entries, activeId, find, others, list, normalize, materialize, open, add, rename, move, remove, describe };
});
