/* FableCut timeline edit operations — split, ripple delete, close gap,
   lift / extract, insert / overwrite, ripple / roll / slip / slide trims and
   crossfades. Zero dependencies. Loaded by the editor as a plain script
   (global `FableCutEdit`) and required by the MCP server, so an agent's patch
   op and the editor's keyboard shortcut run the very same code.

   The ops mutate a project document in place and know nothing about the DOM,
   undo or selection — the editor wraps them with those. `create(env)` binds
   them to a timeline:
     doc()            → the project document (read on every call; may be swapped)
     tracks()         → live lanes, [{id, kind}] top→bottom
     trackLocked(id)  · trackTargeted(id)
     uid()            → short random id
     mediaTimeAt(c,t) → source time at timeline t (optional; default handles speed ramps)
     onRemove(c)      → a clip left the timeline (optional — the editor frees its media element)
     onPlace(m, c)    → Source clips landed (optional — waveforms, channel stems)
     defaultProps()   → props for newly placed clips (optional, default {})
     ignoreLocks      → treat nothing as locked (an agent's force:true)
   `forDoc(doc, opts)` builds the env from the document itself (its tracks,
   lockedTracks and untargetedTracks) for headless callers. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./mask") : root.FableCutMask, node ? require("./tracker") : root.FableCutTracker);
  if (node) module.exports = api;
  else root.FableCutEdit = api;
})(typeof self !== "undefined" ? self : this, function (MaskLib, TrackLib) {
  "use strict";

  const MIN_DUR = 0.05;
  const MIN_TRANS_DUR = 0.1;
  const CROSSFADE_DUR = 1;
  const GAP_EPS = 1e-4;
  const TRIM_EPS = 1e-3;
  const XF_EPS = 0.02;
  const TRIM_LOCKED = "Locked — unlock the clip or its track to edit";
  const DEFAULT_TRACKS = [
    { id: "V3", kind: "video" }, { id: "V2", kind: "video" }, { id: "V1", kind: "video" },
    { id: "A1", kind: "audio" }, { id: "A2", kind: "audio" }, { id: "A3", kind: "audio" }, { id: "A4", kind: "audio" },
  ];

  /* ── Pure clip helpers ── */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clipEnd = (c) => c.start + c.duration;
  const clipSpeed = (c) => clamp(+(c.props?.speed) || 1, 0.1, 8);
  const isMediaClip = (c) => c.kind === "video" || c.kind === "audio";
  const EASE = {
    linear: (u) => u,
    "ease-in": (u) => u * u,
    "ease-out": (u) => 1 - (1 - u) * (1 - u),
    "ease-in-out": (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  };
  function kfChannel(c, key, local, fallback) {
    const kfs = c.keyframes?.[key];
    if (!Array.isArray(kfs) || !kfs.length) return fallback;
    if (local <= kfs[0].t) return kfs[0].v;
    if (local >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v;
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i], b = kfs[i + 1];
      if (local >= a.t && local <= b.t) {
        const u = (local - a.t) / Math.max(1e-6, b.t - a.t);
        const ez = EASE[b.ease || "ease-in-out"] || EASE.linear;
        return a.v + (b.v - a.v) * ez(u);
      }
    }
    return fallback;
  }
  function hasSpeedRamp(c) {
    return Array.isArray(c.keyframes?.speed) && c.keyframes.speed.length > 0;
  }
  /** Source time at timeline time t: in + ∫speed (trapezoid, 1/120 s steps). */
  function mediaTimeAt(c, t) {
    const base = clipSpeed(c);
    const local = clamp(t - c.start, 0, c.duration);
    if (!hasSpeedRamp(c)) return c.in + local * base;
    const step = 1 / 120;
    let sum = 0, prev = clamp(kfChannel(c, "speed", 0, base), 0.1, 8);
    for (let lt = step; lt < local + step; lt += step) {
      const at = Math.min(local, lt);
      const cur = clamp(kfChannel(c, "speed", at, base), 0.1, 8);
      sum += ((prev + cur) / 2) * (at - (lt - step));
      prev = cur;
    }
    return c.in + sum;
  }
  /* Rebase clip-local keyframe times by -offset, dropping ones outside [0, dur] */
  function shiftKF(kfs, offset, dur) {
    if (!kfs) return undefined;
    const out = {};
    for (const [k, arr] of Object.entries(kfs)) {
      const a = arr.map((kf) => ({ ...kf, t: +(kf.t - offset).toFixed(4) }))
        .filter((kf) => kf.t >= -1e-3 && kf.t <= dur + 1e-3);
      if (a.length) out[k] = a;
    }
    return Object.keys(out).length ? out : undefined;
  }
  /** A clip's head moved by `offset` s: its mask keys and track samples follow, like shiftKF does for keyframes. */
  function shiftMasks(c, offset) {
    if (!offset || !c.props) return;
    const ms = c.props.masks, ts = c.props.tracks;
    if (MaskLib && Array.isArray(ms)) {
      const next = MaskLib.shiftKeys(ms, offset);
      if (next !== ms) c.props = { ...c.props, masks: next };
    }
    if (TrackLib && Array.isArray(ts)) {
      const next = TrackLib.shiftTracks(ts, offset);
      c.props = { ...c.props };
      if (next.length) c.props.tracks = next; else delete c.props.tracks;
    }
  }
  /** Default stereo pan for an isolated linked stem (L −1, R +1, else center). */
  function defaultPanForChannel(ch) {
    if (ch === 0) return -1;
    if (ch === 1) return 1;
    return 0;
  }

  function create(env) {
    const P = () => env.doc();
    const uid = env.uid || (() => Math.random().toString(36).slice(2, 9));
    const timeAt = env.mediaTimeAt || mediaTimeAt;
    const removed = (c) => { if (env.onRemove) env.onRemove(c); };
    const getMedia = (id) => P().media.find((m) => m.id === id);
    const getClip = (id) => P().clips.find((c) => c.id === id) || null;
    const dropClips = (pred) => {
      const project = P();
      const keep = [];
      for (const x of project.clips) { if (pred(x)) removed(x); else keep.push(x); }
      project.clips = keep;
    };

    /* ── Targeting, locks, links ── */
    const isTrackLocked = (id) => !env.ignoreLocks && env.trackLocked(id);
    const isEditTarget = (id) => env.trackTargeted(id) && !isTrackLocked(id);
    const isClipLocked = (c) => !!c && !env.ignoreLocks && (c.locked === true || isTrackLocked(c.track));
    const isGroupLocked = (c) => withLinked([c]).some(isClipLocked);
    /** Drop every clip whose linked group is locked. */
    const withoutLocked = (clips) => clips.filter((c) => !isGroupLocked(c));
    const editTargetTracks = () => env.tracks().filter((tr) => isEditTarget(tr.id));

    /* Expand a clip list so each AV-linked partner is included once.
       Supports N-way `linkGroup` (video + per-channel stems) and legacy pairwise `linkedId`. */
    function withLinked(clips) {
      const out = new Map();
      const groups = new Set();
      for (const c of clips) {
        out.set(c.id, c);
        if (c.linkGroup) groups.add(c.linkGroup);
        else {
          const L = c.linkedId ? getClip(c.linkedId) : null;
          if (L) out.set(L.id, L);
        }
      }
      if (groups.size) {
        for (const x of P().clips) {
          if (x.linkGroup && groups.has(x.linkGroup)) out.set(x.id, x);
        }
      }
      return [...out.values()];
    }
    /* Rebuild AV linkGroups: video + audio clips that share mediaId and the
       same start/in/duration belong together (e.g. picture + L/R/C stems from
       one file). A clip the user unlinked carries `unlinked: true` and is never
       re-paired. Legacy pairwise linkedId is cleared in favor of linkGroup. */
    function relinkClips() {
      const project = P();
      const near = (a, b) => Math.abs((+a || 0) - (+b || 0)) < 1e-3;
      // A denoised copy of a file (media.derivedFrom) still pairs with its picture.
      const baseOf = (id) => getMedia(id)?.derivedFrom || id;
      for (const c of project.clips) {
        delete c.linkGroup;
        delete c.linkedId;
      }
      const audios = project.clips.filter((c) => c.kind === "audio" && c.mediaId && c.unlinked !== true);
      const used = new Set();
      for (const v of project.clips) {
        if (v.kind !== "video" || !v.mediaId || v.unlinked === true) continue;
        const partners = audios.filter((a) =>
          !used.has(a.id) &&
          baseOf(a.mediaId) === v.mediaId &&
          near(a.start, v.start) &&
          near(a.in, v.in) &&
          near(a.duration, v.duration)
        );
        if (!partners.length) continue;
        const lg = "lg_" + uid();
        v.linkGroup = lg;
        for (const a of partners) {
          a.linkGroup = lg;
          used.add(a.id);
        }
      }
    }

    /* ── Split ── */
    /* Cut a clip at timeline time t (must fall strictly inside the clip). Leaves
       the left piece as `c` and appends the right piece. */
    function splitClipAt(c, t) {
      if (!(t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR)) return null;
      const cut = t - c.start;
      const right = {
        ...c, id: "c_" + uid(), props: { ...c.props },
        start: t, in: +(timeAt(c, t)).toFixed(4), duration: clipEnd(c) - t,
        keyframes: shiftKF(c.keyframes, cut, clipEnd(c) - t),
        transitionIn: undefined,
        linkedId: undefined,
        linkGroup: undefined,
      };
      shiftMasks(right, cut);
      c.duration = cut;
      c.keyframes = shiftKF(c.keyframes, 0, cut);
      c.transitionOut = undefined;
      P().clips.push(right);
      return right;
    }
    /* After splitting a set of clips, wire each new right half to its partner's right half. */
    function relinkSplitRights(targets, newLink) {
      const newGroups = new Map(); // old linkGroup -> new linkGroup for right halves
      for (const c of targets) {
        const right = newLink.get(c.id);
        if (!right) continue;
        if (c.linkGroup) {
          if (!newGroups.has(c.linkGroup)) newGroups.set(c.linkGroup, "lg_" + uid());
          right.linkGroup = newGroups.get(c.linkGroup);
        } else {
          const partner = c.linkedId ? newLink.get(c.linkedId) : null;
          if (partner) {
            right.linkedId = partner.id;
            partner.linkedId = right.id;
          } else {
            delete right.linkedId;
          }
        }
      }
    }
    /** Split `pool` (default: clips on the targeted tracks) at t, linked
     *  partners included. Returns {split, blocked}: right halves made, and
     *  whether locked clips under t were left whole. */
    function splitAt(t, pool) {
      const project = P();
      pool = pool || project.clips.filter((c) => isEditTarget(c.track));
      const straddlers = pool.filter((c) => t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR);
      const targets = withoutLocked(withLinked(straddlers));
      const newLink = new Map(); // oldClipId -> newRight
      for (const c of targets) {
        const right = splitClipAt(c, t);
        if (right) newLink.set(c.id, right);
      }
      relinkSplitRights(targets, newLink);
      return { split: newLink.size, blocked: targets.length < withLinked(straddlers).length, rights: [...newLink.values()] };
    }
    /** Split the targeted tracks at several times (IN and OUT), right to left
     *  so each cut still lands on the left-hand piece. Returns pieces made. */
    function splitAtTimes(times) {
      const project = P();
      const hit = (c) => times.some((t) => t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR);
      const targets = withoutLocked(withLinked(project.clips.filter((c) => isEditTarget(c.track) && hit(c))));
      let n = 0;
      for (const t of times.slice().sort((a, b) => b - a)) {
        const atT = targets.filter((c) => t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR);
        const newLink = new Map();
        for (const c of atT) {
          const right = splitClipAt(c, t);
          if (right) newLink.set(c.id, right);
        }
        relinkSplitRights(atT, newLink);
        n += newLink.size;
      }
      return n;
    }
    /** Discard clip heads before t0 and tails after t1 on the targeted tracks
     *  (either may be null); linked partners get the identical trim. Clips
     *  wholly outside go. Returns how many clips changed or went. */
    function trimToRange(t0In, t1In) {
      const project = P();
      const onTrack = (c) => isEditTarget(c.track) && !isGroupLocked(c);
      const doomed = new Set();
      let changed = 0;
      // Sync lock: linked partners ride along even on untargeted tracks.
      const targets = withoutLocked(withLinked(project.clips.filter((c) => onTrack(c))));
      for (const c of targets) {
        const start = c.start, end = clipEnd(c);
        let t0 = start, t1 = end;
        if (t0In != null) t0 = Math.max(t0, t0In);
        if (t1In != null) t1 = Math.min(t1, t1In);
        if (t1 - t0 < MIN_DUR) { doomed.add(c.id); continue; }
        const dIn = t0 - start;
        if (dIn > 1e-6) {
          c.start = t0;
          if (isMediaClip(c)) c.in += dIn * clipSpeed(c);
          else c.in = 0;
          c.duration -= dIn;
          c.keyframes = shiftKF(c.keyframes, dIn, c.duration);
          shiftMasks(c, dIn);
          c.transitionIn = undefined;
          changed++;
        }
        if (clipEnd(c) - t1 > 1e-6) {
          c.duration = Math.max(MIN_DUR, t1 - c.start);
          c.keyframes = shiftKF(c.keyframes, 0, c.duration);
          c.transitionOut = undefined;
          changed++;
        }
      }
      if (doomed.size) dropClips((c) => doomed.has(c.id));
      return changed + doomed.size;
    }

    /* ── Delete ── */
    /** Remove clips (their linked partners too). Locked groups stay.
     *  Returns {removed, blocked}. */
    function removeClips(clips) {
      const picked = withLinked(clips);
      const doomed = withoutLocked(picked);
      const ids = new Set(doomed.map((c) => c.id));
      if (ids.size) dropClips((x) => ids.has(x.id));
      return { removed: doomed, blocked: doomed.length < picked.length };
    }
    /** Remove clips and pull later clips left on each targeted track to close
     *  the hole (per-track ripple). Returns {removed, blocked}. */
    function rippleDelete(clips) {
      const project = P();
      const picked = withLinked(clips);
      const doomed = withoutLocked(picked);
      const result = { removed: doomed, blocked: doomed.length < picked.length };
      if (!doomed.length) return result;
      const byTrack = new Map();
      for (const c of doomed) {
        if (!byTrack.has(c.track)) byTrack.set(c.track, []);
        byTrack.get(c.track).push(c);
      }
      const ids = new Set(doomed.map((c) => c.id));
      dropClips((x) => ids.has(x.id));
      const eps = 1e-6;
      // Merged removed ranges per targeted, unlocked track.
      const rangesByTrack = new Map();
      for (const [trackId, gone] of byTrack) {
        if (!isEditTarget(trackId)) continue;
        const ranges = gone.map((c) => [c.start, clipEnd(c)]).sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const [s, e] of ranges) {
          const last = merged[merged.length - 1];
          if (last && s <= last[1] + eps) last[1] = Math.max(last[1], e);
          else merged.push([s, e]);
        }
        rangesByTrack.set(trackId, merged);
      }
      const shiftFor = (ranges, p) => {
        let d = 0;
        for (const [s, e] of ranges) if (e <= p + eps) d += e - s;
        return d;
      };
      // Sync lock: a linked group shifts ONCE by the union of its member tracks'
      // ranges (partners on untargeted tracks ride along) — never once per track.
      // Unlinked clips use their own track's ranges.
      const grouped = new Map(), groups = [], solo = [];
      for (const c of project.clips) {
        if (grouped.has(c.id)) continue;
        const members = withLinked([c]);
        if (members.length === 1) { solo.push(c); continue; }
        const g = { tracks: new Set(members.map((x) => x.track)), clips: members };
        groups.push(g);
        for (const x of members) grouped.set(x.id, g);
      }
      for (const c of solo) {
        if (isClipLocked(c)) continue; // locked clips stay put
        const d = shiftFor(rangesByTrack.get(c.track) || [], c.start);
        if (d > 0) c.start = Math.max(0, +(c.start - d).toFixed(4));
      }
      for (const g of groups) {
        if (g.clips.some(isClipLocked)) continue; // a locked member pins the whole group
        const all = [];
        for (const tid of g.tracks) {
          const r = rangesByTrack.get(tid);
          if (r) all.push(...r);
        }
        if (!all.length) continue;
        all.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const [s, e] of all) {
          const last = merged[merged.length - 1];
          if (last && s <= last[1] + eps) last[1] = Math.max(last[1], e);
          else merged.push([s, e]);
        }
        for (const c of g.clips) {
          const d = shiftFor(merged, c.start);
          if (d > 0) c.start = Math.max(0, +(c.start - d).toFixed(4));
        }
      }
      return result;
    }

    /* ── Gaps ── */
    /* Gap under t on one track, or null if a clip covers t.
       Empty track → [0, +Infinity]. Trailing void → gapEnd = +Infinity. */
    function gapAt(trackId, t) {
      const clips = P().clips.filter((c) => c.track === trackId).sort((a, b) => a.start - b.start);
      for (const c of clips) {
        if (c.start <= t && t < clipEnd(c)) return null;
      }
      let gapStart = 0;
      for (const c of clips) {
        if (clipEnd(c) <= t) gapStart = Math.max(gapStart, clipEnd(c));
      }
      let gapEnd = Infinity;
      for (const c of clips) {
        if (c.start > t) gapEnd = Math.min(gapEnd, c.start);
      }
      return { gapStart, gapEnd };
    }
    /* Sync-safe close: every targeted track must have a gap at t; close the
       intersection of those gaps by shifting later clips on those tracks.
       Locked tracks are not targets, and locked clips stay put. Returns the
       seconds closed, or a string saying why nothing was. */
    function closeGapAt(t) {
      const enabled = editTargetTracks();
      if (!enabled.length) return "No targeted tracks — click a track name to target it";
      let L = 0, R = Infinity;
      for (const tr of enabled) {
        const g = gapAt(tr.id, t);
        if (!g) return `No gap on ${tr.id} — untarget the track or move the playhead`;
        L = Math.max(L, g.gapStart);
        R = Math.min(R, g.gapEnd);
      }
      const G = R - L;
      if (!isFinite(R) || G <= GAP_EPS) return "Nothing to close at playhead";
      // Sync lock: linked partners ride along even on untargeted tracks.
      const movers = withoutLocked(withLinked(P().clips.filter((c) => isEditTarget(c.track) && c.start >= R - GAP_EPS)));
      if (!movers.length) return "Nothing to close at playhead";
      for (const c of movers) c.start = Math.max(0, c.start - G);
      return G;
    }
    /* Aligned gaps on targeted tracks inside [t0, t1] — same notion as closeGapAt. */
    function listAlignedGaps(t0, t1) {
      const enabled = editTargetTracks();
      if (!enabled.length || t1 - t0 <= GAP_EPS) return [];
      const edges = new Set([t0, t1]);
      for (const c of P().clips) {
        if (!isEditTarget(c.track)) continue;
        const s = c.start, e = clipEnd(c);
        if (s > t0 && s < t1) edges.add(s);
        if (e > t0 && e < t1) edges.add(e);
      }
      const ts = [...edges].sort((a, b) => a - b);
      const gaps = [];
      const seen = new Set();
      for (let i = 0; i < ts.length - 1; i++) {
        const a = ts[i], b = ts[i + 1];
        if (b - a <= GAP_EPS) continue;
        const mid = (a + b) / 2;
        let L = -Infinity, R = Infinity;
        let ok = true;
        for (const tr of enabled) {
          const g = gapAt(tr.id, mid);
          if (!g) { ok = false; break; }
          L = Math.max(L, g.gapStart);
          R = Math.min(R, g.gapEnd);
        }
        if (!ok) continue;
        L = Math.max(L, t0);
        R = Math.min(isFinite(R) ? R : t1, t1);
        if (R - L <= GAP_EPS) continue;
        const key = L.toFixed(5) + ":" + R.toFixed(5);
        if (seen.has(key)) continue;
        seen.add(key);
        gaps.push({ L, R });
      }
      gaps.sort((a, b) => a.L - b.L);
      return gaps;
    }

    /* ── Insert / overwrite (three-point editing) ── */
    /** Lanes a Source edit of media `m` lands on: [picture, ...stems] for video.
     *  Source patching follows track targeting — the preferred lane (V1 / A1 / V3
     *  for SVG) when it is targeted and unlocked, else the lowest-numbered lane
     *  that is. Resolved against the live track list, since any lane can be
     *  removed. For video, `picture` is null when no video lane is a target (the
     *  edit lands audio-only); for other media an empty list means nowhere to go. */
    function sourceEditTracks(m, stems = 2) {
      const byNum = (x, y) => (parseInt(x.slice(1), 10) || 0) - (parseInt(y.slice(1), 10) || 0);
      const targets = (kind) => env.tracks().filter((t) => t.kind === kind && isEditTarget(t.id))
        .map((t) => t.id).sort(byNum);
      const lanes = targets(m.kind === "audio" ? "audio" : "video");
      const preferred = m.kind === "audio" ? "A1" : m.kind === "svg" ? "V3" : "V1";
      const pictureTrack = lanes.includes(preferred) ? preferred : lanes[0] || null;
      if (m.kind === "video") return [pictureTrack, ...targets("audio").slice(0, stems)];
      return pictureTrack ? [pictureTrack] : [];
    }
    /** Tracks punched by Replace: placement lanes, plus any overlapping linked
     *  AV stems on A3+ (`audioChannel` set). Leaves V2/V3 and standalone music alone. */
    function sourceReplacePunchTracks(m, t0, t1, stems) {
      const eps = 1e-6;
      const tracks = new Set(sourceEditTracks(m, stems).filter(Boolean));
      if (m.kind === "video") {
        for (const c of P().clips) {
          if (c.kind !== "audio" || c.props?.audioChannel == null) continue;
          if (clipEnd(c) <= t0 + eps || c.start >= t1 - eps) continue;
          if (isEditTarget(c.track)) tracks.add(c.track);
        }
      }
      return [...tracks];
    }
    /** Place Source window clips at `at` (no timeline surgery) on the lanes
     *  sourceEditTracks picked. With no targeted video lane the picture is
     *  dropped and only the stems land. Returns the main clip, or the first
     *  stem when only audio landed, or null. */
    function placeSourceWindowClips(m, inn, duration, at, stems) {
      const project = P();
      const [pictureTrack, ...stemTracks] = sourceEditTracks(m, stems);
      const base = () => ({ ...(env.defaultProps ? env.defaultProps() : {}) });
      const name = String(m.name || "").replace(/\.[^.]+$/, "");
      const start = +at.toFixed(4);
      const innR = +inn.toFixed(4);
      const durR = +duration.toFixed(4);
      const lg = "lg_" + uid();
      let c = null;
      if (pictureTrack) {
        c = {
          id: "c_" + uid(), mediaId: m.id, kind: m.kind, track: pictureTrack,
          start, in: innR, duration: durR, name,
          props: base(),
        };
        project.clips.push(c);
      }
      if (m.kind === "video") {
        if (c) { c.props.volume = 0; c.linkGroup = lg; }
        let firstStem = null;
        for (let ch = 0; ch < stemTracks.length; ch++) {
          const stem = {
            id: "c_" + uid(), mediaId: m.id, kind: "audio", track: stemTracks[ch],
            start, in: innR, duration: durR, name,
            props: { ...base(), audioChannel: ch, pan: defaultPanForChannel(ch) },
            linkGroup: lg,
          };
          project.clips.push(stem);
          firstStem = firstStem || stem;
        }
        if (env.onPlace) env.onPlace(m, c);
        return c || firstStem;
      }
      if (env.onPlace) env.onPlace(m, c);
      return c;
    }
    /** Open a hole on one track over [t0, t1) — trim / split / delete overlaps.
     *  Sync lock: linked partners are punched too, even on untargeted tracks.
     *  Locked groups are left whole (the new clip overlaps them).
     *  Caller must relinkClips() afterwards — split pieces lose their linkGroup. */
    function punchTrackRange(trackId, t0, t1) {
      const project = P();
      const eps = 1e-6;
      if (!(t1 > t0 + eps)) return;
      const drop = (x) => { removed(x); project.clips = project.clips.filter((y) => y !== x); };
      const victims = withLinked(project.clips.filter((x) => x.track === trackId));
      for (const c of victims) {
        if (!project.clips.includes(c)) continue; // already removed this pass
        if (isGroupLocked(c)) continue; // locked clips are never trimmed or removed
        const end = clipEnd(c);
        if (end <= t0 + eps || c.start >= t1 - eps) continue;
        // Fully inside the replace window
        if (c.start >= t0 - eps && end <= t1 + eps) { drop(c); continue; }
        // Spans both edges → keep head + tail, drop middle
        if (c.start < t0 - eps && end > t1 + eps) {
          const right = splitClipAt(c, t0);
          if (!right) {
            // Split refused — an edge sits within MIN_DUR of t0. Don't leave the
            // clip covering the punched range; keep the substantial side.
            if (t0 - c.start > MIN_DUR) {
              // Tail past t0 is the stub → keep the head, end it at t0.
              c.duration = +(t0 - c.start).toFixed(4);
              c.transitionOut = undefined;
              c.keyframes = shiftKF(c.keyframes, 0, c.duration);
            } else if (end - t1 >= MIN_DUR) {
              // Head is the stub → keep the tail, start it at t1.
              const oldStart = c.start;
              c.in = +(timeAt(c, t1)).toFixed(4);
              c.duration = +(end - t1).toFixed(4);
              c.start = +t1.toFixed(4);
              c.transitionIn = undefined;
              c.keyframes = shiftKF(c.keyframes, t1 - oldStart, c.duration);
              shiftMasks(c, t1 - oldStart);
            } else {
              // Stubs on both sides → effectively inside the window.
              drop(c);
            }
            continue;
          }
          if (clipEnd(right) <= t1 + eps) {
            drop(right);
          } else {
            const tail = splitClipAt(right, t1);
            if (tail) {
              drop(right);
            } else {
              right.duration = +(t1 - right.start).toFixed(4);
              right.transitionOut = undefined;
              right.keyframes = shiftKF(right.keyframes, 0, right.duration);
            }
          }
          continue;
        }
        // Head overhang: ends inside the window → trim Out to t0
        if (c.start < t0 - eps && end > t0 + eps) {
          const cut = t0 - c.start;
          c.duration = +cut.toFixed(4);
          c.transitionOut = undefined;
          c.keyframes = shiftKF(c.keyframes, 0, c.duration);
          continue;
        }
        // Tail overhang: starts inside the window → trim In to t1
        if (c.start < t1 - eps && end > t1 + eps) {
          const oldStart = c.start;
          c.in = +(timeAt(c, t1)).toFixed(4);
          c.duration = +(end - t1).toFixed(4);
          c.start = +t1.toFixed(4);
          c.transitionIn = undefined;
          c.keyframes = shiftKF(c.keyframes, t1 - oldStart, c.duration);
          shiftMasks(c, t1 - oldStart);
        }
      }
    }
    /** Premiere-style Insert: place media `m` (source in → in + duration) at
     *  timeline `at` and ripple later clips on the targeted tracks right.
     *  Straddling clips on those tracks are split first (linked partners too);
     *  an `at` inside the unsplittable MIN_DUR zone snaps to the nearby cut.
     *  Returns {clip, at} or a string saying why it could not. */
    function insertAt(m, inn, duration, at, stems) {
      const project = P();
      if (!sourceEditTracks(m, stems).some(Boolean))
        return "No targeted track for this media — click a track name to target it (and unlock it)";
      at = Math.max(0, at);
      const onTrack = (c) => isEditTarget(c.track);
      const eps = 1e-6;
      for (const c of project.clips) {
        if (!onTrack(c)) continue;
        if (at > c.start - eps && at <= c.start + MIN_DUR) { at = c.start; break; }
        if (at >= clipEnd(c) - MIN_DUR && at < clipEnd(c) + eps) { at = clipEnd(c); break; }
      }
      // Open a seam at `at` so the ripple can push the right halves.
      const toSplit = withoutLocked(withLinked(project.clips.filter((c) =>
        onTrack(c) && at > c.start + MIN_DUR && at < clipEnd(c) - MIN_DUR
      )));
      if (toSplit.length) {
        const newLink = new Map();
        for (const c of toSplit) {
          const right = splitClipAt(c, at);
          if (right) newLink.set(c.id, right);
        }
        relinkSplitRights(toSplit, newLink);
      }
      // Sync lock: linked partners ride along even on untargeted tracks; locked
      // groups stay put.
      const movers = withoutLocked(withLinked(project.clips.filter((c) => onTrack(c) && c.start >= at - eps)));
      for (const c of movers) c.start = +(c.start + duration).toFixed(4);
      return { clip: placeSourceWindowClips(m, inn, duration, at, stems), at };
    }
    /** Premiere-style Overwrite: place media at `at`, punching the destination
     *  tracks over [at, at + duration) — no ripple. Returns {clip, at} or why not. */
    function overwriteAt(m, inn, duration, at, stems) {
      if (!sourceEditTracks(m, stems).some(Boolean))
        return "No targeted track for this media — click a track name to target it (and unlock it)";
      at = Math.max(0, at);
      const t1 = at + duration;
      for (const tid of sourceReplacePunchTracks(m, at, t1, stems)) punchTrackRange(tid, at, t1);
      relinkClips(); // re-pair head/tail pieces across tracks after punch splits
      return { clip: placeSourceWindowClips(m, inn, duration, at, stems), at };
    }

    /* ── Trim tools: ripple, roll, slip, slide · range lift / extract ──
       Each op edits from the current state by `delta` seconds of timeline time and
       returns the delta it actually applied — clamped to the source media, MIN_DUR
       and the free room on the track — or a string saying why it refuses (a lock,
       a clip with no source time). The editor's drag gesture restores its
       start-of-drag snapshot before every call, so the ops stay stateless and a
       drag can swing back and forth freely. Sync lock as everywhere else: linked
       partners take the identical trim, ripples shift the targeted tracks (plus
       the edited clip's own), and locked groups never move. */

    /** Longest this clip may run before it runs out of source media. */
    function maxClipDur(c) {
      if (!isMediaClip(c)) return Infinity;
      const m = getMedia(c.mediaId);
      if (!m || !(m.duration > 0)) return Infinity;
      return Math.max(MIN_DUR, (m.duration - c.in) / clipSpeed(c));
    }
    /* A linked group shares its timing, but a partner may run at a different
       speed (links are inferred from timing alone), so every source limit is the
       tightest across the whole group, never just the clip that was grabbed. */
    /** Longest c's linked group may run before any member runs out of source. */
    function groupMaxDur(c) {
      return Math.min(...withLinked([c]).map(maxClipDur));
    }
    /** How far c's group can pull its head back before any member reaches source 0. */
    function groupHeadRoom(c) {
      return Math.min(...withLinked([c]).map((x) => (isMediaClip(x) ? x.in / clipSpeed(x) : Infinity)));
    }
    /** The clip butting against c's head ("in") or tail ("out") on its track. */
    function adjacentClip(c, side) {
      const t = side === "in" ? c.start : clipEnd(c);
      return P().clips.find((x) => x !== c && x.track === c.track &&
        Math.abs((side === "in" ? clipEnd(x) : x.start) - t) < TRIM_EPS) || null;
    }
    /** Empty room on c's track before its head / after its tail. */
    function freeRoom(c, side) {
      let room = side === "in" ? c.start : Infinity;
      for (const x of P().clips) {
        if (x === c || x.track !== c.track) continue;
        if (side === "in" && clipEnd(x) <= c.start + TRIM_EPS) room = Math.min(room, c.start - clipEnd(x));
        if (side === "out" && x.start >= clipEnd(c) - TRIM_EPS) room = Math.min(room, x.start - clipEnd(c));
      }
      return Math.max(0, room);
    }
    function clampTransitions(c) {
      for (const k of ["transitionIn", "transitionOut"])
        if (c[k] && c[k].duration > c.duration) c[k] = { ...c[k], duration: +c.duration.toFixed(3) };
    }
    /** Set the tail of c and its linked partners (same timing, so same math). */
    function trimGroupTail(c, dur) {
      for (const x of withLinked([c])) {
        x.duration = +dur.toFixed(4);
        x.keyframes = shiftKF(x.keyframes, 0, x.duration);
        clampTransitions(x);
      }
    }
    /** Cut `d` seconds off the head of c and its partners (d < 0 extends it).
     *  moveStart: the head edge moves on the timeline (roll / slide); otherwise
     *  the clip keeps its start and only its source In advances (ripple). */
    function trimGroupHead(c, d, moveStart) {
      for (const x of withLinked([c])) {
        if (moveStart) x.start = +(x.start + d).toFixed(4);
        if (isMediaClip(x)) x.in = +(x.in + d * clipSpeed(x)).toFixed(4);
        x.duration = +(x.duration - d).toFixed(4);
        x.keyframes = shiftKF(x.keyframes, d, x.duration);
        shiftMasks(x, d);
        clampTransitions(x);
      }
    }
    const clampD = (d, lo, hi) => Math.min(hi, Math.max(lo, d));

    /** Ripple trim: move c's head or tail and shift everything after it, so
     *  no gap opens or closes. Tail: delta > 0 lengthens the clip. Head: delta > 0
     *  cuts material off the head — the clip keeps its start and the rest of the
     *  timeline pulls left by the same amount. */
    function rippleTrim(c, side, delta) {
      const project = P();
      const group = withLinked([c]);
      if (group.some(isClipLocked)) return TRIM_LOCKED;
      const oldEnd = clipEnd(c);
      let lo, hi;
      if (side === "out") { lo = MIN_DUR - c.duration; hi = groupMaxDur(c) - c.duration; }
      else { lo = -groupHeadRoom(c); hi = c.duration - MIN_DUR; }
      const groupIds = new Set(group.map((x) => x.id));
      const lanes = new Set(group.map((x) => x.track));
      const movers = withoutLocked(withLinked(project.clips.filter((x) => !groupIds.has(x.id) &&
        (isEditTarget(x.track) || lanes.has(x.track)) && !isTrackLocked(x.track) &&
        x.start >= oldEnd - TRIM_EPS)));
      // Pulling left can't push a lane's first mover into what sits before it.
      const moverIds = new Set(movers.map((x) => x.id));
      const first = new Map();
      for (const x of movers) first.set(x.track, Math.min(first.get(x.track) ?? Infinity, x.start));
      let leftRoom = Infinity;
      for (const [tr, f] of first) {
        let blockEnd = 0;
        for (const x of project.clips)
          if (x.track === tr && !moverIds.has(x.id) && !groupIds.has(x.id) && x.start < f - TRIM_EPS)
            blockEnd = Math.max(blockEnd, clipEnd(x));
        leftRoom = Math.min(leftRoom, Math.max(0, f - blockEnd));
      }
      if (side === "out") lo = Math.max(lo, -leftRoom); else hi = Math.min(hi, leftRoom);
      const d = clampD(delta, lo, hi);
      if (Math.abs(d) < 1e-9) return 0;
      if (side === "out") trimGroupTail(c, c.duration + d); else trimGroupHead(c, d, false);
      const shift = side === "out" ? d : -d;
      for (const x of movers) x.start = +(x.start + shift).toFixed(4);
      return d;
    }
    /** Roll edit: move the cut on c's head or tail. The clip on the other side
     *  gives or takes the same amount, so nothing downstream moves. With no clip
     *  butting against that edge, it trims into the free room only. */
    function rollEdit(c, side, delta) {
      const left = side === "out" ? c : adjacentClip(c, "in");
      const right = side === "out" ? adjacentClip(c, "out") : c;
      if ([left, right].some((x) => x && isGroupLocked(x))) return TRIM_LOCKED;
      let lo = -Infinity, hi = Infinity;
      if (left) { lo = MIN_DUR - left.duration; hi = groupMaxDur(left) - left.duration; }
      else lo = -freeRoom(right, "in");
      if (right) {
        hi = Math.min(hi, right.duration - MIN_DUR);
        lo = Math.max(lo, -groupHeadRoom(right));
      } else hi = Math.min(hi, freeRoom(left, "out"));
      const d = clampD(delta, lo, hi);
      if (Math.abs(d) < 1e-9) return 0;
      if (left) trimGroupTail(left, left.duration + d);
      if (right) trimGroupHead(right, d, true);
      return d;
    }
    /** Slip: show a different part of the source through the same window.
     *  delta > 0 drags the picture right, i.e. earlier source. Position and
     *  length stay; clip-local keyframes stay put on the timeline. */
    function slipClip(c, delta) {
      if (!isMediaClip(c)) return "Slip needs a video or audio clip — stills and titles have no source time";
      if (isGroupLocked(c)) return TRIM_LOCKED;
      const sp = clipSpeed(c);
      const group = withLinked([c]);
      // The shared In may go no later than the tightest member allows: each one
      // consumes its own span of source (speed can differ across the group).
      let maxIn = Infinity;
      for (const x of group) {
        if (!isMediaClip(x)) continue;
        const m = getMedia(x.mediaId);
        if (m && m.duration > 0) maxIn = Math.min(maxIn, Math.max(0, m.duration - (timeAt(x, clipEnd(x)) - x.in)));
      }
      const newIn = clampD(c.in - delta * sp, 0, maxIn);
      const d = (c.in - newIn) / sp;
      if (Math.abs(d) < 1e-9) return 0;
      for (const x of group) x.in = +newIn.toFixed(4);
      return d;
    }
    /** Slide: move c along its track; the clip before it lengthens or
     *  shortens its tail and the clip after it its head, so c's content and the
     *  sequence length stay. Without a neighbor, c slides into the free room. */
    function slideClip(c, delta) {
      const prev = adjacentClip(c, "in"), next = adjacentClip(c, "out");
      if ([c, prev, next].some((x) => x && isGroupLocked(x))) return TRIM_LOCKED;
      let lo = prev ? MIN_DUR - prev.duration : -freeRoom(c, "in");
      let hi = prev ? groupMaxDur(prev) - prev.duration : Infinity;
      if (next) {
        hi = Math.min(hi, next.duration - MIN_DUR);
        lo = Math.max(lo, -groupHeadRoom(next));
      } else hi = Math.min(hi, freeRoom(c, "out"));
      const d = clampD(delta, lo, hi);
      if (Math.abs(d) < 1e-9) return 0;
      if (prev) trimGroupTail(prev, prev.duration + d);
      if (next) trimGroupHead(next, d, true);
      for (const x of withLinked([c])) x.start = +(x.start + d).toFixed(4);
      return d;
    }
    /** Lift removes t0→t1 on the targeted tracks and leaves the gap; extract
     *  removes it and closes the gap. Linked partners are cut too and locked
     *  clips stay whole. Returns null, or a string saying why nothing happened. */
    function liftRange(t0, t1, extract) {
      const project = P();
      if (t0 == null || t1 == null || !(t1 - t0 > MIN_DUR))
        return `Set IN and OUT first (I / O) to ${extract ? "extract" : "lift"} that range`;
      const lanes = editTargetTracks().map((t) => t.id);
      if (!lanes.length) return "No targeted tracks — click a track name to target it";
      const inside = (c) => clipEnd(c) > t0 + 1e-6 && c.start < t1 - 1e-6;
      if (!extract && !project.clips.some((c) => lanes.includes(c.track) && inside(c) && !isGroupLocked(c)))
        return "Nothing to lift between IN and OUT";
      for (const id of lanes) punchTrackRange(id, t0, t1);
      relinkClips(); // re-pair head / tail pieces across tracks
      if (extract) {
        const gap = t1 - t0;
        const movers = withoutLocked(withLinked(P().clips.filter((c) =>
          isEditTarget(c.track) && c.start >= t1 - 1e-6)));
        for (const c of movers) c.start = Math.max(0, +(c.start - gap).toFixed(4));
      }
      return null;
    }

    /* ── Audio crossfade. A crossfade here is the same-track overlap idiom: A
       runs on past the cut, B starts before it, A fades out and B fades in over
       the overlap with constant-power curves. The overlap comes from spare
       media beyond each clip's edge, split around the cut; picture linked to B
       dissolves in over A (only B fades, so the frame never dips to black). */
    /** Audio cuts touching `clips`: each pair is {a, b} with a before b on one
     *  track, b starting at (or before) a's end. */
    function crossfadeCuts(clips) {
      const pairs = new Map();
      const audio = (x) => x.kind === "audio";
      for (const c of clips.filter(audio)) {
        const lane = P().clips.filter((x) => audio(x) && x !== c && x.track === c.track);
        const next = lane.filter((x) => x.start > c.start + XF_EPS && x.start <= clipEnd(c) + XF_EPS &&
          clipEnd(x) > clipEnd(c)).sort((x, y) => x.start - y.start)[0];
        const prev = lane.filter((x) => x.start < c.start - XF_EPS && clipEnd(x) >= c.start - XF_EPS &&
          clipEnd(x) < clipEnd(c)).sort((x, y) => clipEnd(y) - clipEnd(x))[0];
        if (next) pairs.set(c.id + ">" + next.id, { a: c, b: next });
        if (prev) pairs.set(prev.id + ">" + c.id, { a: prev, b: c });
      }
      return [...pairs.values()];
    }
    /** Spare source after a clip's out / before its in, in timeline seconds. */
    function tailRoom(x) {
      const m = getMedia(x.mediaId), sp = clipSpeed(x);
      if (!(m?.duration > 0)) return 0;
      return Math.max(0, (m.duration - (x.in + x.duration * sp)) / sp);
    }
    function headRoom(x) { return Math.max(0, Math.min(x.in / clipSpeed(x), x.start)); }
    /** Crossfade one cut. Returns null, or why it could not. */
    function crossfadeCut(a, b, dur = CROSSFADE_DUR) {
      if (isGroupLocked(a) || isGroupLocked(b)) return "locked";
      const ga = withLinked([a]), gb = withLinked([b]);
      let d = clipEnd(a) - b.start; // already overlapping: fade across what is there
      if (d < MIN_TRANS_DUR - 1e-6) {
        const roomA = Math.min(...ga.map(tailRoom)), roomB = Math.min(...gb.map(headRoom));
        const gap = Math.max(0, b.start - clipEnd(a)); // a hair of gap at the cut is closed too
        const want = dur + gap;
        let e1 = Math.min(want / 2, roomA);
        const e2 = Math.min(want - e1, roomB);
        e1 = Math.min(want - e2, roomA);
        d = e1 + e2 - gap;
        if (d < MIN_TRANS_DUR - 1e-6) return "no spare media beyond the cut";
        for (const x of ga) x.duration = +(x.duration + e1).toFixed(4);
        for (const x of gb) {
          const sp = clipSpeed(x);
          x.start = +(x.start - e2).toFixed(4);
          x.in = +Math.max(0, x.in - e2 * sp).toFixed(4);
          x.duration = +(x.duration + e2).toFixed(4);
          x.keyframes = shiftKF(x.keyframes, -e2, x.duration);
          shiftMasks(x, -e2);
        }
      }
      d = +Math.min(d, a.duration, b.duration).toFixed(3);
      for (const x of ga) if (x.kind === "audio") x.transitionOut = { type: "fade", duration: d, curve: "power" };
      for (const x of gb) {
        if (x.kind === "audio") x.transitionIn = { type: "fade", duration: d, curve: "power" };
        else if (x.kind === "video") x.transitionIn = { type: "fade", duration: d };
      }
      return null;
    }
    /** Crossfade every cut in `pairs`, once per linked pair. Returns {done, why}. */
    function crossfadePairs(pairs, dur = CROSSFADE_DUR) {
      let done = 0;
      const why = new Set();
      const seen = new Set();
      for (const { a, b } of pairs) {
        const key = (a.linkGroup || a.id) + ">" + (b.linkGroup || b.id); // one stereo pair = one cut
        if (seen.has(key)) continue;
        seen.add(key);
        const r = crossfadeCut(a, b, dur);
        if (r) why.add(r); else done++;
      }
      return { done, why: [...why] };
    }
    /** The audio cut nearest t (within 0.5 s) on each targeted audio track. */
    function crossfadeCutsNear(t) {
      const pairs = [];
      for (const tr of env.tracks()) {
        if (tr.kind !== "audio" || !isEditTarget(tr.id)) continue;
        const near = crossfadeCuts(P().clips.filter((x) => x.track === tr.id))
          .map((p) => ({ ...p, dist: Math.abs(p.b.start - t) }))
          .filter((p) => p.dist <= 0.5).sort((x, y) => x.dist - y.dist)[0];
        if (near) pairs.push(near);
      }
      return pairs;
    }

    return {
      isTrackLocked, isEditTarget, isClipLocked, isGroupLocked, withoutLocked, editTargetTracks,
      withLinked, relinkClips,
      splitClipAt, relinkSplitRights, splitAt, splitAtTimes, trimToRange,
      removeClips, rippleDelete,
      gapAt, closeGapAt, listAlignedGaps,
      sourceEditTracks, sourceReplacePunchTracks, placeSourceWindowClips, punchTrackRange, insertAt, overwriteAt,
      maxClipDur, groupMaxDur, groupHeadRoom, adjacentClip, freeRoom,
      rippleTrim, rollEdit, slipClip, slideClip, liftRange,
      crossfadeCuts, crossfadeCut, crossfadePairs, crossfadeCutsNear,
    };
  }

  /** Bind the ops to a bare project document: lanes from doc.tracks (or the
   *  default V3…V1 + A1…A4), locks and targeting from the document's own
   *  lockedTracks / untargetedTracks. opts: {tracks?: lanes to target instead,
   *  force?: ignore locks, uid?}. */
  function forDoc(doc, opts = {}) {
    const lanes = () => (Array.isArray(doc.tracks) && doc.tracks.length ? doc.tracks : DEFAULT_TRACKS)
      .map((t) => ({ id: t.id, kind: t.kind || (String(t.id)[0] === "A" ? "audio" : "video") }));
    const only = Array.isArray(opts.tracks) && opts.tracks.length ? new Set(opts.tracks) : null;
    return create({
      doc: () => doc,
      tracks: lanes,
      trackLocked: (id) => Array.isArray(doc.lockedTracks) && doc.lockedTracks.includes(id),
      trackTargeted: (id) => only ? only.has(id)
        : !(Array.isArray(doc.untargetedTracks) && doc.untargetedTracks.includes(id)),
      uid: opts.uid,
      ignoreLocks: opts.force === true,
    });
  }

  return {
    MIN_DUR, MIN_TRANS_DUR, CROSSFADE_DUR, GAP_EPS, TRIM_LOCKED, DEFAULT_TRACKS,
    clipEnd, clipSpeed, kfChannel, hasSpeedRamp, mediaTimeAt, shiftKF, shiftMasks, defaultPanForChannel,
    create, forDoc,
  };
});
