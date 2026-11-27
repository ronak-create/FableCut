/* clips.js: the checks on what the agent asks for, and the steps run() takes through the
   tools it is given (here fakes that record each call). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../clips.js");

const talk = (extra) => ({ width: 1920, height: 1080, fps: 30, revision: 1,
  tracks: [{ id: "V2", kind: "video" }, { id: "V1", kind: "video" }, { id: "A1", kind: "audio" }],
  media: [{ id: "m", kind: "video", src: "/media/talk.mp4", duration: 120 }],
  clips: [{ id: "c", mediaId: "m", kind: "video", track: "V1", start: 0, in: 0, duration: 120 }], ...extra });

test("options: defaults, and every bad argument refused with a reason", () => {
  const o = C.options({ clips: [{ from: 10, to: 40, name: "Tip 1", title: "Start small" }] }, talk());
  assert.deepEqual(o.clips, [{ from: 10, to: 40, name: "Tip 1", title: "Start small" }]);
  assert.equal(o.aspect, "9:16");
  assert.equal(o.captions, "pop");
  assert.equal(o.reframe, true);
  assert.equal(o.title, true);
  assert.equal(o.exportPreset, null);
  assert.equal(C.options({ clips: [{ from: 0, to: 5 }] }, talk()).clips[0].name, "Clip 1");
  const bad = (args, re) => assert.throws(() => C.options(args, talk()), re);
  bad({}, /clips must be a list/);
  bad({ clips: [{ from: "a", to: 5 }] }, /must be numbers/);
  bad({ clips: [{ from: 100, to: 130 }] }, /outside the timeline/);
  bad({ clips: [{ from: 10, to: 11 }] }, /at least 3 s/);
  assert.doesNotThrow(() => C.options({ clips: [{ from: 0, to: 119 }] }, talk()));
  bad({ clips: [{ from: 0, to: 200 }] }, /outside the timeline/);
  assert.throws(() => C.options({ clips: [{ from: 0, to: 200 }] }, talk({ clips: [{ id: "c", mediaId: "m", kind: "video", track: "V1", start: 0, in: 0, duration: 400 }] })), /at most 180 s/);
  bad({ clips: Array.from({ length: 11 }, () => ({ from: 0, to: 5 })) }, /up to 10/);
  bad({ clips: [{ from: 0, to: 5 }], aspect: "7:3" }, /aspect must be one of/);
  bad({ clips: [{ from: 0, to: 5 }], captions: "neon" }, /captions must be one of/);
  assert.throws(() => C.options({ clips: [{ from: 0, to: 5 }] }, talk({ clips: [] })), /timeline is empty/);
});

test("options: locked material is refused before anything changes (an extract can't cut it, so the copy would keep it whole)", () => {
  const one = { clips: [{ from: 10, to: 40 }] };
  const lockedClip = talk(); lockedClip.clips.push({ id: "bed", mediaId: "m", kind: "audio", track: "A1", start: 0, in: 0, duration: 120, locked: true });
  assert.throws(() => C.options(one, lockedClip), /locked material \(bed on A1\).*unlock them .* only if the user agrees/);
  assert.throws(() => C.options(one, talk({ lockedTracks: ["V1"] })), /locked material \(c on V1\)/);
  assert.doesNotThrow(() => C.options(one, talk({ lockedTracks: ["V2"] })), "a locked lane with nothing on it is no obstacle");
});

test("canvasFor keeps the shorter side, even sizes", () => {
  assert.deepEqual(C.canvasFor("9:16", 1920, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(C.canvasFor("1:1", 1920, 1080), { width: 1080, height: 1080 });
  assert.deepEqual(C.canvasFor("4:5", 1280, 720), { width: 720, height: 900 });
  assert.deepEqual(C.canvasFor("16:9", 1080, 1920), { width: 1920, height: 1080 });
});

test("the hook title sits in the top third and only takes a free, unlocked top lane", () => {
  const t = C.titleClip("t", "Start small", "V2", 1080, 1920, 20);
  assert.equal(t.track, "V2");
  assert.equal(t.duration, 3);
  assert.ok(t.props.y < 0 && t.props.boxFit && t.props.textAnim === "word-pop");
  assert.equal(C.titleClip("t", "x", "V2", 1080, 1920, 2).duration, 2);
  assert.equal(C.freeTopLane(talk(), 3), "V2");
  assert.equal(C.freeTopLane(talk({ lockedTracks: ["V2"] }), 3), null);
  const busy = talk(); busy.clips.push({ id: "b", kind: "text", track: "V2", start: 1, duration: 5 });
  assert.equal(C.freeTopLane(busy, 3), null);
});

test("run: one sequence per clip, cut to its part, then reframe, title, captions and export through the tools", async () => {
  let doc = talk({ sequence: "main", sequences: [{ id: "main", name: "Main" }] });
  const calls = [];
  const env = {
    read: async () => JSON.parse(JSON.stringify(doc)),
    patch: async (ops) => {
      calls.push(["patch", ops]);
      for (const op of ops) {
        if (op.op === "addSequence") { doc.sequences.push({ id: op.id, name: op.name }); doc.sequence = op.id; doc.width = op.width; doc.height = op.height; }
        if (op.op === "openSequence") doc.sequence = op.id;
        if (op.op === "addClip") doc.clips.push(op.clip);
      }
      return "Patched";
    },
    reframe: async (a) => { calls.push(["reframe", a]); return "Reframed"; },
    captions: async (a) => { calls.push(["captions", a]); return "Added captions"; },
    exportClip: async (a) => { calls.push(["export", a]); return `Exported → exports/${a.name}.mp4`; },
  };
  const reply = await C.run({ clips: [{ from: 10, to: 40, name: "Tip 1", title: "Start small" }, { from: 60, to: 90, name: "Tip 2" }], export: "tiktok" }, env);
  const first = calls[0][1];
  assert.deepEqual(first[0], { op: "addSequence", id: "seq_clip1", name: "Tip 1", from: "open", width: 1080, height: 1920, open: true });
  assert.deepEqual(first.filter((o) => o.op === "extract").map((o) => [o.from, o.to]), [[40, 121], [0, 10]], "after the clip first, then before it");
  assert.deepEqual(first.find((o) => o.op === "extract").tracks, ["V2", "V1", "A1"]);
  assert.deepEqual(calls.map((c) => c[0]), ["patch", "reframe", "patch", "captions", "export", "patch", "reframe", "captions", "export", "patch"]);
  assert.equal(calls[2][1][0].clip.props.text, "Start small");
  assert.deepEqual(calls[3][1], { style: "pop" });
  assert.deepEqual(calls[4][1], { preset: "tiktok", name: "tip-1", timeout: 180 }, "each export gets its own time (at least 3 min)");
  assert.deepEqual(calls[5][1][0], { op: "openSequence", id: "main" }, "the second clip is copied from the source again");
  assert.deepEqual(calls.at(-1)[1], [{ op: "openSequence", id: "seq_clip1" }], "the first clip is opened at the end");
  assert.match(reply, /Made 2 clips on 1080×1920/);
  assert.match(reply, /hook title "Start small"/);
  assert.match(reply, /exported → exports\/tip-1\.mp4/);
});

test("run: a failed step is reported on its clip, the rest carry on", async () => {
  let doc = talk();
  const env = {
    read: async () => JSON.parse(JSON.stringify(doc)),
    patch: async (ops) => { for (const op of ops) if (op.op === "addSequence") { doc.sequences = [{ id: "main", name: "Main" }, { id: op.id, name: op.name }]; doc.sequence = op.id; } return "ok"; },
    reframe: async () => { throw new Error("no full-frame shots to reframe"); },
    captions: async () => { throw new Error("no speech found"); },
    exportClip: async () => "x",
  };
  const reply = await C.run({ clips: [{ from: 0, to: 10 }], aspect: "1:1", title: false }, env);
  assert.match(reply, /not reframed \(no full-frame shots to reframe\)/);
  assert.match(reply, /no captions \(no speech found\)/);
  const same = await C.run({ clips: [{ from: 0, to: 10 }], aspect: "16:9", captions: false }, { ...env, reframe: async () => { throw new Error("should not run"); } });
  assert.doesNotMatch(same, /reframe/i, "same shape: nothing to reframe");
  const slow = await C.run({ clips: [{ from: 0, to: 10 }], aspect: "16:9", captions: false, export: "tiktok" },
    { ...env, exportClip: async () => "Export x_1 running — 40% (in the user's Studio tab). Check again with fablecut_export {job:\"x_1\"}." });
  assert.match(slow, /not exported \(Export x_1 running/);
  assert.doesNotMatch(slow, /exported →/);
  let tries = 0;
  const retried = await C.run({ clips: [{ from: 0, to: 10 }], aspect: "9:16", captions: false },
    { ...env, reframe: async () => { if (++tries === 1) throw new Error("the project changed while looking at the footage"); return "ok"; } });
  assert.equal(tries, 2);
  assert.match(retried, /framed on the subject/);
  const later = await C.run({ clips: [{ from: 0, to: 10 }], aspect: "16:9" }, { ...env, captions: async () => "Transcribing 1 file in the user's tab. It carries on there: call fablecut_captions again in a minute." });
  assert.match(later, /captions not added yet/);
  assert.doesNotMatch(later, /pop captions/);
});

/* a stand-in editor for run(): sequences, open/add, and the patches it was sent */
function fakeEnv(doc, over = {}) {
  const patches = [];
  const env = {
    read: async () => JSON.parse(JSON.stringify(doc)),
    patch: async (ops) => {
      patches.push(ops);
      if (over.refuse && over.refuse(ops)) throw new Error("CONFLICT — not saved");
      for (const op of ops) {
        if (op.op === "addSequence") { doc.sequences = doc.sequences || [{ id: "main", name: "Main" }]; doc.sequences.push({ id: op.id, name: op.name }); doc.sequence = op.id; }
        if (op.op === "openSequence") doc.sequence = op.id;
      }
      return "Patched";
    },
    reframe: async () => "Reframed", captions: async () => "Added captions",
    exportClip: over.exportClip || (async (a) => `Export x done → exports/${a.name}.mp4`),
  };
  return { env, patches };
}

test("run: a timeline without a tracks list still cuts every lane, untargeted ones too", async () => {
  const doc = talk({ untargetedTracks: ["A1"] });
  delete doc.tracks;
  doc.clips.push({ id: "a", mediaId: "m", kind: "audio", track: "A1", start: 0, in: 0, duration: 120 });
  const { env, patches } = fakeEnv(doc);
  await C.run({ clips: [{ from: 10, to: 40 }], captions: false }, env);
  const cuts = patches[0].filter((o) => o.op === "extract");
  assert.equal(cuts.length, 2);
  assert.ok(cuts.every((o) => JSON.stringify(o.tracks) === JSON.stringify(["V1", "A1"])), JSON.stringify(cuts));
});

test("run: a clip that can't be cut is reported and the next is still made; none made is an error", async () => {
  const { env, patches } = fakeEnv(talk(), { refuse: (ops) => ops.some((o) => o.op === "addSequence" && o.name === "Tip 1") });
  const reply = await C.run({ clips: [{ from: 10, to: 40, name: "Tip 1" }, { from: 60, to: 90, name: "Tip 2" }], captions: false }, env);
  assert.match(reply, /1\. "Tip 1": not made \(CONFLICT — not saved\)/);
  assert.match(reply, /Made 1 clip on 1080×1920/);
  assert.match(reply, /2\. "Tip 2" \(seq_clip2,/);
  assert.equal(patches[1][0].op, "addSequence", "nothing was opened by the failed clip: the source is still the open sequence");
  assert.match(reply, /Opened "Tip 2"/);
  const none = fakeEnv(talk(), { refuse: () => true });
  await assert.rejects(C.run({ clips: [{ from: 10, to: 40, name: "Tip 1" }], captions: false }, none.env), /no clip was made:[\s\S]*"Tip 1": not made/);
});

test("run: an export that hasn't ended stops the batch before another sequence opens under it", async () => {
  const { env, patches } = fakeEnv(talk(), { exportClip: async () => "Export x_1 running — 40% (in the open editor tab). Check again with fablecut_export {job:\"x_1\"}." });
  const reply = await C.run({ clips: [{ from: 10, to: 40, name: "Tip 1" }, { from: 60, to: 90, name: "Tip 2" }], captions: false, export: "tiktok" }, env);
  assert.match(reply, /not exported \(Export x_1 running/);
  assert.match(reply, /The clips after "Tip 1" weren't made: its export is still running/);
  assert.match(reply, /Made 1 clip /);
  assert.ok(!patches.some((ops) => ops.some((o) => o.op === "openSequence")), "no sequence opened while it runs");
  const stopped = fakeEnv(talk(), { exportClip: async (a) => `Export x_2 stopped: it didn't finish in ${a.timeout} s` });
  const ok = await C.run({ clips: [{ from: 10, to: 40, name: "Tip 1" }, { from: 60, to: 90, name: "Tip 2" }], captions: false, export: "tiktok" }, stopped.env);
  assert.match(ok, /not exported \(Export x_2 stopped: it didn't finish in 180 s\)/);
  assert.match(ok, /Made 2 clips/, "a stopped export has ended: the next clip goes on");
});

/* exportUntilEnded: a host's job-based export, ended before it answers (a stand-in for the MCP server) */
function jobHost(script) {
  const log = [];
  const io = {
    start: async () => { log.push("start"); return "Settings adjusted: none\nExport x_9 pending (in the open editor tab). Check again with fablecut_export {job:\"x_9\"}."; },
    status: async (id, secs) => { log.push(secs ? `wait ${secs}` : "status"); return script.status(id, secs, log); },
    cancel: async (id) => { log.push("cancel"); if (script.cancel) return script.cancel(id); },
    sleep: async () => { log.push("sleep"); },
  };
  return { io, log };
}

test("exportUntilEnded: a finished export answers as it is, with no cancel", async () => {
  const { io, log } = jobHost({ status: () => "Export x_9 done → exports/tip-1.mp4 (4.0 MB)" });
  assert.match(await C.exportUntilEnded(io, { preset: "tiktok", name: "tip-1", timeout: 180 }), /Export x_9 done → exports\/tip-1\.mp4/);
  assert.deepEqual(log, ["start", "wait 180"]);
});

test("exportUntilEnded: one still running at its time is cancelled, and answers stopped once its status says so", async () => {
  const { io, log } = jobHost({ status: (id, secs) => secs ? "Export x_9 running — 60% (in the open editor tab)." : "Export x_9 cancelled: cancelled" });
  assert.equal(await C.exportUntilEnded(io, { timeout: 180 }), "Export x_9 stopped: it didn't finish in 180 s");
  assert.deepEqual(log, ["start", "wait 180", "cancel", "sleep", "status"]);
});

test("exportUntilEnded: a status check that fails still cancels the job; one it can't confirm stopped stops the batch", async () => {
  const lost = jobHost({ status: (id, secs) => { if (secs) throw new Error("lost track of the export job"); return "Export x_9 cancelled: cancelled"; } });
  assert.equal(await C.exportUntilEnded(lost.io, { timeout: 180 }), "Export x_9 stopped: it didn't finish in 180 s");
  assert.ok(lost.log.includes("cancel"), "the accepted job is cancelled although its poll failed");
  const stuck = jobHost({ status: () => "Export x_9 running — 60% (in the open editor tab).", cancel: () => { throw new Error("cancel failed"); } });
  const r = await C.exportUntilEnded(stuck.io, { timeout: 180 });
  assert.match(r, /^Export x_9 running: it couldn't be confirmed stopped/);
  const silent = jobHost({ status: (id, secs) => { if (!secs) throw new Error("server gone"); return "Export x_9 running — 60%."; } });
  assert.match(await C.exportUntilEnded(silent.io, { timeout: 180 }), /^Export x_9 running: it couldn't be confirmed stopped$/);
  // and run() stops the batch on those answers, also on one without a job id
  for (const answer of [r, "Export running: it is still going in the tab\nExport failed: an export is already running in the editor"]) {
    const { env, patches } = fakeEnv(talk(), { exportClip: async () => answer });
    const reply = await C.run({ clips: [{ from: 10, to: 40, name: "Tip 1" }, { from: 60, to: 90, name: "Tip 2" }], captions: false, export: "tiktok" }, env);
    assert.match(reply, /The clips after "Tip 1" weren't made/, answer);
    assert.equal(patches.length, 1, "nothing more was patched while it may still render");
  }
});
