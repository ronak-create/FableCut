/* FableCut per-track meter worklet.
   Each input = one timeline audio track. Pass-through mix to stereo out.
   Reports per-track: RMS, sample peak, and momentary LUFS (ITU-R BS.1770-4,
   400 ms, K-weighted stereo). */
function shelfCoeffs(fs) {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.5);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}
function hpfCoeffs(fs) {
  const f0 = 38.13547087613982;
  const Q = 0.5003270373238773;
  const K = Math.tan(Math.PI * f0 / fs);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}
function makeBiquad(c) {
  return { b0: c.b0, b1: c.b1, b2: c.b2, a1: c.a1, a2: c.a2, z1: 0, z2: 0 };
}
function biquadStep(f, x) {
  const y = f.b0 * x + f.z1;
  f.z1 = f.b1 * x - f.a1 * y + f.z2;
  f.z2 = f.b2 * x - f.a2 * y;
  return y;
}

class FableCutMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._hopBlocks = Math.max(1, opts.hopBlocks || 8);
    this._nTracks = Math.max(1, opts.nTracks || 1);
    this._ids = opts.trackIds || [];
    this._block = 0;
    this._sumSq = new Float64Array(this._nTracks);
    this._peak = new Float64Array(this._nTracks);
    this._sumSqK = new Float64Array(this._nTracks);
    this._frames = 0;

    const shelf = shelfCoeffs(sampleRate);
    const hpf = hpfCoeffs(sampleRate);
    this._shelfL = [];
    this._hpfL = [];
    this._shelfR = [];
    this._hpfR = [];
    for (let t = 0; t < this._nTracks; t++) {
      this._shelfL.push(makeBiquad(shelf));
      this._hpfL.push(makeBiquad(hpf));
      this._shelfR.push(makeBiquad(shelf));
      this._hpfR.push(makeBiquad(hpf));
    }

    // Momentary = 400 ms of block mean-squares (BS.1770)
    const hopFrames = 128 * this._hopBlocks;
    this._lufsLen = Math.max(1, Math.round(0.4 * sampleRate / hopFrames));
    this._lufsRing = [];
    this._lufsIdx = [];
    this._lufsFilled = [];
    for (let t = 0; t < this._nTracks; t++) {
      this._lufsRing.push(new Float64Array(this._lufsLen));
      this._lufsIdx.push(0);
      this._lufsFilled.push(0);
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const outL = output && output[0];
    const outR = output && (output[1] || output[0]);
    if (outL) outL.fill(0);
    if (outR && outR !== outL) outR.fill(0);

    let frames = 0;
    for (let t = 0; t < this._nTracks; t++) {
      const chans = inputs[t];
      const has = chans && chans[0];
      const L = has ? chans[0] : null;
      const R = has ? (chans[1] || chans[0]) : null;
      const n = L ? L.length : (outL ? outL.length : 128);
      frames = n;

      let sum = this._sumSq[t];
      let peak = this._peak[t];
      let sumK = this._sumSqK[t];
      const sL = this._shelfL[t], hL = this._hpfL[t];
      const sR = this._shelfR[t], hR = this._hpfR[t];

      for (let i = 0; i < n; i++) {
        const l = L ? L[i] : 0;
        const r = R ? R[i] : 0;
        const mono = (l + r) * 0.5;
        sum += mono * mono;
        const aL = l >= 0 ? l : -l;
        const aR = r >= 0 ? r : -r;
        if (aL > peak) peak = aL;
        if (aR > peak) peak = aR;

        const fl = biquadStep(hL, biquadStep(sL, l));
        const fr = biquadStep(hR, biquadStep(sR, r));
        sumK += fl * fl + fr * fr;

        if (outL) outL[i] += l;
        if (outR && outR !== outL) outR[i] += r;
      }
      this._sumSq[t] = sum;
      this._peak[t] = peak;
      this._sumSqK[t] = sumK;
    }

    if (frames) this._frames += frames;
    this._block++;

    if (this._block >= this._hopBlocks) {
      const n = Math.max(1, this._frames);
      const rms = new Array(this._nTracks);
      const peak = new Array(this._nTracks);
      const lufs = new Array(this._nTracks);
      for (let t = 0; t < this._nTracks; t++) {
        rms[t] = Math.sqrt(this._sumSq[t] / n);
        peak[t] = this._peak[t];

        // Channel-weighted mean square for this hop (L+R, G=1 each)
        const blockMs = this._sumSqK[t] / n;
        const ring = this._lufsRing[t];
        const idx = this._lufsIdx[t];
        ring[idx] = blockMs;
        this._lufsIdx[t] = (idx + 1) % this._lufsLen;
        if (this._lufsFilled[t] < this._lufsLen) this._lufsFilled[t]++;
        let acc = 0;
        const filled = this._lufsFilled[t];
        for (let i = 0; i < filled; i++) acc += ring[i];
        const meanMs = acc / Math.max(1, filled);
        lufs[t] = meanMs > 1e-12 ? -0.691 + 10 * Math.log10(meanMs) : -70;

        this._sumSq[t] = 0;
        this._peak[t] = 0;
        this._sumSqK[t] = 0;
      }
      this.port.postMessage({
        type: "meter",
        trackIds: this._ids,
        rms,
        peak,
        lufs,
        frames: n,
      });
      this._block = 0;
      this._frames = 0;
    }
    return true;
  }
}

registerProcessor("fablecut-meter", FableCutMeterProcessor);
