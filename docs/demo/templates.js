/* FableCut animation presets and templates. Zero dependencies. Loaded by the
   editor as a plain script (global `FableCutTemplates`) and required by the MCP
   server and the tests.

   A PRESET is a named animation that fits any visual clip:
     { id, name, group, anchor: "in" | "out" | "at" | "whole", length, keys: { channel: [{t, v, ease?}] }, props? }
   "in" plays from the clip's start, "out" ends at its end, "at" plays at a
   given time (an emphasis), "whole" spans the clip (a loop; its key times are
   fractions 0…1 of the clip). Key values are relative to the clip's own value
   of that channel at rest: `scale` and `opacity` multiply it, everything else
   adds to it. So "Slide up" works wherever the clip sits and however big it is.

   A TEMPLATE is a composition with editable fields:
     { id, name, group, width, height, duration, hold, background?, tracks?, clips, media?, fields }
   fields: [{ key, label, type: "text" | "color" | "media", default?, targets: ["<clip id>:<path>" | "comp:background"] }]
   Placing one makes its own comp (so two lower thirds can say different
   names) and records the field values in comp.template. `hold` is the time the
   exit animation starts: retime() keeps everything after it at the same
   distance from the end, so a longer template just holds longer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutTemplates = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const r4 = (v) => +(+v).toFixed(4);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const EPS = 1e-4;

  /* ── Presets ── */
  const EASES = ["linear", "ease-in", "ease-out", "ease-in-out"];
  const ANCHORS = ["in", "out", "at", "whole"];
  /** Channels a preset may key. scale and opacity multiply the clip's value; the rest add to it. */
  const CHANNELS = ["x", "y", "scale", "rotation", "opacity", "blur", "anchorX", "anchorY", "trimStart", "trimEnd", "trimOffset",
    "brightness", "saturation", "hue", "grayscale", "shake", "rgbSplit", "glow", "fontSize", "letterSpacing", "pathOffset"];
  const MULTIPLY = new Set(["scale", "opacity"]);
  const PRESET_PROPS = ["motionBlur", "motionBlurSamples"];
  const REST = { scale: 1, opacity: 1, brightness: 100, saturation: 100, trimEnd: 100 };

  const k = (t, v, ease) => (ease ? { t, v, ease } : { t, v });
  const FLIP = { "ease-in": "ease-out", "ease-out": "ease-in" };
  /** An exit from an entrance: the same moves played backwards (eases flip with them). */
  function mirror(p, id, name) {
    const keys = {};
    for (const [ch, list] of Object.entries(p.keys)) {
      const rev = list.map((x, i) => ({ t: r4(p.length - x.t), v: x.v, ease: i + 1 < list.length ? list[i + 1].ease : undefined })).reverse();
      keys[ch] = rev.map((x) => (x.ease && x.ease !== "ease-in-out" ? { t: x.t, v: x.v, ease: FLIP[x.ease] || x.ease } : { t: x.t, v: x.v }));
    }
    return { id, name, group: "Out", anchor: "out", length: p.length, keys, ...(p.props ? { props: { ...p.props } } : {}) };
  }

  const IN = [
    { id: "fade-in", name: "Fade in", length: 0.5, keys: { opacity: [k(0, 0), k(0.5, 1)] } },
    { id: "pop-in", name: "Pop in", length: 0.4, keys: { scale: [k(0, 0), k(0.25, 1.12, "ease-out"), k(0.4, 1)], opacity: [k(0, 0), k(0.12, 1)] } },
    { id: "slide-up-in", name: "Slide up", length: 0.6, keys: { y: [k(0, 120), k(0.6, 0, "ease-out")], opacity: [k(0, 0), k(0.3, 1)] } },
    { id: "slide-down-in", name: "Slide down", length: 0.6, keys: { y: [k(0, -120), k(0.6, 0, "ease-out")], opacity: [k(0, 0), k(0.3, 1)] } },
    { id: "slide-left-in", name: "Slide in from the right", length: 0.6, keys: { x: [k(0, 400), k(0.6, 0, "ease-out")], opacity: [k(0, 0), k(0.3, 1)] } },
    { id: "slide-right-in", name: "Slide in from the left", length: 0.6, keys: { x: [k(0, -400), k(0.6, 0, "ease-out")], opacity: [k(0, 0), k(0.3, 1)] } },
    { id: "drop-in", name: "Drop and bounce", length: 0.8, keys: { y: [k(0, -500), k(0.45, 0, "ease-in"), k(0.6, -40, "ease-out"), k(0.8, 0, "ease-in")], opacity: [k(0, 0), k(0.1, 1)] } },
    { id: "zoom-in", name: "Zoom in", length: 0.6, keys: { scale: [k(0, 1.6), k(0.6, 1, "ease-out")], opacity: [k(0, 0), k(0.35, 1)], blur: [k(0, 14), k(0.6, 0, "ease-out")] } },
    { id: "spin-in", name: "Spin in", length: 0.7, keys: { rotation: [k(0, -180), k(0.7, 0, "ease-out")], scale: [k(0, 0), k(0.7, 1, "ease-out")], opacity: [k(0, 0), k(0.2, 1)] } },
    { id: "whip-in", name: "Whip in", length: 0.45, keys: { x: [k(0, -1400), k(0.45, 0, "ease-out")] }, props: { motionBlur: 180 } },
    { id: "rise-blur", name: "Rise and focus", length: 0.8, keys: { y: [k(0, 40), k(0.8, 0, "ease-out")], blur: [k(0, 16), k(0.8, 0, "ease-out")], opacity: [k(0, 0), k(0.5, 1)] } },
    { id: "draw-on", name: "Draw on (shapes)", length: 1, keys: { trimEnd: [k(0, -100), k(1, 0, "ease-out")] } },
  ].map((p) => ({ ...p, group: "In", anchor: "in" }));
  const OUT = [
    mirror(IN[0], "fade-out", "Fade out"),
    mirror(IN[1], "pop-out", "Pop out"),
    mirror(IN[3], "slide-up-out", "Slide out up"),
    mirror(IN[2], "slide-down-out", "Slide out down"),
    mirror(IN[5], "slide-left-out", "Slide out to the left"),
    mirror(IN[4], "slide-right-out", "Slide out to the right"),
    mirror(IN[7], "zoom-out", "Zoom out"),
    mirror(IN[8], "spin-out", "Spin out"),
    { ...mirror(IN[9], "whip-out", "Whip out"), keys: { x: [k(0, 0), k(0.45, 1400, "ease-in")] } },
    mirror(IN[10], "sink-blur", "Sink and blur"),
    mirror(IN[11], "draw-off", "Draw off (shapes)"),
  ];
  const AT = [
    { id: "pulse", name: "Pulse", length: 0.4, keys: { scale: [k(0, 1), k(0.15, 1.12, "ease-out"), k(0.4, 1)] } },
    { id: "shake", name: "Shake", length: 0.35, keys: { x: [k(0, 0), k(0.05, -18), k(0.1, 16), k(0.15, -12), k(0.2, 8), k(0.27, -4), k(0.35, 0)] } },
    { id: "wobble", name: "Wobble", length: 0.5, keys: { rotation: [k(0, 0), k(0.12, -8, "ease-out"), k(0.3, 6), k(0.5, 0)] } },
    { id: "bounce", name: "Bounce", length: 0.65, keys: { y: [k(0, 0), k(0.2, -60, "ease-out"), k(0.4, 0, "ease-in"), k(0.52, -18, "ease-out"), k(0.65, 0, "ease-in")] } },
    { id: "flash", name: "Flash", length: 0.4, keys: { brightness: [k(0, 0), k(0.06, 80), k(0.4, 0, "ease-out")] } },
  ].map((p) => ({ ...p, group: "Emphasis", anchor: "at" }));
  /* Loops are generated for the clip's length, a whole number of cycles. */
  const cycles = (dur, period) => Math.max(1, Math.round(dur / period));
  /** Keys stepping through `values` over and over, `steps` per cycle, ending where they began. */
  const cycle = (dur, period, values) => {
    const n = cycles(dur, period) * values.length, out = [];
    for (let i = 0; i <= n; i++) out.push(k(r4(i * dur / n), values[i % values.length]));
    return out;
  };
  const LOOP = [
    { id: "float", name: "Float", gen: (dur) => ({ y: cycle(dur, 2.4, [0, -14]) }) },
    { id: "breathe", name: "Breathe", gen: (dur) => ({ scale: cycle(dur, 1.2, [1, 1.06]) }) },
    { id: "sway", name: "Sway", gen: (dur) => ({ rotation: cycle(dur, 2.4, [0, -6, 0, 6]) }) },
    { id: "spin", name: "Spin", gen: (dur) => ({ rotation: [k(0, 0), k(r4(dur), 360 * cycles(dur, 4), "linear")] }) },
    { id: "wiggle", name: "Wiggle", gen: (dur) => {
      // a fixed pseudo-random walk, so the same clip wiggles the same way every time
      let s = 7;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
      const n = Math.max(2, Math.round(dur / 0.12)), x = [k(0, 0)], y = [k(0, 0)];
      for (let i = 1; i < n; i++) { const t = r4(i * dur / n); x.push(k(t, r4(rnd() * 10))); y.push(k(t, r4(rnd() * 10))); }
      x.push(k(r4(dur), 0)); y.push(k(r4(dur), 0));
      return { x, y };
    } },
  ].map((p) => ({ ...p, group: "Loop", anchor: "whole" }));
  const PRESETS = [...IN, ...OUT, ...AT, ...LOOP];

  /** A preset, validated. strict: throw on bad input (agent / saved file). */
  function normalizePreset(p, strict = false) {
    const bad = (m) => { if (strict) throw new Error(m); return null; };
    if (!isObj(p)) return bad("a preset is an object like {name, anchor, length, keys:{channel:[{t, v}]}}");
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : null;
    const id = slug(p.id || name);
    if (!id) return bad("a preset needs a name");
    const anchor = p.anchor || "in";
    if (!ANCHORS.includes(anchor)) return bad(`preset ${id}: anchor is ${ANCHORS.join(" | ")}`);
    const length = anchor === "whole" ? 1 : p.length;
    if (!isNum(length) || length <= 0 || length > 60) return bad(`preset ${id}: length is seconds, more than 0`);
    if (!isObj(p.keys) || !Object.keys(p.keys).length) return bad(`preset ${id}: keys is {channel: [{t, v, ease?}, …]}`);
    const keys = {};
    for (const [ch, list] of Object.entries(p.keys)) {
      if (!CHANNELS.includes(ch)) return bad(`preset ${id}: ${ch} can't be animated by a preset (${CHANNELS.join(", ")})`);
      if (!Array.isArray(list) || !list.length) return bad(`preset ${id}: keys.${ch} must be a list of {t, v, ease?}`);
      const out = [];
      for (const x of list) {
        if (!isObj(x) || !isNum(x.t) || !isNum(x.v) || x.t < 0 || x.t > length + EPS) return bad(`preset ${id}: keys.${ch} times run 0…${anchor === "whole" ? "1 (fractions of the clip)" : length}`);
        if (x.ease != null && !EASES.includes(x.ease)) return bad(`preset ${id}: ease is ${EASES.join(" | ")}`);
        out.push(x.ease && x.ease !== "ease-in-out" ? k(r4(x.t), r4(x.v), x.ease) : k(r4(x.t), r4(x.v)));
      }
      keys[ch] = out.sort((a, b) => a.t - b.t);
    }
    const props = {};
    for (const [key, v] of Object.entries(isObj(p.props) ? p.props : {})) {
      if (!PRESET_PROPS.includes(key) || !isNum(v)) return bad(`preset ${id}: props may set ${PRESET_PROPS.join(", ")}`);
      props[key] = v;
    }
    const group = typeof p.group === "string" && p.group.trim() ? p.group.trim().slice(0, 30) : "Saved";
    return { id, name: name || id, group, anchor, ...(anchor === "whole" ? {} : { length: r4(length) }), keys, ...(Object.keys(props).length ? { props } : {}) };
  }
  /** Find a preset by id or name among the built-ins and `saved`. */
  function findPreset(ref, saved = []) {
    if (isObj(ref)) return normalizePreset(ref, true);
    const want = slug(ref);
    return [...PRESETS, ...saved].find((p) => p.id === want || slug(p.name) === want) || null;
  }

  /** A channel's value at clip time t (keys interpolated linearly — enough to find a resting value). */
  function channelAt(c, ch, t) {
    const list = c.keyframes && c.keyframes[ch];
    if (Array.isArray(list) && list.length) {
      if (t <= list[0].t) return list[0].v;
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        if (t <= b.t) return b.t - a.t > EPS ? a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t) : b.v;
      }
      return list[list.length - 1].v;
    }
    const v = c.props && c.props[ch];
    return isNum(v) ? v : (REST[ch] ?? 0);
  }

  /** Put preset `p` on clip `c` (mutates it). opts.length stretches it, opts.at (clip time) places an emphasis.
   *  Keys already in the window it covers are replaced; the rest stay. Returns the channels it keyed. */
  function applyPreset(c, p, opts = {}) {
    const D = c.duration;
    if (!(D > 0)) throw new Error("the clip has no length");
    let w0 = 0, w1 = D, keys;
    if (p.anchor === "whole") {
      keys = p.gen ? p.gen(D) : Object.fromEntries(Object.entries(p.keys).map(([ch, l]) => [ch, l.map((x) => ({ ...x, t: x.t * D }))]));
    } else {
      const L = Math.min(D, isNum(opts.length) && opts.length > 0 ? opts.length : p.length), s = L / p.length;
      if (p.anchor === "in") w1 = L;
      else if (p.anchor === "out") w0 = D - L;
      else { w0 = clamp(isNum(opts.at) ? opts.at : 0, 0, D - L); w1 = w0 + L; }
      keys = Object.fromEntries(Object.entries(p.keys).map(([ch, l]) => [ch, l.map((x) => ({ ...x, t: w0 + x.t * s }))]));
    }
    c.keyframes = c.keyframes || {};
    for (const [ch, list] of Object.entries(keys)) {
      // the value the animation settles on (or starts from): what the clip shows at that edge of the window today
      const base = p.anchor === "in" ? channelAt(c, ch, w1) : p.anchor === "whole" ? channelAt(c, ch, 0) : channelAt(c, ch, w0);
      const keep = p.anchor === "whole" ? [] : (c.keyframes[ch] || []).filter((x) => x.t < w0 - EPS || x.t > w1 + EPS);
      const add = list.map((x) => {
        const v = MULTIPLY.has(ch) ? base * x.v : base + x.v;
        return x.ease && x.ease !== "ease-in-out" ? k(r4(x.t), r4(v), x.ease) : k(r4(x.t), r4(v));
      });
      c.keyframes[ch] = [...keep, ...add].sort((a, b) => a.t - b.t);
    }
    if (p.props) { c.props = c.props || {}; Object.assign(c.props, p.props); }
    return Object.keys(keys);
  }

  /** A preset made from a clip's own keyframes between clip times from and to. */
  function presetFromClip(c, { name, anchor = "in", from = 0, to = c.duration } = {}) {
    if (!ANCHORS.includes(anchor)) throw new Error(`anchor is ${ANCHORS.join(" | ")}`);
    if (!(to - from > EPS)) throw new Error("the window to save is empty");
    const L = to - from, keys = {};
    for (const ch of CHANNELS) {
      const list = (c.keyframes && c.keyframes[ch] || []).filter((x) => x.t >= from - EPS && x.t <= to + EPS);
      if (!list.length) continue;
      const base = anchor === "in" ? channelAt(c, ch, to) : anchor === "whole" ? (isNum(c.props && c.props[ch]) ? c.props[ch] : (REST[ch] ?? 0)) : channelAt(c, ch, from);
      keys[ch] = list.map((x) => {
        const v = MULTIPLY.has(ch) ? (Math.abs(base) > EPS ? x.v / base : x.v) : x.v - base;
        const t = anchor === "whole" ? (x.t - from) / L : x.t - from;
        return x.ease && x.ease !== "ease-in-out" ? k(r4(t), r4(v), x.ease) : k(r4(t), r4(v));
      });
    }
    if (!Object.keys(keys).length) throw new Error("the clip has no keyframes a preset can carry there (" + CHANNELS.join(", ") + ")");
    const props = {};
    for (const key of PRESET_PROPS) if (isNum(c.props && c.props[key]) && c.props[key] > 0) props[key] = c.props[key];
    return normalizePreset({ name: name || c.name || "Preset", anchor, length: L, keys, props }, true);
  }

  /* ── Templates ── */
  const FIELD_TYPES = ["text", "color", "media"];
  const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const fade = (d) => ({ type: "fade", duration: d });
  const text = (id, track, start, duration, props, extra = {}) =>
    ({ id, kind: "text", mediaId: null, track, start, in: 0, duration, name: extra.name || id, props, ...extra.clip });
  const shape = (id, track, start, duration, props, extra = {}) =>
    ({ id, kind: "shape", mediaId: null, track, start, in: 0, duration, name: extra.name || id, props, ...extra.clip });
  const LOGO_MEDIA = { id: "tm_logo", name: "logo-placeholder.svg", kind: "svg", src: "/library/elements/logo-placeholder.svg" };
  const logo = (track, start, duration, extra = {}) =>
    ({ id: "logo", kind: "svg", mediaId: LOGO_MEDIA.id, track, start, in: 0, duration, name: "Logo", props: { fit: "contain", scale: 0.22, ...extra.props }, ...extra.clip });
  const TRACKS3 = [{ id: "V3", kind: "video" }, { id: "V2", kind: "video" }, { id: "V1", kind: "video" }];
  const TRACKS4 = [{ id: "V4", kind: "video" }, ...TRACKS3];

  const TEMPLATES = [
    /* ── Lower thirds (1920×1080, the bottom-left of the frame) ── */
    { id: "lower-third-bar", name: "Lower third — Bar", group: "Lower thirds", width: 1920, height: 1080, duration: 5, hold: 4.5, tracks: TRACKS3,
      clips: [
        shape("bar", "V1", 0, 5, { x: -840, y: 360, shapes: [
          { type: "rect", name: "Panel", x: 340, w: 680, h: 140, radius: 6, fill: "#111827e6", keys: [{ t: 0, x: 0, w: 0 }, { t: 0.5, x: 340, w: 680, ease: "ease-out" }] },
          { type: "rect", name: "Accent", x: 5, w: 10, h: 140, fill: "#ffd166", keys: [{ t: 0, h: 0 }, { t: 0.35, h: 140, ease: "ease-out" }] }] },
          { name: "Bar", clip: { transitionOut: fade(0.4) } }),
        text("name", "V2", 0.25, 4.75, { text: "Ava Moreno", font: "Archivo Black", fontSize: 54, color: "#ffffff", align: "left", boxW: 620, boxH: 140, x: -480, y: 335, textShadow: 0, textAnim: "rise-mask" },
          { name: "Name", clip: { transitionOut: fade(0.4) } }),
        text("title", "V3", 0.45, 4.55, { text: "Director of Photography", font: "Inter", fontSize: 30, bold: false, color: "#d1d5db", align: "left", boxW: 620, boxH: 80, x: -480, y: 394, textShadow: 0, textAnim: "clip-reveal" },
          { name: "Title", clip: { transitionOut: fade(0.4) } }),
      ],
      fields: [
        { key: "name", label: "Name", type: "text", targets: ["name:props.text"] },
        { key: "title", label: "Title", type: "text", targets: ["title:props.text"] },
        { key: "accent", label: "Accent", type: "color", targets: ["bar:props.shapes.1.fill"] },
        { key: "panel", label: "Panel", type: "color", targets: ["bar:props.shapes.0.fill"] },
      ] },
    { id: "lower-third-underline", name: "Lower third — Underline", group: "Lower thirds", width: 1920, height: 1080, duration: 5, hold: 4.5, tracks: TRACKS3,
      clips: [
        text("name", "V3", 0, 5, { text: "AVA MORENO", font: "Montserrat", fontSize: 60, weight: 800, color: "#ffffff", align: "left", boxW: 900, boxH: 156, x: -390, y: 318, letterSpacing: 2, textShadow: 10, textAnim: "letter-pop", wordRate: 0.04 },
          { name: "Name", clip: { transitionOut: fade(0.35) } }),
        shape("rule", "V2", 0.2, 4.8, { x: -840, y: 362, shapes: [
          { type: "line", name: "Line", points: [[0, 0], [560, 0]], stroke: "#22d3ee", strokeWidth: 6, lineCap: "round", keys: [{ t: 0, trimEnd: 0 }, { t: 0.7, trimEnd: 100, ease: "ease-out" }] }] },
          { name: "Underline", clip: { transitionOut: fade(0.35) } }),
        text("title", "V1", 0.6, 4.4, { text: "Director of Photography", font: "DM Sans", fontSize: 32, bold: false, color: "#e5e7eb", align: "left", boxW: 900, boxH: 84, x: -390, y: 402, textShadow: 8, textAnim: "rise-mask" },
          { name: "Title", clip: { transitionOut: fade(0.35) } }),
      ],
      fields: [
        { key: "name", label: "Name", type: "text", targets: ["name:props.text"] },
        { key: "title", label: "Title", type: "text", targets: ["title:props.text"] },
        { key: "accent", label: "Accent", type: "color", targets: ["rule:props.shapes.0.stroke"] },
      ] },
    { id: "lower-third-boxes", name: "Lower third — Boxes", group: "Lower thirds", width: 1920, height: 1080, duration: 5, hold: 4.5, tracks: TRACKS4,
      clips: [
        shape("nameBox", "V1", 0, 5, { x: -530, y: 330, motionBlur: 180, shapes: [{ type: "rect", name: "Box", w: 620, h: 78, radius: 4, fill: "#ffd166" }] },
          { name: "Name box", clip: { keyframes: { x: [{ t: 0, v: -1500 }, { t: 0.45, v: -530, ease: "ease-out" }, { t: 4.55, v: -530 }, { t: 5, v: -1500, ease: "ease-in" }] } } }),
        shape("titleBox", "V2", 0.12, 4.88, { x: -530, y: 396, motionBlur: 180, shapes: [{ type: "rect", name: "Box", w: 620, h: 54, radius: 4, fill: "#111827eb" }] },
          { name: "Title box", clip: { keyframes: { x: [{ t: 0, v: -1500 }, { t: 0.45, v: -530, ease: "ease-out" }, { t: 4.4, v: -530 }, { t: 4.88, v: -1500, ease: "ease-in" }] } } }),
        text("name", "V3", 0, 5, { text: "Ava Moreno", font: "Poppins", fontSize: 44, weight: 700, color: "#111111", align: "left", boxW: 580, boxH: 78, textShadow: 0, motionBlur: 180 },
          { name: "Name", clip: { parent: "nameBox" } }),
        text("title", "V4", 0.12, 4.88, { text: "Director of Photography", font: "Poppins", fontSize: 27, bold: false, weight: 400, color: "#ffffff", align: "left", boxW: 580, boxH: 54, textShadow: 0, motionBlur: 180 },
          { name: "Title", clip: { parent: "titleBox" } }),
      ],
      fields: [
        { key: "name", label: "Name", type: "text", targets: ["name:props.text"] },
        { key: "title", label: "Title", type: "text", targets: ["title:props.text"] },
        { key: "accent", label: "Accent", type: "color", targets: ["nameBox:props.shapes.0.fill"] },
        { key: "box", label: "Title box", type: "color", targets: ["titleBox:props.shapes.0.fill"] },
      ] },

    /* ── Logo animations (1920×1080, transparent) ── */
    { id: "logo-ring", name: "Logo — Ring reveal", group: "Logo animations", width: 1920, height: 1080, duration: 4, hold: 3.5, tracks: TRACKS3, media: [LOGO_MEDIA],
      clips: [
        shape("ring", "V1", 0, 4, { y: -40, shapes: [
          { type: "ellipse", name: "Ring", w: 330, h: 330, rotation: -90, fill: "none", stroke: "#ffd166", strokeWidth: 10, keys: [{ t: 0, trimEnd: 0 }, { t: 0.9, trimEnd: 100, ease: "ease-out" }] }] },
          { name: "Ring", clip: { transitionOut: fade(0.5) } }),
        logo("V2", 0.35, 3.65, { props: { y: -40, scale: 0.2 }, clip: { keyframes: { scale: [{ t: 0, v: 0 }, { t: 0.35, v: 0.23, ease: "ease-out" }, { t: 0.5, v: 0.2 }], opacity: [{ t: 0, v: 0 }, { t: 0.15, v: 1 }] }, transitionOut: fade(0.5) } }),
        text("brand", "V3", 0.9, 3.1, { text: "YOUR BRAND", font: "Bebas Neue", fontSize: 72, color: "#ffffff", y: 200, letterSpacing: 14, textShadow: 0, textAnim: "rise-mask" },
          { name: "Brand", clip: { transitionOut: fade(0.5) } }),
      ],
      fields: [
        { key: "logo", label: "Logo", type: "media", targets: ["logo:mediaId"] },
        { key: "brand", label: "Brand", type: "text", targets: ["brand:props.text"] },
        { key: "accent", label: "Accent", type: "color", targets: ["ring:props.shapes.0.stroke"] },
      ] },
    { id: "logo-slam", name: "Logo — Slam", group: "Logo animations", width: 1920, height: 1080, duration: 3.5, hold: 3, tracks: TRACKS3, media: [LOGO_MEDIA],
      clips: [
        shape("burst", "V1", 0.35, 0.7, { shapes: [{ type: "group", name: "Burst", scale: 0.5, items:
          [0, 45, 90, 135, 180, 225, 270, 315].map((r) => ({ type: "line", rotation: r, points: [[190, 0], [300, 0]], stroke: "#ff7ac8", strokeWidth: 8, lineCap: "round" })),
          keys: [{ t: 0, scale: 0.5, opacity: 1 }, { t: 0.6, scale: 1.25, opacity: 0, ease: "ease-out" }] }] }, { name: "Burst" }),
        logo("V2", 0, 3.5, { props: { motionBlur: 180 }, clip: {
          keyframes: { scale: [{ t: 0, v: 1.4 }, { t: 0.35, v: 0.22, ease: "ease-in" }], opacity: [{ t: 0, v: 0 }, { t: 0.2, v: 1 }], blur: [{ t: 0, v: 18 }, { t: 0.35, v: 0, ease: "ease-in" }], shake: [{ t: 0.35, v: 0 }, { t: 0.4, v: 22 }, { t: 0.8, v: 0, ease: "ease-out" }] },
          transitionOut: fade(0.5) } }),
      ],
      fields: [
        { key: "logo", label: "Logo", type: "media", targets: ["logo:mediaId"] },
        { key: "accent", label: "Burst", type: "color", targets: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `burst:props.shapes.0.items.${i}.stroke`) },
      ] },
    { id: "logo-lines", name: "Logo — Lines", group: "Logo animations", width: 1920, height: 1080, duration: 4, hold: 3.5, tracks: TRACKS3, media: [LOGO_MEDIA],
      clips: [
        shape("lines", "V1", 0, 4, { shapes: [
          { type: "line", name: "Top", y: -170, points: [[-300, 0], [300, 0]], stroke: "#ffffff", strokeWidth: 3, trimStart: 50, trimEnd: 50, keys: [{ t: 0, trimStart: 50, trimEnd: 50 }, { t: 0.8, trimStart: 0, trimEnd: 100, ease: "ease-out" }] },
          { type: "line", name: "Bottom", y: 150, points: [[-300, 0], [300, 0]], stroke: "#ffffff", strokeWidth: 3, trimStart: 50, trimEnd: 50, keys: [{ t: 0, trimStart: 50, trimEnd: 50 }, { t: 0.8, trimStart: 0, trimEnd: 100, ease: "ease-out" }] }] },
          { name: "Lines", clip: { transitionOut: fade(0.5) } }),
        logo("V2", 0.4, 3.6, { props: { y: -20, scale: 0.18 }, clip: { keyframes: { y: [{ t: 0, v: 20 }, { t: 0.6, v: -20, ease: "ease-out" }], opacity: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }] }, transitionOut: fade(0.5) } }),
        text("tagline", "V3", 1, 3, { text: "Made with care", font: "Playfair Display", fontSize: 40, italic: true, bold: false, color: "#ffffff", y: 205, textShadow: 0, textAnim: "typewriter" },
          { name: "Tagline", clip: { transitionOut: fade(0.5) } }),
      ],
      fields: [
        { key: "logo", label: "Logo", type: "media", targets: ["logo:mediaId"] },
        { key: "tagline", label: "Tagline", type: "text", targets: ["tagline:props.text"] },
        { key: "lines", label: "Lines", type: "color", targets: ["lines:props.shapes.0.stroke", "lines:props.shapes.1.stroke"] },
      ] },

    /* ── Social sizes ── */
    { id: "social-story", name: "Story — Headline (9:16)", group: "Social", width: 1080, height: 1920, duration: 6, hold: 5.4, background: "#14112b", tracks: TRACKS4,
      clips: [
        shape("blobs", "V1", 0, 6, { shapes: [
          { type: "ellipse", name: "Big", x: 330, y: -620, w: 720, h: 720, fill: "#7b6cff", keys: [{ t: 0, scale: 0 }, { t: 0.7, scale: 1, ease: "ease-out" }] },
          { type: "ellipse", name: "Small", x: -380, y: 700, w: 420, h: 420, fill: "#ff7ac8", keys: [{ t: 0.2, scale: 0 }, { t: 0.9, scale: 1, ease: "ease-out" }] }] },
          { name: "Shapes", clip: { transitionOut: fade(0.6) } }),
        text("headline", "V2", 0.4, 5.6, { text: "Big news is here", font: "Anton", fontSize: 150, color: "#ffffff", boxW: 900, boxH: 640, y: -120, lineHeight: 1.05, uppercase: true, textShadow: 0, textAnim: "word-pop", wordRate: 0.12 },
          { name: "Headline", clip: { transitionOut: fade(0.6) } }),
        text("subline", "V3", 1.1, 4.9, { text: "Everything you need to know, in one minute", font: "DM Sans", fontSize: 56, bold: false, color: "#d9d6ff", boxW: 860, boxH: 200, y: 260, textShadow: 0, textAnim: "rise-mask" },
          { name: "Subline", clip: { transitionOut: fade(0.6) } }),
        text("button", "V4", 1.7, 4.3, { text: "Read more", font: "Poppins", fontSize: 44, weight: 700, color: "#14112b", bgColor: "#ffd166", bgOpacity: 1, y: 560, textShadow: 0 },
          { name: "Button", clip: { keyframes: { scale: [{ t: 0, v: 0 }, { t: 0.25, v: 1.12, ease: "ease-out" }, { t: 0.4, v: 1 }] }, transitionOut: fade(0.6) } }),
      ],
      fields: [
        { key: "headline", label: "Headline", type: "text", targets: ["headline:props.text"] },
        { key: "subline", label: "Subline", type: "text", targets: ["subline:props.text"] },
        { key: "button", label: "Button", type: "text", targets: ["button:props.text"] },
        { key: "accent", label: "Accent", type: "color", targets: ["blobs:props.shapes.0.fill"] },
        { key: "background", label: "Background", type: "color", targets: ["comp:background"] },
      ] },
    { id: "social-quote", name: "Post — Quote (1:1)", group: "Social", width: 1080, height: 1080, duration: 6, hold: 5.4, background: "#0f172a", tracks: TRACKS3,
      clips: [
        text("mark", "V1", 0, 6, { text: "“", font: "Playfair Display", fontSize: 360, color: "#ffd166", x: -340, y: -260, textShadow: 0 },
          { name: "Quote mark", clip: { keyframes: { scale: [{ t: 0, v: 0 }, { t: 0.3, v: 1.1, ease: "ease-out" }, { t: 0.45, v: 1 }] }, transitionOut: fade(0.6) } }),
        text("quote", "V2", 0.35, 5.65, { text: "The best way to predict the future is to make it.", font: "Playfair Display", fontSize: 64, bold: false, color: "#ffffff", boxW: 840, boxH: 480, y: 10, lineHeight: 1.25, textShadow: 0, textAnim: "word-slide", wordRate: 0.1 },
          { name: "Quote", clip: { transitionOut: fade(0.6) } }),
        text("author", "V3", 1.8, 4.2, { text: "— A. Writer", font: "DM Sans", fontSize: 38, bold: false, color: "#94a3b8", y: 300, letterSpacing: 2, textShadow: 0, textAnim: "rise-mask" },
          { name: "Author", clip: { transitionOut: fade(0.6) } }),
      ],
      fields: [
        { key: "quote", label: "Quote", type: "text", targets: ["quote:props.text"] },
        { key: "author", label: "Author", type: "text", targets: ["author:props.text"] },
        { key: "accent", label: "Accent", type: "color", targets: ["mark:props.color"] },
        { key: "background", label: "Background", type: "color", targets: ["comp:background"] },
      ] },
    { id: "social-end-card", name: "End card — Follow (16:9)", group: "Social", width: 1920, height: 1080, duration: 6, hold: 5.4, background: "#0b0b12", tracks: TRACKS3,
      clips: [
        text("heading", "V1", 0, 6, { text: "Thanks for watching", font: "Montserrat", fontSize: 96, weight: 800, color: "#ffffff", y: -110, textShadow: 0, textAnim: "rise-mask" },
          { name: "Heading", clip: { transitionOut: fade(0.6) } }),
        shape("pill", "V2", 0.6, 5.4, { y: 90, shapes: [{ type: "rect", name: "Pill", w: 520, h: 110, radius: 55, fill: "#ff4d6d" }] },
          { name: "Pill", clip: { keyframes: { scale: [{ t: 0, v: 0 }, { t: 0.3, v: 1.1, ease: "ease-out" }, { t: 0.45, v: 1 }] }, transitionOut: fade(0.6) } }),
        text("button", "V3", 0.75, 5.25, { text: "Follow for more", font: "Poppins", fontSize: 44, weight: 700, color: "#ffffff", y: 90, textShadow: 0 },
          { name: "Button", clip: { keyframes: { opacity: [{ t: 0, v: 0 }, { t: 0.25, v: 1 }] }, transitionOut: fade(0.6) } }),
      ],
      fields: [
        { key: "heading", label: "Heading", type: "text", targets: ["heading:props.text"] },
        { key: "button", label: "Button", type: "text", targets: ["button:props.text"] },
        { key: "accent", label: "Button colour", type: "color", targets: ["pill:props.shapes.0.fill"] },
        { key: "background", label: "Background", type: "color", targets: ["comp:background"] },
      ] },
  ];

  /** Read a target ("clip:path" or "comp:background") inside a comp; returns {obj, key} to read or write. */
  function resolveTarget(comp, target) {
    const i = String(target).indexOf(":");
    if (i < 1) return null;
    const who = target.slice(0, i), path = target.slice(i + 1).split(".");
    let obj = who === "comp" ? comp : (comp.clips || []).find((c) => c.id === who);
    if (!obj || !path.length || path.some((s) => !s || s === "__proto__" || s === "constructor" || s === "prototype")) return null;
    for (const seg of path.slice(0, -1)) {
      obj = obj[seg];
      if (obj == null || typeof obj !== "object") return null;
    }
    return { obj, key: path[path.length - 1] };
  }
  /** A template, validated. strict: throw on bad input (agent / saved file). */
  function normalizeTemplate(t, strict = false) {
    const bad = (m) => { if (strict) throw new Error(m); return null; };
    if (!isObj(t)) return bad("a template is an object like {name, width, height, duration, clips, fields}");
    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 80) : null;
    const id = slug(t.id || name);
    if (!id) return bad("a template needs a name");
    for (const key of ["width", "height"]) if (!Number.isInteger(t[key]) || t[key] < 16 || t[key] > 8192) return bad(`template ${id}: ${key} must be a whole number of px (16…8192)`);
    if (!isNum(t.duration) || t.duration <= 0) return bad(`template ${id}: duration must be seconds > 0`);
    const hold = isNum(t.hold) ? clamp(t.hold, 0, t.duration) : t.duration;
    if (!Array.isArray(t.clips) || !t.clips.length) return bad(`template ${id}: clips must be a list`);
    const ids = new Set();
    for (const c of t.clips) {
      if (!isObj(c) || typeof c.id !== "string" || !c.track || !isNum(c.start) || !isNum(c.duration)) return bad(`template ${id}: every clip needs id, track, numeric start and duration`);
      if (ids.has(c.id)) return bad(`template ${id}: two clips have the id ${c.id}`);
      ids.add(c.id);
    }
    const media = [];
    for (const m of Array.isArray(t.media) ? t.media : []) {
      if (!isObj(m) || typeof m.id !== "string" || typeof m.src !== "string" || !/^\/(library|media)\//.test(m.src) || !["image", "svg", "video", "audio"].includes(m.kind))
        return bad(`template ${id}: media entries are {id, name, kind, src:"/library/…" | "/media/…"}`);
      media.push({ id: m.id, name: typeof m.name === "string" ? m.name : m.src.split("/").pop(), kind: m.kind, src: m.src });
    }
    const fields = [], keys = new Set();
    const probe = { ...t, clips: t.clips };
    for (const f of Array.isArray(t.fields) ? t.fields : []) {
      if (!isObj(f) || !slug(f.key)) return bad(`template ${id}: a field needs a key`);
      const key = slug(f.key);
      if (keys.has(key)) return bad(`template ${id}: two fields are called ${key}`);
      if (!FIELD_TYPES.includes(f.type)) return bad(`template ${id}: field ${key} type is ${FIELD_TYPES.join(" | ")}`);
      if (!Array.isArray(f.targets) || !f.targets.length || f.targets.some((x) => typeof x !== "string" || !resolveTarget(probe, x)))
        return bad(`template ${id}: field ${key} targets are "<clip id>:<path>" (e.g. "name:props.text") or "comp:background", and must exist`);
      keys.add(key);
      fields.push({ key, label: typeof f.label === "string" && f.label.trim() ? f.label.trim().slice(0, 40) : key, type: f.type, targets: f.targets.slice(0, 32) });
    }
    return {
      id, name: name || id, group: typeof t.group === "string" && t.group.trim() ? t.group.trim().slice(0, 30) : "Saved",
      width: t.width, height: t.height, duration: r4(t.duration), hold: r4(hold),
      ...(typeof t.background === "string" ? { background: t.background } : {}),
      ...(Array.isArray(t.tracks) ? { tracks: clone(t.tracks) } : {}),
      clips: clone(t.clips), ...(media.length ? { media } : {}), fields,
    };
  }
  function findTemplate(ref, saved = []) {
    if (isObj(ref)) return normalizeTemplate(ref, true);
    const want = slug(ref);
    return [...TEMPLATES, ...saved].find((t) => t.id === want || slug(t.name) === want) || null;
  }

  /** Write one field's value into a template comp (mutates it). doc: for media fields. */
  function setField(comp, key, value, doc = {}) {
    const tpl = comp.template;
    const f = tpl && (tpl.fields || []).find((x) => x.key === key);
    if (!f) throw new Error(`comp ${comp.id} has no field ${key}${tpl ? ` (fields: ${(tpl.fields || []).map((x) => x.key).join(", ")})` : " — it isn't a template"}`);
    if (f.type === "text") {
      if (typeof value !== "string") throw new Error(`field ${key} is text`);
      value = value.slice(0, 2000);
    } else if (f.type === "color") {
      if (typeof value !== "string" || !COLOR.test(value)) throw new Error(`field ${key} is a colour like "#ffd166"`);
    } else {
      const m = (doc.media || []).find((x) => x.id === value);
      if (!m) throw new Error(`field ${key} takes a media id from the project`);
      if (!["image", "svg", "video"].includes(m.kind)) throw new Error(`field ${key} needs a picture (image, svg or video), not ${m.kind}`);
    }
    for (const target of f.targets) {
      const r = resolveTarget(comp, target);
      if (!r) continue;
      r.obj[r.key] = value;
      if (f.type === "media") r.obj.kind = (doc.media || []).find((x) => x.id === value).kind;   // an svg logo replaced by a png becomes an image clip
    }
    f.value = value;
  }

  /** Read a field's current value from the comp itself. */
  function fieldValue(comp, f) {
    for (const target of f.targets) { const r = resolveTarget(comp, target); if (r && r.obj[r.key] != null) return r.obj[r.key]; }
    return f.value ?? null;
  }

  /** Shift every key after clip time `after` by `delta` (clip keyframes and shape item keys). */
  function shiftKeysAfter(c, after, delta) {
    for (const list of Object.values(c.keyframes || {})) if (Array.isArray(list)) for (const x of list) if (x.t > after + EPS) x.t = r4(x.t + delta);
    const walk = (items) => { for (const it of items || []) { for (const x of it.keys || []) if (x.t > after + EPS) x.t = r4(x.t + delta); walk(it.items); } };
    walk(c.props && c.props.shapes);
  }
  /** Change a template comp's length: what happens after its hold point keeps its distance from the end. */
  function retime(comp, duration) {
    const hold = comp.template && isNum(comp.template.hold) ? comp.template.hold : comp.duration;
    // the hold point can move back only to where the entrance has finished: the last key or clip start before it
    let settled = 0;
    const note = (t) => { if (t <= hold + EPS) settled = Math.max(settled, t); };
    for (const c of comp.clips || []) {
      note(c.start);
      for (const list of Object.values(c.keyframes || {})) if (Array.isArray(list)) for (const x of list) note(c.start + x.t);
      const walk = (items) => { for (const it of items || []) { for (const x of it.keys || []) note(c.start + x.t); walk(it.items); } };
      walk(c.props && c.props.shapes);
    }
    const min = r4(Math.max(0.5, settled + 0.25 + (comp.duration - hold)));
    if (!isNum(duration) || duration < min) throw new Error(`comp ${comp.id} can't be shorter than ${min}s (its animation needs that long)`);
    const delta = duration - comp.duration;
    if (Math.abs(delta) < EPS) return comp;
    for (const c of comp.clips || []) {
      if (c.start >= hold - EPS) c.start = r4(c.start + delta);
      else if (c.start + c.duration > hold + EPS) { c.duration = r4(c.duration + delta); shiftKeysAfter(c, hold - c.start, delta); }
    }
    if (comp.template) comp.template.hold = r4(hold + delta);
    comp.duration = r4(duration);
    return comp;
  }

  const rid = (p) => p + Math.random().toString(36).slice(2, 9);
  /** Place template `tpl` in doc: a new comp (added to doc.comps), any media it needs (added to doc.media,
   *  reusing entries with the same src) and a comp clip, returned (not added). */
  function instantiate(doc, tpl, { compId, clipId, name, start = 0, track = "V2", duration, fields = {} } = {}) {
    const t = normalizeTemplate(tpl, true);
    doc.media = doc.media || [];
    doc.comps = doc.comps || [];
    const mediaMap = {};
    for (const m of t.media || []) {
      let have = doc.media.find((x) => x.src === m.src);
      if (!have) { have = { id: rid("m_"), name: m.name, kind: m.kind, src: m.src }; doc.media.push(have); }
      mediaMap[m.id] = have.id;
    }
    const clips = t.clips.map((c) => (c.mediaId && mediaMap[c.mediaId] ? { ...c, mediaId: mediaMap[c.mediaId] } : c));
    const id = compId || rid("tpl_");
    if (doc.comps.some((c) => c.id === id)) throw new Error(`a comp ${id} already exists`);
    const n = doc.comps.filter((c) => c.template && c.template.id === t.id).length + 1;
    const comp = {
      id, name: (name || (n > 1 ? `${t.name} ${n}` : t.name)).slice(0, 80), width: t.width, height: t.height, duration: t.duration,
      ...(t.background ? { background: t.background } : {}), ...(t.tracks ? { tracks: t.tracks } : {}), clips,
      template: { id: t.id, hold: t.hold, fields: t.fields.map((f) => ({ ...f, targets: f.targets.slice() })) },
    };
    for (const f of comp.template.fields) f.value = fieldValue(comp, f);
    for (const [key, v] of Object.entries(fields || {})) setField(comp, slug(key), v, doc);
    if (duration != null) retime(comp, duration);
    doc.comps.push(comp);
    const clip = { id: clipId || rid("c_"), kind: "comp", compId: id, mediaId: null, track, start: r4(Math.max(0, start)), in: 0, duration: comp.duration, name: comp.name, props: { fit: "contain" } };
    return { comp, clip };
  }

  /** A template made from a comp. fields: as in a template, or left out to offer every title's text and every picture. */
  function templateFromComp(comp, { name, group = "Saved", fields, hold, media = [] } = {}) {
    const auto = [];
    const seen = new Set();
    for (const c of comp.clips || []) {
      const label = (c.name || c.id).slice(0, 40);
      let key = slug(label) || slug(c.id);
      while (seen.has(key)) key += "-2";
      if (c.kind === "text") { seen.add(key); auto.push({ key, label, type: "text", targets: [`${c.id}:props.text`] }); }
      else if ((c.kind === "image" || c.kind === "svg") && c.mediaId) { seen.add(key); auto.push({ key, label, type: "media", targets: [`${c.id}:mediaId`] }); }
    }
    const own = comp.template && comp.template.fields;
    const used = new Set((comp.clips || []).map((c) => c.mediaId).filter(Boolean));
    return normalizeTemplate({
      name: name || comp.name, group, width: comp.width, height: comp.height, duration: comp.duration,
      hold: isNum(hold) ? hold : comp.template && isNum(comp.template.hold) ? comp.template.hold : comp.duration,
      background: comp.background, tracks: comp.tracks, clips: comp.clips,
      media: media.filter((m) => used.has(m.id)),
      fields: fields || (own ? own.map(({ key, label, type, targets }) => ({ key, label, type, targets })) : auto),
    }, true);
  }

  /** A preset / template about to be saved, renamed if it would take a built-in's id (it couldn't be found then). */
  function asSaved(item, kind) {
    const builtIn = kind === "presets" ? PRESETS : TEMPLATES;
    if (!builtIn.some((x) => x.id === item.id || slug(x.name) === item.id)) return item;
    const name = `${item.name} (saved)`.slice(0, kind === "presets" ? 60 : 80);
    return { ...item, id: slug(name), name };
  }

  /** One line per preset / template, for docs and agent errors. */
  const presetLine = (p) => `${p.id} (${p.group.toLowerCase()}${p.length ? `, ${p.length}s` : ""})`;
  const templateLine = (t) => `${t.id} ${t.width}x${t.height} ${t.duration}s [${t.fields.map((f) => f.key).join(", ")}]`;

  return {
    PRESETS, TEMPLATES, CHANNELS, MULTIPLY, EASES, ANCHORS, FIELD_TYPES,
    slug, normalizePreset, findPreset, channelAt, applyPreset, presetFromClip, presetLine,
    normalizeTemplate, findTemplate, resolveTarget, setField, fieldValue, retime, instantiate, templateFromComp, templateLine, asSaved,
  };
});
