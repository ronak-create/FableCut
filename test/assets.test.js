/* Shipped assets and their documented contracts.

   The SVG rules below are not style preferences — each one maps to a way the
   compositor actually fails. Animated SVGs are frozen at time t by injecting
   `*{animation-play-state:paused!important; animation-delay:calc(var(--d,0s) - t)!important}`
   after the opening <svg> tag and rasterising the result through a data: URI
   (see svgUrlAt / loadSvgMedia in app.js). Anything that defeats that
   injection, or that a data: URI cannot load, renders wrongly in preview and
   export alike. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./helpers");

const SVG_DIR = path.join(ROOT, "library", "svg");
const svgFiles = fs.readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg"));

test("there are library SVGs to validate", () => {
  // Guards the suite itself: a glob that silently matches nothing would make
  // every check below vacuously pass.
  assert.ok(svgFiles.length > 0, "no SVGs found — the checks below would be meaningless");
});

test("every library SVG is well-formed and self-contained", () => {
  for (const f of svgFiles) {
    const s = fs.readFileSync(path.join(SVG_DIR, f), "utf8").trim();
    assert.match(s, /^<svg[\s>]|^<\?xml/i, `${f}: does not start with an <svg> root`);
    assert.match(s, /<\/svg>$/, `${f}: truncated — does not end with </svg>`);

    // parseSvgSize() falls back to 800x600 when it cannot find a size, which
    // silently rescales the clip on the canvas.
    assert.match(s, /<svg[^>]*\s(width|viewBox)=/i, `${f}: needs a width/height or viewBox`);

    // Rasterisation happens from a data: URI, which cannot fetch anything.
    assert.doesNotMatch(s, /(?:href|src)\s*=\s*["']https?:/i,
      `${f}: external reference will not load when rasterised from a data: URI`);
  }
});

test("animated library SVGs stay drivable by the compositor clock", () => {
  for (const f of svgFiles) {
    const s = fs.readFileSync(path.join(SVG_DIR, f), "utf8");

    // SMIL is wall-clock driven and ignores the injected CSS entirely, so it
    // would animate in preview and freeze (or drift) in export.
    assert.doesNotMatch(s, /<animate(?:Transform|Motion)?[\s>]/i,
      `${f}: uses SMIL <animate>; CSS @keyframes are required`);

    // The engine's override is !important at specificity (0,0,0). An author
    // !important on a class selector outranks it and pins the animation.
    assert.doesNotMatch(s, /animation-delay\s*:[^;}]*!important/i,
      `${f}: !important animation-delay overrides the compositor's time driver`);
    assert.doesNotMatch(s, /animation-play-state\s*:[^;}]*!important/i,
      `${f}: !important animation-play-state defeats the compositor's pause`);

    // A hardcoded delay is silently discarded by the override, so the author's
    // intended stagger is lost. `--d` is the supported way to express it.
    const delays = s.match(/animation-delay\s*:[^;}]*/gi) || [];
    for (const d of delays) {
      assert.match(d, /var\(\s*--d/,
        `${f}: hardcoded "${d.trim()}" is discarded at render time; set --d on the element instead`);
    }

    // A file that declares --d but has no keyframes is staging a stagger that
    // will never run.
    if (/--d\s*:/.test(s)) {
      assert.match(s, /@keyframes/,
        `${f}: sets --d for a stagger but defines no @keyframes`);
    }
  }
});

test("the documented starter SVGs still ship", () => {
  // CLAUDE.md points authors at these by name as the worked examples.
  for (const named of ["sparkles.svg", "lower-third.svg", "confetti-burst.svg", "underline-swoosh.svg"]) {
    assert.ok(svgFiles.includes(named), `CLAUDE.md cites library/svg/${named} but it is missing`);
  }
});

test("shipped JSON files parse", () => {
  const files = ["package.json", "manifest.json", "glama.json", "project.json"];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;   // optional files stay optional
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, "utf8")), `${f} is not valid JSON`);
  }
});

test("package.json declares no runtime dependencies", () => {
  // The project's headline constraint: `node server.js` must work on a bare
  // clone with no npm install.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {},
    "FableCut must stay zero-runtime-dependency");
  assert.ok(pkg.scripts?.test, "package.json needs a test script so CI can run the suite");
});

test("inspector sliders advertise and handle Ctrl/Cmd-click reset", () => {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.match(app, /els\.inspector\.addEventListener\("pointerdown"/,
    "slider reset is delegated on the inspector, not bound per range");
  assert.match(app, /Ctrl\/Cmd-click: reset to default/);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /inspector label or slider/);
});
