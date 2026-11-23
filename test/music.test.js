/* Music search (music.js, the bin's Music tab, fablecut_music): openly licensed
   tracks from Openverse, each with its licence spelled out, imported with that
   licence kept on the media entry so the edit's credits can be listed. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const M = require("../music");
const ProjectOps = require("../project-ops");
const MediaLib = require("../media-lib");
const { makeDataDir, seedProject, readProject, startMcp } = require("./helpers");

const result = (over = {}) => ({
  id: "c14c7353-1688-4204-9af0-64c0a5e8ccc3", title: "Night &amp; Day", creator: "Jahzzar",
  license: "by-sa", license_version: "3.0", license_url: "https://creativecommons.org/licenses/by-sa/3.0/",
  url: "https://prod-1.storage.jamendo.com/?trackid=918921&format=mp32", foreign_landing_url: "https://www.jamendo.com/track/918921",
  source: "jamendo", filetype: "mp32", duration: 169480, genres: ["ambient"], tags: [{ name: "calm" }],
  ...over,
});

test("licences say what a video editor may do with a track", () => {
  const by = M.licence("by", "4.0");
  assert.equal(by.label, "CC BY 4.0");
  assert.deepEqual(M.flags(by), ["credit"]);
  assert.deepEqual(M.flags(M.licence("cc0", "1.0")), ["free to use"]);
  assert.equal(M.licence("cc0", "1.0").label, "CC0", "no version on CC0");
  assert.deepEqual(M.flags(M.licence("by-nc-nd")), ["credit", "non-commercial", "no edits"]);
  assert.deepEqual(M.flags(M.licence("by-sa")), ["credit", "share alike"]);
  assert.equal(M.licence("by-nd").edits, false, "music set to video is a derivative");
  assert.deepEqual(M.flags(M.licence("sampling+", "1.0")), ["credit", "non-commercial", "samples only"]);
  assert.deepEqual(M.warnings(M.licence("nc-sampling+", "1.0")),
    ["NC Sampling+ 1.0 allows only sampled, transformed parts — not the whole track under a video", "NC Sampling+ 1.0 is non-commercial only"]);
  const odd = M.licence("mystery");
  assert.equal(odd.commercial, false);
  assert.match(odd.note, /unknown licence/);
});

test("searchUrl builds the Openverse query", () => {
  const u = new URL(M.searchUrl({ query: " chill lo-fi ", length: "short", commercial: true, edits: true, page: 3 }));
  assert.equal(u.origin + u.pathname, M.API);
  assert.equal(u.searchParams.get("q"), "chill lo-fi");
  assert.equal(u.searchParams.get("category"), "music");
  assert.equal(u.searchParams.get("length"), "short");
  assert.equal(u.searchParams.get("license"), "cc0,pdm,by,by-sa", "FableCut's own table, never Openverse's commercial group (it has Sampling+)");
  assert.equal(u.searchParams.get("license_type"), null);
  assert.equal(new URL(M.searchUrl({ commercial: true })).searchParams.get("license"), "cc0,pdm,by,by-sa,by-nd");
  assert.equal(new URL(M.searchUrl({ edits: true })).searchParams.get("license"), "cc0,pdm,by,by-sa,by-nc,by-nc-sa",
    "edits = may go under a video: no ND, no Sampling");
  assert.equal(new URL(M.searchUrl({ commercial: true, licenses: ["by-nc", "by", "sampling+"] })).searchParams.get("license"), "by", "a choice is narrowed, never widened");
  assert.throws(() => M.searchUrl({ commercial: true, licenses: ["by-nc", "sampling+"] }), /none of those licences allow commercial use/);
  assert.equal(u.searchParams.get("page_size"), "20");
  assert.equal(u.searchParams.get("page"), "3");
  assert.equal(u.searchParams.get("mature"), "false");
  const sfx = new URL(M.searchUrl({ query: "whoosh", kind: "sfx", length: "nope", page: 99, licenses: ["cc0", "junk"] }));
  assert.equal(sfx.searchParams.get("source"), "freesound", "Freesound sounds have no category in Openverse");
  assert.equal(sfx.searchParams.get("category"), null);
  assert.equal(sfx.searchParams.get("length"), null, "an unknown length is left out");
  assert.equal(sfx.searchParams.get("page"), "12", "anonymous search goes 12 pages deep");
  assert.equal(sfx.searchParams.get("license"), "cc0");
  const newest = new URL(M.searchUrl({}));
  assert.equal(newest.searchParams.get("q"), null);
  assert.equal(newest.searchParams.get("unstable__sort_by"), "indexed_on");
  assert.equal(M.searchUrl({ query: "x".repeat(300) }).match(/q=(x+)/)[1].length, 200);
  assert.throws(() => M.trackUrl("../etc"), /not an Openverse track id/);
});

test("results become plain tracks", () => {
  const t = M.track(result());
  assert.equal(t.title, "Night & Day", "HTML entities are decoded");
  assert.equal(t.duration, 169.5);
  assert.equal(t.license.label, "CC BY-SA 3.0");
  assert.deepEqual(t.tags, ["calm"]);
  assert.equal(M.fileName(t), "Night Day - Jahzzar.mp3", "mp32 is an mp3");
  assert.equal(M.fileName({ ...t, filetype: "oga" }), "Night Day - Jahzzar.ogg");
  assert.equal(M.fmtLen(59.7), "1:00");
  assert.equal(M.fmtLen(0.43), "0.4 s");
  const r = M.results({ result_count: 999, page_count: 50, results: [result(), result({ url: "" })] }, 2);
  assert.equal(r.tracks.length, 1, "a result without a file is dropped");
  const bad = M.track(result({ foreign_landing_url: "javascript:alert(1)", license_url: "data:text/html,x", url: "file:///etc/passwd" }));
  assert.equal(bad.page, "", "only http(s) links reach an href");
  assert.equal(bad.license.url, "");
  assert.equal(bad.url, "");
  assert.equal(r.pages, 12);
  assert.equal(r.page, 2);
});

test("a media entry keeps its licence, and the edit lists its credits", () => {
  const lic = M.mediaLicense(M.track(result()));
  const kept = M.cleanLicense({ ...lic, extra: { a: 1 }, title: 5 });
  assert.equal(kept.code, "by-sa");
  assert.equal(kept.title, undefined, "only text fields are kept");
  assert.equal(kept.extra, undefined, "unknown keys are dropped");
  assert.equal(M.cleanLicense({ label: "x" }), null, "no code, no licence");
  const long = "https://example.com/" + "a".repeat(600);
  assert.equal(M.cleanLicense({ ...lic, page: long }).page, long, "a link is kept whole");
  assert.equal(M.cleanLicense({ ...lic, page: "https://e.com/" + "a".repeat(2100) }).page, undefined, "or not at all");
  assert.equal(M.cleanLicense({ ...lic, url: "javascript:x" }).url, undefined);
  assert.equal(M.cleanLicense("CC BY"), null);
  const doc = seedProject({
    media: [
      { id: "m_song", name: "song", kind: "audio", src: "/media/s.mp3", license: lic },
      { id: "m_den", name: "song (denoised)", kind: "audio", src: "/media/s.flac", derivedFrom: "m_song", denoise: "medium" },
      { id: "m_fx", name: "fx", kind: "audio", src: "/media/fx.mp3", license: M.mediaLicense(M.track(result({ id: "eab8a6e2-0ac8-4615-9e0d-ebde30523783", license: "cc0", license_version: "1.0", title: "Whoosh" }))) },
      { id: "m_nd", name: "nd", kind: "audio", src: "/media/nd.mp3", license: M.mediaLicense(M.track(result({ id: "bb6de945-d963-4f8e-9c60-3a786fa9aab2", license: "by-nc-nd" }))) },
    ],
    clips: [
      { id: "c1", mediaId: "m_den", kind: "audio", track: "A1", start: 0, in: 0, duration: 5 },
      { id: "c2", mediaId: "m_song", kind: "audio", track: "A2", start: 0, in: 0, duration: 5 },
      { id: "c3", mediaId: "m_fx", kind: "audio", track: "A3", start: 1, in: 0, duration: 1 },
    ],
  });
  const list = M.credits(doc, MediaLib.usageCounts(doc));
  assert.equal(list.length, 2, "the denoised copy is the same song; the unused ND track isn't listed");
  assert.equal(list[0].mediaId, "m_song");
  assert.match(list[0].line, /^"Night & Day" by Jahzzar \(jamendo\) — CC BY-SA 3\.0 \(https:\/\/creativecommons\.org\/licenses\/by-sa\/3\.0\/\) — https:\/\/www\.jamendo\.com\/track\/918921 — changed: noise reduced$/,
    "the edit plays a denoised copy, so the credit says it was changed");
  assert.deepEqual(list[0].changes, ["noise reduced"]);
  assert.deepEqual(list[0].warnings, ["CC BY-SA: share the video under the same licence"]);
  assert.equal(list[1].needsCredit, false, "CC0 needs no credit");
  doc.clips.push({ id: "c4", mediaId: "m_nd", kind: "audio", track: "A4", start: 0, in: 0, duration: 2 });
  const nd = M.credits(doc, MediaLib.usageCounts(doc)).find((c) => c.mediaId === "m_nd");
  assert.deepEqual(nd.warnings, ["CC BY-NC-ND allows no derivatives — music set to video counts as one", "CC BY-NC-ND is non-commercial only"]);
  assert.match(ProjectOps.compactView(doc), /m_song audio "song".* licence:"CC BY-SA 3\.0"/);

  // the edit's own usage: the open sequence and the comps it places, not other sequences or unplaced comps
  const scoped = seedProject({
    media: [{ id: "m_s", name: "s", kind: "audio", src: "/media/s.mp3", license: lic }, { id: "m_o", name: "o", kind: "audio", src: "/media/o.mp3", license: { ...lic, openverse: "x" } },
      { id: "m_u", name: "u", kind: "audio", src: "/media/u.mp3", license: { ...lic, openverse: "y" } }],
    clips: [{ id: "cc", kind: "comp", compId: "k1", track: "V1", start: 0, in: 0, duration: 2 }],
    comps: [{ id: "k1", name: "K", duration: 2, clips: [{ id: "ka", mediaId: "m_s", kind: "audio", track: "A1", start: 0, in: 0, duration: 2 }] },
      { id: "k2", name: "unused", duration: 2, clips: [{ id: "kb", mediaId: "m_u", kind: "audio", track: "A1", start: 0, in: 0, duration: 2 }] }],
    sequence: "main", sequences: [{ id: "main", name: "Main" }, { id: "s2", name: "Other", clips: [{ id: "oc", mediaId: "m_o", kind: "audio", track: "A1", start: 0, in: 0, duration: 2 }] }],
  });
  assert.deepEqual([...M.editUsage(scoped)], [["m_s", 1]]);
  assert.deepEqual(M.credits(scoped, M.editUsage(scoped)).map((c) => c.mediaId), ["m_s"]);
});

/* A stand-in for the Openverse API on 127.0.0.1, serving one track and its file. */
async function fakeOpenverse(t, { limited = false } = {}) {
  const wav = Buffer.alloc(44 + 8000);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + 8000, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36); wav.writeUInt32LE(8000, 40);
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const track = result({ url: base + "/file.wav", filetype: "wav", duration: 1000 });
    if (limited) { res.writeHead(429, { "Content-Type": "application/json" }); return res.end("{}"); }
    if (req.url === "/file.wav") { res.writeHead(200, { "Content-Type": "audio/wav" }); return res.end(wav); }
    if (req.url.startsWith("/v1/audio/?")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ result_count: 1, page_count: 1, results: [track] })); }
    if (req.url === `/v1/audio/${track.id}/`) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(track)); }
    if (req.url === "/v1/audio/bb6de945-d963-4f8e-9c60-3a786fa9aab2/") {   // a no-derivatives track
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ...track, id: "bb6de945-d963-4f8e-9c60-3a786fa9aab2", title: "Golden Peaks", license: "by-nc-nd" }));
    }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/v1/audio/`, seen };
}

test("fablecut_music searches, imports a track with its licence, and lists the credits", async (t) => {
  const ov = await fakeOpenverse(t);
  const dir = makeDataDir(t);
  const mcp = startMcp(t, dir, { FABLECUT_NO_AUTOSTART: "1", FABLECUT_TEST_OPENVERSE: ov.url });
  const text = async (args) => { const r = await mcp.callTool("fablecut_music", args); return (r.isError ? "ERROR " : "") + r.content[0].text; };

  const found = await text({ query: "calm night", commercial: true });
  assert.match(found, /^1 result\(s\), page 1\/1 for "calm night"/);
  assert.match(found, /1\. c14c7353-1688-4204-9af0-64c0a5e8ccc3 "Night & Day" — Jahzzar · 1 s · CC BY-SA 3\.0 \[credit, share alike\] · ambient · jamendo/);
  assert.match(found, /made with Openverse, not endorsed/);
  assert.match(ov.seen[0], /q=calm\+night&category=music&license=cc0%2Cpdm%2Cby%2Cby-sa%2Cby-nd/);
  assert.match(await text({ page: 0 }), /ERROR .*page is 1–12/);

  const got = await text({ import: "c14c7353-1688-4204-9af0-64c0a5e8ccc3" });
  assert.match(got, /^Imported "Night & Day" by Jahzzar → (m_\w+)/);
  assert.match(got, /Licence: CC BY-SA 3\.0 — any use, credit the artist; the video must be shared under CC BY-SA too\./);
  const doc = readProject(dir);
  const m = doc.media.find((x) => x.license);
  assert.equal(m.name, "Night & Day — Jahzzar");
  assert.equal(m.src, "/media/Night%20Day%20-%20Jahzzar.wav", "named after the track, with the served file's extension");
  assert.ok(fs.existsSync(path.join(dir, "media", "Night Day - Jahzzar.wav")));
  assert.equal(m.license.openverse, "c14c7353-1688-4204-9af0-64c0a5e8ccc3");

  assert.match(await text({ credits: true }), /no credits to list/, "imported but not used yet");
  await mcp.callTool("fablecut_patch_project", { ops: [{ op: "addClip", clip: { mediaId: m.id, kind: "audio", track: "A1", start: 0, in: 0, duration: 1 } }] });
  const credits = await text({ credits: true });
  assert.match(credits, /^CREDITS — licensed music in this edit/);
  assert.match(credits, /"Night & Day" by Jahzzar \(jamendo\) — CC BY-SA 3\.0/);
  assert.match(credits, /⚠ CC BY-SA: share the video under the same licence/);

  const nd = await text({ import: "bb6de945-d963-4f8e-9c60-3a786fa9aab2" });
  assert.match(nd, /^Imported "Golden Peaks"/);
  assert.match(nd, /⚠ CC BY-NC-ND 3\.0 allows no derivatives/);
  assert.match(nd, /Don't set this track under the video as it is/);
  assert.doesNotMatch(nd, /Place it/, "no placement recipe for a track that can't go under video");

  // a file replaced by another one loses the old track's licence; a relink keeps it
  const before = readProject(dir).media.find((x) => x.id === m.id);
  fs.copyFileSync(path.join(dir, "media", "Night Day - Jahzzar.wav"), path.join(dir, "media", "other.wav"));
  await mcp.callTool("fablecut_patch_project", { ops: [{ op: "relinkMedia", id: m.id, src: "/media/other.wav" }] });
  assert.deepEqual(readProject(dir).media.find((x) => x.id === m.id).license, before.license);
  await mcp.callTool("fablecut_patch_project", { ops: [{ op: "replaceMedia", id: m.id, src: "/media/Night%20Day%20-%20Jahzzar.wav" }] });
  assert.equal(readProject(dir).media.find((x) => x.id === m.id).license, undefined, "a file no entry has a licence for: none");
  const ndEntry = readProject(dir).media.find((x) => x.license && x.license.title === "Golden Peaks");
  await mcp.callTool("fablecut_patch_project", { ops: [{ op: "replaceMedia", id: m.id, src: ndEntry.src }] });
  assert.equal(readProject(dir).media.find((x) => x.id === m.id).license.title, "Golden Peaks", "the replacement's own licence comes along");
});

test("a requested file name keeps its extension and never makes a dotfile", async (t) => {
  const http2 = require("node:http");
  const srv = http2.createServer((req, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.alloc(64)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const { downloadImportUrl } = require("../import-url");
  const dir = makeDataDir(t);
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const a = await downloadImportUrl(url, dir, { name: "...hidden.mp3", allowLoopback: true });
  assert.equal(a.name, "hidden.mp3");
  const b = await downloadImportUrl(url, dir, { name: "x".repeat(300) + ".mp3", allowLoopback: true });
  assert.match(b.name, /^x{100}\.mp3$/, "the stem is cut, not the extension");
});

test("fablecut_music explains Openverse's rate limit", async (t) => {
  const ov = await fakeOpenverse(t, { limited: true });
  const dir = makeDataDir(t);
  const mcp = startMcp(t, dir, { FABLECUT_NO_AUTOSTART: "1", FABLECUT_TEST_OPENVERSE: ov.url });
  const r = await mcp.callTool("fablecut_music", { query: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /limit for anonymous searches is used up/);
});

test("the editor keeps a media entry's licence when it saves", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(src, /const lic = FableCutMusic\.cleanLicense\(m\.license\);\s*if \(lic\) mo\.license = lic;/);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const mi = html.indexOf('src="music.js"'), ai = html.indexOf('src="app.js"');
  assert.ok(mi !== -1 && ai !== -1 && mi < ai, "music.js loads, before app.js");
  assert.match(html, /data-tab="music"/);
});
