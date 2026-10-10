/* Clip masks: the shared math in mask.js (the editor rasterizes the same
   outlines on a canvas — checked in a browser by hand; matteAt is the CPU
   reference), the agent's setMask / removeMask / setMaskKeys ops, props.masks
   validation on addClip / updateClip, and the mask part of fablecut_scopes. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const M = require("../mask.js");
const { makeDataDir, readProject, seedProject, startServer, startMcp } = require("./helpers");

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: expected ${b}, got ${a}`);
const BW = 200, BH = 100;   // a 2:1 picture

test("normalizeMask fills defaults, clamps, and refuses bad input in strict mode", () => {
  const m = M.normalizeMask({ shape: "rect", x: 0.3, opacity: 3, feather: -4 });
  assert.deepEqual(m, { shape: "rect", mode: "add", x: 0.3, y: 0.5, w: 0.5, h: 0.5, scale: 1, rotation: 0, feather: 0, expand: 0, opacity: 1 });
  assert.equal(M.normalizeMask({ shape: "ellipse" }).shape, "ellipse");
  assert.throws(() => M.normalizeMask({ shape: "star" }, true), /shape must be rect \| ellipse \| bezier/);
  assert.throws(() => M.normalizeMask({ shape: "rect", glow: 1 }, true), /glow: unknown key/);
  assert.throws(() => M.normalizeMask({ shape: "rect", mode: "xor" }, true), /mode must be add/);
  assert.throws(() => M.normalizeMask({ shape: "bezier", points: [[0, 0], [1, 1]] }, true), /3…64 points/);
  assert.throws(() => M.normalizeMasks(new Array(9).fill({ shape: "rect" }), true), /at most 8/);
  const b = M.normalizeMask({ shape: "bezier", points: [[0, -0.2], [0.2, 0.2, 0, 0, 0, 0], [-0.2, 0.2, 0.1, 0, -0.1, 0]] });
  assert.deepEqual(b.points[1], [0.2, 0.2], "a point without handles is stored as a corner");
  assert.equal(b.points[2].length, 6);
  assert.equal(M.normalizeMasks([]), null);
  assert.equal(M.normalizeMasks([{ shape: "rect" }, null]).length, 1);
});

test("shapes: rect, ellipse and bezier outlines cover the right pixels, and follow scale / rotation", () => {
  const rect = M.normalizeMask({ shape: "rect", x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.equal(M.matteAt([rect], 100, 50, BW, BH), 1, "centre");
  assert.equal(M.matteAt([rect], 148, 50, BW, BH), 1, "inside the right edge (x = 150)");
  assert.equal(M.matteAt([rect], 152, 50, BW, BH), 0, "outside the right edge");
  assert.equal(M.matteAt([rect], 100, 77, BW, BH), 0, "outside the bottom edge (y = 75)");
  const ell = M.normalizeMask({ shape: "ellipse", x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.equal(M.matteAt([ell], 148, 50, BW, BH), 1, "on the ellipse's long axis");
  assert.equal(M.matteAt([ell], 145, 72, BW, BH), 0, "a rect corner is outside the ellipse");
  const turned = { ...rect, rotation: 90 };   // 100 × 50 px rect turned → 50 wide, 100 tall (about the centre)
  assert.equal(M.matteAt([turned], 140, 50, BW, BH), 0, "turned: narrower now");
  assert.equal(M.matteAt([turned], 100, 95, BW, BH), 1, "turned: taller now");
  assert.equal(M.matteAt([{ ...rect, scale: 0.5 }], 140, 50, BW, BH), 0, "scale shrinks it about its centre");
  const tri = M.normalizeMask({ shape: "bezier", x: 0.5, y: 0.5, points: [[0, -0.4], [0.4, 0.4], [-0.4, 0.4]] });
  assert.equal(M.matteAt([tri], 100, 60, BW, BH), 1, "inside the triangle");
  assert.equal(M.matteAt([tri], 30, 15, BW, BH), 0, "outside the triangle");
  // handles bulge the edge: a diamond with tangent handles is (nearly) a circle
  const dia = [[0.3, 0], [0, 0.3], [-0.3, 0], [0, -0.3]], k = 0.5523;
  const curvy = M.normalizeMask({ shape: "bezier", x: 0.5, y: 0.5, points: dia.map(([x, y]) => [x, y, y * k, -x * k, -y * k, x * k]) });
  const straight = M.normalizeMask({ shape: "bezier", x: 0.5, y: 0.5, points: dia });
  assert.equal(M.matteAt([straight], 138, 69, BW, BH), 0, "outside the diamond's straight edge");
  assert.equal(M.matteAt([curvy], 138, 69, BW, BH), 1, "inside the curved one");
});

test("modes, invert, opacity, feather and expansion combine like the canvas raster", () => {
  const big = M.normalizeMask({ shape: "rect", x: 0.5, y: 0.5, w: 0.8, h: 0.8 });
  const small = { ...big, w: 0.2, h: 0.2 };
  assert.equal(M.matteAt([big, { ...small, mode: "subtract" }], 100, 50, BW, BH), 0, "subtract cuts a hole");
  assert.equal(M.matteAt([big, { ...small, mode: "subtract" }], 40, 50, BW, BH), 1);
  assert.equal(M.matteAt([big, { ...small, mode: "intersect" }], 40, 50, BW, BH), 0, "intersect keeps the overlap only");
  assert.equal(M.matteAt([big, { ...small, mode: "intersect" }], 100, 50, BW, BH), 1);
  assert.equal(M.matteAt([big, { ...small, mode: "difference" }], 100, 50, BW, BH), 0, "difference: both → none");
  assert.equal(M.matteAt([{ ...small, mode: "subtract" }], 10, 10, BW, BH), 1, "a first subtract starts from the full picture");
  assert.equal(M.matteAt([{ ...small, invert: true }], 100, 50, BW, BH), 0, "invert");
  assert.equal(M.matteAt([{ ...small, invert: true }], 10, 10, BW, BH), 1);
  assert.equal(M.matteAt([{ ...big, opacity: 0.4 }], 100, 50, BW, BH), 0.4, "opacity");
  // feather: a smooth ramp centred on the edge (x = 180)
  const f = { ...big, feather: 20 };
  near(M.matteAt([f], 180, 50, BW, BH), 0.5, 0.02, "half on the edge");
  assert.ok(M.matteAt([f], 172, 50, BW, BH) > 0.85 && M.matteAt([f], 188, 50, BW, BH) < 0.15, "ramps over the feather width");
  // expansion grows / shrinks the outline by px (× the canvas px per project px)
  assert.equal(M.matteAt([{ ...big, expand: 10 }], 188, 50, BW, BH), 1, "grow 10 px");
  assert.equal(M.matteAt([{ ...big, expand: -10 }], 175, 50, BW, BH), 0, "shrink 10 px");
  assert.equal(M.matteAt([{ ...big, expand: 10 }], 188, 50, BW, BH, 0.5), 0, "pxScale halves it");
});

test("keys animate numbers and bezier outlines; masksAt drops masks that are off", () => {
  const m = M.normalizeMask({ shape: "bezier", points: [[0, 0], [0.1, 0], [0, 0.1]],
    keys: [{ t: 2, x: 0.8, points: [[0, 0], [0.3, 0], [0, 0.3]] }, { t: 0, x: 0.2, ease: "linear" }, { t: 1, opacity: 0.5, ease: "linear" }] });
  assert.deepEqual(m.keys.map((k) => k.t), [0, 1, 2], "keys sorted");
  near(M.maskAt(m, 1).x, 0.5, 1e-9, "x eases between its own keys");
  assert.equal(M.maskAt(m, 3).x, 0.8, "holds after the last key");
  assert.equal(M.maskAt(m, 0.5).opacity, 0.5, "a param with one key holds it");
  assert.deepEqual(M.maskAt(m, 0).points, [[0, 0], [0.3, 0], [0, 0.3]], "one points key: held");
  const two = M.normalizeMask({ shape: "bezier", points: [[0, 0], [0.1, 0], [0, 0.1]],
    keys: [{ t: 0, points: [[0, 0], [0.1, 0], [0, 0.1]] }, { t: 1, ease: "linear", points: [[0, 0], [0.3, 0], [0, 0.3]] }] });
  near(M.maskAt(two, 0.5).points[1][0], 0.2, 1e-9, "outline morphs point by point");
  assert.throws(() => M.normalizeMask({ shape: "bezier", points: [[0, 0], [0.1, 0], [0, 0.1]], keys: [{ t: 0, points: [[0, 0], [1, 0], [1, 1], [0, 1]] }] }, true), /need the shape's 3 points/);
  assert.equal(M.masksAt([{ ...m, on: false }], 0), null);
  assert.equal(M.masksAt([m, { ...m, on: false }], 0).length, 1);
});

test("a free-hand stroke becomes an editable bezier that keeps the drawn area", () => {
  const stroke = [];
  for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2; stroke.push([0.5 + 0.25 * Math.cos(a), 0.5 + 0.3 * Math.sin(a)]); }
  stroke.push(stroke[0]);
  const m = M.normalizeMask({ shape: "freehand", stroke, aspect: 2 }, true);
  assert.equal(m.shape, "bezier");
  assert.ok(m.points.length >= 6 && m.points.length <= 40, `simplified to ${m.points.length} points`);
  near(m.x, 0.5, 0.01, "centred on the drawing"); near(m.y, 0.5, 0.01, "centred");
  for (const [u, v, want] of [[0.5, 0.5, 1], [0.7, 0.5, 1], [0.5, 0.75, 1], [0.8, 0.5, 0], [0.5, 0.86, 0], [0.7, 0.75, 0]])
    assert.equal(M.matteAt([m], u * BW, v * BH, BW, BH), want, `(${u}, ${v})`);
  assert.throws(() => M.normalizeMask({ shape: "freehand", stroke: [[0, 0]] }, true), /stroke must be at least 3/);
});

test("adding or removing a bezier point keeps the curve and changes every keyed outline alike", () => {
  const diamond = [[0, -0.4, -0.2, 0, 0.2, 0], [0.4, 0, 0, -0.2, 0, 0.2], [0, 0.4, 0.2, 0, -0.2, 0], [-0.4, 0, 0, 0.2, 0, -0.2]];
  const m = M.normalizeMask({ shape: "bezier", points: diamond });
  const split = { ...m, points: M.splitPoints(m.points, 1, 0.5) };
  assert.equal(split.points.length, 5);
  for (const [x, y] of [[100, 50], [150, 75], [100, 15], [30, 50], [178, 50], [100, 92]])   // same pixels covered
    assert.equal(M.matteAt([split], x, y, BW, BH, 0) > 0.5, M.matteAt([m], x, y, BW, BH, 0) > 0.5, `pixel ${x},${y}`);
  const keyed = M.normalizeMask({ shape: "bezier", points: diamond, keys: [{ t: 0, x: 0.4, points: diamond }, { t: 1, ease: "linear", points: diamond.map((p) => [p[0] * 0.5, p[1] * 0.5, p[2], p[3], p[4], p[5]]) }] });
  const added = M.normalizeMask(M.editTopology(keyed, (pts) => M.splitPoints(pts, 0, 0.5)), true);
  assert.equal(added.points.length, 5);
  assert.equal(added.keys[1].points.length, 5, "the keyed outline gained the point too");
  assert.equal(M.maskAt(added, 0.5).points.length, 5, "and still morphs");
  near(M.maskAt(added, 0.5).points[1][0], 0.225, 1e-6, "the new point morphs between its keyed positions");
  const removed = M.normalizeMask(M.editTopology(added, (pts) => pts.filter((_, j) => j !== 1)), true);
  assert.equal(removed.points.length, 4);
  assert.equal(removed.keys[1].points.length, 4);
  assert.equal(removed.keys[0].x, 0.4, "numeric keys untouched");
});

test("mergeMask merges key by key, resets with null, and a new shape starts fresh", () => {
  const a = M.normalizeMask({ shape: "rect", x: 0.2, w: 0.3, feather: 12, keys: [{ t: 0, x: 0.1 }] });
  const b = M.mergeMask(a, { x: 0.6, feather: null, invert: true });
  assert.equal(b.x, 0.6); assert.equal(b.feather, 0); assert.equal(b.invert, true); assert.equal(b.w, 0.3);
  const c = M.mergeMask(b, { shape: "bezier", points: [[0, 0], [0.1, 0], [0, 0.1]] });
  assert.equal(c.keys, undefined, "keys belonged to the old shape");
  assert.equal(c.x, 0.6, "position stays");
  assert.match(M.describe([a, c]), /^2 masks: rect feather 12 1 keys, bezier\(3\) inverted$/);
});

const masked = () => seedProject({
  media: [{ id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 },
    { id: "m_t", name: "t.wav", kind: "audio", src: "/media/t.wav", duration: 10 }],
  clips: [
    { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 5 },
    { id: "c_b", mediaId: "m_a", kind: "video", track: "V1", start: 5, in: 0, duration: 5, locked: true },
    { id: "c_t", mediaId: "m_t", kind: "audio", track: "A1", start: 0, in: 0, duration: 5 },
    { id: "c_txt", mediaId: null, kind: "text", track: "V2", start: 0, duration: 5, props: { text: "Hi" } },
  ],
});

test("setMask adds, merges, finds by name, removes; setMaskKeys animates; locks and audio are refused", async (t) => {
  const dir = makeDataDir(t, masked());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const masks = (id) => readProject(dir).clips.find((c) => c.id === id).props?.masks;

  let r = await patch({ op: "setMask", id: "c_a", set: { shape: "ellipse", w: 0.4, feather: 30 } },
    { op: "setMask", id: "c_a", mask: "Hole", set: { shape: "rect", mode: "subtract", w: 0.1, h: 0.1 } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /c_a\.masks\(2 masks: ellipse feather 30, "Hole" rect subtract\)/);
  assert.equal(masks("c_a").length, 2);
  assert.equal(masks("c_a")[1].name, "Hole");
  r = await patch({ op: "setMask", id: "c_a", mask: "Hole", set: { x: 0.7, invert: true } });
  assert.equal(masks("c_a")[1].x, 0.7);
  assert.equal(masks("c_a")[1].w, 0.1, "merge keeps the rest");
  r = await patch({ op: "setMask", id: "c_a", mask: 0, set: { shape: "freehand", stroke: [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]] } });
  assert.equal(r.isError, false, r.text);
  assert.equal(masks("c_a")[0].shape, "bezier", "a stroke is stored as a bezier");
  r = await patch({ op: "setMaskKeys", id: "c_a", mask: "Hole", keys: [{ t: 0, x: 0.2 }, { t: 4, x: 0.8, ease: "linear" }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(masks("c_a")[1].keys.length, 2);
  r = await patch({ op: "setMaskKeys", id: "c_a", mask: 1, keys: null });
  assert.equal(masks("c_a")[1].keys, undefined);
  r = await patch({ op: "removeMask", id: "c_a", mask: "Hole" });
  assert.equal(masks("c_a").length, 1);
  r = await patch({ op: "setMask", id: "c_txt", set: { shape: "rect", x: 0.75, w: 0.5, h: 1 } });
  assert.equal(r.isError, false, "text clips take masks: " + r.text);

  // refusals abort the whole patch
  r = await patch({ op: "removeMask", id: "c_a", mask: 0 }, { op: "setMask", id: "c_a", set: { x: 0.5 } });
  assert.equal(r.isError, true);
  assert.match(r.text, /a new mask needs set\.shape/);
  assert.equal(masks("c_a").length, 1, "nothing saved");
  r = await patch({ op: "setMask", id: "c_a", mask: 0, set: { mode: "xor" } });
  assert.match(r.text, /mode must be add/);
  r = await patch({ op: "setMask", id: "c_a", mask: 5, set: { shape: "rect" } });
  assert.match(r.text, /use mask:1/);
  r = await patch({ op: "setMask", id: "c_t", set: { shape: "rect" } });
  assert.match(r.text, /audio clip/);
  r = await patch({ op: "setMask", id: "c_b", set: { shape: "rect" } });
  assert.match(r.text, /locked/);
  r = await patch({ op: "setMask", id: "c_b", set: { shape: "rect" }, force: true });
  assert.equal(r.isError, false, r.text);

  // props.masks written wholesale is validated and normalized
  r = await patch({ op: "updateClip", id: "c_a", set: { props: { masks: [{ shape: "ellipse", oops: 1 }] } } });
  assert.match(r.text, /props\.masks\[0\]\.oops: unknown key/);
  r = await patch({ op: "updateClip", id: "c_a", set: { props: { masks: [{ shape: "rect" }] } } });
  assert.equal(r.isError, false, r.text);
  assert.equal(masks("c_a")[0].w, 0.5, "defaults filled in");
  r = await patch({ op: "addClip", clip: { kind: "text", track: "V3", start: 0, duration: 1, props: { masks: [{ shape: "blob" }] } } });
  assert.match(r.text, /shape must be/);
  const compact = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(compact.text, /c_a V1 .*\[1 mask: rect\]/);
});

test("fablecut_scopes passes mask:{clip} on the ticket and reports the masks' coverage", async (t) => {
  const dir = makeDataDir(t, seedProject({ revision: 2 }));
  const { base, port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1", FABLECUT_CHROME: path.join(dir, "no-such-browser") });
  const tickets = [];
  let wake = null, buf = "", opened;
  const open = new Promise((r) => { opened = r; });
  const sse = http.get(base + "/api/events", (res) => {
    opened();
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^event: export$/m.test(block)) { tickets.push(JSON.parse(/^data: (.*)$/m.exec(block)[1])); wake?.(); }
      }
    });
  });
  sse.on("error", () => {});
  t.after(() => sse.destroy());
  await open;
  await new Promise((r) => setTimeout(r, 100));
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const post = (p, body) => fetch(base + p, { method: "POST", body: body && JSON.stringify(body) });

  const pending = mcp.callTool("fablecut_scopes", { time: 1, where: "tab", mask: { clip: "c_a" } });
  while (!tickets.length) await new Promise((r) => { wake = r; });
  const tk = tickets.shift();
  assert.deepEqual(tk.mask, { clip: "c_a" });
  assert.equal((await post("/api/export/job/claim?id=" + tk.id)).status, 200);
  const stats = { pixels: 10, luma: { min: 0, p1: 0, median: 0.4, mean: 0.4, p99: 1, max: 1 },
    clipped: { blackPct: 0, whitePct: 0 }, rgbMean: [0.4, 0.4, 0.4], saturation: 0, cast: { tone: "neutral", hue: 0, strength: 0 } };
  await post("/api/export/job/report?id=" + tk.id, { status: "done", result: { time: 1, frame: { w: 1280, h: 720 }, stats,
    clips: [{ id: "c_a", track: "V1", kind: "video", grade: "neutral", masks: "1 mask: ellipse" }],
    mask: { clip: "c_a", masks: "1 mask: ellipse", coverage: 31.4, frameCoverage: 22.1 } } });
  const r = await pending;
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Masks of c_a \(1 mask: ellipse\): keep 31\.4% of the clip's picture · the masked clip covers 22\.1% of the frame/);
  for (const mask of [{ clip: 3 }, "c_a", {}])
    assert.equal((await post("/api/scopes/request", { mask })).status, 400, JSON.stringify(mask) + " is not a mask");
});

test("a split or head trim re-bases mask keys, so the animation plays on unchanged", async (t) => {
  const dir = makeDataDir(t, masked());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  let r = await patch({ op: "setMask", id: "c_a", set: { shape: "rect", keys: [{ t: 0, x: 0.2 }, { t: 4, x: 0.6, ease: "linear" }] } },
    { op: "split", at: 1, ids: ["c_a"] });
  assert.equal(r.isError, false, r.text);
  const doc = readProject(dir), left = doc.clips.find((c) => c.id === "c_a");
  const right = doc.clips.find((c) => c.id !== "c_a" && c.track === "V1" && c.start === 1);
  assert.ok(right, "the right half");
  near(M.maskAt(left.props.masks[0], 0.5).x, 0.25, 1e-6, "left half as before");
  assert.deepEqual(right.props.masks[0].keys.map((k) => k.t), [0, 3]);
  for (const local of [0, 1, 2.5]) near(M.maskAt(right.props.masks[0], local).x, 0.2 + 0.1 * (local + 1), 1e-6, `right half at ${local}`);
  r = await patch({ op: "rippleTrim", id: right.id, side: "in", delta: 1 });
  assert.equal(r.isError, false, r.text);
  const trimmed = readProject(dir).clips.find((c) => c.id === right.id);
  near(M.maskAt(trimmed.props.masks[0], 0).x, 0.4, 1e-6, "after a 1 s head trim the mask starts where the shot now starts");
});

test("track mattes: the matte track is the video track above unless named; blend and matte values are checked", () => {
  const ids = ["V3", "V2", "V1"];
  assert.equal(M.matteTrackFor({ track: "V1", props: { matte: "luma" } }, ids), "V2");
  assert.equal(M.matteTrackFor({ track: "V2", props: { matte: "alpha" } }, ids), "V3");
  assert.equal(M.matteTrackFor({ track: "V3", props: { matte: "alpha" } }, ids), null, "nothing above the top track");
  assert.equal(M.matteTrackFor({ track: "V1", props: { matte: "alpha", matteTrack: "V3" } }, ids), "V3");
  assert.equal(M.matteTrackFor({ track: "V1", props: { matte: "alpha", matteTrack: "V1" } }, ids), null, "never its own track");
  assert.equal(M.matteTrackFor({ track: "V1", props: { matte: "glow" } }, ids), null);
  assert.equal(M.matteTrackFor({ track: "V2", props: { matte: "luma" } }, ["V10", "V3", "V2"]), "V3", "numeric order, not text");
  assert.throws(() => M.checkCompositing({ blend: "add" }, ids, "V1", true), /blend must be normal/);
  assert.throws(() => M.checkCompositing({ matte: "luma", matteTrack: "A1" }, ids, "V1", true), /matteTrack must be a video track/);
  assert.deepEqual(M.checkCompositing({ blend: "add", matte: "luma", matteTrack: "V1" }, ids, "V1"), { matte: "luma" }, "lenient: drops what is invalid");
  for (const b of ["color-burn", "exclusion", "hue", "saturation", "color", "luminosity"]) assert.ok(M.BLENDS.includes(b), b);
});

test("setMatte sets and clears a track matte; blend, matte and matteTrack are validated on updateClip", async (t) => {
  const dir = makeDataDir(t, masked());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const props = (id) => readProject(dir).clips.find((c) => c.id === id).props || {};

  let r = await patch({ op: "setMatte", id: "c_a", matte: "luma" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /c_a\.matte\(luma from V2\)/);
  assert.equal(props("c_a").matte, "luma");
  r = await patch({ op: "setMatte", id: "c_a", matte: "alpha-inverted", track: "V3" });
  assert.match(r.text, /alpha-inverted from V3/);
  assert.equal(props("c_a").matteTrack, "V3");
  r = await patch({ op: "setMatte", id: "c_a", matte: null });
  assert.equal(props("c_a").matte, undefined);
  assert.equal(props("c_a").matteTrack, undefined, "the track goes with it");

  r = await patch({ op: "setMatte", id: "c_a", matte: "glow" });
  assert.match(r.text, /setMatte needs matte: alpha \| alpha-inverted \| luma \| luma-inverted/);
  r = await patch({ op: "setMatte", id: "c_a", matte: "luma", track: "V1" });
  assert.match(r.text, /another track than the clip's own/);
  r = await patch({ op: "setMatte", id: "c_t", matte: "luma" });
  assert.match(r.text, /audio clip/);
  r = await patch({ op: "setMatte", id: "c_b", matte: "luma" });
  assert.equal(r.isError, true, "locked");
  r = await patch({ op: "updateClip", id: "c_txt", set: { props: { matte: "luma" } } });
  assert.equal(r.isError, false, "updateClip may set a matte too: " + r.text);
  assert.equal(props("c_txt").matte, "luma");
  r = await patch({ op: "updateClip", id: "c_a", set: { props: { blend: "exclusion" } } });
  assert.equal(r.isError, false, r.text);
  assert.equal(props("c_a").blend, "exclusion");
  r = await patch({ op: "updateClip", id: "c_a", set: { props: { blend: "add" } } });
  assert.match(r.text, /props\.blend must be normal/);
  r = await patch({ op: "updateClip", id: "c_a", set: { props: { matte: "luma", matteTrack: "A1" } } });
  assert.match(r.text, /props\.matteTrack must be a video track/);
  assert.equal(props("c_a").blend, "exclusion", "nothing saved by the refused patches");
});
