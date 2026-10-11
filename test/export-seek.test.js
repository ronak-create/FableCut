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

function loadPlay(hardSeekVideo = () => Promise.resolve()) {
  return new Function(
    "hardSeekVideo",
    `${WAIT_HELPERS}
     ${PLAY}
     return { notePresented, presentedClose, playAdvanceVideo };`
  )(hardSeekVideo);
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
