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
