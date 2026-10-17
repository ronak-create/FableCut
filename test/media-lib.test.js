/* media-lib.js (Project-bin metadata, search, filters, sorting, tags,
   collections, usage) and the agent ops built on it (updateMedia,
   setCollection, removeCollection, the compact view). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../media-lib");
const ProjectOps = require("../project-ops");

const PROBE = {
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" },
    { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
  ],
  format: { duration: "12.345678", size: "45200000", bit_rate: "29300000" },
};

test("parseProbe reads frame rate, codecs, channels, size and bitrate", () => {
  const i = M.parseProbe(PROBE, 1);
  assert.deepEqual(i, {
    size: 45200000, duration: 12.346, bitrate: 29300000, codec: "h264", width: 1920, height: 1080,
    fps: 29.97, audioCodec: "aac", audioChannels: 2, sampleRate: 48000,
  });
});

test("parseProbe: rotated phone footage swaps width and height; stills have no fps; silent video has 0 channels", () => {
  const rot = M.parseProbe({ streams: [{ codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, avg_frame_rate: "60/1", side_data_list: [{ rotation: -90 }] }], format: {} }, 10);
  assert.equal(rot.width, 1080); assert.equal(rot.height, 1920);
  assert.equal(rot.audioChannels, 0, "a video without an audio stream says so");
  assert.equal(rot.size, 10, "the stat size fills in when the format has none");
  const png = M.parseProbe({ streams: [{ codec_type: "video", codec_name: "png", width: 800, height: 600, avg_frame_rate: "25/1" }], format: {} });
  assert.equal(png.fps, undefined);
  assert.equal(png.codec, "png");
  assert.equal(png.audioChannels, undefined, "a picture has no audio to report");
  const cover = M.parseProbe({ streams: [{ codec_type: "audio", codec_name: "mp3", channels: 1 }, { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }], format: {} });
  assert.equal(cover.codec, undefined, "album art is not the picture");
  assert.equal(cover.audioChannels, 1);
});

test("formatting helpers", () => {
  assert.equal(M.fmtSize(45200000), "45 MB");
  assert.equal(M.fmtSize(1530), "1.5 KB");
  assert.equal(M.fmtSize(0), "");
  assert.equal(M.fmtFps(29.97), "29.97");
  assert.equal(M.fmtFps(23.976), "23.98");
  assert.equal(M.fmtAudio({ audioChannels: 2, sampleRate: 48000 }), "stereo 48 kHz");
  assert.equal(M.fmtAudio({ audioChannels: 6 }), "5.1");
  assert.equal(M.fmtAudio({ audioChannels: 0 }), "no audio");
  assert.equal(M.fmtDur(75.5), "1:15.50");
  assert.equal(M.fmtDur(3725), "1:02:05.00");
  assert.equal(M.describe({ width: 1920, height: 1080, fps: 25, codec: "h264", audioChannels: 1, size: 2e6 }), "1920×1080 · 25 fps · h264 · mono · 2.0 MB");
});

test("normalizeTags trims, drops '#', dedupes case-insensitively and caps the list", () => {
  assert.deepEqual(M.normalizeTags(["#Interview", " interview ", "B-roll", "", null]), ["Interview", "B-roll"]);
  assert.deepEqual(M.normalizeTags("a, b ,a"), ["a", "b"]);
  assert.equal(M.normalizeTags(Array.from({ length: 40 }, (_, i) => "t" + i)).length, M.MAX_TAGS);
  assert.deepEqual(M.allTags([{ tags: ["b", "A"] }, { tags: ["a", "c"] }]), ["A", "b", "c"]);
});

test("normalizeCollections drops unknown media, duplicates and broken entries", () => {
  const out = M.normalizeCollections([{ id: "c1", name: " Selects ", media: ["m1", "m1", "gone"] }, { id: "c1" }, null, { name: "no id" }], [{ id: "m1" }]);
  assert.deepEqual(out, [{ id: "c1", name: "Selects", media: ["m1"] }]);
});

const DOC = () => ({
  media: [
    { id: "m1", name: "Interview A.mp4", kind: "video", duration: 60, width: 3840, height: 2160, fps: 25, codec: "hevc", size: 900e6, tags: ["interview"], favorite: true },
    { id: "m2", name: "broll 2.mov", kind: "video", duration: 8, width: 1920, height: 1080, fps: 59.94, codec: "prores", size: 400e6 },
    { id: "m3", name: "music.wav", kind: "audio", duration: 180, audioChannels: 2, size: 30e6, tags: ["Music"] },
    { id: "m4", name: "logo.png", kind: "image", width: 512, height: 512, size: 20e3 },
    { id: "m10", name: "broll 10.mov", kind: "video", duration: 3 },
  ],
  clips: [
    { id: "v1", mediaId: "m1", kind: "video", track: "V1", start: 0, duration: 5, linkGroup: "g1" },
    { id: "a1", mediaId: "m1", kind: "audio", track: "A1", start: 0, duration: 5, linkGroup: "g1" },
    { id: "a2", mediaId: "m1", kind: "audio", track: "A2", start: 0, duration: 5, linkGroup: "g1" },
    { id: "v2", mediaId: "m1", kind: "video", track: "V1", start: 10, duration: 4 },
    { id: "s1", mediaId: "m3", kind: "audio", track: "A3", start: 0, duration: 30 },
  ],
  comps: [{ id: "cp", name: "Lower third", clips: [{ id: "x1", mediaId: "m4", kind: "image", track: "V1", start: 1, duration: 2 }] }],
  collections: [{ id: "col1", name: "Selects", media: ["m2", "m4"] }],
});

test("usage: a video and its linked stems count once; comps count too", () => {
  const u = M.usageCounts(DOC());
  assert.equal(u.get("m1"), 2);
  assert.equal(u.get("m2"), 0);
  assert.equal(u.get("m3"), 1);
  assert.equal(u.get("m4"), 1);
  const p = M.placements(DOC(), "m1");
  assert.deepEqual(p.map((x) => [x.clipId, x.comp, x.start]), [["v1", null, 0], ["v2", null, 10]], "the picture stands for the placement");
  const inComp = M.placements(DOC(), "m4");
  assert.deepEqual(inComp.map((x) => [x.clipId, x.comp, x.compName]), [["x1", "cp", "Lower third"]]);
});

test("search: words match name, kind, extension, codec, resolution or tags; #word matches tags only", () => {
  const names = (q) => DOC().media.filter((m) => M.matchesQuery(m, q)).map((m) => m.id);
  assert.deepEqual(names("broll"), ["m2", "m10"]);
  assert.deepEqual(names("mov prores"), ["m2"]);
  assert.deepEqual(names("2160p"), ["m1"]);
  assert.deepEqual(names("3840x2160"), ["m1"]);
  assert.deepEqual(names("#music"), ["m3"]);
  assert.deepEqual(names("#interview"), ["m1"]);
  assert.deepEqual(names("interview"), ["m1"], "plain words match tags too");
  assert.deepEqual(names("audio"), ["m3"]);
  assert.deepEqual(names(""), ["m1", "m2", "m3", "m4", "m10"]);
});

test("filters: favorites, used / unused, kind, tag, collection", () => {
  const doc = DOC();
  const ctx = { usage: M.usageCounts(doc), collections: doc.collections };
  const ids = (filter) => M.query(doc.media, { filter }, ctx).map((m) => m.id);
  assert.deepEqual(ids("fav"), ["m1"]);
  assert.deepEqual(ids("used"), ["m1", "m4", "m3"].sort((a, b) => doc.media.find((m) => m.id === a).name.localeCompare(doc.media.find((m) => m.id === b).name)));
  assert.deepEqual(ids("unused"), ["m2", "m10"]);
  assert.deepEqual(ids("kind:audio"), ["m3"]);
  assert.deepEqual(ids("tag:music"), ["m3"]);
  assert.deepEqual(ids("col:col1"), ["m2", "m4"]);
  assert.deepEqual(ids("col:missing"), []);
});

test("sorting: numeric names, metadata keys, missing values last in both directions", () => {
  const doc = DOC();
  const ctx = { usage: M.usageCounts(doc) };
  const ids = (sort, dir) => M.sortMedia(doc.media, sort, dir, ctx).map((m) => m.id);
  assert.deepEqual(ids("name", "asc"), ["m2", "m10", "m1", "m4", "m3"], "broll 2 before broll 10");
  assert.deepEqual(ids("resolution", "desc"), ["m1", "m2", "m4", "m10", "m3"]);
  assert.deepEqual(ids("fps", "asc"), ["m1", "m2", "m10", "m4", "m3"]);
  assert.deepEqual(ids("fps", "desc").slice(0, 2), ["m2", "m1"]);
  assert.deepEqual(ids("size", "desc"), ["m1", "m2", "m3", "m4", "m10"]);
  assert.deepEqual(ids("usage", "desc").slice(0, 1), ["m1"]);
  assert.deepEqual(ids("duration", "asc"), ["m10", "m2", "m1", "m3", "m4"]);
});

const patch = (doc, ops) => { ProjectOps.applyPatch(doc, ops, {}); return doc; };

test("updateMedia sets favorite, tags and folder; refuses metadata and unknown ids", () => {
  const doc = { ...DOC(), folders: [{ id: "f1", name: "B-roll", parentId: null }] };
  patch(doc, [{ op: "updateMedia", ids: ["m2", "m10"], set: { favorite: true, folderId: "f1" }, addTags: ["b-roll", "#Day 1"] }]);
  const m2 = doc.media.find((m) => m.id === "m2");
  assert.equal(m2.favorite, true);
  assert.equal(m2.folderId, "f1");
  assert.deepEqual(m2.tags, ["b-roll", "Day 1"]);
  patch(doc, [{ op: "updateMedia", id: "m2", set: { favorite: false }, removeTags: ["B-ROLL"] }]);
  assert.equal(m2.favorite, undefined);
  assert.deepEqual(m2.tags, ["Day 1"]);
  patch(doc, [{ op: "updateMedia", id: "m2", set: { tags: [] } }]);
  assert.equal(m2.tags, undefined, "an empty tag list is dropped");
  assert.throws(() => patch(doc, [{ op: "updateMedia", id: "m2", set: { fps: 24 } }]), /not settable.*probed/);
  assert.throws(() => patch(doc, [{ op: "updateMedia", id: "nope", set: { favorite: true } }]), /no media nope/);
  assert.throws(() => patch(doc, [{ op: "updateMedia", id: "m2", set: { folderId: "f9" } }]), /no folder f9/);
});

test("setCollection creates, adds, removes and renames; removeCollection deletes; removeMedia leaves collections clean", () => {
  const doc = DOC();
  const r = ProjectOps.applyPatch(doc, [{ op: "setCollection", id: "keep", name: "Keepers", media: ["m1"] }, { op: "setCollection", id: "keep", add: ["m2"], remove: ["m1"] }], {});
  assert.deepEqual(r.notes, ["+keep(1)", "~keep(1)"]);
  assert.deepEqual(doc.collections.find((c) => c.id === "keep"), { id: "keep", name: "Keepers", media: ["m2"] });
  patch(doc, [{ op: "setCollection", name: "selects", add: ["m10"] }]);
  assert.deepEqual(doc.collections.find((c) => c.id === "col1").media, ["m2", "m4", "m10"], "a known name finds the collection");
  assert.throws(() => patch(doc, [{ op: "setCollection", id: "new" }]), /needs a name/);
  assert.throws(() => patch(doc, [{ op: "setCollection", id: "keep", add: ["zz"] }]), /no media zz/);
  patch(doc, [{ op: "removeMedia", id: "m2" }]);
  assert.deepEqual(doc.collections.find((c) => c.id === "keep").media, []);
  patch(doc, [{ op: "removeCollection", id: "keep" }]);
  assert.equal(doc.collections.some((c) => c.id === "keep"), false);
  assert.throws(() => patch(doc, [{ op: "removeCollection", id: "keep" }]), /no collection keep/);
});

test("the compact view shows metadata, favorites, tags, usage and collections", () => {
  const doc = { name: "P", width: 1280, height: 720, fps: 30, revision: 3, ...DOC() };
  const text = ProjectOps.compactView(doc);
  assert.match(text, /m1 video "Interview A\.mp4" 60s 3840×2160 25 fps hevc 900 MB ★ #interview uses:2/);
  assert.match(text, /m2 video "broll 2\.mov" 8s 1920×1080 59\.94 fps prores 400 MB uses:0/);
  assert.match(text, /COLLECTIONS \(1\): col1 "Selects" \[m2,m4\]/);
});

test("checkProject normalizes tags, favorites and collections", () => {
  const doc = { ...DOC(), comps: [], revision: 1 };
  doc.media[1].tags = ["#x", "X", ""];
  doc.media[1].favorite = "yes";
  doc.collections.push({ id: "bad", media: ["ghost"] });
  ProjectOps.checkProject(doc);
  assert.deepEqual(doc.media[1].tags, ["x"]);
  assert.equal(doc.media[1].favorite, undefined);
  assert.deepEqual(doc.collections.find((c) => c.id === "bad"), { id: "bad", name: "Collection", media: [] });
});
