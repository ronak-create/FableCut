/* fablecut_captions: caption clips from a file's transcript (saved over the
   REST API here, as the editor saves it after running Whisper), subtitle files
   out and in, removing, and the refusals. No browser or model needed: the
   transcript is already there, so no transcription job runs. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDataDir, readProject, writeProject, seedProject, startServer, startMcp } = require("./helpers");

const WORDS = [["Meet", 0.5, 0.7], ["FableCut", 0.7, 1.3], ["Studio,", 1.3, 1.9], ["a", 2.0, 2.1], ["video", 2.1, 2.4], ["editor.", 2.4, 3.0],
  ["Then", 4.0, 4.3], ["just", 4.3, 4.5], ["ask.", 4.5, 5.0]];
const post = (base, p, body) => fetch(base + p, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

const boot = async (t) => {
  const dir = makeDataDir(t, seedProject({
    revision: 2, width: 1080, height: 1920, fps: 30,
    media: [{ id: "m_v", name: "vo.wav", kind: "audio", src: "/media/vo.wav", duration: 6 }],
    clips: [{ id: "c_v", kind: "audio", mediaId: "m_v", track: "A1", start: 0, in: 0, duration: 6 },
      { id: "c_t", kind: "text", mediaId: null, track: "V3", start: 0, duration: 2, props: { text: "TITLE" } }],
  }));
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "media", "vo.wav"), Buffer.alloc(4096));
  const srv = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1", FABLECUT_CHROME: path.join(dir, "no-such-browser") });
  await post(srv.base, "/api/transcript?src=/media/vo.wav", { model: "base", language: "en", duration: 6, words: WORDS });
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(srv.port) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  return { dir, ...srv, mcp };
};
const caps = (dir) => readProject(dir).clips.filter((c) => c.props && c.props.caption);

test("captions from the transcript, on a new lane above the title, timed word by word", async (t) => {
  const { dir, mcp } = await boot(t);
  const none = await mcp.callTool("fablecut_captions", { export: "srt" });
  assert.equal(none.isError, true);
  assert.match(none.text, /no captions on the timeline/);

  const r = await mcp.callTool("fablecut_captions", { style: "highlight" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Added 3 captions \(Highlight, \d+ px\) on V4 \(a new lane\)/);
  const doc = readProject(dir);
  assert.equal(doc.revision, 3);
  assert.equal(doc.tracks[0].id, "V4", "the new lane is on top");
  const cs = caps(dir).sort((a, b) => a.start - b.start);
  assert.deepEqual(cs.map((c) => c.props.text.replace(/\n/g, " ")), ["Meet FableCut Studio,", "a video editor.", "Then just ask."]);
  assert.ok(cs.every((c) => c.track === "V4" && c.props.textAnim === "highlight" && c.props.captionStyle === "highlight"));
  assert.deepEqual(cs[0].props.wordTimes, [[0, 0.2], [0.2, 0.8], [0.8, 1.4]], "seconds from the caption's start");
  assert.equal(cs[0].start, 0.5);
  for (let k = 1; k < cs.length; k++) assert.ok(cs[k].start >= cs[k - 1].start + cs[k - 1].duration - 1e-9, "never overlapping");

  // again: replaces them on the same lane
  const again = await mcp.callTool("fablecut_captions", { style: "pop" });
  assert.match(again.text, /on V4, .*replacing 3/);
  assert.ok(caps(dir).every((c) => c.props.captionStyle === "pop" && c.track === "V4"));
  assert.ok(caps(dir).every((c) => c.props.text.split(/\s+/).length <= 3), "pop: at most three words");

  const srt = await mcp.callTool("fablecut_captions", { export: "srt" });
  assert.equal(srt.isError, false, srt.text);
  const file = path.join(dir, "exports", "Test Project.srt");
  assert.ok(srt.text.includes(file));
  assert.match(fs.readFileSync(file, "utf8"), /^1\n00:00:00,500 --> /);
  const vtt = await mcp.callTool("fablecut_captions", { export: "vtt" });
  assert.match(fs.readFileSync(path.join(dir, "exports", "Test Project.vtt"), "utf8"), /^WEBVTT\n\n00:00:00\.500 --> /);
  assert.ok(vtt.text.includes(".vtt"));

  // import a file instead of the transcript
  const sub = path.join(dir, "sub.srt");
  fs.writeFileSync(sub, "1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n");
  const imp = await mcp.callTool("fablecut_captions", { import: sub, style: "subtitle" });
  assert.equal(imp.isError, false, imp.text);
  assert.match(imp.text, /Read 2 captions from the SubRip file/);
  const ic = caps(dir).sort((a, b) => a.start - b.start);
  assert.deepEqual(ic.map((c) => [c.start, c.duration, c.props.text]), [[1, 1.5, "Hello there"], [3, 1, "Bye"]]);
  assert.equal(ic[0].props.wordTimes.length, 2, "spread over the caption");

  const rm = await mcp.callTool("fablecut_captions", { remove: true });
  assert.match(rm.text, /Removed 2 captions/);
  assert.equal(caps(dir).length, 0);
  assert.equal(readProject(dir).clips.find((c) => c.id === "c_t").props.text, "TITLE", "other text clips stay");
});

test("refusals: a bad style, a locked caption, a missing file", async (t) => {
  const { dir, mcp } = await boot(t);
  const bad = await mcp.callTool("fablecut_captions", { style: "comic" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /style must be subtitle, karaoke, highlight, pop/);
  assert.match((await mcp.callTool("fablecut_captions", { import: path.join(dir, "nope.srt") })).text, /no such subtitle file/);
  assert.match((await mcp.callTool("fablecut_captions", { import: "not a subtitle" })).text, /no such subtitle file|no subtitles found/);

  await mcp.callTool("fablecut_captions", {});
  const doc = readProject(dir);
  doc.clips.find((c) => c.props && c.props.caption).locked = true;
  doc.revision++;
  writeProject(dir, doc);
  const before = readProject(dir).revision;
  const locked = await mcp.callTool("fablecut_captions", { style: "karaoke" });
  assert.equal(locked.isError, true);
  assert.match(locked.text, /locked — nothing changed/);
  assert.equal(readProject(dir).revision, before, "nothing saved");
  const keep = await mcp.callTool("fablecut_captions", { style: "karaoke", replace: false, track: "V5" });
  assert.equal(keep.isError, false, keep.text);
  assert.ok(caps(dir).some((c) => c.track === "V5") && caps(dir).some((c) => c.locked), "both sets now");
  assert.match((await mcp.callTool("fablecut_captions", { remove: true })).text, /locked — nothing removed/);
});
