/* FableCut transcribe — words with times, from speech, onto the timeline.
   Zero dependencies; loaded by the editor as a plain script (global
   `FableCutTranscribe`) and required by the server and the MCP server, so
   the Transcript tab and `fablecut_transcribe` read, find and cut the same
   words with the same `extract` ops.

   Speech is turned into words in the browser (transcribe-worker.js runs
   Whisper with transformers.js, fetched from a CDN the first time and cached).
   Here: plan (where to split long audio, at its quietest moments) → joinChunks
   (Whisper's word pieces → [text, start, end] in file seconds) → a transcript
   document per file → clipWords / layout (onto the timeline through each
   clip's in point and speed) → find (a phrase, matched on word boundaries,
   case and punctuation ignored) → cutSpans (the time to cut: the words and
   the pause after them, on whole frames) → cutOps (one extract per span, last
   first, so earlier times stay put). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutTranscribe = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Whisper models with word timestamps (cross-attention alignment), 8-bit, from Hugging Face. */
  const MODELS = {
    base: { id: "onnx-community/whisper-base_timestamped", label: "Base", mb: 77 },
    small: { id: "onnx-community/whisper-small_timestamped", label: "Small", mb: 250 },
  };
  const DEFAULT_MODEL = "base";
  /** transformers.js, pinned. Fetched by the worker only when something is transcribed. */
  const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
  /** Whisper listens at 16 kHz, mono. */
  const RATE = 16000;
  /** Languages offered by name (Whisper knows more; any of its codes works). */
  const LANGUAGES = {
    en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch",
    sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish", pl: "Polish", cs: "Czech", sk: "Slovak",
    ro: "Romanian", hu: "Hungarian", el: "Greek", bg: "Bulgarian", hr: "Croatian", sr: "Serbian",
    uk: "Ukrainian", ru: "Russian", tr: "Turkish", ar: "Arabic", he: "Hebrew", fa: "Persian", ur: "Urdu",
    hi: "Hindi", bn: "Bengali", pa: "Punjabi", gu: "Gujarati", mr: "Marathi", ta: "Tamil", te: "Telugu",
    kn: "Kannada", ml: "Malayalam", zh: "Chinese", ja: "Japanese", ko: "Korean", vi: "Vietnamese",
    th: "Thai", id: "Indonesian", ms: "Malay", tl: "Tagalog", sw: "Swahili",
  };
  /** Every language code Whisper takes. */
  const WHISPER_LANGS = new Set(("en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue").split(" "));
  const MAX_WORDS = 200000;
  const MAX_WORD = 80;
  /** edit-ops.js MIN_DUR: extract refuses a range this short or shorter. */
  const MIN_CUT = 0.05;

  const r3 = (x) => Math.round(x * 1000) / 1000 || 0;
  const r4 = (x) => Math.round(x * 10000) / 10000 || 0;   // as the editor stores times; never -0
  const num = (x) => typeof x === "number" && Number.isFinite(x);

  /** The model key, defaulted and checked. */
  function model(m) {
    const k = m == null || m === "" ? DEFAULT_MODEL : String(m);
    if (!MODELS[k]) throw new Error(`model must be ${Object.keys(MODELS).join(" or ")}`);
    return k;
  }
  /** A language code for Whisper, or null to let it detect the language. */
  function language(l) {
    if (l == null || l === "" || l === "auto") return null;
    const k = String(l).trim().toLowerCase();
    if (WHISPER_LANGS.has(k)) return k;
    const byName = Object.keys(LANGUAGES).find((c) => LANGUAGES[c].toLowerCase() === k);
    if (byName) return byName;
    throw new Error(`language must be a Whisper language code such as en, es, hi or ja (or auto), not ${JSON.stringify(l)}`);
  }

  /** Where to split `pcm` (mono samples at `rate`) into pieces Whisper takes in one go (≤ 30 s):
   *  each piece ends at the quietest 50 ms between `min` and `max` seconds in, so no word is cut
   *  in half. Returns [[startSample, endSample], …] covering the whole of it. */
  function plan(pcm, rate = RATE, { min = 12, max = 28 } = {}) {
    const n = pcm.length, hop = Math.max(1, Math.round(rate * 0.05));
    const out = [];
    let a = 0;
    while (n - a > max * rate) {
      const lo = a + Math.round(min * rate), hi = a + Math.round(max * rate) - hop;
      let best = hi, bestE = Infinity;
      for (let f = lo; f <= hi; f += hop) {
        let e = 0;
        for (let i = f; i < f + hop; i++) e += pcm[i] * pcm[i];
        if (e <= bestE) { bestE = e; best = f; }   // ties go later: longer pieces, fewer calls
      }
      const b = best + (hop >> 1);
      out.push([a, b]);
      a = b;
    }
    if (n > a || !out.length) out.push([a, n]);
    return out;
  }
  /** True when a piece is too quiet to hold speech (Whisper invents words in silence). */
  function quiet(pcm, a = 0, b = pcm.length, floorDb = -55) {
    if (b <= a) return true;
    let e = 0;
    for (let i = a; i < b; i++) e += pcm[i] * pcm[i];
    const rms = Math.sqrt(e / (b - a));
    return !(rms > 0) || 20 * Math.log10(rms) < floorDb;
  }

  const SCRIPT_NO_SPACES = /[぀-ヿ㐀-鿿豈-﫿฀-๿຀-໿က-႟ក-៿]/;
  /** Whisper's word pieces ({text, timestamp:[s, e]}) → words [text, start, end] in file seconds
   *  (`offset` added). A piece without a leading space continues the word before it
   *  ("studio" ".fablecut" → "studio.fablecut"), except in scripts written without spaces. */
  function joinChunks(chunks, offset = 0, end = Infinity) {
    const out = [];
    for (const ch of chunks || []) {
      const raw = String(ch && ch.text != null ? ch.text : "");
      const t = raw.trim().replace(/\s+/g, " ");
      if (!t) continue;
      const ts = (ch && ch.timestamp) || [];
      const last = out[out.length - 1];
      let s = num(ts[0]) ? ts[0] + offset : last ? last[2] : offset;
      if (last && s < last[1]) s = last[1];
      let e = num(ts[1]) ? ts[1] + offset : s + 0.3;
      e = Math.min(Math.max(e, s), end);
      s = Math.min(s, e);
      if (last && !/^\s/.test(raw) && !SCRIPT_NO_SPACES.test(t)) {
        last[0] = (last[0] + t).slice(0, MAX_WORD);
        last[2] = r3(Math.max(last[2], e));
        continue;
      }
      out.push([t.slice(0, MAX_WORD), r3(s), r3(e)]);
    }
    return out;
  }

  /** A transcript document, checked: {v, src, model, language, duration, created, words:[[text, s, e], …]}.
   *  Throws on anything malformed. Words are kept in time order, inside 0…duration. */
  function validate(doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("a transcript must be an object");
    if (!Array.isArray(doc.words)) throw new Error("a transcript needs words: [[text, start, end], …]");
    if (doc.words.length > MAX_WORDS) throw new Error(`a transcript holds at most ${MAX_WORDS} words`);
    const duration = num(doc.duration) && doc.duration > 0 ? doc.duration : null;
    const words = [];
    let prev = 0;
    for (const w of doc.words) {
      if (!Array.isArray(w) || typeof w[0] !== "string" || !num(w[1]) || !num(w[2])) throw new Error("each word must be [text, start, end]");
      const t = w[0].trim().slice(0, MAX_WORD);
      if (!t) continue;
      let s = Math.max(0, w[1], prev), e = Math.max(s, w[2]);
      if (duration != null) { s = Math.min(s, duration); e = Math.min(e, duration); }
      words.push([t, r3(s), r3(e)]);
      prev = s;
    }
    const lang = doc.language == null ? null : String(doc.language).slice(0, 16);
    return {
      v: 1, src: typeof doc.src === "string" ? doc.src.slice(0, 1024) : null,
      model: typeof doc.model === "string" ? doc.model.slice(0, 64) : null,
      language: lang, duration: duration != null ? r3(duration) : null,
      created: typeof doc.created === "string" ? doc.created.slice(0, 40) : new Date().toISOString(),
      words,
    };
  }

  /** A clip whose speed follows keyframes: its words can't be placed on the timeline from one speed. */
  const ramped = (c) => !!(c && c.keyframes && Array.isArray(c.keyframes.speed) && c.keyframes.speed.length);
  const clipSpeed = (c) => { const v = +(c && c.props && c.props.speed); return v > 0 ? v : 1; };

  /** The words a clip plays, on the timeline: [{w, s, e, clip, r:[clipStart, clipEnd]}]. A word
   *  counts when its middle is inside the clip's window of the file. Empty for a speed ramp. */
  function clipWords(clip, words) {
    if (!clip || ramped(clip) || !Array.isArray(words)) return [];
    const speed = clipSpeed(clip), a = +clip.in || 0, b = a + (+clip.duration || 0) * speed;
    const start = +clip.start || 0, r = [r4(start), r4(start + (+clip.duration || 0))];
    let lo = 0, hi = words.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (words[m][2] < a) lo = m + 1; else hi = m; }
    const out = [];
    for (let i = lo; i < words.length; i++) {
      const [w, s, e] = words[i];
      const mid = (s + e) / 2;
      if (mid > b) break;
      if (mid < a) continue;
      out.push({ w, s: r4(start + (Math.max(s, a) - a) / speed), e: r4(start + (Math.min(e, b) - a) / speed), clip: clip.id, r });
    }
    return out;
  }
  /** Every clip's words on one timeline, in time order: entries [{clip, words}] → words as clipWords. */
  function layout(entries) {
    const all = [];
    for (const { clip, words } of entries || []) all.push(...clipWords(clip, words));
    return all.sort((x, y) => x.s - y.s || x.e - y.e);
  }

  /** A word reduced for matching: lower case, letters and digits only. */
  const norm = (t) => String(t).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");

  /** Where `query` is said: [{i, j}] (first and last word index), left to right, never overlapping.
   *  Case, accents, punctuation and spacing are ignored ("A.I. powered" finds "AI-powered"), and a
   *  match starts and ends on word boundaries ("cat" doesn't find "category"). */
  function find(words, query, { limit = 1000 } = {}) {
    const q = norm(query);
    if (!q) return [];
    let text = "";
    const startAt = new Map(), endAt = new Map();   // char offset → word index
    for (let i = 0; i < words.length; i++) {
      const n = norm(words[i].w != null ? words[i].w : words[i][0]);
      if (!n) continue;
      startAt.set(text.length, i);
      text += n;
      endAt.set(text.length, i);
    }
    const out = [];
    let from = 0;
    while (out.length < limit) {
      const k = text.indexOf(q, from);
      if (k < 0) break;
      if (startAt.has(k) && endAt.has(k + q.length)) {
        out.push({ i: startAt.get(k), j: endAt.get(k + q.length) });
        from = k + q.length;
      } else from = k + 1;
    }
    return out;
  }

  /** Union of {from, to} spans, sorted. */
  function union(list) {
    const out = [];
    for (const s of list.filter((x) => x.to > x.from).sort((x, y) => x.from - y.from)) {
      const last = out[out.length - 1];
      if (last && s.from <= last.to + 1e-6) last.to = Math.max(last.to, s.to);
      else out.push({ from: s.from, to: s.to });
    }
    return out;
  }

  /** The timeline time to cut for word runs [{i, j}] of timeline words (layout): from just before
   *  the first word to just before the word that follows (so the pause after goes too, and the
   *  pause before stays), never into a neighbouring word, inside the clip, on whole frames.
   *  Returns [{from, to}] in time order, merged where they touch. */
  function cutSpans(words, runs, { fps = 30, lead = 0.04, tail = 0.12 } = {}) {
    const frame = 1 / Math.max(1, +fps || 30);
    const same = (x, y) => x && y && x.r[0] === y.r[0] && x.r[1] === y.r[1];
    const spans = [];
    for (const { i, j } of runs) {
      const a = words[i], b = words[j];
      if (!a || !b || j < i) continue;
      const prev = same(words[i - 1], a) ? words[i - 1] : null, next = same(words[j + 1], b) ? words[j + 1] : null;
      const floor = prev ? prev.e : a.r[0], ceil = next ? next.s : b.r[1];
      const from = Math.max(floor, a.s - lead);
      const to = next ? Math.max(b.e, Math.min(ceil, next.s - lead)) : Math.min(ceil, b.e + tail);
      let f = Math.ceil((from - 1e-6) / frame) * frame, t = Math.floor((to + 1e-6) / frame) * frame;
      if (f > a.s + 1e-6) f = Math.max(floor, Math.floor((a.s + 1e-6) / frame) * frame);   // don't leave the word's first frame
      if (f < floor - 1e-6) f = Math.ceil((floor - 1e-6) / frame) * frame;
      if (t < b.e - 1e-6 && Math.ceil((b.e - 1e-6) / frame) * frame <= ceil + 1e-6) t = Math.ceil((b.e - 1e-6) / frame) * frame;
      const span = { from: r4(f), to: r4(t) };
      if (span.to - span.from > Math.max(frame - 1e-4, MIN_CUT)) spans.push(span);
    }
    return union(spans).map((s) => ({ from: r4(s.from), to: r4(s.to) }));
  }

  /** Patch ops that cut the spans out, last first. `tracks` limits the lanes
   *  (default: the targeted tracks), `force` cuts through locked material. */
  function cutOps(spans, { tracks = null, force = false } = {}) {
    return spans.slice().sort((x, y) => y.from - x.from).map((s) => ({
      op: "extract", from: s.from, to: s.to,
      ...(Array.isArray(tracks) && tracks.length ? { tracks: tracks.slice() } : {}),
      ...(force ? { force: true } : {}),
    }));
  }

  /** Words i…j as text. */
  function text(words, i = 0, j = words.length - 1) {
    const out = [];
    for (let k = Math.max(0, i); k <= Math.min(j, words.length - 1); k++) out.push(words[k].w != null ? words[k].w : words[k][0]);
    return out.join(" ");
  }
  /** A word that ends a sentence ("done." "why?"), but not an abbreviation like "A.I." or "U.S.". */
  const sentenceEnd = (t) => /[.!?…。！？]["')\]]?$/.test(t) && !/^(\p{L}\.)+$/u.test(t);
  /** Readable lines: a break after a sentence (once a line is `min` s long), at a pause of `gap` s,
   *  or at `max` s — not at a cut, so an edited passage still reads as one. [{i, j, from, to, text}] */
  function segments(words, { gap = 0.8, min = 2.5, max = 10 } = {}) {
    const out = [];
    let i0 = 0;
    for (let k = 0; k < words.length; k++) {
      const w = words[k], nx = words[k + 1];
      const s = w.s != null ? w.s : w[1], e = w.e != null ? w.e : w[2];
      const s0 = words[i0].s != null ? words[i0].s : words[i0][1];
      const t = w.w != null ? w.w : w[0];
      const ns = nx ? (nx.s != null ? nx.s : nx[1]) : null;
      const brk = !nx || ns - e >= gap || e - s0 >= max || (sentenceEnd(t) && e - s0 >= min);
      if (brk) { out.push({ i: i0, j: k, from: s0, to: e, text: text(words, i0, k) }); i0 = k + 1; }
    }
    return out;
  }
  /** Seconds the spans add up to. */
  const total = (spans) => r4(spans.reduce((n, s) => n + (s.to - s.from), 0));

  return {
    MODELS, DEFAULT_MODEL, LIBRARY, RATE, LANGUAGES, MIN_CUT,
    model, language, plan, quiet, joinChunks, validate, ramped, clipWords, layout, norm, find, union,
    cutSpans, cutOps, text, segments, total,
  };
});
