/* FableCut audio-effect processors the Web Audio API has no node for.
   Loaded into the live AudioContext and into each export's
   OfflineAudioContext, so preview and export run the same code.

   fablecut-limiter — brickwall peak limiter: 5 ms lookahead, stereo-linked.
     The audio is delayed by the lookahead; the gain needed for every sample
     in that window is known before the sample plays, so peaks never pass the
     ceiling. Gain recovers with an exponential release.
   fablecut-pitch — pitch shift (semitones), two-tap delay line (below).
   fablecut-gate — noise gate: opens (attack) when the input peak rises over
     the threshold, stays open for `hold`, then closes (release) down to
     `range` dB. */

const dbToLin = (db) => Math.pow(10, db / 20);
const coef = (ms) => (ms <= 0 ? 0 : Math.exp(-1 / (sampleRate * ms / 1000)));

class FableCutLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "ceiling", defaultValue: -1, minValue: -24, maxValue: 0, automationRate: "k-rate" },
      { name: "release", defaultValue: 80, minValue: 5, maxValue: 1000, automationRate: "k-rate" },
    ];
  }
  constructor() {
    super();
    this.la = Math.max(1, Math.round(0.005 * sampleRate));
    this.delay = [];                        // per-channel ring of delayed samples
    this.need = new Float32Array(this.la).fill(1); // gain each sample in the window needs
    this.pos = 0;
    this.g = 1;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const ceil = dbToLin(params.ceiling[0]);
    const rel = coef(params.release[0]);
    const nCh = Math.min(inp.length, out.length);
    while (this.delay.length < nCh) this.delay.push(new Float32Array(this.la));
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < nCh; c++) { const a = Math.abs(inp[c][i]); if (a > pk) pk = a; }
      this.need[this.pos] = pk > ceil ? ceil / pk : 1;
      let lo = 1;
      for (let k = 0; k < this.la; k++) if (this.need[k] < lo) lo = this.need[k];
      // Fall instantly to what the window needs; recover smoothly.
      this.g = lo < this.g ? lo : lo + (this.g - lo) * rel;
      for (let c = 0; c < nCh; c++) {
        const d = this.delay[c];
        out[c][i] = d[this.pos] * this.g;
        d[this.pos] = inp[c][i];
      }
      this.pos = (this.pos + 1) % this.la;
    }
    return true;
  }
}

class FableCutGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = "k-rate";
    return [
      { name: "threshold", defaultValue: -50, minValue: -80, maxValue: -10, automationRate: k },
      { name: "range", defaultValue: -40, minValue: -80, maxValue: 0, automationRate: k },
      { name: "attack", defaultValue: 2, minValue: 0, maxValue: 50, automationRate: k },
      { name: "hold", defaultValue: 80, minValue: 0, maxValue: 500, automationRate: k },
      { name: "release", defaultValue: 150, minValue: 5, maxValue: 1000, automationRate: k },
    ];
  }
  constructor() {
    super();
    this.env = 0;      // peak follower
    this.g = 1;        // applied gain
    this.holdLeft = 0; // samples the gate stays open after the signal drops
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const thr = dbToLin(params.threshold[0]);
    const floor = dbToLin(params.range[0]);
    const att = coef(params.attack[0]), rel = coef(params.release[0]);
    const holdN = Math.round(sampleRate * params.hold[0] / 1000);
    const envRel = coef(10);
    const nCh = Math.min(inp.length, out.length);
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < nCh; c++) { const a = Math.abs(inp[c][i]); if (a > pk) pk = a; }
      this.env = pk > this.env ? pk : this.env * envRel;
      if (this.env >= thr) this.holdLeft = holdN;
      else if (this.holdLeft > 0) this.holdLeft--;
      const target = this.env >= thr || this.holdLeft > 0 ? 1 : floor;
      const k = target > this.g ? att : rel;
      this.g = target + (this.g - target) * k;
      for (let c = 0; c < nCh; c++) out[c][i] = inp[c][i] * this.g;
    }
    return true;
  }
}

/* fablecut-pitch — pitch shift without changing speed. A delay line read by
   two taps half a window apart: each tap's delay sweeps through the window
   at (1 − ratio) samples per sample, so it plays the input back faster or
   slower, and a sin² crossfade hides the jump when a tap wraps (the two
   weights always sum to 1). Adds about half a window (~30 ms) of latency. */
class FableCutPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = "k-rate";
    return [
      { name: "semitones", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: k },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: k },
    ];
  }
  constructor() {
    super();
    this.W = Math.max(64, Math.round(0.06 * sampleRate)); // window, samples
    this.N = this.W * 2 + 4;                              // ring length
    this.buf = [];
    this.w = 0;   // write index
    this.d = 0;   // tap A's delay, 0…W
  }
  read(b, delay) {
    let p = this.w - delay;
    while (p < 0) p += this.N;
    const i = Math.floor(p), f = p - i;
    return b[i % this.N] * (1 - f) + b[(i + 1) % this.N] * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const semi = params.semitones[0], mix = params.mix[0];
    const nCh = Math.min(inp.length, out.length);
    while (this.buf.length < nCh) this.buf.push(new Float32Array(this.N));
    const n = inp[0].length;
    if (Math.abs(semi) < 0.01 || mix <= 0) { // exact pass-through, keep the line warm
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < nCh; c++) { this.buf[c][this.w] = inp[c][i]; out[c][i] = inp[c][i]; }
        this.w = (this.w + 1) % this.N;
      }
      return true;
    }
    const step = 1 - Math.pow(2, semi / 12), W = this.W, half = W / 2;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nCh; c++) this.buf[c][this.w] = inp[c][i];
      this.d += step;
      if (this.d >= W) this.d -= W; else if (this.d < 0) this.d += W;
      const d2 = this.d >= half ? this.d - half : this.d + half;
      const s = Math.sin(Math.PI * this.d / W), g1 = s * s, g2 = 1 - g1;
      for (let c = 0; c < nCh; c++) {
        const b = this.buf[c];
        const wet = g1 * this.read(b, this.d) + g2 * this.read(b, d2);
        out[c][i] = inp[c][i] * (1 - mix) + wet * mix;
      }
      this.w = (this.w + 1) % this.N;
    }
    return true;
  }
}

registerProcessor("fablecut-limiter", FableCutLimiter);
registerProcessor("fablecut-gate", FableCutGate);
registerProcessor("fablecut-pitch", FableCutPitch);
