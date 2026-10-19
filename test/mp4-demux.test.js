/* mp4-demux.js — the sample table the exporter feeds to VideoDecoder. Two
   layers: hand-built moov boxes, so every table (stts, ctts, stss, stsc,
   stco / co64, elst) is checked against numbers worked out by hand without
   any tool; and, when ffmpeg is on PATH, real files (B-frames, HEVC, a MOV,
   moov at the end) checked against ffprobe's packet list. The decoding itself
   runs in the browser and is checked there by hand. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const M = require("../mp4-demux.js");

const hasFfmpeg = () => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
};

/* ── tiny box writer ── */
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >> 8) & 255, n & 255];
const str = (s) => [...s].map((c) => c.charCodeAt(0));
const box = (type, ...parts) => {
  const body = parts.flat(Infinity);
  return [...be32(8 + body.length), ...str(type), ...body];
};
const full = (type, version, ...parts) => box(type, [version, 0, 0, 0], ...parts);
const zeros = (n) => new Array(n).fill(0);
const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(be32);

/** A one-track moov: 640×360 avc1 at timescale 1000, the given sample tables. */
function movie({ stts, ctts, cttsVersion = 0, stss, stsc, chunks, sizes, elst, matrix = IDENTITY, co64 = false, movieScale = 1000 }) {
  const avcC = box("avcC", [1, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0x00]);
  const avc1 = box("avc1", zeros(6), be16(1), zeros(16), be16(640), be16(360), zeros(50), avcC);
  const stbl = box("stbl",
    full("stsd", 0, be32(1), avc1),
    full("stts", 0, be32(stts.length), stts.map(([c, d]) => [be32(c), be32(d)])),
    ctts ? full("ctts", cttsVersion, be32(ctts.length), ctts.map(([c, o]) => [be32(c), be32(o)])) : [],
    stss ? full("stss", 0, be32(stss.length), stss.map(be32)) : [],
    full("stsc", 0, be32(stsc.length), stsc.map(([f, n]) => [be32(f), be32(n), be32(1)])),
    full("stsz", 0, be32(0), be32(sizes.length), sizes.map(be32)),
    co64 ? full("co64", 0, be32(chunks.length), chunks.map((c) => [be32(Math.floor(c / 2 ** 32)), be32(c % 2 ** 32)]))
      : full("stco", 0, be32(chunks.length), chunks.map(be32)));
  const trak = box("trak",
    full("tkhd", 0, zeros(36), matrix, be32(640 << 16), be32(360 << 16)),
    elst ? box("edts", full("elst", 0, be32(elst.length), elst.map(([d, t]) => [be32(d), be32(t >>> 0), be16(1), be16(0)]))) : [],
    box("mdia",
      full("mdhd", 0, zeros(8), be32(1000), be32(0), zeros(4)),
      full("hdlr", 0, zeros(4), str("vide"), zeros(12), [0]),
      box("minf", stbl)));
  return new Uint8Array(box("moov", full("mvhd", 0, zeros(8), be32(movieScale), zeros(84)), trak));
}

test("sample table: sizes, chunk offsets, sync samples and B-frame order", () => {
  // 6 samples of 33 ms, decode order I P B B P B; two chunks (4 + 2 samples)
  const mv = M.parseMovie(movie({
    stts: [[6, 33]],
    ctts: [[1, 66], [1, 132], [2, 0], [1, 99], [1, 0]],   // per-sample composition offsets
    stss: [1, 5],
    stsc: [[1, 4], [2, 2]],
    chunks: [1000, 5000],
    sizes: [100, 50, 20, 20, 60, 30],
  }));
  assert.equal(mv.codec, "avc1.64001F");
  assert.deepEqual([mv.width, mv.height], [640, 360]);
  assert.deepEqual(mv.samples.map((s) => s.offset), [1000, 1100, 1150, 1170, 5000, 5060]);
  assert.deepEqual(mv.samples.map((s) => s.key), [true, false, false, false, true, false]);
  assert.deepEqual(mv.samples.map((s) => s.cts), [66, 165, 66, 99, 231, 165]);
  assert.equal(mv.samples[0].dur, 0.033);
  // presentation order sorts by pts, and frameAt picks the latest pts ≤ t
  const order = M.presentationOrder(mv.samples);
  assert.equal(M.frameAt(mv.samples, order, 0), order[0]);
  assert.equal(M.frameAt(mv.samples, order, 0.231), 4);
  assert.equal(M.frameAt(mv.samples, order, 10), 4);
  assert.equal(M.syncBefore(mv.samples, 3), 0);
  assert.equal(M.syncBefore(mv.samples, 5), 4);
});

for (const version of [0, 1]) test(`ctts version ${version}: negative offsets preserve B-frame presentation order`, () => {
  const mv = M.parseMovie(movie({
    stts: [[4, 40]], ctts: [[1, 0], [1, 40], [1, -40], [1, 0]], cttsVersion: version,
    stsc: [[1, 4]], chunks: [1000], sizes: [1, 1, 1, 1],
  }));
  assert.deepEqual(mv.samples.map((s) => s.cts), [0, 80, 40, 120]);
  assert.deepEqual(mv.samples.map((s) => s.pts), [0, 0.08, 0.04, 0.12]);
  const order = M.presentationOrder(mv.samples);
  assert.deepEqual(order, [0, 2, 1, 3]);
  assert.equal(M.frameAt(mv.samples, order, 0.04), 2);
  assert.equal(M.frameAt(mv.samples, order, 0.08), 1);
});

test("the edit list moves pts onto the clock a <video> element shows", () => {
  const base = { stts: [[3, 40]], stsc: [[1, 3]], chunks: [0], sizes: [1, 1, 1] };
  // media_time 80: the first 80 ticks of media are skipped, sample 2 is t = 0
  const cut = M.parseMovie(movie({ ...base, elst: [[120, 80]] }));
  assert.deepEqual(cut.samples.map((s) => +s.pts.toFixed(3)), [-0.08, -0.04, 0]);
  // a leading empty edit (500 movie ticks at 1000/s) delays everything by 0.5 s
  const late = M.parseMovie(movie({ ...base, elst: [[500, -1], [120, 0]] }));
  assert.deepEqual(late.samples.map((s) => +s.pts.toFixed(3)), [0.5, 0.54, 0.58]);
  // no stss: every sample is a sync sample
  assert.ok(cut.samples.every((s) => s.key));
});

test("64-bit chunk offsets", () => {
  const big = 3 * 2 ** 32 + 1000;   // past 4 GB: needs the high word
  const mv = M.parseMovie(movie({ stts: [[2, 33]], stsc: [[1, 2]], chunks: [big], sizes: [10, 20], co64: true }));
  assert.deepEqual(mv.samples.map((s) => s.offset), [big, big + 10]);
});

test("a rotated track is refused, so the exporter keeps the <video> element", () => {
  const rot90 = [0, 0x10000, 0, 0xffff0000, 0, 0, 0, 0, 0x40000000].map(be32);
  assert.equal(M.parseMovie(movie({ stts: [[1, 33]], stsc: [[1, 1]], chunks: [0], sizes: [1], matrix: rot90 })), null);
});

test("findMoov walks top-level boxes through range reads", async () => {
  const moov = movie({ stts: [[1, 33]], stsc: [[1, 1]], chunks: [0], sizes: [1] });
  const mdat = box("mdat", zeros(200000));   // moov after a big mdat, as without +faststart
  const file = new Uint8Array([...box("ftyp", str("isom"), zeros(4)), ...mdat, ...moov]);
  const reads = [];
  const read = async (a, b) => { reads.push([a, b]); return file.subarray(a, b); };
  const found = await M.findMoov(read, file.length);
  assert.deepEqual([...found.subarray(4, 8)].map((c) => String.fromCharCode(c)).join(""), "moov");
  assert.equal(found.length, moov.length);
  assert.ok(reads.length <= 3, "skips the mdat instead of reading it");
  // fragmented files are left to the <video> path
  const frag = new Uint8Array([...box("ftyp", str("isom")), ...box("moof", zeros(8)), ...moov]);
  assert.equal(await M.findMoov(async (a, b) => frag.subarray(a, b), frag.length), null);
});

test("codec strings for HEVC, VP9 and AV1 config boxes", () => {
  const cs = (entry, body) => {
    const b = new Uint8Array(box("cfg ", body));
    return M.codecString(entry, b, { body: 8, end: b.length });
  };
  // hvcC: profile_space 0, tier 0, profile 1, compat 0x60000000, constraint 0x90, level 93
  assert.equal(cs("hvc1", [1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93]), "hvc1.1.6.L93.90");
  assert.equal(cs("vp09", [1, 0, 0, 0, 0, 21, 0x80]), "vp09.00.21.08");
  assert.equal(cs("av01", [0x81, 0x08, 0x0c]), "av01.0.08M.08");
});

test("real files match ffprobe's packet list", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-mp4-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30", "-t", "2"];
  const files = {
    "bframes.mp4": ["-c:v", "libx264", "-bf", "3", "-g", "15"],   // moov at the end
    "faststart.mp4": ["-c:v", "libx264", "-bf", "2", "-movflags", "+faststart"],
    "clip.mov": ["-c:v", "libx264", "-bf", "2"],
    "hevc.mp4": ["-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1"],
  };
  for (const [name, args] of Object.entries(files)) {
    const f = path.join(dir, name);
    try { execFileSync("ffmpeg", ["-v", "error", "-y", ...src, ...args, f], { stdio: "ignore" }); }
    catch { continue; }   // an encoder this ffmpeg lacks
    const buf = new Uint8Array(fs.readFileSync(f));
    const moov = M.boxes(buf).find((b) => b.type === "moov");
    const mv = M.parseMovie(buf.subarray(moov.start, moov.end));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,size,pos,flags", "-of", "json", f]));
    assert.equal(mv.samples.length, probe.packets.length, name);
    probe.packets.forEach((p, i) => {
      const s = mv.samples[i];
      assert.equal(s.offset, +p.pos, `${name} #${i} offset`);
      assert.equal(s.size, +p.size, `${name} #${i} size`);
      assert.equal(s.key, p.flags.includes("K"), `${name} #${i} key`);
      assert.ok(Math.abs(s.pts - +p.pts_time) < 1e-4, `${name} #${i} pts ${s.pts} vs ${p.pts_time}`);
    });
  }
});
