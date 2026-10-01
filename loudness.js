/* FableCut loudness measurement — ITU-R BS.1770-4 integrated loudness (LUFS,
   EBU R128 gating) and sample peak. Zero dependencies. Loaded by the editor as
   a plain script (global `FableCutLoudness`) and required by the MCP server,
   so Normalize in the UI and `fablecut_normalize_audio` measure identically.

   A clip is measured AFTER its channel routing (audioChannel / channelMode)
   and BEFORE gain, volume and pan: equal-power pan keeps BS.1770 loudness, so
   the reading holds wherever the clip is panned. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutLoudness = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* K-weighting: stage 1 high shelf + stage 2 RLB high-pass, with the
     BS.1770 analog prototypes re-derived for any sample rate (same values the
     meter worklet uses). */
  function shelfCoeffs(fs) {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.5);
    const a0 = 1 + K / Q + K * K;
    return {
      b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0,
      b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0,
    };
  }
  function hpfCoeffs(fs) {
    const f0 = 38.13547087613982, Q = 0.5003270373238773;
    const K = Math.tan(Math.PI * f0 / fs);
    const a0 = 1 + K / Q + K * K;
    return { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  }
  function biquad(c) { return { ...c, z1: 0, z2: 0 }; }

  const ABS_GATE = -70;     // LUFS
  const REL_GATE = -10;     // LU below the abs-gated mean
  const loud = (ms) => -0.691 + 10 * Math.log10(ms);

  /** Streaming meter: push() channel arrays of equal length as audio arrives,
   *  then result(). Every channel is weighted 1 (mono / stereo programme). */
  class LoudnessMeter {
    constructor(channels, sampleRate) {
      this.fs = sampleRate;
      this.step = Math.max(1, Math.round(sampleRate * 0.1)); // 100 ms hop, 400 ms blocks (75% overlap)
      this.filters = [];
      for (let i = 0; i < channels; i++)
        this.filters.push([biquad(shelfCoeffs(sampleRate)), biquad(hpfCoeffs(sampleRate))]);
      this.sub = [];      // K-weighted energy per 100 ms step, summed over channels
      this.acc = 0;       // energy of the step being filled
      this.fill = 0;      // samples in the step being filled
      this.tail = 0;      // energy of everything (fallback for < 400 ms)
      this.n = 0;
      this.peak = 0;
    }
    push(chs) {
      const len = chs.length ? chs[0].length : 0;
      for (let i = 0; i < len; i++) {
        let e = 0;
        for (let c = 0; c < chs.length && c < this.filters.length; c++) {
          const x = chs[c][i];
          const a = x < 0 ? -x : x;
          if (a > this.peak) this.peak = a;
          const [s, h] = this.filters[c];
          let y = s.b0 * x + s.z1;
          s.z1 = s.b1 * x - s.a1 * y + s.z2; s.z2 = s.b2 * x - s.a2 * y;
          const x2 = y;
          y = h.b0 * x2 + h.z1;
          h.z1 = h.b1 * x2 - h.a1 * y + h.z2; h.z2 = h.b2 * x2 - h.a2 * y;
          e += y * y;
        }
        this.acc += e;
        this.tail += e;
        if (++this.fill === this.step) { this.sub.push(this.acc); this.acc = 0; this.fill = 0; }
      }
      this.n += len;
    }
    /** {lufs, peak, peakDb}: lufs is -Infinity for silence, peak is linear. */
    result() {
      const blocks = [];
      for (let j = 0; j + 4 <= this.sub.length; j++)
        blocks.push((this.sub[j] + this.sub[j + 1] + this.sub[j + 2] + this.sub[j + 3]) / (4 * this.step));
      // Shorter than one 400 ms block: gate the whole clip as a single block.
      if (!blocks.length && this.n > 0) blocks.push(this.tail / this.n);
      const absGated = blocks.filter((z) => z > 0 && loud(z) > ABS_GATE);
      let lufs = -Infinity;
      if (absGated.length) {
        const rel = loud(absGated.reduce((a, b) => a + b, 0) / absGated.length) + REL_GATE;
        const gated = absGated.filter((z) => loud(z) > rel);
        if (gated.length) lufs = loud(gated.reduce((a, b) => a + b, 0) / gated.length);
      }
      const peakDb = this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
      return { lufs, peak: this.peak, peakDb };
    }
  }

  function measure(chs, sampleRate) {
    const m = new LoudnessMeter(chs.length, sampleRate);
    m.push(chs);
    return m.result();
  }

  const CHANNEL_MODES = ["stereo", "mono", "left", "right", "swap"];

  /** What a clip sends into its gain stage, as channel arrays. Mirrors the
   *  editor's audio graph: an isolated stem (audioChannel) or a mono mode is
   *  one channel (pan places it with equal power); stereo/swap keep them all. */
  function routeChannels(chs, { audioChannel, channelMode } = {}) {
    if (!chs.length) return [];
    if (Number.isInteger(audioChannel) && audioChannel >= 0)
      return audioChannel < chs.length ? [chs[audioChannel]] : [];
    const mode = CHANNEL_MODES.includes(channelMode) ? channelMode : "stereo";
    if (chs.length === 1) return [chs[0]];
    if (mode === "left") return [chs[0]];
    if (mode === "right") return [chs[1]];
    if (mode === "swap") return [chs[1], chs[0], ...chs.slice(2)];
    if (mode === "mono") {
      const n = chs[0].length, out = new Float32Array(n), k = 1 / chs.length;
      for (const x of chs) for (let i = 0; i < n; i++) out[i] += x[i] * k;
      return [out];
    }
    return chs;
  }

  /** Gain (dB) that brings a measurement to `target` ({mode:"lufs"|"peak", value}).
   *  null when the clip is silent — nothing to normalize. */
  function normalizeGainDb(m, target) {
    const level = target.mode === "peak" ? m.peakDb : m.lufs;
    if (!Number.isFinite(level)) return null;
    return target.value - level;
  }

  return { LoudnessMeter, measure, routeChannels, normalizeGainDb, CHANNEL_MODES, shelfCoeffs, hpfCoeffs };
});
