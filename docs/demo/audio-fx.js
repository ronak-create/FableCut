/* FableCut audio effects — the data side: what each effect is, its
   parameters and ranges, validation, and the named presets. Zero
   dependencies. Loaded by the editor as a plain script (global `FableCutFx`)
   and required by the MCP server, so `setFx` from an agent and the editor's
   effects panel accept exactly the same chains. The audio nodes themselves
   are built in app.js (buildFxChain) and fx-worklet.js (gate, limiter, pitch).

   A chain is an array, processed in order:
     [{ type: "highpass", freq: 80 }, { type: "compressor", threshold: -20, ratio: 4 }, …]
   Every parameter is optional (defaults below); `on: false` bypasses an
   effect without losing its settings.

   Automation: an effect may carry `keys`, keyframes per parameter —
     { type: "lowpass", freq: 8000, keys: { freq: [{ t: 0, v: 8000 }, { t: 4, v: 400, ease: "linear" }] } }
   `t` is seconds from the clip's start for a clip's effects, and timeline
   seconds for a track's, a bus's or the master's. While a parameter has keys
   they decide its value; the plain value is used again once they are gone. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutFx = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // [default, min, max, step, unit, label]
  const P = (def, min, max, step, unit, label) => ({ def, min, max, step, unit, label });
  const FX_DEFS = {
    eq: {
      label: "EQ (3-band)",
      params: {
        lowFreq: P(120, 20, 1000, 1, "Hz", "Low freq"), lowGain: P(0, -18, 18, 0.5, "dB", "Low"),
        midFreq: P(1000, 100, 8000, 10, "Hz", "Mid freq"), midGain: P(0, -18, 18, 0.5, "dB", "Mid"),
        midQ: P(1, 0.1, 10, 0.1, "", "Mid Q"),
        highFreq: P(8000, 1000, 18000, 100, "Hz", "High freq"), highGain: P(0, -18, 18, 0.5, "dB", "High"),
      },
    },
    highpass: { label: "High-pass", params: { freq: P(80, 20, 2000, 1, "Hz", "Cutoff"), q: P(0.71, 0.1, 10, 0.01, "", "Q") } },
    lowpass: { label: "Low-pass", params: { freq: P(8000, 200, 20000, 10, "Hz", "Cutoff"), q: P(0.71, 0.1, 10, 0.01, "", "Q") } },
    compressor: {
      label: "Compressor",
      params: {
        threshold: P(-20, -60, 0, 0.5, "dB", "Threshold"), ratio: P(4, 1, 20, 0.1, ":1", "Ratio"),
        attack: P(10, 0, 1000, 1, "ms", "Attack"), release: P(200, 10, 1000, 5, "ms", "Release"),
        knee: P(6, 0, 40, 1, "dB", "Knee"), makeup: P(0, 0, 24, 0.5, "dB", "Makeup"),
      },
    },
    limiter: {
      label: "Limiter",
      params: { ceiling: P(-1, -24, 0, 0.1, "dB", "Ceiling"), release: P(80, 5, 1000, 5, "ms", "Release") },
    },
    gate: {
      label: "Noise gate",
      params: {
        threshold: P(-50, -80, -10, 0.5, "dB", "Threshold"), range: P(-40, -80, 0, 1, "dB", "Range"),
        attack: P(2, 0, 50, 0.5, "ms", "Attack"), hold: P(80, 0, 500, 5, "ms", "Hold"),
        release: P(150, 5, 1000, 5, "ms", "Release"),
      },
    },
    delay: {
      label: "Delay",
      params: { time: P(0.3, 0.01, 2, 0.01, "s", "Time"), feedback: P(0.35, 0, 0.9, 0.01, "", "Feedback"), mix: P(0.25, 0, 1, 0.01, "", "Mix") },
    },
    reverb: {
      label: "Reverb",
      params: { decay: P(2, 0.2, 8, 0.1, "s", "Decay"), predelay: P(20, 0, 200, 1, "ms", "Pre-delay"), mix: P(0.25, 0, 1, 0.01, "", "Mix") },
    },
    distortion: {
      label: "Distortion",
      params: { drive: P(0.3, 0, 1, 0.01, "", "Drive"), mix: P(1, 0, 1, 0.01, "", "Mix") },
    },
    widener: {
      label: "Stereo width",
      params: { width: P(1.5, 0, 2, 0.01, "×", "Width") },
    },
    pitch: {
      label: "Pitch shift",
      params: { semitones: P(0, -12, 12, 0.5, "st", "Pitch"), mix: P(1, 0, 1, 0.01, "", "Mix") },
    },
  };
  // A new impulse response per value — too heavy to sweep, so not automatable.
  FX_DEFS.reverb.params.decay.fixed = true;
  const EASES = ["linear", "ease-in", "ease-out", "ease-in-out"];
  const EASE = {
    linear: (u) => u,
    "ease-in": (u) => u * u,
    "ease-out": (u) => 1 - (1 - u) * (1 - u),
    "ease-in-out": (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  };
  const FX_TYPES = Object.keys(FX_DEFS);

  /** A clean copy of one effect: known type, every param present and in
   *  range. Returns null for an unknown type. */
  function normalizeEffect(raw, strict = false) {
    if (!raw || typeof raw !== "object" || !FX_DEFS[raw.type]) return null;
    const out = { type: raw.type };
    for (const [k, d] of Object.entries(FX_DEFS[raw.type].params)) {
      const v = +raw[k];
      out[k] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.def;
    }
    if (raw.on === false) out.on = false;
    const keys = normalizeKeys(raw.type, raw.keys, strict);
    if (keys) out.keys = keys;
    return out;
  }
  /** Clean automation for one effect: known, automatable params only; points
   *  with numeric t ≥ 0, values clamped to the param's range, sorted, one per
   *  time. Returns undefined when nothing is left. */
  function normalizeKeys(type, raw, strict = false) {
    if (raw == null) return undefined;
    const bad = (msg) => { if (strict) throw new Error(`${type} keys: ${msg}`); };
    if (typeof raw !== "object" || Array.isArray(raw)) { bad("must be an object of param → [{t, v}]"); return undefined; }
    const out = {};
    for (const [k, list] of Object.entries(raw)) {
      const d = FX_DEFS[type].params[k];
      if (!d) { bad(`unknown parameter ${JSON.stringify(k)} (known: ${Object.keys(FX_DEFS[type].params).join(", ")})`); continue; }
      if (d.fixed) { bad(`${k} cannot be automated`); continue; }
      if (list == null) continue;
      if (!Array.isArray(list)) { bad(`${k} must be an array of {t, v}`); continue; }
      const byT = new Map();
      for (const kf of list) {
        const t = +kf?.t, v = +kf?.v;
        if (!Number.isFinite(t) || t < 0 || !Number.isFinite(v)) { bad(`${k}: every key needs t ≥ 0 and a numeric v`); continue; }
        const key = { t: Math.round(t * 1e4) / 1e4, v: Math.min(d.max, Math.max(d.min, v)) };
        if (kf.ease != null) {
          if (EASES.includes(kf.ease)) key.ease = kf.ease;
          else bad(`${k}: ease must be one of ${EASES.join(", ")}`);
        }
        byT.set(key.t, key);
      }
      const arr = [...byT.values()].sort((a, b) => a.t - b.t);
      if (arr.length) out[k] = arr;
    }
    return Object.keys(out).length ? out : undefined;
  }
  /** One automated parameter at time t (ease on the destination key, like clip keyframes). */
  function keyValue(arr, t) {
    if (t <= arr[0].t) return arr[0].v;
    const last = arr[arr.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      if (t >= a.t && t <= b.t) {
        const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return a.v + (b.v - a.v) * (EASE[b.ease || "ease-in-out"] || EASE.linear)(u);
      }
    }
    return last.v;
  }
  /** The effect's parameters at time t (keys applied). Same object when it has none. */
  function evalEffect(e, t) {
    if (!e.keys) return e;
    const out = { ...e };
    for (const [k, arr] of Object.entries(e.keys)) if (arr.length) out[k] = keyValue(arr, t);
    return out;
  }
  const hasKeys = (list) => Array.isArray(list) && list.some((e) => e && e.keys && e.on !== false);
  /** Validate a chain. `strict` throws on the first bad entry (MCP); otherwise
   *  unknown effects are dropped (loading a project from a newer version). */
  function normalizeFx(list, strict = false) {
    if (list == null) return [];
    if (!Array.isArray(list)) {
      if (strict) throw new Error("fx must be an array of effects");
      return [];
    }
    const out = [];
    list.forEach((raw, i) => {
      const e = normalizeEffect(raw, strict);
      if (e) out.push(e);
      else if (strict) throw new Error(`fx[${i}]: unknown effect ${JSON.stringify(raw && raw.type)} (known: ${FX_TYPES.join(", ")})`);
    });
    return out;
  }

  /* Presets: starting points, written into the chain as plain effects so
     they can be tweaked afterwards (and read back by an agent). */
  const PRESETS = {
    "clean-voice": { group: "Voice", label: "Clean voice", fx: [
      { type: "highpass", freq: 80 },
      { type: "eq", lowFreq: 200, lowGain: -2, midFreq: 3000, midGain: 1.5, highFreq: 10000, highGain: 1 },
      { type: "compressor", threshold: -18, ratio: 3, attack: 10, release: 150, makeup: 3 },
      { type: "limiter", ceiling: -1 },
    ] },
    podcast: { group: "Voice", label: "Podcast", fx: [
      { type: "highpass", freq: 90 },
      { type: "gate", threshold: -50, range: -30, hold: 100, release: 200 },
      { type: "eq", lowFreq: 150, lowGain: 1.5, midFreq: 3500, midGain: 2.5, midQ: 0.8, highFreq: 10000, highGain: 2 },
      { type: "compressor", threshold: -22, ratio: 4, attack: 5, release: 120, knee: 8, makeup: 6 },
      { type: "limiter", ceiling: -1 },
    ] },
    radio: { group: "Voice", label: "Radio", fx: [
      { type: "highpass", freq: 120 },
      { type: "eq", lowFreq: 160, lowGain: 3, midFreq: 3000, midGain: 4, midQ: 1.2, highFreq: 9000, highGain: -2 },
      { type: "compressor", threshold: -28, ratio: 8, attack: 2, release: 80, knee: 4, makeup: 9 },
      { type: "distortion", drive: 0.08, mix: 0.4 },
      { type: "limiter", ceiling: -1 },
    ] },
    "deep-voice": { group: "Voice", label: "Deep voice", fx: [
      { type: "pitch", semitones: -4 },
      { type: "eq", lowFreq: 140, lowGain: 5, midFreq: 2500, midGain: -2, midQ: 0.8, highFreq: 7000, highGain: -4 },
      { type: "lowpass", freq: 7500 },
      { type: "compressor", threshold: -20, ratio: 3, makeup: 2 },
      { type: "limiter", ceiling: -1 },
    ] },
    telephone: { group: "Voice", label: "Telephone", fx: [
      { type: "highpass", freq: 400, q: 1 },
      { type: "lowpass", freq: 3400, q: 1 },
      { type: "eq", midFreq: 1500, midGain: 6, midQ: 1 },
      { type: "distortion", drive: 0.35, mix: 0.6 },
      { type: "compressor", threshold: -24, ratio: 6, makeup: 6 },
      { type: "limiter", ceiling: -2 },
    ] },
    cinematic: { group: "Music", label: "Cinematic", fx: [
      { type: "eq", lowFreq: 80, lowGain: 3, midFreq: 400, midGain: -1.5, midQ: 0.7, highFreq: 10000, highGain: 2 },
      { type: "widener", width: 1.3 },
      { type: "reverb", decay: 2.8, predelay: 30, mix: 0.22 },
      { type: "compressor", threshold: -16, ratio: 2, attack: 30, release: 300, makeup: 1.5 },
    ] },
    wide: { group: "Music", label: "Wide", fx: [{ type: "widener", width: 1.6 }] },
    muffled: { group: "Music", label: "Muffled (next room)", fx: [
      { type: "lowpass", freq: 700, q: 0.8 },
      { type: "eq", lowFreq: 150, lowGain: 2, highFreq: 4000, highGain: -6 },
      { type: "reverb", decay: 0.9, predelay: 10, mix: 0.18 },
    ] },
  };
  const PRESET_IDS = Object.keys(PRESETS);
  function presetChain(id) {
    const p = PRESETS[id];
    if (!p) throw new Error(`unknown preset ${JSON.stringify(id)} (known: ${PRESET_IDS.join(", ")})`);
    return normalizeFx(p.fx);
  }
  /** Short text for a chain, e.g. "highpass·eq·compressor(off)·lowpass~freq". */
  function summarizeFx(list) {
    return (list || []).map((e) => e.type + (e.on === false ? "(off)" : "") +
      (e.keys ? "~" + Object.keys(e.keys).join("~") : "")).join("·");
  }

  return {
    FX_DEFS, FX_TYPES, PRESETS, PRESET_IDS, EASES,
    normalizeEffect, normalizeFx, normalizeKeys, presetChain, summarizeFx, keyValue, evalEffect, hasKeys,
  };
});
