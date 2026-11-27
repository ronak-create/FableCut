/* Export video-sync — sliced from app.js so tests exercise production logic,
   not a reimplemented predicate. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const { ROOT } = require("./helpers");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  assert.ok(a >= 0, `start marker not found: ${startMarker}`);
  assert.ok(b > a, `end marker not found after it: ${endMarker}`);
  return SRC.slice(a, b);
}

const WAIT_HELPERS = slice("function notePresented(", "function assignVideoTime(");
const PLAY = slice("function playAdvanceVideo(", "const EXPORT_PREFETCH_S");

function loadWait() {
  return new Function(`${WAIT_HELPERS}
    return { notePresented, presentedClose, waitForPresentedFrame };`)();
}

function loadPlay(hardSeekVideo = () => Promise.resolve(), exportSignal = () => null) {
  return new Function(
    "hardSeekVideo", "exportSignal",
    `${WAIT_HELPERS}
     ${PLAY}
     return { notePresented, presentedClose, playAdvanceVideo };`
  )(hardSeekVideo, exportSignal);
}

function mockVideo({
  currentTime = 0,
  paused = true,
  readyState = 2,
  rvfcMediaTime,
  rvfcDelayMs = 0,
  noRvfc = false,
  noRvfcFire = false,
} = {}) {
  const el = {
    currentTime,
    paused,
    readyState,
    muted: false,
    playbackRate: 1,
    _fcPresentedTime: null,
    _fcPrevMuted: null,
    pause() { el.paused = true; },
    play() { el.paused = false; return Promise.resolve(); },
    addEventListener() {},
    removeEventListener() {},
  };
  if (!noRvfc) {
    el.requestVideoFrameCallback = (cb) => {
      if (noRvfcFire) return;
      const fire = () => cb(0, { mediaTime: rvfcMediaTime ?? currentTime });
      if (rvfcDelayMs > 0) setTimeout(fire, rvfcDelayMs);
      else queueMicrotask(fire);
    };
    el.cancelVideoFrameCallback = () => {};
  }
  return el;
}

const { waitForPresentedFrame } = loadWait();

test("waitForPresentedFrame: timeout rejects without recording currentTime", async () => {
  const el = mockVideo({ noRvfcFire: true });
  await assert.rejects(() => waitForPresentedFrame(el, 15), /presented frame timeout/);
  assert.equal(el._fcPresentedTime, null);
});

test("waitForPresentedFrame: rvfc without mediaTime times out instead of using currentTime", async () => {
  const el = mockVideo();
  el.requestVideoFrameCallback = (cb) => { cb(0, {}); };
  await assert.rejects(() => waitForPresentedFrame(el, 50), /presented frame timeout/);
  assert.equal(el._fcPresentedTime, null);
});

test("waitForPresentedFrame: records finite mediaTime from rvfc", async () => {
  const el = mockVideo({ rvfcMediaTime: 0.04 });
  await waitForPresentedFrame(el, 80);
  assert.equal(el._fcPresentedTime, 0.04);
});

test("playAdvanceVideo: no hard-seek when presented reached target but clock ran ahead", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.055, rvfcMediaTime: 0.039 });
  await play(el, 0.04, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 0);
  assert.equal(el._fcPresentedTime, 0.039);
});

test("playAdvanceVideo: hard-seeks when picture never reaches target", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.07, noRvfcFire: true });
  await play(el, 0.04, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 1);
}, { timeout: 1000 });

test("playAdvanceVideo: tolerates small clock drift when picture is on target", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.025, rvfcMediaTime: 0.02 });
  await play(el, 0.02, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 0);
});

test("playAdvanceVideo: hard-seeks when presented picture overshoots target", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.06, rvfcMediaTime: 0.041 });
  await play(el, 0.04, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 1);
});

/* hardSeekVideo: a seek that presents no new frame (slow motion inside one source
   frame) or presents it late must not fail the export. */
const HARD = slice("function sameSourceFrame(", "/** Play forward until");
function loadHard() {
  return new Function(`${WAIT_HELPERS}
    function assignVideoTime(el, mt) { el.currentTime = mt; }
    ${HARD}
    return { hardSeekVideo, sameSourceFrame };`)();
}
/** A video whose seeks complete (seeked fires) but whose frame callback never does. */
function seekingVideo({ currentTime = 0, presented = null, completes = true, frameDur = 1 / 30 } = {}) {
  const listeners = new Map();
  const el = {
    _t: currentTime, paused: true, readyState: 2, seeking: false, _fcPresentedTime: presented, rvfcCalls: 0,
    _fcLastShown: presented, _fcFrameDur: frameDur, _fcFrameSeen: frameDur ? 5 : 0,   // as learned from earlier frames
    pause() { el.paused = true; },
    get currentTime() { return el._t; },
    set currentTime(v) {
      el._t = v; el.seeking = true;
      if (!completes) return;
      setTimeout(() => { el.seeking = false; for (const f of [...(listeners.get("seeked") || [])]) f(); }, 5);
    },
    addEventListener(n, f) { (listeners.get(n) || listeners.set(n, []).get(n)).push(f); },
    removeEventListener(n, f) { const a = listeners.get(n) || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    requestVideoFrameCallback() { el.rvfcCalls++; },   // never fires: nothing new was presented
  };
  return el;
}

test("hardSeekVideo: slow motion inside the frame on screen resolves without a frame callback", async () => {
  const { hardSeekVideo } = loadHard();
  const el = seekingVideo({ currentTime: 1.0, presented: 1.0 });
  await hardSeekVideo(el, 1.02);   // 0.6x on 30 fps footage: still source frame 1.0 (1.0 … 1.033)
  assert.equal(el.rvfcCalls, 1, "accepted after the first wait, not after every retry");
  assert.equal(el._fcPresentedTime, 1.0, "the presented frame is still the one on screen");
});

test("hardSeekVideo: a target in the next source frame is not taken for the frame on screen", async () => {
  const { hardSeekVideo, sameSourceFrame } = loadHard();
  const el = seekingVideo({ currentTime: 1.0, presented: 1.0 });
  el._t = 1.04; el.seeking = false;
  assert.equal(sameSourceFrame(el, 1.04, 1.0), false, "1.04 s is the next frame of 30 fps footage");
  const unknown = seekingVideo({ currentTime: 1.0, presented: 1.0, frameDur: 0 });
  unknown._t = 1.02;
  assert.equal(sameSourceFrame(unknown, 1.02, 1.0), false, "no frame duration learned yet: never assume");
  await hardSeekVideo(el, 1.04);   // only the finished seek on the last try settles it
  assert.equal(el.rvfcCalls, 3);
  assert.equal(el._fcPresentedTime, 1.04);
});

test("notePresented learns the source frame duration from consecutive frames", () => {
  const { notePresented } = loadWait();
  const el = {};
  for (const t of [0, 1 / 30, 3 / 30, 4 / 30, 5 / 30]) notePresented(el, t);   // one dropped frame in there
  assert.ok(Math.abs(el._fcFrameDur - 1 / 30) < 1e-9);
  assert.equal(el._fcFrameSeen, 4);
});

test("hardSeekVideo: a late frame callback on the last try still uses the finished seek", async () => {
  const { hardSeekVideo } = loadHard();
  const el = seekingVideo({ currentTime: 0, presented: 0 });
  await hardSeekVideo(el, 2.0);   // a different frame, but the callback never arrives (busy page)
  assert.equal(el._fcPresentedTime, 2.0);
});

test("hardSeekVideo: a seek that never lands still fails", async () => {
  const { hardSeekVideo } = loadHard();
  const el = seekingVideo({ currentTime: 0, presented: 0, completes: false });
  await assert.rejects(hardSeekVideo(el, 2.0), /presented frame timeout/);
});

/* A hidden tab (the user switched away while an agent works) runs no frame
   callbacks: a finished seek must resolve at once, not wait out every retry. */
test("hardSeekVideo: in a hidden tab a finished seek resolves without a frame callback", async () => {
  const { hardSeekVideo } = loadHard();
  const el = seekingVideo({ currentTime: 0, presented: 0, frameDur: 0 });
  globalThis.document = { hidden: true };
  try {
    const t0 = Date.now();
    await hardSeekVideo(el, 2.0);
    assert.ok(Date.now() - t0 < 500, "resolved without the frame-callback retries");
    assert.equal(el._fcPresentedTime, 2.0);
    assert.equal(el.rvfcCalls, 0);
  } finally { delete globalThis.document; }
});

test("hardSeekVideo: a hidden-tab seek teaches nothing about frame durations", async () => {
  const { hardSeekVideo } = loadHard();
  const el = seekingVideo({ currentTime: 0, presented: 1.0, frameDur: 1 / 30 });
  globalThis.document = { hidden: true };
  try {
    await hardSeekVideo(el, 1.01);
    assert.equal(el._fcFrameDur, 1 / 30);
    assert.equal(el._fcLastShown, null);
  } finally { delete globalThis.document; }
});

test("hardSeekVideo: an export's Cancel stops a seek still waiting in a hidden tab", async () => {
  const { hardSeekVideo } = loadHard();
  const el = seekingVideo({ currentTime: 0, presented: 0, completes: false });
  globalThis.document = { hidden: true };
  globalThis.exportAbort = new AbortController();
  try {
    const t0 = Date.now();
    const p = hardSeekVideo(el, 2.0);
    setTimeout(() => globalThis.exportAbort.abort(), 20);
    await assert.rejects(p, /cancelled/);
    assert.ok(Date.now() - t0 < 1000, "rejected on Cancel, not after the 10 s wait");
  } finally { delete globalThis.document; delete globalThis.exportAbort; }
});

test("hardSeekVideo: retries keep the export's cancel signal after it is cleared", async () => {
  const { hardSeekVideo } = loadHard();
  const el = seekingVideo({ currentTime: 0, presented: 0, frameDur: 0 });   // seeks land, no frame callback
  const ctl = new AbortController();
  globalThis.exportAbort = ctl;
  try {
    const p = hardSeekVideo(el, 2.0);
    globalThis.exportAbort = null;   // export cleanup after a sibling seek was cancelled
    ctl.abort();
    await assert.rejects(p, /cancelled/);
  } finally { delete globalThis.exportAbort; }
});

/* seekVideosTo whose export ended while it waited (the stall watchdog gave up on it): the players
   may be the next export's by then, so the stale seek must not move them. */
const SEEK = slice("async function seekVideosTo(", "function encodeWAV(");
function loadSeek(over = {}) {
  let finishDecode = null;
  const moved = [];
  const deps = {
    exportWindow: { export: "A" }, exportSeekClock: 0,
    runtime: { exportDecode: { sources: new Map(), opening: new Map() }, exportFrames: new Map(), clipGain: new Map() },
    projectFps: () => 30, exportLoopLag: () => ({ fast: true, behind: false }),
    mediaClips: () => [{ id: "v", kind: "video", start: 0, duration: 10, in: 0 }],
    clipRenders: () => true, activeAt: () => true,
    exportDecodeFrame: () => new Promise((r) => { finishDecode = r; }),
    getClipEl: () => ({ readyState: 4, paused: true, currentTime: 0, pause() { } }),
    mediaTimeAt: (c, t) => t, clamp: (v, a, b) => Math.min(b, Math.max(a, v)), kfChannel: (c, k, l, d) => d, clipSpeed: () => 1,
    presentedClose: () => false, muteClipChain() { }, videoRangeBuffered: () => false,
    playAdvanceVideo: async () => { moved.push("play"); }, hardSeekVideo: async () => { moved.push("seek"); },
    driveClipChain() { }, evalProps: () => ({}), prefetchExportVideos: () => { moved.push("prefetch"); },
    ...over,
  };
  const seekVideosTo = new Function("deps", `with (deps) { ${SEEK}; return seekVideosTo; }`)(deps);
  return { deps, moved, seekVideosTo, finish: (v) => finishDecode(v) };
}

test("export seek: a seek whose export ended while it decoded leaves the players alone", async () => {
  const s = loadSeek();
  const p = s.seekVideosTo(1);
  s.deps.exportWindow = { export: "B" };   // A ended, B began
  s.finish(false);                          // A's decode lands late: its clip would fall back to the element
  await p;
  assert.deepEqual(s.moved, [], "no seek, play or prefetch for the export that is gone");
  const live = loadSeek();
  const q = live.seekVideosTo(1);
  live.finish(false);
  await q;
  assert.deepEqual(live.moved, ["seek", "prefetch"], "the export still running seeks its element as before");
});

test("playAdvanceVideo: once its export has ended, its callbacks neither pause nor seek the player", async () => {
  let seeks = 0, pauses = 0;
  const { playAdvanceVideo } = loadPlay(() => { seeks++; return Promise.resolve(); });
  const el = mockVideo({ currentTime: 1, paused: true, noRvfcFire: true });
  const pause = el.pause; el.pause = () => { pauses++; pause(); };
  const ctl = new AbortController();
  const p = playAdvanceVideo(el, 1.05, 0.02, 1, { keepPlaying: false }, ctl.signal);
  ctl.abort();   // the export ended (its watchdog gave up) before this player got there
  await assert.rejects(p, /cancelled/);
  assert.equal(seeks, 0, "no seek: the player may be the next export's by now");
  assert.equal(pauses, 0, "and no pause");
  // the export still running: the same timeout seeks as before
  const live = new AbortController(), el2 = mockVideo({ currentTime: 1, paused: true, noRvfcFire: true });
  await playAdvanceVideo(el2, 1.05, 0.02, 1, { keepPlaying: false }, live.signal);
  assert.equal(seeks, 1);
});
