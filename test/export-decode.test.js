/* Run the export frame source from app.js with controlled fetch/decoder tasks. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Mp4 = require("../mp4-demux");

const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = src.indexOf("class ExportFrameSource {");
const end = src.indexOf("/** Export-time decode state:", start);
assert.ok(start >= 0 && end > start, "export frame source markers exist");
function load(fetch = () => { throw new Error("unexpected fetch"); }) {
  return new Function("Mp4", "fetch", "VideoDecoder", `${src.slice(start, end)}; return ExportFrameSource;`)(Mp4, fetch, function () {});
}
const frame = (timestamp) => ({ timestamp, closed: false, close() { this.closed = true; } });
const samples = [0, 3, 1, 2].map((pts, i) => ({ pts, dur: 1, key: i === 0, offset: i, size: 1 }));

test("export decode: a server ignoring Range is cancelled without consuming its body", async () => {
  for (const cancelFails of [false, true]) {
    let cancelled = false, consumed = false;
    const Source = load(async (_, options) => {
      assert.equal(options.headers.Range, "bytes=0-0");
      return {
        status: 200, headers: { get: () => null },
        body: { async cancel() { cancelled = true; if (cancelFails) throw new Error("closed"); } },
        async arrayBuffer() { consumed = true; return new ArrayBuffer(0); },
      };
    });
    assert.equal(await Source.open("/media/large.mp4"), null);
    assert.equal(cancelled, true);
    assert.equal(consumed, false, "never buffers the full video on fallback");
  }
});

for (const delayed of [false, true]) test(`export decode: empty output waits for ${delayed ? "pending output" : "B-frames at flush"} without restarting`, async () => {
  const Source = load();
  const source = new Source(null, 4, { samples }, {});
  const first = source.cur = frame(0), target = frame(1e6);
  source.pos = samples.length;
  let flushes = 0;
  source.dec = {
    state: "configured", decodeQueueSize: delayed ? 1 : 0,
    close() { assert.fail("pending decoder must stay open"); },
    async flush() { flushes++; source.out.push(target); },
  };
  if (delayed) setTimeout(() => {
    source.out.push(target);
    source.dec.decodeQueueSize = 0;
    source.poke();
  }, 0);
  assert.equal(await source.frameAt(1), target);
  assert.equal(first.closed, true);
  assert.equal(flushes, delayed ? 0 : 1);
});

test("export decode: an output past the requested frame still restarts at its sync sample", async () => {
  const Source = load();
  const source = new Source(null, 4, { samples }, {});
  source.cur = frame(0);
  source.pos = samples.length;
  source.dec = { state: "configured" };
  source.out = [frame(2e6)];
  const target = frame(1e6);
  let restarted = false;
  source.restart = (sync) => {
    assert.equal(sync, 0);
    restarted = true;
    source.dropQueue();
    source.out.push(target);
  };
  assert.equal(await source.frameAt(1), target);
  assert.equal(restarted, true);
});

/* exportDecodeFrame after its export ended: the watchdog (or a cancel) can end an export while a
   source is still opening or a frame still decoding, and the next export may have begun by then. */
const frameStart = src.indexOf("async function exportDecodeFrame(");
const frameEnd = src.indexOf("async function seekVideosTo(", frameStart);
assert.ok(frameStart >= 0 && frameEnd > frameStart, "exportDecodeFrame markers exist");
function loadFrame(runtime, open) {
  return new Function("runtime", "evalProps", "getMedia", "ExportFrameSource", "mediaTimeAt", "console",
    `${src.slice(frameStart, frameEnd)}; return exportDecodeFrame;`)(runtime, () => ({}), () => ({ src: "/media/a.mp4" }),
    { open }, (c, t) => t, { warn() { } });
}
const session = () => ({ sources: new Map(), opening: new Map() });
const clip = { id: "c1", kind: "video", mediaId: "m" };

test("export decode: a source that opens after its export ended is closed, and the next export's frames are left alone", async () => {
  const runtime = { exportDecode: session(), exportFrames: new Map() };
  let opened = null;
  const source = { closed: false, close() { this.closed = true; }, frameAt: async () => "stale" };
  const decodeFrame = loadFrame(runtime, () => new Promise((r) => { opened = r; }));
  const pending = decodeFrame(clip, 1);
  const next = session();
  runtime.exportDecode = next; runtime.exportFrames = new Map([["c1", "fresh"]]);   // a new export began meanwhile
  opened(source);
  assert.equal(await pending, false);
  assert.equal(source.closed, true, "nobody else would close it");
  assert.equal(runtime.exportFrames.get("c1"), "fresh");
  assert.equal(next.sources.size, 0);
});

test("export decode: a frame (or a decode error) that lands after its export ended touches nothing", async () => {
  for (const fails of [false, true]) {
    const runtime = { exportDecode: session(), exportFrames: new Map() };
    let decoded = null;
    const source = { close() { }, frameAt: () => new Promise((res, rej) => { decoded = fails ? () => rej(new Error("closed")) : () => res("stale"); }) };
    runtime.exportDecode.sources.set("c1", source);
    const decodeFrame = loadFrame(runtime, () => { throw new Error("not opened again"); });
    const pending = decodeFrame(clip, 1);
    await Promise.resolve();
    runtime.exportDecode = null; runtime.exportFrames = null;   // the export ended: its frame map is gone
    decoded();
    assert.equal(await pending, false, "no TypeError on the map that is gone");
    runtime.exportDecode = session(); runtime.exportFrames = new Map([["c1", "fresh"]]);
    assert.equal(runtime.exportFrames.get("c1"), "fresh");
  }
});
