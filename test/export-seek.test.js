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

const WAIT_HELPERS = slice("const SRC_FRAME_MIN", "function assignVideoTime(");
const SEEK = slice("function assignVideoTime(", "function playAdvanceVideo(");
const PLAY = slice("function playAdvanceVideo(", "const EXPORT_PREFETCH_S");

function loadWait() {
  return new Function(`${WAIT_HELPERS}
    return { notePresented, presentedClose, presentedCovers, waitForPresentedFrame };`)();
}

function loadSeek() {
  return new Function(`${WAIT_HELPERS}
    ${SEEK}
    return { notePresented, hardSeekVideo };`)();
}

function loadPlay(hardSeekVideo = () => Promise.resolve()) {
  return new Function(
    "hardSeekVideo",
    `${WAIT_HELPERS}
     ${PLAY}
     return { notePresented, presentedCovers, playAdvanceVideo };`
  )(hardSeekVideo);
}

function mockVideo({
  currentTime = 0,
  paused = true,
  readyState = 2,
  rvfcMediaTime,
  rvfcFrames,
  rvfcDelayMs = 0,
  noRvfc = false,
  noRvfcFire = false,
  presented = null,
  frameDur = null,
} = {}) {
  const el = {
    currentTime,
    paused,
    readyState,
    muted: false,
    playbackRate: 1,
    _fcPresentedTime: presented,
    _fcPresentedExact: presented != null,
    _fcFrameDur: frameDur,
    _fcPrevMuted: null,
    pause() { el.paused = true; },
    play() { el.paused = false; return Promise.resolve(); },
    addEventListener() {},
    removeEventListener() {},
  };
  if (!noRvfc) {
    // rvfcFrames plays a source-frame grid back one callback at a time.
    const queue = rvfcFrames ? rvfcFrames.slice() : null;
    el.requestVideoFrameCallback = (cb) => {
      if (noRvfcFire) return;
      const next = queue ? queue.shift() : (rvfcMediaTime ?? currentTime);
      if (next === undefined) return;
      const fire = () => cb(0, { mediaTime: next });
      if (rvfcDelayMs > 0) setTimeout(fire, rvfcDelayMs);
      else queueMicrotask(fire);
    };
    el.cancelVideoFrameCallback = () => {};
  }
  return el;
}

const { waitForPresentedFrame, notePresented, presentedCovers } = loadWait();

test("notePresented learns the source frame duration from consecutive frames", () => {
  const el = { _fcPresentedTime: null, _fcPresentedExact: false, _fcFrameDur: null };
  notePresented(el, 0);
  assert.equal(el._fcFrameDur, null);
  notePresented(el, 0.04);
  assert.equal(el._fcFrameDur, 0.04);
  // A clock fallback is not a real frame boundary — it must not teach anything.
  notePresented(el, 0.08, false);
  notePresented(el, 0.12);
  assert.equal(el._fcFrameDur, 0.04);
});

test("presentedCovers: one source frame spans several timeline ticks", () => {
  const el = { _fcPresentedTime: 0.04, _fcPresentedExact: true, _fcFrameDur: 0.04 };
  assert.equal(presentedCovers(el, 0.04, 0.002), true);
  assert.equal(presentedCovers(el, 0.06, 0.002), true, "25 fps frame still owns the 50 fps tick");
  assert.equal(presentedCovers(el, 0.08, 0.002), false, "next source frame is due");
  assert.equal(presentedCovers(el, 0.02, 0.002), false, "picture is ahead of the target");
});

test("presentedCovers: unknown frame duration falls back to an exact match", () => {
  const el = { _fcPresentedTime: 0.04, _fcPresentedExact: true, _fcFrameDur: null };
  assert.equal(presentedCovers(el, 0.04, 0.002), true);
  assert.equal(presentedCovers(el, 0.06, 0.002), false);
});

test("waitForPresentedFrame: timeout rejects without recording currentTime", async () => {
  const el = mockVideo({ noRvfcFire: true });
  await assert.rejects(() => waitForPresentedFrame(el, 15), /presented frame timeout/);
  assert.equal(el._fcPresentedTime, null);
});

test("waitForPresentedFrame: rvfc without mediaTime times out instead of using currentTime", async () => {
  const el = mockVideo();
  el.requestVideoFrameCallback = (cb) => {
    queueMicrotask(() => cb(0, {}));
  };
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
  const el = mockVideo({ currentTime: 0.06, rvfcMediaTime: 0.043 });
  await play(el, 0.04, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 1);
});

test("playAdvanceVideo: settles on the frame covering the target, no seek back", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  // 25 fps source on a 50 fps timeline: 0.06 belongs to the frame at 0.04.
  const el = mockVideo({
    currentTime: 0.05, presented: 0, frameDur: 0.04, rvfcFrames: [0.04, 0.08],
  });
  await play(el, 0.06, 0.01, 1, { keepPlaying: false });
  assert.equal(el._fcPresentedTime, 0.04, "stopped on the covering frame, not the next one");
  assert.equal(hardSeeks, 0);
});

test("playAdvanceVideo: skips work when the picture already covers the target", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.06, presented: 0.04, frameDur: 0.04, noRvfcFire: true });
  await play(el, 0.06, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 0);
  assert.equal(el._fcPresentedTime, 0.04);
});

test("hardSeekVideo: accepts clock after seeked when rvfc never fires", async () => {
  const { hardSeekVideo } = loadSeek();
  const el = {
    currentTime: 0.04,
    paused: false,
    readyState: 2,
    muted: false,
    _fcPresentedTime: null,
    pause() { el.paused = true; },
    requestVideoFrameCallback() { /* paused video: no frame */ },
    cancelVideoFrameCallback() {},
    addEventListener(ev, fn) {
      if (ev === "seeked") queueMicrotask(() => fn({ type: "seeked" }));
    },
    removeEventListener() {},
  };
  await hardSeekVideo(el, 0.04);
  assert.equal(el._fcPresentedTime, 0.04);
  assert.equal(el._fcPresentedExact, false, "a clock fallback must not drive frame-duration math");
}, { timeout: 2000 });

test("hardSeekVideo: rejects when the seek itself never completes", async () => {
  const { hardSeekVideo } = loadSeek();
  const el = {
    currentTime: 0.5,
    paused: true,
    readyState: 2,
    _fcPresentedTime: null,
    _fcPresentedExact: false,
    _fcFrameDur: null,
    pause() { el.paused = true; },
    requestVideoFrameCallback() { },
    cancelVideoFrameCallback() { },
    addEventListener() { /* seeked never fires */ },
    removeEventListener() { },
  };
  await assert.rejects(() => hardSeekVideo(el, 0.04), /presented frame timeout/);
}, { timeout: 20000 });
