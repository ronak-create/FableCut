/* FableCut speech-to-text worker (a module worker started by the editor).

   Runs Whisper with transformers.js, imported from the CDN URL the editor
   passes (transcribe.js LIBRARY) only when something is transcribed; the
   library and the model files are cached by the browser after the first time.
   One piece of audio at a time (≤ 30 s, 16 kHz mono, planned by
   transcribe.js), so the editor can report progress and stop between pieces.

   in:  {type:"run", id, lib, model, pcm: Float32Array, language: "en" | null}
   out: {type:"progress", status, file, loaded, total}   — while the model downloads
        {type:"done", id, chunks:[{text, timestamp:[s, e]}]} · {type:"error", id, error} */
let asr = null, asrModel = "";

async function load(lib, model) {
  if (asr && asrModel === model) return asr;
  const T = await import(lib);
  T.env.allowLocalModels = false;
  asr = await T.pipeline("automatic-speech-recognition", model, {
    dtype: "q8", device: "wasm",
    progress_callback: (p) => {
      if (!p || (p.status !== "progress" && p.status !== "initiate" && p.status !== "done")) return;
      self.postMessage({ type: "progress", status: p.status, file: p.file || "", loaded: p.loaded || 0, total: p.total || 0 });
    },
  });
  asrModel = model;
  return asr;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type !== "run") return;
  try {
    const run = await load(m.lib, m.model);
    const out = await run(m.pcm, { return_timestamps: "word", ...(m.language ? { language: m.language, task: "transcribe" } : {}) });
    self.postMessage({ type: "done", id: m.id, chunks: (out && out.chunks) || [] });
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, error: String((err && err.message) || err) });
  }
};
