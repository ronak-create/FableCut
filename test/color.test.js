/* Color grading: the shared math in color.js (the shader mirrors it — the GPU
   path is checked against gradePixel in a browser by hand), the agent's
   setGrade op, and the fablecut_scopes job protocol. The test plays the
   editor tab itself, like export-jobs.test.js. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const C = require("../color.js");
const { makeDataDir, readProject, seedProject, startServer, startMcp } = require("./helpers");

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: expected ${b}, got ${a}`);

test("a neutral grade is the identity, and normalizeGrade keeps only what differs", () => {
  for (const v of [0, 0.02, 0.18, 0.5, 0.9, 1]) {
    const out = C.gradePixel([v, v * 0.7, 1 - v], {});
    near(out[0], v, 1e-9, "r"); near(out[1], v * 0.7, 1e-9, "g"); near(out[2], 1 - v, 1e-9, "b");
  }
  assert.equal(C.normalizeGrade({ exposure: 0, contrast: 1, lift: [0, 0, 0, 0], saturation: 100 }), null);
  assert.deepEqual(C.normalizeGrade({ exposure: 9, temp: 3, lift: [0, 0, 0.1, 0] }), { exposure: 5, temp: 3, lift: [0, 0, 0.1, 0] }, "clamped + sparse");
  assert.equal(C.normalizeGrade({ on: false }), null, "a bypass with nothing to bypass is dropped");
  assert.ok(C.isNeutral({ exposure: 2, on: false }), "bypassed grades change nothing");
  assert.throws(() => C.normalizeGrade({ nope: 1 }, true), /unknown grade key "nope"/);
  assert.throws(() => C.normalizeGrade({ lift: [0, 0, 0] }, true), /four numbers/);
  assert.deepEqual(C.mergeGrade({ exposure: 1, temp: 5 }, { exposure: null, tint: -4 }), { temp: 5, tint: -4 });
});

test("exposure works in stops of linear light; lift moves black and keeps white", () => {
  const g = C.gradePixel([0.2, 0.2, 0.2], { exposure: 1 });
  near(C.srgbToLinear(g[0]), 2 * C.srgbToLinear(0.2), 1e-9, "+1 stop doubles linear light");
  assert.deepEqual(C.gradePixel([0, 0, 0], { lift: [0, 0, 0, 0.1] }).map((v) => +v.toFixed(6)), [0.1, 0.1, 0.1]);
  assert.deepEqual(C.gradePixel([1, 1, 1], { lift: [0, 0, 0, 0.1] }), [1, 1, 1]);
  near(C.gradePixel([0.5, 0.5, 0.5], { gain: [0, 0, 0, -0.5] })[0], 0.25, 1e-9, "gain multiplies");
  assert.ok(C.gradePixel([0.5, 0.5, 0.5], { gamma: [0, 0, 0, 0.3] })[0] > 0.5, "positive gamma lifts mids");
  near(C.gradePixel([0.435, 0.435, 0.435], { contrast: 1.6 })[0], 0.435, 1e-9, "contrast pivots around the pivot");
  assert.equal(C.gradePixel([0, 0, 0], { contrast: 2 })[0], 0, "…and never crushes below black");
});

test("tone bands act where they should and saturation keeps luma", () => {
  const dark = C.gradePixel([0.2, 0.2, 0.2], { shadows: 50 })[0] - 0.2;
  const bright = C.gradePixel([0.95, 0.95, 0.95], { shadows: 50 })[0] - 0.95;
  assert.ok(dark > 0.05 && bright < 0.01, `shadows lift the darks (${dark}) not the brights (${bright})`);
  assert.ok(C.gradePixel([0.9, 0.9, 0.9], { highlights: -50 })[0] < 0.85);
  const px = [0.7, 0.4, 0.2];
  const y = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  near(y(C.gradePixel(px, { saturation: 150 })), y(px), 1e-9, "saturation is luma-neutral");
  const grey = C.gradePixel(px, { saturation: 0 });
  near(grey[0], grey[2], 1e-9, "saturation 0 is monochrome");
  assert.ok(C.gradePixel([0.99, 0.99, 0.99], { exposure: 2, highSoft: 100 })[0] < 1, "high rolloff keeps whites under clip");
});

test("the white-balance picker neutralizes the sampled colour", () => {
  for (const cast of [[0.6, 0.5, 0.35], [0.35, 0.45, 0.62], [0.55, 0.42, 0.55]]) {
    const wb = C.solveWhiteBalance(cast);
    const out = C.gradePixel(cast, wb);
    assert.ok(Math.max(...out) - Math.min(...out) < 0.01, `${cast} → ${out.map((v) => v.toFixed(3))} with ${JSON.stringify(wb)}`);
  }
});

test("wheels sit on the vectorscope's Cb/Cr plane and carry no luma", () => {
  const rgb = C.wheelToRgb(0.03, 0.08);
  const [cb, cr] = C.rgbToWheel(...rgb);
  near(cb, 0.03, 1e-3, "cb"); near(cr, 0.08, 1e-3, "cr");
  near(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], 0, 1e-3, "pure colour");
  const red = C.vectorTargets().find((t) => t.label === "R");
  assert.ok(red.y < 128 && red.x < 128, "red sits up and left, as on a broadcast vectorscope");
});

test("CPU fallback = per-pixel reference; scopes and stats count the right things", () => {
  const data = new Uint8ClampedArray([255, 0, 0, 255, 10, 10, 10, 255, 200, 200, 200, 255, 0, 0, 0, 0]);
  const g = { exposure: 0.5, lift: [0, 0.02, 0, 0], saturation: 130 };
  const copy = new Uint8ClampedArray(data);
  C.gradeImageData(copy, g);
  for (let i = 0; i < 12; i += 4) {
    const ref = C.gradePixel([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255], g).map((v) => Math.round(v * 255));
    assert.deepEqual([copy[i], copy[i + 1], copy[i + 2]], ref);
  }
  const sc = C.computeScopes(data, 4, 1, ["histogram", "waveform", "parade", "vectorscope"]);
  assert.equal(sc.histogram.y.reduce((a, b) => a + b, 0), 3, "transparent pixels are skipped");
  assert.equal(sc.waveform.data[0 * 256 + Math.round(0.2126 * 255)], 1, "red's luma in column 0");
  assert.equal(sc.parade.data[0][0 * 256 + 255], 1);
  assert.equal(sc.vectorscope.reduce((a, b) => a + b, 0), 3);
  const st = C.scopeStats(data, 4, 1);
  assert.equal(st.pixels, 3);
  assert.equal(st.luma.max, 0.784);
  assert.equal(st.cast.tone, "red", "the red pixel tints the midtones");
  const warm = C.scopeStats(new Uint8ClampedArray([200, 150, 90, 255, 180, 130, 80, 255]), 2, 1);
  assert.match(warm.cast.tone, /orange|yellow/);
});

/* ── agent ops ── */
const graded = () => seedProject({
  media: [{ id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 },
    { id: "m_t", name: "t.wav", kind: "audio", src: "/media/t.wav", duration: 10 }],
  clips: [
    { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 5 },
    { id: "c_b", mediaId: "m_a", kind: "video", track: "V1", start: 5, in: 0, duration: 5, locked: true },
    { id: "c_t", mediaId: "m_t", kind: "audio", track: "A1", start: 0, in: 0, duration: 5 },
    { id: "c_adj", mediaId: null, kind: "adjust", track: "V2", start: 0, duration: 10 },
  ],
});

test("setGrade merges, resets with null, replaces, clears — and respects locks", async (t) => {
  const dir = makeDataDir(t, graded());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const grade = (id) => readProject(dir).clips.find((c) => c.id === id).props?.grade;

  let r = await patch({ op: "setGrade", ids: ["c_a", "c_adj"], grade: { exposure: 0.5, lift: [0, 0, 0.02, -0.01] } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(grade("c_a"), { exposure: 0.5, lift: [0, 0, 0.02, -0.01] });
  assert.deepEqual(grade("c_adj"), grade("c_a"), "adjustment layers take grades");
  r = await patch({ op: "setGrade", id: "c_a", grade: { exposure: null, temp: -20 } });
  assert.deepEqual(grade("c_a"), { lift: [0, 0, 0.02, -0.01], temp: -20 });
  r = await patch({ op: "setGrade", id: "c_a", grade: { saturation: 80 }, replace: true });
  assert.deepEqual(grade("c_a"), { saturation: 80 });
  r = await patch({ op: "setGrade", id: "c_a", grade: null });
  assert.equal(grade("c_a"), undefined);

  r = await patch({ op: "setGrade", id: "c_a", grade: { exposure: 1 } }, { op: "setGrade", id: "c_a", grade: { glow: 2 } });
  assert.equal(r.isError, true);
  assert.match(r.text, /unknown grade key "glow"/);
  assert.equal(grade("c_a"), undefined, "a bad op aborts the whole patch");
  r = await patch({ op: "setGrade", id: "c_t", grade: { exposure: 1 } });
  assert.match(r.text, /audio clip/);
  r = await patch({ op: "setGrade", id: "c_b", grade: { exposure: 1 } });
  assert.equal(r.isError, true);
  assert.match(r.text, /locked/);
  r = await patch({ op: "setGrade", id: "c_b", grade: { exposure: 1 }, force: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(grade("c_b"), { exposure: 1 });
});

test("fablecut_scopes hands a scopes job to the tab and reports its measurement", async (t) => {
  const dir = makeDataDir(t, seedProject({ revision: 3 }));
  const { base, port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1", FABLECUT_CHROME: path.join(dir, "no-such-browser") });
  const tickets = [];
  let wake = null, buf = "";
  let opened;
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
  await open; // the server counts the tab once its stream is open
  await new Promise((r) => setTimeout(r, 100));
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });

  const pending = mcp.callTool("fablecut_scopes", { time: 2.5, where: "tab" });
  if (!tickets.length) {
    // a refused request resolves pending instead of sending a ticket — fail, don't hang
    const early = await Promise.race([new Promise((r) => { wake = () => r(null); }), pending]);
    assert.equal(early, null, "expected a ticket, got: " + early?.text);
  }
  const ticket = tickets.shift();
  assert.equal(ticket.kind, "scopes");
  assert.equal(ticket.time, 2.5);
  assert.equal(ticket.revision, 3);
  const post = (p, body) => fetch(base + p, { method: "POST", body: body && JSON.stringify(body) });
  assert.equal((await post("/api/export/job/claim?id=" + ticket.id)).status, 200);
  const stats = { pixels: 10, luma: { min: 0, p1: 0.02, median: 0.41, mean: 0.43, p99: 0.97, max: 1 },
    clipped: { blackPct: 0.1, whitePct: 2.5 }, rgbMean: [0.5, 0.4, 0.3], saturation: 0.08, cast: { tone: "orange", hue: 31, strength: 0.05 } };
  await post("/api/export/job/report?id=" + ticket.id, { status: "done",
    result: { time: 2.5, frame: { w: 1280, h: 720 }, stats, clips: [{ id: "c_a", track: "V1", kind: "video", grade: "exposure+0.5" }] } });
  const { text, isError } = await pending;
  assert.equal(isError, false, text);
  assert.match(text, /median 0\.41/);
  assert.match(text, /white 2\.5%/);
  assert.match(text, /orange \(hue 31°\)/);
  assert.match(text, /c_a V1 video grade:exposure\+0\.5/);

  for (const time of [-1, "", false, [], "abc"])
    assert.equal((await post("/api/scopes/request", { time })).status, 400, JSON.stringify(time) + " is not a time");
});

test("curves: monotone, endpoints added, luma curve keeps hue, hue curves wrap", () => {
  const f = C.monotone([[0, 0], [0.3, 0.1], [0.31, 0.9], [1, 1]]);
  let prev = -1;
  for (let i = 0; i <= 200; i++) { const v = f(i / 200); assert.ok(v >= prev - 1e-12, "never dips"); assert.ok(v >= 0 && v <= 1, "no overshoot"); prev = v; }
  assert.deepEqual(C.normalizeGrade({ curves: { y: [[0.25, 0.2]] } }), { curves: { y: [[0, 0], [0.25, 0.2], [1, 1]] } });
  assert.equal(C.normalizeGrade({ curves: { r: [[0.5, 0.5]] }, hueSat: [[90, 1]] }), null, "identity curves are dropped");
  assert.deepEqual(C.normalizeGrade({ hueHue: [[370, 30]] }).hueHue, [[330, 0], [10, 30], [50, 0]].sort((a, b) => a[0] - b[0]), "one point = a ±40° band, wrapped");
  assert.throws(() => C.normalizeGrade({ curves: { w: [[0.5, 0.6]] } }, true), /unknown curve/);
  assert.throws(() => C.normalizeGrade({ hueSat: [[10]] }, true), /\[x, value\]/);

  // luma curve: brighter, same chroma direction (every channel moves by the same amount)
  const src = [0.6, 0.4, 0.2], out = C.gradePixel(src, { curves: { y: [[0.5, 0.6]] } });
  assert.ok(out[0] > src[0], "brighter");
  near(out[0] - src[0], out[2] - src[2], 0.01, "the luma curve adds the same to each channel");
  // a red-channel curve leaves green and blue alone
  const rc = C.gradePixel([0.5, 0.5, 0.5], { curves: { r: [[0.5, 0.7]] } });
  near(rc[0], 0.7, 0.01, "r"); near(rc[1], 0.5, 1e-6, "g"); near(rc[2], 0.5, 1e-6, "b");

  // hue curves: only the targeted hue moves; greys never do
  const blue = C.hsvToRgb(240 / 360, 0.8, 0.8), green = C.hsvToRgb(120 / 360, 0.8, 0.8);
  const desat = C.gradePixel(blue, { hueSat: [[240, 0]] });
  assert.ok(C.rgbToHsv(...desat)[1] < 0.02, "blue desaturated");
  assert.deepEqual(C.gradePixel(green, { hueSat: [[240, 0]] }).map((v) => +v.toFixed(4)), green.map((v) => +v.toFixed(4)), "green untouched");
  near(C.rgbToHsv(...C.gradePixel(blue, { hueHue: [[240, -30]] }))[0] * 360, 210, 1, "hue vs hue shifts the hue");
  assert.ok(C.gradePixel(blue, { hueLuma: [[240, -0.3]] })[2] < blue[2], "hue vs luma darkens");
  assert.deepEqual(C.gradePixel([0.5, 0.5, 0.5], { hueLuma: [[0, -0.3]], hueSat: [[0, 2]] }), [0.5, 0.5, 0.5], "grey has no hue");
  assert.ok(C.gradePixel(blue, { satLuma: [[1, 0.2]] })[2] > blue[2], "sat vs luma lifts saturated colours");
  // a red band reaches across 0°/360°
  assert.ok(C.rgbToHsv(...C.gradePixel(C.hsvToRgb(350 / 360, 0.8, 0.8), { hueSat: [[5, 0]] }))[1] < 0.6, "band wraps");

  assert.equal(C.withoutCurves({ exposure: 1, curves: { y: [[0, 0.1], [1, 1]] }, hueSat: [[0, 0]] }).exposure, 1);
  assert.deepEqual(Object.keys(C.withoutCurves({ exposure: 1, curves: {}, hueSat: [] })), ["exposure"]);
});

test("setGrade sets curves per channel and hue curves, null removes one", async (t) => {
  const dir = makeDataDir(t, graded());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const grade = (id) => readProject(dir).clips.find((c) => c.id === id).props?.grade;

  let r = await patch({ op: "setGrade", id: "c_a", grade: { curves: { y: [[0.25, 0.2], [0.75, 0.8]] }, hueSat: [[220, 1.4]] } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /curves\(y\)/);
  assert.deepEqual(grade("c_a").curves, { y: [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]] });
  assert.equal(grade("c_a").hueSat.length, 3, "one point became a band");
  r = await patch({ op: "setGrade", id: "c_a", grade: { curves: { r: [[0.5, 0.55]] } } });
  assert.deepEqual(Object.keys(grade("c_a").curves), ["y", "r"], "curves merge per channel");
  r = await patch({ op: "setGrade", id: "c_a", grade: { curves: { y: null }, hueSat: null } });
  assert.deepEqual(grade("c_a"), { curves: { r: [[0, 0], [0.5, 0.55], [1, 1]] } });
  r = await patch({ op: "setGrade", id: "c_a", grade: { curves: { r: [[0.5, 0.6, 1]] } } });
  assert.equal(r.isError, true);
  assert.match(r.text, /\[x, value\]/);
});
