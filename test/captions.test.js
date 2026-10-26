/* captions.js — grouping a transcript's words into captions, the caption
   clips (style, wordTimes), the lane they go on, and SRT / WebVTT in and out. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../captions.js");
const ProjectOps = require("../project-ops.js");

const W = (list) => list.map(([w, s, e]) => ({ w, s, e }));

test("styles are checked; sizes and line length follow the canvas", () => {
  assert.equal(C.style(), "subtitle");
  assert.throws(() => C.style("comic"), /style must be subtitle, karaoke, highlight, pop/);
  const wide = C.metrics("subtitle", 1920, 1080), tall = C.metrics("subtitle", 1080, 1920);
  assert.equal(wide.fontSize, tall.fontSize, "the same size on the shorter side");
  assert.ok(wide.chars > tall.chars * 1.5, "a vertical canvas fits fewer characters a line");
  assert.equal(C.metrics("pop", 1080, 1920).words, 3);
  assert.equal(C.metrics("subtitle", 1920, 1080, { lines: 1, words: 4 }).words, 4);
  assert.ok(Math.abs(C.metrics("subtitle", 1920, 1080, { scale: 2 }).fontSize - wide.fontSize * 2) <= 1);
});

test("wrap splits into even lines", () => {
  assert.deepEqual(C.wrap(["short", "line"], 40, 2), [["short", "line"]]);
  assert.deepEqual(C.wrap("one two three four five six seven".split(" "), 20, 2).map((l) => l.join(" ")), ["one two three four", "five six seven"]);
  assert.deepEqual(C.wrap(["a", "b"], 1, 1), [["a", "b"]], "one line is one line, however long");
});

test("cues break at pauses, sentences, room and word limits, on frames, never overlapping", () => {
  const words = W([["Hello", 0, 0.4], ["there.", 0.45, 0.9], ["This", 1.0, 1.2], ["is", 1.2, 1.3], ["a", 1.3, 1.4], ["test", 1.4, 1.8],
    ["after", 3.0, 3.4], ["a", 3.4, 3.5], ["pause", 3.5, 4.0]]);
  const cs = C.cues(words, { chars: 40, lines: 2, fps: 10 });
  assert.deepEqual(cs.map((c) => c.text), ["Hello there.", "This is a test", "after a pause"]);
  assert.deepEqual(cs.map((c) => [c.start, c.end]), [[0, 1], [1, 2], [3, 4.3]], "a short tail after the last word, cut short by the next cue");
  for (let k = 1; k < cs.length; k++) assert.ok(cs[k].start >= cs[k - 1].end);
  const pop = C.cues(words, { chars: 40, lines: 1, words: 2, fps: 10 });
  assert.ok(pop.every((c) => c.text.split(" ").length <= 2));
  const narrow = C.cues(W([["one", 0, 0.2], ["two", 0.2, 0.4], ["three", 0.4, 0.6], ["four", 0.6, 0.8], ["five", 0.8, 1]]), { chars: 10, lines: 2 });
  assert.equal(narrow[0].text, "one two\nthree four", "wrapped onto two lines");
  assert.equal(narrow[1].text, "five");
});

test("a cue lasts at least minDur when there is room", () => {
  const [c] = C.cues(W([["Hi", 1, 1.1]]), { fps: 10, minDur: 0.7 });
  assert.deepEqual([c.start, c.end], [1, 1.7]);
});

test("wordTimes come from the words, or are spread over the cue by length", () => {
  const cue = { start: 2, end: 4, text: "big news", words: [{ w: "big", s: 2.1, e: 2.5 }, { w: "news", s: 2.6, e: 3.2 }] };
  assert.deepEqual(C.wordTimes(cue), [[0.1, 0.5], [0.6, 1.2]]);
  const spread = C.wordTimes({ start: 0, end: 2, text: "a bbbbbb" });
  assert.equal(spread.length, 2);
  assert.equal(spread[1][1], 2);
  assert.ok(spread[0][1] < 1, "a short word gets less time");
});

test("clip() makes a caption text clip in the style, placed for the canvas", () => {
  const clip = C.clip({ start: 1, end: 2.5, text: "Hello there", words: [{ s: 1, e: 1.4 }, { s: 1.5, e: 2 }] }, { style: "highlight", width: 1080, height: 1920, track: "V4" });
  assert.equal(clip.kind, "text");
  assert.equal(clip.track, "V4");
  assert.equal(clip.duration, 1.5);
  assert.equal(clip.props.caption, true);
  assert.equal(clip.props.textAnim, "highlight");
  assert.equal(clip.props.highlightColor, "#ffd166");
  assert.deepEqual(clip.props.wordTimes, [[0, 0.4], [0.5, 1]]);
  assert.equal(clip.props.y, Math.round(1920 * C.STYLES.highlight.y));
  // a valid addClip for the agent's patch
  const doc = { revision: 1, width: 1080, height: 1920, fps: 30, media: [], clips: [] };
  ProjectOps.applyPatch(doc, [{ op: "addClip", clip }]);
  assert.equal(doc.clips[0].props.wordTimes.length, 2);
  assert.match(ProjectOps.compactView(doc), /\[2 words timed to speech\]/);
  assert.doesNotMatch(ProjectOps.compactView(doc), /"wordTimes"/, "the times are summarized, not printed");
});

test("the lane: captions' own, else the top video lane when free, else a new one", () => {
  const cap = { id: "k", kind: "text", track: "V2", start: 0, duration: 1, props: { caption: true } };
  assert.deepEqual(C.trackFor({ clips: [cap] }, 0, 5), { track: "V2", add: false });
  assert.deepEqual(C.trackFor({ clips: [] }, 0, 5), { track: "V3", add: false });
  const busy = { id: "t", kind: "text", track: "V3", start: 2, duration: 1, props: {} };
  assert.deepEqual(C.trackFor({ clips: [busy] }, 0, 5), { track: "V4", add: true });
  assert.deepEqual(C.trackFor({ clips: [busy] }, 4, 5), { track: "V3", add: false }, "free over the span");
  assert.deepEqual(C.trackFor({ tracks: [{ id: "V1", kind: "video" }, { id: "A1", kind: "audio" }], clips: [] }, 0, 1), { track: "V1", add: false });
});

test("SRT and WebVTT out, and back in", () => {
  const list = [{ start: 0.48, end: 2.5, text: "Meet FableCut" }, { start: 3725.1, end: 3727, text: "two\nlines" }];
  const srt = C.toSRT(list);
  assert.match(srt, /^1\n00:00:00,480 --> 00:00:02,500\nMeet FableCut\n\n2\n01:02:05,100 --> 01:02:07,000\ntwo\nlines\n$/);
  assert.deepEqual(C.parse(srt), list);
  const vtt = C.toVTT(list);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.480 --> 00:00:02\.500\n/);
  assert.deepEqual(C.parse(vtt), list);
  const messy = "﻿WEBVTT\r\n\r\nNOTE hi\r\n\r\ncue-1\r\n00:01.5 --> 00:03.000 align:start\r\n<b>Bold</b> {\\an8}text\r\n";
  assert.deepEqual(C.parse(messy), [{ start: 1.5, end: 3, text: "Bold text" }]);
  assert.throws(() => C.parse("just words"), /no subtitles found/);
  assert.equal(C.readStamp("1:00:00,000"), 3600);
});

test("fromClips lists the caption clips in time order", () => {
  const clips = [
    { kind: "text", start: 5, duration: 1, props: { caption: true, text: "second" } },
    { kind: "text", start: 1, duration: 1, props: { caption: true, text: "first" } },
    { kind: "text", start: 2, duration: 1, props: { text: "a title" } },
    { kind: "text", start: 3, duration: 1, disabled: true, props: { caption: true, text: "off" } },
  ];
  assert.deepEqual(C.fromClips(clips).map((c) => c.text), ["first", "second"]);
});

test("fit re-breaks an imported caption to the style's line length", () => {
  const [a, b, c] = C.fit([{ start: 0, end: 1, text: "short" }, { start: 1, end: 2, text: "one two\nthree four five" },
    { start: 2, end: 3, text: "aaaa bbbb cccc dddd eeee ffff gggg hhhh" }], 12, 2);
  assert.equal(a.text, "short");
  assert.equal(b.text, "one two three\nfour five", "the file's own break is replaced by an even one");
  const lines = c.text.split("\n");
  assert.ok(lines.length >= 3 && lines.every((l) => l.length <= 12), "more lines when it doesn't fit in two");
  assert.deepEqual([c.start, c.end], [2, 3]);
});

