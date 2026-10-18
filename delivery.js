/* FableCut delivery — export presets and encode settings as data. Zero
   dependencies. Loaded by the editor as a plain script (global
   `FableCutDelivery`) and required by the server, the MCP server and the tests.

   A delivery spec says what one output file should be:

     { preset: "youtube",                 // where it started (label only)
       width: 1920, height: 1080,         // null = the picture's own size
       fps: null,                         // null = the project's frame rate
       reframe: "fill",                   // fill (crop) · fit (pad) · stretch
       container: "mp4",
       video: { codec: "h264", encoder: null (= best available software),
                rate: "crf" | "vbr" | "cbr", crf: 18, bitrate: 12000 (kbps),
                maxrate: null (kbps, caps a CRF encode), keyint: 2 (s, 0 = encoder default),
                pixFmt: "yuv420p", speed: "fast" | "balanced" | "best",
                profile: null (ProRes / DNxHR flavour) },
       audio: { codec: "aac", bitrate: 320, sampleRate: 48000, channels: 2,
                loudness: null (LUFS target — the mix is turned up / down to it),
                truePeak: -1 (dBTP ceiling while normalizing) },
       color: "bt709",                    // a COLORS key
       filename: "{project}_{preset}_{res}",
       metadata: { title, artist, description, copyright, date } }

   normalize() turns anything (a preset id, a partial spec, an agent's guess)
   into a complete, self-consistent spec, saying what it changed. ffmpegArgs()
   turns a spec into one ffmpeg pass that reads the browser's frames on stdin.
   Every value that reaches ffmpeg comes from a table here, never from the
   caller, except the metadata strings (passed as separate argv entries, no
   shell) — unlike encoding-profiles.json, which is raw args the user owns. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory();
  if (node) module.exports = api;
  else root.FableCutDelivery = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (v != null && v !== "" && Number.isFinite(+v) ? +v : d);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);

  /* ── Tables ─────────────────────────────────────────────────────────── */

  const CONTAINERS = {
    mp4: { label: "MP4", ext: ".mp4", mov: true },
    mov: { label: "QuickTime MOV", ext: ".mov", mov: true },
    mkv: { label: "Matroska MKV", ext: ".mkv" },
    webm: { label: "WebM", ext: ".webm" },
    mxf: { label: "MXF (OP1a)", ext: ".mxf" },
  };

  /* rate: which rate controls the codec offers ("fixed" = set by the codec's
     profile / spec, no bitrate or CRF). crf: [min, max, default]. */
  const CODECS = {
    h264: {
      label: "H.264", encoders: ["libx264", "h264_nvenc", "h264_qsv", "h264_amf"],
      containers: ["mp4", "mov", "mkv"], rate: ["crf", "vbr", "cbr"], crf: [0, 51, 18],
      pixFmts: ["yuv420p", "yuv422p", "yuv444p", "yuv420p10le", "yuv422p10le"],
    },
    hevc: {
      label: "H.265 / HEVC", encoders: ["libx265", "hevc_nvenc", "hevc_qsv", "hevc_amf"],
      containers: ["mp4", "mov", "mkv"], rate: ["crf", "vbr", "cbr"], crf: [0, 51, 22],
      pixFmts: ["yuv420p", "yuv420p10le", "yuv422p10le", "yuv444p"],
    },
    av1: {
      label: "AV1", encoders: ["libsvtav1", "libaom-av1", "av1_nvenc", "av1_qsv", "av1_amf"],
      containers: ["mp4", "mkv", "webm"], rate: ["crf", "vbr", "cbr"], crf: [0, 63, 30],
      pixFmts: ["yuv420p", "yuv420p10le"],
    },
    vp9: {
      label: "VP9", encoders: ["libvpx-vp9"],
      containers: ["webm", "mkv", "mp4"], rate: ["crf", "vbr", "cbr"], crf: [0, 63, 31],
      pixFmts: ["yuv420p", "yuv420p10le"],
    },
    prores: {
      label: "Apple ProRes", encoders: ["prores_ks"], containers: ["mov"], rate: ["fixed"],
      profiles: { proxy: "Proxy", lt: "LT", standard: "422", hq: "422 HQ", 4444: "4444", "4444xq": "4444 XQ" },
      defaultProfile: "hq", pixFmts: ["yuv422p10le", "yuv444p10le"],
    },
    dnxhr: {
      label: "Avid DNxHR", encoders: ["dnxhd"], containers: ["mov", "mxf"], rate: ["fixed"],
      profiles: { lb: "LB", sq: "SQ", hq: "HQ", hqx: "HQX 10-bit", 444: "444 10-bit" },
      defaultProfile: "hq", pixFmts: ["yuv422p", "yuv422p10le", "yuv444p10le"],
    },
    mpeg2: {
      label: "XDCAM HD422 (MPEG-2 50 Mb/s)", encoders: ["mpeg2video"], containers: ["mxf", "mov"],
      rate: ["fixed"], pixFmts: ["yuv422p"],
    },
    ffv1: {
      label: "FFV1 (lossless)", encoders: ["ffv1"], containers: ["mkv"], rate: ["fixed"],
      pixFmts: ["yuv422p10le", "yuv444p10le", "yuv420p"],
    },
  };

  /* Which pixel formats an encoder takes, as ffmpeg names. A spec keeps the
     generic name (yuv420p10le); hardware encoders get their own (p010le). */
  const HW_PIX = { yuv420p: "nv12", yuv420p10le: "p010le", yuv444p: "yuv444p" };
  const ENCODERS = {
    libx264: { label: "x264 (software)" },
    h264_nvenc: { label: "NVIDIA NVENC", hw: "nvenc", pix: ["yuv420p", "yuv444p", "yuv420p10le"] },
    h264_qsv: { label: "Intel Quick Sync", hw: "qsv", pix: ["yuv420p"] },
    h264_amf: { label: "AMD AMF", hw: "amf", pix: ["yuv420p"] },
    libx265: { label: "x265 (software)" },
    hevc_nvenc: { label: "NVIDIA NVENC", hw: "nvenc", pix: ["yuv420p", "yuv420p10le", "yuv444p"] },
    hevc_qsv: { label: "Intel Quick Sync", hw: "qsv", pix: ["yuv420p", "yuv420p10le"] },
    hevc_amf: { label: "AMD AMF", hw: "amf", pix: ["yuv420p", "yuv420p10le"] },
    libsvtav1: { label: "SVT-AV1 (software)" },
    "libaom-av1": { label: "libaom (software, slow)" },
    av1_nvenc: { label: "NVIDIA NVENC", hw: "nvenc", pix: ["yuv420p", "yuv420p10le"] },
    av1_qsv: { label: "Intel Quick Sync", hw: "qsv", pix: ["yuv420p", "yuv420p10le"] },
    av1_amf: { label: "AMD AMF", hw: "amf", pix: ["yuv420p"] },
    "libvpx-vp9": { label: "libvpx (software)" },
    prores_ks: { label: "prores_ks" },
    dnxhd: { label: "dnxhd" },
    mpeg2video: { label: "mpeg2video" },
    ffv1: { label: "ffv1" },
  };

  const AUDIO = {
    aac: { label: "AAC", encoder: "aac", bitrate: [64, 512, 320], containers: ["mp4", "mov", "mkv"] },
    opus: { label: "Opus", encoder: "libopus", bitrate: [32, 512, 192], containers: ["webm", "mkv", "mp4"] },
    mp3: { label: "MP3", encoder: "libmp3lame", bitrate: [64, 320, 320], containers: ["mp4", "mov", "mkv"] },
    pcm16: { label: "PCM 16-bit", encoder: "pcm_s16le", containers: ["mov", "mkv", "mxf"] },
    pcm24: { label: "PCM 24-bit", encoder: "pcm_s24le", containers: ["mov", "mkv", "mxf"] },
    flac: { label: "FLAC (lossless)", encoder: "flac", containers: ["mkv"] },
    none: { label: "No audio", containers: ["mp4", "mov", "mkv", "webm", "mxf"] },
  };
  const SAMPLE_RATES = [44100, 48000];

  /* Output colour. The canvas is sRGB / BT.709 RGB; these set the YUV matrix,
     range and the tags. No gamut conversion — BT.601 primaries are close
     enough to BT.709 for SD, and wide-gamut / HDR is not offered because the
     compositor never produces it. `scale` is the matrix name the scale filter
     takes, which differs from the tag name for PAL. */
  const COLORS = {
    bt709: { label: "Rec. 709 (limited)", matrix: "bt709", primaries: "bt709", trc: "bt709", range: "tv", scale: "bt709" },
    "bt709-full": { label: "Rec. 709 (full range)", matrix: "bt709", primaries: "bt709", trc: "bt709", range: "pc", scale: "bt709" },
    "bt601-625": { label: "Rec. 601 PAL (limited)", matrix: "bt470bg", primaries: "bt470bg", trc: "smpte170m", range: "tv", scale: "bt470" },
    "bt601-525": { label: "Rec. 601 NTSC (limited)", matrix: "smpte170m", primaries: "smpte170m", trc: "smpte170m", range: "tv", scale: "smpte170m" },
  };

  const FPS_CHOICES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  /** ffmpeg rate for a frame rate: the NTSC ones as exact fractions. */
  function fpsRational(fps) {
    const f = +fps;
    for (const base of [24, 30, 60, 120]) if (Math.abs(f - base * 1000 / 1001) < 0.01) return `${base * 1000}/1001`;
    return String(Math.round(f * 1000) / 1000);
  }

  const RESOLUTIONS = [
    [3840, 2160, "4K UHD"], [2560, 1440, "1440p"], [1920, 1080, "1080p"], [1280, 720, "720p"], [854, 480, "480p"],
    [4096, 2160, "DCI 4K"], [2160, 3840, "4K vertical"], [1080, 1920, "9:16 vertical"], [720, 1280, "9:16 720"],
    [1080, 1350, "4:5 portrait"], [1080, 1080, "1:1 square"],
  ];

  const SPEEDS = ["fast", "balanced", "best"];

  /* ── Presets ─────────────────────────────────────────────────────────
     Settings follow each platform's published upload guidance where there is
     one; `limits` are soft checks (platforms change them — the warning says
     so). `group` orders the dropdown. */
  const H264 = (crf, extra) => ({ codec: "h264", rate: "crf", crf, keyint: 2, pixFmt: "yuv420p", speed: "balanced", ...extra });
  const PRESETS = {
    youtube: {
      label: "YouTube", group: "Platforms", width: 1920, height: 1080, container: "mp4",
      // YouTube: High profile, closed GOP of half the frame rate, AAC-LC 384k stereo 48 kHz
      video: H264(18, { keyint: 0.5 }), audio: { codec: "aac", bitrate: 384, sampleRate: 48000, channels: 2 },
      filename: "{project}_youtube_{res}", note: "16:9 · H.264 High · CRF 18 · AAC 384k",
    },
    "youtube-shorts": {
      label: "YouTube Shorts", group: "Platforms", width: 1080, height: 1920, container: "mp4",
      video: H264(18, { keyint: 0.5 }), audio: { codec: "aac", bitrate: 384, sampleRate: 48000, channels: 2 },
      filename: "{project}_shorts_{res}", limits: { duration: 180, vertical: true },
      note: "9:16 · up to 3 min",
    },
    "instagram-reels": {
      label: "Instagram Reels", group: "Platforms", width: 1080, height: 1920, container: "mp4",
      video: H264(19, { maxrate: 25000, keyint: 1 }), audio: { codec: "aac", bitrate: 256, sampleRate: 48000, channels: 2 },
      filename: "{project}_reel_{res}", limits: { duration: 180, vertical: true, fps: 60 },
      note: "9:16 · ≤ 60 fps · capped at 25 Mb/s",
    },
    tiktok: {
      label: "TikTok", group: "Platforms", width: 1080, height: 1920, container: "mp4",
      video: H264(19, { maxrate: 20000, keyint: 1 }), audio: { codec: "aac", bitrate: 256, sampleRate: 48000, channels: 2 },
      filename: "{project}_tiktok_{res}", limits: { duration: 600, vertical: true, fps: 60 },
      note: "9:16 · ≤ 60 fps",
    },
    x: {
      label: "X (Twitter)", group: "Platforms", width: 1920, height: 1080, container: "mp4",
      video: H264(20, { maxrate: 25000, keyint: 1 }), audio: { codec: "aac", bitrate: 192, sampleRate: 48000, channels: 2 },
      filename: "{project}_x_{res}", limits: { duration: 140, size: 512 * 1024 * 1024, fps: 60 },
      note: "≤ 2 min 20 s and 512 MB on a free account",
    },
    linkedin: {
      label: "LinkedIn", group: "Platforms", width: 1920, height: 1080, container: "mp4",
      video: H264(20, { maxrate: 20000, keyint: 1 }), audio: { codec: "aac", bitrate: 192, sampleRate: 48000, channels: 2 },
      filename: "{project}_linkedin_{res}", limits: { duration: 900, size: 5 * 1024 ** 3, fps: 60 },
      note: "≤ 15 min and 5 GB",
    },
    master: {
      label: "Master", group: "Delivery", width: null, height: null, container: "mp4",
      video: H264(16, { speed: "best", keyint: 2 }), audio: { codec: "aac", bitrate: 320, sampleRate: 48000, channels: 2 },
      filename: "{project}_master_{res}", note: "Project size · H.264 CRF 16 · AAC 320k",
    },
    broadcast: {
      label: "Broadcast", group: "Delivery", width: 1920, height: 1080, container: "mov",
      video: { codec: "prores", profile: "hq", pixFmt: "yuv422p10le" },
      audio: { codec: "pcm24", sampleRate: 48000, channels: 2, loudness: -23, truePeak: -1 },
      filename: "{project}_broadcast_{res}_{fps}", limits: { fpsList: [25, 29.97, 50, 59.94] },
      note: "ProRes 422 HQ · PCM 24-bit 48 kHz · Rec. 709 · −23 LUFS (EBU R128)",
    },
    web: {
      label: "Web", group: "Delivery", width: 1280, height: 720, container: "mp4",
      video: H264(23, { speed: "balanced" }), audio: { codec: "aac", bitrate: 128, sampleRate: 48000, channels: 2 },
      filename: "{project}_web_{res}", note: "Small, plays everywhere · fast start",
    },
    archive: {
      label: "Archive", group: "Delivery", width: null, height: null, container: "mkv",
      video: { codec: "ffv1", pixFmt: "yuv422p10le" }, audio: { codec: "pcm24", sampleRate: 48000, channels: 2 },
      filename: "{project}_archive_{date}", note: "Lossless FFV1 · PCM 24-bit · source resolution",
    },
    custom: {
      label: "Custom", group: "Custom", width: null, height: null, container: "mp4",
      video: H264(18), audio: { codec: "aac", bitrate: 320, sampleRate: 48000, channels: 2 },
      filename: "{project}_{res}", note: "Your own settings",
    },
  };
  const PRESET_IDS = Object.keys(PRESETS);
  /* Where each platform plays a mix (streaming players turn louder ones down).
     Only a reference for the report; a spec normalizes only when audio.loudness is set. */
  const PLATFORM_LOUDNESS = { youtube: -14, "youtube-shorts": -14, "instagram-reels": -14, tiktok: -14, x: -14, linkedin: -14, broadcast: -23 };
  const LOUDNESS_TARGETS = [[-14, "−14 LUFS · streaming and social"], [-16, "−16 LUFS · podcast, dialogue"], [-23, "−23 LUFS · broadcast (EBU R128)"], [-24, "−24 LUFS · broadcast (ATSC A/85)"]];
  const DEFAULT_PRESET = "master";

  /* ── Normalize ──────────────────────────────────────────────────────── */

  function pick(list, v, d) { return list.includes(v) ? v : d; }
  function cleanText(v, max) {
    // eslint-disable-next-line no-control-regex
    return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  }

  /** Encoders to choose from for a codec, best first: software unless the
   *  caller asked for hardware. `available` (a Set of ffmpeg encoder names)
   *  filters to what this ffmpeg has; null = assume all. */
  function encodersFor(codec, available) {
    const list = (CODECS[codec] || CODECS.h264).encoders;
    return available ? list.filter((e) => available.has(e)) : list.slice();
  }

  /** opts: {available: Set|null, presets: {id: spec} (user presets)}.
   *  Returns {spec, notes:[…what was changed and why]}. */
  function normalize(input, opts = {}) {
    const notes = [];
    const userPresets = opts.presets || {};
    let raw = input;
    if (typeof raw === "string") raw = { preset: raw };
    raw = raw && typeof raw === "object" ? raw : {};
    const pid = typeof raw.preset === "string" ? raw.preset : null;
    const base = (pid && (PRESETS[pid] || userPresets[pid])) || null;
    if (pid && !base) notes.push(`unknown preset "${pid}" — using Custom`);
    const b = base || PRESETS.custom;
    const rv = raw.video && typeof raw.video === "object" ? raw.video : {};
    // a different codec than the preset's starts from that codec's defaults
    const bv = { ...(b.video || {}) };
    if (rv.codec && rv.codec !== bv.codec) for (const k of ["crf", "pixFmt", "profile", "encoder", "rate"]) delete bv[k];
    const v = { ...bv, ...rv };
    const a = { ...(b.audio || {}), ...(raw.audio || {}) };
    const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);

    const spec = { preset: base ? pid : "custom" };
    // resolution: both or neither; even numbers; 16…8192
    let w = has("width") ? raw.width : b.width, h = has("height") ? raw.height : b.height;
    w = w == null || w === "" ? null : num(w, null); h = h == null || h === "" ? null : num(h, null);
    if ((w == null) !== (h == null)) { notes.push("width and height go together — using the picture's own size"); w = h = null; }
    if (w != null) {
      const cw = even(clamp(w, 16, 8192)), ch = even(clamp(h, 16, 8192));
      if (cw !== w || ch !== h) notes.push(`resolution ${w}×${h} → ${cw}×${ch} (even, 16…8192)`);
      w = cw; h = ch;
    }
    spec.width = w; spec.height = h;
    let fps = has("fps") ? raw.fps : b.fps;
    fps = fps == null || fps === "" || fps === "project" ? null : num(fps, null);
    if (fps != null) {
      const f = clamp(fps, 1, 120);
      const snap = FPS_CHOICES.find((c) => Math.abs(c - f) < 0.02);
      spec.fps = snap ?? Math.round(f * 1000) / 1000;
    } else spec.fps = null;
    spec.reframe = pick(["fill", "fit", "stretch"], has("reframe") ? raw.reframe : b.reframe, "fill");

    // video codec → encoder → container
    const codec = CODECS[v.codec] ? v.codec : "h264";
    if (v.codec && !CODECS[v.codec]) notes.push(`unknown codec "${v.codec}" — using H.264`);
    const C = CODECS[codec];
    const avail = encodersFor(codec, opts.available);
    let encoder = v.encoder && C.encoders.includes(v.encoder) ? v.encoder : null;
    if (v.encoder && !encoder) notes.push(`encoder "${v.encoder}" does not make ${C.label}`);
    if (encoder && opts.available && !opts.available.has(encoder)) { notes.push(`this ffmpeg has no ${encoder}`); encoder = null; }
    if (!encoder) encoder = avail[0] || C.encoders[0];
    if (opts.available && !avail.length) notes.push(`this ffmpeg has no ${C.label} encoder — the export will fail`);
    const E = ENCODERS[encoder] || {};

    let container = has("container") ? raw.container : b.container;
    if (!C.containers.includes(container)) {
      if (container) notes.push(`${C.label} does not go in ${String(container).toUpperCase()} — using ${C.containers[0].toUpperCase()}`);
      container = C.containers[0];
    }
    spec.container = container;

    const video = { codec, encoder };
    video.rate = C.rate.includes(v.rate) ? v.rate : C.rate[0];
    if (v.rate && v.rate !== video.rate && C.rate[0] !== "fixed") notes.push(`rate "${v.rate}" is not offered for ${C.label}`);
    if (video.rate !== "fixed") {
      const [lo, hi, dflt] = C.crf;
      video.crf = Math.round(clamp(num(v.crf, dflt), lo, hi));
      video.bitrate = Math.round(clamp(num(v.bitrate, 12000), 100, 400000));
      // 0, empty or not a number = no cap (clamping first would turn 0 into a 100 kb/s cap)
      video.maxrate = +v.maxrate > 0 ? Math.round(clamp(+v.maxrate, 100, 800000)) : null;
      video.keyint = Math.round(clamp(num(v.keyint, 2), 0, 20) * 100) / 100;
      video.speed = pick(SPEEDS, v.speed, "balanced");
      if (encoder === "libsvtav1" && video.rate === "cbr") { video.rate = "vbr"; notes.push("SVT-AV1 has no CBR here — using VBR"); }
    }
    if (C.profiles) video.profile = C.profiles[v.profile] ? String(v.profile) : C.defaultProfile;
    // pixel format: the codec's list, then what the encoder takes
    let pf = C.pixFmts.includes(v.pixFmt) ? v.pixFmt : C.pixFmts[0];
    if (codec === "prores") pf = /^4444/.test(video.profile) ? "yuv444p10le" : "yuv422p10le";
    if (codec === "dnxhr") pf = video.profile === "444" ? "yuv444p10le" : video.profile === "hqx" ? "yuv422p10le" : "yuv422p";
    if (E.pix && !E.pix.includes(pf)) {
      notes.push(`${E.label} cannot encode ${pf} — using ${E.pix[0]}`);
      pf = E.pix[0];
    }
    if (rv.pixFmt && rv.pixFmt !== pf && !notes.some((n) => n.includes(pf))) notes.push(`pixel format ${rv.pixFmt} → ${pf} for ${C.label}${video.profile ? " " + C.profiles[video.profile] : ""}`);
    video.pixFmt = pf;
    spec.video = video;

    // audio
    let ac = AUDIO[a.codec] ? a.codec : "aac";
    if (!AUDIO[ac].containers.includes(container)) {
      const alt = Object.keys(AUDIO).find((k) => k !== "none" && AUDIO[k].containers.includes(container)) || "none";
      notes.push(`${AUDIO[ac].label} audio does not go in ${container.toUpperCase()} — using ${AUDIO[alt].label}`);
      ac = alt;
    }
    const A = AUDIO[ac];
    const audio = { codec: ac };
    if (ac !== "none") {
      if (A.bitrate) audio.bitrate = Math.round(clamp(num(a.bitrate, A.bitrate[2]), A.bitrate[0], A.bitrate[1]));
      audio.sampleRate = pick(SAMPLE_RATES, +a.sampleRate, 48000);
      if (ac === "opus") audio.sampleRate = 48000;
      audio.channels = +a.channels === 1 ? 1 : 2;
      // loudness: null = leave the mix as it is
      const lu = a.loudness == null || a.loudness === "" || a.loudness === "off" ? null : +a.loudness;
      audio.loudness = Number.isFinite(lu) ? Math.round(clamp(lu, -36, -5) * 10) / 10 : null;
      if (audio.loudness != null) audio.truePeak = Math.round(clamp(num(a.truePeak, -1), -9, 0) * 10) / 10;
    }
    spec.audio = audio;

    spec.color = COLORS[has("color") ? raw.color : b.color] ? (has("color") ? raw.color : b.color) : "bt709";
    spec.filename = cleanText(has("filename") ? raw.filename : b.filename, 160) || "{project}_{res}";
    const md = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
    spec.metadata = {};
    for (const k of META_KEYS) { const s = cleanText(md[k], k === "description" ? 2000 : 300); if (s) spec.metadata[k] = s; }
    return { spec, notes };
  }
  const META_KEYS = ["title", "artist", "description", "copyright", "date", "keywords"];

  /* ── Reframe ────────────────────────────────────────────────────────── */

  /** Where the output's picture comes from on the canvas, and how big the
   *  scaled picture is inside the output. region = the export frame when one
   *  is set, else the whole canvas. Returns
   *  {crop:{x,y,w,h}|null, scaleW, scaleH, outW, outH, padX, padY, upscale}. */
  function reframe(spec, canvasW, canvasH, region) {
    /* The export frame is the picture for outputs of its own shape (and for
       "the picture's size"); an output of another shape — the 16:9 file of a
       project framed for 9:16 — reframes the whole canvas instead. */
    const full = { x: 0, y: 0, w: canvasW | 0, h: canvasH | 0 };
    let r = region && region.w > 0 && region.h > 0
      ? { x: region.x | 0, y: region.y | 0, w: region.w | 0, h: region.h | 0 } : full;
    if (r !== full && spec.width && Math.abs(spec.width / spec.height - r.w / r.h) > 0.01) r = full;
    // the picture's own size rounds down to even, so it is never scaled up by a pixel
    const outW = spec.width || Math.max(2, r.w - (r.w & 1)), outH = spec.height || Math.max(2, r.h - (r.h & 1));
    let crop = { ...r }, scaleW = outW, scaleH = outH, padX = 0, padY = 0;
    const want = outW / outH, have = r.w / r.h;
    if (spec.width && Math.abs(want - have) > 0.002) {
      if (spec.reframe === "fill") {
        // largest rect of the output's shape inside the region, centred
        if (have > want) { crop.w = Math.round(r.h * want); crop.x = r.x + Math.round((r.w - crop.w) / 2); }
        else { crop.h = Math.round(r.w / want); crop.y = r.y + Math.round((r.h - crop.h) / 2); }
      } else if (spec.reframe === "fit") {
        if (have > want) scaleH = even(outW / have); else scaleW = even(outH * have);
        padX = (outW - scaleW) >> 1; padY = (outH - scaleH) >> 1;
        padX -= padX & 1; padY -= padY & 1;
      }
    }
    crop.w = Math.max(2, crop.w - (crop.w & 1)); crop.h = Math.max(2, crop.h - (crop.h & 1));
    const whole = crop.x === 0 && crop.y === 0 && crop.w === canvasW && crop.h === canvasH;
    const upscale = scaleW > crop.w * 1.01 || scaleH > crop.h * 1.01;
    return { crop: whole ? null : crop, scaleW, scaleH, outW, outH, padX, padY, upscale, from: { w: crop.w, h: crop.h } };
  }

  /* ── ffmpeg ─────────────────────────────────────────────────────────── */

  const SPEED_MAP = {
    libx264: { fast: ["-preset", "veryfast"], balanced: ["-preset", "medium"], best: ["-preset", "slow"] },
    libx265: { fast: ["-preset", "fast"], balanced: ["-preset", "medium"], best: ["-preset", "slow"] },
    nvenc: { fast: ["-preset", "p3"], balanced: ["-preset", "p5"], best: ["-preset", "p7"] },
    qsv: { fast: ["-preset", "veryfast"], balanced: ["-preset", "medium"], best: ["-preset", "veryslow"] },
    amf: { fast: ["-quality", "speed"], balanced: ["-quality", "balanced"], best: ["-quality", "quality"] },
    "libvpx-vp9": { fast: ["-deadline", "good", "-cpu-used", "4"], balanced: ["-deadline", "good", "-cpu-used", "2"], best: ["-deadline", "good", "-cpu-used", "1"] },
    "libaom-av1": { fast: ["-cpu-used", "8"], balanced: ["-cpu-used", "6"], best: ["-cpu-used", "4"] },
    libsvtav1: { fast: ["-preset", "10"], balanced: ["-preset", "8"], best: ["-preset", "5"] },
  };
  const PRORES_PROFILE = { proxy: "0", lt: "1", standard: "2", hq: "3", 4444: "4", "4444xq": "5" };

  function videoArgs(spec, fps) {
    const v = spec.video, enc = v.encoder, E = ENCODERS[enc] || {};
    const out = ["-c:v", enc];
    const k = (n) => `${Math.round(n)}k`;
    if (v.codec === "prores") return out.concat(["-profile:v", PRORES_PROFILE[v.profile] || "3", "-vendor", "apl0", "-pix_fmt", v.pixFmt]);
    if (v.codec === "dnxhr") return out.concat(["-profile:v", `dnxhr_${v.profile}`, "-pix_fmt", v.pixFmt]);
    if (v.codec === "ffv1") return out.concat(["-level", "3", "-g", "1", "-slices", "16", "-slicecrc", "1", "-coder", "1", "-context", "1", "-pix_fmt", v.pixFmt]);
    if (v.codec === "mpeg2") {
      // XDCAM HD422: 4:2:2 long-GOP MPEG-2 at a constant 50 Mb/s
      return out.concat(["-pix_fmt", "yuv422p", "-b:v", "50M", "-minrate", "50M", "-maxrate", "50M", "-bufsize", "17825792",
        "-rc_init_occupancy", "17825792", "-g", "12", "-bf", "2", "-intra_vlc", "1", "-non_linear_quant", "1",
        "-dc", "10", "-qmin", "1", "-qmax", "12", "-lmin", "1*QP2LAMBDA", "-rc_max_vbv_use", "1", "-rc_min_vbv_use", "1"]);
    }
    out.push(...((SPEED_MAP[E.hw || enc] || {})[v.speed] || []));
    const br = v.bitrate, max = v.maxrate;
    if (v.rate === "crf") {
      if (enc === "libx264" || enc === "libx265" || enc === "libsvtav1") out.push("-crf", String(v.crf));
      else if (enc === "libvpx-vp9" || enc === "libaom-av1") out.push("-crf", String(v.crf), "-b:v", "0");
      else if (E.hw === "nvenc") out.push("-rc", "vbr", "-cq", String(v.crf), "-b:v", "0");
      else if (E.hw === "qsv") out.push("-global_quality", String(v.crf));
      else if (E.hw === "amf") out.push("-rc", "cqp", "-qp_i", String(v.crf), "-qp_p", String(v.crf), ...(v.codec === "h264" ? ["-qp_b", String(v.crf)] : []));
      if (max && E.hw !== "amf") {
        if (enc === "libsvtav1") out.push("-svtav1-params", `mbr=${max}`);
        else out.push("-maxrate", k(max), "-bufsize", k(max * 2));
      }
    } else if (v.rate === "vbr") {
      const peak = max || Math.round(br * 1.5);
      if (E.hw === "nvenc") out.push("-rc", "vbr");
      if (E.hw === "amf") out.push("-rc", "vbr_peak");
      out.push("-b:v", k(br), "-maxrate", k(peak), "-bufsize", k(peak * 2));
    } else if (v.rate === "cbr") {
      if (E.hw === "nvenc") out.push("-rc", "cbr");
      if (E.hw === "amf") out.push("-rc", "cbr");
      out.push("-b:v", k(br), "-minrate", k(br), "-maxrate", k(br), "-bufsize", k(br));
      if (enc === "libx264") out.push("-x264-params", "nal-hrd=cbr");
    }
    if (v.keyint > 0) {
      const g = Math.max(1, Math.round(v.keyint * fps));
      out.push("-g", String(g));
      if (enc === "libx264" || enc === "libx265") out.push("-keyint_min", String(Math.min(g, Math.max(1, Math.round(fps / 2)))));
    }
    if (enc === "libvpx-vp9" || enc === "libaom-av1") out.push("-row-mt", "1");
    if (enc === "libx265") out.push("-x265-params", "log-level=error");
    if (v.codec === "hevc" && (spec.container === "mp4" || spec.container === "mov")) out.push("-tag:v", "hvc1");
    out.push("-pix_fmt", E.hw ? (HW_PIX[v.pixFmt] || v.pixFmt) : v.pixFmt);
    return out;
  }

  function audioArgs(spec) {
    const a = spec.audio;
    if (a.codec === "none") return ["-an"];
    const out = ["-c:a", AUDIO[a.codec].encoder];
    if (a.bitrate) out.push("-b:a", `${a.bitrate}k`);
    out.push("-ar", String(a.sampleRate), "-ac", String(a.channels));
    return out;
  }

  /** The filter chain: crop → scale (with the RGB/JPEG → YUV matrix) → tags → pad. */
  function videoFilter(spec, frame, inMatrix) {
    const c = COLORS[spec.color] || COLORS.bt709;
    const parts = [];
    if (frame.crop) parts.push(`crop=${frame.crop.w}:${frame.crop.h}:${frame.crop.x}:${frame.crop.y}`);
    parts.push(`scale=${frame.scaleW}:${frame.scaleH}:flags=lanczos:in_range=full:in_color_matrix=${inMatrix}` +
      `:out_range=${c.range}:out_color_matrix=${c.scale}`);
    parts.push(`setparams=color_primaries=${c.primaries}:color_trc=${c.trc}:colorspace=${c.matrix}:range=${c.range === "pc" ? "pc" : "tv"}`);
    if (frame.padX || frame.padY || frame.scaleW !== frame.outW || frame.scaleH !== frame.outH)
      parts.push(`pad=${frame.outW}:${frame.outH}:${frame.padX}:${frame.padY}:color=black`);
    return parts.join(",");
  }

  /** One ffmpeg pass. o: {fps, input:"jpeg"|"rgba", canvasW, canvasH, frame
   *  (from reframe), wavPath|null, outPath, duration (s, frames ÷ fps),
   *  loudnorm (pass-one measurement, when the spec has a loudness target), dry}. `dry` swaps stdin for a
   *  0.1 s synthetic picture of the canvas size, to check the settings
   *  before anything is rendered. */
  function ffmpegArgs(spec, o) {
    const rate = fpsRational(o.fps);
    const args = ["-y", "-hide_banner"];
    const rgba = o.input === "rgba";
    if (o.dry) args.push("-f", "lavfi", "-i", `color=c=black:s=${o.canvasW}x${o.canvasH}:r=${rate}:d=0.1,format=${rgba ? "rgba" : "yuvj420p"}`);
    else if (rgba) args.push("-thread_queue_size", "8", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${o.canvasW}x${o.canvasH}`, "-framerate", rate, "-i", "-");
    else args.push("-thread_queue_size", "64", "-f", "image2pipe", "-framerate", rate, "-c:v", "mjpeg", "-i", "-");
    const audio = spec.audio.codec !== "none" && (o.dry ? o.hasAudio !== false : !!o.wavPath);
    if (audio) {
      if (o.dry) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      else args.push("-i", o.wavPath);
    }
    args.push("-map", "0:v:0");
    if (audio) args.push("-map", "1:a:0");
    args.push("-vf", videoFilter(spec, o.frame, rgba ? "bt709" : "bt601"));
    args.push(...videoArgs(spec, +o.fps));
    const c = COLORS[spec.color] || COLORS.bt709;
    args.push("-colorspace", c.matrix, "-color_primaries", c.primaries, "-color_trc", c.trc, "-color_range", c.range);
    // The audio is cut to exactly the frames' length (o.duration): padded when
    // the mix ends a fraction of a frame early (29.97 fps), trimmed when it runs
    // long. -shortest alone overshoots by up to half a second on slow inputs.
    const dur = +o.duration > 0 ? (+o.duration).toFixed(6) : null;
    if (audio && !o.dry) args.push("-af", [o.loudnorm ? loudnormFilter(spec, o.loudnorm) : "", dur ? `apad=whole_dur=${dur},atrim=0:${dur}` : "apad"].filter(Boolean).join(","));
    args.push(...(audio ? audioArgs(spec) : ["-an"]));
    for (const [k, v] of Object.entries(spec.metadata || {})) {
      if (k === "description") args.push("-metadata", `description=${v}`, "-metadata", `comment=${v}`);
      else args.push("-metadata", `${k}=${v}`);
    }
    if (CONTAINERS[spec.container].mov) args.push("-movflags", "+faststart" + (spec.metadata && spec.metadata.keywords ? "+use_metadata_tags" : ""));
    if (o.dry) args.push("-t", "0.1");
    else if (audio && !dur) args.push("-shortest");
    args.push(o.outPath);
    return args;
  }

  /* Loudness normalization is ffmpeg's two-pass loudnorm (EBU R128): pass one
     measures the mix (LOUDNORM_ARGS → parseLoudnorm), pass two — this filter —
     applies one linear gain to the target, with a true-peak limiter (4×
     oversampled inside loudnorm) at the ceiling. When the peaks leave no room
     for the gain, loudnorm compresses instead, and may land under the target:
     the check after the export says so. */
  const LOUDNORM_ARGS = (file, spec) => ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0",
    "-af", `loudnorm=I=${spec.audio.loudness}:TP=${spec.audio.truePeak ?? -1}:LRA=11:print_format=json`, "-f", "null", "-"];
  /** loudnorm's pass-one JSON (the last {...} in its stderr) → numbers, or null. */
  function parseLoudnorm(stderr) {
    const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(String(stderr || "").split(/Parsed_loudnorm/).pop() || "");
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]);
      const out = {};
      for (const k of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) out[k] = Number(j[k]);
      return Object.values(out).every(Number.isFinite) && out.input_i > -70 ? out : null;   // silence: nothing to normalize
    } catch { return null; }
  }
  function loudnormFilter(spec, m) {
    const a = spec.audio;
    if (a.loudness == null || !m) return "";
    // linear mode needs the range to fit; 20 LU is the most every ffmpeg build takes
    // (a wider mix makes loudnorm compress instead — the check reports where it lands)
    const lra = Math.min(20, Math.max(11, Math.ceil(m.input_lra + 1)));
    return `loudnorm=I=${a.loudness}:TP=${a.truePeak ?? -1}:LRA=${lra}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
      `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  }
  /** `-af ebur128=peak=true` summary → {lufs, truePeak} (null where ffmpeg said
   *  -inf), plus silent:true when it measured and found nothing (I: -inf). */
  function parseEbur128(stderr) {
    const txt = String(stderr || "");
    const i = [...txt.matchAll(/\bI:\s+(-?[\d.]+|-inf)\s+LUFS/g)].pop();
    const p = [...txt.matchAll(/True peak:\s*[\r\n]+\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS/g)].pop();
    const val = (m) => (m && m[1] !== "-inf" ? +m[1] : null);
    const out = { lufs: val(i), truePeak: val(p) };
    // nothing above the -70 LUFS gate: ffmpeg prints -70.0 (older builds -inf)
    if (i && (i[1] === "-inf" || +i[1] <= -69.95)) { out.lufs = null; out.silent = true; }
    return out;
  }
  const LOUDNESS_ARGS = (file) => ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"];

  /** What came out vs what was asked: ffprobe JSON of the file (+ its loudness)
   *  against the spec. ctx: {fps, frames, duration, size (bytes), loud:{lufs,
   *  truePeak}|null, frame (from reframe)}. → {ok, checks:[{ok, text}], line}. */
  function verify(spec, probe, ctx = {}) {
    const checks = [];
    const add = (ok, text) => checks.push({ ok: !!ok, text });
    const streams = (probe && probe.streams) || [];
    const v = streams.find((x) => x.codec_type === "video");
    const a = streams.find((x) => x.codec_type === "audio");
    const fr = ctx.frame || {};
    const near = (x, y, tol) => Math.abs(x - y) <= tol;
    const rate = (r) => { const [n, d] = String(r || "0/1").split("/").map(Number); return d ? n / d : 0; };
    const CODEC = { h264: "h264", hevc: "hevc", av1: "av1", vp9: "vp9", prores: "prores", dnxhr: "dnxhd", mpeg2: "mpeg2video", ffv1: "ffv1" };
    if (!v) add(false, "no video stream in the file");
    else {
      if (fr.outW) add(v.width === fr.outW && v.height === fr.outH, `${v.width}×${v.height}${v.width === fr.outW && v.height === fr.outH ? "" : ` (asked ${fr.outW}×${fr.outH})`}`);
      const got = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
      if (ctx.fps) add(near(got, ctx.fps, 0.01), `${Math.round(got * 1000) / 1000} fps${near(got, ctx.fps, 0.01) ? "" : ` (asked ${ctx.fps})`}`);
      const n = +v.nb_frames;
      if (ctx.frames && Number.isFinite(n) && n > 0) add(n === ctx.frames, `${n} frames${n === ctx.frames ? "" : ` (rendered ${ctx.frames})`}`);
      add(v.codec_name === CODEC[spec.video.codec], `${v.codec_name}${v.codec_name === CODEC[spec.video.codec] ? "" : ` (asked ${spec.video.codec})`}`);
      const c = COLORS[spec.color];
      if (c && v.color_space && v.color_space !== "unknown") add(v.color_space === c.matrix, `color ${v.color_space}${v.color_space === c.matrix ? "" : ` (asked ${c.matrix})`}`);
    }
    if (spec.audio.codec === "none") add(!a, a ? "has an audio stream (asked none)" : "no audio");
    else if (!a) add(!ctx.hasAudio, ctx.hasAudio ? "no audio stream" : "no audio (the timeline is silent)");
    else {
      const A = AUDIO[spec.audio.codec];
      add(a.codec_name === A.encoder || (A.encoder === "libopus" && a.codec_name === "opus") || (A.encoder === "libmp3lame" && a.codec_name === "mp3"),
        `${a.codec_name} ${Math.round(+a.sample_rate / 100) / 10} kHz ${+a.channels === 1 ? "mono" : +a.channels === 2 ? "stereo" : a.channels + " ch"}`);
      if (+a.sample_rate !== spec.audio.sampleRate) add(false, `sample rate ${a.sample_rate} (asked ${spec.audio.sampleRate})`);
      if (+a.channels !== spec.audio.channels) add(false, `${a.channels} channel${+a.channels === 1 ? "" : "s"} (asked ${spec.audio.channels})`);
    }
    const dur = +(probe && probe.format && probe.format.duration);
    if (ctx.duration && Number.isFinite(dur)) add(near(dur, ctx.duration, Math.max(0.05, 1.5 / (ctx.fps || 30))), `${fmtClock(dur)}${near(dur, ctx.duration, Math.max(0.05, 1.5 / (ctx.fps || 30))) ? "" : ` (timeline ${fmtClock(ctx.duration)})`}`);
    const L = ctx.loud;
    if (ctx.loudWanted && a && !(L && L.lufs != null) && !(L && L.silent)) add(false, "loudness could not be measured");
    // silence was measured: fine as mixed, but it cannot meet a loudness target
    if (L && L.silent && a) add(spec.audio.loudness == null, `silent${spec.audio.loudness != null ? ` (target ${spec.audio.loudness} LUFS)` : ""}`);
    if (L && L.lufs != null) {
      const target = spec.audio.loudness;
      const tp = L.truePeak;
      if (target != null) {
        add(near(L.lufs, target, 1), `${L.lufs.toFixed(1)} LUFS${near(L.lufs, target, 1) ? "" : ` (target ${target})`}`);
        if (tp != null) add(tp <= (spec.audio.truePeak ?? -1) + 0.5, `${tp.toFixed(1)} dBTP${tp <= (spec.audio.truePeak ?? -1) + 0.5 ? "" : ` (ceiling ${spec.audio.truePeak ?? -1})`}`);
      } else {
        const ref = PLATFORM_LOUDNESS[spec.preset];
        const loudNote = ref != null && L.lufs > ref + 1 ? ` — ${PRESETS[spec.preset].label} plays it ${(L.lufs - ref).toFixed(1)} dB quieter (set Loudness to ${ref} LUFS to match)` : "";
        add(true, `${L.lufs.toFixed(1)} LUFS${tp != null ? ` · ${tp.toFixed(1)} dBTP` : ""}${loudNote}`);
        if (tp != null && tp > 0) add(false, `true peak ${tp.toFixed(1)} dBTP — over 0, it will clip after encoding`);
      }
    }
    const lim = (PRESETS[spec.preset] && PRESETS[spec.preset].limits) || {};
    if (ctx.size) add(!(lim.size && ctx.size > lim.size), `${fmtBytes(ctx.size)}${lim.size && ctx.size > lim.size ? ` (over ${PRESETS[spec.preset].label}'s ${fmtBytes(lim.size)})` : ""}`);
    const bad = checks.filter((x) => !x.ok);
    return { ok: !bad.length, checks, line: checks.map((x) => (x.ok ? "" : "⚠ ") + x.text).join(" · ") };
  }
  function fmtClock(s) {
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r < 10 ? "0" : ""}${r.toFixed(2)}`;
  }

  /** How the browser should hand frames over: JPEG is 4:2:0 8-bit, so
   *  anything that keeps more chroma or bit depth gets raw RGBA instead. */
  function frameInput(spec) {
    const v = spec.video;
    return v.codec === "ffv1" || /422|444|10le/.test(v.pixFmt) ? "rgba" : "jpeg";
  }
  function jpegQuality(spec) {
    const v = spec.video;
    if (v.rate === "crf") return v.crf <= 16 ? 0.98 : v.crf <= 20 ? 0.95 : 0.9;
    return 0.95;
  }

  /* ── Names, summaries, checks ───────────────────────────────────────── */

  function pad2(n) { return String(n).padStart(2, "0"); }
  /** ctx: {project, preset (label or id), width, height, fps, range, date: Date, index} */
  function renderFilename(template, spec, ctx = {}) {
    const d = ctx.date instanceof Date ? ctx.date : new Date();
    const w = ctx.width || spec.width || 0, h = ctx.height || spec.height || 0;
    const fps = ctx.fps || spec.fps || 0;
    const res = w && h ? (w > h ? `${h}p` : w === h ? `${w}sq` : `${w}x${h}`) : "source";
    const vals = {
      project: ctx.project || "export",
      preset: spec.preset || "custom",
      w, h, width: w, height: h, res,
      fps: fps ? String(Math.round(fps * 100) / 100).replace(".", "_") : "",
      codec: spec.video.codec,
      date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      time: `${pad2(d.getHours())}${pad2(d.getMinutes())}`,
      range: ctx.range === "in-out" ? "inout" : "full",
      n: ctx.index != null ? String(ctx.index) : "1",
    };
    let s = String(template || "{project}").replace(/\{(\w+)\}/g, (m, k) => (k in vals ? String(vals[k]) : m));
    s = s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
    return s.slice(0, 120) || "export";
  }
  /** The file name an output gets in a project (its size, export frame and fps). */
  function projectFilename(spec, proj = {}) {
    const fr = reframe(spec, proj.width || 1920, proj.height || 1080, proj.exportFrame || null);
    return renderFilename(spec.filename, spec, { project: proj.name, width: fr.outW, height: fr.outH, fps: spec.fps || proj.fps });
  }
  const FILENAME_TOKENS = ["project", "preset", "res", "w", "h", "fps", "codec", "date", "time", "range", "n"];

  function fmtRate(kbps) { return kbps >= 1000 ? `${Math.round(kbps / 100) / 10} Mb/s` : `${kbps} kb/s`; }
  function describe(spec, ctx = {}) {
    const v = spec.video, a = spec.audio, C = CODECS[v.codec];
    const w = spec.width || ctx.width, h = spec.height || ctx.height;
    const parts = [w && h ? `${w}×${h}` : "source size", `${spec.fps || ctx.fps || "project"} fps`];
    let vid = C.label.replace(/ \(.+\)$/, "");
    if (v.profile && C.profiles) vid += " " + C.profiles[v.profile];
    if (v.rate === "crf") vid += ` CRF ${v.crf}` + (v.maxrate ? ` ≤ ${fmtRate(v.maxrate)}` : "");
    else if (v.rate === "vbr") vid += ` VBR ${fmtRate(v.bitrate)}`;
    else if (v.rate === "cbr") vid += ` CBR ${fmtRate(v.bitrate)}`;
    parts.push(vid);
    parts.push(a.codec === "none" ? "no audio" : `${AUDIO[a.codec].label}${a.bitrate ? " " + a.bitrate + "k" : ""}${a.loudness != null ? ` · ${a.loudness} LUFS` : ""}`);
    parts.push(spec.container.toUpperCase());
    return parts.join(" · ");
  }

  /* Rough Mb/s at 1920×1080 30 fps for the fixed-rate codecs (Apple's and
     Avid's published figures), scaled by pixels × fps. */
  const FIXED_MBPS = { prores: { proxy: 45, lt: 102, standard: 147, hq: 220, 4444: 330, "4444xq": 500 }, dnxhr: { lb: 45, sq: 145, hq: 220, hqx: 220, 444: 440 } };
  /** Bytes, or null when it cannot be known before encoding (CRF, lossless). */
  function estimateSize(spec, ctx) {
    const v = spec.video, a = spec.audio, dur = ctx.duration || 0;
    const w = spec.width || ctx.width || 1920, h = spec.height || ctx.height || 1080, fps = spec.fps || ctx.fps || 30;
    let vk = null;
    if (v.rate === "vbr" || v.rate === "cbr") vk = v.bitrate;
    else if (v.codec === "mpeg2") vk = 50000;
    else if (FIXED_MBPS[v.codec]) vk = FIXED_MBPS[v.codec][v.profile] * 1000 * (w * h * fps) / (1920 * 1080 * 30);
    if (vk == null) return null;
    const ak = a.codec === "none" ? 0 : a.bitrate || (a.codec === "pcm24" ? 24 : 16) * a.sampleRate * a.channels / 1000;
    return Math.round((vk + ak) * 1000 / 8 * dur);
  }

  /** Warnings worth reading before a long render.
   *  ctx: {duration, fps (output), canvasW, canvasH, region, presets} */
  function checks(spec, ctx = {}) {
    const out = [];
    const preset = PRESETS[spec.preset];
    const lim = (preset && preset.limits) || {};
    const fr = reframe(spec, ctx.canvasW || 1920, ctx.canvasH || 1080, ctx.region);
    const fps = spec.fps || ctx.fps || 30;
    if (fr.upscale) out.push(`Upscaled: the part of the picture used is ${fr.from.w}×${fr.from.h} and the output ${fr.outW}×${fr.outH} — a larger${spec.width && spec.height > spec.width ? " or vertical" : ""} project size keeps it sharp`);
    if (spec.width && spec.reframe === "fill" && fr.crop && ctx.canvasW && (fr.crop.w < (ctx.region ? ctx.region.w : ctx.canvasW) - 2 || fr.crop.h < (ctx.region ? ctx.region.h : ctx.canvasH) - 2))
      out.push(`Cropped to ${fr.crop.w}×${fr.crop.h} from the middle of the picture — set an export frame (⬒ Frame) to choose the part, or use Fit to keep everything`);
    if (lim.vertical && spec.width && spec.width > spec.height) out.push(`${preset.label} expects a vertical picture; this output is landscape`);
    if (lim.duration && ctx.duration > lim.duration + 0.05) out.push(`${preset.label}: ${fmtDur(ctx.duration)} is longer than ${fmtDur(lim.duration)} — check the platform's current limit`);
    if (lim.fps && fps > lim.fps + 0.01) out.push(`${preset.label} takes up to ${lim.fps} fps; this output is ${fps}`);
    if (lim.fpsList && !lim.fpsList.some((f) => Math.abs(f - fps) < 0.02)) out.push(`Broadcast usually wants ${lim.fpsList.join(" / ")} fps; this output is ${fps}`);
    const size = estimateSize(spec, { duration: ctx.duration, width: fr.outW, height: fr.outH, fps });
    if (lim.size && size && size > lim.size) out.push(`${preset.label} takes files up to ${fmtBytes(lim.size)}; this one will be about ${fmtBytes(size)}`);
    if (spec.video.codec === "mpeg2" && (fr.outW !== 1920 || fr.outH !== 1080)) out.push("XDCAM HD422 is 1920×1080 — other sizes may be refused by playout servers");
    return out;
  }
  function fmtDur(s) { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`; }
  function fmtBytes(b) { return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }

  /** Presets in dropdown order, grouped: [{group, items:[{id, label, note}]}].
   *  User presets (id → spec with a label) come under "Saved". */
  function presetGroups(userPresets = {}) {
    const groups = [];
    const add = (g, id, p) => {
      let grp = groups.find((x) => x.group === g);
      if (!grp) groups.push(grp = { group: g, items: [] });
      grp.items.push({ id, label: p.label || id, note: p.note || "" });
    };
    for (const id of PRESET_IDS) if (PRESETS[id].group !== "Custom") add(PRESETS[id].group, id, PRESETS[id]);
    for (const [id, p] of Object.entries(userPresets)) add("Saved", id, p);
    add("Custom", "custom", PRESETS.custom);
    return groups;
  }

  /** A user preset id from its name: "My client 4K" → "my-client-4k". */
  function presetId(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  /** Saved presets from library/delivery/*.json (paths.readSaved output:
   *  [{file, data}]) → {id: spec + label + note}. Built-in ids cannot be shadowed. */
  function savedPresets(list) {
    const out = {};
    for (const { file, data } of list || []) {
      if (!data || typeof data !== "object") continue;
      const id = presetId(data.id || String(file || "").replace(/\.json$/i, ""));
      if (!id || PRESETS[id]) continue;
      const { spec } = normalize({ ...data, preset: "custom" });
      out[id] = { ...spec, preset: id, label: cleanText(data.label || id, 60), note: describe(spec) };
    }
    return out;
  }

  /** Parse `ffmpeg -encoders` output into a Set of encoder names. */
  function parseEncoders(text) {
    const set = new Set();
    for (const line of String(text || "").split(/\r?\n/)) {
      const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
      if (m && m[1] !== "=") set.add(m[1]);
    }
    return set;
  }

  return {
    CONTAINERS, CODECS, ENCODERS, AUDIO, COLORS, PRESETS, PRESET_IDS, DEFAULT_PRESET,
    FPS_CHOICES, RESOLUTIONS, SPEEDS, SAMPLE_RATES, META_KEYS, FILENAME_TOKENS,
    normalize, encodersFor, reframe, ffmpegArgs, videoFilter, frameInput, jpegQuality, fpsRational,
    renderFilename, projectFilename, describe, estimateSize, checks, presetGroups, presetId, savedPresets, parseEncoders,
    PLATFORM_LOUDNESS, LOUDNESS_TARGETS, LOUDNESS_ARGS, LOUDNORM_ARGS, parseLoudnorm, loudnormFilter, parseEbur128, verify,
    fmtBytes, fmtDur,
  };
});
