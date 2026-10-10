/* FableCut masks — a clip's mask stack: the shapes, their validation, their
   keyframes and the matte they cut. Zero dependencies. Loaded by the editor
   as a plain script (global `FableCutMask`) and required by the MCP server and
   the tests, so the editor, an agent's `setMask` op and the tests agree on
   what a mask is.

   Masks live on a clip as `props.masks`, a list (first = bottom), each:
     { name?, on?, shape: rect | ellipse | bezier,
       mode?: add | subtract | intersect | difference   (default add),
       invert?, opacity? 0…1, feather? px, expand? px (− shrinks),
       x, y      centre, 0…1 of the clip's picture (y down),
       w, h      size, 0…1 of the picture (rect / ellipse),
       scale?, rotation?°,
       points?   bezier: [[dx, dy, inX?, inY?, outX?, outY?], …] — anchors
                 around x, y (fractions of the picture), each with optional
                 handles relative to the anchor; [dx, dy] alone is a corner,
       keys?: [{ t, ease?, x?, y?, w?, h?, scale?, rotation?, feather?,
                 expand?, opacity?, points? }] }   t = seconds from the clip's start
   A free-hand stroke comes in as { shape: "freehand", stroke: [[u, v], …] }
   (picture fractions) and is stored as the bezier fitted through it.

   The picture is the clip's drawn rectangle for video / image / svg, the text
   block for text and the whole frame for an adjustment layer, so a mask moves,
   scales and turns with its clip. feather and expand are in project pixels.
   Masks combine bottom-up into one matte; the first mask starts from empty when
   it adds and from full otherwise. invert flips a mask before it combines. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutMask = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_MASKS = 8;
  const MAX_POINTS = 64;
  const SHAPES = ["rect", "ellipse", "bezier"];
  const MODES = ["add", "subtract", "intersect", "difference"];
  const KEYED = ["x", "y", "w", "h", "scale", "rotation", "feather", "expand", "opacity", "points"];
  const NUM_KEYED = KEYED.filter((k) => k !== "points");
  const RANGE = {
    x: [-2, 3], y: [-2, 3], w: [0.001, 8], h: [0.001, 8], scale: [0.01, 20],
    rotation: [-3600, 3600], feather: [0, 1000], expand: [-1000, 1000], opacity: [0, 1],
  };
  const DEFAULTS = { mode: "add", opacity: 1, feather: 0, expand: 0, x: 0.5, y: 0.5, w: 0.5, h: 0.5, scale: 1, rotation: 0 };
  const KAPPA = 0.5522847498;   // cubic bezier quarter circle
  const EASES = {
    linear: (u) => u,
    "ease-in": (u) => u * u,
    "ease-out": (u) => 1 - (1 - u) * (1 - u),
    "ease-in-out": (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const r4 = (v) => +v.toFixed(4);
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

  /* ── Validation ── */
  /** A clip's mask list, validated. null when empty. strict: throw on bad input (agent). */
  function normalizeMasks(list, strict = false) {
    if (list == null) return null;
    if (!Array.isArray(list)) { if (strict) throw new Error("masks must be a list of masks"); return null; }
    if (list.length > MAX_MASKS) {
      if (strict) throw new Error(`masks has ${list.length} masks (at most ${MAX_MASKS})`);
      list = list.slice(0, MAX_MASKS);
    }
    const out = list.map((m, i) => normalizeMask(m, strict, `masks[${i}]`)).filter(Boolean);
    return out.length ? out : null;
  }
  function normalizePoints(pts, bad, label) {
    if (!Array.isArray(pts) || pts.length < 3 || pts.length > MAX_POINTS ||
      pts.some((p) => !Array.isArray(p) || (p.length !== 2 && p.length !== 6) || !p.every(isNum))) {
      bad(`${label} must be 3…${MAX_POINTS} points [dx, dy] or [dx, dy, inX, inY, outX, outY] (fractions of the picture)`);
      return null;
    }
    return pts.map((p) => {
      const q = p.map((v) => r4(clamp(v, -4, 4)));
      return q.length === 6 && q.slice(2).every((v) => v === 0) ? q.slice(0, 2) : q;
    });
  }
  /** One mask, validated, with every default filled in (so the editor never guesses). */
  function normalizeMask(m, strict = false, where = "mask") {
    if (m == null) return null;
    const bad = (msg) => { if (strict) throw new Error(`${where}${msg}`); return null; };
    if (!isObj(m)) return bad(" must be an object like {shape:'ellipse', x:0.5, y:0.5, w:0.4, h:0.6}");
    let src = m;
    if (m.shape === "freehand") {
      if (!Array.isArray(m.stroke) || m.stroke.length < 3 || m.stroke.some((p) => !Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])))
        return bad(".stroke must be at least 3 [u, v] points (fractions of the picture)");
      src = { ...m, ...fitStroke(m.stroke, m.aspect), shape: "bezier" };
      delete src.stroke; delete src.aspect;
    }
    const shape = src.shape == null ? "ellipse" : src.shape;
    if (!SHAPES.includes(shape)) return bad(`.shape must be ${SHAPES.join(" | ")} (or freehand with a stroke)`);
    const known = [...KEYED, "shape", "name", "on", "mode", "invert", "keys", "stroke", "aspect"];
    for (const k of Object.keys(src)) if (!known.includes(k)) bad(`.${k}: unknown key (${known.slice(0, -2).join(", ")})`);
    const out = { shape };
    if (typeof src.name === "string" && src.name.trim()) out.name = src.name.trim().slice(0, 40);
    else if (src.name != null && strict) bad(".name must be a string");
    if (src.on === false) out.on = false;
    const mode = src.mode == null ? "add" : src.mode;
    if (!MODES.includes(mode)) bad(`.mode must be ${MODES.join(" | ")}`);
    out.mode = MODES.includes(mode) ? mode : "add";
    if (src.invert === true) out.invert = true;
    for (const k of NUM_KEYED) {
      let v = src[k];
      if (v == null) v = DEFAULTS[k];
      else if (!isNum(v)) { bad(`.${k} must be a number`); v = DEFAULTS[k]; }
      out[k] = k === "rotation" ? r4(clamp(v, ...RANGE[k])) : r4(clamp(v, ...RANGE[k]));
    }
    if (shape === "bezier") {
      const pts = normalizePoints(src.points, bad, ".points");
      if (!pts) return null;
      out.points = pts;
    } else if (src.points != null && strict) bad(".points is for bezier masks");
    if (src.keys != null) {
      const keys = normalizeKeys(src.keys, out, bad);
      if (keys) out.keys = keys;
    }
    return out;
  }
  function normalizeKeys(list, m, bad) {
    if (!Array.isArray(list)) { bad(".keys must be a list of {t, x?, y?, …}"); return null; }
    const keys = [];
    for (const kf of list) {
      if (!isObj(kf) || !isNum(kf.t)) { bad(".keys entries need a time t (seconds from the clip's start)"); continue; }
      const k = { t: r4(Math.max(0, kf.t)) };
      for (const p of NUM_KEYED) if (isNum(kf[p])) k[p] = r4(clamp(kf[p], ...RANGE[p]));
      if (kf.points != null) {
        if (m.shape !== "bezier") bad(".keys points are for bezier masks");
        else {
          const pts = normalizePoints(kf.points, bad, ".keys points");
          if (pts && pts.length !== m.points.length) bad(`.keys points need the shape's ${m.points.length} points (got ${pts.length})`);
          else if (pts) k.points = pts;
        }
      }
      if (kf.ease && kf.ease !== "ease-in-out") {
        if (!EASES[kf.ease]) { bad(`.keys ease must be ${Object.keys(EASES).join(" | ")}`); continue; }
        k.ease = kf.ease;
      }
      if (Object.keys(k).some((p) => KEYED.includes(p))) keys.push(k);
    }
    keys.sort((a, b) => a.t - b.t);
    const dedup = keys.filter((k, i) => i === keys.length - 1 || keys[i + 1].t !== k.t);
    return dedup.length ? dedup : null;
  }
  /** Merge `set` into a mask key by key (null resets a key); a new shape starts fresh. */
  function mergeMask(base, set, strict = false) {
    if (set == null) return null;
    if (!isObj(set)) { if (strict) throw new Error("mask must be an object"); return base || null; }
    const next = { ...(base || {}) };
    if (set.shape === "freehand" || (set.shape && base && set.shape !== base.shape)) {
      for (const k of ["points", "keys", "w", "h"]) delete next[k];
    }
    for (const [k, v] of Object.entries(set)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    if (next.shape === "freehand") delete next.points;
    return normalizeMask(next, strict);
  }

  /* ── Time ── */
  function lerpPoints(a, b, u) {
    return a.map((p, i) => {
      const q = b[i], n = Math.max(p.length, q.length), out = [];
      for (let j = 0; j < n; j++) out.push((p[j] || 0) + ((q[j] || 0) - (p[j] || 0)) * u);
      return out;
    });
  }
  /** A mask as it is at clip-local time t (keys resolved and removed). */
  function maskAt(m, t) {
    if (!m || !m.keys || !m.keys.length) return m;
    const out = { ...m };
    delete out.keys;
    for (const p of KEYED) {
      const ks = m.keys.filter((k) => k[p] != null);
      if (!ks.length) continue;
      if (t <= ks[0].t) { out[p] = ks[0][p]; continue; }
      if (t >= ks[ks.length - 1].t) { out[p] = ks[ks.length - 1][p]; continue; }
      let i = 0;
      while (t > ks[i + 1].t) i++;
      const a = ks[i], b = ks[i + 1];
      const u = (EASES[b.ease || "ease-in-out"] || EASES.linear)((t - a.t) / Math.max(1e-9, b.t - a.t));
      out[p] = p === "points" ? lerpPoints(a.points, b.points, u) : a[p] + (b[p] - a[p]) * u;
    }
    return out;
  }
  /** The masks that cut the clip at clip-local time t, or null when none do. */
  function masksAt(list, t) {
    if (!Array.isArray(list) || !list.length) return null;
    const on = list.filter((m) => m && m.on !== false);
    return on.length ? on.map((m) => maskAt(m, t)) : null;
  }

  /* ── Geometry ── */
  /** A mask's outline as closed cubic segments in picture pixels (bw × bh box,
   *  origin top-left): [{x, y, ix, iy, ox, oy}, …] — anchors with absolute handles. */
  function anchors(m, bw, bh) {
    let local;   // in picture px around the mask centre, before scale / rotation
    if (m.shape === "rect") {
      const hx = m.w * bw / 2, hy = m.h * bh / 2;
      local = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => [x, y, 0, 0, 0, 0]);
    } else if (m.shape === "ellipse") {
      const rx = m.w * bw / 2, ry = m.h * bh / 2, kx = rx * KAPPA, ky = ry * KAPPA;
      local = [[0, -ry, -kx, 0, kx, 0], [rx, 0, 0, -ky, 0, ky], [0, ry, kx, 0, -kx, 0], [-rx, 0, 0, ky, 0, -ky]];
    } else {
      local = (m.points || []).map((p) => [p[0] * bw, p[1] * bh, (p[2] || 0) * bw, (p[3] || 0) * bh, (p[4] || 0) * bw, (p[5] || 0) * bh]);
    }
    const th = (m.rotation || 0) * Math.PI / 180, s = m.scale == null ? 1 : m.scale;
    const cs = Math.cos(th) * s, sn = Math.sin(th) * s, cx = m.x * bw, cy = m.y * bh;
    const vec = (x, y) => [x * cs - y * sn, x * sn + y * cs];
    return local.map(([x, y, ix, iy, ox, oy]) => {
      const [ax, ay] = vec(x, y), [hix, hiy] = vec(ix, iy), [hox, hoy] = vec(ox, oy);
      return { x: cx + ax, y: cy + ay, ix: cx + ax + hix, iy: cy + ay + hiy, ox: cx + ax + hox, oy: cy + ay + hoy };
    });
  }
  /** Trace the outline into a canvas-like path (moveTo / bezierCurveTo / closePath). */
  function tracePath(ctx, A) {
    if (!A.length) return;
    ctx.moveTo(A[0].x, A[0].y);
    for (let i = 0; i < A.length; i++) {
      const a = A[i], b = A[(i + 1) % A.length];
      ctx.bezierCurveTo(a.ox, a.oy, b.ix, b.iy, b.x, b.y);
    }
    ctx.closePath();
  }
  /** The outline as a polygon (each cubic cut into `n` pieces). */
  function flatten(A, n = 16) {
    const out = [];
    for (let i = 0; i < A.length; i++) {
      const a = A[i], b = A[(i + 1) % A.length];
      const straight = a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y;
      const steps = straight ? 1 : n;
      for (let j = 0; j < steps; j++) {
        const t = j / steps, u = 1 - t;
        out.push([
          u * u * u * a.x + 3 * u * u * t * a.ox + 3 * u * t * t * b.ix + t * t * t * b.x,
          u * u * u * a.y + 3 * u * u * t * a.oy + 3 * u * t * t * b.iy + t * t * t * b.y,
        ]);
      }
    }
    return out;
  }
  /** Signed distance from (px, py) to a polygon — negative inside (even-odd). */
  function polyDist(P, px, py) {
    let d = Infinity, inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i, i++) {
      const [x1, y1] = P[j], [x2, y2] = P[i], ex = x2 - x1, ey = y2 - y1;
      const k = clamp(((px - x1) * ex + (py - y1) * ey) / Math.max(1e-12, ex * ex + ey * ey), 0, 1);
      d = Math.min(d, Math.hypot(px - x1 - ex * k, py - y1 - ey * k));
      if ((y2 > py) !== (y1 > py) && px < x1 + (py - y1) * ex / (ey || 1e-12)) inside = !inside;
    }
    return inside ? -d : d;
  }
  const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  /** One mask's coverage (0…1) at picture pixel (px, py) — the CPU reference
   *  for the canvas raster; feather is a smooth ramp the width of `feather`. */
  function maskCoverage(m, px, py, bw, bh, pxScale = 1) {
    const d = polyDist(flatten(anchors(m, bw, bh)), px, py) - (m.expand || 0) * pxScale;
    const f = (m.feather || 0) * pxScale;
    let a = f > 0.5 ? 1 - smooth(-f / 2, f / 2, d) : (d <= 0 ? 1 : 0);
    if (m.invert) a = 1 - a;
    return a * (m.opacity == null ? 1 : m.opacity);
  }
  /** Combine one more mask's coverage into the matte so far. */
  function combine(acc, a, mode) {
    if (mode === "subtract") return acc * (1 - a);
    if (mode === "intersect") return acc * a;
    if (mode === "difference") return acc + a - 2 * acc * a;
    return acc + a - acc * a;
  }
  /** The matte value (0…1) at picture pixel (px, py) for a resolved mask list. */
  function matteAt(masks, px, py, bw, bh, pxScale = 1) {
    if (!masks || !masks.length) return 1;
    let acc = masks[0].mode === "add" ? 0 : 1;
    for (const m of masks) acc = combine(acc, maskCoverage(m, px, py, bw, bh, pxScale), m.mode);
    return acc;
  }

  /* ── Free-hand strokes → editable bezier ── */
  function rdp(P, eps) {
    if (P.length < 3) return P.slice();
    const keep = new Uint8Array(P.length);
    keep[0] = keep[P.length - 1] = 1;
    const stack = [[0, P.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [x1, y1] = P[a], [x2, y2] = P[b], ex = x2 - x1, ey = y2 - y1, L = Math.hypot(ex, ey) || 1e-12;
      let best = -1, bd = eps;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((P[i][0] - x1) * ey - (P[i][1] - y1) * ex) / L;
        if (d > bd) { bd = d; best = i; }
      }
      if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return P.filter((_, i) => keep[i]);
  }
  /** Fit a closed bezier through a stroke of [u, v] picture fractions. aspect =
   *  picture width / height (so the simplification is even in both directions);
   *  max = the most anchors to keep. Returns { x, y, points } ready for a bezier mask. */
  function fitStroke(stroke, aspect = 16 / 9, max = 40) {
    const a = isNum(aspect) && aspect > 0 ? aspect : 16 / 9;
    let P = stroke.map((p) => [p[0] * a, p[1]]);
    // drop the closing point when the stroke ends where it began
    while (P.length > 3 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-4) P.pop();
    let eps = 0.004, S = rdp(P, eps);
    while (S.length > Math.min(MAX_POINTS, max) && eps < 1) { eps *= 1.5; S = rdp(P, eps); }
    if (S.length < 3) S = [P[0], P[Math.floor(P.length / 3)], P[Math.floor(2 * P.length / 3)]];
    // centre on the bounding box, Catmull-Rom tangents → handles (1/6 of the chord)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of S) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, n = S.length;
    const points = S.map((p, i) => {
      const prev = S[(i - 1 + n) % n], next = S[(i + 1) % n];
      const tx = (next[0] - prev[0]) / 6, ty = (next[1] - prev[1]) / 6;
      return [(p[0] - cx) / a, p[1] - cy, -tx / a, -ty, tx / a, ty].map(r4);
    });
    return { x: r4(cx / a), y: r4(cy), points };
  }

  /* ── Raster (browser): the matte as the alpha of a canvas ── */
  /** Paint the matte for `masks` into `out` (a 2D context, W × H, cleared here).
   *  `m` = the DOMMatrix from the picture's top-left-origin box (bw × bh px) to
   *  the canvas; `pxScale` = canvas px per project px (feather / expand units);
   *  `tmp`, `tmp2` = two scratch 2D contexts of the same size. */
  function rasterize(out, tmp, tmp2, masks, m, bw, bh, pxScale = 1) {
    const W = out.canvas.width, H = out.canvas.height;
    const id = () => { out.setTransform(1, 0, 0, 1, 0, 0); tmp.setTransform(1, 0, 0, 1, 0, 0); tmp2.setTransform(1, 0, 0, 1, 0, 0); };
    id();
    out.globalAlpha = 1; out.globalCompositeOperation = "source-over"; out.filter = "none";
    out.clearRect(0, 0, W, H);
    if (masks[0].mode !== "add") { out.fillStyle = "#fff"; out.fillRect(0, 0, W, H); }
    const s = Math.hypot(m.a, m.b) || 1;   // the picture's scale on the canvas
    for (const mk of masks) {
      const A = anchors(mk, bw, bh);
      tmp.globalCompositeOperation = "source-over"; tmp.filter = "none"; tmp.globalAlpha = 1;
      tmp.clearRect(0, 0, W, H);
      tmp.setTransform(m);
      tmp.fillStyle = "#fff"; tmp.strokeStyle = "#fff"; tmp.lineJoin = "round";
      tmp.beginPath(); tracePath(tmp, A); tmp.fill();
      const ex = (mk.expand || 0) * pxScale / s;
      if (ex) {
        tmp.lineWidth = Math.abs(ex) * 2;
        if (ex < 0) tmp.globalCompositeOperation = "destination-out";
        tmp.stroke();
        tmp.globalCompositeOperation = "source-over";
      }
      tmp.setTransform(1, 0, 0, 1, 0, 0);
      let src = tmp;
      const f = (mk.feather || 0) * pxScale;
      if (f > 0.25) {
        tmp2.globalCompositeOperation = "source-over"; tmp2.globalAlpha = 1;
        tmp2.clearRect(0, 0, W, H);
        tmp2.filter = `blur(${(f / 2).toFixed(2)}px)`;
        tmp2.drawImage(tmp.canvas, 0, 0);
        tmp2.filter = "none";
        src = tmp2;
      }
      if (mk.invert) {
        src.globalCompositeOperation = "xor";
        src.fillStyle = "#fff"; src.fillRect(0, 0, W, H);
        src.globalCompositeOperation = "source-over";
      }
      out.globalAlpha = mk.opacity == null ? 1 : mk.opacity;
      out.globalCompositeOperation = mk.mode === "subtract" ? "destination-out" : mk.mode === "intersect" ? "destination-in"
        : mk.mode === "difference" ? "xor" : "source-over";
      out.drawImage(src.canvas, 0, 0);
    }
    out.globalAlpha = 1; out.globalCompositeOperation = "source-over";
  }

  /** One line per clip for status readouts: "2 masks: ellipse, bezier(12) −". */
  function describe(list) {
    if (!Array.isArray(list) || !list.length) return "";
    return `${list.length} mask${list.length > 1 ? "s" : ""}: ` + list.map((m) => {
      const bits = [m.name ? `"${m.name}" ` : "", m.shape, m.shape === "bezier" && m.points ? `(${m.points.length})` : "",
        m.mode && m.mode !== "add" ? ` ${m.mode}` : "", m.invert ? " inverted" : "", m.on === false ? " off" : "",
        m.feather ? ` feather ${m.feather}` : "", m.expand ? ` expand ${m.expand}` : "", m.keys ? ` ${m.keys.length} keys` : ""];
      return bits.join("");
    }).join(", ");
  }

  return {
    MAX_MASKS, MAX_POINTS, SHAPES, MODES, KEYED, NUM_KEYED, RANGE, DEFAULTS, EASES,
    normalizeMasks, normalizeMask, mergeMask, maskAt, masksAt,
    anchors, tracePath, flatten, polyDist, maskCoverage, combine, matteAt, fitStroke, rasterize, describe,
  };
});
