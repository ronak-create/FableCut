/* Unit tests for the keyframe-editing core in app.js: channel evaluation,
   playhead-local writes (setAnimProp / toggleKfAtPlayhead / resets), the
   inspector playhead sync (stamp gate, slider saturation, off-clip lock-out)
   and the transition-envelope probe the canvas box drag uses to invert the
   compositor's envelope (transOffsetAt vs evalProps).

   app.js is a browser script with no exports, so — like meter-worklet.test.js —
   we run the relevant sections in Node. The pure-logic block
   (kfChannel … toggleKfAtPlayhead) and the inspector-sync block
   (syncInspectorOffClip / syncInspectorPlayhead) are sliced out of the source
   by function-name markers and evaluated with stubs; the constants they close
   over (ANIMATABLE, DEFAULT_PROPS, EASE) are lifted verbatim from the same
   file, so the tests can never drift away from the real tables. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const { ROOT } = require("./helpers");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/* Slice the source between two unique markers, failing loudly when a rename
   breaks the harness (a silent empty slice would pass vacuously). */
function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  assert.ok(a >= 0, `start marker not found: ${startMarker}`);
  assert.ok(b > a, `end marker not found after it: ${endMarker}`);
  return SRC.slice(a, b);
}

/* Evaluate an object/array literal lifted from the source. */
const lift = (re) => {
  const m = re.exec(SRC);
  assert.ok(m, `literal not found: ${re}`);
  return new Function(`return (${m[1]});`)();
};

const DEFAULT_PROPS = lift(/const DEFAULT_PROPS = (\{[\s\S]*?\n\});/);
const ANIMATABLE = lift(/const ANIMATABLE = (\[[\s\S]*?\]);/);
const EASE = lift(/const EASE = (\{[\s\S]*?\n\});/);

const LOGIC = slice("function kfChannel(", "function hasSpeedRamp(");
const SYNC = slice("function syncInspectorOffClip(", "/* ── Keyframe graphs");

/* Build the sandbox. Each test gets a fresh one: `state` and the inspector
   stamp/gen counters live in the closure and must not leak between tests. */
function makeSandbox({ fps = 50, clips = [] } = {}) {
  const state = { time: 0, dirtyTimeline: false, selId: null };
  const sandbox = { els: { inspector: null }, document: { activeElement: null }, holdRefreshes: 0 };
  const bindings = new Function(
    "ANIMATABLE", "DEFAULT_PROPS", "EASE", "clamp", "state", "els", "document",
    "getClip", "projectFps", "ensureFont", "scheduleAudioHoldRefresh",
    `${LOGIC}\n${SYNC}\nreturn {
      kfChannel, kfTimeEps, playheadOverClip, kfAtPlayhead, propsAtPlayhead,
      fmtInspNum, setAnimProp, resetPropChannel, resetPropAtPlayhead,
      toggleKfAtPlayhead, syncInspectorOffClip, syncInspectorPlayhead,
      inspStampNow, gen: () => inspPropGen, stamp: () => inspSyncStamp,
    };`
  )(
    ANIMATABLE, DEFAULT_PROPS, EASE,
    (v, a, b) => Math.min(b, Math.max(a, v)), // clamp, as in app.js
    state, sandbox.els, sandbox.document,
    (id) => clips.find((c) => c.id === id) || null,
    () => fps, () => {},
    () => { sandbox.holdRefreshes++; }, // the real one no-ops unless holding
  );
  return {
    state, els: sandbox.els, document: sandbox.document,
    get holdRefreshes() { return sandbox.holdRefreshes; }, // live — the stub bumps it after construction
    ...bindings,
  };
}

/* ── Minimal fake DOM for the inspector sync ── */
class FakeEl {
  constructor(attrs = {}) {
    this.dataset = attrs.dataset || {};
    this.type = attrs.type || "number";
    this.step = attrs.step;
    this.min = attrs.min;
    this.max = attrs.max;
    this.disabled = false;
    this.title = "";
    this.textContent = "";
    this.classes = new Set(attrs.classes || []);
    this.classList = {
      toggle: (cls, on) => (on ? this.classes.add(cls) : this.classes.delete(cls)),
      contains: (cls) => this.classes.has(cls),
    };
    this.writes = 0;
    this._value = String(attrs.value ?? "0");
  }
  get value() { return this._value; }
  set value(v) { this.writes++; this._value = String(v); }
}
function fakeInspector({ inputs = [], buttons = [], vals = {} }) {
  return {
    querySelectorAll(sel) {
      if (sel === "[data-k]") return inputs;
      if (sel === "[data-kf]") return buttons;
      return [];
    },
    querySelector(sel) {
      const m = /^\[data-val="(.+)"\]$/.exec(sel);
      return m ? vals[m[1]] || null : null;
    },
  };
}
const kfBtn = (k) => new FakeEl({ dataset: { kf: k } });
const scaleRow = (value = "1") => ({
  input: new FakeEl({ dataset: { k: "scale" }, type: "range", min: "0.1", max: "4", step: "0.01", value }),
  val: new FakeEl({ dataset: { unit: "" } }),
});

/* A clip on [10, 15] with a linear scale ramp 1 → 3 over local t 2 → 4. */
function keyedClip(over = {}) {
  return {
    id: "c1", start: 10, duration: 5,
    props: { ...DEFAULT_PROPS, scale: 0.8 },
    keyframes: { scale: [{ t: 2, v: 1 }, { t: 4, v: 3, ease: "linear" }] },
    ...over,
  };
}

/* ── kfChannel ── */
test("kfChannel: fallback, edge holds, interpolation, easing", () => {
  const { kfChannel } = makeSandbox();
  const c = keyedClip();
  assert.equal(kfChannel(c, "rotation", 2, 0.5), 0.5); // no channel → fallback
  assert.equal(kfChannel(c, "scale", 0, 0), 1);        // before first keyframe
  assert.equal(kfChannel(c, "scale", 99, 0), 3);       // after last keyframe
  assert.equal(kfChannel(c, "scale", 3, 0), 2);        // linear midpoint
  c.keyframes.scale[1].ease = "ease-in";
  assert.equal(kfChannel(c, "scale", 3, 0), 1 + 2 * 0.25); // u² at u=0.5
  c.keyframes.scale[1].ease = "bogus";
  assert.equal(kfChannel(c, "scale", 3, 0), 2);        // unknown ease → linear
});

/* ── playheadOverClip / kfAtPlayhead ── */
test("playheadOverClip: inside, edge tolerance, outside", () => {
  const { state, playheadOverClip, kfTimeEps } = makeSandbox();
  const c = keyedClip();
  const eps = kfTimeEps();
  state.time = 12;
  assert.equal(playheadOverClip(c), true);
  state.time = 10 - eps / 2;
  assert.equal(playheadOverClip(c), true); // half a frame before start still counts
  state.time = 15 + eps / 2;
  assert.equal(playheadOverClip(c), true); // half a frame after end still counts
  state.time = 10 - eps * 2;
  assert.equal(playheadOverClip(c), false);
  state.time = 16;
  assert.equal(playheadOverClip(c), false);
});

test("kfAtPlayhead: matches absolute playhead time, never clamps off-clip", () => {
  const { state, kfAtPlayhead, kfTimeEps } = makeSandbox();
  const c = keyedClip();
  state.time = 12 + kfTimeEps() / 2; // within eps of the t=2 keyframe (abs 12)
  assert.equal(kfAtPlayhead(c, "scale"), c.keyframes.scale[0]);
  state.time = 12.5;
  assert.equal(kfAtPlayhead(c, "scale"), null);
  state.time = 0; // off-clip: must NOT match the edge keyframe via clamping
  assert.equal(kfAtPlayhead(c, "scale"), null);
  assert.equal(kfAtPlayhead(c, "rotation"), null); // no channel
});

/* ── propsAtPlayhead ── */
test("propsAtPlayhead: keyed channels interpolate, statics pass through", () => {
  const { state, propsAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 13; // local 3 → midpoint of 1→3
  const p = propsAtPlayhead(c);
  assert.equal(p.scale, 2);
  assert.equal(p.rotation, 0);      // unkeyed static untouched
  assert.equal(p.opacity, 1);       // default untouched
  state.time = 0; // off-clip → nearest edge value, for display only
  assert.equal(propsAtPlayhead(c).scale, 1);
});

/* ── fmtInspNum ── */
test("fmtInspNum: integers, step rounding, fallback precision, junk", () => {
  const { fmtInspNum } = makeSandbox();
  assert.equal(fmtInspNum(1, "0.01"), "1");
  assert.equal(fmtInspNum(1.234567, "0.01"), "1.23");
  assert.equal(fmtInspNum(12, "1"), "12");
  assert.equal(fmtInspNum(0.123456), "0.123"); // no step → 3 decimals
  assert.equal(fmtInspNum(7.0000001), "7");
  assert.equal(fmtInspNum(NaN), "0");
});

/* ── setAnimProp ── */
test("setAnimProp: unkeyed channel writes the static prop", () => {
  const { state, setAnimProp, gen } = makeSandbox();
  const c = keyedClip();
  state.time = 0; // off-clip — static writes are playhead-independent
  const g = gen();
  assert.equal(setAnimProp(c, "rotation", 45), true);
  assert.equal(c.props.rotation, 45);
  assert.ok(gen() > g, "a write bumps the generation");
});

test("setAnimProp: keyed channel updates the keyframe under the playhead", () => {
  const { state, setAnimProp } = makeSandbox();
  const c = keyedClip();
  state.time = 12; // local 2 — on the first keyframe
  assert.equal(setAnimProp(c, "scale", 2.5), true);
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[2, 2.5], [4, 3]]);
});

test("setAnimProp: keyed channel off a keyframe auto-keys, sorted", () => {
  const { state, setAnimProp } = makeSandbox();
  const c = keyedClip();
  state.time = 13; // local 3 — between keyframes
  assert.equal(setAnimProp(c, "scale", 9), true);
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[2, 1], [3, 9], [4, 3]]);
  assert.equal(state.dirtyTimeline, true);
});

test("setAnimProp: off-clip keyed write is refused without touching anything", () => {
  const { state, setAnimProp, gen } = makeSandbox();
  const c = keyedClip();
  state.time = 0;
  const before = JSON.stringify(c.keyframes);
  const g = gen();
  assert.equal(setAnimProp(c, "scale", 9), false);
  assert.equal(JSON.stringify(c.keyframes), before); // the old bug: edge keyframe rewritten to 9
  assert.equal(c.props.scale, 0.8);
  assert.equal(gen(), g, "a refusal must not bump the generation");
});

test("setAnimProp: invalid input refused", () => {
  const { state, setAnimProp, gen } = makeSandbox();
  const c = keyedClip();
  state.time = 12;
  const g = gen();
  assert.equal(setAnimProp(c, "scale", NaN), false);
  assert.equal(setAnimProp(c, "notAProp", 1), false);
  assert.equal(setAnimProp(null, "scale", 1), false);
  assert.equal(gen(), g);
});

/* ── toggleKfAtPlayhead ── */
test("toggleKfAtPlayhead: adds a keyframe holding the playhead value", () => {
  const { state, toggleKfAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 13; // rotation unkeyed; current static is 0
  assert.equal(toggleKfAtPlayhead(c, "rotation"), true);
  assert.deepEqual(c.keyframes.rotation, [{ t: 3, v: 0 }]);
});

test("toggleKfAtPlayhead: removes the keyframe under the playhead", () => {
  const { state, toggleKfAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 12;
  assert.equal(toggleKfAtPlayhead(c, "scale"), true);
  assert.deepEqual(c.keyframes.scale, [{ t: 4, v: 3, ease: "linear" }]);
});

test("toggleKfAtPlayhead: removing the last keyframe promotes it to static", () => {
  const { state, toggleKfAtPlayhead } = makeSandbox();
  const c = keyedClip({ keyframes: { scale: [{ t: 2, v: 1.7 }] } });
  state.time = 12;
  assert.equal(toggleKfAtPlayhead(c, "scale"), true);
  assert.equal(c.keyframes, undefined); // channel (and empty map) gone
  assert.equal(c.props.scale, 1.7);     // value survives as the static prop
});

test("toggleKfAtPlayhead: refused off-clip, no phantom edge keyframe", () => {
  const { state, toggleKfAtPlayhead, gen } = makeSandbox();
  const c = keyedClip({ keyframes: undefined });
  state.time = 0;
  const g = gen();
  assert.equal(toggleKfAtPlayhead(c, "scale"), false);
  assert.equal(c.keyframes, undefined); // the old bug: keyframe planted at t=0
  assert.equal(gen(), g);
});

test("toggleKfAtPlayhead: eps-duplicate updates instead of inserting", () => {
  const { state, toggleKfAtPlayhead, kfTimeEps } = makeSandbox();
  const c = keyedClip();
  state.time = 12 + kfTimeEps() / 2; // sits on the first keyframe → removes it
  assert.equal(toggleKfAtPlayhead(c, "scale"), true);
  assert.equal(c.keyframes.scale.length, 1);
});

/* ── resets ── */
test("resetPropChannel: factory default + channel keyframes wiped", () => {
  const { resetPropChannel } = makeSandbox();
  const c = keyedClip();
  c.props.scale = 2.2;
  resetPropChannel(c, "scale");
  assert.equal(c.props.scale, 1);
  assert.equal(c.keyframes, undefined);
});

test("resetPropChannel: clears transitions", () => {
  const { resetPropChannel } = makeSandbox();
  const c = keyedClip({ transitionIn: { type: "fade", duration: 1 } });
  resetPropChannel(c, "transIn");
  assert.equal(c.transitionIn, undefined);
});

test("resetPropAtPlayhead: parked on a keyframe removes just that one", () => {
  const { state, resetPropAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 12;
  assert.equal(resetPropAtPlayhead(c, "scale"), true);
  assert.deepEqual(c.keyframes.scale, [{ t: 4, v: 3, ease: "linear" }]);
});

test("resetPropAtPlayhead: keyed off a keyframe sets default at the playhead", () => {
  const { state, resetPropAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 13; // local 3, between keyframes
  assert.equal(resetPropAtPlayhead(c, "scale"), true);
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[2, 1], [3, 1], [4, 3]]);
});

test("resetPropAtPlayhead: unkeyed writes the static default even off-clip", () => {
  const { state, resetPropAtPlayhead } = makeSandbox();
  const c = keyedClip();
  c.props.rotation = 77;
  state.time = 0;
  assert.equal(resetPropAtPlayhead(c, "rotation"), true);
  assert.equal(c.props.rotation, 0);
});

test("resetPropAtPlayhead: keyed off-clip is refused", () => {
  const { state, resetPropAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 0;
  const before = JSON.stringify(c.keyframes);
  assert.equal(resetPropAtPlayhead(c, "scale"), false);
  assert.equal(JSON.stringify(c.keyframes), before);
});

/* ── dirtyTimeline ownership ──
   The keyframe mutators own state.dirtyTimeline: they set it when a keyframe
   appears or disappears (clip markers must be rebuilt) and only then —
   value-only writes skip it because the graphs redraw every rAF regardless.
   Callers never set it on the mutators' behalf. */
test("dirtyTimeline: setAnimProp dirties on insert, not on value-only writes", () => {
  const { state, setAnimProp } = makeSandbox();
  const c = keyedClip();
  state.time = 12; // on the first keyframe → value update
  assert.equal(setAnimProp(c, "scale", 2), true);
  assert.equal(state.dirtyTimeline, false, "value update: no marker moved");
  state.time = 0;  // off-clip → static unkeyed write
  assert.equal(setAnimProp(c, "rotation", 5), true);
  assert.equal(state.dirtyTimeline, false, "static write: no keyframes involved");
  state.time = 13; // between keyframes → insert
  assert.equal(setAnimProp(c, "scale", 9), true);
  assert.equal(state.dirtyTimeline, true, "insert: a marker appears");
});

test("dirtyTimeline: toggleKfAtPlayhead dirties on add and on remove", () => {
  const { state, toggleKfAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 13;
  assert.equal(toggleKfAtPlayhead(c, "rotation"), true);
  assert.equal(state.dirtyTimeline, true, "add: a marker appears");
  state.dirtyTimeline = false;
  state.time = 12; // parked on an existing scale keyframe
  assert.equal(toggleKfAtPlayhead(c, "scale"), true);
  assert.equal(state.dirtyTimeline, true, "remove: a marker disappears");
});

test("dirtyTimeline: refused mutations stay clean", () => {
  const { state, toggleKfAtPlayhead, setAnimProp, resetPropAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 0; // off-clip
  assert.equal(toggleKfAtPlayhead(c, "scale"), false);
  assert.equal(setAnimProp(c, "scale", 9), false);
  assert.equal(resetPropAtPlayhead(c, "scale"), false);
  assert.equal(state.dirtyTimeline, false, "nothing changed → no rebuild");
});

test("dirtyTimeline: resetPropAtPlayhead inherits it from the delegate", () => {
  const { state, resetPropAtPlayhead } = makeSandbox();
  const c = keyedClip();
  state.time = 12; // on a keyframe → removal via toggleKfAtPlayhead
  assert.equal(resetPropAtPlayhead(c, "scale"), true);
  assert.equal(state.dirtyTimeline, true);
});

/* ── audio-hold refresh ownership ──
   Audio hold loops one frame of audio built from volume/pan/speed (the speed
   keyframes remap media time). The mutators must re-cut it on any such write —
   no matter which UI surface triggered it — and never for unrelated props. */
test("audio hold: setAnimProp refreshes on volume/pan/speed only", () => {
  const sb = makeSandbox();
  const c = keyedClip();
  sb.state.time = 12;
  sb.setAnimProp(c, "volume", 0.5);
  assert.equal(sb.holdRefreshes, 1);
  sb.setAnimProp(c, "scale", 2);
  assert.equal(sb.holdRefreshes, 1, "visual props don't touch the hold");
  sb.setAnimProp(c, "pan", -1);
  sb.setAnimProp(c, "speed", 2); // remaps which frame of audio is held
  assert.equal(sb.holdRefreshes, 3);
});

test("audio hold: toggleKfAtPlayhead refreshes on add and remove", () => {
  const sb = makeSandbox();
  const c = keyedClip();
  sb.state.time = 13;
  assert.equal(sb.toggleKfAtPlayhead(c, "volume"), true);
  assert.equal(sb.holdRefreshes, 1, "add re-cuts the hold");
  sb.state.time = 13; // still parked on the new keyframe
  assert.equal(sb.toggleKfAtPlayhead(c, "volume"), true);
  assert.equal(sb.holdRefreshes, 2, "remove re-cuts it too");
  sb.toggleKfAtPlayhead(c, "scale");
  assert.equal(sb.holdRefreshes, 2);
});

test("audio hold: resets refresh through the mutators", () => {
  const sb = makeSandbox();
  const c = keyedClip({ keyframes: { pan: [{ t: 2, v: -1 }] } });
  sb.state.time = 12;
  sb.resetPropChannel(c, "pan");          // Ctrl-click path
  assert.equal(sb.holdRefreshes, 1);
  sb.resetPropChannel(c, "contrast");
  assert.equal(sb.holdRefreshes, 1);
  sb.resetPropAtPlayhead(c, "volume");    // unkeyed static path
  assert.equal(sb.holdRefreshes, 2);
  c.keyframes = { volume: [{ t: 2, v: 0.5 }] };
  sb.resetPropAtPlayhead(c, "volume");    // parked on it → removal path
  assert.equal(sb.holdRefreshes, 3);
});

test("audio hold: refused writes never refresh", () => {
  const sb = makeSandbox();
  const c = keyedClip({ keyframes: { volume: [{ t: 2, v: 1 }] } });
  sb.state.time = 0; // off-clip
  assert.equal(sb.setAnimProp(c, "volume", 0.1), false);
  assert.equal(sb.toggleKfAtPlayhead(c, "volume"), false);
  assert.equal(sb.resetPropAtPlayhead(c, "volume"), false);
  assert.equal(sb.holdRefreshes, 0);
});

/* ── inspector sync (fake DOM) ── */
test("syncInspectorPlayhead: fields show playhead values, ◆ state follows", () => {
  const sb = makeSandbox({ clips: [keyedClip()] });
  const row = scaleRow();
  const btn = kfBtn("scale");
  sb.els.inspector = fakeInspector({ inputs: [row.input], buttons: [btn], vals: { scale: row.val } });
  sb.state.selId = "c1";
  sb.state.time = 13; // midpoint → 2
  sb.syncInspectorPlayhead();
  assert.equal(row.input.value, "2");
  assert.equal(row.val.textContent, "2");
  assert.equal(btn.classes.has("has"), true);
  assert.equal(btn.classes.has("on"), false);
  assert.equal(btn.textContent, "◆2");
  sb.state.time = 12; // parked on the first keyframe
  sb.syncInspectorPlayhead();
  assert.equal(row.input.value, "1");
  assert.equal(btn.classes.has("on"), true);
  assert.equal(btn.title, "Remove keyframe at playhead");
});

test("syncInspectorPlayhead: unchanged stamp is a no-op", () => {
  const sb = makeSandbox({ clips: [keyedClip()] });
  const row = scaleRow();
  sb.els.inspector = fakeInspector({ inputs: [row.input], vals: { scale: row.val } });
  sb.state.selId = "c1";
  sb.state.time = 13;
  sb.syncInspectorPlayhead();
  const writes = row.input.writes;
  assert.ok(writes > 0, "first sync writes");
  sb.syncInspectorPlayhead();
  sb.syncInspectorPlayhead();
  assert.equal(row.input.writes, writes, "gated syncs write nothing");
  sb.state.time = 13.5; // a real change re-arms the sync
  sb.syncInspectorPlayhead();
  assert.ok(row.input.writes > writes);
  assert.equal(row.input.value, "2.5"); // local 3.5: 1 + (3-1)·0.75
});

test("syncInspectorPlayhead: clip start/duration change invalidates the stamp", () => {
  const c = keyedClip();
  const sb = makeSandbox({ clips: [c] });
  const row = scaleRow();
  const btn = kfBtn("scale");
  sb.els.inspector = fakeInspector({
    inputs: [row.input], buttons: [btn], vals: { scale: row.val },
  });
  sb.state.selId = "c1";
  sb.state.time = 13; // on-clip, local 3 → scale 2
  sb.syncInspectorPlayhead();
  assert.equal(row.input.value, "2");
  assert.equal(row.input.disabled, false);
  const writes = row.input.writes;
  c.start = 11; // still on-clip, local 2 → scale 1; time/sel/gen unchanged
  sb.syncInspectorPlayhead();
  assert.ok(row.input.writes > writes, "start change re-syncs");
  assert.equal(row.input.value, "1");
  c.start = 20; // playhead now off the clip
  sb.syncInspectorPlayhead();
  assert.equal(row.input.disabled, true, "off-clip lock after drag");
  assert.equal(btn.disabled, true);
  c.start = 10;
  c.duration = 2; // 10–12, playhead 13 still off
  sb.syncInspectorPlayhead();
  assert.equal(row.input.disabled, true, "duration trim can push the playhead off");
  c.duration = 5;
  sb.syncInspectorPlayhead();
  assert.equal(row.input.disabled, false);
});

test("syncInspectorPlayhead: out-of-range keyframe saturates the thumb, label keeps truth", () => {
  const c = keyedClip({ keyframes: { scale: [{ t: 2, v: 12 }] } });
  const sb = makeSandbox({ clips: [c] });
  const row = scaleRow();
  sb.els.inspector = fakeInspector({ inputs: [row.input], vals: { scale: row.val } });
  sb.state.selId = "c1";
  sb.state.time = 12;
  sb.syncInspectorPlayhead();
  assert.equal(row.input.value, "4"); // slider max
  assert.equal(row.val.textContent, "12");
  const writes = row.input.writes;
  sb.state.time = 12.004; // value stays 12 (single keyframe) → still saturated
  sb.syncInspectorPlayhead();
  assert.equal(row.input.value, "4");
  assert.equal(row.input.writes, writes, "no per-frame churn against the clamp");
});

test("syncInspectorPlayhead: focused field is never rewritten", () => {
  const sb = makeSandbox({ clips: [keyedClip()] });
  const row = scaleRow();
  row.val.textContent = "typed…"; // the input handler owns the label while focused
  sb.els.inspector = fakeInspector({ inputs: [row.input], vals: { scale: row.val } });
  sb.state.selId = "c1";
  sb.state.time = 12;
  sb.document.activeElement = row.input;
  sb.syncInspectorPlayhead();
  assert.equal(row.input.writes, 0, "focused input untouched");
  assert.equal(row.val.textContent, "typed…", "its label is left to the input handler");
  assert.equal(row.input.disabled, false, "focus is never yanked mid-edit");
});

test("syncInspectorPlayhead: blur re-syncs a field skipped while it held focus", () => {
  const sb = makeSandbox({ clips: [keyedClip()] });
  const row = scaleRow();
  sb.els.inspector = fakeInspector({ inputs: [row.input], vals: { scale: row.val } });
  sb.state.selId = "c1";
  sb.state.time = 12;
  sb.document.activeElement = row.input; // user is mid-edit on the slider
  sb.syncInspectorPlayhead();
  sb.state.time = 13;                    // a shortcut moves the playhead under them
  sb.syncInspectorPlayhead();
  assert.equal(row.input.writes, 0, "focused input is left alone while it has focus");
  sb.document.activeElement = null;      // clicks away — the playhead does NOT move
  sb.syncInspectorPlayhead();
  assert.equal(row.input.value, "2", "value at the playhead is written on blur");
  assert.equal(row.val.textContent, "2", "and the label catches up");
});

test("syncInspectorPlayhead: off the clip, keyframed fields lock, statics stay editable", () => {
  const sb = makeSandbox({ clips: [keyedClip()] });
  const scale = scaleRow();
  const rot = { input: new FakeEl({ dataset: { k: "rotation" } }), val: new FakeEl({ dataset: { unit: "" } }) };
  const btnScale = kfBtn("scale"), btnRot = kfBtn("rotation");
  sb.els.inspector = fakeInspector({
    inputs: [scale.input, rot.input],
    buttons: [btnScale, btnRot],
    vals: { scale: scale.val, rotation: rot.val },
  });
  sb.state.selId = "c1";
  sb.state.time = 0; // off-clip
  sb.syncInspectorPlayhead();
  assert.equal(scale.input.disabled, true, "keyed channel locked");
  assert.equal(scale.input.value, "1", "shows the nearest edge value");
  assert.equal(rot.input.disabled, false, "static prop stays editable anywhere");
  assert.equal(btnScale.disabled, true);
  assert.equal(btnRot.disabled, true, "no keyframe can be planted off-clip either");
  assert.equal(btnScale.title, "Move the playhead over the clip to add or remove keyframes");
  assert.equal(btnScale.classes.has("on"), false, "no false 'parked' state off-clip");
  // back on-clip → everything unlocks
  sb.state.time = 12;
  sb.syncInspectorPlayhead();
  assert.equal(scale.input.disabled, false);
  assert.equal(btnScale.disabled, false);
});

/* ── transition envelope probe (canvas box-drag inversion) ──
   The selection overlay and hit-test work in displayed space (evalProps —
   transition envelopes included), but a box drag writes resting geometry:
   the displayed center minus whatever the envelopes currently add. That only
   works if transOffsetAt reports EXACTLY what applyTransition adds inside
   evalProps — including glitch's deterministic jitter — so the probe is
   tested against the compositor itself, type by type. */
const BACKOUT = lift(/const backOut = (\(u\) => \{[^\n]*\});/);
const TRANS = slice("function evalProps(", "function shiftKF(");

function makeTransSandbox({ W = 1280, H = 720, previewW = 640, previewH = 360 } = {}) {
  const composeCanvas = { width: W, height: H };
  return new Function(
    "DEFAULT_PROPS", "EASE", "FILTER_PRESETS", "backOut", "clamp", "els", "composeCanvas",
    `${TRANS}\nreturn { evalProps, applyTransition, transOffsetAt, composeCanvas };`
  )(
    DEFAULT_PROPS, EASE, { none: {} }, BACKOUT,
    (v, a, b) => Math.min(b, Math.max(a, v)), // clamp, as in app.js
    { preview: { width: previewW, height: previewH } },
    composeCanvas,
  );
}

/* Clip on [10, 15] with non-default transform props and a keyframed x, so the
   envelope has real values to mix with (the keyframes must cancel out of the
   delta, exactly as they do in the drag math). */
function transClip(over = {}) {
  return {
    id: "c1", start: 10, duration: 5,
    props: {
      ...DEFAULT_PROPS, x: 37, y: -12, scale: 1.6, rotation: 15,
      opacity: 0.8, volume: 0.7, blur: 2, rgbSplit: 1,
    },
    keyframes: { x: [{ t: 0, v: 100 }, { t: 5, v: -100, ease: "linear" }] },
    ...over,
  };
}

test("transOffsetAt: no transitions, or outside their windows, is zero", () => {
  const { transOffsetAt } = makeTransSandbox();
  assert.deepEqual(transOffsetAt(transClip(), 12), { x: 0, y: 0 });
  const c = transClip({
    transitionIn: { type: "slide-left", duration: 0.8 },
    transitionOut: { type: "zoom", duration: 1 },
  });
  assert.deepEqual(transOffsetAt(c, 12), { x: 0, y: 0 }, "mid-clip: outside both windows");
  assert.deepEqual(transOffsetAt(c, 10.8), { x: 0, y: 0 }, "in window is [start, start+dur) — boundary clean");
  assert.deepEqual(transOffsetAt(c, 14), { x: 0, y: 0 }, "out window is (end-dur, end] — boundary clean");
});

test("transOffsetAt: mirrors the compositor envelope for every transition type", () => {
  const W = 1280, H = 720, previewW = 640, previewH = 360;
  const { evalProps, transOffsetAt, composeCanvas } = makeTransSandbox({ W, H, previewW, previewH });
  assert.notEqual(composeCanvas.width, previewW);
  assert.notEqual(composeCanvas.height, previewH);
  const types = ["fade", "slide-left", "slide-right", "slide-up", "slide-down",
    "zoom", "wipe", "wipe-right", "wipe-up", "wipe-down", "iris", "spin",
    "blur", "whip", "glitch", "pop"];
  const base = transClip();
  for (const type of types) {
    for (const side of ["In", "Out"]) {
      const c = transClip({ ["transition" + side]: { type, duration: 0.8 } });
      for (const f of [0.1, 0.5, 0.9]) {
        const t = side === "In" ? 10 + f * 0.8 : 15 - f * 0.8;
        const env = transOffsetAt(c, t);
        assert.ok(Math.abs(evalProps(c, t).x - evalProps(base, t).x - env.x) < 1e-9,
          `${type} ${side} @${f}: probe x ≠ compositor x delta`);
        assert.ok(Math.abs(evalProps(c, t).y - evalProps(base, t).y - env.y) < 1e-9,
          `${type} ${side} @${f}: probe y ≠ compositor y delta`);
      }
    }
  }
  // slide-left/up at mid-in: easeOut(0.5) → k=0.25. Must scale with composeCanvas, not preview.
  const k = 0.25, tIn = 10.5;
  const slideX = transOffsetAt(transClip({
    keyframes: undefined, transitionIn: { type: "slide-left", duration: 1 },
  }), tIn);
  assert.equal(slideX.x, k * W, "slide-left uses composeCanvas.width");
  assert.notEqual(slideX.x, k * previewW, "slide-left must not use preview.width");
  const slideY = transOffsetAt(transClip({
    keyframes: undefined, transitionIn: { type: "slide-up", duration: 1 },
  }), tIn);
  assert.equal(slideY.y, k * H, "slide-up uses composeCanvas.height");
  assert.notEqual(slideY.y, k * previewH, "slide-up must not use preview.height");
});

test("box drag during a transition: the box lands where the pointer left it", () => {
  const W = 1280, H = 720, previewW = 640, previewH = 360;
  const { evalProps, transOffsetAt } = makeTransSandbox({ W, H, previewW, previewH });
  const c = transClip({ keyframes: undefined, transitionIn: { type: "slide-left", duration: 1 } });
  const t = 10.5; // mid-transition: easeOut(0.5) → k=0.25 → envelope x = +W/4
  const env = transOffsetAt(c, t);
  assert.equal(env.x, 0.25 * W, "slide envelope uses composeCanvas.width");
  assert.notEqual(env.x, 0.25 * previewW, "slide envelope must not use preview.width");
  assert.equal(env.y, 0);
  // The user drags the displayed box until its center sits at compose-canvas
  // (900, 500) and releases. The drag stores the resting center:
  // displayed midpoint − canvas center − envelope (app.js box branch).
  c.props.x = Math.round(900 - W / 2 - env.x);
  c.props.y = Math.round(500 - H / 2 - env.y);
  assert.ok(Math.abs(W / 2 + evalProps(c, t).x - 900) < 1, "displayed center x ≈ release point");
  assert.ok(Math.abs(H / 2 + evalProps(c, t).y - 500) < 1, "displayed center y ≈ release point");
  assert.ok(Math.abs(previewW / 2 + evalProps(c, t).x - 900) > 1,
    "preview center would miss the release point");
  // The pre-fix write (no envelope subtraction) displaced the box by the
  // envelope on the spot, and left it there for good once the transition ended.
  const buggy = transClip({ keyframes: undefined, transitionIn: { type: "slide-left", duration: 1 } });
  buggy.props.x = Math.round(900 - W / 2);
  assert.ok(Math.abs(W / 2 + evalProps(buggy, t).x - 900) > 100,
    "without the probe the box is off by the full envelope");
});
