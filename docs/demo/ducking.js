/* FableCut auto-duck — find where the voice is and turn that into `duck`
   keyframes (dB) on the music. Zero dependencies; loaded by the editor as a
   plain script (global `FableCutDucking`) and required by the MCP server, so
   the inspector's Auto-duck and `fablecut_auto_duck` write identical keys.

   Pipeline: rmsEnvelope (per voice clip) → activeRegions (timeline seconds,
   above a threshold) → mergeRegions (all voices, short gaps bridged) →
   duckKeyframes (ramps down before speech, back up after). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutDucking = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const HOP = 0.05;  // s between envelope points
  const WIN = 0.1;   // s RMS window

  /** Streaming RMS envelope over one or more channels (power summed, so a
   *  stereo voice reads like its loudness). push() as audio arrives. */
  class EnvelopeMeter {
    constructor(channels, sampleRate, hop = HOP, win = WIN) {
      this.c = channels;
      this.hopN = Math.max(1, Math.round(hop * sampleRate));
      this.winN = Math.max(this.hopN, Math.round(win * sampleRate));
      this.ring = new Float64Array(this.winN); // per-sample power, last winN
      this.idx = 0; this.sum = 0; this.n = 0;
      this.out = [];
    }
    push(chs) {
      const len = chs.length ? chs[0].length : 0;
      for (let i = 0; i < len; i++) {
        let e = 0;
        for (let k = 0; k < chs.length; k++) { const x = chs[k][i]; e += x * x; }
        this.sum += e - this.ring[this.idx];
        this.ring[this.idx] = e;
        this.idx = (this.idx + 1) % this.winN;
        if (++this.n % this.hopN === 0)
          this.out.push(Math.sqrt(Math.max(0, this.sum) / Math.min(this.n, this.winN)));
      }
    }
    /** Linear RMS per hop; point i covers the window ending at (i + 1) × hop. */
    result() { return Float32Array.from(this.out); }
  }
  function rmsEnvelope(chs, sampleRate, hop = HOP) {
    const m = new EnvelopeMeter(chs.length, sampleRate, hop);
    m.push(chs);
    return m.result();
  }

  /** Timeline [start, end] spans where the envelope is above threshold.
   *  env[i] maps to timeline t0 + (i + 1) × hop / speed; `gain` (linear) is the
   *  clip's own gain × volume, so a quiet take still counts as voice. */
  function activeRegions(env, { t0 = 0, hop = HOP, speed = 1, gain = 1, threshold = -40, minLen = 0.25 } = {}) {
    const lim = Math.pow(10, threshold / 20);
    const step = hop / Math.max(0.01, speed);
    const out = [];
    let a = -1;
    for (let i = 0; i <= env.length; i++) {
      const on = i < env.length && env[i] * gain >= lim;
      if (on && a < 0) a = i;
      if (!on && a >= 0) {
        // the window ending at point a started WIN earlier — begin there
        const s = t0 + Math.max(0, (a + 1) * step - WIN / Math.max(0.01, speed));
        const e = t0 + i * step;
        if (e - s >= minLen) out.push([s, e]);
        a = -1;
      }
    }
    return out;
  }

  /** Union of region lists; gaps shorter than `gap` seconds are bridged so the
   *  music doesn't pump between words. */
  function mergeRegions(lists, gap = 0.6) {
    const all = lists.flat().filter((r) => r[1] > r[0]).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [s, e] of all) {
      const last = out[out.length - 1];
      if (last && s <= last[1] + gap) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }

  /** `duck` keyframes (clip-local seconds, dB) for one music clip.
   *  Ramps start `attack` s before each region and recover over `release` s
   *  after it; ramps that would meet stay ducked. Returns [] when no region
   *  touches the clip. */
  function duckKeyframes(regions, { start, duration }, { amount = -12, attack = 0.3, release = 0.6 } = {}) {
    amount = Math.min(0, +amount || 0);
    const end = start + duration;
    const spans = mergeRegions([regions.map(([s, e]) => [s - attack, e + release])], 0)
      .filter(([s, e]) => e > start && s < end);
    if (!spans.length || !amount) return [];
    // The envelope in timeline time: each span is 0 → amount (attack) → hold →
    // amount → 0 (release). A merged span always has attack-end ≤ release-start.
    const pts = [];
    for (const [s, e] of spans) pts.push([s, 0], [s + attack, amount], [e - release, amount], [e, 0]);
    const valAt = (t) => {
      if (t <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        const [t1, v1] = pts[i], [t0, v0] = pts[i - 1];
        if (t <= t1) return t1 > t0 ? v0 + (v1 - v0) * (t - t0) / (t1 - t0) : v1;
      }
      return pts[pts.length - 1][1];
    };
    // Cut it to the clip: interpolated values on the edges, corners inside.
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const keys = [];
    const put = (t, v) => {
      t = r3(t - start); v = r3(v) || 0;
      const last = keys[keys.length - 1];
      if (last && t <= last.t) { last.v = v; return; } // same instant: latest wins
      keys.push({ t, v, ease: "linear" });
    };
    const v0 = valAt(start), v1 = valAt(end);
    if (v0) put(start, v0);
    for (const [t, v] of pts) if (t > start && t < end) put(t, v);
    if (v1) put(end, v1);
    // collapse runs of equal values to their two ends
    return keys.filter((k, i) => !(i > 0 && i < keys.length - 1 &&
      keys[i - 1].v === k.v && keys[i + 1].v === k.v));
  }

  return { HOP, WIN, EnvelopeMeter, rmsEnvelope, activeRegions, mergeRegions, duckKeyframes };
});
