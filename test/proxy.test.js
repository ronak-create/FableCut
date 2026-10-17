/* proxy.js and /api/proxy: light copies of heavy footage, made by ffmpeg in
   the background, named after the source version, served at /proxies/, and
   frame-for-frame on the original's timestamps. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { makeDataDir, startServer, rawGet } = require("./helpers");
const { createProxies, findProxies } = require("../proxy");

const hasFfmpeg = () => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
};
const NO_FFMPEG = !hasFfmpeg() && "ffmpeg not on PATH";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A short 1280×720 test clip with a frame counter in the picture. */
function makeClip(file, seconds = 2) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", file]);
}

test("proxy names follow the source version, so a changed original stops matching its old proxy", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-proxy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, "Shot 1.mp4");
  fs.writeFileSync(src, "v1");
  const pdir = path.join(dir, "proxies");
  fs.mkdirSync(pdir);
  assert.deepEqual(findProxies(pdir, src), []);
  // what a finished 540p job leaves behind
  const p = createProxies({ dir: pdir, resolveSrc: () => src });
  assert.deepEqual(await p.status("/media/Shot%201.mp4"), { state: "none" });
  const st = fs.statSync(src);
  const h = crypto.createHash("sha1").update(path.resolve(src) + "|" + st.size + "|" + Math.round(st.mtimeMs)).digest("hex").slice(0, 10);
  fs.writeFileSync(path.join(pdir, `Shot_1-${h}-540p.mp4`), "proxy");
  fs.writeFileSync(path.join(pdir, `Shot_1-${h}-720p.mp4`), "proxy, bigger");
  assert.deepEqual(findProxies(pdir, src).map((x) => x.height), [720, 540], "largest first");
  assert.equal((await p.status("/media/Shot%201.mp4")).state, "ready");
  assert.match((await p.status("/media/Shot%201.mp4")).src, /^\/proxies\/Shot_1-[0-9a-f]{10}-720p\.mp4$/);
  fs.writeFileSync(src, "v2 — re-rendered");
  assert.deepEqual(findProxies(pdir, src), [], "a new version of the file has no proxy yet");
  assert.equal(p.file("../secret.mp4"), null);
  assert.equal(p.file(".hidden.mp4"), null);
  assert.equal(p.file("x.txt"), null);
});

test("/api/proxy makes a frame-accurate H.264 proxy, serves it, reports it, deletes it", { skip: NO_FFMPEG }, async (t) => {
  const dir = makeDataDir(t);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  makeClip(path.join(dir, "media", "clip a.mp4"));
  const { base, port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const post = async (p, body) => (await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const src = "/media/clip%20a.mp4";
  assert.equal((await post("/api/proxy/status", { srcs: [src] })).status[src].state, "none");
  const started = (await post("/api/proxy", { srcs: [src, "/media/missing.mp4"], height: 540 })).status;
  assert.ok(["queued", "running"].includes(started[src].state));
  assert.equal(started["/media/missing.mp4"], null);
  let st;
  for (let i = 0; i < 120; i++) {
    st = (await post("/api/proxy/status", { srcs: [src] })).status[src];
    if (st.state !== "queued" && st.state !== "running") break;
    await sleep(250);
  }
  assert.equal(st.state, "ready", JSON.stringify(st));
  assert.equal(st.height, 540);
  assert.equal(st.width, 960);
  const file = path.join(dir, "analysis", "proxies", decodeURIComponent(st.src.slice("/proxies/".length)));
  assert.ok(fs.existsSync(file));
  // the same frames at the same times: frame 25 of the original is frame 25 of the proxy
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" }));
  const v = probe.streams.find((s) => s.codec_type === "video");
  assert.equal(v.codec_name, "h264");
  assert.equal(v.avg_frame_rate, "25/1");
  assert.ok(probe.streams.some((s) => s.codec_type === "audio"), "keeps the sound");
  const db = (s) => { const m = /average:([0-9.]+|inf)/.exec(s); return m ? (m[1] === "inf" ? 99 : +m[1]) : NaN; };
  const getDb = (ta, tb) => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(ta), "-i", path.join(dir, "media", "clip a.mp4"), "-ss", String(tb), "-i", file,
      "-filter_complex", "[0:v]scale=960:540,format=yuv420p,setpts=0[x];[1:v]format=yuv420p,setpts=0[y];[x][y]psnr", "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" });
    return db(r.stderr);
  };
  const same = getDb(1.0, 1.0), off = getDb(1.04, 1.0);
  assert.ok(same > 35, `same moment should match closely (${same} dB)`);
  assert.ok(same > off + 6, `one frame off should match much worse (${same} vs ${off} dB)`);
  // served at its src, and refused outside the proxies folder
  const res = await fetch(base + st.src);
  assert.equal(res.status, 200);
  assert.ok((await res.arrayBuffer()).byteLength > 1000);
  assert.notEqual((await rawGet(port, "/proxies/..%2fproject.json")).status, 200);
  // asking again is a no-op; delete removes it
  assert.equal((await post("/api/proxy", { srcs: [src], height: 540 })).status[src].state, "ready");
  assert.deepEqual((await post("/api/proxy/delete", { srcs: [src] })).deleted, { [src]: 1 });
  assert.equal((await post("/api/proxy/status", { srcs: [src] })).status[src].state, "none");
  assert.ok(!fs.existsSync(file));
});
