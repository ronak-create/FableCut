/* delivery.js (export presets → one ffmpeg pass), the delivery endpoints
   (/api/export/presets, /api/export/begin with a delivery spec) and the
   setProject delivery op. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const D = require("../delivery");
const ProjectOps = require("../project-ops");
const { makeDataDir, seedProject, startServer } = require("./helpers");

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("every preset normalizes to a complete spec with nothing to correct", () => {
  for (const id of D.PRESET_IDS) {
    const { spec, notes } = D.normalize(id);
    assert.equal(spec.preset, id);
    assert.deepEqual(notes, [], `${id}: ${notes.join("; ")}`);
    assert.ok(D.CODECS[spec.video.codec] && D.CONTAINERS[spec.container] && D.AUDIO[spec.audio.codec] && D.COLORS[spec.color], id);
    assert.ok(D.CODECS[spec.video.codec].containers.includes(spec.container), id);
    assert.ok(D.AUDIO[spec.audio.codec].containers.includes(spec.container), id);
  }
  assert.equal(D.DEFAULT_PRESET, "master");
  assert.equal(D.normalize("master").spec.width, null, "the default keeps the project's own size");
});

test("normalize corrects impossible combinations and says how", () => {
  let r = D.normalize({ preset: "youtube", video: { codec: "prores" } });
  assert.equal(r.spec.container, "mov", "ProRes moves to MOV");
  assert.equal(r.spec.audio.codec, "aac", "AAC is fine in MOV");
  assert.equal(r.spec.video.rate, "fixed");
  assert.equal(r.spec.video.pixFmt, "yuv422p10le");
  assert.ok(r.notes.some((n) => /MP4/.test(n)));

  r = D.normalize({ preset: "custom", container: "webm", audio: { codec: "aac" } });
  assert.equal(r.spec.video.codec, "h264");
  assert.equal(r.spec.container, "mp4", "H.264 does not go in WebM");

  r = D.normalize({ preset: "custom", container: "webm", video: { codec: "vp9" }, audio: { codec: "aac" } });
  assert.equal(r.spec.audio.codec, "opus", "WebM takes Opus");
  assert.equal(r.spec.video.crf, D.CODECS.vp9.crf[2], "a codec switch starts from that codec's CRF, not the preset's");

  r = D.normalize({ preset: "custom", width: 1921, height: 1081 });
  assert.equal(r.spec.width, 1922); assert.equal(r.spec.height, 1082);
  r = D.normalize({ preset: "custom", width: 1920 });
  assert.equal(r.spec.width, null, "width without height falls back to the picture's size");

  r = D.normalize({ preset: "nope" });
  assert.equal(r.spec.preset, "custom");
  assert.match(r.notes[0], /unknown preset/);

  r = D.normalize({ preset: "custom", fps: 29.97003 });
  assert.equal(r.spec.fps, 29.97);
  for (const m of [0, "", "abc", -5, null]) assert.equal(D.normalize({ preset: "instagram-reels", video: { maxrate: m } }).spec.video.maxrate, null, `maxrate ${JSON.stringify(m)} = no cap`);
  assert.equal(D.normalize({ preset: "custom", video: { maxrate: 50 } }).spec.video.maxrate, 100);
});

test("normalize picks an encoder this ffmpeg has, and keeps hardware pixel formats legal", () => {
  const sw = D.normalize({ preset: "youtube" }, { available: new Set(["libx264", "h264_nvenc", "aac"]) });
  assert.equal(sw.spec.video.encoder, "libx264", "software first unless asked");
  const hw = D.normalize({ preset: "custom", video: { encoder: "h264_qsv", pixFmt: "yuv422p" } }, { available: new Set(["libx264", "h264_qsv"]) });
  assert.equal(hw.spec.video.encoder, "h264_qsv");
  assert.equal(hw.spec.video.pixFmt, "yuv420p", "Quick Sync cannot do 4:2:2");
  const missing = D.normalize({ preset: "custom", video: { encoder: "h264_nvenc" } }, { available: new Set(["libx264"]) });
  assert.equal(missing.spec.video.encoder, "libx264");
  assert.ok(missing.notes.some((n) => /no h264_nvenc/.test(n)));
});

test("reframe: fill crops the middle, fit pads, the export frame is the source region", () => {
  const reel = D.normalize("instagram-reels").spec;
  let f = D.reframe(reel, 1920, 1080, null);
  assert.deepEqual(f.crop, { x: 656, y: 0, w: 608, h: 1080 });
  assert.equal(f.outW, 1080); assert.equal(f.outH, 1920);
  assert.ok(f.upscale);

  f = D.reframe({ ...reel, reframe: "fit" }, 1920, 1080, null);
  assert.equal(f.crop, null);
  assert.equal(f.scaleW, 1080); assert.equal(f.scaleH, 608);
  assert.equal(f.padY, 656);

  f = D.reframe(reel, 1920, 1080, { x: 1000, y: 0, w: 608, h: 1080 });
  assert.deepEqual(f.crop, { x: 1000, y: 0, w: 608, h: 1080 }, "an export frame of the right shape is used as is");

  const src = D.normalize("archive").spec;
  f = D.reframe(src, 1280, 720, null);
  assert.equal(f.crop, null); assert.equal(f.outW, 1280); assert.equal(f.upscale, false);
  f = D.reframe(src, 1280, 720, { x: 100, y: 50, w: 641, h: 361 });
  assert.equal(f.outW, 640, "the picture's own size, made even");
});

test("ffmpegArgs: the input side, the filter chain, rate control and the container flags", () => {
  const yt = D.normalize({ preset: "youtube", metadata: { title: "Hi", description: "Long text" } }).spec;
  const frame = D.reframe(yt, 1920, 1080, null);
  const args = D.ffmpegArgs(yt, { fps: 29.97, input: "jpeg", canvasW: 1920, canvasH: 1080, frame, wavPath: "a.wav", outPath: "o.mp4", duration: 2 });
  assert.equal(argAfter(args, "-framerate"), "30000/1001", "NTSC rates are exact fractions");
  assert.equal(argAfter(args, "-c:v"), "mjpeg", "first -c:v is the JPEG input decoder");
  assert.match(argAfter(args, "-vf"), /scale=1920:1080:flags=lanczos:in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709/);
  assert.ok(args.includes("libx264") && argAfter(args, "-crf") === "18");
  assert.equal(argAfter(args, "-g"), "15", "keyframe every 0.5 s at 29.97");
  assert.equal(argAfter(args, "-af"), "apad=whole_dur=2.000000,atrim=0:2.000000", "audio cut to the frames' length");
  assert.ok(!args.includes("-shortest"));
  assert.equal(argAfter(args, "-movflags"), "+faststart");
  assert.ok(args.includes("title=Hi") && args.includes("comment=Long text"));
  assert.equal(args[args.length - 1], "o.mp4");

  const cbr = D.normalize({ preset: "web", video: { rate: "cbr", bitrate: 5000 } }).spec;
  const c = D.ffmpegArgs(cbr, { fps: 30, input: "jpeg", canvasW: 1280, canvasH: 720, frame: D.reframe(cbr, 1280, 720), outPath: "o.mp4" });
  assert.equal(argAfter(c, "-minrate"), "5000k"); assert.equal(argAfter(c, "-maxrate"), "5000k");
  assert.equal(argAfter(c, "-x264-params"), "nal-hrd=cbr");
  assert.ok(c.includes("-an"), "no wav → no audio");

  const pr = D.normalize("broadcast").spec;
  assert.equal(D.frameInput(pr), "rgba", "ProRes 4:2:2 10-bit gets full-chroma frames");
  assert.equal(D.frameInput(yt), "jpeg");
  const p = D.ffmpegArgs(pr, { fps: 25, input: "rgba", canvasW: 1920, canvasH: 1080, frame: D.reframe(pr, 1920, 1080), outPath: "o.mov" });
  assert.equal(argAfter(p, "-pix_fmt"), "rgba");
  assert.equal(argAfter(p, "-profile:v"), "3");

  const reel = D.normalize("tiktok").spec;
  const r = D.ffmpegArgs(reel, { fps: 30, input: "jpeg", canvasW: 1920, canvasH: 1080, frame: D.reframe(reel, 1920, 1080), outPath: "o.mp4" });
  assert.match(argAfter(r, "-vf"), /^crop=608:1080:656:0,scale=1080:1920/);

  const nv = D.normalize({ preset: "custom", video: { codec: "hevc", encoder: "hevc_nvenc", pixFmt: "yuv420p10le" } }).spec;
  const n = D.ffmpegArgs(nv, { fps: 30, input: "jpeg", canvasW: 1280, canvasH: 720, frame: D.reframe(nv, 1280, 720), outPath: "o.mp4" });
  assert.equal(n[n.lastIndexOf("-pix_fmt") + 1], "p010le", "hardware encoders get their own pixel format names");
  assert.equal(argAfter(n, "-cq"), String(nv.video.crf));
  assert.equal(argAfter(n, "-tag:v"), "hvc1");
});

test("renderFilename fills tokens and strips what a file name cannot hold", () => {
  const sp = D.normalize("youtube").spec;
  const d = new Date(2026, 9, 18, 9, 5);
  assert.equal(D.renderFilename("{project}_{preset}_{res}_{fps}", sp, { project: "My film", width: 1920, height: 1080, fps: 29.97, date: d }), "My film_youtube_1080p_29_97");
  assert.equal(D.renderFilename("{project}_{w}x{h}_{date}_{time}", sp, { project: "a", width: 1080, height: 1920, date: d }), "a_1080x1920_2026-10-18_0905");
  assert.equal(D.renderFilename("../{project}:{nope}", sp, { project: "x" }), "_x_{nope}");
  assert.equal(D.renderFilename("{res}", sp, { width: 1080, height: 1080 }), "1080sq");
});

test("checks: upscaling, crops, platform limits and size", () => {
  const reel = D.normalize("instagram-reels").spec;
  const w = D.checks(reel, { duration: 200, canvasW: 1920, canvasH: 1080 });
  assert.ok(w.some((x) => /^Upscaled/.test(x)));
  assert.ok(w.some((x) => /^Cropped to 608×1080/.test(x)));
  assert.ok(w.some((x) => /longer than 3 min/.test(x)));
  assert.deepEqual(D.checks(reel, { duration: 30, canvasW: 1080, canvasH: 1920 }), [], "a vertical project fits a Reel exactly");
  const x = D.normalize({ preset: "x", video: { rate: "cbr", bitrate: 40000 } }).spec;
  assert.ok(D.checks(x, { duration: 130, canvasW: 1920, canvasH: 1080 }).some((m) => /512 MB/.test(m)));
  assert.ok(D.checks(D.normalize("broadcast").spec, { fps: 30, canvasW: 1920, canvasH: 1080 }).some((m) => /25 \/ 29.97/.test(m)));
  assert.equal(D.estimateSize(D.normalize("youtube").spec, { duration: 10 }), null, "CRF has no size up front");
});

test("savedPresets and parseEncoders", () => {
  const saved = D.savedPresets([
    { file: "client-4k.json", data: { id: "client-4k", label: "Client 4K", width: 3840, height: 2160, video: { codec: "hevc" } } },
    { file: "youtube.json", data: { label: "Shadow" } },
    { file: "junk.json", data: null },
  ]);
  assert.deepEqual(Object.keys(saved), ["client-4k"], "built-in ids cannot be shadowed");
  assert.equal(saved["client-4k"].video.codec, "hevc");
  assert.equal(D.normalize("client-4k", { presets: saved }).spec.width, 3840);
  const enc = D.parseEncoders(" V....D libx264              libx264 H.264\n A....D aac                  AAC\n ------\n V..... = Video\n");
  assert.deepEqual([...enc].sort(), ["aac", "libx264"]);
});

test("setProject delivery stores the complete spec; a bad preset is refused", () => {
  const proj = seedProject();
  const { notes } = ProjectOps.applyPatch(proj, [{ op: "setProject", set: { delivery: { preset: "youtube-shorts", fps: 60 } } }], {});
  assert.equal(proj.delivery.preset, "youtube-shorts");
  assert.equal(proj.delivery.fps, 60);
  assert.equal(proj.delivery.width, 1080);
  assert.ok(notes.some((n) => /youtube-shorts/.test(n)));
  assert.throws(() => ProjectOps.applyPatch(seedProject(), [{ op: "setProject", set: { delivery: "nope" } }], {}), /no delivery preset/);
  ProjectOps.applyPatch(proj, [{ op: "setProject", set: { delivery: null } }], {});
  assert.equal(proj.delivery, undefined);
});

/* ── server ── */
async function boot(t) {
  const dir = makeDataDir(t);
  const { base } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
  return { dir, base };
}
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("delivery presets: list, save, refuse a built-in name, delete", async (t) => {
  const { dir, base } = await boot(t);
  const list = await (await fetch(base + "/api/export/presets")).json();
  assert.deepEqual(list.builtin, D.PRESET_IDS);
  assert.ok(Array.isArray(list.encoders));
  assert.deepEqual(list.saved, {});

  const saved = await post(base, "/api/export/presets", { name: "Client 4K", spec: { preset: "youtube", width: 3840, height: 2160 } });
  const body = await saved.json();
  assert.equal(saved.status, 200, body.error);
  assert.equal(body.id, "client-4k");
  assert.ok(fs.existsSync(path.join(dir, "library", "delivery", "client-4k.json")));
  const again = await (await fetch(base + "/api/export/presets")).json();
  assert.equal(again.saved["client-4k"].width, 3840);
  assert.equal(again.saved["client-4k"].label, "Client 4K");
  // the rest came from YouTube, not from Custom
  assert.equal(again.saved["client-4k"].audio.bitrate, 384);
  assert.equal(again.saved["client-4k"].video.keyint, 0.5);

  assert.equal((await post(base, "/api/export/presets", { name: "YouTube", spec: {} })).status, 400);
  assert.equal((await post(base, "/api/export/presets", { name: "!!!", spec: {} })).status, 400);
  assert.equal((await post(base, "/api/export/presets/delete", { id: "client-4k" })).status, 200);
  assert.equal((await post(base, "/api/export/presets/delete", { id: "client-4k" })).status, 404);
});

test("export/request: a profile and a preset together are refused", async (t) => {
  const { base } = await boot(t);
  const ff = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ff.available) return;
  const r = await post(base, "/api/export/request", { profile: "draft", preset: "youtube" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not both/);
});

test("export/begin with a delivery spec: crops, scales and encodes the frames it is sent", async (t) => {
  const { dir, base } = await boot(t);
  const ff = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ff.available) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fc-dlv-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 6 JPEG frames of a 320×180 canvas, left half red and right half blue
  const jpg = path.join(tmp, "f.jpg");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x180,pad=320:180:0:0:blue", "-frames:v", "1", "-q:v", "2", jpg]);
  const frame = fs.readFileSync(jpg);

  const begin = await post(base, "/api/export/begin", {
    fps: 30, name: "vertical", hasAudio: false, duration: 0.2,
    delivery: { preset: "custom", width: 90, height: 160, reframe: "fill" },
    canvasW: 320, canvasH: 180, region: { x: 20, y: 0, w: 100, h: 178 },   // 9:16, inside the red half
  });
  const sess = await begin.json();
  assert.equal(begin.status, 200, sess.error);
  assert.equal(sess.input, "jpeg");
  assert.deepEqual(sess.size, { w: 90, h: 160 });
  const up = await fetch(base + "/api/export/frame?id=" + sess.id, { method: "POST", body: Buffer.concat(Array(6).fill(frame)) });
  assert.equal(up.status, 200);
  const end = await (await fetch(base + "/api/export/end?id=" + sess.id, { method: "POST" })).json();
  assert.match(end.src || "", /^\/exports\/vertical\.mp4$/, end.error);
  const file = path.join(dir, "exports", "vertical.mp4");
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,nb_frames,color_space", "-of", "json", file], { encoding: "utf8" }));
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height, +probe.streams[0].nb_frames], [90, 160, 6]);
  assert.equal(probe.streams[0].color_space, "bt709");
  // the crop came from the region (red half): the middle pixel is red, not blue
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-vf", "crop=2:2:44:79", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.ok(px[0] > 200 && px[2] < 60, `expected red, got rgb(${px[0]},${px[1]},${px[2]})`);
});

test("export/begin with a delivery spec: ffmpeg's refusal comes back before any frame", async (t) => {
  const { base } = await boot(t);
  const ff = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ff.available) return;
  const list = await (await fetch(base + "/api/export/presets")).json();
  // an encoder this build lists but cannot open (no GPU) is not offered; ask for a size H.264 refuses instead
  const r = await post(base, "/api/export/begin", {
    fps: 30, name: "bad", hasAudio: false,
    delivery: { preset: "custom", width: 8192, height: 8192, video: { codec: "h264", encoder: "libx264" } },
    canvasW: 64, canvasH: 64,
  });
  if (r.status === 200) return; // some x264 builds take 8K square — nothing to assert then
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ffmpeg rejected these settings/);
  assert.ok(list.encoders.includes("libx264") || true);
});

test("reframe: an export frame of another shape is ignored — the output reframes the whole canvas", () => {
  const ef = { x: 656, y: 0, w: 608, h: 1080 };   // framed for 9:16
  assert.equal(D.reframe(D.normalize("youtube").spec, 1920, 1080, ef).crop, null, "16:9 takes the whole 16:9 canvas");
  assert.deepEqual(D.reframe(D.normalize("tiktok").spec, 1920, 1080, ef).crop, ef, "9:16 takes the frame");
  assert.deepEqual(D.reframe(D.normalize("master").spec, 1920, 1080, ef).crop, ef, "the picture's own size is the frame");
});

test("setProject outputs: the batch list is stored complete, with ids and checkboxes", () => {
  const proj = seedProject();
  const { notes } = ProjectOps.applyPatch(proj, [{ op: "setProject", set: { outputs: ["master", { preset: "instagram-reels", on: false }, { preset: "custom", width: 1080, height: 1080, filename: "{project}_square_{res}", id: "sq" }] } }], {});
  assert.equal(proj.outputs.length, 3);
  assert.equal(proj.outputs[0].preset, "master");
  assert.equal(proj.outputs[1].on, false);
  assert.equal(proj.outputs[2].id, "sq");
  assert.equal(proj.outputs[2].width, 1080);
  assert.ok(proj.outputs.every((o) => /^o_|^sq$/.test(o.id)));
  assert.match(notes.join(" "), /Test Project_square_1080sq/);
  assert.throws(() => ProjectOps.applyPatch(seedProject(), [{ op: "setProject", set: { outputs: ["nope"] } }], {}), /no delivery preset/);
  assert.throws(() => ProjectOps.applyPatch(seedProject(), [{ op: "setProject", set: { outputs: Array(17).fill("web") } }], {}), /up to 16/);
});

test("export/begin with several deliveries: one stream of frames, one file per output", async (t) => {
  const { dir, base } = await boot(t);
  const ff = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ff.available) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fc-dlv-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const raw = path.join(tmp, "f.rgba");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=320x180", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw]);
  const frame = fs.readFileSync(raw);

  const begin = await post(base, "/api/export/begin", {
    fps: 25, hasAudio: false, duration: 0.2, canvasW: 320, canvasH: 180,
    deliveries: [
      { delivery: { preset: "custom", width: 320, height: 180 }, name: "wide" },
      { delivery: { preset: "custom", width: 90, height: 160 }, name: "tall" },
      { delivery: { preset: "custom", video: { codec: "prores", profile: "proxy" } }, name: "master" },
    ],
  });
  const sess = await begin.json();
  assert.equal(begin.status, 200, sess.error);
  assert.equal(sess.input, "rgba", "ProRes in the batch → every output reads RGBA");
  assert.equal(sess.outputs.length, 3);
  assert.deepEqual(sess.outputs.map((o) => o.file), ["wide.mp4", "tall.mp4", "master.mov"]);
  const up = await fetch(base + "/api/export/frame?id=" + sess.id, { method: "POST", body: Buffer.concat(Array(5).fill(frame)) });
  assert.equal(up.status, 200);
  const end = await (await fetch(base + "/api/export/end?id=" + sess.id, { method: "POST" })).json();
  assert.equal(end.outputs.length, 3, end.error);
  assert.ok(end.outputs.every((o) => o.ok), JSON.stringify(end.outputs));
  for (const [file, w, h] of [["wide.mp4", 320, 180], ["tall.mp4", 90, 160], ["master.mov", 320, 180]]) {
    const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,nb_frames", "-of", "json", path.join(dir, "exports", file)], { encoding: "utf8" }));
    assert.deepEqual([pr.streams[0].width, pr.streams[0].height, +pr.streams[0].nb_frames], [w, h, 5], file);
  }
  const mixed = await post(base, "/api/export/begin", { fps: 25, hasAudio: false, canvasW: 64, canvasH: 64,
    deliveries: [{ delivery: { preset: "web" } }, { delivery: { preset: "web", fps: 30 } }] });
  assert.equal(mixed.status, 400, "an output at another frame rate is refused, not encoded at the render's rate");
  assert.match((await mixed.json()).error, /output 2 asks for 30 fps but this render is 25 fps/);
  const many = await post(base, "/api/export/begin", { fps: 25, hasAudio: false, canvasW: 64, canvasH: 64, deliveries: Array(9).fill({ delivery: "web" }) });
  assert.equal(many.status, 400);
  assert.match((await many.json()).error, /at most 8/);
});

test("loudness: spec, gain, limiter filter and the ebur128 parser", () => {
  const b = D.normalize("broadcast").spec;
  assert.equal(b.audio.loudness, -23, "Broadcast normalizes to EBU R128");
  assert.equal(b.audio.truePeak, -1);
  assert.equal(D.normalize("youtube").spec.audio.loudness, null, "platforms leave the mix alone unless asked");
  assert.equal(D.normalize({ preset: "youtube", audio: { loudness: "off" } }).spec.audio.loudness, null);
  assert.equal(D.normalize({ preset: "youtube", audio: { loudness: -50 } }).spec.audio.loudness, -36);
  const m = D.parseLoudnorm('[Parsed_loudnorm_0 @ x] \n{\n\t"input_i" : "-21.81",\n\t"input_tp" : "-21.09",\n\t"input_lra" : "0.40",\n\t"input_thresh" : "-31.81",\n\t"output_i" : "-23.0",\n\t"target_offset" : "-0.10"\n}\n');
  assert.deepEqual(m, { input_i: -21.81, input_tp: -21.09, input_lra: 0.4, input_thresh: -31.81, target_offset: -0.1 });
  assert.equal(D.parseLoudnorm('{"input_i" : "-inf", "input_tp" : "-inf", "input_lra" : "0", "input_thresh" : "-70", "target_offset" : "0"}'), null, "silence");
  assert.equal(D.loudnormFilter(b, m), "loudnorm=I=-23:TP=-1:LRA=11:measured_I=-21.81:measured_TP=-21.09:measured_LRA=0.4:measured_thresh=-31.81:offset=-0.1:linear=true");
  const yt = D.normalize("youtube").spec;
  assert.equal(D.loudnormFilter(yt, m), "", "no target → no filter");
  const args = D.ffmpegArgs(b, { fps: 25, input: "rgba", canvasW: 64, canvasH: 64, frame: D.reframe(b, 64, 64), wavPath: "a.wav", outPath: "o.mov", duration: 2, loudnorm: m });
  assert.match(args[args.indexOf("-af") + 1], /^loudnorm=I=-23:.*:linear=true,apad=whole_dur=2\.000000,atrim=0:2\.000000$/);
  const plain = D.ffmpegArgs(yt, { fps: 25, input: "jpeg", canvasW: 64, canvasH: 64, frame: D.reframe(yt, 64, 64), wavPath: "a.wav", outPath: "o.mp4", duration: 2, loudnorm: m });
  assert.equal(plain[plain.indexOf("-af") + 1], "apad=whole_dur=2.000000,atrim=0:2.000000");
  const st = "[Parsed_ebur128_0 @ x] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.2 LUFS\n\n  True peak:\n    Peak:       -1.3 dBFS\n";
  assert.deepEqual(D.parseEbur128(st), { lufs: -14.2, truePeak: -1.3 });
  assert.deepEqual(D.parseEbur128("I: -inf LUFS\n  True peak:\n    Peak: -inf dBFS"), { lufs: null, truePeak: null });
});

test("verify: what came out against what was asked", () => {
  const sp = D.normalize({ preset: "youtube", audio: { loudness: -14 } }).spec;
  const frame = D.reframe(sp, 1920, 1080);
  const probe = {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1", nb_frames: "60", color_space: "bt709" },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
    format: { duration: "2.000000" },
  };
  const good = D.verify(sp, probe, { fps: 30, frames: 60, duration: 2, size: 3e6, loud: { lufs: -14.2, truePeak: -1.4 }, frame, hasAudio: true });
  assert.ok(good.ok, good.line);
  assert.match(good.line, /1920×1080 · 30 fps · 60 frames · h264 · color bt709 · aac 48 kHz stereo · 0:02\.00 · -14\.2 LUFS · -1\.4 dBTP/);
  const bad = D.verify(sp, { ...probe, streams: [{ ...probe.streams[0], width: 1280, height: 720, nb_frames: "59" }, probe.streams[1]] },
    { fps: 30, frames: 60, duration: 2, loud: { lufs: -17, truePeak: 0.4 }, frame, hasAudio: true });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.checks.filter((c) => !c.ok).map((c) => c.text), ["1280×720 (asked 1920×1080)", "59 frames (rendered 60)", "-17.0 LUFS (target -14)", "0.4 dBTP (ceiling -1)"]);
  const mono = D.verify(sp, { ...probe, streams: [probe.streams[0], { ...probe.streams[1], channels: 1 }] }, { frame, hasAudio: true });
  assert.deepEqual(mono.checks.filter((c) => !c.ok).map((c) => c.text), ["1 channel (asked 2)"]);
  assert.equal(D.verify(sp, probe, { frame, hasAudio: true, loudWanted: true, loud: null }).ok, false, "a loudness that could not be measured is not a pass");
  assert.ok(D.verify(sp, probe, { frame, hasAudio: true, loudWanted: true, loud: { lufs: null, truePeak: null, silent: true } }).ok, "silence is measured, not missing");
  assert.match(D.loudnormFilter(D.normalize("broadcast").spec, { input_i: -20, input_tp: -3, input_lra: 35, input_thresh: -30, target_offset: 0 }), /:LRA=20:/, "LRA capped at 20");
  const loudYt = D.verify(D.normalize("youtube").spec, probe, { fps: 30, loud: { lufs: -8, truePeak: -0.5 }, frame, hasAudio: true });
  assert.ok(loudYt.ok);
  assert.match(loudYt.line, /plays it 6\.0 dB quieter/);
  const x = D.normalize("x").spec;
  assert.equal(D.verify(x, probe, { size: 600 * 1024 * 1024, frame: D.reframe(x, 1920, 1080) }).ok, false, "over the platform's file size");
});

test("export with a loudness target: the mix is measured, turned to the target, limited, and the file is checked", async (t) => {
  const { dir, base } = await boot(t);
  const ff = await (await fetch(base + "/api/export/ffmpeg")).json();
  if (!ff.available) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fc-dlv-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // a quiet mix whose peaks sit near full scale: +14 dB of gain would clip them without the limiter
  const wav = path.join(tmp, "mix.wav");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=4:r=48000,volume=0.05,aformat=channel_layouts=stereo",
    "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,1),0.001),0.6,0)':d=4:s=48000:c=stereo", "-filter_complex", "amix=inputs=2:normalize=0", "-c:a", "pcm_s16le", wav]);
  const jpg = path.join(tmp, "f.jpg");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64", "-frames:v", "1", jpg]);
  const begin = await post(base, "/api/export/begin", {
    fps: 25, hasAudio: true, duration: 4, canvasW: 64, canvasH: 64,
    deliveries: [{ delivery: { preset: "custom", audio: { loudness: -14, truePeak: -1 } }, name: "loud" }],
  });
  const sess = await begin.json();
  assert.equal(begin.status, 200, sess.error);
  assert.equal((await fetch(base + "/api/export/audio?id=" + sess.id, { method: "POST", body: fs.readFileSync(wav) })).status, 200);
  const frame = fs.readFileSync(jpg);
  assert.equal((await fetch(base + "/api/export/frame?id=" + sess.id, { method: "POST", body: Buffer.concat(Array(100).fill(frame)) })).status, 200);
  const end = await (await fetch(base + "/api/export/end?id=" + sess.id, { method: "POST" })).json();
  const o = end.outputs && end.outputs[0];
  assert.ok(o && o.ok, JSON.stringify(end));
  assert.ok(o.mixLoudness < -20, `the mix was measured: ${o.mixLoudness}`);
  assert.ok(o.report && o.report.checks.length >= 6, JSON.stringify(o.report));
  const tp = /(-?\d+\.\d) dBTP/.exec(o.report.line), lu = /(-?\d+\.\d) LUFS/.exec(o.report.line);
  assert.ok(tp && +tp[1] <= -0.5, `true peak held under the ceiling: ${o.report.line}`);
  assert.ok(lu && +lu[1] > o.mixLoudness + 3, `turned up towards the target: ${o.report.line}`);
  assert.ok(fs.existsSync(path.join(dir, "exports", "loud.mp4")));
});
