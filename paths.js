/* ═══════════════════════════════════════════════════════════════════════════
   Where things live.

   Two roots, because they have different lifetimes:

     APP_DIR   the checked-out code and the assets that ship with it. Read-only
               in practice. When FableCut is installed as a Claude Code plugin
               this directory is pinned to a commit and REPLACED on every update.

     DATA_DIR  the user's work — project.json, imported media, exports, cached
               analysis. Must outlive an update.

   Standalone (`node server.js`) they are the same directory, which is exactly
   how FableCut has always behaved. Set FABLECUT_DATA_DIR to split them; the
   plugin sets it to ${CLAUDE_PLUGIN_DATA}. Installed from npm (the code sits
   under node_modules, e.g. the npx cache) the default is ~/FableCut.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = __dirname;
const FROM_NPM = APP_DIR.split(path.sep).includes("node_modules");
const DATA_DIR = process.env.FABLECUT_DATA_DIR
  ? path.resolve(process.env.FABLECUT_DATA_DIR)
  : FROM_NPM ? path.join(os.homedir(), "FableCut") : APP_DIR;
const SPLIT = DATA_DIR !== APP_DIR;

const MEDIA_DIR = path.join(DATA_DIR, "media");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const ANALYSIS_DIR = path.join(DATA_DIR, "analysis");
const LIBRARY_DIR = path.join(DATA_DIR, "library");
const PROJECT_FILE = path.join(DATA_DIR, "project.json");
const LIBRARY_SUBDIRS = ["sfx", "elements", "svg", "fonts"];

/* The asset library ships with the repo but users also drop their own files in
   (library/sfx is gitignored precisely for that). When the data dir is split
   off, copy the shipped assets across once so the library is populated, then
   leave it alone — a later update re-copies only what the user deleted or has
   never seen, and never clobbers a file they put there. */
function seedLibrary() {
  if (!SPLIT) return;
  const src = path.join(APP_DIR, "library");
  if (!fs.existsSync(src)) return;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) walk(a, b);
      else if (!fs.existsSync(b) || superseded(path.relative(src, a), b)) fs.copyFileSync(a, b);
    }
  };
  walk(src, LIBRARY_DIR);
}

/* Shipped files that a later release replaced. Seeding never overwrites, so
   an old copy has to be recognised to be swapped out: one still byte-identical
   to what we shipped (sha256, first 16 hex) was never edited by the user.
   The fonts in 1.0-1.9.0 were the wrong Unicode subset, with no basic Latin. */
const SUPERSEDED = {
  "fonts/Abril Fatface.woff2": "c7cc6ab22643e87e",
  "fonts/Anton.woff2": "82cc85bd416dc825",
  "fonts/Archivo Black.woff2": "a69dfe4ff8ea7fd2",
  "fonts/Bangers.woff2": "3275f18f37839309",
  "fonts/Barlow.woff2": "d9bb523921d15e2b",
  "fonts/Bebas Neue.woff2": "16c95ce45a2922f5",
  "fonts/Bungee.woff2": "73d615497987a45a",
  "fonts/Caveat.woff2": "f225d05db8fd2872",
  "fonts/DM Sans.woff2": "6406eb05e2eb5077",
  "fonts/Inter.woff2": "1c2db92d3cd9b237",
  "fonts/Lato.woff2": "3a5797f440bc67b5",
  "fonts/Montserrat.woff2": "5cdc3c54c076ef8c",
  "fonts/Oswald.woff2": "cbcfd4dce7316ca4",
  "fonts/Pacifico.woff2": "566fd7603618daf7",
  "fonts/Playfair Display.woff2": "cfbfb0e36791f824",
  "fonts/Poppins.woff2": "58dba357cb1e89bf",
  "fonts/Righteous.woff2": "5cdd7df84db547c5",
  "fonts/Roboto.woff2": "a99e7e70a8225591",
  "fonts/Rubik.woff2": "f60c6ef1b75cff9c",
  "fonts/Teko.woff2": "facad9bed4914ede",
};
function superseded(rel, file) {
  const old = SUPERSEDED[rel.split(path.sep).join("/")];
  if (!old) return false;
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").startsWith(old);
  } catch { return false; }
}

/* Create the writable tree. Safe to call from both servers; whoever runs first
   wins and the other no-ops. */
function ensureDirs() {
  for (const d of [DATA_DIR, MEDIA_DIR, EXPORTS_DIR, ANALYSIS_DIR])
    fs.mkdirSync(d, { recursive: true });
  for (const d of LIBRARY_SUBDIRS)
    fs.mkdirSync(path.join(LIBRARY_DIR, d), { recursive: true });
  seedLibrary();
}

module.exports = {
  APP_DIR, DATA_DIR, SPLIT,
  MEDIA_DIR, EXPORTS_DIR, ANALYSIS_DIR, LIBRARY_DIR, PROJECT_FILE,
  LIBRARY_SUBDIRS, ensureDirs,
};
