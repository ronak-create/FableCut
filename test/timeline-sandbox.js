/* A stubbed timeline for unit-testing app.js editing logic in Node.

   app.js is a browser script with no exports, so — like keyframes.test.js —
   the real functions are sliced out of the source by name markers and run
   inside a Function against a small world: `project`, `TRACKS`, `state`
   (disabled / locked / untargeted track sets, selection, playhead) and no-op
   stand-ins for everything that touches the DOM, audio or the network.
   Markers are unique function names or comment heads; a rename fails loudly
   instead of passing vacuously on an empty slice. */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { ROOT } = require("./helpers");
const FableCutEdit = require("../edit-ops.js");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  assert.ok(a >= 0, `start marker not found: ${startMarker}`);
  assert.ok(b > a, `end marker not found after it: ${endMarker}`);
  return SRC.slice(a, b);
}

const MIN_DUR = +/const MIN_DUR = ([\d.]+);/.exec(SRC)[1];

const CODE = [
  slice("function isTrackEnabled(", "function syncTrackDisabledUI("),
  slice("function audioTrackIds(", "function nextTrackId("),
  slice("function defaultTrackFor(", "function syncLinkedTiming("),
  slice("function toastNoSourceTarget(", "/** Apply Source In→Out to a timeline clip"),
  slice("function deleteSelected(", "const GAP_EPS = "),
  slice("const GAP_EPS = ", "function clearFocusedTransition("),
  slice("function splitAtPlayhead(", "function trimToPlayhead("),
  slice("/** Lift (;) removes IN→OUT", "function hasWorkArea("),
].join("\n");

const EXPORTS = [
  "sourceEditTracks", "placeSourceWindowClips", "punchTrackRange", "insertSourceAtPlayhead",
  "replaceSourceAtPlayhead", "deleteSelected", "rippleDeleteSelected", "closeGapAtPlayhead",
  "splitAtPlayhead", "relinkClips", "toggleClipsDisabled", "toggleClipsLocked",
  "toggleLinkSelected", "linkRefusal", "isGroupLocked", "isEditTarget", "clipRenders",
  "rippleTrim", "rollEdit", "slipClip", "slideClip", "liftExtract", "adjacentClip",
  "crossfadeCuts", "crossfadeCut", "crossfadeSelected",
];

const DEFAULT_TRACKS = ["V3", "V2", "V1", "A1", "A2", "A3"];

/* A fresh world per test. `trackIds` lists the live lanes; `disabled`,
   `locked` and `untargeted` switch lanes off, lock them, or drop them from
   edit targeting. `selected` seeds the selection. */
function world({
  trackIds = DEFAULT_TRACKS, disabled = [], locked = [], untargeted = [],
  clips = [], selected = [], time = 0, media = [{ id: "m1", kind: "video", duration: 60 }],
  inPoint = null, outPoint = null,
} = {}) {
  const project = { clips, media, inPoint, outPoint };
  const TRACKS = trackIds.map((id) => ({ id, kind: id[0] === "A" ? "audio" : "video" }));
  const state = {
    disabledTracks: new Set(disabled), lockedTracks: new Set(locked),
    untargetedTracks: new Set(untargeted),
    selIds: new Set(selected), time, playing: false, dirtyTimeline: false,
    source: { mediaId: null, fromClipId: null, playing: false },
  };
  const calls = { toast: [], applyWindow: 0, undo: 0 };
  let n = 0;
  let sourceWindow = () => null;
  const env = {
    project, TRACKS, state, MIN_DUR, MIN_TRANS_DUR: 0.1,
    DEFAULT_PROPS: { volume: 1 },
    uid: () => "u" + (++n),
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    clipEnd: (c) => c.start + c.duration,
    // No speed ramps in these fixtures: linear media time.
    mediaTimeAt: (c, t) => c.in + Math.min(c.duration, Math.max(0, t - c.start)) * (c.props?.speed || 1),
    getClip: (id) => project.clips.find((c) => c.id === id) || null,
    getMedia: (id) => project.media.find((m) => m.id === id),
    clipSpeed: (c) => Math.min(8, Math.max(0.1, +(c.props?.speed) || 1)),
    updateWorkArea() {}, syncTrimIOButton() {},
    setTime: (t) => { state.time = t; },
    selectedClips: () => project.clips.filter((c) => state.selIds.has(c.id)),
    setSelection: (ids) => { state.selIds = new Set(ids); },
    selectClip: (id) => { state.selIds = new Set([id]); },
    releaseClipEl() {}, scheduleSave() {}, renderInspector() {}, pruneSelection() {},
    ensureWave() {}, reconcileAudioChannels() {}, pause() {}, pauseSource() {},
    ensurePlayheadVisible() {}, toastSourceWindowMissing() {},
    defaultPanForChannel: (ch) => (ch === 0 ? -1 : ch === 1 ? 1 : 0),
    FableCutEdit, shiftKF: FableCutEdit.shiftKF, undoSnapshot: () => null,
    pushUndo: () => { calls.undo++; },
    toast: (msg) => { calls.toast.push(msg); },
    applySourceWindowToClip: () => { calls.applyWindow++; },
    sourceInsertWindow: () => sourceWindow(),
  };
  const names = Object.keys(env);
  const fns = new Function(...names, `${CODE}\nreturn { ${EXPORTS.join(", ")} };`)(
    ...names.map((k) => env[k]));
  return {
    ...fns, project, state, calls,
    setWindow: (fn) => { sourceWindow = fn; },
    byId: (id) => project.clips.find((c) => c.id === id),
  };
}

const clip = (id, track, start, duration, extra = {}) => ({
  id, track, start, duration, in: 0, kind: track[0] === "A" ? "audio" : "video",
  mediaId: "m1", props: {}, ...extra,
});

module.exports = { world, clip, MIN_DUR, SRC };
