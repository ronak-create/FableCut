/* FableCut captions — a transcript's words become caption clips, and caption
   clips become subtitle files. Zero dependencies; loaded by the editor as a
   plain script (global `FableCutCaptions`) and required by the MCP server, so
   the Transcript tab's Add captions and `fablecut_captions` make the same clips.

   cues(words) groups timeline words (transcribe.js layout) into captions: a
   line as long as fits the canvas at the style's size, one or two lines, a new
   caption at a pause, after a sentence, or when it would run too long. clip()
   turns a cue into a text clip: the style's look, the text, `wordTimes` (each
   word's start and end, seconds from the clip's start, which word-pop, karaoke
   and highlight follow) and `caption: true` so captions can be found, replaced
   and exported. toSRT / toVTT / parse read and write subtitle files. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutCaptions = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** The looks. Sizes and placement follow the canvas: `size` is a fraction of its shorter
   *  side, `y` of its height below the centre. `words` caps a caption (pop, highlight). */
  const STYLES = {
    subtitle: {
      label: "Subtitle", lines: 2, size: 0.042, y: 0.38, maxDur: 6, glyph: 0.52,
      props: { font: "Roboto", weight: 500, color: "#ffffff", bgColor: "#000000", bgOpacity: 0.6, textShadow: 0, textAnim: "none" },
    },
    karaoke: {
      label: "Karaoke", lines: 2, size: 0.05, y: 0.34, maxDur: 5, glyph: 0.62,
      props: { font: "Montserrat", weight: 800, color: "#ffffff", strokeWidth: 6, strokeColor: "#000000", textShadow: 10, textAnim: "karaoke" },
    },
    highlight: {
      label: "Highlight", lines: 2, size: 0.065, y: 0.22, maxDur: 3, words: 5, glyph: 0.78,
      props: { font: "Archivo Black", color: "#ffffff", highlightColor: "#ffd166", uppercase: true, strokeWidth: 10, strokeColor: "#000000", textShadow: 12, textAnim: "highlight" },
    },
    pop: {
      label: "Word pop", lines: 1, size: 0.085, y: 0.18, maxDur: 2, words: 3, glyph: 0.55,
      props: { font: "Anton", color: "#ffffff", uppercase: true, strokeWidth: 10, strokeColor: "#000000", textShadow: 14, textAnim: "word-pop" },
    },
  };
  const DEFAULT_STYLE = "subtitle";
  /** An average glyph's width as a fraction of the font size, when a style doesn't give its own. */
  const GLYPH = 0.56;

  const r4 = (x) => Math.round(x * 10000) / 10000 || 0;
  const num = (x) => typeof x === "number" && Number.isFinite(x);

  function style(s) {
    const k = s == null || s === "" ? DEFAULT_STYLE : String(s);
    if (!STYLES[k]) throw new Error(`style must be ${Object.keys(STYLES).join(", ")}`);
    return k;
  }
  /** The style's font size and line length on a canvas. */
  function metrics(st, width, height, opts = {}) {
    const S = STYLES[style(st)];
    const fontSize = Math.round(Math.min(width, height) * S.size * (+opts.scale > 0 ? +opts.scale : 1));
    const chars = Math.max(8, Math.floor((width * 0.84) / (fontSize * (S.glyph || GLYPH))));
    return { fontSize, chars, lines: opts.lines > 0 ? Math.min(3, Math.round(opts.lines)) : S.lines, words: opts.words > 0 ? Math.round(opts.words) : S.words || Infinity, maxDur: S.maxDur };
  }

  const sentenceEnd = (t) => /[.!?…。！？]["')\]]?$/.test(t) && !/^(\p{L}\.)+$/u.test(t);
  const softEnd = (t) => /[,;:—–]["')\]]?$/.test(t);
  const wordOf = (w) => (w.w != null ? w.w : w[0]);
  const startOf = (w) => (w.s != null ? w.s : w[1]);
  const endOf = (w) => (w.e != null ? w.e : w[2]);

  /** Break words into at most `lines` lines of about `chars` characters, as even as it can. */
  function wrap(words, chars, lines) {
    const text = words.join(" ");
    if (lines <= 1 || text.length <= chars) return [words.slice()];
    // the split that keeps the longest line shortest
    let best = null;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(" ").length, b = words.slice(k).join(" ").length;
      const worst = Math.max(a, b);
      if (!best || worst < best.worst || (worst === best.worst && a >= b)) best = { k, worst };
    }
    return [words.slice(0, best.k), words.slice(best.k)];
  }

  /** Timeline words [{w, s, e, clip?}] → cues [{start, end, text, words:[{w, s, e}]}], in time order.
   *  opts: {chars, lines, words (max per cue), maxDur, gap (a pause that starts a new cue),
   *  minDur, linger (seconds a cue stays after its last word), fps}. */
  function cues(words, opts = {}) {
    const chars = opts.chars || 42, lines = opts.lines || 2, maxWords = opts.words || Infinity;
    const maxDur = opts.maxDur || 6, gap = opts.gap != null ? opts.gap : 0.6, minDur = opts.minDur != null ? opts.minDur : 0.7;
    const linger = opts.linger != null ? opts.linger : 0.25, frame = 1 / Math.max(1, +opts.fps || 30);
    const room = chars * lines;
    const groups = [];
    let cur = [];
    const flush = () => { if (cur.length) groups.push(cur); cur = []; };
    for (let k = 0; k < words.length; k++) {
      const w = words[k], t = String(wordOf(w)).trim();
      if (!t) continue;
      const word = { w: t, s: startOf(w), e: endOf(w) };
      if (cur.length) {
        const prev = cur[cur.length - 1], len = cur.map((x) => x.w).join(" ").length + 1 + t.length;
        if (word.s - prev.e >= gap || len > room || cur.length >= maxWords || word.e - cur[0].s > maxDur ||
          (sentenceEnd(prev.w) && cur.length >= 2) || (softEnd(prev.w) && (cur.length >= 3 || len > room * 0.5))) flush();
      }
      cur.push(word);
    }
    flush();
    const out = groups.map((g) => {
      const ls = wrap(g.map((x) => x.w), chars, lines);
      return { start: g[0].s, end: g[g.length - 1].e, text: ls.map((l) => l.join(" ")).join("\n"), words: g };
    });
    // on frames; linger after the last word and stretch short ones, never into the next cue
    for (let k = 0; k < out.length; k++) {
      const c = out[k], next = out[k + 1];
      const limit = next ? next.start : Infinity;
      let end = Math.max(c.end + linger, c.start + minDur);
      end = Math.min(end, limit);
      c.start = r4(Math.round(c.start / frame) * frame);
      c.end = r4(Math.max(c.start + frame, Math.round(end / frame) * frame));
      if (next && c.end > Math.round(next.start / frame) * frame) c.end = r4(Math.round(next.start / frame) * frame);
    }
    return out.filter((c) => c.end > c.start);
  }

  /** Re-break cues' text (an imported file's own line breaks) to `chars` a line: `lines` lines when it
   *  fits, else as many as it needs. */
  function fit(list, chars, lines) {
    return list.map((c) => {
      const ws = String(c.text).split(/\s+/).filter(Boolean), len = ws.join(" ").length;
      let out;
      if (len <= chars || lines <= 1 && len <= chars) out = [ws];
      else if (len <= chars * 2) out = wrap(ws, chars, 2);
      else {
        out = [[]];
        for (const w of ws) {
          const line = out[out.length - 1];
          if (line.length && (line.join(" ") + " " + w).length > chars) out.push([w]); else line.push(w);
        }
      }
      return { ...c, text: out.map((l) => l.join(" ")).join("\n") };
    });
  }

  /** Each word's [start, end], seconds from the cue's start: from the words when they are
   *  there (a transcript), else spread over the cue by length (a subtitle file). */
  function wordTimes(cue) {
    const dur = cue.end - cue.start;
    const ws = String(cue.text).split(/\s+/).filter(Boolean);
    if (cue.words && cue.words.length === ws.length)
      return cue.words.map((w) => [r4(Math.max(0, w.s - cue.start)), r4(Math.min(dur, Math.max(0, w.e - cue.start)))]);
    const weight = ws.map((w) => w.length + 2), total = weight.reduce((a, b) => a + b, 0) || 1;
    let t = 0;
    return ws.map((w, i) => { const a = t; t += dur * weight[i] / total; return [r4(a), r4(t)]; });
  }

  /** A caption clip (for addClip) for a cue: the style on this canvas, `y` placed by the style. */
  function clip(cue, { style: st, width, height, track, id, scale } = {}) {
    const k = style(st), S = STYLES[k], m = metrics(k, width || 1920, height || 1080, { scale });
    const props = Object.assign({}, S.props, {
      text: cue.text, fontSize: m.fontSize, y: Math.round((height || 1080) * S.y),
      wordTimes: wordTimes(cue), caption: true, captionStyle: k,
    });
    return { ...(id ? { id } : {}), kind: "text", mediaId: null, track: track || "V2", start: r4(cue.start), duration: r4(cue.end - cue.start), name: "Caption", props };
  }

  /** Cues of the caption clips in a clip list (props.caption), in time order. */
  function fromClips(clips) {
    return (clips || []).filter((c) => c && c.kind === "text" && c.props && c.props.caption === true && c.disabled !== true)
      .map((c) => ({ start: +c.start || 0, end: (+c.start || 0) + (+c.duration || 0), text: String(c.props.text || "") }))
      .filter((c) => c.text.trim() && c.end > c.start).sort((a, b) => a.start - b.start);
  }

  function stamp(t, sep) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, f = ms % 1000;
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
  }
  /** SubRip text. */
  function toSRT(list) {
    return list.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n");
  }
  /** WebVTT text. */
  function toVTT(list) {
    return "WEBVTT\n\n" + list.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n");
  }
  /** "01:02:03,456", "02:03.456" or "3.5" → seconds, or null. */
  function readStamp(s) {
    const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$/.exec(s);
    if (m) return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, "0")) / 1000;
    return null;
  }
  /** An SRT or WebVTT file → cues [{start, end, text}] (formatting tags dropped). Throws when nothing reads. */
  function parse(text) {
    const src = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const out = [];
    for (const block of src.split(/\n{2,}/)) {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      const at = lines.findIndex((l) => l.includes("-->"));
      if (at < 0) continue;
      const [a, b] = lines[at].split("-->");
      const start = readStamp(a), end = readStamp(String(b).trim().split(/\s+/)[0]);
      if (start == null || end == null || !(end > start)) continue;
      const body = lines.slice(at + 1).map((l) => l.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "").trim()).filter(Boolean).join("\n");
      if (body) out.push({ start: r4(start), end: r4(end), text: body.slice(0, 500) });
    }
    if (!out.length) throw new Error("no subtitles found — expected an SRT or WebVTT file (00:00:01,000 --> 00:00:03,000 lines)");
    return out.sort((x, y) => x.start - y.start);
  }

  const isCaption = (c) => !!(c && c.kind === "text" && c.props && c.props.caption === true);
  const DEFAULT_TRACKS = ["V3", "V2", "V1", "A1", "A2", "A3", "A4"].map((id) => ({ id, kind: id[0] === "V" ? "video" : "audio" }));
  /** The lane captions from `from` to `to` go on: where captions already are; else the top video
   *  lane when it is free then; else a new one above it ({track, add:true}). */
  function trackFor(doc, from, to) {
    const clips = Array.isArray(doc.clips) ? doc.clips : [];
    const caps = clips.filter(isCaption);
    if (caps.length) return { track: caps[0].track, add: false };
    const lanes = (Array.isArray(doc.tracks) && doc.tracks.length ? doc.tracks : DEFAULT_TRACKS).filter((t) => t && t.kind === "video").map((t) => t.id);
    for (const c of clips) if (/^V\d+$/.test(c.track) && !lanes.includes(c.track)) lanes.push(c.track);
    lanes.sort((a, b) => +b.slice(1) - +a.slice(1));
    const top = lanes[0] || "V1";
    const busy = clips.some((c) => c.track === top && c.start < to && c.start + c.duration > from);
    const n = +top.slice(1) + 1;
    if (!busy || n > 16) return { track: top, add: false };
    return { track: "V" + n, add: true };
  }

  return { STYLES, DEFAULT_STYLE, DEFAULT_TRACKS, style, metrics, wrap, fit, cues, wordTimes, clip, fromClips, toSRT, toVTT, parse, readStamp, isCaption, trackFor };
});
