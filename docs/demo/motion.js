/* FableCut motion graphics — shape layers and layer transforms. Zero
   dependencies. Loaded by the editor as a plain script (global
   `FableCutMotion`) and required by edit-ops, the MCP server and the tests, so
   the editor, an agent's `setShape` / `setParent` ops and the tests agree on
   what a shape is and where a parented layer lands.

   Shape layers: a clip of kind "shape" draws `props.shapes`, a list (first =
   bottom), each item:
     { type: rect | ellipse | polygon | star | line | path | group, name?, on?,
       x, y        position in layer px, from the layer's origin (y down),
       rotation°, scale, opacity 0…1,
       w, h        size in px (rect / ellipse / polygon / star),
       radius      rect corner radius, px,
       sides       polygon / star points (3…64); inner: a star's inner radius (0.05…1 of the outer),
       points      line / path: [[x, y, inX?, inY?, outX?, outY?], …] px around x, y,
                   handles relative to their point; a line has exactly 2 points,
       closed      path: true (default) closes it; a line is always open,
       fill        "#rrggbb" | "#rrggbbaa" | "none"; stroke likewise,
       strokeWidth px, lineCap butt | round | square, lineJoin miter | round | bevel,
       dash        [on, off, …] px,
       trimStart, trimEnd   0…100 — the part of the outline that is drawn (a draw-on),
       trimOffset  % of the outline the drawn part is shifted round by,
       items       group: its own items, moved, turned, scaled, faded and trimmed together,
       keys        [{ t, ease?, x?, y?, rotation?, scale?, opacity?, w?, h?, radius?, inner?,
                      strokeWidth?, trimStart?, trimEnd?, trimOffset?, fill?, stroke?, points? }] }
                   t = seconds from the clip's start.
   The layer's own props.trimStart / trimEnd / trimOffset trim every path in it.

   Layer transforms (every visual clip):
     props.anchorX, anchorY  layer px from the picture's centre: the point that sits
                             at x / y and that rotation and scale turn around
     clip.parent             another clip's id: this clip moves, turns and scales
                             with it (its x / y are then in the parent's space).
                             Opacity, transitions and effects are not inherited. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutMotion = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TYPES = ["rect", "ellipse", "polygon", "star", "line", "path", "group"];
  const MAX_ITEMS = 64;       // every item in the layer, groups and their children included
  const MAX_DEPTH = 4;        // groups inside groups
  const MAX_POINTS = 128;
  const MAX_PARENT_DEPTH = 16;
  const CAPS = ["butt", "round", "square"];
  const JOINS = ["miter", "round", "bevel"];
  const KAPPA = 0.5522847498;
  const RANGE = {
    x: [-20000, 20000], y: [-20000, 20000], rotation: [-36000, 36000], scale: [0.001, 100], opacity: [0, 1],
    w: [0, 20000], h: [0, 20000], radius: [0, 10000], inner: [0.05, 1], strokeWidth: [0, 1000],
    trimStart: [0, 100], trimEnd: [0, 100], trimOffset: [-10000, 10000],
  };
  const NUM_KEYED = Object.keys(RANGE);
  const COLOR_KEYED = ["fill", "stroke"];
  const KEYED = [...NUM_KEYED, ...COLOR_KEYED, "points"];
  const TRANSFORM = ["x", "y", "rotation", "scale", "opacity"];
  const TRIM = ["trimStart", "trimEnd", "trimOffset"];
  /** Which keys each type takes beyond the transform, trim and name / on / keys. */
  const OWN = {
    rect: ["w", "h", "radius"], ellipse: ["w", "h"], polygon: ["w", "h", "sides"], star: ["w", "h", "sides", "inner"],
    line: ["points"], path: ["points", "closed"], group: ["items"],
  };
  const PAINT = ["fill", "stroke", "strokeWidth", "lineCap", "lineJoin", "dash"];
  const EASES = {
    linear: (u) => u,
    "ease-in": (u) => u * u,
    "ease-out": (u) => 1 - (1 - u) * (1 - u),
    "ease-in-out": (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const r3 = (v) => +v.toFixed(3);
  const r4 = (v) => +v.toFixed(4);

  /* ── Colours ── */
  /** "#rrggbb" / "#rrggbbaa" (lower case), "none", or null when it is not a colour. */
  function normColor(v) {
    if (v === "none" || v === "transparent" || v === "") return "none";
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{3,4}$/.test(s)) return "#" + [...s.slice(1)].map((c) => c + c).join("");
    return /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(s) ? s : null;
  }
  const rgba = (c) => {
    if (!c || c === "none") return [0, 0, 0, 0];
    const n = (i) => parseInt(c.slice(i, i + 2), 16);
    return [n(1), n(3), n(5), c.length > 7 ? n(7) : 255];
  };
  /** Colour between a and b ("none" fades through the other colour's transparent self). */
  function lerpColor(a, b, u) {
    if (a === b) return a;
    let A = rgba(a), B = rgba(b);
    if (a === "none") A = [B[0], B[1], B[2], 0];
    if (b === "none") B = [A[0], A[1], A[2], 0];
    const m = A.map((v, i) => Math.round(v + (B[i] - v) * u));
    if (m[3] <= 0 && (a === "none" || b === "none") && u >= 1) return "none";
    const hx = (v) => clamp(v, 0, 255).toString(16).padStart(2, "0");
    return "#" + hx(m[0]) + hx(m[1]) + hx(m[2]) + (m[3] < 255 ? hx(m[3]) : "");
  }

  /* ── Validation ── */
  const isClosed = (it) => it.type !== "line" && (it.type !== "path" || it.closed !== false);
  function defaultsFor(type, closed = true) {
    const open = type === "line" || (type === "path" && !closed);
    const d = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1, trimStart: 0, trimEnd: 100, trimOffset: 0 };
    if (type === "group") return d;
    Object.assign(d, { fill: open ? "none" : "#ffffff", stroke: open ? "#ffffff" : "none", lineCap: "round", lineJoin: "round" });
    if (type === "rect" || type === "ellipse" || type === "polygon" || type === "star") Object.assign(d, { w: 200, h: 200 });
    if (type === "rect") d.radius = 0;
    if (type === "polygon") d.sides = 6;
    if (type === "star") Object.assign(d, { sides: 5, inner: 0.5 });
    if (type === "line") d.points = [[-150, 0], [150, 0]];
    return d;
  }
  function normalizePoints(pts, type, bad, label) {
    const min = 2, max = type === "line" ? 2 : MAX_POINTS;
    if (!Array.isArray(pts) || pts.length < min || pts.length > max ||
      pts.some((p) => !Array.isArray(p) || (p.length !== 2 && p.length !== 6) || !p.every(isNum))) {
      bad(`${label} must be ${type === "line" ? "exactly 2" : `2…${MAX_POINTS}`} points [x, y] or [x, y, inX, inY, outX, outY] (px around the item's x, y)`);
      return null;
    }
    return pts.map((p) => {
      const q = p.map((v) => r3(clamp(v, -20000, 20000)));
      return q.length === 6 && q.slice(2).every((v) => v === 0) ? q.slice(0, 2) : q;
    });
  }
  /** A layer's shape list, validated, with every default filled in. null when empty.
   *  strict: throw on bad input (agent); otherwise drop what is invalid. */
  function normalizeShapes(list, strict = false) {
    if (list == null) return null;
    if (!Array.isArray(list)) { if (strict) throw new Error("shapes must be a list of shape items"); return null; }
    const count = { n: 0 };
    const out = list.map((it, i) => normalizeItem(it, strict, `shapes[${i}]`, 0, count)).filter(Boolean);
    return out.length ? out : null;
  }
  /** One shape item, validated (groups with their items). */
  function normalizeItem(it, strict = false, where = "shape", depth = 0, count = { n: 0 }) {
    if (it == null) return null;
    const bad = (msg) => { if (strict) throw new Error(`${where}${msg}`); return null; };
    if (!isObj(it)) return bad(" must be an object like {type:'rect', w:300, h:120, fill:'#ffd166'}");
    if (++count.n > MAX_ITEMS) return bad(`: a shape layer has at most ${MAX_ITEMS} items`);
    const type = it.type == null ? "rect" : it.type;
    if (!TYPES.includes(type)) return bad(`.type must be ${TYPES.join(" | ")}`);
    if (type === "group" && depth >= MAX_DEPTH) return bad(`: groups nest at most ${MAX_DEPTH} deep`);
    const known = ["type", "name", "on", "keys", ...TRANSFORM, ...TRIM, ...OWN[type], ...(type === "group" ? [] : PAINT)];
    for (const k of Object.keys(it)) if (!known.includes(k)) bad(`.${k}: not a ${type} key (${known.join(", ")})`);
    const closed = type === "path" ? it.closed !== false : type !== "line";
    const d = defaultsFor(type, closed);
    const out = { type };
    if (typeof it.name === "string" && it.name.trim()) out.name = it.name.trim().slice(0, 40);
    else if (it.name != null) bad(".name must be a string");
    if (it.on === false) out.on = false;
    for (const k of [...TRANSFORM, ...TRIM, ...OWN[type].filter((k) => RANGE[k])]) {
      let v = it[k];
      if (v == null) v = d[k];
      else if (!isNum(v)) { bad(`.${k} must be a number`); v = d[k]; }
      out[k] = r4(clamp(v, ...RANGE[k]));
    }
    if (OWN[type].includes("sides")) {
      let v = it.sides == null ? d.sides : it.sides;
      if (!Number.isInteger(v) || v < 3 || v > 64) { bad(".sides must be a whole number 3…64"); v = d.sides; }
      out.sides = clamp(Math.round(+v || d.sides), 3, 64);
    }
    if (type === "line" || type === "path") {
      const pts = it.points == null && type === "line" ? d.points : normalizePoints(it.points, type, bad, ".points");
      if (!pts) return null;
      out.points = pts;
      if (type === "path" && it.closed === false) out.closed = false;
    }
    if (type === "group") {
      if (it.items != null && !Array.isArray(it.items)) bad(".items must be a list of shape items");
      out.items = (Array.isArray(it.items) ? it.items : []).map((c, i) => normalizeItem(c, strict, `${where}.items[${i}]`, depth + 1, count)).filter(Boolean);
    } else {
      for (const k of COLOR_KEYED) {
        const v = it[k] == null ? d[k] : normColor(it[k]);
        if (v == null) bad(`.${k} must be a colour "#rrggbb" / "#rrggbbaa" or "none"`);
        out[k] = v || d[k];
      }
      let sw = it.strokeWidth;
      if (sw != null && !isNum(sw)) { bad(".strokeWidth must be a number (px)"); sw = null; }
      if (sw == null) sw = out.stroke === "none" ? 0 : closed ? 6 : 8;
      if (sw || out.stroke !== "none") out.strokeWidth = r3(clamp(sw, ...RANGE.strokeWidth));
      out.lineCap = CAPS.includes(it.lineCap) ? it.lineCap : (it.lineCap != null && bad(`.lineCap must be ${CAPS.join(" | ")}`), d.lineCap);
      out.lineJoin = JOINS.includes(it.lineJoin) ? it.lineJoin : (it.lineJoin != null && bad(`.lineJoin must be ${JOINS.join(" | ")}`), d.lineJoin);
      if (it.dash != null) {
        if (!Array.isArray(it.dash) || it.dash.length > 8 || !it.dash.every((v) => isNum(v) && v >= 0) || !it.dash.some((v) => v > 0)) bad(".dash must be a list of up to 8 lengths in px, e.g. [20, 10]");
        else out.dash = it.dash.map((v) => r3(Math.min(v, 10000)));
      }
    }
    if (it.keys != null) {
      const keys = normalizeKeys(it.keys, out, bad);
      if (keys) out.keys = keys;
    }
    return out;
  }
  function normalizeKeys(list, it, bad) {
    if (!Array.isArray(list)) { bad(".keys must be a list of {t, x?, y?, …}"); return null; }
    const ok = it.type === "group" ? [...TRANSFORM, ...TRIM] : [...TRANSFORM, ...TRIM, ...OWN[it.type].filter((k) => RANGE[k]), ...COLOR_KEYED, ...(it.points ? ["points"] : [])];
    const keys = [];
    for (const kf of list) {
      if (!isObj(kf) || !isNum(kf.t)) { bad(".keys entries need a time t (seconds from the clip's start)"); continue; }
      const k = { t: r4(Math.max(0, kf.t)) };
      for (const p of Object.keys(kf)) {
        if (p === "t" || p === "ease") continue;
        if (!ok.includes(p)) { bad(`.keys: ${p} is not keyable on a ${it.type} (${ok.join(", ")})`); continue; }
        if (RANGE[p]) { if (isNum(kf[p])) k[p] = r4(clamp(kf[p], ...RANGE[p])); else bad(`.keys ${p} must be a number`); }
        else if (p === "points") {
          const pts = normalizePoints(kf.points, it.type, bad, ".keys points");
          if (pts && pts.length !== it.points.length) bad(`.keys points need the shape's ${it.points.length} points (got ${pts.length})`);
          else if (pts) k.points = pts;
        } else {
          const c = normColor(kf[p]);
          if (c == null) bad(`.keys ${p} must be a colour or "none"`); else k[p] = c;
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
  /** Merge `set` into an item key by key (null resets a key); a new type starts fresh. */
  function mergeItem(base, set, strict = false) {
    if (set == null) return null;
    if (!isObj(set)) { if (strict) throw new Error("shape must be an object"); return base || null; }
    let next = { ...(base || {}) };
    if (set.type && base && set.type !== base.type) {
      next = {};
      for (const k of ["name", "on", ...TRANSFORM, ...TRIM, ...PAINT]) if (k in base) next[k] = base[k];
    }
    for (const [k, v] of Object.entries(set)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    if (next.type === "group") for (const k of PAINT) delete next[k];
    return normalizeItem(next, strict);
  }

  /* ── Time ── */
  function lerpPoints(a, b, u) {
    return a.map((p, i) => {
      const q = b[i], n = Math.max(p.length, q.length), out = [];
      for (let j = 0; j < n; j++) out.push((p[j] || 0) + ((q[j] || 0) - (p[j] || 0)) * u);
      return out;
    });
  }
  /** An item as it is at clip-local time t (keys resolved and removed, groups too). */
  function itemAt(it, t) {
    if (!it) return it;
    let out = it;
    if (it.keys && it.keys.length) {
      out = { ...it };
      delete out.keys;
      for (const p of KEYED) {
        const ks = it.keys.filter((k) => k[p] != null);
        if (!ks.length) continue;
        if (t <= ks[0].t) { out[p] = ks[0][p]; continue; }
        if (t >= ks[ks.length - 1].t) { out[p] = ks[ks.length - 1][p]; continue; }
        let i = 0;
        while (t > ks[i + 1].t) i++;
        const a = ks[i], b = ks[i + 1];
        const u = (EASES[b.ease || "ease-in-out"] || EASES.linear)((t - a.t) / Math.max(1e-9, b.t - a.t));
        out[p] = p === "points" ? lerpPoints(a.points, b.points, u)
          : COLOR_KEYED.includes(p) ? lerpColor(a[p], b[p], u) : a[p] + (b[p] - a[p]) * u;
      }
      if (out.stroke !== "none" && !out.strokeWidth && !it.keys.some((k) => k.strokeWidth != null)) out.strokeWidth = it.type === "line" || it.closed === false ? 8 : 6;
    }
    if (it.type === "group" && it.items && it.items.some((c) => c.keys || c.type === "group")) {
      if (out === it) out = { ...it };
      out.items = it.items.map((c) => itemAt(c, t));
    }
    return out;
  }
  /** The layer's items at clip-local time t (keys resolved), or null. */
  function shapesAt(list, t) {
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((it) => itemAt(it, t));
  }
  /** A key holding every keyed value of `now` (an item at some time), at time t. */
  function snapshotKey(it, now, t) {
    const k = { t: r4(Math.max(0, t)) };
    for (const p of KEYED) {
      if (now[p] == null) continue;
      if (!(it.keys || []).some((x) => x[p] != null)) continue;
      k[p] = p === "points" ? now.points.map((q) => q.map(r3)) : RANGE[p] ? r4(now[p]) : now[p];
    }
    return k;
  }
  /** Re-base item keys when the clip's head moves by `offset` s (a split's right half, a
   *  head trim): keys before the new start fold into one key at 0, so the animation plays on. */
  function shiftKeys(list, offset) {
    if (!Array.isArray(list) || !offset) return list;
    const shift = (it) => {
      if (!it || typeof it !== "object") return it;
      let out = it;
      if (it.keys && it.keys.length) {
        const keys = it.keys.map((k) => ({ ...k, t: r4(k.t - offset) }));
        const after = keys.filter((k) => k.t > 1e-4);
        if (after.length === keys.length) out = { ...it, keys };
        else {
          const now = itemAt({ ...it, items: undefined }, offset);
          out = { ...it, keys: [snapshotKey(it, now, 0), ...after] };
        }
      }
      if (it.type === "group" && Array.isArray(it.items)) out = { ...out, items: it.items.map(shift) };
      return out;
    };
    return list.map(shift);
  }

  /* ── 2D affine matrices [a, b, c, d, e, f] (the canvas / DOMMatrix order) ── */
  const IDENT = [1, 0, 0, 1, 0, 0];
  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  /** translate(x, y) · rotate(deg) · scale(s) · translate(−ax, −ay) */
  function trs(x, y, deg, s, ax = 0, ay = 0) {
    const th = (deg || 0) * Math.PI / 180, cs = Math.cos(th) * s, sn = Math.sin(th) * s;
    return [cs, sn, -sn, cs, x - (cs * ax - sn * ay), y - (sn * ax + cs * ay)];
  }

  /* ── Geometry ── */
  /** An item's outline in its own frame (before its x / y / rotation / scale):
   *  { A: [{x, y, ix, iy, ox, oy}, …] anchors with absolute handles, closed }. */
  function outline(it) {
    const hw = (it.w || 0) / 2, hh = (it.h || 0) / 2;
    const P = (x, y, ix = 0, iy = 0, ox = 0, oy = 0) => ({ x, y, ix: x + ix, iy: y + iy, ox: x + ox, oy: y + oy });
    if (it.type === "rect") {
      const r = Math.min(it.radius || 0, hw, hh), k = r * KAPPA;
      if (r <= 0) return { A: [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)], closed: true };
      return { A: [
        P(-hw + r, -hh, -k, 0), P(hw - r, -hh, 0, 0, k, 0), P(hw, -hh + r, 0, -k), P(hw, hh - r, 0, 0, 0, k),
        P(hw - r, hh, k, 0), P(-hw + r, hh, 0, 0, -k, 0), P(-hw, hh - r, 0, k), P(-hw, -hh + r, 0, 0, 0, -k),
      ], closed: true };
    }
    if (it.type === "ellipse") {
      const kx = hw * KAPPA, ky = hh * KAPPA;
      return { A: [P(0, -hh, -kx, 0, kx, 0), P(hw, 0, 0, -ky, 0, ky), P(0, hh, kx, 0, -kx, 0), P(-hw, 0, 0, ky, 0, -ky)], closed: true };
    }
    if (it.type === "polygon" || it.type === "star") {
      const n = it.sides || 5, star = it.type === "star", m = star ? n * 2 : n, A = [];
      for (let i = 0; i < m; i++) {
        const th = -Math.PI / 2 + i * 2 * Math.PI / m, k = star && i % 2 ? it.inner : 1;
        A.push(P(Math.cos(th) * hw * k, Math.sin(th) * hh * k));
      }
      return { A, closed: true };
    }
    if (it.type === "line" || it.type === "path") {
      return { A: (it.points || []).map((p) => P(p[0], p[1], p[2] || 0, p[3] || 0, p[4] || 0, p[5] || 0)), closed: isClosed(it) };
    }
    return { A: [], closed: false };
  }
  /** Cubic segments of an outline: [[a, b], …] (closed: the last one wraps to the first). */
  function segments(A, closed) {
    const out = [];
    for (let i = 0; i < A.length - (closed ? 0 : 1); i++) out.push([A[i], A[(i + 1) % A.length]]);
    return out;
  }
  const cubic = (a, b, t) => {
    const u = 1 - t;
    return [u * u * u * a.x + 3 * u * u * t * a.ox + 3 * u * t * t * b.ix + t * t * t * b.x,
      u * u * u * a.y + 3 * u * u * t * a.oy + 3 * u * t * t * b.iy + t * t * t * b.y];
  };
  const straight = (a, b) => a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y;
  /** The outline as a polyline (each curve cut into n pieces), starting at the first point. */
  function flatten(A, closed, n = 32) {
    if (!A.length) return [];
    const out = [[A[0].x, A[0].y]];
    for (const [a, b] of segments(A, closed)) {
      const steps = straight(a, b) ? 1 : n;
      for (let j = 1; j <= steps; j++) out.push(cubic(a, b, j / steps));
    }
    return out;
  }
  /** Trace the full outline into a canvas-like path. */
  function tracePath(ctx, A, closed) {
    if (!A.length) return;
    ctx.moveTo(A[0].x, A[0].y);
    for (const [a, b] of segments(A, closed)) ctx.bezierCurveTo(a.ox, a.oy, b.ix, b.iy, b.x, b.y);
    if (closed) ctx.closePath();
  }
  /** The drawn window of an outline as fractions of its length: [[from, to], …] (one or two runs). */
  function trimRuns(trim, closed) {
    let s = clamp(trim[0], 0, 1), e = clamp(trim[1], 0, 1);
    if (e - s <= 1e-6) return [];
    if (s <= 0 && e >= 1) return [[0, 1]];
    const off = trim[2] || 0;
    if (!closed) { s = clamp(s + off, 0, 1); e = clamp(e + off, 0, 1); return e - s > 1e-6 ? [[s, e]] : []; }
    const span = e - s;
    s = ((s + off) % 1 + 1) % 1;
    return s + span <= 1 + 1e-9 ? [[s, s + span]] : [[s, 1], [0, s + span - 1]];
  }
  /** Trace the trimmed part of an outline (polyline). Closed outlines wrap round the seam. */
  function traceTrim(ctx, A, closed, trim) {
    const runs = trimRuns(trim, closed);
    if (!runs.length) return false;
    const P = flatten(A, closed), L = [0];
    for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const total = L[L.length - 1];
    if (total <= 0) return false;
    const at = (d) => {
      let i = 1;
      while (i < L.length - 1 && L[i] < d) i++;
      const u = (d - L[i - 1]) / Math.max(1e-12, L[i] - L[i - 1]);
      return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * u, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * u];
    };
    // a wrapped window on a closed outline is one continuous run: [s, 1] then [0, e]
    const pts = [];
    for (const [a, b] of runs) {
      const da = a * total, db = b * total;
      pts.push(at(da));
      for (let i = 0; i < L.length; i++) if (L[i] > da && L[i] < db) pts.push(P[i]);
      pts.push(at(db));
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    return true;
  }
  /** Compose a parent's trim window [s, e, offset] (fractions) with an item's own. */
  function composeTrim(outer, it) {
    const is = (it.trimStart ?? 0) / 100, ie = (it.trimEnd ?? 100) / 100, io = (it.trimOffset ?? 0) / 100;
    const span = ie - is;
    return [is + span * outer[0], is + span * outer[1], io + outer[2]];
  }
  const itemMatrix = (it) => trs(it.x || 0, it.y || 0, it.rotation || 0, it.scale == null ? 1 : it.scale);

  /** Draw resolved items (shapesAt) onto a 2D context in layer px. trim: the layer's
   *  [trimStart, trimEnd, trimOffset] in % (default the whole outline). */
  function draw(ctx, items, trim = [0, 100, 0]) {
    if (!Array.isArray(items)) return;
    const base = ctx.globalAlpha;
    drawItems(ctx, items, [trim[0] / 100, trim[1] / 100, (trim[2] || 0) / 100], 1, base);
    ctx.globalAlpha = base;
  }
  function drawItems(ctx, items, trim, alpha, base) {
    for (const it of items) {
      if (!it || it.on === false) continue;
      const a = alpha * (it.opacity == null ? 1 : it.opacity);
      if (a <= 0) continue;
      ctx.save();
      const m = itemMatrix(it);
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      const tr = composeTrim(trim, it);
      if (it.type === "group") drawItems(ctx, it.items || [], tr, a, base);
      else paint(ctx, it, tr, a * base);
      ctx.restore();
    }
  }
  function paint(ctx, it, trim, alpha) {
    const { A, closed } = outline(it);
    if (A.length < 2) return;
    const full = trim[0] <= 1e-6 && trim[1] >= 1 - 1e-6;
    ctx.beginPath();
    if (full) tracePath(ctx, A, closed);
    else if (!traceTrim(ctx, A, closed, trim)) return;
    ctx.globalAlpha = alpha;
    if (it.fill && it.fill !== "none") { ctx.fillStyle = it.fill; ctx.fill(); }
    if (it.stroke && it.stroke !== "none" && it.strokeWidth > 0) {
      ctx.lineWidth = it.strokeWidth;
      ctx.lineCap = it.lineCap || "round";
      ctx.lineJoin = it.lineJoin || "round";
      if (ctx.setLineDash) ctx.setLineDash(it.dash || []);
      ctx.strokeStyle = it.stroke;
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    }
  }
  /** Bounding box of resolved items in layer px (stroke included): {x0, y0, x1, y1} or null. */
  function bounds(items, m = IDENT, acc = null) {
    for (const it of items || []) {
      if (!it || it.on === false) continue;
      const M = mul(m, itemMatrix(it));
      if (it.type === "group") { acc = bounds(it.items, M, acc); continue; }
      const { A } = outline(it);
      const k = Math.hypot(M[0], M[1]), pad = it.stroke && it.stroke !== "none" ? (it.strokeWidth || 0) / 2 * k : 0;
      for (const a of A) for (const [x, y] of [[a.x, a.y], [a.ix, a.iy], [a.ox, a.oy]]) {
        const [px, py] = apply(M, x, y);
        acc = acc || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        acc.x0 = Math.min(acc.x0, px - pad); acc.y0 = Math.min(acc.y0, py - pad);
        acc.x1 = Math.max(acc.x1, px + pad); acc.y1 = Math.max(acc.y1, py + pad);
      }
    }
    return acc;
  }
  /** Item paths through a list: [[i], [i, j], …] for every item, depth first (the UI's item picker). */
  function itemPaths(items, pre = [], out = []) {
    (items || []).forEach((it, i) => {
      out.push([...pre, i]);
      if (it.type === "group") itemPaths(it.items, [...pre, i], out);
    });
    return out;
  }
  function getItem(items, path) {
    let list = items, it = null;
    for (const i of path || []) { it = list && list[i]; if (!it) return null; list = it.items; }
    return it;
  }
  /** The list with the item at `path` replaced by fn(item) (null removes it). Copies along the path only. */
  function updateItem(items, path, fn) {
    const [i, ...rest] = path, list = items.slice();
    if (!list[i]) return items;
    if (rest.length) list[i] = { ...list[i], items: updateItem(list[i].items || [], rest, fn) };
    else { const v = fn(list[i]); if (v == null) list.splice(i, 1); else list[i] = v; }
    return list;
  }
  /** Matrix from an item's own frame (at path) to layer px, items resolved. */
  function itemFrame(items, path) {
    let m = IDENT, list = items;
    for (const i of path) { const it = list && list[i]; if (!it) return null; m = mul(m, itemMatrix(it)); list = it.items; }
    return m;
  }
  function countItems(items) { return itemPaths(items).length; }

  /** One line per layer for status readouts: "3 shapes: rect, star(5), group(2) …". */
  function describe(list) {
    if (!Array.isArray(list) || !list.length) return "";
    const one = (it) => (it.name ? `"${it.name}" ` : "") + it.type +
      (it.type === "group" ? `(${(it.items || []).map(one).join(", ")})` : it.type === "path" ? `(${(it.points || []).length}${it.closed === false ? " open" : ""})` :
        it.sides && it.type !== "rect" ? `(${it.sides})` : "") +
      (it.fill && it.fill !== "none" && it.type !== "group" ? ` ${it.fill}` : "") +
      (it.stroke && it.stroke !== "none" ? ` stroke ${it.stroke}/${it.strokeWidth}` : "") +
      ((it.trimStart || 0) > 0 || (it.trimEnd ?? 100) < 100 ? ` trim ${it.trimStart || 0}-${it.trimEnd ?? 100}` : "") +
      (it.on === false ? " off" : "") + (it.keys ? ` ${it.keys.length} keys` : "");
    const n = countItems(list);
    return `${n} shape${n > 1 ? "s" : ""}: ` + list.map(one).join(", ");
  }

  /* ── Layer transforms: anchor point and parenting ── */
  /** The scale a clip's picture is drawn at (a boxed title ignores scale). */
  function contentScale(clip, p) {
    if (clip && clip.kind === "text" && +p.boxW > 0 && +p.boxH > 0 && !p.textPath) return 1;
    return +p.scale || 1;
  }
  /** A layer's own matrix: position · rotation · scale about its anchor point. */
  function layerMatrix(clip, p) {
    return trs(+p.x || 0, +p.y || 0, +p.rotation || 0, contentScale(clip, p), +p.anchorX || 0, +p.anchorY || 0);
  }
  /** A keyframed channel at clip-local time (the editor's own interpolation). */
  function channelAt(clip, key, local, fallback) {
    const kfs = clip.keyframes && clip.keyframes[key];
    if (!Array.isArray(kfs) || !kfs.length) return fallback;
    if (local <= kfs[0].t) return kfs[0].v;
    if (local >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v;
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i], b = kfs[i + 1];
      if (local >= a.t && local <= b.t) {
        const u = (local - a.t) / Math.max(1e-6, b.t - a.t);
        return a.v + (b.v - a.v) * (EASES[b.ease || "ease-in-out"] || EASES.linear)(u);
      }
    }
    return fallback;
  }
  const XFORM_KEYS = ["x", "y", "rotation", "scale", "anchorX", "anchorY", "boxW", "boxH"];
  const XFORM_DEF = { x: 0, y: 0, rotation: 0, scale: 1, anchorX: 0, anchorY: 0, boxW: 0, boxH: 0 };
  /** A clip's transform at timeline time t (its keyframes, held past its ends; no transitions). */
  function transformAt(clip, t) {
    const local = clamp(t - (clip.start || 0), 0, clip.duration || 0), p = clip.props || {}, out = {};
    for (const k of XFORM_KEYS) out[k] = channelAt(clip, k, local, p[k] == null ? XFORM_DEF[k] : +p[k]);
    const q = pathPositionAt(clip, local);   // a curved motion path moves the children too
    if (q) { out.x = q.x; out.y = q.y; }
    if (p.autoOrient) { const a = orientAt(clip, local); if (a != null) out.rotation += a; }
    return out;
  }
  /** The clips a clip is parented through: [parent, grandparent, …]; stops at a missing clip or a loop. */
  function parentChain(clip, byId) {
    const out = [], seen = new Set([clip.id]);
    let q = clip;
    while (q && q.parent && out.length < MAX_PARENT_DEPTH) {
      const p = byId(q.parent);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id); out.push(p); q = p;
    }
    return out;
  }
  /** The parents' combined matrix at timeline t (identity without a parent). */
  function parentMatrix(clip, byId, t) {
    const chain = parentChain(clip, byId);
    let m = IDENT;
    for (let i = chain.length - 1; i >= 0; i--) m = mul(m, layerMatrix(chain[i], transformAt(chain[i], t)));
    return m;
  }
  /** Would parenting `childId` to `parentId` make a loop? */
  function wouldCycle(childId, parentId, byId) {
    let q = byId(parentId), n = 0;
    while (q && n++ < 64) { if (q.id === childId) return true; q = q.parent ? byId(q.parent) : null; }
    return false;
  }
  /** The x / y / rotation / scale that keep a clip where it is (at timeline t) when its
   *  parent changes from the current one to `parentId` (null = none). */
  function reparentValues(clip, parentId, byId, t) {
    const own = transformAt(clip, t);
    const world = mul(parentMatrix(clip, byId, t), layerMatrix(clip, own));
    const next = parentId ? parentMatrix({ id: clip.id, parent: parentId }, byId, t) : IDENT;
    const L = mul(invert(next), world);
    const boxed = clip.kind === "text" && own.boxW > 0 && own.boxH > 0;
    const s = Math.hypot(L[0], L[1]);
    const [x, y] = apply(L, own.anchorX, own.anchorY);
    const out = { x: r3(x), y: r3(y), rotation: r3(Math.atan2(L[1], L[0]) * 180 / Math.PI) };
    if (!boxed) out.scale = r4(s);
    return out;
  }
  /** The x / y that keep a layer's picture still while its anchor moves to (ax, ay). */
  function anchorMoveValues(clip, p, ax, ay) {
    const [x, y] = apply(layerMatrix(clip, p), ax, ay);   // where the new anchor point is now: the new position
    return { x: r3(x), y: r3(y), anchorX: r3(ax), anchorY: r3(ay) };
  }

  /* ── Motion paths: position keys with spatial handles ──
     A position key is a time where keyframes.x and keyframes.y both have a key.
     Its curve handles sit on those keys: x key {pin, pout} and y key {pin, pout},
     px relative to the key's position (in the clip's x / y space). Between two
     position keys with no other x / y key in between, the clip travels along the
     cubic bezier key → key+out → next+in → next, at the pace of the arriving key's
     ease (measured along the curve). Without handles the channels run as usual. */
  const KEY_EPS = 1e-3;
  /** The clip's position keys: [{t, x, y, ix, iy, ox, oy, ease, xk, yk}] (xk / yk = the stored keys). */
  function posKeys(clip) {
    const kx = clip && clip.keyframes && clip.keyframes.x, ky = clip && clip.keyframes && clip.keyframes.y;
    if (!Array.isArray(kx) || !Array.isArray(ky) || kx.length < 2 || ky.length < 2) return [];
    const out = [];
    for (const a of kx) {
      const b = ky.find((k) => Math.abs(k.t - a.t) < KEY_EPS);
      if (!b) continue;
      out.push({ t: a.t, x: +a.v, y: +b.v, ix: +a.pin || 0, iy: +b.pin || 0, ox: +a.pout || 0, oy: +b.pout || 0,
        ease: a.ease || "ease-in-out", xk: a, yk: b });
    }
    return out.sort((p, q) => p.t - q.t);
  }
  function hasPathHandles(clip) {
    const k = clip && clip.keyframes;
    return !!k && [k.x, k.y].some((a) => Array.isArray(a) && a.some((x) => x && (+x.pin || +x.pout)));
  }
  /** The curved segment that holds clip-local time t, or null (the channels apply there). */
  function pathSegmentAt(clip, t) {
    if (!hasPathHandles(clip)) return null;
    const P = posKeys(clip);
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      if (t < a.t - 1e-9 || t > b.t + 1e-9) continue;
      if (!(a.ox || a.oy || b.ix || b.iy)) return null;
      const between = (arr) => arr.some((k) => k.t > a.t + KEY_EPS && k.t < b.t - KEY_EPS);
      if (between(clip.keyframes.x) || between(clip.keyframes.y)) return null;
      return { a, b, A: { x: a.x, y: a.y, ix: a.x, iy: a.y, ox: a.x + a.ox, oy: a.y + a.oy }, B: { x: b.x, y: b.y, ix: b.x + b.ix, iy: b.y + b.iy, ox: b.x, oy: b.y } };
    }
    return null;
  }
  const segLUT = new Map();   // "x,y,…" → cumulative arc lengths of one cubic (64 steps)
  function cubicLUT(A, B) {
    const key = [A.x, A.y, A.ox, A.oy, B.ix, B.iy, B.x, B.y].join(",");
    let L = segLUT.get(key);
    if (!L) {
      L = [0];
      let prev = [A.x, A.y];
      for (let j = 1; j <= 64; j++) { const q = cubic(A, B, j / 64); L.push(L[j - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1])); prev = q; }
      if (segLUT.size > 512) segLUT.clear();
      segLUT.set(key, L);
    }
    return L;
  }
  /** Curve parameter at arc-length fraction s of one cubic. */
  function paramAtFraction(A, B, s) {
    const L = cubicLUT(A, B), total = L[64];
    if (total <= 1e-9) return s;
    const d = clamp(s, 0, 1) * total;
    let j = 1;
    while (j < 64 && L[j] < d) j++;
    return (j - 1 + (d - L[j - 1]) / Math.max(1e-12, L[j] - L[j - 1])) / 64;
  }
  /** {x, y} on the clip's motion path at clip-local t, or null where the channels apply. */
  function pathPositionAt(clip, t) {
    const seg = pathSegmentAt(clip, t);
    if (!seg) return null;
    const u = (t - seg.a.t) / Math.max(1e-9, seg.b.t - seg.a.t);
    const s = (EASES[seg.b.ease] || EASES.linear)(clamp(u, 0, 1));
    const [x, y] = cubic(seg.A, seg.B, paramAtFraction(seg.A, seg.B, s));
    return { x, y };
  }
  /** x / y at clip-local t: the motion path where it curves, the keyframe channels elsewhere. */
  function positionAt(clip, t, p = clip.props || {}) {
    const q = pathPositionAt(clip, t);
    if (q) return q;
    return { x: channelAt(clip, "x", t, +p.x || 0), y: channelAt(clip, "y", t, +p.y || 0) };
  }
  /** Direction of travel at clip-local t in degrees (for auto-orient), or null when the clip never moves. */
  function orientAt(clip, t) {
    const kx = clip.keyframes && clip.keyframes.x, ky = clip.keyframes && clip.keyframes.y;
    const ts = [...(kx || []), ...(ky || [])].map((k) => k.t);
    if (ts.length < 2) return null;
    const lo = Math.min(...ts), hi = Math.max(...ts);
    for (const eps of [1 / 240, 1 / 60, 1 / 10]) {
      const t0 = clamp(t - eps, lo, hi), t1 = clamp(t + eps, lo, hi);
      if (t1 - t0 < 1e-9) continue;
      const a = positionAt(clip, t0), b = positionAt(clip, t1);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    }
    return null;
  }
  /** Handles for every position key that make a smooth path through them (Catmull-Rom,
   *  a third of the way to the neighbours); the ends get one handle each. Returns the keyframes. */
  function smoothPath(keyframes) {
    const clip = { keyframes };
    const P = posKeys(clip);
    if (P.length < 2) return keyframes;
    const out = { ...keyframes, x: keyframes.x.map((k) => ({ ...k })), y: keyframes.y.map((k) => ({ ...k })) };
    const find = (arr, t) => arr.find((k) => Math.abs(k.t - t) < KEY_EPS);
    P.forEach((k, i) => {
      const prev = P[i - 1] || k, next = P[i + 1] || k;
      const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6;
      const xk = find(out.x, k.t), yk = find(out.y, k.t);
      const set = (key, prop, v) => { if (i === 0 && prop === "pin" || i === P.length - 1 && prop === "pout" || Math.abs(v) < 1e-3) delete key[prop]; else key[prop] = r3(v); };
      set(xk, "pin", -tx); set(xk, "pout", tx); set(yk, "pin", -ty); set(yk, "pout", ty);
    });
    return out;
  }
  /** The keyframes with every spatial handle removed (a straight path). */
  function straightPath(keyframes) {
    const strip = (arr) => Array.isArray(arr) ? arr.map((k) => { const o = { ...k }; delete o.pin; delete o.pout; return o; }) : arr;
    return { ...keyframes, x: strip(keyframes.x), y: strip(keyframes.y) };
  }

  /* ── Paths as tracks: arc-length sampling of an outline (text on a path) ── */
  /** A sampler over an outline: { length, at(d) → {x, y, angle°} } with d in px along it (wraps when closed).
   *  offset: a parallel curve that far to the right of the direction of travel (below a left-to-right
   *  line), so a second line of text gets its own, shorter or longer, track. */
  function pathSampler(A, closed, offset = 0) {
    let P = flatten(A, closed, 48);
    if (offset && P.length > 1) {
      const n = P.length, seg = (i) => { const a = P[i], b = P[i + 1]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
      P = P.map((q, i) => {
        const t1 = i < n - 1 ? seg(i) : null, t0 = i > 0 ? seg(i - 1) : (closed && n > 2 ? seg(n - 2) : null);
        let tx = (t0 ? t0[0] : 0) + (t1 ? t1[0] : 0), ty = (t0 ? t0[1] : 0) + (t1 ? t1[1] : 0);
        const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
        return [q[0] - ty * offset, q[1] + tx * offset];
      });
    }
    const L = [0];
    for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const length = L[L.length - 1];
    const at = (d) => {
      if (length <= 0) return { x: P[0] ? P[0][0] : 0, y: P[0] ? P[0][1] : 0, angle: 0 };
      if (closed) d = ((d % length) + length) % length;
      const outside = !closed && (d < 0 || d > length);
      const dd = clamp(d, 0, length);
      let i = 1;
      while (i < L.length - 1 && L[i] < dd) i++;
      const a = P[i - 1], b = P[i], u = (dd - L[i - 1]) / Math.max(1e-12, L[i] - L[i - 1]);
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      let x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
      if (outside) { const over = d < 0 ? d : d - length; x += Math.cos(angle) * over; y += Math.sin(angle) * over; }   // runs on straight past the ends
      return { x, y, angle: angle * 180 / Math.PI };
    };
    return { length, at, points: P };
  }
  const TEXT_PATH_TYPES = ["path", "line", "ellipse", "rect", "polygon", "star"];
  /** Ready-made text paths (the editor's buttons and the agent's setTextPath names). */
  const TEXT_PATH_PRESETS = {
    line: { type: "line", points: [[-420, 0], [420, 0]] },
    arc: { type: "path", closed: false, points: [[-420, 120], [0, -110, -240, 0, 240, 0], [420, 120]] },
    circle: { type: "ellipse", w: 520, h: 520 },
    wave: { type: "path", closed: false, points: [[-450, 0, 0, 0, 150, -160], [0, 0, -150, 160, 150, 160], [450, 0, -150, -160, 0, 0]] },
  };
  /** A text clip's props.textPath: one shape item (its outline is the baseline), validated. */
  function normalizeTextPath(v, strict = false) {
    if (v == null) return null;
    const bad = (m) => { if (strict) throw new Error("textPath" + m); return null; };
    if (!isObj(v)) return bad(" must be an object like {type:'path', points:[[-300, 0], [300, 0]], closed:false}");
    const type = v.type == null ? "path" : v.type;
    if (!TEXT_PATH_TYPES.includes(type)) return bad(`.type must be ${TEXT_PATH_TYPES.join(" | ")}`);
    const src = { ...v, type };
    for (const k of ["fill", "stroke", "strokeWidth", "lineCap", "lineJoin", "dash", "opacity", "trimStart", "trimEnd", "trimOffset", "name", "on"]) {
      if (k in src) { if (strict && !["name", "on"].includes(k)) bad(`.${k}: a text path has no paint or trim (the text is what draws)`); delete src[k]; }
    }
    if (type === "path" && src.closed == null) src.closed = false;
    const it = normalizeItem(src, strict, "textPath");
    if (!it) return null;
    for (const k of ["fill", "stroke", "strokeWidth", "lineCap", "lineJoin", "trimStart", "trimEnd", "trimOffset", "opacity"]) delete it[k];
    return it;
  }

  return {
    posKeys, hasPathHandles, pathSegmentAt, pathPositionAt, positionAt, orientAt, smoothPath, straightPath,
    pathSampler, TEXT_PATH_TYPES, TEXT_PATH_PRESETS, normalizeTextPath,
    TYPES, MAX_ITEMS, MAX_DEPTH, MAX_POINTS, CAPS, JOINS, KEYED, NUM_KEYED, COLOR_KEYED, RANGE, EASES, OWN,
    normColor, lerpColor, defaultsFor, normalizeShapes, normalizeItem, mergeItem, itemAt, shapesAt, snapshotKey, shiftKeys,
    IDENT, mul, apply, invert, trs, outline, segments, flatten, tracePath, trimRuns, traceTrim, composeTrim, itemMatrix,
    draw, bounds, itemPaths, getItem, updateItem, itemFrame, countItems, describe, isClosed,
    contentScale, layerMatrix, channelAt, transformAt, parentChain, parentMatrix, wouldCycle, reparentValues, anchorMoveValues,
  };
});
