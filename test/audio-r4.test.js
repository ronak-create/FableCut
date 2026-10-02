/* Pitch shift, effect automation, submix buses and noise reduction — the
   data / agent side of each, plus the pitch worklet run in Node on a sine
   (the fx worklets are plain AudioWorkletProcessors, mocked as in
   meter-worklet.test.js). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { ROOT, makeDataDir, readProject, seedProject, startMcp, startServer } = require("./helpers");
const FX = require("../audio-fx.js");
const EditOps = require("../edit-ops.js");

let HAS_FFMPEG = false;
try { HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; } catch {}

/* ── Pitch worklet ── */
const SR = 48000;
const processors = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "fx-worklet.js"), "utf8"), {
  AudioWorkletProcessor: class {}, registerProcessor: (name, cls) => { processors[name] = cls; },
  sampleRate: SR, Math, Float32Array, Array,
});
/** Run `seconds` of a sine at `hz` through fablecut-pitch; return the output. */
function shift(hz, semitones, seconds = 1, mix = 1) {
  const P = new processors["fablecut-pitch"]();
  const n = Math.round(seconds * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    const len = Math.min(128, n - i);
    const inp = new Float32Array(len), o = new Float32Array(len);
    for (let k = 0; k < len; k++) inp[k] = Math.sin(2 * Math.PI * hz * (i + k) / SR);
    P.process([[inp]], [[o]], { semitones: [semitones], mix: [mix] });
    out.set(o, i);
  }
  return out;
}
/** Dominant frequency over the second half (skips the delay line filling). */
function freqOf(x) {
  const a = Math.floor(x.length / 2);
  let crossings = 0;
  for (let i = a + 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return crossings / ((x.length - a) / SR);
}

test("pitch shift moves a sine by the asked interval and leaves 0 st untouched", () => {
  const near = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: ${got.toFixed(1)} Hz, wanted ≈${want}`);
  near(freqOf(shift(440, 12)), 880, 25, "+12 st doubles");
  near(freqOf(shift(440, -12)), 220, 12, "−12 st halves");
  near(freqOf(shift(440, -4)), 440 * Math.pow(2, -4 / 12), 15, "−4 st (Deep voice)");
  const dry = shift(440, 0, 0.1);
  for (let i = 0; i < dry.length; i++) assert.ok(Math.abs(dry[i] - Math.sin(2 * Math.PI * 440 * i / SR)) < 1e-6, "0 st passes through exactly");
});

test("Deep voice is a real pitch shift now, and pitch is a normal effect", () => {
  const chain = FX.presetChain("deep-voice");
  assert.equal(chain[0].type, "pitch");
  assert.ok(chain[0].semitones < 0);
  assert.deepEqual(FX.normalizeEffect({ type: "pitch", semitones: 40 }), { type: "pitch", semitones: 12, mix: 1 }, "clamped to ±12");
});

/* ── Effect automation (keys) ── */
test("effect keys are validated, clamped, sorted and interpolated", () => {
  const e = FX.normalizeEffect({ type: "lowpass", keys: { freq: [{ t: 4, v: 400, ease: "linear" }, { t: 0, v: 99999 }, { t: 4, v: 500, ease: "linear" }] } });
  assert.deepEqual(e.keys.freq, [{ t: 0, v: 20000 }, { t: 4, v: 500, ease: "linear" }], "clamped to range, sorted, one key per time (last wins)");
  assert.equal(FX.evalEffect(e, 2).freq, 10250, "linear halfway");
  assert.equal(FX.evalEffect(e, 9).freq, 500, "holds the last value");
  assert.equal(FX.evalEffect(e, 2).q, e.q, "unkeyed params keep their value");
  assert.equal(FX.summarizeFx([e]), "lowpass~freq");
  assert.throws(() => FX.normalizeFx([{ type: "reverb", keys: { decay: [{ t: 0, v: 1 }] } }], true), /decay cannot be automated/);
  assert.throws(() => FX.normalizeFx([{ type: "eq", keys: { nope: [] } }], true), /unknown parameter/);
  assert.throws(() => FX.normalizeFx([{ type: "eq", keys: { lowGain: [{ t: -1, v: 0 }] } }], true), /t ≥ 0/);
  assert.equal(FX.normalizeFx([{ type: "eq", keys: { nope: [] } }])[0].keys, undefined, "lenient load drops bad keys");
});

/* ── Links survive a denoised copy ── */
test("a stem playing a denoised copy still links to its picture", () => {
  const doc = {
    media: [{ id: "m_v", kind: "video" }, { id: "m_d", kind: "audio", derivedFrom: "m_v", denoise: "medium" }],
    clips: [
      { id: "v", kind: "video", track: "V1", mediaId: "m_v", start: 0, in: 0, duration: 4 },
      { id: "l", kind: "audio", track: "A1", mediaId: "m_d", start: 0, in: 0, duration: 4, props: { audioChannel: 0 } },
    ],
  };
  EditOps.forDoc(doc).relinkClips();
  assert.ok(doc.clips[0].linkGroup && doc.clips[0].linkGroup === doc.clips[1].linkGroup);
});

/* ── Agent side: buses, fx keys ── */
const boot = async (t, project) => {
  const dir = makeDataDir(t, project);
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  return { dir, mcp, patch: (...ops) => mcp.callTool("fablecut_patch_project", { ops }), doc: () => readProject(dir) };
};

test("setBus / setTrack out / removeBus route tracks through submix buses", async (t) => {
  const { patch, doc, mcp } = await boot(t);
  const r = await patch(
    { op: "setBus", id: "B1", set: { name: "Dialogue", gain: -3 } },
    { op: "setTrack", id: "A1", set: { out: "B1" } },
    { op: "setTrack", id: "A2", set: { out: "B1" } },
    { op: "setFx", target: "bus", id: "B1", preset: "podcast" },
  );
  assert.equal(r.isError, false, r.text);
  let d = doc();
  assert.deepEqual(d.buses.map((b) => [b.id, b.name, b.gain]), [["B1", "Dialogue", -3]]);
  assert.equal(d.tracks.find((x) => x.id === "A1").out, "B1");
  assert.ok(d.buses[0].fx.length > 2);
  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(text, /A1→B1/);
  assert.match(text, /bus B1 "Dialogue" -3dB fx:/);

  const bad = await patch({ op: "setTrack", id: "A3", set: { out: "B9" } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /no bus "B9"/);

  assert.equal((await patch({ op: "removeBus", id: "B1" })).isError, false);
  d = doc();
  assert.equal(d.buses, undefined);
  assert.equal(d.tracks.find((x) => x.id === "A1").out, undefined, "its tracks go back to the master");
});

test("setFxKeys automates one parameter and clears it again", async (t) => {
  const { patch, doc } = await boot(t);
  await patch({ op: "setFx", target: "master", fx: [{ type: "eq" }, { type: "lowpass" }] });
  const r = await patch({ op: "setFxKeys", target: "master", type: "lowpass", param: "freq", keys: [{ t: 0, v: 18000 }, { t: 6, v: 600, ease: "ease-in" }] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /master\.fx\[1\]\.freq\(2 keys\)/);
  assert.deepEqual(doc().master.fx[1].keys.freq, [{ t: 0, v: 18000 }, { t: 6, v: 600, ease: "ease-in" }]);
  const badParam = await patch({ op: "setFxKeys", target: "master", index: 0, param: "freq", keys: [] });
  assert.match(badParam.text, /eq has no parameter "freq"/);
  await patch({ op: "setFxKeys", target: "master", index: 1, param: "freq", keys: null });
  assert.equal(doc().master.fx[1].keys, undefined);
});

/* ── Noise reduction ── */
const skip = HAS_FFMPEG ? false : "noise reduction needs ffmpeg on PATH";
/** A 3 s stereo take: hiss alone for the first second, then a tone over it. */
function noisyTake(dir) {
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  const file = path.join(dir, "media", "take.wav");
  const r = spawnSync("ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.05:duration=3:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=2:sample_rate=48000",
    "-filter_complex", "[1]adelay=1000|1000,volume=0.4[t];[0][t]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo",
    file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}
function rmsDb(file, from, dur) {
  const r = spawnSync("ffmpeg", ["-v", "info", "-ss", String(from), "-t", String(dur), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  return +/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)[1];
}

test("fablecut_denoise renders a cleaner copy, switches the stems, and off switches back", { skip }, async (t) => {
  const project = seedProject({
    media: [{ id: "m_v", name: "take.wav", kind: "audio", src: "/media/take.wav", duration: 3 }],
    clips: [
      { id: "a", kind: "audio", track: "A1", mediaId: "m_v", start: 0, in: 0, duration: 3, props: { audioChannel: 0 }, linkGroup: "g" },
      { id: "b", kind: "audio", track: "A2", mediaId: "m_v", start: 0, in: 0, duration: 3, props: { audioChannel: 1 }, linkGroup: "g" },
    ],
  });
  const { dir, mcp, doc } = await boot(t, project);
  const src = noisyTake(dir);
  const r = await mcp.callTool("fablecut_denoise", { clipIds: ["a"], amount: "strong" });
  assert.equal(r.isError, false, r.text);
  const d = doc();
  const m = d.media.find((x) => x.derivedFrom === "m_v");
  assert.ok(m, "a derived media entry is registered");
  assert.equal(m.denoise, "strong");
  assert.deepEqual(d.clips.map((c) => c.mediaId), [m.id, m.id], "both linked stems switch");
  const out = path.join(dir, "media", decodeURIComponent(m.src.slice(7)));
  const before = rmsDb(src, 0.2, 0.6), after = rmsDb(out, 0.2, 0.6);
  assert.ok(before - after > 6, `hiss pulled down by more than 6 dB (${before} → ${after})`);
  assert.ok(Math.abs(rmsDb(src, 1.5, 1) - rmsDb(out, 1.5, 1)) < 3, "the tone survives");

  const again = await mcp.callTool("fablecut_denoise", { clipIds: ["b"], amount: "strong" });
  assert.match(again.text, /already rendered/);
  assert.equal(doc().media.filter((x) => x.derivedFrom).length, 1, "no duplicate media entry");

  const off = await mcp.callTool("fablecut_denoise", { clipIds: ["a"], amount: "off" });
  assert.equal(off.isError, false, off.text);
  assert.deepEqual(doc().clips.map((c) => c.mediaId), ["m_v", "m_v"]);
});

test("fablecut_denoise refuses a picture that carries its own sound", { skip }, async (t) => {
  const { mcp } = await boot(t);
  const r = await mcp.callTool("fablecut_denoise", { clipIds: ["c_a"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /plays from the picture/);
});

test("POST /api/denoise validates its input", { skip }, async (t) => {
  const dir = makeDataDir(t);
  const { base } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  const post = (body) => fetch(base + "/api/denoise", { method: "POST", body: JSON.stringify(body) }).then((r) => r.status);
  assert.equal(await post({ src: "/media/x.wav", amount: "loud" }), 400);
  assert.equal(await post({ src: "/media/../project.json", amount: "light" }), 404);
  assert.equal(await post({ src: "/media/missing.wav", amount: "light" }), 404);
});
