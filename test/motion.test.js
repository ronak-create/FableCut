/* Motion graphics: the shared math in motion.js (shape items, keys, trim
   paths, bounds, anchor point and parenting), the agent's setShape /
   removeShape / setParent ops, props.shapes validation and the split that
   carries shape keys into the right half. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../motion.js");
const E = require("../edit-ops.js");
const { makeDataDir, readProject, startMcp } = require("./helpers");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("shape items validate, fill defaults and reject bad input in strict mode", () => {
  const [rect, line, group] = M.normalizeShapes([
    { type: "rect", w: 300, h: 100, fill: "#F80" },
    { type: "line" },
    { type: "group", items: [{ type: "star" }, { type: "path", points: [[0, 0], [100, 0], [100, 100]], closed: false }] },
  ], true);
  assert.equal(rect.fill, "#ff8800", "short hex expands");
  assert.equal(rect.stroke, "none");
  assert.equal(rect.strokeWidth, undefined, "no stroke, no width");
  assert.equal(line.stroke, "#ffffff", "a line strokes by default");
  assert.equal(line.strokeWidth, 8);
  assert.deepEqual(line.points, [[-150, 0], [150, 0]]);
  assert.equal(group.items[0].sides, 5);
  assert.equal(group.items[1].fill, "none", "an open path does not fill");
  assert.equal(M.normalizeItem({ type: "rect", stroke: "#fff" }).strokeWidth, 6, "a stroke gets a width");
  assert.throws(() => M.normalizeShapes([{ type: "rect", bogus: 1 }], true), /bogus: not a rect key/);
  assert.throws(() => M.normalizeShapes([{ type: "blob" }], true), /type must be/);
  assert.throws(() => M.normalizeShapes([{ type: "line", points: [[0, 0]] }], true), /exactly 2 points/);
  assert.throws(() => M.normalizeShapes([{ type: "rect", fill: "red" }], true), /fill must be a colour/);
  assert.throws(() => M.normalizeShapes([{ type: "group", fill: "#fff" }], true), /not a group key/);
  assert.throws(() => M.normalizeShapes([{ type: "rect", keys: [{ t: 0, sides: 4 }] }], true), /sides is not keyable/);
  assert.throws(() => M.normalizeShapes(Array.from({ length: 70 }, () => ({ type: "rect" })), true), /at most 64 items/);
  let deep = { type: "rect" };
  for (let i = 0; i < 5; i++) deep = { type: "group", items: [deep] };
  assert.throws(() => M.normalizeShapes([deep], true), /nest at most 4 deep/);
  assert.equal(M.normalizeShapes([{ type: "blob" }, { type: "ellipse" }]).length, 1, "lenient mode drops what is invalid");
});

test("keys interpolate numbers, colours and points; groups resolve their children", () => {
  const [it] = M.normalizeShapes([{
    type: "path", points: [[0, 0], [100, 0]], closed: false,
    keys: [{ t: 0, x: 0, stroke: "#000000", points: [[0, 0], [100, 0]] }, { t: 2, x: 100, stroke: "#ffffff", points: [[0, 0], [100, 100]], ease: "linear" }],
  }]);
  const mid = M.itemAt(it, 1);
  near(mid.x, 100 * 0.5);
  assert.equal(mid.stroke, "#808080");
  assert.deepEqual(mid.points[1].slice(0, 2), [100, 50]);
  assert.equal(mid.keys, undefined);
  assert.equal(M.itemAt(it, -1).x, 0, "held before the first key");
  assert.equal(M.itemAt(it, 9).x, 100, "held after the last key");
  const [g] = M.normalizeShapes([{ type: "group", items: [{ type: "rect", keys: [{ t: 0, w: 0 }, { t: 1, w: 100, ease: "linear" }] }] }]);
  near(M.itemAt(g, 0.5).items[0].w, 50);
  assert.equal(M.lerpColor("none", "#ff0000", 0.5), "#ff000080", "none fades in through transparent");
});

test("outlines, bounds and trim windows", () => {
  const rect = M.normalizeItem({ type: "rect", w: 200, h: 100 });
  assert.equal(M.outline(rect).A.length, 4);
  assert.equal(M.outline({ ...rect, radius: 10 }).A.length, 8, "rounded corners add anchors");
  assert.equal(M.outline(M.normalizeItem({ type: "star", sides: 6 })).A.length, 12);
  assert.deepEqual(M.bounds([{ ...rect, x: 50, scale: 2 }]), { x0: -150, y0: -100, x1: 250, y1: 100 });
  const b = M.bounds([M.normalizeItem({ type: "rect", w: 100, h: 100, stroke: "#fff", strokeWidth: 10 })]);
  assert.equal(b.x0, -55, "the stroke counts");
  assert.equal(M.bounds([{ ...rect, on: false }]), null, "an item that is off has no bounds");
  assert.deepEqual(M.trimRuns([0, 1, 0], true), [[0, 1]]);
  assert.deepEqual(M.trimRuns([0.5, 0.5, 0], true), [], "an empty window draws nothing");
  assert.deepEqual(M.trimRuns([0.6, 1, 0.2], true).map((r) => r.map((v) => +v.toFixed(3))), [[0.8, 1], [0, 0.2]], "a closed outline wraps round its seam");
  assert.deepEqual(M.trimRuns([0.6, 1, 0.2], false).map((r) => r.map((v) => +v.toFixed(3))), [[0.8, 1]], "an open one clamps");
  // composing a group's trim with an item's own
  const tr = M.composeTrim([0, 0.5, 0], { trimStart: 20, trimEnd: 60, trimOffset: 0 });
  near(tr[0], 0.2); near(tr[1], 0.4);
});

test("draw paints fills, strokes and trims onto a 2D context", () => {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1 }, {
    get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])),
    set: (o, k, v) => { o[k] = v; calls.push(["=" + String(k), v]); return true; },
  });
  M.draw(ctx, M.shapesAt(M.normalizeShapes([
    { type: "rect", fill: "#ff0000", stroke: "#00ff00", strokeWidth: 4 },
    { type: "line", trimEnd: 50 },
    { type: "ellipse", on: false },
  ]), 0));
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes("fill") && names.includes("stroke"));
  assert.equal(calls.filter((c) => c[0] === "=fillStyle")[0][1], "#ff0000");
  assert.ok(names.includes("lineTo"), "a trimmed path is traced as a polyline");
  assert.equal(names.filter((n) => n === "bezierCurveTo").length, 4, "only the rect traces curves; the ellipse is off");
});

test("anchor point and parenting keep the picture where it is", () => {
  const clips = [
    { id: "n", kind: "null", start: 0, duration: 4, props: { x: 100, y: 50, rotation: 90, scale: 2 } },
    { id: "c", kind: "shape", start: 0, duration: 4, props: { x: 40, y: 0, rotation: 10, scale: 1 } },
    { id: "k", kind: "video", start: 0, duration: 4, parent: "c", props: {} },
  ];
  const byId = (id) => clips.find((x) => x.id === id);
  const world = (c, t = 0) => M.mul(M.parentMatrix(c, byId, t), M.layerMatrix(c, M.transformAt(c, t)));
  const w0 = world(clips[1]);
  Object.assign(clips[1].props, M.reparentValues(clips[1], "n", byId, 0));
  clips[1].parent = "n";
  const w1 = world(clips[1]);
  w0.forEach((v, i) => near(v, w1[i], 1e-3));
  near(clips[1].props.scale, 0.5, 1e-4);
  // the grandchild follows through the chain
  assert.deepEqual(M.parentChain(clips[2], byId).map((x) => x.id), ["c", "n"]);
  assert.equal(M.wouldCycle("n", "k", byId), true, "a parent cannot become its descendant's child");
  // moving the anchor keeps the picture still
  const p = { x: 10, y: 20, rotation: 30, scale: 1.5 };
  const before = M.layerMatrix({ kind: "shape" }, p);
  const moved = { ...p, ...M.anchorMoveValues({ kind: "shape" }, p, 40, -20) };
  const after = M.layerMatrix({ kind: "shape" }, moved);
  for (const [x, y] of [[0, 0], [100, 50]]) {
    const a = M.apply(before, x, y), b = M.apply(after, x, y);
    near(a[0], b[0], 1e-3); near(a[1], b[1], 1e-3);
  }
  // a boxed title ignores scale; keyframed parents are read at the time asked
  assert.equal(M.contentScale({ kind: "text" }, { scale: 3, boxW: 100, boxH: 50 }), 1);
  clips[0].keyframes = { x: [{ t: 0, v: 0 }, { t: 2, v: 200, ease: "linear" }] };
  near(M.transformAt(clips[0], 1).x, 100);
  near(M.transformAt(clips[0], 9).x, 200, 1e-9);
});

test("a split carries shape keys into the right half, re-based", () => {
  const doc = {
    tracks: [{ id: "V1", kind: "video" }], media: [],
    clips: [{ id: "s", kind: "shape", mediaId: null, track: "V1", start: 0, in: 0, duration: 4, parent: "n",
      props: { shapes: M.normalizeShapes([{ type: "rect", keys: [{ t: 0, trimEnd: 0 }, { t: 2, trimEnd: 100, ease: "linear" }] }]) } }],
  };
  const r = E.forDoc(doc).splitAt(1, [doc.clips[0]]);
  const right = r.rights[0];
  assert.equal(right.parent, "n", "the right half keeps its parent");
  assert.deepEqual(right.props.shapes[0].keys, [{ t: 0, trimEnd: 50 }, { t: 1, trimEnd: 100, ease: "linear" }]);
  assert.equal(doc.clips[0].props.shapes[0].keys.length, 2, "the left half is untouched");
});

const motionProject = () => ({
  name: "Motion", width: 1280, height: 720, fps: 30, revision: 1,
  media: [{ id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 }],
  clips: [
    { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 5, props: { x: 100 } },
    { id: "c_l", mediaId: "m_a", kind: "video", track: "V1", start: 5, in: 0, duration: 5, locked: true },
  ],
});

test("agent: shape and null clips, setShape / removeShape, setParent and the compact view", async (t) => {
  const dir = makeDataDir(t, motionProject());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const clip = (id) => readProject(dir).clips.find((c) => c.id === id);

  let r = await patch(
    { op: "addClip", clip: { id: "c_s", kind: "shape", track: "V2", start: 0, duration: 5, props: { shapes: [{ type: "ellipse", fill: "#7b6cff" }] } } },
    { op: "addClip", clip: { id: "c_n", kind: "null", track: "V3", start: 0, duration: 5, props: { x: 200 } } },
    { op: "setShape", id: "c_s", shape: "Bar", set: { type: "rect", w: 400, h: 20, keys: [{ t: 0, trimEnd: 0 }, { t: 1, trimEnd: 100 }] } },
    { op: "setShape", id: "c_s", set: { type: "group", items: [{ type: "star" }] } },
    { op: "setShape", id: "c_s", shape: "2.1", set: { type: "line", stroke: "#ff0000" } });
  assert.equal(r.isError, false, r.text);
  assert.equal(clip("c_s").mediaId, null);
  let shapes = clip("c_s").props.shapes;
  assert.equal(shapes.length, 3);
  assert.equal(shapes[1].name, "Bar");
  assert.equal(shapes[2].items[1].type, "line", "a path adds into a group");
  r = await patch({ op: "setShape", id: "c_s", shape: "Bar", set: { fill: "#00ff00" } }, { op: "setShape", id: "c_s", shape: 0, set: { type: "polygon" } });
  assert.equal(r.isError, false, r.text);
  shapes = clip("c_s").props.shapes;
  assert.equal(shapes[1].fill, "#00ff00");
  assert.equal(shapes[1].w, 400, "set merges key by key");
  assert.equal(shapes[0].type, "polygon");
  assert.equal(shapes[0].fill, "#7b6cff", "a new type keeps the paint");
  r = await patch({ op: "removeShape", id: "c_s", shape: "2.0" });
  assert.equal(clip("c_s").props.shapes[2].items.length, 1);

  // refusals
  r = await patch({ op: "setShape", id: "c_s", set: { w: 10 } });
  assert.match(r.text, /a new shape needs set\.type/);
  r = await patch({ op: "setShape", id: "c_s", shape: 9, set: { type: "rect" } });
  assert.match(r.text, /use index 3/);
  r = await patch({ op: "setShape", id: "c_a", set: { type: "rect" } });
  assert.match(r.text, /video clip — shapes go on shape clips/);
  r = await patch({ op: "setShape", id: "c_s", shape: 0, set: { sides: 99 } });
  assert.match(r.text, /sides must be a whole number/);
  r = await patch({ op: "updateClip", id: "c_s", set: { props: { shapes: [{ type: "rect", oops: 1 }] } } });
  assert.match(r.text, /props\.shapes\[0\]\.oops/);

  // parenting keeps the clip where it is; loops and missing clips are refused
  r = await patch({ op: "setParent", id: "c_a", parent: "c_n" });
  assert.equal(r.isError, false, r.text);
  assert.equal(clip("c_a").parent, "c_n");
  assert.equal(clip("c_a").props.x, -100, "x is now relative to the null");
  r = await patch({ op: "setParent", id: "c_n", parent: "c_a" });
  assert.match(r.text, /makes a loop/);
  r = await patch({ op: "setParent", id: "c_s", parent: "c_nope" });
  assert.match(r.text, /is not a clip/);
  r = await patch({ op: "setParent", id: "c_l", parent: "c_n" });
  assert.match(r.text, /locked/);
  r = await patch({ op: "updateClip", id: "c_s", set: { parent: "c_s" } });
  assert.match(r.text, /makes a loop/);

  const compact = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(compact.text, /c_a V1 .* parent:c_n/);
  assert.match(compact.text, /c_s V2 .*shape \[4 shapes: polygon\(6\) #7b6cff, "Bar" rect #00ff00 2 keys, group\(line stroke #ff0000\/8\)\]/);
  assert.match(compact.text, /c_n V3 .* null \{"x":200\}/);

  // removing a parent leaves its children where they were
  r = await patch({ op: "removeClip", id: "c_n" });
  assert.equal(r.isError, false, r.text);
  assert.equal(clip("c_a").parent, undefined);
  assert.equal(clip("c_a").props.x, 100);
});

test("deleting a parent leaves its children in place, under the nearest ancestor that stays", () => {
  const doc = {
    tracks: [{ id: "V3", kind: "video" }, { id: "V2", kind: "video" }, { id: "V1", kind: "video" }], media: [],
    clips: [
      { id: "g", kind: "null", mediaId: null, track: "V3", start: 0, in: 0, duration: 4, props: { x: 100, rotation: 90 } },
      { id: "n", kind: "null", mediaId: null, track: "V2", start: 0, in: 0, duration: 4, parent: "g", props: { x: 50, scale: 2 } },
      { id: "c", kind: "shape", mediaId: null, track: "V1", start: 0, in: 0, duration: 4, parent: "n", props: { x: 10, y: 20 } },
    ],
  };
  const byId = (id) => doc.clips.find((x) => x.id === id);
  const world = (c) => M.mul(M.parentMatrix(c, byId, 0), M.layerMatrix(c, M.transformAt(c, 0)));
  const before = world(byId("c"));
  E.forDoc(doc).removeClips([byId("n")]);
  const c = byId("c");
  assert.equal(c.parent, "g", "re-parented to the grandparent");
  world(c).forEach((v, i) => near(v, before[i], 1e-3));
  E.forDoc(doc).rippleDelete([byId("g")]);
  assert.equal(c.parent, undefined, "no ancestor left: unparented");
  world(c).forEach((v, i) => near(v, before[i], 1e-3));
});

test("motion paths: curved position keys, arc-length pacing, auto-orient, smooth and straight", () => {
  const kf = () => ({
    x: [{ t: 0, v: -300 }, { t: 2, v: 300, ease: "linear" }],
    y: [{ t: 0, v: 0, pout: -300 }, { t: 2, v: 0, pin: -300, ease: "linear" }],
  });
  const clip = { start: 0, duration: 2, keyframes: kf(), props: {} };
  assert.equal(M.posKeys(clip).length, 2);
  assert.equal(M.hasPathHandles(clip), true);
  const mid = M.positionAt(clip, 1);
  near(mid.x, 0, 1e-6); near(mid.y, -225, 0.5);   // the top of the arch
  near(M.orientAt(clip, 1), 0, 0.5);              // travelling right at the top
  assert.ok(M.orientAt(clip, 0.1) < -45, "climbing at the start");
  // pacing is along the curve: equal times cover equal lengths on a linear key
  const travelled = (a, b) => {   // distance along the path between two times
    let d = 0, prev = M.positionAt(clip, a);
    for (let i = 1; i <= 200; i++) { const q = M.positionAt(clip, a + (b - a) * i / 200); d += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; }
    return d;
  };
  const legs = [0, 0.5, 1, 1.5].map((t) => travelled(t, t + 0.5));
  for (const l of legs) near(l, legs[0], legs[0] * 0.01);
  // no handles: the channels run exactly as before
  const plain = { keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 100 }], y: [{ t: 0, v: 0 }, { t: 1, v: 0 }] }, props: {} };
  assert.equal(M.pathPositionAt(plain, 0.5), null);
  // an extra x key between two position keys breaks that segment back to the channels
  const broken = { keyframes: { x: [...kf().x, { t: 1, v: 50 }].sort((a, b) => a.t - b.t), y: kf().y }, props: {} };
  assert.equal(M.pathPositionAt(broken, 0.5), null);
  const sm = M.smoothPath({ x: [{ t: 0, v: 0 }, { t: 1, v: 100 }, { t: 2, v: 200 }], y: [{ t: 0, v: 0 }, { t: 1, v: 100 }, { t: 2, v: 0 }] });
  assert.equal(sm.x[0].pin, undefined, "the first key has no in handle");
  assert.equal(sm.x[1].pout, 33.333);
  assert.equal(M.hasPathHandles({ keyframes: M.straightPath(sm) }), false);
  // a parent on a curved path carries its children along it
  const parent = { id: "p", start: 0, duration: 2, keyframes: kf(), props: { autoOrient: true } };
  const tr = M.transformAt(parent, 1);
  near(tr.y, -225, 0.5); near(tr.rotation, 0, 0.5);
});

test("text paths: validation, presets and the arc-length sampler", () => {
  const circle = M.normalizeTextPath(M.TEXT_PATH_PRESETS.circle, true);
  assert.equal(circle.type, "ellipse");
  assert.equal(circle.fill, undefined, "a text path carries no paint");
  assert.equal(M.normalizeTextPath({ points: [[0, 0], [10, 0]] }).closed, false, "a path defaults to open");
  assert.throws(() => M.normalizeTextPath({ type: "group" }, true), /type must be/);
  assert.throws(() => M.normalizeTextPath({ type: "line", stroke: "#fff" }, true), /no paint/);
  const s = M.pathSampler(M.outline(M.normalizeItem({ type: "line", points: [[0, 0], [100, 0]] })).A, false);
  near(s.length, 100, 1e-6);
  assert.deepEqual([s.at(25).x, s.at(25).y, s.at(25).angle], [25, 0, 0]);
  near(s.at(120).x, 120, 1e-6, "runs on straight past an open end");
  const ring = M.pathSampler(M.outline(circle).A, true);
  near(ring.at(ring.length * 1.25).x, ring.at(ring.length * 0.25).x, 1e-6);   // a closed path wraps
});

test("a split keeps the motion path's handles on both halves", () => {
  const doc = { tracks: [{ id: "V1", kind: "video" }], media: [], clips: [{ id: "s", kind: "shape", mediaId: null, track: "V1", start: 0, in: 0, duration: 4,
    props: {}, keyframes: { x: [{ t: 0, v: 0, pout: 50 }, { t: 3, v: 300, pin: -50 }], y: [{ t: 0, v: 0, pout: -80 }, { t: 3, v: 0, pin: -80 }] } }] };
  const right = E.forDoc(doc).splitAt(3.5, [doc.clips[0]]).rights[0];
  assert.equal(doc.clips[0].keyframes.x[0].pout, 50);
  assert.ok(right, "split happened");
});

test("agent: setMotionPath, setTextPath, motion blur props and the compact view", async (t) => {
  const dir = makeDataDir(t, motionProject());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const clip = (id) => readProject(dir).clips.find((c) => c.id === id);
  let r = await patch(
    { op: "addClip", clip: { id: "c_s", kind: "shape", track: "V2", start: 0, duration: 4, props: { shapes: [{ type: "star" }], motionBlur: 180 },
      keyframes: { x: [{ t: 0, v: -300 }, { t: 2, v: 0 }, { t: 4, v: 300 }], y: [{ t: 0, v: 100 }, { t: 2, v: -100 }, { t: 4, v: 100 }] } } },
    { op: "setMotionPath", id: "c_s", path: "smooth", autoOrient: true },
    { op: "addClip", clip: { id: "c_t", kind: "text", track: "V3", start: 0, duration: 4, props: { text: "Round and round" } } },
    { op: "setTextPath", id: "c_t", path: "circle", offset: 25, align: "center" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /c_s\.motionPath\(3 keys, curved, auto-orient\)/);
  assert.equal(clip("c_s").keyframes.x[1].pout, 100);
  assert.equal(clip("c_s").props.autoOrient, true);
  assert.equal(clip("c_t").props.textPath.type, "ellipse");
  assert.equal(clip("c_t").props.pathOffset, 25);
  r = await patch({ op: "setTextPath", id: "c_t", path: { type: "path", points: [[-200, 0], [0, -80, -90, 0, 90, 0], [200, 0]] } });
  assert.equal(r.isError, false, r.text);
  assert.equal(clip("c_t").props.textPath.closed, false);
  r = await patch({ op: "setMotionPath", id: "c_s", path: "straight" });
  assert.equal(clip("c_s").keyframes.x[1].pout, undefined);

  // refusals
  r = await patch({ op: "setMotionPath", id: "c_a", path: "smooth" });
  assert.match(r.text, /needs x and y keyed together/);
  r = await patch({ op: "setTextPath", id: "c_s", path: "arc" });
  assert.match(r.text, /text paths go on text clips/);
  r = await patch({ op: "setTextPath", id: "c_t", path: "spiral" });
  assert.match(r.text, /path is line \| arc \| circle \| wave/);
  r = await patch({ op: "updateClip", id: "c_s", set: { props: { motionBlur: 900 } } });
  assert.match(r.text, /shutter angle 0…720/);
  r = await patch({ op: "updateClip", id: "c_s", set: { keyframes: { x: [{ t: 0, v: 0, pout: "big" }] } } });
  assert.match(r.text, /pout must be a number/);

  await patch({ op: "setMotionPath", id: "c_s", path: "smooth" });
  const compact = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(compact.text, /c_s V2 .*"motionBlur":180.*kf:x\(3\),y\(3\) path:curved/);
  assert.match(compact.text, /c_t V3 .*"textPath":"path\(3\)"/);
});
