/* FableCut highlights — the best moments of long footage, cut into a short
   edit. Zero dependencies; loaded by the editor as a plain script (global
   `FableCutHighlights`) and required by the MCP server, so the editor,
   fablecut_highlights and Studio pick the same moments.

   picture: small RGB frames sampled through each source (PIC_FPS a second) →
   how much moves, how sharp it is, how dark. sound: the source's mono sound →
   its loudness every AUD_STEP seconds. shots: sudden picture changes, the cuts
   already in the footage. pick: score every half second (movement, loudness
   against its surroundings, a clear picture), then take the best moments of
   `shot` seconds, never across a cut, apart from each other, until the edit is
   `duration` long; in story order, their ends nudged to quiet points. ops: the
   patch that lays them back to back in a new sequence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutHighlights = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PIC_FPS = 2;        // frames looked at per second of footage (one score bin each)
  const BIN = 1 / PIC_FPS;  // seconds
  const SAMPLE_W = 64;      // their width in px
  const AUD_STEP = 0.1;     // seconds per loudness reading
  const DEFAULTS = { duration: 30, minShot: 1.5, maxShot: 4 };
  const LIMITS = { duration: [5, 600], shot: [0.5, 20] };
  const MAX_SOURCE_SECS = 60 * 60;   // footage looked at per call
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const quantile = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

  /** Checked options: duration (seconds of edit), shot (seconds per moment; default from duration). */
  function options(o = {}) {
    const duration = o.duration == null ? DEFAULTS.duration : +o.duration;
    if (!(duration >= LIMITS.duration[0] && duration <= LIMITS.duration[1]))
      throw new Error(`duration must be ${LIMITS.duration[0]}…${LIMITS.duration[1]} seconds`);
    let shot = o.shot == null ? clamp(duration / 8, DEFAULTS.minShot, DEFAULTS.maxShot) : +o.shot;
    if (!(shot >= LIMITS.shot[0] && shot <= LIMITS.shot[1])) throw new Error(`shot must be ${LIMITS.shot[0]}…${LIMITS.shot[1]} seconds`);
    shot = Math.min(shot, duration);
    return { duration, shot };
  }

  /* ── reading the footage ── */

  /** The picture, a frame at a time: push(rgb) for each frame (w×h×3 bytes, PIC_FPS a
   *  second); `motion`, `sharp` and `dark` grow by one value per frame (0…255 scales). */
  function picture(w, h) {
    const n = w * h, motion = [], sharp = [], dark = [];
    let prev = null;
    return {
      motion, sharp, dark,
      push(rgb) {
        const y = new Float32Array(n);
        let sum = 0;
        for (let i = 0, j = 0; i < n; i++, j += 3) { y[i] = 0.2126 * rgb[j] + 0.7152 * rgb[j + 1] + 0.0722 * rgb[j + 2]; sum += y[i]; }
        let g = 0, d = 0;
        for (let r = 0; r < h - 1; r++) for (let c = 0; c < w - 1; c++) {
          const i = r * w + c;
          g += Math.abs(y[i + 1] - y[i]) + Math.abs(y[i + w] - y[i]);
        }
        if (prev) for (let i = 0; i < n; i++) d += Math.abs(y[i] - prev[i]);
        motion.push(prev ? d / n : 0);
        sharp.push(g / ((w - 1) * (h - 1) * 2));
        dark.push(sum / n);
        prev = y;
      },
    };
  }

  /** The sound, a chunk at a time: push(mono Float32Array) at `rate`; `db` grows by one
   *  RMS reading (dBFS, -90 floor) per AUD_STEP. */
  function sound(rate) {
    const step = Math.max(1, Math.round(rate * AUD_STEP)), db = [];
    let acc = 0, k = 0;
    return {
      db,
      push(x) {
        for (let i = 0; i < x.length; i++) {
          acc += x[i] * x[i];
          if (++k === step) { db.push(Math.max(-90, 10 * Math.log10(acc / step + 1e-12))); acc = 0; k = 0; }
        }
      },
    };
  }

  /** Cuts already in the footage: bins (seconds) where the picture changes all at once,
   *  far beyond the movement around them. */
  function shots(motion) {
    const cuts = [];
    for (let i = 1; i < motion.length; i++) {
      const around = motion.slice(Math.max(1, i - 10), i).concat(motion.slice(i + 1, i + 11));
      if (motion[i] > Math.max(28, 4 * median(around) + 6)) cuts.push(round3(i * BIN));
    }
    return cuts;
  }

  /* ── scoring and picking ── */

  /** Per-bin scores (0…1) for each source {pic: picture(), aud: sound() | null}; normalised
   *  across all of them so a busy source outranks a quiet one. Also each source's cuts. */
  function score(sources) {
    const cutsOf = sources.map((s) => shots(s.pic.motion));
    // movement without the cut spikes, which are edits, not action
    const moves = sources.map((s, k) => {
      const at = new Set(cutsOf[k].map((t) => Math.round(t / BIN)));
      return s.pic.motion.map((m, i) => (at.has(i) ? (s.pic.motion[i - 1] || 0) : m));
    });
    const mHi = Math.max(1, quantile(moves.flat(), 0.9));
    const sHi = Math.max(1, quantile(sources.flatMap((s) => s.pic.sharp), 0.75));
    return sources.map((s, k) => {
      const n = s.pic.motion.length, db = s.aud && s.aud.db.length ? s.aud.db : null;
      const loudAt = (i) => {
        if (!db) return null;
        const a = Math.floor((i * BIN) / AUD_STEP), b = Math.max(a + 1, Math.floor(((i + 1) * BIN) / AUD_STEP));
        let v = -90;
        for (let j = a; j < b && j < db.length; j++) v = Math.max(v, db[j]);
        return v;
      };
      const loud = Array.from({ length: n }, (_, i) => loudAt(i));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const m = clamp(moves[k][i] / mHi, 0, 1);
        const v = clamp(s.pic.sharp[i] / sHi, 0, 1);
        const blank = s.pic.dark[i] < 16 || s.pic.sharp[i] < 0.6;   // black, or a flat colour
        let x;
        if (loud[i] != null) {
          // louder than the 20 s around it: a cheer, a laugh, a hit
          const ctx = median(loud.slice(Math.max(0, i - 20), i + 21).filter((d) => d != null));
          const lift = clamp((loud[i] - ctx) / 12, 0, 1), level = clamp((loud[i] + 50) / 40, 0, 1);
          x = 0.45 * m + 0.25 * lift + 0.15 * level + 0.15 * v;
        } else x = 0.75 * m + 0.25 * v;
        out[i] = blank ? x * 0.2 : x;
      }
      return { scores: out, cuts: cutsOf[k] };
    });
  }

  /** The best moments: sources [{id, len, pic, aud, speed?}] (len: seconds of footage looked at,
   *  times from its start; speed: how fast the clip plays it, default 1) → [{source, from, to, len,
   *  score, why}] in story order: from / to in seconds of footage, len in seconds of edit, `duration`
   *  seconds of edit in all (the last ones trimmed to fit). */
  function pick(sources, opts = {}) {
    const { duration, shot } = options(opts);
    const scored = score(sources);
    const gap = Math.max(1, shot * 0.5);
    const cands = [];
    sources.forEach((s, k) => {
      const sc = scored[k].scores, n = sc.length, sp = speedOfSource(s);
      const len = Math.min(s.len, n * BIN);
      const bounds = [0, ...scored[k].cuts, len];
      for (let b = 0; b + 1 < bounds.length; b++) {
        const a0 = bounds[b], a1 = bounds[b + 1];
        const L = Math.min(shot * sp, a1 - a0);   // `shot` seconds of edit, in seconds of footage
        if (L / sp < Math.min(1, shot)) continue;   // a flash between two cuts
        for (let t = a0; t + L <= a1 + 1e-6; t += BIN) {
          const i0 = Math.round(t / BIN), i1 = Math.max(i0 + 1, Math.round((t + L) / BIN));
          let sum = 0;
          for (let i = i0; i < i1 && i < n; i++) sum += sc[i];
          cands.push({ k, shotNo: b, from: t, to: t + L, score: sum / (i1 - i0), lo: a0, hi: a1 });
        }
      }
    });
    const chosen = [], perShot = new Map();
    let total = 0;
    while (total < duration - 1e-6) {
      let best = null, bestV = -1;
      for (const c of cands) {
        if (c.used) continue;
        if (chosen.some((p) => p.k === c.k && c.from < p.to + gap && c.to > p.from - gap)) { c.used = true; continue; }
        const v = c.score * Math.pow(0.8, perShot.get(c.k + ":" + c.shotNo) || 0);   // variety: a shot already used counts less
        if (v > bestV) { bestV = v; best = c; }
      }
      if (!best) break;
      best.used = true;
      chosen.push(best);
      perShot.set(best.k + ":" + best.shotNo, (perShot.get(best.k + ":" + best.shotNo) || 0) + 1);
      total += (best.to - best.from) / speedOfSource(sources[best.k]);
    }
    chosen.sort((a, b) => a.k - b.k || a.from - b.from);
    // ends on a quiet moment nearby (not through a word or a hit), never past a cut
    for (const c of chosen) {
      const db = sources[c.k].aud && sources[c.k].aud.db;
      if (!db || !db.length) continue;
      const quiet = (lo, hi, t) => {
        let bestT = t, bestD = Infinity;
        for (let u = lo; u <= hi + 1e-6; u += AUD_STEP) {
          const d = db[Math.round(u / AUD_STEP)];
          if (d != null && d < bestD - 1) { bestD = d; bestT = u; }
        }
        return bestT;
      };
      // the start moves either way and the moment keeps its length; the end only moves later, so the
      // edit never comes out short (the trim below takes any extra off the last moments)
      const L = c.to - c.from;
      c.from = quiet(Math.max(c.lo, c.from - 0.3), Math.max(c.lo, Math.min(c.from + 0.3, c.hi - L)), c.from);
      c.to = c.from + L;
      c.to = quiet(c.to, Math.min(c.hi, c.to + 0.3), c.to);
    }
    // exactly `duration`: trim the moments from the end
    // (in seconds of edit: a clip at 2× spends two seconds of footage on each)
    let over = chosen.reduce((n, c) => n + (c.to - c.from) / speedOfSource(sources[c.k]), 0) - duration;
    for (let i = chosen.length - 1; i >= 0 && over > 1e-3; i--) {
      const c = chosen[i], sp = speedOfSource(sources[c.k]), cut = Math.min(over, (c.to - c.from) / sp - 0.5);
      if (cut > 0) { c.to -= cut * sp; over -= cut; }
    }
    return chosen.map((c) => {
      const sc = scored[c.k].scores, i0 = Math.round(c.from / BIN), i1 = Math.max(i0 + 1, Math.round(c.to / BIN));
      const moves = sources[c.k].pic.motion.slice(i0, i1);
      const busy = moves.length && median(moves) > quantile(sources[c.k].pic.motion, 0.6);
      // loud: well above the footage's usual level somewhere in the moment
      const db = sources[c.k].aud && sources[c.k].aud.db;
      const peak = db ? Math.max(-90, ...db.slice(Math.floor(c.from / AUD_STEP), Math.ceil(c.to / AUD_STEP))) : -90;
      const loud = !!(db && db.length && peak > median(db) + 8);
      return { source: sources[c.k].id, from: round3(c.from), to: round3(c.to), len: round3((c.to - c.from) / speedOfSource(sources[c.k])),
        score: Math.round(c.score * 100) / 100,
        why: busy && loud ? "movement and sound" : busy ? "movement" : loud ? "sound" : "a clear picture", bins: sc.slice(i0, i1).length };
    }).map(({ bins, ...p }) => p);
  }

  /* ── the edit ── */

  /** Clips this tool reads: video clips with a picture, at a steady speed. `ids` limits them. */
  function sourcesOf(doc, ids = null) {
    const take = [], skip = [];
    const off = new Set(Array.isArray(doc.disabledTracks) ? doc.disabledTracks : []);
    for (const c of doc.clips || []) {
      if (ids && !ids.includes(c.id)) continue;
      const why = c.kind !== "video" ? (ids ? `${/^[aeiou]/.test(c.kind) ? "an" : "a"} ${c.kind} clip` : null)
        : c.disabled || off.has(c.track) ? "disabled"
        : Array.isArray(c.keyframes?.speed) && c.keyframes.speed.length ? "a speed ramp"
        : null;
      if (c.kind !== "video" && !ids) continue;
      if (why) skip.push({ id: c.id, why }); else take.push(c);
    }
    return { take, skip };
  }

  const speedOf = (c) => clamp(+(c.props && c.props.speed) || 1, 0.1, 8);
  function speedOfSource(s) { return clamp(+s.speed || 1, 0.1, 8); }

  /** The patch: a new sequence (`seq`: {name, width?, height?, fps?}) holding each moment as
   *  a clip back to back on V1, with the sound clips linked to its source alongside.
   *  `picks` from pick(), whose `source` is a clip id in `doc` or "media:<id>" for a whole file
   *  (its `from` / `to` in seconds from the start of that clip's window). */
  function ops(doc, picks, seq) {
    const out = [{ op: "addSequence", from: "empty", name: seq.name, ...(seq.width ? { width: seq.width, height: seq.height } : {}),
      ...(seq.fps ? { fps: seq.fps } : {}), open: true }];
    const clips = doc.clips || [];
    // ids no clip in the project has, in any sequence or composition (a second run gets hl1_2, …)
    const used = new Set([...clips, ...(doc.sequences || []).flatMap((q) => q.clips || []), ...(doc.comps || []).flatMap((q) => q.clips || [])].map((c) => c.id));
    let run = 1;
    const tag = () => (run === 1 ? "" : `_${run}`);
    while (picks.some((_, n) => [...used].some((u) => u === `hl${n + 1}${tag()}` || u.startsWith(`hl${n + 1}${tag()}a`)))) run++;
    let at = 0;
    picks.forEach((p, n) => {
      const id = `hl${n + 1}${tag()}`;
      let c = clips.find((x) => x.id === p.source);
      if (!c && String(p.source).startsWith("media:")) {
        const m = (doc.media || []).find((x) => x.id === p.source.slice(6));
        if (m) c = { id, mediaId: m.id, kind: "video", track: "V1", start: 0, in: 0, duration: m.duration, props: {} };
      }
      if (!c) return;
      const sp = speedOf(c), len = (p.to - p.from) / sp;
      const props = { ...(c.props || {}) };
      delete props.reframe;   // the new canvas gets framed anew
      const partners = clips.filter((x) => x !== c && x.id !== c.id && x.kind === "audio" &&
        ((c.linkGroup && x.linkGroup === c.linkGroup) || (c.linkedId && c.linkedId === x.id) || x.linkedId === c.id));
      const group = partners.length ? `hl_${n + 1}` : null;
      out.push({ op: "addClip", clip: { id, mediaId: c.mediaId, kind: "video", track: "V1", start: round3(at),
        in: round3((c.in || 0) + p.from), duration: round3(len), props, ...(group ? { linkGroup: group } : {}) } });
      partners.forEach((x, j) => {
        // the same moment of the sound: through where the two sit on the timeline
        const t0 = c.start + p.from / sp, xs = speedOf(x);
        const xin = (x.in || 0) + (t0 - x.start) * xs;
        if (xin < (x.in || 0) - 1e-3 || t0 + len > x.start + x.duration + 1e-3) return;
        out.push({ op: "addClip", clip: { id: `${id}a${j + 1}`, mediaId: x.mediaId, kind: "audio", track: x.track, start: round3(at),
          in: round3(xin), duration: round3(len), props: { ...(x.props || {}) }, linkGroup: group } });
      });
      at += len;
    });
    return out;
  }

  /** The reply: what was picked, and why. */
  function describe(picks, { duration, seqName, made = false } = {}) {
    const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
    const lenOf = (p) => (p.len != null ? p.len : p.to - p.from);
    const total = picks.reduce((n, p) => n + lenOf(p), 0);
    const lines = picks.map((p, i) => `  ${i + 1}. ${p.source} ${clock(p.from)}–${clock(p.to)} (${lenOf(p).toFixed(1)} s, ${p.why}, score ${p.score})`);
    return (made ? `New sequence "${seqName}", opened: ` : "") + `${picks.length} moment${picks.length === 1 ? "" : "s"}, ${total.toFixed(1)} s` +
      (duration && total < duration - 0.5 ? ` (asked for ${duration} s: the footage has no more distinct moments)` : "") + ":\n" + lines.join("\n");
  }

  return { PIC_FPS, BIN, SAMPLE_W, AUD_STEP, DEFAULTS, LIMITS, MAX_SOURCE_SECS, options, picture, sound, shots, score, pick, sourcesOf, ops, describe };
});
