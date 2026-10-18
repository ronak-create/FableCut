/* FableCut project operations: what `fablecut_patch_project` does to a
   project document, the compact project view, and `fablecut_set_project`'s
   checks. No I/O: the MCP server reads and writes project.json around them,
   and the module runs unchanged anywhere else a document needs the same ops,
   validation and messages (it loads in a browser too).

     applyPatch(proj, ops, ctx) → {notes, toSave}
       Applies the ops to proj in place, in order; throws on the first bad op
       (the caller then discards proj). notes are the per-op summaries, toSave
       the [kind, item] presets / templates to write once the project is saved.
       ctx.savedItems(kind) → the saved presets / templates (default none)
       ctx.audioChannels(media) → audio channels of a video file, 0 = none,
                                 null = unknown (insert / overwrite assume 2)
       ctx.checkProfile(id) → throws if id is not an encoding profile
       ctx.mediaInfo(src) → the file's probed details (media-probe.js), null = no
                           such file, undefined = can't tell (relinkMedia / replaceMedia)
     compactView(doc) → the one-line-per-clip summary of fablecut_get_project
     checkProject(doc) → validates and normalizes a whole document in place
                         (fablecut_set_project); throws on the first problem
     timelineEdit(proj, op, refuseLocked, lockReason, ctx) → note (split … crossfade)
     describeScopes(job) · describeScopeLines(stats) · TEXT_ONLY_NOTE · describeTrack(result)
                       → what fablecut_scopes, fablecut_frame and fablecut_track say

   In a browser it loads as a plain script (global `FableCutProjectOps`)
   after the modules it uses, the same way edit-ops.js does. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const dep = (file, name) => (node ? require(file) : root[name]);
  const api = factory(dep("./audio-fx", "FableCutFx"), dep("./edit-ops", "FableCutEdit"), dep("./color", "FableCutColor"),
    dep("./mask", "FableCutMask"), dep("./tracker", "FableCutTracker"), dep("./motion", "FableCutMotion"),
    dep("./comp", "FableCutComp"), dep("./templates", "FableCutTemplates"), dep("./media-lib", "FableCutMedia"),
    dep("./delivery", "FableCutDelivery"));
  if (node) module.exports = api;
  else root.FableCutProjectOps = api;
})(typeof self !== "undefined" ? self : this, function (FX, EditOps, Color, Mask, Tracker, Motion, CompLib, Templates, MediaLib, Delivery) {
  "use strict";

  const DEFAULT_TRACKS = EditOps.DEFAULT_TRACKS;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const basename = (p) => String(p).split(/[\\/]/).pop();

  // the UI persists default-valued props on every clip; the compact view hides
  // them so it only shows what actually deviates
  const PROP_DEFAULTS = {
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
    anchorX: 0, anchorY: 0, trimStart: 0, trimEnd: 100, trimOffset: 0,
    autoOrient: false, motionBlur: 0, motionBlurSamples: 8, pathOffset: 0, pathAlign: "start",
  };

  /* ── Timeline edits (patch ops split … crossfade) ──
     The editor's own edit code (edit-ops.js) run against the document, so an
     agent gets the same targeting (untargetedTracks, or the op's `tracks`), the
     same sync lock (linked partners ride along) and the same lock rules as the
     keyboard shortcuts. Returns a short note; throws to abort the patch. */
  const relinkedDocs = new WeakSet();
  function timelineEdit(proj, op, refuseLocked, lockReason, ctx) {
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
          try { const n = ctx && ctx.audioChannels ? ctx.audioChannels(m) : null; if (n != null) stems = n; } catch { /* no ffprobe: assume stereo */ }
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


  function applyPatch(proj, ops, ctx) {
    const savedItems = (ctx && ctx.savedItems) || (() => []);
    const notes = [];
    const toSave = [];   // [kind, item] — presets / templates written to the library once the project is saved
    const savedList = (kind) => [...savedItems(kind), ...toSave.filter((x) => x[0] === kind).map((x) => x[1])];
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
    // props.tracks written wholesale is validated too (the editor writes them; agents rarely should)
    const checkTracks = (c, label) => {
      if (!c.props || c.props.tracks == null) return;
      if (c.kind !== "video") throw new Error(`${label}: tracks belong to video clips`);
      let n;
      try { n = Tracker.normalizeTracks(c.props.tracks, true); } catch (err) { throw new Error(`${label}: props.${err.message}`); }
      if (n) c.props.tracks = n; else delete c.props.tracks;
    };
    // props.shapes (shape layers) and clip.parent: validated like setShape / setParent
    const NO_MEDIA = ["text", "adjust", "shape", "null", "comp"];
    let inCompId = null;   // set while an inComp op runs its ops inside a comp
    // a comp clip names a comp that exists, and placing it here makes no loop
    const checkCompClip = (c, label) => {
      if (c.kind !== "comp") { if (c.compId != null) throw new Error(`${label}: compId is for kind:"comp" clips`); return; }
      if (typeof c.compId !== "string" || !CompLib.getComp(proj, c.compId))
        throw new Error(`${label}: compId must name a comp in project.comps${(proj.comps || []).length ? ` (${proj.comps.map((x) => x.id).join(", ")})` : " — add one with addComp"}`);
      if (CompLib.wouldCycle(proj, inCompId, c.compId)) throw new Error(`${label}: comp ${c.compId} can't go inside ${inCompId} — that would contain itself`);
      c.props = c.props || {};
      if (c.props.fit == null) c.props.fit = "none";   // a comp shows at its own size unless told otherwise
      if (c.in == null) c.in = 0;
    };
    const checkShapes = (c, label) => {
      if (!c.props || c.props.shapes == null) return;
      if (c.kind !== "shape") throw new Error(`${label}: shapes go on shape clips (kind:"shape")`);
      let n;
      try { n = Motion.normalizeShapes(c.props.shapes, true); } catch (err) { throw new Error(`${label}: props.${err.message}`); }
      if (n) c.props.shapes = n; else delete c.props.shapes;
    };
    const byId = (id) => proj.clips.find((x) => x.id === id) || null;
    // motion blur, auto-orient, text paths and motion-path handles (pin / pout on x / y keys)
    const checkMotion = (c, label) => {
      const p = c.props || {};
      if (p.motionBlur != null && !(typeof p.motionBlur === "number" && p.motionBlur >= 0 && p.motionBlur <= 720)) throw new Error(`${label}: props.motionBlur is a shutter angle 0…720 (0 = off)`);
      if (p.motionBlurSamples != null && !(Number.isInteger(p.motionBlurSamples) && p.motionBlurSamples >= 2 && p.motionBlurSamples <= 32)) throw new Error(`${label}: props.motionBlurSamples is a whole number 2…32`);
      if (p.autoOrient != null && typeof p.autoOrient !== "boolean") throw new Error(`${label}: props.autoOrient is true or false`);
      if (p.pathAlign != null && !["start", "center", "end"].includes(p.pathAlign)) throw new Error(`${label}: props.pathAlign is start | center | end`);
      if (p.textPath != null) {
        if (c.kind !== "text") throw new Error(`${label}: textPath goes on text clips`);
        try { p.textPath = Motion.normalizeTextPath(p.textPath, true); } catch (err) { throw new Error(`${label}: props.${err.message}`); }
      }
      for (const ch of ["x", "y"]) for (const k of (c.keyframes && Array.isArray(c.keyframes[ch]) ? c.keyframes[ch] : []))
        for (const h of ["pin", "pout"]) if (k && k[h] != null && !(typeof k[h] === "number" && Number.isFinite(k[h])))
          throw new Error(`${label}: keyframes.${ch} ${h} must be a number (px, the motion path's curve handle)`);
    };
    const checkParent = (c, label) => {
      if (c.parent == null) { delete c.parent; return; }
      const par = typeof c.parent === "string" && byId(c.parent);
      if (!par) throw new Error(`${label}: parent ${JSON.stringify(c.parent)} is not a clip`);
      if (par.id === c.id || Motion.wouldCycle(c.id, par.id, byId)) throw new Error(`${label}: parenting ${c.id} to ${par.id} makes a loop`);
      if (par.kind === "audio" || par.kind === "adjust" || c.kind === "audio" || c.kind === "adjust")
        throw new Error(`${label}: parenting is for visual clips (video, image, svg, text, shape, null)`);
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
    const applyOps = (opList) => { for (const op of opList) {
      switch (op.op) {
        case "addClip": {
          const c = op.clip;
          if (!c || !c.track || typeof c.start !== "number" || typeof c.duration !== "number")
            throw new Error("addClip needs clip{track, start, duration}");
          c.id = c.id || "c_" + uid();
          if (proj.clips.some((x) => x.id === c.id)) throw new Error("addClip: duplicate clip id " + c.id);
          refuseLocked("addClip", lockedTracks().has(c.track) ? `track ${c.track} is locked` : null, op);
          if (!NO_MEDIA.includes(c.kind) && !proj.media.some((m) => m.id === c.mediaId))
            throw new Error(`addClip: unknown mediaId ${c.mediaId}`);
          if (NO_MEDIA.includes(c.kind)) c.mediaId = null;
          checkMasks(c, "addClip");
          checkShapes(c, "addClip");
          checkParent(c, "addClip");
          checkMotion(c, "addClip");
          checkCompClip(c, "addClip");
          checkTracks(c, "addClip");
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
          if (op.set && op.set.props && "tracks" in op.set.props) checkTracks(c, "updateClip");
          if (op.set && op.set.props && "shapes" in op.set.props) checkShapes(c, "updateClip");
          if (op.set && "parent" in op.set) checkParent(c, "updateClip");
          checkMotion(c, "updateClip");
          if (op.set && ("compId" in op.set || "kind" in op.set)) checkCompClip(c, "updateClip");
          // a track move re-checks the matte too (a clip can't be its own matte)
          checkCompositing(c, "updateClip", op.set && op.set.track ? c.props : op.set && op.set.props);
          if (c.props && c.props.matteTrack && !c.props.matte) delete c.props.matteTrack;   // matte:null clears its track too
          notes.push("~" + op.id);
          break;
        }
        case "removeClip": {
          const doomed = proj.clips.find((x) => x.id === op.id);
          if (doomed) refuseLocked("removeClip", lockReason(doomed), op);
          const n = proj.clips.length;
          // its children stay where they are (at their own start), under its own parent if it has one
          const kids = doomed ? proj.clips.filter((x) => x.parent === op.id).map((x) => x.id) : [];
          if (doomed) EditOps.detachChildren(proj, new Set([op.id]));
          for (const id of kids) notes.push(`~${id}.parent(${byId(id).parent || "none"})`);
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
          m.name = m.name || basename(decodeURIComponent(m.src));
          proj.media.push(m);
          notes.push("+" + m.id);
          break;
        }
        case "updateMedia": {
          // {op:"updateMedia", id | ids, set:{name?, favorite?, tags?, folderId?}, addTags?, removeTags?}
          const ids = op.ids || [op.id];
          if (!ids.length || ids.some((id) => !id)) throw new Error("updateMedia needs id or ids");
          const set = op.set || {};
          const SETTABLE = ["name", "favorite", "tags", "folderId"];
          for (const k of Object.keys(set))
            if (!SETTABLE.includes(k)) throw new Error(`updateMedia: '${k}' not settable (allowed: ${SETTABLE.join(", ")}; metadata such as fps or codec is probed from the file)`);
          if ("folderId" in set && set.folderId != null && !(proj.folders || []).some((f) => f.id === set.folderId))
            throw new Error(`updateMedia: no folder ${set.folderId}`);
          if ("name" in set && !String(set.name || "").trim()) throw new Error("updateMedia: name can't be empty");
          for (const id of ids) {
            const m = proj.media.find((x) => x.id === id);
            if (!m) throw new Error("updateMedia: no media " + id);
            if ("name" in set) m.name = String(set.name).trim().slice(0, 200);
            if ("favorite" in set) { if (set.favorite) m.favorite = true; else delete m.favorite; }
            if ("folderId" in set) m.folderId = set.folderId || null;
            let tags = "tags" in set ? MediaLib.normalizeTags(set.tags) : MediaLib.normalizeTags(m.tags);
            if (op.addTags) tags = MediaLib.normalizeTags([...tags, ...MediaLib.normalizeTags(op.addTags)]);
            if (op.removeTags) { const rm = new Set(MediaLib.normalizeTags(op.removeTags).map((t) => t.toLowerCase())); tags = tags.filter((t) => !rm.has(t.toLowerCase())); }
            if (tags.length) m.tags = tags; else delete m.tags;
            notes.push("~" + id);
          }
          break;
        }
        case "setCollection": {
          // {op:"setCollection", id?, name?, media?:[…], add?:[…], remove?:[…]} — creates it when the id is new
          const list = proj.collections = MediaLib.normalizeCollections(proj.collections, proj.media);
          const known = (ids, what) => {
            if (ids == null) return [];
            if (!Array.isArray(ids)) throw new Error(`setCollection: ${what} must be a list of media ids`);
            for (const id of ids) if (!proj.media.some((m) => m.id === id)) throw new Error(`setCollection: no media ${id}`);
            return ids.map(String);
          };
          let col = op.id ? list.find((c) => c.id === op.id) : null;
          if (!col && !op.id && op.name) col = list.find((c) => c.name.toLowerCase() === String(op.name).trim().toLowerCase()) || null;
          const fresh = !col;
          if (fresh) {
            if (!op.name) throw new Error("setCollection: a new collection needs a name");
            col = { id: op.id ? String(op.id) : "col_" + uid(), name: "", media: [] };
            list.push(col);
          }
          if (op.name != null) col.name = String(op.name).trim().slice(0, 80) || col.name || "Collection";
          if (op.media != null) col.media = [...new Set(known(op.media, "media"))];
          for (const id of known(op.add, "add")) if (!col.media.includes(id)) col.media.push(id);
          const rm = new Set(known(op.remove, "remove"));
          col.media = col.media.filter((id) => !rm.has(id));
          notes.push((fresh ? "+" : "~") + col.id + `(${col.media.length})`);
          break;
        }
        case "removeCollection": {
          const list = MediaLib.normalizeCollections(proj.collections, proj.media);
          const n = list.length;
          proj.collections = list.filter((c) => c.id !== op.id);
          if (proj.collections.length === n) throw new Error("removeCollection: no collection " + op.id);
          if (!proj.collections.length) delete proj.collections;
          notes.push("-" + op.id);
          break;
        }
        case "relinkMedia": case "replaceMedia": {
          // relink: the same footage found somewhere else — clips keep their In points.
          // replace: a different file behind the same media entry (a new render, a
          // better take) — clips keep their timing, trimmed to fit a shorter file.
          const name = op.op;
          const m = proj.media.find((x) => x.id === op.id);
          if (!m) throw new Error(`${name}: no media ${op.id}`);
          const src = String(op.src || "");
          if (!/^\/(media|library)\//.test(src)) throw new Error(`${name}: src must be a /media/… or /library/… path (import the file first with fablecut_import_media)`);
          const info = ctx.mediaInfo ? ctx.mediaInfo(src) : undefined;
          if (info === null) throw new Error(`${name}: no file at ${src}`);
          const kindOf = MediaLib.kindFromName(src);
          if (kindOf && kindOf !== m.kind && !(m.kind === "audio" && kindOf === "video"))   // an audio entry may sit in a video container
            throw new Error(`${name}: ${src} is ${kindOf === "audio" || kindOf === "image" ? "an" : "a"} ${kindOf} file, but ${m.id} is ${m.kind}`);
          const was = { duration: m.duration };
          m.src = src;
          for (const k of MediaLib.INFO_KEYS) delete m[k];
          if (name === "replaceMedia") {
            m.name = op.name ? String(op.name).trim().slice(0, 200) : MediaLib.srcName(src);
            delete m.duration; delete m.width; delete m.height;
          } else if (op.name) m.name = String(op.name).trim().slice(0, 200);
          if (info) {
            for (const k of MediaLib.INFO_KEYS) if (info[k] != null) m[k] = info[k];
            if (info.duration > 0 && m.kind !== "image" && m.kind !== "svg") m.duration = info.duration;
            if (info.width > 0) { m.width = info.width; m.height = info.height; }
          }
          let note = `~${m.id}→${MediaLib.srcName(src)}`;
          if (name === "relinkMedia" && was.duration > 0 && m.duration > 0 && Math.abs(was.duration - m.duration) > 0.1)
            note += ` (warning: ${m.duration}s, the media was ${was.duration}s — is it the same footage?)`;
          if (name === "replaceMedia" && m.duration > 0) {
            // keep every clip's In and timing, trimmed to fit the new file
            let trimmed = 0;
            const fit = (clips) => {
              for (const c of clips || []) {
                if (c.mediaId !== m.id || c.kind === "image" || c.kind === "svg") continue;
                const speed = (c.props && +c.props.speed) || 1;
                const maxIn = Math.max(0, m.duration - 0.001);
                if ((+c.in || 0) > maxIn) { c.in = +maxIn.toFixed(3); trimmed++; }
                const maxDur = Math.max(0.05, (m.duration - (+c.in || 0)) / speed);
                if (c.duration > maxDur + 1e-6) { c.duration = +maxDur.toFixed(3); trimmed++; }
              }
            };
            fit(proj.clips);
            for (const comp of proj.comps || []) fit(comp.clips);
            if (trimmed) note += ` (${trimmed} clip edge${trimmed === 1 ? "" : "s"} trimmed to the new file's ${m.duration}s)`;
          }
          notes.push(note);
          break;
        }
        case "removeMedia": {
          const used = proj.clips.find((c) => c.mediaId === op.id);
          if (used) throw new Error(`removeMedia: media ${op.id} is used by clip ${used.id}`);
          for (const comp of proj.comps || []) {
            const inner = (comp.clips || []).find((c) => c.mediaId === op.id);
            if (inner) throw new Error(`removeMedia: media ${op.id} is used by clip ${inner.id} in comp ${comp.id}`);
          }
          const n = proj.media.length;
          proj.media = proj.media.filter((x) => x.id !== op.id);
          if (proj.media.length === n) throw new Error("removeMedia: no media " + op.id);
          if (proj.collections) proj.collections = MediaLib.normalizeCollections(proj.collections, proj.media);
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
        case "setShape":
        case "removeShape": {
          // {op:"setShape", id | ids, shape?: index | "name" | "2.0" (group path), set:{…}, replace?:true, remove?:true}
          const name = op.op;
          const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
          if (!ids.length) throw new Error(`${name} needs id or ids`);
          const remove = name === "removeShape" || op.remove === true;
          if (remove && op.shape == null) throw new Error(`${name} needs shape: an index, a name or a path like "2.0"`);
          if (!remove && (op.set == null || typeof op.set !== "object" || Array.isArray(op.set))) throw new Error("setShape needs set:{type?, x?, y?, w?, h?, fill?, …} (or remove:true)");
          const isPath = (v) => Array.isArray(v) || (typeof v === "string" && /^\d+(\.\d+)*$/.test(v.trim()));
          for (const id of ids) {
            const c = byId(id);
            if (!c) throw new Error(`${name}: no clip ${id}`);
            if (c.kind !== "shape") throw new Error(`${name}: ${id} is a ${c.kind} clip — shapes go on shape clips (addClip kind:"shape")`);
            refuseLocked(name, lockReason(c), op);
            const where = `${name}: ${id}`;
            let list = (Motion.normalizeShapes(c.props?.shapes) || []).slice();
            // the target as a path [i, j…]; its last index may be one past the end (= add there)
            let path, named = null;
            if (op.shape == null) path = [list.length];
            else if (Number.isInteger(op.shape) && op.shape >= 0) path = [op.shape];
            else if (isPath(op.shape)) path = (Array.isArray(op.shape) ? op.shape : op.shape.trim().split(".")).map(Number);
            else if (typeof op.shape === "string" && op.shape.trim()) {
              path = Motion.itemPaths(list).find((q) => Motion.getItem(list, q).name === op.shape.trim());
              if (!path) { if (remove) throw new Error(`${where} has no shape named ${JSON.stringify(op.shape)}`); path = [list.length]; named = op.shape.trim(); }
            } else throw new Error(`${name}: shape is an index (0 = first), a name or a path like "2.0"`);
            if (path.some((i) => !Number.isInteger(i) || i < 0)) throw new Error(`${name}: bad shape path ${JSON.stringify(op.shape)}`);
            const parentPath = path.slice(0, -1), last = path[path.length - 1];
            const group = parentPath.length ? Motion.getItem(list, parentPath) : null;
            if (parentPath.length && (!group || group.type !== "group")) throw new Error(`${where}: ${parentPath.join(".")} is not a group`);
            const siblings = group ? group.items : list;
            const it = siblings[last];
            if (remove) {
              if (!it) throw new Error(`${where} has no shape ${JSON.stringify(op.shape)}${list.length ? ` (it has ${Motion.describe(list)})` : ""}`);
              list = Motion.updateItem(list, path, () => null);
            } else if (!it) {
              if (last !== siblings.length) throw new Error(`${where}: ${parentPath.length ? `group ${parentPath.join(".")}` : "the layer"} has ${siblings.length} item(s) — use index ${siblings.length} (or leave shape out) to add one`);
              if (!op.set.type) throw new Error(`${where}: a new shape needs set.type (${Motion.TYPES.join(" | ")})`);
              let next;
              try { next = Motion.normalizeItem({ ...op.set, ...(named && !op.set.name ? { name: named } : {}) }, true, "shape"); }
              catch (err) { throw new Error(`${where}: ${err.message}`); }
              list = group ? Motion.updateItem(list, parentPath, (g) => ({ ...g, items: [...g.items, next] })) : [...list, next];
            } else {
              let next;
              const base = op.replace ? { type: it.type, name: it.name, ...(it.type === "group" ? { items: it.items } : {}) } : it;
              try { next = Motion.mergeItem(base, op.set, true); }
              catch (err) { throw new Error(`${where}: ${err.message}`); }
              list = Motion.updateItem(list, path, () => next);
            }
            let n;
            try { n = Motion.normalizeShapes(list, true); } catch (err) { throw new Error(`${where}: ${err.message}`); }
            c.props = c.props || {};
            if (n) c.props.shapes = n; else delete c.props.shapes;
            notes.push(`~${id}.shapes(${Motion.describe(n) || "none"})`);
          }
          break;
        }
        case "setParent": {
          // {op:"setParent", id | ids, parent: "c_…" | null, keep?: true, at?: seconds}
          const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
          if (!ids.length) throw new Error("setParent needs id or ids");
          if (op.parent !== null && typeof op.parent !== "string") throw new Error("setParent needs parent: a clip id (or null to unparent)");
          if (op.at != null && typeof op.at !== "number") throw new Error("setParent: at is a timeline time in seconds");
          for (const id of ids) {
            const c = byId(id);
            if (!c) throw new Error("setParent: no clip " + id);
            refuseLocked("setParent", lockReason(c), op);
            const prev = c.parent;
            c.parent = op.parent;
            try { checkParent(c, `setParent: ${id}`); } finally { if (prev) c.parent = prev; else delete c.parent; }
            if (op.keep !== false) {
              const t = op.at != null ? Math.min(Math.max(op.at, c.start), c.start + c.duration) : c.start;
              const v = Motion.reparentValues(c, op.parent, byId, t);
              c.props = c.props || {};
              for (const [k, val] of Object.entries(v)) if (!c.keyframes?.[k]?.length) c.props[k] = val;
            }
            if (op.parent) c.parent = op.parent; else delete c.parent;
            notes.push(`~${id}.parent(${op.parent || "none"})`);
          }
          break;
        }
        case "setMotionPath": {
          // {op:"setMotionPath", id | ids, path?: "smooth" | "straight", autoOrient?: bool}
          const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
          if (!ids.length) throw new Error("setMotionPath needs id or ids");
          if (op.path != null && !["smooth", "straight"].includes(op.path)) throw new Error('setMotionPath: path is "smooth" (curve through the position keys) or "straight"');
          if (op.autoOrient != null && typeof op.autoOrient !== "boolean") throw new Error("setMotionPath: autoOrient is true or false");
          if (op.path == null && op.autoOrient == null) throw new Error('setMotionPath needs path:"smooth"|"straight" and / or autoOrient');
          for (const id of ids) {
            const c = byId(id);
            if (!c) throw new Error("setMotionPath: no clip " + id);
            if (c.kind === "audio" || c.kind === "adjust") throw new Error(`setMotionPath: ${id} is a ${c.kind} clip`);
            refuseLocked("setMotionPath", lockReason(c), op);
            if (op.path) {
              if (Motion.posKeys(c).length < 2) throw new Error(`setMotionPath: ${id} needs x and y keyed together at two or more times first (the position keys)`);
              c.keyframes = op.path === "smooth" ? Motion.smoothPath(c.keyframes) : Motion.straightPath(c.keyframes);
            }
            if (op.autoOrient != null) { c.props = c.props || {}; if (op.autoOrient) c.props.autoOrient = true; else delete c.props.autoOrient; }
            notes.push(`~${id}.motionPath(${Motion.posKeys(c).length} keys${Motion.hasPathHandles(c) ? ", curved" : ""}${c.props && c.props.autoOrient ? ", auto-orient" : ""})`);
          }
          break;
        }
        case "setTextPath": {
          // {op:"setTextPath", id | ids, path: "line" | "arc" | "circle" | "wave" | {type, …} | null, offset?, align?}
          const ids = Array.isArray(op.ids) ? op.ids : op.id != null ? [op.id] : [];
          if (!ids.length) throw new Error("setTextPath needs id or ids");
          if (op.path === undefined && op.offset == null && op.align == null) throw new Error("setTextPath needs path (a preset name, a shape item or null), offset and / or align");
          let item;
          if (op.path === null) item = null;
          else if (typeof op.path === "string") {
            if (!Motion.TEXT_PATH_PRESETS[op.path]) throw new Error(`setTextPath: path is ${Object.keys(Motion.TEXT_PATH_PRESETS).join(" | ")}, a shape item or null`);
            item = Motion.normalizeTextPath(Motion.TEXT_PATH_PRESETS[op.path], true);
          } else if (op.path !== undefined) {
            try { item = Motion.normalizeTextPath(op.path, true); } catch (err) { throw new Error(`setTextPath: ${err.message}`); }
          }
          if (op.offset != null && typeof op.offset !== "number") throw new Error("setTextPath: offset is % of the path's length");
          if (op.align != null && !["start", "center", "end"].includes(op.align)) throw new Error("setTextPath: align is start | center | end");
          for (const id of ids) {
            const c = byId(id);
            if (!c) throw new Error("setTextPath: no clip " + id);
            if (c.kind !== "text") throw new Error(`setTextPath: ${id} is a ${c.kind} clip — text paths go on text clips`);
            refuseLocked("setTextPath", lockReason(c), op);
            c.props = c.props || {};
            if (op.path !== undefined) { if (item) c.props.textPath = JSON.parse(JSON.stringify(item)); else delete c.props.textPath; }
            if (op.offset != null) c.props.pathOffset = op.offset;
            if (op.align != null) c.props.pathAlign = op.align;
            notes.push(`~${id}.textPath(${c.props.textPath ? c.props.textPath.type : "none"})`);
          }
          break;
        }
        case "addComp": {
          // {op:"addComp", comp:{id?, name, width?, height?, duration, background?, tracks?, clips?:[…]}}
          const src = op.comp;
          if (!src || typeof src !== "object") throw new Error("addComp needs comp:{name, duration, …}");
          const id = src.id || "comp_" + uid();
          if (CompLib.getComp(proj, id)) throw new Error(`addComp: comp ${id} already exists`);
          let comp;
          try { comp = CompLib.normalizeComp({ ...src, id, clips: [] }, true, proj); } catch (err) { throw new Error(`addComp: ${err.message}`); }
          if (!comp.tracks) comp.tracks = CompLib.DEFAULT_TRACKS.map((t) => ({ ...t }));
          proj.comps = [...(proj.comps || []), comp];
          notes.push(`+comp ${id}`);
          // its clips go in through the same checks as addClip
          if (Array.isArray(src.clips) && src.clips.length) applyOps([{ op: "inComp", comp: id, ops: src.clips.map((clip) => ({ op: "addClip", clip })) }]);
          break;
        }
        case "updateComp": {
          // {op:"updateComp", id, set:{name?, width?, height?, duration?, background?, tracks?}}
          const comp = CompLib.getComp(proj, op.id);
          if (!comp) throw new Error("updateComp: no comp " + op.id);
          const set = op.set || {};
          for (const k of Object.keys(set)) if (!["name", "width", "height", "duration", "background", "tracks", "disabledTracks"].includes(k))
            throw new Error(`updateComp: ${k} can't be set here (name, width, height, duration, background, tracks, disabledTracks) — edit its clips with inComp`);
          const next = { ...comp, ...set };
          for (const [k, v] of Object.entries(set)) if (v === null) delete next[k];
          let n;
          try { n = CompLib.normalizeComp(next, true, proj); } catch (err) { throw new Error(`updateComp: ${err.message}`); }
          proj.comps = proj.comps.map((c) => (c.id === comp.id ? n : c));
          notes.push(`~comp ${comp.id}`);
          break;
        }
        case "removeComp": {
          const comp = CompLib.getComp(proj, op.id);
          if (!comp) throw new Error("removeComp: no comp " + op.id);
          const used = CompLib.usages(proj, comp.id);
          if (used.length) throw new Error(`removeComp: ${comp.id} is used by ${used.map((u) => u.clip.id + (u.in ? ` (in ${u.in})` : "")).join(", ")} — remove those clips first`);
          proj.comps = proj.comps.filter((c) => c.id !== comp.id);
          notes.push(`-comp ${comp.id}`);
          break;
        }
        case "precompose": {
          // {op:"precompose", ids:[…], name?, id?} — the clips (here, or inside the comp an inComp op is in) move into a new comp
          const ids = Array.isArray(op.ids) ? op.ids : [];
          if (!ids.length) throw new Error("precompose needs ids:[…] (the clips to move into the new comp)");
          for (const id of ids) {
            const c = proj.clips.find((x) => x.id === id);
            if (!c) throw new Error("precompose: no clip " + id + (inCompId ? ` in comp ${inCompId}` : ""));
            refuseLocked("precompose", lockReason(c), op);
          }
          const doc = { clips: proj.clips, comps: proj.comps || [], tracks: proj.tracks, width: proj.width, height: proj.height };
          let r;
          try { r = CompLib.precompose(doc, ids, { id: op.id, name: op.name }); } catch (err) { throw new Error(err.message); }
          proj.clips = doc.clips; proj.comps = doc.comps;
          r.clip.id = "c_" + uid();
          notes.push(`+comp ${r.comp.id} (${ids.length} clips) +${r.clip.id}`);
          break;
        }
        case "applyPreset": {
          // {op:"applyPreset", id | ids, preset: name | {anchor, length, keys…}, length?, at?} — at: timeline seconds, for an "at" (emphasis) preset
          const ids = Array.isArray(op.ids) ? op.ids : op.id ? [op.id] : [];
          if (!ids.length) throw new Error("applyPreset needs id or ids:[…]");
          let p;
          try { p = Templates.findPreset(op.preset, savedList("presets")); } catch (err) { throw new Error(`applyPreset: ${err.message}`); }
          if (!p) throw new Error(`applyPreset: no preset ${JSON.stringify(op.preset)} — built in: ${Templates.PRESETS.map((x) => x.id).join(", ")}` +
            (savedList("presets").length ? `; saved: ${savedList("presets").map((x) => x.id).join(", ")}` : ""));
          if (op.length != null && !(typeof op.length === "number" && op.length > 0)) throw new Error("applyPreset: length is seconds, more than 0");
          for (const id of ids) {
            const c = proj.clips.find((x) => x.id === id);
            if (!c) throw new Error("applyPreset: no clip " + id + (inCompId ? ` in comp ${inCompId}` : ""));
            if (c.kind === "audio" || c.kind === "adjust") throw new Error(`applyPreset: clip ${id} is ${c.kind} — presets animate visual clips`);
            refuseLocked("applyPreset", lockReason(c), op);
            Templates.applyPreset(c, p, { length: op.length, at: typeof op.at === "number" ? op.at - c.start : undefined });
          }
          notes.push(`~${ids.join(",")}.${p.id}`);
          break;
        }
        case "addTemplate": {
          // {op:"addTemplate", template: name | {…}, start?, track?, duration?, fields?:{key: value}, id?, compId?, name?}
          let t;
          try { t = Templates.findTemplate(op.template, savedList("templates")); } catch (err) { throw new Error(`addTemplate: ${err.message}`); }
          if (!t) throw new Error(`addTemplate: no template ${JSON.stringify(op.template)} — built in: ${Templates.TEMPLATES.map((x) => x.id).join(", ")}` +
            (savedList("templates").length ? `; saved: ${savedList("templates").map((x) => x.id).join(", ")}` : ""));
          let r;
          try {
            r = Templates.instantiate(proj, t, { compId: op.compId || "comp_" + uid(), clipId: op.id || "c_" + uid(), name: op.name,
              start: typeof op.start === "number" ? op.start : 0, track: op.track || "V2", duration: op.duration, fields: op.fields });
          } catch (err) { throw new Error(`addTemplate: ${err.message}`); }
          notes.push(`+comp ${r.comp.id} (${t.id})`);
          applyOps([{ op: "addClip", clip: r.clip }]);   // the same checks as any clip: track, locks
          break;
        }
        case "setTemplate": {
          // {op:"setTemplate", id: comp clip id | comp id, fields?:{key: value}, duration?}
          let comp = CompLib.getComp(proj, op.id);
          if (!comp) { const c = proj.clips.find((x) => x.id === op.id && x.kind === "comp"); comp = c && CompLib.getComp(proj, c.compId); }
          if (!comp) throw new Error("setTemplate: no template clip or comp " + op.id);
          if (!comp.template) throw new Error(`setTemplate: comp ${comp.id} isn't a placed template — edit its clips with inComp`);
          try {
            for (const [k, v] of Object.entries(op.fields || {})) Templates.setField(comp, Templates.slug(k), v, proj);
            if (op.duration != null) {
              const old = comp.duration;
              Templates.retime(comp, op.duration);
              // clips that showed the comp to its end keep doing so
              for (const u of CompLib.usages(proj, comp.id)) if (Math.abs((+u.clip.in || 0) + u.clip.duration - old) < 1e-3) u.clip.duration = +(comp.duration - (+u.clip.in || 0)).toFixed(4);
            }
          } catch (err) { throw new Error(`setTemplate: ${err.message}`); }
          notes.push(`~template ${comp.id}`);
          break;
        }
        case "savePreset": {
          // {op:"savePreset", id: clip id, name, anchor?:"in"|"out"|"whole", from?, to?} (clip seconds) or {op:"savePreset", preset:{…}}
          let p;
          try {
            if (op.preset) p = Templates.normalizePreset(op.preset, true);
            else {
              const c = proj.clips.find((x) => x.id === op.id);
              if (!c) throw new Error("no clip " + op.id);
              const times = Object.values(c.keyframes || {}).flat().map((x) => x.t);
              if (!times.length) throw new Error(`clip ${c.id} has no keyframes to save`);
              const anchor = op.anchor || "in";
              p = Templates.presetFromClip(c, { name: op.name, anchor,
                from: typeof op.from === "number" ? op.from : anchor === "out" ? Math.min(...times) : 0,
                to: typeof op.to === "number" ? op.to : anchor === "in" ? Math.max(...times) : c.duration });
            }
          } catch (err) { throw new Error(`savePreset: ${err.message}`); }
          p = Templates.asSaved(p, "presets");
          toSave.push(["presets", p]);
          notes.push(`saved preset ${p.id} → library/presets/${p.id}.json`);
          break;
        }
        case "saveTemplate": {
          // {op:"saveTemplate", comp, name?, fields?, hold?} or {op:"saveTemplate", template:{…}}
          let t;
          try {
            if (op.template) t = Templates.normalizeTemplate(op.template, true);
            else {
              const comp = CompLib.getComp(proj, op.comp);
              if (!comp) throw new Error("no comp " + op.comp);
              t = Templates.templateFromComp(comp, { name: op.name, fields: op.fields, hold: op.hold, media: proj.media });
            }
          } catch (err) { throw new Error(`saveTemplate: ${err.message}`); }
          t = Templates.asSaved(t, "templates");
          toSave.push(["templates", t]);
          notes.push(`saved template ${t.id} → library/templates/${t.id}.json`);
          break;
        }
        case "inComp": {
          // {op:"inComp", comp, ops:[…clip / timeline ops…]} — run ops on the comp's own clips and tracks
          const comp = CompLib.getComp(proj, op.comp);
          if (!comp) throw new Error("inComp: no comp " + op.comp);
          if (!Array.isArray(op.ops)) throw new Error("inComp needs ops:[…]");
          const allowed = ["addClip", "updateClip", "removeClip", "setGrade", "setGradeLayer", "setMask", "removeMask", "setMaskKeys", "setMatte",
            "setShape", "removeShape", "setParent", "setMotionPath", "setTextPath", "setFx", "setFxKeys", "precompose", "inComp",
            "applyPreset", "addTemplate", "setTemplate",
            "split", "rippleDelete", "closeGap", "lift", "extract", "rippleTrim", "roll", "slip", "slide", "crossfade"];
          for (const o of op.ops) {
            if (!o || !allowed.includes(o.op)) throw new Error(`inComp: ${o && o.op} can't run inside a comp (clip and timeline ops only: ${allowed.join(", ")})`);
            // the same target rule as fxTarget: no id means master, A… a track, B… a bus — none of them live in a comp
            const fxAt = o.target || (o.id && /^A\d+$/.test(o.id) ? "track" : o.id && /^B\d+$/.test(o.id) ? "bus" : o.id ? "clip" : "master");
            if ((o.op === "setFx" || o.op === "setFxKeys") && fxAt !== "clip")
              throw new Error(`inComp: ${o.op} inside a comp works on its clips only (target:"clip", id) — the ${fxAt} effects are the main timeline's`);
          }
          const keep = { clips: proj.clips, tracks: proj.tracks, width: proj.width, height: proj.height, lockedTracks: proj.lockedTracks,
            untargetedTracks: proj.untargetedTracks, disabledTracks: proj.disabledTracks, inPoint: proj.inPoint, outPoint: proj.outPoint };
          const prevIn = inCompId;
          Object.assign(proj, { clips: comp.clips || [], tracks: CompLib.compTracks(comp), width: comp.width, height: comp.height,
            lockedTracks: [], untargetedTracks: [], disabledTracks: comp.disabledTracks || [], inPoint: null, outPoint: null });
          inCompId = comp.id;
          const n0 = notes.length;
          try { applyOps(op.ops); }
          finally {
            const live = CompLib.getComp(proj, comp.id) || comp;
            live.clips = proj.clips;
            inCompId = prevIn;
            Object.assign(proj, keep);
          }
          const inner = notes.splice(n0);
          notes.push(`${comp.id}{${inner.join(" ")}}`);
          break;
        }
        case "removeTrack": {
          // {op:"removeTrack", id, track: "name" | index} — what follows it keeps its keys
          const c = proj.clips.find((x) => x.id === op.id);
          if (!c) throw new Error("removeTrack: no clip " + op.id);
          refuseLocked("removeTrack", lockReason(c), op);
          const list = Tracker.normalizeTracks(c.props?.tracks) || [];
          const i = typeof op.track === "string" ? list.findIndex((t) => t.name === op.track) : op.track;
          if (!list[i]) throw new Error(`removeTrack: ${op.id} has no track ${JSON.stringify(op.track)}${list.length ? ` (it has ${Tracker.describe(list)})` : ""}`);
          list.splice(i, 1);
          if (list.length) c.props.tracks = list; else delete c.props.tracks;
          notes.push(`~${op.id}.tracks(${Tracker.describe(list) || "none"})`);
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
          const allowed = ["name", "width", "height", "fps", "background", "markers", "disabledTracks", "lockedTracks", "untargetedTracks", "exportFrame", "encodeProfile", "delivery", "outputs", "master", "inPoint", "outPoint"];
          for (const [k, v] of Object.entries(op.set || {})) {
            if (!allowed.includes(k)) throw new Error(`setProject: '${k}' not settable (allowed: ${allowed.join(", ")})`);
            if ((k === "inPoint" || k === "outPoint") && v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0))
              throw new Error(`setProject: ${k} must be seconds ≥ 0 (null clears it)`);
            if (k === "encodeProfile" && v != null) {
              if (ctx && ctx.checkProfile) ctx.checkProfile(String(v)); // validate id exists
            }
            if (k === "delivery" && v != null) {
              // a preset id or a spec → the complete spec, so the editor and agents read the same thing
              if (typeof v !== "string" && (typeof v !== "object" || Array.isArray(v)))
                throw new Error("setProject: delivery is a preset id ('youtube') or a spec {preset?, width?, height?, fps?, video?, audio?, …}");
              const n = Delivery.normalize(v, { presets: (ctx && ctx.deliveryPresets) || {} });
              if (typeof v === "string" && !Delivery.PRESETS[v] && !(ctx && ctx.deliveryPresets && ctx.deliveryPresets[v]))
                throw new Error(`setProject: no delivery preset "${v}" (built-in: ${Delivery.PRESET_IDS.join(", ")})`);
              proj.delivery = n.spec;
              notes.push(`delivery ${n.spec.preset}: ${Delivery.describe(n.spec)}${n.notes.length ? ` (adjusted: ${n.notes.join("; ")})` : ""}`);
              continue;
            }
            if (k === "outputs" && v != null) {
              // the batch list: each entry a preset id or a spec, stored complete with {id, on}
              if (!Array.isArray(v) || v.length > 16) throw new Error("setProject: outputs is a list of up to 16 delivery specs (or preset ids)");
              const presets = (ctx && ctx.deliveryPresets) || {};
              proj.outputs = v.map((o, i) => {
                if (typeof o !== "string" && (!o || typeof o !== "object" || Array.isArray(o))) throw new Error(`setProject: outputs[${i}] is a preset id or a spec`);
                if (typeof o === "string" && !Delivery.PRESETS[o] && !presets[o]) throw new Error(`setProject: outputs[${i}]: no delivery preset "${o}"`);
                const n = Delivery.normalize(o, { presets });
                const id = typeof o === "object" && typeof o.id === "string" && o.id ? o.id.slice(0, 40) : "o_" + uid();
                return { id, on: !(typeof o === "object" && o.on === false), ...n.spec };
              });
              if (!proj.outputs.length) delete proj.outputs;
              notes.push(`outputs: ${(proj.outputs || []).map((o) => Delivery.projectFilename(o, proj)).join(", ") || "none"}`);
              continue;
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
          notes.push(timelineEdit(proj, op, refuseLocked, lockReason, ctx));
          break;
        default:
          throw new Error("Unknown op: " + op.op + " (addClip|updateClip|removeClip|addMedia|updateMedia|removeMedia|relinkMedia|replaceMedia|setCollection|removeCollection|setProject|setTrack|setBus|removeBus|setFx|setFxKeys|setGrade|setGradeLayer|setMask|removeMask|setMaskKeys|setMatte|removeTrack|setShape|removeShape|setParent|setMotionPath|setTextPath|" +
            "split|rippleDelete|closeGap|lift|extract|rippleTrim|roll|slip|slide|insert|overwrite|crossfade|" +
            "addComp|updateComp|removeComp|precompose|inComp|applyPreset|addTemplate|setTemplate|savePreset|saveTemplate)");
      }
    } };
    applyOps(ops);
    return { notes, toSave };
  }

  /** opts.offline(media) → true when the media's file is missing;
   *  opts.proxy(media) → its proxy's height (540, 720…) or null. */
  function compactView(doc, opts = {}) {
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
        if (k === "masks" || k === "tracks" || k === "shapes" || k === "textPath") continue;   // summarized below — point lists and samples are long
        if (hex(PROP_DEFAULTS[k]) !== hex(v)) kept[k] = v;
      }
      const masks = Mask.describe(Mask.normalizeMasks(o.masks)), tracks = Tracker.describe(Tracker.normalizeTracks(o.tracks));
      const shapes = Motion.describe(Motion.normalizeShapes(o.shapes));
      const tp = o.textPath && Motion.normalizeTextPath(o.textPath);
      if (tp) kept.textPath = tp.type + (tp.points ? `(${tp.points.length})` : tp.w ? ` ${tp.w}×${tp.h}` : "");
      return (Object.keys(kept).length ? " " + JSON.stringify(kept) : "") + (shapes ? ` [${shapes}]` : "") + (masks ? ` [${masks}]` : "") + (tracks ? ` [tracks: ${tracks}]` : "");
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
      ...(() => {
        const uses = MediaLib.usageCounts(doc);
        return doc.media.map((m) => {
          const info = MediaLib.describe(m);
          return `  ${m.id} ${m.kind} "${m.name}"${m.duration ? " " + m.duration + "s" : ""}` +
            (info ? ` ${info.replace(/ · /g, " ")}` : "") +
            (opts.offline && opts.offline(m) ? " OFFLINE (file missing — relinkMedia)" : "") +
            (opts.proxy && m.kind === "video" && opts.proxy(m) ? ` proxy:${opts.proxy(m)}p` : "") +
            (m.favorite ? " ★" : "") + (m.tags && m.tags.length ? " " + m.tags.map((t) => "#" + t.replace(/\s+/g, "_")).join(" ") : "") +
            (m.folderId ? ` folder:${m.folderId}` : "") + ` uses:${uses.get(m.id) || 0}` +
            (m.derivedFrom ? ` (${m.denoise ? "denoised " + m.denoise : "derived"} from ${m.derivedFrom})` : "");
        });
      })(),
      ...(doc.collections && doc.collections.length
        ? [`COLLECTIONS (${doc.collections.length}): ` + doc.collections.map((c) => `${c.id} "${c.name}" [${(c.media || []).join(",")}]`).join(" · ")]
        : []),
      `CLIPS (${doc.clips.length}), by track/time:`,
      ...doc.clips
        .slice()
        .sort((a, b) => (a.track === b.track ? a.start - b.start : String(a.track).localeCompare(b.track)))
        .map((c) => {
          const kf = c.keyframes ? " kf:" + Object.entries(c.keyframes).map(([k, v]) => `${k}(${v.length})`).join(",") +
            (Motion.hasPathHandles(c) ? " path:curved" : "") : "";
          const tr = (c.transitionIn ? ` in:${c.transitionIn.type}/${c.transitionIn.duration}` : "") +
                     (c.transitionOut ? ` out:${c.transitionOut.type}/${c.transitionOut.duration}` : "");
          const r3 = (n) => Math.round(n * 1000) / 1000;
          return `  ${c.id} ${c.track} ${r3(c.start)}s+${r3(c.duration)}s ${c.kind}` +
            (c.mediaId ? `(${c.mediaId}${c.in ? ` in:${r3(c.in)}` : ""})` : "") +
            (c.kind === "comp" ? `(${c.compId}${c.in ? ` in:${r3(c.in)}` : ""})` : "") +
            (c.name ? ` "${c.name}"` : "") + (c.parent ? ` parent:${c.parent}` : "") + fmtProps(c.props, c.kind) + kf + tr +
            (c.locked === true ? " [locked]" : "") + (c.disabled === true ? " [disabled]" : "") +
            (c.unlinked === true ? " [unlinked]" : "") + fxTag(c.fx);
        }),
      ...(Array.isArray(doc.comps) && doc.comps.length ? [`COMPS (${doc.comps.length}) — edit their clips with {op:"inComp", comp, ops:[…]}:`,
        ...doc.comps.flatMap((comp) => [`  ${CompLib.describe(comp)}`,
          ...(comp.template ? [`    template ${comp.template.id} — fields (setTemplate): ` + (comp.template.fields || []).map((f) => {
            const v = Templates.fieldValue(comp, f);
            return `${f.key}=${typeof v === "string" ? JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v) : v}`;
          }).join(" ")] : []),
          ...(comp.clips || []).slice().sort((a, b) => a.start - b.start).map((c) => {
          const r3 = (n) => Math.round(n * 1000) / 1000;
          return `    ${c.id} ${c.track} ${r3(c.start)}s+${r3(c.duration)}s ${c.kind}` + (c.mediaId ? `(${c.mediaId})` : "") + (c.kind === "comp" ? `(${c.compId})` : "") +
            (c.name ? ` "${c.name}"` : "") + (c.parent ? ` parent:${c.parent}` : "") + fmtProps(c.props, c.kind);
        })])] : []),
      `(compact view — full JSON: fablecut_get_project without compact; edit via fablecut_patch_project)`,
    ];
    return lines.join("\n");
  }

  function checkProject(doc) {
    if (doc.collections != null) {
      if (!Array.isArray(doc.collections)) throw new Error("collections must be a list of {id, name, media:[…]}");
      doc.collections = MediaLib.normalizeCollections(doc.collections, doc.media || []);
    }
    for (const m of doc.media || []) {
      if (m && m.tags != null) { const t = MediaLib.normalizeTags(m.tags); if (t.length) m.tags = t; else delete m.tags; }
      if (m && m.favorite != null && m.favorite !== true) delete m.favorite;
    }
    if (doc.comps != null) {
      if (!Array.isArray(doc.comps)) throw new Error("comps must be a list of compositions");
      // saved as normalized (trimmed id, default name and size, rounded duration)
      try { doc.comps = doc.comps.map((comp) => CompLib.normalizeComp(comp, true, doc)); } catch (err) { throw new Error(err.message); }
      const seen = new Set();
      for (const comp of doc.comps) {
        if (seen.has(comp.id)) throw new Error(`two comps have the id ${comp.id} — comp ids must be unique`);
        seen.add(comp.id);
      }
    }
    // the same checks for clips on the timeline and clips inside comps
    const checkClip = (c, where) => {
      const at = where ? `comp ${where}: ` : "";
      if (!c.id || !c.track || typeof c.start !== "number" || typeof c.duration !== "number")
        throw new Error(`${at}clip ${c.id || "?"} needs id, track, numeric start and duration`);
      if (!["text", "adjust", "shape", "null", "comp"].includes(c.kind) && !doc.media.some((m) => m.id === c.mediaId))
        throw new Error(`${at}clip ${c.id} references unknown mediaId ${c.mediaId}`);
      if (c.kind === "comp" && !CompLib.getComp(doc, c.compId)) throw new Error(`${at}clip ${c.id} references unknown compId ${c.compId}`);
      if (c.kind === "comp" && where && CompLib.wouldCycle(doc, where, c.compId))
        throw new Error(`comp ${where}: clip ${c.id} uses comp ${c.compId}, which is missing or would contain itself`);
      if (c.kind === "shape" && c.props && c.props.shapes != null) {
        let n;
        try { n = Motion.normalizeShapes(c.props.shapes, true); } catch (err) { throw new Error(`${at}clip ${c.id}: props.${err.message}`); }
        if (n) c.props.shapes = n; else delete c.props.shapes;
      }
    };
    for (const c of doc.clips) checkClip(c, null);
    for (const comp of doc.comps || []) for (const c of comp.clips) checkClip(c, comp.id);
  }

  const TEXT_ONLY_NOTE = [
    "Measured, not described: these are brightness, dominant colours, texture (detail within the",
    "frame) and change-since-the-previous-sample. They cannot tell you the subject — a person, a",
    "car, a landscape, text on screen. To choose footage by what it shows, use a vision-capable",
    "model and drop `text:true`, or stay with fablecut_analyze_reference for structure.",
  ].join("\n");

  /** color.js scopeStats → text lines, for fablecut_frame {text:true} in timeline
   *  mode. Same measurements fablecut_scopes reports, so a text-only agent gets
   *  the composed picture described on the same terms as a source frame. */
  function describeScopeLines(st) {
    const L = st.luma, cast = st.cast;
    const bright = L.mean < 0.12 ? "very dark" : L.mean < 0.35 ? "dark" : L.mean < 0.65 ? "mid" : L.mean < 0.85 ? "bright" : "very bright";
    return [
      `${bright} (luma mean ${L.mean}, median ${L.median}, range ${L.min}–${L.max})`,
      `  clipped: black ${st.clipped.blackPct}% · white ${st.clipped.whitePct}%`,
      `  mean rgb [${st.rgbMean.join(", ")}] · saturation ${st.saturation}`,
      `  colour cast: ${cast.tone === "neutral" ? "neutral" : `${cast.tone} (hue ${cast.hue}°), strength ${cast.strength}`}`,
    ].join("\n");
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

  function describeTrack(t) {
    return [
      t.tracked ? `Tracked ${t.clip} "${t.track}" (${t.kind}) ${t.from}–${t.to} s: ${t.samples} samples, match quality min ${t.quality.min} · mean ${t.quality.mean}`
        : `Used the stored track "${t.track}" on ${t.clip} (${t.from}–${t.to} s, ${t.samples} samples)`,
      t.lostAt && t.lostAt.length ? `Lost the region at ${t.lostAt.join(", ")} s — the track stops there (pick a spot with more detail, or a larger region, and track on from there)` : "",
      t.cancelled ? "Cancelled — kept what was tracked so far." : "",
      t.applied ? `Applied → ${t.applied}` : "Stored only (apply it with apply:{mask} or apply:{clip}).",
      `Project revision ${t.revision}.`,
    ].filter(Boolean).join("\n");
  }

  return { applyPatch, compactView, checkProject, timelineEdit, PROP_DEFAULTS,
    TEXT_ONLY_NOTE, describeScopeLines, describeScopes, describeTrack };
});
