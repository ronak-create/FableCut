/* MCP tool semantics: the editing contract agents actually drive — patch ops,
   validation, and the optimistic-concurrency rules documented in CLAUDE.md.
   fablecut_status is deliberately not exercised: it spawns the editor server as
   a side effect, which is covered directly in rest-api.test.js instead. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDataDir, readProject, writeProject, seedProject, startMcp } = require("./helpers");

const boot = async (t, project) => {
  const dir = makeDataDir(t, project);
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  return { dir, mcp };
};

test("fablecut_docs returns the manual, and can slice it by section", async (t) => {
  const { mcp } = await boot(t);
  const full = await mcp.callTool("fablecut_docs");
  assert.match(full.text, /# FableCut/);

  const section = await mcp.callTool("fablecut_docs", { section: "schema" });
  assert.ok(section.text.length < full.text.length, "a section must be smaller than the manual");
  assert.match(section.text, /^## /, "a section slice starts at its heading");
  assert.match(section.text, /props reference/i);

  // Every section name the manual advertises as an example must resolve —
  // only `## ` headings are searched, so a `###`-only example is a dead end.
  for (const name of ["schema", "Recipes", "Remake", "Export", "REST API"]) {
    const hit = await mcp.callTool("fablecut_docs", { section: name });
    assert.match(hit.text, /^## /, `the manual advertises section "${name}" but it matches nothing`);
  }

  // An unmatched section is a helpful listing, not an error or a crash.
  const miss = await mcp.callTool("fablecut_docs", { section: "no-such-section" });
  assert.equal(miss.isError, false);
  assert.match(miss.text, /No '## ' section matches/);
});

test("fablecut_get_project returns the document, and compact hides default props", async (t) => {
  const project = seedProject();
  // Defaults the UI persists on every clip; the compact view should drop them.
  project.clips[0].props = { scale: 1, opacity: 1, volume: 1, filterPreset: "noir" };
  const { mcp } = await boot(t, project);

  const full = JSON.parse((await mcp.callTool("fablecut_get_project")).text);
  assert.equal(full.revision, 1);
  assert.equal(full.clips[0].props.scale, 1, "the full document keeps every prop");

  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(text, /c_a V1 0s\+5s video/, "compact lists the clip");
  assert.match(text, /filterPreset/, "a non-default prop must survive");
  assert.doesNotMatch(text, /"scale"/, "default-valued props must be hidden");
});

test("fablecut_patch_project applies a batch atomically and bumps the revision once", async (t) => {
  const { dir, mcp } = await boot(t);
  const { text, isError } = await mcp.callTool("fablecut_patch_project", {
    ops: [
      { op: "addMedia", media: { id: "m_b", kind: "audio", src: "/library/sfx/whoosh.mp3" } },
      { op: "addClip", clip: { id: "c_b", mediaId: "m_b", kind: "audio", track: "A1", start: 2, duration: 3 } },
      { op: "updateClip", id: "c_a", set: { props: { filterPreset: "noir" } } },
      { op: "setProject", set: { name: "Renamed" } },
    ],
  });
  assert.equal(isError, false, text);

  const doc = readProject(dir);
  assert.equal(doc.revision, 2, "one patch call is exactly one revision bump");
  assert.equal(doc.name, "Renamed");
  assert.equal(doc.media.length, 2);
  assert.equal(doc.clips.find((c) => c.id === "c_b").track, "A1");
  assert.equal(doc.clips.find((c) => c.id === "c_a").props.filterPreset, "noir");
  // addMedia fills in a name from the src when one is not supplied.
  assert.equal(doc.media.find((m) => m.id === "m_b").name, "whoosh.mp3");
});

test("updateClip merges into props, and null deletes a key", async (t) => {
  const project = seedProject();
  project.clips[0].props = { filterPreset: "noir", scale: 2 };
  const { dir, mcp } = await boot(t, project);

  await mcp.callTool("fablecut_patch_project", {
    ops: [{ op: "updateClip", id: "c_a", set: { props: { opacity: 0.5, filterPreset: null } } }],
  });
  const props = readProject(dir).clips[0].props;
  assert.equal(props.scale, 2, "untouched props survive a merge");
  assert.equal(props.opacity, 0.5, "new props are merged in");
  assert.ok(!("filterPreset" in props), "null removes a prop");
});

test("patch ops reject edits that would corrupt the timeline", async (t) => {
  const { dir, mcp } = await boot(t);
  const cases = [
    [{ op: "addClip", clip: { id: "c_x", mediaId: "m_nope", kind: "video", track: "V1", start: 0, duration: 1 } },
      /unknown mediaId/i],
    [{ op: "addClip", clip: { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, duration: 1 } },
      /duplicate clip id/i],
    [{ op: "addClip", clip: { id: "c_y", mediaId: "m_a", kind: "video", track: "V1" } },
      /addClip needs/i],
    [{ op: "updateClip", id: "c_missing", set: { start: 1 } }, /no clip/i],
    [{ op: "removeClip", id: "c_missing" }, /no clip/i],
    [{ op: "removeMedia", id: "m_a" }, /is used by clip c_a/i],
    [{ op: "setProject", set: { revision: 99 } }, /not settable/i],
    [{ op: "frobnicate" }, /Unknown op/i],
  ];
  for (const [op, expected] of cases) {
    const { text, isError } = await mcp.callTool("fablecut_patch_project", { ops: [op] });
    assert.ok(isError, `${op.op} should have been rejected, got: ${text}`);
    assert.match(text, expected);
  }
  const empty = await mcp.callTool("fablecut_patch_project", { ops: [] });
  assert.ok(empty.isError, "an empty op list is a mistake, not a no-op");

  // Nothing above may have touched the document.
  assert.deepEqual(readProject(dir), seedProject(), "rejected patches must not write");
});

test("patch refuses to change locked clips and tracks unless forced", async (t) => {
  const project = seedProject({
    lockedTracks: ["A3"],
    media: [
      { id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 },
      { id: "m_m", name: "bed.mp3", kind: "audio", src: "/media/bed.mp3", duration: 30 },
    ],
    clips: [
      { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 5, locked: true },
      { id: "c_s", mediaId: "m_a", kind: "audio", track: "A1", start: 5, in: 5, duration: 5, linkGroup: "g" },
      { id: "c_p", mediaId: "m_a", kind: "video", track: "V1", start: 5, in: 5, duration: 5, linkGroup: "g", locked: true },
      { id: "c_m", mediaId: "m_m", kind: "audio", track: "A3", start: 0, in: 0, duration: 10 },
    ],
  });
  const { dir, mcp } = await boot(t, project);
  const refused = [
    [{ op: "updateClip", id: "c_a", set: { start: 2 } }, /clip c_a is locked/],
    [{ op: "removeClip", id: "c_a" }, /clip c_a is locked/],
    [{ op: "updateClip", id: "c_m", set: { start: 1 } }, /locked track A3/],
    [{ op: "updateClip", id: "c_s", set: { start: 1 } }, /linked to c_p/],
    [{ op: "addClip", clip: { mediaId: "m_m", kind: "audio", track: "A3", start: 12, duration: 2 } }, /track A3 is locked/],
  ];
  for (const [op, expected] of refused) {
    const { text, isError } = await mcp.callTool("fablecut_patch_project", { ops: [op] });
    assert.ok(isError, `${op.op} on locked material should be refused, got: ${text}`);
    assert.match(text, expected);
    assert.match(text, /force:true/, "the error must say how to override");
  }
  assert.deepEqual(readProject(dir), project, "refused patches must not write");

  // Moving an unlocked clip onto a locked track is refused too.
  await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setProject", set: { lockedTracks: ["A3", "V2"] } }] });
  const move = await mcp.callTool("fablecut_patch_project", {
    ops: [{ op: "addClip", clip: { id: "c_t", kind: "text", track: "V3", start: 0, duration: 1 } },
      { op: "updateClip", id: "c_t", set: { track: "V2" } }],
  });
  assert.ok(move.isError);
  assert.match(move.text, /track V2 is locked/);

  // force:true overrides, and toggling `locked` itself is always allowed.
  const forced = await mcp.callTool("fablecut_patch_project", {
    ops: [
      { op: "updateClip", id: "c_m", set: { start: 1 }, force: true },
      { op: "updateClip", id: "c_a", set: { locked: null } },
      { op: "updateClip", id: "c_a", set: { start: 3 } },
    ],
  });
  assert.equal(forced.isError, false, forced.text);
  const doc = readProject(dir);
  assert.equal(doc.clips.find((c) => c.id === "c_m").start, 1);
  assert.equal(doc.clips.find((c) => c.id === "c_a").start, 3);
  assert.ok(!("locked" in doc.clips.find((c) => c.id === "c_a")), "set:{locked:null} unlocks");
});

test("compact view shows locked tracks and clip flags", async (t) => {
  const project = seedProject({ lockedTracks: ["A3"], untargetedTracks: ["V2"] });
  Object.assign(project.clips[0], { locked: true, disabled: true, unlinked: true });
  const { mcp } = await boot(t, project);
  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(text, /lockedTracks:\[A3\]/);
  assert.match(text, /untargetedTracks:\[V2\]/);
  assert.match(text, /c_a V1 .*\[locked\] \[disabled\] \[unlinked\]/);
});

test("text and adjust clips need no media, unlike footage clips", async (t) => {
  const { dir, mcp } = await boot(t);
  const { isError, text } = await mcp.callTool("fablecut_patch_project", {
    ops: [
      { op: "addClip", clip: { id: "c_t", mediaId: null, kind: "text", track: "V2", start: 0, duration: 2, props: { text: "Hi" } } },
      { op: "addClip", clip: { id: "c_j", mediaId: null, kind: "adjust", track: "V3", start: 0, duration: 1, props: { shake: 18 } } },
    ],
  });
  assert.equal(isError, false, text);
  assert.equal(readProject(dir).clips.length, 3);
});

test("fablecut_set_project refuses to clobber an edit made behind its back", async (t) => {
  const { dir, mcp } = await boot(t);
  const doc = JSON.parse((await mcp.callTool("fablecut_get_project")).text);

  // The user drags a clip in the UI while the agent is thinking.
  writeProject(dir, { ...readProject(dir), revision: 7, name: "Edited in the UI" });

  doc.name = "Agent edit";
  const conflict = await mcp.callTool("fablecut_set_project", { project: doc });
  assert.ok(conflict.isError, "a stale save must be refused");
  assert.match(conflict.text, /CONFLICT/);
  assert.equal(readProject(dir).name, "Edited in the UI", "the user's work must survive");

  // force is the documented escape hatch.
  const forced = await mcp.callTool("fablecut_set_project", { project: doc, force: true });
  assert.equal(forced.isError, false, forced.text);
  const after = readProject(dir);
  assert.equal(after.name, "Agent edit");
  assert.ok(after.revision > 7, "a forced save still moves the revision forward");
});

test("patch with a stale baseRevision is refused instead of landing on a newer edit", async (t) => {
  const { dir, mcp } = await boot(t);
  const base = readProject(dir).revision;

  // The user edits in the UI while the agent is planning its ops.
  writeProject(dir, { ...readProject(dir), revision: base + 3, name: "Edited in the UI" });

  const stale = await mcp.callTool("fablecut_patch_project", {
    baseRevision: base,
    ops: [{ op: "updateClip", id: "c_a", set: { start: 2 } }],
  });
  assert.ok(stale.isError, "a patch planned on an old revision must be refused");
  assert.match(stale.text, /CONFLICT/);
  assert.match(stale.text, new RegExp(`revision ${base + 3}`), "the error carries the current revision");
  assert.equal(readProject(dir).clips[0].start, 0, "nothing may be written");
  assert.equal(readProject(dir).name, "Edited in the UI");

  // Retrying against the revision from the error goes through.
  const ok = await mcp.callTool("fablecut_patch_project", {
    baseRevision: base + 3,
    ops: [{ op: "updateClip", id: "c_a", set: { start: 2 } }],
  });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, new RegExp(`revision ${base + 4}`));
  const doc = readProject(dir);
  assert.equal(doc.clips[0].start, 2);
  assert.equal(doc.name, "Edited in the UI", "the user's edit survives");

  // Without baseRevision a patch still applies on top of whatever is latest.
  const loose = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setProject", set: { name: "Agent" } }] });
  assert.equal(loose.isError, false, loose.text);

  const bad = await mcp.callTool("fablecut_patch_project", { baseRevision: "7", ops: [{ op: "setProject", set: { name: "x" } }] });
  assert.ok(bad.isError);
  assert.match(bad.text, /baseRevision/);
});

test("fablecut_encode_profiles lists shipped presets and rejects an unknown id", async (t) => {
  const { mcp } = await boot(t);

  const listed = await mcp.request("tools/list");
  const names = listed.result.tools.map((x) => x.name);
  assert.ok(names.includes("fablecut_encode_profiles"), "tools/list must advertise the new tool");

  const summary = JSON.parse((await mcp.callTool("fablecut_encode_profiles")).text);
  assert.equal(summary.default, "delivery");
  assert.ok(summary.profiles.delivery, "the shipped delivery profile must be listed");
  assert.equal(summary.profiles.delivery.args, undefined, "the compact list omits the ffmpeg args array");
  assert.ok(summary.profiles.delivery.summary, "the compact list still has a summary string");

  const detailed = JSON.parse((await mcp.callTool("fablecut_encode_profiles", { detail: true })).text);
  assert.ok(Array.isArray(detailed.profiles.delivery.args), "detail:true includes the args array");
  assert.ok(detailed.profiles.delivery.args.includes("-c:v"), "shipped args look like ffmpeg flags");

  const one = JSON.parse((await mcp.callTool("fablecut_encode_profiles", { profile: "delivery" })).text);
  assert.equal(one.profile, "delivery");
  assert.equal(one.extension, ".mp4");
  assert.ok(Array.isArray(one.args) && one.args.length, "a known id returns its args");

  const miss = await mcp.callTool("fablecut_encode_profiles", { profile: "no-such-profile" });
  assert.ok(miss.isError, "an unknown profile id must be flagged isError");
  assert.match(miss.text, /Unknown encoding profile/i);
});

test("fablecut_set_project validates the document before writing it", async (t) => {
  const { dir, mcp } = await boot(t);
  const before = readProject(dir);
  const cases = [
    [{ project: "nope" }, /must be an object/i],
    [{ project: { clips: [] } }, /clips.*media/i],
    [{ project: { media: [], clips: [{ track: "V1", start: 0, duration: 1 }] } }, /needs id, track/i],
    [{ project: { media: [], clips: [{ id: "c", kind: "video", mediaId: "m_ghost", track: "V1", start: 0, duration: 1 }] } },
      /unknown mediaId/i],
  ];
  for (const [args, expected] of cases) {
    const { text, isError } = await mcp.callTool("fablecut_set_project", args);
    assert.ok(isError, `should have been rejected: ${JSON.stringify(args)}`);
    assert.match(text, expected);
  }
  assert.deepEqual(readProject(dir), before, "an invalid save must leave the file untouched");
});

test("fablecut_import_media copies a local file and registers it", async (t) => {
  const { dir, mcp } = await boot(t);
  const src = path.join(dir, "take.mp4");
  fs.writeFileSync(src, "clip-bytes");
  const { text, isError } = await mcp.callTool("fablecut_import_media", { path: src });
  assert.equal(isError, false, text);
  const entry = JSON.parse(text.replace(/^Imported → /, "").split("\n")[0]);
  assert.equal(entry.kind, "video");
  assert.equal(entry.src, "/media/take.mp4");
  assert.ok(fs.existsSync(path.join(dir, "media", "take.mp4")));
  const doc = readProject(dir);
  assert.equal(doc.media.some((m) => m.id === entry.id && m.src === entry.src), true);
  assert.equal(doc.revision, 2);
});

test("fablecut_import_media rejects http and loopback https URLs", async (t) => {
  const { dir, mcp } = await boot(t);
  const http = await mcp.callTool("fablecut_import_media", { path: "http://example.com/a.mp4" });
  assert.ok(http.isError);
  assert.match(http.text, /https/i);
  const loop = await mcp.callTool("fablecut_import_media", { path: "https://127.0.0.1/a.mp4" });
  assert.ok(loop.isError);
  assert.match(loop.text, /blocked/i);
  assert.equal(readProject(dir).media.length, 1, "a rejected import must not add media");
});

test("setTrack sets an audio lane's fader / pan; setProject master sets the master fader", async (t) => {
  const { dir, mcp } = await boot(t);
  const ok = await mcp.callTool("fablecut_patch_project", {
    ops: [
      { op: "setTrack", id: "A2", set: { gain: -6, pan: -0.5 } },
      { op: "setProject", set: { master: { gain: -1.5 } } },
    ],
  });
  assert.equal(ok.isError, false, ok.text);
  const doc = readProject(dir);
  assert.deepEqual(doc.tracks.find((x) => x.id === "A2"), { id: "A2", kind: "audio", gain: -6, pan: -0.5 });
  assert.equal(doc.tracks.length, 7, "a project with no tracks list gets the default lanes");
  assert.deepEqual(doc.master, { gain: -1.5 });

  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(text, /MIX: A2 -6dB pan:-0\.5 · master -1\.5dB/);

  // 0 / null reset, out-of-range and video lanes are refused (and nothing is saved)
  await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setTrack", id: "A2", set: { gain: 0, pan: null } }] });
  assert.deepEqual(readProject(dir).tracks.find((x) => x.id === "A2"), { id: "A2", kind: "audio" });
  const before = readProject(dir);
  for (const [op, re] of [
    [{ op: "setTrack", id: "V1", set: { gain: -3 } }, /audio track/],
    [{ op: "setTrack", id: "A1", set: { gain: 30 } }, /gain must be a number/],
    [{ op: "setTrack", id: "A1", set: { mute: true } }, /not settable/],
    [{ op: "setProject", set: { master: { gain: "loud" } } }, /master is \{gain\}/],
  ]) {
    const bad = await mcp.callTool("fablecut_patch_project", { ops: [op] });
    assert.ok(bad.isError, JSON.stringify(op));
    assert.match(bad.text, re);
  }
  assert.deepEqual(readProject(dir), before);
});

test("fablecut_normalize_audio measures with ffmpeg and sets one gain per linked group", async (t) => {
  const { spawnSync } = require("node:child_process");
  const has = (b) => { try { return spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; } };
  if (!has("ffmpeg") || !has("ffprobe")) { t.skip("ffmpeg / ffprobe not installed"); return; }
  const project = seedProject({
    media: [{ id: "m_t", name: "tone.wav", kind: "audio", src: "/media/tone.wav", duration: 4 }],
    clips: [
      // a stereo pair of linked stems, and a standalone clip on A3
      { id: "c_l", mediaId: "m_t", kind: "audio", track: "A1", start: 0, in: 0, duration: 4, linkGroup: "lg1", props: { audioChannel: 0, pan: -1 } },
      { id: "c_r", mediaId: "m_t", kind: "audio", track: "A2", start: 0, in: 0, duration: 4, linkGroup: "lg1", props: { audioChannel: 1, pan: 1 } },
      { id: "c_s", mediaId: "m_t", kind: "audio", track: "A3", start: 0, in: 1, duration: 2, props: {} },
      { id: "c_x", mediaId: "m_t", kind: "audio", track: "A4", start: 0, in: 0, duration: 4, locked: true, props: {} },
    ],
  });
  const { dir, mcp } = await boot(t, project);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  // 1 kHz at −23 dBFS on both channels = −23 LUFS (EBU Tech 3341)
  // (lavfi "sine" is fixed at 1/8 amplitude, so build the tone with aevalsrc)
  const wave = "0.0707946*sin(2*PI*1000*t)"; // −23 dBFS
  const gen = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc=${wave}|${wave}:s=48000:d=4`,
    "-c:a", "pcm_f32le", path.join(dir, "media", "tone.wav")]);
  assert.equal(gen.status, 0, String(gen.stderr));

  const res = await mcp.callTool("fablecut_normalize_audio", { clipIds: ["c_l", "c_s", "c_x"], target: -14 });
  assert.equal(res.isError, false, res.text);
  const doc = readProject(dir);
  const gain = (id) => doc.clips.find((c) => c.id === id).props.gain;
  assert.ok(Math.abs(gain("c_l") - 9) <= 0.2, `stereo pair → +9 dB, got ${gain("c_l")}`);
  assert.equal(gain("c_r"), gain("c_l"), "linked stems share one gain");
  assert.ok(Math.abs(gain("c_s") - 9) <= 0.2, `standalone stereo clip → +9 dB, got ${gain("c_s")}`);
  assert.equal(gain("c_x"), undefined, "a locked clip is left alone");
  assert.match(res.text, /c_x.*locked/);
  assert.equal(doc.revision, 2);

  const peak = await mcp.callTool("fablecut_normalize_audio", { clipIds: ["c_s"], mode: "peak", target: -1 });
  assert.equal(peak.isError, false, peak.text);
  const pg = readProject(dir).clips.find((c) => c.id === "c_s").props.gain;
  assert.ok(Math.abs(pg - 22) <= 0.2, `peak −23 → −1 dBFS is +22 dB, got ${pg}`);

  const miss = await mcp.callTool("fablecut_normalize_audio", { clipIds: ["nope"] });
  assert.ok(miss.isError);
});

test("fablecut_auto_duck writes duck keys on the music where the voice speaks, and clears them", async (t) => {
  const { spawnSync } = require("node:child_process");
  const has = (b) => { try { return spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; } };
  if (!has("ffmpeg") || !has("ffprobe")) { t.skip("ffmpeg / ffprobe not installed"); return; }
  const project = seedProject({
    media: [
      { id: "m_v", name: "voice.wav", kind: "audio", src: "/media/voice.wav", duration: 6 },
      { id: "m_m", name: "music.wav", kind: "audio", src: "/media/music.wav", duration: 10 },
    ],
    clips: [
      { id: "c_v", mediaId: "m_v", kind: "audio", track: "A1", start: 2, in: 0, duration: 6, props: {} },
      { id: "c_m", mediaId: "m_m", kind: "audio", track: "A3", start: 0, in: 0, duration: 10, props: { volume: 0.5 } },
    ],
  });
  const { dir, mcp } = await boot(t, project);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  // voice: speech-level tone from 1 s to 3 s of the file (timeline 3 → 5 s), silence around it
  const voice = "if(between(t,1,3),0.2*sin(2*PI*300*t),0)";
  const music = "0.1*sin(2*PI*220*t)";
  for (const [name, expr, d] of [["voice.wav", voice, 6], ["music.wav", music, 10]]) {
    const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${d}`,
      "-c:a", "pcm_f32le", path.join(dir, "media", name)]);
    assert.equal(r.status, 0, String(r.stderr));
  }

  const res = await mcp.callTool("fablecut_auto_duck", { clipIds: ["c_m"], amount: -10 });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /under A1 — 1 voice span/);
  const keys = readProject(dir).clips.find((c) => c.id === "c_m").keyframes.duck;
  assert.equal(keys.length, 4, JSON.stringify(keys));
  const [down, low, high, up] = keys;
  assert.equal(down.v, 0);
  assert.equal(low.v, -10);
  assert.ok(Math.abs(low.t - 3) < 0.15, `fully ducked as the voice starts (${low.t})`);
  assert.ok(Math.abs(high.t - 5) < 0.15, `held to the end of the voice (${high.t})`);
  assert.ok(Math.abs(up.t - high.t - 0.6) < 1e-6, "0.6 s release");
  assert.equal(readProject(dir).clips.find((c) => c.id === "c_m").props.volume, 0.5, "volume untouched");

  const cleared = await mcp.callTool("fablecut_auto_duck", { clipIds: ["c_m"], amount: 0 });
  assert.equal(cleared.isError, false, cleared.text);
  assert.equal(readProject(dir).clips.find((c) => c.id === "c_m").keyframes, undefined, "amount 0 clears");

  const none = await mcp.callTool("fablecut_auto_duck", { clipIds: ["c_m"], under: ["A2"] });
  assert.ok(none.isError);
  assert.match(none.text, /nothing to duck for/);
});

test("fablecut_silence reports the pauses in speech, then cuts them with the stems in step", async (t) => {
  const { spawnSync } = require("node:child_process");
  const has = (b) => { try { return spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; } };
  if (!has("ffmpeg") || !has("ffprobe")) { t.skip("ffmpeg / ffprobe not installed"); return; }
  const project = seedProject({
    fps: 30,
    media: [
      { id: "m_s", name: "talk.wav", kind: "audio", src: "/media/talk.wav", duration: 10 },
      { id: "m_b", name: "bed.wav", kind: "audio", src: "/media/bed.wav", duration: 10 },
    ],
    clips: [
      { id: "c_s", mediaId: "m_s", kind: "audio", track: "A1", start: 0, in: 0, duration: 10, props: {} },
      { id: "c_b", mediaId: "m_b", kind: "audio", track: "A3", start: 0, in: 0, duration: 10, props: { volume: 0.3 } },
      { id: "c_t", kind: "text", mediaId: null, track: "V2", start: 0, in: 0, duration: 10, props: { text: "hi" } },
    ],
    lockedTracks: ["A3"],
  });
  const { dir, mcp } = await boot(t, project);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  // speech 1–3 s and 5–6 s, silence around it; a steady bed on A3 that must not count
  const talk = "if(between(t,1,3)+between(t,5,6),0.2*sin(2*PI*300*t),0)";
  for (const [name, expr] of [["talk.wav", talk], ["bed.wav", "0.1*sin(2*PI*220*t)"]]) {
    const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=10`,
      "-c:a", "pcm_f32le", path.join(dir, "media", name)]);
    assert.equal(r.status, 0, String(r.stderr));
  }

  const look = await mcp.callTool("fablecut_silence", { clipIds: ["c_s"], padding: 0.2 });
  assert.equal(look.isError, false, look.text);
  assert.match(look.text, /^3 silences, /, look.text);
  assert.match(look.text, /cut:true/);
  assert.equal(readProject(dir).revision, project.revision, "reporting changes nothing");
  const loose = await mcp.callTool("fablecut_silence", { clipIds: ["c_s"], padding: 0.2, cut: "true" });
  assert.equal(loose.isError, false, loose.text);
  assert.equal(readProject(dir).revision, project.revision, "only cut:true cuts");

  // a picture with no audio stream beside it is not 'silent': its time is left alone
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=10", "-c:v", "libx264",
    "-pix_fmt", "yuv420p", path.join(dir, "media", "mute.mp4")]);
  assert.equal(r.status, 0, String(r.stderr));
  const withMute = readProject(dir);
  withMute.media.push({ id: "m_n", name: "mute.mp4", kind: "video", src: "/media/mute.mp4", duration: 10 });
  withMute.clips.push({ id: "c_n", mediaId: "m_n", kind: "video", track: "V1", start: 12, in: 0, duration: 10, props: {} });
  withMute.revision++;
  writeProject(dir, withMute);
  const mute = await mcp.callTool("fablecut_silence", { clipIds: ["c_s", "c_n"], padding: 0.2 });
  assert.equal(mute.isError, false, mute.text);
  assert.match(mute.text, /^3 silences, .*1 clip\(s\) with no audio stream left alone/, mute.text);
  const muteOnly = await mcp.callTool("fablecut_silence", { clipIds: ["c_n"] });
  assert.ok(muteOnly.isError);
  assert.match(muteOnly.text, /no audio stream/);
  withMute.clips = withMute.clips.filter((c) => c.id !== "c_n");
  withMute.media = withMute.media.filter((m) => m.id !== "m_n");
  withMute.revision++;
  writeProject(dir, withMute);

  const res = await mcp.callTool("fablecut_silence", { clipIds: ["c_s"], padding: 0.2, cut: true });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /^Cut 3 silences/);
  assert.match(res.text, /kept as a version/);
  const doc = readProject(dir);
  const speech = doc.clips.filter((c) => c.track === "A1").sort((a, b) => a.start - b.start);
  assert.equal(speech.length, 2, "two phrases left");
  const len = speech.reduce((n, c) => n + c.duration, 0);
  // 3 s of speech + 0.2 s padding each side, plus up to one 0.1 s RMS window of tail per phrase
  assert.ok(len >= 3.75 && len <= 4.35, `about 2 s + 1 s of speech plus padding, got ${len}`);
  assert.ok(Math.abs(speech[1].start - (speech[0].start + speech[0].duration)) < 1e-3, "no gap between the phrases");
  assert.ok(speech[0].in > 0.5 && speech[1].in > 4.5, JSON.stringify(speech.map((c) => c.in)));
  const bed = doc.clips.find((c) => c.id === "c_b");
  assert.deepEqual([bed.start, bed.duration], [0, 10], "the locked bed keeps running");

  const bad = await mcp.callTool("fablecut_silence", { clipIds: ["c_t"] });
  assert.ok(bad.isError);
  assert.match(bad.text, /no sound to listen to/);
});

test("fablecut_beats finds the tempo and the beat, marks it, snaps cuts to it and re-cuts a track on it", async (t) => {
  const { spawnSync } = require("node:child_process");
  const has = (b) => { try { return spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; } };
  if (!has("ffmpeg") || !has("ffprobe")) { t.skip("ffmpeg / ffprobe not installed"); return; }
  const v = (id, start, duration) => ({ id, mediaId: "m_v", kind: "video", track: "V1", start, in: 2, duration, props: {} });
  const project = seedProject({
    fps: 30,
    media: [
      { id: "m_k", name: "kicks.wav", kind: "audio", src: "/media/kicks.wav", duration: 16 },
      { id: "m_v", name: "gray.mp4", kind: "video", src: "/media/gray.mp4", duration: 20 },
    ],
    // the music plays from 1 s into the file at 2 s on the timeline: kicks at 0.25 + k·0.5 in the file → 1.25 + k·0.5 on the timeline
    clips: [
      { id: "c_k", mediaId: "m_k", kind: "audio", track: "A1", start: 2, in: 1, duration: 12, props: {} },
      v("v1", 2, 1.4), v("v2", 3.4, 2), v("v3", 5.4, 3),
      { id: "c_t", kind: "text", mediaId: null, track: "V2", start: 0, in: 0, duration: 4, props: { text: "hi" } },
    ],
    markers: [{ t: 0.5, label: "intro" }],
  });
  const { dir, mcp } = await boot(t, project);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  const kick = "gte(t,0.25)*0.9*sin(2*PI*60*mod(t-0.25,0.5))*exp(-mod(t-0.25,0.5)/0.1)";
  let r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc='${kick}':s=48000:d=16`, "-c:a", "pcm_f32le", path.join(dir, "media", "kicks.wav")]);
  assert.equal(r.status, 0, String(r.stderr));
  r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "media", "gray.mp4")]);
  assert.equal(r.status, 0, String(r.stderr));
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

  const look = await mcp.callTool("fablecut_beats", { clipId: "c_k" });
  assert.equal(look.isError, false, look.text);
  const bpm = +/: ([\d.]+) BPM/.exec(look.text)[1];
  near(bpm, 120, 0.6, "tempo");
  const first = +/Beats \(timeline\): ([\d.]+)/.exec(look.text)[1];
  near(first, 2.25, 0.017, "first beat");
  assert.match(look.text, /Nothing changed/);
  assert.equal(readProject(dir).revision, project.revision, "reporting changes nothing");

  const mark = await mcp.callTool("fablecut_beats", { clipId: "c_k", markers: true });
  assert.equal(mark.isError, false, mark.text);
  let doc = readProject(dir);
  const cyan = doc.markers.filter((m) => m.color === "cyan");
  assert.ok(cyan.length >= 22 && cyan.length <= 24, `${cyan.length} beat markers`);
  assert.ok(doc.markers.some((m) => m.label === "intro"), "the user's marker stays");

  const snap = await mcp.callTool("fablecut_beats", { clipId: "c_k", snap: true });
  assert.equal(snap.isError, false, snap.text);
  assert.match(snap.text, /snapped 2 of 2 cuts on/);
  assert.match(snap.text, /kept as a version/);
  doc = readProject(dir);
  const byId = (id) => doc.clips.find((c) => c.id === id);
  near(byId("v2").start, 3.25, 1 / 30, "cut 1 on the beat");
  near(byId("v3").start, 5.25, 1 / 30, "cut 2 on the beat");
  near(byId("v1").start + byId("v1").duration, byId("v2").start, 1e-6, "a roll keeps the cut closed");
  near(byId("v3").start + byId("v3").duration, 8.4, 1e-6, "nothing after the cut moves");

  // a cut whose next clip starts at its very first frame can't move earlier
  const noHead = readProject(dir);
  const n2 = noHead.clips.find((c) => c.id === "v2"), n1 = noHead.clips.find((c) => c.id === "v1");
  n1.duration += 0.15; n2.start += 0.15; n2.duration -= 0.15; n2.in = 0;
  noHead.revision++;
  writeProject(dir, noHead);
  const blocked = await mcp.callTool("fablecut_beats", { clipId: "c_k", snap: true });
  assert.equal(blocked.isError, false, blocked.text);
  assert.match(blocked.text, /1 without spare footage to reach the beat/);
  near(readProject(dir).clips.find((c) => c.id === "v2").start, n2.start, 1e-6, "that cut stays");

  const re = await mcp.callTool("fablecut_beats", { clipId: "c_k", retime: { every: 2 } });
  assert.equal(re.isError, false, re.text);
  assert.match(re.text, /re-cut 3 clips on V1 to 2 beats each/);
  doc = readProject(dir);
  near(byId("v1").start, 2.25, 1 / 30, "v1 starts on the first beat");
  for (const [a, b] of [["v1", "v2"], ["v2", "v3"]]) {
    near(byId(a).duration, 1, 1 / 30, `${a} lasts two beats`);
    near(byId(a).start + byId(a).duration, byId(b).start, 1e-6, `${a} → ${b} back to back`);
  }

  // footage that can't fill one beat refuses the whole re-cut
  const short = readProject(dir);
  short.clips.find((c) => c.id === "v3").in = 19.8;
  short.clips.find((c) => c.id === "v3").duration = 0.2;
  short.revision++;
  writeProject(dir, short);
  const refused = await mcp.callTool("fablecut_beats", { clipId: "c_k", retime: { every: 2 } });
  assert.ok(refused.isError);
  assert.match(refused.text, /v3 has less than one beat of footage/);
  assert.equal(readProject(dir).revision, short.revision, "nothing re-cut");

  // a locked track: retime refuses, force goes ahead
  const locked = readProject(dir);
  locked.clips.find((c) => c.id === "v3").in = 2;
  locked.clips.find((c) => c.id === "v3").duration = 3;
  locked.lockedTracks = ["V1"];
  locked.revision++;
  writeProject(dir, locked);
  const lockedRe = await mcp.callTool("fablecut_beats", { clipId: "c_k", retime: true });
  assert.ok(lockedRe.isError);
  assert.match(lockedRe.text, /locked/);
  const forced = await mcp.callTool("fablecut_beats", { clipId: "c_k", retime: true, force: true });
  assert.equal(forced.isError, false, forced.text);

  const notMusic = await mcp.callTool("fablecut_beats", { clipId: "c_t" });
  assert.ok(notMusic.isError);
  assert.match(notMusic.text, /no sound to find a beat in/);
  const badEvery = await mcp.callTool("fablecut_beats", { clipId: "c_k", retime: { every: 3 } });
  assert.ok(badEvery.isError);
  assert.match(badEvery.text, /every must be one of/);
});

test("fablecut_reframe makes a 9:16 copy whose shots follow the subject", async (t) => {
  const { spawnSync } = require("node:child_process");
  const has = (b) => { try { return spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; } };
  if (!has("ffmpeg") || !has("ffprobe")) { t.skip("ffmpeg / ffprobe not installed"); return; }
  const project = seedProject({
    width: 1920, height: 1080, fps: 30,
    media: [{ id: "m_sq", name: "slide.mp4", kind: "video", src: "/media/slide.mp4", duration: 4, width: 1280, height: 720 }],
    clips: [
      { id: "c_sq", mediaId: "m_sq", kind: "video", track: "V1", start: 0, in: 0, duration: 4, props: {} },
      { id: "c_pip", mediaId: "m_sq", kind: "video", track: "V2", start: 0, in: 0, duration: 2, props: { scale: 0.3, x: 500 } },
      { id: "c_t", kind: "text", mediaId: null, track: "V3", start: 0, in: 0, duration: 4, props: { text: "hi" } },
    ],
  });
  const { dir, mcp } = await boot(t, project);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  // an orange square sliding left to right across a dark frame
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x111111:s=1280x720:r=30:d=4", "-f", "lavfi", "-i", "color=c=orange:s=150x150:r=30:d=4",
    "-filter_complex", "[0][1]overlay=x='60+t*260':y=285", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "media", "slide.mp4")]);
  assert.equal(r.status, 0, String(r.stderr));

  const res = await mcp.callTool("fablecut_reframe", { aspect: "9:16" });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /New sequence ".* 9:16" 1080×1920, opened/);
  assert.match(res.text, /c_sq: follows the subject/);
  assert.match(res.text, /c_pip \(placed by hand/);
  assert.match(res.text, /kept as a version/);
  const doc = readProject(dir);
  assert.deepEqual([doc.width, doc.height], [1080, 1920], "the new 9:16 sequence is open");
  const sq = doc.clips.find((c) => c.id === "c_sq");
  assert.equal(sq.props.fit, "cover");
  const keys = sq.keyframes.x;
  assert.ok(keys.length >= 2, JSON.stringify(keys));
  assert.ok(keys[0].v > 150 && keys[keys.length - 1].v < -150, `the picture moves right then left with the square: ${JSON.stringify(keys)}`);
  const max = (1280 * (1920 / 720) - 1080) / 2;
  assert.ok(keys.every((k) => Math.abs(k.v) <= max + 1), "never past the picture's edge");
  assert.deepEqual(doc.clips.find((c) => c.id === "c_pip").props, { scale: 0.3, x: 500 }, "the picture-in-picture is left alone");
  const main = doc.sequences.find((s) => s.id !== doc.sequence);
  assert.deepEqual(main.clips.find((c) => c.id === "c_sq").props, {}, "the original sequence is untouched");

  const centred = await mcp.callTool("fablecut_reframe", { clipIds: ["c_sq"], follow: false });
  assert.equal(centred.isError, false, centred.text);
  assert.match(centred.text, /c_sq: centred/);
  const none = await mcp.callTool("fablecut_reframe", { clipIds: ["c_t"] });
  assert.ok(none.isError);
  assert.match(none.text, /no full-frame shots/);
});

test("setFx puts validated chains or presets on clips (with their stems), tracks and the master", async (t) => {
  const project = seedProject({
    media: [{ id: "m_v", name: "v.mp4", kind: "video", src: "/media/v.mp4", duration: 10 }],
    clips: [
      { id: "c_v", mediaId: "m_v", kind: "video", track: "V1", start: 0, in: 0, duration: 5, linkGroup: "g" },
      { id: "c_l", mediaId: "m_v", kind: "audio", track: "A1", start: 0, in: 0, duration: 5, linkGroup: "g", props: { audioChannel: 0 } },
      { id: "c_r", mediaId: "m_v", kind: "audio", track: "A2", start: 0, in: 0, duration: 5, linkGroup: "g", props: { audioChannel: 1 } },
    ],
  });
  const { dir, mcp } = await boot(t, project);
  const ok = await mcp.callTool("fablecut_patch_project", { ops: [
    { op: "setFx", target: "clip", id: "c_l", preset: "podcast" },
    { op: "setFx", target: "track", id: "A3", fx: [{ type: "highpass", freq: 60 }] },
    { op: "setFx", target: "track", id: "A3", fx: [{ type: "limiter" }], append: true },
    { op: "setFx", target: "master", fx: [{ type: "limiter", ceiling: -1.5 }] },
  ] });
  assert.equal(ok.isError, false, ok.text);
  let doc = readProject(dir);
  const fx = (id) => doc.clips.find((c) => c.id === id).fx;
  assert.equal(fx("c_l").map((e) => e.type).join(","), "highpass,gate,eq,compressor,limiter");
  assert.deepEqual(fx("c_r"), fx("c_l"), "the stereo partner gets the same chain");
  assert.equal(fx("c_v"), undefined, "the picture clip carries no audio fx");
  assert.deepEqual(doc.tracks.find((x) => x.id === "A3").fx.map((e) => e.type), ["highpass", "limiter"], "append adds to the end");
  assert.equal(doc.master.fx[0].ceiling, -1.5);
  assert.equal(doc.master.fx[0].release, 80, "defaults filled in");

  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(text, /c_l .*fx:highpass·gate·eq·compressor·limiter/);
  assert.match(text, /MIX: A3 fx:highpass·limiter · master fx:limiter/);

  await mcp.callTool("fablecut_patch_project", { ops: [{ op: "setFx", target: "clip", id: "c_r", fx: null }] });
  doc = readProject(dir);
  assert.equal(fx("c_l"), undefined, "fx:null clears the whole stereo pair");

  const before = readProject(dir);
  for (const [op, re] of [
    [{ op: "setFx", target: "clip", id: "c_l", fx: [{ type: "flanger" }] }, /unknown effect "flanger"/],
    [{ op: "setFx", target: "clip", id: "c_l", preset: "loud" }, /unknown preset/],
    [{ op: "setFx", target: "clip", id: "c_v", preset: "podcast" }, /effects go on audio clips/],
    [{ op: "setFx", target: "track", id: "V1", preset: "wide" }, /audio track/],
  ]) {
    const bad = await mcp.callTool("fablecut_patch_project", { ops: [op] });
    assert.ok(bad.isError, JSON.stringify(op));
    assert.match(bad.text, re);
  }
  assert.deepEqual(readProject(dir), before, "a refused op saves nothing");
});

test("fablecut_highlights picks the busy and the loud moments into a new sequence", async (t) => {
  const { spawnSync } = require("node:child_process");
  const has = (b) => { try { return spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; } };
  if (!has("ffmpeg") || !has("ffprobe")) { t.skip("ffmpeg / ffprobe not installed"); return; }
  const project = seedProject({
    width: 1920, height: 1080, fps: 30,
    media: [{ id: "m_v", name: "day.mp4", kind: "video", src: "/media/day.mp4", duration: 30, width: 320, height: 180 }],
    clips: [{ id: "c_v", mediaId: "m_v", kind: "video", track: "V1", start: 0, in: 0, duration: 30, props: {} }],
  });
  const { dir, mcp } = await boot(t, project);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  // a still gridded frame; an orange square racing about 10–14 s; a cut to a blue scene at 20 s; a loud tone 24–26 s
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=30", "-f", "lavfi", "-i", "color=c=orange:s=40x40:r=30:d=30",
    "-f", "lavfi", "-i", "color=c=0x203070:s=320x180:r=30:d=30", "-f", "lavfi", "-i", "aevalsrc='if(between(t,24,26),0.6,0.01)*sin(2*PI*220*t)':s=48000:d=30",
    "-filter_complex", "[0][1]overlay=x='if(between(t,10,14),mod(t*900,280),20)':y=70[a];[a][2]overlay=enable='gte(t,20)',drawgrid=w=16:h=16:t=1:c=white@0.4[v]",
    "-map", "[v]", "-map", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "media", "day.mp4")]);
  assert.equal(r.status, 0, String(r.stderr));

  const res = await mcp.callTool("fablecut_highlights", { duration: 6, shot: 2 });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /New sequence "Highlights 6 s", opened/);
  assert.match(res.text, /kept as a version/);
  const doc = readProject(dir);
  assert.equal(doc.sequences.find((s) => s.id === doc.sequence).name, "Highlights 6 s");
  const hl = doc.clips.filter((c) => c.track === "V1").sort((a, b) => a.start - b.start);
  assert.ok(hl.length >= 3, JSON.stringify(hl));
  const total = hl.reduce((n, c) => n + c.duration, 0);
  assert.ok(Math.abs(total - 6) < 0.05, `total ${total}`);
  for (let i = 1; i < hl.length; i++) assert.ok(Math.abs(hl[i].start - (hl[i - 1].start + hl[i - 1].duration)) < 1e-3, "back to back");
  const spans = hl.map((c) => [c.in, c.in + c.duration]);
  assert.ok(spans.some(([a, b]) => a >= 9.5 && b <= 14.5), `the busy moment: ${JSON.stringify(spans)}`);
  assert.ok(spans.some(([a, b]) => a >= 23.5 && b <= 26.6), `the loud moment: ${JSON.stringify(spans)}`);
  assert.ok(spans.every(([a, b]) => !(a < 19.9 && b > 20.1)), `none across the cut: ${JSON.stringify(spans)}`);
  const main = doc.sequences.find((s) => s.id !== doc.sequence);
  assert.deepEqual(main.clips.map((c) => c.id), ["c_v"], "the timeline it came from is untouched");

  const tall = await mcp.callTool("fablecut_highlights", { duration: 6, mediaIds: ["m_v"], aspect: "9:16", name: "Reel" });
  assert.equal(tall.isError, false, tall.text);
  assert.match(tall.text, /fablecut_reframe \{\} fits them/);
  assert.deepEqual([readProject(dir).width, readProject(dir).height], [1080, 1920]);
  assert.ok(readProject(dir).clips.every((c) => c.mediaId === "m_v"));

  const shape = await mcp.callTool("fablecut_highlights", { aspect: "7:3" });
  assert.ok(shape.isError);
  assert.match(shape.text, /aspect must be one of/);
  const short = await mcp.callTool("fablecut_highlights", { duration: 2 });
  assert.ok(short.isError);
  assert.match(short.text, /duration must be/);
  const none = await mcp.callTool("fablecut_highlights", { clipIds: ["nope"] });
  assert.ok(none.isError);
  assert.match(none.text, /no video to make highlights from/);
});
