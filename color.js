/* FableCut color — the grade's math, its validation, the scopes and the
   frame statistics an agent reads. Zero dependencies. Loaded by the editor as
   a plain script (global `FableCutColor`) and required by the MCP server and
   the tests, so the editor's Color page, an agent's `setGrade` op and the
   numbers in `fablecut_scopes` all agree. The GPU path (GRADE_FRAG, run by
   app.js) mirrors gradePixel() step for step; the CPU path is the fallback
   when WebGL2 is missing, and the reference the tests check.

   A grade lives on a clip (or adjustment layer) as `props.grade`, sparse —
   only the keys that differ from neutral:
     { exposure: 0.3, temp: -12, lift: [0, 0, 0.02, -0.03], contrast: 1.15 }
   Wheels (lift / gamma / gain / offset) are [r, g, b, master]; every other
   key is a number. `on: false` bypasses the grade without losing it.

   Order, on display (sRGB-encoded) values 0…1:
     1 exposure + white balance, in linear light
     2 offset   x + o
     3 lift     x + l·(1 − x)          raises / lowers blacks, white stays put
     4 gain     x · (1 + g)
     5 gamma    x ^ (1 / 2^γ)          γ > 0 brightens mids
     6 contrast pivot · (x / pivot)^c — linear in log, so blacks never clip
     7 tone     blacks · shadows · midtones · highlights · whites (luma bands)
     8 rolloff  soft knee into white (highSoft) and black (lowSoft)
     9 saturation around Rec.709 luma
  10 curves    luma curve (brightness only) then the R, G, B curves
  11 hue curves hue vs hue · hue vs saturation · hue vs luma · sat vs luma
   Steps 1–6 are per channel, so the CPU path bakes them into a table; the
   curves are baked into lookup tables that the shader reads the same way.

   Curves are point lists, interpolated with a monotone cubic (no overshoot):
     curves:  { y?, r?, g?, b? }  each [[x, y], …] on 0…1 — (0,0) and (1,1)
              are added when missing, so [[0.25, 0.2]] is a gentle shadow dip
     hueHue:  [[hue°, shift°], …]       shift −180…180, neutral 0
     hueSat:  [[hue°, factor], …]       factor 0…2, neutral 1
     hueLuma: [[hue°, offset], …]       offset −0.5…0.5, neutral 0
     satLuma: [[saturation, offset], …] saturation 0…1, offset −0.5…0.5
   Hue curves wrap around 360°. A hue curve with ONE point is a band: that
   value at the hue, easing back to neutral 40° either side. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutColor = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const WHEELS = ["lift", "gamma", "gain", "offset"];
  // [default, min, max, step, label] — wheel entries describe each component.
  const R = (def, min, max, step, label) => ({ def, min, max, step, label });
  const GRADE_PARAMS = {
    exposure: R(0, -5, 5, 0.01, "Exposure"),
    temp: R(0, -100, 100, 1, "Temp"),
    tint: R(0, -100, 100, 1, "Tint"),
    lift: R(0, -1, 1, 0.005, "Lift"),
    gamma: R(0, -1, 1, 0.005, "Gamma"),
    gain: R(0, -1, 1, 0.005, "Gain"),
    offset: R(0, -1, 1, 0.005, "Offset"),
    contrast: R(1, 0, 3, 0.01, "Contrast"),
    pivot: R(0.435, 0.05, 0.95, 0.005, "Pivot"),
    blacks: R(0, -100, 100, 1, "Blacks"),
    shadows: R(0, -100, 100, 1, "Shadows"),
    midtones: R(0, -100, 100, 1, "Midtones"),
    highlights: R(0, -100, 100, 1, "Highlights"),
    whites: R(0, -100, 100, 1, "Whites"),
    lowSoft: R(0, 0, 100, 1, "Low rolloff"),
    highSoft: R(0, 0, 100, 1, "High rolloff"),
    saturation: R(100, 0, 200, 1, "Saturation"),
  };
  const GRADE_KEYS = Object.keys(GRADE_PARAMS);
  const CURVE_CHANNELS = ["y", "r", "g", "b"];
  const HUE_CURVES = {
    hueHue: { label: "Hue vs Hue", xMax: 360, min: -180, max: 180, neutral: 0, periodic: true },
    hueSat: { label: "Hue vs Sat", xMax: 360, min: 0, max: 2, neutral: 1, periodic: true },
    hueLuma: { label: "Hue vs Luma", xMax: 360, min: -0.5, max: 0.5, neutral: 0, periodic: true },
    satLuma: { label: "Sat vs Luma", xMax: 1, min: -0.5, max: 0.5, neutral: 0, periodic: false },
  };
  const HUE_KEYS = Object.keys(HUE_CURVES);
  const MAX_POINTS = 24;
  const BAND = 40;            // a one-point hue curve eases back to neutral this far either side
  const CURVE_N = 1024;       // luma / RGB lookup-table size
  const HUE_N = 360;          // hue-curve lookup-table size (also sat 0…1 for satLuma)
  const WB_STOPS = 1 / 100;   // temp / tint ±100 → ±1 stop per channel
  const TONE_K = 0.5;         // tone slider ±100 → ±0.5 luma at the band's peak

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const round = (v, step) => Math.round(v / step) * step;

  /** Validate a grade. Returns the sparse form (neutral keys dropped), or null
   *  when nothing is left. strict: throw on unknown keys / bad values instead
   *  of dropping them (agent input). */
  function normalizeGrade(g, strict = false) {
    if (g == null) return null;
    if (typeof g !== "object" || Array.isArray(g)) {
      if (strict) throw new Error("grade must be an object like {exposure: 0.5, lift: [0, 0, 0.05, 0]}");
      return null;
    }
    const out = {};
    for (const [k, v] of Object.entries(g)) {
      if (k === "on") { if (v === false) out.on = false; continue; }
      if (k === "curves") {
        const c = normalizeCurves(v, strict);
        if (c) out.curves = c;
        continue;
      }
      if (HUE_CURVES[k]) {
        const pts = normalizeHueCurve(k, v, strict);
        if (pts) out[k] = pts;
        continue;
      }
      const def = GRADE_PARAMS[k];
      if (!def) {
        if (strict) throw new Error(`unknown grade key ${JSON.stringify(k)} (known: on, ${GRADE_KEYS.join(", ")}, curves, ${HUE_KEYS.join(", ")})`);
        continue;
      }
      if (WHEELS.includes(k)) {
        if (!Array.isArray(v) || v.length !== 4 || v.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
          if (strict) throw new Error(`grade.${k} must be [r, g, b, master], four numbers ${def.min}…${def.max}`);
          continue;
        }
        const w = v.map((n) => +clamp(n, def.min, def.max).toFixed(4));
        if (w.some((n) => n !== 0)) out[k] = w;
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v)) {
        if (strict) throw new Error(`grade.${k} must be a number ${def.min}…${def.max}`);
        continue;
      }
      const n = +clamp(v, def.min, def.max).toFixed(4);
      if (n !== def.def) out[k] = n;
    }
    const keys = Object.keys(out);
    if (!keys.length || (keys.length === 1 && out.on === false)) return null;
    return out;
  }
  /** [[x, v], …] → sorted, clamped, de-duplicated points (or throws / null). */
  function normalizePoints(name, v, xMax, min, max, strict) {
    const bad = (msg) => { if (strict) throw new Error(`grade.${name} ${msg}`); return null; };
    if (!Array.isArray(v)) return bad(`must be a list of [x, value] points`);
    if (v.length > MAX_POINTS) return bad(`has ${v.length} points (at most ${MAX_POINTS})`);
    const byX = new Map();
    for (const p of v) {
      if (!Array.isArray(p) || p.length !== 2 || p.some((n) => typeof n !== "number" || !Number.isFinite(n)))
        return bad(`points must be [x, value] number pairs (x 0…${xMax}, value ${min}…${max})`);
      const x = xMax === 360 ? ((p[0] % 360) + 360) % 360 : clamp(p[0], 0, xMax);
      byX.set(+x.toFixed(4), +clamp(p[1], min, max).toFixed(4));
    }
    return [...byX.entries()].sort((a, b) => a[0] - b[0]);
  }
  function normalizeCurves(v, strict) {
    if (v == null) return null;
    if (typeof v !== "object" || Array.isArray(v)) {
      if (strict) throw new Error("grade.curves must be {y?, r?, g?, b?}, each a list of [x, y] points on 0…1");
      return null;
    }
    const out = {};
    for (const [ch, pts] of Object.entries(v)) {
      if (!CURVE_CHANNELS.includes(ch)) {
        if (strict) throw new Error(`grade.curves.${ch}: unknown curve (y, r, g, b)`);
        continue;
      }
      if (pts == null) continue;
      let p = normalizePoints("curves." + ch, pts, 1, 0, 1, strict);
      if (!p) continue;
      if (!p.length || p[0][0] > 0) p.unshift([0, 0]);
      if (p[p.length - 1][0] < 1) p.push([1, 1]);
      if (p.every(([x, y]) => Math.abs(x - y) < 1e-4)) continue; // identity
      out[ch] = p;
    }
    return Object.keys(out).length ? out : null;
  }
  function normalizeHueCurve(k, v, strict) {
    const d = HUE_CURVES[k];
    if (v == null) return null;
    let p = normalizePoints(k, v, d.xMax, d.min, d.max, strict);
    if (!p || !p.length) return null;
    if (d.periodic && p.length === 1) {
      const [h, val] = p[0];
      p = [[((h - BAND) + 360) % 360, d.neutral], [h, val], [(h + BAND) % 360, d.neutral]].sort((a, b) => a[0] - b[0]);
    }
    if (!d.periodic && p[0][0] > 0) p.unshift([0, d.neutral]);
    if (p.every(([, y]) => Math.abs(y - d.neutral) < 1e-4)) return null;
    return p;
  }
  /** Every key filled in (wheels as fresh arrays). */
  function fullGrade(g) {
    const out = { on: !(g && g.on === false) };
    for (const k of GRADE_KEYS) {
      const v = g && g[k];
      out[k] = WHEELS.includes(k) ? (Array.isArray(v) ? v.slice(0, 4) : [0, 0, 0, 0]) : (typeof v === "number" ? v : GRADE_PARAMS[k].def);
    }
    out.curves = {};
    for (const ch of CURVE_CHANNELS) {
      const p = g && g.curves && g.curves[ch];
      out.curves[ch] = Array.isArray(p) && p.length ? p.map((q) => q.slice(0, 2)) : null;
    }
    for (const k of HUE_KEYS) {
      const p = g && g[k];
      out[k] = Array.isArray(p) && p.length ? p.map((q) => q.slice(0, 2)) : null;
    }
    return out;
  }
  /** True when the grade changes nothing (absent, bypassed or all neutral). */
  function isNeutral(g) {
    if (!g || g.on === false) return true;
    for (const k of GRADE_KEYS) {
      const v = g[k];
      if (v == null) continue;
      if (WHEELS.includes(k)) { if (Array.isArray(v) && (v[0] || v[1] || v[2] || v[3])) return false; }
      else if (v !== GRADE_PARAMS[k].def) return false;
    }
    if (g.curves && CURVE_CHANNELS.some((ch) => Array.isArray(g.curves[ch]) && g.curves[ch].length)) return false;
    if (HUE_KEYS.some((k) => Array.isArray(g[k]) && g[k].length)) return false;
    return true;
  }
  /** The grade without its curves (what the curve pickers sample). */
  function withoutCurves(g) {
    if (!g) return g;
    const out = { ...g };
    delete out.curves;
    for (const k of HUE_KEYS) delete out[k];
    return out;
  }
  /** Merge a change into a grade (null on a key resets it) → sparse. */
  function mergeGrade(g, set, strict = false) {
    const next = { ...(g || {}) };
    for (const [k, v] of Object.entries(set || {})) {
      if (v === null) delete next[k];
      else if (k === "curves" && v && typeof v === "object" && !Array.isArray(v)) {
        const cur = { ...(next.curves || {}) };   // curves merge per channel
        for (const [ch, pts] of Object.entries(v)) { if (pts === null) delete cur[ch]; else cur[ch] = pts; }
        next.curves = cur;
      }
      else next[k] = v;
    }
    return normalizeGrade(next, strict);
  }

  /* ── White balance ── */
  /** Linear-light channel gains for temp / tint, normalized so a neutral
   *  grey keeps its Rec.709 luminance. temp > 0 warms, tint > 0 → magenta. */
  function wbGains(temp, tint) {
    const a = (+temp || 0) * WB_STOPS, c = (+tint || 0) * WB_STOPS;
    const r = Math.pow(2, a), g = Math.pow(2, -c), b = Math.pow(2, -a);
    const n = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [r / n, g / n, b / n];
  }
  /** temp / tint that turn this sampled colour (sRGB 0…1) neutral. */
  function solveWhiteBalance(rgb) {
    const lr = Math.log2(Math.max(1e-4, srgbToLinear(rgb[0])));
    const lg = Math.log2(Math.max(1e-4, srgbToLinear(rgb[1])));
    const lb = Math.log2(Math.max(1e-4, srgbToLinear(rgb[2])));
    const a = (lb - lr) / 2;        // r·2^a = b·2^-a
    const c = lg - (lr + a);        // g·2^-c = that
    return {
      temp: Math.round(clamp(a / WB_STOPS, -100, 100)),
      tint: Math.round(clamp(c / WB_STOPS, -100, 100)),
    };
  }

  /* ── Transfer ── */
  function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(v) {
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  /* ── Wheels ↔ colour offsets ──
     A wheel's puck sits at (Cb, Cr) of its r/g/b offset — the same plane as
     the vectorscope, so pushing a wheel toward red moves the trace toward the
     red target. The r/g/b it writes has zero Rec.709 luma (pure colour); the
     master component carries brightness. */
  function wheelToRgb(cb, cr) {
    return [
      +(1.5748 * cr).toFixed(4),
      +(-0.18733 * cb - 0.46812 * cr).toFixed(4),
      +(1.8556 * cb).toFixed(4),
    ];
  }
  function rgbToWheel(r, g, b) {
    return [ycbcr(r, g, b)[1], ycbcr(r, g, b)[2]];
  }
  /** Rec.709 Y, Cb, Cr (Cb/Cr ±0.5). */
  function ycbcr(r, g, b) {
    return [
      0.2126 * r + 0.7152 * g + 0.0722 * b,
      -0.114572 * r - 0.385428 * g + 0.5 * b,
      0.5 * r - 0.454153 * g - 0.045847 * b,
    ];
  }

  /* ── Curves: monotone cubic interpolation (Fritsch–Carlson) ── */
  function monotone(pts) {
    const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    if (n === 1) return () => ys[0];
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s2 = a * a + b * b;
      if (s2 > 9) { const t = 3 / Math.sqrt(s2); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (x) => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }
  /** Evaluate a stored curve (as normalized) at x. */
  function curveFn(pts, periodic) {
    if (!periodic) return monotone(pts);
    const ext = [...pts.map(([x, y]) => [x - 360, y]), ...pts, ...pts.map(([x, y]) => [x + 360, y])];
    const f = monotone(ext);
    return (x) => f(((x % 360) + 360) % 360);
  }
  const lutCache = new Map();
  function cached(key, build) {
    let v = lutCache.get(key);
    if (!v) {
      v = build();
      if (lutCache.size > 48) lutCache.delete(lutCache.keys().next().value);
      lutCache.set(key, v);
    }
    return v;
  }
  /** RGBA float table, CURVE_N wide: R G B curves in .rgb, the luma curve in .a. */
  function curveLut(curves) {
    if (!curves || !CURVE_CHANNELS.some((ch) => curves[ch])) return null;
    return cached("c" + JSON.stringify(curves), () => {
      const t = new Float32Array(CURVE_N * 4);
      const f = CURVE_CHANNELS.map((ch) => (curves[ch] ? monotone(curves[ch]) : (x) => x));
      for (let i = 0; i < CURVE_N; i++) {
        const x = i / (CURVE_N - 1);
        t[i * 4] = clamp(f[1](x), 0, 1); t[i * 4 + 1] = clamp(f[2](x), 0, 1);
        t[i * 4 + 2] = clamp(f[3](x), 0, 1); t[i * 4 + 3] = clamp(f[0](x), 0, 1);
      }
      return t;
    });
  }
  /** RGBA float table, HUE_N wide: hue shift (°), sat factor, hue→luma (by hue)
   *  and sat→luma (by saturation 0…1) in .r .g .b .a. */
  function hueLut(g) {
    if (!HUE_KEYS.some((k) => g[k])) return null;
    return cached("h" + JSON.stringify(HUE_KEYS.map((k) => g[k] || 0)), () => {
      const t = new Float32Array(HUE_N * 4);
      const f = HUE_KEYS.map((k) => {
        const d = HUE_CURVES[k];
        return g[k] ? curveFn(g[k], d.periodic) : () => d.neutral;
      });
      for (let i = 0; i < HUE_N; i++) {
        const h = i * 360 / HUE_N, sv = i / (HUE_N - 1);
        for (let k = 0; k < 3; k++) t[i * 4 + k] = clamp(f[k](h), HUE_CURVES[HUE_KEYS[k]].min, HUE_CURVES[HUE_KEYS[k]].max);
        t[i * 4 + 3] = clamp(f[3](sv), -0.5, 0.5);
      }
      return t;
    });
  }
  /** Linear read of a baked table, like the shader's two texelFetch taps. */
  function lutAt(t, n, x, ch) {
    const f = clamp(x, 0, 1) * (n - 1), i = Math.floor(f), j = Math.min(i + 1, n - 1), u = f - i;
    return t[i * 4 + ch] + (t[j * 4 + ch] - t[i * 4 + ch]) * u;
  }
  function hueAt(t, h, ch) {   // h in 0…1, wraps
    const f = (((h % 1) + 1) % 1) * HUE_N, i = Math.floor(f) % HUE_N, j = (i + 1) % HUE_N, u = f - Math.floor(f);
    return t[i * 4 + ch] + (t[j * 4 + ch] - t[i * 4 + ch]) * u;
  }
  function rgbToHsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 1e-9) {
      h = mx === r ? (g - b) / d : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6; if (h < 0) h += 1;
    }
    return [h, mx > 1e-9 ? d / mx : 0, mx];
  }
  function hsvToRgb(h, s, v) {
    const k = (n) => { const q = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(q, 4 - q, 1)); };
    return [k(5), k(3), k(1)];
  }

  /* ── The grade itself ── */
  /** Pre-compute the numbers the shader and the CPU path use. */
  function prepareGrade(g) {
    const f = fullGrade(g && g.on === false ? g : normalizeGrade(g));
    const wb = wbGains(f.temp, f.tint), ex = Math.pow(2, f.exposure);
    const per = (w, c) => w[c] + w[3];
    const P = {
      on: f.on,
      mul: [0, 1, 2].map((c) => wb[c] * ex),
      off: [0, 1, 2].map((c) => per(f.offset, c)),
      lift: [0, 1, 2].map((c) => per(f.lift, c)),
      gain: [0, 1, 2].map((c) => 1 + per(f.gain, c)),
      gam: [0, 1, 2].map((c) => 1 / Math.pow(2, per(f.gamma, c))),
      contrast: f.contrast, pivot: f.pivot,
      tone: [f.blacks, f.shadows, f.midtones, f.highlights, f.whites].map((v) => (v / 100) * TONE_K),
      lowSoft: f.lowSoft / 100, highSoft: f.highSoft / 100,
      sat: f.saturation / 100,
    };
    P.curveLut = curveLut(f.curves);
    P.hueLut = hueLut(f);
    P.linear = P.mul.some((m) => Math.abs(m - 1) > 1e-6);
    P.toned = P.tone.some((v) => v !== 0);
    return P;
  }
  /** Steps 1–6: one channel. */
  function channelCurve(v, P, c) {
    if (P.linear) v = linearToSrgb(Math.max(0, srgbToLinear(v) * P.mul[c]));
    v += P.off[c];
    v += P.lift[c] * (1 - v);
    v *= P.gain[c];
    v = Math.pow(Math.max(0, v), P.gam[c]);
    if (P.contrast !== 1) v = P.pivot * Math.pow(Math.max(0, v) / P.pivot, P.contrast);
    return v;
  }
  function softHigh(v, s) {
    if (s <= 0) return v;
    const k = 1 - 0.6 * s;
    return v > k ? k + (1 - k) * Math.tanh((v - k) / (1 - k)) : v;
  }
  function softLow(v, s) {
    if (s <= 0) return v;
    const k = 0.25 * s;
    return v < k ? k - k * Math.tanh((k - v) / k) : v;
  }
  /** Steps 7–9 on one pixel already through the channel curves. */
  function finishPixel(r, g, b, P, out) {
    if (P.toned) {
      const y = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1), u = 1 - y;
      const d = P.tone[0] * u * u * u * u + P.tone[1] * 4 * y * u * u * u + P.tone[2] * 6 * y * y * u * u +
        P.tone[3] * 4 * y * y * y * u + P.tone[4] * y * y * y * y;
      r += d; g += d; b += d;
    }
    r = softLow(softHigh(r, P.highSoft), P.lowSoft);
    g = softLow(softHigh(g, P.highSoft), P.lowSoft);
    b = softLow(softHigh(b, P.highSoft), P.lowSoft);
    if (P.sat !== 1) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = y + (r - y) * P.sat; g = y + (g - y) * P.sat; b = y + (b - y) * P.sat;
    }
    if (P.curveLut) {
      const t = P.curveLut;
      r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b, dy = lutAt(t, CURVE_N, y, 3) - y;
      r = lutAt(t, CURVE_N, r + dy, 0); g = lutAt(t, CURVE_N, g + dy, 1); b = lutAt(t, CURVE_N, b + dy, 2);
    }
    if (P.hueLut) {
      const t = P.hueLut;
      const [h, s0, v] = rgbToHsv(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
      const h2 = h + hueAt(t, h, 0) / 360, s2 = clamp(s0 * hueAt(t, h, 1), 0, 1);
      const dl = hueAt(t, h, 2) * s0 + lutAt(t, HUE_N, s0, 3);
      [r, g, b] = hsvToRgb(((h2 % 1) + 1) % 1, s2, v);
      r += dl; g += dl; b += dl;
    }
    out[0] = clamp(r, 0, 1); out[1] = clamp(g, 0, 1); out[2] = clamp(b, 0, 1);
    return out;
  }
  /** Grade one sRGB colour (0…1) — the reference the shader matches. */
  function gradePixel(rgb, g) {
    const P = g && g.mul ? g : prepareGrade(g);
    if (!P.on) return rgb.slice(0, 3);
    return finishPixel(channelCurve(rgb[0], P, 0), channelCurve(rgb[1], P, 1), channelCurve(rgb[2], P, 2), P, [0, 0, 0]);
  }
  /** Grade RGBA bytes in place (CPU fallback). Alpha is left alone. */
  function gradeImageData(data, g) {
    const P = prepareGrade(g);
    if (!P.on) return data;
    const lut = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) lut[c][i] = channelCurve(i / 255, P, c);
    const px = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      finishPixel(lut[0][data[i]], lut[1][data[i + 1]], lut[2][data[i + 2]], P, px);
      data[i] = Math.round(px[0] * 255); data[i + 1] = Math.round(px[1] * 255); data[i + 2] = Math.round(px[2] * 255);
    }
    return data;
  }
  /** Uniform values for GRADE_FRAG (flat arrays, ready for gl.uniform*). */
  function gradeUniforms(g) {
    const P = prepareGrade(g);
    return {
      uMul: P.mul, uLinear: P.linear ? 1 : 0, uOff: P.off, uLift: P.lift, uGain: P.gain, uGam: P.gam,
      uContrast: P.contrast, uPivot: P.pivot, uTone: P.tone, uSoft: [P.lowSoft, P.highSoft], uSat: P.sat,
      curveLut: P.curveLut, hueLut: P.hueLut, CURVE_N, HUE_N,
    };
  }

  const GRADE_VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;   // source crop: x, y, w, h in texture coords (y down)
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vUv = vec2(uRect.x + t.x * uRect.z, uRect.y + (1.0 - t.y) * uRect.w);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
  const GRADE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec3 uMul; uniform int uLinear;
uniform vec3 uOff, uLift, uGain, uGam;
uniform float uContrast, uPivot, uSat;
uniform float uTone[5];
uniform vec2 uSoft;
uniform sampler2D uCurveLut;  // ${CURVE_N}×1 RGBA32F: r, g, b curves + luma curve in .a
uniform sampler2D uHueLut;    // ${HUE_N}×1 RGBA32F: hue shift°, sat factor, hue→luma, sat→luma
uniform int uCurves, uHueCurves;
out vec4 outColor;
vec4 lutAt(sampler2D t, int n, float x) {
  float f = clamp(x, 0.0, 1.0) * float(n - 1);
  int i = int(floor(f));
  return mix(texelFetch(t, ivec2(i, 0), 0), texelFetch(t, ivec2(min(i + 1, n - 1), 0), 0), f - float(i));
}
vec4 hueAt(float h) {
  float f = fract(h) * float(${HUE_N});
  int i = int(floor(f)) % ${HUE_N};
  return mix(texelFetch(uHueLut, ivec2(i, 0), 0), texelFetch(uHueLut, ivec2((i + 1) % ${HUE_N}, 0), 0), fract(f));
}
vec3 rgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn, h = 0.0;
  if (d > 1e-9) {
    h = mx == c.r ? (c.g - c.b) / d : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
    h /= 6.0; if (h < 0.0) h += 1.0;
  }
  return vec3(h, mx > 1e-9 ? d / mx : 0.0, mx);
}
vec3 hsvToRgb(vec3 c) {
  vec3 q = mod(vec3(5.0, 3.0, 1.0) + c.x * 6.0, 6.0);
  return c.z - c.z * c.y * max(vec3(0.0), min(min(q, 4.0 - q), vec3(1.0)));
}
vec3 toLin(vec3 v) { return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v)); }
vec3 toSrgb(vec3 v) { return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v)); }
float softHigh(float v, float s) {
  if (s <= 0.0) return v;
  float k = 1.0 - 0.6 * s;
  return v > k ? k + (1.0 - k) * tanh((v - k) / (1.0 - k)) : v;
}
float softLow(float v, float s) {
  if (s <= 0.0) return v;
  float k = 0.25 * s;
  return v < k ? k - k * tanh((k - v) / k) : v;
}
void main() {
  vec4 src = texture(uTex, vUv);
  vec3 v = src.rgb;
  if (uLinear == 1) v = toSrgb(max(vec3(0.0), toLin(v) * uMul));
  v += uOff;
  v += uLift * (1.0 - v);
  v *= uGain;
  v = pow(max(v, vec3(0.0)), uGam);
  if (uContrast != 1.0) v = uPivot * pow(max(v, vec3(0.0)) / uPivot, vec3(uContrast));
  float y = clamp(dot(v, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0), u = 1.0 - y;
  v += uTone[0] * u * u * u * u + uTone[1] * 4.0 * y * u * u * u + uTone[2] * 6.0 * y * y * u * u +
       uTone[3] * 4.0 * y * y * y * u + uTone[4] * y * y * y * y;
  v = vec3(softLow(softHigh(v.r, uSoft.y), uSoft.x), softLow(softHigh(v.g, uSoft.y), uSoft.x), softLow(softHigh(v.b, uSoft.y), uSoft.x));
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = l + (v - l) * uSat;
  if (uCurves == 1) {
    v = clamp(v, 0.0, 1.0);
    float y = dot(v, vec3(0.2126, 0.7152, 0.0722));
    float dy = lutAt(uCurveLut, ${CURVE_N}, y).a - y;
    v = vec3(lutAt(uCurveLut, ${CURVE_N}, v.r + dy).r, lutAt(uCurveLut, ${CURVE_N}, v.g + dy).g, lutAt(uCurveLut, ${CURVE_N}, v.b + dy).b);
  }
  if (uHueCurves == 1) {
    vec3 hsv = rgbToHsv(clamp(v, 0.0, 1.0));
    vec4 hc = hueAt(hsv.x);
    float dl = hc.b * hsv.y + lutAt(uHueLut, ${HUE_N}, hsv.y).a;
    v = hsvToRgb(vec3(fract(hsv.x + hc.r / 360.0), clamp(hsv.y * hc.g, 0.0, 1.0), hsv.z)) + dl;
  }
  v = clamp(v, 0.0, 1.0);
  outColor = vec4(v * src.a, src.a);   // premultiplied for the canvas
}`;

  /* ── Scopes ──
     All read RGBA bytes (a downscaled copy of the program monitor). */
  /** kinds: any of "histogram", "waveform", "parade", "vectorscope".
   *  cols: waveform columns (default the image width). */
  function computeScopes(data, w, h, kinds, cols = w) {
    const want = new Set(kinds);
    const out = {};
    const hist = want.has("histogram") ? { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), y: new Uint32Array(256) } : null;
    const wave = want.has("waveform") ? new Uint32Array(cols * 256) : null;
    const par = want.has("parade") ? [new Uint32Array(cols * 256), new Uint32Array(cols * 256), new Uint32Array(cols * 256)] : null;
    const vec = want.has("vectorscope") ? new Uint32Array(256 * 256) : null;
    const colOf = new Uint16Array(w);
    for (let x = 0; x < w; x++) colOf[x] = Math.min(cols - 1, Math.floor(x * cols / w));
    for (let yy = 0; yy < h; yy++) {
      let i = yy * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        if (data[i + 3] === 0) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const Y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        if (hist) { hist.r[r]++; hist.g[g]++; hist.b[b]++; hist.y[Y]++; }
        const col = colOf[x];
        if (wave) wave[col * 256 + Y]++;
        if (par) { par[0][col * 256 + r]++; par[1][col * 256 + g]++; par[2][col * 256 + b]++; }
        if (vec) {
          const cb = -0.114572 * r - 0.385428 * g + 0.5 * b;   // ±127.5
          const cr = 0.5 * r - 0.454153 * g - 0.045847 * b;
          const vx = clamp(Math.round(128 + cb), 0, 255), vy = clamp(Math.round(128 - cr), 0, 255);
          vec[vy * 256 + vx]++;
        }
      }
    }
    if (hist) out.histogram = hist;
    if (wave) out.waveform = { cols, data: wave };
    if (par) out.parade = { cols, data: par };
    if (vec) out.vectorscope = vec;
    return out;
  }
  /** Where the 75 % colour bars land on a 256² vectorscope (x, y, label). */
  function vectorTargets(level = 0.75) {
    const bars = { R: [1, 0, 0], Mg: [1, 0, 1], B: [0, 0, 1], Cy: [0, 1, 1], G: [0, 1, 0], Yl: [1, 1, 0] };
    return Object.entries(bars).map(([label, c]) => {
      const [, cb, cr] = ycbcr(c[0] * level, c[1] * level, c[2] * level);
      return { label, x: 128 + cb * 255, y: 128 - cr * 255 };
    });
  }
  const SKIN_ANGLE = 123; // degrees from +Cb toward +Cr — the "I" / skin-tone line

  const HUE_NAMES = [["red", 0], ["orange", 30], ["yellow", 60], ["green", 120], ["cyan", 180], ["blue", 240], ["magenta", 300]];
  /** Plain-number summary of a frame for agents: levels, clipping, cast. */
  function scopeStats(data, w, h) {
    const hy = new Uint32Array(256);
    let n = 0, sr = 0, sg = 0, sb = 0, sat = 0, mcb = 0, mcr = 0, mn = 0;
    for (let i = 0; i < w * h * 4; i += 4) {
      if (data[i + 3] === 0) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [Y, cb, cr] = ycbcr(r / 255, g / 255, b / 255);
      hy[clamp(Math.round(Y * 255), 0, 255)]++;
      n++; sr += r; sg += g; sb += b; sat += Math.hypot(cb, cr);
      if (Y > 0.15 && Y < 0.85) { mcb += cb; mcr += cr; mn++; }
    }
    if (!n) return null;
    const pct = (q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hy[i]; if (acc >= q * n) return i / 255; } return 1; };
    let sum = 0, lo = -1, hi = 0;
    for (let i = 0; i < 256; i++) { sum += i * hy[i]; if (hy[i] && lo < 0) lo = i; if (hy[i]) hi = i; }
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const cb = mn ? mcb / mn : 0, cr = mn ? mcr / mn : 0;
    // hue of the cast, measured like an HSV hue (red 0°, green 120°, blue 240°)
    const rgb = [cr * 1.5748, -0.18733 * cb - 0.46812 * cr, 1.8556 * cb];
    const hue = rgbHue(rgb);
    const strength = Math.hypot(cb, cr);
    const name = HUE_NAMES.reduce((best, [nm, a]) => {
      const d = Math.min(Math.abs(hue - a), 360 - Math.abs(hue - a));
      return d < best.d ? { nm, d } : best;
    }, { nm: "", d: 999 }).nm;
    return {
      pixels: n,
      luma: { min: r3(lo / 255), p1: r3(pct(0.01)), median: r3(pct(0.5)), mean: r3(sum / n / 255), p99: r3(pct(0.99)), max: r3(hi / 255) },
      clipped: { blackPct: r3(100 * hy[0] / n), whitePct: r3(100 * hy[255] / n) },
      rgbMean: [r3(sr / n / 255), r3(sg / n / 255), r3(sb / n / 255)],
      saturation: r3(sat / n),
      cast: strength < 0.01 ? { tone: "neutral", strength: r3(strength) } : { tone: name, hue: Math.round(hue), strength: r3(strength) },
    };
  }
  function rgbHue([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d <= 0) return 0;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }
  /** Short text for a grade, e.g. "exposure+0.3 temp-12 lift(0,0,0.02,-0.03)". */
  function summarizeGrade(g) {
    const s = normalizeGrade(g);
    if (!s) return "neutral";
    return Object.entries(s).map(([k, v]) => k === "on" ? "(bypassed)"
      : k === "curves" ? `curves(${Object.keys(v).join(",")})`
      : HUE_CURVES[k] ? `${k}(${v.map((p) => p.join(":")).join(" ")})`
      : Array.isArray(v) ? `${k}(${v.join(",")})` : `${k}${v >= 0 && k !== "contrast" && k !== "pivot" && k !== "saturation" ? "+" : ""}${v}`).join(" ");
  }

  return {
    GRADE_PARAMS, GRADE_KEYS, WHEELS, GRADE_VERT, GRADE_FRAG, SKIN_ANGLE,
    CURVE_CHANNELS, HUE_CURVES, HUE_KEYS, CURVE_N, HUE_N, BAND,
    normalizeGrade, fullGrade, isNeutral, mergeGrade, summarizeGrade, withoutCurves,
    monotone, curveFn, rgbToHsv, hsvToRgb,
    wbGains, solveWhiteBalance, srgbToLinear, linearToSrgb, wheelToRgb, rgbToWheel, ycbcr,
    prepareGrade, gradePixel, gradeImageData, gradeUniforms,
    computeScopes, vectorTargets, scopeStats, round,
  };
});
