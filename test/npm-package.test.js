/* The npm package: the `fablecut` command and where an npm install keeps the
   user's work. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");

const run = (args, opts = {}) =>
  spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15_000, ...opts });

test("fablecut -v prints the package version; an unknown command fails with usage", () => {
  const v = run([path.join(ROOT, "cli.js"), "-v"]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), pkg.version);

  const bad = run([path.join(ROOT, "cli.js"), "frobnicate"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /fablecut mcp/);
});

test("package.json exposes the command and ships the files it runs from", () => {
  assert.equal(pkg.bin.fablecut, "cli.js");
  assert.match(fs.readFileSync(path.join(ROOT, "cli.js"), "utf8"), /^#!\/usr\/bin\/env node/);
  // every script the editor page loads must match a `files` entry
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const shipped = (f) => pkg.files.some((p) => p === f || (p === "*.js" && /^[^/]+\.js$/.test(f)) ||
    (p.endsWith("/") && f.startsWith(p)));
  for (const [, f] of html.matchAll(/(?:src|href)="\/?([^"#:?]+)"/g))
    assert.ok(shipped(f), `index.html loads ${f}, which the npm package would not ship`);
  for (const f of ["server.js", "mcp-server.js", "CLAUDE.md", "encoding-profiles.json"])
    assert.ok(shipped(f), `${f} must ship`);
});

test("installed under node_modules, the data folder defaults to ~/FableCut", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-npm-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const app = path.join(tmp, "node_modules", "fablecut");
  fs.mkdirSync(app, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "paths.js"), path.join(app, "paths.js"));
  const home = path.join(tmp, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.FABLECUT_DATA_DIR;
  const probe = "process.stdout.write(require(process.argv[1]).DATA_DIR)";

  const installed = run(["-e", probe, path.join(app, "paths.js")], { env });
  assert.equal(installed.stdout, path.join(home, "FableCut"));

  const overridden = run(["-e", probe, path.join(app, "paths.js")],
    { env: { ...env, FABLECUT_DATA_DIR: path.join(tmp, "elsewhere") } });
  assert.equal(overridden.stdout, path.join(tmp, "elsewhere"), "FABLECUT_DATA_DIR still wins");

  const clone = run(["-e", probe, path.join(ROOT, "paths.js")], { env });
  assert.equal(clone.stdout, ROOT, "a clone keeps its data beside the code");
});
