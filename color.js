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
   Steps 1–6 are per channel, so the CPU path bakes them into a table. */
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
      const def = GRADE_PARAMS[k];
      if (!def) {
        if (strict) throw new Error(`unknown grade key ${JSON.stringify(k)} (known: on, ${GRADE_KEYS.join(", ")})`);
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
  /** Every key filled in (wheels as fresh arrays). */
  function fullGrade(g) {
    const out = { on: !(g && g.on === false) };
    for (const k of GRADE_KEYS) {
      const v = g && g[k];
      out[k] = WHEELS.includes(k) ? (Array.isArray(v) ? v.slice(0, 4) : [0, 0, 0, 0]) : (typeof v === "number" ? v : GRADE_PARAMS[k].def);
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
    return true;
  }
  /** Merge a change into a grade (null on a key resets it) → sparse. */
  function mergeGrade(g, set, strict = false) {
    const next = { ...(g || {}) };
    for (const [k, v] of Object.entries(set || {})) {
      if (v === null) delete next[k];
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

  /* ── The grade itself ── */
  /** Pre-compute the numbers the shader and the CPU path use. */
  function prepareGrade(g) {
    const f = fullGrade(g);
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
out vec4 outColor;
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
      : Array.isArray(v) ? `${k}(${v.join(",")})` : `${k}${v >= 0 && k !== "contrast" && k !== "pivot" && k !== "saturation" ? "+" : ""}${v}`).join(" ");
  }

  return {
    GRADE_PARAMS, GRADE_KEYS, WHEELS, GRADE_VERT, GRADE_FRAG, SKIN_ANGLE,
    normalizeGrade, fullGrade, isNeutral, mergeGrade, summarizeGrade,
    wbGains, solveWhiteBalance, srgbToLinear, linearToSrgb, wheelToRgb, rgbToWheel, ycbcr,
    prepareGrade, gradePixel, gradeImageData, gradeUniforms,
    computeScopes, vectorTargets, scopeStats, round,
  };
});
