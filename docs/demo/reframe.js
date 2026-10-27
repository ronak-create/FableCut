/* FableCut reframe — follow the subject when a shot is shown on a canvas of
   another shape (a 16:9 edit made 9:16, 1:1 or 4:5). Zero dependencies; loaded
   by the editor as a plain script (global `FableCutReframe`) and required by
   the MCP server, so the editor, fablecut_reframe and Studio frame the same.

   subjectTrack: small RGB frames sampled through a clip → where the subject is
   in each (motion against the shot's own movement, detail and colour, with a
   gentle pull to the centre) and how sure that is. camera: a virtual operator
   on those samples — it holds while the subject stays inside a dead zone, then
   eases toward it no faster than a pan speed. keys: the camera as the clip's
   own x / y keyframes for a "cover"-fitted picture on the new canvas, kept
   inside the picture and thinned to the few keys that matter. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutReframe = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SAMPLE_FPS = 5;     // frames looked at per second of a clip
  const SAMPLE_W = 96;      // their width in px (height follows the picture)
  const ASPECTS = { "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5], "16:9": [16, 9], "4:3": [4, 3], "2:3": [2, 3] };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ── where the subject is ── */

  function lumaOf(rgb, n) {
    const y = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 3) y[i] = 0.2126 * rgb[j] + 0.7152 * rgb[j + 1] + 0.0722 * rgb[j + 2];
    return y;
  }
  /** Box blur radius r, separable, in place on a copy. */
  function blur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[y * w + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / (2 * r + 1);
        s += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / (2 * r + 1);
        s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
    return out;
  }
  /** Values scaled to 0…1 by their 98th percentile (one bright speck doesn't flatten the rest). */
  function norm(a) {
    const s = Array.from(a).sort((x, y) => x - y);
    const top = s[Math.floor(s.length * 0.98)] || 0;
    const out = new Float32Array(a.length);
    if (top <= 1e-6) return out;
    for (let i = 0; i < a.length; i++) out[i] = Math.min(1, a[i] / top);
    return out;
  }

  /** One frame's saliency map. `prev` is the previous frame's luma (or null). */
  function saliency(rgb, w, h, prev) {
    const n = w * h, y = lumaOf(rgb, n);
    // detail: gradient magnitude
    const det = new Float32Array(n);
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      det[k] = Math.abs(y[k + 1] - y[k - 1]) + Math.abs(y[k + w] - y[k - w]);
    }
    // colour: saturation (vivid things and skin stand out from grey surroundings)
    const sat = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const mx = Math.max(rgb[j], rgb[j + 1], rgb[j + 2]), mn = Math.min(rgb[j], rgb[j + 1], rgb[j + 2]);
      sat[i] = mx > 8 ? (mx - mn) / mx : 0;
    }
    // motion against the frame's own typical change (a pan or a flicker moves everything alike)
    let mot = null;
    if (prev) {
      mot = new Float32Array(n);
      for (let i = 0; i < n; i++) mot[i] = Math.abs(y[i] - prev[i]);
      const s = Array.from(mot).sort((a, b) => a - b), med = s[Math.floor(n / 2)];
      for (let i = 0; i < n; i++) mot[i] = Math.max(0, mot[i] - med * 1.5);
    }
    const r = Math.max(1, Math.round(w / 24));
    const D = norm(blur(det, w, h, r)), C = norm(blur(sat, w, h, r)), M = mot ? norm(blur(mot, w, h, r)) : null;
    const map = new Float32Array(n);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i, dx = (i + 0.5) / w - 0.5, dy = (j + 0.5) / h - 0.5;
      const prior = 0.55 + 0.45 * Math.exp(-(dx * dx + dy * dy) / (2 * 0.3 * 0.3));
      map[k] = prior * (M ? 0.5 * M[k] + 0.32 * D[k] + 0.18 * C[k] : 0.62 * D[k] + 0.38 * C[k]);
    }
    return { map, luma: y };
  }

  /** The subject's centre in a saliency map: the weighted centre of its strongest 12 %,
   *  and how gathered that is (1 = one tight spot, 0 = spread over the frame). */
  function centre(map, w, h) {
    const s = Array.from(map).sort((a, b) => a - b), cut = s[Math.floor(s.length * 0.88)];
    let sw = 0, sx = 0, sy = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const v = map[j * w + i] - cut;
      if (v <= 0) continue;
      sw += v; sx += v * (i + 0.5); sy += v * (j + 0.5);
    }
    if (sw <= 0) return { u: 0.5, v: 0.5, conf: 0 };
    const cx = sx / sw, cy = sy / sw;
    let spread = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const v = map[j * w + i] - cut;
      if (v > 0) spread += v * Math.hypot((i + 0.5 - cx) / w, (j + 0.5 - cy) / h);
    }
    spread /= sw;
    return { u: cx / w, v: cy / h, conf: clamp(1 - spread / 0.3, 0, 1) };
  }

  /** Frames → samples [[t, u, v, conf], …]: t in seconds from the first frame (at `fps`),
   *  u / v the subject's centre as fractions of the picture. `frames` are RGB bytes (w×h×3). */
  function subjectTrack(frames, w, h, { fps = SAMPLE_FPS } = {}) {
    const out = [];
    let prev = null;
    for (let f = 0; f < frames.length; f++) {
      const { map, luma } = saliency(frames[f], w, h, prev);
      const c = centre(map, w, h);
      out.push([Math.round((f / fps) * 1000) / 1000, c.u, c.v, c.conf]);
      prev = luma;
    }
    return out;
  }

  /* ── the virtual camera ── */

  /** Smooth the subject's path along one axis (k = 1 for u, 2 for v) into where the
   *  camera looks: a median against jitter, low-confidence samples held, then an operator
   *  that only moves once the subject leaves a dead zone around the frame's centre, and
   *  eases toward it no faster than `maxSpeed` (fractions of the picture per second).
   *  `smooth` 0…1 widens the dead zone and slows the pan. Returns [[t, pos], …]. */
  function camera(samples, k = 1, { smooth = 0.5, minConf = 0.15 } = {}) {
    if (!samples.length) return [];
    const sm = clamp(+smooth || 0, 0, 1);
    const dead = 0.04 + 0.1 * sm, maxSpeed = 0.6 - 0.4 * sm, ease = 0.35 + 0.4 * sm;
    // median of 5 against jitter
    const raw = samples.map((s) => s[k]);
    const med = raw.map((_, i) => { const win = raw.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b); return win[Math.floor(win.length / 2)]; });
    // unsure samples hold the last sure position (the first sure one, at the start)
    const firstSure = samples.findIndex((s) => s[3] >= minConf);
    let held = firstSure >= 0 ? med[firstSure] : 0.5;
    const target = samples.map((s, i) => (s[3] >= minConf ? (held = med[i]) : held));
    // the operator: starts on the subject, moves when it leaves the dead zone, eases, caps its speed
    let pos = target[0];
    const out = [[samples[0][0], pos]];
    for (let i = 1; i < samples.length; i++) {
      const dt = Math.max(1e-3, samples[i][0] - samples[i - 1][0]);
      const off = target[i] - pos;
      if (Math.abs(off) > dead) {
        const want = (off - Math.sign(off) * dead * 0.5) * (1 - Math.pow(1 - ease, dt * SAMPLE_FPS));
        pos += clamp(want, -maxSpeed * dt, maxSpeed * dt);
      }
      out.push([samples[i][0], pos]);
    }
    return out;
  }

  /** Fewest points that stay within `tol` of a path [[t, v], …] (Ramer–Douglas–Peucker). */
  function simplify(path, tol) {
    if (path.length <= 2) return path.slice();
    const keep = new Uint8Array(path.length);
    keep[0] = keep[path.length - 1] = 1;
    const stack = [[0, path.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let worst = -1, at = -1;
      for (let i = a + 1; i < b; i++) {
        const f = (path[i][0] - path[a][0]) / Math.max(1e-9, path[b][0] - path[a][0]);
        const d = Math.abs(path[i][1] - (path[a][1] + f * (path[b][1] - path[a][1])));
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
    }
    return path.filter((_, i) => keep[i]);
  }

  /* ── on the canvas ── */

  /** A picture srcW×srcH fitted with "cover" on a canvas W×H at clip scale `scale`:
   *  its drawn size and how far it may move each way before an edge shows. */
  function coverRect(srcW, srcH, W, H, scale = 1) {
    const s = Math.max(W / srcW, H / srcH) * scale;
    const pw = srcW * s, ph = srcH * s;
    return { pw, ph, maxX: Math.max(0, (pw - W) / 2), maxY: Math.max(0, (ph - H) / 2) };
  }
  /** The clip's x (or y) offset that puts picture fraction u at the canvas centre, kept inside the picture. */
  function offsetFor(u, size, max) { return clamp((0.5 - u) * size, -max, max); }

  /** A camera path [[t, u], …] (t in clip-source seconds from the clip's in point, at speed 1)
   *  → keyframes for the clip's x or y on the canvas: {static} when it hardly moves, else
   *  {keys:[{t, v, ease}]} in clip seconds, within ~2 px. */
  function keysFor(path, size, max, { speed = 1, fps = 30, tolPx = 2 } = {}) {
    if (!path.length || max <= 0.5) return { static: 0 };
    const px = path.map(([t, u]) => [t / speed, Math.round(offsetFor(u, size, max) * 10) / 10]);
    const lo = Math.min(...px.map((p) => p[1])), hi = Math.max(...px.map((p) => p[1]));
    if (hi - lo <= tolPx * 2) return { static: Math.round((lo + hi) / 2) };
    const keys = simplify(px, tolPx).map(([t, v], i) => ({ t: Math.round(t * fps) / fps, v: Math.round(v), ...(i ? { ease: "linear" } : {}) }));
    // two keys can land on one frame after rounding: keep the later
    return { keys: keys.filter((k, i) => i === keys.length - 1 || keys[i + 1].t > k.t) };
  }

  /** "9:16" (or [w, h]) → a canvas of that shape, as big as the project's longer side allows,
   *  even sizes (H.264): a 1920×1080 edit gives 1080×1920 for 9:16, 1080×1080 for 1:1. */
  function canvasFor(aspect, W, H) {
    const a = Array.isArray(aspect) ? aspect : ASPECTS[String(aspect)];
    if (!a || !(a[0] > 0 && a[1] > 0)) throw new Error(`aspect must be one of ${Object.keys(ASPECTS).join(", ")}`);
    const short = Math.min(W, H), even = (v) => Math.max(2, Math.round(v / 2) * 2);
    // the shorter side of the new canvas is the project's shorter side
    return a[0] <= a[1] ? { width: even(short), height: even(short * a[1] / a[0]) } : { width: even(short * a[0] / a[1]), height: even(short) };
  }

  /* ── on a project: which clips, and what to write ── */

  const near0 = (v) => v == null || Math.abs(+v) < 0.5;
  const hasKeys = (c, k) => Array.isArray(c.keyframes?.[k]) && c.keyframes[k].length > 0;

  /** The clips a reframe works on, from `doc` (the sequence as it will be): full-frame
   *  pictures — video clips (and stills) not moved, scaled, cropped or animated by hand,
   *  not fitted "none" or "stretch", not locked (unless force). Returns {take, skip:[{id, why}]}. */
  function targets(doc, { ids = null, force = false } = {}) {
    const lanes = new Set(Array.isArray(doc.lockedTracks) ? doc.lockedTracks : []);
    const take = [], skip = [];
    for (const c of doc.clips || []) {
      if (ids && !ids.includes(c.id)) continue;
      // audio has no picture; a title, shape or other layer on the picture is listed, to be checked on the new canvas
      if (c.kind !== "video" && c.kind !== "image") { if (ids || c.kind !== "audio") skip.push({ id: c.id, why: c.kind === "text" ? "a title" : `a ${c.kind} clip` }); continue; }
      const p = c.props || {};
      const ours = p.reframe === "follow" || p.reframe === "centre";   // reframed before: its fit and keys are ours to redo
      const why = !force && (c.locked || lanes.has(c.track)) ? "locked"
        : ours ? (["cropL", "cropR", "cropT", "cropB"].some((k) => +p[k] > 0) ? "cropped" : null)
        : p.fit === "none" || p.fit === "stretch" ? `fit:${p.fit}`
        : !near0(p.x) || !near0(p.y) || (p.scale != null && Math.abs(+p.scale - 1) > 0.01) ? "placed by hand (moved or scaled)"
        : hasKeys(c, "x") || hasKeys(c, "y") || hasKeys(c, "scale") ? "animated by hand (position or scale keys)"
        : ["cropL", "cropR", "cropT", "cropB"].some((k) => +p[k] > 0) ? "cropped"
        : Array.isArray(c.keyframes?.speed) && c.keyframes.speed.length ? "a speed ramp"
        : null;
      if (why) skip.push({ id: c.id, why }); else take.push(c);
    }
    return { take, skip };
  }

  /** What one clip gets: fit cover, and an x (or y) that follows the subject — keys, or one
   *  steady value. `samples` from subjectTrack (null: centre it); `src` {width, height} the
   *  picture; `canvas` {width, height}. Returns {set, note} for an updateClip op. */
  function clipPlan(c, samples, src, canvas, { smooth = 0.5, fps = 30, follow = true } = {}) {
    const r = coverRect(src.width, src.height, canvas.width, canvas.height, 1);
    const axis = r.maxX >= r.maxY ? "x" : "y";
    const size = axis === "x" ? r.pw : r.ph, max = axis === "x" ? r.maxX : r.maxY;
    // only what changes: updateClip merges props key by key, and null takes one away. props.reframe marks the
    // fit and position as reframe's own, so running it again redoes them instead of calling them hand-made.
    const props = { fit: "cover", x: null, y: null, reframe: follow ? "follow" : "centre" };
    const rest = { ...(c.keyframes || {}) };
    delete rest.x; delete rest.y;
    const set = { props };
    if (c.keyframes && (c.keyframes.x || c.keyframes.y)) set.keyframes = Object.keys(rest).length ? rest : null;
    const sp = Math.min(8, Math.max(0.1, +c.props?.speed || 1));
    const sure = samples && samples.length ? samples.reduce((n, s) => n + s[3], 0) / samples.length : 0;
    if (!follow || max <= 0.5 || !samples || !samples.length || sure < 0.12) {
      const why = max <= 0.5 ? "already this shape" : !follow ? "centred" : "no clear subject — centred";
      return { set, note: why, axis, keys: 0 };
    }
    const path = camera(samples, axis === "x" ? 1 : 2, { smooth });
    const k = keysFor(path, size, max, { speed: sp, fps });
    if (k.keys) {
      set.keyframes = { ...rest, [axis]: k.keys };
      const vals = k.keys.map((q) => q.v), span = (Math.max(...vals) - Math.min(...vals)) / (2 * max || 1);
      return { set, note: `follows the subject (${k.keys.length} keys, pans ${Math.round(span * 100)}% of the room)`, axis, keys: k.keys.length };
    }
    props[axis] = k.static;
    return { set, note: k.static ? `held on the subject (${axis} ${k.static > 0 ? "+" : ""}${k.static})` : "subject in the middle — centred", axis, keys: 0 };
  }

  return { SAMPLE_FPS, SAMPLE_W, ASPECTS, targets, clipPlan, saliency, centre, subjectTrack, camera, simplify, coverRect, offsetFor, keysFor, canvasFor };
});
