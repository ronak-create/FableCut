"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { ROOT } = require("./helpers");
const { parseVideoIndex, sampleToChunk, applyPresentationHolds } =
  require(path.join(ROOT, "video-index"));

function stscBox(entries) {
  const b = Buffer.alloc(8 + entries.length * 12);
  b.writeUInt32BE(0, 0);
  b.writeUInt32BE(entries.length, 4);
  let o = 8;
  for (const e of entries) {
    b.writeUInt32BE(e.firstChunk, o);
    b.writeUInt32BE(e.samplesPerChunk, o + 4);
    b.writeUInt32BE(e.descriptionIndex, o + 8);
    o += 12;
  }
  return { b, stsc: { data: 0, end: b.length } };
}

test("parseVideoIndex reads the H.264 fixture sample table", () => {
  const index = parseVideoIndex(path.join(ROOT, "test/fixtures/video-index.mp4"));
  assert.equal(index.width, 32);
  assert.equal(index.height, 24);
  assert.equal(index.samples.length, 2);
  assert.equal(index.samples[0].timestamp, 0);
  assert.equal(index.samples[1].timestamp, 500000);
  assert.equal(index.samples[1].duration, 500000);
});

test("applyPresentationHolds uses stts duration for the last PTS, not the prior gap", () => {
  const samples = [
    { timestamp: 0, duration: 40_000 },
    { timestamp: 100_000, duration: 40_000 },
    { timestamp: 250_000, duration: 50_000 },
  ];
  applyPresentationHolds(samples);
  assert.equal(samples[0].duration, 100_000);
  assert.equal(samples[1].duration, 150_000);
  assert.equal(samples[2].duration, 50_000);
});

test("applyPresentationHolds keeps ctts presentation order after media-start normalize", () => {
  const samples = [
    { timestamp: 100_000, duration: 40_000 },
    { timestamp: 0, duration: 50_000 },
    { timestamp: 50_000, duration: 50_000 },
  ];
  applyPresentationHolds(samples);
  assert.equal(samples[1].duration, 50_000);
  assert.equal(samples[2].duration, 50_000);
  assert.equal(samples[0].duration, 40_000);
});

test("sampleToChunk keeps description index 1", () => {
  const { b, stsc } = stscBox([
    { firstChunk: 1, samplesPerChunk: 4, descriptionIndex: 1 },
  ]);
  const mapping = sampleToChunk(b, stsc);
  assert.equal(mapping[0].descriptionIndex, 1);
  assert.equal(mapping[0].samplesPerChunk, 4);
});

test("sampleToChunk rejects a description index other than 1", () => {
  const { b, stsc } = stscBox([
    { firstChunk: 1, samplesPerChunk: 2, descriptionIndex: 2 },
  ]);
  assert.throws(
    () => sampleToChunk(b, stsc),
    /does not support multiple MP4 sample descriptions/,
  );
});
