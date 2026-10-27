/* FableCut beats — the music's beat, and cuts that land on it. Zero
   dependencies; loaded by the editor as a plain script (global
   `FableCutBeats`) and required by the MCP server and analyze.js, so the
   Inspector's Beats section, `fablecut_beats` and the reference analyzer hear
   the same beats.

   analyze: mono samples at SR → onset envelope → beats (onsets), BPM, a
   loudness curve and the drop. grid: a steady beat (from the BPM and the
   onsets' phase) that cuts snap to. Then, on a timeline: snapOps rolls
   each cut to the nearest beat (nothing else moves), retimeOps lays a
   track's clips back to back, `every` beats each. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutBeats = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SR = 22050;    // analysis sample rate
  const HOP = 512;     // onset-envelope hop (~23 ms)
  const WIN = 1024;    // energy window
  const EVERY = [1, 2, 4, 8, 16];
  /** An onset is timed at the middle of the window its energy rise shows up in: about
   *  half a window after the hit. The grid takes it back, so cuts land on the hit itself. */
  const ONSET_LAG = WIN / 2 / SR;
  const EPS = 1e-6;
  const MIN_DUR = 0.05;   // edit-ops.js: the shortest a clip may be

  /** Mono samples at another rate → SR (box average when shrinking, linear otherwise). */
  function resample(x, rate) {
    if (!(rate > 0)) throw new Error("sample rate must be > 0");
    if (rate === SR) return x instanceof Float32Array ? x : Float32Array.from(x);
    const n = Math.floor(x.length * SR / rate), out = new Float32Array(n), r = rate / SR;
    if (r > 1) {
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * r), b = Math.max(a + 1, Math.min(x.length, Math.floor((i + 1) * r)));
        let s = 0;
        for (let j = a; j < b; j++) s += x[j];
        out[i] = s / (b - a);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const p = i * r, a = Math.floor(p), f = p - a;
        out[i] = (x[a] || 0) * (1 - f) + (x[Math.min(x.length - 1, a + 1)] || 0) * f;
      }
    }
    return out;
  }

  /** Several channels → one (their mean). */
  function mono(channels) {
    if (channels.length === 1) return channels[0];
    const n = Math.min(...channels.map((c) => c.length)), out = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
    for (let i = 0; i < n; i++) out[i] /= channels.length;
    return out;
  }

  /** Beats, BPM, energy curve and drop of mono samples at SR (seconds from the
   *  first sample). `scale` turns integer PCM into −1…1 (1 / 32768 for s16). */
  function analyze(pcm, { scale = 1 } = {}) {
    const nFrames = Math.max(0, Math.floor((pcm.length - WIN) / HOP));
    if (nFrames < 20) return { beats: [], bpm: null, energy: { step: 0.5, values: [] }, drop: null };

    // frame energies
    const E = new Float64Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      let s = 0;
      const o = i * HOP;
      for (let j = 0; j < WIN; j++) { const x = pcm[o + j] * scale; s += x * x; }
      E[i] = s / WIN;
    }

    // onset envelope: energy rise vs. trailing average
    const O = new Float64Array(nFrames);
    for (let i = 1; i < nFrames; i++) {
      let m = 0, k = 0;
      for (let j = Math.max(0, i - 8); j < i; j++) { m += E[j]; k++; }
      O[i] = Math.max(0, E[i] - m / k);
    }
    let oMax = 0;
    for (let i = 0; i < nFrames; i++) if (O[i] > oMax) oMax = O[i];
    if (oMax > 0) for (let i = 0; i < nFrames; i++) O[i] /= oMax;

    // peak-pick beats: local max, above an adaptive floor, min 0.25 s apart
    const frameT = (i) => Math.round(((i * HOP + WIN / 2) / SR) * 1000) / 1000;
    const minGap = Math.round(0.25 * SR / HOP);
    const halfWin = Math.round(1.0 * SR / HOP);
    const beats = [];
    let last = -minGap;
    for (let i = 3; i < nFrames - 3; i++) {
      if (O[i] < 0.05) continue;
      let isMax = true;
      for (let j = -3; j <= 3; j++) if (O[i + j] > O[i]) { isMax = false; break; }
      if (!isMax) continue;
      let m = 0, k = 0;
      for (let j = Math.max(0, i - halfWin); j < Math.min(nFrames, i + halfWin); j++) { m += O[j]; k++; }
      if (O[i] < (m / k) * 1.5) continue;
      if (i - last < minGap) continue;
      beats.push(frameT(i));
      last = i;
    }

    // BPM: autocorrelation of the onset envelope over 60–200 BPM lags,
    // with a mild prior toward ~120; fold octaves into 70–180.
    let bpm = null;
    const lagMin = Math.round(60 / 200 * SR / HOP), lagMax = Math.round(60 / 60 * SR / HOP);
    let best = 0, bestLag = 0;
    for (let lag = lagMin; lag <= Math.min(lagMax, nFrames - 1); lag++) {
      let s = 0;
      for (let i = 0; i + lag < nFrames; i++) s += O[i] * O[i + lag];
      const cand = 60 / (lag * HOP / SR);
      const w = Math.exp(-0.5 * Math.pow(Math.log2(cand / 120) / 1.0, 2));
      if (s * w > best) { best = s * w; bestLag = lag; }
    }
    if (bestLag) {
      bpm = 60 / (bestLag * HOP / SR);
      while (bpm < 70) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      // refine: if the picked beats are regular, the median inter-beat interval
      // is a much finer tempo estimate than the autocorrelation lag grid
      if (beats.length >= 6) {
        const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
        const med = gaps[Math.floor(gaps.length / 2)];
        const spread = gaps[Math.floor(gaps.length * 0.85)] - gaps[Math.floor(gaps.length * 0.15)];
        if (med > 0 && spread < med * 0.15) {
          // full span / count averages out the hop-grid quantization of each beat
          let refined = 60 / ((beats[beats.length - 1] - beats[0]) / (beats.length - 1));
          while (refined < 70) refined *= 2;
          while (refined > 180) refined /= 2;
          if (Math.abs(refined - bpm) / bpm < 0.15) bpm = refined;
        }
      }
      bpm = Math.round(bpm * 10) / 10;
    }

    // loudness curve, one value per 0.5 s, normalized 0–100
    const step = 0.5;
    const perStep = Math.round(step * SR / HOP);
    const values = [];
    for (let i = 0; i < nFrames; i += perStep) {
      let s = 0, k = 0;
      for (let j = i; j < Math.min(nFrames, i + perStep); j++) { s += Math.sqrt(E[j]); k++; }
      values.push(k ? s / k : 0);
    }
    const vMax = Math.max(...values, 1e-9);
    const energy = values.map((v) => Math.round(v / vMax * 100));

    // the drop: biggest sustained energy rise (skip the very start)
    let drop = null, bestRise = 0;
    for (let i = 2; i < energy.length - 1; i++) {
      const before = (energy[i - 2] + energy[i - 1]) / 2;
      const after = (energy[i] + energy[Math.min(i + 1, energy.length - 1)]) / 2;
      if (after - before > bestRise && after > 55) { bestRise = after - before; drop = Math.round(i * step * 10) / 10; }
    }

    return { beats, bpm, energy: { step, values: energy }, drop };
  }

  /** A steady beat from `from` to `to` (seconds, same clock as `beats`): the BPM's
   *  period, phased to where the onsets fall (their circular mean). Without a
   *  tempo, or with too few onsets to phase it, the onsets themselves. */
  function grid(beats, bpm, from, to) {
    const inside = (t) => t >= from - EPS && t <= to + EPS;
    if (!(bpm > 0) || beats.length < 4) return beats.filter(inside);
    let p = 60 / bpm;
    let sx = 0, sy = 0;
    for (const t of beats) { const a = 2 * Math.PI * ((t % p) / p); sx += Math.cos(a); sy += Math.sin(a); }
    let phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * p;
    // refine period and phase together: a least-squares line through the onsets that sit
    // near a grid beat (beat index → time), so a slightly-off tempo doesn't drift over a song
    for (let pass = 0; pass < 3; pass++) {
      let n = 0, sk = 0, st = 0, skk = 0, skt = 0;
      for (const t of beats) {
        const k = Math.round((t - phase) / p);
        if (Math.abs(t - (phase + k * p)) > p / 4) continue;
        n++; sk += k; st += t; skk += k * k; skt += k * t;
      }
      const den = n * skk - sk * sk;
      if (n < 4 || !den) break;
      const np = (n * skt - sk * st) / den;
      if (!(np > p * 0.97 && np < p * 1.03)) break;   // a fit that changes the tempo isn't a refinement
      p = np; phase = (st - p * sk) / n;
    }
    phase = (((phase - ONSET_LAG) % p) + p) % p;
    const out = [];
    for (let k = Math.ceil((from - phase) / p - EPS); ; k++) {
      const t = phase + k * p;
      if (t > to + EPS) break;
      if (t >= from - EPS) out.push(Math.round(t * 1000) / 1000);
    }
    return out;
  }

  /** Seconds in a clip's source (from its `in`) → timeline seconds, at its steady speed; inside the clip. */
  function toTimeline(times, clip) {
    const sp = Math.min(8, Math.max(0.1, +clip.props?.speed || 1));
    const end = clip.start + clip.duration;
    return times.map((t) => Math.round((clip.start + (t - (clip.in || 0)) / sp) * 1000) / 1000)
      .filter((t) => t >= clip.start - EPS && t <= end + EPS);
  }

  /** What a clip's timed data becomes when its length changes at the tail (as edit-ops trims do):
   *  keyframes past the new end dropped, transitions no longer than the clip. Only changed keys;
   *  null removes the keyframes. */
  function fitTimed(c, dur) {
    const set = {};
    if (c.keyframes && typeof c.keyframes === "object") {
      const out = {};
      let changed = false;
      for (const [k, arr] of Object.entries(c.keyframes)) {
        if (!Array.isArray(arr)) { out[k] = arr; continue; }
        const keep = arr.filter((kf) => !(kf.t > dur + 1e-3));
        if (keep.length !== arr.length) changed = true;
        if (keep.length) out[k] = keep;
      }
      if (changed) set.keyframes = Object.keys(out).length ? out : null;
    }
    for (const k of ["transitionIn", "transitionOut"])
      if (c[k] && c[k].duration > dur) set[k] = { ...c[k], duration: Math.round(dur * 1000) / 1000 };
    return set;
  }

  /** A clip whose speed is keyframed: its sound doesn't keep the music's time on the timeline. */
  const ramped = (c) => Array.isArray(c.keyframes?.speed) && c.keyframes.speed.length > 0;

  function every(v) {
    const n = v == null ? 2 : +v;
    if (!EVERY.includes(n)) throw new Error(`every must be one of ${EVERY.join(", ")} (beats per shot)`);
    return n;
  }

  /** The nearest grid time to t, or null when the grid is empty. */
  function nearest(g, t) {
    let best = null;
    for (const b of g) if (best == null || Math.abs(b - t) < Math.abs(best - t)) best = b;
    return best;
  }

  /** The cuts on `tracks` (where one clip ends and the next on the same track starts),
   *  inside the beat grid's span: [{t, a, b}] with a the clip before, b the one after. */
  function cuts(clips, tracks, g, fps) {
    const tol = 0.5 / (fps || 30);
    const touch = 1e-3;   // edit-ops.js TRIM_EPS: what a roll counts as clips that meet
    const out = [];
    for (const tr of tracks) {
      const on = clips.filter((c) => c.track === tr).sort((x, y) => x.start - y.start);
      for (let i = 0; i + 1 < on.length; i++) {
        const a = on[i], b = on[i + 1], t = a.start + a.duration;
        if (Math.abs(b.start - t) > touch) continue;   // a gap or an overlap (even a hair's): not a cut a roll can move
        if (!g.length || t < g[0] - tol || t > g[g.length - 1] + tol) continue;
        out.push({ t, a, b });
      }
    }
    return out;
  }

  /** Roll each cut on `tracks` to the nearest beat when it is within `maxShift` seconds
   *  (default: half a beat) and off by more than half a frame: [{op:"roll", id, side, delta}]
   *  — patch ops for project-ops.js (and EDIT.rollEdit in the editor). The rolls touch
   *  different cuts, so their order doesn't matter. A roll needs spare footage: earlier,
   *  the clip after the cut shows more of its head; later, the clip before shows more of
   *  its tail. `spare(c)` gives {head, tail} in timeline seconds (default: unlimited);
   *  a cut that can't reach its beat is left where it is (`blocked` counts them). */
  function snapOps(clips, tracks, g, { fps = 30, maxShift, bpm, spare = () => ({ head: Infinity, tail: Infinity }), blocked } = {}) {
    const beat = bpm > 0 ? 60 / bpm : g.length > 1 ? (g[g.length - 1] - g[0]) / (g.length - 1) : 0.5;
    const limit = maxShift == null ? beat / 2 : +maxShift;
    if (!(limit > 0)) throw new Error("maxShift must be > 0 seconds");
    const half = 0.5 / fps, ops = [];
    // the rolls are planned one after another, each on the clips as the earlier ones left them:
    // two cuts beside one short clip can't both take its time
    const now = new Map();
    const cur = (c) => now.get(c.id) || { ...c };
    const speed = (c) => Math.min(8, Math.max(0.1, +c.props?.speed || 1));
    for (const { t, a, b } of cuts(clips, tracks, g, fps).sort((x, y) => x.t - y.t)) {
      const to = nearest(g, Math.round(t * fps) / fps);
      if (to == null) continue;
      const snapped = Math.round(to * fps) / fps, delta = snapped - t;
      if (Math.abs(delta) <= half || Math.abs(delta) > limit + half) continue;
      const A = cur(a), B = cur(b);
      const room = delta < 0 ? spare(B).head : spare(A).tail;
      const keeps = (delta < 0 ? A.duration + delta : B.duration - delta) >= MIN_DUR - 1e-9;
      if (room + 1e-6 < Math.abs(delta) || !keeps) { if (blocked) blocked.n++; continue; }
      now.set(a.id, { ...A, duration: A.duration + delta });
      now.set(b.id, { ...B, start: B.start + delta, in: (B.in || 0) + delta * speed(B), duration: B.duration - delta });
      ops.push({ op: "roll", id: a.id, side: "out", delta: Math.round(delta * 1e6) / 1e6 });
    }
    return ops;
  }

  /** Lay the clips on `track` that start at or after `from` back to back on the beat:
   *  each takes `n` beats of the grid (fewer when its source runs out, at least one),
   *  starting at the first beat at or after `from`. `mediaDur(clip)` is how many seconds
   *  of source a clip may use from its `in` (Infinity for pictures). Clips past the
   *  grid's end follow on at their own length. Returns {plan:[{id, start, duration, beats?}]
   *  (beats: how many it was given; none for the ones past the grid),
   *  short:[ids that got fewer beats], skipped:[ids too short for one beat]}; partners
   *  (linked stems) are the caller's to move with their picture. */
  function retimePlan(clips, track, g, { n = 2, from = 0, fps = 30, mediaDur = () => Infinity } = {}) {
    const snap = (t) => Math.round(t * fps) / fps;
    const on = clips.filter((c) => c.track === track && c.start >= from - 0.5 / fps).sort((x, y) => x.start - y.start);
    const beats = g.filter((t) => t >= from - EPS).map(snap);
    const plan = [], short = [], skipped = [];
    let k = 0, at = beats.length ? beats[0] : snap(from);
    for (const c of on) {
      const sp = Math.min(8, Math.max(0.1, +c.props?.speed || 1));
      const room = mediaDur(c) / sp;   // timeline seconds of source left from its in
      if (k < beats.length - 1) {
        let m = Math.min(n, beats.length - 1 - k);
        while (m > 0 && beats[k + m] - beats[k] > room + 1e-3) m--;
        if (m === 0) { skipped.push(c.id); continue; }
        if (m < n && k + n <= beats.length - 1) short.push(c.id);
        plan.push({ id: c.id, start: beats[k], duration: Math.round((beats[k + m] - beats[k]) * 1e6) / 1e6, beats: m });
        k += m;
        at = beats[k];
      } else {
        plan.push({ id: c.id, start: at, duration: c.duration });
        at = snap(at + c.duration);
      }
    }
    return { plan, short, skipped };
  }

  /* ── On a project: what fablecut_beats (and Studio's relay) does with an analysis ── */

  const DEFAULT_VIDEO = ["V3", "V2", "V1"];
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

  /** Ids of clips that may not be edited: their own lock, a locked lane, or a linked partner of one. */
  function lockedIds(doc) {
    const lanes = new Set(Array.isArray(doc.lockedTracks) ? doc.lockedTracks : []);
    const own = (c) => c.locked === true || lanes.has(c.track);
    const groups = new Set(doc.clips.filter((c) => c.linkGroup && own(c)).map((c) => c.linkGroup));
    return new Set(doc.clips.filter((c) => own(c) || (c.linkGroup && groups.has(c.linkGroup))).map((c) => c.id));
  }
  /** Video lanes, bottom (V1) first. */
  function videoTracks(doc) {
    const ids = Array.isArray(doc.tracks) && doc.tracks.length ? doc.tracks.filter((t) => t.kind === "video").map((t) => t.id) : DEFAULT_VIDEO;
    return ids.slice().sort((a, b) => (+a.slice(1) || 0) - (+b.slice(1) || 0));
  }

  /** The beat on the timeline under a music clip, and the ops for what `o` asks:
   *  markers (a cyan marker on every beat), snap (roll cuts to the beat) and retime
   *  ({track?, every?, from?}: lay a track's clips on the beat). `a` is analyze()'s
   *  result with its times in the file's seconds (beats + the clip's in point).
   *  Throws on anything it can't do safely; nothing is half done. */
  function plan(doc, clip, a, o = {}) {
    if (!clip || (clip.kind !== "audio" && clip.kind !== "video")) throw new Error("the music must be an audio or video clip");
    if (ramped(clip)) throw new Error(`clip ${clip.id} has a speed ramp — beats follow music playing at a steady speed`);
    const fps = doc.fps || 30, force = o.force === true;
    const sp = Math.min(8, Math.max(0.1, +clip.props?.speed || 1));
    const src0 = clip.in || 0, src1 = src0 + clip.duration * sp;
    const g = toTimeline(grid(a.beats, a.bpm, src0, src1), clip);
    const drop = a.drop != null && a.drop >= src0 && a.drop <= src1 ? toTimeline([a.drop], clip)[0] : null;
    const out = { clip: clip.id, bpm: a.bpm ? Math.round(a.bpm * sp * 10) / 10 : null, grid: g, drop, ops: [], done: [] };
    if (!g.length) return out;
    const locked = force ? new Set() : lockedIds(doc);
    const steady = (c) => !ramped(c);
    const media = new Map((doc.media || []).map((m) => [m.id, m]));
    const timed = (c) => (c.kind === "video" || c.kind === "audio") && media.get(c.mediaId)?.duration > 0;
    const speedOf = (c) => Math.min(8, Math.max(0.1, +c.props?.speed || 1));
    /** source seconds a clip may still use from its in point (Infinity for pictures and titles) */
    const mediaDur = (c) => timed(c) ? media.get(c.mediaId).duration - (c.in || 0) : Infinity;
    /** timeline seconds of footage before the clip's head and after its tail — the tightest of
     *  its linked group, which a roll moves together (a stem may sit on a shorter file) */
    const own = (c) => timed(c)
      ? { head: (c.in || 0) / speedOf(c), tail: Math.max(0, mediaDur(c) - c.duration * speedOf(c)) / speedOf(c) }
      : { head: Infinity, tail: Infinity };
    const spare = (c) => {
      const group = c.linkGroup ? doc.clips.filter((x) => x.linkGroup === c.linkGroup && x.id !== c.id).concat([c]) : [c];
      // c may carry an earlier roll's timing (snapOps); its partners moved by the same amount
      const shift = (x) => x.id === c.id ? c : { ...x, in: (x.in || 0) + ((c.in || 0) - (doc.clips.find((y) => y.id === c.id)?.in || 0)) * speedOf(x) / speedOf(c),
        duration: c.duration };
      return group.map((x) => own(shift(x))).reduce((m, r) => ({ head: Math.min(m.head, r.head), tail: Math.min(m.tail, r.tail) }), { head: Infinity, tail: Infinity });
    };

    if (o.markers) {
      const have = doc.markers || [];
      const free = g.filter((t) => !have.some((m) => Math.abs(t - m.t) < 0.01));
      const add = free.slice(0, 1000).map((t) => ({ t, color: "cyan" }));
      out.ops.push({ op: "setProject", set: { markers: have.concat(add).sort((x, y) => x.t - y.t) } });
      out.done.push(`marked ${add.length} beat${add.length === 1 ? "" : "s"} (cyan markers)` +
        (free.length > add.length ? ` — the first ${add.length}` : "") + (g.length > free.length ? ` (${g.length - free.length} already had a marker)` : ""));
    }

    if (o.snap) {
      const s = typeof o.snap === "object" ? o.snap : {};
      const untargeted = new Set(Array.isArray(doc.untargetedTracks) ? doc.untargetedTracks : []);
      const tracks = Array.isArray(s.tracks) && s.tracks.length ? s.tracks.map(String)
        : videoTracks(doc).filter((t) => !untargeted.has(t));
      const clips = doc.clips.filter((c) => c.id !== clip.id && steady(c));
      const blocked = { n: 0 };
      const all = snapOps(clips, tracks, g, { fps, bpm: out.bpm, maxShift: s.maxShift, spare, blocked });
      const byId = new Map(doc.clips.map((c) => [c.id, c]));
      const next = (id) => { const c = byId.get(id); return clips.find((x) => x.track === c.track && Math.abs(x.start - (c.start + c.duration)) < 0.5 / fps); };
      const ok = all.filter((op) => !locked.has(op.id) && !locked.has(next(op.id)?.id));
      for (const op of ok) out.ops.push(force ? { ...op, force: true } : op);
      const near = cuts(clips, tracks, g, fps).length;
      out.done.push(`snapped ${ok.length} of ${near} cut${near === 1 ? "" : "s"} on ${tracks.join(", ")} to the beat` +
        (all.length > ok.length ? ` (${all.length - ok.length} beside locked clips left alone)` : "") +
        (blocked.n ? ` (${blocked.n} without spare footage to reach the beat)` : "") +
        (near - all.length - blocked.n > 0 ? ` (${near - all.length - blocked.n} already on a beat or more than ${s.maxShift ?? "half a beat"}${s.maxShift != null ? " s" : ""} away)` : ""));
    }

    if (o.retime) {
      const r = typeof o.retime === "object" ? o.retime : {};
      const n = every(r.every ?? o.every);
      const lanes = videoTracks(doc);
      const track = r.track != null ? String(r.track) : lanes.find((t) => doc.clips.some((c) => c.track === t)) || "V1";
      const from = r.from != null ? +r.from : clip.start;
      if (!Number.isFinite(from)) throw new Error("retime.from must be a time in seconds");
      const music = (c) => c.id === clip.id || (clip.linkGroup && c.linkGroup === clip.linkGroup);
      const rest = doc.clips.filter((c) => !music(c));
      const on = rest.filter((c) => c.track === track && c.start >= from - 0.5 / fps);
      if (!on.length) throw new Error(`no clips on ${track} from ${fmt(from)} — nothing to re-cut`);
      const bad = on.filter((c) => locked.has(c.id));
      if (bad.length) throw new Error(`${bad.map((c) => c.id).join(", ")} ${bad.length === 1 ? "is" : "are"} locked — unlock, or pass force:true if the user asked`);
      const rampedOnes = on.filter(ramped);
      if (rampedOnes.length) throw new Error(`${rampedOnes.map((c) => c.id).join(", ")} ${rampedOnes.length === 1 ? "has" : "have"} a speed ramp — re-cutting needs clips at a steady speed`);
      // a clip's linked stems take its new length too: the tightest of the group sets how long it can be
      const groupDur = (c) => {
        const group = c.linkGroup ? rest.filter((x) => x.linkGroup === c.linkGroup) : [c];
        return Math.min(...group.map((x) => mediaDur(x) / speedOf(x))) * speedOf(c);
      };
      const p = retimePlan(rest, track, g, { n, from, fps, mediaDur: groupDur });
      if (p.skipped.length) throw new Error(`${p.skipped.join(", ")} ${p.skipped.length === 1 ? "has" : "have"} less than one beat of footage ` +
        "left after the in point — slip it earlier, shorten its in point, or take it off this track; nothing re-cut");
      const partners = (c) => c.linkGroup ? doc.clips.filter((x) => x.linkGroup === c.linkGroup && x.id !== c.id) : [];
      const byId = new Map(doc.clips.map((c) => [c.id, c]));
      for (const q of p.plan) {
        for (const c of [byId.get(q.id), ...partners(byId.get(q.id))]) {
          const op = { op: "updateClip", id: c.id, set: { start: q.start, duration: q.duration, ...fitTimed(c, q.duration) } };
          out.ops.push(force ? { ...op, force: true } : op);
        }
      }
      const onBeat = p.plan.filter((q) => q.beats).length;
      out.done.push(`re-cut ${onBeat} clip${onBeat === 1 ? "" : "s"} on ${track} to ${n} beat${n === 1 ? "" : "s"} each from ${fmt(p.plan[0]?.start ?? from)}` +
        (p.short.length ? ` (${p.short.join(", ")} ran out of footage: fewer beats)` : "") +
        (p.plan.length > onBeat ? ` (${p.plan.length - onBeat} past the music kept their length)` : ""));
      out.retime = { track, n, plan: p.plan };
    }
    return out;
  }

  /** The answer's text for a plan. */
  function describe(r, { applied = false, limit = 48 } = {}) {
    if (!r.grid.length) return `No steady beat found in clip ${r.clip} — it may be too quiet, too short or have no clear rhythm. Nothing changed.`;
    const per = r.grid.length > 1 ? (r.grid[r.grid.length - 1] - r.grid[0]) / (r.grid.length - 1) : 0;
    const lines = [`Beat of ${r.clip}: ${r.bpm != null ? r.bpm + " BPM, " : ""}${r.grid.length} beats from ${fmt(r.grid[0])} to ` +
      `${fmt(r.grid[r.grid.length - 1])} (one every ${per.toFixed(3)} s)` + (r.drop != null ? `; the drop at ${fmt(r.drop)}` : "") + ".",
      `Beats (timeline): ${r.grid.slice(0, limit).map((t) => t.toFixed(3)).join(" ")}${r.grid.length > limit ? ` … +${r.grid.length - limit} more` : ""}`];
    if (r.done.length) lines.push((applied ? "Done: " : "Would do: ") + r.done.join("; ") + ".");
    else lines.push("Nothing changed: markers:true marks the beats, snap:true rolls the cuts onto them, retime:{track, every} re-cuts a track's clips to the beat.");
    return lines.join("\n");
  }

  return { SR, HOP, WIN, EVERY, ONSET_LAG, MIN_DUR, fitTimed, lockedIds, videoTracks, plan, describe, resample, mono, analyze, grid, toTimeline, ramped, every, nearest, cuts, snapOps, retimePlan };
});
