/* Refresh the playground copy of the editor from the repo root.
   Run:  node docs/demo/sync.js
   The playground is the REAL editor (same index.html / app.js / style.css),
   with one extra script (static-shim.js) loaded first: it answers the /api
   calls from memory so the whole thing runs on GitHub Pages with no server. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = __dirname;

/* index.html: same markup, plus the shim ahead of app.js */
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
html = html
  .replace(/<title>[^<]*<\/title>/, "<title>FableCut playground</title>")
  .replace('<script src="app.js"></script>',
    '<script src="static-shim.js"></script>\n<script src="app.js"></script>');
if (!html.includes("static-shim.js")) {
  console.error("! could not inject the shim - app.js script tag not found");
  process.exit(1);
}
fs.writeFileSync(path.join(OUT, "index.html"), html);

/* app.js and style.css are copied verbatim. Some of these only exist on
   branches that add them, so a missing one is skipped rather than fatal. */
for (const f of ["app.js", "loudness.js", "ducking.js", "silence.js", "beats.js", "transcribe.js", "transcribe-worker.js", "captions.js", "audio-fx.js", "mask.js", "tracker.js", "motion.js", "color.js", "edit-ops.js", "comp.js", "sequences.js", "templates.js", "mp4-demux.js", "media-lib.js", "delivery.js", "fx-worklet.js", "style.css", "favicon.svg", "ruler-worker.js", "meter-worklet.js", "svg-sanitize.js", "credits.js"]) {
  const from = path.join(ROOT, f);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(OUT, f));
}

/* The library files the built-in templates use (the placeholder logo). The
   shim serves /library/… from this folder. */
for (const rel of ["elements/logo-placeholder.svg"]) {
  const to = path.join(OUT, "library", rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "library", rel), to);
}

/* Footage is generated, not borrowed: see make-media.js. It is left alone
   here so a sync never overwrites it. */
const mediaDir = path.join(OUT, "media");
const have = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
if (!have.length) console.log("! docs/demo/media is empty - run: node docs/demo/make-media.js");

console.log("playground synced. media files present:", have.length);
