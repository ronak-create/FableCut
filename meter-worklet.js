/* FableCut master-bus meter worklet.
   Computes per-channel RMS (and peak) on the audio thread and posts
   snapshots to the main thread. Passes audio through unchanged.

   Layout is reserved for future LUFS (K-weighting + gated loudness):
   keep the report payload stable and accumulate in process() only. */
class FableCutMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // How many render quanta to average before posting (~8 × 128 ≈ 23 ms @ 44.1k)
    this._hopBlocks = Math.max(1, opts.hopBlocks || 8);
    this._block = 0;
    this._sumSq = [0, 0];
    this._peak = [0, 0];
    this._frames = 0;
    // Future LUFS: mean-square of K-weighted signal, block energy ring, etc.
    // this._kWeight = …; this._lufsBlocks = [];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const chans = Math.max(output.length, input ? input.length : 0, 1);

    for (let ch = 0; ch < output.length; ch++) {
      const inp = input && input[Math.min(ch, input.length - 1)];
      const out = output[ch];
      if (!out) continue;
      if (inp) {
        out.set(inp);
        let sum = this._sumSq[ch] || 0;
        let peak = this._peak[ch] || 0;
        for (let i = 0; i < inp.length; i++) {
          const s = inp[i];
          sum += s * s;
          const a = s >= 0 ? s : -s;
          if (a > peak) peak = a;
        }
        this._sumSq[ch] = sum;
        this._peak[ch] = peak;
      } else {
        out.fill(0);
      }
    }
    if (input && input[0]) this._frames += input[0].length;
    this._block++;

    if (this._block >= this._hopBlocks) {
      const n = Math.max(1, this._frames);
      const rms = [];
      const peak = [];
      for (let ch = 0; ch < chans; ch++) {
        rms[ch] = Math.sqrt((this._sumSq[ch] || 0) / n);
        peak[ch] = this._peak[ch] || 0;
        this._sumSq[ch] = 0;
        this._peak[ch] = 0;
      }
      this.port.postMessage({
        type: "meter",
        rms,
        peak,
        // Placeholder for next step (momentary / short-term LUFS)
        lufs: null,
        frames: n,
      });
      this._block = 0;
      this._frames = 0;
    }
    return true;
  }
}

registerProcessor("fablecut-meter", FableCutMeterProcessor);
