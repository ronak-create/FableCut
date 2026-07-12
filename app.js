/* ═══════════════════════════════════════════════════════════════════════════
   FableCut — a browser-based non-linear video editor
   Works standalone (open index.html) or connected to server.js, which adds
   persistent projects (project.json), a media library folder, and a REST API
   so external tools (e.g. Claude Code) can edit the timeline programmatically.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── Constants ─────────────────────────────────────────────────────────── */
const TRACKS = [
  { id: "V4", kind: "video", h: 44, color: "#ff8a5c" },
  { id: "V3", kind: "video", h: 44, color: "#ffd166" },
  { id: "V2", kind: "video", h: 58, color: "#7b6cff" },
  { id: "V1", kind: "video", h: 58, color: "#4f8cff" },
  { id: "A1", kind: "audio", h: 42, color: "#7ec249" },
  { id: "A2", kind: "audio", h: 42, color: "#5a9e3a" },
  { id: "A3", kind: "audio", h: 42, color: "#4a8a2f" },
];
const RULER_H = 26;
const SNAP_PX = 8;
const MIN_DUR = 0.05;

const DEFAULT_PROPS = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1,
  speed: 1,                                    // playback rate (video/audio)
  brightness: 100, contrast: 100, saturation: 100, hue: 0,
  blur: 0, grayscale: 0, sepia: 0, invert: 0,
  temperature: 0, tint: 0, vignette: 0,        // color grade extensions
  filterPreset: "none",                        // named look, see FILTER_PRESETS
  fit: "contain",                              // contain | cover | stretch | none
  cropL: 0, cropT: 0, cropR: 0, cropB: 0,      // % trimmed off each source edge
  flipH: false, flipV: false,
  cornerRadius: 0,                             // px, rounded corners (PiP look)
  blend: "normal",                             // canvas blend mode
  chromaKey: "", chromaTolerance: 26, chromaSoftness: 12,  // green-screen key
  bgRemove: false,                             // AI person cut-out (MediaPipe)
  shake: 0, shakeSpeed: 8,                     // handheld/impact camera shake (px)
  rgbSplit: 0,                                 // chromatic aberration (px)
  grain: 0,                                    // film grain (%)
  text: "Title", fontSize: 72, color: "#ffffff", color2: "", font: "Segoe UI",
  bold: true, italic: false, weight: 0, align: "center",
  letterSpacing: 0, lineHeight: 1.2, uppercase: false, textShadow: 12,
  glow: 0, glowColor: "",                      // neon glow (glowColor defaults to fill)
  textAnim: "none", wordRate: 0.15,
  strokeWidth: 0, strokeColor: "#000000", bgColor: "#000000", bgOpacity: 0,
};
const ANIMATABLE = ["x", "y", "scale", "rotation", "opacity", "volume", "speed",
  "brightness", "contrast", "saturation", "hue", "blur", "grayscale", "sepia", "invert",
  "temperature", "tint", "vignette", "cornerRadius", "shake", "rgbSplit", "grain",
  "fontSize", "letterSpacing", "glow"];
const TRANSITIONS = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down",
  "zoom", "wipe", "wipe-right", "wipe-up", "wipe-down", "iris", "spin", "blur", "whip",
  "glitch", "pop"];
const TEXT_ANIMS = ["none", "typewriter", "word-pop", "word-slide", "karaoke",
  "letter-pop", "wave", "bounce", "shake",
  "clip-reveal", "zoom-in", "font-cut", "rise-mask"];
const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "lighter", "soft-light",
  "hard-light", "color-dodge", "darken", "lighten", "difference"];
/* Named looks. % props multiply against the clip's own value, additive props add. */
const FILTER_PRESETS = {
  none: {},
  cinematic:     { contrast: 112, saturation: 118, temperature: -10, vignette: 28 },
  "teal-orange": { contrast: 115, saturation: 125, temperature: -18, hue: -8, vignette: 22 },
  noir:          { grayscale: 100, contrast: 128, brightness: 96, vignette: 45 },
  vintage:       { sepia: 42, contrast: 92, brightness: 106, saturation: 88, temperature: 12, vignette: 30 },
  faded:         { contrast: 84, brightness: 110, saturation: 82 },
  warm:          { temperature: 28, brightness: 103, saturation: 108 },
  cold:          { temperature: -28, saturation: 104 },
  pop:           { saturation: 152, contrast: 116 },
  dreamy:        { brightness: 109, saturation: 112, blur: 0.6, temperature: 8 },
  retro:         { saturation: 130, hue: -6, contrast: 106, sepia: 15 },
  "bw-soft":     { grayscale: 100, contrast: 95, brightness: 108 },
  cyberpunk:     { saturation: 140, hue: 12, contrast: 118, temperature: -15, vignette: 25 },
};
const SYSTEM_FONTS = ["Segoe UI", "Arial", "Georgia", "Impact", "Courier New",
  "Trebuchet MS", "Verdana", "Times New Roman", "Comic Sans MS", "Consolas"];
const GOOGLE_FONTS = ["Anton", "Archivo Black", "Abril Fatface", "Barlow", "Bebas Neue",
  "Caveat", "Inter", "Lobster", "Montserrat", "Oswald", "Pacifico", "Permanent Marker",
  "Playfair Display", "Poppins", "Roboto", "Roboto Condensed", "Teko"];

/* ── Title styles: cohesive one-tap looks. Each bundles a DIFFERENT font,
   placement and animation, so titles vary instead of all looking basic.
   Agents can reproduce a look by writing the same props directly. ── */
const FONT_CUT_DEFAULT = ["Anton", "Bebas Neue", "Archivo Black", "Oswald", "Impact"];
const STYLE_RESET = {   // decorative props a style owns; reset before applying
  color2: "", glow: 0, glowColor: "", strokeWidth: 0, bgColor: "#000000", bgOpacity: 0,
  rotation: 0, letterSpacing: 0, uppercase: false, italic: false, textShadow: 12,
  fontCutSet: undefined, align: "center",
};
const TITLE_STYLES = {
  plain:      { label: "Plain",       place: "center",     props: { font: "Segoe UI", fontSize: 72, bold: true, color: "#ffffff", textAnim: "none" } },
  impact:     { label: "Impact",      place: "lower",      props: { font: "Anton", fontSize: 96, bold: false, uppercase: true, color: "#ffffff", textShadow: 22, textAnim: "word-pop" } },
  elegant:    { label: "Elegant",     place: "center",     props: { font: "Playfair Display", fontSize: 88, bold: false, color: "#ffffff", color2: "#ffd166", letterSpacing: 2, textAnim: "clip-reveal" } },
  kinetic:    { label: "Kinetic cut", place: "center",     props: { font: "Bebas Neue", fontSize: 120, bold: false, uppercase: true, color: "#ffd166", letterSpacing: 3, textAnim: "font-cut", fontCutSet: ["Anton", "Bebas Neue", "Archivo Black", "Oswald"] } },
  neon:       { label: "Neon",        place: "center",     props: { font: "Bebas Neue", fontSize: 104, bold: false, uppercase: true, color: "#ffffff", glow: 60, glowColor: "#22d3ee", textAnim: "wave" } },
  handwritten:{ label: "Handwritten", place: "lower-left", props: { font: "Caveat", fontSize: 92, bold: false, color: "#ffffff", rotation: -4, textAnim: "word-slide" } },
  serifDrop:  { label: "Serif drop",  place: "center",     props: { font: "Abril Fatface", fontSize: 96, bold: false, color: "#ffffff", textShadow: 18, textAnim: "zoom-in" } },
  subtitle:   { label: "Subtitle",    place: "lower",      props: { font: "Roboto", fontSize: 52, bold: false, color: "#ffffff", bgColor: "#000000", bgOpacity: 0.5, textAnim: "karaoke" } },
  boldRise:   { label: "Bold rise",   place: "lower",      props: { font: "Archivo Black", fontSize: 92, bold: false, uppercase: true, color: "#ffffff", textAnim: "rise-mask" } },
};
const STYLE_CYCLE = ["impact", "elegant", "kinetic", "neon", "handwritten", "serifDrop", "boldRise"];
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|mpeg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
const ASPECT_PRESETS = [
  { label: "16:9 · 1280×720", w: 1280, h: 720 },
  { label: "16:9 · 1920×1080", w: 1920, h: 1080 },
  { label: "9:16 · Reel 1080×1920", w: 1080, h: 1920 },
  { label: "4:5 · IG 1080×1350", w: 1080, h: 1350 },
  { label: "1:1 · 1080×1080", w: 1080, h: 1080 },
];
const WAVE_PEAKS_PER_SEC = 50;

/* ── State ─────────────────────────────────────────────────────────────── */
const project = {
  name: "Untitled Project",
  width: 1280, height: 720, fps: 30,
  background: "#000000",
  revision: 0,
  media: [],   // {id, name, kind:'video'|'audio'|'image', src, duration, width?, height?}
  clips: [],   // {id, mediaId, kind, track, start, in, duration, name, props:{}}
  markers: [], // {t, label?} — beat/cue markers on the ruler; snap targets
};
const state = {
  time: 0, playing: false, pps: 60, snap: true,
  selId: null,           // primary selection (drives the inspector)
  selIds: new Set(),     // full multi-selection (includes selId)
  connected: false, exporting: false,
  rendering: false,      // fast (server/ffmpeg) export in progress
  guides: false,         // safe-area overlay on the monitor
  ffmpeg: false,         // server reports ffmpeg available
  dirtyTimeline: true, gesture: false,
  binTab: "project",     // project | elements | sfx | svg
};
const runtime = {
  clipEls: new Map(),   // clipId -> HTMLMediaElement
  clipGain: new Map(),  // clipId -> GainNode
  mediaAux: new Map(),  // mediaId -> {img?, thumb?, svgText?, svgAnimated?}
  audioBufs: new Map(), // mediaId -> Promise<AudioBuffer> (waveforms + export mix)
  wavePeaks: new Map(), // mediaId -> Float32Array peaks at WAVE_PEAKS_PER_SEC
  library: {},          // dir -> [{name, rel, src, size}] cached /api/library results
  customFonts: [],      // family names loaded from /library/fonts
  googleLoaded: new Set(),
  undo: [], redo: [],
  audio: null,          // {ctx, master, recDest}
  saveTimer: null, pendingSync: false,
  sfxPreview: null,     // <audio> element for library sound previews
};

/* ── DOM ───────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const els = {
  binList: $("binList"), binEmpty: $("binEmpty"), fileInput: $("fileInput"),
  binTabs: $("binTabs"), libList: $("libList"), toast: $("toast"),
  preview: $("preview"), tcCurrent: $("tcCurrent"), tcTotal: $("tcTotal"),
  btnPlay: $("btnPlay"), inspector: $("inspector"),
  trackHeaders: $("trackHeaders"), timelineScroll: $("timelineScroll"),
  tracksContent: $("tracksContent"), tracks: $("tracks"), playhead: $("playhead"),
  ruler: $("ruler"), zoomSlider: $("zoomSlider"), btnSnap: $("btnSnap"),
  exportOverlay: $("exportOverlay"), exportProgress: $("exportProgress"),
  exportTitle: $("exportTitle"), exportNote: $("exportNote"),
  projectName: $("projectName"), monitorRes: $("monitorRes"),
  aspectSel: $("aspectSel"), btnGuides: $("btnGuides"), safeOverlay: $("safeOverlay"),
  monitorStage: $("monitorStage"),
  exportSetup: $("exportSetup"), engineFast: $("engineFast"), engineRealtime: $("engineRealtime"),
};
const ctx2d = els.preview.getContext("2d");

/* ── Utils ─────────────────────────────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60),
        f = Math.floor((t % 1) * project.fps);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(m)}:${p(s)}:${p(f)}`;
}
const getMedia = (id) => project.media.find((m) => m.id === id);
const getClip = (id) => project.clips.find((c) => c.id === id);
const clipEnd = (c) => c.start + c.duration;
function projDur() {
  return project.clips.reduce((mx, c) => Math.max(mx, clipEnd(c)), 0);
}
const trackOf = (c) => TRACKS.find((t) => t.id === c.track);
const clipSpeed = (c) => clamp(+(c.props?.speed) || 1, 0.1, 8);

/* ── Speed ramps (time remapping) ──
   `speed` is keyframable: media time = in + ∫ speed(t) dt over the clip.
   The integral is sampled once per unique speed curve and cached. */
const speedIntCache = new Map(); // clipId -> {key, cum: Float32Array, step}
function kfChannel(c, key, local, fallback) {
  const kfs = c.keyframes?.[key];
  if (!Array.isArray(kfs) || !kfs.length) return fallback;
  if (local <= kfs[0].t) return kfs[0].v;
  if (local >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (local >= a.t && local <= b.t) {
      const u = (local - a.t) / Math.max(1e-6, b.t - a.t);
      const ez = EASE[b.ease || "ease-in-out"] || EASE.linear;
      return a.v + (b.v - a.v) * ez(u);
    }
  }
  return fallback;
}
function hasSpeedRamp(c) {
  return Array.isArray(c.keyframes?.speed) && c.keyframes.speed.length > 0;
}
function mediaTimeAt(c, t) {
  const base = clipSpeed(c);
  const local = clamp(t - c.start, 0, c.duration);
  if (!hasSpeedRamp(c)) return c.in + local * base;
  const key = JSON.stringify(c.keyframes.speed) + "|" + c.duration.toFixed(4) + "|" + base;
  let e = speedIntCache.get(c.id);
  if (!e || e.key !== key) {
    const step = 1 / 120;
    const n = Math.max(2, Math.ceil(c.duration / step) + 1);
    const cum = new Float32Array(n);
    let prev = clamp(kfChannel(c, "speed", 0, base), 0.1, 8);
    for (let i = 1; i < n; i++) {
      const lt = Math.min(c.duration, i * step);
      const cur = clamp(kfChannel(c, "speed", lt, base), 0.1, 8);
      cum[i] = cum[i - 1] + ((prev + cur) / 2) * (lt - (i - 1) * step);
      prev = cur;
    }
    e = { key, cum, step };
    speedIntCache.set(c.id, e);
  }
  const idx = Math.min(e.cum.length - 1, local / e.step);
  const i0 = Math.floor(idx), frac = idx - i0;
  const v = i0 >= e.cum.length - 1 ? e.cum[e.cum.length - 1]
          : e.cum[i0] + (e.cum[i0 + 1] - e.cum[i0]) * frac;
  return c.in + v;
}
let toastTimer = null;
function toast(msg) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

/* ═══════════════════════ SERVER SYNC (optional) ═══════════════════════ */
async function connectServer() {
  try {
    const res = await fetch("/api/project", { cache: "no-store" });
    if (!res.ok) throw 0;
    const data = await res.json();
    applyProject(data);
    state.connected = true;
    els.projectName.textContent = project.name + "  ·  🟢 connected";
    listenSSE();
    fetch("/api/export/ffmpeg").then((r) => r.json())
      .then((j) => { state.ffmpeg = !!j.available; }).catch(() => {});
  } catch {
    state.connected = false;
    els.projectName.textContent = project.name + "  ·  ⚪ local session";
  }
  await probeMissingMeta();
}
function applyProject(data) {
  Object.assign(project, {
    name: data.name || "Untitled Project",
    width: data.width || 1280, height: data.height || 720, fps: data.fps || 30,
    background: data.background || "#000000",
    revision: data.revision || 0,
    media: data.media || [], clips: data.clips || [],
    markers: (data.markers || []).filter((m) => m && isFinite(m.t)).sort((a, b) => a.t - b.t),
  });
  for (const c of project.clips) {
    c.props = { ...DEFAULT_PROPS, ...(c.props || {}) };
    if (c.keyframes) for (const arr of Object.values(c.keyframes))
      if (Array.isArray(arr)) arr.sort((a, b) => a.t - b.t);
    if (c.kind === "text") ensureFont(c.props.font);
  }
  // reset runtime playback elements so they rebuild against new data
  for (const el of runtime.clipEls.values()) { try { el.pause(); el.src = ""; } catch {} }
  runtime.clipEls.clear(); runtime.clipGain.clear();
  els.preview.width = project.width; els.preview.height = project.height;
  els.monitorRes.textContent = `${project.width} × ${project.height} · ${project.fps}fps`;
  syncAspectSel();
  pruneSelection(); // keep the selection across external reloads where possible
  state.dirtyTimeline = true;
  renderBin(); renderInspector();
}
function scheduleSave() {
  state.dirtyTimeline = true;
  if (!state.connected) return;
  clearTimeout(runtime.saveTimer);
  runtime.saveTimer = setTimeout(async () => {
    runtime.saveTimer = null;
    project.revision++;
    const body = JSON.stringify(projectJSON(), null, 2);
    try {
      const res = await fetch("/api/project", { method: "PUT", headers: { "Content-Type": "application/json" }, body });
      if (res.status === 409) {
        // an external tool saved a newer revision while this change was pending
        await syncFromServer(true);
        toast("Project was updated externally — your last change may need redoing.");
      }
    } catch {}
  }, 400);
}
function projectJSON() {
  const { name, width, height, fps, background, revision, media, clips, markers } = project;
  return {
    name, width, height, fps, background, revision,
    media: media.filter((m) => !m.transient).map(({ id, name, kind, src, duration, width, height }) =>
      ({ id, name, kind, src, duration, width, height })),
    clips: clips.map(({ id, mediaId, kind, track, start, in: inn, duration, name, props, keyframes, transitionIn, transitionOut }) =>
      ({ id, mediaId, kind, track, start, in: inn, duration, name, props, keyframes, transitionIn, transitionOut })),
    markers: (markers || []).map(({ t, label }) => (label ? { t, label } : { t })),
  };
}
function listenSSE() {
  const es = new EventSource("/api/events");
  es.onmessage = () => syncFromServer();
}
/* Pull the server's project if it moved past our revision (an external tool —
   e.g. Claude — wrote it). Our own saves land at our exact local revision, so
   they compare equal and are skipped without any timing heuristics. Deferred
   during gestures/exports and re-run when they end (runtime.pendingSync). */
async function syncFromServer(force) {
  if (state.gesture || state.exporting) { runtime.pendingSync = true; return; }
  runtime.pendingSync = false;
  if (state.binTab !== "project") fetchLibrary(state.binTab).then(renderLibrary);
  loadLibraryFonts();
  try {
    const res = await fetch("/api/project", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.clips)) return;
    if (!force && (data.revision || 0) === (project.revision || 0)) return; // our own save
    if (runtime.saveTimer) { // unsaved local edit vs. external write: external wins, tell the user
      clearTimeout(runtime.saveTimer); runtime.saveTimer = null;
      toast("Project was updated externally — your last change may need redoing.");
    }
    applyProject(data);
    await probeMissingMeta();
  } catch {}
}
/* Fill in duration/size for media entries added externally without metadata */
async function probeMissingMeta() {
  let changed = false;
  for (const m of project.media) {
    if (m.kind === "svg") {
      if (!runtime.mediaAux.get(m.id)?.svgText) { try { await loadSvgMedia(m); changed = true; } catch {} }
      continue;
    }
    if (m.kind !== "image" && (m.duration == null || isNaN(m.duration))) {
      try { Object.assign(m, await probeAV(m.src, m.kind)); changed = true; } catch {}
    }
    if (m.kind === "image" && !runtime.mediaAux.get(m.id)?.img) {
      try {
        const img = await loadImage(m.src);
        runtime.mediaAux.set(m.id, { ...(runtime.mediaAux.get(m.id) || {}), img });
        m.width = img.naturalWidth; m.height = img.naturalHeight; changed = true;
      } catch {}
    }
    if (m.kind === "video" && !runtime.mediaAux.get(m.id)?.thumb) {
      grabThumb(m).catch(() => {});
    }
    ensureWave(m);
  }
  if (changed) { renderBin(); scheduleSave(); }
  state.dirtyTimeline = true;
}
function probeAV(src, kind) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.preload = "metadata"; el.src = src;
    el.onloadedmetadata = () => resolve({
      duration: el.duration,
      width: el.videoWidth || undefined, height: el.videoHeight || undefined,
    });
    el.onerror = reject;
  });
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function grabThumb(m) {
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.src = m.src;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
  v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
  await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); });
  const c = document.createElement("canvas");
  c.width = 160; c.height = 90;
  c.getContext("2d").drawImage(v, 0, 0, 160, 90);
  runtime.mediaAux.set(m.id, { ...(runtime.mediaAux.get(m.id) || {}), thumb: c.toDataURL("image/jpeg", 0.6) });
  v.src = "";
  renderBin(); state.dirtyTimeline = true;
}

/* ── Audio decoding (shared by clip waveforms and the fast-export mix) ── */
let decodeCtx = null;
function getDecodeCtx() {
  return decodeCtx || (decodeCtx = new (window.AudioContext || window.webkitAudioContext)());
}
function getAudioBuffer(m) {
  let p = runtime.audioBufs.get(m.id);
  if (!p) {
    p = fetch(m.src).then((r) => r.arrayBuffer())
      .then((ab) => getDecodeCtx().decodeAudioData(ab));
    runtime.audioBufs.set(m.id, p);
    p.catch(() => runtime.audioBufs.delete(m.id));
  }
  return p;
}
function ensureWave(m) {
  if (m.kind !== "audio" || runtime.wavePeaks.has(m.id)) return;
  runtime.wavePeaks.set(m.id, null); // pending
  getAudioBuffer(m).then((buf) => {
    const n = Math.max(1, Math.ceil(buf.duration * WAVE_PEAKS_PER_SEC));
    const peaks = new Float32Array(n);
    const step = buf.length / n;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        let mx = 0;
        const i0 = Math.floor(i * step), i1 = Math.min(data.length, Math.floor((i + 1) * step));
        for (let j = i0; j < i1; j += 8) { const a = Math.abs(data[j]); if (a > mx) mx = a; }
        if (mx > peaks[i]) peaks[i] = mx;
      }
    }
    runtime.wavePeaks.set(m.id, peaks);
    state.dirtyTimeline = true;
  }).catch(() => runtime.wavePeaks.delete(m.id));
}

/* ═══════════════════════════ MEDIA IMPORT ═══════════════════════════ */
/* Windows often leaves File.type empty for video/audio — fall back to extension. */
function mediaKindFromFile(file) {
  const t = file.type || "";
  if (t === "image/svg+xml" || t === "image/svg") return "svg";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("image/")) return "image";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "svg") return "svg";
  if (["mp4", "mov", "webm", "mkv", "m4v", "avi", "mpg", "mpeg"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac", "wma"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].includes(ext)) return "image";
  return null;
}
async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let added = 0, skipped = 0;
  for (const file of files) {
    const kind = mediaKindFromFile(file);
    if (!kind) { skipped++; continue; }
    let src, transient = false;
    if (state.connected) {
      try {
        const res = await fetch("/api/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
        if (!res.ok) throw new Error("upload " + res.status);
        src = (await res.json()).src;
      } catch { src = URL.createObjectURL(file); transient = true; }
    } else {
      src = URL.createObjectURL(file); transient = true;
    }
    const m = { id: "m_" + uid(), name: file.name, kind, src, transient };
    try {
      if (kind === "svg") {
        await loadSvgMedia(m);
      } else if (kind === "image") {
        const img = await loadImage(src);
        runtime.mediaAux.set(m.id, { img });
        m.width = img.naturalWidth; m.height = img.naturalHeight;
      } else {
        Object.assign(m, await probeAV(src, kind));
        if (kind === "video") grabThumb(m).catch(() => {});
        ensureWave(m);
      }
    } catch { skipped++; continue; }
    project.media.push(m);
    added++;
  }
  renderBin(); scheduleSave();
  if (!added && skipped)
    toast("Couldn't import — unsupported or unreadable file type");
  else if (skipped)
    toast(`Imported ${added}, skipped ${skipped}`);
}

function renderBin() {
  els.binList.querySelectorAll(".bin-item").forEach((n) => n.remove());
  els.binEmpty.style.display = project.media.length ? "none" : "";
  for (const m of project.media) {
    const item = document.createElement("div");
    item.className = "bin-item"; item.draggable = true;
    const aux = runtime.mediaAux.get(m.id) || {};
    const icon = m.kind === "audio" ? "🎵" : m.kind === "image" ? "🖼" : m.kind === "svg" ? "✨" : "🎞";
    const thumbSrc = aux.thumb || (m.kind === "image" || m.kind === "svg" ? m.src : null);
    item.innerHTML = `
      <div class="bin-thumb" ${thumbSrc ? `style="background-image:url('${thumbSrc}')"` : ""}>${thumbSrc ? "" : icon}</div>
      <div class="bin-meta">
        <div class="bin-name" title="${m.name}">${m.name}</div>
        <div class="bin-sub">${m.kind}${m.duration ? " · " + fmt(m.duration) : ""}</div>
      </div>
      <span class="bin-del" title="Remove (and its clips)">✕</span>`;
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/fablecut-media", m.id);
      e.dataTransfer.effectAllowed = "copy";
    });
    item.addEventListener("dblclick", () => addClipFromMedia(m, null, state.time));
    item.querySelector(".bin-del").addEventListener("click", () => {
      pushUndo();
      project.media = project.media.filter((x) => x.id !== m.id);
      project.clips = project.clips.filter((c) => c.mediaId !== m.id);
      renderBin(); scheduleSave(); renderInspector();
    });
    els.binList.appendChild(item);
  }
}

/* Open the native file dialog. Windows anchors it to the <input>'s screen
   position — park the input under the cursor and open after the mouse
   gesture finishes so the dialog doesn't appear then jump. */
function openFileImport(clientX, clientY) {
  const input = els.fileInput;
  if (clientX != null && clientY != null) {
    input.style.cssText =
      `position:fixed;left:${clientX}px;top:${clientY}px;width:1px;height:1px;` +
      `opacity:0;margin:0;padding:0;border:0;overflow:hidden;z-index:-1;`;
  }
  setTimeout(() => input.click(), 0);
}

/* Ctrl/Cmd+click in the Project bin opens the file importer. */
els.binList.addEventListener("click", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
  if (e.target.closest(".bin-del")) return;
  e.preventDefault();
  openFileImport(e.clientX, e.clientY);
});

/* ═══════════════════ ASSET LIBRARY (./library on the server) ═══════════════
   Read-only default assets in four tabs: Elements (overlay art), Sound FX,
   SVG (Claude-authored vector animations), plus fonts consumed by the font
   editor. Files are used in place (src under /library/…) — never copied. */
async function fetchLibrary(dir) {
  try { runtime.library[dir] = await (await fetch("/api/library?dir=" + dir)).json(); }
  catch { runtime.library[dir] = []; }
  return runtime.library[dir];
}
function libKind(name) {
  if (/\.svg$/i.test(name)) return "svg";
  if (AUDIO_EXT.test(name)) return "audio";
  if (VIDEO_EXT.test(name)) return "video";
  if (IMAGE_EXT.test(name)) return "image";
  return null;
}
/* Find-or-create the project media entry for a library file (dedup by src). */
function mediaForLibraryItem(f) {
  let m = project.media.find((x) => x.src === f.src);
  if (m) return m;
  const kind = libKind(f.name);
  if (!kind) return null;
  m = { id: "m_" + uid(), name: f.name, kind, src: f.src };
  project.media.push(m);
  renderBin(); scheduleSave();
  return m;
}
async function addLibraryItem(f, trackId, at) {
  const m = mediaForLibraryItem(f);
  if (!m) { toast("Unsupported file type: " + f.name); return; }
  if ((m.kind === "audio" || m.kind === "video") && (m.duration == null || isNaN(m.duration))) {
    try { Object.assign(m, await probeAV(m.src, m.kind)); } catch {}
    ensureWave(m);
    if (m.kind === "video") grabThumb(m).catch(() => {});
  }
  if (m.kind === "svg" && !runtime.mediaAux.get(m.id)?.svgText) {
    try { await loadSvgMedia(m); } catch {}
  }
  if (m.kind === "image" && !runtime.mediaAux.get(m.id)?.img) {
    try {
      const img = await loadImage(m.src);
      runtime.mediaAux.set(m.id, { ...(runtime.mediaAux.get(m.id) || {}), img });
      m.width = img.naturalWidth; m.height = img.naturalHeight;
    } catch {}
  }
  addClipFromMedia(m, trackId, at);
}
function toggleSfxPreview(f, btn) {
  const cur = runtime.sfxPreview;
  if (cur && cur.dataset.src === f.src && !cur.paused) {
    cur.pause();
    btn.textContent = "▶";
    return;
  }
  if (cur) { cur.pause(); }
  els.libList.querySelectorAll(".lib-play").forEach((b) => (b.textContent = "▶"));
  const a = new Audio(f.src);
  a.dataset.src = f.src;
  a.onended = () => { btn.textContent = "▶"; };
  a.play().catch(() => toast("Couldn't play " + f.name));
  btn.textContent = "⏸";
  runtime.sfxPreview = a;
}
function renderLibrary() {
  const dir = state.binTab;
  if (dir === "project") return;
  const files = runtime.library[dir] || [];
  els.libList.innerHTML = "";
  if (!files.length) {
    els.libList.innerHTML = `<div class="bin-empty">
      <div class="bin-empty-icon">${dir === "sfx" ? "🔊" : dir === "svg" ? "✨" : "🧩"}</div>
      <p>No assets yet.</p>
      <p class="hint">Drop files into<br><b>library/${dir}/</b><br>— this list live-updates.</p></div>`;
    return;
  }
  for (const f of files) {
    const kind = libKind(f.name);
    const item = document.createElement("div");
    item.className = "bin-item lib-item";
    item.draggable = true;
    const visual = kind === "image" || kind === "svg";
    const icon = kind === "audio" ? "🎵" : kind === "video" ? "🎞" : kind === "svg" ? "✨" : "🧩";
    item.innerHTML = `
      <div class="bin-thumb${kind === "svg" ? " svg" : ""}" ${visual ? `style="background-image:url('${f.src}')"` : ""}>${visual ? "" : icon}</div>
      <div class="bin-meta">
        <div class="bin-name" title="${f.rel}">${f.name}</div>
        <div class="bin-sub">${(f.size / 1024).toFixed(0)} KB</div>
      </div>
      ${dir === "sfx" ? `<button class="btn tiny lib-play" title="Preview">▶</button>` : ""}
      <button class="btn tiny accent lib-add" title="Add at playhead">＋</button>`;
    item.addEventListener("dragstart", (e) => {
      const m = mediaForLibraryItem(f);
      if (!m) { e.preventDefault(); return; }
      e.dataTransfer.setData("text/fablecut-media", m.id);
      e.dataTransfer.effectAllowed = "copy";
    });
    item.addEventListener("dblclick", () => addLibraryItem(f, null, state.time));
    item.querySelector(".lib-add").addEventListener("click", () => addLibraryItem(f, null, state.time));
    const play = item.querySelector(".lib-play");
    if (play) play.addEventListener("click", () => toggleSfxPreview(f, play));
    els.libList.appendChild(item);
  }
}
function setBinTab(tab) {
  state.binTab = tab;
  for (const b of els.binTabs.querySelectorAll("[data-tab]"))
    b.classList.toggle("on", b.dataset.tab === tab);
  const isProj = tab === "project";
  els.binList.classList.toggle("hidden", !isProj);
  els.libList.classList.toggle("hidden", isProj);
  if (!isProj) fetchLibrary(tab).then(renderLibrary);
}

/* ═══════════════════════════ EDIT OPERATIONS ═══════════════════════════ */
function pushUndo() {
  runtime.undo.push(JSON.stringify(project.clips));
  if (runtime.undo.length > 100) runtime.undo.shift();
  runtime.redo.length = 0;
}
function undo() {
  if (!runtime.undo.length) return;
  runtime.redo.push(JSON.stringify(project.clips));
  project.clips = JSON.parse(runtime.undo.pop());
  pruneSelection();
  scheduleSave(); renderInspector();
}
function redo() {
  if (!runtime.redo.length) return;
  runtime.undo.push(JSON.stringify(project.clips));
  project.clips = JSON.parse(runtime.redo.pop());
  pruneSelection();
  scheduleSave(); renderInspector();
}

function defaultTrackFor(kind) {
  return kind === "audio" ? "A1" : kind === "svg" ? "V3" : "V1";
}

function addClipFromMedia(m, trackId, at) {
  pushUndo();
  const kind = m.kind;
  trackId = trackId || defaultTrackFor(kind);
  const tr = TRACKS.find((t) => t.id === trackId);
  if (!tr || (kind === "audio") !== (tr.kind === "audio")) trackId = defaultTrackFor(kind);
  const c = {
    id: "c_" + uid(), mediaId: m.id, kind, track: trackId,
    start: Math.max(0, at ?? state.time), in: 0,
    duration: m.duration || 5, name: m.name.replace(/\.[^.]+$/, ""),
    props: { ...DEFAULT_PROPS },
  };
  project.clips.push(c);
  selectClip(c.id); scheduleSave();
  return c;
}
/* Apply a named title style: reset the props a style owns, merge the style,
   place it (canvas-aware), and make sure its fonts are loaded. */
function applyTitleStyle(clip, name) {
  const st = TITLE_STYLES[name] || TITLE_STYLES.plain;
  const P = clip.props;
  Object.assign(P, STYLE_RESET, st.props);
  const H = project.height || 720, W = project.width || 1280;
  const place = st.place || "center";
  P.x = 0;
  P.y = place === "lower" ? Math.round(H * 0.30)
      : place === "upper" ? -Math.round(H * 0.30)
      : place === "lower-left" ? Math.round(H * 0.28) : 0;
  if (place === "lower-left") { P.x = -Math.round(W * 0.18); P.align = "left"; }
  ensureFont(P.font);
  if (Array.isArray(P.fontCutSet)) P.fontCutSet.forEach(ensureFont);
  clip.styleName = name;
}
function addTitle() {
  pushUndo();
  const c = {
    id: "c_" + uid(), mediaId: null, kind: "text", track: "V2",
    start: state.time, in: 0, duration: 4, name: "Title",
    props: { ...DEFAULT_PROPS },
  };
  // interesting by default: rotate through the styles so titles vary
  runtime.titleStyleIdx = ((runtime.titleStyleIdx || 0) + 1) % STYLE_CYCLE.length;
  applyTitleStyle(c, STYLE_CYCLE[runtime.titleStyleIdx]);
  project.clips.push(c);
  selectClip(c.id); scheduleSave();
}
function addAdjust() {
  pushUndo();
  const c = {
    id: "c_" + uid(), mediaId: null, kind: "adjust", track: "V3",
    start: state.time, in: 0, duration: 4, name: "Adjust",
    props: { ...DEFAULT_PROPS },
  };
  project.clips.push(c);
  selectClip(c.id); scheduleSave();
}
function deleteSelected() {
  const doomed = selectedClips();
  if (!doomed.length) return;
  pushUndo();
  for (const c of doomed) releaseClipEl(c.id);
  project.clips = project.clips.filter((x) => !state.selIds.has(x.id));
  setSelection([]);
  scheduleSave(); renderInspector();
}
function splitAtPlayhead() {
  const t = state.time;
  let targets = state.selIds.size ? selectedClips() : project.clips;
  targets = targets.filter((c) => t > c.start + MIN_DUR && t < clipEnd(c) - MIN_DUR);
  if (!targets.length) return;
  pushUndo();
  for (const c of targets) {
    const cut = t - c.start;
    const right = {
      ...c, id: "c_" + uid(), props: { ...c.props },
      start: t, in: c.in + cut * clipSpeed(c), duration: clipEnd(c) - t,
      keyframes: shiftKF(c.keyframes, cut, clipEnd(c) - t),
      transitionIn: undefined,
    };
    c.duration = cut;
    c.keyframes = shiftKF(c.keyframes, 0, cut);
    c.transitionOut = undefined;
    project.clips.push(right);
  }
  scheduleSave();
}
function trimToPlayhead(side) {
  const c = getClip(state.selId);
  if (!c) return;
  const t = state.time;
  if (t <= c.start && side === "in") return;
  pushUndo();
  if (side === "in" && t > c.start && t < clipEnd(c) - MIN_DUR) {
    const d = t - c.start;
    c.start = t; c.in += d * clipSpeed(c); c.duration -= d;
  } else if (side === "out" && t > c.start + MIN_DUR && t < clipEnd(c)) {
    c.duration = t - c.start;
  }
  scheduleSave(); renderInspector();
}

/* ═══════════════════════════ TIMELINE UI ═══════════════════════════ */
function buildTrackDOM() {
  els.trackHeaders.innerHTML = "";
  els.tracks.innerHTML = "";
  const inner = document.createElement("div");
  inner.id = "trackHeadInner";
  els.trackHeaders.appendChild(inner);
  for (const t of TRACKS) {
    const h = document.createElement("div");
    h.className = "track-head"; h.style.height = t.h + "px";
    h.innerHTML = `<span class="track-dot" style="background:${t.color}"></span>${t.id} <span class="dim" style="font-weight:400">${t.kind}</span>`;
    inner.appendChild(h);
    const row = document.createElement("div");
    row.className = "track"; row.dataset.track = t.id; row.style.height = t.h + "px";
    els.tracks.appendChild(row);
  }
}
/* keep track headers vertically aligned with the (scrollable) track rows */
els.timelineScroll.addEventListener("scroll", () => {
  const inner = $("trackHeadInner");
  if (inner) inner.style.transform = `translateY(${-els.timelineScroll.scrollTop}px)`;
});
function contentWidth() {
  const minSec = (els.timelineScroll.clientWidth || 800) / state.pps;
  return Math.max(projDur() + 15, minSec) * state.pps;
}
function rebuildClips() {
  const w = contentWidth();
  els.tracksContent.style.width = w + "px";
  els.ruler.style.width = els.timelineScroll.clientWidth + "px";
  for (const row of els.tracks.children) row.innerHTML = "";
  for (const c of project.clips) {
    const tr = trackOf(c); if (!tr) continue;
    const row = els.tracks.querySelector(`[data-track="${c.track}"]`);
    const div = document.createElement("div");
    div.className = `clip c-${c.kind}` +
      (state.selIds.has(c.id) ? " selected" : "") + (c.id === state.selId ? " primary" : "");
    div.dataset.id = c.id;
    div.style.left = c.start * state.pps + "px";
    div.style.width = Math.max(8, c.duration * state.pps) + "px";
    let inner = "";
    if (c.kind === "video") {
      const thumb = runtime.mediaAux.get(c.mediaId)?.thumb;
      if (thumb) inner += `<div class="thumbs" style="background-image:url('${thumb}')"></div>`;
    }
    const hasWave = c.kind === "audio" && runtime.wavePeaks.get(c.mediaId) instanceof Float32Array;
    if (hasWave) inner += `<canvas class="wave"></canvas>`;
    const badge = (c.keyframes && Object.keys(c.keyframes).length ? "◆ " : "") +
                  (c.transitionIn || c.transitionOut ? "⇄ " : "");
    inner += `<div class="fade"></div>
      <div class="clip-label">${badge}${c.kind === "text" ? "T · " + (c.props.text || "").split("\n")[0]
        : c.kind === "adjust" ? "FX · " + c.name : c.name}</div>
      <div class="handle l"></div><div class="handle r"></div>`;
    div.innerHTML = inner;
    if (hasWave) div.classList.add("has-wave");
    row.appendChild(div);
    if (hasWave) drawClipWave(div.querySelector(".wave"), c, tr.h);
  }
  state.dirtyTimeline = false;
}

/* Render decoded peaks for the [in, in+duration] slice of the clip's media */
function drawClipWave(cv, c, trackH) {
  const peaks = runtime.wavePeaks.get(c.mediaId);
  if (!(peaks instanceof Float32Array)) return;
  const w = Math.min(2400, Math.max(8, Math.round(c.duration * state.pps)));
  const h = trackH - 8;
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d");
  g.fillStyle = "#c9f29b";
  g.globalAlpha = 0.75;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const t = mediaTimeAt(c, c.start + (x / w) * c.duration);
    const v = peaks[Math.min(peaks.length - 1, Math.floor(t * WAVE_PEAKS_PER_SEC))] || 0;
    const bh = Math.max(1, v * (h - 2));
    g.fillRect(x, mid - bh / 2, 1, bh);
  }
}

/* ── Ruler ── */
function drawRuler() {
  const cv = els.ruler, dpr = window.devicePixelRatio || 1;
  const w = els.timelineScroll.clientWidth, h = RULER_H;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const sl = els.timelineScroll.scrollLeft, pps = state.pps;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * pps >= 70) || 600;
  const minor = step / 5;
  g.strokeStyle = "#4a4a55"; g.fillStyle = "#9a9aa6"; g.font = "10px Consolas, monospace";
  g.beginPath();
  const i0 = Math.max(0, Math.floor(sl / pps / minor));
  for (let i = i0; i * minor * pps < sl + w; i++) {
    const t = i * minor;
    const x = Math.round(t * pps - sl) + 0.5;
    const isMajor = i % 5 === 0;
    g.moveTo(x, isMajor ? 8 : 17); g.lineTo(x, h);
    if (isMajor) g.fillText(fmt(Math.round(t * 1000) / 1000).slice(0, 5), x + 4, 12);
  }
  g.stroke();
  // beat/cue markers
  for (const mk of project.markers || []) {
    const x = mk.t * pps - sl;
    if (x < -6 || x > w + 6) continue;
    g.fillStyle = "#ffd166";
    g.beginPath();
    g.moveTo(x, h - 9); g.lineTo(x + 4, h - 5); g.lineTo(x, h - 1); g.lineTo(x - 4, h - 5);
    g.closePath(); g.fill();
  }
  // playhead marker on ruler
  const px = state.time * pps - sl;
  if (px >= -8 && px <= w + 8) {
    g.fillStyle = "#ff4d6a";
    g.beginPath();
    g.moveTo(px - 6, 12); g.lineTo(px + 6, 12); g.lineTo(px + 6, 19); g.lineTo(px, 25); g.lineTo(px - 6, 19);
    g.closePath(); g.fill();
  }
}

/* ── Snapping ── */
function snapTime(t, ignore) { // ignore: clip id, Set of ids, or null
  if (!state.snap) return t;
  const ign = ignore instanceof Set ? ignore : new Set(ignore ? [ignore] : []);
  const tol = SNAP_PX / state.pps;
  const cands = [0, state.time];
  for (const mk of project.markers || []) cands.push(mk.t);
  for (const c of project.clips) {
    if (ign.has(c.id)) continue;
    cands.push(c.start, clipEnd(c));
  }
  let best = t, bd = tol;
  for (const s of cands) {
    const d = Math.abs(s - t);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/* ── Pointer interactions on timeline ── */
function timeAtEvent(e) {
  const rect = els.timelineScroll.getBoundingClientRect();
  return clamp((e.clientX - rect.left + els.timelineScroll.scrollLeft) / state.pps, 0, 1e6);
}
function trackAtEvent(e) {
  for (const row of els.tracks.children) {
    const r = row.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY < r.bottom) return row.dataset.track;
  }
  return null;
}

els.tracksContent.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const clipDiv = e.target.closest(".clip");
  if (!clipDiv) {
    // empty track background: drag = marquee select, plain click = seek + deselect
    startMarquee(e);
    return;
  }
  const c = getClip(clipDiv.dataset.id);
  if (!c) return;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  if (additive) {
    selectClip(c.id, { toggle: true });
    if (!state.selIds.has(c.id)) return; // toggled off — nothing to drag
  } else if (!state.selIds.has(c.id)) {
    selectClip(c.id);
  } else if (state.selId !== c.id) {
    // grabbing inside an existing multi-selection: keep the group, retarget the inspector
    state.selId = c.id;
    state.dirtyTimeline = true;
    renderInspector();
  }
  const mode = e.target.classList.contains("handle")
    ? (e.target.classList.contains("l") ? "trim-l" : "trim-r") : "move";
  // a plain click (no drag) on a multi-selection collapses it to that clip on release
  startClipGesture(e, c, mode, !additive && state.selIds.size > 1);
});

function startClipGesture(e, c, mode, collapseOnClick) {
  e.preventDefault();
  state.gesture = true;
  const media = getMedia(c.mediaId);
  const orig = {
    start: c.start, in: c.in, duration: c.duration, track: c.track,
    keyframes: c.keyframes ? JSON.parse(JSON.stringify(c.keyframes)) : undefined,
  };
  // moving a clip that belongs to a multi-selection drags the whole group
  const group = mode === "move" && state.selIds.has(c.id) ? selectedClips() : [c];
  const groupOrig = new Map(group.map((x) => [x.id, x.start]));
  const groupIds = new Set(group.map((x) => x.id));
  const t0 = timeAtEvent(e);
  let moved = false;
  const snapshot = JSON.stringify(project.clips);

  const onMove = (ev) => {
    const dt = timeAtEvent(ev) - t0;
    if (Math.abs(dt * state.pps) > 3) moved = true;
    if (!moved) return;
    if (mode === "move") {
      let ns = snapTime(orig.start + dt, groupIds);
      const nsEnd = snapTime(orig.start + orig.duration + dt, groupIds);
      if (Math.abs(nsEnd - (orig.start + orig.duration + dt)) < Math.abs(ns - (orig.start + dt)))
        ns = nsEnd - orig.duration;
      // one time-delta for the whole group, clamped so nothing crosses 0
      let d = ns - orig.start;
      d = Math.max(d, -Math.min(...group.map((x) => groupOrig.get(x.id))));
      for (const x of group) x.start = groupOrig.get(x.id) + d;
      if (group.length === 1) {
        const tk = trackAtEvent(ev);
        if (tk) {
          const trk = TRACKS.find((t) => t.id === tk);
          if (trk && (c.kind === "audio") === (trk.kind === "audio")) c.track = tk;
        }
      }
    } else if (mode === "trim-l") {
      let ns = snapTime(orig.start + dt, c.id);
      const sp = clipSpeed(c);
      const maxShiftLeft = (c.kind === "video" || c.kind === "audio") ? orig.in / sp : 1e6;
      ns = clamp(ns, Math.max(0, orig.start - maxShiftLeft), orig.start + orig.duration - MIN_DUR);
      const d = ns - orig.start;
      c.start = ns;
      c.in = (c.kind === "video" || c.kind === "audio") ? orig.in + d * sp : 0;
      c.duration = orig.duration - d;
      c.keyframes = shiftKF(orig.keyframes, d, c.duration);
    } else { // trim-r
      let ne = snapTime(orig.start + orig.duration + dt, c.id);
      let maxDur = 1e6;
      if ((c.kind === "video" || c.kind === "audio") && media?.duration)
        maxDur = (media.duration - orig.in) / clipSpeed(c);
      c.duration = clamp(ne - orig.start, MIN_DUR, maxDur);
      c.keyframes = shiftKF(orig.keyframes, 0, c.duration);
    }
    state.dirtyTimeline = true;
    renderInspector(true);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.gesture = false;
    if (moved) {
      runtime.undo.push(snapshot);
      if (runtime.undo.length > 100) runtime.undo.shift();
      runtime.redo.length = 0;
      scheduleSave();
    } else if (collapseOnClick) {
      selectClip(c.id);
    }
    if (runtime.pendingSync) syncFromServer();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ── Marquee (rubber-band) selection on empty timeline area ──
   Drag draws a box in tracksContent space and selects every clip it touches
   (ctrl/cmd/shift keeps the existing selection). A click without drag keeps
   the old behavior: deselect + seek to the click point. */
function startMarquee(e) {
  e.preventDefault();
  state.gesture = true;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  const base = additive ? new Set(state.selIds) : new Set();
  const rect0 = els.tracksContent.getBoundingClientRect();
  const x0 = e.clientX - rect0.left, y0 = e.clientY - rect0.top;
  const rows = new Map(); // track id -> vertical band inside tracksContent
  for (const row of els.tracks.children)
    rows.set(row.dataset.track, { top: row.offsetTop, h: row.offsetHeight });
  let box = null, moved = false;

  const onMove = (ev) => {
    const r = els.tracksContent.getBoundingClientRect();
    const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
    if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
    moved = true;
    if (!box) {
      box = document.createElement("div");
      box.className = "marquee";
      els.tracksContent.appendChild(box);
    }
    const L = Math.min(x0, x1), T = Math.min(y0, y1);
    const bw = Math.abs(x1 - x0), bh = Math.abs(y1 - y0);
    Object.assign(box.style, { left: L + "px", top: T + "px", width: bw + "px", height: bh + "px" });
    const hits = new Set(base);
    for (const c of project.clips) {
      const row = rows.get(c.track);
      if (!row) continue;
      const cx0 = c.start * state.pps, cx1 = cx0 + Math.max(8, c.duration * state.pps);
      if (cx0 < L + bw && cx1 > L && row.top < T + bh && row.top + row.h > T) hits.add(c.id);
    }
    state.selIds = hits;
    // cheap live highlight — no full timeline rebuild per pointermove
    for (const div of els.tracks.querySelectorAll(".clip"))
      div.classList.toggle("selected", hits.has(div.dataset.id));
  };
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.gesture = false;
    if (box) box.remove();
    if (!moved) {
      selectClip(null);
      setTime(timeAtEvent(ev));
    } else {
      if (!state.selIds.has(state.selId)) state.selId = [...state.selIds].pop() ?? null;
      state.dirtyTimeline = true;
      renderInspector();
    }
    if (runtime.pendingSync) syncFromServer();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ── Scrubbing ── */
function startScrub(e) {
  e.preventDefault();
  state.gesture = true;
  const seek = (ev) => setTime(timeAtEvent(ev));
  seek(e);
  const onUp = () => {
    window.removeEventListener("pointermove", seek);
    window.removeEventListener("pointerup", onUp);
    state.gesture = false;
    if (runtime.pendingSync) syncFromServer();
  };
  window.addEventListener("pointermove", seek);
  window.addEventListener("pointerup", onUp);
}
els.ruler.addEventListener("pointerdown", startScrub);

function setTime(t) {
  state.time = clamp(t, 0, Math.max(projDur(), 0));
  seekMediaWhilePaused();
}

/* Add a marker at the playhead, or remove one already there (M key).
   Works while playing — tap M on the beat to lay down a beat grid. */
function toggleMarker() {
  const t = +state.time.toFixed(3);
  const tol = Math.max(0.05, SNAP_PX / state.pps);
  project.markers = project.markers || [];
  const near = project.markers.findIndex((m) => Math.abs(m.t - t) < tol);
  if (near >= 0 && !state.playing) project.markers.splice(near, 1);
  else { project.markers.push({ t }); project.markers.sort((a, b) => a.t - b.t); }
  scheduleSave();
}

/* ── Drag & drop: bin → timeline, files → window ── */
els.timelineScroll.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("text/fablecut-media")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    for (const row of els.tracks.children)
      row.classList.toggle("drop-hint", row.dataset.track === trackAtEvent(e));
  }
});
els.timelineScroll.addEventListener("dragleave", () => {
  for (const row of els.tracks.children) row.classList.remove("drop-hint");
});
els.timelineScroll.addEventListener("drop", (e) => {
  for (const row of els.tracks.children) row.classList.remove("drop-hint");
  const mid = e.dataTransfer.getData("text/fablecut-media");
  if (!mid) return;
  e.preventDefault();
  const m = getMedia(mid); if (!m) return;
  const track = trackAtEvent(e), at = snapTime(timeAtEvent(e), null);
  // library assets may not be probed yet — addLibraryItem fills metadata first
  if ((m.duration == null && m.kind !== "image" && m.kind !== "svg") ||
      (m.kind === "svg" && !runtime.mediaAux.get(m.id)?.svgText))
    addLibraryItem({ name: m.name, src: m.src }, track, at);
  else
    addClipFromMedia(m, track, at);
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer?.types.includes("Files")) { dragDepth++; document.body.classList.add("file-drag"); }
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("file-drag"); }
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  dragDepth = 0; document.body.classList.remove("file-drag");
  if (e.dataTransfer?.files.length) { e.preventDefault(); importFiles(e.dataTransfer.files); }
});

/* ── Zoom ── */
function setZoom(pps, anchorClientX) {
  const scroller = els.timelineScroll;
  const rect = scroller.getBoundingClientRect();
  const ax = anchorClientX != null ? anchorClientX - rect.left : rect.width / 2;
  const tAtAnchor = (scroller.scrollLeft + ax) / state.pps;
  state.pps = clamp(pps, 8, 300);
  els.zoomSlider.value = state.pps;
  state.dirtyTimeline = true;
  rebuildClips();
  scroller.scrollLeft = Math.max(0, tAtAnchor * state.pps - ax);
}
els.zoomSlider.addEventListener("input", () => setZoom(+els.zoomSlider.value));
els.timelineScroll.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(state.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
  }
}, { passive: false });

/* ═══════════════════════════ SELECTION & INSPECTOR ═══════════════════════ */
function setSelection(ids, primary) {
  state.selIds = new Set(ids);
  state.selId = primary !== undefined ? primary : ([...state.selIds].pop() ?? null);
  if (state.selId && !state.selIds.has(state.selId)) state.selIds.add(state.selId);
  state.dirtyTimeline = true;
  renderInspector();
}
/* Plain call replaces the selection; {toggle:true} (ctrl/cmd/shift+click)
   adds/removes the clip from it. */
function selectClip(id, opts) {
  if (opts && opts.toggle && id != null) {
    const s = new Set(state.selIds);
    if (s.has(id)) { s.delete(id); setSelection([...s]); }
    else { s.add(id); setSelection([...s], id); }
    return;
  }
  if (state.selId === id && state.selIds.size <= 1) return;
  setSelection(id == null ? [] : [id], id ?? null);
}
/* Drop selected ids whose clips no longer exist (undo/redo, external reload) */
function pruneSelection() {
  state.selIds = new Set([...state.selIds].filter((id) => getClip(id)));
  if (!state.selIds.has(state.selId)) state.selId = [...state.selIds].pop() ?? null;
}
const selectedClips = () => project.clips.filter((c) => state.selIds.has(c.id));
function renderInspector(lite) {
  const c = getClip(state.selId);
  if (!c) {
    els.inspector.innerHTML = `<div class="inspector-empty">Select a clip to edit its<br>transform, effects &amp; audio.</div>`;
    return;
  }
  if (lite) { // during gestures, just refresh timing numbers if present
    const s = els.inspector.querySelector("[data-k=start]"), d = els.inspector.querySelector("[data-k=duration]");
    if (s) s.value = c.start.toFixed(2);
    if (d) d.value = c.duration.toFixed(2);
    return;
  }
  const p = c.props;
  const kfCount = (k) => (c.keyframes && c.keyframes[k] ? c.keyframes[k].length : 0);
  const kfCtl = (k) => !ANIMATABLE.includes(k) ? "" :
    `<span class="kf-ctl"><button class="kf-btn${kfCount(k) ? " has" : ""}" data-kf="${k}" title="Set keyframe at playhead">◆${kfCount(k) || ""}</button>${kfCount(k) ? `<button class="kf-btn" data-kfclear="${k}" title="Clear keyframes">✕</button>` : ""}</span>`;
  const row = (label, inner, k = "") => `<div class="insp-row"><label>${label}</label>${inner}${k ? kfCtl(k) : ""}</div>`;
  const slider = (k, min, max, step, val, unit = "") =>
    row(k[0].toUpperCase() + k.slice(1),
      `<input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}">
       <span class="val" data-val="${k}">${val}${unit}</span>`, k);
  let html = (state.selIds.size > 1
    ? `<div class="insp-multi">${state.selIds.size} clips selected — drag moves them together, Del deletes all. Fields below edit the primary (white-outlined) clip.</div>`
    : "") + `<div class="insp-section"><h3>Clip — ${c.kind}</h3>
    ${row("Name", `<input type="text" data-k="name" value="${c.name.replace(/"/g, "&quot;")}">`)}
    ${row("Start (s)", `<input type="number" data-k="start" step="0.01" value="${c.start.toFixed(2)}">`)}
    ${row("Length (s)", `<input type="number" data-k="duration" step="0.01" value="${c.duration.toFixed(2)}">`)}
  </div>`;
  const sel = (label, k, opts, cur) => row(label,
    `<select data-k="${k}">${opts.map((o) => `<option value="${o}" ${String(o) === String(cur) ? "selected" : ""}>${o}</option>`).join("")}</select>`);
  const check = (label, k, on) => row(label, `<input type="checkbox" data-k="${k}" ${on ? "checked" : ""}>`);
  if (c.kind === "adjust") {
    html += `<div class="insp-section"><h3>Adjustment layer</h3>
      ${slider("opacity", 0, 1, 0.01, p.opacity)}
    </div>`;
  } else if (c.kind !== "audio") {
    html += `<div class="insp-section"><h3>Transform</h3>
      ${row("Position X", `<input type="number" data-k="x" value="${p.x}">`, "x")}
      ${row("Position Y", `<input type="number" data-k="y" value="${p.y}">`, "y")}
      ${slider("scale", 0.1, 4, 0.01, p.scale)}
      ${slider("rotation", -180, 180, 1, p.rotation, "°")}
      ${slider("opacity", 0, 1, 0.01, p.opacity)}
      ${sel("Blend", "blend", BLEND_MODES, p.blend)}
    </div>`;
  }
  if (c.kind === "video" || c.kind === "image" || c.kind === "svg") {
    html += `<div class="insp-section"><h3>Layout</h3>
      ${sel("Fit", "fit", ["contain", "cover", "stretch", "none"], p.fit)}
      ${row("Crop L/R %", `<input type="number" data-k="cropL" min="0" max="95" value="${p.cropL}" style="max-width:58px">
                           <input type="number" data-k="cropR" min="0" max="95" value="${p.cropR}" style="max-width:58px">`)}
      ${row("Crop T/B %", `<input type="number" data-k="cropT" min="0" max="95" value="${p.cropT}" style="max-width:58px">
                           <input type="number" data-k="cropB" min="0" max="95" value="${p.cropB}" style="max-width:58px">`)}
      ${slider("cornerRadius", 0, 300, 1, p.cornerRadius, "px")}
      ${check("Flip H", "flipH", p.flipH)}
      ${check("Flip V", "flipV", p.flipV)}
    </div>`;
  }
  if (c.kind === "video" || c.kind === "image" || c.kind === "svg" || c.kind === "adjust") {
    html += `<div class="insp-section"><h3>Filter / Color</h3>
      ${sel("Preset", "filterPreset", Object.keys(FILTER_PRESETS), p.filterPreset)}
      ${slider("brightness", 0, 200, 1, p.brightness, "%")}
      ${slider("contrast", 0, 200, 1, p.contrast, "%")}
      ${slider("saturation", 0, 200, 1, p.saturation, "%")}
      ${slider("hue", -180, 180, 1, p.hue, "°")}
      ${slider("temperature", -100, 100, 1, p.temperature)}
      ${slider("tint", -100, 100, 1, p.tint)}
      ${slider("blur", 0, 20, 0.5, p.blur, "px")}
      ${slider("grayscale", 0, 100, 1, p.grayscale, "%")}
      ${slider("sepia", 0, 100, 1, p.sepia, "%")}
      ${slider("invert", 0, 100, 1, p.invert, "%")}
      ${slider("vignette", 0, 100, 1, p.vignette, "%")}
    </div>
    <div class="insp-section"><h3>Motion FX</h3>
      ${slider("shake", 0, 40, 0.5, p.shake, "px")}
      ${slider("shakeSpeed", 1, 30, 0.5, p.shakeSpeed)}
      ${slider("rgbSplit", 0, 30, 0.5, p.rgbSplit, "px")}
      ${slider("grain", 0, 100, 1, p.grain, "%")}
    </div>`;
  }
  if (c.kind === "video" || c.kind === "image") {
    html += `<div class="insp-section"><h3>Keying / Cut-out</h3>
      ${row("Key color", `<input type="color" data-k="chromaKey" value="${p.chromaKey || "#00ff00"}">
        <button class="btn tiny${p.chromaKey ? "" : " toggle on"}" data-action="keyoff" title="Disable chroma key">off</button>`)}
      ${slider("chromaTolerance", 0, 100, 1, p.chromaTolerance)}
      ${slider("chromaSoftness", 0, 100, 1, p.chromaSoftness)}
      ${check("AI bg remove", "bgRemove", p.bgRemove)}
    </div>`;
  }
  if (c.kind === "video" || c.kind === "audio") {
    html += `<div class="insp-section"><h3>Audio / Time</h3>
      ${slider("volume", 0, 2, 0.01, p.volume)}
      ${slider("speed", 0.25, 4, 0.05, p.speed, "×")}
    </div>`;
  }
  const tsel = (label, key, tr) => row(label,
    `<select data-k="${key}">${TRANSITIONS.map((x) => `<option ${x === (tr?.type || "none") ? "selected" : ""}>${x}</option>`).join("")}</select>
     <input type="number" data-k="${key}Dur" step="0.1" min="0.1" style="max-width:58px" value="${tr?.duration ?? 1}">`);
  html += `<div class="insp-section"><h3>Transition</h3>
    ${tsel("In", "transIn", c.transitionIn)}
    ${tsel("Out", "transOut", c.transitionOut)}
  </div>`;
  if (c.kind === "text") {
    const fontGroup = (label, fonts) => fonts.length
      ? `<optgroup label="${label}">${fonts.map((f) => `<option ${f === p.font ? "selected" : ""}>${f}</option>`).join("")}</optgroup>` : "";
    const known = [...SYSTEM_FONTS, ...runtime.customFonts, ...GOOGLE_FONTS, ...runtime.googleLoaded];
    html += `<div class="insp-section"><h3>Text</h3>
      ${row("Content", `<textarea data-k="text">${p.text}</textarea>`)}
      ${slider("fontSize", 12, 300, 1, p.fontSize, "px")}
      ${row("Color", `<input type="color" data-k="color" value="${p.color}">
                      <input type="color" data-k="color2" value="${p.color2 || p.color}" title="Gradient bottom color">
                      <button class="btn tiny${p.color2 ? "" : " toggle on"}" data-action="grad-off" title="Disable gradient">flat</button>`)}
      ${sel("Align", "align", ["left", "center", "right"], p.align)}
    </div>
    <div class="insp-section"><h3>Font</h3>
      ${row("Family", `<select data-k="font">
        ${fontGroup("System", SYSTEM_FONTS)}
        ${fontGroup("Library fonts", runtime.customFonts)}
        ${fontGroup("Google fonts", [...new Set([...GOOGLE_FONTS, ...runtime.googleLoaded])])}
        ${known.includes(p.font) ? "" : `<option selected>${p.font}</option>`}
      </select>`)}
      ${row("Google font", `<input type="text" data-gfont placeholder="Type any Google Font name…">
        <button class="btn tiny" data-action="gfont-load">Load</button>`)}
      ${sel("Weight", "weight", [0, 300, 400, 500, 600, 700, 800, 900], p.weight)}
      ${check("Bold", "bold", p.bold)}
      ${check("Italic", "italic", p.italic)}
      ${check("Uppercase", "uppercase", p.uppercase)}
      ${slider("letterSpacing", -10, 60, 0.5, p.letterSpacing, "px")}
      ${slider("lineHeight", 0.7, 2.5, 0.05, p.lineHeight)}
    </div>
    <div class="insp-section"><h3>Text style</h3>
      ${slider("strokeWidth", 0, 20, 0.5, p.strokeWidth, "px")}
      ${row("Stroke col.", `<input type="color" data-k="strokeColor" value="${p.strokeColor}">`)}
      ${row("Bg color", `<input type="color" data-k="bgColor" value="${p.bgColor}">`)}
      ${slider("bgOpacity", 0, 1, 0.05, p.bgOpacity)}
      ${slider("textShadow", 0, 40, 1, p.textShadow)}
      ${slider("glow", 0, 100, 1, p.glow)}
      ${row("Glow color", `<input type="color" data-k="glowColor" value="${p.glowColor || p.color}">
        <button class="btn tiny${p.glowColor ? "" : " toggle on"}" data-action="glow-auto" title="Glow uses the text color">auto</button>`)}
    </div>
    <div class="insp-section"><h3>Title &amp; caption</h3>
      ${row("Title style", `<select data-sel="title-style">${Object.entries(TITLE_STYLES).map(([k, v]) => `<option value="${k}" ${c.styleName === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
        <button class="btn tiny" data-action="title-shuffle" title="Random style">Shuffle</button>`)}
      ${row("Animation", `<select data-k="textAnim">${TEXT_ANIMS.map((a) => `<option ${a === p.textAnim ? "selected" : ""}>${a}</option>`).join("")}</select>`)}
      ${slider("wordRate", 0.05, 0.6, 0.01, p.wordRate, "s")}
    </div>`;
  }
  els.inspector.innerHTML = html;
  els.inspector.querySelectorAll("[data-k]").forEach((input) => {
    input.addEventListener("input", () => {
      const k = input.dataset.k;
      let v = input.type === "checkbox" ? input.checked
            : input.type === "range" || input.type === "number" ? parseFloat(input.value)
            : input.value;
      if (k === "weight") v = +v || 0;
      if (k === "font") ensureFont(String(v));
      if (k === "name") { c.name = String(v); state.dirtyTimeline = true; }
      else if (k === "start") { c.start = Math.max(0, +v || 0); state.dirtyTimeline = true; }
      else if (k === "duration") { c.duration = Math.max(MIN_DUR, +v || MIN_DUR); state.dirtyTimeline = true; }
      else if (k === "transIn" || k === "transOut") {
        const key = k === "transIn" ? "transitionIn" : "transitionOut";
        const dur = Math.max(0.1, parseFloat(els.inspector.querySelector(`[data-k="${k}Dur"]`)?.value) || 1);
        c[key] = v === "none" ? undefined : { type: String(v), duration: dur };
        state.dirtyTimeline = true;
      }
      else if (k === "transInDur" || k === "transOutDur") {
        const key = k === "transInDur" ? "transitionIn" : "transitionOut";
        if (c[key]) c[key].duration = Math.max(0.1, +v || 1);
      }
      else { c.props[k] = v; if (k === "text") state.dirtyTimeline = true; }
      const valEl = els.inspector.querySelector(`[data-val="${k}"]`);
      if (valEl) valEl.textContent = input.value;
      scheduleSave();
    });
    input.addEventListener("focus", () => pushUndo(), { once: true });
  });
  els.inspector.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const a = btn.dataset.action;
      pushUndo();
      if (a === "keyoff") c.props.chromaKey = "";
      else if (a === "grad-off") c.props.color2 = "";
      else if (a === "glow-auto") c.props.glowColor = "";
      else if (a === "gfont-load") {
        const name = els.inspector.querySelector("[data-gfont]")?.value.trim();
        if (!name) return;
        ensureFont(name);
        c.props.font = name;
        toast(`Loading Google font "${name}"…`);
      }
      else if (a === "title-shuffle") {
        const keys = Object.keys(TITLE_STYLES).filter((k) => k !== "plain" && k !== c.styleName);
        applyTitleStyle(c, keys[Math.floor(Math.random() * keys.length)]);
      }
      scheduleSave(); renderInspector();
    });
  });
  els.inspector.querySelectorAll("[data-sel='title-style']").forEach((sel2) => {
    sel2.addEventListener("change", () => {
      pushUndo();
      applyTitleStyle(c, sel2.value);
      state.dirtyTimeline = true;
      scheduleSave(); renderInspector();
    });
  });
  els.inspector.querySelectorAll("[data-kf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.kf;
      const input = els.inspector.querySelector(`[data-k="${k}"]`);
      const v = input ? parseFloat(input.value) : +(c.props[k] || 0);
      if (isNaN(v)) return;
      pushUndo();
      if (!c.keyframes) c.keyframes = {};
      const arr = (c.keyframes[k] = c.keyframes[k] || []);
      const lt = +clamp(state.time - c.start, 0, c.duration).toFixed(3);
      const near = arr.find((kf) => Math.abs(kf.t - lt) < 0.5 / project.fps);
      if (near) near.v = v; else arr.push({ t: lt, v });
      arr.sort((a, b) => a.t - b.t);
      state.dirtyTimeline = true;
      scheduleSave(); renderInspector();
    });
  });
  els.inspector.querySelectorAll("[data-kfclear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pushUndo();
      delete c.keyframes[btn.dataset.kfclear];
      if (!Object.keys(c.keyframes).length) c.keyframes = undefined;
      state.dirtyTimeline = true;
      scheduleSave(); renderInspector();
    });
  });
}

/* ═══════════════════════════ PLAYBACK ENGINE ═══════════════════════════ */
function getClipEl(c) {
  let el = runtime.clipEls.get(c.id);
  if (el) return el;
  const m = getMedia(c.mediaId);
  if (!m) return null;
  el = document.createElement(c.kind === "audio" ? "audio" : "video");
  el.preload = "auto"; el.src = m.src; el.playsInline = true;
  runtime.clipEls.set(c.id, el);
  hookAudio(c, el);
  return el;
}
function releaseClipEl(id) {
  const el = runtime.clipEls.get(id);
  if (el) { try { el.pause(); el.src = ""; } catch {} runtime.clipEls.delete(id); }
  const g = runtime.clipGain.get(id);
  if (g) { try { g.disconnect(); } catch {} runtime.clipGain.delete(id); }
}
function ensureAudio() {
  if (runtime.audio) return runtime.audio;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain();
  const recDest = ctx.createMediaStreamDestination();
  master.connect(ctx.destination);
  master.connect(recDest);
  runtime.audio = { ctx, master, recDest };
  // hook any elements created before the audio context existed
  for (const [id, el] of runtime.clipEls) {
    const c = getClip(id);
    if (c) hookAudio(c, el);
  }
  return runtime.audio;
}
function hookAudio(c, el) {
  if (!runtime.audio || runtime.clipGain.has(c.id)) return;
  if (c.kind !== "video" && c.kind !== "audio") return;
  try {
    const src = runtime.audio.ctx.createMediaElementSource(el);
    const g = runtime.audio.ctx.createGain();
    src.connect(g); g.connect(runtime.audio.master);
    runtime.clipGain.set(c.id, g);
  } catch {}
}

function play() {
  if (state.playing) return;
  ensureAudio();
  runtime.audio.ctx.resume();
  if (state.time >= projDur() - 0.01) state.time = 0;
  state.playing = true;
  els.btnPlay.textContent = "⏸";
}
function pause() {
  state.playing = false;
  els.btnPlay.textContent = "▶";
  for (const el of runtime.clipEls.values()) { if (!el.paused) el.pause(); }
  if (state.exporting) finishExport(false);
}

function activeAt(c, t) { return t >= c.start && t < clipEnd(c); }

function syncMedia() {
  const t = state.time;
  for (const c of project.clips) {
    if (c.kind === "text" || c.kind === "image" || c.kind === "svg" || c.kind === "adjust") continue;
    const el = getClipEl(c); if (!el) continue;
    const p = evalProps(c, t);
    const sp = clamp(+p.speed || 1, 0.1, 8);
    const mt = mediaTimeAt(c, t);
    if (state.playing && activeAt(c, t)) {
      if (el.playbackRate !== sp) { try { el.playbackRate = sp; } catch {} }
      if (el.paused) el.play().catch(() => {});
      if (Math.abs(el.currentTime - mt) > 0.25 * sp) { try { el.currentTime = mt; } catch {} }
      const vol = clamp(p.volume, 0, 4);
      const g = runtime.clipGain.get(c.id);
      if (g) g.gain.value = vol;
      else el.volume = clamp(vol, 0, 1);
    } else if (!el.paused) {
      el.pause();
    }
  }
}
function seekMediaWhilePaused() {
  if (state.playing) return;
  const t = state.time;
  for (const c of project.clips) {
    if (c.kind !== "video") continue;
    if (!activeAt(c, t)) continue;
    const el = getClipEl(c); if (!el) continue;
    const mt = mediaTimeAt(c, t);
    if (Math.abs(el.currentTime - mt) > 0.04) { try { el.currentTime = mt; } catch {} }
  }
}

/* ── Keyframes & transitions ── */
const EASE = {
  linear: (u) => u,
  "ease-in": (u) => u * u,
  "ease-out": (u) => 1 - (1 - u) * (1 - u),
  "ease-in-out": (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
};
/* Effective properties of a clip at timeline time t: static props, overridden by
   keyframe curves, then shaped by in/out transition envelopes. */
function evalProps(c, t) {
  const p = { ...DEFAULT_PROPS, ...c.props };
  const local = t - c.start;
  if (c.keyframes) {
    for (const [k, kfs] of Object.entries(c.keyframes)) {
      if (!Array.isArray(kfs) || !kfs.length) continue;
      let v;
      if (local <= kfs[0].t) v = kfs[0].v;
      else if (local >= kfs[kfs.length - 1].t) v = kfs[kfs.length - 1].v;
      else for (let i = 0; i < kfs.length - 1; i++) {
        const a = kfs[i], b = kfs[i + 1];
        if (local >= a.t && local <= b.t) {
          const u = (local - a.t) / Math.max(1e-6, b.t - a.t);
          const ez = EASE[b.ease || "ease-in-out"] || EASE.linear;
          v = a.v + (b.v - a.v) * ez(u);
          break;
        }
      }
      if (typeof v === "number" && !isNaN(v)) p[k] = v;
    }
  }
  applyFilterPreset(p);
  const W = els.preview.width, H = els.preview.height;
  const tin = c.transitionIn, tout = c.transitionOut;
  if (tin && tin.duration > 0 && local < tin.duration)
    applyTransition(p, tin.type, 1 - EASE["ease-out"](clamp(local / tin.duration, 0, 1)), W, H, -1);
  if (tout && tout.duration > 0 && local > c.duration - tout.duration)
    applyTransition(p, tout.type,
      EASE["ease-in"](clamp((local - (c.duration - tout.duration)) / tout.duration, 0, 1)), W, H, 1);
  return p;
}
/* Merge a named look into evaluated props: % props scale, additive props add. */
function applyFilterPreset(p) {
  const fp = FILTER_PRESETS[p.filterPreset];
  if (!fp || p.filterPreset === "none") return;
  for (const [k, v] of Object.entries(fp)) {
    if (k === "brightness" || k === "contrast" || k === "saturation")
      p[k] = (+p[k] || 100) * v / 100;
    else if (k === "grayscale" || k === "sepia" || k === "vignette" || k === "invert")
      p[k] = clamp((+p[k] || 0) + v, 0, 100);
    else p[k] = (+p[k] || 0) + v;   // hue, temperature, tint, blur
  }
}
/* k: 0 = fully visible … 1 = fully transitioned away; dir: -1 = in, +1 = out */
function applyTransition(p, type, k, W, H, dir) {
  if (!(k > 0)) return;
  switch (type) {
    case "fade": case "dissolve":
      p.opacity *= 1 - k; p.volume *= 1 - k; break;
    case "slide-left":  p.x = (+p.x || 0) - dir * k * W; break;
    case "slide-right": p.x = (+p.x || 0) + dir * k * W; break;
    case "slide-up":    p.y = (+p.y || 0) - dir * k * H; break;
    case "slide-down":  p.y = (+p.y || 0) + dir * k * H; break;
    case "zoom":
      p.scale = (+p.scale || 1) * (1 - 0.6 * k); p.opacity *= 1 - k; break;
    case "wipe": case "wipe-left": p._wipe = k; p._wipeDir = "left"; break;
    case "wipe-right": p._wipe = k; p._wipeDir = "right"; break;
    case "wipe-up":    p._wipe = k; p._wipeDir = "up"; break;
    case "wipe-down":  p._wipe = k; p._wipeDir = "down"; break;
    case "iris": p._iris = k; break;
    case "spin":
      p.rotation = (+p.rotation || 0) + dir * k * 200;
      p.scale = (+p.scale || 1) * (1 - 0.4 * k);
      p.opacity *= 1 - k; break;
    case "blur":
      p.blur = (+p.blur || 0) + k * 24;
      p.opacity *= 1 - k * k; p.volume *= 1 - k; break;
    case "whip":
      p.x = (+p.x || 0) - dir * EASE["ease-in"](k) * W * 1.4;
      p.blur = (+p.blur || 0) + k * 16; break;
    case "glitch": { // RGB split + horizontal jitter, deterministic
      const j = Math.sin(k * 61.7) * Math.sin(k * 23.3);
      p.rgbSplit = (+p.rgbSplit || 0) + k * 14;
      p.x = (+p.x || 0) + j * k * W * 0.06;
      p.opacity *= 1 - k * k;
      break;
    }
    case "pop": // overshoot scale (backOut) — sticker/caption entrance
      p.scale = (+p.scale || 1) * Math.max(0.001, backOut(1 - k));
      p.opacity *= Math.min(1, (1 - k) * 2.5);
      break;
  }
}
/* Rebase clip-local keyframe times by -offset, dropping ones outside [0, dur] */
function shiftKF(kfs, offset, dur) {
  if (!kfs) return undefined;
  const out = {};
  for (const [k, arr] of Object.entries(kfs)) {
    const a = arr.map((kf) => ({ ...kf, t: +(kf.t - offset).toFixed(4) }))
      .filter((kf) => kf.t >= -1e-3 && kf.t <= dur + 1e-3);
    if (a.length) out[k] = a;
  }
  return Object.keys(out).length ? out : undefined;
}

/* ═════════════════ SVG CLIPS (Claude-authored animated vectors) ═════════════
   Animated SVGs use CSS @keyframes. The compositor freezes them at any time t
   by injecting `animation-play-state:paused` + a negative animation-delay,
   then rasterizing through an <img>. Convention for staggered starts:
   authors set `--d: 0.4s` on an element instead of a literal animation-delay. */
function parseSvgSize(txt) {
  const num = (s) => { const v = parseFloat(s); return isFinite(v) && v > 0 ? v : 0; };
  const attr = (name) => (txt.match(new RegExp(`<svg[^>]*\\s${name}="([^"%]+)"`, "i")) || [])[1];
  let w = num(attr("width")), h = num(attr("height"));
  if (!w || !h) {
    const vb = (txt.match(/<svg[^>]*\sviewBox="([^"]+)"/i) || [])[1];
    if (vb) { const p = vb.trim().split(/[\s,]+/); w = num(p[2]); h = num(p[3]); }
  }
  return { width: w || 800, height: h || 600 };
}
async function loadSvgMedia(m) {
  const txt = await (await fetch(m.src)).text();
  const { width, height } = parseSvgSize(txt);
  m.width = width; m.height = height;
  const aux = runtime.mediaAux.get(m.id) || {};
  aux.svgText = txt;
  aux.svgAnimated = /@keyframes|animation\s*:/i.test(txt);
  aux.svgFrames = new Map(); // quantized t -> HTMLImageElement (small LRU)
  aux.svgPending = null;
  runtime.mediaAux.set(m.id, aux);
  if (!aux.svgAnimated) aux.img = await loadImage(m.src);
  state.dirtyTimeline = true;
}
function svgUrlAt(aux, t) {
  const style = `<style>*{animation-play-state:paused!important;` +
    `animation-delay:calc(var(--d,0s) - ${t.toFixed(4)}s)!important}</style>`;
  const txt = aux.svgText.replace(/(<svg[^>]*>)/i, `$1${style}`);
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(txt);
}
function renderSvgFrame(aux, t) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("svg raster failed"));
    img.src = svgUrlAt(aux, t);
  });
}
/* Preview path: returns the best already-rasterized frame and schedules the
   exact one; export path awaits prepareSvgFrame() instead. */
function getSvgImage(c, t) {
  const aux = runtime.mediaAux.get(c.mediaId);
  if (!aux || !aux.svgText) return null;
  if (!aux.svgAnimated) return aux.img || null;
  const local = Math.max(0, mediaTimeAt(c, t));
  const q = Math.round(local * project.fps) / project.fps;
  const hit = aux.svgFrames.get(q);
  if (hit) return hit;
  if (!aux.svgPending) {
    aux.svgPending = renderSvgFrame(aux, q).then((img) => {
      aux.svgFrames.set(q, img);
      if (aux.svgFrames.size > 90) aux.svgFrames.delete(aux.svgFrames.keys().next().value);
      aux.lastImg = img;
    }).catch(() => {}).finally(() => { aux.svgPending = null; });
  }
  return aux.lastImg || null; // may be one frame stale during preview
}
async function prepareSvgFrame(c, t) {
  const aux = runtime.mediaAux.get(c.mediaId);
  if (!aux) return;
  if (!aux.svgText) { try { await loadSvgMedia(getMedia(c.mediaId)); } catch { return; } }
  if (!aux.svgAnimated) return;
  const local = Math.max(0, mediaTimeAt(c, t));
  const q = Math.round(local * project.fps) / project.fps;
  if (aux.svgFrames.get(q)) return;
  try {
    const img = await renderSvgFrame(aux, q);
    aux.svgFrames.set(q, img);
    if (aux.svgFrames.size > 90) aux.svgFrames.delete(aux.svgFrames.keys().next().value);
    aux.lastImg = img;
  } catch {}
}

/* ═════════════ AI BACKGROUND REMOVAL (MediaPipe selfie segmentation) ════════
   Loaded lazily from CDN the first time a clip sets props.bgRemove. Produces a
   per-clip person mask consumed by the pixel pipeline below. Degrades politely
   when offline. */
const bgSeg = { seg: null, loading: null, failed: false, queue: Promise.resolve(), masks: new Map() };
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("script load failed: " + src));
    document.head.appendChild(s);
  });
}
function ensureBgSeg() {
  if (bgSeg.seg || bgSeg.failed) return bgSeg.loading || Promise.resolve();
  if (!bgSeg.loading) {
    const base = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation";
    bgSeg.loading = loadScript(`${base}/selfie_segmentation.js`).then(() => {
      const seg = new SelfieSegmentation({ locateFile: (f) => `${base}/${f}` });
      seg.setOptions({ modelSelection: 1 });
      seg.onResults((r) => {
        if (!bgSeg.currentClip) return;
        let cv = bgSeg.masks.get(bgSeg.currentClip);
        if (!cv) { cv = document.createElement("canvas"); bgSeg.masks.set(bgSeg.currentClip, cv); }
        cv.width = r.segmentationMask.width; cv.height = r.segmentationMask.height;
        cv.getContext("2d").drawImage(r.segmentationMask, 0, 0);
      });
      bgSeg.seg = seg;
    }).catch(() => {
      bgSeg.failed = true;
      toast("Background removal unavailable — couldn't load MediaPipe (offline?). Using chroma key still works.");
    });
  }
  return bgSeg.loading;
}
/* Serialize sends; returns a promise that resolves once the mask is refreshed.
   Preview calls are dropped while one is in flight (masks lag a frame at most);
   the exporter passes force=true and awaits the exact mask. */
bgSeg.pending = 0;
function requestMask(clipId, el, force = false) {
  ensureBgSeg();
  if (!bgSeg.seg) return bgSeg.loading || Promise.resolve();
  if (!force && bgSeg.pending > 0) return Promise.resolve();
  bgSeg.pending++;
  bgSeg.queue = bgSeg.queue.then(async () => {
    if ((el.videoWidth || el.naturalWidth || 0) === 0) return;
    bgSeg.currentClip = clipId;
    try { await bgSeg.seg.send({ image: el }); } catch {}
  }).finally(() => { bgSeg.pending--; });
  return bgSeg.queue;
}

/* ═══════════ PIXEL PIPELINE (chroma key · temperature · tint · mask) ═══════
   Only used when a clip needs per-pixel work; everything else stays on the
   fast CSS-filter path. Renders into a reusable scratch canvas at destination
   resolution (capped), applies the mask + one pixel loop, hands back a canvas. */
const scratch = document.createElement("canvas");
const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
/* film-grain tile, generated once */
let grainTile = null;
function getGrainTile() {
  if (grainTile) return grainTile;
  grainTile = document.createElement("canvas");
  grainTile.width = grainTile.height = 256;
  const g = grainTile.getContext("2d");
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + Math.random() * 130;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return grainTile;
}
/* Draw a tiled grain overlay over a rect in the CURRENT transform space.
   Phase jumps per frame so grain "boils" like film. */
function drawGrain(amount, x, y, w, h, t) {
  const keepA = ctx2d.globalAlpha, keepC = ctx2d.globalCompositeOperation;
  const off = (Math.floor(t * project.fps) * 7919) % 256;
  ctx2d.globalCompositeOperation = "overlay";
  ctx2d.globalAlpha = keepA * clamp(amount / 100, 0, 1) * 0.55;
  ctx2d.save();
  ctx2d.translate(-off, off);
  ctx2d.fillStyle = ctx2d.createPattern(getGrainTile(), "repeat");
  ctx2d.fillRect(x + off, y - off, w, h);
  ctx2d.restore();
  ctx2d.globalAlpha = keepA;
  ctx2d.globalCompositeOperation = keepC;
}
/* Adjustment layers: snapshot everything drawn so far, re-draw it through this
   clip's filter stack (Premiere-style). */
const adjScratch = document.createElement("canvas");
function drawAdjust(c, W, H, t) {
  const p = evalProps(c, t);
  if (adjScratch.width !== W) adjScratch.width = W;
  if (adjScratch.height !== H) adjScratch.height = H;
  const a = adjScratch.getContext("2d");
  a.clearRect(0, 0, W, H);
  a.drawImage(els.preview, 0, 0);
  ctx2d.save();
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  if (p.shake > 0) { // whole-frame impact shake
    const s = +p.shake, tt = t * clamp(+p.shakeSpeed || 8, 0.5, 40) * Math.PI * 2;
    ctx2d.translate(
      Math.sin(tt * 1.3) * s * 0.6 + Math.sin(tt * 2.71) * s * 0.4,
      Math.cos(tt * 1.7) * s * 0.5 + Math.sin(tt * 3.13) * s * 0.35);
  }
  ctx2d.globalAlpha = clamp(p.opacity, 0, 1);
  ctx2d.filter = buildFilter(p);
  let src = adjScratch;
  if (p.temperature || p.tint || p.rgbSplit > 0)
    src = pixelPass(c, { ...p, chromaKey: "", bgRemove: false }, adjScratch, 0, 0, W, H, W, H);
  ctx2d.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, H);
  ctx2d.filter = "none";
  if (p.vignette > 0) {
    const g = ctx2d.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${clamp(p.vignette / 100, 0, 1) * 0.9})`);
    ctx2d.fillStyle = g;
    ctx2d.fillRect(0, 0, W, H);
  }
  if (p.grain > 0) drawGrain(p.grain, 0, 0, W, H, t);
  ctx2d.restore();
}
function needsPixelPass(p, c) {
  return !!(p.chromaKey || p.temperature || p.tint || p.rgbSplit > 0 ||
            (p.bgRemove && bgSeg.masks.get(c.id)));
}
function hexToRgb(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function pixelPass(c, p, src, sx, sy, sw, sh, dw, dh) {
  const w = Math.max(2, Math.min(Math.round(dw), 1920));
  const h = Math.max(2, Math.min(Math.round(dh), 1920));
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  scratchCtx.clearRect(0, 0, w, h);
  scratchCtx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const mask = p.bgRemove ? bgSeg.masks.get(c.id) : null;
  if (mask && mask.width) {
    scratchCtx.globalCompositeOperation = "destination-in";
    scratchCtx.drawImage(mask, 0, 0, w, h);
    scratchCtx.globalCompositeOperation = "source-over";
  }
  const doKey = !!p.chromaKey, temp = +p.temperature || 0, tint = +p.tint || 0;
  const split = Math.round(clamp(+p.rgbSplit || 0, 0, 60) * (w / Math.max(1, dw)));
  if (doKey || temp || tint || split > 0) {
    const img = scratchCtx.getImageData(0, 0, w, h);
    const d = img.data;
    if (split > 0) { // chromatic aberration: shift R left→, B →right
      const src2 = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) {
        const rowOff = y * w * 4;
        for (let x = 0; x < w; x++) {
          const i = rowOff + x * 4;
          d[i] = src2[rowOff + Math.min(w - 1, x + split) * 4];
          d[i + 2] = src2[rowOff + Math.max(0, x - split) * 4 + 2];
        }
      }
    }
    let kcb = 0, kcr = 0, t0 = 0, t1 = 1;
    if (doKey) {
      const [kr, kg, kb] = hexToRgb(p.chromaKey);
      kcb = 128 - 0.168736 * kr - 0.331264 * kg + 0.5 * kb;
      kcr = 128 + 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
      t0 = clamp(+p.chromaTolerance || 0, 0, 100) * 1.2;
      t1 = t0 + Math.max(1, clamp(+p.chromaSoftness || 0, 0, 100) * 1.2);
    }
    const tShift = temp * 0.6, gShift = tint * 0.5;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (doKey) {
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        const dist = Math.sqrt((cb - kcb) * (cb - kcb) + (cr - kcr) * (cr - kcr));
        if (dist < t0) { d[i + 3] = 0; continue; }
        if (dist < t1) {
          const a = (dist - t0) / (t1 - t0);
          d[i + 3] = Math.round(d[i + 3] * a);
          // spill suppression: pull the keyed hue's dominant channel down
          const avg = (r + b) / 2;
          if (g > avg) g = g * a + avg * (1 - a);
        }
      }
      if (tShift) { r += tShift; b -= tShift; }
      if (gShift) { g += gShift; }
      d[i] = clamp(r, 0, 255); d[i + 1] = clamp(g, 0, 255); d[i + 2] = clamp(b, 0, 255);
    }
    scratchCtx.putImageData(img, 0, 0);
  }
  return scratch;
}

/* ── Compositor ── */
function buildFilter(p) {
  const parts = [];
  if (p.brightness !== 100) parts.push(`brightness(${p.brightness}%)`);
  if (p.contrast !== 100) parts.push(`contrast(${p.contrast}%)`);
  if (p.saturation !== 100) parts.push(`saturate(${p.saturation}%)`);
  if (p.hue) parts.push(`hue-rotate(${p.hue}deg)`);
  if (p.blur) parts.push(`blur(${p.blur}px)`);
  if (p.grayscale) parts.push(`grayscale(${p.grayscale}%)`);
  if (p.sepia) parts.push(`sepia(${p.sepia}%)`);
  if (p.invert) parts.push(`invert(${p.invert}%)`);
  return parts.length ? parts.join(" ") : "none";
}
function drawFrame(t = state.time) {
  const W = els.preview.width, H = els.preview.height;
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.filter = "none"; ctx2d.globalAlpha = 1;
  ctx2d.fillStyle = project.background || "#000"; ctx2d.fillRect(0, 0, W, H);
  // render video tracks bottom-up (V1 under V2)
  const videoTracks = TRACKS.filter((tr) => tr.kind === "video").reverse();
  for (const tr of videoTracks) {
    const clips = project.clips
      .filter((c) => c.track === tr.id && activeAt(c, t))
      .sort((a, b) => a.start - b.start);
    for (const c of clips) drawClip(c, W, H, t);
  }
  // on-canvas selection handles (never during export or playback)
  if (!state.exporting && !state.playing) drawSelectionOverlay(W, H, t);
}

/* ═══════════ Direct manipulation on the program monitor ═══════════
   Drag a clip to move it, corner handles to resize (scale), the top
   handle to rotate. Maps gestures straight onto props.x/y/scale/rotation. */
function clipBounds(c, p, W, H) {
  const cx = W / 2 + (+p.x || 0), cy = H / 2 + (+p.y || 0);
  const rot = (p.rotation || 0) * Math.PI / 180, sc = +p.scale || 1;
  let hw, hh;
  if (c.kind === "text") {
    ctx2d.save();
    const size = p.fontSize || 72, weight = +p.weight || (p.bold ? 700 : 400);
    ctx2d.font = `${p.italic ? "italic " : ""}${weight} ${size}px "${p.font || "Segoe UI"}", sans-serif`;
    try { ctx2d.letterSpacing = `${+p.letterSpacing || 0}px`; } catch {}
    let lines = String(p.text || "").split("\n");
    if (p.uppercase) lines = lines.map((l) => l.toUpperCase());
    const tw = Math.max(1, ...lines.map((l) => ctx2d.measureText(l).width));
    const lh = size * clamp(+p.lineHeight || 1.2, 0.6, 3);
    ctx2d.restore();
    hw = (tw / 2 + size * 0.25) * sc;
    hh = (lines.length * lh / 2 + size * 0.14) * sc;
  } else {                       // media/svg: canvas-sized base box, scaled
    hw = (W / 2) * sc; hh = (H / 2) * sc;
  }
  return { cx, cy, hw, hh, rot };
}
function isVisualClip(c) { return c && c.kind !== "adjust" && c.kind !== "audio"; }
function drawSelectionOverlay(W, H, t) {
  const c = getClip(state.selId);
  if (!isVisualClip(c) || !activeAt(c, t)) return;
  const b = clipBounds(c, evalProps(c, t), W, H);
  const lw = Math.max(2, W / 640), hs = Math.max(6, W / 150), gap = Math.max(24, W / 34);
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.save();
  ctx2d.translate(b.cx, b.cy); ctx2d.rotate(b.rot);
  ctx2d.lineWidth = lw; ctx2d.strokeStyle = "#4f8cff";
  ctx2d.setLineDash([lw * 4, lw * 3]);
  ctx2d.strokeRect(-b.hw, -b.hh, b.hw * 2, b.hh * 2);
  ctx2d.setLineDash([]);
  ctx2d.beginPath(); ctx2d.moveTo(0, -b.hh); ctx2d.lineTo(0, -b.hh - gap); ctx2d.stroke();
  ctx2d.fillStyle = "#ffffff";
  for (const [x, y] of [[-b.hw, -b.hh], [b.hw, -b.hh], [b.hw, b.hh], [-b.hw, b.hh]]) {
    ctx2d.beginPath(); ctx2d.rect(x - hs, y - hs, hs * 2, hs * 2); ctx2d.fill(); ctx2d.stroke();
  }
  ctx2d.beginPath(); ctx2d.arc(0, -b.hh - gap, hs * 1.1, 0, Math.PI * 2);
  ctx2d.fillStyle = "#ffce5c"; ctx2d.fill(); ctx2d.stroke();
  ctx2d.restore();
}
function canvasPt(e) {
  const r = els.preview.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (els.preview.width / r.width),
           y: (e.clientY - r.top) * (els.preview.height / r.height) };
}
function toLocal(pt, b) {
  const dx = pt.x - b.cx, dy = pt.y - b.cy, cs = Math.cos(-b.rot), sn = Math.sin(-b.rot);
  return { x: dx * cs - dy * sn, y: dx * sn + dy * cs };
}
function pickClipAt(pt, W, H) {
  const seq = [];
  for (const tr of TRACKS.filter((tk) => tk.kind === "video").slice().reverse()) {
    for (const c of project.clips.filter((c) => c.track === tr.id && activeAt(c, state.time)).sort((a, b) => a.start - b.start))
      if (isVisualClip(c)) seq.push(c);
  }
  for (let i = seq.length - 1; i >= 0; i--) {
    const c = seq[i], b = clipBounds(c, evalProps(c, state.time), W, H), lp = toLocal(pt, b);
    if (Math.abs(lp.x) <= b.hw && Math.abs(lp.y) <= b.hh) return c;
  }
  return null;
}
let canvasDrag = null, canvasDidMove = false;
els.preview.style.touchAction = "none";
els.preview.addEventListener("pointerdown", (e) => {
  const W = els.preview.width, H = els.preview.height, pt = canvasPt(e);
  const cur = getClip(state.selId);
  canvasDrag = null;
  if (isVisualClip(cur) && activeAt(cur, state.time)) {
    const b = clipBounds(cur, evalProps(cur, state.time), W, H), lp = toLocal(pt, b);
    const hs = Math.max(6, W / 150) * 1.8, gap = Math.max(24, W / 34);
    if (Math.hypot(lp.x, lp.y + b.hh + gap) <= hs) {
      canvasDrag = { mode: "rotate", id: cur.id, startRot: +cur.props.rotation || 0, startAng: Math.atan2(pt.y - b.cy, pt.x - b.cx) };
    } else if ([[-b.hw, -b.hh], [b.hw, -b.hh], [b.hw, b.hh], [-b.hw, b.hh]].some(([cx, cy]) => Math.abs(lp.x - cx) <= hs && Math.abs(lp.y - cy) <= hs)) {
      canvasDrag = { mode: "scale", id: cur.id, startScale: +cur.props.scale || 1, startDist: Math.hypot(lp.x, lp.y) || 1 };
    } else if (Math.abs(lp.x) <= b.hw && Math.abs(lp.y) <= b.hh) {
      canvasDrag = { mode: "move", id: cur.id, startX: +cur.props.x || 0, startY: +cur.props.y || 0, startPt: pt };
    }
  }
  if (!canvasDrag) {
    const hit = pickClipAt(pt, W, H);
    if (!hit) return;
    if (hit.id !== state.selId) { selectClip(hit.id); renderInspector(); }
    canvasDrag = { mode: "move", id: hit.id, startX: +hit.props.x || 0, startY: +hit.props.y || 0, startPt: pt };
  }
  canvasDidMove = false;
  els.preview.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.preview.addEventListener("pointermove", (e) => {
  if (!canvasDrag) return;
  const c = getClip(canvasDrag.id); if (!c) return;
  const W = els.preview.width, H = els.preview.height, pt = canvasPt(e);
  if (!canvasDidMove) { pushUndo(); canvasDidMove = true; } // one undo per drag, only if it actually moves
  if (canvasDrag.mode === "move") {
    c.props.x = Math.round(canvasDrag.startX + (pt.x - canvasDrag.startPt.x));
    c.props.y = Math.round(canvasDrag.startY + (pt.y - canvasDrag.startPt.y));
  } else if (canvasDrag.mode === "scale") {
    const b = clipBounds(c, evalProps(c, state.time), W, H), lp = toLocal(pt, b);
    c.props.scale = clamp(+(canvasDrag.startScale * (Math.hypot(lp.x, lp.y) / canvasDrag.startDist)).toFixed(3), 0.05, 12);
  } else {
    const cx = W / 2 + (+c.props.x || 0), cy = H / 2 + (+c.props.y || 0);
    let deg = canvasDrag.startRot + (Math.atan2(pt.y - cy, pt.x - cx) - canvasDrag.startAng) * 180 / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    c.props.rotation = Math.round(deg);
  }
});
function endCanvasDrag(e) {
  if (!canvasDrag) return;
  canvasDrag = null;
  try { els.preview.releasePointerCapture(e.pointerId); } catch {}
  if (canvasDidMove) { scheduleSave(); renderInspector(); } // no-op on a pure click
}
els.preview.addEventListener("pointerup", endCanvasDrag);
els.preview.addEventListener("pointercancel", endCanvasDrag);

function drawClip(c, W, H, t) {
  if (c.kind === "adjust") { drawAdjust(c, W, H, t); return; }
  const p = evalProps(c, t);
  ctx2d.save();
  if (p._wipe) {
    ctx2d.beginPath();
    const k = p._wipe;
    if (p._wipeDir === "right")     ctx2d.rect(W * k, 0, W * (1 - k), H);
    else if (p._wipeDir === "up")   ctx2d.rect(0, 0, W, H * (1 - k));
    else if (p._wipeDir === "down") ctx2d.rect(0, H * k, W, H * (1 - k));
    else                            ctx2d.rect(0, 0, W * (1 - k), H);
    ctx2d.clip();
  }
  if (p._iris != null) {
    ctx2d.beginPath();
    ctx2d.arc(W / 2, H / 2, Math.max(0.01, (1 - p._iris)) * Math.hypot(W, H) * 0.55, 0, Math.PI * 2);
    ctx2d.clip();
  }
  ctx2d.globalAlpha = clamp(p.opacity, 0, 1);
  if (p.blend && p.blend !== "normal" && BLEND_MODES.includes(p.blend))
    ctx2d.globalCompositeOperation = p.blend === "normal" ? "source-over" : p.blend;
  ctx2d.translate(W / 2 + (+p.x || 0), H / 2 + (+p.y || 0));
  ctx2d.rotate((p.rotation || 0) * Math.PI / 180);
  if (p.shake > 0) { // deterministic multi-sine handheld/impact shake
    const a = +p.shake, tt = t * clamp(+p.shakeSpeed || 8, 0.5, 40) * Math.PI * 2;
    ctx2d.translate(
      Math.sin(tt * 1.3) * a * 0.6 + Math.sin(tt * 2.71) * a * 0.4,
      Math.cos(tt * 1.7) * a * 0.5 + Math.sin(tt * 3.13) * a * 0.35);
    ctx2d.rotate(Math.sin(tt * 0.9) * a * 0.0022);
  }
  if (c.kind === "text") {
    drawText(c, p, t - c.start);
    ctx2d.restore();
    return;
  }
  let src = null, sw = 0, sh = 0;
  if (c.kind === "image") {
    src = runtime.mediaAux.get(c.mediaId)?.img;
    if (src) { sw = src.naturalWidth; sh = src.naturalHeight; }
  } else if (c.kind === "svg") {
    src = getSvgImage(c, t);
    if (src) { sw = src.naturalWidth || src.width; sh = src.naturalHeight || src.height; }
  } else if (c.kind === "video") {
    src = getClipEl(c);
    if (src) { sw = src.videoWidth; sh = src.videoHeight; }
  }
  if (src && sw && sh) {
    // source crop (percent per edge)
    const sx = sw * clamp(+p.cropL || 0, 0, 95) / 100;
    const sy = sh * clamp(+p.cropT || 0, 0, 95) / 100;
    const cw = Math.max(1, sw - sx - sw * clamp(+p.cropR || 0, 0, 95) / 100);
    const ch = Math.max(1, sh - sy - sh * clamp(+p.cropB || 0, 0, 95) / 100);
    // fit → destination size
    const sc = p.scale || 1;
    let dw, dh;
    if (p.fit === "cover")        { const f = Math.max(W / cw, H / ch) * sc; dw = cw * f; dh = ch * f; }
    else if (p.fit === "stretch") { dw = W * sc; dh = H * sc; }
    else if (p.fit === "none")    { dw = cw * sc; dh = ch * sc; }
    else                          { const f = Math.min(W / cw, H / ch) * sc; dw = cw * f; dh = ch * f; }
    if (p.flipH || p.flipV) ctx2d.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
    if (p.cornerRadius > 0) {
      ctx2d.beginPath();
      ctx2d.roundRect(-dw / 2, -dh / 2, dw, dh, Math.min(+p.cornerRadius, dw / 2, dh / 2));
      ctx2d.clip();
    }
    if (p.bgRemove && c.kind === "video") requestMask(c.id, src); // refresh person mask
    if (p.bgRemove && c.kind === "image" && !bgSeg.masks.get(c.id)) requestMask(c.id, src);
    ctx2d.filter = buildFilter(p);
    if (needsPixelPass(p, c)) {
      const processed = pixelPass(c, p, src, sx, sy, cw, ch, dw, dh);
      ctx2d.drawImage(processed, 0, 0, processed.width, processed.height, -dw / 2, -dh / 2, dw, dh);
    } else {
      ctx2d.drawImage(src, sx, sy, cw, ch, -dw / 2, -dh / 2, dw, dh);
    }
    ctx2d.filter = "none";
    if (p.vignette > 0) {
      const g = ctx2d.createRadialGradient(0, 0, Math.min(dw, dh) * 0.35, 0, 0, Math.hypot(dw, dh) * 0.55);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${clamp(p.vignette / 100, 0, 1) * 0.9})`);
      ctx2d.fillStyle = g;
      ctx2d.fillRect(-dw / 2, -dh / 2, dw, dh);
    }
    if (p.grain > 0) drawGrain(p.grain, -dw / 2, -dh / 2, dw, dh, t);
  }
  ctx2d.restore();
}

/* ── Text rendering: styling (stroke / background pill) + kinetic animations.
   `local` is clip-local time in seconds. Word timing: word i enters at
   i * wordRate; each entrance animation lasts ~0.25 s. ── */
const backOut = (u) => { const c1 = 1.70158, c3 = c1 + 1; const v = u - 1; return 1 + c3 * v * v * v + c1 * v * v; };
function hexToRgba(hex, a) {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function drawText(c, p, local) {
  const size = p.fontSize || 72;
  const weight = +p.weight || (p.bold ? 700 : 400);
  ctx2d.font = `${p.italic ? "italic " : ""}${weight} ${size}px "${p.font || "Segoe UI"}", sans-serif`;
  ctx2d.textBaseline = "middle";
  try { ctx2d.letterSpacing = `${+p.letterSpacing || 0}px`; } catch {}
  ctx2d.scale(p.scale || 1, p.scale || 1);
  let rawLines = String(p.text || "").split("\n");
  if (p.uppercase) rawLines = rawLines.map((l) => l.toUpperCase());
  const lh = size * (clamp(+p.lineHeight || 1.2, 0.6, 3)), y0 = -((rawLines.length - 1) * lh) / 2;
  const anim = TEXT_ANIMS.includes(p.textAnim) ? p.textAnim : "none";
  const rate = clamp(+p.wordRate || 0.15, 0.03, 2);
  const align = p.align === "left" || p.align === "right" ? p.align : "center";
  const lineWidths = rawLines.map((ln) => ctx2d.measureText(ln).width);
  const blockW = Math.max(1, ...lineWidths);
  // anchor x of each line's center, honoring block alignment
  const lineCx = (i) => align === "left" ? -blockW / 2 + lineWidths[i] / 2
                     : align === "right" ? blockW / 2 - lineWidths[i] / 2 : 0;
  const shadowBlur = (p.textShadow === 0 ? 0 : (+p.textShadow || 12)) * size / 100;

  // background pill per line (static — anchors the animated words)
  if (p.bgOpacity > 0) {
    ctx2d.fillStyle = hexToRgba(p.bgColor || "#000", clamp(p.bgOpacity, 0, 1));
    const padX = size * 0.4, padY = size * 0.18, r = size * 0.28;
    rawLines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const w = lineWidths[i];
      const y = y0 + i * lh;
      ctx2d.beginPath();
      ctx2d.roundRect(lineCx(i) - w / 2 - padX, y - lh / 2 - padY + lh * 0.08, w + padX * 2, lh + padY * 2 - lh * 0.16, r);
      ctx2d.fill();
    });
  }

  const fillFor = (y) => {
    if (!p.color2) return p.color || "#fff";
    const g = ctx2d.createLinearGradient(0, y - size * 0.55, 0, y + size * 0.55);
    g.addColorStop(0, p.color || "#fff");
    g.addColorStop(1, p.color2);
    return g;
  };
  const paint = (str, x, y, alpha = 1) => {
    if (alpha <= 0) return;
    const keep = ctx2d.globalAlpha;
    ctx2d.globalAlpha = keep * clamp(alpha, 0, 1);
    if (p.strokeWidth > 0) {
      ctx2d.shadowColor = "transparent";
      ctx2d.lineJoin = "round"; ctx2d.miterLimit = 2;
      ctx2d.lineWidth = p.strokeWidth;
      ctx2d.strokeStyle = p.strokeColor || "#000";
      ctx2d.strokeText(str, x, y);
    }
    if (p.glow > 0) { // neon: colored halo, double-fill for intensity
      ctx2d.shadowColor = p.glowColor || p.color || "#fff";
      ctx2d.shadowBlur = (+p.glow) * size / 40;
      ctx2d.fillStyle = fillFor(y);
      ctx2d.fillText(str, x, y);
      ctx2d.fillText(str, x, y);
    } else if (shadowBlur > 0) {
      ctx2d.shadowColor = "rgba(0,0,0,.7)"; ctx2d.shadowBlur = shadowBlur; ctx2d.shadowOffsetY = shadowBlur / 3;
      ctx2d.fillStyle = fillFor(y);
      ctx2d.fillText(str, x, y);
    } else {
      ctx2d.fillStyle = fillFor(y);
      ctx2d.fillText(str, x, y);
    }
    ctx2d.shadowColor = "transparent"; ctx2d.shadowBlur = 0; ctx2d.shadowOffsetY = 0;
    ctx2d.globalAlpha = keep;
  };

  if (anim === "none") {
    ctx2d.textAlign = "center";
    rawLines.forEach((ln, i) => paint(ln, lineCx(i), y0 + i * lh));
    return;
  }
  // clip-reveal: a wipe mask sweeps each line into view, left to right
  if (anim === "clip-reveal") {
    ctx2d.textAlign = "center";
    rawLines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const u = clamp((local - i * rate) / 0.5, 0, 1);
      if (u <= 0) return;
      const e = EASE["ease-out"](u), w = lineWidths[i], cx = lineCx(i), y = y0 + i * lh;
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(cx - w / 2 - 6, y - lh / 2, (w + 12) * e, lh);
      ctx2d.clip();
      paint(ln, cx, y);
      ctx2d.restore();
    });
    return;
  }
  // zoom-in: text scales down into place with an opacity settle
  if (anim === "zoom-in") {
    ctx2d.textAlign = "center";
    rawLines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const u = clamp((local - i * rate) / 0.45, 0, 1);
      if (u <= 0) return;
      const e = EASE["ease-out"](u), s = 1.35 - 0.35 * e;
      ctx2d.save();
      ctx2d.translate(lineCx(i), y0 + i * lh);
      ctx2d.scale(s, s);
      paint(ln, 0, 0, Math.min(1, u * 1.6));
      ctx2d.restore();
    });
    return;
  }
  // rise-mask: each line rises from behind its own baseline (lower-third reveal)
  if (anim === "rise-mask") {
    ctx2d.textAlign = "center";
    rawLines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const u = clamp((local - i * rate) / 0.5, 0, 1);
      if (u <= 0) return;
      const e = EASE["ease-out"](u), cx = lineCx(i), y = y0 + i * lh;
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(cx - blockW / 2 - 24, y - lh / 2, blockW + 48, lh);
      ctx2d.clip();
      paint(ln, cx, y + (1 - e) * lh);
      ctx2d.restore();
    });
    return;
  }
  // font-cut: rhythmically swap the typeface, then settle (speed cuts)
  if (anim === "font-cut") {
    ctx2d.textAlign = "center";
    const setF = (Array.isArray(p.fontCutSet) && p.fontCutSet.length) ? p.fontCutSet : FONT_CUT_DEFAULT;
    setF.forEach(ensureFont);
    const cutDur = 0.6, interval = 0.06;
    let fam = p.font || "Segoe UI";
    if (local < cutDur) fam = setF[Math.floor(local / interval) % setF.length];
    ctx2d.font = `${p.italic ? "italic " : ""}${weight} ${size}px "${fam}", sans-serif`;
    const lw = rawLines.map((ln) => ctx2d.measureText(ln).width);
    const bw = Math.max(1, ...lw);
    const lcx = (i) => align === "left" ? -bw / 2 + lw[i] / 2
                     : align === "right" ? bw / 2 - lw[i] / 2 : 0;
    rawLines.forEach((ln, i) => { if (ln.trim()) paint(ln, lcx(i), y0 + i * lh); });
    return;
  }
  if (anim === "typewriter") {
    ctx2d.textAlign = "center";
    let budget = Math.floor(local / (rate / 4)); // rate/4 s per character
    rawLines.forEach((ln, i) => {
      const shown = ln.slice(0, Math.max(0, budget));
      budget -= ln.length;
      if (shown) paint(shown, lineCx(i) - (lineWidths[i] - ctx2d.measureText(shown).width) / 2, y0 + i * lh);
    });
    return;
  }
  // per-character animations (TikTok style)
  if (anim === "letter-pop" || anim === "wave") {
    ctx2d.textAlign = "center";
    let ci = 0;
    rawLines.forEach((ln, i) => {
      const y = y0 + i * lh;
      const chars = [...ln];
      const widths = chars.map((ch) => ctx2d.measureText(ch).width);
      const total = widths.reduce((a, b) => a + b, 0);
      let x = lineCx(i) - total / 2;
      chars.forEach((ch, j) => {
        const cx = x + widths[j] / 2;
        if (ch.trim()) {
          if (anim === "letter-pop") {
            const u = clamp((local - ci * rate / 3) / 0.18, 0, 1);
            if (u > 0) {
              ctx2d.save();
              ctx2d.translate(cx, y);
              const s = Math.max(0.001, backOut(u));
              ctx2d.scale(s, s);
              paint(ch, 0, 0, Math.min(1, u * 2.5));
              ctx2d.restore();
            }
          } else { // wave: continuous per-character sine ride
            paint(ch, cx, y + Math.sin(local * 4 + ci * 0.55) * size * 0.12);
          }
          ci++;
        }
        x += widths[j];
      });
    });
    return;
  }
  // word-based animations: lay words out manually, per-line, honoring alignment
  ctx2d.textAlign = "center";
  const spaceW = ctx2d.measureText(" ").width;
  let wi = 0;
  rawLines.forEach((ln, i) => {
    const y = y0 + i * lh;
    const words = ln.split(/\s+/).filter(Boolean);
    const widths = words.map((w) => ctx2d.measureText(w).width);
    const total = widths.reduce((a, b) => a + b, 0) + spaceW * Math.max(0, words.length - 1);
    let x = lineCx(i) - total / 2;
    words.forEach((word, j) => {
      const cx = x + widths[j] / 2;
      const u = clamp((local - wi * rate) / 0.25, 0, 1);
      if (anim === "word-pop") {
        if (u > 0) {
          ctx2d.save();
          ctx2d.translate(cx, y);
          const s = Math.max(0.001, backOut(u));
          ctx2d.scale(s, s);
          paint(word, 0, 0, Math.min(1, u * 2.5));
          ctx2d.restore();
        }
      } else if (anim === "word-slide") {
        if (u > 0) paint(word, cx, y + (1 - EASE["ease-out"](u)) * size * 0.7, u);
      } else if (anim === "bounce") { // continuous per-word hop
        paint(word, cx, y - Math.abs(Math.sin(local * 3.2 + wi * 0.9)) * size * 0.18);
      } else if (anim === "shake") { // continuous nervous jitter
        paint(word, cx + Math.sin(local * 31 + wi * 7.3) * size * 0.035,
                    y + Math.cos(local * 27 + wi * 3.1) * size * 0.035);
      } else { // karaoke: everything visible dim, spoken words at full strength
        paint(word, cx, y, u >= 1 ? 1 : 0.3 + u * 0.7);
      }
      x += widths[j] + spaceW;
      wi++;
    });
  });
}

/* ═══════════════════════════ FONTS ═══════════════════════════ */
/* Custom fonts: any .ttf/.otf/.woff/.woff2 in ./library/fonts is registered
   under its file name (sans extension). Google fonts load on demand by name. */
async function loadLibraryFonts() {
  try {
    const files = await (await fetch("/api/library?dir=fonts")).json();
    for (const f of files) {
      if (!/\.(ttf|otf|woff2?)$/i.test(f.name)) continue;
      const family = f.name.replace(/\.[^.]+$/, "");
      if (runtime.customFonts.includes(family)) continue;
      try {
        const face = new FontFace(family, `url("${f.src}")`);
        await face.load();
        document.fonts.add(face);
        runtime.customFonts.push(family);
      } catch {}
    }
    runtime.customFonts.sort();
  } catch {}
}
function ensureFont(name) {
  if (!name || SYSTEM_FONTS.includes(name) || runtime.customFonts.includes(name)) return;
  if (runtime.googleLoaded.has(name)) return;
  if (document.fonts.check(`16px "${name}"`)) return;
  runtime.googleLoaded.add(name);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=" +
    encodeURIComponent(name).replace(/%20/g, "+") + ":ital,wght@0,300..900;1,300..900&display=swap";
  document.head.appendChild(link);
}

/* ── Main loop ── */
let lastTs = null;
function loop(ts) {
  if (lastTs == null) lastTs = ts;
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (state.playing) {
    state.time += dt;
    const end = projDur();
    if (state.time >= end) {
      state.time = end;
      if (state.exporting) finishExport(true);
      else pause();
    }
    // keep playhead visible
    const px = state.time * state.pps, sc = els.timelineScroll;
    if (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 40)
      sc.scrollLeft = Math.max(0, px - 60);
  }
  if (!state.rendering) { // fast export owns media seeking + the canvas
    syncMedia();
    drawFrame();
  }
  if (state.dirtyTimeline) rebuildClips();
  els.playhead.style.left = state.time * state.pps + "px";
  drawRuler();
  updateSafeOverlay();
  els.tcCurrent.textContent = fmt(state.time);
  els.tcTotal.textContent = fmt(projDur());
  if (state.exporting && !state.rendering) {
    const pct = projDur() ? (state.time / projDur()) * 100 : 0;
    els.exportProgress.style.width = pct.toFixed(1) + "%";
    els.exportTitle.textContent = `Exporting… ${pct.toFixed(0)}%`;
  }
  requestAnimationFrame(loop);
}

/* ═══════════════════════════ EXPORT ═══════════════════════════ */
/* Two engines:
   – fast: the browser renders every frame with the normal compositor
     (frame-accurate, works unfocused) and streams JPEGs + an offline audio
     mix to the server, where ffmpeg encodes a real CRF-18 MP4.
   – realtime: the original MediaRecorder capture, kept as the fallback for
     local sessions / servers without ffmpeg. */

function openExportSetup() {
  if (state.exporting) return;
  if (!project.clips.length) { alert("Timeline is empty — add some clips first."); return; }
  const fastOk = state.connected && state.ffmpeg;
  els.engineFast.disabled = !fastOk;
  els.engineFast.checked = fastOk;
  els.engineRealtime.checked = !fastOk;
  $("engineFastNote").textContent = fastOk
    ? "Frame-accurate ffmpeg encode. Keeps rendering if you switch tabs."
    : "Needs the server + ffmpeg on PATH.";
  els.exportSetup.classList.remove("hidden");
}
function startChosenExport() {
  els.exportSetup.classList.add("hidden");
  if (els.engineFast.checked && !els.engineFast.disabled) fastExport();
  else startExport();
}

/* ── Fast export ── */
let renderCancelled = false;
function seekVideosTo(t) {
  const waits = [];
  for (const c of project.clips) {
    if (c.kind !== "video") continue;
    const el = getClipEl(c); if (!el) continue;
    if (!activeAt(c, t)) { if (!el.paused) el.pause(); continue; }
    const mt = mediaTimeAt(c, t);
    if (Math.abs(el.currentTime - mt) < 1e-4 && el.readyState >= 2) continue;
    waits.push(new Promise((res) => {
      const done = () => { clearTimeout(tm); el.removeEventListener("seeked", done); res(); };
      const tm = setTimeout(done, 1500);
      el.addEventListener("seeked", done);
      try { el.currentTime = mt; } catch { done(); }
    }));
  }
  return Promise.all(waits);
}
function encodeWAV(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const bytes = 44 + len * ch * 2;
  const ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, bytes - 8, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, len * ch * 2, true);
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const s = clamp(chans[c][i], -1, 1);
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}
/* Mix all audio-bearing clips offline, honoring volume keyframes + fades */
async function renderAudioMix(dur) {
  const jobs = [];
  for (const c of project.clips) {
    if (c.kind !== "audio" && c.kind !== "video") continue;
    const m = getMedia(c.mediaId); if (!m) continue;
    jobs.push(getAudioBuffer(m).then((buf) => ({ c, buf })).catch(() => null));
  }
  const sources = (await Promise.all(jobs)).filter(Boolean);
  if (!sources.length) return null;
  const sr = 48000;
  const off = new OfflineAudioContext(2, Math.ceil(dur * sr) + 1, sr);
  for (const { c, buf } of sources) {
    const src = off.createBufferSource(); src.buffer = buf;
    const g = off.createGain();
    const n = Math.max(2, Math.ceil(c.duration * 30));
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++)
      curve[i] = clamp(evalProps(c, c.start + (i / (n - 1)) * c.duration).volume, 0, 4);
    g.gain.setValueCurveAtTime(curve, Math.max(0, c.start), Math.max(0.01, c.duration));
    src.connect(g); g.connect(off.destination);
    if (hasSpeedRamp(c)) {
      const rc = new Float32Array(n);
      for (let i = 0; i < n; i++)
        rc[i] = clamp(kfChannel(c, "speed", (i / (n - 1)) * c.duration, clipSpeed(c)), 0.1, 8);
      src.playbackRate.setValueCurveAtTime(rc, Math.max(0, c.start), Math.max(0.01, c.duration));
      src.start(Math.max(0, c.start), Math.max(0, c.in));
      src.stop(Math.max(0, c.start) + c.duration);
    } else {
      const sp = clipSpeed(c);
      src.playbackRate.value = sp;
      src.start(Math.max(0, c.start), Math.max(0, c.in), c.duration * sp);
    }
  }
  return encodeWAV(await off.startRendering());
}
/* Frame-exact asset prep for the fast exporter: rasterize the SVG frame for
   this exact time, and refresh AI person masks synchronously. */
async function prepareFrameAssets(t) {
  for (const c of project.clips) {
    if (!activeAt(c, t)) continue;
    if (c.kind === "svg") await prepareSvgFrame(c, t);
    if (c.props?.bgRemove && (c.kind === "video" || c.kind === "image")) {
      const el = c.kind === "video" ? getClipEl(c) : runtime.mediaAux.get(c.mediaId)?.img;
      if (el) { try { await requestMask(c.id, el, true); } catch {} }
    }
  }
}
async function fastExport() {
  if (state.exporting) return;
  pause();
  state.exporting = true; state.rendering = true; renderCancelled = false;
  els.exportOverlay.classList.remove("hidden");
  els.exportProgress.style.width = "0%";
  els.exportNote.textContent = "Rendering frames → ffmpeg. You can switch tabs; export continues.";
  const fps = project.fps, dur = Math.max(1 / fps, projDur());
  const frames = Math.max(1, Math.round(dur * fps));
  let sessId = null;
  try {
    els.exportTitle.textContent = "Mixing audio…";
    const wav = await renderAudioMix(dur);
    if (renderCancelled) throw new Error("cancelled");
    const begin = await fetch("/api/export/begin", {
      method: "POST", body: JSON.stringify({ fps, name: project.name.replace(/[^\w\- ]+/g, "") || "export" }),
    }).then((r) => r.json());
    if (!begin.id) throw new Error(begin.error || "export begin failed");
    sessId = begin.id;
    if (wav) {
      const r = await fetch("/api/export/audio?id=" + sessId, { method: "POST", body: wav });
      if (!r.ok) throw new Error("audio upload failed");
    }
    try { await document.fonts.ready; } catch {}
    for (let f = 0; f < frames; f++) {
      if (renderCancelled) throw new Error("cancelled");
      const t = f / fps;
      state.time = t;                    // playhead follows the render
      await seekVideosTo(t);
      await prepareFrameAssets(t);       // exact SVG frames + AI masks
      drawFrame(t);
      const blob = await new Promise((res) => els.preview.toBlob(res, "image/jpeg", 0.95));
      const r = await fetch("/api/export/frame?id=" + sessId, { method: "POST", body: blob });
      if (!r.ok) throw new Error((await r.json()).error || "frame upload failed");
      const pct = ((f + 1) / frames) * 100;
      els.exportProgress.style.width = pct.toFixed(1) + "%";
      els.exportTitle.textContent = `Rendering… ${pct.toFixed(0)}%`;
    }
    els.exportTitle.textContent = "Encoding…";
    const end = await fetch("/api/export/end?id=" + sessId, { method: "POST" }).then((r) => r.json());
    if (!end.src) throw new Error(end.error || "encode failed");
    const a = document.createElement("a");
    a.href = end.src;
    a.download = decodeURIComponent(end.src.split("/").pop());
    a.click();
  } catch (e) {
    if (sessId) fetch("/api/export/end?id=" + sessId + "&discard=1", { method: "POST" }).catch(() => {});
    if (String(e.message) !== "cancelled") alert("Export failed: " + e.message);
  } finally {
    state.exporting = false; state.rendering = false;
    els.exportOverlay.classList.add("hidden");
    els.exportNote.textContent = "Rendering your sequence in real time. Keep this tab focused.";
    if (runtime.pendingSync) syncFromServer();
  }
}

/* ── Realtime export (MediaRecorder fallback) ── */
let recorder = null, recChunks = [], recDiscard = false;
function pickMime() {
  const cands = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4",
    "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm",
  ];
  return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}
async function startExport() {
  if (state.exporting) return;
  if (!project.clips.length) { alert("Timeline is empty — add some clips first."); return; }
  const mime = pickMime();
  if (!mime) { alert("MediaRecorder is not supported in this browser."); return; }
  ensureAudio();
  await runtime.audio.ctx.resume();
  pause();
  state.time = 0;
  seekMediaWhilePaused();
  await new Promise((r) => setTimeout(r, 350)); // let first frames decode
  const stream = els.preview.captureStream(project.fps);
  for (const tr of runtime.audio.recDest.stream.getAudioTracks()) stream.addTrack(tr);
  recChunks = []; recDiscard = false;
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    els.exportOverlay.classList.add("hidden");
    if (recDiscard || !recChunks.length) return;
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const blob = new Blob(recChunks, { type: mime.split(";")[0] });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (project.name.replace(/[^\w\- ]+/g, "") || "export") + "." + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  };
  els.exportOverlay.classList.remove("hidden");
  els.exportProgress.style.width = "0%";
  state.exporting = true;
  recorder.start(250);
  state.playing = true;
  els.btnPlay.textContent = "⏸";
}
function finishExport(keep) {
  if (!state.exporting) return;
  state.exporting = false;
  if (runtime.pendingSync) syncFromServer();
  recDiscard = !keep;
  state.playing = false;
  els.btnPlay.textContent = "▶";
  for (const el of runtime.clipEls.values()) { if (!el.paused) el.pause(); }
  if (recorder && recorder.state !== "inactive") recorder.stop();
  else els.exportOverlay.classList.add("hidden");
}

/* ═══════════════════════════ WIRING ═══════════════════════════ */
els.fileInput.addEventListener("change", () => { importFiles(els.fileInput.files); els.fileInput.value = ""; });
$("btnTitle").addEventListener("click", addTitle);
$("btnAdjust").addEventListener("click", addAdjust);
$("btnSplit").addEventListener("click", splitAtPlayhead);
$("btnDelete").addEventListener("click", deleteSelected);
$("btnExport").addEventListener("click", openExportSetup);
$("btnStartExport").addEventListener("click", startChosenExport);
$("btnCancelSetup").addEventListener("click", () => els.exportSetup.classList.add("hidden"));
$("btnCancelExport").addEventListener("click", () => {
  if (state.rendering) renderCancelled = true;
  else finishExport(false);
});
$("btnPlay").addEventListener("click", () => state.playing ? pause() : play());
$("btnHome").addEventListener("click", () => setTime(0));
$("btnEnd").addEventListener("click", () => setTime(projDur()));
$("btnBack").addEventListener("click", () => setTime(state.time - 1 / project.fps));
$("btnFwd").addEventListener("click", () => setTime(state.time + 1 / project.fps));
$("btnHelp").addEventListener("click", () => $("helpOverlay").classList.remove("hidden"));
$("btnCloseHelp").addEventListener("click", () => $("helpOverlay").classList.add("hidden"));
els.btnSnap.addEventListener("click", () => {
  state.snap = !state.snap;
  els.btnSnap.classList.toggle("on", state.snap);
});
els.binTabs.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) setBinTab(b.dataset.tab);
});

/* ── Canvas aspect presets + safe-area guides ── */
function syncAspectSel() {
  if (!els.aspectSel) return;
  const i = ASPECT_PRESETS.findIndex((a) => a.w === project.width && a.h === project.height);
  els.aspectSel.innerHTML =
    ASPECT_PRESETS.map((a, j) => `<option value="${j}" ${j === i ? "selected" : ""}>${a.label}</option>`).join("") +
    (i < 0 ? `<option value="custom" selected>Custom · ${project.width}×${project.height}</option>` : "");
}
els.aspectSel.addEventListener("change", () => {
  const a = ASPECT_PRESETS[+els.aspectSel.value];
  if (!a) return;
  project.width = a.w; project.height = a.h;
  els.preview.width = a.w; els.preview.height = a.h;
  els.monitorRes.textContent = `${a.w} × ${a.h} · ${project.fps}fps`;
  syncAspectSel();
  seekMediaWhilePaused();
  scheduleSave();
});
els.btnGuides.addEventListener("click", () => {
  state.guides = !state.guides;
  els.btnGuides.classList.toggle("on", state.guides);
  els.safeOverlay.classList.toggle("hidden", !state.guides);
});
/* Keep the guide overlay glued to the (letterboxed, CSS-scaled) canvas */
function updateSafeOverlay() {
  if (!state.guides) return;
  const stage = els.monitorStage.getBoundingClientRect();
  const cv = els.preview.getBoundingClientRect();
  const o = els.safeOverlay.style;
  o.left = (cv.left - stage.left) + "px"; o.top = (cv.top - stage.top) + "px";
  o.width = cv.width + "px"; o.height = cv.height + "px";
  els.safeOverlay.classList.toggle("vertical", project.height > project.width);
}

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); state.playing ? pause() : play(); }
  else if (k === "s" || k === "S") splitAtPlayhead();
  else if (k === "Delete" || k === "Backspace") deleteSelected();
  else if (k === "ArrowLeft") setTime(state.time - (e.shiftKey ? 1 : 1 / project.fps));
  else if (k === "ArrowRight") setTime(state.time + (e.shiftKey ? 1 : 1 / project.fps));
  else if (k === "Home") setTime(0);
  else if (k === "End") setTime(projDur());
  else if (k === "[") trimToPlayhead("in");
  else if (k === "]") trimToPlayhead("out");
  else if (k === "m" || k === "M") toggleMarker();
  else if (k === "n" || k === "N") els.btnSnap.click();
  else if (k === "Escape") selectClip(null);
  else if ((e.ctrlKey || e.metaKey) && (k === "a" || k === "A")) {
    e.preventDefault();
    setSelection(project.clips.map((c) => c.id));
  }
  else if (k === "+" || k === "=") setZoom(state.pps * 1.25);
  else if (k === "-") setZoom(state.pps / 1.25);
  else if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
  else if ((e.ctrlKey || e.metaKey) && (k === "y" || k === "Y")) { e.preventDefault(); redo(); }
});

window.addEventListener("resize", () => { state.dirtyTimeline = true; });

/* ── Boot ── */
buildTrackDOM();
rebuildClips();
renderBin();
connectServer().then(loadLibraryFonts);
requestAnimationFrame(loop);
