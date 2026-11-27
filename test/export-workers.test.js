/* Fast export's frame encoders and stall watchdog — sliced from app.js so the
   tests run the production code with stand-in workers and clocks. */
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
const WORKERS = slice("const JPEG_WORKER_SRC = ", "function jpegFromBitmap(");
const WATCHDOG = slice("function exportWatchdog(", "/* Sequential /frame POSTs");

/* A stand-in Worker: records what it is sent; the test says when it starts,
   answers, or fails. */
class FakeWorker {
  constructor() { this.sent = []; this.terminated = false; FakeWorker.all.push(this); }
  postMessage(msg) { this.sent.push(msg); }
  terminate() { this.terminated = true; }
  start() { this.onmessage({ data: { ready: true } }); }
  answer(i = 0) { const m = this.sent[i]; this.onmessage({ data: { id: m.id, buf: new ArrayBuffer(4) } }); }
  fail(message) { this.onerror({ message }); }
}
function loadWorkers() {
  FakeWorker.all = [];
  const here = [];
  const jpegFromBitmap = (bmp) => { here.push(bmp); return Promise.resolve(new ArrayBuffer(2)); };
  const create = new Function("Worker", "OffscreenCanvas", "URL", "Blob", "jpegFromBitmap",
    `${WORKERS}; return createJpegWorkers;`)(
    FakeWorker, function () { }, { createObjectURL: () => "blob:x", revokeObjectURL() { } }, function () { }, jpegFromBitmap);
  return { create, here, workers: FakeWorker.all };
}
const bmp = (n) => ({ n });

test("frame encoders: the worker script says it is running before it takes frames", () => {
  assert.match(WORKERS, /JPEG_WORKER_SRC = `"use strict";\nself\.postMessage\(\{ ready: true \}\);/);
});

test("frame encoders: a worker that never starts gets no frames; they are encoded here until one does", async () => {
  const { create, here, workers } = loadWorkers();
  const pool = create(3);
  assert.equal(workers.length, 3);
  // nobody has started: the frame is encoded on this thread, not lost in a worker that may never run
  assert.equal((await pool.encode(bmp(0), 0.9)).byteLength, 2);
  assert.deepEqual(here, [bmp(0)]);
  workers[0].start(); workers[1].start();   // worker 2 never starts (a debugger holding it, a failed load)
  const answers = [1, 2, 3, 4].map((n) => pool.encode(bmp(n), 0.9));
  assert.equal(workers[2].sent.length, 0, "the worker that never started got nothing");
  assert.deepEqual([workers[0].sent.length, workers[1].sent.length], [2, 2], "the running ones share the frames");
  for (const w of workers.slice(0, 2)) { w.answer(0); w.answer(1); }
  assert.deepEqual((await Promise.all(answers)).map((b) => b.byteLength), [4, 4, 4, 4]);
  assert.equal(here.length, 1);
});

test("frame encoders: a worker that fails is dropped, and the frames it held fail with the reason", async () => {
  const { create, workers } = loadWorkers();
  const pool = create(2);
  workers[0].start(); workers[1].start();
  const a = pool.encode(bmp(1)), b = pool.encode(bmp(2));
  workers[0].fail("out of memory");
  await assert.rejects(a, /a frame encoder stopped: out of memory/);
  assert.equal(workers[0].terminated, true);
  workers[1].answer(0);
  assert.equal((await b).byteLength, 4);
  const c = pool.encode(bmp(3));
  assert.equal(workers[0].sent.length, 1, "nothing more goes to the dropped worker");
  assert.equal(workers[1].sent.length, 2);
  pool.terminate();
  await assert.rejects(c, /cancelled/);
});

test("frame encoders: a frame a worker keeps past the answer limit fails, and the worker is dropped", async () => {
  const { create, here, workers } = loadWorkers();
  const pool = create(1, { answerMs: 20 });
  workers[0].start();
  await assert.rejects(pool.encode(bmp(1)), /a frame encoder didn't answer in 0 s/);
  assert.equal(workers[0].terminated, true);
  await pool.encode(bmp(2));   // none left: encoded here
  assert.deepEqual(here, [bmp(2)]);
});

test("frame encoders: terminate cancels the frames still out", async () => {
  const { create, workers } = loadWorkers();
  const pool = create(2);
  workers[0].start();
  const a = pool.encode(bmp(1));
  pool.terminate();
  await assert.rejects(a, /cancelled/);
  assert.ok(workers.every((w) => w.terminated));
});

/* the watchdog on a hand-driven clock: advance(ms) moves time and runs its checks */
function loadWatchdog(doc = { hidden: false }) {
  const clock = { now: 0, checks: new Map(), next: 1 };
  const exportWatchdog = new Function("performance", "setInterval", "clearInterval", "document", `${WATCHDOG}; return exportWatchdog;`)(
    { now: () => clock.now },
    (fn) => { clock.checks.set(clock.next, fn); return clock.next++; },
    (id) => { clock.checks.delete(id); }, doc);
  const advance = (ms) => { clock.now += ms; for (const fn of [...clock.checks.values()]) fn(); };
  return { exportWatchdog, advance, clock };
}
const settled = (p) => p.then(() => "resolved", (e) => "rejected: " + e.message);

test("export watchdog: nothing moving for the limit fails the guarded step and tells the polling waits", async () => {
  const { exportWatchdog, advance } = loadWatchdog();
  let told = null;
  const w = exportWatchdog(45, (e) => { told = e; });
  const step = settled(w.guard(new Promise(() => { })));
  advance(59000);
  assert.equal(told, null, "a 45 s export gets the one-minute floor");
  advance(1000);
  assert.match(String(told), /the export stalled: nothing moved on for 60 s/);
  assert.match(await step, /^rejected: the export stalled/);
  w.stop();
});

test("export watchdog: steps that move the export on keep it alive; stop() ends it", async () => {
  const { exportWatchdog, advance, clock } = loadWatchdog();
  let told = null;
  const w = exportWatchdog(45, (e) => { told = e; });
  for (let i = 0; i < 10; i++) { advance(50000); w.moved(); }
  assert.equal(told, null, "500 s of steps 50 s apart never stall");
  assert.equal(await w.guard(Promise.resolve("done")), "done");
  w.stop();
  assert.equal(clock.checks.size, 0);
  advance(600000);
  assert.equal(told, null, "a stopped watchdog never fires");
});

test("export watchdog: a guarded step that finishes counts as moving on", async () => {
  const { exportWatchdog, advance } = loadWatchdog();
  let told = null, done = null;
  const w = exportWatchdog(45, (e) => { told = e; });
  advance(40000);
  const g = w.guard(new Promise((r) => { done = r; }));
  advance(15000);
  done("ok");
  assert.equal(await g, "ok");   // the step ended 55 s in
  advance(40000);
  assert.equal(told, null, "95 s since the start, but only 40 s since the step finished");
  advance(20000);
  assert.match(String(told), /for 60 s/);
  w.stop();
});

test("export watchdog: a hidden tab, whose timers the browser runs about once a minute, gets five minutes", () => {
  const doc = { hidden: true };
  const { exportWatchdog, advance } = loadWatchdog(doc);
  let told = null;
  const w = exportWatchdog(45, (e) => { told = e; });
  for (let i = 0; i < 4; i++) { advance(61000); w.moved(); }   // throttled: a step a minute, healthy
  assert.equal(told, null);
  advance(299000);
  assert.equal(told, null);
  advance(1000);
  assert.match(String(told), /nothing moved on for 300 s/);
  w.stop();
  const shown = loadWatchdog({ hidden: false }), w2 = shown.exportWatchdog(45, (e) => { told = e; });
  told = null; shown.advance(60000);
  assert.match(String(told), /for 60 s/, "a visible tab keeps the one-minute limit");
  w2.stop();
});

test("export watchdog: a long export gets a longer limit (one step can scale with its length)", () => {
  const { exportWatchdog, advance } = loadWatchdog();
  let told = null;
  const w = exportWatchdog(5100, (e) => { told = e; });   // 85 minutes
  advance(500000);
  assert.equal(told, null);
  advance(10000);
  assert.match(String(told), /nothing moved on for 510 s/);
  w.stop();
});
