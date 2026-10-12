/* Animation presets and templates: the shared logic in templates.js (presets
   relative to the clip, mirrored exits, saving a clip's animation, template
   fields, retiming, saving a comp) and the agent's applyPreset / addTemplate /
   setTemplate / savePreset / saveTemplate ops. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const T = require("../templates.js");
const { makeDataDir, readProject, startMcp } = require("./helpers");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const keys = (c, ch) => c.keyframes[ch].map((k) => [k.t, k.v]);

test("built-in presets and templates are all valid", () => {
  for (const p of T.PRESETS) if (!p.gen) assert.ok(T.normalizePreset(p, true), p.id);
  for (const t of T.TEMPLATES) assert.ok(T.normalizeTemplate(t, true), t.id);
  assert.equal(new Set(T.PRESETS.map((p) => p.id)).size, T.PRESETS.length, "preset ids are unique");
  assert.equal(new Set(T.TEMPLATES.map((t) => t.id)).size, T.TEMPLATES.length, "template ids are unique");
});

test("presets key relative to the clip: in, out, at and loops", () => {
  const c = { id: "c", kind: "text", start: 10, duration: 4, props: { x: 100, y: 50, scale: 2, opacity: 0.8 } };
  T.applyPreset(c, T.findPreset("pop-in"));
  assert.deepEqual(keys(c, "scale"), [[0, 0], [0.25, 2.24], [0.4, 2]], "scale multiplies the clip's own scale");
  assert.deepEqual(keys(c, "opacity"), [[0, 0], [0.12, 0.8]]);
  T.applyPreset(c, T.findPreset("slide-down-out"));
  assert.deepEqual(keys(c, "y"), [[3.4, 50], [4, 170]], "y adds to where the clip sits, ending at its end");
  assert.deepEqual(keys(c, "opacity").slice(-2), [[3.7, 0.8], [4, 0]], "the exit fades from the value the entrance settled on");
  T.applyPreset(c, T.findPreset("pulse"), { at: 2 });
  assert.deepEqual(keys(c, "scale").slice(3), [[2, 2], [2.15, 2.24], [2.4, 2]], "an emphasis sits at the time asked");
  T.applyPreset(c, T.findPreset("pop-in"), { length: 0.8 });
  assert.deepEqual(keys(c, "scale").slice(0, 3), [[0, 0], [0.5, 2.24], [0.8, 2]], "length stretches it; its old keys in that window are replaced");
  const s = { id: "s", kind: "shape", start: 0, duration: 5, props: { rotation: 10 } };
  T.applyPreset(s, T.findPreset("spin"));
  assert.deepEqual(keys(s, "rotation"), [[0, 10], [5, 370]], "a loop spans the clip, from its own rotation");
  T.applyPreset(s, T.findPreset("wiggle"));
  const w = s.keyframes.x;
  assert.equal(w[0].v, 0); assert.equal(w[w.length - 1].v, 0); near(w[w.length - 1].t, 5);
  assert.ok(w.every((k) => Math.abs(k.v) <= 10), "wiggle stays within 10 px");
  const short = { id: "q", kind: "image", start: 0, duration: 0.2, props: {} };
  T.applyPreset(short, T.findPreset("drop-in"));
  near(short.keyframes.y[short.keyframes.y.length - 1].t, 0.2, 1e-4);   // squeezed into a short clip
});

test("exits mirror their entrances, eases flipped", () => {
  const out = T.findPreset("pop-out");
  assert.deepEqual(out.keys.scale, [{ t: 0, v: 1 }, { t: 0.15, v: 1.12 }, { t: 0.4, v: 0, ease: "ease-in" }]);
  assert.deepEqual(T.findPreset("slide-left-out").keys.x.map((k) => k.v), [0, -400], "slide out to the left goes left");
  assert.equal(T.findPreset("Pop in").id, "pop-in", "found by name too");
});

test("a clip's animation saved as a preset plays the same on another clip", () => {
  const a = { id: "a", kind: "text", start: 0, duration: 3, props: { x: 200, opacity: 1 },
    keyframes: { x: [{ t: 0, v: -300 }, { t: 0.6, v: 200, ease: "ease-out" }], opacity: [{ t: 0, v: 0 }, { t: 0.3, v: 1 }] } };
  const p = T.presetFromClip(a, { name: "Fly in", anchor: "in", from: 0, to: 0.6 });
  assert.deepEqual(p.keys.x, [{ t: 0, v: -500 }, { t: 0.6, v: 0, ease: "ease-out" }], "relative to where it lands");
  const b = { id: "b", kind: "image", start: 0, duration: 5, props: { x: -50, opacity: 0.5 } };
  T.applyPreset(b, p);
  assert.deepEqual(keys(b, "x"), [[0, -550], [0.6, -50]]);
  assert.deepEqual(keys(b, "opacity"), [[0, 0], [0.3, 0.5]]);
  assert.throws(() => T.presetFromClip({ id: "n", duration: 2, props: {} }, { name: "x" }), /no keyframes/);
  assert.throws(() => T.normalizePreset({ name: "x", anchor: "in", length: 1, keys: { volume: [{ t: 0, v: 1 }] } }, true), /can't be animated/);
  assert.throws(() => T.normalizePreset({ name: "x", anchor: "in", length: 1, keys: { x: [{ t: 2, v: 1 }] } }, true), /times run 0…1/);
  assert.throws(() => T.normalizePreset({ name: "x", anchor: "sideways", length: 1, keys: { x: [{ t: 0, v: 1 }] } }, true), /anchor/);
});

test("templates: fields, their own comp, shared media and retiming", () => {
  const doc = { width: 1280, height: 720, media: [], comps: [], clips: [] };
  const { comp, clip } = T.instantiate(doc, T.findTemplate("lower-third-bar"), { compId: "lt1", clipId: "k1", start: 3, track: "V3", fields: { name: "Kim Lee", accent: "#ff0000" } });
  assert.equal(doc.comps.length, 1);
  assert.deepEqual([clip.kind, clip.compId, clip.start, clip.duration, clip.track, clip.props.fit], ["comp", "lt1", 3, 5, "V3", "contain"]);
  assert.equal(comp.clips.find((c) => c.id === "name").props.text, "Kim Lee");
  assert.equal(comp.clips.find((c) => c.id === "bar").props.shapes[1].fill, "#ff0000");
  assert.deepEqual(comp.template.fields.map((f) => [f.key, f.value]),
    [["name", "Kim Lee"], ["title", "Director of Photography"], ["accent", "#ff0000"], ["panel", "#111827e6"]]);
  const two = T.instantiate(doc, T.findTemplate("lower-third-bar"), { compId: "lt2" });
  assert.equal(two.comp.name, "Lower third — Bar 2");
  assert.equal(two.comp.clips.find((c) => c.id === "name").props.text, "Ava Moreno", "each copy has its own text");

  // a logo template brings its placeholder once, and takes the user's picture
  T.instantiate(doc, T.findTemplate("logo-ring"), { compId: "lg1" });
  T.instantiate(doc, T.findTemplate("logo-lines"), { compId: "lg2" });
  assert.equal(doc.media.length, 1, "the placeholder is shared");
  doc.media.push({ id: "m_png", name: "brand.png", kind: "image", src: "/media/brand.png" }, { id: "m_wav", name: "a.wav", kind: "audio", src: "/media/a.wav" });
  const lg = doc.comps.find((c) => c.id === "lg1");
  T.setField(lg, "logo", "m_png", doc);
  const logo = lg.clips.find((c) => c.id === "logo");
  assert.deepEqual([logo.mediaId, logo.kind], ["m_png", "image"], "an svg logo replaced by a png becomes an image clip");
  assert.throws(() => T.setField(lg, "logo", "m_wav", doc), /needs a picture/);
  assert.throws(() => T.setField(lg, "accent", "red", doc), /colour like/);
  assert.throws(() => T.setField(lg, "nope", "x", doc), /has no field nope/);

  // longer holds longer: the exit keeps its distance from the end
  const bx = T.instantiate(doc, T.findTemplate("lower-third-boxes"), { compId: "bx", duration: 8 }).comp;
  const nameBox = bx.clips.find((c) => c.id === "nameBox");
  assert.equal(bx.duration, 8);
  assert.deepEqual(nameBox.keyframes.x.map((k) => k.t), [0, 0.45, 7.55, 8]);
  near(bx.clips.find((c) => c.id === "titleBox").start, 0.12);
  near(bx.template.hold, 7.5);
  assert.throws(() => T.retime(bx, 1), /can't be shorter than/);
  T.retime(bx, 5);
  assert.deepEqual(nameBox.keyframes.x.map((k) => k.t), [0, 0.45, 4.55, 5], "and back again");
  const lt = doc.comps.find((c) => c.id === "lt1");
  T.retime(lt, 6.5);
  assert.deepEqual(lt.clips.map((c) => +(c.start + c.duration).toFixed(4)), [6.5, 6.5, 6.5], "clips that ran to the end still do");
});

test("templateFromComp: titles and pictures become fields; bad templates are refused", () => {
  const comp = { id: "k", name: "Promo", width: 1080, height: 1080, duration: 4, clips: [
    { id: "h", kind: "text", name: "Headline", track: "V2", start: 0, duration: 4, props: { text: "Hi" } },
    { id: "p", kind: "image", name: "Photo", mediaId: "m1", track: "V1", start: 0, duration: 4, props: {} },
    { id: "s", kind: "shape", track: "V3", start: 0, duration: 4, props: { shapes: [] } }] };
  const t = T.templateFromComp(comp, { media: [{ id: "m1", name: "a.jpg", kind: "image", src: "/media/a.jpg" }, { id: "m2", kind: "image", src: "/media/b.jpg" }] });
  assert.deepEqual(t.fields.map((f) => [f.key, f.type, f.targets[0]]), [["headline", "text", "h:props.text"], ["photo", "media", "p:mediaId"]]);
  assert.deepEqual(t.media.map((m) => m.id), ["m1"], "only the media it uses");
  assert.equal(t.group, "Saved");
  assert.throws(() => T.normalizeTemplate({ ...t, fields: [{ key: "x", type: "text", targets: ["ghost:props.text"] }] }, true), /must exist/);
  assert.throws(() => T.normalizeTemplate({ ...t, fields: [{ key: "x", type: "text", targets: ["h:__proto__.x"] }] }, true), /must exist/);
  assert.throws(() => T.normalizeTemplate({ ...t, media: [{ id: "m", kind: "image", src: "C:/secret.png" }] }, true), /media entries/);
  assert.throws(() => T.normalizeTemplate({ ...t, width: 5 }, true), /width/);
});

const project = () => ({
  name: "Tpl", width: 1280, height: 720, fps: 30, revision: 1,
  media: [{ id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 }, { id: "m_png", name: "logo.png", kind: "image", src: "/media/logo.png" }, { id: "m_w", name: "vo.wav", kind: "audio", src: "/media/vo.wav", duration: 4 }],
  clips: [
    { id: "c_v", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 6 },
    { id: "c_t", kind: "text", track: "V2", start: 1, duration: 3, props: { text: "Hi", x: 40, y: -20 } },
    { id: "c_a", mediaId: "m_a", kind: "audio", track: "A1", start: 0, in: 0, duration: 6 },
    { id: "c_l", kind: "text", track: "V3", start: 0, duration: 2, locked: true, props: { text: "locked" } },
  ],
});

test("agent: applyPreset, addTemplate, setTemplate, savePreset, saveTemplate", async (t) => {
  const dir = makeDataDir(t, project());
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const patch = (...ops) => mcp.callTool("fablecut_patch_project", { ops });
  const doc = () => readProject(dir);
  const clip = (id) => doc().clips.find((c) => c.id === id);

  let r = await patch({ op: "applyPreset", id: "c_t", preset: "slide-up-in" }, { op: "applyPreset", id: "c_t", preset: "pulse", at: 2.5 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(clip("c_t").keyframes.y.map((k) => [k.t, k.v]), [[0, 100], [0.6, -20]]);
  assert.deepEqual(clip("c_t").keyframes.scale.map((k) => k.t), [1.5, 1.65, 1.9], "at is timeline time");

  r = await patch(
    { op: "addTemplate", template: "lower-third-underline", id: "c_lt", compId: "lt", start: 1, track: "V3", fields: { name: "Kim Lee", title: "Editor" }, duration: 7 },
    { op: "addTemplate", template: "logo-ring", id: "c_logo", compId: "lg", start: 0, track: "V2", fields: { logo: "m_png" } });
  assert.equal(r.isError, false, r.text);
  const lt = doc().comps.find((c) => c.id === "lt");
  assert.equal(lt.clips.find((c) => c.id === "name").props.text, "Kim Lee");
  assert.equal(lt.duration, 7);
  assert.equal(clip("c_lt").duration, 7);
  assert.equal(doc().comps.find((c) => c.id === "lg").clips.find((c) => c.id === "logo").kind, "image");
  assert.ok(doc().media.some((m) => m.src === "/library/elements/logo-placeholder.svg"), "the placeholder logo was registered");

  r = await patch({ op: "setTemplate", id: "c_lt", fields: { accent: "#00ff88" }, duration: 4 });
  assert.equal(r.isError, false, r.text);
  assert.equal(doc().comps.find((c) => c.id === "lt").clips.find((c) => c.id === "rule").props.shapes[0].stroke, "#00ff88");
  assert.equal(clip("c_lt").duration, 4, "the clip follows the template's new length");

  const compact = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(compact.text, /template lower-third-underline — fields \(setTemplate\): name="Kim Lee" title="Editor" accent="#00ff88"/);

  // saving to the library, then using it by name in a later patch
  r = await patch({ op: "savePreset", id: "c_t", name: "My slide", anchor: "in" }, { op: "saveTemplate", comp: "lt", name: "Studio lower third" });
  assert.equal(r.isError, false, r.text);
  const lib = path.join(dir, "library");
  assert.ok(fs.existsSync(path.join(lib, "presets", "my-slide.json")));
  assert.ok(fs.existsSync(path.join(lib, "templates", "studio-lower-third.json")));
  r = await patch({ op: "saveTemplate", comp: "lg" }, { op: "savePreset", preset: { name: "Pop in", anchor: "in", length: 1, keys: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } } });
  assert.match(r.text, /saved template logo-ring-reveal-saved .* saved preset pop-in-saved/, "a built-in's name gets \"(saved)\" so both stay reachable");
  r = await patch({ op: "applyPreset", id: "c_v", preset: "My slide" }, { op: "addTemplate", template: "studio-lower-third", id: "c_lt2", start: 5, track: "V3", fields: { name: "Sam" } });
  assert.equal(r.isError, false, r.text);
  assert.ok(clip("c_v").keyframes.y, "the saved preset applied");
  assert.equal(doc().comps.find((c) => c.id === clip("c_lt2").compId).clips.find((c) => c.id === "name").props.text, "Sam");

  // inside a comp
  r = await patch({ op: "inComp", comp: "lt", ops: [{ op: "applyPreset", id: "title", preset: "fade-in" }] });
  assert.equal(r.isError, false, r.text);
  assert.ok(doc().comps.find((c) => c.id === "lt").clips.find((c) => c.id === "title").keyframes.opacity);

  // refusals change nothing
  const before = JSON.stringify(doc());
  for (const [op, why] of [
    [{ op: "applyPreset", id: "c_t", preset: "moonwalk" }, /no preset "moonwalk" — built in: fade-in/],
    [{ op: "applyPreset", id: "c_a", preset: "fade-in" }, /presets animate visual clips/],
    [{ op: "applyPreset", id: "c_l", preset: "fade-in" }, /locked/],
    [{ op: "addTemplate", template: "nope" }, /no template "nope"/],
    [{ op: "addTemplate", template: "logo-ring", fields: { logo: "m_w" } }, /needs a picture/],
    [{ op: "setTemplate", id: "c_v" }, /no template clip or comp/],
    [{ op: "setTemplate", id: "c_lt", fields: { accent: "teal" } }, /colour like/],
    [{ op: "savePreset", id: "c_v", name: "x", anchor: "sideways" }, /anchor is/],
  ]) {
    r = await patch({ op: "applyPreset", id: "c_t", preset: "fade-in" }, op);
    assert.match(r.text, why);
  }
  assert.equal(JSON.stringify(doc()), before, "a refused patch saves nothing");
});
