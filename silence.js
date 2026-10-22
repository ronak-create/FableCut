/* FableCut silence — find the quiet stretches between phrases and cut them
   out. Zero dependencies; loaded by the editor as a plain script (global
   `FableCutSilence`) and required by the MCP server, so the inspector's
   Silence section and `fablecut_silence` find the same spans and cut them
   with the same `extract` ops.

   Sound comes from ducking.js (rmsEnvelope → activeRegions → mergeRegions,
   no gap bridging). Here: silentSpans (what lies between the sounds, inside
   the clips, keeping `padding` of quiet around each phrase, on whole frames)
   → cutOps (one extract per span, last first, so earlier times stay put). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutSilence = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = { threshold: -40, minSilence: 0.5, padding: 0.15 };
  const LIMITS = { threshold: [-80, -10], minSilence: [0.1, 10], padding: [0, 2] };
  /** Sound shorter than this still counts (a short word); quieter blips don't. */
  const MIN_SOUND = 0.08;

  /** The settings, defaulted and checked. Throws on a value out of range. */
  function options(o = {}) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      const v = o[k] == null ? DEFAULTS[k] : +o[k];
      const [lo, hi] = LIMITS[k];
      if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be ${lo}…${hi}`);
      out[k] = v;
    }
    return out;
  }

  /** Union of [start, end] spans, sorted. */
  function union(list) {
    const out = [];
    for (const [s, e] of list.filter((r) => r[1] > r[0]).sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }

  /** Silent spans to cut, timeline seconds: the gaps between `sound` regions
   *  inside `ranges` (the clips' extents) that last at least `minSilence`,
   *  less `padding` kept after the phrase before and before the phrase after
   *  (none at a range's own start or end), snapped inward to whole frames.
   *  Returns [{from, to}] in time order. */
  function silentSpans(sound, ranges, { minSilence = DEFAULTS.minSilence, padding = DEFAULTS.padding, fps = 30 } = {}) {
    const snd = union(sound);
    const frame = 1 / Math.max(1, +fps || 30);
    const out = [];
    for (const [rs, re] of union(ranges)) {
      let t = rs;
      const gaps = [];
      for (const [s, e] of snd) {
        if (e <= rs || s >= re) continue;
        if (s > t) gaps.push([t, s]);
        t = Math.max(t, e);
      }
      if (t < re) gaps.push([t, re]);
      for (const [a, b] of gaps) {
        if (b - a < minSilence - 1e-9) continue;
        const from = Math.ceil(((a > rs + 1e-6 ? a + padding : a) - 1e-6) / frame) * frame;
        const to = Math.floor(((b < re - 1e-6 ? b - padding : b) + 1e-6) / frame) * frame;
        if (to - from >= Math.max(frame, 0.05) - 1e-9) out.push({ from: r4(from), to: r4(to) });
      }
    }
    return out;
  }
  const r4 = (x) => Math.round(x * 10000) / 10000 || 0;   // as the editor stores times; never -0

  /** Patch ops that cut the spans out, last first. `tracks` limits the lanes
   *  (default: the targeted tracks), `force` cuts through locked material. */
  function cutOps(spans, { tracks = null, force = false } = {}) {
    return spans.slice().sort((x, y) => y.from - x.from).map((s) => ({
      op: "extract", from: s.from, to: s.to,
      ...(Array.isArray(tracks) && tracks.length ? { tracks: tracks.slice() } : {}),
      ...(force ? { force: true } : {}),
    }));
  }

  /** Seconds the spans add up to. */
  const total = (spans) => r4(spans.reduce((n, s) => n + (s.to - s.from), 0));

  return { DEFAULTS, LIMITS, MIN_SOUND, options, union, silentSpans, cutOps, total };
});
