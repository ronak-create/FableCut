/* FableCut compositions — nested sequences. Zero dependencies beyond edit-ops
   (for re-basing keyframes). Loaded by the editor as a plain script (global
   `FableCutComp`) and required by the MCP server and the tests.

   A composition lives in `project.comps`:
     { id, name, width, height, duration, background?, tracks?: [{id, kind}], clips: [ …clips… ] }
   Its clips are ordinary clips (any kind, comp clips too) on the comp's own
   tracks, with times inside the comp. A clip of kind "comp" places one on a
   timeline: { kind: "comp", compId, start, in, duration, props… } — `in` is
   where in the comp it starts. It draws like a picture of the comp's size (so
   it moves, scales, masks, grades and blends like an image), and the media in
   it — video frames, audio — plays and exports as if it were on the timeline.

   flatten() turns every comp clip's contents into "virtual" clips on the main
   timeline: ids "<compClip>><clip>", start shifted to timeline time, trimmed
   to the comp clip's window, keyframes / masks / shape keys re-based, parents
   and links renamed into the same instance. Playback, export seeking, the
   audio mix and the comp renderer all work from that list. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./edit-ops") : root.FableCutEdit);
  if (node) module.exports = api;
  else root.FableCutComp = api;
})(typeof self !== "undefined" ? self : this, function (EditLib) {
  "use strict";

  const MAX_DEPTH = 4;
  const SEP = ">";
  const DEFAULT_TRACKS = [
    { id: "V3", kind: "video" }, { id: "V2", kind: "video" }, { id: "V1", kind: "video" },
    { id: "A1", kind: "audio" }, { id: "A2", kind: "audio" },
  ];
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const r4 = (v) => +(+v).toFixed(4);
  const compTracks = (comp) => (Array.isArray(comp.tracks) && comp.tracks.length ? comp.tracks : DEFAULT_TRACKS);

  /** A comp, validated. strict: throw on bad input (agent). doc: for width / height defaults. */
  function normalizeComp(c, strict = false, doc = {}) {
    const bad = (m) => { if (strict) throw new Error(m); return null; };
    if (!isObj(c)) return bad("a comp must be an object like {id, name, duration, clips:[…]}");
    if (typeof c.id !== "string" || !c.id.trim()) return bad("a comp needs an id");
    const out = { ...c, id: c.id.trim() };
    out.name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 80) : out.id;
    for (const [k, def] of [["width", doc.width || 1280], ["height", doc.height || 720]]) {
      const v = c[k] == null ? def : c[k];
      if (!Number.isInteger(v) || v < 16 || v > 8192) { bad(`comp ${out.id}: ${k} must be a whole number of px (16…8192)`); out[k] = def; }
      else out[k] = v;
    }
    if (!isNum(c.duration) || c.duration <= 0) return bad(`comp ${out.id}: duration must be a number of seconds > 0`);
    out.duration = r4(c.duration);
    if (c.background != null && typeof c.background !== "string") bad(`comp ${out.id}: background is a colour string (or leave it out for transparent)`);
    if (c.tracks != null) {
      if (!Array.isArray(c.tracks) || c.tracks.some((t) => !isObj(t) || typeof t.id !== "string" || !["video", "audio"].includes(t.kind)))
        bad(`comp ${out.id}: tracks is a list of {id, kind:"video"|"audio"}`);
    }
    if (c.clips != null && !Array.isArray(c.clips)) return bad(`comp ${out.id}: clips must be a list`);
    out.clips = Array.isArray(c.clips) ? c.clips : [];
    for (const x of out.clips) {
      if (!isObj(x) || typeof x.id !== "string" || !isNum(x.start) || !isNum(x.duration))
        return bad(`comp ${out.id}: every clip needs id, numeric start and duration`);
    }
    return out;
  }
  function getComp(doc, id) { return (doc && Array.isArray(doc.comps) ? doc.comps : []).find((c) => c.id === id) || null; }
  /** Comp ids that comp `id` uses, directly or through nested comps. */
  function usedComps(doc, id, out = new Set(), depth = 0) {
    const comp = getComp(doc, id);
    if (!comp || depth > 32) return out;
    for (const c of comp.clips || []) if (c.kind === "comp" && c.compId && !out.has(c.compId)) { out.add(c.compId); usedComps(doc, c.compId, out, depth + 1); }
    return out;
  }
  /** Would placing comp `childId` inside comp `parentId` (null = the main timeline) make a loop? */
  function wouldCycle(doc, parentId, childId) {
    if (!parentId) return false;
    if (parentId === childId) return true;
    return usedComps(doc, childId).has(parentId);
  }
  /** Where comp `id` is used: [{in: compId | null (main), clip}] */
  function usages(doc, id) {
    const out = [];
    for (const c of doc.clips || []) if (c.kind === "comp" && c.compId === id) out.push({ in: null, clip: c });
    for (const comp of doc.comps || []) for (const c of comp.clips || []) if (c.kind === "comp" && c.compId === id) out.push({ in: comp.id, clip: c });
    return out;
  }

  /* ── Flattening ── */
  const clipEnd = (c) => c.start + c.duration;
  const speedOf = (c) => (c.props && +c.props.speed) || 1;
  /** Keyframe times re-based by -offset, every key kept (keys before 0 still shape the curve). */
  function shiftAll(kfs, offset) {
    if (!kfs) return kfs;
    const out = {};
    for (const [k, arr] of Object.entries(kfs)) out[k] = Array.isArray(arr) ? arr.map((kf) => ({ ...kf, t: r4(kf.t - offset) })) : arr;
    return out;
  }
  /** A comp's clip as a clip on the timeline: shifted by `offset`, trimmed to `win`, renamed under `prefix`. */
  function virtualize(inner, prefix, offset, win, inst, on) {
    const start = inner.start + offset, end = start + inner.duration;
    const a = Math.max(start, win[0]), b = Math.min(end, win[1]);
    if (b - a <= 1e-6) return null;
    const head = a - start;
    const v = { ...inner, id: prefix + inner.id, start: r4(a), duration: r4(b - a), _comp: inst, _src: inner.id, _on: on && inner.disabled !== true };
    if (inner.props) v.props = { ...inner.props };
    if (head > 1e-6) {
      const shifted = { ...inner, start };
      if (inner.kind === "video" || inner.kind === "audio") v.in = r4(EditLib.mediaTimeAt(shifted, a));
      else if (inner.kind === "comp") v.in = r4((inner.in || 0) + head);
      v.keyframes = shiftAll(inner.keyframes, head);
      v.transitionIn = undefined;
      if (v.props) EditLib.shiftMasks(v, head);
    }
    if (end - b > 1e-6) v.transitionOut = undefined;
    if (inner.parent) v.parent = prefix + inner.parent;
    if (inner.linkGroup) v.linkGroup = prefix + inner.linkGroup;
    if (inner.linkedId) v.linkedId = prefix + inner.linkedId;
    return v;
  }
  /** Every clip the comp clips in `clips` bring onto the timeline, depth first:
   *  [{…virtual clip, _comp: the comp clip's id (its instance), _on: renders}]. */
  function flatten(doc, clips = doc.clips, opts = {}) {
    const out = [];
    const walk = (list, depth, seen, renders) => {
      for (const c of list || []) {
        if (c.kind !== "comp") continue;
        const comp = getComp(doc, c.compId);
        if (!comp || seen.has(comp.id) || depth >= MAX_DEPTH) continue;
        const on = renders(c);
        const offset = c.start - (c.in || 0), win = [c.start, Math.min(clipEnd(c), c.start - (c.in || 0) + comp.duration)];
        const disabled = new Set(comp.disabledTracks || []);
        const kids = [];
        for (const inner of comp.clips || []) {
          const v = virtualize(inner, c.id + SEP, offset, win, c.id, on && !disabled.has(inner.track));
          if (v) { kids.push(v); out.push(v); }
        }
        const next = new Set(seen); next.add(comp.id);
        walk(kids, depth + 1, next, (x) => x._on);
      }
    };
    walk(clips, 0, new Set(opts.inComp ? [opts.inComp] : []), opts.renders || ((c) => c.disabled !== true));
    return out;
  }
  /** The tracks a comp draws in, bottom first (V1 under V2 …), and its audio tracks. */
  function drawOrder(comp) {
    const tr = compTracks(comp);
    return { video: tr.filter((t) => t.kind === "video").map((t) => t.id).reverse(), audio: tr.filter((t) => t.kind === "audio").map((t) => t.id) };
  }

  /* ── Precompose ── */
  /** Move `ids` (clips on the main timeline or in comp `from`) into a new comp; put a comp clip
   *  in their place. Returns { comp, clip }. Times in the comp start at the earliest clip. */
  function precompose(doc, ids, { id, name, from = null, track } = {}) {
    const host = from ? getComp(doc, from) : doc;
    if (!host) throw new Error(`precompose: no comp ${from}`);
    const set = new Set(ids);
    const moving = (host.clips || []).filter((c) => set.has(c.id));
    if (!moving.length) throw new Error("precompose: none of those clips are there");
    const t0 = Math.min(...moving.map((c) => c.start)), t1 = Math.max(...moving.map(clipEnd));
    const hostTracks = from ? compTracks(host) : (Array.isArray(doc.tracks) && doc.tracks.length ? doc.tracks : DEFAULT_TRACKS);
    const used = [...new Set(moving.map((c) => c.track))];
    const tracks = hostTracks.filter((t) => used.includes(t.id)).map((t) => ({ id: t.id, kind: t.kind }));
    const compId = id || "comp_" + Math.random().toString(36).slice(2, 8);
    if (getComp(doc, compId)) throw new Error(`precompose: comp ${compId} already exists`);
    const comp = {
      id: compId, name: name || "Comp " + ((doc.comps || []).length + 1),
      width: from ? host.width : (doc.width || 1280), height: from ? host.height : (doc.height || 720),
      duration: r4(t1 - t0), tracks,
      clips: moving.map((c) => ({ ...c, start: r4(c.start - t0) })),
    };
    // a hidden track stays hidden inside the comp
    const hidden = (host.disabledTracks || []).filter((t) => used.includes(t));
    if (hidden.length) comp.disabledTracks = hidden;
    // parents outside the moved set can't follow into the comp
    for (const c of comp.clips) if (c.parent && !set.has(c.parent)) delete c.parent;
    const videoTracks = moving.filter((c) => c.kind !== "audio").map((c) => c.track);
    const lane = track || videoTracks.sort((a, b) => (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0))[0] || "V1";
    const clip = { id: "c_" + Math.random().toString(36).slice(2, 9), kind: "comp", compId, mediaId: null, track: lane, start: r4(t0), in: 0, duration: comp.duration, name: comp.name, props: { fit: "none" } };
    host.clips = host.clips.filter((c) => !set.has(c.id));
    host.clips.push(clip);
    // clips that were parented to a moved clip now follow nothing
    for (const c of host.clips) if (c.parent && set.has(c.parent)) delete c.parent;
    doc.comps = [...(doc.comps || []), comp];
    return { comp, clip };
  }

  /** One line per comp for status readouts. */
  function describe(comp) {
    const kinds = {};
    for (const c of comp.clips || []) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    return `${comp.id} "${comp.name}" ${comp.width}x${comp.height} ${comp.duration}s, ${(comp.clips || []).length} clips` +
      (Object.keys(kinds).length ? ` (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")})` : "");
  }

  return { MAX_DEPTH, SEP, DEFAULT_TRACKS, normalizeComp, getComp, usedComps, wouldCycle, usages, compTracks, virtualize, flatten, drawOrder, precompose, describe };
});
