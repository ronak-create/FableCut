/* ═══════════════════════════════════════════════════════════════════════════
   FableCut — a browser-based non-linear video editor
   Works standalone (open index.html) or connected to server.js, which adds
   persistent projects (project.json), a media library folder, and a REST API
   so external tools (e.g. Claude Code) can edit the timeline programmatically.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── Constants ─────────────────────────────────────────────────────────── */
const VIDEO_TRACK_COLORS = ["#4f8cff", "#7b6cff", "#ffd166", "#ff6b9d", "#45d9c2", "#f4a261", "#e76f51", "#a8dadc"];
const AUDIO_TRACK_COLORS = ["#7ec249", "#5a9e3a", "#4a8a2f", "#3a7226", "#2d5a1e", "#8fbc5a", "#6b9e3a", "#4d7a28"];
const MAX_TRACKS_PER_KIND = 16; // +V/+A and auto-grown A-tracks for multi-channel sources
const DEFAULT_TRACK_DEFS = [
  { id: "V3", kind: "video" },
  { id: "V2", kind: "video" },
  { id: "V1", kind: "video" },
  { id: "A1", kind: "audio" },
  { id: "A2", kind: "audio" },
  { id: "A3", kind: "audio" },
  { id: "A4", kind: "audio" },
];
function makeTrack(id, kind) {
  const n = Math.max(1, parseInt(String(id).slice(1), 10) || 1);
  const colors = kind === "audio" ? AUDIO_TRACK_COLORS : VIDEO_TRACK_COLORS;
  return { id, kind, h: kind === "audio" ? 42 : 58, color: colors[(n - 1) % colors.length] };
}
/** Live track list (top→bottom). Mutated by +V/+A; rebuilt from project.tracks on load. */
let TRACKS = DEFAULT_TRACK_DEFS.map((d) => makeTrack(d.id, d.kind));
/* Three timeline density presets. L matches the original track heights (with thumbs).
   S is compact solid-color rows; M is in between. */
const TRACK_SIZE_PRESETS = {
  s: { thumbs: false, hVideo: 26, hAudio: 22 },
  m: { thumbs: true, hVideo: 44, hAudio: 32 },
  l: { thumbs: true, hVideo: 58, hAudio: 42 },
};
const TRACK_SIZE_KEY = "fablecut-track-size";
const LAST_TRANS_KEY = { in: "fablecut-last-trans-in", out: "fablecut-last-trans-out" };
const DEFAULT_LAST_TRANS = { type: "fade", duration: 1 };
const RULER_H = 26;
const SNAP_PX = 8;
const MIN_DUR = 0.05;
const ZOOM_MIN = 1;
const ZOOM_MAX = 300;
const TIMELINE_PAD_SEC = 15; // trailing empty seconds in the scrollable content
const TIMELINE_FIT_FILL = 0.95; // ⇧Z / Fit — clip content fills this fraction of the viewport

const DEFAULT_PROPS = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1, pan: 0,
  gain: 0,                                     // clip gain, dB — applied before volume
  channelMode: "stereo",                       // stereo | mono | left | right | swap
  duck: 0,                                     // ducking, dB (≤ 0) — keyframed by Auto-duck, multiplies volume
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
  textAnim: "none", wordRate: 0.15, direction: "auto",
  strokeWidth: 0, strokeColor: "#000000", bgColor: "#000000", bgOpacity: 0,
  boxW: 0, boxH: 0,                            // text box (px); 0 = hug content. Resize handles edit these.
  boxFit: false,                               // false = wrap at fixed fontSize; true = scale font to fit box
  vAlign: "middle",                            // top | middle | bottom — vertical align of the text block in the box
};
const ANIMATABLE = ["x", "y", "scale", "rotation", "opacity", "volume", "pan", "duck", "speed",
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
  cinematic: { contrast: 112, saturation: 118, temperature: -10, vignette: 28 },
  "teal-orange": { contrast: 115, saturation: 125, temperature: -18, hue: -8, vignette: 22 },
  noir: { grayscale: 100, contrast: 128, brightness: 96, vignette: 45 },
  vintage: { sepia: 42, contrast: 92, brightness: 106, saturation: 88, temperature: 12, vignette: 30 },
  faded: { contrast: 84, brightness: 110, saturation: 82 },
  warm: { temperature: 28, brightness: 103, saturation: 108 },
  cold: { temperature: -28, saturation: 104 },
  pop: { saturation: 152, contrast: 116 },
  dreamy: { brightness: 109, saturation: 112, blur: 0.6, temperature: 8 },
  retro: { saturation: 130, hue: -6, contrast: 106, sepia: 15 },
  "bw-soft": { grayscale: 100, contrast: 95, brightness: 108 },
  cyberpunk: { saturation: 140, hue: 12, contrast: 118, temperature: -15, vignette: 25 },
  sunset: { temperature: 24, tint: 6, brightness: 105, saturation: 116, contrast: 104, vignette: 20 },
  midnight: { temperature: -24, brightness: 88, contrast: 122, saturation: 94, vignette: 38 },
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
  plain: { label: "Plain", place: "center", props: { font: "Segoe UI", fontSize: 72, bold: true, color: "#ffffff", textAnim: "none" } },
  impact: { label: "Impact", place: "lower", props: { font: "Anton", fontSize: 96, bold: false, uppercase: true, color: "#ffffff", textShadow: 22, textAnim: "word-pop" } },
  elegant: { label: "Elegant", place: "center", props: { font: "Playfair Display", fontSize: 88, bold: false, color: "#ffffff", color2: "#ffd166", letterSpacing: 2, textAnim: "clip-reveal" } },
  kinetic: { label: "Kinetic cut", place: "center", props: { font: "Bebas Neue", fontSize: 120, bold: false, uppercase: true, color: "#ffd166", letterSpacing: 3, textAnim: "font-cut", fontCutSet: ["Anton", "Bebas Neue", "Archivo Black", "Oswald"] } },
  neon: { label: "Neon", place: "center", props: { font: "Bebas Neue", fontSize: 104, bold: false, uppercase: true, color: "#ffffff", glow: 60, glowColor: "#22d3ee", textAnim: "wave" } },
  handwritten: { label: "Handwritten", place: "lower-left", props: { font: "Caveat", fontSize: 92, bold: false, color: "#ffffff", rotation: -4, textAnim: "word-slide" } },
  serifDrop: { label: "Serif drop", place: "center", props: { font: "Abril Fatface", fontSize: 96, bold: false, color: "#ffffff", textShadow: 18, textAnim: "zoom-in" } },
  subtitle: { label: "Subtitle", place: "lower", props: { font: "Roboto", fontSize: 52, bold: false, color: "#ffffff", bgColor: "#000000", bgOpacity: 0.5, textAnim: "karaoke" } },
  boldRise: { label: "Bold rise", place: "lower", props: { font: "Archivo Black", fontSize: 92, bold: false, uppercase: true, color: "#ffffff", textAnim: "rise-mask" } },
  luxury: { label: "Luxury", place: "center", props: { font: "Cinzel", fontSize: 88, bold: false, uppercase: true, color: "#faf0dc", color2: "#c9a227", letterSpacing: 6, textAnim: "clip-reveal" } },
};
const STYLE_CYCLE = ["impact", "elegant", "kinetic", "neon", "handwritten", "serifDrop", "boldRise", "luxury"];
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
const FPS_PRESETS = [24, 25, 30, 50, 60];
/** Delivery-aspect presets fitted inside the composition canvas (export crop). */
const EXPORT_FRAME_ASPECTS = [
  { label: "Full canvas", w: 0, h: 0 },
  { label: "9:16 Reel", w: 9, h: 16 },
  { label: "16:9", w: 16, h: 9 },
  { label: "4:5 IG", w: 4, h: 5 },
  { label: "1:1 Square", w: 1, h: 1 },
];
const WAVE_PEAKS_PER_SEC = 50;
/* ── Mixer levels (dB). Clip gain is a trim before volume; track and master
   faders sit on the buses. A fader at its floor is silence, not −60 dB. ── */
const CLIP_GAIN_MIN = -60, CLIP_GAIN_MAX = 24;
const FADER_DB_MIN = -60, FADER_DB_MAX = 12;
const CHANNEL_MODES = ["stereo", "mono", "left", "right", "swap"];
function dbToGain(db) {
  db = +db;
  if (!Number.isFinite(db)) return 1;
  return db <= FADER_DB_MIN ? 0 : Math.pow(10, db / 20);
}
function clampFaderDb(db) { return clamp(+db || 0, FADER_DB_MIN, FADER_DB_MAX); }
/** What a clip's evaluated props send to its vol stage: volume × duck. */
function clipAudioGain(p) {
  const vol = clamp(+p.volume || 0, 0, 4);
  return p.duck < 0 ? vol * dbToGain(p.duck) : vol;
}
function clipGainDb(c) { return clamp(+c?.props?.gain || 0, CLIP_GAIN_MIN, CLIP_GAIN_MAX); }
function clipChannelMode(c) {
  const m = c?.props?.channelMode;
  return CHANNEL_MODES.includes(m) ? m : "stereo";
}
function trackGainDb(id) { return clampFaderDb(TRACKS.find((t) => t.id === id)?.gain); }
function trackPanValue(id) { return clipPan(TRACKS.find((t) => t.id === id)?.pan); }
function masterGainDb() { return clampFaderDb(project.master?.gain); }
/** project.master on disk: {gain?, fx?}, written only when off-default. */
function normalizeMaster(raw) {
  const gain = clampFaderDb(raw?.gain);
  const fx = normFx(raw?.fx);
  if (!gain && !fx) return null;
  const out = {};
  if (gain) out.gain = gain;
  if (fx) out.fx = fx;
  return out;
}
/* Submix buses: project.buses = [{id:"B1", name?, gain?, pan?, mute?, fx?}].
   An A-track routes into one with tracks[].out = "B1" (default: the master);
   a bus has its own effects, fader and pan and feeds the master. */
const BUS_MAX = 8;
const BUS_COLOR = "#c58cff";
function normalizeBuses(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), out = [];
  for (const b of raw) {
    if (!b || !/^B\d+$/.test(String(b.id)) || seen.has(b.id) || out.length >= BUS_MAX) continue;
    seen.add(b.id);
    const d = { id: b.id };
    if (typeof b.name === "string" && b.name.trim()) d.name = b.name.trim().slice(0, 40);
    const g = Math.round(clampFaderDb(b.gain) * 10) / 10;
    if (g) d.gain = g;
    const pn = clipPan(b.pan);
    if (pn) d.pan = pn;
    if (b.mute === true) d.mute = true;
    const fx = normFx(b.fx);
    if (fx) d.fx = fx;
    out.push(d);
  }
  return out.sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
}
function busById(id) { return (project.buses || []).find((b) => b.id === id) || null; }
function busIdsNow() { return (project.buses || []).map((b) => b.id); }
function busLabel(b) { return b?.name || b?.id || ""; }
/** The bus an A-track feeds, or null for the master. */
function trackOut(id) {
  const o = TRACKS.find((t) => t.id === id)?.out;
  return o && busById(o) ? o : null;
}
const TRACK_IDS = new Set(TRACKS.map((t) => t.id));
function syncTrackIds() {
  TRACK_IDS.clear();
  for (const t of TRACKS) TRACK_IDS.add(t.id);
}
function serializeTracks() {
  // Mixer settings are written only when off-default, so untouched projects
  // stay byte-identical.
  return TRACKS.map(({ id, kind, gain, pan, fx, out }) => {
    const d = { id, kind };
    if (kind === "audio" && +gain) d.gain = +gain;
    if (kind === "audio" && +pan) d.pan = +pan;
    if (kind === "audio" && fx?.length) d.fx = fx;
    if (kind === "audio" && out && busById(out)) d.out = out;
    return d;
  });
}
function sortTracksInPlace() {
  const vids = TRACKS.filter((t) => t.kind === "video")
    .sort((a, b) => (parseInt(b.id.slice(1), 10) || 0) - (parseInt(a.id.slice(1), 10) || 0));
  const auds = TRACKS.filter((t) => t.kind === "audio")
    .sort((a, b) => (parseInt(a.id.slice(1), 10) || 0) - (parseInt(b.id.slice(1), 10) || 0));
  TRACKS.length = 0;
  TRACKS.push(...vids, ...auds);
  syncTrackIds();
}
function applyTracksFromProject(defs) {
  const raw = Array.isArray(defs) && defs.length
    ? defs.filter((d) => d && d.id && (d.kind === "video" || d.kind === "audio"))
    : DEFAULT_TRACK_DEFS;
  const seen = new Set();
  const list = raw.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
  TRACKS.length = 0;
  for (const d of list) {
    const t = makeTrack(d.id, d.kind === "audio" ? "audio" : "video");
    if (t.kind === "audio") {
      if (+d.gain) t.gain = clampFaderDb(d.gain);
      if (+d.pan) t.pan = clipPan(d.pan);
      const fx = normFx(d.fx);
      if (fx) t.fx = fx;
      if (typeof d.out === "string" && /^B\d+$/.test(d.out)) t.out = d.out;
    }
    TRACKS.push(t);
  }
  sortTracksInPlace();
  applyTrackHeights();
}
/** Ensure every clip.track exists (agents may reference V4+ before the UI adds it). */
function ensureTracksCoverClips() {
  let added = false;
  for (const c of project.clips) {
    if (!c.track || TRACK_IDS.has(c.track)) continue;
    const kind = c.kind === "audio" || /^A\d+$/i.test(c.track) ? "audio" : "video";
    TRACKS.push(makeTrack(c.track, kind));
    TRACK_IDS.add(c.track); // mark present before later clips (avoids duplicate makeTrack)
    added = true;
  }
  if (added) {
    sortTracksInPlace();
    applyTrackHeights();
  }
}
function audioTrackIds() {
  return TRACKS.filter((t) => t.kind === "audio").map((t) => t.id);
}
function nextTrackId(kind) {
  const prefix = kind === "audio" ? "A" : "V";
  let max = 0;
  for (const t of TRACKS) {
    if (t.kind !== kind) continue;
    const n = parseInt(t.id.slice(1), 10);
    if (n > max) max = n;
  }
  return prefix + (max + 1);
}
function addTimelineTrack(kind) {
  const existing = TRACKS.filter((t) => t.kind === kind).length;
  if (existing >= MAX_TRACKS_PER_KIND) {
    toast(`Maximum ${MAX_TRACKS_PER_KIND} ${kind} tracks`);
    return null;
  }
  const id = nextTrackId(kind);
  const t = makeTrack(id, kind);
  TRACKS.push(t);
  sortTracksInPlace();
  applyTrackHeights();
  project.tracks = serializeTracks();
  if (state.soloId && state.soloId !== id) {
    state.disabledTracks.add(id);
    project.disabledTracks = [...state.disabledTracks].sort();
  }
  if (kind === "audio") syncAudioGraphTracks();
  buildTrackDOM();
  syncAllTrackDisabledUI();
  state.dirtyTimeline = true;
  rebuildClips();
  const h = setTimelineHeight(Math.max(
    $("timelinePanel")?.getBoundingClientRect().height || 0,
    defaultTimelineHeight()
  ));
  localStorage.setItem(TL_H_KEY, String(h));
  scheduleSave();
  return t;
}
function trackHasClips(trackId) {
  return project.clips.some((c) => c.track === trackId);
}
function canRemoveTrack(trackId) {
  const t = TRACKS.find((x) => x.id === trackId);
  if (!t) return { ok: false, reason: "Unknown track" };
  if (trackHasClips(trackId)) return { ok: false, reason: "Track has clips" };
  if (TRACKS.filter((x) => x.kind === t.kind).length <= 1)
    return { ok: false, reason: `Keep at least one ${t.kind} track` };
  return { ok: true, reason: "" };
}
function removeTimelineTrack(trackId) {
  const check = canRemoveTrack(trackId);
  if (!check.ok) { toast(check.reason); return false; }
  const wasAudio = TRACKS.find((t) => t.id === trackId)?.kind === "audio";
  const idx = TRACKS.findIndex((t) => t.id === trackId);
  if (idx < 0) return false;
  if (state.soloId === trackId) clearTrackSolo({ restore: true });
  TRACKS.splice(idx, 1);
  syncTrackIds();
  if (state.disabledTracks.has(trackId)) {
    state.disabledTracks.delete(trackId);
    project.disabledTracks = [...state.disabledTracks].sort();
  }
  state.lockedTracks.delete(trackId);
  state.untargetedTracks.delete(trackId);
  project.lockedTracks = [...state.lockedTracks].sort();
  project.untargetedTracks = [...state.untargetedTracks].sort();
  if (Array.isArray(state.soloRestore)) {
    state.soloRestore = state.soloRestore.filter((id) => id !== trackId);
  }
  project.tracks = serializeTracks();
  if (wasAudio) syncAudioGraphTracks();
  buildTrackDOM();
  syncAllTrackDisabledUI();
  state.dirtyTimeline = true;
  rebuildClips();
  scheduleSave();
  return true;
}
/* Lightweight right-click menu for track headers. */
let trackCtxMenu = null;
function hideTrackCtxMenu() {
  if (trackCtxMenu) { trackCtxMenu.remove(); trackCtxMenu = null; }
}
function showTrackCtxMenu(clientX, clientY, track) {
  hideTrackCtxMenu();
  const check = canRemoveTrack(track.id);
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.id = "trackCtxMenu";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ctx-item";
  btn.textContent = "Remove track";
  if (!check.ok) {
    btn.disabled = true;
    btn.title = check.reason;
  } else {
    btn.addEventListener("click", () => {
      hideTrackCtxMenu();
      removeTimelineTrack(track.id);
    });
  }
  menu.appendChild(btn);
  document.body.appendChild(menu);
  trackCtxMenu = menu;
  const pad = 6;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let x = clientX, y = clientY;
  if (x + w + pad > window.innerWidth) x = window.innerWidth - w - pad;
  if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
  menu.style.left = Math.max(pad, x) + "px";
  menu.style.top = Math.max(pad, y) + "px";
  btn.focus();
}
/* Clip right-click menu: enable / lock / link for the clip's selection. */
function showClipCtxMenu(clientX, clientY, c) {
  hideTrackCtxMenu();
  if (!state.selIds.has(c.id)) selectClip(c.id);
  const group = withLinked(selectedClips());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.id = "trackCtxMenu";
  const item = (label, keys, run, disabledReason) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-item";
    btn.innerHTML = `<span>${escapeHtml(label)}</span>` + (keys ? `<kbd>${escapeHtml(keys)}</kbd>` : "");
    if (disabledReason) { btn.disabled = true; btn.title = disabledReason; }
    else btn.addEventListener("click", () => { hideTrackCtxMenu(); run(); });
    menu.appendChild(btn);
    return btn;
  };
  const anyEnabled = group.some((x) => x.disabled !== true);
  const anyUnlocked = group.some((x) => x.locked !== true);
  const locked = group.some(isClipLocked);
  item(anyEnabled ? "Disable clip" : "Enable clip", "Shift+E", toggleClipsDisabled,
    locked ? "Locked — unlock to change" : null);
  item(anyUnlocked ? "Lock clip" : "Unlock clip", "", toggleClipsLocked);
  if (group.some((x) => x.kind === "audio")) {
    item("Crossfade with neighbours", "Shift+D", () => crossfadeSelected(), locked ? "Locked — unlock to change" : null);
    item("Auto-duck under other tracks", "", () => autoDuckClips(selectedClips()), locked ? "Locked — unlock to change" : null);
  }
  const linked = selectedClips().some((x) => x.linkGroup || x.linkedId);
  if (linked) item("Unlink audio / video", "Ctrl+L", toggleLinkSelected, locked ? "Locked — unlock to change" : null);
  else if (c.kind === "video" || c.kind === "audio") {
    const why = linkRefusal(selectedClips());
    item("Link audio / video", "Ctrl+L", toggleLinkSelected, why);
  }
  document.body.appendChild(menu);
  trackCtxMenu = menu;
  const pad = 6;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let x = clientX, y = clientY;
  if (x + w + pad > window.innerWidth) x = window.innerWidth - w - pad;
  if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
  menu.style.left = Math.max(pad, x) + "px";
  menu.style.top = Math.max(pad, y) + "px";
  menu.querySelector(".ctx-item:not(:disabled)")?.focus();
}
document.addEventListener("pointerdown", (e) => {
  if (trackCtxMenu && !trackCtxMenu.contains(e.target)) hideTrackCtxMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideTrackCtxMenu();
}, true);

/* ── User settings (localStorage; optional behavior toggles) ── */
const SETTINGS_KEY = "fablecut-settings";
const DEFAULT_SETTINGS = {
  linkSelect: false, // timeline ↔ project bin selection sync
  encodeProfile: null, // null = server default from encoding-profiles.json
  // WebCodecs has no CRF — bitrate (Mbps) + constant|variable mode
  webCodecsBitrateMbps: null, // null = auto from canvas size
  webCodecsBitrateMode: "variable", // "variable" | "constant"
  snapTargets: { clips: true, playhead: true, markers: true, inout: true, keyframes: false, frames: true },
};
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!raw || typeof raw !== "object") { settings = { ...DEFAULT_SETTINGS }; return; }
    const next = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (Object.hasOwn(raw, k)) next[k] = raw[k];
    }
    // coerce WebCodecs bitrate settings
    const mbps = next.webCodecsBitrateMbps;
    if (mbps != null) {
      const n = Number(mbps);
      next.webCodecsBitrateMbps = (Number.isFinite(n) && n > 0) ? n : null;
    }
    if (next.webCodecsBitrateMode !== "constant" && next.webCodecsBitrateMode !== "variable") {
      next.webCodecsBitrateMode = "variable";
    }
    const st = next.snapTargets;
    next.snapTargets = { ...DEFAULT_SETTINGS.snapTargets };
    if (st && typeof st === "object") {
      for (const k of Object.keys(next.snapTargets)) if (typeof st[k] === "boolean") next.snapTargets[k] = st[k];
    }
    settings = next;
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { }
}
function getSetting(key) {
  return settings[key];
}
function setSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return;
  settings[key] = value;
  saveSettings();
}

/* ── State ─────────────────────────────────────────────────────────────── */
const project = {
  name: "Untitled Project",
  width: 1280, height: 720, fps: 30, // overwritten by project.json / applyProject
  background: "#000000",
  revision: 0,
  folders: [], // {id, name, parentId:null|string, open:true} — Project-bin tree (virtual)
  media: [],   // {id, name, kind, src, duration, width?, height?, folderId?}
  clips: [],   // {id, mediaId, kind, track, start, in, duration, name, props:{}}
  markers: [], // {t, label?} — beat/cue markers on the ruler; snap targets
  inPoint: null,  // timeline work-area IN (seconds), or null
  outPoint: null, // timeline work-area OUT (seconds), or null
  disabledTracks: [], // track ids (V4…A3) hidden from preview/export when listed
  lockedTracks: [],     // track ids no edit may change (UI and MCP patch)
  untargetedTracks: [], // track ids edits skip (split, insert, ripple, close gap…)
  exportFrame: null, // optional {x,y,w,h} delivery crop inside width×height canvas
  encodeProfile: null, // optional fast-export profile id (overrides browser setting)
  tracks: null, // optional [{id, kind, gain?, pan?}] — null means default V3…V1 + A1…A4
  master: null, // optional {gain} — master bus fader (dB)
  buses: [],    // submix buses [{id:"B1", name?, gain?, pan?, mute?, fx?}]; tracks[].out routes into one
  panSchema: 1, // 1 = pan-aware; gates one-time L/R stem migration on load
};
/** Sole runtime FPS source — always the loaded project’s `fps`. */
function projectFps() {
  const n = Number(project.fps);
  return (Number.isFinite(n) && n > 0) ? n : 1;
}
const state = {
  time: 0, playing: false, pps: 60, snap: true,
  previewRate: 1,        // playback speed for PREVIEW only — never affects export
  selId: null,           // primary selection (drives the inspector)
  selIds: new Set(),     // full multi-selection (includes selId)
  trackSize: "l",        // s | m | l — timeline track density preset
  connected: false, exporting: false,
  rendering: false,      // fast (server/ffmpeg) export in progress
  guides: false,         // safe-area overlay on the monitor
  exportFrameView: true, // export frame overlay (border + overscan dim)
  exportFrameCrop: false, // clip preview to the export frame (hide overscan)
  viewZoom: 1,           // program-monitor display zoom (1 = fit stage)
  monitorMode: "program", // "source" | "program" — single-viewer Avid-style toggle
  source: {              // Source monitor (media-local; not timeline)
    mediaId: null,
    time: 0,
    playing: false,
    in: null,            // media-time mark, or null
    out: null,
    fromClipId: null,    // set when loaded from a timeline clip (informational)
  },
  audioHold: false,      // while paused, loop one frame of audio at the playhead
  ffmpeg: false,         // server reports ffmpeg available
  webCodecs: false,      // VideoEncoder + Annex-B H.264 supported
  dirtyTimeline: true, gesture: false,
  workAreaPlay: false,   // when true, play + Home/End stay inside IN/OUT
  binTab: "project",     // project | elements | sfx | svg
  disabledTracks: new Set(), // mirror of project.disabledTracks for fast lookup
  lockedTracks: new Set(),   // mirror of project.lockedTracks
  untargetedTracks: new Set(), // mirror of project.untargetedTracks
  tool: "select",            // timeline edit tool: select | ripple | roll | slip | slide
  soloId: null,              // track id when solo is active, else null
  soloRestore: null,         // disabledTracks snapshot taken when solo engaged
  transFocus: null,      // "in" | "out" — inspector transition row highlighted
  kfGraphs: new Set(),   // animatable prop keys with open monitor graphs
};
function normalizeDisabledTracks(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [];
  return [...new Set(arr.filter((id) => TRACK_IDS.has(id)))].sort();
}
function isTrackEnabled(id) {
  return !state.disabledTracks.has(id);
}
/* ── Track targeting, locks and clip enable ──
   Three independent switches, Premiere-style:
   • enabled (eye)  — output only: hidden from preview, audio and export.
   • targeted       — which lanes an edit touches: split, insert, ripple
                      delete, close gap, T / ⇧T, jump-to-cut, Source placement.
   • locked         — nothing may change it: not the mouse, not the keyboard,
                      not a ripple (locked lanes stay put while others shift).
   A clip can also be locked or disabled on its own. A linked A/V group with
   any locked member counts as locked as a whole, so sync lock never splits it. */
function isTrackTargeted(id) { return !state.untargetedTracks.has(id); }
function isTrackLocked(id) { return state.lockedTracks.has(id); }
/* Timeline edit ops (split, ripple, insert, trims, crossfade…) live in
   edit-ops.js, shared with the MCP server so an agent's patch op and the
   editor's shortcut run the same code. The wrappers below add undo,
   selection, toasts and saving. */
const EDIT = FableCutEdit.create({
  doc: () => project,
  tracks: () => TRACKS,
  trackLocked: (id) => isTrackLocked(id),
  trackTargeted: (id) => isTrackTargeted(id),
  uid: () => uid(),
  mediaTimeAt: (c, t) => mediaTimeAt(c, t),
  onRemove: (c) => releaseClipEl(c.id),
  onPlace: (m, c) => {
    if (m.kind === "video" || m.kind === "audio") ensureWave(m);
    if (m.kind === "video" && c) reconcileAudioChannels(c, true);
  },
  defaultProps: () => DEFAULT_PROPS,
});
const {
  isEditTarget, isClipLocked, isGroupLocked, withoutLocked, editTargetTracks, withLinked, relinkClips,
  splitClipAt, relinkSplitRights, sourceEditTracks, placeSourceWindowClips, punchTrackRange,
  listAlignedGaps, adjacentClip, rippleTrim, rollEdit, slipClip, slideClip, crossfadeCuts, crossfadeCut,
} = EDIT;
/** Does this clip reach the picture / the mix? Track output and clip enable. */
function clipRenders(c) { return isTrackEnabled(c.track) && c.disabled !== true; }
function toastLocked(partial = false) {
  toast(partial ? "Locked clips were left untouched — unlock them to edit"
    : "Locked — unlock the clip or its track to edit");
}
function syncTrackDisabledUI(id) {
  const on = isTrackEnabled(id);
  const solo = state.soloId === id;
  const head = els.trackHeaders.querySelector(`.track-head[data-track="${id}"]`);
  const row = els.tracks.querySelector(`.track[data-track="${id}"]`);
  if (head) {
    head.classList.toggle("disabled", !on);
    head.classList.toggle("solo", solo);
    const btn = head.querySelector(".track-toggle");
    if (btn) {
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? "Disable track" : "Enable track";
    }
    const sBtn = head.querySelector(".track-solo");
    if (sBtn) {
      sBtn.setAttribute("aria-pressed", solo ? "true" : "false");
      sBtn.classList.toggle("on", solo);
      sBtn.title = solo ? "Unsolo track" : "Solo track (mute all others)";
    }
  }
  const locked = isTrackLocked(id), targeted = isTrackTargeted(id);
  if (head) {
    head.classList.toggle("locked", locked);
    head.classList.toggle("untargeted", !targeted);
    const tBtn = head.querySelector(".track-id");
    if (tBtn) {
      tBtn.setAttribute("aria-pressed", targeted ? "true" : "false");
      tBtn.title = targeted
        ? "Targeted — edits (split, insert, ripple, close gap) touch this track. Click to untarget"
        : "Not targeted — edits skip this track. Click to target";
    }
    const lBtn = head.querySelector(".track-lock");
    if (lBtn) {
      lBtn.setAttribute("aria-pressed", locked ? "true" : "false");
      lBtn.classList.toggle("on", locked);
      lBtn.title = locked ? "Unlock track" : "Lock track — nothing on it can be edited or moved";
    }
  }
  if (row) {
    row.classList.toggle("disabled", !on);
    row.classList.toggle("solo", solo);
    row.classList.toggle("locked", locked);
  }
  syncMixerStrip(id);
}
function syncAllTrackDisabledUI() {
  for (const t of TRACKS) syncTrackDisabledUI(t.id);
}
function clearTrackSolo({ restore = false } = {}) {
  if (!state.soloId) return;
  if (restore && Array.isArray(state.soloRestore)) {
    state.disabledTracks = new Set(state.soloRestore.filter((id) => TRACK_IDS.has(id)));
    project.disabledTracks = [...state.disabledTracks].sort();
  }
  state.soloId = null;
  state.soloRestore = null;
}
function toggleTrackSolo(id) {
  if (!TRACK_IDS.has(id)) return;
  if (state.soloId === id) {
    clearTrackSolo({ restore: true });
  } else {
    if (!state.soloId) state.soloRestore = [...state.disabledTracks];
    state.soloId = id;
    state.disabledTracks = new Set(TRACKS.filter((t) => t.id !== id).map((t) => t.id));
    project.disabledTracks = [...state.disabledTracks].sort();
  }
  syncAllTrackDisabledUI();
  scheduleSave();
}
function toggleTrackEnabled(id) {
  if (!TRACK_IDS.has(id)) return;
  // Manual mute exits solo without restoring the pre-solo snapshot
  if (state.soloId) clearTrackSolo({ restore: false });
  if (state.disabledTracks.has(id)) state.disabledTracks.delete(id);
  else state.disabledTracks.add(id);
  project.disabledTracks = [...state.disabledTracks].sort();
  syncAllTrackDisabledUI();
  scheduleSave();
}
function toggleTrackLocked(id) {
  if (!TRACK_IDS.has(id)) return;
  if (state.lockedTracks.has(id)) state.lockedTracks.delete(id);
  else state.lockedTracks.add(id);
  project.lockedTracks = [...state.lockedTracks].sort();
  syncAllTrackDisabledUI();
  state.dirtyTimeline = true; // clips on the lane redraw with the lock hatch
  renderInspector();
  scheduleSave();
}
function toggleTrackTargeted(id) {
  if (!TRACK_IDS.has(id)) return;
  if (state.untargetedTracks.has(id)) state.untargetedTracks.delete(id);
  else state.untargetedTracks.add(id);
  project.untargetedTracks = [...state.untargetedTracks].sort();
  syncAllTrackDisabledUI();
  scheduleSave();
}
const runtime = {
  clipEls: new Map(),   // clipId -> HTMLMediaElement
  clipGain: new Map(),  // clipId -> GainNode
  mediaAux: new Map(),  // mediaId -> {img?, thumb?, svgText?, svgAnimated?}
  audioBufs: new Map(), // mediaId -> Promise<AudioBuffer> (waveforms + export mix)
  wavePeaks: new Map(), // mediaId -> {channels: Float32Array[], max: Float32Array} | Float32Array (legacy) | null (pending)
  library: {},          // dir -> [{name, rel, src, size}] cached /api/library results
  customFonts: [],      // family names loaded from /library/fonts
  libraryFontReq: new Set(), // library families claimed by a load pass
  googleLoaded: new Set(),   // loaded from Google Fonts (the font picker lists them)
  fontReq: new Map(),   // font name -> Promise<boolean> (ensureFont)
  undo: [], redo: [],
  audio: null,          // {ctx, master (sum), masterOut (fader), trackBus, recDest, meter?, meterReady?}
  saveTimer: null, pendingSync: false,
  sfxPreview: null,     // <audio> element for library sound previews
  importUrlAbort: null, // AbortController for an in-flight /api/import-url
  importFolderId: null, // Project-bin folder to place the next import into
  binDragFolderId: null, // folder id currently being dragged (cycle checks)
  binCtxMenu: null,     // Project-tab context menu element
  sourceEl: null,       // dedicated <video>/<audio> for Source monitor (not WebAudio-hooked)
  sourceMarks: new Map(), // mediaId -> {in, out} remembered across loads
  sourceHold: null,     // canvas of last good Source video frame (scrub/seek holdover)
  sourceHoldOk: false,
  sourceSeekPending: null, // coalesced scrub target (sec) while a seek is in flight
  sourceSeekBusy: false,
};

/* ── DOM ───────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const els = {
  binList: $("binList"), binEmpty: $("binEmpty"), fileInput: $("fileInput"),
  binTabs: $("binTabs"), libList: $("libList"), toast: $("toast"),
  preview: $("preview"), tcCurrent: $("tcCurrent"), tcTotal: $("tcTotal"),
  tcIo: $("tcIo"), tcIn: $("tcIn"), tcOut: $("tcOut"), tcDur: $("tcDur"),
  btnPlay: $("btnPlay"), inspector: $("inspector"),
  trackHeaders: $("trackHeaders"), timelineScroll: $("timelineScroll"),
  tracksContent: $("tracksContent"), tracks: $("tracks"), playhead: $("playhead"),
  ruler: $("ruler"), zoomSlider: $("zoomSlider"), btnSnap: $("btnSnap"),
  btnSnapMenu: $("btnSnapMenu"), btnMarkers: $("btnMarkers"), snapLine: $("snapLine"),
  btnAudioHold: $("btnAudioHold"),
  exportOverlay: $("exportOverlay"), exportProgress: $("exportProgress"),
  exportTitle: $("exportTitle"), exportNote: $("exportNote"),
  projectName: $("projectName"), monitorRes: $("monitorRes"),
  aspectSel: $("aspectSel"), fpsSel: $("fpsSel"),
  btnGuides: $("btnGuides"), btnExportFrame: $("btnExportFrame"),
  btnExportFrameDim: $("btnExportFrameDim"),
  exportFrameSel: $("exportFrameSel"), exportFrameOverlay: $("exportFrameOverlay"),
  btnZoom100: $("btnZoom100"),
  safeOverlay: $("safeOverlay"), btnSpeed: $("btnSpeed"),
  monitorStage: $("monitorStage"), monitorScroll: $("monitorScroll"),
  monitorZoomInner: $("monitorZoomInner"), kfGraphs: $("kfGraphs"),
  monitorPanel: $("monitorPanel"), monitorClipName: $("monitorClipName"),
  sourceScrub: $("sourceScrub"), sourceScrubTrack: $("sourceScrubTrack"),
  sourceScrubRange: $("sourceScrubRange"), sourceScrubIn: $("sourceScrubIn"),
  sourceScrubOut: $("sourceScrubOut"), sourceScrubHead: $("sourceScrubHead"),
  btnInsert: $("btnInsert"), btnReplace: $("btnReplace"),
  vuMeter: $("vuMeter"),
  sideTabs: $("sideTabs"),
  mixer: $("mixer"),
  exportSetup: $("exportSetup"), engineFast: $("engineFast"), engineRealtime: $("engineRealtime"),
  exportProfileRow: $("exportProfileRow"),
  exportProfileSel: $("exportProfileSel"), exportProfileNote: $("exportProfileNote"),
  exportProfileHint: $("exportProfileHint"),
  importUrlOverlay: $("importUrlOverlay"), importUrlInput: $("importUrlInput"),
  importUrlStatus: $("importUrlStatus"), importUrlProgress: $("importUrlProgress"),
};
const ctx2d = els.preview.getContext("2d");

/* ── Utils ─────────────────────────────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Other host/port than the editor. drawImage of that media taints the canvas
 *  unless it was fetched with CORS — Fast/WebCodecs export then cannot toBlob. */
function isCrossOriginSrc(src) {
  if (!src) return false;
  try { return new URL(src, location.href).origin !== location.origin; }
  catch { return false; }
}
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60),
    f = Math.floor((t % 1) * projectFps());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(m)}:${p(s)}:${p(f)}`;
}
/* Typed timecode → seconds, or null if it doesn't parse. Colon (or ;)
   fields read right-to-left as FF, SS, MM, HH; bare digits pack the same way
   (Premiere style: "1500" = 15s 00f, "5" = 5 frames). Frames may overflow
   ("0:45" at 30 fps = 1.5 s). A decimal point or trailing "s" means seconds
   ("12.5", "90s").
   A leading + / − offsets from `base` instead of setting an absolute time. */
function parseTimecode(str, fps, base = 0) {
  let s = String(str ?? "").trim().replace(/\s+/g, "");
  if (!s) return null;
  let sign = 0;
  if (s[0] === "+" || s[0] === "-") { sign = s[0] === "+" ? 1 : -1; s = s.slice(1); }
  if (!s) return null;
  let sec;
  const secs = /^(\d*\.\d+)s?$|^(\d+)s$/i.exec(s);
  if (secs) sec = +(secs[1] ?? secs[2]);
  else {
    let fields;
    if (/^\d+$/.test(s)) {
      fields = [];
      for (let i = s.length; i > 0; i -= 2) fields.unshift(s.slice(Math.max(0, i - 2), i));
      if (fields.length > 4) fields = [fields.slice(0, fields.length - 3).join(""), ...fields.slice(-3)];
    } else if (/^\d*([:;]\d*){1,3}$/.test(s)) fields = s.split(/[:;]/);
    else return null;
    const n = fields.map((f) => +f || 0).reverse(); // [ff, ss, mm, hh]
    sec = (n[3] || 0) * 3600 + (n[2] || 0) * 60 + (n[1] || 0) + (n[0] || 0) / (fps > 0 ? fps : 30);
  }
  if (!Number.isFinite(sec)) return null;
  return Math.max(0, sign ? base + sign * sec : sec);
}
/* ── Markers: named, coloured cues on the ruler ({t, label?, color?}) ── */
const MARKER_COLORS = {
  gold: "#ffd166", red: "#ff5c6c", orange: "#ff9f43", green: "#4ade80",
  cyan: "#22d3ee", blue: "#60a5fa", purple: "#a78bfa", pink: "#f472b6",
};
function normalizeMarker(m) {
  if (!m || !Number.isFinite(+m.t) || +m.t < 0) return null;
  const out = { t: +(+m.t).toFixed(3) };
  const label = typeof m.label === "string" ? m.label.trim().slice(0, 80) : "";
  if (label) out.label = label;
  if (m.color && m.color !== "gold" && Object.hasOwn(MARKER_COLORS, m.color)) out.color = m.color;
  return out;
}
function normalizeMarkers(list) {
  return (Array.isArray(list) ? list : []).map(normalizeMarker).filter(Boolean).sort((a, b) => a.t - b.t);
}
function markerColor(m) { return MARKER_COLORS[m?.color] || MARKER_COLORS.gold; }
/* First marker strictly after t (dir 1) or before it (dir −1), or null. */
function adjacentMarker(markers, t, dir, eps = 1e-3) {
  let best = null;
  for (const m of markers || []) {
    if (dir > 0 ? m.t > t + eps && (!best || m.t < best.t) : m.t < t - eps && (!best || m.t > best.t)) best = m;
  }
  return best;
}
const getMedia = (id) => project.media.find((m) => m.id === id);
const getClip = (id) => project.clips.find((c) => c.id === id);
const clipEnd = (c) => c.start + c.duration;
const trackOf = (c) => TRACKS.find((t) => t.id === c.track);
/** Last timeline second occupied by a clip on a known track (ignores orphan refs). */
function projDur() {
  let mx = 0;
  for (const c of project.clips) {
    if (!trackOf(c)) continue;
    const end = clipEnd(c);
    if (Number.isFinite(end) && end > mx) mx = end;
  }
  return mx;
}
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
const kfTimeEps = () => 0.5 / projectFps();
/* Is the playhead over the clip (± half a frame)? Keyframe edits are only
   meaningful then — off-clip writes would land clamped on the clip's edge. */
function playheadOverClip(c) {
  const eps = kfTimeEps();
  return state.time >= c.start - eps && state.time <= c.start + c.duration + eps;
}
/* Keyframe on this channel whose absolute time matches the playhead. */
function kfAtPlayhead(c, k) {
  const arr = c.keyframes?.[k];
  if (!Array.isArray(arr) || !arr.length) return null;
  const eps = kfTimeEps();
  const abs = state.time;
  return arr.find((kf) => Math.abs(c.start + kf.t - abs) < eps) || null;
}
/* Static props with keyed channels replaced by the value at the playhead
   (no transition envelopes — those would fake a keyframe in the inspector). */
function propsAtPlayhead(c) {
  const p = { ...c.props };
  if (!c.keyframes) return p;
  const local = state.time - c.start;
  for (const k of ANIMATABLE) {
    const kfs = c.keyframes[k];
    if (!Array.isArray(kfs) || !kfs.length) continue;
    const v = kfChannel(c, k, local, +(p[k] ?? DEFAULT_PROPS[k] ?? 0));
    if (typeof v === "number" && !isNaN(v)) p[k] = v;
  }
  return p;
}
function fmtInspNum(v, step) {
  const n = +v;
  if (!Number.isFinite(n)) return "0";
  const s = +step;
  if (Number.isFinite(s) && s > 0) {
    if (s >= 1) return String(Math.round(n / s) * s);
    const dec = Math.min(6, Math.max(0, Math.ceil(-Math.log10(s) - 1e-9)));
    return String(+n.toFixed(dec));
  }
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  return String(+n.toFixed(3));
}
/* Inspector playhead-sync cache: the rAF loop re-syncs inspector fields only
   when the playhead, selection, keyed values, or the selected clip's start /
   duration changed since the last sync.
   Mutators that don't re-render the inspector bump inspPropGen. */
let inspSyncStamp = "";
let inspPropGen = 0;
const inspStampNow = () => {
  const c = getClip(state.selId);
  return state.time + "|" + state.selId + "|" + inspPropGen + "|"
    + (c ? c.start : "") + "|" + (c ? c.duration : "")
    // Focus belongs in the stamp: the sync skips the focused field, so a blur
    // has to invalidate the stamp or that field keeps the value it was left on.
    + "|" + (document.activeElement?.dataset?.k || "");
};
/* Audio hold loops one frame of audio built from volume / pan / the speed
   remap — a write to any of them must re-cut it. The mutators own this (like
   dirtyTimeline); scheduleAudioHoldRefresh itself no-ops unless holding. */
function refreshAudioHoldFor(k) {
  if (k === "volume" || k === "pan" || k === "speed") scheduleAudioHoldRefresh();
}
/* Write an animatable prop: static if the channel has no keyframes; otherwise
   update the keyframe under the playhead or insert one (auto-key). Returns
   false when the write was refused — a keyed channel with the playhead off
   the clip would corrupt the edge keyframe, so it must not be written.
   dirtyTimeline ownership: the keyframe mutators (setAnimProp /
   toggleKfAtPlayhead / resetProp*) set it themselves when a keyframe appears
   or disappears (clip markers move); value-only writes skip it — the graphs
   redraw every rAF anyway. Callers never set it for these. The same goes for
   refreshAudioHoldFor() on volume/pan/speed writes. */
function setAnimProp(c, k, v) {
  if (!c || !ANIMATABLE.includes(k) || typeof v !== "number" || isNaN(v)) return false;
  const arr = c.keyframes?.[k];
  if (Array.isArray(arr) && arr.length && !playheadOverClip(c)) return false;
  inspPropGen++;
  refreshAudioHoldFor(k);
  if (!Array.isArray(arr) || !arr.length) {
    c.props[k] = v;
    return true;
  }
  const near = kfAtPlayhead(c, k);
  if (near) { near.v = v; return true; }
  const lt = +clamp(state.time - c.start, 0, c.duration).toFixed(3);
  const eps = kfTimeEps();
  const dup = arr.find((kf) => Math.abs(kf.t - lt) < eps);
  if (dup) { dup.v = v; return true; }
  arr.push({ t: lt, v });
  arr.sort((a, b) => a.t - b.t);
  state.dirtyTimeline = true;
  return true;
}
/* Wipe a property: factory default + delete that channel's keyframes. */
function resetPropChannel(c, k) {
  if (!c || !k) return;
  if (k === "transIn" || k === "transOut") {
    c[k === "transIn" ? "transitionIn" : "transitionOut"] = undefined;
    state.dirtyTimeline = true;
    return;
  }
  if (!Object.hasOwn(DEFAULT_PROPS, k)) return;
  c.props[k] = DEFAULT_PROPS[k];
  refreshAudioHoldFor(k);
  if (c.keyframes?.[k]) {
    delete c.keyframes[k];
    if (!Object.keys(c.keyframes).length) c.keyframes = undefined;
    state.dirtyTimeline = true;
  }
  if (k === "text" || k === "font") state.dirtyTimeline = true;
  if (k === "font") ensureFont(String(DEFAULT_PROPS.font));
}
/* Playhead-local reset: remove the keyframe under the playhead, else set the
   value at the playhead to the property default (auto-keys if already keyed).
   Returns false when refused (keyed channel, playhead off the clip). */
function resetPropAtPlayhead(c, k) {
  if (!c || !k) return false;
  if (k === "transIn" || k === "transOut") {
    resetPropChannel(c, k);
    return true;
  }
  if (!Object.hasOwn(DEFAULT_PROPS, k)) return false;
  if (ANIMATABLE.includes(k) && kfAtPlayhead(c, k)) return toggleKfAtPlayhead(c, k);
  const def = DEFAULT_PROPS[k];
  if (ANIMATABLE.includes(k) && c.keyframes?.[k]?.length) {
    if (!setAnimProp(c, k, def)) return false;
  } else { c.props[k] = def; refreshAudioHoldFor(k); }
  if (k === "text" || k === "font") state.dirtyTimeline = true;
  if (k === "font") ensureFont(String(def));
  return true;
}
function applyInspectorReset(keys, channelWide) {
  const c = getClip(state.selId);
  if (!c || !keys.length) return;
  pushUndo();
  let refused = false;
  for (const k of keys) {
    if (channelWide) resetPropChannel(c, k);
    else refused = !resetPropAtPlayhead(c, k) || refused;
  }
  if (refused) toast("Move the playhead over the clip to edit its keyframes");
  scheduleSave();
  renderInspector();
}
/* ◆ : add a keyframe at the playhead, or remove the one already there.
   Refused (false) when the playhead is off the clip — there is no "at the
   playhead" then, and clamping would plant a keyframe on the clip's edge. */
function toggleKfAtPlayhead(c, k) {
  if (!c || !ANIMATABLE.includes(k) || !playheadOverClip(c)) return false;
  const near = kfAtPlayhead(c, k);
  if (near) {
    inspPropGen++;
    refreshAudioHoldFor(k);
    const rest = c.keyframes[k].filter((kf) => kf !== near);
    if (rest.length) c.keyframes[k] = rest;
    else {
      c.props[k] = near.v;
      delete c.keyframes[k];
      if (!Object.keys(c.keyframes).length) c.keyframes = undefined;
    }
    state.dirtyTimeline = true; // a diamond left the clip — mutators own this flag
    return true;
  }
  const fallback = +(c.props?.[k] ?? DEFAULT_PROPS[k] ?? 0);
  const v = kfChannel(c, k, state.time - c.start, fallback);
  if (typeof v !== "number" || isNaN(v)) return false;
  inspPropGen++;
  refreshAudioHoldFor(k);
  if (!c.keyframes) c.keyframes = {};
  const arr = (c.keyframes[k] = c.keyframes[k] || []);
  const lt = +clamp(state.time - c.start, 0, c.duration).toFixed(3);
  const dup = arr.find((kf) => Math.abs(kf.t - lt) < kfTimeEps());
  if (dup) dup.v = v; // value-only: no marker moves, no timeline rebuild
  else {
    arr.push({ t: lt, v });
    arr.sort((a, b) => a.t - b.t);
    state.dirtyTimeline = true;
  }
  return true;
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
/** Inverse of mediaTimeAt for a given media-time target, returning the local
 *  timeline offset within the clip, or null if no unique inverse exists.
 *  Reuses the same trapezoid integral cache as mediaTimeAt. */
function localTimeForMedia(c, mediaTarget) {
  if (!hasSpeedRamp(c)) {
    const base = clipSpeed(c);
    return (mediaTarget - c.in) / base;
  }
  const base = clipSpeed(c);
  const key = JSON.stringify(c.keyframes.speed) + "|" + c.duration.toFixed(4) + "|" + base;
  let e = speedIntCache.get(c.id);
  if (!e || e.key !== key) {
    mediaTimeAt(c, c.start); // build cache
    e = speedIntCache.get(c.id);
  }
  if (!e) return null;
  const target = mediaTarget - c.in;
  const { cum, step } = e;
  if (target <= 0) return 0;
  if (target >= cum[cum.length - 1]) return cum.length <= 1 ? 0 : (cum.length - 1) * step;
  // Linear search for bracket; cum is monotonic because speed is clamped positive.
  let i = 1;
  while (i < cum.length && cum[i] < target) i++;
  if (i >= cum.length) i = cum.length - 1;
  const v0 = cum[i - 1], v1 = cum[i];
  if (Math.abs(v1 - v0) < 1e-9) return null;
  const frac = (target - v0) / (v1 - v0);
  return (i - 1 + frac) * step;
}
let toastTimer = null;
function toast(msg) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

/* True when keyboard events should go to a text-entry control (not range/checkbox). */
function isTypingTarget(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    return !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "hidden"].includes(t);
  }
  return !!el.isContentEditable;
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
      .then((j) => { state.ffmpeg = !!j.available; }).catch(() => { });
    fetchEncodeProfiles();
    detectWebCodecs();
  } catch {
    state.connected = false;
    els.projectName.textContent = project.name + "  ·  ⚪ local session";
  }
  await probeMissingMeta();
}
/* Main-profile AVC level by canvas height; Annex-B is required so ffmpeg
   can ingest the elementary stream with `-f h264` and no avcC converter. */
function webCodecsAvcCodec() {
  const h = project.height || 720;
  if (h > 1080) return "avc1.4D0032"; // Main@L5.0
  if (h > 720) return "avc1.4D0028";  // Main@L4.0
  return "avc1.4D001F";               // Main@L3.1
}
async function detectWebCodecs() {
  state.webCodecs = false;
  try {
    if (typeof VideoEncoder !== "function" || typeof VideoEncoder.isConfigSupported !== "function") return;
    const base = {
      codec: webCodecsAvcCodec(),
      width: Math.max(2, project.width | 0 || 1280),
      height: Math.max(2, project.height | 0 || 720),
      bitrate: 8_000_000,
      framerate: projectFps(),
      avc: { format: "annexb" },
      latencyMode: "quality",
    };
    const requested = getSetting("webCodecsBitrateMode") === "constant" ? "constant" : "variable";
    const [variable, constant] = await Promise.all([
      VideoEncoder.isConfigSupported({ ...base, bitrateMode: "variable" }),
      VideoEncoder.isConfigSupported({ ...base, bitrateMode: "constant" }),
    ]);
    const match = requested === "constant" ? constant : variable;
    state.webCodecs = !!match.supported;
  } catch { state.webCodecs = false; }
}
const TIMELINE_START_TIME = 0.000; // composition timeline start (seconds)
function normalizeWorkArea(i, o, t0 = TIMELINE_START_TIME) {
  let inPoint = (i != null && isFinite(i)) ? Math.max(t0, +i) : null;
  let outPoint = (o != null && isFinite(o)) ? Math.max(t0, +o) : null;
  if (inPoint != null && outPoint != null && outPoint <= inPoint) {
    inPoint = null;
    outPoint = null;
  }
  return { inPoint, outPoint };
}
function getFolder(id) {
  return id ? project.folders.find((f) => f.id === id) : null;
}
function normalizeFolders(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const f of list) {
    if (!f || !f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({
      id: String(f.id),
      name: String(f.name || "Folder").trim() || "Folder",
      parentId: f.parentId || null,
      open: f.open !== false,
    });
  }
  // drop parent refs that don't exist
  for (const f of out) if (f.parentId && !seen.has(f.parentId)) f.parentId = null;
  return out;
}
function normalizeMediaEntry(m) {
  if (!m || typeof m !== "object") return m;
  return { ...m, folderId: m.folderId || null };
}
function folderChildren(parentId) {
  return project.folders
    .filter((f) => (f.parentId || null) === (parentId || null))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
function mediaInFolder(folderId) {
  return project.media
    .filter((m) => (m.folderId || null) === (folderId || null))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
/* True if ancestorId is the same as nodeId or an ancestor of nodeId. */
function isSelfOrFolderAncestor(ancestorId, nodeId) {
  let cur = getFolder(nodeId);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? getFolder(cur.parentId) : null;
  }
  return false;
}
function addFolder(parentId = null) {
  if (parentId && !getFolder(parentId)) parentId = null;
  const f = {
    id: "f_" + uid(),
    name: "New folder",
    parentId: parentId || null,
    open: true,
  };
  project.folders.push(f);
  if (parentId) {
    const p = getFolder(parentId);
    if (p) p.open = true;
  }
  scheduleSave();
  renderBin();
  // defer rename so the row exists
  requestAnimationFrame(() => startFolderRename(f.id));
  return f;
}
function deleteFolder(id) {
  const f = getFolder(id); if (!f) return;
  const parent = f.parentId || null;
  const doomed = new Set();
  const walk = (fid) => {
    doomed.add(fid);
    for (const c of project.folders) if (c.parentId === fid) walk(c.id);
  };
  walk(id);
  for (const m of project.media) if (m.folderId && doomed.has(m.folderId)) m.folderId = parent;
  for (const c of project.folders) if (c.parentId && doomed.has(c.parentId) && !doomed.has(c.id)) c.parentId = parent;
  project.folders = project.folders.filter((x) => !doomed.has(x.id));
  scheduleSave();
  renderBin();
}
function moveMediaToFolder(mediaId, folderId) {
  const m = getMedia(mediaId); if (!m) return;
  if (folderId && !getFolder(folderId)) folderId = null;
  m.folderId = folderId || null;
  if (folderId) { const f = getFolder(folderId); if (f) f.open = true; }
  scheduleSave();
  renderBin();
}
function moveFolderToParent(folderId, parentId) {
  const f = getFolder(folderId); if (!f) return;
  if (parentId && (parentId === folderId || isSelfOrFolderAncestor(folderId, parentId))) return;
  if (parentId && !getFolder(parentId)) parentId = null;
  f.parentId = parentId || null;
  if (parentId) { const p = getFolder(parentId); if (p) p.open = true; }
  scheduleSave();
  renderBin();
}
function startFolderRename(folderId) {
  const row = els.binList.querySelector(`.bin-folder[data-folder-id="${folderId}"] .bin-folder-name`);
  if (!row) return;
  row.contentEditable = "true";
  row.focus();
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(row); sel.removeAllRanges(); sel.addRange(range);
  const commit = () => {
    row.contentEditable = "false";
    const f = getFolder(folderId); if (!f) return;
    const name = row.textContent.replace(/\s+/g, " ").trim() || "Folder";
    f.name = name;
    row.textContent = name;
    scheduleSave();
  };
  row.addEventListener("blur", commit, { once: true });
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); row.blur(); }
    if (e.key === "Escape") { e.preventDefault(); row.textContent = getFolder(folderId)?.name || "Folder"; row.blur(); }
  });
}
/** Floor to even ≥ 8 — required for libx264 + yuv420p (chroma 2×2). */
function evenFloor(n) {
  return Math.max(8, Math.floor(n / 2) * 2);
}
function normalizeExportFrame(raw, canvasW, canvasH) {
  if (!raw || typeof raw !== "object") return null;
  let w = Math.round(+raw.w), h = Math.round(+raw.h);
  if (!w || !h || w < 8 || h < 8) return null;
  let x = Math.round(+raw.x || 0), y = Math.round(+raw.y || 0);
  w = evenFloor(Math.min(w, canvasW));
  h = evenFloor(Math.min(h, canvasH));
  x = clamp(x, 0, Math.max(0, canvasW - w));
  y = clamp(y, 0, Math.max(0, canvasH - h));
  if (w >= canvasW && h >= canvasH) return null;
  return { x, y, w, h };
}
function getExportFrame() {
  return normalizeExportFrame(project.exportFrame, project.width, project.height);
}
/** Largest axis-aligned rect of aspect aw×ah that fits inside the canvas.
 *  Width/height are snapped even so Fast export (H.264 yuv420p) can encode. */
function fitExportFrameAspect(aw, ah, canvasW = project.width, canvasH = project.height) {
  const target = aw / ah, canvas = canvasW / canvasH;
  let w, h;
  if (target > canvas) { w = canvasW; h = Math.round(canvasW / target); }
  else { h = canvasH; w = Math.round(canvasH * target); }
  w = evenFloor(Math.min(w, canvasW));
  h = evenFloor(Math.min(h, canvasH));
  return {
    x: Math.round((canvasW - w) / 2),
    y: Math.round((canvasH - h) / 2),
    w, h,
  };
}
function exportFrameAspectIndex(ef) {
  if (!ef) return 0;
  const r = ef.w / ef.h;
  for (let i = 1; i < EXPORT_FRAME_ASPECTS.length; i++) {
    const a = EXPORT_FRAME_ASPECTS[i];
    const ar = a.w / a.h;
    if (Math.abs(r - ar) < 0.02) return i;
  }
  return -1;
}
function updateMonitorRes() {
  if (!els.monitorRes) return;
  const ef = getExportFrame();
  els.monitorRes.textContent = ef
    ? `${project.width}×${project.height} canvas → ${ef.w}×${ef.h} export · ${project.fps}fps`
    : `${project.width} × ${project.height} · ${project.fps}fps`;
}
function syncExportFrameSel() {
  if (!els.exportFrameSel) return;
  const ef = getExportFrame();
  const i = exportFrameAspectIndex(ef);
  let html = EXPORT_FRAME_ASPECTS.map((a, j) => {
    const sel = ef ? (i === j) : (j === 0);
    return `<option value="${j}" ${sel ? "selected" : ""}>${a.label}</option>`;
  }).join("");
  if (ef && i < 0)
    html += `<option value="custom" selected>Custom · ${ef.w}×${ef.h}</option>`;
  els.exportFrameSel.innerHTML = html;
}
function applyProject(data) {
  const wa = normalizeWorkArea(data.inPoint, data.outPoint);
  Object.assign(project, {
    name: data.name || "Untitled Project",
    width: data.width || 1280, height: data.height || 720,
    fps: (Number(data.fps) > 0 ? Number(data.fps) : project.fps),
    background: data.background || "#000000",
    revision: data.revision || 0,
    folders: normalizeFolders(data.folders),
    media: (data.media || []).map(normalizeMediaEntry),
    clips: data.clips || [],
    markers: normalizeMarkers(data.markers),
    inPoint: wa.inPoint,
    outPoint: wa.outPoint,
    exportFrame: normalizeExportFrame(data.exportFrame, data.width || 1280, data.height || 720),
    encodeProfile: data.encodeProfile || null,
    master: normalizeMaster(data.master),
    buses: normalizeBuses(data.buses),
  });
  applyTracksFromProject(data.tracks);
  ensureTracksCoverClips();
  project.tracks = serializeTracks();
  const disabledTracks = normalizeDisabledTracks(data.disabledTracks);
  project.disabledTracks = disabledTracks;
  const folderIds = new Set(project.folders.map((f) => f.id));
  for (const m of project.media) {
    if (m.folderId && !folderIds.has(m.folderId)) m.folderId = null;
  }
  state.disabledTracks = new Set(disabledTracks);
  project.lockedTracks = normalizeDisabledTracks(data.lockedTracks);
  project.untargetedTracks = normalizeDisabledTracks(data.untargetedTracks);
  state.lockedTracks = new Set(project.lockedTracks);
  state.untargetedTracks = new Set(project.untargetedTracks);
  state.soloId = null;
  state.soloRestore = null;
  // One-shot migration for projects saved before props.pan existed. Gated by
  // panSchema so a later write that omits pan:0 (compact MCP / agent rebuild)
  // does not re-hard-pan a deliberately centered stem.
  const migratePan = !(data.panSchema >= 1);
  for (const c of project.clips) {
    c.fx = normFx(c.fx);
    if (!c.fx) delete c.fx;
    const raw = c.props || {};
    c.props = { ...DEFAULT_PROPS, ...raw };
    if (migratePan && !Object.hasOwn(raw, "pan") && Number.isInteger(raw.audioChannel) && raw.audioChannel >= 0)
      c.props.pan = defaultPanForChannel(raw.audioChannel);
    if (c.keyframes) for (const arr of Object.values(c.keyframes))
      if (Array.isArray(arr)) arr.sort((a, b) => a.t - b.t);
    if (c.kind === "text") ensureFont(c.props.font);
  }
  project.panSchema = 1;
  if (migratePan) scheduleSave(); // persist marker + migrated stem pans
  // AV links aren't always on disk (older saves / agents) — rebuild from matching timing.
  relinkClips();
  // reset runtime playback elements so they rebuild against new data
  if (state.audioHold) setAudioHold(false);
  else stopAudioHoldNodes();
  // Tear down each clip's Web Audio chain (src→split→gain→panner→bus) before
  // clearing the maps — otherwise nodes stay wired to live track buses and leak.
  for (const id of new Set([...runtime.clipEls.keys(), ...runtime.clipGain.keys()]))
    releaseClipEl(id);
  if (runtime.audio) syncAudioGraphTracks();
  // Drop Source if its media vanished from the new document
  if (state.source.mediaId && !getMedia(state.source.mediaId)) clearSource();
  else if (state.source.mediaId) restoreSourceAfterReload();
  els.preview.width = project.width; els.preview.height = project.height;
  updateMonitorRes();
  syncAspectSel();
  syncFpsSel();
  syncExportFrameSel();
  updateExportFrameOverlay();
  els.btnExportFrame?.classList.toggle("on", state.exportFrameView && !!getExportFrame());
  pruneSelection(); // keep the selection across external reloads where possible
  buildTrackDOM();
  state.dirtyTimeline = true;
  renderBin(); renderInspector();
  updateWorkArea();
  syncTrimIOButton();
  syncExportRangeSelect();
  syncExportRangeUi();
  syncAllTrackDisabledUI();
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
    } catch { }
  }, 400);
}
function projectJSON() {
  const { name, width, height, fps, background, revision, folders, media, clips, markers, inPoint, outPoint, disabledTracks, encodeProfile } = project;
  const out = {
    name, width, height, fps, background, revision,
    panSchema: 1,
    folders: (folders || []).map(({ id, name, parentId, open }) =>
      ({ id, name, parentId: parentId || null, open: open !== false })),
    tracks: serializeTracks(),
    media: media.filter((m) => !m.transient).map(({ id, name, kind, src, duration, width, height, folderId, derivedFrom, denoise }) => {
      const mo = { id, name, kind, src, duration, width, height, folderId: folderId || null };
      if (derivedFrom) { mo.derivedFrom = derivedFrom; if (denoise) mo.denoise = denoise; }
      return mo;
    }),
    clips: clips.map(({ id, mediaId, kind, track, start, in: inn, duration, name, props, keyframes, transitionIn, transitionOut, linkedId, linkGroup, locked, disabled, unlinked, fx }) => {
      const clipOut = { id, mediaId, kind, track, start, in: inn, duration, name, props, keyframes, transitionIn, transitionOut };
      if (fx?.length) clipOut.fx = fx;
      if (linkGroup) clipOut.linkGroup = linkGroup;
      if (linkedId) clipOut.linkedId = linkedId;
      // Written only when set, so untouched projects stay byte-identical.
      if (locked === true) clipOut.locked = true;
      if (disabled === true) clipOut.disabled = true;
      if (unlinked === true) clipOut.unlinked = true;
      return clipOut;
    }),
    markers: normalizeMarkers(markers),
    inPoint: inPoint == null ? null : inPoint,
    outPoint: outPoint == null ? null : outPoint,
    disabledTracks: normalizeDisabledTracks(disabledTracks),
  };
  const locked = normalizeDisabledTracks(project.lockedTracks);
  const untargeted = normalizeDisabledTracks(project.untargetedTracks);
  if (locked.length) out.lockedTracks = locked;
  if (untargeted.length) out.untargetedTracks = untargeted;
  const ef = getExportFrame();
  if (ef) out.exportFrame = ef;
  if (encodeProfile) out.encodeProfile = encodeProfile;
  const master = normalizeMaster(project.master);
  if (master) out.master = master;
  const buses = normalizeBuses(project.buses);
  if (buses.length) out.buses = buses;
  return out;
}
function listenSSE() {
  const es = new EventSource("/api/events");
  // Named events: "change" = project/media/library; "profiles" = encoding-profiles.json only
  es.addEventListener("change", () => syncFromServer());
  es.addEventListener("export", (e) => {
    try { runExportJob(JSON.parse(e.data)); } catch { }
  });
  es.addEventListener("profiles", () => {
    fetchEncodeProfiles().then(() => {
      if (els.exportSetup && !els.exportSetup.classList.contains("hidden"))
        populateExportProfileSelect();
    });
  });
  // Legacy default "message" events (old servers that emit bare `data:`)
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
  fetchEncodeProfiles();
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
  } catch { }
}
/** Populate a media entry's duration/dimensions (and cache preview assets) by
 * dispatching on kind: svg loads its markup, image loads for width/height,
 * audio/video probes duration+size via a throwaway <video>/<audio> element.
 * Throws on failure — callers decide whether that's fatal or best-effort.
 * Shared by importFiles, addLibraryItem and probeMissingMeta. */
async function loadMediaMetadata(m) {
  if (m.kind === "svg") { await loadSvgMedia(m); return; }
  if (m.kind === "image") {
    const img = await loadImage(m.src);
    runtime.mediaAux.set(m.id, { ...(runtime.mediaAux.get(m.id) || {}), img });
    m.width = img.naturalWidth; m.height = img.naturalHeight;
    return;
  }
  Object.assign(m, await probeAV(m.src, m.kind));
}
/* Fill in duration/size for media entries added externally without metadata */
async function probeMissingMeta() {
  let changed = false;
  for (const m of project.media) {
    if (m.kind === "svg") {
      if (!runtime.mediaAux.get(m.id)?.svgText) { try { await loadMediaMetadata(m); changed = true; } catch { } }
      continue;
    }
    if (m.kind !== "image" && (m.duration == null || isNaN(m.duration))) {
      try { await loadMediaMetadata(m); changed = true; } catch { }
    }
    if (m.kind === "image" && !runtime.mediaAux.get(m.id)?.img) {
      try { await loadMediaMetadata(m); changed = true; } catch { }
    }
    if (m.kind === "video" && !runtime.mediaAux.get(m.id)?.thumb) {
      grabThumb(m).catch(() => { });
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
  return new Promise((res, rej) => {
    const i = new Image();
    // Must be set before src. Same-origin stays unset so /media needs no ACAO;
    // cross-origin needs CORS or drawImage taints the canvas.
    if (isCrossOriginSrc(src)) i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}
async function grabThumb(m) {
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto";
  if (isCrossOriginSrc(m.src)) v.crossOrigin = "anonymous";
  v.src = m.src;
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
  // Also decode peaks from video files when their audio is placed on an A track
  if ((m.kind !== "audio" && m.kind !== "video") || runtime.wavePeaks.has(m.id)) return;
  runtime.wavePeaks.set(m.id, null); // pending
  getAudioBuffer(m).then((buf) => {
    const n = Math.max(1, Math.ceil(buf.duration * WAVE_PEAKS_PER_SEC));
    const step = buf.length / n;
    const channels = [];
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      const peaks = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let mx = 0;
        const i0 = Math.floor(i * step), i1 = Math.min(data.length, Math.floor((i + 1) * step));
        for (let j = i0; j < i1; j += 8) { const a = Math.abs(data[j]); if (a > mx) mx = a; }
        peaks[i] = mx;
      }
      channels.push(peaks);
    }
    // Combined max envelope for clips that play full stereo
    const max = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let mx = 0;
      for (const p of channels) if (p[i] > mx) mx = p[i];
      max[i] = mx;
    }
    runtime.wavePeaks.set(m.id, { channels, max });
    if (m.channels == null) m.channels = buf.numberOfChannels;
    state.dirtyTimeline = true;
  }).catch(() => runtime.wavePeaks.delete(m.id));
}
function wavePeaksFor(c) {
  const w = runtime.wavePeaks.get(c.mediaId);
  if (!w) return null;
  // Legacy: bare Float32Array
  if (w instanceof Float32Array) return w;
  if (!w.max) return null;
  const ch = c.props?.audioChannel;
  if (Number.isInteger(ch) && ch >= 0 && w.channels?.[ch]) return w.channels[ch];
  return w.max;
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
  if (!files.length) return [];
  const folderId = runtime.importFolderId && getFolder(runtime.importFolderId)
    ? runtime.importFolderId : null;
  runtime.importFolderId = null;
  let added = 0, skipped = 0;
  const addedMedia = [];
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
    const m = { id: "m_" + uid(), name: file.name, kind, src, transient, folderId };
    try {
      await loadMediaMetadata(m);
      if (kind === "video") grabThumb(m).catch(() => { });
      ensureWave(m);
    } catch { skipped++; continue; }
    project.media.push(m);
    addedMedia.push(m);
    added++;
  }
  renderBin(); scheduleSave();
  if (!added && skipped)
    toast("Couldn't import — unsupported or unreadable file type");
  else if (skipped)
    toast(`Imported ${added}, skipped ${skipped}`);
  return addedMedia;
}

function setImportUrlBusy(busy) {
  const input = els.importUrlInput;
  const go = $("btnDoImportUrl");
  if (input) input.disabled = busy;
  if (go) go.disabled = busy;
  els.importUrlStatus?.classList.toggle("hidden", !busy);
  els.importUrlProgress?.classList.toggle("hidden", !busy);
}

function closeImportUrl() {
  if (runtime.importUrlAbort) {
    try { runtime.importUrlAbort.abort(); } catch { }
    runtime.importUrlAbort = null;
  }
  setImportUrlBusy(false);
  els.importUrlOverlay?.classList.add("hidden");
}

function openImportUrl() {
  if (!state.connected) {
    toast("Import from URL needs the editor server");
    return;
  }
  if (!els.importUrlOverlay) return;
  if (els.importUrlInput) els.importUrlInput.value = "";
  setImportUrlBusy(false);
  els.importUrlOverlay.classList.remove("hidden");
  setTimeout(() => els.importUrlInput?.focus(), 0);
}

async function importFromUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) { toast("Paste an HTTPS URL first"); return; }
  if (!/^https:\/\//i.test(trimmed)) { toast("URL must start with https://"); return; }
  if (!state.connected) { toast("Import from URL needs the editor server"); return; }
  runtime.importUrlAbort = new AbortController();
  setImportUrlBusy(true);
  try {
    const res = await fetch("/api/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: trimmed }),
      signal: runtime.importUrlAbort.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "import failed (" + res.status + ")");
    const kind = libKind(body.name);
    if (!kind) throw new Error("unsupported file type: " + (body.name || ""));
    const folderId = runtime.importFolderId && getFolder(runtime.importFolderId)
      ? runtime.importFolderId : null;
    runtime.importFolderId = null;
    const m = { id: "m_" + uid(), name: body.name, kind, src: body.src, folderId };
    try {
      await loadMediaMetadata(m);
      if (kind === "video") grabThumb(m).catch(() => { });
      ensureWave(m);
    } catch { /* browser will retry via probeMissingMeta */ }
    project.media.push(m);
    renderBin(); scheduleSave();
    closeImportUrl();
    toast("Imported " + m.name);
  } catch (e) {
    if (e && e.name === "AbortError") return;
    setImportUrlBusy(false);
    toast(e && e.message ? e.message : "Couldn't import URL");
  } finally {
    runtime.importUrlAbort = null;
  }
}

function renderBin() {
  els.binList.querySelectorAll(".bin-item, .bin-folder, .bin-drop-root").forEach((n) => n.remove());
  const empty = !project.media.length && !project.folders.length;
  els.binEmpty.style.display = empty ? "" : "none";
  if (empty) return;

  const clearBinDropHints = () => {
    els.binList.querySelectorAll(".bin-drop-over").forEach((n) => n.classList.remove("bin-drop-over"));
  };

  const bindFolderDropTarget = (el, folderId /* null = root */) => {
    el.addEventListener("dragover", (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      const hasMedia = types.includes("text/fablecut-media");
      const hasFolder = types.includes("text/fablecut-folder");
      const hasFiles = types.includes("Files");
      if (!hasMedia && !hasFolder && !hasFiles) return;
      if (hasFolder) {
        const dragId = runtime.binDragFolderId;
        if (dragId && folderId && isSelfOrFolderAncestor(dragId, folderId)) return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
      clearBinDropHints();
      el.classList.add("bin-drop-over");
      if (hasFiles) runtime.importFolderId = folderId;
    });
    el.addEventListener("dragleave", (e) => {
      if (el.contains(e.relatedTarget)) return;
      el.classList.remove("bin-drop-over");
      if (runtime.importFolderId === folderId) runtime.importFolderId = null;
    });
    el.addEventListener("drop", (e) => {
      const mid = e.dataTransfer.getData("text/fablecut-media");
      const fid = e.dataTransfer.getData("text/fablecut-folder");
      const files = e.dataTransfer.files;
      clearBinDropHints();
      if (files?.length) {
        e.preventDefault();
        e.stopPropagation();
        runtime.importFolderId = folderId;
        importFiles(files);
        return;
      }
      if (mid) {
        e.preventDefault();
        e.stopPropagation();
        moveMediaToFolder(mid, folderId);
        return;
      }
      if (fid) {
        e.preventDefault();
        e.stopPropagation();
        moveFolderToParent(fid, folderId);
      }
    });
  };

  const makeMediaItem = (m, depth) => {
    const item = document.createElement("div");
    item.className = "bin-item";
    item.draggable = true;
    item.dataset.mediaId = m.id;
    item.style.setProperty("--bin-depth", depth);
    const aux = runtime.mediaAux.get(m.id) || {};
    const icon = mediaKindIcon(m.kind, "🎞");
    const thumbSrc = aux.thumb || (m.kind === "image" || m.kind === "svg" ? m.src : null);
    item.innerHTML = `
      <div class="bin-thumb"></div>
      <div class="bin-meta">
        <div class="bin-name"></div>
        <div class="bin-sub">${m.kind}${m.duration ? " · " + fmt(m.duration) : ""}</div>
      </div>
      <span class="bin-del" title="Remove (and its clips)">✕</span>`;
    const thumbEl = item.querySelector(".bin-thumb");
    if (thumbSrc) thumbEl.style.backgroundImage = `url(${JSON.stringify(thumbSrc)})`;
    else thumbEl.textContent = icon;
    const nameEl = item.querySelector(".bin-name");
    nameEl.textContent = m.name;
    nameEl.title = m.name;
    item.addEventListener("dragstart", (e) => {
      runtime.binDragFolderId = null;
      e.dataTransfer.setData("text/fablecut-media", m.id);
      e.dataTransfer.effectAllowed = "copyMove";
      item.classList.add("bin-dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("bin-dragging");
      clearBinDropHints();
      runtime.importFolderId = null;
    });
    // Don't bubble to the root drop zone while hovering a media row
    item.addEventListener("dragover", (e) => e.stopPropagation());
    item.addEventListener("click", (e) => {
      if (e.target.closest(".bin-del")) return;
      if (e.ctrlKey || e.metaKey) return; // reserved for import
      if (!getSetting("linkSelect")) return;
      e.preventDefault();
      selectClipsByMediaId(m.id);
    });
    item.addEventListener("dblclick", () => {
      // Double-click loads Source (single-click only selects when link-select is on).
      if (state.source.mediaId === m.id) {
        setMonitorMode("source");
      } else {
        loadSourceFromMedia(m);
      }
      if (getSetting("linkSelect")) flashMonitorAttention();
    });
    item.querySelector(".bin-del").addEventListener("click", (e) => {
      e.stopPropagation();
      pushUndo();
      project.media = project.media.filter((x) => x.id !== m.id);
      project.clips = project.clips.filter((c) => c.mediaId !== m.id);
      if (state.source.mediaId === m.id) clearSource();
      renderBin(); scheduleSave(); renderInspector();
    });
    return item;
  };

  const renderLevel = (parentId, depth) => {
    for (const f of folderChildren(parentId)) {
      const row = document.createElement("div");
      row.className = "bin-folder" + (f.open ? " open" : "");
      row.dataset.folderId = f.id;
      row.draggable = true;
      row.style.setProperty("--bin-depth", depth);
      const count = mediaInFolder(f.id).length + folderChildren(f.id).length;
      row.innerHTML = `
        <button type="button" class="bin-folder-twist" title="${f.open ? "Collapse" : "Expand"}" aria-expanded="${f.open}">${f.open ? "▼" : "▶"}</button>
        <span class="bin-folder-icon">📁</span>
        <span class="bin-folder-name"></span>
        <span class="bin-folder-count">${count}</span>
        <button type="button" class="bin-folder-add" title="New subfolder">+</button>
        <button type="button" class="bin-del bin-folder-del" title="Delete folder (keeps media)">✕</button>`;
      const nameEl = row.querySelector(".bin-folder-name");
      nameEl.textContent = f.name;
      nameEl.title = f.name;
      row.querySelector(".bin-folder-twist").addEventListener("click", (e) => {
        e.stopPropagation();
        f.open = !f.open;
        scheduleSave();
        renderBin();
      });
      row.querySelector(".bin-folder-name").addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startFolderRename(f.id);
      });
      row.querySelector(".bin-folder-add").addEventListener("click", (e) => {
        e.stopPropagation();
        addFolder(f.id);
      });
      row.querySelector(".bin-folder-del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteFolder(f.id);
      });
      row.addEventListener("dragstart", (e) => {
        // don't start folder drag from action buttons
        if (e.target.closest("button")) { e.preventDefault(); return; }
        runtime.binDragFolderId = f.id;
        e.dataTransfer.setData("text/fablecut-folder", f.id);
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("bin-dragging");
      });
      row.addEventListener("dragend", () => {
        runtime.binDragFolderId = null;
        row.classList.remove("bin-dragging");
        clearBinDropHints();
        runtime.importFolderId = null;
      });
      bindFolderDropTarget(row, f.id);
      els.binList.appendChild(row);
      if (f.open) renderLevel(f.id, depth + 1);
    }
    for (const m of mediaInFolder(parentId)) els.binList.appendChild(makeMediaItem(m, depth));
  };

  renderLevel(null, 0);

  // Root drop zone at the bottom so items can be moved out of folders
  const root = document.createElement("div");
  root.className = "bin-drop-root";
  root.textContent = "Drop here to move to root";
  bindFolderDropTarget(root, null);
  els.binList.appendChild(root);
  syncBinSelectionFromTimeline();
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
/** Emoji shown for a bin/library item without a thumbnail preview. `other` is
 * the fallback for kinds not explicitly mapped here (image/svg items always
 * render a real thumbnail in both callers, so their icon is never actually
 * shown). Shared by renderBin and renderLibrary. */
function mediaKindIcon(kind, other) {
  return kind === "audio" ? "🎵" : kind === "svg" ? "✨" : kind === "image" ? "🖼" : kind === "video" ? "🎞" : other;
}
/* Find-or-create the project media entry for a library file (dedup by src). */
function mediaForLibraryItem(f) {
  let m = project.media.find((x) => x.src === f.src);
  if (m) return m;
  const kind = libKind(f.name);
  if (!kind) return null;
  m = { id: "m_" + uid(), name: f.name, kind, src: f.src, folderId: null };
  project.media.push(m);
  renderBin(); scheduleSave();
  return m;
}
async function addLibraryItem(f, trackId, at) {
  const m = mediaForLibraryItem(f);
  if (!m) { toast("Unsupported file type: " + f.name); return; }
  if ((m.kind === "audio" || m.kind === "video") && (m.duration == null || isNaN(m.duration))) {
    try { await loadMediaMetadata(m); } catch { }
    ensureWave(m);
    if (m.kind === "video") grabThumb(m).catch(() => { });
  }
  if (m.kind === "svg" && !runtime.mediaAux.get(m.id)?.svgText) {
    try { await loadMediaMetadata(m); } catch { }
  }
  if (m.kind === "image" && !runtime.mediaAux.get(m.id)?.img) {
    try { await loadMediaMetadata(m); } catch { }
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
    const icon = mediaKindIcon(kind, "🧩");
    item.innerHTML = `
      <div class="bin-thumb${kind === "svg" ? " svg" : ""}"></div>
      <div class="bin-meta">
        <div class="bin-name"></div>
        <div class="bin-sub">${(f.size / 1024).toFixed(0)} KB</div>
      </div>
      ${dir === "sfx" ? `<button class="btn tiny lib-play" title="Preview">▶</button>` : ""}
      <button class="btn tiny accent lib-add" title="Add at playhead">＋</button>`;
    const thumbEl = item.querySelector(".bin-thumb");
    if (visual) thumbEl.style.backgroundImage = `url(${JSON.stringify(f.src)})`;
    else thumbEl.textContent = icon;
    const nameEl = item.querySelector(".bin-name");
    nameEl.textContent = f.name;
    nameEl.title = f.rel || f.name;
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
/* Undo entries are {clips, markers} snapshots. Drag gestures still push a bare
   clips array (taken at pointerdown) — restoring one leaves markers alone. */
function undoSnapshot() {
  return JSON.stringify({ clips: project.clips, markers: project.markers || [] });
}
/** Record an undo step — `snap` lets an edit snapshot first and record only
 *  once it knows it changed something. */
function pushUndo(snap = undoSnapshot()) {
  runtime.undo.push(snap);
  if (runtime.undo.length > 100) runtime.undo.shift();
  runtime.redo.length = 0;
}
function restoreSnapshot(json) {
  const snap = JSON.parse(json);
  if (Array.isArray(snap)) project.clips = snap;
  else { project.clips = snap.clips; project.markers = snap.markers; }
}
function undo() {
  if (!runtime.undo.length) return;
  runtime.redo.push(undoSnapshot());
  restoreSnapshot(runtime.undo.pop());
  pruneSelection();
  scheduleSave(); renderInspector();
}
function redo() {
  if (!runtime.redo.length) return;
  runtime.undo.push(undoSnapshot());
  restoreSnapshot(runtime.redo.pop());
  pruneSelection();
  scheduleSave(); renderInspector();
}

function defaultTrackFor(kind) {
  return kind === "audio" ? "A1" : kind === "svg" ? "V3" : "V1";
}
/* ── Clip enable / lock / link ── Each acts on the selection's whole linked
   group, so picture and stems never end up in different states. */
function toggleClipsDisabled() {
  const group = withLinked(selectedClips());
  if (!group.length) { toast("Select a clip first"); return; }
  if (group.some(isClipLocked)) { toastLocked(); return; }
  const disable = group.some((c) => c.disabled !== true);
  pushUndo();
  for (const c of group) { if (disable) c.disabled = true; else delete c.disabled; }
  state.dirtyTimeline = true;
  scheduleSave(); renderInspector();
  toast(disable ? "Clip disabled — hidden from preview and export" : "Clip enabled");
}
function toggleClipsLocked() {
  const group = withLinked(selectedClips());
  if (!group.length) { toast("Select a clip first"); return; }
  const lock = group.some((c) => c.locked !== true);
  pushUndo();
  for (const c of group) { if (lock) c.locked = true; else delete c.locked; }
  state.dirtyTimeline = true;
  scheduleSave(); renderInspector();
  const trackLocked = !lock && group.some((c) => isTrackLocked(c.track));
  toast(lock ? "Clip locked" : trackLocked ? "Clip unlocked — its track is still locked" : "Clip unlocked");
}
/** Why these clips can't be linked, or null when they can. Links in FableCut
 *  mean identical timing, so only aligned clips of one file qualify: one
 *  video plus its audio (e.g. after unlink → nudge → nudge back). */
function linkRefusal(clips) {
  const near = (a, b) => Math.abs((+a || 0) - (+b || 0)) < 1e-3;
  if (clips.length < 2) return "Select a video clip and its audio to link";
  if (clips.some((c) => c.kind !== "video" && c.kind !== "audio")) return "Only video and audio clips can be linked";
  if (clips.filter((c) => c.kind === "video").length !== 1) return "Select exactly one video clip and its audio";
  const v = clips.find((c) => c.kind === "video");
  if (clips.some((c) => !c.mediaId || baseMediaId(c.mediaId) !== v.mediaId)) return "Linked clips must come from the same media file";
  if (clips.some((c) => !near(c.start, v.start) || !near(c.in, v.in) || !near(c.duration, v.duration)))
    return "Line the clips up first — same start, in point and length";
  return null;
}
function toggleLinkSelected() {
  const sel = selectedClips();
  if (!sel.length) { toast("Select clips first"); return; }
  const linked = sel.filter((c) => c.linkGroup || c.linkedId);
  if (linked.length) {
    const group = withLinked(linked);
    if (group.some(isClipLocked)) { toastLocked(); return; }
    pushUndo();
    for (const c of group) { delete c.linkGroup; delete c.linkedId; c.unlinked = true; }
    toast("Unlinked — video and audio now move and trim separately");
  } else {
    const why = linkRefusal(sel);
    if (why) { toast(why); return; }
    if (sel.some(isClipLocked)) { toastLocked(); return; }
    pushUndo();
    const lg = "lg_" + uid();
    for (const c of sel) { c.linkGroup = lg; delete c.linkedId; delete c.unlinked; }
    toast("Linked");
  }
  state.dirtyTimeline = true;
  scheduleSave(); renderInspector();
}
function syncLinkedTiming(c) {
  for (const L of withLinked([c])) {
    if (L.id === c.id) continue;
    L.start = c.start;
    L.in = c.in;
    L.duration = c.duration;
    if (c.props?.speed != null) {
      L.props = L.props || {};
      L.props.speed = c.props.speed;
    }
  }
}
/* Discrete-channel labels for linked stems (WAV / Web Audio order). */
const CHANNEL_SHORT = ["L", "R", "C", "LFE", "Ls", "Rs", "Lb", "Rb"];
const CHANNEL_LONG = ["Left", "Right", "Center", "LFE", "Surround L", "Surround R", "Back L", "Back R"];
function audioChannelShort(ch) {
  if (!Number.isInteger(ch) || ch < 0) return "";
  return CHANNEL_SHORT[ch] || `Ch${ch + 1}`;
}
function audioChannelLong(ch) {
  if (!Number.isInteger(ch) || ch < 0) return null;
  return CHANNEL_LONG[ch] || `Channel ${ch + 1}`;
}
/** Default stereo pan for an isolated linked stem (L −1, R +1, else center). */
function defaultPanForChannel(ch) {
  if (ch === 0) return -1;
  if (ch === 1) return 1;
  return 0;
}
function clipPan(v) { return clamp(+v || 0, -1, 1); }
/** Grow A-tracks to at least `need` (capped at MAX_TRACKS_PER_KIND). Returns how many were added. */
function ensureAudioTrackCount(need) {
  need = Math.min(Math.max(0, need | 0), MAX_TRACKS_PER_KIND);
  let added = 0;
  while (audioTrackIds().length < need) {
    if (TRACKS.filter((t) => t.kind === "audio").length >= MAX_TRACKS_PER_KIND) break;
    const id = nextTrackId("audio");
    TRACKS.push(makeTrack(id, "audio"));
    if (state.soloId && state.soloId !== id) state.disabledTracks.add(id);
    added++;
  }
  if (!added) return 0;
  sortTracksInPlace();
  applyTrackHeights();
  project.tracks = serializeTracks();
  if (state.disabledTracks.size) project.disabledTracks = [...state.disabledTracks].sort();
  syncAudioGraphTracks();
  buildTrackDOM();
  syncAllTrackDisabledUI();
  state.dirtyTimeline = true;
  rebuildClips();
  const h = setTimelineHeight(Math.max(
    $("timelinePanel")?.getBoundingClientRect().height || 0,
    defaultTimelineHeight()
  ));
  localStorage.setItem(TL_H_KEY, String(h));
  scheduleSave();
  return added;
}
/** Attach one audio clip per source channel (A1…An), sharing the video's linkGroup. */
function attachLinkedAudioChannels(videoClip, m, nCh) {
  if (!videoClip?.linkGroup || !getClip(videoClip.id)) return [];
  const lg = videoClip.linkGroup;
  // Drop any prior stems for this group (e.g. stereo placeholder → 3.0 upgrade).
  const doomed = project.clips.filter((x) => x.linkGroup === lg && x.kind === "audio");
  for (const c of doomed) releaseClipEl(c.id);
  project.clips = project.clips.filter((x) => !(x.linkGroup === lg && x.kind === "audio"));
  const ids = audioTrackIds();
  const n = Math.min(Math.max(1, nCh | 0), ids.length);
  const out = [];
  for (let ch = 0; ch < n; ch++) {
    const a = {
      id: "c_" + uid(), mediaId: m.id, kind: "audio", track: ids[ch],
      start: videoClip.start, in: videoClip.in, duration: videoClip.duration,
      name: videoClip.name,
      props: { ...DEFAULT_PROPS, audioChannel: ch, pan: defaultPanForChannel(ch) },
      linkGroup: lg,
    };
    if (videoClip.props?.speed != null) a.props.speed = videoClip.props.speed;
    project.clips.push(a);
    out.push(a);
  }
  return out;
}
function addClipFromMedia(m, trackId, at) {
  const kind = m.kind;
  trackId = trackId || defaultTrackFor(kind);
  const tr = TRACKS.find((t) => t.id === trackId);
  if (!tr || (kind === "audio") !== (tr.kind === "audio")) trackId = defaultTrackFor(kind);
  if (isTrackLocked(trackId)) { toast(`${trackId} is locked — unlock it to add clips`); return null; }
  pushUndo();
  const start = Math.max(0, at ?? state.time);
  const duration = m.duration || 5;
  const name = m.name.replace(/\.[^.]+$/, "");
  const c = {
    id: "c_" + uid(), mediaId: m.id, kind, track: trackId,
    start, in: 0, duration, name,
    props: { ...DEFAULT_PROPS },
  };
  project.clips.push(c);
  // Video+audio: picture on a V track; one linked stem per source channel on A-tracks.
  // Mute the video clip so audio isn't doubled. If channel count isn't known yet,
  // plant a stereo placeholder now (so the drop isn't picture-only, and so the
  // next pushUndo snapshot includes the AV link); reconcileAudioChannels upgrades
  // or trims once decodeAudioData reports the real count.
  if (kind === "video") {
    c.props.volume = 0;
    c.linkGroup = "lg_" + uid();
    const nCh = m.channels > 0 ? m.channels : 2;
    const added = ensureAudioTrackCount(Math.min(nCh, MAX_TRACKS_PER_KIND));
    if (added) {
      toast(added === 1
        ? `Added an audio track for ${nCh}-channel audio`
        : `Added ${added} audio tracks for ${nCh}-channel audio`);
    }
    attachLinkedAudioChannels(c, m, nCh);
    ensureWave(m);
    reconcileAudioChannels(c);
  }
  selectClip(c.id); scheduleSave();
  return c;
}
/** Source In→Out window for insert/replace (media-local seconds). Images/SVGs
 *  use marks only as timeline duration (`in` stays 0). */
function sourceInsertWindow() {
  const m = sourceMedia();
  if (!m) return null;
  const mediaDur = sourceDur();
  if (m.kind === "image" || m.kind === "svg") {
    const a = state.source.in != null ? state.source.in : 0;
    const b = state.source.out != null ? state.source.out : (m.duration || 5);
    const duration = Math.max(MIN_DUR, b - a);
    return { m, inn: 0, duration };
  }
  const inn = state.source.in != null ? state.source.in : 0;
  let out = state.source.out != null ? state.source.out : mediaDur;
  if (!(mediaDur > 0)) return null;
  out = Math.min(out, mediaDur);
  const innClamped = clamp(inn, 0, Math.max(0, mediaDur - MIN_DUR));
  if (!(out > innClamped + MIN_DUR * 0.5)) return null;
  return { m, inn: innClamped, duration: out - innClamped };
}
function toastSourceWindowMissing() {
  if (!state.source.mediaId)
    toast("Load Source first (double-click Project or a timeline clip)");
  else
    toast("Mark a Source range (I / O) — or load media with a known duration");
}
function toastNoSourceTarget() {
  toast("No targeted track for this media — click a track name to target it (and unlock it)");
}
/** Premiere-style Insert: place Source In→Out at the timeline playhead and
 *  ripple later clips on targeted tracks (EDIT.insertAt). */
function insertSourceAtPlayhead() {
  const win = sourceInsertWindow();
  if (!win) { toastSourceWindowMissing(); return; }
  const { m, inn, duration } = win;
  if (!sourceEditTracks(m).some(Boolean)) { toastNoSourceTarget(); return; }
  if (state.playing) pause();
  if (state.source.playing) pauseSource();
  pushUndo();
  const { clip: c, at } = EDIT.insertAt(m, inn, duration, state.time);
  if (c) selectClip(c.id);
  state.time = +(at + duration).toFixed(4);
  state.dirtyTimeline = true;
  scheduleSave();
  ensurePlayheadVisible();
}
/** Premiere-style Overwrite / Replace: place Source In→Out at the playhead,
 *  punching destination tracks (no ripple). When Source was loaded from a
 *  timeline clip, instead retarget that instance's In/Out and ripple later
 *  clips on its tracks by the duration delta. */
function replaceSourceAtPlayhead() {
  const win = sourceInsertWindow();
  if (!win) { toastSourceWindowMissing(); return; }
  if (state.source.fromClipId) {
    const existing = getClip(state.source.fromClipId);
    if (existing && existing.mediaId === win.m.id) {
      if (isGroupLocked(existing)) { toastLocked(); return; }
      applySourceWindowToClip(existing, win);
      return;
    }
  }
  const { m, inn, duration } = win;
  if (!sourceEditTracks(m).some(Boolean)) { toastNoSourceTarget(); return; }
  if (state.playing) pause();
  if (state.source.playing) pauseSource();
  pushUndo();
  const { clip: c, at } = EDIT.overwriteAt(m, inn, duration, state.time);
  pruneSelection();
  if (c) selectClip(c.id);
  state.time = +(at + duration).toFixed(4);
  state.dirtyTimeline = true;
  scheduleSave();
  ensurePlayheadVisible();
}
/** Apply Source In→Out to a timeline clip loaded into Source. Updates linked
 *  stems, then ripples later clips on those tracks when duration changes. */
function applySourceWindowToClip(c, win) {
  if (isGroupLocked(c)) { toastLocked(); return; }
  const { inn, duration: mediaWin } = win;
  const sp = clipSpeed(c);
  if (hasSpeedRamp(c)) {
    toast("Cannot retarget Source In/Out on a clip with a speed ramp");
    return;
  }
  const newDur = Math.max(MIN_DUR, mediaWin / sp);
  const oldEnd = clipEnd(c);
  const delta = newDur - c.duration;
  if (state.playing) pause();
  if (state.source.playing) pauseSource();

  pushUndo();
  const group = withLinked([c]);
  const groupIds = new Set(group.map((x) => x.id));
  const tracks = new Set(group.map((x) => x.track));
  const innR = +inn.toFixed(4);
  const durR = +newDur.toFixed(4);
  for (const x of group) {
    x.in = innR;
    x.duration = durR;
    x.keyframes = shiftKF(x.keyframes, 0, x.duration);
    if (x.transitionIn && x.transitionIn.duration > x.duration)
      x.transitionIn.duration = +x.duration.toFixed(3);
    if (x.transitionOut && x.transitionOut.duration > x.duration)
      x.transitionOut.duration = +x.duration.toFixed(3);
  }
  if (Math.abs(delta) > 1e-6) {
    const eps = 1e-6;
    // Sync lock: linked partners ride along even on untargeted tracks.
    const movers = withoutLocked(withLinked(project.clips.filter((x) =>
      !groupIds.has(x.id) && tracks.has(x.track) && isEditTarget(x.track) && x.start >= oldEnd - eps
    )));
    for (const x of movers) x.start = Math.max(0, +(x.start + delta).toFixed(4));
  }
  selectClip(c.id);
  state.time = +(c.start + newDur).toFixed(4);
  state.dirtyTimeline = true;
  scheduleSave();
  ensurePlayheadVisible();
  renderInspector();
}
/* Resolve (and cache) a media's real channel count via Web Audio decode —
   <video>/<audio> metadata (probeAV) doesn't expose it, only decodeAudioData
   does. Shares the getAudioBuffer() cache, so this never decodes twice. */
async function detectChannelCount(m) {
  if (m.channels != null) return m.channels;
  try {
    const buf = await getAudioBuffer(m);
    if (m.channels == null) m.channels = buf.numberOfChannels;
  } catch { if (m.channels == null) m.channels = 2; }
  return m.channels;
}
/* Keep a video clip's linked per-channel audio clips in sync with its
   media's actual channel count. Channels 0/1 (A1/A2) are created
   synchronously by addClipFromMedia; this handles channel 3+ once the async
   channel-count decode resolves, growing the audio track set (A5, A6, …) via
   ensureAudioTrackCount() for sources beyond 4 channels (5.1, 7.1…), and is
   also re-run after replaceClipMedia swaps the source. Drops linked clips
   for channels the (new) source no longer has, and warns only if a source
   has more channels than MAX_TRACKS_PER_KIND. */
async function reconcileAudioChannels(videoClip, onlyTargeted = false) {
  if (videoClip.kind !== "video" || !videoClip.linkGroup) return;
  const mediaId = videoClip.mediaId;
  const m = getMedia(mediaId);
  if (!m) return;
  const chCount = await detectChannelCount(m);
  const live = getClip(videoClip.id);
  if (!live || live.mediaId !== mediaId) return; // superseded by a newer add/replace
  const lg = live.linkGroup;
  const tracksBefore = audioTrackIds().length;
  if (chCount > tracksBefore) ensureAudioTrackCount(chCount);
  const ids = audioTrackIds();
  const newTracks = ids.length - tracksBefore;
  const wantCh = Math.min(chCount, ids.length);
  const have = project.clips.filter((c) => c.linkGroup === lg && c.kind === "audio");
  let added = 0, removed = 0;
  for (const c of have) {
    if ((c.props?.audioChannel ?? 0) >= wantCh) {
      releaseClipEl(c.id);
      project.clips = project.clips.filter((x) => x !== c);
      removed++;
    }
  }
  for (let ch = 0; ch < wantCh; ch++) {
    if (have.some((c) => c.props?.audioChannel === ch)) continue;
    if (onlyTargeted && !isEditTarget(ids[ch])) continue;
    project.clips.push({
      id: "c_" + uid(), mediaId, kind: "audio", track: ids[ch],
      start: live.start, in: live.in, duration: live.duration, name: live.name,
      props: { ...DEFAULT_PROPS, audioChannel: ch, pan: defaultPanForChannel(ch) },
      linkGroup: lg,
    });
    added++;
  }
  if (!added && !removed) {
    if (newTracks > 0) scheduleSave();
    return;
  }
  state.dirtyTimeline = true;
  scheduleSave(); renderInspector();
  if (chCount > ids.length)
    toast(`${m.name}: ${chCount} audio channels, only ${MAX_TRACKS_PER_KIND} tracks supported — extra channel(s) dropped`);
  else if (added)
    toast(newTracks
      ? `${m.name}: added ${newTracks} audio track${newTracks === 1 ? "" : "s"} and linked ${wantCh} channels`
      : `Linked ${wantCh} audio channel${wantCh === 1 ? "" : "s"} from ${m.name}`);
  else if (removed)
    toast(`${m.name} has fewer channels — removed ${removed} linked audio clip(s)`);
}
/* Apply a named title style: reset the props a style owns, merge the style,
   place it (canvas-aware), and make sure its fonts are loaded.
   keepTransform: restyle the look only — x/y/scale/rotation/align stay as the
   user set them. Used when switching styles on an existing clip; new titles
   (keepTransform=false) still get the style's placement. */
function applyTitleStyle(clip, name, { keepTransform = false } = {}) {
  const st = TITLE_STYLES[name] || TITLE_STYLES.plain;
  const P = clip.props;
  const kept = keepTransform
    ? { x: P.x, y: P.y, scale: P.scale, rotation: P.rotation, align: P.align }
    : null;
  Object.assign(P, STYLE_RESET, st.props);
  if (kept) Object.assign(P, kept);
  else {
    const H = project.height || 720, W = project.width || 1280;
    const place = st.place || "center";
    P.x = 0;
    P.y = place === "lower" ? Math.round(H * 0.30)
      : place === "upper" ? -Math.round(H * 0.30)
        : place === "lower-left" ? Math.round(H * 0.28) : 0;
    if (place === "lower-left") { P.x = -Math.round(W * 0.18); P.align = "left"; }
  }
  ensureFont(P.font);
  if (Array.isArray(P.fontCutSet)) P.fontCutSet.forEach(ensureFont);
  clip.styleName = name;
}
/* Custom title-style dropdown: every entry renders in its own font, hovering
   an entry live-previews the style on the canvas (transform kept — see
   applyTitleStyle), moving away reverts, clicking commits. Nothing is saved
   until a click. */
function openStylePicker(anchor, c) {
  const snap = { props: JSON.parse(JSON.stringify(c.props)), styleName: c.styleName };
  let committed = false;
  const rewind = () => {
    if (committed) return;
    c.props = JSON.parse(JSON.stringify(snap.props));
    c.styleName = snap.styleName;
  };
  const menu = document.createElement("div");
  menu.className = "style-menu";
  for (const [k, v] of Object.entries(TITLE_STYLES)) {
    ensureFont(v.props.font); // so the entry itself renders in the style's face
    const it = document.createElement("div");
    it.className = "style-opt" + (c.styleName === k ? " on" : "");
    it.textContent = v.label;
    it.style.fontFamily = `"${v.props.font}", sans-serif`;
    if (v.props.uppercase) it.style.textTransform = "uppercase";
    it.addEventListener("mouseenter", () => {
      rewind(); // preview from the clip's real state, not a previous preview
      applyTitleStyle(c, k, { keepTransform: true });
    });
    it.addEventListener("click", () => {
      rewind();
      pushUndo();
      applyTitleStyle(c, k, { keepTransform: true });
      committed = true;
      close();
      scheduleSave(); renderInspector();
    });
    menu.appendChild(it);
  }
  menu.addEventListener("mouseleave", rewind);
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
  function close() {
    rewind();
    menu.remove();
    document.removeEventListener("pointerdown", onDoc, true);
    runtime.styleMenu = null;
  }
  document.addEventListener("pointerdown", onDoc, true);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.round(Math.min(r.left, innerWidth - 220)) + "px";
  menu.style.top = Math.round(Math.min(r.bottom + 4, innerHeight - 340)) + "px";
  document.body.appendChild(menu);
  runtime.styleMenu = { close };
}
function closeStylePicker() { if (runtime.styleMenu) runtime.styleMenu.close(); }
/* Swap a clip's source media in place: position, trim, keyframes, transitions,
   props and name are all untouched. If the clip is part of a linkGroup (video
   + its L/R audio companions extracted from the same file), replacing the
   video member cascades the new mediaId to those companions too, since they
   represent channels of the same source. If the new source is shorter than
   the clip's current in/duration window, the trim is clamped to fit. */
function replaceClipMedia(clip, media) {
  if (!media || (clip.mediaId === media.id)) return;
  pushUndo();
  const targets = (clip.kind === "video" && clip.linkGroup)
    ? project.clips.filter((c) => c.linkGroup === clip.linkGroup)
    : [clip];
  let trimmed = false;
  for (const c of targets) {
    c.mediaId = media.id;
    // the clip's cached <video>/<audio> element (and its Web Audio graph node)
    // is keyed by clip id and still points at the old src — drop it so
    // getClipEl() rebuilds it against the new media on the next sync/frame.
    releaseClipEl(c.id);
    if (media.duration == null) continue;
    const speed = c.props?.speed || 1;
    // in + duration×speed ≤ media.duration (see CLAUDE.md props reference)
    const maxIn = Math.max(0, media.duration - 0.001);
    if (c.in > maxIn) { c.in = maxIn; trimmed = true; }
    const maxDur = Math.max(0.05, (media.duration - c.in) / speed);
    if (c.duration > maxDur) { c.duration = maxDur; trimmed = true; }
  }
  if (media.kind === "video" || media.kind === "audio") ensureWave(media);
  if (clip.kind === "video") reconcileAudioChannels(clip); // add/drop A3+ channel clips once decoded
  state.dirtyTimeline = true;
  scheduleSave(); renderInspector();
  toast(trimmed ? "Media replaced — trimmed to fit shorter source" : "Media replaced");
}
/* A dedicated, lazily-created file input for the "Browse file…" replace
   action — deliberately NOT the shared #fileInput (also driven by the global
   "+ Import" button): that one carries no target-clip state of its own, so
   if this flow set a pending-replace flag on it and the user then cancelled
   the OS file dialog (no "change" event fires on cancel), the flag would
   stay stuck and hijack the next *unrelated* normal import. This input's
   pending target lives in its own closure instead, so it can never leak
   into a different import path. */
let replaceFileInput = null, replaceFileTargetId = null;
function pickReplacementFile(clip) {
  if (!replaceFileInput) {
    replaceFileInput = document.createElement("input");
    replaceFileInput.type = "file";
    replaceFileInput.accept = els.fileInput.accept;
    replaceFileInput.className = "sr-only";
    document.body.appendChild(replaceFileInput);
    replaceFileInput.addEventListener("change", async () => {
      const files = replaceFileInput.files;
      replaceFileInput.value = "";
      const targetId = replaceFileTargetId;
      replaceFileTargetId = null;
      if (!files.length) return;
      const added = await importFiles(files);
      const c = getClip(targetId);
      if (!c || !added.length) return;
      const m = added.find((x) => x.kind === c.kind) || added[0];
      if (m.kind === c.kind) replaceClipMedia(c, m);
      else toast(`Imported, but can't replace a ${c.kind} clip with ${m.kind === "audio" ? "an" : "a"} ${m.kind}`);
    });
  }
  replaceFileTargetId = clip.id;
  replaceFileInput.click();
}
/* Media-replace dropdown for the Inspector's "Source" button — same widget
   pattern as openStylePicker (floating menu, click outside to cancel). Lists
   bin/library media of the same kind as the clip, plus a "Browse file…" entry
   that imports a new file and replaces with it directly. */
function openMediaPicker(anchor, c) {
  const compatible = project.media.filter((m) => m.kind === c.kind && m.id !== c.mediaId);
  const menu = document.createElement("div");
  menu.className = "style-menu";
  const browse = document.createElement("div");
  browse.className = "style-opt media-opt";
  browse.textContent = "📂 Browse file…";
  browse.addEventListener("click", () => {
    close();
    pickReplacementFile(c);
  });
  menu.appendChild(browse);
  if (compatible.length) {
    const sep = document.createElement("div");
    sep.style.cssText = "height:1px;background:var(--border);margin:4px 2px;";
    menu.appendChild(sep);
    for (const m of compatible) {
      const it = document.createElement("div");
      it.className = "style-opt media-opt";
      it.textContent = m.name;
      it.title = m.name;
      it.addEventListener("click", () => { close(); replaceClipMedia(c, m); });
      menu.appendChild(it);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "style-opt media-opt";
    empty.style.opacity = ".6";
    empty.style.cursor = "default";
    empty.textContent = `No other ${c.kind} in bin`;
    menu.appendChild(empty);
  }
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
  function close() {
    menu.remove();
    document.removeEventListener("pointerdown", onDoc, true);
    runtime.mediaMenu = null;
  }
  document.addEventListener("pointerdown", onDoc, true);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.round(Math.min(r.left, innerWidth - 220)) + "px";
  menu.style.top = Math.round(Math.min(r.bottom + 4, innerHeight - 340)) + "px";
  document.body.appendChild(menu);
  runtime.mediaMenu = { close };
}
function closeMediaPicker() { if (runtime.mediaMenu) runtime.mediaMenu.close(); }
function addTitle() {
  if (isTrackLocked("V2")) { toast("V2 is locked — unlock it to add a title"); return; }
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
  if (isTrackLocked("V3")) { toast("V3 is locked — unlock it to add an adjustment layer"); return; }
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
  const snap = undoSnapshot();
  const { removed, blocked } = EDIT.removeClips(selectedClips());
  if (blocked) toastLocked(removed.length > 0);
  if (!removed.length) return;
  pushUndo(snap);
  setSelection([]);
  scheduleSave(); renderInspector();
}
/** Delete selection and pull later clips left on targeted tracks (per-track ripple). */
function rippleDeleteSelected() {
  const snap = undoSnapshot();
  const { removed, blocked } = EDIT.rippleDelete(selectedClips());
  if (blocked) toastLocked(removed.length > 0);
  if (!removed.length) return;
  pushUndo(snap);
  setSelection([]);
  state.dirtyTimeline = true;
  scheduleSave(); renderInspector();
}
const GAP_EPS = FableCutEdit.GAP_EPS;
/* Sync-safe close (EDIT.closeGapAt): every targeted track must have a gap at
   the playhead; their intersection closes. Locked clips stay put. */
function closeGapAtPlayhead() {
  const snap = undoSnapshot();
  const G = EDIT.closeGapAt(state.time);
  if (typeof G === "string") { toast(G); return; }
  pushUndo(snap);
  state.dirtyTimeline = true;
  scheduleSave();
  const label = G >= 1 ? G.toFixed(2) : G.toFixed(3);
  toast(`Closed ${label}s gap`);
}
function clearFocusedTransition() {
  if (!state.transFocus || !state.selId) return false;
  const c = getClip(state.selId);
  if (!c) return false;
  if (isGroupLocked(c)) { toastLocked(); return true; }
  const key = state.transFocus === "in" ? "transitionIn" : "transitionOut";
  if (!c[key]) return false;
  pushUndo();
  c[key] = undefined;
  state.transFocus = null;
  state.dirtyTimeline = true;
  scheduleSave();
  renderInspector();
  return true;
}
function loadLastTransition(side) {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_TRANS_KEY[side]) || "null");
    if (raw?.type && raw.type !== "none" && TRANSITIONS.includes(raw.type)) {
      const dur = +raw.duration;
      return { type: raw.type, duration: isFinite(dur) && dur >= MIN_TRANS_DUR ? dur : 1 };
    }
  } catch {}
  return { ...DEFAULT_LAST_TRANS };
}
function saveLastTransition(side, tr) {
  if (!tr?.type || tr.type === "none") return;
  try {
    localStorage.setItem(LAST_TRANS_KEY[side], JSON.stringify({
      type: tr.type,
      duration: Math.max(MIN_TRANS_DUR, +tr.duration || 1),
    }));
  } catch {}
}
function addTransitionAtPlayhead() {
  const c = getClip(state.selId);
  if (!c) { toast("Select a clip first"); return; }
  const t = state.time;
  if (t < c.start || t >= clipEnd(c)) { toast("Move playhead over the selected clip"); return; }
  const side = (t - c.start) / c.duration < 0.5 ? "in" : "out";
  const key = side === "in" ? "transitionIn" : "transitionOut";
  const preset = loadLastTransition(side);
  const dur = Math.min(Math.max(MIN_TRANS_DUR, preset.duration), c.duration);
  pushUndo();
  c[key] = { type: preset.type, duration: +dur.toFixed(3) };
  saveLastTransition(side, c[key]);
  state.dirtyTimeline = true;
  selectClip(c.id, { transFocus: side });
  scheduleSave();
}
/* Search window: IN–OUT when both markers are set, else the full project span. */
function gapSearchRange() {
  if (project.inPoint != null && project.outPoint != null) {
    return { t0: project.inPoint, t1: project.outPoint };
  }
  return { t0: 0, t1: Math.max(projDur(), 0) };
}
function ensurePlayheadVisible() {
  const px = state.time * state.pps, sc = els.timelineScroll;
  if (!sc) return;
  if (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 40) {
    sc.scrollLeft = Math.max(0, px - sc.clientWidth / 3);
  }
}
/* Jump playhead to the middle of the next aligned gap (wraps). */
function goToNextGap() {
  const { t0, t1 } = gapSearchRange();
  if (t1 - t0 <= GAP_EPS) { toast("No gaps found"); return; }
  const gaps = listAlignedGaps(t0, t1);
  if (!gaps.length) {
    toast(project.inPoint != null && project.outPoint != null
      ? "No gaps in IN/OUT range" : "No gaps found");
    return;
  }
  const t = state.time;
  let g = gaps.find((x) => (x.L + x.R) / 2 > t + GAP_EPS);
  if (!g) g = gaps[0];
  setTime((g.L + g.R) / 2);
  ensurePlayheadVisible();
}
function splitAtPlayhead() {
  // A selection splits wherever it sits; with none, the targeted tracks do.
  const snap = undoSnapshot();
  const { split, blocked } = EDIT.splitAt(state.time, state.selIds.size ? selectedClips() : null);
  if (!split) { if (blocked) toastLocked(); return; }
  pushUndo(snap);
  scheduleSave();
}
/* Split every targeted-track clip that crosses IN and/or OUT (no head/tail removal). */
function splitAtWorkArea() {
  const cuts = [project.inPoint, project.outPoint].filter((t) => t != null);
  if (!cuts.length) {
    toast("Set an IN or OUT marker first (I / O)");
    return;
  }
  const snap = undoSnapshot();
  if (!EDIT.splitAtTimes(cuts)) { toast("Nothing to split at IN/OUT"); return; }
  pushUndo(snap);
  scheduleSave();
}
function trimToPlayhead(side) {
  const c = getClip(state.selId);
  if (!c) return;
  if (isGroupLocked(c)) { toastLocked(); return; }
  const t = state.time;
  if (t <= c.start && side === "in") return;
  pushUndo();
  if (side === "in" && t > c.start && t < clipEnd(c) - MIN_DUR) {
    const d = t - c.start;
    c.start = t; c.in += d * clipSpeed(c); c.duration -= d;
  } else if (side === "out" && t > c.start + MIN_DUR && t < clipEnd(c)) {
    c.duration = t - c.start;
  }
  syncLinkedTiming(c);
  scheduleSave(); renderInspector();
}
/* Split at IN/OUT and discard clip heads before IN and tails after OUT.
   Targets targeted tracks; linked partners get the identical trim (sync lock). */
function trimToWorkArea() {
  const inn = project.inPoint, out = project.outPoint;
  if (inn == null && out == null) {
    toast("Set an IN or OUT marker first (I / O)");
    return;
  }
  const snap = undoSnapshot();
  if (!EDIT.trimToRange(inn, out)) { toast("Nothing to trim"); return; }
  pushUndo(snap);
  pruneSelection();
  scheduleSave();
  renderInspector();
}
/** Lift (;) removes IN→OUT on the targeted tracks and leaves the gap.
 *  Extract (') removes it and closes the gap. Linked partners are cut too,
 *  locked clips stay whole, and IN / OUT clear afterwards (as in Premiere). */
function liftExtract(extract) {
  const t0 = project.inPoint, t1 = project.outPoint;
  const snap = undoSnapshot();
  const why = EDIT.liftRange(t0, t1, extract);
  if (why) { toast(why); return; }
  pushUndo(snap);
  project.inPoint = project.outPoint = null;
  updateWorkArea();
  syncTrimIOButton();
  pruneSelection();
  setTime(t0);
  state.dirtyTimeline = true;
  scheduleSave();
  toast(`${extract ? "Extracted" : "Lifted"} ${(t1 - t0).toFixed(2)}s`);
}
/** Shift+D: crossfade the cuts of the selected audio clips, or — with no
 *  selection — the audio cut nearest the playhead on each targeted track. */
function crossfadeSelected(dur = FableCutEdit.CROSSFADE_DUR) {
  const pairs = state.selIds.size ? crossfadeCuts(withLinked(selectedClips())) : EDIT.crossfadeCutsNear(state.time);
  if (!pairs.length) {
    toast(state.selIds.size ? "No audio cut next to the selection — clips must touch or overlap on one track"
      : "No audio cut near the playhead on the targeted tracks");
    return;
  }
  pushUndo();
  const { done, why } = EDIT.crossfadePairs(pairs, dur);
  state.dirtyTimeline = true;
  scheduleSave();
  renderInspector();
  if (done) toast(`Crossfaded ${done} cut${done === 1 ? "" : "s"}` + (why.length ? ` · skipped: ${why.join(", ")}` : ""));
  else toast(`Couldn't crossfade: ${why.join(", ")}`);
}
function hasWorkArea() {
  return project.inPoint != null || project.outPoint != null;
}
/* Active work-area playback bounds. Missing IN → 0; missing OUT → project end. */
function playRange() {
  const start = project.inPoint != null ? project.inPoint : 0;
  const end = project.outPoint != null ? project.outPoint : Math.max(projDur(), 0);
  return { start, end: Math.max(end, start) };
}
/* Export window. IN/OUT are clamped to the content span so a marker past
   the last clip cannot inflate a 0-length range into a 1-frame black file.
   Mode comes from the Export dialog (Entire timeline / IN–OUT). */
/** An agent's export job picks its range instead of the dialog. */
let exportRangeForced = null;
function exportRangeMode() {
  const sel = $("exportRangeSel");
  const v = exportRangeForced || (sel && sel.value === "in-out" ? "in-out" : "entire");
  if (v === "in-out" && !hasWorkArea()) return "entire";
  return v;
}
function exportRange() {
  const fps = projectFps();
  const span = Math.max(projDur(), 0);
  let start = 0, end = span;
  if (exportRangeMode() === "in-out") {
    const r = playRange();
    start = Math.min(Math.max(0, r.start), span);
    end = Math.min(Math.max(0, r.end), span);
    if (end < start) end = start;
  }
  const sec = Math.max(0, end - start);
  let frames = Math.round(sec * fps);
  if (exportRangeMode() === "entire") frames = Math.max(1, frames);
  else frames = Math.max(0, frames);
  const dur = frames / fps;
  return { start, end: start + dur, dur, frames };
}
function playLimited() {
  return state.workAreaPlay && !state.exporting && hasWorkArea();
}
/* Stop time while Limit is on. Playhead past OUT = manual override → full timeline.
   `dur`, if given, is a precomputed projDur() (callers already looping every
   clip once per frame can reuse it instead of triggering a second full scan). */
function playStopAt(dur) {
  const d = Math.max(dur ?? projDur(), 0);
  if (!playLimited()) return d;
  const { end } = playRange();
  if (state.time > end + 1e-4) return d;
  return end;
}
function gotoHome() {
  setTime(playLimited() && project.inPoint != null ? project.inPoint : 0);
}
function gotoEnd() {
  setTime(playLimited() && project.outPoint != null ? project.outPoint : projDur());
}
function setTcField(el, t) {
  if (!el) return;
  if (t == null) {
    el.textContent = "00:00:00";
    el.classList.add("unset");
  } else {
    el.textContent = fmt(t);
    el.classList.remove("unset");
  }
}
function updateTimecode(dur) {
  if (isSourceMode()) {
    els.tcCurrent.textContent = fmt(state.source.time);
    els.tcTotal.textContent = fmt(sourceDur());
    const inn = state.source.in, out = state.source.out;
    const has = inn != null || out != null;
    if (els.tcIo) {
      els.tcIo.classList.toggle("idle", !has);
      els.tcIo.setAttribute("aria-hidden", has ? "false" : "true");
    }
    setTcField(els.tcIn, inn);
    setTcField(els.tcOut, out);
    if (inn != null && out != null) setTcField(els.tcDur, Math.max(0, out - inn));
    else setTcField(els.tcDur, null);
    return;
  }
  const d = Math.max(dur ?? projDur(), 0);
  els.tcCurrent.textContent = fmt(state.time);
  els.tcTotal.textContent = fmt(d);
  const has = hasWorkArea();
  if (els.tcIo) {
    els.tcIo.classList.toggle("idle", !has);
    els.tcIo.setAttribute("aria-hidden", has ? "false" : "true");
  }
  setTcField(els.tcIn, project.inPoint);
  setTcField(els.tcOut, project.outPoint);
  if (has) {
    const { start, end } = playRange();
    setTcField(els.tcDur, Math.max(0, end - start));
  } else {
    setTcField(els.tcDur, null);
  }
}
function syncTrimIOButton() {
  const has = hasWorkArea();
  const trim = $("btnTrimIO");
  const lim = $("btnWorkAreaPlay");
  if (trim) trim.classList.toggle("hidden", !has);
  if (lim) {
    lim.classList.toggle("hidden", !has);
    lim.classList.toggle("on", state.workAreaPlay);
  }
}

/* ═══════════════════════════ TIMELINE UI ═══════════════════════════ */
const TRACK_LOCK_ICON =
  `<svg class="track-ico" viewBox="0 0 16 16" aria-hidden="true">` +
  `<path class="lock-shackle" fill="none" stroke="currentColor" stroke-width="1.6" d="M5 7V5a3 3 0 0 1 6 0v2"/>` +
  `<rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="currentColor"/></svg>`;
function trackToggleIcon(kind) {
  if (kind === "audio") {
    // Speaker
    return `<svg class="track-ico" viewBox="0 0 16 16" aria-hidden="true">` +
      `<path fill="currentColor" d="M2.5 5.75h2.2L8.2 3.1v9.8L4.7 10.25H2.5V5.75zm7.15 1.05a2.1 2.1 0 0 1 0 2.4l.95.7a3.35 3.35 0 0 0 0-3.8l-.95.7zm1.55-2.2a4.6 4.6 0 0 1 0 6.8l.95.7a5.85 5.85 0 0 0 0-8.2l-.95.7z"/>` +
      `<path class="track-ico-off" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.2 2.2l11.6 11.6"/>` +
      `</svg>`;
  }
  // Screen / monitor
  return `<svg class="track-ico" viewBox="0 0 16 16" aria-hidden="true">` +
    `<path fill="currentColor" d="M1.75 3.25h12.5v8H9.6l.4 1.5h2.25v1.25H3.75V12.75H6l.4-1.5H1.75v-8zm1.25 1.25v5.5h10.0v-5.5H3z"/>` +
    `<path class="track-ico-off" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.2 2.2l11.6 11.6"/>` +
    `</svg>`;
}
function buildTrackDOM() {
  let inner = $("trackHeadInner");
  if (!inner) {
    inner = document.createElement("div");
    inner.id = "trackHeadInner";
    els.trackHeaders.appendChild(inner);
  }
  inner.innerHTML = "";
  els.tracks.innerHTML = "";
  for (const t of TRACKS) {
    const on = isTrackEnabled(t.id);
    const solo = state.soloId === t.id;
    const h = document.createElement("div");
    h.className = "track-head" + (on ? "" : " disabled") + (solo ? " solo" : "");
    h.dataset.track = t.id;
    h.style.height = t.h + "px";
    h.innerHTML =
      `<button type="button" class="track-toggle" aria-pressed="${on}" ` +
      `title="${on ? "Disable track" : "Enable track"}" style="color:${t.color}">` +
      `${trackToggleIcon(t.kind)}</button>` +
      `<button type="button" class="track-id">${escapeHtml(t.id)}</button>` +
      `<button type="button" class="track-lock" aria-pressed="false">${TRACK_LOCK_ICON}</button>` +
      `<button type="button" class="track-solo${solo ? " on" : ""}" aria-pressed="${solo}" ` +
      `title="${solo ? "Unsolo track" : "Solo track (mute all others)"}">S</button>`;
    h.querySelector(".track-toggle").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleTrackEnabled(t.id);
    });
    h.querySelector(".track-solo").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleTrackSolo(t.id);
    });
    h.querySelector(".track-id").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleTrackTargeted(t.id);
    });
    h.querySelector(".track-lock").addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleTrackLocked(t.id);
    });
    h.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showTrackCtxMenu(ev.clientX, ev.clientY, t);
    });
    inner.appendChild(h);
    const row = document.createElement("div");
    row.className = "track" + (on ? "" : " disabled") + (solo ? " solo" : "");
    row.dataset.track = t.id;
    row.style.height = t.h + "px";
    els.tracks.appendChild(row);
  }
  syncAllTrackDisabledUI(); // lock / target state on the fresh headers
  renderMixer(); // strips follow the A-track list
}
/* keep track headers vertically aligned with the (scrollable) track rows */
els.timelineScroll.addEventListener("scroll", () => {
  const inner = $("trackHeadInner");
  if (inner) inner.style.transform = `translateY(${-els.timelineScroll.scrollTop}px)`;
});
function contentWidth() {
  const minSec = (els.timelineScroll.clientWidth || 800) / state.pps;
  return Math.max(projDur() + TIMELINE_PAD_SEC, minSec) * state.pps;
}
function clipTransitionDur(tr) {
  if (!tr || tr.type === "none") return 0;
  const d = +tr.duration;
  return isFinite(d) && d > 0 ? d : 0;
}
function clipBorderRadius() {
  return state.trackSize === "s" ? 2 : 5;
}
/* Top-edge SVG wedges — width from transition duration × pps. */
function transitionMarksHtml(c, trackH) {
  let html = "";
  const clipH = Math.max(8, trackH - 6);
  const r = clipBorderRadius();
  const wedge = (tr, side) => {
    const dur = clipTransitionDur(tr);
    if (!dur) return;
    const w = Math.max(4, Math.min(dur, c.duration) * state.pps);
    const bot = clipH - r;
    const focused = state.selId === c.id && state.transFocus === side ? " focused" : "";
    // Audio fades draw their real gain curve instead of a straight ramp.
    if (c.kind === "audio" && tr.type === "fade") {
      const N = 24, pts = [`0,0`, `${w},0`];
      for (let i = N; i >= 0; i--) {
        const u = side === "in" ? i / N : 1 - i / N;
        const g = audioFadeGain(tr.curve, u) ?? EASE["ease-out"](u);
        pts.push(`${(w * i / N).toFixed(1)},${(bot * (1 - g)).toFixed(1)}`);
      }
      html += `<div class="trans-mark ${side}${focused}" style="width:${w}px" data-side="${side}">` +
        `<svg viewBox="0 0 ${w} ${clipH}" preserveAspectRatio="none" aria-hidden="true">` +
        `<polygon points="${pts.join(" ")}"/></svg>` +
        `<div class="trans-dur-handle" title="Drag to adjust duration"></div></div>`;
      return;
    }
    if (side === "in") {
      html += `<div class="trans-mark in${focused}" style="width:${w}px" data-side="in">` +
        `<svg viewBox="0 0 ${w} ${clipH}" preserveAspectRatio="none" aria-hidden="true">` +
        `<polygon points="0,0 ${w},0 0,${bot}"/></svg>` +
        `<div class="trans-dur-handle" title="Drag to adjust duration"></div></div>`;
    } else {
      html += `<div class="trans-mark out${focused}" style="width:${w}px" data-side="out">` +
        `<svg viewBox="0 0 ${w} ${clipH}" preserveAspectRatio="none" aria-hidden="true">` +
        `<polygon points="0,0 ${w},0 ${w},${bot}"/></svg>` +
        `<div class="trans-dur-handle" title="Drag to adjust duration"></div></div>`;
    }
  };
  wedge(c.transitionIn, "in");
  wedge(c.transitionOut, "out");
  return html;
}
/* Group keyframes by clip-local time → [{ t, keys: ["opacity","scale"] }, …]. */
function clipKeyframeGroups(c) {
  if (!c?.keyframes) return [];
  const byT = new Map();
  for (const [channel, arr] of Object.entries(c.keyframes)) {
    // Auto-duck can write dozens of keys; the dashed volume line shows them.
    if (!Array.isArray(arr) || channel === "duck") continue;
    for (const kf of arr) {
      const t = +kf.t;
      if (!Number.isFinite(t)) continue;
      const key = t.toFixed(4);
      let g = byT.get(key);
      if (!g) { g = { t, keys: [] }; byT.set(key, g); }
      if (!g.keys.includes(channel)) g.keys.push(channel);
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
const clipKeyframeLocalTimes = (c) => clipKeyframeGroups(c).map((g) => g.t);
/* Diamond marks on the clip body — one per unique time; count badge if multi-channel. */
function clipKeyframesHtml(c) {
  const groups = clipKeyframeGroups(c);
  if (!groups.length || !(c.duration > 0)) return "";
  let html = `<div class="clip-kfs">`;
  for (const { t, keys } of groups) {
    if (t < -1e-6 || t > c.duration + 1e-6) continue;
    const pct = Math.max(0, Math.min(100, (t / c.duration) * 100));
    const label = keys.join(", ") + " @ " + fmt(c.start + t);
    const badge = keys.length > 1 ? `<span class="clip-kf-n">${keys.length}</span>` : "";
    const multi = keys.length > 1 ? " multi" : "";
    html += `<div class="clip-kf${multi}" style="left:${pct}%" data-t="${t}" title="${label}">${badge}</div>`;
  }
  return html + `</div>`;
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
      (state.selIds.has(c.id) ? " selected" : "") + (c.id === state.selId ? " primary" : "") +
      (isClipLocked(c) ? " locked" : "") + (c.disabled === true ? " disabled" : "") +
      (c.unlinked === true ? " unlinked" : "");
    div.dataset.id = c.id;
    div.style.left = c.start * state.pps + "px";
    div.style.width = Math.max(8, c.duration * state.pps) + "px";
    let body = "";
    if (c.kind === "video" && trackSizeShowsThumbs()) {
      const thumb = runtime.mediaAux.get(c.mediaId)?.thumb;
      if (thumb) body += `<div class="thumbs" style="background-image:url('${thumb}')"></div>`;
    }
    const hasWave = c.kind === "audio" && !!wavePeaksFor(c);
    if (hasWave) body += `<canvas class="wave"></canvas>`;
    const badge = (c.keyframes && Object.keys(c.keyframes).length ? "◆ " : "") +
                  (c.transitionIn || c.transitionOut ? "⇄ " : "");
    const chTag = (() => {
      const s = audioChannelShort(c.props?.audioChannel);
      return s ? s + " · " : "";
    })();
    const label = c.kind === "text" ? "T · " + (c.props.text || "").split("\n")[0]
      : c.kind === "adjust" ? "FX · " + (c.name || "")
      : c.kind === "audio" ? chTag + (c.name || "")
      : (c.name || "");
    body += `<div class="fade"></div>
      <div class="clip-label">${badge}${escapeHtml(label)}</div>`;
    body += clipKeyframesHtml(c);
    let inner = `<div class="clip-body">${body}</div>`;
    inner += transitionMarksHtml(c, tr.h);
    if (c.kind === "audio") inner += volBandHtml(c, tr.h) + fadeGripsHtml(c);
    inner += `<div class="handle l"></div><div class="handle r"></div>`;
    div.innerHTML = inner;
    if (hasWave) div.classList.add("has-wave");
    row.appendChild(div);
    if (hasWave) drawClipWave(div.querySelector(".wave"), c, tr.h);
  }
  paintAudioOverlaps();
  state.dirtyTimeline = false;
  updateWorkArea();
}
/* Hatched bands where two+ audio clips share a track (CSS draw, O(n²) per track). */
function paintAudioOverlaps() {
  const byTrack = new Map();
  for (const c of project.clips) {
    if (c.kind !== "audio") continue;
    let list = byTrack.get(c.track);
    if (!list) byTrack.set(c.track, list = []);
    list.push(c);
  }
  for (const [trackId, clips] of byTrack) {
    if (clips.length < 2) continue;
    const row = els.tracks.querySelector(`[data-track="${trackId}"]`);
    if (!row) continue;
    const intervals = [];
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length; j++) {
        const t0 = Math.max(clips[i].start, clips[j].start);
        const t1 = Math.min(clipEnd(clips[i]), clipEnd(clips[j]));
        if (t1 - t0 > 1e-4 && !isCrossfaded(clips[i], clips[j])) intervals.push([t0, t1]);
      }
    }
    if (!intervals.length) continue;
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [[intervals[0][0], intervals[0][1]]];
    for (let k = 1; k < intervals.length; k++) {
      const last = merged[merged.length - 1];
      const cur = intervals[k];
      if (cur[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], cur[1]);
      else merged.push([cur[0], cur[1]]);
    }
    for (const [t0, t1] of merged) {
      const el = document.createElement("div");
      el.className = "track-overlap";
      el.style.left = (t0 * state.pps) + "px";
      el.style.width = Math.max(2, (t1 - t0) * state.pps) + "px";
      el.title = "Overlapping audio";
      row.appendChild(el);
    }
  }
}

/* Two overlapping audio clips whose fades cover the overlap are a crossfade,
   not a mistake — no warning hatch. */
function isCrossfaded(x, y) {
  const [a, b] = x.start <= y.start ? [x, y] : [y, x];
  const ov = Math.min(clipEnd(a), clipEnd(b)) - b.start - 1e-3;
  return a.transitionOut?.type === "fade" && b.transitionIn?.type === "fade" &&
    a.transitionOut.duration >= ov && b.transitionIn.duration >= ov;
}

/* ── Volume line (rubber band) + fade grips on audio clips ──
   The line is the clip's volume over time on a dB taper (0 dB at 85%, +6 dB
   on top). Drag it to change the level; with keyframes, dragging moves the
   two around the pointer. Ctrl/Cmd-click the line adds a keyframe; drag a
   point to move it; Alt-click or double-click a point removes it. A dashed
   line shows the level after Auto-duck. Edits mirror onto linked stems. */
const VOL_MAX = 2; // volume ceiling, +6.02 dB
const VOL_TAPER = [[0, -60], [0.3, -30], [0.6, -12], [0.85, 0], [1, 20 * Math.log10(VOL_MAX)]];
function taperPosToDb(taper, pos) {
  pos = clamp(+pos || 0, 0, 1);
  for (let i = 1; i < taper.length; i++) {
    const [p1, d1] = taper[i], [p0, d0] = taper[i - 1];
    if (pos <= p1) return d0 + (d1 - d0) * (pos - p0) / (p1 - p0);
  }
  return taper[taper.length - 1][1];
}
function taperDbToPos(taper, db) {
  db = clamp(+db, taper[0][1], taper[taper.length - 1][1]);
  for (let i = 1; i < taper.length; i++) {
    const [p1, d1] = taper[i], [p0, d0] = taper[i - 1];
    if (db <= d1) return p0 + (p1 - p0) * (db - d0) / (d1 - d0);
  }
  return 1;
}
function volToDb(v) { return v > 0 ? 20 * Math.log10(v) : FADER_DB_MIN; }
function dbToVol(db) { return db <= FADER_DB_MIN ? 0 : Math.min(VOL_MAX, Math.pow(10, db / 20)); }
function volToPos(v) { return taperDbToPos(VOL_TAPER, volToDb(v)); }
function posToVol(pos) { return dbToVol(taperPosToDb(VOL_TAPER, pos)); }
function volumeAtLocal(c, local) {
  return clamp(kfChannel(c, "volume", local, +(c.props?.volume ?? 1)), 0, VOL_MAX);
}
function volBandHtml(c, trackH) {
  const clipH = trackH - 6;
  if (clipH < 24 || !(c.duration > 0)) return "";
  const W = Math.max(8, c.duration * state.pps), H = clipH - 6;
  const y = (v) => (3 + (1 - volToPos(v)) * H).toFixed(1);
  const kfs = c.keyframes?.volume;
  const pts = [];
  if (!kfs?.length) pts.push(`0,${y(volumeAtLocal(c, 0))}`, `${W.toFixed(1)},${y(volumeAtLocal(c, 0))}`);
  else {
    pts.push(`0,${y(kfs[0].v)}`);
    for (let i = 0; i < kfs.length; i++) {
      const b = kfs[i], a = kfs[i - 1];
      if (a && (b.ease || "ease-in-out") !== "linear") // eased segment: sample the curve
        for (let s = 1; s < 12; s++) {
          const lt = a.t + (b.t - a.t) * s / 12;
          pts.push(`${(lt * state.pps).toFixed(1)},${y(volumeAtLocal(c, lt))}`);
        }
      pts.push(`${(b.t * state.pps).toFixed(1)},${y(b.v)}`);
    }
    pts.push(`${W.toFixed(1)},${y(kfs[kfs.length - 1].v)}`);
  }
  let duck = "";
  if (c.keyframes?.duck?.length) {
    const n = Math.min(600, Math.max(2, Math.ceil(W / 3)));
    const dp = [];
    for (let i = 0; i <= n; i++) {
      const lt = c.duration * i / n;
      const v = volumeAtLocal(c, lt) * dbToGain(kfChannel(c, "duck", lt, 0));
      dp.push(`${(W * i / n).toFixed(1)},${y(v)}`);
    }
    duck = `<polyline class="vol-duck" points="${dp.join(" ")}"/>`;
  }
  const line = pts.join(" ");
  let html = `<svg class="vol-band" width="${W.toFixed(1)}" height="${clipH}" aria-hidden="true">${duck}` +
    `<polyline class="vol-line" points="${line}"/>` +
    `<polyline class="vol-hit" points="${line}"><title>Volume — drag to change · Ctrl/Cmd-click: add keyframe</title></polyline></svg>`;
  if (kfs?.length) for (let i = 0; i < kfs.length; i++) {
    const k = kfs[i];
    html += `<div class="vol-pt" data-i="${i}" style="left:${(k.t * state.pps).toFixed(1)}px;top:${y(k.v)}px" ` +
      `title="${fmtDb(volToDb(k.v))} @ ${fmt(c.start + k.t)} — drag · Alt-click: remove"></div>`;
  }
  return html;
}
function fadeGripsHtml(c) {
  const fin = c.transitionIn?.type === "fade" ? clipTransitionDur(c.transitionIn) : 0;
  const fout = c.transitionOut?.type === "fade" ? clipTransitionDur(c.transitionOut) : 0;
  return `<div class="fade-grip l" style="left:${(Math.min(fin, c.duration) * state.pps).toFixed(1)}px" title="Drag to fade in"></div>` +
    `<div class="fade-grip r" style="right:${(Math.min(fout, c.duration) * state.pps).toFixed(1)}px" title="Drag to fade out"></div>`;
}
const volGroup = (c) => withLinked([c]).filter((x) => x.kind === "audio");
/** Copy c's volume (static + keyframes) onto its linked stems. */
function mirrorVolume(c) {
  for (const x of volGroup(c)) {
    if (x === c) continue;
    x.props.volume = c.props.volume;
    if (c.keyframes?.volume?.length) {
      x.keyframes = x.keyframes || {};
      x.keyframes.volume = c.keyframes.volume.map((k) => ({ ...k }));
    } else if (x.keyframes?.volume) {
      delete x.keyframes.volume;
      if (!Object.keys(x.keyframes).length) x.keyframes = undefined;
    }
  }
}
function volBandRect(c) {
  return els.tracks.querySelector(`.clip[data-id="${c.id}"] .vol-band`)?.getBoundingClientRect() || null;
}
function endVolEdit(c) {
  hideTrimReadout();
  state.gesture = false;
  if (c.keyframes?.volume && !c.keyframes.volume.length) {
    delete c.keyframes.volume;
    if (!Object.keys(c.keyframes).length) c.keyframes = undefined;
  }
  mirrorVolume(c);
  state.dirtyTimeline = true;
  scheduleSave();
  renderInspector();
  refreshAudioHold();
}
function startVolBandGesture(e, c) {
  e.preventDefault();
  if (isGroupLocked(c)) { toastLocked(); return; }
  if (!state.selIds.has(c.id)) selectClip(c.id);
  const rect = volBandRect(c);
  if (!rect) return;
  const H = Math.max(1, rect.height - 6);
  const local = clamp((e.clientX - rect.left) / state.pps, 0, c.duration);
  pushUndo();
  if (e.ctrlKey || e.metaKey) { // add a keyframe where the line is
    const v = volumeAtLocal(c, local);
    const t = +local.toFixed(4);
    c.keyframes = c.keyframes || {};
    const arr = (c.keyframes.volume || []).filter((k) => Math.abs(k.t - t) > 1e-3);
    arr.push({ t, v: +v.toFixed(4), ease: "linear" });
    arr.sort((a, b) => a.t - b.t);
    c.keyframes.volume = arr;
    mirrorVolume(c);
    state.dirtyTimeline = true;
    rebuildClips();
    startVolPointGesture(e, c, arr.findIndex((k) => k.t === t), true);
    return;
  }
  state.gesture = true;
  const kfs = c.keyframes?.volume;
  let idx = [];
  if (kfs?.length) {
    const j = kfs.findIndex((k) => k.t >= local);
    idx = j < 0 ? [kfs.length - 1] : j === 0 ? [0] : [j - 1, j];
  }
  const orig = idx.map((i) => volToDb(kfs[i].v));
  const v0 = volumeAtLocal(c, local), p0 = volToPos(v0), db0 = volToDb(v0);
  const y0 = e.clientY;
  const onMove = (ev) => {
    const v = posToVol(p0 - (ev.clientY - y0) / H);
    if (!idx.length) c.props.volume = +v.toFixed(4);
    else {
      const d = volToDb(v) - db0;
      idx.forEach((i, n) => { kfs[i].v = +dbToVol(orig[n] + d).toFixed(4); });
    }
    mirrorVolume(c);
    showTrimReadout(ev, fmtDb(volToDb(v)));
    state.dirtyTimeline = true;
    rebuildClips();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    endVolEdit(c);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
function startVolPointGesture(e, c, i, undoDone = false, remove = e.altKey) {
  e.preventDefault();
  if (isGroupLocked(c)) { toastLocked(); return; }
  const kfs = c.keyframes?.volume;
  if (!kfs?.[i]) return;
  if (!state.selIds.has(c.id)) selectClip(c.id);
  if (!undoDone) pushUndo();
  if (remove) { // the level it held stays as the clip's volume
    if (kfs.length === 1) c.props.volume = kfs[0].v;
    kfs.splice(i, 1);
    endVolEdit(c);
    return;
  }
  const rect = volBandRect(c);
  const H = Math.max(1, (rect?.height || 30) - 6);
  state.gesture = true;
  const k = kfs[i];
  const t0 = k.t, p0 = volToPos(k.v), x0 = e.clientX, y0 = e.clientY;
  const lo = i > 0 ? kfs[i - 1].t + 0.001 : 0;
  const hi = i < kfs.length - 1 ? kfs[i + 1].t - 0.001 : c.duration;
  const onMove = (ev) => {
    if (!ev.shiftKey) k.t = +clamp(t0 + (ev.clientX - x0) / state.pps, lo, hi).toFixed(4); // Shift: level only
    k.v = +posToVol(p0 - (ev.clientY - y0) / H).toFixed(4);
    mirrorVolume(c);
    showTrimReadout(ev, `${fmtDb(volToDb(k.v))} · ${fmt(c.start + k.t)}`);
    state.dirtyTimeline = true;
    rebuildClips();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    endVolEdit(c);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
/** Drag a fade grip: creates / resizes a constant-power fade on the clip and
 *  its linked stems; dragging it back to the edge removes the fade. */
function startFadeGripGesture(e, c, side) {
  e.preventDefault();
  if (isGroupLocked(c)) { toastLocked(); return; }
  selectClip(c.id, { transFocus: side });
  const key = side === "in" ? "transitionIn" : "transitionOut";
  const group = volGroup(c);
  const orig = c[key]?.type === "fade" ? clipTransitionDur(c[key]) : 0;
  const x0 = e.clientX;
  let moved = false;
  state.gesture = true;
  pushUndo();
  const onMove = (ev) => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 2) return;
    moved = true;
    const dur = clamp(orig + (side === "in" ? dx : -dx) / state.pps, 0, c.duration);
    for (const x of group) {
      if (dur < MIN_TRANS_DUR) x[key] = undefined;
      else x[key] = { type: "fade", duration: +dur.toFixed(3), curve: x[key]?.type === "fade" ? x[key].curve || "power" : "power" };
    }
    showTrimReadout(ev, dur < MIN_TRANS_DUR ? "no fade" : `fade ${side} ${dur.toFixed(2)}s`);
    state.dirtyTimeline = true;
    rebuildClips();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideTrimReadout();
    state.gesture = false;
    if (moved) scheduleSave();
    renderInspector();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* Render decoded peaks for the [in, in+duration] slice of the clip's media */
function drawClipWave(cv, c, trackH) {
  const peaks = wavePeaksFor(c);
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

/* ── Ruler ──
   Pure vector 2D drawing with no <video>/DOM dependency (unlike the program
   monitor), so it's a clean fit to move off the main thread: transfer the
   canvas to a Worker once and post it a handful of numbers per frame instead
   of running the drawing code here. Falls back to drawing directly on the
   main thread (drawRulerMainThread) when OffscreenCanvas/
   transferControlToOffscreen isn't available. */
let rulerWorker = null, rulerWorkerTried = false;
function ensureRulerWorker() {
  if (rulerWorkerTried) return;
  rulerWorkerTried = true;
  try {
    if (window.Worker && els.ruler.transferControlToOffscreen) {
      const offscreen = els.ruler.transferControlToOffscreen();
      const w = new Worker("ruler-worker.js");
      w.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
      rulerWorker = w;
    }
  } catch { rulerWorker = null; }
}
function drawRuler() {
  ensureRulerWorker();
  const dpr = window.devicePixelRatio || 1;
  const w = els.timelineScroll.clientWidth, h = RULER_H;
  els.ruler.style.width = w + "px"; els.ruler.style.height = h + "px";
  if (rulerWorker) {
    rulerWorker.postMessage({
      type: "draw", w, h, dpr,
      sl: els.timelineScroll.scrollLeft, pps: state.pps,
      markers: project.markers, markerColors: MARKER_COLORS,
      inPoint: project.inPoint, outPoint: project.outPoint,
      time: state.time, fps: projectFps(),
    });
    return;
  }
  drawRulerMainThread(w, h, dpr);
}
function drawRulerMainThread(w, h, dpr) {
  const cv = els.ruler;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const sl = els.timelineScroll.scrollLeft, pps = state.pps;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * pps >= 70) || 600;
  const minor = step / 5;
  const i0 = Math.max(0, Math.floor(sl / pps / minor));
  // ticks + time labels first so IN/OUT can difference-blend over them
  g.strokeStyle = "#4a4a55";
  g.fillStyle = "#9a9aa6";
  g.font = "10px Consolas, monospace";
  g.beginPath();
  for (let i = i0; i * minor * pps < sl + w; i++) {
    const t = i * minor;
    const x = Math.round(t * pps - sl) + 0.5;
    const isMajor = i % 5 === 0;
    g.moveTo(x, isMajor ? 8 : 17); g.lineTo(x, h);
    if (isMajor) g.fillText(fmt(Math.round(t * 1000) / 1000).slice(0, 5), x + 4, 12);
  }
  g.stroke();
  // dim timeline outside the IN–OUT work area
  const inn = project.inPoint, out = project.outPoint;
  if (inn != null && out != null && out > inn) {
    const x0 = inn * pps - sl, x1 = out * pps - sl;
    g.fillStyle = "#00000055";
    if (x0 > 0) g.fillRect(0, 0, Math.min(w, x0), h);
    if (x1 < w) g.fillRect(Math.max(0, x1), 0, w - Math.max(0, x1), h);
  }
  // beat/cue markers — coloured diamonds, name to the right (clipped at the next marker)
  const mks = project.markers || [];
  for (let i = 0; i < mks.length; i++) {
    const mk = mks[i], x = mk.t * pps - sl;
    if (x < -6 || x > w + 6) {
      if (!mk.label || x > w) continue;
    }
    const col = markerColor(mk);
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x, h - 9); g.lineTo(x + 4, h - 5); g.lineTo(x, h - 1); g.lineTo(x - 4, h - 5);
    g.closePath(); g.fill();
    if (mk.label) {
      const next = mks[i + 1] ? mks[i + 1].t * pps - sl : w;
      const room = Math.min(next - x - 10, 160);
      if (room > 14) {
        g.save();
        g.beginPath(); g.rect(x + 6, h - 12, room, 12); g.clip();
        g.font = "9px system-ui, sans-serif";
        const tw = g.measureText(mk.label).width;
        g.fillStyle = "#101014cc";
        g.fillRect(x + 6, h - 11, Math.min(tw + 6, room), 10);
        g.fillStyle = col;
        g.fillText(mk.label, x + 9, h - 3);
        g.restore();
      }
    }
  }
  // IN / OUT — bottom-aligned; `difference` keeps time glyphs readable where they overlap
  // (true `xor` would punch transparent holes instead of showing the digits)
  const mkH = (h - 4) * 0.75, bot = h - 1, top = bot - mkH, mid = (top + bot) / 2;
  g.globalCompositeOperation = "difference";
  if (inn != null) {
    const x = inn * pps - sl;
    if (x >= -10 && x <= w + 10) {
      g.fillStyle = "#5eead4";
      g.beginPath();
      g.moveTo(x, top); g.lineTo(x, bot); g.lineTo(x + 8, mid);
      g.closePath(); g.fill();
    }
  }
  if (out != null) {
    const x = out * pps - sl;
    if (x >= -10 && x <= w + 10) {
      g.fillStyle = "#fb923c";
      g.beginPath();
      g.moveTo(x, top); g.lineTo(x, bot); g.lineTo(x - 8, mid);
      g.closePath(); g.fill();
    }
  }
  g.globalCompositeOperation = "source-over";
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
/* Which targets pull a dragged time in (the ▾ menu next to Snap). `frames`
   is not a target: when nothing is in reach it rounds to the frame grid. */
const SNAP_TARGET_LABELS = {
  clips: "Clip edges", playhead: "Playhead", markers: "Markers",
  inout: "IN / OUT", keyframes: "Keyframes", frames: "Frame grid",
};
function snapTargets() { return getSetting("snapTargets") || DEFAULT_SETTINGS.snapTargets; }
/* → {t, hit}: `hit` is true when a target (not the frame grid) caught t.
   ignore: clip id, Set of ids, or null. opts.skipMarker: a marker being dragged. */
function snapInfo(t, ignore, opts = {}) {
  if (!state.snap) return { t, hit: false };
  const on = snapTargets();
  const ign = ignore instanceof Set ? ignore : new Set(ignore ? [ignore] : []);
  const tol = SNAP_PX / state.pps;
  const cands = [0];
  if (on.playhead) cands.push(state.time);
  if (on.markers) for (const mk of project.markers || []) if (mk !== opts.skipMarker) cands.push(mk.t);
  if (on.inout) {
    if (project.inPoint != null) cands.push(project.inPoint);
    if (project.outPoint != null) cands.push(project.outPoint);
  }
  if (on.clips || on.keyframes) {
    for (const c of project.clips) {
      if (ign.has(c.id)) continue;
      if (on.clips) cands.push(c.start, clipEnd(c));
      if (on.keyframes) for (const lt of clipKeyframeLocalTimes(c)) cands.push(c.start + lt);
    }
  }
  let best = t, bd = tol, hit = false;
  for (const s of cands) {
    const d = Math.abs(s - t);
    if (d < bd) { bd = d; best = s; hit = true; }
  }
  if (!hit && on.frames) {
    const fps = projectFps();
    best = Math.round(t * fps) / fps;
  }
  noteSnap(hit ? best : null);
  return { t: best, hit };
}
function snapTime(t, ignore, opts) { return snapInfo(t, ignore, opts).t; }
/* Vertical guide at the time a drag snapped to. Coalesced per frame so a
   miss on one edge doesn't hide a hit on the other; pointerup clears it. */
let snapLineT = null, snapLineRaf = 0;
function noteSnap(hitT) {
  if (hitT != null) snapLineT = hitT;
  if (snapLineRaf) return;
  snapLineRaf = requestAnimationFrame(() => {
    snapLineRaf = 0;
    const el = els.snapLine;
    if (el) {
      const show = snapLineT != null && state.gesture;
      el.classList.toggle("hidden", !show);
      if (show) el.style.left = Math.round(snapLineT * state.pps) + "px";
    }
    snapLineT = null;
  });
}
window.addEventListener("pointerup", () => els.snapLine?.classList.add("hidden"), true);
function toggleSnapTarget(key) {
  setSetting("snapTargets", { ...snapTargets(), [key]: !snapTargets()[key] });
}
function openSnapMenu(anchor) {
  const menu = document.createElement("div");
  menu.className = "ctx-menu snap-menu";
  const on = snapTargets();
  menu.innerHTML = `<div class="snap-menu-head dim">Snap to</div>` +
    Object.entries(SNAP_TARGET_LABELS).map(([k, label]) =>
      `<label class="ctx-item snap-opt"><input type="checkbox" data-snap="${k}"${on[k] ? " checked" : ""}> <span>${label}</span></label>`).join("");
  menu.addEventListener("change", (e) => {
    const k = e.target.dataset.snap;
    if (k) toggleSnapTarget(k);
  });
  const r = anchor.getBoundingClientRect();
  showPopover(menu, r.left, r.bottom + 4);
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

/* ── Edit tools (V / B / R / Y / U) ──
   Select drags and trims as always. Ripple and Roll act on clip edges (the
   trim handles); Slip and Slide act on the whole clip. */
const EDIT_TOOLS = {
  select: { key: "V", label: "Selection" },
  ripple: { key: "B", label: "Ripple edit" },
  roll: { key: "R", label: "Rolling edit" },
  slip: { key: "Y", label: "Slip" },
  slide: { key: "U", label: "Slide" },
};
function setEditTool(name) {
  if (!EDIT_TOOLS[name]) return;
  state.tool = name;
  els.tracksContent.dataset.tool = name;
  for (const b of document.querySelectorAll("[data-edit-tool]")) {
    const on = b.dataset.editTool === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
}
document.querySelectorAll("[data-edit-tool]").forEach((b) =>
  b.addEventListener("click", () => setEditTool(b.dataset.editTool)));
/* Live offset beside the pointer while a trim tool drags. */
function showTrimReadout(ev, text) {
  let el = runtime.trimReadout;
  if (!el) {
    el = runtime.trimReadout = document.createElement("div");
    el.className = "trim-readout";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.left = ev.clientX + 14 + "px";
  el.style.top = ev.clientY + 18 + "px";
  el.hidden = false;
}
function hideTrimReadout() { if (runtime.trimReadout) runtime.trimReadout.hidden = true; }
function fmtTrimDelta(d) {
  const f = Math.round(Math.abs(d) * projectFps());
  return `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}s · ${f}f`;
}
/* Drag with a trim tool. Snapshot at pointerdown, restore before every step,
   then run the op with the total delta — so the drag can swing both ways. */
function startTrimToolGesture(e, c, mode) {
  e.preventDefault();
  const [tool, s] = mode.split("-");
  const side = s === "l" ? "in" : "out";
  const run = (d) => tool === "ripple" ? rippleTrim(c, side, d)
    : tool === "roll" ? rollEdit(c, side, d)
      : tool === "slip" ? slipClip(c, d) : slideClip(c, d);
  const probe = run(0); // delta 0 changes nothing — it only asks "may I?"
  if (typeof probe === "string") { toast(probe); return; }
  state.gesture = true;
  const snapshot = JSON.stringify(project.clips);
  const cloneTr = (tr) => (tr ? { ...tr } : tr);
  const base = new Map(project.clips.map((x) => [x.id, {
    start: x.start, in: x.in, duration: x.duration, keyframes: x.keyframes,
    transitionIn: cloneTr(x.transitionIn), transitionOut: cloneTr(x.transitionOut),
  }]));
  const restore = () => {
    for (const x of project.clips) {
      const b = base.get(x.id);
      if (!b) continue;
      x.start = b.start; x.in = b.in; x.duration = b.duration; x.keyframes = b.keyframes;
      x.transitionIn = cloneTr(b.transitionIn); x.transitionOut = cloneTr(b.transitionOut);
    }
  };
  // Snap targets ignore everything this edit moves.
  const ignore = new Set(withLinked([c]).map((x) => x.id));
  for (const n of [adjacentClip(c, "in"), adjacentClip(c, "out")])
    if (n) for (const x of withLinked([n])) ignore.add(x.id);
  const t0 = timeAtEvent(e), x0 = e.clientX;
  const label = EDIT_TOOLS[tool].label;
  let moved = false, applied = 0;
  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) <= 3) return;
    moved = true;
    restore();
    let d = timeAtEvent(ev) - t0;
    if (tool === "roll" || (tool === "ripple" && side === "out")) {
      const edge = side === "out" ? clipEnd(c) : c.start;
      d = snapTime(edge + d, ignore) - edge;
    } else if (tool === "slide") {
      const sa = snapInfo(c.start + d, ignore), sb = snapInfo(clipEnd(c) + d, ignore);
      const a = sa.t - c.start, b = sb.t - clipEnd(c);
      if (sb.hit && (!sa.hit || Math.abs(b - d) < Math.abs(a - d))) d = b; else d = a;
    }
    const r = run(d);
    applied = typeof r === "number" ? r : 0;
    state.dirtyTimeline = true;
    renderInspector(true);
    showTrimReadout(ev, `${label} ${fmtTrimDelta(applied)}`);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideTrimReadout();
    state.gesture = false;
    if (moved && Math.abs(applied) > 1e-9) {
      runtime.undo.push(snapshot);
      if (runtime.undo.length > 100) runtime.undo.shift();
      runtime.redo.length = 0;
      scheduleSave();
    } else if (moved) restore();
    state.dirtyTimeline = true;
    renderInspector();
    if (runtime.pendingSync) syncFromServer();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
/* Right-click a clip: enable / lock / link menu. */
els.tracksContent.addEventListener("contextmenu", (e) => {
  const clipDiv = e.target.closest(".clip");
  if (!clipDiv) return;
  const c = getClip(clipDiv.dataset.id);
  if (!c) return;
  e.preventDefault();
  showClipCtxMenu(e.clientX, e.clientY, c);
});
els.tracksContent.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // Clicking the timeline should release inspector text fields so shortcuts (z, s, …) work
  if (isTypingTarget(document.activeElement) && els.inspector.contains(document.activeElement))
    document.activeElement.blur();
  const clipDiv = e.target.closest(".clip");
  if (!clipDiv) {
    // empty track background: drag = marquee select, plain click = seek + deselect
    startMarquee(e);
    return;
  }
  const c = getClip(clipDiv.dataset.id);
  if (!c) return;
  if (c.kind === "audio" && (state.tool || "select") === "select") {
    const grip = e.target.closest(".fade-grip");
    if (grip) { startFadeGripGesture(e, c, grip.classList.contains("r") ? "out" : "in"); return; }
    const pt = e.target.closest(".vol-pt");
    if (pt) { startVolPointGesture(e, c, +pt.dataset.i); return; }
    if (e.target.closest(".vol-hit")) { startVolBandGesture(e, c); return; }
  }
  const kfMark = e.target.closest(".clip-kf");
  if (kfMark) {
    e.preventDefault();
    selectClip(c.id);
    setTime(c.start + (+kfMark.dataset.t || 0));
    return;
  }
  const transHandle = e.target.closest(".trans-dur-handle");
  if (transHandle) {
    const wrap = transHandle.closest(".trans-mark");
    startTransDurGesture(e, c, wrap?.classList.contains("out") ? "out" : "in");
    return;
  }
  const transMark = e.target.closest(".trans-mark");
  if (transMark) {
    e.preventDefault();
    selectClip(c.id, { transFocus: transMark.classList.contains("out") ? "out" : "in" });
    return;
  }
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  if (additive) {
    selectClip(c.id, { toggle: true });
    if (!state.selIds.has(c.id)) return; // toggled off — nothing to drag
  } else if (!state.selIds.has(c.id)) {
    selectClip(c.id);
  } else if (state.selId !== c.id) {
    // grabbing inside an existing multi-selection: keep the group, retarget the inspector
    // (bin link-select unchanged — same media set)
    state.selId = c.id;
    state.dirtyTimeline = true;
    renderInspector();
  }
  const onHandle = e.target.classList.contains("handle");
  const edge = e.target.classList.contains("l") ? "l" : "r";
  const tool = state.tool || "select";
  if ((tool === "ripple" || tool === "roll") && onHandle) { startTrimToolGesture(e, c, `${tool}-${edge}`); return; }
  if (tool === "slip" || tool === "slide") { startTrimToolGesture(e, c, tool); return; }
  const mode = onHandle ? (edge === "l" ? "trim-l" : "trim-r") : "move";
  // a plain click (no drag) on a multi-selection collapses it to that clip on release
  startClipGesture(e, c, mode, !additive && state.selIds.size > 1);
});

els.tracksContent.addEventListener("dblclick", (e) => {
  const clipDiv = e.target.closest(".clip");
  if (!clipDiv) return;
  const c = getClip(clipDiv.dataset.id);
  if (!c) return;
  const pt = e.target.closest(".vol-pt");
  if (pt) { // double-click a volume point: remove it
    e.preventDefault();
    startVolPointGesture(e, c, +pt.dataset.i, false, true);
    return;
  }
  if (e.target.closest(".handle, .trans-mark, .trans-dur-handle, .clip-kf, .fade-grip, .vol-hit")) return;
  e.preventDefault();
  loadSourceFromClip(c, { timelineTime: timeAtEvent(e) });
});

const MIN_TRANS_DUR = 0.1;
function startTransDurGesture(e, c, side) {
  e.preventDefault();
  if (isGroupLocked(c)) { selectClip(c.id, { transFocus: side }); toastLocked(); return; }
  const key = side === "in" ? "transitionIn" : "transitionOut";
  const tr = c[key];
  if (!tr) return;
  selectClip(c.id, { transFocus: side });
  state.gesture = true;
  const origDur = tr.duration;
  const x0 = e.clientX;
  let moved = false;
  pushUndo();

  const onMove = (ev) => {
    const dx = ev.clientX - x0;
    if (Math.abs(dx) < 2 && !moved) return;
    moved = true;
    const sign = side === "in" ? 1 : -1;
    const dur = clamp(origDur + sign * dx / state.pps, MIN_TRANS_DUR, c.duration);
    tr.duration = +dur.toFixed(3);
    state.dirtyTimeline = true;
    rebuildClips();
    const durK = side === "in" ? "transInDur" : "transOutDur";
    const inp = els.inspector.querySelector(`[data-k="${durK}"]`);
    if (inp) inp.value = tr.duration;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.gesture = false;
    if (moved) {
      scheduleSave();
      saveLastTransition(side, c[key]);
    }
    renderInspector();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startClipGesture(e, c, mode, collapseOnClick) {
  e.preventDefault();
  state.gesture = true;
  const media = getMedia(c.mediaId);
  const orig = {
    start: c.start, in: c.in, duration: c.duration, track: c.track,
    keyframes: c.keyframes ? JSON.parse(JSON.stringify(c.keyframes)) : undefined,
  };
  // moving a clip that belongs to a multi-selection drags the whole group;
  // AV-linked partners (video+audio from one file) always move together
  const group = withLinked(mode === "move" && state.selIds.has(c.id) ? selectedClips() : [c]);
  if (group.some(isClipLocked)) { state.gesture = false; toastLocked(); return; }
  const groupOrig = new Map(group.map((x) => [x.id, {
    start: x.start, in: x.in, duration: x.duration,
    keyframes: x.keyframes ? JSON.parse(JSON.stringify(x.keyframes)) : undefined,
  }]));
  const groupIds = new Set(group.map((x) => x.id));
  const t0 = timeAtEvent(e);
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  const snapshot = JSON.stringify(project.clips);

  const onMove = (ev) => {
    const dt = timeAtEvent(ev) - t0;
    // Count vertical motion too — track changes are often pure Y drags
    if (!moved && (Math.abs(ev.clientX - x0) > 3 || Math.abs(ev.clientY - y0) > 3)) moved = true;
    if (!moved) return;
    if (mode === "move") {
      // Snap whichever edge is closer to a target. A non-snapping edge has
      // distance 0, which must NOT beat a real snap on the other edge.
      const rawStart = orig.start + dt;
      const rawEnd = orig.start + orig.duration + dt;
      // (A frame-grid rounding is not a snap: it only applies to the start.)
      const sStart = snapInfo(rawStart, groupIds);
      const sEnd = snapInfo(rawEnd, groupIds);
      let ns = sStart.t;
      if (sEnd.hit && (!sStart.hit || Math.abs(sEnd.t - rawEnd) < Math.abs(sStart.t - rawStart)))
        ns = sEnd.t - orig.duration;
      // one time-delta for the whole group, clamped so nothing crosses 0
      let d = ns - orig.start;
      d = Math.max(d, -Math.min(...group.map((x) => groupOrig.get(x.id).start)));
      for (const x of group) x.start = groupOrig.get(x.id).start + d;
      // Dragged clip may change track; its AV-linked partner stays on its own lane
      const tk = trackAtEvent(ev);
      if (tk) {
        const trk = TRACKS.find((t) => t.id === tk);
        if (trk && (c.kind === "audio") === (trk.kind === "audio") && !isTrackLocked(tk)) {
          c.track = tk;
          routeClipGain(c);
        }
      }
    } else if (mode === "trim-l") {
      let ns = snapTime(orig.start + dt, groupIds);
      const sp = clipSpeed(c);
      const maxShiftLeft = (c.kind === "video" || c.kind === "audio") ? orig.in / sp : 1e6;
      ns = clamp(ns, Math.max(0, orig.start - maxShiftLeft), orig.start + orig.duration - MIN_DUR);
      const d = ns - orig.start;
      c.start = ns;
      c.in = (c.kind === "video" || c.kind === "audio") ? orig.in + d * sp : 0;
      c.duration = orig.duration - d;
      c.keyframes = shiftKF(orig.keyframes, d, c.duration);
      syncLinkedTiming(c);
    } else { // trim-r
      let ne = snapTime(orig.start + orig.duration + dt, groupIds);
      let maxDur = 1e6;
      if ((c.kind === "video" || c.kind === "audio") && media?.duration)
        maxDur = (media.duration - orig.in) / clipSpeed(c);
      c.duration = clamp(ne - orig.start, MIN_DUR, maxDur);
      c.keyframes = shiftKF(orig.keyframes, 0, c.duration);
      syncLinkedTiming(c);
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
      syncBinSelectionFromTimeline();
    }
    if (runtime.pendingSync) syncFromServer();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ── Scrubbing ── */
function startScrub(e) {
  e.preventDefault();
  if (isSourceMode()) setMonitorMode("program");
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
/* Marker under a ruler pointer event: the diamond row at the bottom, ±6 px. */
function markerAtRulerEvent(e) {
  const r = els.ruler.getBoundingClientRect();
  if (e.clientY - r.top < RULER_H - 13) return null;
  const x = e.clientX - els.timelineScroll.getBoundingClientRect().left + els.timelineScroll.scrollLeft;
  let best = null, bd = 6;
  for (const m of project.markers || []) {
    const d = Math.abs(m.t * state.pps - x);
    if (d <= bd) { bd = d; best = m; }
  }
  return best;
}
/* Ruler: drag a marker diamond to move it (snaps like a clip edge), click one
   to park the playhead on it; anywhere else scrubs. */
function onRulerPointerDown(e) {
  const mk = e.button === 0 ? markerAtRulerEvent(e) : null;
  if (!mk) { if (e.button === 0) startScrub(e); return; }
  e.preventDefault();
  if (isSourceMode()) setMonitorMode("program");
  state.gesture = true;
  const snapshot = undoSnapshot(), x0 = e.clientX, t0 = mk.t;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) <= 3) return;
    moved = true;
    const t = clamp(t0 + (ev.clientX - x0) / state.pps, 0, 1e6);
    mk.t = +snapTime(t, null, { skipMarker: mk }).toFixed(3);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.gesture = false;
    if (moved && mk.t !== t0) {
      runtime.undo.push(snapshot);
      if (runtime.undo.length > 100) runtime.undo.shift();
      runtime.redo.length = 0;
      project.markers.sort((a, b) => a.t - b.t);
      scheduleSave();
    } else if (!moved) seekToMarker(mk);
    if (runtime.pendingSync) syncFromServer();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
els.ruler.addEventListener("pointerdown", onRulerPointerDown);
els.ruler.addEventListener("dblclick", (e) => {
  const mk = markerAtRulerEvent(e);
  if (mk) openMarkerEditor(mk, e.clientX - 20, e.clientY + 10);
});
els.ruler.addEventListener("contextmenu", (e) => {
  const mk = markerAtRulerEvent(e);
  if (!mk) return;
  e.preventDefault();
  openMarkerEditor(mk, e.clientX, e.clientY);
});
els.ruler.addEventListener("pointermove", (e) => {
  if (state.gesture) return;
  const mk = markerAtRulerEvent(e);
  els.ruler.style.cursor = mk ? "ew-resize" : "";
  els.ruler.title = mk
    ? `${mk.label ? mk.label + " · " : ""}${fmt(mk.t)} — drag to move · double-click to name / colour`
    : "";
});

function setTime(t) {
  state.time = clamp(t, 0, Math.max(projDur(), 0));
  seekMediaWhilePaused();
  if (state.audioHold) scheduleAudioHoldRefresh();
}

/* Absolute timeline times of every keyframe on the given clips (deduped). */
function keyframeTimelineTimes(clips) {
  const seen = new Set();
  const out = [];
  for (const c of clips) {
    for (const local of clipKeyframeLocalTimes(c)) {
      const t = +(c.start + local).toFixed(4);
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}
/** Clip In/Out times used as edit points. Selection wins; otherwise targeted tracks. */
function editPointTimes() {
  const clips = state.selIds.size
    ? selectedClips()
    : project.clips.filter((c) => isTrackTargeted(c.track));
  const seen = new Set();
  const out = [];
  for (const c of clips) {
    for (const t of [c.start, clipEnd(c)]) {
      const v = +(+t).toFixed(4);
      if (!Number.isFinite(v) || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}
/** Source In/Out (and 0 / duration) as edit points while the Source monitor is active. */
function sourceEditPointTimes() {
  const dur = sourceDur();
  const seen = new Set();
  const out = [];
  for (const t of [0, state.source.in, state.source.out, dur]) {
    if (t == null || !Number.isFinite(+t)) continue;
    const v = +clamp(+t, 0, Math.max(dur, 0)).toFixed(4);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}
/** Premiere-style ↑ / ↓: previous / next edit. Selected clip → its In then Out. */
function goToEditPoint(dir) {
  const src = isSourceMode();
  const times = src ? sourceEditPointTimes() : editPointTimes();
  if (!times.length) { toast(src ? "No Source marks" : "No cuts"); return; }
  const eps = kfTimeEps();
  const now = src ? state.source.time : state.time;
  if (dir > 0) {
    const next = times.find((t) => t > now + eps);
    if (next == null) { toast(src ? "Already at Source end" : "Already at last cut"); return; }
    if (src) setSourceTime(next); else { setTime(next); ensurePlayheadVisible(); }
  } else {
    let prev = null;
    for (const t of times) if (t < now - eps) prev = t;
    if (prev == null) { toast(src ? "Already at Source start" : "Already at first cut"); return; }
    if (src) setSourceTime(prev); else { setTime(prev); ensurePlayheadVisible(); }
  }
}

/* Jump playhead to previous (−1) or next (+1) keyframe.
   Prefers selected clips; falls back to clips under the playhead.
   Keyboard counterpart to Avid’s Ctrl/Cmd-click snap-to-audio-keyframe. */
function goToKeyframe(dir) {
  let clips = state.selIds.size ? selectedClips() : [];
  if (!clips.some((c) => clipKeyframeLocalTimes(c).length)) {
    const t = state.time;
    clips = project.clips.filter((c) =>
      clipKeyframeLocalTimes(c).length &&
      t >= c.start - 1e-6 && t <= c.start + c.duration + 1e-6);
  }
  const times = keyframeTimelineTimes(clips);
  if (!times.length) { toast("No keyframes"); return; }
  const eps = kfTimeEps();
  if (dir > 0) {
    const next = times.find((t) => t > state.time + eps);
    if (next == null) { toast("No next keyframe"); return; }
    setTime(next);
  } else {
    let prev = null;
    for (const t of times) if (t < state.time - eps) prev = t;
    if (prev == null) { toast("No previous keyframe"); return; }
    setTime(prev);
  }
}

/* Add a marker at the playhead, or remove one already there (M key).
   Works while playing — tap M on the beat to lay down a beat grid. */
function toggleMarker() {
  const t = +state.time.toFixed(3);
  const tol = Math.max(0.05, SNAP_PX / state.pps);
  project.markers = project.markers || [];
  const near = project.markers.findIndex((m) => Math.abs(m.t - t) < tol);
  pushUndo();
  if (near >= 0 && !state.playing) project.markers.splice(near, 1);
  else { project.markers.push({ t }); project.markers.sort((a, b) => a.t - b.t); }
  scheduleSave();
}
/* Shift+M / Alt+Shift+M — playhead to the next / previous marker. */
function goToMarker(dir) {
  // The playhead stops at the last clip, so markers past it are skipped —
  // otherwise ⇧M would park at the end and silently repeat forever.
  const end = projDur() + 1e-3;
  const m = adjacentMarker((project.markers || []).filter((mk) => mk.t <= end), state.time, dir);
  if (!m) { toast(dir > 0 ? "No marker after the playhead" : "No marker before the playhead"); return; }
  seekToMarker(m);
}
/* Park the playhead on a marker (Program monitor). */
function seekToMarker(m) {
  if (m.t > projDur() + 1e-3) { toast("That marker is past the end of the timeline"); return; }
  if (isSourceMode()) setMonitorMode("program");
  setTime(m.t);
  revealTime(m.t);
}
/* Scroll the timeline so time t is on screen (no-op when it already is). */
function revealTime(t) {
  const sc = els.timelineScroll, px = t * state.pps;
  if (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 40)
    sc.scrollLeft = Math.max(0, px - sc.clientWidth / 3);
}
/* Open a small popover at client (x, y), reusing the context-menu slot so the
   outside-click / Escape handlers close it. */
function showPopover(menu, clientX, clientY) {
  hideTrackCtxMenu();
  menu.id = "trackCtxMenu";
  document.body.appendChild(menu);
  trackCtxMenu = menu;
  const pad = 6, w = menu.offsetWidth, h = menu.offsetHeight;
  let x = clientX, y = clientY;
  if (x + w + pad > window.innerWidth) x = window.innerWidth - w - pad;
  if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
  menu.style.left = Math.max(pad, x) + "px";
  menu.style.top = Math.max(pad, y) + "px";
}
/* Name / colour / delete one marker. Edits apply live; the first change of
   each kind takes one undo step. */
function openMarkerEditor(mk, clientX, clientY) {
  const menu = document.createElement("div");
  menu.className = "ctx-menu marker-pop";
  const swatches = Object.entries(MARKER_COLORS).map(([name, hex]) =>
    `<button type="button" class="marker-swatch" data-color="${name}" title="${name}" aria-label="${name}" style="--c:${hex}"></button>`).join("");
  menu.innerHTML =
    `<div class="marker-pop-head"><span class="timecode">${fmt(mk.t)}</span><span class="dim">Marker</span></div>` +
    `<input type="text" class="marker-name" maxlength="80" placeholder="Name (optional)" spellcheck="false">` +
    `<div class="marker-swatches">${swatches}</div>` +
    `<button type="button" class="ctx-item marker-del"><span>Delete marker</span></button>`;
  const input = menu.querySelector(".marker-name");
  input.value = mk.label || "";
  const syncSwatches = () => {
    for (const b of menu.querySelectorAll(".marker-swatch"))
      b.classList.toggle("on", b.dataset.color === (mk.color || "gold"));
  };
  syncSwatches();
  let named = false;
  input.addEventListener("input", () => {
    if (!named) { pushUndo(); named = true; }
    const label = input.value.trim().slice(0, 80);
    if (label) mk.label = label; else delete mk.label;
    scheduleSave();
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") hideTrackCtxMenu(); });
  menu.querySelector(".marker-swatches").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    pushUndo();
    if (b.dataset.color === "gold") delete mk.color; else mk.color = b.dataset.color;
    syncSwatches();
    scheduleSave();
  });
  menu.querySelector(".marker-del").addEventListener("click", () => {
    const i = (project.markers || []).indexOf(mk);
    if (i >= 0) { pushUndo(); project.markers.splice(i, 1); scheduleSave(); }
    hideTrackCtxMenu();
  });
  showPopover(menu, clientX, clientY);
  input.focus();
  input.select();
}
/* Toolbar Markers list — click a row to jump, ✎ to rename / recolour. */
function openMarkerList(anchor) {
  const menu = document.createElement("div");
  menu.className = "ctx-menu marker-list";
  const list = project.markers || [];
  if (!list.length) {
    menu.innerHTML = `<div class="marker-empty dim">No markers yet — press <kbd>M</kbd> at the playhead.</div>`;
  } else {
    menu.innerHTML = list.map((m, i) =>
      `<div class="marker-row" data-i="${i}">` +
      `<button type="button" class="ctx-item marker-go" data-i="${i}">` +
      `<span class="marker-dot" style="--c:${markerColor(m)}"></span>` +
      `<span class="timecode">${fmt(m.t)}</span>` +
      `<span class="marker-label${m.label ? "" : " dim"}">${m.label ? escapeHtml(m.label) : "—"}</span></button>` +
      `<button type="button" class="btn tiny marker-edit" data-i="${i}" title="Rename / colour">✎</button></div>`,
    ).join("") +
      `<button type="button" class="ctx-item marker-clear"><span>Clear all markers</span></button>`;
  }
  menu.addEventListener("click", (e) => {
    const go = e.target.closest(".marker-go"), ed = e.target.closest(".marker-edit");
    if (go) {
      const m = list[+go.dataset.i];
      hideTrackCtxMenu();
      seekToMarker(m);
    } else if (ed) {
      const r = ed.getBoundingClientRect();
      openMarkerEditor(list[+ed.dataset.i], r.left, r.bottom + 4);
    } else if (e.target.closest(".marker-clear")) {
      pushUndo();
      project.markers = [];
      scheduleSave();
      hideTrackCtxMenu();
    }
  });
  const r = anchor.getBoundingClientRect();
  showPopover(menu, r.left, r.bottom + 4);
}
/* Work-area IN/OUT markers (I / O). Shift+I / Shift+O clear them. */
function workAreaTime() {
  return Math.max(TIMELINE_START_TIME, +state.time.toFixed(3));
}
function setInPoint(at) {
  const t = at == null ? workAreaTime() : Math.max(TIMELINE_START_TIME, +at.toFixed(3));
  const prevOut = project.outPoint;
  const { inPoint, outPoint } = normalizeWorkArea(t, prevOut);
  if (prevOut != null && inPoint == null && outPoint == null) {
    toast(Math.abs(t - prevOut) < 1e-6 ? "IN and OUT must be at different times" : "IN must be before OUT");
  }
  project.inPoint = inPoint;
  project.outPoint = outPoint;
  updateWorkArea();
  syncTrimIOButton();
  scheduleSave();
}
function setOutPoint(at) {
  const t = at == null ? workAreaTime() : Math.max(TIMELINE_START_TIME, +at.toFixed(3));
  const prevIn = project.inPoint;
  const { inPoint, outPoint } = normalizeWorkArea(prevIn, t);
  if (prevIn != null && inPoint == null && outPoint == null) {
    toast(Math.abs(t - prevIn) < 1e-6 ? "IN and OUT must be at different times" : "OUT must be after IN");
  }
  project.inPoint = inPoint;
  project.outPoint = outPoint;
  updateWorkArea();
  syncTrimIOButton();
  scheduleSave();
}
function clearInPoint() {
  if (project.inPoint == null) return;
  project.inPoint = null;
  updateWorkArea();
  syncTrimIOButton();
  scheduleSave();
}
function clearOutPoint() {
  if (project.outPoint == null) return;
  project.outPoint = null;
  updateWorkArea();
  syncTrimIOButton();
  scheduleSave();
}
function updateWorkArea() {
  const left = $("workDimL"), right = $("workDimR");
  if (!left || !right) return;
  const a = project.inPoint, b = project.outPoint;
  const contentW = els.tracksContent.offsetWidth || contentWidth();
  if (a == null || b == null || b <= a) {
    left.classList.add("hidden");
    right.classList.add("hidden");
    return;
  }
  const x0 = a * state.pps, x1 = b * state.pps;
  left.classList.remove("hidden");
  right.classList.remove("hidden");
  left.style.width = Math.max(0, x0) + "px";
  right.style.left = x1 + "px";
  right.style.width = Math.max(0, contentW - x1) + "px";
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
  state.pps = clamp(pps, ZOOM_MIN, ZOOM_MAX);
  els.zoomSlider.value = state.pps;
  state.dirtyTimeline = true;
  rebuildClips();
  scroller.scrollLeft = Math.max(0, tAtAnchor * state.pps - ax);
}
/* Fit clip content into 95% of the viewport, then scroll to the start.
   TIMELINE_PAD_SEC is scroll room added by contentWidth(), not part of the fit. */
function zoomToFit() {
  const w = els.timelineScroll.clientWidth || 800;
  const span = Math.max(projDur(), 1);
  setZoom((TIMELINE_FIT_FILL * w) / span);
  els.timelineScroll.scrollLeft = 0;
}
/* Zoom so the selection fills 90% of the timeline width and is centered.
   One clip → that clip; multiple → the time range covering all of them. */
function zoomToSelection() {
  const clips = selectedClips();
  if (!clips.length) { toast("Select a clip to zoom to"); return; }
  const t0 = Math.min(...clips.map((c) => c.start));
  const t1 = Math.max(...clips.map((c) => c.start + c.duration));
  zoomToRange(t0, t1);
}
/* Zoom so the IN–OUT work area fills 90% of the timeline width and is centered. */
function zoomToWorkArea() {
  const t0 = project.inPoint, t1 = project.outPoint;
  if (t0 == null || t1 == null || t1 <= t0) {
    toast("Set IN and OUT markers first (I / O)");
    return;
  }
  zoomToRange(t0, t1);
}
function zoomToRange(t0, t1) {
  const dur = Math.max(t1 - t0, MIN_DUR);
  const w = els.timelineScroll.clientWidth || 800;
  const pps = clamp((0.9 * w) / dur, ZOOM_MIN, ZOOM_MAX);
  state.pps = pps;
  els.zoomSlider.value = pps;
  rebuildClips();
  const center = (t0 + t1) / 2;
  const maxScroll = Math.max(0, contentWidth() - w);
  els.timelineScroll.scrollLeft = clamp(center * pps - w / 2, 0, maxScroll);
}
els.zoomSlider.addEventListener("input", () => setZoom(+els.zoomSlider.value));
$("btnZoomFit").addEventListener("click", zoomToFit);
$("btnAddV").addEventListener("click", () => addTimelineTrack("video"));
$("btnAddA").addEventListener("click", () => addTimelineTrack("audio"));
els.timelineScroll.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(state.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
  }
}, { passive: false });

/* ═══════════════════════════ SELECTION & INSPECTOR ═══════════════════════ */
function selectedMediaIds() {
  const ids = new Set();
  for (const c of selectedClips()) {
    if (c.mediaId) ids.add(c.mediaId);
  }
  return ids;
}
/** Clear Project-bin link-select highlights (used when the setting turns off). */
function clearBinSelectionHighlight() {
  if (!els.binList) return;
  for (const item of els.binList.querySelectorAll(".bin-item.selected"))
    item.classList.remove("selected");
}
/** Highlight Project-bin items that match the timeline selection (when linkSelect is on). */
function syncBinSelectionFromTimeline() {
  if (!els.binList || !getSetting("linkSelect")) return; // no-op when off — avoids DOM work on every selection
  const mediaIds = selectedMediaIds();
  for (const item of els.binList.querySelectorAll(".bin-item[data-media-id]")) {
    item.classList.toggle("selected", mediaIds.has(item.dataset.mediaId));
  }
}
/** Select every timeline clip that uses this media (video primary when present). */
function selectClipsByMediaId(mediaId) {
  const clips = project.clips.filter((c) => c.mediaId === mediaId);
  if (!clips.length) {
    setSelection([]);
    toast("No clips on the timeline use this media");
    return;
  }
  clips.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
  const primary = clips.find((c) => c.kind === "video") || clips[0];
  if (state.binTab !== "project") setBinTab("project");
  setSelection(clips.map((c) => c.id), primary.id);
}
function setSelection(ids, primary) {
  state.selIds = new Set(ids);
  state.selId = primary !== undefined ? primary : ([...state.selIds].pop() ?? null);
  if (state.selId && !state.selIds.has(state.selId)) state.selIds.add(state.selId);
  state.dirtyTimeline = true;
  renderInspector();
  syncBinSelectionFromTimeline();
}
/* Plain call replaces the selection; {toggle:true} (ctrl/cmd/shift+click)
   adds/removes the clip from it. */
function selectClip(id, opts) {
  if (opts && opts.toggle && id != null) {
    const s = new Set(state.selIds);
    state.transFocus = null;
    if (s.has(id)) { s.delete(id); setSelection([...s]); }
    else { s.add(id); setSelection([...s], id); }
    return;
  }
  const nextFocus = id == null ? null : (opts?.transFocus ?? null);
  if (state.selId === id && state.selIds.size <= 1 && nextFocus === state.transFocus) return;
  state.transFocus = nextFocus;
  setSelection(id == null ? [] : [id], id ?? null);
}
/* Drop selected ids whose clips no longer exist (undo/redo, external reload) */
function pruneSelection() {
  state.selIds = new Set([...state.selIds].filter((id) => getClip(id)));
  if (!state.selIds.has(state.selId)) state.selId = [...state.selIds].pop() ?? null;
  syncBinSelectionFromTimeline();
}
const selectedClips = () => project.clips.filter((c) => state.selIds.has(c.id));
/* Enable / lock / link toggles at the top of the inspector. They stay live
   while the clip is locked — this is where you unlock it. */
function clipStatusBar(c) {
  const locked = isGroupLocked(c), disabled = c.disabled === true;
  const linked = !!(c.linkGroup || c.linkedId);
  const canLink = !linked && (c.kind === "video" || c.kind === "audio") && c.unlinked === true;
  const b = (cmd, on, label, title, extra = "") =>
    `<button type="button" class="clip-flag${on ? " on" : ""}" data-clip-cmd="${cmd}" aria-pressed="${on}" title="${title}"${extra}>${label}</button>`;
  return `<div class="clip-flags">` +
    b("disable", disabled, disabled ? "Disabled" : "Enabled",
      disabled ? "Hidden from preview and export — click to enable (Shift+E)" : "Click to disable: hide from preview and export without deleting (Shift+E)") +
    b("lock", locked, locked ? "Locked" : "Unlocked",
      locked ? (c.locked === true ? "Click to unlock" : `Locked by track ${c.track} or a linked clip`) : "Click to lock — nothing can move or change it") +
    ((linked || canLink) ? b("link", linked, linked ? "Linked" : "Unlinked",
      linked ? "Video and audio move together — click to unlink (Ctrl/Cmd+L)" : "Click to relink with its audio (select both, Ctrl/Cmd+L)") : "") +
    `</div>`;
}
function renderInspector(lite) {
  const c = getClip(state.selId);
  if (!c) {
    els.inspector.innerHTML = `<div class="inspector-empty">Select a clip to edit its<br>transform, effects &amp; audio.</div>`;
    renderKfGraphsPanel();
    return;
  }
  if (lite) { // during gestures, just refresh timing numbers if present
    const s = els.inspector.querySelector("[data-k=start]"), d = els.inspector.querySelector("[data-k=duration]");
    if (s) s.value = c.start.toFixed(2);
    if (d) d.value = c.duration.toFixed(2);
    syncInspectorPlayhead(); // start/duration are in the stamp — refresh keyed fields + off-clip lock
    return;
  }
  const p = propsAtPlayhead(c);
  const kfCount = (k) => (c.keyframes && c.keyframes[k] ? c.keyframes[k].length : 0);
  const kfCtl = (k) => {
    if (!ANIMATABLE.includes(k)) return "";
    const n = kfCount(k), on = !!kfAtPlayhead(c, k);
    return `<span class="kf-ctl"><button class="kf-btn${n ? " has" : ""}${on ? " on" : ""}" data-kf="${k}" title="${on ? "Remove keyframe at playhead" : "Set keyframe at playhead"}">◆${n || ""}</button>${n ? `<button class="kf-btn" data-kfclear="${k}" title="Clear keyframes">✕</button>` : ""}</span>`;
  };
  /* Label carries two affordances that key off different click modifiers:
     plain click toggles the keyframe graph (animatable props), Ctrl/Cmd-click
     resets the whole channel, Shift-click resets at the playhead / removes
     that keyframe. `reset` overrides which keys reset; defaults to k. */
  const propLabel = (label, k = "", reset) => {
    const keys = reset !== undefined ? reset : k;
    const list = (Array.isArray(keys) ? keys : String(keys || "").split(",")).map((s) => s.trim()).filter(Boolean);
    const canReset = list.some((rk) => Object.hasOwn(DEFAULT_PROPS, rk) || rk === "transIn" || rk === "transOut");
    const isGraph = !!k && ANIMATABLE.includes(k);
    if (!isGraph && !canReset) return `<label>${label}</label>`;
    const cls = [
      isGraph ? "kf-graph-toggle" : "",
      isGraph && state.kfGraphs.has(k) ? "on" : "",
      isGraph && kfCount(k) ? "has-kf" : "",
      canReset ? "insp-reset" : "",
    ].filter(Boolean).join(" ");
    const attrs = (isGraph ? ` data-kfgraph="${k}"` : "") + (canReset ? ` data-reset="${list.join(",")}"` : "");
    const title = isGraph && canReset
      ? "Click: keyframe graph · Ctrl-click: reset channel · Shift-click: reset at playhead / remove keyframe"
      : isGraph ? "Show / hide keyframe graph"
        : "Ctrl-click: reset channel · Shift-click: reset at playhead / remove keyframe";
    return `<label class="${cls}"${attrs} title="${title}">${label}</label>`;
  };
  const row = (label, inner, k = "", reset) =>
    `<div class="insp-row">${propLabel(label, k, reset)}${inner}${k ? kfCtl(k) : ""}</div>`;
  const slider = (k, min, max, step, val, unit = "") => {
    const shown = fmtInspNum(val, step);
    return row(k[0].toUpperCase() + k.slice(1),
      `<input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${shown}" title="Ctrl/Cmd-click: reset to default">
       <span class="val" data-val="${k}" data-unit="${unit}">${shown}${unit}</span>`, k);
  };
  let html = (state.selIds.size > 1
    ? `<div class="insp-multi">${state.selIds.size} clips selected — drag moves them together, Del deletes all. Fields below edit the primary (white-outlined) clip.</div>`
    : "") + clipStatusBar(c) + `<div class="insp-section"><h3>Clip — ${c.kind}</h3>
    ${row("Name", `<input type="text" data-k="name" value="${c.name.replace(/"/g, "&quot;")}">`)}
    ${c.mediaId ? row("Source", `<button type="button" class="btn tiny style-picker-btn" data-media-open title="Replace this clip's media — keeps position, trim, keyframes and effects">${escapeHtml((getMedia(c.mediaId) || {}).name || "Missing media")} ▾</button>`) : ""}
    ${row("Start (s)", `<input type="number" data-k="start" step="0.01" value="${c.start.toFixed(2)}">`)}
    ${row("Length (s)", `<input type="number" data-k="duration" step="0.01" value="${c.duration.toFixed(2)}">`)}
  </div>`;
  const sel = (label, k, opts, cur) => row(label,
    `<select data-k="${k}">${opts.map((o) => `<option value="${o}" ${String(o) === String(cur) ? "selected" : ""}>${o}</option>`).join("")}</select>`, k);
  const check = (label, k, on) => row(label, `<input type="checkbox" data-k="${k}" ${on ? "checked" : ""}>`, k);
  if (c.kind === "adjust") {
    html += `<div class="insp-section"><h3>Adjustment layer</h3>
      ${slider("opacity", 0, 1, 0.01, p.opacity)}
    </div>`;
  } else if (c.kind !== "audio") {
    html += `<div class="insp-section"><h3>Transform</h3>
      ${row("Position X", `<input type="number" data-k="x" value="${fmtInspNum(p.x)}">`, "x")}
      ${row("Position Y", `<input type="number" data-k="y" value="${fmtInspNum(p.y)}">`, "y")}
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
                           <input type="number" data-k="cropR" min="0" max="95" value="${p.cropR}" style="max-width:58px">`, "", "cropL,cropR")}
      ${row("Crop T/B %", `<input type="number" data-k="cropT" min="0" max="95" value="${p.cropT}" style="max-width:58px">
                           <input type="number" data-k="cropB" min="0" max="95" value="${p.cropB}" style="max-width:58px">`, "", "cropT,cropB")}
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
        <button class="btn tiny${p.chromaKey ? "" : " toggle on"}" data-action="keyoff" title="Disable chroma key">off</button>`, "", "chromaKey")}
      ${slider("chromaTolerance", 0, 100, 1, p.chromaTolerance)}
      ${slider("chromaSoftness", 0, 100, 1, p.chromaSoftness)}
      ${check("AI bg remove", "bgRemove", p.bgRemove)}
    </div>`;
  }
  if (c.kind === "video" || c.kind === "audio") {
    const chLabel = audioChannelLong(c.props?.audioChannel);
    const nt = normalizeTarget();
    html += `<div class="insp-section"><h3>Audio / Time</h3>
      ${chLabel ? row("Channel", `<span style="opacity:.75">${chLabel}</span>`)
        : row("Channels", `<select data-k="channelMode" title="Stereo: as recorded · Mono: fold L+R to one channel · Left / Right: use one side only · Swap: exchange L and R">${CHANNEL_MODES.map((o) =>
          `<option value="${o}" ${o === clipChannelMode(c) ? "selected" : ""}>${o[0].toUpperCase() + o.slice(1)}</option>`).join("")}</select>`, "", "channelMode")}
      ${row("Gain", `<input type="range" data-k="gain" min="-24" max="24" step="0.1" value="${fmtInspNum(clipGainDb(c), 0.1)}" title="Clip gain, applied before volume — Ctrl/Cmd-click: reset">
         <span class="val" data-val="gain" data-unit=" dB">${fmtInspNum(clipGainDb(c), 0.1)} dB</span>`, "", "gain")}
      ${row("Normalize", `<span class="insp-ctrls"><select data-norm-target title="Loudness target">${NORMALIZE_TARGETS.map((t) =>
        `<option value="${t.id}" ${t.id === nt.id ? "selected" : ""}>${t.label}</option>`).join("")}</select>
        <button type="button" class="btn tiny" data-norm-run title="Measure the selected clips and set their gain to hit this target (linked stems share one gain)">Apply</button></span>`)}
      ${row("Noise", `<span class="insp-ctrls"><select data-denoise title="${state.connected && state.ffmpeg
        ? "Noise reduction (ffmpeg FFT denoiser) — renders a cleaned copy of the file; Off switches back to the original"
        : "Noise reduction needs the server with ffmpeg on PATH"}" ${state.connected && state.ffmpeg ? "" : "disabled"}>${["off", ...DENOISE_LEVELS].map((v) =>
        `<option value="${v}" ${v === clipDenoise(c) ? "selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></span>`)}
      ${slider("volume", 0, 2, 0.01, p.volume)}
      ${slider("pan", -1, 1, 0.01, p.pan)}
      ${slider("speed", 0.25, 4, 0.05, p.speed, "×")}
    </div>`;
  }
  if (c.kind === "audio" && typeof FableCutFx !== "undefined") {
    html += `<div class="insp-section" data-fx-section><h3>Audio effects</h3>${fxEditorHtml(c.fx, playheadOverClip(c) ? state.time - c.start : null)}</div>`;
  }
  if (c.kind === "audio") {
    const duckN = c.keyframes?.duck?.length || 0;
    const lanes = audioTrackIds().filter((id) => id !== c.track);
    html += `<div class="insp-section"><h3>Auto-duck</h3>
      ${row("Under", `<select data-duck-under title="Lower this clip wherever there is sound on these tracks (dialogue / VO)">
        <option value="">All other audio tracks</option>${lanes.map((id) => `<option value="${id}">${id}</option>`).join("")}</select>`)}
      ${row("Amount", `<span class="insp-ctrls"><input type="number" data-duck-amount min="-40" max="-1" step="1" value="${duckAmount()}" title="How far to dip, dB" style="max-width:64px"> dB
        <button type="button" class="btn tiny" data-duck-run title="Write duck keyframes on the selected clips">Apply</button>
        ${duckN ? `<button type="button" class="btn tiny" data-duck-clear title="Remove the ducking">Clear</button>` : ""}</span>`)}
      ${duckN ? `<div class="insp-note">${duckN} duck keyframe${duckN === 1 ? "" : "s"} — the dashed line on the clip shows the ducked level.</div>` : ""}
    </div>`;
  }
  const tsel = (label, key, tr) => {
    const active = state.transFocus === (key === "transIn" ? "in" : "out");
    return `<div class="insp-row${active ? " trans-active" : ""}"><label class="insp-reset" data-reset="${key}" title="Ctrl-click: reset · Shift-click: reset">${label}</label>
      <span class="insp-ctrls"><select data-k="${key}">${TRANSITIONS.map((x) => `<option ${x === (tr?.type || "none") ? "selected" : ""}>${x}</option>`).join("")}</select>
       <input type="number" class="insp-dur" data-k="${key}Dur" step="0.1" min="0.1" value="${tr?.duration ?? 1}"></span></div>`;
  };
  const curveSel = (label, k, tr) => tr?.type === "fade" && c.kind === "audio"
    ? row(label, `<select data-k="${k}" title="Fade shape (audio)">${[["", "Smooth (eased)"], ...Object.entries(AUDIO_FADE_CURVES)].map(([v, l]) =>
      `<option value="${v}" ${(tr.curve || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select>`) : "";
  html += `<div class="insp-section"><h3>Transition</h3>
    ${tsel("In", "transIn", c.transitionIn)}
    ${curveSel("In curve", "curveIn", c.transitionIn)}
    ${tsel("Out", "transOut", c.transitionOut)}
    ${curveSel("Out curve", "curveOut", c.transitionOut)}
  </div>`;
  if (c.kind === "text") {
    const fontGroup = (label, fonts) => fonts.length
      ? `<optgroup label="${label}">${fonts.map((f) => `<option ${f === p.font ? "selected" : ""}>${f}</option>`).join("")}</optgroup>` : "";
    const known = [...SYSTEM_FONTS, ...runtime.customFonts, ...GOOGLE_FONTS, ...runtime.googleLoaded];
    html += `<div class="insp-section"><h3>Text</h3>
      ${row("Content", `<textarea data-k="text">${p.text}</textarea>`, "", "text")}
      ${row(hasTextBox(p) && p.boxFit ? "Max size" : "Font size",
        `<input type="range" data-k="fontSize" min="12" max="300" step="1" value="${fmtInspNum(p.fontSize, 1)}" title="Ctrl/Cmd-click: reset to default">
         <span class="val" data-val="fontSize" data-unit="px">${fmtInspNum(p.fontSize, 1)}px</span>`, "fontSize")}
      ${row("Box W/H", `<span class="insp-ctrls">
        <input type="number" data-k="boxW" min="0" step="1" value="${p.boxW || 0}" title="Width in px (0 = no box — hug content)" style="max-width:64px">
        <input type="number" data-k="boxH" min="0" step="1" value="${p.boxH || 0}" title="Height in px (0 = no box — hug content)" style="max-width:64px">
      </span>`, "", "boxW,boxH")}
      ${hasTextBox(p) ? check("Scale to fit", "boxFit", !!p.boxFit) : ""}
      ${row("Color", `<span class="insp-ctrls"><input type="color" data-k="color" value="${p.color}">
                      <input type="color" data-k="color2" value="${p.color2 || p.color}" title="Gradient bottom color">
                      <button class="btn tiny${p.color2 ? "" : " toggle on"}" data-action="grad-off" title="Disable gradient">flat</button></span>`, "", "color,color2")}
      ${sel("Align", "align", ["left", "center", "right", "justify"], p.align)}
      ${hasTextBox(p) ? sel("V-align", "vAlign", ["top", "middle", "bottom"], p.vAlign || "middle") : ""}
      ${sel("Direction", "direction", ["auto", "ltr", "rtl"], p.direction || "auto")}
    </div>
    <div class="insp-section"><h3>Font</h3>
      ${row("Family", `<select data-k="font">
        ${fontGroup("System", SYSTEM_FONTS)}
        ${fontGroup("Library fonts", runtime.customFonts)}
        ${fontGroup("Google fonts", [...new Set([...GOOGLE_FONTS, ...runtime.googleLoaded])])}
        ${known.includes(p.font) ? "" : `<option selected>${p.font}</option>`}
      </select>`, "", "font")}
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
      ${row("Stroke col.", `<input type="color" data-k="strokeColor" value="${p.strokeColor}">`, "", "strokeColor")}
      ${row("Bg color", `<input type="color" data-k="bgColor" value="${p.bgColor}">`, "", "bgColor")}
      ${slider("bgOpacity", 0, 1, 0.05, p.bgOpacity)}
      ${slider("textShadow", 0, 40, 1, p.textShadow)}
      ${slider("glow", 0, 100, 1, p.glow)}
      ${row("Glow color", `<input type="color" data-k="glowColor" value="${p.glowColor || p.color}">
        <button class="btn tiny${p.glowColor ? "" : " toggle on"}" data-action="glow-auto" title="Glow uses the text color">auto</button>`, "", "glowColor")}
    </div>
    <div class="insp-section"><h3>Title &amp; caption</h3>
      ${row("Title style", `<button type="button" class="btn tiny style-picker-btn" data-style-open title="Pick a style — hover to preview it live">${(TITLE_STYLES[c.styleName] || {}).label || "Choose…"} ▾</button>
        <button class="btn tiny" data-action="title-shuffle" title="Random style">Shuffle</button>`)}
      ${row("Animation", `<select data-k="textAnim">${TEXT_ANIMS.map((a) => `<option ${a === p.textAnim ? "selected" : ""}>${a}</option>`).join("")}</select>`, "", "textAnim")}
      ${slider("wordRate", 0.05, 0.6, 0.01, p.wordRate, "s")}
    </div>`;
  }
  els.inspector.innerHTML = html;
  inspSyncStamp = inspStampNow(); // full rebuild already reflects this state
  els.inspector.querySelectorAll("label.insp-reset[data-reset]").forEach((lab) => {
    lab.addEventListener("click", (e) => {
      const all = e.ctrlKey || e.metaKey;
      const local = e.shiftKey && !all;
      if (!all && !local) return;
      e.preventDefault();
      if (isGroupLocked(c)) { toastLocked(); return; }
      applyInspectorReset(lab.dataset.reset.split(",").map((s) => s.trim()).filter(Boolean), all);
    });
  });
  els.inspector.querySelectorAll("[data-k]").forEach((input) => {
    const k = input.dataset.k;
    input.addEventListener("input", (e) => {
      if (!input.isConnected) return;
      if (input.type === "range" && (e.ctrlKey || e.metaKey)) return;
      let v = input.type === "checkbox" ? input.checked
        : input.type === "range" || input.type === "number" ? parseFloat(input.value)
          : input.value;
      if (k === "weight") v = +v || 0;
      if (k === "font") ensureFont(String(v));
      if (k === "name") { c.name = String(v); state.dirtyTimeline = true; }
      else if (k === "start") { c.start = Math.max(0, +v || 0); state.dirtyTimeline = true; inspPropGen++; }
      else if (k === "duration") { c.duration = Math.max(MIN_DUR, +v || MIN_DUR); state.dirtyTimeline = true; inspPropGen++; }
      else if (k === "transIn" || k === "transOut") {
        const key = k === "transIn" ? "transitionIn" : "transitionOut";
        const side = k === "transIn" ? "in" : "out";
        const dur = Math.max(MIN_TRANS_DUR, parseFloat(els.inspector.querySelector(`[data-k="${k}Dur"]`)?.value) || 1);
        c[key] = v === "none" ? undefined : { type: String(v), duration: dur };
        if (c[key]) saveLastTransition(side, c[key]);
        state.dirtyTimeline = true;
      }
      else if (k === "curveIn" || k === "curveOut") {
        const tr = k === "curveIn" ? c.transitionIn : c.transitionOut;
        if (tr) {
          if (v) tr.curve = String(v); else delete tr.curve;
          for (const x of volGroup(c)) { // stems fade together
            const xt = k === "curveIn" ? x.transitionIn : x.transitionOut;
            if (x !== c && xt?.type === "fade") { if (v) xt.curve = String(v); else delete xt.curve; }
          }
          state.dirtyTimeline = true;
        }
      }
      else if (k === "transInDur" || k === "transOutDur") {
        const key = k === "transInDur" ? "transitionIn" : "transitionOut";
        const side = k === "transInDur" ? "in" : "out";
        if (c[key]) {
          c[key].duration = Math.max(MIN_TRANS_DUR, +v || 1);
          saveLastTransition(side, c[key]);
          state.dirtyTimeline = true;
        }
      }
      else if (ANIMATABLE.includes(k)) {
        if (!setAnimProp(c, k, v))
          toast("Move the playhead over the clip to edit its keyframes");
      }
      else { c.props[k] = v; if (k === "text") state.dirtyTimeline = true; }
      const valEl = els.inspector.querySelector(`[data-val="${k}"]`);
      if (valEl) valEl.textContent = input.value + (valEl.dataset.unit || "");
      scheduleSave();
      if (ANIMATABLE.includes(k)) syncInspectorPlayhead();
    });
    input.addEventListener("focus", () => {
      pushUndo();
      if (ANIMATABLE.includes(k) && state.playing) pause();
    }, { once: true });
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
        ensureFont(name).then((ok) => { if (!ok) toast(`Couldn't load "${name}" from Google Fonts`); });
        c.props.font = name;
        toast(`Loading Google font "${name}"…`);
      }
      else if (a === "title-shuffle") {
        const keys = Object.keys(TITLE_STYLES).filter((k) => k !== "plain" && k !== c.styleName);
        applyTitleStyle(c, keys[Math.floor(Math.random() * keys.length)], { keepTransform: true });
      }
      scheduleSave(); renderInspector();
    });
  });
  const fxSection = els.inspector.querySelector("[data-fx-section]");
  if (fxSection) {
    let undone = false;
    bindFxEditor(fxSection, () => c.fx, (fx) => {
      if (!undone) { pushUndo(); undone = true; } // one undo step per edit burst
      for (const x of volGroup(c)) { // a stereo pair shares one chain
        if (fx?.length) x.fx = fx.map((e) => ({ ...e })); else delete x.fx;
      }
      c.fx = fx; // keep c's array identity = what was just set
      if (!fx?.length) delete c.fx;
      scheduleSave();
      refreshAudioHold();
    }, () => renderInspector(), () => playheadOverClip(c) ? state.time - c.start : null);
  }
  els.inspector.querySelector("[data-duck-amount]")?.addEventListener("change", (e) => {
    try { localStorage.setItem(DUCK_KEY, String(clamp(+e.target.value || -12, -40, -1))); } catch { }
  });
  els.inspector.querySelector("[data-duck-run]")?.addEventListener("click", () => {
    const sel = selectedClips();
    autoDuckClips(sel.length ? sel : [c], {
      under: els.inspector.querySelector("[data-duck-under]")?.value || null,
      amount: clamp(+els.inspector.querySelector("[data-duck-amount]")?.value || -12, -40, -1),
    });
  });
  els.inspector.querySelector("[data-duck-clear]")?.addEventListener("click", () => {
    const sel = selectedClips();
    clearDuck(sel.length ? sel : [c]);
  });
  els.inspector.querySelector("[data-norm-target]")?.addEventListener("change", (e) => {
    try { localStorage.setItem(NORMALIZE_KEY, e.target.value); } catch { }
  });
  els.inspector.querySelector("[data-denoise]")?.addEventListener("change", (e) => {
    const sel = selectedClips();
    denoiseClips(sel.length ? sel : [c], e.target.value);
  });
  els.inspector.querySelector("[data-norm-run]")?.addEventListener("click", () => {
    const sel = selectedClips();
    normalizeClips(sel.length ? sel : [c]);
  });
  els.inspector.querySelectorAll("[data-style-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (runtime.styleMenu) { closeStylePicker(); return; }
      openStylePicker(btn, c);
    });
  });
  els.inspector.querySelectorAll("[data-media-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (runtime.mediaMenu) { closeMediaPicker(); return; }
      openMediaPicker(btn, c);
    });
  });
  els.inspector.querySelectorAll("[data-kf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pushUndo();
      if (!toggleKfAtPlayhead(c, btn.dataset.kf)) // owns dirtyTimeline on success
        toast("Move the playhead over the clip to add or remove keyframes");
      scheduleSave(); renderInspector();
    });
  });
  els.inspector.querySelectorAll("[data-kfclear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pushUndo();
      delete c.keyframes[btn.dataset.kfclear]; // raw mutation — owns its own side effects
      refreshAudioHoldFor(btn.dataset.kfclear);
      if (!Object.keys(c.keyframes).length) c.keyframes = undefined;
      state.dirtyTimeline = true;
      scheduleSave(); renderInspector();
    });
  });
  if (state.transFocus) {
    const k = state.transFocus === "in" ? "transIn" : "transOut";
    const row = els.inspector.querySelector(`[data-k="${k}"]`)?.closest(".insp-row");
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  els.inspector.querySelectorAll("[data-clip-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.clipCmd;
      if (!state.selIds.has(c.id)) selectClip(c.id);
      if (cmd === "disable") toggleClipsDisabled();
      else if (cmd === "lock") toggleClipsLocked();
      else if (cmd === "link") {
        // Relinking from the inspector pairs the clip with its aligned partners.
        if (!c.linkGroup && !c.linkedId) {
          const near = (a, b) => Math.abs(a - b) < 1e-3;
          const mates = project.clips.filter((x) => x.mediaId === c.mediaId &&
            near(x.start, c.start) && near(x.in, c.in) && near(x.duration, c.duration));
          setSelection(mates.map((x) => x.id));
        }
        toggleLinkSelected();
      }
    });
  });
  els.inspector.querySelectorAll("[data-kfgraph]").forEach((lab) => {
    lab.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return; // modifiers reserved for prop reset
      e.preventDefault();
      toggleKfGraph(lab.dataset.kfgraph);
    });
  });
  syncInspectorOffClip(c);
  renderKfGraphsPanel();
}
/* One listener for every slider: capture so preventDefault runs before the
   range jumps the thumb to the click. */
els.inspector.addEventListener("pointerdown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const input = e.target.closest?.("input[type=range][data-k]");
  if (!input || !els.inspector.contains(input)) return;
  e.preventDefault();
  if (isGroupLocked(getClip(state.selId))) { toastLocked(); return; }
  const k = input.dataset.k;
  if (!k || !Object.hasOwn(DEFAULT_PROPS, k)) return;
  applyInspectorReset([k], true);
}, true);
els.inspector.addEventListener("contextmenu", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!e.target.closest?.("input[type=range][data-k]")) return;
  e.preventDefault();
});

/* Off the clip, keyframed fields show their edge value but must not be
   editable — a write would land clamped on the clip's edge. Disables those
   inputs and the ◆ buttons. Called on every inspector sync and after each
   full renderInspector rebuild. */
function syncInspectorOffClip(c) {
  const off = !playheadOverClip(c);
  const locked = isGroupLocked(c); // a locked clip is read-only
  const active = document.activeElement;
  els.inspector.classList.toggle("locked", locked);
  for (const input of els.inspector.querySelectorAll("[data-k]")) {
    const k = input.dataset.k;
    if (input === active) continue; // don't yank focus mid-edit
    input.disabled = locked || (ANIMATABLE.includes(k) && off && !!(c.keyframes?.[k]?.length));
  }
  for (const btn of els.inspector.querySelectorAll("[data-kfclear], [data-action], [data-style-open], [data-media-open], [data-norm-run], [data-duck-run], [data-duck-clear]"))
    btn.disabled = locked;
  for (const btn of els.inspector.querySelectorAll("[data-kf]")) {
    btn.disabled = off || locked;
    btn.title = off ? "Move the playhead over the clip to add or remove keyframes"
      : btn.classList.contains("on") ? "Remove keyframe at playhead" : "Set keyframe at playhead";
  }
}
/* Patch inspector fields to the playhead (no innerHTML rebuild — keeps focus).
   Runs every rAF tick but exits early unless time, selection, or keyed values
   actually changed since the last sync. */
function syncInspectorPlayhead() {
  const root = els && els.inspector;
  if (!root) return;
  const c = getClip(state.selId);
  if (!c) return;
  const stamp = inspStampNow();
  if (stamp === inspSyncStamp) return;
  inspSyncStamp = stamp;
  const p = propsAtPlayhead(c);
  const active = document.activeElement;
  for (const input of root.querySelectorAll("[data-k]")) {
    const k = input.dataset.k;
    if (!ANIMATABLE.includes(k)) continue;
    if (active === input) continue;
    const v = p[k];
    if (typeof v !== "number" || isNaN(v)) continue;
    const next = fmtInspNum(v, input.type === "range" ? input.step : undefined);
    if (input.type === "range") {
      // Thumb saturates at the slider's ends; the label keeps the true value,
      // so an out-of-range keyframe doesn't churn the input every frame.
      const mn = +input.min, mx = +input.max;
      const shown = Number.isFinite(mn) && +next < mn ? input.min
        : Number.isFinite(mx) && +next > mx ? input.max : next;
      if (Math.abs(+input.value - +shown) > 1e-6) input.value = shown;
    } else if (Math.abs(+input.value - +next) > 1e-6) input.value = next;
    const valEl = root.querySelector(`[data-val="${k}"]`);
    if (valEl) {
      const text = next + (valEl.dataset.unit || "");
      if (valEl.textContent !== text) valEl.textContent = text;
    }
  }
  for (const btn of root.querySelectorAll("[data-kf]")) {
    const k = btn.dataset.kf;
    const n = (c.keyframes?.[k] && c.keyframes[k].length) || 0;
    const on = !!kfAtPlayhead(c, k);
    btn.classList.toggle("has", n > 0);
    btn.classList.toggle("on", on);
    const label = "◆" + (n || "");
    if (btn.textContent !== label) btn.textContent = label;
  }
  syncInspectorOffClip(c); // after the class pass, so ◆ titles read the fresh "on" state
}

/* ── Keyframe graphs (program-monitor left gutter) ── */
const KF_GRAPH_LABEL = {
  x: "Pos X", y: "Pos Y", scale: "Scale", rotation: "Rotation", opacity: "Opacity",
  volume: "Volume", pan: "Pan", duck: "Duck", speed: "Speed", brightness: "Bright", contrast: "Contrast",
  saturation: "Sat", hue: "Hue", blur: "Blur", grayscale: "Gray", sepia: "Sepia",
  invert: "Invert", temperature: "Temp", tint: "Tint", vignette: "Vignette",
  cornerRadius: "Radius", shake: "Shake", rgbSplit: "RGB", grain: "Grain",
  fontSize: "Size", letterSpacing: "Track", glow: "Glow",
};
function toggleKfGraph(key) {
  if (!ANIMATABLE.includes(key)) return;
  if (state.kfGraphs.has(key)) state.kfGraphs.delete(key);
  else state.kfGraphs.add(key);
  renderInspector(); // refresh label .on state + panel
}
function renderKfGraphsPanel() {
  const root = els.kfGraphs;
  if (!root) return;
  const c = getClip(state.selId);
  const keys = [...state.kfGraphs].filter((k) => ANIMATABLE.includes(k));
  if (!c || !keys.length) {
    root.innerHTML = "";
    root.hidden = true;
    return;
  }
  root.hidden = false;
  root.innerHTML = keys.map((k) => {
    const label = KF_GRAPH_LABEL[k] || k;
    return `<div class="kf-graph" data-kfgraph-card="${k}">
      <div class="kf-graph-head"><span>${label}</span>
        <button type="button" data-kfgraph-close="${k}" title="Close graph">✕</button></div>
      <canvas width="160" height="52"></canvas>
    </div>`;
  }).join("");
  root.querySelectorAll("[data-kfgraph-close]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.kfGraphs.delete(btn.dataset.kfgraphClose);
      renderInspector();
    });
  });
  root.querySelectorAll(".kf-graph canvas").forEach((cv) => {
    const key = cv.closest("[data-kfgraph-card]")?.dataset.kfgraphCard;
    cv.addEventListener("pointerdown", (e) => seekKfGraph(e, cv, key));
  });
  updateKfGraphs();
}
function seekKfGraph(e, cv, key) {
  const c = getClip(state.selId);
  if (!c || !key) return;
  const { t0, t1 } = kfGraphRange(c, key);
  const rect = cv.getBoundingClientRect();
  const u = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  setTime(c.start + t0 + u * Math.max(1e-6, t1 - t0));
  updateKfGraphs();
}
/* Value + time window for a graph. When keyframes exist, zoom X to their span
   (with padding) instead of the full clip duration. */
function kfGraphRange(c, key) {
  const fallback = +(c.props?.[key] ?? DEFAULT_PROPS[key] ?? 0);
  const dur = Math.max(MIN_DUR, c.duration);
  const kfs = Array.isArray(c.keyframes?.[key]) ? c.keyframes[key] : [];
  const vals = kfs.length ? kfs.map((kf) => +kf.v) : [fallback];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
  if (Math.abs(hi - lo) < 1e-6) {
    const pad = Math.max(0.05, Math.abs(lo) * 0.1 || 0.5);
    lo -= pad; hi += pad;
  } else {
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
  }

  let t0 = 0, t1 = dur;
  if (kfs.length === 1) {
    const t = clamp(+kfs[0].t || 0, 0, dur);
    const half = Math.max(0.15, dur * 0.08);
    t0 = Math.max(0, t - half);
    t1 = Math.min(dur, t + half);
  } else if (kfs.length >= 2) {
    const ts = kfs.map((kf) => +kf.t || 0);
    const a = Math.min(...ts), b = Math.max(...ts);
    const pad = Math.max(0.05, (b - a) * 0.1, dur * 0.02);
    t0 = Math.max(0, a - pad);
    t1 = Math.min(dur, b + pad);
  }
  if (t1 - t0 < 1e-3) { t0 = 0; t1 = dur; }
  return { lo, hi, fallback, t0, t1, dur };
}
function updateKfGraphs() {
  const root = els.kfGraphs;
  if (!root || root.hidden) return;
  const c = getClip(state.selId);
  if (!c) return;
  root.querySelectorAll(".kf-graph").forEach((card) => {
    const key = card.dataset.kfgraphCard;
    const cv = card.querySelector("canvas");
    if (key && cv) drawKfGraph(cv, c, key);
  });
}
function drawKfGraph(cv, c, key) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 160, cssH = cv.clientHeight || 52;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;
  g.clearRect(0, 0, W, H);
  const { lo, hi, fallback, t0, t1 } = kfGraphRange(c, key);
  const span = Math.max(1e-6, t1 - t0);
  const yAt = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
  const xAt = (t) => 3 + ((t - t0) / span) * (W - 6);

  // mid / zero guide
  g.strokeStyle = "#ffffff10";
  g.lineWidth = 1;
  g.beginPath();
  const y0 = yAt(0);
  if (y0 > 4 && y0 < H - 4) { g.moveTo(3, y0); g.lineTo(W - 3, y0); g.stroke(); }

  // interpolated curve (only the zoomed window)
  g.strokeStyle = "#7b6cff";
  g.lineWidth = 1.5;
  g.beginPath();
  const steps = Math.max(24, Math.floor(W));
  for (let i = 0; i <= steps; i++) {
    const t = t0 + (i / steps) * span;
    const v = kfChannel(c, key, t, fallback);
    const x = xAt(t), y = yAt(v);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();

  // keyframe diamonds
  const kfs = c.keyframes?.[key];
  if (Array.isArray(kfs)) {
    g.fillStyle = "#ffd166";
    for (const kf of kfs) {
      const x = xAt(kf.t), y = yAt(kf.v);
      g.beginPath();
      g.moveTo(x, y - 3.5); g.lineTo(x + 3.5, y); g.lineTo(x, y + 3.5); g.lineTo(x - 3.5, y);
      g.closePath(); g.fill();
    }
  }

  // playhead (drawn only when inside the zoomed window)
  const lt = state.time - c.start;
  if (lt >= t0 - 1e-6 && lt <= t1 + 1e-6) {
    const px = xAt(clamp(lt, t0, t1));
    g.strokeStyle = "#ff4d6a";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px, 1); g.lineTo(px, H - 1);
    g.stroke();
    const cur = kfChannel(c, key, clamp(lt, t0, t1), fallback);
    g.fillStyle = "#ff4d6a";
    g.beginPath();
    g.arc(px, yAt(cur), 2.5, 0, Math.PI * 2);
    g.fill();
  }
}

/* ═══════════════════════════ SOURCE MONITOR ═══════════════════════════
   Single-viewer Avid NewsCutter layout: one canvas toggles Source ↔ Program.
   Source holds a media-local playhead + In/Out marks (not timeline work area).
   Double-click Project media or a timeline clip to load Source. */
function isSourceMode() { return state.monitorMode === "source"; }
function sourceMedia() { return state.source.mediaId ? getMedia(state.source.mediaId) : null; }
function sourceDur() {
  const m = sourceMedia();
  if (!m) return 0;
  if (m.kind === "image" || m.kind === "svg") return Math.max(m.duration || 5, 0.1);
  return Math.max(+m.duration || 0, 0);
}
function persistSourceMarks() {
  const id = state.source.mediaId;
  if (!id) return;
  runtime.sourceMarks.set(id, { in: state.source.in, out: state.source.out });
}
/** Unload the Source monitor — its media was deleted or vanished on reload. */
function clearSource() {
  if (state.source.mediaId) runtime.sourceMarks.delete(state.source.mediaId);
  pauseSource();
  releaseSourceEl();
  state.source.mediaId = null;
  state.source.fromClipId = null;
  state.source.in = state.source.out = null;
  state.source.time = 0;
  if (isSourceMode()) setMonitorMode("program");
  else syncMonitorModeUI();
}
/** Rebuild the Source element after a project reload without losing the
 *  Source playhead or marks (clamped if the media got shorter). */
function restoreSourceAfterReload() {
  const m = sourceMedia();
  if (!m) return;
  if (state.source.fromClipId && !getClip(state.source.fromClipId)) state.source.fromClipId = null;
  const dur = sourceDur();
  if (dur > 0) {
    if (state.source.in != null) state.source.in = clamp(state.source.in, 0, dur);
    if (state.source.out != null) state.source.out = clamp(state.source.out, 0, dur);
    state.source.time = clamp(state.source.time, 0, dur);
  }
  pauseSource(); // adopt the decoded playhead before the element goes away
  releaseSourceEl(); // force rebuild against possibly new src
  const el = ensureSourceEl(m);
  if (el) {
    const seek = () => seekSourceEl(state.source.time);
    if (el.readyState >= 1) seek();
    else el.addEventListener("loadedmetadata", seek, { once: true });
  }
  syncMonitorModeUI();
}
function syncMonitorModeUI() {
  const src = isSourceMode();
  if (els.monitorPanel) els.monitorPanel.dataset.mode = state.monitorMode;
  for (const b of document.querySelectorAll("[data-monitor-mode]"))
    b.classList.toggle("on", b.dataset.monitorMode === state.monitorMode);
  if (els.sourceScrub) els.sourceScrub.classList.toggle("hidden", !src || !state.source.mediaId);
  const m = sourceMedia();
  if (els.monitorClipName) {
    els.monitorClipName.textContent = src && m ? m.name : "";
    els.monitorClipName.title = src && m ? m.name : "";
  }
  // Safe-area guides are sequence-relative — hide overlay chrome in Source
  if (els.btnGuides) els.btnGuides.classList.toggle("hidden", src);
  if (els.aspectSel) els.aspectSel.classList.toggle("hidden", src);
  if (els.kfGraphs) els.kfGraphs.classList.toggle("source-hidden", src);
  if (src && els.safeOverlay) els.safeOverlay.classList.add("hidden");
  else if (!src && els.safeOverlay) {
    els.safeOverlay.classList.toggle("hidden", !state.guides);
    updateSafeOverlay();
  }
  updateSourceScrub();
  syncPlayButton();
  if (els.btnInsert) {
    els.btnInsert.classList.toggle("hidden", !src);
    els.btnInsert.disabled = !state.source.mediaId;
  }
  if (els.btnReplace) {
    els.btnReplace.classList.toggle("hidden", !src);
    els.btnReplace.disabled = !state.source.mediaId;
    const fromClip = state.source.fromClipId && getClip(state.source.fromClipId);
    els.btnReplace.title = fromClip
      ? "Apply Source In→Out to the timeline clip (.) — ripples later clips if duration changes"
      : "Replace (overwrite) Source In→Out at the timeline playhead (.)";
  }
}
function setMonitorMode(mode) {
  if (mode !== "source" && mode !== "program") return;
  if (mode === state.monitorMode) {
    syncMonitorModeUI();
    return;
  }
  if (mode === "program") {
    pauseSource();
  } else {
    // Leaving Program for Source — stop sequence playback
    if (state.playing) pause();
  }
  state.monitorMode = mode;
  syncMonitorModeUI();
  scheduleAudioHoldRefresh();
}
function releaseSourceEl() {
  const el = runtime.sourceEl;
  if (el) {
    try { el.pause(); el.removeAttribute("src"); el.load(); } catch { }
    if (el._fcNodes) {
      for (const n of el._fcNodes) { try { n.disconnect(); } catch { } }
    }
    if (el._fcSrc) { try { el._fcSrc.disconnect(); } catch { } }
  }
  runtime.sourceEl = null;
  runtime.sourceHold = null;
  runtime.sourceHoldOk = false;
  runtime.sourceSeekPending = null;
  runtime.sourceSeekBusy = false;
}
function ensureSourceEl(m) {
  if (!m || (m.kind !== "video" && m.kind !== "audio")) {
    releaseSourceEl();
    return null;
  }
  let el = runtime.sourceEl;
  if (!el || el.tagName.toLowerCase() !== (m.kind === "audio" ? "audio" : "video")) {
    releaseSourceEl();
    el = document.createElement(m.kind === "audio" ? "audio" : "video");
    el.preload = "auto";
    el.playsInline = true;
    el.volume = 1;
    // After each seek settles, apply any newer scrub target (coalesced seeks).
    el.addEventListener("seeked", () => {
      runtime.sourceSeekBusy = false;
      flushSourceSeek();
    });
    runtime.sourceEl = el;
  }
  if (el.dataset.src !== m.src) {
    el.src = m.src;
    el.dataset.src = m.src;
    runtime.sourceHold = null;
    runtime.sourceHoldOk = false;
    runtime.sourceSeekPending = null;
    runtime.sourceSeekBusy = false;
  }
  return el;
}
/** Queue a Source media seek. HTMLVideoElement blanks while seeking; we only
 *  keep one in-flight seek and always show the last good hold frame. */
function flushSourceSeek() {
  const el = runtime.sourceEl;
  if (!el || state.source.playing) {
    runtime.sourceSeekPending = null;
    runtime.sourceSeekBusy = false;
    return;
  }
  const t = runtime.sourceSeekPending;
  if (t == null) return;
  if (runtime.sourceSeekBusy || el.seeking) return;
  if (Math.abs(el.currentTime - t) <= 1 / Math.max(1, project.fps || 30)) {
    runtime.sourceSeekPending = null;
    return;
  }
  runtime.sourceSeekPending = null;
  runtime.sourceSeekBusy = true;
  try { el.currentTime = t; } catch { runtime.sourceSeekBusy = false; }
}
function seekSourceEl(t) {
  const el = runtime.sourceEl;
  if (!el) return;
  runtime.sourceSeekPending = t;
  flushSourceSeek();
}
function setSourceTime(t) {
  const dur = sourceDur();
  state.source.time = clamp(t, 0, Math.max(dur, 0));
  const m = sourceMedia();
  if (m && (m.kind === "video" || m.kind === "audio") && !state.source.playing) {
    seekSourceEl(state.source.time);
  }
  updateSourceScrub();
  scheduleAudioHoldRefresh();
}
function updateSourceScrub() {
  if (!els.sourceScrubHead) return;
  const track = els.sourceScrubTrack;
  const dur = sourceDur();
  const w = track ? track.clientWidth : 0;
  const xAt = (t) => (dur > 0 && w > 0 ? clamp(t / dur, 0, 1) * w : 0);
  // Pixel + translate3d (like the timeline playhead) — smoother than % left.
  const hx = xAt(state.source.time);
  els.sourceScrubHead.style.transform = `translate3d(${hx}px,0,0)`;
  const a = state.source.in, b = state.source.out;
  if (els.sourceScrubIn) {
    const show = a != null;
    els.sourceScrubIn.hidden = !show;
    if (show) els.sourceScrubIn.style.transform = `translate3d(${xAt(a)}px,0,0)`;
  }
  if (els.sourceScrubOut) {
    const show = b != null;
    els.sourceScrubOut.hidden = !show;
    if (show) els.sourceScrubOut.style.transform = `translate3d(${xAt(b)}px,0,0)`;
  }
  if (els.sourceScrubRange) {
    if (a != null && b != null && b > a && dur > 0) {
      const x0 = xAt(a), x1 = xAt(b);
      els.sourceScrubRange.style.transform = `translate3d(${x0}px,0,0)`;
      els.sourceScrubRange.style.width = Math.max(0, x1 - x0) + "px";
    } else {
      els.sourceScrubRange.style.transform = "translate3d(0,0,0)";
      els.sourceScrubRange.style.width = "0px";
    }
  }
}
function syncPlayButton() {
  const on = isSourceMode() ? state.source.playing : state.playing;
  els.btnPlay.textContent = on ? "⏸" : "▶";
  els.btnPlay.classList.toggle("on", on);
}
/** Brief white border flash over the canvas (Project → Source feedback). */
function flashMonitorAttention() {
  const cv = els.preview;
  const inner = els.monitorZoomInner;
  if (!cv || !inner) return;
  let ring = $("monitorFlashRing");
  if (!ring) {
    ring = document.createElement("div");
    ring.id = "monitorFlashRing";
    ring.className = "monitor-flash-ring";
    inner.appendChild(ring);
  }
  ring.style.left = cv.offsetLeft + "px";
  ring.style.top = cv.offsetTop + "px";
  ring.style.width = cv.offsetWidth + "px";
  ring.style.height = cv.offsetHeight + "px";
  ring.classList.remove("on");
  void ring.offsetWidth;
  ring.classList.add("on");
  const done = () => {
    ring.classList.remove("on");
    ring.removeEventListener("animationend", done);
  };
  ring.addEventListener("animationend", done);
}
function pauseSource() {
  const wasPlaying = state.source.playing;
  state.source.playing = false;
  const el = runtime.sourceEl;
  if (el) {
    // Adopt the decoded playhead — never seek the element to the RAF clock.
    // Seeking a paused HTMLVideoElement clears the frame (black flash) until
    // the decoder catches up.
    if (wasPlaying && Number.isFinite(el.currentTime)) {
      state.source.time = clamp(el.currentTime, 0, Math.max(sourceDur(), 0));
    }
    if (!el.paused) el.pause();
  }
  syncPlayButton();
  updateSourceScrub();
}
/** Route a Source node's channels to per-track buses for metering.
 *  audio → the first Source track's bus (or master); video → mono-split each
 *  channel through gain → panner (default L/R) into the matching A-track bus.
 *  `collect(node, role)` receives every created node ("splitter"|"gain"|"panner")
 *  so callers can track them for disposal. Shared by live playback (hookSourceAudio)
 *  and Source audio-hold (refreshAudioHold). */
function routeSourceChannels(ctx, src, m, nCh, audio, collect) {
  if (m.kind === "audio") {
    const bus = audio.trackBus[sourceEditTracks(m)[0]] || audio.master;
    src.connect(bus);
    return;
  }
  const splitter = ctx.createChannelSplitter(nCh);
  src.connect(splitter);
  collect(splitter, "splitter");
  const stemTracks = sourceEditTracks(m).slice(1);
  for (let ch = 0; ch < nCh; ch++) {
    const trackId = ch < stemTracks.length ? stemTracks[ch] : `A${ch + 1}`;
    const bus = audio.trackBus[trackId];
    if (!bus) continue;

    const g = ctx.createGain();
    splitter.connect(g, ch);
    collect(g, "gain");

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = defaultPanForChannel(ch);
      g.connect(panner);
      panner.connect(bus);
      collect(panner, "panner");
    } else {
      g.connect(bus);
    }
  }
}
function hookSourceAudio(m, el, audio) {
  if (el._fcSrc) return;
  try {
    const ctx = audio.ctx;
    const src = ctx.createMediaElementSource(el);
    el._fcSrc = src;
    el._fcNodes = [];
    if (m.kind !== "audio" && m.kind !== "video") return;
    if (m.kind === "video") { try { src.channelInterpretation = "discrete"; } catch { } }
    const nCh = m.channels > 0 ? m.channels : 2;
    routeSourceChannels(ctx, src, m, nCh, audio, (n) => el._fcNodes.push(n));
  } catch (e) {
    el.volume = 1;
  }
}

async function playSource() {
  if (!state.source.mediaId) {
    toast("Double-click a clip in Project or the timeline to load Source");
    return;
  }
  if (state.playing) pause();
  if (state.audioHold) setAudioHold(false);
  const dur = sourceDur();
  const end = state.source.out != null ? Math.min(state.source.out, dur) : dur;
  const start = state.source.in != null ? state.source.in : 0;
  if (playRate() >= 0 && state.source.time >= end - 0.01) setSourceTime(start);
  const m = sourceMedia();
  const el = ensureSourceEl(m);
  const audio = ensureAudio();
  if (el) {
    if (m.kind === "video" && m.channels == null) {
      // Resolve channels before hooking so the graph has the right count
      await detectChannelCount(m);
    }
    hookSourceAudio(m, el, audio);
  }
  audio.ctx.resume();
  state.source.playing = true;
  syncPlayButton();
}
function toggleTransportPlay() {
  // Space always resumes forward — drop a reverse / crawl rate left by J or K+L
  if (!transportPlaying() && state.previewRate < 1) setPreviewRate(1);
  if (isSourceMode()) {
    state.source.playing ? pauseSource() : playSource();
  } else {
    state.playing ? pause() : play();
  }
}
function sourceStopAt() {
  const dur = sourceDur();
  if (state.source.out != null) return Math.min(state.source.out, dur);
  return dur;
}
function loadSourceFromMedia(m, opts = {}) {
  if (!m) return;
  // text/adjust aren't media — ignore
  if (m.kind === "text" || m.kind === "adjust") return;
  if (state.playing) pause();
  pauseSource();
  const prevId = state.source.mediaId;
  if (prevId && prevId !== m.id) persistSourceMarks();
  state.source.mediaId = m.id;
  state.source.fromClipId = opts.fromClipId || null;
  const marks = runtime.sourceMarks.get(m.id);
  if (opts.in != null || opts.out != null) {
    state.source.in = opts.in != null ? +opts.in : null;
    state.source.out = opts.out != null ? +opts.out : null;
  } else if (marks) {
    state.source.in = marks.in;
    state.source.out = marks.out;
  } else {
    state.source.in = null;
    state.source.out = null;
  }
  const dur = Math.max(+m.duration || (m.kind === "image" || m.kind === "svg" ? 5 : 0), 0);
  // Re-opening the same media without an explicit time keeps the Source playhead.
  let t;
  if (opts.time != null) t = +opts.time;
  else if (prevId === m.id) t = state.source.time;
  else if (state.source.in != null) t = state.source.in;
  else t = 0;
  state.source.time = clamp(t, 0, Math.max(dur, 0));
  ensureSourceEl(m);
  if (m.kind === "image") {
    const aux = runtime.mediaAux.get(m.id);
    if (!aux?.img) loadMediaMetadata(m).catch(() => {});
  }
  if (m.kind === "svg") loadSvgMedia(m).catch(() => {});
  setMonitorMode("source");
  updateSourceScrub();
  // Seek decode head once loaded (coalesced — hold frame covers the blank)
  const el = runtime.sourceEl;
  if (el) {
    const seek = () => seekSourceEl(state.source.time);
    if (el.readyState >= 1) seek();
    else el.addEventListener("loadedmetadata", seek, { once: true });
  }
}
function loadSourceFromClip(c, opts = {}) {
  if (!c || !c.mediaId) {
    if (c && (c.kind === "text" || c.kind === "adjust"))
      toast("Titles and adjustment layers have no source media");
    return;
  }
  const m = getMedia(c.mediaId);
  if (!m) return;
  const sp = clipSpeed(c);
  // Source In/Out = the instance's source window (Premiere/Avid-like)
  const inn = +c.in || 0;
  const out = inn + c.duration * sp;
  let time = opts.time;
  if (time == null && opts.timelineTime != null)
    time = mediaTimeAt(c, opts.timelineTime);
  if (time == null) time = inn;
  loadSourceFromMedia(m, {
    in: inn,
    out: out,
    time,
    fromClipId: c.id,
  });
  persistSourceMarks();
}
function setSourceInMark(at) {
  if (!state.source.mediaId) return;
  const t = +clamp(at ?? state.source.time, 0, Math.max(sourceDur(), 0)).toFixed(3);
  const out = state.source.out;
  if (out != null && t >= out) {
    toast("IN must be before OUT");
    return;
  }
  state.source.in = t;
  persistSourceMarks();
  updateSourceScrub();
}
function setSourceOutMark(at) {
  if (!state.source.mediaId) return;
  const t = +clamp(at ?? state.source.time, 0, Math.max(sourceDur(), 0)).toFixed(3);
  const inn = state.source.in;
  if (inn != null && t <= inn) {
    toast("OUT must be after IN");
    return;
  }
  state.source.out = t;
  persistSourceMarks();
  updateSourceScrub();
}
function clearSourceInMark() {
  if (state.source.in == null) return;
  state.source.in = null;
  persistSourceMarks();
  updateSourceScrub();
}
function clearSourceOutMark() {
  if (state.source.out == null) return;
  state.source.out = null;
  persistSourceMarks();
  updateSourceScrub();
}
function markIn() {
  if (isSourceMode()) setSourceInMark();
  else setInPoint();
}
function markOut() {
  if (isSourceMode()) setSourceOutMark();
  else setOutPoint();
}
function clearMarkIn() {
  if (isSourceMode()) clearSourceInMark();
  else clearInPoint();
}
function clearMarkOut() {
  if (isSourceMode()) clearSourceOutMark();
  else clearOutPoint();
}
/* ── Typed timecode: click the playhead / IN / OUT readout (or type a digit)
   and enter a time — see parseTimecode for the accepted forms. ── */
function tcEntryTarget(kind) {
  const src = isSourceMode();
  if (kind === "time") return src ? state.source.time : state.time;
  if (kind === "in") return src ? state.source.in : project.inPoint;
  return src ? state.source.out : project.outPoint;
}
function applyTcEntry(kind, t) {
  const src = isSourceMode();
  if (kind === "time") {
    if (src) setSourceTime(t);
    else { setTime(t); revealTime(state.time); }
  } else if (kind === "in") src ? setSourceInMark(t) : setInPoint(t);
  else src ? setSourceOutMark(t) : setOutPoint(t);
}
function beginTcEntry(el, kind, initial) {
  if (!el || document.querySelector(".tc-input")) return;
  if (kind !== "time" && isSourceMode() && !state.source.mediaId) return;
  const cur = tcEntryTarget(kind);
  const base = cur ?? tcEntryTarget("time");
  const r = el.getBoundingClientRect();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tc-input";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.title = "Enter to go · Esc to cancel (see ? for formats)";
  input.value = initial ?? fmt(base);
  // Sit exactly over the readout it replaces: same font, a hair of padding
  // for relative "+30" entries, no taller than the line (IN/OUT rows stack).
  const cs = getComputedStyle(el);
  Object.assign(input.style, {
    font: cs.font, left: r.left - 3 + "px", top: r.top - 2 + "px",
    width: r.width + 14 + "px", height: r.height + 4 + "px",
  });
  document.body.appendChild(input);
  el.classList.add("editing");
  let done = false;
  const close = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const t = parseTimecode(input.value, projectFps(), base);
      if (t == null) toast("Couldn't read that time — try 01:15:00, 1500, +30 or 12.5s");
      else if (input.value.trim() !== fmt(base)) applyTcEntry(kind, t);
    }
    input.remove();
    el.classList.remove("editing");
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); close(true); }
    else if (e.key === "Escape") { e.preventDefault(); close(false); }
  });
  input.addEventListener("blur", () => close(true));
  input.focus();
  if (initial == null) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}
els.tcCurrent.addEventListener("click", () => beginTcEntry(els.tcCurrent, "time"));
els.tcIn?.addEventListener("click", () => beginTcEntry(els.tcIn, "in"));
els.tcOut?.addEventListener("click", () => beginTcEntry(els.tcOut, "out"));
function gotoTransportHome() {
  if (isSourceMode()) {
    setSourceTime(state.source.in != null ? state.source.in : 0);
  } else gotoHome();
}
function gotoTransportEnd() {
  if (isSourceMode()) {
    const dur = sourceDur();
    setSourceTime(state.source.out != null ? state.source.out : dur);
  } else gotoEnd();
}
function stepTransport(dir) {
  const dt = dir * (1 / projectFps());
  if (isSourceMode()) setSourceTime(state.source.time + dt);
  else setTime(state.time + dt);
}
function syncSourceMedia() {
  const m = sourceMedia();
  if (!m || (m.kind !== "video" && m.kind !== "audio")) return;
  const el = ensureSourceEl(m);
  if (!el) return;
  const mt = state.source.time;
  const rate = playRate();
  if (state.source.playing) {
    if (rate < 0) { // media can't play backwards — park paused and seek frame by frame
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - mt) > 1 / projectFps()) {
        try { el.currentTime = mt; } catch { }
      }
      return;
    }
    if (el.playbackRate !== rate) { try { el.playbackRate = rate; } catch { } }
    if (el.paused) el.play().catch(() => {});
    // Only hard-seek on large drift (start/scrub resume). Tiny RAF vs decode
    // skew is corrected by driving state.source.time from el in the loop.
    if (Math.abs(el.currentTime - mt) > 0.35 * rate) {
      try { el.currentTime = mt; } catch { }
    }
  } else if (!el.paused) {
    el.pause();
  }
  // Paused: do not seek here. setSourceTime() handles user scrubs; seeking on
  // every post-pause drift flash-blacks the video frame.
}
function drawSourceContain(ctx, src, sw, sh, W, H) {
  if (!src || !(sw > 0) || !(sh > 0)) return false;
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  try {
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return true;
  } catch {
    return false;
  }
}
function ensureSourceHold(W, H) {
  let cv = runtime.sourceHold;
  if (!cv) {
    cv = document.createElement("canvas");
    runtime.sourceHold = cv;
  }
  if (cv.width !== W || cv.height !== H) {
    cv.width = W;
    cv.height = H;
    runtime.sourceHoldOk = false;
  }
  return cv;
}
/** Snapshot a decoded video frame into the hold canvas (used while seeking). */
function captureSourceVideoFrame(el, m, W, H) {
  if (!el || el.seeking || el.readyState < 2 || !(el.videoWidth > 0)) return false;
  const hold = ensureSourceHold(W, H);
  const g = hold.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  const ok = drawSourceContain(
    g, el,
    el.videoWidth || m.width || W,
    el.videoHeight || m.height || H,
    W, H
  );
  if (ok) runtime.sourceHoldOk = true;
  return ok;
}
function getSourceSvgImage(m, t) {
  const aux = runtime.mediaAux.get(m.id);
  if (!aux || !aux.svgText) return null;
  if (!aux.svgAnimated) return aux.img || null;
  const q = Math.round(Math.max(0, t) * projectFps()) / projectFps();
  const hit = aux.svgFrames.get(q);
  if (hit) return hit;
  if (!aux.svgPending) {
    aux.svgPending = renderSvgFrame(aux, q).then((img) => {
      aux.svgFrames.set(q, img);
      pruneSvgFrames(aux);
      aux.lastImg = img;
    }).catch(() => { }).finally(() => { aux.svgPending = null; });
  }
  return aux.lastImg || null;
}
function drawSourceFrame() {
  const W = els.preview.width, H = els.preview.height;
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.filter = "none"; ctx2d.globalAlpha = 1;
  ctx2d.fillStyle = "#000"; ctx2d.fillRect(0, 0, W, H);
  const m = sourceMedia();
  if (!m) {
    ctx2d.fillStyle = "#8a8698";
    ctx2d.font = `600 ${Math.round(H * 0.045)}px "Segoe UI", sans-serif`;
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";
    ctx2d.fillText("Double-click a clip to load Source", W / 2, H / 2);
    return;
  }
  const t = state.source.time;
  if (m.kind === "video") {
    const el = ensureSourceEl(m);
    // Prefer a fresh decode into the hold canvas; while seeking / not ready the
    // previous hold stays, so scrubbing doesn't flash black.
    captureSourceVideoFrame(el, m, W, H);
    if (runtime.sourceHoldOk && runtime.sourceHold)
      ctx2d.drawImage(runtime.sourceHold, 0, 0);
  } else if (m.kind === "image") {
    const img = runtime.mediaAux.get(m.id)?.img;
    if (img) drawSourceContain(ctx2d, img, img.naturalWidth || m.width || W, img.naturalHeight || m.height || H, W, H);
  } else if (m.kind === "svg") {
    const img = getSourceSvgImage(m, t);
    if (img) drawSourceContain(ctx2d, img, img.naturalWidth || m.width || W, img.naturalHeight || m.height || H, W, H);
  } else if (m.kind === "audio") {
    ctx2d.fillStyle = "#1a1a22";
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.fillStyle = "#cfc8ff";
    ctx2d.font = `700 ${Math.round(H * 0.08)}px "Segoe UI", sans-serif`;
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";
    ctx2d.fillText("♪", W / 2, H * 0.42);
    ctx2d.fillStyle = "#e8e6f0";
    ctx2d.font = `600 ${Math.round(H * 0.04)}px "Segoe UI", sans-serif`;
    ctx2d.fillText(m.name || "Audio", W / 2, H * 0.55);
    // Simple progress bar
    const dur = sourceDur();
    if (dur > 0) {
      const bw = W * 0.5, bh = Math.max(4, H * 0.01);
      const bx = (W - bw) / 2, by = H * 0.66;
      ctx2d.fillStyle = "#2a2a33";
      ctx2d.fillRect(bx, by, bw, bh);
      ctx2d.fillStyle = "#7b6cff";
      ctx2d.fillRect(bx, by, bw * clamp(t / dur, 0, 1), bh);
    }
  }
  // Draw In/Out labels on frame edge
  if (state.source.in != null || state.source.out != null) {
    ctx2d.font = `600 ${Math.max(11, Math.round(H * 0.028))}px "Segoe UI", sans-serif`;
    ctx2d.textBaseline = "top";
    if (state.source.in != null) {
      ctx2d.fillStyle = "#ffd166";
      ctx2d.textAlign = "left";
      ctx2d.fillText("IN " + fmt(state.source.in), 10, 10);
    }
    if (state.source.out != null) {
      ctx2d.fillStyle = "#ff8a65";
      ctx2d.textAlign = "right";
      ctx2d.fillText("OUT " + fmt(state.source.out), W - 10, 10);
    }
  }
}

/* ═══════════════════════════ PLAYBACK ENGINE ═══════════════════════════ */
function getClipEl(c) {
  let el = runtime.clipEls.get(c.id);
  const m = getMedia(c.mediaId);
  // The clip now plays another file (noise reduction, or undoing it): rebuild.
  if (el && m && el._fcSrc !== m.src) { releaseClipEl(c.id); el = null; }
  if (el) return el;
  if (!m) return null;
  el = document.createElement(c.kind === "audio" ? "audio" : "video");
  el.preload = "auto"; el.src = m.src; el.playsInline = true;
  el._fcSrc = m.src;
  runtime.clipEls.set(c.id, el);
  hookAudio(c, el);
  return el;
}
function releaseClipEl(id) {
  const el = runtime.clipEls.get(id);
  if (el) { try { el.pause(); el.src = ""; } catch { } runtime.clipEls.delete(id); }
  const chain = runtime.clipGain.get(id);
  if (chain) {
    disposeClipChain(chain);
    runtime.clipGain.delete(id);
  }
}

/* ═══ Audio mixer — one graph for preview and export ═══
   clip:   src → [channel routing] → trim (clip gain) → vol (volume, fades,
           keyframes) → pan ─→ its A-track bus (V-track audio → master sum)
   track:  bus (fader) → pan ─→ meter worklet input, or the master sum
   master: sum → masterOut (fader) → speakers + recorder
   Preview (AudioContext) and the export mix (OfflineAudioContext) are built
   from these same helpers, so what plays is what renders. */

/** Configure a bus so stereo panner output stays L/R through the meter. */
function configureTrackBus(g) {
  g.channelCount = 2;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "discrete";
}
/** Master sum / fader — same stereo rules as the A-buses. */
function configureMasterBus(g) {
  configureTrackBus(g);
}
/** Route `src` into `dest` per the clip's channel settings and return the
 *  routing nodes created (for disposal). An isolated stem (audioChannel) or a
 *  mono mode feeds `dest` one channel, so the clip's pan places it with equal
 *  power; stereo passes through and swap crosses L/R. */
function wireClipInput(ctx, src, dest, c, nCh) {
  const ch = c.props?.audioChannel;
  const mode = clipChannelMode(c);
  const stem = Number.isInteger(ch) && ch >= 0;
  // left/right on a mono source would pick a silent channel — play it as is.
  const iso = stem ? ch : nCh >= 2 && mode === "left" ? 0 : nCh >= 2 && mode === "right" ? 1 : -1;
  if (iso >= 0) {
    try { src.channelInterpretation = "discrete"; } catch { }
    const split = ctx.createChannelSplitter(Math.max(2, nCh | 0, iso + 1));
    src.connect(split);
    split.connect(dest, iso);
    return [split];
  }
  if (!stem && mode === "mono") {
    const down = ctx.createGain(); // speakers downmix: stereo → ½(L+R)
    down.channelCount = 1;
    down.channelCountMode = "explicit";
    down.channelInterpretation = "speakers";
    src.connect(down);
    down.connect(dest);
    return [down];
  }
  if (!stem && mode === "swap" && nCh >= 2) {
    const split = ctx.createChannelSplitter(Math.max(2, nCh | 0));
    const merge = ctx.createChannelMerger(2);
    src.connect(split);
    split.connect(merge, 0, 1);
    split.connect(merge, 1, 0);
    merge.connect(dest);
    return [split, merge];
  }
  src.connect(dest);
  return [];
}
function clipWiringKey(c) { return `${c.props?.audioChannel ?? ""}|${clipChannelMode(c)}`; }
/** One clip's chain: src → routing → trim → vol → pan. `out` goes to a bus;
 *  vol and pan are driven per frame (preview) or by curves (export). */
function buildClipChain(ctx, src, c, nCh) {
  const trim = ctx.createGain();
  const vol = ctx.createGain();
  const chain = { ctx, src, trim, vol, pan: null, out: vol, inNodes: [], nCh, wiring: "", bus: null };
  chain.inNodes = wireClipInput(ctx, src, trim, c, nCh);
  chain.wiring = clipWiringKey(c);
  trim.gain.value = dbToGain(clipGainDb(c));
  chain.fxSlot = makeFxSlot(ctx, trim, vol); // clip effects sit between gain and volume
  syncFxSlot(chain.fxSlot, c.fx);
  try {
    chain.pan = ctx.createStereoPanner();
    vol.connect(chain.pan);
    chain.out = chain.pan;
  } catch { chain.pan = null; } // no StereoPanner: vol is the output
  return chain;
}
/** Re-route a live chain after the clip's audioChannel / channelMode changed. */
function rewireClipChain(chain, c) {
  if (!chain || !chain.trim || chain.wiring === clipWiringKey(c)) return;
  try { chain.src.disconnect(); } catch { }
  for (const n of chain.inNodes) { try { n.disconnect(); } catch { } }
  chain.inNodes = wireClipInput(chain.ctx, chain.src, chain.trim, c, chain.nCh);
  chain.wiring = clipWiringKey(c);
}
function disposeClipChain(chain) {
  if (!chain) return;
  for (const n of [chain.out, chain.pan, chain.vol, chain.trim, ...(chain.inNodes || []), chain.src]) {
    if (n) { try { n.disconnect(); } catch { } }
  }
  disposeFxChain(chain.fxSlot?.chain);
  chain.bus = null;
}
/* ── Audio effects: the node side. A chain (audio-fx.js data) becomes a run
   of Web Audio nodes between two fixed points — an "fx slot". Clips have a
   slot between gain and volume, tracks between their input and fader, the
   master between its sum and fader. A slot rebuilds only when the chain's
   shape changes; parameter tweaks update the live nodes in place. Gate and
   limiter come from fx-worklet.js and pass audio through until it loads. */
const fxWorklets = new WeakMap(); // ctx → Promise (resolved = loaded)
const fxWorkletReady = new WeakSet();
function loadFxWorklet(ctx) {
  if (!ctx.audioWorklet) return Promise.resolve(false);
  let p = fxWorklets.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule("fx-worklet.js?v=2")
      .then(() => { fxWorkletReady.add(ctx); return true; })
      .catch((err) => { console.warn("[FableCut] fx worklet unavailable:", err); return false; });
    fxWorklets.set(ctx, p);
  }
  return p;
}
const FX_WORKLET_TYPES = { limiter: "fablecut-limiter", gate: "fablecut-gate", pitch: "fablecut-pitch" };
function normFx(list) {
  if (!Array.isArray(list) || !list.length) return undefined;
  const out = typeof FableCutFx !== "undefined" ? FableCutFx.normalizeFx(list) : list;
  return out.length ? out : undefined;
}
/** Seeded so preview and every export get the same impulse response. */
function reverbIR(ctx, decay) {
  const cache = reverbIR.cache || (reverbIR.cache = new WeakMap());
  let byDecay = cache.get(ctx);
  if (!byDecay) cache.set(ctx, byDecay = new Map());
  const key = decay.toFixed(2);
  if (byDecay.has(key)) return byDecay.get(key);
  const sr = ctx.sampleRate, n = Math.max(1, Math.round(sr * decay));
  const buf = ctx.createBuffer(2, n, sr);
  let s = Math.round(decay * 1000) >>> 0;
  const rnd = () => { // mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * Math.exp(-6.91 * i / n); // −60 dB at `decay`
  }
  byDecay.set(key, buf);
  return buf;
}
function shaperCurve(drive) {
  const k = drive * 40, n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * 2 / (n - 1) - 1;
    curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
  }
  return curve;
}
/** One effect as {input, output, nodes, set(e, smooth)}. `smooth` glides each
 *  parameter (automation runs ~50 times a second); otherwise it jumps. */
function makeFxUnit(ctx, e) {
  const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  let smooth = false;
  const sv = (param, v) => {
    if (!Number.isFinite(v)) return;
    if (smooth) param.setTargetAtTime(v, ctx.currentTime, 0.012);
    else param.value = v;
  };
  const unit = (u) => { const set = u.set; u.set = (p, sm = false) => { smooth = sm; set(p); }; return u; };
  const bq = (type) => { const n = ctx.createBiquadFilter(); n.type = type; return n; };
  const eqPow = (mix) => [Math.cos(mix * Math.PI / 2), Math.sin(mix * Math.PI / 2)];
  switch (e.type) {
    case "eq": {
      const lo = bq("lowshelf"), mid = bq("peaking"), hi = bq("highshelf");
      lo.connect(mid); mid.connect(hi);
      return unit({ input: lo, output: hi, nodes: [lo, mid, hi], set(p) {
        sv(lo.frequency, p.lowFreq); sv(lo.gain, p.lowGain);
        sv(mid.frequency, p.midFreq); sv(mid.gain, p.midGain); sv(mid.Q, p.midQ);
        sv(hi.frequency, p.highFreq); sv(hi.gain, p.highGain);
      } });
    }
    case "highpass": case "lowpass": {
      const f = bq(e.type);
      return unit({ input: f, output: f, nodes: [f], set(p) { sv(f.frequency, p.freq); sv(f.Q, p.q); } });
    }
    case "compressor": {
      const c = ctx.createDynamicsCompressor(), mk = g();
      c.connect(mk);
      return unit({ input: c, output: mk, nodes: [c, mk], set(p) {
        sv(c.threshold, p.threshold); sv(c.ratio, p.ratio); sv(c.knee, p.knee);
        sv(c.attack, p.attack / 1000); sv(c.release, p.release / 1000);
        sv(mk.gain, dbToGain(p.makeup));
      } });
    }
    case "limiter": case "gate": case "pitch": {
      if (!fxWorkletReady.has(ctx)) { const pass = g(); return unit({ input: pass, output: pass, nodes: [pass], pending: true, set() { } }); }
      const w = new AudioWorkletNode(ctx, FX_WORKLET_TYPES[e.type]);
      return unit({ input: w, output: w, nodes: [w], set(p) {
        for (const k of Object.keys(FableCutFx.FX_DEFS[e.type].params)) sv(w.parameters.get(k), p[k]);
      } });
    }
    case "delay": {
      const inp = g(), out = g(), dry = g(1), wet = g(), fb = g(), d = ctx.createDelay(2);
      inp.connect(dry); dry.connect(out);
      inp.connect(d); d.connect(wet); wet.connect(out); d.connect(fb); fb.connect(d);
      return unit({ input: inp, output: out, nodes: [inp, out, dry, wet, fb, d], set(p) {
        sv(d.delayTime, p.time); sv(fb.gain, p.feedback); sv(wet.gain, p.mix);
      } });
    }
    case "reverb": {
      const inp = g(), out = g(), dry = g(), wet = g(), pre = ctx.createDelay(0.5), conv = ctx.createConvolver();
      inp.connect(dry); dry.connect(out);
      inp.connect(pre); pre.connect(conv); conv.connect(wet); wet.connect(out);
      let decay = null;
      return unit({ input: inp, output: out, nodes: [inp, out, dry, wet, pre, conv], set(p) {
        const [d, w] = eqPow(p.mix);
        sv(dry.gain, d); sv(wet.gain, w); sv(pre.delayTime, p.predelay / 1000);
        if (decay !== p.decay) { decay = p.decay; conv.buffer = reverbIR(ctx, p.decay); }
      } });
    }
    case "distortion": {
      const inp = g(), out = g(), dry = g(), wet = g(), sh = ctx.createWaveShaper();
      sh.oversample = "4x";
      inp.connect(dry); dry.connect(out); inp.connect(sh); sh.connect(wet); wet.connect(out);
      let drive = null;
      return unit({ input: inp, output: out, nodes: [inp, out, dry, wet, sh], set(p) {
        const [d, w] = eqPow(p.mix);
        sv(dry.gain, d); sv(wet.gain, w);
        if (drive !== p.drive) { drive = p.drive; sh.curve = shaperCurve(p.drive); }
      } });
    }
    case "widener": { // mid/side width: 0 = mono, 1 = as is, 2 = twice the side
      const up = g(); // mono in → both sides, so a mono clip widens sanely
      up.channelCount = 2; up.channelCountMode = "explicit"; up.channelInterpretation = "speakers";
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      const ll = g(), lr = g(), rr = g(), rl = g();
      up.connect(sp);
      sp.connect(ll, 0); sp.connect(rl, 0); sp.connect(rr, 1); sp.connect(lr, 1);
      ll.connect(mg, 0, 0); lr.connect(mg, 0, 0); rr.connect(mg, 0, 1); rl.connect(mg, 0, 1);
      return unit({ input: up, output: mg, nodes: [up, sp, mg, ll, lr, rr, rl], set(p) {
        const a = (1 + p.width) / 2, b = (1 - p.width) / 2;
        sv(ll.gain, a); sv(rr.gain, a); sv(lr.gain, b); sv(rl.gain, b);
      } });
    }
  }
  const pass = g();
  return unit({ input: pass, output: pass, nodes: [pass], set() { } });
}
function buildFxChain(ctx, fx) {
  const units = fx.map((e) => { const u = makeFxUnit(ctx, e); u.set(e); return u; });
  for (let i = 1; i < units.length; i++) units[i - 1].output.connect(units[i].input);
  return { units, input: units[0].input, output: units[units.length - 1].output, pending: units.some((u) => u.pending) };
}
function disposeFxChain(chain) {
  if (!chain) return;
  for (const u of chain.units) for (const n of u.nodes) { try { n.disconnect(); } catch { } }
}
/** An fx insert between `from` and `to`; `from` must feed nothing else. */
function makeFxSlot(ctx, from, to) {
  from.connect(to);
  return { ctx, from, to, chain: null, ref: null, shape: "" };
}
/** Bring a slot in line with an effects list (bypassed effects left out). */
function syncFxSlot(slot, list) {
  if (!slot) return;
  if (slot.ref === list && !slot.chain?.pending) return;
  slot.ref = list;
  const fx = (list || []).filter((e) => e && e.on !== false);
  const shape = fx.map((e) => e.type).join(",");
  if (slot.chain && shape === slot.shape && !slot.chain.pending) {
    fx.forEach((e, i) => slot.chain.units[i].set(e));
    return;
  }
  try { slot.from.disconnect(); } catch { }
  disposeFxChain(slot.chain);
  slot.chain = null;
  slot.shape = shape;
  if (!fx.length) { slot.from.connect(slot.to); return; }
  slot.chain = buildFxChain(slot.ctx, fx);
  slot.from.connect(slot.chain.input);
  slot.chain.output.connect(slot.to);
}
/** Apply automation (`keys`) to a live slot at time t — clip-local for a
 *  clip's effects, timeline time for a track's, a bus's or the master's. */
function animateFxSlot(slot, t, smooth = true) {
  const chain = slot?.chain;
  if (!chain || chain.pending || !FableCutFx.hasKeys(slot.ref)) return;
  const fx = slot.ref.filter((e) => e && e.on !== false);
  fx.forEach((e, i) => { if (e.keys && chain.units[i]) chain.units[i].set(FableCutFx.evalEffect(e, t), smooth); });
}
function trackFx(id) { return TRACKS.find((t) => t.id === id)?.fx; }
function masterFx() { return project.master?.fx; }
/** An A-track bus: clips connect to the bus (its input sum), then fx →
 *  fader (`_fcFader`) → pan (`_fcPan`); `_fcOut` feeds the master sum. */
function makeTrackBus(ctx) {
  const bus = ctx.createGain();
  configureTrackBus(bus);
  const fader = ctx.createGain();
  configureTrackBus(fader);
  bus._fcFx = makeFxSlot(ctx, bus, fader);
  let pan = null;
  try { pan = ctx.createStereoPanner(); fader.connect(pan); } catch { pan = null; }
  bus._fcFader = fader;
  bus._fcPan = pan;
  bus._fcOut = pan || fader;
  return bus;
}
function busOut(bus) { return bus._fcOut || bus; }
function disposeTrackBus(bus) {
  for (const n of [busOut(bus), bus._fcFader, bus]) { try { n.disconnect(); } catch { } }
  disposeFxChain(bus._fcFx?.chain);
}
/** Track buses (→ a submix bus or the master) + submix buses (→ master) +
 *  master sum → master fx → master fader. */
function buildMixBuses(ctx, ids, busIds = busIdsNow()) {
  const master = ctx.createGain();
  configureMasterBus(master);
  const masterOut = ctx.createGain();
  configureMasterBus(masterOut);
  const masterFxSlot = makeFxSlot(ctx, master, masterOut);
  const subBus = {};
  for (const id of busIds) {
    subBus[id] = makeTrackBus(ctx);
    busOut(subBus[id]).connect(master);
  }
  const trackBus = {};
  for (const id of ids) {
    trackBus[id] = makeTrackBus(ctx);
    busOut(trackBus[id]).connect(master);
    trackBus[id]._fcDest = master;
  }
  return { ctx, master, masterOut, masterFxSlot, trackBus, subBus };
}
/** Point each track bus at its submix bus (tracks[].out) or the master.
 *  Disconnects only that one edge, so meter taps stay. */
function routeTrackBuses(mix) {
  for (const [id, bus] of Object.entries(mix.trackBus)) {
    const dest = mix.subBus?.[trackOut(id)] || mix.master;
    if (bus._fcDest === dest) continue;
    if (bus._fcDest) { try { busOut(bus).disconnect(bus._fcDest); } catch { } }
    busOut(bus).connect(dest);
    bus._fcDest = dest;
  }
}
/** Track / master effect automation at timeline time t. */
function animateMixFx(mix, t, smooth = true) {
  for (const bus of Object.values(mix.trackBus || {})) animateFxSlot(bus._fcFx, t, smooth);
  for (const bus of Object.values(mix.subBus || {})) animateFxSlot(bus._fcFx, t, smooth);
  animateFxSlot(mix.masterFxSlot, t, smooth);
}
/** Push track / master faders, pans and effects into a mix. `smooth` glides
 *  live fader moves (no zipper noise); export sets them flat. */
function applyMixLevels(mix, smooth = false) {
  if (!mix) return;
  const set = (param, v) => {
    if (smooth && mix.ctx) param.setTargetAtTime(v, mix.ctx.currentTime, 0.015);
    else param.value = v;
  };
  for (const [id, bus] of Object.entries(mix.trackBus)) {
    set((bus._fcFader || bus).gain, dbToGain(trackGainDb(id)));
    if (bus._fcPan) set(bus._fcPan.pan, trackPanValue(id));
    syncFxSlot(bus._fcFx, trackFx(id));
  }
  for (const [id, bus] of Object.entries(mix.subBus || {})) {
    const b = busById(id);
    set(bus._fcFader.gain, b?.mute ? 0 : dbToGain(clampFaderDb(b?.gain)));
    if (bus._fcPan) set(bus._fcPan.pan, clipPan(b?.pan));
    syncFxSlot(bus._fcFx, b?.fx);
  }
  routeTrackBuses(mix);
  if (mix.masterOut) set(mix.masterOut.gain, dbToGain(masterGainDb()));
  syncFxSlot(mix.masterFxSlot, masterFx());
}
function ensureAudio() {
  if (runtime.audio) return runtime.audio;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const ids = audioTrackIds();
  const mix = buildMixBuses(ctx, ids);
  const recDest = ctx.createMediaStreamDestination();
  // Until the meter worklet is ready the master fader feeds the speakers directly.
  mix.masterOut.connect(ctx.destination);
  mix.masterOut.connect(recDest);
  runtime.audio = {
    ctx, master: mix.master, masterOut: mix.masterOut, masterFxSlot: mix.masterFxSlot, recDest,
    trackBus: mix.trackBus, audioTrackIds: ids.slice(), subBus: mix.subBus, busIds: busIdsNow(),
    meter: null, meterReady: false,
  };
  applyMixLevels(runtime.audio);
  // Gate / limiter slots built before the worklet loaded pass audio through;
  // rebuild them once it is in (clip slots catch up on their next frame).
  loadFxWorklet(ctx).then(() => { if (runtime.audio?.ctx === ctx) applyMixLevels(runtime.audio); });
  installMeterWorklet(runtime.audio).catch(() => {});
  for (const [id, el] of runtime.clipEls) {
    const c = getClip(id);
    if (c) hookAudio(c, el);
  }
  return runtime.audio;
}
/** Create missing A-track buses and rebuild the meter when the track list changes. */
function syncAudioGraphTracks() {
  const audio = runtime.audio;
  if (!audio) return;
  const ids = audioTrackIds();
  const idSet = new Set(ids);
  // Drop buses for removed A-tracks (independent of meter state).
  for (const id of Object.keys(audio.trackBus)) {
    if (idSet.has(id)) continue;
    disposeTrackBus(audio.trackBus[id]);
    delete audio.trackBus[id];
  }
  for (const id of ids) {
    if (!audio.trackBus[id]) audio.trackBus[id] = makeTrackBus(audio.ctx);
  }
  audio.audioTrackIds = ids.slice();
  // Submix buses follow project.buses the same way.
  audio.subBus = audio.subBus || {};
  const busIds = busIdsNow();
  for (const id of Object.keys(audio.subBus)) {
    if (busIds.includes(id)) continue;
    disposeTrackBus(audio.subBus[id]);
    delete audio.subBus[id];
  }
  for (const id of busIds) {
    if (!audio.subBus[id]) audio.subBus[id] = makeTrackBus(audio.ctx);
    const out = busOut(audio.subBus[id]);
    try { out.disconnect(); } catch { }
    try { out.connect(audio.master); } catch { }
  }
  audio.busIds = busIds;
  // Tear down meter so installMeterWorklet can rebuild with the new input count.
  if (audio.meter) {
    teardownMeterNode(audio);
    audio.meter = null;
  }
  audio.meterReady = false;
  // Allow a new install even if a previous addModule is still in flight — that
  // call's finally will see _reloadMeter and run again.
  meterState._reloadMeter = true;
  // Always wire current buses → master so re-added tracks stay audible if meter install fails.
  for (const id of ids) {
    const out = busOut(audio.trackBus[id]);
    try { out.disconnect(); } catch { }
    try { out.connect(audio.master); } catch { }
    audio.trackBus[id]._fcDest = audio.master;
  }
  applyMixLevels(audio); // routes tracks into their submix buses
  installMeterWorklet(audio).catch(() => {});
  // Re-route clip chains onto (possibly new) buses
  for (const c of project.clips) {
    if (c.kind === "audio" || c.kind === "video") routeClipGain(c);
  }
}
function hookAudio(c, el) {
  if (!runtime.audio || runtime.clipGain.has(c.id)) return;
  if (c.kind !== "video" && c.kind !== "audio") return;
  const ctx = runtime.audio.ctx;
  // createMediaElementSource irreversibly diverts element audio into the
  // graph — register a stub first so releaseClipEl can always tear it down
  // even if building the chain throws.
  let src;
  try { src = ctx.createMediaElementSource(el); } catch { return; }
  runtime.clipGain.set(c.id, { src, inNodes: [] });
  try {
    const m = getMedia(c.mediaId);
    const ch = c.props?.audioChannel;
    const nCh = Math.max(m?.channels > 0 ? m.channels : 2, Number.isInteger(ch) ? ch + 1 : 0);
    runtime.clipGain.set(c.id, buildClipChain(ctx, src, c, nCh));
    routeClipGain(c);
  } catch { }
}
/** Reconnect a clip's chain to the correct track bus (or master for video tracks). */
function routeClipGain(c) {
  const chain = runtime.clipGain.get(c.id);
  if (!chain?.out || !runtime.audio) return;
  const bus = runtime.audio.trackBus[c.track] || runtime.audio.master;
  if (chain.bus === bus) return;
  try { chain.out.disconnect(); } catch { }
  chain.bus = null;
  chain.out.connect(bus);
  chain.bus = bus;
}
/** Drive a live clip chain from the clip's evaluated props at timeline time t. */
function driveClipChain(chain, c, p, t) {
  if (!chain?.vol) return;
  // The element may have been hooked before its channel count was probed.
  const nCh = getMedia(c.mediaId)?.channels;
  if (nCh > 0 && nCh !== chain.nCh && !Number.isInteger(c.props?.audioChannel)) {
    chain.nCh = nCh;
    chain.wiring = "";
  }
  rewireClipChain(chain, c);
  syncFxSlot(chain.fxSlot, c.fx);
  if (t != null) animateFxSlot(chain.fxSlot, t - c.start);
  chain.trim.gain.value = dbToGain(clipGainDb(c));
  chain.vol.gain.value = clipAudioGain(p);
  if (chain.pan) chain.pan.pan.value = clipPan(p.pan);
}
function muteClipChain(chain) {
  if (chain?.vol) chain.vol.gain.value = 0;
}

/* ── Normalize: measure what each clip feeds its gain stage over its source
   window (loudness.js — same math as fablecut_normalize_audio) and set clip
   gain to hit the target. Linked stems are measured together and share one
   gain, so a stereo pair stays balanced. Volume keyframes are left alone. ── */
const NORMALIZE_TARGETS = [
  { id: "lufs-14", label: "−14 LUFS (streaming)", mode: "lufs", value: -14 },
  { id: "lufs-16", label: "−16 LUFS (podcast)", mode: "lufs", value: -16 },
  { id: "lufs-23", label: "−23 LUFS (broadcast)", mode: "lufs", value: -23 },
  { id: "peak-1", label: "−1 dBFS peak", mode: "peak", value: -1 },
];
const NORMALIZE_KEY = "fablecut-normalize-target";
function normalizeTarget() {
  let id = null;
  try { id = localStorage.getItem(NORMALIZE_KEY); } catch { }
  return NORMALIZE_TARGETS.find((t) => t.id === id) || NORMALIZE_TARGETS[0];
}
/** Clips that actually sound for this selection: a linked group's audio stems
 *  (its picture is muted), or the clip itself. One array per gain decision. */
function normalizeGroups(clips) {
  const groups = new Map();
  for (const c of withLinked(clips)) {
    if (c.kind !== "audio" && c.kind !== "video") continue;
    const key = c.linkGroup || c.linkedId && [c.id, c.linkedId].sort().join("|") || c.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const list of groups.values()) {
    const stems = list.filter((c) => c.kind === "audio");
    out.push(stems.length ? stems : list);
  }
  return out;
}
/** Integrated loudness + sample peak of a group of clips, played together. */
async function measureClipGroup(clips) {
  const chans = [];
  let sr = 0;
  for (const c of clips) {
    const m = getMedia(c.mediaId);
    if (!m) continue;
    const buf = await getAudioBuffer(m);
    sr = sr || buf.sampleRate;
    const a = clamp(Math.floor(c.in * buf.sampleRate), 0, buf.length);
    const b = clamp(Math.ceil(mediaTimeAt(c, c.start + c.duration) * buf.sampleRate), a, buf.length);
    const src = [];
    for (let ch = 0; ch < buf.numberOfChannels; ch++) src.push(buf.getChannelData(ch).subarray(a, b));
    chans.push(...FableCutLoudness.routeChannels(src, c.props || {}));
  }
  if (!chans.length) return null;
  const n = Math.min(...chans.map((x) => x.length));
  return FableCutLoudness.measure(chans.map((x) => x.subarray(0, n)), sr);
}
async function normalizeClips(clips, target = normalizeTarget()) {
  if (typeof FableCutLoudness === "undefined") { toast("Loudness module missing — reload the editor"); return; }
  const groups = normalizeGroups(clips).filter((g) => !g.some(isGroupLocked));
  if (!groups.length) { toast("Select an audio or video clip to normalize"); return; }
  toast(`Measuring ${groups.length} clip${groups.length > 1 ? "s" : ""}…`);
  const results = [];
  for (const g of groups) {
    try { results.push({ g, m: await measureClipGroup(g) }); } catch { results.push({ g, m: null }); }
  }
  pushUndo();
  let done = 0, silent = 0;
  for (const { g, m } of results) {
    const db = m && FableCutLoudness.normalizeGainDb(m, target);
    if (db == null) { silent++; continue; }
    const gain = Math.round(clamp(db, CLIP_GAIN_MIN, CLIP_GAIN_MAX) * 10) / 10;
    for (const c of g) { if (getClip(c.id)) c.props.gain = gain; }
    done++;
  }
  scheduleSave();
  renderInspector();
  refreshAudioHold();
  const what = done === 1 && results.length === 1
    ? `gain ${fmtDb(results[0].g[0].props.gain)}` : `${done} clip${done === 1 ? "" : "s"}`;
  toast(`Normalized to ${target.label}: ${what}${silent ? ` · ${silent} silent, skipped` : ""}`);
}
/* ── Noise reduction: render and replace (denoise.js on the server). The
   server writes a cleaned FLAC of the clip's whole source file; the clip's
   audio stems switch to it (media.derivedFrom points back, so links and
   "Off" still find the original). The picture keeps its own file. ── */
const DENOISE_LEVELS = ["light", "medium", "strong"];
function baseMediaId(id) { return getMedia(id)?.derivedFrom || id; }
/** The stems a selection's noise reduction applies to (see denoise.js). */
function denoiseTargets(clips) {
  const out = new Map();
  for (const c of clips) {
    const stems = (c.linkGroup ? withLinked([c]) : [c]).filter((x) => x.kind === "audio" && x.mediaId);
    for (const s of stems) out.set(s.id, s);
  }
  return [...out.values()];
}
/** The level the clip plays at now: "off" or a DENOISE_LEVELS entry. */
function clipDenoise(c) {
  const stem = denoiseTargets([c])[0];
  return (stem && getMedia(stem.mediaId)?.denoise) || "off";
}
async function denoiseClips(clips, level) {
  const picked = denoiseTargets(clips);
  const targets = picked.filter((x) => !isGroupLocked(x));
  if (!picked.length) { toast("Noise reduction works on audio — this picture has no linked audio stems"); renderInspector(); return; }
  if (!targets.length) { toastLocked(); renderInspector(); return; }
  const swap = new Map(); // base media id → the media to play
  if (level === "off") for (const t of targets) swap.set(baseMediaId(t.mediaId), baseMediaId(t.mediaId));
  else {
    const bases = [...new Set(targets.map((t) => baseMediaId(t.mediaId)))];
    toast(`Reducing noise (${level})…`);
    for (const id of bases) {
      const base = getMedia(id);
      try {
        const r = await fetch("/api/denoise", { method: "POST", body: JSON.stringify({ src: base.src, amount: level }) })
          .then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.error || x.status); return j; });
        let m = project.media.find((x) => x.src === r.src);
        if (!m) {
          m = { id: "m_" + uid(), name: r.name, kind: "audio", src: r.src, duration: r.duration, folderId: base.folderId || null,
            derivedFrom: base.id, denoise: level };
          if (r.channels) m.channels = r.channels;
          project.media.push(m);
        }
        swap.set(id, m.id);
      } catch (err) {
        toast(`Noise reduction failed: ${err.message || err}`);
        renderInspector();
        return;
      }
    }
  }
  pushUndo();
  for (const t of targets) {
    const next = swap.get(baseMediaId(t.mediaId));
    if (!next || next === t.mediaId) continue;
    t.mediaId = next;
    releaseClipEl(t.id); // its player and audio chain rebuild on the new file
    const m = getMedia(next);
    if (m) ensureWave(m);
  }
  state.dirtyTimeline = true;
  scheduleSave();
  renderInspector();
  renderBin();
  refreshAudioHold();
  toast(level === "off" ? "Noise reduction off — playing the original" : `Noise reduction: ${level}`);
}
/* ── Auto-duck: find where the voice tracks have sound (ducking.js) and
   write `duck` keyframes on the selected music clips — the same pipeline as
   fablecut_auto_duck. The duck rides on top of volume, so the music's own
   level and fades are left alone and a re-run simply replaces the dips. ── */
const DUCK_KEY = "fablecut-duck-amount";
function duckAmount() {
  let v = -12;
  try { v = +localStorage.getItem(DUCK_KEY) || -12; } catch { }
  return clamp(v, -40, -1);
}
function setDuckKeys(c, keys) {
  for (const x of volGroup(c)) {
    if (keys.length) {
      x.keyframes = x.keyframes || {};
      x.keyframes.duck = keys.map((k) => ({ ...k }));
    } else if (x.keyframes?.duck) {
      delete x.keyframes.duck;
      if (!Object.keys(x.keyframes).length) x.keyframes = undefined;
    }
  }
}
/** Timeline spans with sound on the voice clips (each measured after its
 *  channel routing, scaled by its clip gain and static volume). */
async function voiceRegions(voices, threshold) {
  const lists = [];
  for (const v of voices) {
    const m = getMedia(v.mediaId);
    if (!m) continue;
    let buf;
    try { buf = await getAudioBuffer(m); } catch { continue; }
    const a = clamp(Math.floor(v.in * buf.sampleRate), 0, buf.length);
    const b = clamp(Math.ceil(mediaTimeAt(v, clipEnd(v)) * buf.sampleRate), a, buf.length);
    const src = [];
    for (let ch = 0; ch < buf.numberOfChannels; ch++) src.push(buf.getChannelData(ch).subarray(a, b));
    const env = FableCutDucking.rmsEnvelope(FableCutLoudness.routeChannels(src, v.props || {}), buf.sampleRate);
    lists.push(FableCutDucking.activeRegions(env, {
      t0: v.start, speed: clipSpeed(v), threshold,
      gain: dbToGain(clipGainDb(v)) * clamp(+(v.props?.volume ?? 1), 0, VOL_MAX),
    }));
  }
  return FableCutDucking.mergeRegions(lists);
}
async function autoDuckClips(clips, { under = null, amount = duckAmount(), threshold = -40 } = {}) {
  if (typeof FableCutDucking === "undefined") { toast("Ducking module missing — reload the editor"); return; }
  const music = withLinked(clips).filter((x) => x.kind === "audio" && !isGroupLocked(x));
  if (!music.length) { toast("Select the music clip(s) to duck"); return; }
  const musicIds = new Set(music.map((x) => x.id));
  const own = new Set(music.map((x) => x.track));
  const lanes = under ? [under] : audioTrackIds().filter((id) => !own.has(id));
  const t0 = Math.min(...music.map((x) => x.start)), t1 = Math.max(...music.map(clipEnd));
  const voices = project.clips.filter((x) => x.kind === "audio" && lanes.includes(x.track) &&
    !musicIds.has(x.id) && clipRenders(x) && clipEnd(x) > t0 && x.start < t1);
  if (!voices.length) {
    toast(`No audio on ${under || "the other audio tracks"} under these clips to duck for`);
    return;
  }
  toast("Listening for voice…");
  const regions = await voiceRegions(voices, threshold);
  pushUndo();
  let dips = 0;
  const done = new Set();
  for (const c of music) {
    if (done.has(c.linkGroup || c.id)) continue;
    done.add(c.linkGroup || c.id);
    const keys = FableCutDucking.duckKeyframes(regions, c, { amount });
    setDuckKeys(c, keys);
    dips += keys.filter((k, i) => k.v === amount && (i === 0 || keys[i - 1].v !== amount)).length;
  }
  state.dirtyTimeline = true;
  scheduleSave();
  renderInspector();
  refreshAudioHold();
  toast(regions.length ? `Ducked ${amount} dB under ${lanes.join(", ")} — ${dips} dip${dips === 1 ? "" : "s"}`
    : `No voice found on ${lanes.join(", ")} — nothing ducked`);
}
function clearDuck(clips) {
  const list = withLinked(clips).filter((x) => x.kind === "audio" && x.keyframes?.duck && !isGroupLocked(x));
  if (!list.length) return;
  pushUndo();
  for (const c of list) setDuckKeys(c, []);
  state.dirtyTimeline = true;
  scheduleSave();
  renderInspector();
  refreshAudioHold();
}
function fmtDb(db) {
  if (!Number.isFinite(db) || db <= FADER_DB_MIN) return "−∞ dB";
  const v = Math.round(db * 10) / 10;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " dB";
}

/* ── Mixer (side-panel tab): a strip per A-track — fader, pan, mute, solo,
   meter — plus the master fader. Faders live on project.tracks[].gain/pan and
   project.master.gain; meters read the same ballistics as the monitor VU. ── */
const SIDE_TAB_KEY = "fablecut-side-tab";
const MIXER_MASTER = "master";
const mixerState = { open: false, strips: {} };
/* Console-style taper: unity sits at 3/4 of the throw, the bottom is −∞. */
const FADER_TAPER = [[0, FADER_DB_MIN], [0.25, -30], [0.5, -12], [0.75, 0], [1, FADER_DB_MAX]];
function faderPosToDb(pos) {
  pos = clamp(+pos || 0, 0, 1);
  for (let i = 1; i < FADER_TAPER.length; i++) {
    const [p1, d1] = FADER_TAPER[i], [p0, d0] = FADER_TAPER[i - 1];
    if (pos <= p1) return d0 + (d1 - d0) * (pos - p0) / (p1 - p0);
  }
  return FADER_DB_MAX;
}
function faderDbToPos(db) {
  db = clampFaderDb(db);
  for (let i = 1; i < FADER_TAPER.length; i++) {
    const [p1, d1] = FADER_TAPER[i], [p0, d0] = FADER_TAPER[i - 1];
    if (db <= d1) return p0 + (p1 - p0) * (db - d0) / (d1 - d0);
  }
  return 1;
}
function fmtPan(v) {
  const n = Math.round(clipPan(v) * 100);
  return n === 0 ? "C" : n < 0 ? `L${-n}` : `R${n}`;
}
/** Parse a typed fader value: "-6", "+3.5 dB", "-inf". */
function parseDbInput(s) {
  const t = String(s).trim().toLowerCase().replace("−", "-");
  if (/^-?∞|^-?inf/.test(t)) return FADER_DB_MIN;
  const v = parseFloat(t);
  return Number.isFinite(v) ? clampFaderDb(v) : null;
}
function setSideTab(tab) {
  const mixer = tab === "mixer";
  mixerState.open = mixer;
  for (const b of els.sideTabs.querySelectorAll("[data-side]"))
    b.classList.toggle("on", b.dataset.side === tab);
  els.inspector.classList.toggle("hidden", mixer);
  els.mixer.classList.toggle("hidden", !mixer);
  try { localStorage.setItem(SIDE_TAB_KEY, tab); } catch { }
  if (mixer) renderMixer();
  else renderInspector();
}
/** Write a track's fader / pan, push it into the live graph, persist. */
function setTrackMix(id, { gain, pan } = {}) {
  const t = TRACKS.find((x) => x.id === id && x.kind === "audio");
  if (!t) return;
  if (gain !== undefined) { const g = Math.round(clampFaderDb(gain) * 10) / 10; if (g) t.gain = g; else delete t.gain; }
  if (pan !== undefined) { const p = clipPan(pan); if (p) t.pan = p; else delete t.pan; }
  project.tracks = serializeTracks();
  if (runtime.audio) applyMixLevels(runtime.audio, true);
  scheduleSave();
  syncMixerStrip(id);
}
function setMasterGain(db) {
  project.master = normalizeMaster({ gain: Math.round(clampFaderDb(db) * 10) / 10 });
  if (runtime.audio) applyMixLevels(runtime.audio, true);
  scheduleSave();
  syncMixerStrip(MIXER_MASTER);
}
function mixerStripDb(id) {
  if (id === MIXER_MASTER) return masterGainDb();
  const b = busById(id);
  return b ? clampFaderDb(b.gain) : trackGainDb(id);
}
/** Apply a bus list change (add / remove) to the live graph and the panel. */
function busesChanged() {
  project.tracks = serializeTracks();
  if (runtime.audio) syncAudioGraphTracks();
  scheduleSave();
  renderMixer();
}
function addBus() {
  const buses = project.buses || (project.buses = []);
  if (buses.length >= BUS_MAX) { toast(`Up to ${BUS_MAX} buses`); return; }
  let n = 1;
  while (buses.some((b) => b.id === "B" + n)) n++;
  buses.push({ id: "B" + n });
  project.buses = normalizeBuses(buses);
  busesChanged();
}
function removeBus(id) {
  project.buses = (project.buses || []).filter((b) => b.id !== id);
  for (const t of TRACKS) if (t.out === id) delete t.out; // its tracks go back to the master
  busesChanged();
}
/** Write a bus's fader / pan / mute / name and push it into the live graph. */
function setBusMix(id, patch) {
  const b = busById(id);
  if (!b) return;
  Object.assign(b, patch);
  project.buses = normalizeBuses(project.buses);
  if (runtime.audio) applyMixLevels(runtime.audio, true);
  scheduleSave();
  syncMixerStrip(id);
}
function setTrackOut(id, out) {
  const t = TRACKS.find((x) => x.id === id && x.kind === "audio");
  if (!t) return;
  if (out && busById(out)) t.out = out; else delete t.out;
  project.tracks = serializeTracks();
  if (runtime.audio) applyMixLevels(runtime.audio, true);
  scheduleSave();
}
function renderMixer() {
  if (!mixerState.open || !els.mixer) return;
  const root = els.mixer;
  root.innerHTML = "";
  mixerState.strips = {};
  if (mixerState.fxTarget) { renderMixerFx(root, mixerState.fxTarget); return; }
  const row = document.createElement("div");
  row.className = "mixer-strips";
  const buses = project.buses || [];
  const strip = (id, label, color, isMaster, isBus = false) => {
    const s = document.createElement("div");
    s.className = "mix-strip" + (isMaster ? " master" : "") + (isBus ? " bus" : "");
    s.dataset.strip = id;
    if (color) s.style.setProperty("--strip-color", color);
    s.innerHTML = `
      <div class="mix-name" title="${isMaster ? "Master bus — everything you hear and export" : isBus ? `Submix bus ${id} — double-click to rename` : `Track ${id}`}">${escapeHtml(label)}</div>
      ${!isMaster && !isBus ? `<select class="mix-out" title="Where this track goes: the master, or a submix bus"><option value="">→ Master</option>${buses.map((b) =>
        `<option value="${b.id}">→ ${escapeHtml(busLabel(b))}</option>`).join("")}</select>` : ""}
      ${isMaster ? `<div class="mix-pan-row mix-lufs" title="Momentary loudness of the mix (post-fader)">— LUFS</div>`
        : `<div class="mix-pan-row"><input type="range" class="mix-pan" min="-1" max="1" step="0.01" title="Track pan — double-click: center"><span class="mix-pan-val"></span></div>`}
      <div class="mix-body">
        <canvas class="mix-meter"></canvas>
        <input type="range" class="mix-fader" min="0" max="1" step="0.001" title="${isMaster ? "Master" : "Track"} fader — double-click: 0 dB">
      </div>
      <input type="text" class="mix-db" spellcheck="false" title="Type a level in dB (e.g. -6, +2, -inf)">
      <button type="button" class="mix-fx" title="${isMaster ? "Master" : isBus ? `Bus ${id}` : `Track ${id}`} effects">FX</button>
      ${isMaster ? "" : isBus ? `<div class="mix-btns"><button type="button" class="mix-m" title="Mute the bus">M</button><button type="button" class="mix-x" title="Remove the bus — its tracks go back to the master">✕</button></div>`
        : `<div class="mix-btns"><button type="button" class="mix-m" title="Mute (track output on/off)">M</button><button type="button" class="mix-s" title="Solo">S</button></div>`}`;
    s.querySelector(".mix-fx").addEventListener("click", () => { mixerState.fxTarget = id; renderMixer(); });
    const fader = s.querySelector(".mix-fader");
    const dbIn = s.querySelector(".mix-db");
    const setDb = (db) => isMaster ? setMasterGain(db) : isBus ? setBusMix(id, { gain: db }) : setTrackMix(id, { gain: db });
    fader.addEventListener("input", () => setDb(faderPosToDb(fader.value)));
    fader.addEventListener("dblclick", () => setDb(0));
    dbIn.addEventListener("change", () => {
      const v = parseDbInput(dbIn.value);
      if (v == null) syncMixerStrip(id); else setDb(v);
    });
    dbIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") dbIn.blur(); });
    if (isBus) {
      const pan = s.querySelector(".mix-pan");
      pan.addEventListener("input", () => setBusMix(id, { pan: +pan.value }));
      pan.addEventListener("dblclick", () => setBusMix(id, { pan: 0 }));
      s.querySelector(".mix-m").addEventListener("click", () => setBusMix(id, { mute: !busById(id)?.mute }));
      s.querySelector(".mix-x").addEventListener("click", () => removeBus(id));
      const nameEl = s.querySelector(".mix-name");
      nameEl.addEventListener("dblclick", () => {
        const inp = document.createElement("input");
        inp.className = "mix-rename";
        inp.value = busById(id)?.name || "";
        inp.placeholder = id;
        nameEl.replaceWith(inp);
        inp.focus(); inp.select();
        const done = () => { setBusMix(id, { name: inp.value }); renderMixer(); };
        inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { inp.value = busById(id)?.name || ""; inp.blur(); } });
        inp.addEventListener("blur", done, { once: true });
      });
    } else if (!isMaster) {
      const pan = s.querySelector(".mix-pan");
      pan.addEventListener("input", () => setTrackMix(id, { pan: +pan.value }));
      pan.addEventListener("dblclick", () => setTrackMix(id, { pan: 0 }));
      s.querySelector(".mix-m").addEventListener("click", () => toggleTrackEnabled(id));
      s.querySelector(".mix-s").addEventListener("click", () => toggleTrackSolo(id));
      const out = s.querySelector(".mix-out");
      out.value = trackOut(id) || "";
      out.addEventListener("change", () => setTrackOut(id, out.value || null));
    }
    row.appendChild(s);
    const cv = s.querySelector(".mix-meter");
    mixerState.strips[id] = { el: s, cv, ctx: cv.getContext("2d"), w: 0, h: 0, master: isMaster, bus: isBus };
  };
  for (const t of TRACKS) if (t.kind === "audio") strip(t.id, t.id, t.color, false);
  for (const b of buses) strip(b.id, busLabel(b), BUS_COLOR, false, true);
  if (buses.length < BUS_MAX) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "mix-add";
    add.title = "Add a submix bus — route tracks into it to process and level them together";
    add.textContent = "+ Bus";
    add.addEventListener("click", addBus);
    row.appendChild(add);
  }
  strip(MIXER_MASTER, "Master", null, true);
  root.appendChild(row);
  for (const id of Object.keys(mixerState.strips)) syncMixerStrip(id);
  sizeMixerMeters();
}
/** Size meter canvases to their laid-out box (device pixels). */
function sizeMixerMeters() {
  const dpr = window.devicePixelRatio || 1;
  for (const st of Object.values(mixerState.strips)) {
    const w = st.cv.clientWidth, h = st.cv.clientHeight;
    if (!w || !h || (st.w === w && st.h === h)) continue;
    st.w = w; st.h = h;
    st.cv.width = Math.round(w * dpr);
    st.cv.height = Math.round(h * dpr);
    st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  paintMixerMeters();
}
function syncMixerStrip(id) {
  const st = mixerState.strips[id];
  if (!st) return;
  const s = st.el;
  const db = mixerStripDb(id);
  const fader = s.querySelector(".mix-fader");
  // Leave a fader being dragged alone (the taper round-trip would nudge it).
  if (document.activeElement !== fader || Math.abs(+fader.value - faderDbToPos(db)) > 0.002) fader.value = faderDbToPos(db);
  const dbIn = s.querySelector(".mix-db");
  if (document.activeElement !== dbIn) dbIn.value = fmtDb(db);
  const nFx = ((st.master ? masterFx() : st.bus ? busById(id)?.fx : trackFx(id)) || []).filter((e) => e.on !== false).length;
  const fxBtn = s.querySelector(".mix-fx");
  fxBtn.textContent = nFx ? `FX ${nFx}` : "FX";
  fxBtn.classList.toggle("on", nFx > 0);
  if (st.master) return;
  if (st.bus) {
    const b = busById(id);
    const pan = s.querySelector(".mix-pan");
    if (document.activeElement !== pan) pan.value = clipPan(b?.pan);
    s.querySelector(".mix-pan-val").textContent = fmtPan(b?.pan);
    s.classList.toggle("muted", !!b?.mute);
    s.querySelector(".mix-m").classList.toggle("on", !!b?.mute);
    s.querySelector(".mix-m").setAttribute("aria-pressed", b?.mute ? "true" : "false");
    return;
  }
  const pan = s.querySelector(".mix-pan");
  pan.value = trackPanValue(id);
  s.querySelector(".mix-pan-val").textContent = fmtPan(trackPanValue(id));
  const on = isTrackEnabled(id), solo = state.soloId === id;
  s.classList.toggle("muted", !on);
  s.querySelector(".mix-m").classList.toggle("on", !on);
  s.querySelector(".mix-m").setAttribute("aria-pressed", on ? "false" : "true");
  s.querySelector(".mix-s").classList.toggle("on", solo);
  s.querySelector(".mix-s").setAttribute("aria-pressed", solo ? "true" : "false");
}
/* ── Effects panel: the same editor for a clip (inspector), a track and the
   master (mixer). `get` returns the current chain, `set` applies a new one
   (always a fresh array, so live audio slots notice the change). ── */
function fxFmt(v, d) {
  if (d.unit === "Hz") return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
  if (d.unit === "") return d.max <= 1 ? `${Math.round(v * 100)}%` : (+v).toFixed(2);
  if (d.unit === "ms") return `${Math.round(v)} ms`;
  if (d.unit === "s") return `${(+v).toFixed(2)} s`;
  if (d.unit === ":1") return `${(+v).toFixed(1)}:1`;
  if (d.unit === "×") return `${(+v).toFixed(2)}×`;
  return `${(+v).toFixed(1)} ${d.unit}`;
}
/* Frequency sliders move on a log scale (0…1000 ↔ min…max Hz). */
const fxToSlider = (v, d) => d.unit === "Hz" ? Math.round(1000 * Math.log(v / d.min) / Math.log(d.max / d.min)) : v;
const fxFromSlider = (s, d) => d.unit === "Hz" ? d.min * Math.pow(d.max / d.min, s / 1000) : +s;
/** The effects editor. `at` is the time keys are read and written at — the
 *  playhead in clip-local seconds for a clip's chain, timeline seconds for a
 *  track's, a bus's or the master's; null while the playhead is off the clip
 *  (automation is then shown but not editable). */
function fxEditorHtml(list, at = null) {
  const F = FableCutFx;
  const groups = {};
  for (const [id, p] of Object.entries(F.PRESETS)) (groups[p.group] = groups[p.group] || []).push([id, p.label]);
  let html = `<div class="fx-tools-row">
    <select data-fx-preset title="Replace the chain with a preset — tweak it afterwards"><option value="">Preset…</option>${Object.entries(groups).map(([g, items]) =>
      `<optgroup label="${g}">${items.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</optgroup>`).join("")}</select>
    <select data-fx-add title="Add an effect to the end of the chain"><option value="">+ Add effect…</option>${F.FX_TYPES.map((t) =>
      `<option value="${t}">${F.FX_DEFS[t].label}</option>`).join("")}</select>
    ${list?.length ? `<button type="button" class="btn tiny" data-fx-clear title="Remove every effect">Clear</button>` : ""}
  </div>`;
  if (!list?.length) return html + `<div class="insp-note">No effects. Pick a preset or add one.</div>`;
  list.forEach((e, i) => {
    const def = F.FX_DEFS[e.type];
    const ev = at != null ? F.evalEffect(e, at) : e;
    html += `<div class="fx-card${e.on === false ? " off" : ""}" data-fx-i="${i}">
      <div class="fx-head"><label title="On / bypass"><input type="checkbox" data-fx-on ${e.on === false ? "" : "checked"}> ${def.label}</label>
        <span class="fx-btns"><button type="button" data-fx-move="-1" title="Earlier in the chain" ${i ? "" : "disabled"}>▲</button><button type="button" data-fx-move="1" title="Later in the chain" ${i < list.length - 1 ? "" : "disabled"}>▼</button><button type="button" data-fx-del title="Remove">✕</button></span></div>
      ${Object.entries(def.params).map(([k, d]) => `<div class="fx-param"><span>${d.label}</span>
        <input type="range" data-fx-p="${k}" min="${d.unit === "Hz" ? 0 : d.min}" max="${d.unit === "Hz" ? 1000 : d.max}" step="${d.unit === "Hz" ? 1 : d.step}" value="${fxToSlider(ev[k], d)}" title="Double-click: default">
        <span class="fx-val">${fxFmt(ev[k], d)}</span>${d.fixed ? "<span></span>" : fxKeyBtn(e, k, at)}</div>`).join("")}
    </div>`;
  });
  return html;
}
/** The ◆ beside an automatable effect parameter (count of keys; lit on one at `at`). */
function fxKeyBtn(e, k, at) {
  const ks = e.keys?.[k] || [], n = ks.length;
  const on = at != null && ks.some((x) => Math.abs(x.t - at) < kfTimeEps());
  const title = at == null ? "Move the playhead over the clip to automate this"
    : on ? "Remove the key at the playhead" : "Set a key at the playhead";
  return `<button type="button" class="kf-btn fx-kf${n ? " has" : ""}${on ? " on" : ""}" data-fx-kf="${k}" title="${title}"${at == null ? " disabled" : ""}>◆${n || ""}</button>`;
}
/* Live effects editors, so automated sliders follow the playhead. */
const fxEditors = new Set();
let fxEditorsAt = NaN;
function syncFxEditors() {
  if (state.time === fxEditorsAt) return;
  fxEditorsAt = state.time;
  for (const ed of fxEditors) { if (ed.root.isConnected) ed.sync(); else fxEditors.delete(ed); }
}
function bindFxEditor(root, get, set, onStructure, timeOf = () => null) {
  const F = FableCutFx;
  const list = () => (get() || []).map((e) => ({ ...e }));
  const restructure = (next) => { set(next.length ? next : undefined); onStructure(); };
  const near = (x, at) => Math.abs(x.t - at) < kfTimeEps();
  /** Put v at time `at` on parameter k of effect i (replacing a key there). */
  const withKey = (e, k, at, v) => {
    const arr = (e.keys?.[k] || []).filter((x) => !near(x, at));
    arr.push({ t: Math.round(at * 1e4) / 1e4, v });
    arr.sort((a, b) => a.t - b.t);
    return { ...(e.keys || {}), [k]: arr };
  };
  fxEditors.add({ root, sync() {
    const at = timeOf(), cur = get() || [];
    for (const card of root.querySelectorAll(".fx-card")) {
      const e = cur[+card.dataset.fxI];
      if (!e) continue;
      const ev = at != null ? F.evalEffect(e, at) : e;
      for (const inp of card.querySelectorAll("[data-fx-p]")) {
        const k = inp.dataset.fxP, d = F.FX_DEFS[e.type].params[k];
        if (!e.keys?.[k] || document.activeElement === inp) continue;
        inp.value = fxToSlider(ev[k], d);
        inp.nextElementSibling.textContent = fxFmt(ev[k], d);
      }
      for (const btn of card.querySelectorAll("[data-fx-kf]")) {
        const tmp = document.createElement("span");
        tmp.innerHTML = fxKeyBtn(e, btn.dataset.fxKf, at);
        const fresh = tmp.firstElementChild;
        if (btn.className !== fresh.className || btn.textContent !== fresh.textContent || btn.disabled !== fresh.disabled) {
          btn.className = fresh.className; btn.textContent = fresh.textContent;
          btn.disabled = fresh.disabled; btn.title = fresh.title;
        }
      }
    }
  } });
  root.querySelector("[data-fx-preset]")?.addEventListener("change", (ev) => {
    if (ev.target.value) restructure(F.presetChain(ev.target.value));
  });
  root.querySelector("[data-fx-add]")?.addEventListener("change", (ev) => {
    if (ev.target.value) restructure([...list(), F.normalizeEffect({ type: ev.target.value })]);
  });
  root.querySelector("[data-fx-clear]")?.addEventListener("click", () => restructure([]));
  for (const card of root.querySelectorAll(".fx-card")) {
    const i = +card.dataset.fxI;
    card.querySelector("[data-fx-on]").addEventListener("change", (ev) => {
      const next = list();
      if (ev.target.checked) delete next[i].on; else next[i].on = false;
      restructure(next);
    });
    card.querySelector("[data-fx-del]").addEventListener("click", () => restructure(list().filter((_, j) => j !== i)));
    for (const b of card.querySelectorAll("[data-fx-move]")) b.addEventListener("click", () => {
      const next = list(), j = i + +b.dataset.fxMove;
      if (j < 0 || j >= next.length) return;
      [next[i], next[j]] = [next[j], next[i]];
      restructure(next);
    });
    for (const btn of card.querySelectorAll("[data-fx-kf]")) btn.addEventListener("click", () => {
      const at = timeOf();
      if (at == null) return;
      const next = list(), e = next[i], k = btn.dataset.fxKf;
      const here = (e.keys?.[k] || []).find((x) => near(x, at));
      let keys;
      if (here) {
        keys = { ...e.keys, [k]: e.keys[k].filter((x) => x !== here) };
        if (!keys[k].length) delete keys[k];
      } else keys = withKey(e, k, at, F.evalEffect(e, at)[k]);
      if (Object.keys(keys).length) e.keys = keys; else delete e.keys;
      restructure(next);
    });
    for (const inp of card.querySelectorAll("[data-fx-p]")) {
      const k = inp.dataset.fxP;
      const d = F.FX_DEFS[list()[i].type].params[k];
      const apply = (v) => {
        const next = list(), e = next[i];
        v = Math.round(v * 1000) / 1000;
        if (e.keys?.[k]?.length) { // automated: the slider edits the key at the playhead
          const at = timeOf();
          if (at == null) return;
          e.keys = withKey(e, k, at, v);
        } else e[k] = v;
        set(next);
        inp.nextElementSibling.textContent = fxFmt(v, d);
        const b = card.querySelector(`[data-fx-kf="${k}"]`);
        if (b && e.keys?.[k]) { b.classList.add("has", "on"); b.textContent = "◆" + e.keys[k].length; }
      };
      inp.addEventListener("input", () => apply(fxFromSlider(inp.value, d)));
      inp.addEventListener("dblclick", () => { inp.value = fxToSlider(d.def, d); apply(d.def); });
    }
  }
}
/** Mixer: the effects of one track (or the master), replacing the strips. */
function renderMixerFx(root, id) {
  const isMaster = id === MIXER_MASTER;
  const bus = busById(id);
  if (bus) return renderBusFx(root, bus);
  const t = TRACKS.find((x) => x.id === id);
  if (!isMaster && !t) { mixerState.fxTarget = null; renderMixer(); return; }
  root.innerHTML = `<div class="mixer-fx">
    <div class="mixer-fx-head"><button type="button" class="btn tiny" data-fx-back>← Mixer</button>
      <span>${isMaster ? "Master" : id} effects</span></div>
    <div class="mixer-fx-body">${fxEditorHtml(isMaster ? masterFx() : t.fx, state.time)}</div></div>`;
  root.querySelector("[data-fx-back]").addEventListener("click", () => { mixerState.fxTarget = null; renderMixer(); });
  bindFxEditor(root, () => isMaster ? masterFx() : t.fx, (fx) => {
    if (isMaster) project.master = normalizeMaster({ ...(project.master || {}), fx });
    else { if (fx?.length) t.fx = fx; else delete t.fx; project.tracks = serializeTracks(); }
    if (runtime.audio) applyMixLevels(runtime.audio, true);
    scheduleSave();
  }, () => renderMixer(), () => state.time);
}
function renderBusFx(root, bus) {
  const id = bus.id;
  root.innerHTML = `<div class="mixer-fx">
    <div class="mixer-fx-head"><button type="button" class="btn tiny" data-fx-back>← Mixer</button>
      <span>${escapeHtml(busLabel(bus))} effects</span></div>
    <div class="mixer-fx-body">${fxEditorHtml(bus.fx, state.time)}</div></div>`;
  root.querySelector("[data-fx-back]").addEventListener("click", () => { mixerState.fxTarget = null; renderMixer(); });
  bindFxEditor(root, () => busById(id)?.fx, (fx) => {
    const b = busById(id);
    if (!b) return;
    if (fx?.length) b.fx = fx; else delete b.fx;
    if (runtime.audio) applyMixLevels(runtime.audio, true);
    scheduleSave();
  }, () => renderMixer(), () => state.time);
}
function paintMixerBar(ctx, x, w, h, db, holdDb) {
  const frac = (v) => clamp((v - METER_DB_MIN) / (METER_DB_MAX - METER_DB_MIN), 0, 1);
  ctx.fillStyle = "#2a2a33";
  ctx.fillRect(x, 0, w, h);
  const f = frac(db);
  if (f > 0) {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, "#3dd68c"); g.addColorStop(0.6, "#3dd68c");
    g.addColorStop(0.75, "#f0c14a"); g.addColorStop(0.9, "#e5484d");
    ctx.fillStyle = g;
    ctx.fillRect(x, h * (1 - f), w, h * f);
  }
  const hf = frac(holdDb);
  if (hf > 0 && f > 0) {
    ctx.fillStyle = hf > 0.9 ? "#e5484d" : "#d7d7dc";
    ctx.fillRect(x, Math.max(0, h * (1 - hf) - 1), w, 2);
  }
}
function paintMixerMeters() {
  for (const [id, st] of Object.entries(mixerState.strips)) {
    if (!st.w || !st.h) continue;
    const { ctx, w, h } = st;
    ctx.clearRect(0, 0, w, h);
    if (st.master) {
      const m = meterState.master, half = (w - 2) / 2;
      paintMixerBar(ctx, 0, half, h, m.dispL, m.peakHoldL);
      paintMixerBar(ctx, half + 2, half, h, m.dispR, m.peakHoldR);
      const lufs = st.el.querySelector(".mix-lufs");
      const playing = state.playing || state.source.playing || state.audioHold;
      const txt = playing && m.lufs > -70 ? `${m.lufs.toFixed(1)} LUFS` : "— LUFS";
      if (lufs.textContent !== txt) lufs.textContent = txt;
    } else {
      paintMixerBar(ctx, 0, w, h, meterState.disp[id] ?? METER_DB_MIN, meterState.peakHold[id] ?? METER_DB_MIN);
    }
  }
}

/* ── Per-track meters: RMS / LUFS-M / Peak (AudioWorklet) ── */
const METER_SEGS = 20;
const METER_DB_MIN = -48;
const METER_DB_MAX = 0;
/** Scale tick marks shown beside the meter bars (dBFS). */
const METER_DB_MARKS = [0, -6, -12, -24, -36, -48];
function meterMarkTopPct(db) {
  return ((METER_DB_MAX - db) / (METER_DB_MAX - METER_DB_MIN)) * 100;
}
const METER_MODES = ["rms", "lufs", "peak"];
const METER_MODE_LABEL = { rms: "RMS", lufs: "LUFS", peak: "PEAK" };
/* Each channel's segment ladder is one <canvas>  - index 0 = bottom = quietest. */
const METER_SEG_W = 10, METER_SEG_H = 10, METER_SEG_GAP = 1;
const METER_COL_W = METER_SEG_W;
const METER_COL_H = METER_SEGS * METER_SEG_H + (METER_SEGS - 1) * METER_SEG_GAP;
function makeMeterCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = METER_COL_W + "px";
  cv.style.height = METER_COL_H + "px";
  cv.width = Math.round(METER_COL_W * dpr);
  cv.height = Math.round(METER_COL_H * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas: cv, ctx };
}
/** Paint the full 16-segment ladder for one channel in a single pass. `hold`
 * is the peak-hold tick's segment index (-1 = none). */
function paintMeterSegs(entry, lit, hold) {
  const ctx = entry.ctx;
  ctx.clearRect(0, 0, METER_COL_W, METER_COL_H);
  for (let i = 0; i < METER_SEGS; i++) {
    const y = METER_COL_H - (i + 1) * METER_SEG_H - i * METER_SEG_GAP;
    const on = i < lit || i === hold;
    const u = i / (METER_SEGS - 1);
    ctx.beginPath();
    ctx.roundRect(0, y, METER_SEG_W, METER_SEG_H, 1);
    if (on) {
      ctx.fillStyle = u < 0.6 ? "#3dd68c" : u < 0.85 ? "#f0c14a" : "#e5484d";
      ctx.fill();
    } else {
      ctx.fillStyle = "#2a2a33";
      ctx.fill();
      ctx.strokeStyle = "#0006"; ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
const MASTER_METER_L = "M:L";
const MASTER_METER_R = "M:R";
const MASTER_METER_IDS = [MASTER_METER_L, MASTER_METER_R];
function resetMasterMeterBallistics() {
  meterState.master.dispL = meterState.master.dispR = METER_DB_MIN;
  meterState.master.peakHoldL = meterState.master.peakHoldR = METER_DB_MIN;
  meterState.master.peakHoldTL = meterState.master.peakHoldTR = 0;
  meterState.master.lufs = -70;
  meterState.lastLit[MASTER_METER_L] = meterState.lastLit[MASTER_METER_R] = -1;
  meterState.lastHold[MASTER_METER_L] = meterState.lastHold[MASTER_METER_R] = -1;
}
/** Tap the post-meter stereo bus for true L/R master readings (matches headphones). */
function disposeMasterAnalysers(audio) {
  if (!audio?.masterSplit) return;
  try { audio.masterOut.disconnect(audio.masterSplit); } catch {}
  try { audio.masterSplit.disconnect(); } catch {}
  audio.masterSplit = null;
  audio.masterAnalysers = null;
}
/** Disconnect meter + analysers; the master fader feeds the speakers again.
 *  (Bus taps into the old meter are rewired by syncAudioGraphTracks.) */
function teardownMeterNode(audio) {
  if (!audio) return;
  disposeMasterAnalysers(audio);
  if (audio.meter) {
    try { audio.meter.port.onmessage = null; } catch {}
    try { audio.meter.disconnect(); } catch {}
  }
  try { audio.masterOut.disconnect(); } catch {}
  try { audio.masterOut.connect(audio.ctx.destination); } catch {}
  try { audio.masterOut.connect(audio.recDest); } catch {}
}
function installMasterAnalysers(audio, meterNode) {
  disposeMasterAnalysers(audio);
  const meter = meterNode || audio?.meter;
  if (!meter) return;
  const ctx = audio.ctx;
  const split = ctx.createChannelSplitter(2);
  const aL = ctx.createAnalyser();
  const aR = ctx.createAnalyser();
  const n = 2048;
  aL.fftSize = n;
  aR.fftSize = n;
  aL.smoothingTimeConstant = 0;
  aR.smoothingTimeConstant = 0;
  audio.masterOut.connect(split); // post-fader: the meter shows what leaves the mix
  split.connect(aL, 0);
  split.connect(aR, 1);
  audio.masterSplit = split;
  audio.masterAnalysers = { L: aL, R: aR, bufL: new Float32Array(n), bufR: new Float32Array(n) };
}
function sampleMasterAnalysers() {
  const a = runtime.audio?.masterAnalysers;
  if (!a) return;
  a.L.getFloatTimeDomainData(a.bufL);
  a.R.getFloatTimeDomainData(a.bufR);
  let sumL = 0, sumR = 0, pkL = 0, pkR = 0;
  const n = a.bufL.length;
  for (let i = 0; i < n; i++) {
    const l = a.bufL[i], r = a.bufR[i];
    sumL += l * l;
    sumR += r * r;
    const al = l >= 0 ? l : -l, ar = r >= 0 ? r : -r;
    if (al > pkL) pkL = al;
    if (ar > pkR) pkR = ar;
  }
  const inv = 1 / Math.max(1, n);
  meterState.master.rmsL = Math.sqrt(sumL * inv);
  meterState.master.rmsR = Math.sqrt(sumR * inv);
  meterState.master.peakL = pkL;
  meterState.master.peakR = pkR;
}
const meterState = {
  mode: (() => {
    try {
      const m = localStorage.getItem("fablecut-meter-mode");
      return METER_MODES.includes(m) ? m : "rms";
    } catch { return "rms"; }
  })(),
  trackIds: [],
  rms: {},
  peak: {},
  lufs: {},
  disp: {},
  peakHold: {},
  peakHoldT: {},
  segs: {},
  lastLit: {},   // id -> last-painted lit/hold seg indices, to skip redundant DOM writes
  lastHold: {},
  modeBtn: null,
  tracksToggleBtn: null,
  tracksExpanded: (() => {
    try { return localStorage.getItem("fablecut-meter-tracks-expanded") !== "0"; }
    catch { return true; }
  })(),
  master: { rmsL: 0, rmsR: 0, peakL: 0, peakR: 0, lufs: -70,
    dispL: METER_DB_MIN, dispR: METER_DB_MIN,
    peakHoldL: METER_DB_MIN, peakHoldR: METER_DB_MIN,
    peakHoldTL: 0, peakHoldTR: 0 },
};
function audioMeterTracks() {
  return TRACKS.filter((t) => t.kind === "audio");
}
function cycleMeterMode(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  const i = METER_MODES.indexOf(meterState.mode);
  meterState.mode = METER_MODES[(i + 1) % METER_MODES.length];
  try { localStorage.setItem("fablecut-meter-mode", meterState.mode); } catch {}
  if (meterState.modeBtn) meterState.modeBtn.textContent = METER_MODE_LABEL[meterState.mode];
  const root = $("vuMeter");
  if (root) root.title = `Mode: ${METER_MODE_LABEL[meterState.mode]} — click to switch`;
  // Reset ballistics so the bar doesn't linger from the previous scale reading
  for (const id of meterState.trackIds) {
    meterState.disp[id] = METER_DB_MIN;
    meterState.peakHold[id] = METER_DB_MIN;
    meterState.peakHoldT[id] = 0;
  }
  resetMasterMeterBallistics();
}
function syncMeterTracksExpandedUI() {
  const root = $("vuMeter");
  if (!root) return;
  root.classList.toggle("vu-tracks-open", meterState.tracksExpanded);
  const btn = meterState.tracksToggleBtn;
  if (btn) {
    btn.textContent = meterState.tracksExpanded ? "▸" : "◂";
    btn.title = meterState.tracksExpanded ? "Hide track meters" : "Show track meters";
    btn.setAttribute("aria-expanded", meterState.tracksExpanded ? "true" : "false");
  }
  if (meterState.tracksExpanded) {
    for (const id of meterState.trackIds) {
      meterState.lastLit[id] = -1;
      meterState.lastHold[id] = -1;
    }
  }
  fitVuMeter();
}
function toggleMeterTracksExpanded(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  meterState.tracksExpanded = !meterState.tracksExpanded;
  try { localStorage.setItem("fablecut-meter-tracks-expanded", meterState.tracksExpanded ? "1" : "0"); } catch {}
  syncMeterTracksExpandedUI();
}
async function installMeterWorklet(audio) {
  if (audio.meterReady || !audio.ctx.audioWorklet) return;
  if (meterState._loading) {
    meterState._reloadMeter = true; // sync tore down mid-install — retry in finally
    return;
  }
  meterState._loading = true;
  meterState._reloadMeter = false;
  const trackIds = audio.audioTrackIds.slice();
  const busIds = (audio.busIds || []).filter((id) => audio.subBus?.[id]);
  const meterIds = [...trackIds, ...busIds];
  const nAudio = meterIds.length;
  const nInputs = Math.max(1, nAudio + 1); // +1 = the finished program
  let meter = null;
  try {
    await audio.ctx.audioWorklet.addModule("meter-worklet.js?v=9");
    // Aborted by syncAudioGraphTracks while we were loading — retry fresh.
    if (meterState._reloadMeter) return;
    meter = new AudioWorkletNode(audio.ctx, "fablecut-meter", {
      numberOfInputs: nInputs,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      // The last input is the finished program (after master fx and fader):
      // it alone is passed through and measured for master loudness.
      processorOptions: { hopBlocks: 8, nTracks: nInputs, nAudioTracks: nAudio, trackIds: meterIds, programInput: nAudio },
    });
    meter.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.type !== "meter") return;
      for (let i = 0; i < nAudio; i++) {
        const id = meterIds[i];
        if (!id) continue;
        meterState.rms[id] = msg.rms[i] || 0;
        meterState.peak[id] = msg.peak[i] || 0;
        meterState.lufs[id] = msg.lufs[i] != null ? msg.lufs[i] : -70;
      }
      if (msg.masterLufs != null) meterState.master.lufs = msg.masterLufs;
    };

    // Connect the output first so a wiring error never leaves the graph silent.
    meter.connect(audio.ctx.destination);
    meter.connect(audio.recDest);

    // Each A-bus is tapped for its own meter (it keeps feeding the master sum);
    // the program after master fx + fader goes through the meter to the speakers.
    for (let i = 0; i < meterIds.length; i++) {
      const bus = audio.trackBus[meterIds[i]] || audio.subBus?.[meterIds[i]];
      if (bus) busOut(bus).connect(meter, 0, i);
    }
    try { audio.masterOut.disconnect(audio.ctx.destination); } catch {}
    try { audio.masterOut.disconnect(audio.recDest); } catch {}
    audio.masterOut.connect(meter, 0, nAudio);

    installMasterAnalysers(audio, meter);

    audio.meter = meter;
    meter = null; // ownership transferred — catch must not tear down live node
    audio.meterReady = true;
    meterState.trackIds = trackIds;
    meterState.busIds = busIds;
    for (const id of meterIds) {
      meterState.rms[id] = 0;
      meterState.peak[id] = 0;
      meterState.lufs[id] = -70;
      meterState.disp[id] = METER_DB_MIN;
      meterState.peakHold[id] = METER_DB_MIN;
      meterState.peakHoldT[id] = 0;
    }
    resetMasterMeterBallistics();
    buildMeterDOM();
  } catch (err) {
    console.warn("[FableCut] meter worklet unavailable:", err);
    if (meter) {
      try { meter.port.onmessage = null; } catch {}
      try { meter.disconnect(); } catch {}
    }
    // Drop any meter taps and send the master fader straight to the speakers.
    for (const id of trackIds) {
      const bus = audio.trackBus[id];
      if (!bus) continue;
      try { busOut(bus).disconnect(); } catch {}
      try { busOut(bus).connect(audio.master); } catch {}
    }
    try { audio.masterOut.disconnect(); } catch {}
    try { audio.masterOut.connect(audio.ctx.destination); } catch {}
    try { audio.masterOut.connect(audio.recDest); } catch {}
  } finally {
    meterState._loading = false;
    if (meterState._reloadMeter && !audio.meterReady) {
      meterState._reloadMeter = false;
      installMeterWorklet(audio).catch(() => {});
    }
  }
}
function buildMeterDOM() {
  const root = $("vuMeter");
  if (!root) return;
  const tracks = audioMeterTracks();
  root.innerHTML = "";
  root.classList.toggle("vu-tracks-open", meterState.tracksExpanded);

  const row = document.createElement("div");
  row.className = "vu-channels";

  const tracksWrap = document.createElement("div");
  tracksWrap.className = "vu-tracks-wrap";

  meterState.segs = {};
  meterState.lastLit = {};
  meterState.lastHold = {};
  meterState.trackIds = tracks.map((t) => t.id);

  for (const t of tracks) {
    if (meterState.disp[t.id] == null) {
      meterState.disp[t.id] = METER_DB_MIN;
      meterState.peakHold[t.id] = METER_DB_MIN;
      meterState.peakHoldT[t.id] = 0;
      meterState.rms[t.id] = 0;
      meterState.peak[t.id] = 0;
      meterState.lufs[t.id] = -70;
    }
    const col = document.createElement("div");
    col.className = "vu-channel";
    col.dataset.track = t.id;
    const segsCv = document.createElement("canvas");
    segsCv.className = "vu-segs";
    const entry = makeMeterCanvas(segsCv);
    meterState.segs[t.id] = entry;
    paintMeterSegs(entry, 0, -1); // start fully off
    const label = document.createElement("span");
    label.className = "vu-label";
    label.textContent = t.id;
    col.appendChild(segsCv);
    col.appendChild(label);
    tracksWrap.appendChild(col);
  }
  row.appendChild(tracksWrap);

  const scaleMaster = document.createElement("div");
  scaleMaster.className = "vu-scale-master";

  const scale = document.createElement("div");
  scale.className = "vu-scale";
  for (const db of METER_DB_MARKS) {
    const tick = document.createElement("span");
    tick.className = "vu-scale-tick";
    tick.textContent = db === 0 ? "0" : String(db);
    tick.style.top = meterMarkTopPct(db) + "%";
    scale.appendChild(tick);
  }

  const masterStack = document.createElement("div");
  masterStack.className = "vu-master-stack";

  if (tracks.length) {
    const tracksBtn = document.createElement("button");
    tracksBtn.type = "button";
    tracksBtn.className = "vu-tracks-toggle";
    tracksBtn.addEventListener("click", toggleMeterTracksExpanded);
    masterStack.appendChild(tracksBtn);
    meterState.tracksToggleBtn = tracksBtn;
  } else {
    meterState.tracksToggleBtn = null;
  }

  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "vu-mode";
  modeBtn.textContent = METER_MODE_LABEL[meterState.mode];
  modeBtn.title = "Cycle RMS → LUFS → Peak";
  modeBtn.addEventListener("click", cycleMeterMode);
  masterStack.appendChild(modeBtn);
  meterState.modeBtn = modeBtn;

  const masterWrap = document.createElement("div");
  masterWrap.className = "vu-master";
  for (const ch of ["L", "R"]) {
    const id = ch === "L" ? MASTER_METER_L : MASTER_METER_R;
    const col = document.createElement("div");
    col.className = "vu-channel vu-master-ch";
    col.dataset.track = id;
    const segsCv = document.createElement("canvas");
    segsCv.className = "vu-segs";
    const entry = makeMeterCanvas(segsCv);
    meterState.segs[id] = entry;
    paintMeterSegs(entry, 0, -1);
    const label = document.createElement("span");
    label.className = "vu-label";
    label.textContent = ch;
    col.appendChild(segsCv);
    col.appendChild(label);
    masterWrap.appendChild(col);
  }
  masterStack.appendChild(masterWrap);
  scaleMaster.appendChild(masterStack);
  scaleMaster.appendChild(scale);
  row.appendChild(scaleMaster);
  if (!tracks.length) masterStack.classList.add("vu-master-only");
  root.appendChild(row);
  syncMeterTracksExpandedUI();
}
let vuMeterScale = 1;
/** Fit the VU overlay to the stage with a compositor scale — no canvas resize. */
function fitVuMeter() {
  const meter = els.vuMeter;
  const stage = els.monitorStage;
  if (!meter || !stage) return;
  const naturalH = meter.offsetHeight;
  const naturalW = meter.offsetWidth;
  if (!naturalH || !naturalW) {
    if (vuMeterScale !== 1) {
      vuMeterScale = 1;
      meter.style.transform = "";
    }
    return;
  }
  const sx = (stage.clientWidth - 4) / naturalW;
  const sy = (stage.clientHeight - 12) / naturalH;
  const next = Math.max(0, Math.min(1, sx, sy));
  if (Math.abs(next - vuMeterScale) < 0.001) return;
  vuMeterScale = next;
  meter.style.transform = next >= 0.999 ? "" : "scale(" + next + ")";
}

function rmsToDb(rms) {
  return rms > 1e-8 ? 20 * Math.log10(rms) : METER_DB_MIN;
}
function meterReadingDb(id) {
  const mode = meterState.mode;
  if (id === MASTER_METER_L || id === MASTER_METER_R) {
    const m = meterState.master;
    const isL = id === MASTER_METER_L;
    if (mode === "peak") return rmsToDb(isL ? m.peakL : m.peakR);
    if (mode === "lufs") {
      // Master LUFS is a single program value; both L/R bars display it.
      const v = m.lufs;
      return v == null || v < METER_DB_MIN ? METER_DB_MIN : Math.min(METER_DB_MAX, v);
    }
    return rmsToDb(isL ? m.rmsL : m.rmsR);
  }
  if (mode === "peak") return rmsToDb(meterState.peak[id] || 0);
  if (mode === "lufs") {
    const v = meterState.lufs[id];
    return v == null || v < METER_DB_MIN ? METER_DB_MIN : Math.min(METER_DB_MAX, v);
  }
  return rmsToDb(meterState.rms[id] || 0);
}
function updateMeterChannel(id, target, dt, attack, release, now) {
  const floorEps = (METER_DB_MAX - METER_DB_MIN) / (METER_SEGS * 2);
  const curKey = id === MASTER_METER_L ? "dispL" : id === MASTER_METER_R ? "dispR" : null;
  const holdKey = id === MASTER_METER_L ? "peakHoldL" : id === MASTER_METER_R ? "peakHoldR" : null;
  const holdTKey = id === MASTER_METER_L ? "peakHoldTL" : id === MASTER_METER_R ? "peakHoldTR" : null;
  let cur, peakHold, peakHoldT;
  if (curKey) {
    cur = meterState.master[curKey] ?? METER_DB_MIN;
    peakHold = meterState.master[holdKey] ?? METER_DB_MIN;
    peakHoldT = meterState.master[holdTKey] || 0;
  } else {
    cur = meterState.disp[id] ?? METER_DB_MIN;
    peakHold = meterState.peakHold[id] ?? METER_DB_MIN;
    peakHoldT = meterState.peakHoldT[id] || 0;
  }
  const a = target > cur ? attack : release;
  let next = cur + (target - cur) * a;
  if (next <= METER_DB_MIN + floorEps) next = METER_DB_MIN;
  if (curKey) meterState.master[curKey] = next;
  else meterState.disp[id] = next;

  const pk = target;
  if (pk > peakHold) {
    peakHold = pk;
    peakHoldT = now;
    if (curKey) {
      meterState.master[holdKey] = pk;
      meterState.master[holdTKey] = now;
    } else {
      meterState.peakHold[id] = pk;
      meterState.peakHoldT[id] = now;
    }
  } else if (now - peakHoldT > 800) {
    peakHold += (METER_DB_MIN - peakHold) * release;
    if (peakHold <= METER_DB_MIN + floorEps) peakHold = METER_DB_MIN;
    if (curKey) meterState.master[holdKey] = peakHold;
    else meterState.peakHold[id] = peakHold;
  }

  const segs = meterState.segs[id];
  if (!segs) return;
  const isMaster = id === MASTER_METER_L || id === MASTER_METER_R;
  if (!isMaster && !meterState.tracksExpanded) return;
  const level = (next - METER_DB_MIN) / (METER_DB_MAX - METER_DB_MIN);
  const lit = next <= METER_DB_MIN ? 0 : Math.round(clamp(level, 0, 1) * METER_SEGS);
  const holdN = clamp((peakHold - METER_DB_MIN) / (METER_DB_MAX - METER_DB_MIN), 0, 1);
  let hold = holdN <= 0 ? -1 : Math.round(holdN * (METER_SEGS - 1));
  if (lit === 0) hold = -1;
  if (meterState.lastLit[id] === lit && meterState.lastHold[id] === hold) return;
  meterState.lastLit[id] = lit;
  meterState.lastHold[id] = hold;
  paintMeterSegs(segs, lit, hold);
}
function updateMeterUI(dt) {
  const metering = (state.playing || state.source.playing || state.audioHold) && runtime.audio?.meterReady;
  if (metering) sampleMasterAnalysers();
  const mode = meterState.mode;
  // Peak: snappy; LUFS already smoothed in-worklet (400 ms); RMS: classic VU feel
  const atkMs = mode === "peak" ? 0.005 : mode === "lufs" ? 0.04 : 0.015;
  const relMs = mode === "peak" ? 0.35 : mode === "lufs" ? 0.12 : 0.18;
  const attack = 1 - Math.exp(-dt / atkMs);
  const release = 1 - Math.exp(-dt / relMs);
  const now = performance.now();
  const floor = METER_DB_MIN;
  for (const id of [...meterState.trackIds, ...(meterState.busIds || []), ...MASTER_METER_IDS]) {
    const target = metering ? meterReadingDb(id) : floor;
    updateMeterChannel(id, target, dt, attack, release, now);
  }
  if (mixerState.open) paintMixerMeters();
}

function play() {
  if (state.audioHold) setAudioHold(false);
  if (state.playing) return;
  pauseSource();
  if (isSourceMode()) setMonitorMode("program");
  ensureAudio();
  runtime.audio.ctx.resume();
  if (playRate() < 0) {
    // reverse from where the playhead is — no wrap
  } else if (playLimited()) {
    const { start, end } = playRange();
    // Parked at OUT after a limited play → restart at IN. Playhead before IN or
    // past OUT is a manual override: leave it and play from there.
    if (state.time >= end - 0.01 && state.time <= end + 0.02) state.time = start;
  } else if (state.time >= projDur() - 0.01) {
    state.time = 0;
  }
  state.playing = true;
  syncPlayButton();
  syncMedia(); // start active seeks + cut lookahead without waiting a RAF
}
function pause() {
  if (state.audioHold) setAudioHold(false);
  state.playing = false;
  syncPlayButton();
  for (const el of runtime.clipEls.values()) { if (!el.paused) el.pause(); }
  if (state.exporting) finishExport(false);
}

/* ── Audio Hold: while paused, loop one project-frame of audio at the playhead ── */
let audioHoldGen = 0;
let audioHoldNodes = [];
let audioHoldRaf = 0;
function disposeAudioHoldNode(n) {
  if (!n) return;
  try { n.src.stop(); } catch { }
  try { n.src.disconnect(); } catch { }
  try { if (n.src) n.src.buffer = null; } catch { }
  if (n.gain) { try { n.gain.disconnect(); } catch { } }
  if (n.gains) { for (const g of n.gains) try { g.disconnect(); } catch { } }
  if (n.panner) { try { n.panner.disconnect(); } catch { } }
  if (n.panners) { for (const p of n.panners) try { p.disconnect(); } catch { } }
  if (n.split) { try { n.split.disconnect(); } catch { } }
  if (n.chain) disposeClipChain(n.chain);
}
function stopAudioHoldNodes() {
  audioHoldGen++;
  if (audioHoldRaf) { cancelAnimationFrame(audioHoldRaf); audioHoldRaf = 0; }
  for (const n of audioHoldNodes) disposeAudioHoldNode(n);
  audioHoldNodes = [];
}
/** An in-flight audio-hold build is stale once a newer refresh ran (`gen`),
 *  hold turned off, or the relevant transport (`playing`) started. */
function audioHoldStale(gen, playing) {
  return gen !== audioHoldGen || !state.audioHold || playing;
}
/** start() a hold voice, then keep it only if the build is still current —
 *  a newer refresh/stop or playback may have run while the graph was built. */
function commitAudioHoldNode(node, gen, playing) {
  try { node.src.start(0); } catch { disposeAudioHoldNode(node); return; }
  if (audioHoldStale(gen, playing)) { disposeAudioHoldNode(node); return; }
  audioHoldNodes.push(node);
}
function scheduleAudioHoldRefresh() {
  if (!state.audioHold || state.playing || state.source.playing) return;
  if (audioHoldRaf) return;
  audioHoldRaf = requestAnimationFrame(() => {
    audioHoldRaf = 0;
    refreshAudioHold();
  });
}
/** Copy one timeline-frame of samples from `buf` starting at `startSec`. */
function sliceAudioFrame(ctx, buf, startSec, durSec) {
  const sr = buf.sampleRate;
  const start = clamp(Math.floor(startSec * sr), 0, Math.max(0, buf.length - 1));
  const n = Math.max(1, Math.min(buf.length - start, Math.round(durSec * sr)));
  const out = ctx.createBuffer(buf.numberOfChannels, n, sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buf.getChannelData(ch).subarray(start, start + n));
  }
  return out;
}
function refreshAudioHold() {
  if (!state.audioHold || state.playing || state.source.playing || state.exporting || state.rendering) {
    stopAudioHoldNodes();
    return;
  }
  const audio = ensureAudio();
  try { audio.ctx.resume(); } catch { }
  const t = isSourceMode() ? state.source.time : state.time;
  const frameDur = 1 / projectFps();
  const gen = ++audioHoldGen;
  // Stop previous voices before starting the new slice
  for (const n of audioHoldNodes) disposeAudioHoldNode(n);
  audioHoldNodes = [];

  if (isSourceMode()) {
    if (runtime.sourceEl && !runtime.sourceEl.paused) runtime.sourceEl.pause();
    const m = sourceMedia();
    if (!m || (m.kind !== "audio" && m.kind !== "video")) return;
    getAudioBuffer(m).then((buf) => {
      if (audioHoldStale(gen, state.source.playing)) return;
      if (!(buf.duration > 0) || t >= buf.duration) return;
      const slice = sliceAudioFrame(audio.ctx, buf, t, frameDur);
      const src = audio.ctx.createBufferSource();
      src.buffer = slice;
      src.loop = true;
      const nCh = Math.max(buf.numberOfChannels, 2);
      const node = { src, split: null, gains: [], panners: [] };
      routeSourceChannels(audio.ctx, src, m, nCh, audio, (n, role) => {
        if (role === "splitter") node.split = n;
        else if (role === "gain") node.gains.push(n);
        else if (role === "panner") node.panners.push(n);
      });
      commitAudioHoldNode(node, gen, state.source.playing);
    }).catch(() => { });
    return;
  }

  // Keep media-element preview silent while holding (BufferSource owns the sound).
  for (const el of runtime.clipEls.values()) { if (!el.paused) el.pause(); }
  for (const chain of runtime.clipGain.values()) muteClipChain(chain);

  for (const c of project.clips) {
    if (c.kind !== "audio" && c.kind !== "video") continue;
    if (!clipRenders(c) || !activeAt(c, t)) continue;
    const m = getMedia(c.mediaId);
    if (!m || (m.kind !== "audio" && m.kind !== "video")) continue;
    const p = evalProps(c, t);
    const vol = clipAudioGain(p);
    if (vol <= 1e-4) continue; // skip muted picture track (linked stems carry the sound)
    getAudioBuffer(m).then((buf) => {
      if (audioHoldStale(gen, state.playing)) return;
      const mt = mediaTimeAt(c, t);
      if (!(buf.duration > 0) || mt >= buf.duration) return;
      // Slice exactly one frame — looping the whole short buffer (not loopStart on
      // the full file, which would play from 0 until the loop region first).
      const slice = sliceAudioFrame(audio.ctx, buf, mt, frameDur);
      const src = audio.ctx.createBufferSource();
      src.buffer = slice;
      src.loop = true;
      const chain = buildClipChain(audio.ctx, src, c, buf.numberOfChannels);
      driveClipChain(chain, c, p, t);
      chain.out.connect(audio.trackBus[c.track] || audio.master);
      commitAudioHoldNode({ src, chain }, gen, state.playing);
    }).catch(() => { });
  }
}
function setAudioHold(on) {
  on = !!on;
  if (on) {
    if (state.exporting || state.rendering) return;
    if (state.playing || state.source.playing) {
      // Pause without going through pause() (that would clear hold).
      state.playing = false;
      pauseSource();
      syncPlayButton();
      for (const el of runtime.clipEls.values()) { if (!el.paused) el.pause(); }
    }
    state.audioHold = true;
    if (els.btnAudioHold) els.btnAudioHold.classList.add("on");
    refreshAudioHold();
  } else {
    state.audioHold = false;
    if (els.btnAudioHold) els.btnAudioHold.classList.remove("on");
    stopAudioHoldNodes();
  }
}

/* ── Preview playback speed — affects the PREVIEW player only, never the export ── */
const PREVIEW_RATES = [1, 1.5, 2, 4];
// Effective preview rate: forced to 1 during any export so renders/captures stay real-time.
function playRate() { return state.exporting ? 1 : state.previewRate; }
// Negative = reverse (J). Reverse playback seeks frame by frame and is silent.
function setPreviewRate(r) {
  state.previewRate = r;
  els.btnSpeed.textContent = (r < 0 ? "◀" + -r : r) + "×";
  els.btnSpeed.classList.toggle("on", r !== 1);
}
function cyclePreviewRate(dir) { // wrap around — for the toolbar button
  const i = Math.max(0, PREVIEW_RATES.indexOf(state.previewRate));
  setPreviewRate(PREVIEW_RATES[(i + dir + PREVIEW_RATES.length) % PREVIEW_RATES.length]);
}
/* J / L shuttle step: another tap in the current direction speeds up
   (1 → 1.5 → 2 → 4×); the opposite key turns around at 1×. */
function shuttleRate(cur, dir, playing) {
  if (!playing || Math.sign(cur) !== dir || Math.abs(cur) < 1) return dir;
  const i = PREVIEW_RATES.indexOf(Math.abs(cur));
  return dir * PREVIEW_RATES[clamp(i < 0 ? 0 : i + 1, 0, PREVIEW_RATES.length - 1)];
}
const INCH_RATE = 0.25; // K held + J/L held: slow crawl
function transportPlaying() { return isSourceMode() ? state.source.playing : state.playing; }
function transportStop() { isSourceMode() ? pauseSource() : pause(); }
function transportStart() { isSourceMode() ? playSource() : play(); }
function shuttle(dir) {
  setPreviewRate(shuttleRate(state.previewRate, dir, transportPlaying()));
  if (!transportPlaying()) transportStart();
}

function activeAt(c, t) { return t >= c.start && t < clipEnd(c); }

/* Wall-clock seconds to pre-seek the next clip's In before a cut. Without this,
   syncMedia only seeks when the clip becomes active — HTMLVideoElement seek is
   async, so the first painted frame(s) of a hard cut often show media t≈0 (or a
   stale frame) until `seeked`. Frame-step hides it because pause seeks settle. */
const VIDEO_PREFETCH_SEC = 0.85;

function syncMedia() {
  const t = state.time;
  const rate = playRate();
  if (runtime.audio) animateMixFx(runtime.audio, t);
  // Reverse (J): media can't play backwards, so every clip is parked paused
  // and the one under the playhead is seeked frame by frame, like a scrub.
  const reversing = state.playing && rate < 0;
  // Timeline lookahead grows with preview rate so wall-clock budget stays ≈VIDEO_PREFETCH_SEC.
  const prefetchTl = VIDEO_PREFETCH_SEC * Math.max(rate, 1);
  for (const c of project.clips) {
    if (c.kind === "text" || c.kind === "image" || c.kind === "svg" || c.kind === "adjust") continue;
    const el = getClipEl(c); if (!el) continue;
    const enabled = clipRenders(c);
    const mt = mediaTimeAt(c, t);
    if (state.playing && !reversing && enabled && activeAt(c, t)) {
      // Only the active-under-playhead branch needs the full evaluated props
      // (speed/volume incl. keyframes+transitions) — skip that work for every
      // other clip on the timeline, which is the common case each frame.
      const p = evalProps(c, t);
      const sp = clamp(+p.speed || 1, 0.1, 8);
      const eff = clamp(sp * playRate(), 0.0625, 16); // preview speed rides on top of clip speed
      if (el.playbackRate !== eff) { try { el.playbackRate = eff; } catch {} }
      if (el.paused) el.play().catch(() => {});
      if (Math.abs(el.currentTime - mt) > 0.25 * eff) { try { el.currentTime = mt; } catch {} }
      const chain = runtime.clipGain.get(c.id);
      if (chain?.vol) driveClipChain(chain, c, p, t);
      else el.volume = clamp(clipAudioGain(p), 0, 1);
    } else {
      if (!el.paused) el.pause();
      muteClipChain(runtime.clipGain.get(c.id));
      // Paused preview: keep decode head on the frame under the playhead.
      // Needed when clips move/trim without setTime (drag does not scrub time).
      if ((!state.playing || reversing) && enabled && c.kind === "video" && activeAt(c, t) &&
          Math.abs(el.currentTime - mt) > 0.04 && !(reversing && el.seeking)) {
        try { el.currentTime = mt; } catch {}
      } else if (state.playing && !reversing && enabled && c.kind === "video") {
        // Approach a cut: park decode head on this clip's In so the first
        // drawn frame after activeAt flips is already the correct picture.
        const until = c.start - t;
        if (until > 0 && until <= prefetchTl && !el.seeking) {
          const inMt = mediaTimeAt(c, c.start);
          if (Math.abs(el.currentTime - inMt) > 0.04) {
            try { el.currentTime = inMt; } catch {}
          }
        }
      }
    }
  }
}
function seekMediaWhilePaused() {
  if (state.playing) return;
  const t = state.time;
  for (const c of project.clips) {
    if (c.kind !== "video") continue;
    if (!clipRenders(c)) continue;
    if (!activeAt(c, t)) continue;
    const el = getClipEl(c); if (!el) continue;
    const mt = mediaTimeAt(c, t);
    if (Math.abs(el.currentTime - mt) > 0.04) { try { el.currentTime = mt; } catch { } }
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
  // c.props is always fully populated with DEFAULT_PROPS's keys already (on
  // load and at every clip-creation site), so a plain shallow clone suffices —
  // merging DEFAULT_PROPS in again here would just double the copy work.
  const p = { ...c.props };
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
  if (tin && tin.duration > 0 && local < tin.duration) {
    const u = clamp(local / tin.duration, 0, 1);
    applyTransition(p, tin.type, 1 - EASE["ease-out"](u), W, H, -1, audioFadeGain(tin.curve, u));
  }
  if (tout && tout.duration > 0 && local > c.duration - tout.duration) {
    const u = clamp((local - (c.duration - tout.duration)) / tout.duration, 0, 1);
    applyTransition(p, tout.type, EASE["ease-in"](u), W, H, 1, audioFadeGain(tout.curve, 1 - u));
  }
  return p;
}
/* Audio fade shapes. `u` runs 0 (silent edge) → 1 (full level). A fade with
   no `curve` keeps the original eased shape (applyTransition's 1 − k), so
   older projects sound the same. Two "power" fades crossing sum to constant
   power (cos² + sin² = 1): no dip in the middle of a crossfade. */
const AUDIO_FADE_CURVES = { power: "Constant power", linear: "Constant gain", exp: "Exponential" };
function audioFadeGain(curve, u) {
  u = clamp(u, 0, 1);
  if (curve === "power") return Math.sin(u * Math.PI / 2);
  if (curve === "linear") return u;
  if (curve === "exp") return (Math.pow(10, 2 * u) - 1) / 99; // slow start, smooth into full
  return null;
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
/* k: 0 = fully visible … 1 = fully transitioned away; dir: -1 = in, +1 = out.
   audioG: the fade's own audio gain when it has a `curve` (else 1 − k). */
function applyTransition(p, type, k, W, H, dir, audioG = null) {
  if (!(k > 0)) return;
  switch (type) {
    case "fade": case "dissolve":
      p.opacity *= 1 - k; p.volume *= audioG ?? 1 - k; break;
    case "slide-left": p.x = (+p.x || 0) - dir * k * W; break;
    case "slide-right": p.x = (+p.x || 0) + dir * k * W; break;
    case "slide-up": p.y = (+p.y || 0) - dir * k * H; break;
    case "slide-down": p.y = (+p.y || 0) + dir * k * H; break;
    case "zoom":
      p.scale = (+p.scale || 1) * (1 - 0.6 * k); p.opacity *= 1 - k; break;
    case "wipe": case "wipe-left": p._wipe = k; p._wipeDir = "left"; break;
    case "wipe-right": p._wipe = k; p._wipeDir = "right"; break;
    case "wipe-up": p._wipe = k; p._wipeDir = "up"; break;
    case "wipe-down": p._wipe = k; p._wipeDir = "down"; break;
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
/* Translation the in/out transition envelopes add on top of the keyframed
   props at timeline time t — probed through applyTransition itself, so it can
   never disagree with the compositor. Canvas box drags write resting
   (envelope-free) geometry, so displayed-space results must have this
   subtracted back out. */
function transOffsetAt(c, t) {
  const p = { x: 0, y: 0, scale: 1, opacity: 1, volume: 1, rotation: 0, blur: 0, rgbSplit: 0 };
  const local = t - c.start, W = els.preview.width, H = els.preview.height;
  const tin = c.transitionIn, tout = c.transitionOut;
  if (tin && tin.duration > 0 && local < tin.duration)
    applyTransition(p, tin.type, 1 - EASE["ease-out"](clamp(local / tin.duration, 0, 1)), W, H, -1);
  if (tout && tout.duration > 0 && local > c.duration - tout.duration)
    applyTransition(p, tout.type,
      EASE["ease-in"](clamp((local - (c.duration - tout.duration)) / tout.duration, 0, 1)), W, H, 1);
  return { x: +p.x || 0, y: +p.y || 0 };
}
/* Rebase clip-local keyframe times by -offset, dropping ones outside [0, dur] */
const shiftKF = FableCutEdit.shiftKF;

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
  if (!aux.svgAnimated) aux.img = await rasterizeSvgMarkup(txt);
  state.dirtyTimeline = true;
}
function svgMarkupAt(aux, t) {
  if (!aux.svgAnimated) return aux.svgText;
  const style = `<style>*{animation-play-state:paused!important;` +
    `animation-delay:calc(var(--d,0s) - ${t.toFixed(4)}s)!important}</style>`;
  return aux.svgText.replace(/(<svg[^>]*>)/i, `$1${style}`);
}
function closeSvgFrame(img) {
  if (img && typeof img.close === "function") try { img.close(); } catch { }
}
function pruneSvgFrames(aux) {
  if (!aux.svgFrames || aux.svgFrames.size <= 90) return;
  const k = aux.svgFrames.keys().next().value;
  closeSvgFrame(aux.svgFrames.get(k));
  aux.svgFrames.delete(k);
}
/** Rasterize SVG markup without tainting the compositor canvas.
 *  data: URLs (and <img src="*.svg"> in some browsers) mark the bitmap dirty
 *  so toBlob throws. A same-origin blob + createImageBitmap stays origin-clean. */
async function rasterizeSvgMarkup(markup) {
  const blob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      if (bmp.width && bmp.height) return bmp;
      try { bmp.close(); } catch { }
    } catch { /* Safari / empty SVG bitmaps */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("svg raster failed")); };
    img.src = url;
  });
}
function renderSvgFrame(aux, t) {
  return rasterizeSvgMarkup(svgMarkupAt(aux, t));
}
/* Preview path: returns the best already-rasterized frame and schedules the
   exact one; export path awaits prepareSvgFrame() instead. */
function getSvgImage(c, t) {
  const aux = runtime.mediaAux.get(c.mediaId);
  if (!aux || !aux.svgText) return null;
  if (!aux.svgAnimated) return aux.img || null;
  const local = Math.max(0, mediaTimeAt(c, t));
  const q = Math.round(local * projectFps()) / projectFps();
  const hit = aux.svgFrames.get(q);
  if (hit) return hit;
  if (!aux.svgPending) {
    aux.svgPending = renderSvgFrame(aux, q).then((img) => {
      aux.svgFrames.set(q, img);
      pruneSvgFrames(aux);
      aux.lastImg = img;
    }).catch(() => { }).finally(() => { aux.svgPending = null; });
  }
  return aux.lastImg || null; // may be one frame stale during preview
}
async function prepareSvgFrame(c, t) {
  const aux = runtime.mediaAux.get(c.mediaId);
  if (!aux) return;
  if (!aux.svgText) { try { await loadSvgMedia(getMedia(c.mediaId)); } catch { return; } }
  if (!aux.svgAnimated) return;
  const local = Math.max(0, mediaTimeAt(c, t));
  const q = Math.round(local * projectFps()) / projectFps();
  if (aux.svgFrames.get(q)) return;
  try {
    const img = await renderSvgFrame(aux, q);
    aux.svgFrames.set(q, img);
    pruneSvgFrames(aux);
    aux.lastImg = img;
  } catch { }
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
    try { await bgSeg.seg.send({ image: el }); } catch { }
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
  const off = (Math.floor(t * projectFps()) * 7919) % 256;
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
/** Active, enabled clips across enabled video tracks at time `t`, in compositing order
 * (bottom-to-top: V1 first, then V2, V3), each track's clips sorted by
 * `start`. Shared by drawFrame (renders it as-is) and pickClipAt (hit-tests
 * it top-down, filtered to visual clips only). */
function visibleClipsAt(t) {
  const out = [];
  const videoTracks = TRACKS.filter((tr) => tr.kind === "video" && isTrackEnabled(tr.id)).reverse();
  for (const tr of videoTracks) {
    out.push(...project.clips
      .filter((c) => c.track === tr.id && c.disabled !== true && activeAt(c, t))
      .sort((a, b) => a.start - b.start));
  }
  return out;
}
function drawFrame(t = state.time) {
  const W = els.preview.width, H = els.preview.height;
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.filter = "none"; ctx2d.globalAlpha = 1;
  ctx2d.fillStyle = project.background || "#000"; ctx2d.fillRect(0, 0, W, H);
  // render video tracks bottom-up (V1 under V2)
  for (const c of visibleClipsAt(t)) drawClip(c, W, H, t);
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
    if (hasTextBox(p)) {
      hw = +p.boxW / 2; hh = +p.boxH / 2;
    } else {
      const half = measureTextHalfSize(p);
      hw = half.hw; hh = half.hh;
    }
  } else {                       // media/svg: canvas-sized base box, scaled
    hw = (W / 2) * sc; hh = (H / 2) * sc;
  }
  return { cx, cy, hw, hh, rot };
}
function isVisualClip(c) { return c && c.kind !== "adjust" && c.kind !== "audio"; }
/* Screen-space handle positions for the selection overlay. Each handle is
   clamped into the visible canvas (inset by its own size) so it stays visible
   and grabbable when the clip's box extends past the frame. Drawing and
   hit-testing both use these, so they can never disagree. */
function overlayHandles(b, W, H) {
  const cs = Math.cos(b.rot), sn = Math.sin(b.rot);
  const toScreen = (lx, ly) => ({ x: b.cx + lx * cs - ly * sn, y: b.cy + lx * sn + ly * cs });
  const hs = Math.max(6, W / 150), gap = Math.max(24, W / 34), m = hs * 1.4;
  const cl = (p) => ({ x: clamp(p.x, m, W - m), y: clamp(p.y, m, H - m) });
  return {
    hs,
    corners: [[-b.hw, -b.hh], [b.hw, -b.hh], [b.hw, b.hh], [-b.hw, b.hh]].map(([x, y]) => cl(toScreen(x, y))),
    topMid: cl(toScreen(0, -b.hh)),
    rotate: cl(toScreen(0, -b.hh - gap)),
  };
}
function drawSelectionOverlay(W, H, t) {
  const c = getClip(state.selId);
  if (!isVisualClip(c) || !activeAt(c, t) || !clipRenders(c)) return;
  const b = clipBounds(c, evalProps(c, t), W, H);
  const lw = Math.max(2, W / 640);
  const hd = overlayHandles(b, W, H), hs = hd.hs;
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.save();
  ctx2d.lineWidth = lw; ctx2d.strokeStyle = "#4f8cff";
  ctx2d.save();
  ctx2d.translate(b.cx, b.cy); ctx2d.rotate(b.rot);
  ctx2d.setLineDash([lw * 4, lw * 3]);
  ctx2d.strokeRect(-b.hw, -b.hh, b.hw * 2, b.hh * 2);
  ctx2d.restore();
  ctx2d.setLineDash([]);
  ctx2d.beginPath(); ctx2d.moveTo(hd.topMid.x, hd.topMid.y); ctx2d.lineTo(hd.rotate.x, hd.rotate.y); ctx2d.stroke();
  ctx2d.fillStyle = "#ffffff";
  for (const h of hd.corners) {
    ctx2d.beginPath(); ctx2d.rect(h.x - hs, h.y - hs, hs * 2, hs * 2); ctx2d.fill(); ctx2d.stroke();
  }
  ctx2d.beginPath(); ctx2d.arc(hd.rotate.x, hd.rotate.y, hs * 1.1, 0, Math.PI * 2);
  ctx2d.fillStyle = "#ffce5c"; ctx2d.fill(); ctx2d.stroke();
  ctx2d.restore();
}
function canvasPt(e) {
  const r = els.preview.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (els.preview.width / r.width),
    y: (e.clientY - r.top) * (els.preview.height / r.height)
  };
}
function toLocal(pt, b) {
  const dx = pt.x - b.cx, dy = pt.y - b.cy, cs = Math.cos(-b.rot), sn = Math.sin(-b.rot);
  return { x: dx * cs - dy * sn, y: dx * sn + dy * cs };
}
function pickClipAt(pt, W, H) {
  const seq = visibleClipsAt(state.time).filter(isVisualClip);
  for (let i = seq.length - 1; i >= 0; i--) {
    const c = seq[i], b = clipBounds(c, evalProps(c, state.time), W, H), lp = toLocal(pt, b);
    if (Math.abs(lp.x) <= b.hw && Math.abs(lp.y) <= b.hh) return c;
  }
  return null;
}
let canvasDrag = null, canvasDidMove = false;
els.preview.style.touchAction = "none";
els.preview.addEventListener("pointerdown", (e) => {
  if (e.altKey || e.button === 1) return; // leave to monitor pan
  // Source mode: drag on the frame scrubs media time (no clip transforms)
  if (isSourceMode()) {
    if (!state.source.mediaId) return;
    e.preventDefault();
    pauseSource();
    const r = els.preview.getBoundingClientRect();
    const scrub = (ev) => {
      const u = clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
      setSourceTime(u * sourceDur());
    };
    scrub(e);
    const onMove = (ev) => scrub(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return;
  }
  const W = els.preview.width, H = els.preview.height, pt = canvasPt(e);
  const cur = getClip(state.selId);
  canvasDrag = null;
  if (isVisualClip(cur) && activeAt(cur, state.time)) {
    const b = clipBounds(cur, evalProps(cur, state.time), W, H), lp = toLocal(pt, b);
    const hd = overlayHandles(b, W, H), grab = hd.hs * 1.8;
    if (Math.hypot(pt.x - hd.rotate.x, pt.y - hd.rotate.y) <= grab) {
      const ep = propsAtPlayhead(cur);
      canvasDrag = { mode: "rotate", id: cur.id, startRot: +ep.rotation || 0, startAng: Math.atan2(pt.y - b.cy, pt.x - b.cx), cx: b.cx, cy: b.cy };
    } else if (hd.corners.some((h) => Math.abs(pt.x - h.x) <= grab && Math.abs(pt.y - h.y) <= grab)) {
      if (cur.kind === "text") {
        canvasDrag = {
          ...beginTextBoxDrag(cur, pt, W, H),
          seedBox: !hasTextBox(cur.props),
          startClient: { x: e.clientX, y: e.clientY },
        };
      } else {
        canvasDrag = { mode: "scale", id: cur.id, startScale: +(propsAtPlayhead(cur).scale) || 1, startDist: Math.hypot(lp.x, lp.y) || 1 };
      }
    } else if (Math.abs(lp.x) <= b.hw && Math.abs(lp.y) <= b.hh) {
      const ep = propsAtPlayhead(cur);
      canvasDrag = { mode: "move", id: cur.id, startX: +ep.x || 0, startY: +ep.y || 0, startPt: pt };
    }
  }
  if (!canvasDrag) {
    const hit = pickClipAt(pt, W, H);
    if (!hit) return;
    if (hit.id !== state.selId) { selectClip(hit.id); renderInspector(); }
    const ep = propsAtPlayhead(hit);
    canvasDrag = { mode: "move", id: hit.id, startX: +ep.x || 0, startY: +ep.y || 0, startPt: pt };
  }
  if (isGroupLocked(getClip(canvasDrag.id))) { canvasDrag = null; toastLocked(); return; }
  canvasDidMove = false;
  if (canvasDrag.mode === "move") els.preview.style.cursor = "move";
  else if (canvasDrag.mode === "rotate") els.preview.style.cursor = ROTATE_CURSOR;
  els.preview.setPointerCapture(e.pointerId);
  e.preventDefault();
});
/* ── Hover cursor feedback: rotate knob → rotate cursor, corner handles →
   directional resize arrows (by the handle's on-screen angle, so rotation-
   aware), clip body → move, other pickable clip → pointer. ── */
const ROTATE_CURSOR = (() => {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'>" +
    "<path d='M10 3a7 7 0 1 1-6.7 9' fill='none' stroke='black' stroke-width='4.5' stroke-linecap='round'/>" +
    "<path d='M10 3a7 7 0 1 1-6.7 9' fill='none' stroke='white' stroke-width='2' stroke-linecap='round'/>" +
    "<path d='M10.5 0.5L14.5 3L10.5 5.5Z' fill='white' stroke='black'/></svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, crosshair`;
})();
function cursorForHandleAngle(deg) {
  const i = ((Math.round(deg / 45) % 4) + 4) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][i];
}
function updateCanvasCursor(e) {
  if (isSourceMode()) {
    els.preview.style.cursor = state.source.mediaId ? "ew-resize" : "default";
    return;
  }
  const W = els.preview.width, H = els.preview.height, pt = canvasPt(e);
  const cur = getClip(state.selId);
  let cursor = "default";
  if (isVisualClip(cur) && activeAt(cur, state.time) && !state.playing && !state.exporting) {
    const b = clipBounds(cur, evalProps(cur, state.time), W, H);
    const hd = overlayHandles(b, W, H), grab = hd.hs * 1.8;
    const corner = hd.corners.find((h) => Math.abs(pt.x - h.x) <= grab && Math.abs(pt.y - h.y) <= grab);
    const lp = toLocal(pt, b);
    if (Math.hypot(pt.x - hd.rotate.x, pt.y - hd.rotate.y) <= grab) cursor = ROTATE_CURSOR;
    else if (corner) cursor = cursorForHandleAngle(Math.atan2(corner.y - b.cy, corner.x - b.cx) * 180 / Math.PI);
    else if (Math.abs(lp.x) <= b.hw && Math.abs(lp.y) <= b.hh) cursor = "move";
    else if (pickClipAt(pt, W, H)) cursor = "pointer";
  } else if (pickClipAt(pt, W, H)) cursor = "pointer";
  els.preview.style.cursor = cursor;
}
els.preview.addEventListener("pointermove", (e) => {
  if (!canvasDrag) { updateCanvasCursor(e); return; }
  const c = getClip(canvasDrag.id); if (!c) return;
  const W = els.preview.width, H = els.preview.height, pt = canvasPt(e);
  // Hug-content titles: don't seed a box until the pointer actually moves
  // (same ~3px deadzone as clip drags), so a click-release is a no-op.
  if (canvasDrag.seedBox && !canvasDidMove) {
    const s = canvasDrag.startClient;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 3) return;
  }
  if (!canvasDidMove) {
    pushUndo(); // snapshot includes hug-content, before any box seed
    canvasDidMove = true;
    if (canvasDrag.seedBox) {
      ensureTextBox(c);
      Object.assign(canvasDrag, beginTextBoxDrag(c, pt, W, H), { seedBox: false });
    }
  }
  if (canvasDrag.mode === "move") {
    setAnimProp(c, "x", Math.round(canvasDrag.startX + (pt.x - canvasDrag.startPt.x)));
    setAnimProp(c, "y", Math.round(canvasDrag.startY + (pt.y - canvasDrag.startPt.y)));
  } else if (canvasDrag.mode === "box") {
    const aspect = canvasDrag.aspect || 1;
    const lockAR = e.shiftKey;
    // The displayed box is the resting box plus the transition envelope; the
    // writes below target the resting geometry, so strip the envelope's
    // translation back out (boxed text ignores scale, and the center midpoint
    // is rotation-invariant — translation is the only component that leaks).
    const env = transOffsetAt(c, state.time);
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd: resize from center (all corners move).
      const b = clipBounds(c, evalProps(c, state.time), W, H), lp = toLocal(pt, b);
      let bw = Math.abs(lp.x) * 2, bh = Math.abs(lp.y) * 2;
      if (lockAR) {
        if (bw / aspect >= bh) bh = bw / aspect;
        else bw = bh * aspect;
      }
      c.props.boxW = +clamp(bw, 20, W * 3).toFixed(1);
      c.props.boxH = +clamp(bh, 16, H * 3).toFixed(1);
    } else {
      // Default: opposite corner stays fixed; dragged corner follows the pointer.
      const fix = canvasDrag.fix, rot = canvasDrag.rot;
      let dx = pt.x - fix.x, dy = pt.y - fix.y;
      const cs = Math.cos(-rot), sn = Math.sin(-rot);
      let ldx = dx * cs - dy * sn, ldy = dx * sn + dy * cs;
      if (lockAR) {
        const aw = Math.abs(ldx), ah = Math.abs(ldy);
        if (aw / aspect >= ah) {
          ldy = (Math.sign(ldy) || canvasDrag.dragSY) * (aw / aspect);
        } else {
          ldx = (Math.sign(ldx) || canvasDrag.dragSX) * (ah * aspect);
        }
      }
      const minW = 20, minH = 16;
      if (Math.abs(ldx) < minW) ldx = (Math.sign(ldx) || canvasDrag.dragSX) * minW;
      if (Math.abs(ldy) < minH) ldy = (Math.sign(ldy) || canvasDrag.dragSY) * minH;
      if (lockAR) {
        // Re-sync after min clamp so aspect stays locked.
        if (Math.abs(ldx) / aspect >= Math.abs(ldy)) {
          ldy = (Math.sign(ldy) || canvasDrag.dragSY) * (Math.abs(ldx) / aspect);
        } else {
          ldx = (Math.sign(ldx) || canvasDrag.dragSX) * (Math.abs(ldy) * aspect);
        }
      }
      ldx = clamp(ldx, -W * 3, W * 3);
      ldy = clamp(ldy, -H * 3, H * 3);
      const c2 = Math.cos(rot), s2 = Math.sin(rot);
      const freeX = fix.x + ldx * c2 - ldy * s2;
      const freeY = fix.y + ldx * s2 + ldy * c2;
      setAnimProp(c, "x", Math.round((fix.x + freeX) / 2 - W / 2 - env.x));
      setAnimProp(c, "y", Math.round((fix.y + freeY) / 2 - H / 2 - env.y));
      c.props.boxW = +Math.abs(ldx).toFixed(1);
      c.props.boxH = +Math.abs(ldy).toFixed(1);
    }
  } else if (canvasDrag.mode === "scale") {
    const b = clipBounds(c, evalProps(c, state.time), W, H), lp = toLocal(pt, b);
    setAnimProp(c, "scale", clamp(+(canvasDrag.startScale * (Math.hypot(lp.x, lp.y) / canvasDrag.startDist)).toFixed(3), 0.05, 12));
  } else {
    const cx = canvasDrag.cx, cy = canvasDrag.cy;
    let deg = canvasDrag.startRot + (Math.atan2(pt.y - cy, pt.x - cx) - canvasDrag.startAng) * 180 / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    setAnimProp(c, "rotation", Math.round(deg));
  }
});
function endCanvasDrag(e) {
  if (!canvasDrag) return;
  canvasDrag = null;
  try { els.preview.releasePointerCapture(e.pointerId); } catch { }
  if (canvasDidMove) { scheduleSave(); renderInspector(); } // no-op on a pure click
  updateCanvasCursor(e); // re-derive hover cursor at the release point
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
    if (p._wipeDir === "right") ctx2d.rect(W * k, 0, W * (1 - k), H);
    else if (p._wipeDir === "up") ctx2d.rect(0, 0, W, H * (1 - k));
    else if (p._wipeDir === "down") ctx2d.rect(0, H * k, W, H * (1 - k));
    else ctx2d.rect(0, 0, W * (1 - k), H);
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
    if (p.fit === "cover") { const f = Math.max(W / cw, H / ch) * sc; dw = cw * f; dh = ch * f; }
    else if (p.fit === "stretch") { dw = W * sc; dh = H * sc; }
    else if (p.fit === "none") { dw = cw * sc; dh = ch * sc; }
    else { const f = Math.min(W / cw, H / ch) * sc; dw = cw * f; dh = ch * f; }
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

/* ── Text direction (LTR / RTL) — per-line when direction is "auto".
   Auto-detect uses a DOM probe + getComputedStyle; cache by line text so
   preview/export frames don't re-resolve style every tick. ── */
let _textDirProbe;
const _textDirCache = new Map(); // line text → "ltr" | "rtl"
const TEXT_DIR_CACHE_MAX = 256;
function detectTextDirection(text) {
  const key = (text && String(text).trim()) ? String(text) : " ";
  const hit = _textDirCache.get(key);
  if (hit) return hit;
  if (!_textDirProbe) {
    _textDirProbe = document.createElement("p");
    _textDirProbe.style.cssText = "position:fixed;left:-9999px;visibility:hidden;white-space:nowrap";
    document.body.appendChild(_textDirProbe);
  }
  _textDirProbe.dir = "auto";
  _textDirProbe.textContent = key;
  const dir = getComputedStyle(_textDirProbe).direction === "rtl" ? "rtl" : "ltr";
  if (_textDirCache.size >= TEXT_DIR_CACHE_MAX) _textDirCache.clear();
  _textDirCache.set(key, dir);
  return dir;
}
function lineDirections(p, lines) {
  if (p.direction === "rtl" || p.direction === "ltr") {
    const forced = p.direction;
    return lines.map(() => forced);
  }
  return lines.map((ln) => detectTextDirection(ln));
}
function revealWipeRect(cx, w, lh, y, e, rtl, pad = 6) {
  const clipW = (w + pad * 2) * e;
  const x0 = rtl ? cx + w / 2 + pad - clipW : cx - w / 2 - pad;
  ctx2d.rect(x0, y - lh / 2, clipW, lh);
}
function typewriterX(cx, fullW, shownW, rtl) {
  const dx = (fullW - shownW) / 2;
  return rtl ? cx + dx : cx - dx;
}
function runOrigin(cx, totalW, rtl) {
  return rtl ? cx + totalW / 2 : cx - totalW / 2;
}
// Arabic/Indic letters change shape when drawn in isolation — letter-pop/wave must
// paint shaped clusters (whole words), not individual code points.
const SHAPING_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;
function needsContextualShaping(text) {
  return SHAPING_SCRIPT_RE.test(text);
}
let _graphemeSeg;
const _graphemeCache = new Map(); // line text → string[]
const _letterAnimCache = new Map(); // line text → {text, animate}[]
const TEXT_SEG_CACHE_MAX = 256;
function graphemeSegments(text) {
  const key = String(text ?? "");
  const hit = _graphemeCache.get(key);
  if (hit) return hit;
  let segs;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    if (!_graphemeSeg) _graphemeSeg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    segs = [..._graphemeSeg.segment(key)].map((s) => s.segment);
  } else {
    segs = [...key];
  }
  if (_graphemeCache.size >= TEXT_SEG_CACHE_MAX) _graphemeCache.clear();
  _graphemeCache.set(key, segs);
  return segs;
}
function letterAnimSegments(line) {
  const key = String(line ?? "");
  const hit = _letterAnimCache.get(key);
  if (hit) return hit;
  let segs;
  if (needsContextualShaping(key)) {
    segs = [];
    const re = /(\s+|[^\s]+)/g;
    let m;
    while ((m = re.exec(key))) segs.push({ text: m[0], animate: !!m[0].trim() });
  } else {
    segs = graphemeSegments(key).map((text) => ({ text, animate: !!text.trim() }));
  }
  if (_letterAnimCache.size >= TEXT_SEG_CACHE_MAX) _letterAnimCache.clear();
  _letterAnimCache.set(key, segs);
  return segs;
}

/* ── Text rendering: styling (stroke / background pill) + kinetic animations.
   `local` is clip-local time in seconds. Word timing: word i enters at
   i * wordRate; each entrance animation lasts ~0.25 s. ── */
const backOut = (u) => { const c1 = 1.70158, c3 = c1 + 1; const v = u - 1; return 1 + c3 * v * v * v + c1 * v * v; };
function hexToRgba(hex, a) {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function hasTextBox(p) { return +p.boxW > 0 && +p.boxH > 0; }
/* Target width for justify: text box width when set, else max(natural, ~85% canvas). */
function textJustifyTarget(p, naturalBlockW) {
  if (+p.boxW > 0) return +p.boxW;
  const sc = Math.max(0.001, +p.scale || 1);
  return Math.max(naturalBlockW, project.width / sc * 0.85);
}
/* Expand a line to ≈ targetW by inserting whole spaces between words. */
function justifyLineBySpaces(ctx, ln, targetW) {
  const words = String(ln).split(/\s+/).filter(Boolean);
  if (words.length < 2) return ln;
  const natural = words.join(" ");
  if (ctx.measureText(natural).width >= targetW - 0.5) return natural;
  let lo = 1, hi = 2, best = natural;
  while (hi < 160 && ctx.measureText(words.join(" ".repeat(hi))).width < targetW) hi *= 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = words.join(" ".repeat(mid));
    if (ctx.measureText(s).width <= targetW) { best = s; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}
function textFontWeight(p) {
  return +p.weight || (p.bold ? 700 : 400);
}
function setTextFont(ctx, p, size) {
  const weight = textFontWeight(p);
  ctx.font = `${p.italic ? "italic " : ""}${weight} ${size}px "${p.font || "Segoe UI"}", sans-serif`;
  try { ctx.letterSpacing = `${+p.letterSpacing || 0}px`; } catch { }
}
function textSourceString(p) {
  let t = String(p.text || "");
  if (p.uppercase) t = t.split("\n").map((l) => l.toUpperCase()).join("\n");
  return t;
}
/* Word-wrap paragraphs to maxW (hard newlines preserved as paragraph breaks). */
function wrapTextToWidth(ctx, text, maxW) {
  const out = [];
  const width = Math.max(1, maxW);
  for (const para of String(text).split("\n")) {
    if (!para) { out.push(""); continue; }
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const trial = line + " " + words[i];
      if (ctx.measureText(trial).width <= width) line = trial;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}
const lineHeightOf = (p) => clamp(+p.lineHeight || 1.2, 0.6, 3);
/* Largest font size ≤ maxSize that wraps into boxW×boxH. */
function fitFontSizeToBox(ctx, p, boxW, boxH, maxSize) {
  const lhMul = lineHeightOf(p);
  const justify = p.align === "justify";
  const src = textSourceString(p);
  let lo = 8, hi = Math.max(8, Math.round(maxSize || 72)), best = 8;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    setTextFont(ctx, p, mid);
    let lines = wrapTextToWidth(ctx, src, boxW);
    if (justify) lines = lines.map((ln) => justifyLineBySpaces(ctx, ln, boxW));
    const totalH = Math.max(1, lines.length) * mid * lhMul;
    if (totalH <= boxH + 0.5) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}
/* Measure content-sized text bounds (half-width / half-height) at current props. */
function measureTextHalfSize(p) {
  ctx2d.save();
  const size = p.fontSize || 72;
  setTextFont(ctx2d, p, size);
  let lines = textSourceString(p).split("\n");
  if (p.align === "justify") {
    const nat = Math.max(1, ...lines.map((l) => ctx2d.measureText(l).width));
    const target = textJustifyTarget(p, nat);
    lines = lines.map((l) => justifyLineBySpaces(ctx2d, l, target));
  }
  const tw = Math.max(1, ...lines.map((l) => ctx2d.measureText(l).width));
  const lh = size * lineHeightOf(p);
  ctx2d.restore();
  const sc = +p.scale || 1;
  return { hw: (tw / 2 + size * 0.25) * sc, hh: (lines.length * lh / 2 + size * 0.14) * sc };
}
/* First corner-drag on a hug-content title: create a box from current bounds. */
function ensureTextBox(c) {
  if (c.kind !== "text" || hasTextBox(c.props)) return;
  const p = propsAtPlayhead(c);
  const half = measureTextHalfSize(p);
  const sc = +p.scale || 1;
  if (Math.abs(sc - 1) > 0.01) {
    setAnimProp(c, "fontSize", Math.round((+p.fontSize || 72) * sc));
    setAnimProp(c, "scale", 1);
  }
  c.props.boxW = Math.max(40, +(half.hw * 2).toFixed(1));
  c.props.boxH = Math.max(24, +(half.hh * 2).toFixed(1));
}
/* Pin the opposite corner for a boxed-text resize (call after any seed). */
function beginTextBoxDrag(c, pt, W, H) {
  const b2 = clipBounds(c, evalProps(c, state.time), W, H);
  const hd2 = overlayHandles(b2, W, H);
  const grab = hd2.hs * 1.8;
  const ci = hd2.corners.findIndex((h) => Math.abs(pt.x - h.x) <= grab && Math.abs(pt.y - h.y) <= grab);
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const [dsx, dsy] = signs[ci >= 0 ? ci : 0];
  const cs = Math.cos(b2.rot), sn = Math.sin(b2.rot);
  const ox = -dsx * b2.hw, oy = -dsy * b2.hh;
  return {
    mode: "box", id: c.id, rot: b2.rot, dragSX: dsx, dragSY: dsy,
    fix: { x: b2.cx + ox * cs - oy * sn, y: b2.cy + ox * sn + oy * cs },
    aspect: Math.max(0.05, (b2.hw * 2) / Math.max(1e-6, b2.hh * 2)),
  };
}
function drawText(c, p, local) {
  const useBox = hasTextBox(p);
  const boxW = +p.boxW, boxH = +p.boxH;
  const scaleToFit = useBox && !!p.boxFit;
  const src = textSourceString(p);
  const weight = textFontWeight(p);
  let size = p.fontSize || 72;
  if (useBox) {
    if (scaleToFit) size = fitFontSizeToBox(ctx2d, p, boxW, boxH, p.fontSize || 72);
  } else {
    ctx2d.scale(p.scale || 1, p.scale || 1);
  }
  setTextFont(ctx2d, p, size);
  ctx2d.textBaseline = "middle";
  let rawLines = useBox ? wrapTextToWidth(ctx2d, src, boxW) : src.split("\n");
  const justify = p.align === "justify";
  if (justify) {
    const target = useBox ? boxW : textJustifyTarget(p, Math.max(1, ...rawLines.map((ln) => ctx2d.measureText(ln).width)));
    rawLines = rawLines.map((ln) => justifyLineBySpaces(ctx2d, ln, target));
  }
  const lh = size * lineHeightOf(p);
  const nLines = Math.max(1, rawLines.length);
  const vAlign = p.vAlign === "top" || p.vAlign === "bottom" ? p.vAlign : "middle";
  // y0 = first line center. With a box, place the whole block by vAlign; without, center on clip origin.
  let y0;
  if (useBox) {
    if (vAlign === "top") y0 = -boxH / 2 + lh / 2;
    else if (vAlign === "bottom") y0 = boxH / 2 - lh / 2 - (nLines - 1) * lh;
    else y0 = -((nLines - 1) * lh) / 2;
  } else {
    y0 = -((nLines - 1) * lh) / 2;
  }
  const anim = TEXT_ANIMS.includes(p.textAnim) ? p.textAnim : "none";
  const rate = clamp(+p.wordRate || 0.15, 0.03, 2);
  const align = p.align === "left" || p.align === "right" ? p.align : "center";
  const lineWidths = rawLines.map((ln) => ctx2d.measureText(ln).width);
  const blockW = useBox ? boxW : Math.max(1, ...lineWidths);
  const lineDirs = lineDirections(p, rawLines);
  // anchor x of each line's center, honoring block alignment
  const lineCx = (i) => align === "left" ? -blockW / 2 + lineWidths[i] / 2
    : align === "right" ? blockW / 2 - lineWidths[i] / 2 : 0;
  if (useBox) {
    ctx2d.beginPath();
    ctx2d.rect(-boxW / 2, -boxH / 2, boxW, boxH);
    ctx2d.clip();
  }
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
  const paint = (str, x, y, alpha = 1, rtl = false) => {
    if (alpha <= 0) return;
    const keep = ctx2d.globalAlpha;
    const prevDir = ctx2d.direction;
    ctx2d.globalAlpha = keep * clamp(alpha, 0, 1);
    ctx2d.direction = rtl ? "rtl" : "ltr";
    ctx2d.textAlign = "center";
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
    ctx2d.direction = prevDir;
    ctx2d.globalAlpha = keep;
  };

  if (anim === "none") {
    rawLines.forEach((ln, i) => paint(ln, lineCx(i), y0 + i * lh, 1, lineDirs[i] === "rtl"));
    return;
  }
  // clip-reveal: wipe mask sweeps each line in reading direction
  if (anim === "clip-reveal") {
    rawLines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const u = clamp((local - i * rate) / 0.5, 0, 1);
      if (u <= 0) return;
      const e = EASE["ease-out"](u), w = lineWidths[i], cx = lineCx(i), y = y0 + i * lh;
      const rtl = lineDirs[i] === "rtl";
      ctx2d.save();
      ctx2d.beginPath();
      revealWipeRect(cx, w, lh, y, e, rtl);
      ctx2d.clip();
      paint(ln, cx, y, 1, rtl);
      ctx2d.restore();
    });
    return;
  }
  // zoom-in: text scales down into place with an opacity settle
  if (anim === "zoom-in") {
    rawLines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const u = clamp((local - i * rate) / 0.45, 0, 1);
      if (u <= 0) return;
      const e = EASE["ease-out"](u), s = 1.35 - 0.35 * e;
      const rtl = lineDirs[i] === "rtl";
      ctx2d.save();
      ctx2d.translate(lineCx(i), y0 + i * lh);
      ctx2d.scale(s, s);
      paint(ln, 0, 0, Math.min(1, u * 1.6), rtl);
      ctx2d.restore();
    });
    return;
  }
  // rise-mask: each line rises from behind its own baseline (lower-third reveal)
  if (anim === "rise-mask") {
    rawLines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const u = clamp((local - i * rate) / 0.5, 0, 1);
      if (u <= 0) return;
      const e = EASE["ease-out"](u), cx = lineCx(i), y = y0 + i * lh;
      const rtl = lineDirs[i] === "rtl";
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(cx - blockW / 2 - 24, y - lh / 2, blockW + 48, lh);
      ctx2d.clip();
      paint(ln, cx, y + (1 - e) * lh, 1, rtl);
      ctx2d.restore();
    });
    return;
  }
  // font-cut: rhythmically swap the typeface, then settle (speed cuts)
  if (anim === "font-cut") {
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
    rawLines.forEach((ln, i) => { if (ln.trim()) paint(ln, lcx(i), y0 + i * lh, 1, lineDirs[i] === "rtl"); });
    return;
  }
  if (anim === "typewriter") {
    let budget = Math.floor(local / (rate / 4)); // rate/4 s per grapheme cluster
    rawLines.forEach((ln, i) => {
      const rtl = lineDirs[i] === "rtl";
      const graphemes = graphemeSegments(ln);
      const shown = graphemes.slice(0, Math.max(0, budget)).join("");
      budget -= graphemes.length;
      if (shown) {
        const shownW = ctx2d.measureText(shown).width;
        paint(shown, typewriterX(lineCx(i), lineWidths[i], shownW, rtl), y0 + i * lh, 1, rtl);
      }
    });
    return;
  }
  // per-character animations (TikTok style); Arabic/Indic fall back to word clusters
  if (anim === "letter-pop" || anim === "wave") {
    let ci = 0;
    rawLines.forEach((ln, i) => {
      const y = y0 + i * lh;
      const rtl = lineDirs[i] === "rtl";
      const shaped = needsContextualShaping(ln);
      const segs = letterAnimSegments(ln);
      const stagger = shaped ? rate : rate / 3;
      const widths = segs.map((s) => ctx2d.measureText(s.text).width);
      const total = widths.reduce((a, b) => a + b, 0);
      let x = runOrigin(lineCx(i), total, rtl);
      segs.forEach((seg, j) => {
        const w = widths[j];
        const cx = rtl ? x - w / 2 : x + w / 2;
        if (seg.animate) {
          if (anim === "letter-pop") {
            const u = clamp((local - ci * stagger) / 0.18, 0, 1);
            if (u > 0) {
              ctx2d.save();
              ctx2d.translate(cx, y);
              const s = Math.max(0.001, backOut(u));
              ctx2d.scale(s, s);
              paint(seg.text, 0, 0, Math.min(1, u * 2.5), rtl);
              ctx2d.restore();
            }
          } else { // wave: continuous per-segment sine ride
            paint(seg.text, cx, y + Math.sin(local * 4 + ci * 0.55) * size * 0.12, 1, rtl);
          }
          ci++;
        }
        x += rtl ? -w : w;
      });
    });
    return;
  }
  // word-based animations: lay words out manually, per-line, honoring alignment + direction
  const spaceW = ctx2d.measureText(" ").width;
  let wi = 0;
  rawLines.forEach((ln, i) => {
    const y = y0 + i * lh;
    const rtl = lineDirs[i] === "rtl";
    const words = ln.split(/\s+/).filter(Boolean);
    const widths = words.map((w) => ctx2d.measureText(w).width);
    const wordsW = widths.reduce((a, b) => a + b, 0);
    const gapN = Math.max(0, words.length - 1);
    // After justify, ln already has expanded spaces — recreate that gap so word anims stay spread
    const total = justify && gapN
      ? lineWidths[i]
      : wordsW + spaceW * gapN;
    const gap = gapN ? (total - wordsW) / gapN : spaceW;
    let x = runOrigin(lineCx(i), total, rtl);
    words.forEach((word, j) => {
      const w = widths[j];
      const cx = rtl ? x - w / 2 : x + w / 2;
      const u = clamp((local - wi * rate) / 0.25, 0, 1);
      if (anim === "word-pop") {
        if (u > 0) {
          ctx2d.save();
          ctx2d.translate(cx, y);
          const s = Math.max(0.001, backOut(u));
          ctx2d.scale(s, s);
          paint(word, 0, 0, Math.min(1, u * 2.5), rtl);
          ctx2d.restore();
        }
      } else if (anim === "word-slide") {
        if (u > 0) paint(word, cx, y + (1 - EASE["ease-out"](u)) * size * 0.7, u, rtl);
      } else if (anim === "bounce") { // continuous per-word hop
        paint(word, cx, y - Math.abs(Math.sin(local * 3.2 + wi * 0.9)) * size * 0.18, 1, rtl);
      } else if (anim === "shake") { // continuous nervous jitter
        paint(word, cx + Math.sin(local * 31 + wi * 7.3) * size * 0.035,
                    y + Math.cos(local * 27 + wi * 3.1) * size * 0.035, 1, rtl);
      } else { // karaoke: everything visible dim, spoken words at full strength
        paint(word, cx, y, u >= 1 ? 1 : 0.3 + u * 0.7, rtl);
      }
      x += rtl ? -(w + gap) : (w + gap);
      wi++;
    });
  });
}

/* ═══════════════════════════ FONTS ═══════════════════════════ */
/* Custom fonts: any .ttf/.otf/.woff/.woff2 in ./library/fonts is registered
   under its file name (sans extension). Google fonts load on demand by name. */
let libraryFontsReady = null; // the first library pass; ensureFont waits on it
function loadLibraryFonts() {
  const pass = (async () => {
    try {
      const files = await (await fetch("/api/library?dir=fonts")).json();
      await Promise.all(files.map(async (f) => {
        if (!/\.(ttf|otf|woff2?)$/i.test(f.name)) return;
        const family = f.name.replace(/\.[^.]+$/, "");
        // claimed before the first await: every sync runs this, and passes
        // that overlapped used to list the same family twice
        if (runtime.libraryFontReq.has(family)) return;
        runtime.libraryFontReq.add(family);
        try {
          const buf = await (await fetch(f.src)).arrayBuffer();
          // a variable font draws every weight itself; a static one keeps the
          // default descriptor so bold is still synthesized from it
          const face = new FontFace(family, buf, fontIsVariable(buf) ? { weight: "1 1000" } : {});
          await face.load();
          document.fonts.add(face);
          runtime.customFonts.push(family);
          runtime.customFonts.sort();
        } catch { runtime.libraryFontReq.delete(family); }
      }));
    } catch { }
  })();
  libraryFontsReady ??= pass;
  return pass;
}
/* True when a font file has an fvar table. Reads only the table directory,
   of an sfnt (TTF/OTF), a WOFF or a WOFF2. */
function fontIsVariable(buf) {
  const FVAR = 0x66766172;
  try {
    const v = new DataView(buf);
    const sig = v.getUint32(0);
    if (sig === 0x774f4632) { // wOF2: flags, optional tag, UIntBase128 lengths
      let o = 48;
      const skip128 = () => { while (v.getUint8(o++) & 128); };
      for (let i = 0, n = v.getUint16(12); i < n; i++) {
        const flags = v.getUint8(o++), known = flags & 63;
        if (known === 47) return true; // 47 = fvar in the WOFF2 known-tag table
        if (known === 63 && v.getUint32((o += 4) - 4) === FVAR) return true;
        skip128(); // origLength
        const xform = flags >> 6; // glyf/loca: 3 is the null transform, others: 0
        if (known === 10 || known === 11 ? xform !== 3 : xform !== 0) skip128();
      }
      return false;
    }
    const woff = sig === 0x774f4646;
    for (let i = 0, n = v.getUint16(woff ? 12 : 4); i < n; i++)
      if (v.getUint32(woff ? 44 + i * 20 : 12 + i * 16) === FVAR) return true;
  } catch { }
  return false;
}
/* Every weight, upright and italic, in one request: the API leaves out the
   styles a family doesn't have, and answers 400 for a name it doesn't know. */
const GOOGLE_FONT_STYLES = "ital,wght@" + [0, 1].flatMap((i) =>
  [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => `${i},${w}`)).join(";");
const FONT_READY = Promise.resolve(true);
let fontProbe = null;
/* Installed on this machine? A known face measures differently from the
   generic fallback it would otherwise get. */
function fontInstalled(name) {
  fontProbe ||= document.createElement("canvas").getContext("2d");
  const s = "mmmmmmmmmmlli1WQ@#";
  return ["monospace", "serif"].some((generic) => {
    fontProbe.font = `72px ${generic}`;
    const base = fontProbe.measureText(s).width;
    fontProbe.font = `72px "${name}", ${generic}`;
    return fontProbe.measureText(s).width !== base;
  });
}
function fontRegistered(name) {
  for (const f of document.fonts) if (f.family.replace(/^["']|["']$/g, "") === name) return true;
  return false;
}
/* Make `name` drawable: system and library fonts already are, anything else
   comes from Google Fonts. Resolves false when there is no such font. Cheap
   to call every frame (font-cut does): one request per name, ever. */
function ensureFont(name) {
  if (!name || SYSTEM_FONTS.includes(name)) return FONT_READY;
  let req = runtime.fontReq.get(name);
  if (req) return req;
  req = (async () => {
    await (libraryFontsReady || loadLibraryFonts());
    if (runtime.customFonts.includes(name) || fontRegistered(name) || fontInstalled(name)) return true;
    const ok = await new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      // CORS mode so @font-face files stay origin-clean when fillText hits the canvas.
      link.crossOrigin = "anonymous";
      link.href = "https://fonts.googleapis.com/css2?family=" +
        encodeURIComponent(name).replace(/%20/g, "+") + ":" + GOOGLE_FONT_STYLES + "&display=swap";
      link.onload = () => resolve(true);
      link.onerror = () => { link.remove(); resolve(false); };
      document.head.appendChild(link);
    });
    if (!ok) return false;
    runtime.googleLoaded.add(name);
    // fetch the usual faces now instead of on the first frame that draws them
    await Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 64px "${name}"`).catch(() => { })));
    return true;
  })();
  runtime.fontReq.set(name, req);
  return req;
}
/* Before an export: every face the titles draw with, loaded. A frame drawn
   while its face is still in flight comes out in the fallback font, and in
   an export that frame is final. Bounded so a dead network can't stall it. */
async function loadProjectFonts() {
  const faces = new Map(); // "italic 700 64px "Anton"" -> "Anton"
  for (const c of project.clips) {
    if (c.kind !== "text" || c.disabled) continue;
    const p = c.props || {};
    const fams = [p.font || "Segoe UI"];
    if (p.textAnim === "font-cut")
      fams.push(...(Array.isArray(p.fontCutSet) && p.fontCutSet.length ? p.fontCutSet : FONT_CUT_DEFAULT));
    for (const fam of fams) faces.set(`${p.italic ? "italic " : ""}${textFontWeight(p)} 64px "${fam}"`, fam);
  }
  const load = Promise.all([...faces].map(async ([spec, fam]) => {
    if (await ensureFont(fam)) await document.fonts.load(spec).catch(() => { });
  }));
  await Promise.race([load, new Promise((r) => setTimeout(r, 8000))]);
  try { await document.fonts.ready; } catch { }
}

/* ── Main loop ── */
let lastTs = null;
let exportWindow = null;
let playheadPx = -1;
function loop(ts) {
  if (lastTs == null) lastTs = ts;
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  // projDur() is an O(clips) scan — compute it once per tick and reuse below
  // instead of the 2-4 independent recomputations this loop used to trigger.
  const dur = projDur();
  if (state.source.playing) {
    // Same RAF clock as the timeline playhead — video.currentTime only steps at
    // decode cadence and makes the scrub head stutter.
    const rate = playRate();
    if (rate < 0) { // reverse: stop at Source In (if the head is past it) or 0
      const inn = state.source.in;
      const floor = inn != null && state.source.time >= inn - 1e-4 ? inn : 0;
      state.source.time += dt * rate;
      if (state.source.time <= floor) {
        state.source.time = floor;
        pauseSource();
      }
    } else {
      state.source.time += dt * rate;
      const end = sourceStopAt();
      if (state.source.time >= end) {
        state.source.time = end;
        pauseSource();
      }
    }
  } else if (state.playing) {
    const rate = playRate();
    if (rate < 0) { // reverse: stop at IN under Limit (if the playhead is past it) or 0
      const floor = playLimited() && project.inPoint != null && state.time >= project.inPoint - 1e-4
        ? project.inPoint : 0;
      state.time += dt * rate;
      if (state.time <= floor) {
        state.time = floor;
        pause();
      }
    } else {
      state.time += dt * rate;
      let end = playStopAt(dur);
      if (state.exporting && !state.rendering && exportWindow) end = exportWindow.end;
      if (state.time >= end) {
        state.time = end;
        if (state.exporting) finishExport(true);
        else pause();
      }
    }
    // keep playhead visible
    const px = state.time * state.pps, sc = els.timelineScroll;
    if (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 40)
      sc.scrollLeft = Math.max(0, px - 60);
  }
  if (!state.rendering) { // fast export owns media seeking + the canvas
    if (isSourceMode()) {
      syncSourceMedia();
      drawSourceFrame();
    } else {
      syncMedia();
      drawFrame();
    }
  }
  if (state.dirtyTimeline) rebuildClips();
  const phX = Math.round(state.time * state.pps);
  if (phX !== playheadPx) {
    playheadPx = phX;
    els.playhead.style.left = phX + "px";
  }
  drawRuler();
  if (!isSourceMode()) updateSafeOverlay();
  updateKfGraphs();
  syncInspectorPlayhead();
  syncFxEditors();
  updateMeterUI(dt);
  updateTimecode(dur);
  if (isSourceMode()) updateSourceScrub();
  if (state.exporting && !state.rendering) {
    const w = exportWindow;
    const span = w ? w.dur : dur;
    const t0 = w ? w.start : 0;
    const pct = span ? ((state.time - t0) / span) * 100 : 0;
    els.exportProgress.style.width = pct.toFixed(1) + "%";
    els.exportTitle.textContent = `Exporting… ${pct.toFixed(0)}%`;
  }
  requestAnimationFrame(loop);
}

/* ═══════════════════════════ EXPORT ═══════════════════════════ */
/* Three engines:
   – fast: the browser renders every frame with the normal compositor
     (frame-accurate, works unfocused) and streams JPEGs + an offline audio
     mix to the server, where ffmpeg encodes via an encoding profile.
   – webcodecs: VideoEncoder Annex-B H.264 → server stream-copy mux
   – realtime: MediaRecorder HW-encode H.264 → server stream-copy mux
     server/ffmpeg is unavailable. */

/* Placeholder until /api/export/profiles answers — the real list (and the real
   ffmpeg args) always comes from encoding-profiles.json on the server. */
let encodeProfiles = {
  default: "delivery",
  profiles: {
    draft: {
      label: "Draft · H.264 fast",
      description: "Quick preview — smaller file, faster encode.",
      summary: "-c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k",
      jpegQuality: 0.85,
    },
    delivery: {
      label: "Delivery · H.264 balanced",
      description: "Default export — good quality and compatibility.",
      summary: "-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k",
      jpegQuality: 0.95,
    },
    hq: {
      label: "High quality · H.264 slow",
      description: "Best H.264 quality — slower encode, larger file.",
      summary: "-c:v libx264 -preset slow -crf 16 -c:a aac -b:a 256k",
      jpegQuality: 0.98,
    },
  },
};

async function fetchEncodeProfiles() {
  if (!state.connected) return;
  try {
    const r = await fetch("/api/export/profiles", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (data?.profiles && Object.keys(data.profiles).length) encodeProfiles = data;
  } catch { }
}
function effectiveEncodeProfileId() {
  return project.encodeProfile || getSetting("encodeProfile") || encodeProfiles.default || "delivery";
}
function exportProfileMeta(id) {
  return encodeProfiles.profiles[id] || { label: id, summary: id, jpegQuality: 0.95 };
}
function updateExportProfileNote(id) {
  const known = Object.hasOwn(encodeProfiles.profiles, id);
  const p = exportProfileMeta(id);
  if (els.exportProfileNote) {
    els.exportProfileNote.textContent = known
      ? [p.description, p.summary].filter(Boolean).join(" — ")
      : `"${id}" is not defined in encoding-profiles.json — the export will fail until it is added or another profile is picked.`;
  }
  if (els.exportProfileHint) {
    if (project.encodeProfile) {
      els.exportProfileHint.textContent =
        "Project default (encodeProfile in project.json). Pick another profile here for a one-off export.";
    } else if (getSetting("encodeProfile")) {
      els.exportProfileHint.textContent = "Browser default — saved when you change this dropdown.";
    } else {
      els.exportProfileHint.textContent = "Using server default from encoding-profiles.json.";
    }
  }
}
function populateExportProfileSelect() {
  if (!els.exportProfileSel) return;
  const ids = Object.keys(encodeProfiles.profiles);
  const cur = effectiveEncodeProfileId();
  // a project/browser default naming a deleted profile must stay visible rather
  // than silently falling through to whichever option happens to be first
  if (cur && !ids.includes(cur)) ids.unshift(cur);
  els.exportProfileSel.innerHTML = ids.map((id) => {
    const p = encodeProfiles.profiles[id];
    const sel = id === cur ? " selected" : "";
    const label = p ? (p.label || id) : `${id} (not defined on the server)`;
    return `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(label)}</option>`;
  }).join("");
  updateExportProfileNote(els.exportProfileSel.value || cur || "delivery");
}
function syncExportProfileVisibility() {
  const show = els.engineFast.checked && !els.engineFast.disabled;
  els.exportProfileRow?.classList.toggle("hidden", !show);
}

function syncExportWcOpts() {
  const opts = $("exportWcOpts");
  if (!opts) return;
  const show = !!(els.engineRealtime?.checked && state.webCodecs
    && state.connected && state.ffmpeg && !els.engineRealtime.disabled);
  opts.classList.toggle("hidden", !show);
}
function fillExportWcOpts() {
  const br = $("exportWcBitrate");
  const mode = $("exportWcMode");
  if (br) {
    const mbps = getSetting("webCodecsBitrateMbps");
    const want = mbps == null ? "auto" : String(Math.round(Number(mbps)));
    br.value = [...br.options].some((o) => o.value === want) ? want : "auto";
  }
  if (mode) {
    const m = getSetting("webCodecsBitrateMode");
    mode.value = m === "constant" ? "constant" : "variable";
  }
}
function persistExportWcOpts() {
  const br = $("exportWcBitrate");
  const mode = $("exportWcMode");
  if (br) {
    setSetting("webCodecsBitrateMbps", br.value === "auto" ? null : Number(br.value));
  }
  if (mode) {
    setSetting("webCodecsBitrateMode", mode.value === "constant" ? "constant" : "variable");
  }
}
/** Bitrate for VideoEncoder.configure — no CRF in WebCodecs; only bitrate (+ CBR/VBR). */
function webCodecsBitrate(w, h, fps) {
  const mbps = getSetting("webCodecsBitrateMbps");
  if (mbps != null && Number.isFinite(+mbps) && +mbps > 0) {
    return Math.round(Math.min(100, Math.max(0.5, +mbps)) * 1_000_000);
  }
  // ~0.1 bit/pixel/frame, clamped — same heuristic as before
  return Math.min(20_000_000, Math.max(2_000_000, Math.round(w * h * fps * 0.1)));
}
async function openExportSetup() {
  if (state.exporting) return;
  if (!project.clips.length) { alert("Timeline is empty — add some clips first."); return; }
  await detectWebCodecs();
  const ef = getExportFrame();
  const fastOk = state.connected && state.ffmpeg;
  // WebCodecs and MediaRecorder encode the full canvas — only Fast crops.
  const wcOk = fastOk && state.webCodecs && !ef;
  const recOk = !ef && !!(window.MediaRecorder && pickMime());
  els.engineFast.disabled = !fastOk;
  els.engineRealtime.disabled = !wcOk && !recOk;
  // Prefer Fast, then WebCodecs, then MediaRecorder
  if (fastOk) {
    els.engineFast.checked = true;
    els.engineRealtime.checked = false;
  } else if (wcOk || recOk) {
    els.engineFast.checked = false;
    els.engineRealtime.checked = true;
  } else {
    // Frame set but no ffmpeg — neither engine can run; prefer Fast in the UI.
    els.engineFast.checked = true;
    els.engineRealtime.checked = false;
  }
  $("engineFastNote").textContent = fastOk
    ? (ef ? "Exports the " + ef.w + "×" + ef.h + " delivery frame (cropped). Keeps rendering if you switch tabs."
      : "Frame-accurate. Server encodes from JPEG frames. Keeps going if you switch tabs.")
    : (ef
      ? "Needs the server + ffmpeg on PATH to export a cropped delivery frame."
      : "Needs the server + ffmpeg on PATH.");
  const wcNote = $("engineWebCodecsNote");
  if (wcNote) {
    if (wcOk) wcNote.textContent = "Frame-accurate. Browser HW-encodes H.264; server muxes with audio. Faster upload than Fast.";
    else if (ef) wcNote.textContent = fastOk
      ? "Unavailable while an export frame is set — use Fast export."
      : "Unavailable while an export frame is set. Install ffmpeg, or clear the export frame to use Realtime.";
    else if (!state.connected || !state.ffmpeg) wcNote.textContent = "Needs the server + ffmpeg. Falling back to in-browser MediaRecorder when selected.";
    else wcNote.textContent = "This browser does not support VideoEncoder Annex-B H.264. Falling back to MediaRecorder when selected.";
  }
  // Relabel the radio when WebCodecs is unavailable but MediaRecorder still works
  const label = els.engineRealtime?.closest("label")?.querySelector("b");
  if (label) label.textContent = wcOk ? "WebCodecs (HW encode)" : "Realtime (in-browser)";
  fillExportWcOpts();
  syncExportWcOpts();
  const warn = $("exportTrackWarn");
  const disabled = TRACKS.filter((t) =>
    !isTrackEnabled(t.id) && project.clips.some((c) => c.track === t.id)
  ).map((t) => t.id);
  if (disabled.length && warn) {
    const list = disabled.join(", ");
    warn.textContent = disabled.length === 1
      ? `Track ${list} is disabled and will be omitted from the export.`
      : `Tracks ${list} are disabled and will be omitted from the export.`;
    warn.classList.remove("hidden");
  } else if (warn) {
    warn.textContent = "";
    warn.classList.add("hidden");
  }
  fillExportRangeSelect();
  syncExportRangeUi();
  syncExportProfileVisibility();
  fetchEncodeProfiles().then(() => {
    populateExportProfileSelect();
    els.exportSetup.classList.remove("hidden");
  });
}
function startChosenExport() {
  persistExportWcOpts();
  const useFast = els.engineFast.checked && !els.engineFast.disabled;
  const useSecond = els.engineRealtime.checked && !els.engineRealtime.disabled;
  if (!useFast && !useSecond) {
    const ef = getExportFrame();
    if (ef && !(state.connected && state.ffmpeg)) {
      alert("Export frame cropping needs Fast export (server + ffmpeg). Clear the export frame, or install ffmpeg and try again.");
      return;
    }
    alert("No export engine is available.");
    return;
  }
  if (exportRange().frames < 1) {
    alert("Export range is empty — IN/OUT is at or past the end of the timeline. Choose Entire timeline, or move the markers.");
    return;
  }
  els.exportSetup.classList.add("hidden");
  if (useFast) fastExport();
  else if (useSecond && state.connected && state.ffmpeg && state.webCodecs && !getExportFrame()) webCodecsExport();
  else startExport();
}

/* Keep Range's IN–OUT option in sync with marker presence without clobbering
   a deliberate "entire" choice. Invalid "in-out" (no work area) snaps to entire
   so the displayed value matches exportRangeMode(). */
function syncExportRangeSelect() {
  const sel = $("exportRangeSel");
  if (!sel) return;
  const opt = sel.querySelector('option[value="in-out"]');
  const has = hasWorkArea();
  if (opt) opt.disabled = !has;
  if (!has && sel.value === "in-out") sel.value = "entire";
}
function fillExportRangeSelect() {
  syncExportRangeSelect();
  const sel = $("exportRangeSel");
  if (sel) sel.value = hasWorkArea() ? "in-out" : "entire";
}
function exportRangeNoteText() {
  const mode = exportRangeMode();
  const { start, dur, frames } = exportRange();
  const end = start + dur;
  if (mode === "entire") return `Full timeline · ${fmt(start)} → ${fmt(end)}`;
  if (frames < 1) return "IN–OUT is empty — markers are at or past the end of the timeline.";
  const inn = project.inPoint != null, out = project.outPoint != null;
  if (inn && out) return `IN–OUT · ${fmt(start)} → ${fmt(end)}`;
  if (inn) return `IN to end · ${fmt(start)} → ${fmt(end)}`;
  return `Start to OUT · ${fmt(start)} → ${fmt(end)}`;
}
function syncExportRangeUi() {
  const note = $("exportRangeNote");
  if (note) note.textContent = exportRangeNoteText();
  const btn = $("btnStartExport");
  if (btn) btn.disabled = exportRange().frames < 1;
}

/* ── Fast export ── */
let renderCancelled = false;
let exportAbort = null;
function beginExportWindow() {
  exportWindow = exportRange();
  return exportWindow;
}
function endExportWindow() {
  exportWindow = null;
}
let exportCropCanvas = null;
let exportCropCtx = null;
function canvasTaintError(e) {
  const tainted = e && (e.name === "SecurityError" || /taint/i.test(String(e.message || e)));
  return tainted
    ? new Error("Tainted canvas — a clip is from another origin (not /media or /library) without CORS, or an SVG could not be rasterized cleanly. Import the file into the project, or serve it with Access-Control-Allow-Origin.")
    : (e || new Error("frame encode failed"));
}
function exportSourceCanvas() {
  const ef = getExportFrame();
  if (!ef) return els.preview;
  if (!exportCropCanvas) exportCropCanvas = document.createElement("canvas");
  if (exportCropCanvas.width !== ef.w) exportCropCanvas.width = ef.w;
  if (exportCropCanvas.height !== ef.h) exportCropCanvas.height = ef.h;
  if (!exportCropCtx) exportCropCtx = exportCropCanvas.getContext("2d", { alpha: false });
  exportCropCtx.drawImage(els.preview, ef.x, ef.y, ef.w, ef.h, 0, 0, ef.w, ef.h);
  return exportCropCanvas;
}
let exportSnapOff = null, exportSnapCtx = null;
/** Synchronous snapshot so the compositor can draw the next frame immediately.
 *  JPEG encode runs off-thread from the ImageBitmap. */
function snapshotExportFrame() {
  const src = exportSourceCanvas();
  try {
    if (typeof OffscreenCanvas === "function") {
      if (!exportSnapOff || exportSnapOff.width !== src.width || exportSnapOff.height !== src.height) {
        exportSnapOff = new OffscreenCanvas(src.width, src.height);
        exportSnapCtx = exportSnapOff.getContext("2d", { alpha: false });
      }
      exportSnapCtx.drawImage(src, 0, 0);
      if (typeof exportSnapOff.transferToImageBitmap === "function")
        return { kind: "bmp", bmp: exportSnapOff.transferToImageBitmap() };
    }
    const img = src.getContext("2d").getImageData(0, 0, src.width, src.height);
    return { kind: "rgba", data: img.data, w: src.width, h: src.height };
  } catch (e) { throw canvasTaintError(e); }
}
const JPEG_WORKER_SRC = `"use strict";
self.onmessage = async (e) => {
  const { id, bmp, quality } = e.data;
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d", { alpha: false });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await c.convertToBlob({ type: "image/jpeg", quality: quality || 0.92 });
    const buf = await blob.arrayBuffer();
    self.postMessage({ id, buf }, [buf]);
  } catch (err) {
    try { bmp.close(); } catch {}
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
`;
function createJpegWorkers(n) {
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") return null;
  let url;
  try { url = URL.createObjectURL(new Blob([JPEG_WORKER_SRC], { type: "text/javascript" })); }
  catch { return null; }
  const workers = [];
  try {
    for (let i = 0; i < n; i++) workers.push(new Worker(url));
  } catch {
    for (const w of workers) try { w.terminate(); } catch { }
    URL.revokeObjectURL(url);
    return null;
  }
  URL.revokeObjectURL(url);
  const pending = new Map();
  let nextId = 0, rr = 0;
  for (const w of workers) {
    w.onmessage = (e) => {
      const rec = pending.get(e.data.id);
      if (!rec) return;
      pending.delete(e.data.id);
      if (e.data.error) rec.reject(new Error(e.data.error));
      else rec.resolve(e.data.buf);
    };
    w.onerror = () => {};
  }
  return {
    encode(bmp, quality) {
      const id = nextId++;
      const w = workers[rr++ % workers.length];
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { w.postMessage({ id, bmp, quality }, [bmp]); }
        catch (e) { pending.delete(id); reject(e); }
      });
    },
    terminate() {
      for (const rec of pending.values()) rec.reject(new Error("cancelled"));
      pending.clear();
      for (const w of workers) try { w.terminate(); } catch { }
    },
  };
}
function jpegFromBitmap(bmp, quality) {
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0);
  try { bmp.close(); } catch { }
  return new Promise((res, rej) => {
    try {
      c.toBlob((b) => {
        if (!b) return rej(new Error("frame encode failed"));
        b.arrayBuffer().then(res, rej);
      }, "image/jpeg", quality);
    } catch (e) { rej(canvasTaintError(e)); }
  });
}
/** Preview may already be tainted (cross-origin PiP, old data: SVG). Resetting
 *  width clears the bitmap and the origin-clean flag; export redraws each frame. */
function resetExportCanvases() {
  els.preview.width = els.preview.width;
  if (exportCropCanvas) {
    exportCropCanvas.width = exportCropCanvas.width;
    exportCropCtx = null;
  }
  adjScratch.width = adjScratch.width;
  scratch.width = scratch.width;
  exportSnapOff = null;
  exportSnapCtx = null;
}
function waitMediaEl(el, ms = 2500) {
  if (el.readyState >= 2 && !(el.error)) return Promise.resolve();
  return new Promise((res) => {
    const done = () => {
      clearTimeout(tm);
      el.removeEventListener("loadeddata", done);
      el.removeEventListener("error", done);
      res();
    };
    const tm = setTimeout(done, ms);
    el.addEventListener("loadeddata", done);
    el.addEventListener("error", done);
  });
}
/** Reload other-origin video/images with crossOrigin=anonymous for the export
 *  compositor. Preview leaves them no-cors so a stream without ACAO still plays. */
async function armExportCors() {
  const jobs = [];
  for (const c of project.clips) {
    if (c.kind !== "video" || !clipRenders(c)) continue;
    const m = getMedia(c.mediaId);
    if (!m || !isCrossOriginSrc(m.src)) continue;
    const el = getClipEl(c);
    if (!el || el.crossOrigin === "anonymous") continue;
    const t = el.currentTime;
    el.crossOrigin = "anonymous";
    el.src = m.src;
    jobs.push(waitMediaEl(el).then(() => {
      try { if (Number.isFinite(t)) el.currentTime = t; } catch { }
    }));
  }
  for (const m of project.media) {
    if (m.kind !== "image" || !isCrossOriginSrc(m.src)) continue;
    const aux = runtime.mediaAux.get(m.id);
    if (!aux?.img || aux.img.crossOrigin === "anonymous") continue;
    jobs.push(loadImage(m.src).then((img) => {
      runtime.mediaAux.set(m.id, { ...aux, img });
    }).catch(() => { }));
  }
  await Promise.all(jobs);
  const missing = [];
  for (const c of project.clips) {
    if (c.kind !== "video" || !clipRenders(c)) continue;
    const m = getMedia(c.mediaId);
    if (!m || !isCrossOriginSrc(m.src)) continue;
    const el = runtime.clipEls.get(c.id);
    if (el && (el.error || el.readyState < 2)) missing.push(m.name || m.src);
  }
  if (missing.length)
    toast("No CORS on " + missing.join(", ") + " — blank in the export. Import into the project or add Access-Control-Allow-Origin.");
}
/* Sequential /frame POSTs, batched. Concurrent bodies can still race on ffmpeg
   stdin if they complete out of order, so the client starts each fetch only
   after the previous one settles; rendering runs ahead under backpressure.
   JPEG Fast and WebCodecs Annex-B both concatenate on this path. */
function createExportUploader(sessId, { batchItems, batchBytes, signal, getError, setError }) {
  let batch = [];
  let packed = 0;
  let sentFirst = false;
  let uploadTail = Promise.resolve();
  let uploadsInFlight = 0;
  const cancelled = () => renderCancelled || !!(signal && signal.aborted);
  const concatChunks = (parts, n) => {
    if (parts.length === 1) return parts[0];
    if (parts[0] instanceof Uint8Array) {
      const out = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.byteLength; }
      return out;
    }
    return new Blob(parts);
  };
  const enqueueUpload = (body) => {
    uploadsInFlight++;
    const p = uploadTail.catch(() => {}).then(async () => {
      if (cancelled()) throw new Error("cancelled");
      const err = getError();
      if (err) throw err;
      const r = await fetch("/api/export/frame?id=" + sessId, {
        method: "POST", body, signal,
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "frame upload failed");
    });
    uploadTail = p.catch((err) => {
      if (!getError()) setError(err);
    }).finally(() => { uploadsInFlight--; });
    return p;
  };
  const flush = (force) => {
    if (!batch.length) return;
    const first = !sentFirst;
    if (!force && !first && packed < batchBytes && batch.length < batchItems) return;
    sentFirst = true;
    const parts = batch, n = packed;
    batch = [];
    packed = 0;
    enqueueUpload(concatChunks(parts, n));
  };
  return {
    push(chunk) {
      const size = chunk.size ?? chunk.byteLength ?? 0;
      batch.push(chunk);
      packed += size;
      flush(false);
    },
    flush,
    inFlight() { return uploadsInFlight; },
    done() { flush(true); return uploadTail; },
    waitBackpressure(max = 2) {
      return new Promise((res, rej) => {
        const tick = () => {
          if (cancelled()) { clearInterval(poll); rej(new Error("cancelled")); }
          else {
            const err = getError();
            if (err) { clearInterval(poll); rej(err); }
            else if (uploadsInFlight <= max) { clearInterval(poll); res(); }
          }
        };
        const poll = setInterval(tick, 20);
        tick();
      });
    },
  };
}
/* ── Fast / WebCodecs frame sync ──
   HTMLVideoElement has no “step one frame” API — assigning currentTime always
   seeks. On the export hot path a seek-per-frame is the dominant cost, so:
     • already showing the target (requestVideoFrameCallback mediaTime) → no-op
     • forward through a shot, buffered → play + requestVideoFrameCallback.
       Settle on the *presented* frame, not currentTime (the clock runs ahead of
       the picture). If the last compositor tick was fast and the encode queue is
       not deep, leave the element playing. A slow tick or a backed-up queue
       pauses after the hit so the decoder cannot overrun during JPEG/encode wait.
     • reverse / large jump / unbuffered / overshoot → hard seek (currentTime,
       never fastSeek: fastSeek snaps to a nearby keyframe and repeats frames)
   Incoming clips are seek-prefetched ~1 s before they become active. */
let exportSeekClock = 0;
function restoreExportVideoState() {
  exportSeekClock = 0;
  pauseExportVideos();
  for (const el of runtime.clipEls.values()) {
    if (el._fcPrevMuted != null) {
      try { el.muted = el._fcPrevMuted; } catch { }
      el._fcPrevMuted = null;
    }
  }
}
function pauseExportVideos() {
  for (const el of runtime.clipEls.values()) {
    try { if (!el.paused) el.pause(); } catch { }
  }
}
/** How long the prior export tick took (seek → draw). Used to decide play-ahead. */
function exportLoopLag(frameMs) {
  const now = performance.now();
  if (exportSeekClock <= 0) return { lagMs: 0, fast: true, behind: false };
  const lagMs = now - exportSeekClock;
  return {
    lagMs,
    fast: lagMs < frameMs * 2,
    behind: lagMs > frameMs * 3,
  };
}
function videoRangeBuffered(el, from, to) {
  try {
    const b = el.buffered;
    const a = Math.min(from, to), z = Math.max(from, to);
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= a + 0.05 && b.end(i) >= z - 0.05) return true;
    }
  } catch { }
  return el.readyState >= 3;
}
function notePresented(el, mediaTime) {
  if (Number.isFinite(mediaTime)) el._fcPresentedTime = mediaTime;
}
function presentedClose(el, mt, eps) {
  return el._fcPresentedTime != null && Math.abs(el._fcPresentedTime - mt) <= eps;
}
function waitForPresentedFrame(el, timeoutMs = 80) {
  return new Promise((res, rej) => {
    if (typeof el.requestVideoFrameCallback !== "function") {
      notePresented(el, el.currentTime);
      res();
      return;
    }
    let done = false;
    const finishOk = (meta) => {
      const mediaTime = meta?.mediaTime;
      if (!Number.isFinite(mediaTime)) return;
      if (done) return;
      done = true;
      clearTimeout(tm);
      notePresented(el, mediaTime);
      res();
    };
    const tm = setTimeout(() => {
      if (done) return;
      done = true;
      rej(new Error("presented frame timeout"));
    }, timeoutMs);
    el.requestVideoFrameCallback((_n, meta) => finishOk(meta));
  });
}
function assignVideoTime(el, mt, accurate) {
  if (!accurate) el._fcPresentedTime = null;
  if (!accurate && typeof el.fastSeek === "function") {
    try { el.fastSeek(mt); return; } catch { }
  }
  el.currentTime = mt;
}
function hardSeekVideo(el, mt, attempt = 0) {
  const hasRvfc = typeof el.requestVideoFrameCallback === "function";
  const maxAttempts = 3;
  return new Promise((res, rej) => {
    const after = () => waitForPresentedFrame(el)
      .then(res)
      .catch((err) => {
        if (attempt + 1 >= maxAttempts) rej(err);
        else hardSeekVideo(el, mt, attempt + 1).then(res, rej);
      });
    if (presentedClose(el, mt, 0.002) && el.readyState >= 2) {
      res();
      return;
    }
    // No rvfc — paused on the right clock is the only signal we have.
    if (!hasRvfc && el._fcPresentedTime == null && el.paused && el.readyState >= 2
        && Math.abs(el.currentTime - mt) < 1e-4) {
      notePresented(el, el.currentTime);
      res();
      return;
    }
    el._fcPresentedTime = null;
    const done = () => {
      clearTimeout(tm);
      el.removeEventListener("seeked", done);
      after();
    };
    const tm = setTimeout(done, 1500);
    el.addEventListener("seeked", done);
    try {
      if (!el.paused) el.pause();
      // Same currentTime does not fire seeked — nudge so the decoder must present mt.
      if (Math.abs(el.currentTime - mt) < 1e-4) {
        const nudge = mt >= 0.001 ? mt - 0.001 : mt + 0.001;
        try { el.currentTime = nudge; } catch { }
      }
      assignVideoTime(el, mt, true);
    } catch { done(); }
  });
}
/** Play forward until a *presented* frame reaches mt. Pause afterwards unless
    keepPlaying — a free-running element overruns while JPEG encode/HTTP stalls. */
function playAdvanceVideo(el, mt, eps, rate, { keepPlaying } = {}) {
  return new Promise((res, rej) => {
    let settled = false;
    let rvfcId = null;
    let poll = null;
    if (el._fcPrevMuted == null) el._fcPrevMuted = el.muted;
    const wasPlaying = !el.paused;
    const slop = Math.min(eps, 0.002);
    const cleanup = () => {
      clearTimeout(tm);
      if (poll) { clearInterval(poll); poll = null; }
      if (rvfcId != null && typeof el.cancelVideoFrameCallback === "function") {
        try { el.cancelVideoFrameCallback(rvfcId); } catch { }
        rvfcId = null;
      }
      if (!keepPlaying) {
        try { el.pause(); } catch { }
      }
    };
    const finish = (presented) => {
      if (settled) return;
      if (!Number.isFinite(presented)) return;
      settled = true;
      notePresented(el, presented);
      cleanup();
      // Presented picture is authoritative — currentTime often runs ahead of
      // the displayed frame. Accept when within [mt-slop, mt]; hard-seek when
      // play-ahead overshoots past mt or the picture is still short.
      const pictureShort = presented < mt - slop * 2;
      const pictureOvershoot = presented > mt;
      if (pictureOvershoot
        || (pictureShort && Math.abs(el.currentTime - mt) > Math.max(eps * 2, 0.008)))
        hardSeekVideo(el, mt).then(res, rej);
      else res();
    };
    if (presentedClose(el, mt, slop) && el.readyState >= 2) {
      if (!keepPlaying) { try { el.pause(); } catch { } }
      res();
      return;
    }
    const remain = Math.max(0, mt - el.currentTime);
    const tm = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      hardSeekVideo(el, mt).then(res, rej);
    }, Math.min(3000, 400 + (remain * 1000) / Math.max(0.1, rate) * 2.5));
    const check = (mediaTime) => {
      // Presented frame only — currentTime finishes half a frame early and
      // canvas still holds the previous picture (duplicate Fast frames).
      if (mediaTime != null && mediaTime >= mt - slop) finish(mediaTime);
    };
    try { el.playbackRate = clamp(rate, 0.1, 8); } catch { }
    // muted → autoplay-friendly after async export setup (user-gesture may be gone)
    el.muted = true;
    if (typeof el.requestVideoFrameCallback === "function") {
      const onFrame = (_now, meta) => {
        if (settled) return;
        check(meta?.mediaTime);
        if (!settled) rvfcId = el.requestVideoFrameCallback(onFrame);
      };
      rvfcId = el.requestVideoFrameCallback(onFrame);
    } else {
      poll = setInterval(() => check(el.currentTime), 4);
    }
    if (wasPlaying) return;
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        if (settled) return;
        settled = true;
        cleanup();
        hardSeekVideo(el, mt).then(res, rej);
      });
    }
  });
}
const EXPORT_PREFETCH_S = 1.25;
function prefetchExportVideos(t) {
  for (const c of project.clips) {
    if (c.kind !== "video" || !clipRenders(c)) continue;
    if (activeAt(c, t)) continue;
    if (c.start > t + EXPORT_PREFETCH_S || clipEnd(c) <= t) continue;
    const el = getClipEl(c);
    if (!el) continue;
    const mt = mediaTimeAt(c, Math.max(t, c.start));
    if (Math.abs(el.currentTime - mt) < 0.08) continue;
    try {
      if (!el.paused) el.pause();
      assignVideoTime(el, mt);
    } catch { }
  }
}
async function seekVideosTo(t, { queueBusy } = {}) {
  const fps = projectFps();
  const frameMs = 1000 / fps;
  const { fast, behind } = exportLoopLag(frameMs);
  exportSeekClock = performance.now();
  // Stay in play() only when the last tick was fast, the encode queue is not
  // deep, and we are not falling behind — avoids random mid-shot seek hitches
  // from pausing on every JPEG/upload blip.
  const keepPlaying = fast && !behind && !queueBusy;
  const waits = [];
  const restoreGain = [];
  for (const c of project.clips) {
    if (c.kind !== "video") continue;
    if (!clipRenders(c)) continue;
    const el = getClipEl(c); if (!el) continue;
    if (!activeAt(c, t)) {
      if (!el.paused) el.pause();
      if (el._fcPrevMuted != null) {
        try { el.muted = el._fcPrevMuted; } catch { }
        el._fcPrevMuted = null;
      }
      const chain = runtime.clipGain.get(c.id);
      if (chain?.vol) driveClipChain(chain, c, evalProps(c, t), t);
      continue;
    }
    const mt = mediaTimeAt(c, t);
    const local = clamp(t - c.start, 0, c.duration);
    const sp = clamp(kfChannel(c, "speed", local, clipSpeed(c)), 0.1, 8);
    // One timeline frame in media-time
    const mediaFrame = sp / fps;
    const eps = 0.5 * mediaFrame;
    const slop = Math.min(eps, 0.002);
    // Skip only when the *presented* picture is already the target. currentTime
    // within ½ frame is not enough — Fast export used to snapshot the previous
    // decoded frame twice while the clock had already ticked.
    if (el.readyState >= 2 && presentedClose(el, mt, slop)) {
      if (keepPlaying && !el.paused) {
        try { el.playbackRate = sp; } catch { }
      }
      continue;
    }

    const chain = runtime.clipGain.get(c.id);
    if (chain?.vol) {
      muteClipChain(chain);
      restoreGain.push(c);
    }

    const delta = mt - el.currentTime;
    const alreadyPlaying = !el.paused;
    const maxPlay = alreadyPlaying || keepPlaying
      ? Math.min(3, Math.max(2, mediaFrame * 60))
      : Math.min(1, Math.max(0.5, mediaFrame * 16));
    const canPlayFwd = delta > eps && delta <= maxPlay
      && (alreadyPlaying || (el.readyState >= 2 && videoRangeBuffered(el, el.currentTime, mt)));
    if (canPlayFwd) {
      waits.push(playAdvanceVideo(el, mt, eps, sp, { keepPlaying }));
    } else {
      waits.push(hardSeekVideo(el, mt));
    }
  }
  await Promise.all(waits);
  for (const c of restoreGain) {
    const chain = runtime.clipGain.get(c.id);
    if (chain?.vol) driveClipChain(chain, c, evalProps(c, t), t);
  }
  prefetchExportVideos(t);
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
/* Mix all audio-bearing clips offline through the same graph as preview
   (clip chains → track buses → master fader), honoring volume / pan keyframes
   and fades. t0/t1 are timeline seconds (export window); mix time 0 is t0. */
const FX_AUTOMATION_STEP = 0.02; // export automation resolution, seconds
async function renderAudioMix(t0, t1) {
  const jobs = [];
  for (const c of project.clips) {
    if (c.kind !== "audio" && c.kind !== "video") continue;
    if (!clipRenders(c)) continue;
    const m = getMedia(c.mediaId); if (!m) continue;
    jobs.push(getAudioBuffer(m).then((buf) => ({ c, buf })).catch(() => null));
  }
  const sources = (await Promise.all(jobs)).filter(Boolean);
  if (!sources.length) return null;
  const dur = Math.max(0, t1 - t0);
  if (dur <= 0) return null;
  const sr = 48000;
  const off = new OfflineAudioContext(2, Math.ceil(dur * sr) + 1, sr);
  await loadFxWorklet(off); // gate / limiter render in the export too
  const mix = buildMixBuses(off, audioTrackIds(), busIdsNow());
  applyMixLevels(mix);
  mix.masterOut.connect(off.destination);
  let scheduled = false;
  const exportChains = [];
  for (const { c, buf } of sources) {
    const a = Math.max(c.start, t0), b = Math.min(c.start + c.duration, t1);
    if (b - a <= 1e-6) continue;
    const mixWhen = Math.max(0, a - t0);
    const mixDur = b - a;
    const local0 = a - c.start;
    const src = off.createBufferSource(); src.buffer = buf;
    const chain = buildClipChain(off, src, c, buf.numberOfChannels);
    exportChains.push({ chain, c });
    const n = Math.max(2, Math.ceil(mixDur * 30));
    const volCurve = new Float32Array(n);
    const panCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ep = evalProps(c, a + (i / (n - 1)) * mixDur);
      volCurve[i] = clipAudioGain(ep);
      panCurve[i] = clipPan(ep.pan);
    }
    chain.vol.gain.setValueCurveAtTime(volCurve, mixWhen, Math.max(0.01, mixDur));
    if (chain.pan) {
      try {
        chain.pan.pan.setValueCurveAtTime(panCurve, mixWhen, Math.max(0.01, mixDur));
      } catch {
        chain.pan.pan.value = panCurve[0] ?? 0;
      }
    }
    chain.out.connect(mix.trackBus[c.track] || mix.master);
    if (hasSpeedRamp(c)) {
      const rc = new Float32Array(n);
      for (let i = 0; i < n; i++)
        rc[i] = clamp(kfChannel(c, "speed", local0 + (i / (n - 1)) * mixDur, clipSpeed(c)), 0.1, 8);
      src.playbackRate.setValueCurveAtTime(rc, mixWhen, Math.max(0.01, mixDur));
      src.start(mixWhen, Math.max(0, mediaTimeAt(c, a)));
      src.stop(mixWhen + mixDur);
    } else {
      const sp = clipSpeed(c);
      src.playbackRate.value = sp;
      src.start(mixWhen, Math.max(0, c.in + local0 * sp), mixDur * sp);
    }
    scheduled = true;
  }
  if (!scheduled) return null;
  // Effect automation: step the offline render and glide each keyed
  // parameter, the same way preview drives it every frame.
  const animated = [];
  for (const { chain, c } of exportChains) if (FableCutFx.hasKeys(c.fx)) animated.push((t) => animateFxSlot(chain.fxSlot, t - c.start));
  if (FableCutFx.hasKeys(masterFx()) || Object.keys(mix.trackBus).some((id) => FableCutFx.hasKeys(trackFx(id))) ||
      (project.buses || []).some((b) => FableCutFx.hasKeys(b.fx)))
    animated.push((t) => animateMixFx(mix, t));
  if (animated.length) {
    for (const run of animated) run(t0);
    // jump to the first values, then glide
    for (const { chain, c } of exportChains) if (FableCutFx.hasKeys(c.fx)) animateFxSlot(chain.fxSlot, t0 - c.start, false);
    animateMixFx(mix, t0, false);
    const step = FX_AUTOMATION_STEP;
    for (let k = 1; k * step < dur; k++) {
      const when = k * step;
      off.suspend(when).then(() => { for (const run of animated) run(t0 + when); off.resume(); });
    }
  }
  return encodeWAV(await off.startRendering());
}
/* Frame-exact asset prep for the fast exporter: rasterize the SVG frame for
   this exact time, and refresh AI person masks synchronously. */
async function prepareFrameAssets(t) {
  for (const c of project.clips) {
    if (!activeAt(c, t) || !clipRenders(c)) continue;
    if (c.kind === "svg") await prepareSvgFrame(c, t);
    if (c.props?.bgRemove && (c.kind === "video" || c.kind === "image")) {
      const el = c.kind === "video" ? getClipEl(c) : runtime.mediaAux.get(c.mediaId)?.img;
      if (el) { try { await requestMask(c.id, el, true); } catch { } }
    }
  }
}
/** opts.job: an agent's export job id — progress and the result go back to
 *  the server instead of an alert / download (nobody may be watching).
 *  opts.profile: encoding profile id for this run. */
async function fastExport(opts = {}) {
  if (state.exporting) return;
  const job = opts.job || null;
  pause();
  state.exporting = true; state.rendering = true; renderCancelled = false;
  exportAbort = new AbortController();
  const signal = exportAbort.signal;
  els.exportOverlay.classList.remove("hidden");
  els.exportProgress.style.width = "0%";
  els.exportNote.textContent = "Rendering frames → ffmpeg. You can switch tabs; export continues.";
  restoreExportVideoState();
  const { start: t0, end: t1, frames } = beginExportWindow();
  const fps = projectFps();
  let sessId = null;
  let uploadError = null;
  const setError = (err) => { if (!uploadError) uploadError = err; };
  try {
    els.exportTitle.textContent = "Mixing audio…";
    const wav = await renderAudioMix(t0, t1);
    if (renderCancelled) throw new Error("cancelled");
    const profileId = job ? (opts.profile || effectiveEncodeProfileId())
      : els.exportProfileSel?.value || effectiveEncodeProfileId();
    const jpegQ = exportProfileMeta(profileId).jpegQuality ?? 0.95;
    const begin = await fetch("/api/export/begin", {
      method: "POST",
      body: JSON.stringify({
        fps,
        name: project.name.replace(/[^\w\- ]+/g, "") || "export",
        profile: profileId,
        hasAudio: !!wav,
      }),
      signal,
    }).then((r) => r.json());
    if (!begin.id) throw new Error(begin.error || "export begin failed");
    sessId = begin.id;
    if (wav) {
      const r = await fetch("/api/export/audio?id=" + sessId, { method: "POST", body: wav, signal });
      if (!r.ok) throw new Error("audio upload failed");
    }
    await loadProjectFonts();
    resetExportCanvases();
    await armExportCors();
    // JPEG off the compositor thread: snapshot is sync, encode/upload run ahead
    // under backpressure. Awaiting toBlob every frame was slower than ffmpeg.
    const up = createExportUploader(sessId, {
      batchItems: 8, batchBytes: 512 * 1024, signal,
      getError: () => uploadError, setError,
    });
    const workers = createJpegWorkers(Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));
    let pixelChain = Promise.resolve();
    let pixelsInflight = 0;
    const waitPixels = (max) => new Promise((res, rej) => {
      const tick = () => {
        if (renderCancelled || signal.aborted) { clearInterval(poll); rej(new Error("cancelled")); }
        else if (uploadError) { clearInterval(poll); rej(uploadError); }
        else if (pixelsInflight <= max) { clearInterval(poll); res(); }
      };
      const poll = setInterval(tick, 4);
      tick();
    });
    try {
    for (let f = 0; f < frames; f++) {
      if (renderCancelled || signal.aborted) throw new Error("cancelled");
      if (uploadError) throw uploadError;
      // Let workers run ahead; only pause the decoder when the queue is deep
      // enough that play-ahead would overrun during the wait (not on every blip).
      const queueBusy = pixelsInflight > 6 || up.inFlight() > 4;
      if (pixelsInflight > 4) pauseExportVideos();
      await waitPixels(6);
      await up.waitBackpressure(4);
      const t = t0 + f / fps;
      state.time = t;
      await seekVideosTo(t, { queueBusy });
      await prepareFrameAssets(t);
      drawFrame(t);
      const snap = snapshotExportFrame();
      pixelsInflight++;
      let jpegP;
      if (snap.kind === "bmp") {
        jpegP = workers ? workers.encode(snap.bmp, jpegQ) : jpegFromBitmap(snap.bmp, jpegQ);
      } else {
        const c = document.createElement("canvas");
        c.width = snap.w; c.height = snap.h;
        c.getContext("2d", { alpha: false }).putImageData(new ImageData(snap.data, snap.w, snap.h), 0, 0);
        jpegP = new Promise((res, rej) => {
          try {
            c.toBlob((b) => {
              if (!b) return rej(new Error("frame encode failed"));
              b.arrayBuffer().then(res, rej);
            }, "image/jpeg", jpegQ);
          } catch (e) { rej(canvasTaintError(e)); }
        });
      }
      pixelChain = pixelChain.then(async () => {
        if (renderCancelled || signal.aborted) throw new Error("cancelled");
        if (uploadError) throw uploadError;
        const buf = await jpegP;
        if (!buf || !(buf.byteLength || buf.size || buf.length)) throw new Error("frame encode failed");
        up.push(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
      }).catch((err) => { setError(err); throw err; }).finally(() => { pixelsInflight--; });
      const pct = ((f + 1) / frames) * 100;
      els.exportProgress.style.width = pct.toFixed(1) + "%";
      els.exportTitle.textContent = `Rendering… ${pct.toFixed(0)}%`;
      if (job) reportExportJob(job, { progress: 0.97 * (f + 1) / frames });
    }
    await pixelChain;
    if (uploadError) throw uploadError;
    els.exportTitle.textContent = "Encoding…";
    await up.done();
    if (uploadError) throw uploadError;
    } finally {
      try { workers?.terminate(); } catch { }
    }
    const end = await fetch("/api/export/end?id=" + sessId, { method: "POST", signal }).then((r) => r.json());
    if (!end.src) throw new Error(end.error || "encode failed");
    if (job) await reportExportJob(job, { status: "done", src: end.src }, true);
    else {
      const a = document.createElement("a");
      a.href = end.src;
      a.download = decodeURIComponent(end.src.split("/").pop());
      a.click();
    }
  } catch (e) {
    if (sessId) fetch("/api/export/end?id=" + sessId + "&discard=1", { method: "POST" }).catch(() => { });
    const msg = e?.name === "AbortError" ? "cancelled" : String(e.message || e);
    if (job) await reportExportJob(job, { status: "failed", error: msg }, true);
    else if (msg !== "cancelled") alert("Export failed: " + msg);
  } finally {
    exportAbort = null;
    restoreExportVideoState();
    endExportWindow();
    state.exporting = false; state.rendering = false;
    els.exportOverlay.classList.add("hidden");
    els.exportNote.textContent = "Rendering your sequence in real time. Keep this tab focused.";
    if (runtime.pendingSync) syncFromServer();
  }
}

/* ── Agent-requested export (fablecut_export · POST /api/export/request) ──
   The server hands a job to an open tab over SSE, or opens a headless one on
   ?exportJob=<id>. The first tab to claim it waits until it has loaded the
   revision the agent asked for, then runs Fast export with the job's range
   and profile and reports back. A cancel from the agent arrives as the reply
   to a progress report. */
let exportJobReportAt = 0;
async function reportExportJob(id, body, force = false) {
  const now = performance.now();
  if (!force && now - exportJobReportAt < 1000) return; // a heartbeat, not a stream
  exportJobReportAt = now;
  try {
    const r = await fetch("/api/export/job/report?id=" + encodeURIComponent(id), {
      method: "POST", body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r?.cancel) { renderCancelled = true; exportAbort?.abort(); }
  } catch { }
}
async function runExportJob(ticket) {
  if (!ticket?.id || state.exporting) return; // a busy tab leaves it for another
  const claimed = await fetch("/api/export/job/claim?id=" + encodeURIComponent(ticket.id), { method: "POST" })
    .then((r) => r.ok).catch(() => false);
  if (!claimed) return;
  const fail = (error) => reportExportJob(ticket.id, { status: "failed", error }, true);
  // The agent's last edit may still be on its way here over SSE.
  for (let i = 0; i < 150 && ticket.revision != null && (project.revision || 0) < ticket.revision; i++)
    await new Promise((r) => setTimeout(r, 100));
  if (ticket.revision != null && (project.revision || 0) < ticket.revision) await syncFromServer();
  if (!state.ffmpeg) {
    const j = await fetch("/api/export/ffmpeg").then((r) => r.json()).catch(() => ({}));
    state.ffmpeg = !!j.available;
  }
  if (!state.ffmpeg) return fail("ffmpeg not found on PATH — export needs it");
  if (!project.clips.length) return fail("the timeline is empty");
  await fetchEncodeProfiles();
  await probeMissingMeta();
  if (ticket.range === "in-out" && !hasWorkArea())
    return fail("range in-out needs the project's inPoint and/or outPoint — set them, or export the entire timeline");
  exportRangeForced = ticket.range || (hasWorkArea() ? "in-out" : "entire");
  try {
    if (exportRange().frames < 1) return fail("the export range is empty — IN/OUT is at or past the end of the timeline");
    reportExportJob(ticket.id, { progress: 0 }, true);
    await fastExport({ job: ticket.id, profile: ticket.profile });
  } finally {
    exportRangeForced = null;
  }
}
/** A headless page opened for one job (?exportJob=<id>) fetches and runs it. */
async function runExportJobFromUrl() {
  const id = new URLSearchParams(location.search).get("exportJob");
  if (!id || !state.connected) return;
  const ticket = await fetch("/api/export/job/ticket?id=" + encodeURIComponent(id)).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (ticket?.status === "pending") runExportJob(ticket);
}

/* ── WebCodecs export (browser H.264 → server mux) ── */
function waitEncodeQueue(encoder, max = 2, { signal, getError } = {}) {
  const cancelled = () => renderCancelled || !!(signal && signal.aborted);
  const failed = () => (getError ? getError() : null);
  if (cancelled()) return Promise.reject(new Error("cancelled"));
  {
    const err = failed();
    if (err) return Promise.reject(err);
  }
  if (encoder.encodeQueueSize <= max) return Promise.resolve();
  return new Promise((res, rej) => {
    const done = (err) => {
      clearInterval(poll);
      encoder.ondequeue = null;
      err ? rej(err) : res();
    };
    const tick = () => {
      if (cancelled()) done(new Error("cancelled"));
      else {
        const err = failed();
        if (err) done(err);
        else if (encoder.encodeQueueSize <= max) done(null);
      }
    };
    encoder.ondequeue = tick;
    // ondequeue alone won't notice Cancel / encoder·upload failure — poll
    const poll = setInterval(tick, 50);
    tick();
  });
}
async function webCodecsExport() {
  if (state.exporting) return;
  await detectWebCodecs();
  if (!state.webCodecs) { startExport(); return; }
  pause();
  state.exporting = true; state.rendering = true; renderCancelled = false;
  exportAbort = new AbortController();
  const signal = exportAbort.signal;
  els.exportOverlay.classList.remove("hidden");
  els.exportProgress.style.width = "0%";
  els.exportNote.textContent = "Encoding with WebCodecs → ffmpeg mux. You can switch tabs; export continues.";
  restoreExportVideoState();
  const { start: t0, end: t1, frames } = beginExportWindow();
  const fps = projectFps();
  const keyEvery = Math.max(1, Math.round(fps * 2));
  let sessId = null;
  let encoder = null;
  let uploadError = null;
  const setError = (err) => { if (!uploadError) uploadError = err; };
  let up = null;
  try {
    els.exportTitle.textContent = "Mixing audio…";
    const wav = await renderAudioMix(t0, t1);
    if (renderCancelled) throw new Error("cancelled");

    const begin = await fetch("/api/export/begin", {
      method: "POST",
      body: JSON.stringify({
        fps,
        name: project.name.replace(/[^\w\- ]+/g, "") || "export",
        mode: "annexb",
        hasAudio: !!wav,
      }),
      signal,
    }).then((r) => r.json());
    if (!begin.id) throw new Error(begin.error || "export begin failed");
    sessId = begin.id;
    if (wav) {
      const r = await fetch("/api/export/audio?id=" + sessId, { method: "POST", body: wav, signal });
      if (!r.ok) throw new Error("audio upload failed");
    }
    up = createExportUploader(sessId, {
      batchItems: 12, batchBytes: 128 * 1024, signal,
      getError: () => uploadError, setError,
    });

    // Always encode at project/frame resolution (not display CSS size).
    const w = Math.max(2, project.width | 0 || 1280);
    const h = Math.max(2, project.height | 0 || 720);
    if (els.preview.width !== w || els.preview.height !== h) {
      els.preview.width = w;
      els.preview.height = h;
    }
    const codec = webCodecsAvcCodec();
    const bitrate = webCodecsBitrate(w, h, fps);
    const bitrateMode = getSetting("webCodecsBitrateMode") === "constant" ? "constant" : "variable";
    encoder = new VideoEncoder({
      output: (chunk) => {
        if (uploadError || renderCancelled || signal.aborted) return;
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        up.push(buf);
      },
      error: (e) => { uploadError = e; },
    });
    encoder.configure({
      codec, width: w, height: h, bitrate, bitrateMode, framerate: fps,
      avc: { format: "annexb" },
      latencyMode: "quality",
    });
    await loadProjectFonts();
    resetExportCanvases();
    await armExportCors();

    for (let f = 0; f < frames; f++) {
      if (renderCancelled || signal.aborted) throw new Error("cancelled");
      if (uploadError) throw uploadError;
      const queueBusy = up.inFlight() > 4 || encoder.encodeQueueSize > 4;
      if (up.inFlight() > 3 || encoder.encodeQueueSize > 3) pauseExportVideos();
      await up.waitBackpressure(4);
      await waitEncodeQueue(encoder, 4, { signal, getError: () => uploadError });
      const t = t0 + f / fps;
      state.time = t;
      await seekVideosTo(t, { queueBusy });
      await prepareFrameAssets(t);
      drawFrame(t);
      // Absolute µs timestamps; duration = delta so average rate stays exact
      // (constant Math.round(1e6/fps) drifts, e.g. 33333µs → avg 1000000/33333).
      const ts = Math.round(f * 1e6 / fps);
      let frame;
      try {
        frame = new VideoFrame(els.preview, {
          timestamp: ts,
          duration: Math.round((f + 1) * 1e6 / fps) - ts,
        });
      } catch (e) {
        if (e && (e.name === "SecurityError" || /taint/i.test(String(e.message || e))))
          throw new Error("Tainted canvas — a clip is from another origin (not /media or /library) without CORS. Import the file into the project, or serve it with Access-Control-Allow-Origin.");
        throw e;
      }
      try {
        encoder.encode(frame, { keyFrame: f === 0 || f % keyEvery === 0 });
      } finally {
        frame.close();
      }
      const pct = ((f + 1) / frames) * 100;
      els.exportProgress.style.width = pct.toFixed(1) + "%";
      els.exportTitle.textContent = `Encoding… ${pct.toFixed(0)}%`;
    }
    els.exportTitle.textContent = "Finishing…";
    await encoder.flush();
    await up.done();
    if (uploadError) throw uploadError;
    encoder.close();
    encoder = null;
    const end = await fetch("/api/export/end?id=" + sessId, { method: "POST", signal }).then((r) => r.json());
    if (!end.src) throw new Error(end.error || "mux failed");
    const a = document.createElement("a");
    a.href = end.src;
    a.download = decodeURIComponent(end.src.split("/").pop());
    a.click();
  } catch (e) {
    try { encoder?.close(); } catch { }
    if (sessId) fetch("/api/export/end?id=" + sessId + "&discard=1", { method: "POST" }).catch(() => { });
    const msg = e?.name === "AbortError" ? "cancelled" : String(e.message || e);
    if (msg !== "cancelled") alert("Export failed: " + msg);
  } finally {
    exportAbort = null;
    restoreExportVideoState();
    endExportWindow();
    state.exporting = false; state.rendering = false;
    els.exportOverlay.classList.add("hidden");
    els.exportNote.textContent = "Rendering your sequence in real time. Keep this tab focused.";
    if (runtime.pendingSync) syncFromServer();
  }
}

/* ── Realtime export (MediaRecorder offline / unsupported fallback) ── */
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
  const { start } = beginExportWindow();
  state.time = start;
  seekMediaWhilePaused();
  await new Promise((r) => setTimeout(r, 350)); // let first frames decode
  await loadProjectFonts();
  const stream = els.preview.captureStream(projectFps());
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
  pauseSource();
  setMonitorMode("program");
  state.playing = true;
  syncPlayButton();
}
function finishExport(keep) {
  if (!state.exporting) return;
  state.exporting = false;
  endExportWindow();
  if (runtime.pendingSync) syncFromServer();
  recDiscard = !keep;
  state.playing = false;
  syncPlayButton();
  for (const el of runtime.clipEls.values()) { if (!el.paused) el.pause(); }
  if (recorder && recorder.state !== "inactive") recorder.stop();
  else els.exportOverlay.classList.add("hidden");
}

/* ═══════════════════════════ WIRING ═══════════════════════════ */
els.fileInput.addEventListener("change", () => { importFiles(els.fileInput.files); els.fileInput.value = ""; });
$("btnImportUrl")?.addEventListener("click", openImportUrl);
$("btnCancelImportUrl")?.addEventListener("click", closeImportUrl);
$("btnDoImportUrl")?.addEventListener("click", () => importFromUrl(els.importUrlInput?.value));
els.importUrlInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); importFromUrl(els.importUrlInput.value); }
});
els.importUrlOverlay?.addEventListener("click", (e) => {
  if (e.target === els.importUrlOverlay) closeImportUrl();
});
$("btnTitle").addEventListener("click", addTitle);
$("btnAdjust").addEventListener("click", addAdjust);
$("btnSplit").addEventListener("click", splitAtPlayhead);
$("btnCloseGap").addEventListener("click", closeGapAtPlayhead);
$("btnLift").addEventListener("click", () => liftExtract(false));
$("btnExtract").addEventListener("click", () => liftExtract(true));
$("btnNextGap").addEventListener("click", goToNextGap);
$("btnTrimIO").addEventListener("click", trimToWorkArea);
$("btnWorkAreaPlay").addEventListener("click", () => {
  state.workAreaPlay = !state.workAreaPlay;
  syncTrimIOButton();
});
$("btnDelete").addEventListener("click", () => {
  if (!clearFocusedTransition()) deleteSelected();
});
$("btnRippleDelete").addEventListener("click", () => {
  if (!clearFocusedTransition()) rippleDeleteSelected();
});
$("btnExport").addEventListener("click", openExportSetup);
$("btnStartExport").addEventListener("click", startChosenExport);
els.exportSetup?.addEventListener("change", (e) => {
  if (e.target.name === "engine") {
    syncExportProfileVisibility();
    syncExportWcOpts();
  }
  if (e.target.id === "exportRangeSel") syncExportRangeUi();
});
els.exportProfileSel?.addEventListener("change", (e) => {
  const id = e.target.value;
  if (!project.encodeProfile) {
    setSetting("encodeProfile", id === encodeProfiles.default ? null : id);
  }
  updateExportProfileNote(id);
});
$("btnCancelSetup").addEventListener("click", () => els.exportSetup.classList.add("hidden"));
els.engineFast?.addEventListener("change", syncExportWcOpts);
els.engineRealtime?.addEventListener("change", syncExportWcOpts);
$("exportWcBitrate")?.addEventListener("change", persistExportWcOpts);
$("exportWcMode")?.addEventListener("change", async () => {
  persistExportWcOpts();
  await detectWebCodecs();
  syncExportWcOpts();
  if (!els.exportSetup.classList.contains("hidden")) openExportSetup();
});
$("btnCancelExport").addEventListener("click", () => {
  if (state.rendering) {
    renderCancelled = true;
    try { exportAbort?.abort(); } catch { }
  } else finishExport(false);
});
$("btnPlay").addEventListener("click", toggleTransportPlay);
els.btnSpeed.addEventListener("click", () => cyclePreviewRate(1));
$("btnHome").addEventListener("click", gotoTransportHome);
$("btnEnd").addEventListener("click", gotoTransportEnd);
$("btnBack").addEventListener("click", () => stepTransport(-1));
$("btnFwd").addEventListener("click", () => stepTransport(1));
$("btnMarkIn").addEventListener("click", markIn);
$("btnMarkOut").addEventListener("click", markOut);
els.btnInsert?.addEventListener("click", () => insertSourceAtPlayhead());
els.btnReplace?.addEventListener("click", () => replaceSourceAtPlayhead());
$("monitorModeGroup")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-monitor-mode]");
  if (!btn) return;
  if (btn.dataset.monitorMode === "source" && !state.source.mediaId) {
    setMonitorMode("source");
    toast("Double-click a clip in Project or the timeline to load Source");
    return;
  }
  setMonitorMode(btn.dataset.monitorMode);
});
function sourceScrubAtEvent(e) {
  const track = els.sourceScrubTrack;
  if (!track) return 0;
  const r = track.getBoundingClientRect();
  const u = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
  return u * sourceDur();
}
function startSourceScrub(e) {
  if (!state.source.mediaId) return;
  e.preventDefault();
  pauseSource();
  setSourceTime(sourceScrubAtEvent(e));
  const onMove = (ev) => setSourceTime(sourceScrubAtEvent(ev));
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
els.sourceScrubTrack?.addEventListener("pointerdown", startSourceScrub);
$("btnHelp").addEventListener("click", () => $("helpOverlay").classList.remove("hidden"));
$("btnCloseHelp").addEventListener("click", () => $("helpOverlay").classList.add("hidden"));
function settingsFocusables() {
  const root = $("settingsDialog");
  if (!root) return [];
  return [...root.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((el) => !el.disabled && el.getClientRects().length);
}
function onSettingsTabTrap(e) {
  if (e.key !== "Tab") return;
  const list = settingsFocusables();
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
function openSettings() {
  const cb = $("setLinkSelect");
  if (cb) cb.checked = !!getSetting("linkSelect");
  const overlay = $("settingsOverlay");
  overlay.classList.remove("hidden");
  overlay.addEventListener("keydown", onSettingsTabTrap);
  const dialog = $("settingsDialog");
  (cb || dialog)?.focus();
}
function closeSettings() {
  const overlay = $("settingsOverlay");
  overlay.removeEventListener("keydown", onSettingsTabTrap);
  overlay.classList.add("hidden");
  $("btnSettings")?.focus();
}
$("btnSettings").addEventListener("click", openSettings);
$("btnCloseSettings").addEventListener("click", closeSettings);
$("settingsOverlay").addEventListener("click", (e) => {
  if (e.target === $("settingsOverlay")) closeSettings();
});
$("setLinkSelect").addEventListener("change", (e) => {
  setSetting("linkSelect", !!e.target.checked);
  if (!getSetting("linkSelect")) {
    clearBinSelectionHighlight();
    return;
  }
  if (selectedMediaIds().size && state.binTab !== "project") setBinTab("project");
  syncBinSelectionFromTimeline();
});
els.btnSnap.addEventListener("click", () => {
  state.snap = !state.snap;
  els.btnSnap.classList.toggle("on", state.snap);
});
els.btnSnapMenu.addEventListener("click", () => openSnapMenu(els.btnSnap));
els.btnMarkers.addEventListener("click", () => openMarkerList(els.btnMarkers));
if (els.btnAudioHold) {
  els.btnAudioHold.addEventListener("click", () => setAudioHold(!state.audioHold));
}
$("btnLayoutReset").addEventListener("click", restoreDefaultLayout);
$("trackSizeGroup").addEventListener("click", (e) => {
  const b = e.target.closest("[data-track-size]");
  if (b) setTrackSize(b.dataset.trackSize);
});
els.binTabs.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) setBinTab(b.dataset.tab);
});
/* Right-click the Project tab → New folder */
function closeBinCtxMenu() {
  if (!runtime.binCtxMenu) return;
  runtime.binCtxMenu.remove();
  runtime.binCtxMenu = null;
  document.removeEventListener("pointerdown", onBinCtxDoc, true);
}
function onBinCtxDoc(e) {
  if (runtime.binCtxMenu && !runtime.binCtxMenu.contains(e.target)) closeBinCtxMenu();
}
function openProjectTabMenu(clientX, clientY) {
  closeBinCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const item = document.createElement("div");
  item.className = "ctx-opt";
  item.textContent = "New folder";
  item.addEventListener("click", () => {
    closeBinCtxMenu();
    if (state.binTab !== "project") setBinTab("project");
    addFolder(null);
  });
  menu.appendChild(item);
  document.body.appendChild(menu);
  const pad = 6;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(clientX, window.innerWidth - w - pad) + "px";
  menu.style.top = Math.min(clientY, window.innerHeight - h - pad) + "px";
  runtime.binCtxMenu = menu;
  document.addEventListener("pointerdown", onBinCtxDoc, true);
}
els.binTabs.addEventListener("contextmenu", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b || b.dataset.tab !== "project") return;
  e.preventDefault();
  openProjectTabMenu(e.clientX, e.clientY);
});

/* ── Canvas aspect presets + project FPS + safe-area guides ── */
function syncAspectSel() {
  if (!els.aspectSel) return;
  const i = ASPECT_PRESETS.findIndex((a) => a.w === project.width && a.h === project.height);
  els.aspectSel.innerHTML =
    ASPECT_PRESETS.map((a, j) => `<option value="${j}" ${j === i ? "selected" : ""}>${a.label}</option>`).join("") +
    (i < 0 ? `<option value="custom" selected>Custom · ${project.width}×${project.height}</option>` : "");
}
function syncFpsSel() {
  if (!els.fpsSel) return;
  const fps = Number(project.fps);
  const i = FPS_PRESETS.findIndex((v) => v === fps);
  els.fpsSel.innerHTML =
    FPS_PRESETS.map((v, j) => `<option value="${j}" ${j === i ? "selected" : ""}>${v} fps</option>`).join("") +
    (i < 0 && Number.isFinite(fps) && fps > 0
      ? `<option value="custom" selected>Custom · ${fps} fps</option>`
      : "");
}
els.aspectSel.addEventListener("change", () => {
  const a = ASPECT_PRESETS[+els.aspectSel.value];
  if (!a) return;
  project.width = a.w; project.height = a.h;
  els.preview.width = a.w; els.preview.height = a.h;
  if (project.exportFrame)
    project.exportFrame = normalizeExportFrame(project.exportFrame, a.w, a.h);
  updateMonitorRes();
  syncAspectSel();
  syncExportFrameSel();
  updateExportFrameOverlay();
  seekMediaWhilePaused();
  scheduleSave();
});
els.fpsSel?.addEventListener("change", () => {
  const v = FPS_PRESETS[+els.fpsSel.value];
  if (!(v > 0)) return;
  project.fps = v;
  syncFpsSel();
  updateMonitorRes();
  state.dirtyTimeline = true;
  seekMediaWhilePaused();
  scheduleSave();
});
els.exportFrameSel?.addEventListener("change", () => {
  const v = els.exportFrameSel.value;
  if (v === "custom") return;
  const preset = EXPORT_FRAME_ASPECTS[+v];
  if (!preset) return;
  if (!preset.w) project.exportFrame = null;
  else project.exportFrame = fitExportFrameAspect(preset.w, preset.h);
  state.exportFrameView = !!getExportFrame();
  els.btnExportFrame?.classList.toggle("on", state.exportFrameView && !!getExportFrame());
  updateMonitorRes();
  syncExportFrameSel();
  updateExportFrameOverlay();
  scheduleSave();
});
els.btnExportFrame?.addEventListener("click", () => {
  if (!getExportFrame()) {
    const preset = EXPORT_FRAME_ASPECTS[1]; // 9:16 — common reframe default
    project.exportFrame = fitExportFrameAspect(preset.w, preset.h);
    state.exportFrameView = true;
    syncExportFrameSel();
    updateMonitorRes();
    scheduleSave();
  } else if (state.exportFrameView) {
    state.exportFrameView = false;
    syncExportFrameSel();
    updateMonitorRes();
    scheduleSave();
  } else {
    state.exportFrameView = true;
  }
  els.btnExportFrame.classList.toggle("on", state.exportFrameView && !!getExportFrame());
  updateExportFrameOverlay();
});
els.btnExportFrameDim?.addEventListener("click", () => {
  state.exportFrameCrop = !state.exportFrameCrop;
  updateExportFrameOverlay();
});
els.btnGuides.addEventListener("click", () => {
  state.guides = !state.guides;
  els.btnGuides.classList.toggle("on", state.guides);
  els.safeOverlay.classList.toggle("hidden", !state.guides);
  if (state.guides) updateSafeOverlay();
});
/* ── Program-monitor view zoom (wheel) + fit reset ──
   Zoom enlarges the canvas layout size inside a scrollport (native scrollbars),
   not a CSS transform — overflow stays reachable. Pointer mapping via
   getBoundingClientRect still tracks the visible canvas.
   Max zoom = VIEW_PIXEL_MAX screen CSS pixels per canvas pixel. */
const VIEW_ZOOM_MIN = 1;
const VIEW_PIXEL_MAX = 2;
let monitorFitCache = null; // {w,h} fit size captured at zoom start (stable while zoomed)
let monitorViewPad = { x: 0, y: 0 }; // content padding so any canvas point can sit under the cursor
function measureMonitorFit() {
  const sw = els.monitorStage.clientWidth, sh = els.monitorStage.clientHeight;
  const pw = project.width || els.preview.width || 1;
  const ph = project.height || els.preview.height || 1;
  const s = Math.min(sw / pw, sh / ph);
  return { w: pw * s, h: ph * s };
}
function monitorFitSize() {
  if (monitorFitCache) return monitorFitCache;
  const w = els.preview.offsetWidth, h = els.preview.offsetHeight;
  if (w > 0 && h > 0 && state.viewZoom <= 1.001) return { w, h };
  return measureMonitorFit();
}
function maxViewZoom() {
  const { w } = monitorFitSize();
  const pxW = project.width || els.preview.width;
  if (!w || !pxW) return VIEW_ZOOM_MIN;
  return Math.max(VIEW_ZOOM_MIN, VIEW_PIXEL_MAX * pxW / w);
}
function applyMonitorView() {
  const z = state.viewZoom;
  const zoomed = z > 1.001;
  const scroll = els.monitorScroll;
  const inner = els.monitorZoomInner;
  if (!zoomed) {
    state.viewZoom = 1;
    monitorFitCache = null;
    monitorViewPad = { x: 0, y: 0 };
    els.preview.style.width = "";
    els.preview.style.height = "";
    if (inner) inner.style.padding = "";
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  } else {
    if (!monitorFitCache) monitorFitCache = monitorFitSize();
    const fit = monitorFitCache;
    els.preview.style.width = (fit.w * z) + "px";
    els.preview.style.height = (fit.h * z) + "px";
    // Pad by the stage size so scrollLeft can be "negative" relative to the canvas
    // (needed when zooming from a centered fit letterbox without jumping).
    if (!monitorViewPad.x && !monitorViewPad.y) {
      monitorViewPad = {
        x: Math.ceil(els.monitorStage.clientWidth || scroll.clientWidth || 0),
        y: Math.ceil(els.monitorStage.clientHeight || scroll.clientHeight || 0),
      };
    }
    if (inner) inner.style.padding = `${monitorViewPad.y}px ${monitorViewPad.x}px`;
  }
  els.btnZoom100.classList.toggle("hidden", !zoomed);
  scroll.classList.toggle("is-zoomed", zoomed);
  updateSafeOverlay();
  updateExportFrameOverlay();
}
let monitorViewRaf = 0;
let monitorViewAfter = null;
/** Coalesce repeated zoom/pan updates into one paint (updateSafeOverlay ≤ once/frame). */
function scheduleMonitorView(after) {
  if (after) monitorViewAfter = after;
  if (monitorViewRaf) return;
  monitorViewRaf = requestAnimationFrame(() => {
    monitorViewRaf = 0;
    const fn = monitorViewAfter;
    monitorViewAfter = null;
    applyMonitorView();
    if (fn) fn();
  });
}
function resetMonitorView() {
  state.viewZoom = 1;
  monitorFitCache = null;
  monitorViewPad = { x: 0, y: 0 };
  monitorViewAfter = null;
  if (monitorViewRaf) {
    cancelAnimationFrame(monitorViewRaf);
    monitorViewRaf = 0;
  }
  applyMonitorView(); // immediate — don't wait a frame to clear zoom
}
els.btnZoom100.addEventListener("click", resetMonitorView);
els.monitorScroll.addEventListener("wheel", (e) => {
  e.preventDefault();
  const scroll = els.monitorScroll;
  const rect = scroll.getBoundingClientRect();
  const ox = e.clientX - rect.left;
  const oy = e.clientY - rect.top;
  const oldZ = state.viewZoom;
  if (oldZ <= 1.001) {
    monitorFitCache = {
      w: els.preview.offsetWidth || measureMonitorFit().w,
      h: els.preview.offsetHeight || measureMonitorFit().h,
    };
  }
  const fit = monitorFitSize();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const next = clamp(+(oldZ * factor).toFixed(3), VIEW_ZOOM_MIN, maxViewZoom());
  if (Math.abs(next - oldZ) < 1e-4) {
    if (next <= VIEW_ZOOM_MIN) resetMonitorView();
    return;
  }
  // Fraction of the canvas under the cursor (works for centered fit and scrolled zoom).
  const cv = els.preview.getBoundingClientRect();
  const relX = cv.width > 0 ? (e.clientX - cv.left) / cv.width : 0.5;
  const relY = cv.height > 0 ? (e.clientY - cv.top) / cv.height : 0.5;
  state.viewZoom = next;
  if (next <= VIEW_ZOOM_MIN) {
    resetMonitorView();
    return;
  }
  scheduleMonitorView(() => {
    void scroll.scrollWidth; // ensure padding/size are laid out before assigning scroll
    const pad = monitorViewPad;
    scroll.scrollLeft = pad.x + relX * fit.w * next - ox;
    scroll.scrollTop = pad.y + relY * fit.h * next - oy;
  });
}, { passive: false });
/* Pan while zoomed: middle mouse, or Alt+drag — drives native scroll position. */
let viewPanDrag = null;
els.monitorScroll.addEventListener("pointerdown", (e) => {
  if (state.viewZoom <= 1.001) return;
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    const scroll = els.monitorScroll;
    viewPanDrag = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
    scroll.classList.add("is-panning");
    scroll.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
els.monitorScroll.addEventListener("pointermove", (e) => {
  if (!viewPanDrag) return;
  const scroll = els.monitorScroll;
  scroll.scrollLeft = viewPanDrag.sl - (e.clientX - viewPanDrag.x);
  scroll.scrollTop = viewPanDrag.st - (e.clientY - viewPanDrag.y);
});
function endViewPan(e) {
  if (!viewPanDrag) return;
  viewPanDrag = null;
  els.monitorScroll.classList.remove("is-panning");
  try { els.monitorScroll.releasePointerCapture(e.pointerId); } catch { }
}
els.monitorScroll.addEventListener("pointerup", endViewPan);
els.monitorScroll.addEventListener("pointercancel", endViewPan);
els.monitorScroll.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
els.monitorScroll.addEventListener("scroll", () => {
  if (state.guides) updateSafeOverlay();
  if (state.exportFrameView && getExportFrame()) updateExportFrameOverlay();
  scheduleMonitorView();
});
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    fitVuMeter();
    if (state.viewZoom <= 1.001) {
      monitorFitCache = null;
      if (state.guides) updateSafeOverlay();
      if (state.exportFrameView && getExportFrame()) updateExportFrameOverlay();
      return;
    }
    const scroll = els.monitorScroll;
    const relX = scroll.scrollWidth > 0 ? scroll.scrollLeft / scroll.scrollWidth : 0;
    const relY = scroll.scrollHeight > 0 ? scroll.scrollTop / scroll.scrollHeight : 0;
    monitorFitCache = measureMonitorFit();
    if (state.viewZoom > maxViewZoom()) state.viewZoom = maxViewZoom();
    applyMonitorView();
    scroll.scrollLeft = relX * scroll.scrollWidth;
    scroll.scrollTop = relY * scroll.scrollHeight;
  }).observe(els.monitorStage);
}
/* Keep the guide overlay glued to the canvas inside .monitor-zoom-inner */
function updateSafeOverlay() {
  if (!state.guides) return;
  const cv = els.preview;
  const o = els.safeOverlay.style;
  o.left = cv.offsetLeft + "px";
  o.top = cv.offsetTop + "px";
  o.width = cv.offsetWidth + "px";
  o.height = cv.offsetHeight + "px";
  els.safeOverlay.classList.toggle("vertical", project.height > project.width);
}
/* Dimmed overscan outside the delivery export frame (preview-only overlay). */
const EF_EDGE = 10;
function layoutExportFrameOverlayPart(el, left, top, w, h) {
  el.style.left = left + "px";
  el.style.top = top + "px";
  el.style.width = w + "px";
  el.style.height = h + "px";
}
function applyExportFrameClip(ef, show) {
  const inner = els.monitorZoomInner;
  if (!inner) return;
  if (!(show && state.exportFrameCrop && ef && els.preview)) {
    inner.style.clipPath = "";
    return;
  }
  const cv = els.preview;
  const ir = inner.getBoundingClientRect();
  const cr = cv.getBoundingClientRect();
  if (!ir.width || !cr.width) { inner.style.clipPath = ""; return; }
  const sx = cr.width / project.width, sy = cr.height / project.height;
  const left = cr.left - ir.left + ef.x * sx;
  const top = cr.top - ir.top + ef.y * sy;
  const right = ir.right - (cr.left + (ef.x + ef.w) * sx);
  const bottom = ir.bottom - (cr.top + (ef.y + ef.h) * sy);
  inner.style.clipPath = `inset(${Math.max(0, top)}px ${Math.max(0, right)}px ${Math.max(0, bottom)}px ${Math.max(0, left)}px)`;
}
function updateExportFrameOverlay() {
  const ov = els.exportFrameOverlay;
  if (!ov) return;
  const ef = getExportFrame();
  const show = state.exportFrameView && ef;
  ov.classList.toggle("hidden", !show);
  ov.classList.toggle("is-crop", !!(show && state.exportFrameCrop));
  const dimBtn = els.btnExportFrameDim;
  if (dimBtn) {
    dimBtn.classList.toggle("hidden", !show);
    dimBtn.classList.toggle("on", !!(show && !state.exportFrameCrop));
    dimBtn.setAttribute("aria-pressed", show && !state.exportFrameCrop ? "true" : "false");
    dimBtn.title = state.exportFrameCrop
      ? "Lights on — show canvas outside the export frame"
      : "Lights off — crop to the export frame";
  }
  applyExportFrameClip(ef, show);
  if (!show) return;
  const cv = els.preview;
  const root = ov.style;
  root.left = cv.offsetLeft + "px";
  root.top = cv.offsetTop + "px";
  root.width = cv.offsetWidth + "px";
  root.height = cv.offsetHeight + "px";
  const sx = cv.offsetWidth / project.width;
  const sy = cv.offsetHeight / project.height;
  const hole = ov.querySelector(".ef-shade");
  const handle = ov.querySelector(".ef-handle");
  const edgeT = ov.querySelector(".ef-edge-t");
  const edgeB = ov.querySelector(".ef-edge-b");
  const edgeL = ov.querySelector(".ef-edge-l");
  const edgeR = ov.querySelector(".ef-edge-r");
  if (!hole) return;
  const left = ef.x * sx, top = ef.y * sy, w = ef.w * sx, h = ef.h * sy;
  layoutExportFrameOverlayPart(hole, left, top, w, h);
  if (handle) {
    handle.style.left = (left + 6) + "px";
    handle.style.top = (top + 6) + "px";
    handle.style.width = "auto";
    handle.style.maxWidth = Math.max(0, w - 12) + "px";
  }
  if (edgeT) layoutExportFrameOverlayPart(edgeT, left, top, w, EF_EDGE);
  if (edgeB) layoutExportFrameOverlayPart(edgeB, left, top + h - EF_EDGE, w, EF_EDGE);
  if (edgeL) layoutExportFrameOverlayPart(edgeL, left, top + EF_EDGE, EF_EDGE, Math.max(0, h - EF_EDGE * 2));
  if (edgeR) layoutExportFrameOverlayPart(edgeR, left + w - EF_EDGE, top + EF_EDGE, EF_EDGE, Math.max(0, h - EF_EDGE * 2));
}
let exportFrameDrag = null;
function exportFrameDragTarget(e) {
  return e.target.closest(".ef-handle, .ef-edge-t, .ef-edge-b, .ef-edge-l, .ef-edge-r");
}
function exportFrameDragMove(e) {
  if (!exportFrameDrag) return;
  const cv = els.preview;
  const sx = project.width / cv.offsetWidth;
  const sy = project.height / cv.offsetHeight;
  const ef = getExportFrame();
  if (!ef) return;
  project.exportFrame = normalizeExportFrame({
    x: exportFrameDrag.ox + (e.clientX - exportFrameDrag.startX) * sx,
    y: exportFrameDrag.oy + (e.clientY - exportFrameDrag.startY) * sy,
    w: ef.w, h: ef.h,
  }, project.width, project.height);
  updateExportFrameOverlay();
}
function exportFrameDragEnd(e) {
  if (!exportFrameDrag) return;
  exportFrameDrag = null;
  els.exportFrameOverlay?.classList.remove("is-dragging");
  syncExportFrameSel();
  updateMonitorRes();
  scheduleSave();
  document.removeEventListener("pointermove", exportFrameDragMove);
  document.removeEventListener("pointerup", exportFrameDragEnd, true);
  document.removeEventListener("pointercancel", exportFrameDragEnd, true);
  try { els.exportFrameOverlay?.releasePointerCapture(e.pointerId); } catch { }
}
const EF_NUDGE_PX = 1;
const EF_NUDGE_SHIFT_PX = 10;
function nudgeExportFrame(dx, dy) {
  const ef = getExportFrame();
  if (!ef) return;
  project.exportFrame = normalizeExportFrame({
    x: ef.x + dx, y: ef.y + dy, w: ef.w, h: ef.h,
  }, project.width, project.height);
  updateExportFrameOverlay();
  syncExportFrameSel();
  updateMonitorRes();
  scheduleSave();
}
function exportFrameHandleKeydown(e) {
  const k = e.key;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k)) return;
  e.preventDefault();
  e.stopPropagation();
  const step = e.shiftKey ? EF_NUDGE_SHIFT_PX : EF_NUDGE_PX;
  nudgeExportFrame(
    k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0,
    k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0,
  );
}
els.exportFrameOverlay?.addEventListener("pointerdown", (e) => {
  if (!exportFrameDragTarget(e)) return;
  const ef = getExportFrame();
  if (!ef) return;
  e.preventDefault();
  e.stopPropagation();
  els.exportFrameOverlay?.classList.add("is-dragging");
  exportFrameDrag = { startX: e.clientX, startY: e.clientY, ox: ef.x, oy: ef.y };
  try { els.exportFrameOverlay.setPointerCapture(e.pointerId); } catch { }
  document.addEventListener("pointermove", exportFrameDragMove);
  document.addEventListener("pointerup", exportFrameDragEnd, true);
  document.addEventListener("pointercancel", exportFrameDragEnd, true);
});
els.exportFrameOverlay?.querySelector(".ef-handle")?.addEventListener("keydown", exportFrameHandleKeydown);

window.addEventListener("keydown", (e) => {
  const k = e.key;
  if ((k === "Delete" || k === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (!isTypingTarget(document.activeElement) && clearFocusedTransition()) {
      e.preventDefault();
      return;
    }
  }
  if (k === "Escape" && els.importUrlOverlay && !els.importUrlOverlay.classList.contains("hidden")) {
    e.preventDefault();
    closeImportUrl();
    return;
  }
  if (isTypingTarget(document.activeElement)) return;
  if (k === " ") { e.preventDefault(); toggleTransportPlay(); }
  // JKL shuttle — bare keys only, so Cmd/Ctrl+J/K/L stay with the browser.
  // K stops; hold K and tap J / L to step a frame, hold both to crawl.
  else if ((k === "k" || k === "K") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (e.repeat) return;
    runtime.kHeld = true;
    transportStop();
    setPreviewRate(1);
  }
  else if ((k === "l" || k === "L" || k === "j" || k === "J") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const dir = k === "l" || k === "L" ? 1 : -1;
    if (runtime.kHeld) {
      if (!e.repeat) { stepTransport(dir); return; }
      if (!runtime.inching) { // key auto-repeat = held: crawl until release
        runtime.inching = true;
        setPreviewRate(dir * INCH_RATE);
        transportStart();
      }
      return;
    }
    if (!e.repeat) shuttle(dir);
  }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
    Object.entries(EDIT_TOOLS).some(([, t]) => t.key === k.toUpperCase())) {
    e.preventDefault();
    setEditTool(Object.keys(EDIT_TOOLS).find((n) => EDIT_TOOLS[n].key === k.toUpperCase()));
  }
  else if (k === ";" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); liftExtract(false); }
  else if (k === "'" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); liftExtract(true); }
  else if ((k === "e" || k === "E") && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    toggleClipsDisabled();
  }
  else if ((k === "d" || k === "D") && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    crossfadeSelected();
  }
  else if ((k === "l" || k === "L") && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault(); // Ctrl/Cmd+L would otherwise focus the address bar
    toggleLinkSelected();
  }
  else if (k === "s" || k === "S") splitAtPlayhead();
  else if (k === "," && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    insertSourceAtPlayhead();
  }
  else if (k === "." && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    replaceSourceAtPlayhead();
  }
  else if ((k === "g" || k === "G") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.shiftKey ? closeGapAtPlayhead() : goToNextGap();
  }
  else if (e.altKey && !e.ctrlKey && !e.metaKey && (k === "t" || k === "T")) {
    e.preventDefault();
    addTransitionAtPlayhead();
  }
  else if ((k === "t" || k === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.shiftKey ? trimToWorkArea() : splitAtWorkArea();
  }
  else if ((k === "Delete" || k === "Backspace") && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    rippleDeleteSelected();
  }
  else if ((k === "Delete" || k === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey) deleteSelected();
  else if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "ArrowLeft" || k === "ArrowRight")) {
    e.preventDefault();
    goToKeyframe(k === "ArrowRight" ? 1 : -1);
  }
  else if ((k === "ArrowUp" || k === "ArrowDown") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    goToEditPoint(k === "ArrowDown" ? 1 : -1);
  }
  // Transport keys claim the event so the focused timeline/monitor scroller
  // doesn't also scroll. Alt+←/→ stays with the browser (history navigation).
  else if (k === "ArrowLeft" && !e.altKey) {
    e.preventDefault();
    const dt = e.shiftKey ? 1 : 1 / projectFps();
    if (isSourceMode()) setSourceTime(state.source.time - dt);
    else setTime(state.time - dt);
  }
  else if (k === "ArrowRight" && !e.altKey) {
    e.preventDefault();
    const dt = e.shiftKey ? 1 : 1 / projectFps();
    if (isSourceMode()) setSourceTime(state.source.time + dt);
    else setTime(state.time + dt);
  }
  else if (k === "Home" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); gotoTransportHome(); }
  else if (k === "End" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); gotoTransportEnd(); }
  else if (k === "[") trimToPlayhead("in");
  else if (k === "]") trimToPlayhead("out");
  else if (e.code === "KeyM" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    goToMarker(e.altKey ? -1 : 1); // ⇧M next · Alt+⇧M previous
  }
  else if ((k === "m" || k === "M") && !e.ctrlKey && !e.metaKey && !e.altKey) toggleMarker();
  else if (/^[0-9]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); // type a timecode straight into the playhead readout
    beginTcEntry(els.tcCurrent, "time", k);
  }
  else if ((k === "i" || k === "I") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.shiftKey ? clearMarkIn() : markIn();
  }
  else if ((k === "o" || k === "O") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.shiftKey ? clearMarkOut() : markOut();
  }
  else if (k === "n" || k === "N") els.btnSnap.click();
  else if (k === "Escape") {
    if (!$("settingsOverlay").classList.contains("hidden")) {
      e.preventDefault();
      closeSettings();
    } else if (!$("helpOverlay").classList.contains("hidden")) {
      e.preventDefault();
      $("helpOverlay").classList.add("hidden");
    } else {
      selectClip(null);
    }
  }
  else if ((e.ctrlKey || e.metaKey) && (k === "a" || k === "A")) {
    e.preventDefault();
    setSelection(project.clips.map((c) => c.id));
  }
  else if (k === "+" || k === "=") setZoom(state.pps * 1.25);
  else if (k === "-") setZoom(state.pps / 1.25);
  else if (e.code === "KeyZ" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (e.altKey) zoomToWorkArea();
    else if (e.shiftKey) zoomToFit();
    else zoomToSelection();
  }
  else if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
  else if ((e.ctrlKey || e.metaKey) && (k === "y" || k === "Y")) { e.preventDefault(); redo(); }
});

window.addEventListener("resize", () => { state.dirtyTimeline = true; clampTimelineHeight(); if (mixerState.open) sizeMixerMeters(); });

/* ── Resizable upper / timeline split ── */
const TL_H_KEY = "fablecut-timeline-h";
const TL_H_MIN = 180;
const UPPER_MIN = 140;
function availableTimelineMax() {
  const app = $("app").getBoundingClientRect();
  const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
  const topbarH = topbar ? topbar.height : 46;
  const split = 6;
  const gaps = 18; // three 6px flex gaps between four children
  return Math.floor(app.height - topbarH - UPPER_MIN - split - gaps);
}
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (k !== "k" && k !== "j" && k !== "l") return;
  if (k === "k") runtime.kHeld = false;
  if (runtime.inching) {
    runtime.inching = false;
    transportStop();
    setPreviewRate(1);
  }
});
window.addEventListener("blur", () => { runtime.kHeld = false; });
function setTimelineHeight(px) {
  const h = clamp(Math.round(px), TL_H_MIN, Math.max(TL_H_MIN, availableTimelineMax()));
  $("app").style.setProperty("--timeline-h", h + "px");
  state.dirtyTimeline = true;
  return h;
}
/* Tall enough for the toolbar + ruler + every track row (no vertical overflow). */
function defaultTimelineHeight() {
  const tracksH = TRACKS.reduce((s, t) => s + t.h, 0);
  const toolbar = document.querySelector(".timeline-toolbar");
  const toolbarH = toolbar ? toolbar.getBoundingClientRect().height : 40;
  return tracksH + RULER_H + toolbarH + 8;
}
function resetTimelineHeight() {
  const h = setTimelineHeight(defaultTimelineHeight());
  localStorage.removeItem(TL_H_KEY);
  state.dirtyTimeline = true;
  return h;
}
function trackSizeShowsThumbs() {
  return !!(TRACK_SIZE_PRESETS[state.trackSize] || TRACK_SIZE_PRESETS.l).thumbs;
}
function syncTrackSizeButtons() {
  const group = $("trackSizeGroup");
  if (!group) return;
  for (const b of group.querySelectorAll("[data-track-size]"))
    b.classList.toggle("on", b.dataset.trackSize === state.trackSize);
  document.body.classList.toggle("track-size-s", state.trackSize === "s");
  document.body.classList.toggle("track-size-m", state.trackSize === "m");
  document.body.classList.toggle("track-size-l", state.trackSize === "l");
}
function applyTrackHeights() {
  const preset = TRACK_SIZE_PRESETS[state.trackSize] || TRACK_SIZE_PRESETS.l;
  for (const t of TRACKS) {
    t.h = t.kind === "audio" ? preset.hAudio : preset.hVideo;
  }
}
/* Switch S/M/L track density, rebuild the timeline, and grow/shrink the pane
   so every track fits without a vertical scrollbar. */
function setTrackSize(size, { persist = true, fitPane = true } = {}) {
  if (!TRACK_SIZE_PRESETS[size]) size = "l";
  state.trackSize = size;
  applyTrackHeights();
  if (persist) localStorage.setItem(TRACK_SIZE_KEY, size);
  syncTrackSizeButtons();
  buildTrackDOM();
  state.dirtyTimeline = true;
  rebuildClips();
  if (fitPane) {
    const h = setTimelineHeight(defaultTimelineHeight());
    localStorage.setItem(TL_H_KEY, String(h));
  }
}
function restoreDefaultLayout() {
  setTrackSize("l", { persist: true, fitPane: false });
  resetTimelineHeight();
}
function clampTimelineHeight() {
  const cur = $("timelinePanel")?.getBoundingClientRect().height;
  if (cur) setTimelineHeight(cur);
}
function initPanelSplit() {
  const handle = $("splitUpperTimeline");
  const tl = $("timelinePanel");
  if (!handle || !tl) return;
  const savedSize = localStorage.getItem(TRACK_SIZE_KEY);
  if (TRACK_SIZE_PRESETS[savedSize]) state.trackSize = savedSize;
  applyTrackHeights();
  syncTrackSizeButtons();

  const saved = parseFloat(localStorage.getItem(TL_H_KEY));
  if (saved > 0) setTimelineHeight(saved);
  else resetTimelineHeight();

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing-panels");
    const y0 = e.clientY;
    const h0 = tl.getBoundingClientRect().height;
    const onMove = (ev) => setTimelineHeight(h0 - (ev.clientY - y0));
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing-panels");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      localStorage.setItem(TL_H_KEY, String(Math.round(tl.getBoundingClientRect().height)));
      state.dirtyTimeline = true;
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
  handle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    resetTimelineHeight();
  });
}

/* ── Boot ── */
loadSettings();
initPanelSplit();
buildTrackDOM();
rebuildClips();
renderBin();
syncTrimIOButton();
syncMonitorModeUI();
buildMeterDOM();
for (const b of els.sideTabs.querySelectorAll("[data-side]"))
  b.addEventListener("click", () => setSideTab(b.dataset.side));
try { if (localStorage.getItem(SIDE_TAB_KEY) === "mixer") setSideTab("mixer"); } catch { }
connectServer().then(() => { loadLibraryFonts(); runExportJobFromUrl(); });
requestAnimationFrame(loop);
