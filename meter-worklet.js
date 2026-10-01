/* FableCut per-track meter worklet + stereo program sum pass-through.
   Inputs 0…nAudio−1 = A-track buses; input nAudio = video/other spill on master.
   Pass-through sum → stereo out. Per-track RMS/LUFS/Peak via port; master L/R
   RMS/Peak is metered on the main thread (AnalyserNodes on the worklet output),
   while master LUFS is computed here on the true summed program output. */
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
    this._nAudio = Math.max(0, opts.nAudioTracks ?? opts.nTracks ?? 1);
    // When set, that input is the finished program: only it reaches the
    // output (and the master LUFS); the others are metering taps. Unset =
    // every input is summed (the original layout).
    this._program = Number.isInteger(opts.programInput) ? opts.programInput : -1;
    this._block = 0;
    this._sumSqL = new Float64Array(this._nTracks);
    this._sumSqR = new Float64Array(this._nTracks);
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

    // Filters for the summed program output so the master LUFS is the true
    // post-mix reading, not an approximation from per-track values.
    this._shelfOutL = makeBiquad(shelf);
    this._hpfOutL = makeBiquad(hpf);
    this._shelfOutR = makeBiquad(shelf);
    this._hpfOutR = makeBiquad(hpf);
    this._sumSqKOut = 0;

    // Momentary = 400 ms of block mean-squares (BS.1770) — per A-track + program.
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
    this._lufsRingOut = new Float64Array(this._lufsLen);
    this._lufsIdxOut = 0;
    this._lufsFilledOut = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const outL = output && output[0];
    const outR = output && output[1];
    if (outL) outL.fill(0);
    if (outR) outR.fill(0);

    let frames = 0;
    for (let t = 0; t < this._nTracks; t++) {
      const chans = inputs[t];
      const has = chans && chans[0];
      const L = has ? chans[0] : null;
      // Never mirror L→R: post-pan buses are stereo; mono input = one channel only.
      const hasR = has && chans.length > 1 && chans[1];
      const R = hasR ? chans[1] : null;
      const n = L ? L.length : (outL ? outL.length : 128);
      frames = n;

      let sumL = this._sumSqL[t];
      let sumR = this._sumSqR[t];
      let peak = this._peak[t];
      let sumK = this._sumSqK[t];
      const sL = this._shelfL[t], hL = this._hpfL[t];
      const sR = this._shelfR[t], hR = this._hpfR[t];

      for (let i = 0; i < n; i++) {
        const l = L ? L[i] : 0;
        const r = R ? R[i] : 0;
        sumL += l * l;
        sumR += r * r;
        const aL = l >= 0 ? l : -l;
        const aR = r >= 0 ? r : -r;
        if (aL > peak) peak = aL;
        if (aR > peak) peak = aR;

        const fl = biquadStep(hL, biquadStep(sL, l));
        const fr = biquadStep(hR, biquadStep(sR, r));
        sumK += fl * fl + fr * fr;

        if (this._program < 0 || t === this._program) {
          if (outL) outL[i] += l;
          if (outR) outR[i] += r;
        }
      }
      this._sumSqL[t] = sumL;
      this._sumSqR[t] = sumR;
      this._peak[t] = peak;
      this._sumSqK[t] = sumK;
    }

    // Filter the summed program output for a true master LUFS reading.
    if (outL && outR && frames > 0) {
      const sL = this._shelfOutL, hL = this._hpfOutL;
      const sR = this._shelfOutR, hR = this._hpfOutR;
      let sumK = this._sumSqKOut;
      for (let i = 0; i < frames; i++) {
        const fl = biquadStep(hL, biquadStep(sL, outL[i]));
        const fr = biquadStep(hR, biquadStep(sR, outR[i]));
        sumK += fl * fl + fr * fr;
      }
      this._sumSqKOut = sumK;
    }

    if (frames) this._frames += frames;
    this._block++;

    if (this._block >= this._hopBlocks) {
      const n = Math.max(1, this._frames);
      const rms = new Array(this._nAudio);
      const peak = new Array(this._nAudio);
      const lufs = new Array(this._nAudio);
      for (let t = 0; t < this._nAudio; t++) {
        // Track bar follows the louder channel so a mono stem panned hard L/R
        // (or any stereo track) stays in sync with the per-channel master meters.
        const rmsL = Math.sqrt(this._sumSqL[t] / n);
        const rmsR = Math.sqrt(this._sumSqR[t] / n);
        rms[t] = Math.max(rmsL, rmsR);
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

        this._sumSqL[t] = 0;
        this._sumSqR[t] = 0;
        this._peak[t] = 0;
        this._sumSqK[t] = 0;
      }

      // Program LUFS from the actual summed output (includes video spill).
      let masterLufs = -70;
      if (outL && outR) {
        const blockMs = this._sumSqKOut / n;
        const ring = this._lufsRingOut;
        const idx = this._lufsIdxOut;
        ring[idx] = blockMs;
        this._lufsIdxOut = (idx + 1) % this._lufsLen;
        if (this._lufsFilledOut < this._lufsLen) this._lufsFilledOut++;
        let acc = 0;
        for (let i = 0; i < this._lufsFilledOut; i++) acc += ring[i];
        const meanMs = acc / Math.max(1, this._lufsFilledOut);
        masterLufs = meanMs > 1e-12 ? -0.691 + 10 * Math.log10(meanMs) : -70;
        this._sumSqKOut = 0;
      }

      this.port.postMessage({
        type: "meter",
        rms,
        peak,
        lufs,
        masterLufs,
        frames: n,
      });
      this._block = 0;
      this._frames = 0;
    }
    return true;
  }
}

registerProcessor("fablecut-meter", FableCutMeterProcessor);
