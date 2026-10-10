/* FableCut tracker — follows a region of a video from frame to frame by
   template matching (normalized cross-correlation), optionally with its scale
   and rotation. Zero dependencies. Loaded by the editor as a plain script
   (global `FableCutTracker`) and required by the MCP server and the tests.

   The editor feeds it greyscale frames; it returns where the region went.
   A finished track is stored on the clip it was made on, in `props.tracks`:
     { name, kind: "point" | "box", w, h,     region size at the first sample,
                                              fractions of the clip's picture
       samples: [[t, x, y, s, r, q], …] }     t = seconds from the clip's start,
                                              x, y = centre (fractions of the picture),
                                              s = scale against the first sample,
                                              r = rotation° against the first sample,
                                              q = match quality 0…1
   Masks and other clips follow a track by having it baked into their keys. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutTracker = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_TRACKS = 16;
  const MAX_SAMPLES = 20000;
  const KINDS = ["point", "box"];
  const GRID = 40;          // template samples per side (at most)
  const MIN_SCORE = 0.45;   // below this the region is lost
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const r4 = (v) => +v.toFixed(4);

  /** RGBA bytes → luma (0…255) as a Float32Array. */
  function toGray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    return g;
  }

  /** Bilinear sample, clamped to the frame. */
  function sample(img, w, h, x, y) {
    x = clamp(x, 0, w - 1.001); y = clamp(y, 0, h - 1.001);
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    const a = img[i], b = img[i + 1], c = img[i + w], d = img[i + w + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /**
   * Follow a region. `box` = {cx, cy, w, h} in frame pixels on `first`.
   * opts: scale / rotation (search them too), search (px radius, default from the box size).
   * Returns { step(frame) → {cx, cy, s, r, q, lost} }.
   */
  function createTracker(first, w, h, box, opts = {}) {
    const gw = Math.max(6, Math.min(GRID, Math.round(box.w))), gh = Math.max(6, Math.min(GRID, Math.round(box.h)));
    const sx = box.w / gw, sy = box.h / gh, n = gw * gh;
    // template offsets around the centre, before scale / rotation
    const ox = new Float32Array(n), oy = new Float32Array(n);
    for (let j = 0, k = 0; j < gh; j++) for (let i = 0; i < gw; i++, k++) { ox[k] = (i - (gw - 1) / 2) * sx; oy[k] = (j - (gh - 1) / 2) * sy; }
    const coarse = [];   // every other sample, for the wide first pass
    for (let j = 0; j < gh; j += 2) for (let i = 0; i < gw; i += 2) coarse.push(j * gw + i);
    const idxAll = Array.from({ length: n }, (_, k) => k);
    const buf = new Float32Array(n);

    function grab(img, cx, cy, s, r, idx, out) {
      const cs = Math.cos(r) * s, sn = Math.sin(r) * s;
      for (let m = 0; m < idx.length; m++) {
        const k = idx[m];
        out[m] = sample(img, w, h, cx + ox[k] * cs - oy[k] * sn, cy + ox[k] * sn + oy[k] * cs);
      }
      return out;
    }
    /** Zero-mean, unit-norm copy (null when flat). */
    function normed(v, len) {
      let mean = 0;
      for (let i = 0; i < len; i++) mean += v[i];
      mean /= len;
      let ss = 0;
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) { out[i] = v[i] - mean; ss += out[i] * out[i]; }
      if (ss < 1e-3 * len) return null;
      const k = 1 / Math.sqrt(ss);
      for (let i = 0; i < len; i++) out[i] *= k;
      return out;
    }
    function ncc(tn, v, len) {
      let sv = 0, sv2 = 0, st = 0;
      for (let i = 0; i < len; i++) { const x = v[i]; sv += x; sv2 += x * x; st += tn[i] * x; }
      const varv = sv2 - (sv * sv) / len;
      return varv > 1e-6 ? st / Math.sqrt(varv) : 0;
    }

    const raw0 = Float32Array.from(grab(first, box.cx, box.cy, 1, 0, idxAll, buf));
    let raw = Float32Array.from(raw0);
    const pick = (src, idx) => Float32Array.from(idx, (k) => src[k]);
    let tAll = normed(raw, n), tCoarse = normed(pick(raw, coarse), coarse.length);
    const flat = !tAll || !tCoarse;
    let cx = box.cx, cy = box.cy, s = 1, r = 0, vx = 0, vy = 0;
    const R = opts.search || Math.max(12, Math.round(0.8 * Math.max(box.w, box.h)));
    const cbuf = new Float32Array(coarse.length);

    function score(px, py, ps, pr, fine) {
      return fine ? ncc(tAll, grab(cur, px, py, ps, pr, idxAll, buf), n) : ncc(tCoarse, grab(cur, px, py, ps, pr, coarse, cbuf), coarse.length);
    }
    let cur = first;

    function step(frame) {
      if (flat) return { cx, cy, s, r, q: 0, lost: true };
      cur = frame;
      const px = cx + vx * 0.7, py = cy + vy * 0.7;
      // 1. wide pass on the coarse grid
      let best = { x: px, y: py, q: -2 };
      const st = Math.max(1, Math.round(Math.min(sx, sy) * 1.5));
      for (let dy = -R; dy <= R; dy += st) for (let dx = -R; dx <= R; dx += st) {
        const q = score(px + dx, py + dy, s, r, false);
        if (q > best.q) best = { x: px + dx, y: py + dy, q };
      }
      // 2. full grid, one-pixel steps around it
      let fb = { x: best.x, y: best.y, s, r, q: -2 };
      const look = (x, y, ss, rr) => { const q = score(x, y, ss, rr, true); if (q > fb.q) fb = { x, y, s: ss, r: rr, q }; return q; };
      for (let dy = -st; dy <= st; dy++) for (let dx = -st; dx <= st; dx++) look(best.x + dx, best.y + dy, s, r);
      // 3. scale / rotation, then the position again
      if (opts.scale || opts.rotation) {
        for (const [fs, fr] of [[1.03, 0.035], [1.01, 0.012], [1.004, 0.005]]) {   // coarse to fine
          const c0 = fb;
          for (const ds of opts.scale ? [1 / fs, 1, fs] : [1]) for (const dr of opts.rotation ? [-fr, 0, fr] : [0])
            if (ds !== 1 || dr !== 0) look(c0.x, c0.y, c0.s * ds, c0.r + dr);
          const c1 = fb;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) look(c1.x + dx, c1.y + dy, c1.s, c1.r);
        }
      }
      // 4. sub-pixel: a parabola through the neighbours on each axis
      const q0 = fb.q;
      const qx1 = score(fb.x - 1, fb.y, fb.s, fb.r, true), qx2 = score(fb.x + 1, fb.y, fb.s, fb.r, true);
      const qy1 = score(fb.x, fb.y - 1, fb.s, fb.r, true), qy2 = score(fb.x, fb.y + 1, fb.s, fb.r, true);
      const sub = (a, b) => { const d = a - 2 * q0 + b; return d < -1e-6 ? clamp(0.5 * (a - b) / d, -0.5, 0.5) : 0; };
      const nx = fb.x + sub(qx1, qx2), ny = fb.y + sub(qy1, qy2);
      const lost = fb.q < MIN_SCORE || nx < 0 || ny < 0 || nx >= w || ny >= h;
      if (lost) return { cx, cy, s, r, q: Math.max(0, fb.q), lost: true };
      vx = nx - cx; vy = ny - cy; cx = nx; cy = ny; s = fb.s; r = fb.r;
      // keep the template fresh on good matches, anchored to the first frame so it does not drift
      if (fb.q > 0.8) {
        const now = grab(cur, cx, cy, s, r, idxAll, new Float32Array(n));
        for (let i = 0; i < n; i++) raw[i] = 0.5 * raw0[i] + 0.35 * raw[i] + 0.15 * now[i];
        const a = normed(raw, n), b = normed(pick(raw, coarse), coarse.length);
        if (a && b) { tAll = a; tCoarse = b; }
      }
      return { cx, cy, s, r: r * 180 / Math.PI, q: fb.q, lost: false };
    }
    return { step, flat };
  }

  /* ── Stored tracks ── */
  function normalizeTracks(list, strict = false) {
    if (list == null) return null;
    const bad = (msg) => { if (strict) throw new Error(msg); };
    if (!Array.isArray(list)) { bad("tracks must be a list"); return null; }
    if (list.length > MAX_TRACKS) bad(`tracks: at most ${MAX_TRACKS}`);
    const out = [], names = new Set();
    list.slice(0, MAX_TRACKS).forEach((tr, i) => {
      const where = `tracks[${i}]`;
      if (!isObj(tr)) { bad(`${where} must be an object`); return; }
      const name = typeof tr.name === "string" && tr.name.trim() ? tr.name.trim().slice(0, 60) : `Track ${i + 1}`;
      if (names.has(name)) { bad(`${where}: the name "${name}" is used twice`); return; }
      if (tr.kind != null && !KINDS.includes(tr.kind)) bad(`${where}.kind must be ${KINDS.join(" | ")}`);
      const samples = [];
      for (const sm of Array.isArray(tr.samples) ? tr.samples.slice(0, MAX_SAMPLES) : []) {
        if (!Array.isArray(sm) || sm.length < 3 || !sm.slice(0, 3).every(isNum)) { bad(`${where}.samples: each is [t, x, y, s?, r?, q?]`); continue; }
        const [t, x, y, s = 1, r = 0, q = 1] = sm;
        samples.push([r4(Math.max(0, t)), r4(x), r4(y), r4(isNum(s) && s > 0 ? s : 1), r4(isNum(r) ? r : 0), r4(isNum(q) ? clamp(q, 0, 1) : 1)]);
      }
      samples.sort((a, b) => a[0] - b[0]);
      const dedup = samples.filter((sm, j) => j === samples.length - 1 || samples[j + 1][0] !== sm[0]);
      if (!dedup.length) { bad(`${where} has no samples`); return; }
      names.add(name);
      out.push({
        name, kind: KINDS.includes(tr.kind) ? tr.kind : "point",
        w: r4(clamp(isNum(tr.w) ? tr.w : 0.05, 0.001, 4)), h: r4(clamp(isNum(tr.h) ? tr.h : 0.05, 0.001, 4)),
        samples: dedup,
      });
    });
    return out.length ? out : null;
  }

  /** The track's position at clip-local t: { x, y, s, r, q } (linear between samples; held past the ends). */
  function trackAt(tr, t) {
    const S = tr.samples, last = S.length - 1;
    const at = (sm) => ({ x: sm[1], y: sm[2], s: sm[3], r: sm[4], q: sm[5], inside: false });
    if (t <= S[0][0]) return { ...at(S[0]), inside: t >= S[0][0] - 1e-6 };
    if (t >= S[last][0]) return { ...at(S[last]), inside: t <= S[last][0] + 1e-6 };
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid][0] <= t) lo = mid; else hi = mid; }
    const a = S[lo], b = S[hi], u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
    const L = (i) => a[i] + (b[i] - a[i]) * u;
    return { x: L(1), y: L(2), s: L(3), r: L(4), q: Math.min(a[5], b[5]), inside: true };
  }

  /** A clip's head moved by `offset` s: sample times follow; samples now before 0 or after dur go. */
  function shiftTracks(list, offset, dur = Infinity) {
    if (!Array.isArray(list) || !offset) return list;
    const out = [];
    for (const tr of list) {
      const samples = (tr.samples || []).map((sm) => [r4(sm[0] - offset), ...sm.slice(1)]).filter((sm) => sm[0] >= -1e-3 && sm[0] <= dur + 1e-3);
      if (samples.length) out.push({ ...tr, samples });
    }
    return out;
  }

  /** Centred moving averages: scale and rotation over ±k frames, position over ±kp (0 = as tracked). */
  function smooth(samples, k = 3, kp = 0) {
    if (samples.length < 3) return samples.slice();
    const avg = (i, col, w) => {
      let v = 0, n = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(samples.length - 1, i + w); j++) { v += samples[j][col]; n++; }
      return v / n;
    };
    return samples.map((sm, i) => [sm[0], kp ? avg(i, 1, kp) : sm[1], kp ? avg(i, 2, kp) : sm[2], avg(i, 3, k), avg(i, 4, k), sm[5]]);
  }

  /**
   * The samples worth keying: drops samples a straight line between their
   * neighbours already explains within `tol` (in the units of x / y), 0.4 % of
   * scale or 0.3° of rotation. Ramer–Douglas–Peucker over time.
   */
  function simplify(samples, tol = 0.001, sTol = 0.004, rTol = 0.3) {
    if (samples.length <= 2) return samples.slice();
    const keep = new Uint8Array(samples.length);
    keep[0] = keep[samples.length - 1] = 1;
    const err = (a, b, m) => {
      const u = (m[0] - a[0]) / Math.max(1e-9, b[0] - a[0]);
      const L = (i) => a[i] + (b[i] - a[i]) * u;
      return Math.max(Math.hypot(m[1] - L(1), m[2] - L(2)) / tol, Math.abs(m[3] - L(3)) / sTol, Math.abs(m[4] - L(4)) / rTol);
    };
    const stack = [[0, samples.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      let worst = 0, at = -1;
      for (let k = i + 1; k < j; k++) { const e = err(samples[i], samples[j], samples[k]); if (e > worst) { worst = e; at = k; } }
      if (worst > 1 && at > 0) { keep[at] = 1; stack.push([i, at], [at, j]); }
    }
    return samples.filter((_, i) => keep[i]);
  }

  function describe(list) {
    if (!list || !list.length) return "";
    return list.map((tr) => {
      const S = tr.samples, a = S[0][0], b = S[S.length - 1][0];
      return `"${tr.name}" ${tr.kind} ${a.toFixed(2)}–${b.toFixed(2)} s (${S.length} samples)`;
    }).join(", ");
  }

  return { MAX_TRACKS, MAX_SAMPLES, KINDS, MIN_SCORE, toGray, sample, createTracker, normalizeTracks, trackAt, shiftTracks, smooth, simplify, describe };
});
