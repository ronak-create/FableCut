/* FableCut media management — the Project bin's metadata, search, filters,
   sorting, tags, collections and usage. Zero dependencies. Loaded by the
   editor as a plain script (global `FableCutMedia`) and required by the
   server, the MCP server and the tests.

   A media entry may carry, beside id/name/kind/src/duration/width/height:
     size          bytes on disk
     fps           video frame rate (29.97, 30, 59.94 …)
     codec         video codec (h264, hevc, vp9, prores …) — or the image format
     audioCodec    aac, mp3, pcm_s16le, opus …
     audioChannels channel count of the first audio stream, 0 = no audio
     sampleRate    Hz
     bitrate       bits per second (whole file)
     favorite      true = starred in the bin
     tags          ["interview", "b-roll"]
   Metadata comes from ffprobe (parseProbe) — the server reads it, nobody
   types it. Collections are project-level: project.collections =
   [{id, name, media:[mediaId…]}], a media entry can be in any number of them. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api;
  else root.FableCutMedia = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KINDS = ["video", "audio", "image", "svg"];
  /** Fields the server probes. Written back to the entry; never user-set. */
  const INFO_KEYS = ["size", "fps", "codec", "audioCodec", "audioChannels", "sampleRate", "bitrate"];
  const MAX_TAGS = 24, MAX_TAG_LEN = 32;
  const SORT_KEYS = ["name", "kind", "duration", "resolution", "fps", "codec", "audio", "size", "usage"];

  const ratio = (s) => {
    const [a, b] = String(s || "").split("/").map(Number);
    return b > 0 && a > 0 ? a / b : (a > 0 && !b && !String(s).includes("/") ? a : 0);
  };
  const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

  /** ffprobe -show_format -show_streams -of json output → the INFO_KEYS (+ duration,
   *  width, height). `size` falls back to the stat size the caller passes. */
  function parseProbe(json, statSize) {
    const out = {};
    const streams = Array.isArray(json && json.streams) ? json.streams : [];
    const fmt = (json && json.format) || {};
    const v = streams.find((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));
    const a = streams.find((s) => s.codec_type === "audio");
    const size = Number(fmt.size) || Number(statSize) || 0;
    if (size > 0) out.size = size;
    const dur = Number(fmt.duration);
    if (dur > 0) out.duration = round(dur, 3);
    const br = Number(fmt.bit_rate);
    if (br > 0) out.bitrate = Math.round(br);
    // stills (png/jpg/webp, gif) report 25/1 — not a frame rate anyone shot at
    const still = !!v && /^(png|mjpeg|jpeg|webp|bmp|tiff|gif)$/.test(String(v.codec_name || "")) && !(dur > 0 && Number(v.nb_frames) > 1);
    if (v) {
      if (v.codec_name) out.codec = String(v.codec_name);
      let w = Number(v.width) || 0, h = Number(v.height) || 0;
      const rot = Number(((v.side_data_list || []).find((d) => d.rotation != null) || {}).rotation ?? (v.tags && v.tags.rotate)) || 0;
      if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
      if (w > 0 && h > 0) { out.width = w; out.height = h; }
      const fps = ratio(v.avg_frame_rate) || ratio(v.r_frame_rate);
      if (!still && fps > 0 && fps < 1000) out.fps = round(fps, 3);
    }
    if (a) {
      if (a.codec_name) out.audioCodec = String(a.codec_name);
      const ch = Number(a.channels);
      if (ch > 0) out.audioChannels = ch;
      const sr = Number(a.sample_rate);
      if (sr > 0) out.sampleRate = sr;
    } else if (v && !still) out.audioChannels = 0;   // a video without sound says so; a picture has no audio to speak of
    return out;
  }

  /* ── formatting ── */
  function fmtSize(b) {
    if (!(b > 0)) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, n = b;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return (i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)) + " " + u[i];
  }
  function fmtFps(f) {
    if (!(f > 0)) return "";
    return String(round(f, 2));
  }
  function fmtRes(m) { return m && m.width > 0 && m.height > 0 ? `${m.width}×${m.height}` : ""; }
  function fmtAudio(m) {
    if (!m || m.audioChannels == null) return "";
    if (m.audioChannels === 0) return "no audio";
    const ch = m.audioChannels === 1 ? "mono" : m.audioChannels === 2 ? "stereo" : m.audioChannels === 6 ? "5.1" : m.audioChannels === 8 ? "7.1" : m.audioChannels + " ch";
    return ch + (m.sampleRate ? ` ${round(m.sampleRate / 1000, 1)} kHz` : "");
  }
  function fmtDur(t) {
    if (!(t > 0)) return "";
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const ss = s.toFixed(2).padStart(5, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }
  /** One-line summary: "1920×1080 · 29.97 fps · h264 · stereo 48 kHz · 45 MB". */
  function describe(m) {
    return [fmtRes(m), m.fps ? fmtFps(m.fps) + " fps" : "", m.codec || "", fmtAudio(m), fmtSize(m.size)]
      .filter(Boolean).join(" · ");
  }

  /* ── tags and collections ── */
  function normalizeTags(v) {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
    const out = [], seen = new Set();
    for (const t of list) {
      const s = String(t == null ? "" : t).replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LEN);
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      out.push(s);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }
  /** Every tag used in the project, sorted, each once (first spelling wins). */
  function allTags(media) {
    const seen = new Map();
    for (const m of media || []) for (const t of m.tags || []) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }
  function normalizeCollections(list, media) {
    if (!Array.isArray(list)) return [];
    const ids = media ? new Set(media.map((m) => m.id)) : null;
    const out = [], seen = new Set();
    for (const c of list) {
      if (!c || !c.id || seen.has(String(c.id))) continue;
      seen.add(String(c.id));
      const mem = [...new Set((Array.isArray(c.media) ? c.media : []).map(String))].filter((id) => !ids || ids.has(id));
      out.push({ id: String(c.id), name: String(c.name || "Collection").trim().slice(0, 80) || "Collection", media: mem });
    }
    return out;
  }

  /* ── usage ── */
  /** Where a media entry is placed: one entry per placement (a video and its
   *  linked audio stems count once), on the main timeline (comp: null) and
   *  inside every composition. Sorted main timeline first, then by time. */
  function placements(doc, mediaId) {
    const out = [];
    const scan = (clips, comp) => {
      const groups = new Map();
      for (const c of clips || []) {
        if (c.mediaId !== mediaId) continue;
        const key = c.linkGroup ? "g:" + c.linkGroup : "c:" + c.id;
        const prev = groups.get(key);
        // the picture represents a placement; its stems fold into it
        if (!prev || (prev.kind !== "video" && c.kind === "video")) groups.set(key, c);
      }
      for (const c of groups.values())
        out.push({ clipId: c.id, comp: comp ? comp.id : null, compName: comp ? comp.name : null, track: c.track, start: +c.start || 0, duration: +c.duration || 0, kind: c.kind });
    };
    scan(doc && doc.clips, null);
    for (const comp of (doc && doc.comps) || []) scan(comp.clips, comp);
    return out.sort((a, b) => (a.comp ? 1 : 0) - (b.comp ? 1 : 0) || String(a.comp || "").localeCompare(String(b.comp || "")) || a.start - b.start);
  }
  /** mediaId → number of placements (see placements()). */
  function usageCounts(doc) {
    const n = new Map();
    for (const m of (doc && doc.media) || []) n.set(m.id, 0);
    const scan = (clips) => {
      const seen = new Set();
      for (const c of clips || []) {
        if (!c.mediaId) continue;
        // per file: a denoised stem shares its video's linkGroup but plays another file
        const key = (c.linkGroup ? "g:" + c.linkGroup : "c:" + c.id) + "|" + c.mediaId;
        if (seen.has(key)) continue;
        seen.add(key);
        n.set(c.mediaId, (n.get(c.mediaId) || 0) + 1);
      }
    };
    scan(doc && doc.clips);
    for (const comp of (doc && doc.comps) || []) scan(comp.clips);
    return n;
  }

  /* ── search, filter, sort ── */
  const ext = (m) => (/\.([a-z0-9]+)$/i.exec(String(m.name || m.src || "")) || [])[1] || "";
  /** Search text: every word must match the name, kind, extension, codecs,
   *  resolution or a tag; "#word" matches tags only. */
  function matchesQuery(m, q) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const tags = (m.tags || []).map((t) => t.toLowerCase());
    const hay = [m.name, m.kind, ext(m), m.codec, m.audioCodec, fmtRes(m).replace("×", "x"), m.height ? m.height + "p" : ""]
      .filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => w.startsWith("#")
      ? tags.some((t) => t.includes(w.slice(1)))
      : hay.includes(w) || tags.some((t) => t.includes(w)));
  }
  /** filter: "" | "fav" | "used" | "unused" | "kind:<kind>" | "tag:<tag>" | "col:<collectionId>". */
  function matchesFilter(m, filter, ctx) {
    const f = String(filter || "");
    if (!f || f === "all") return true;
    const uses = ctx && ctx.usage ? ctx.usage.get(m.id) || 0 : 0;
    if (f === "fav") return m.favorite === true;
    if (f === "used") return uses > 0;
    if (f === "unused") return uses === 0;
    if (f.startsWith("kind:")) return m.kind === f.slice(5);
    if (f.startsWith("tag:")) { const t = f.slice(4).toLowerCase(); return (m.tags || []).some((x) => x.toLowerCase() === t); }
    if (f.startsWith("col:")) {
      const c = ((ctx && ctx.collections) || []).find((x) => x.id === f.slice(4));
      return !!c && c.media.includes(m.id);
    }
    if (ctx && typeof ctx.extraFilter === "function") return ctx.extraFilter(m, f);
    return true;
  }
  /** Sort value for a key; null sorts last whatever the direction. */
  function sortValue(m, key, ctx) {
    switch (key) {
      case "kind": return KINDS.indexOf(m.kind);
      case "duration": return m.duration > 0 ? m.duration : null;
      case "resolution": return m.width > 0 && m.height > 0 ? m.width * m.height : null;
      case "fps": return m.fps > 0 ? m.fps : null;
      case "codec": return m.codec || null;
      case "audio": return m.audioChannels != null ? m.audioChannels : null;
      case "size": return m.size > 0 ? m.size : null;
      case "usage": return ctx && ctx.usage ? ctx.usage.get(m.id) || 0 : 0;
      default: return null;
    }
  }
  function sortMedia(list, key, dir, ctx) {
    const sign = dir === "desc" ? -1 : 1;
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base", numeric: true });
    return list.slice().sort((a, b) => {
      if (!key || key === "name") return sign * byName(a, b);
      const va = sortValue(a, key, ctx), vb = sortValue(b, key, ctx);
      if (va == null || vb == null) return va == null && vb == null ? byName(a, b) : va == null ? 1 : -1;
      const d = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return d ? sign * d : byName(a, b);
    });
  }
  /** search + filter + sort in one go. Favorites float to the top when asked. */
  function query(media, opts, ctx) {
    const o = opts || {};
    const hit = (media || []).filter((m) => matchesQuery(m, o.q) && matchesFilter(m, o.filter, ctx));
    return sortMedia(hit, o.sort || "name", o.dir || "asc", ctx);
  }

  const KIND_BY_EXT = {
    mp4: "video", webm: "video", mov: "video", mkv: "video", m4v: "video", avi: "video",
    mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", aac: "audio", flac: "audio", opus: "audio",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "svg",
  };
  /** video | audio | image | svg from a file name or src, or null. */
  function kindFromName(n) {
    const ext = (/\.([a-z0-9]+)$/i.exec(String(n || "").split("?")[0]) || [])[1];
    return (ext && KIND_BY_EXT[ext.toLowerCase()]) || null;
  }

  /* ── relink ── */
  const stem = (n) => String(n || "").replace(/\.[a-z0-9]{1,5}$/i, "").toLowerCase();
  /** Name of a /media/… or /library/… src, decoded. */
  function srcName(src) {
    const s = String(src || "").split("?")[0].split("/").pop() || "";
    try { return decodeURIComponent(s); } catch { return s; }
  }
  /** How likely `file` ({name, size}) is the missing media `m` ({name, src, size}).
   *  → {score, why}; 0 = not a candidate. Same file name beats same name with
   *  another extension beats a name containing the other; a matching size adds.
   *  With m.kind, files of another kind never qualify. */
  function relinkScore(m, file) {
    // only files that can stand in for this kind (an audio entry may sit in a video container)
    const fk = kindFromName(file.name);
    if (m.kind && fk && fk !== m.kind && !(m.kind === "audio" && fk === "video")) return { score: 0, why: "" };
    const names = [m.name, srcName(m.src)].filter(Boolean).map((n) => n.toLowerCase());
    const fn = String(file.name || "").toLowerCase(), fs = stem(fn);
    let score = 0, why = "";
    if (names.includes(fn)) { score = 100; why = "same name"; }
    else if (names.some((n) => stem(n) === fs && fs)) { score = 60; why = "same name, other type"; }
    else if (names.some((n) => { const a = stem(n); return a.length >= 3 && fs.length >= 3 && (fs.includes(a) || a.includes(fs)); })) { score = 30; why = "similar name"; }
    const sameSize = m.size > 0 && file.size > 0 && m.size === file.size;
    if (sameSize) { score += score ? 50 : 40; why = why ? why + " and size" : "same size"; }
    return { score, why };
  }

  return {
    KINDS, INFO_KEYS, SORT_KEYS, MAX_TAGS,
    srcName, relinkScore, kindFromName,
    parseProbe, fmtSize, fmtFps, fmtRes, fmtAudio, fmtDur, describe,
    normalizeTags, allTags, normalizeCollections,
    placements, usageCounts,
    matchesQuery, matchesFilter, sortValue, sortMedia, query,
  };
});
