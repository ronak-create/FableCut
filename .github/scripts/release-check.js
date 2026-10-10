/* Release readiness — what npm, the MCP registry and Glama will see, checked on
   every pull request instead of after a release.

     node .github/scripts/release-check.js                 # the repo checkout
     node .github/scripts/release-check.js --installed DIR # + an installed copy of the npm package

   Checks: one version everywhere it is written · registry / Glama metadata ·
   every root script parses · the MCP server starts over stdio and its tool list
   matches manifest.json · the installed package holds every file the editor
   page and the server load, and its MCP server answers too.
   Zero dependencies, like the rest of the repo. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) { console.error(`${name} needs a folder`); process.exit(2); }
  return v;
};
const INSTALLED = arg("--installed");

let failed = 0;
const ok = (msg) => console.log("  ok  " + msg);
const fail = (msg) => { failed++; console.log("::error::" + msg); };
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad));
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const section = (s) => console.log("\n" + s);

/* ── One version everywhere ── */
section("Versions");
const pkg = readJSON("package.json");
const V = pkg.version;
const server = readJSON("server.json");
const npmPkg = (server.packages || []).find((p) => p.registryType === "npm");
const mcpb = (server.packages || []).find((p) => p.registryType === "mcpb");
const mcpSrc = fs.readFileSync(path.join(ROOT, "mcp-server.js"), "utf8");
const serverInfo = /serverInfo:\s*\{\s*name:\s*"[^"]*",\s*version:\s*"([^"]+)"/.exec(mcpSrc);
const versions = {
  "package.json": V,
  "server.json version": server.version,
  "server.json npm package": npmPkg && npmPkg.version,
  "manifest.json": readJSON("manifest.json").version,
  ".claude-plugin/plugin.json": readJSON(".claude-plugin/plugin.json").version,
  "mcp-server.js serverInfo": serverInfo && serverInfo[1],
};
for (const [where, v] of Object.entries(versions)) check(v === V, `${where} = ${V}`, `${where} is ${v}, package.json is ${V} — bump every version place together`);
if (mcpb) check(mcpb.identifier.includes(`/v${V}/`), "server.json mcpb URL points at this release", `server.json mcpb identifier ${mcpb.identifier} is not the v${V} release`);

/* ── Registry and Glama metadata ── */
section("Registry / Glama metadata");
check(npmPkg && npmPkg.identifier === pkg.name, `server.json npm identifier = ${pkg.name}`, "server.json has no npm package entry matching package.json name");
check(typeof server.name === "string" && /^io\.github\.[^/]+\/.+/.test(server.name), `server.json name ${server.name}`, "server.json name must look like io.github.<owner>/<name>");
check(pkg.mcpName === undefined || pkg.mcpName === server.name, "package.json mcpName matches server.json", `package.json mcpName ${pkg.mcpName} ≠ server.json name ${server.name}`);
check((server.description || "").length > 0 && server.description.length <= 100, "server.json description fits the registry (≤ 100 chars)", `server.json description is ${(server.description || "").length} chars (registry max 100)`);
const glama = readJSON("glama.json");
check(typeof glama.$schema === "string" && Array.isArray(glama.maintainers) && glama.maintainers.length > 0, "glama.json has $schema and maintainers", "glama.json needs $schema and a non-empty maintainers list");
check(fs.existsSync(path.join(ROOT, "LICENSE")) && pkg.license, `LICENSE present (${pkg.license})`, "LICENSE file or package.json license missing");
check(pkg.bin && pkg.bin.fablecut && fs.existsSync(path.join(ROOT, pkg.bin.fablecut)), "package.json bin exists", "package.json bin points at a missing file");
for (const f of ["package.json", "server.json", "manifest.json", "glama.json", ".mcp.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
  try { readJSON(f); ok(`${f} parses`); } catch (e) { fail(`${f}: ${e.message}`); }
}

/* ── Every root script parses ── */
section("Syntax");
const rootJs = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js"));
for (const f of rootJs) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, f)], { encoding: "utf8" });
  check(r.status === 0, `${f}`, `${f} does not parse:\n${r.stderr}`);
}

/* ── MCP server over stdio, the way Glama and clients inspect it ── */
function mcpTools(dir) {
  return new Promise((resolve, reject) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-check-"));
    const child = spawn(process.execPath, [path.join(dir, "mcp-server.js")], {
      cwd: dir, env: { ...process.env, FABLECUT_DATA_DIR: data, FABLECUT_NO_FS_WATCH: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "", err = "";
    const done = (fn, v) => { clearTimeout(timer); child.kill(); try { fs.rmSync(data, { recursive: true, force: true }); } catch { } fn(v); };
    const timer = setTimeout(() => done(reject, new Error("no answer within 20 s\n" + err)), 20000);
    child.stderr.on("data", (c) => { err += c; });
    child.on("exit", (code) => done(reject, new Error(`exited with ${code}\n${err}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { return done(reject, new Error("stdout carried a non-JSON line: " + line.slice(0, 120))); }
        if (msg.id === 1) {
          if (!msg.result || !msg.result.serverInfo) return done(reject, new Error("initialize failed: " + line));
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        } else if (msg.id === 2) {
          if (!msg.result || !Array.isArray(msg.result.tools)) return done(reject, new Error("tools/list failed: " + line));
          done(resolve, msg.result.tools);
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-check", version: "1" } } }) + "\n");
  });
}
function checkTools(label, tools) {
  const manifest = readJSON("manifest.json").tools.map((t) => t.name).sort();
  const names = tools.map((t) => t.name).sort();
  check(names.length > 0, `${label}: ${names.length} tools`, `${label}: no tools listed`);
  const missing = names.filter((n) => !manifest.includes(n)), stale = manifest.filter((n) => !names.includes(n));
  check(!missing.length && !stale.length, `${label}: tools match manifest.json`,
    `${label}: manifest.json tools out of date — add [${missing.join(", ")}], remove [${stale.join(", ")}]`);
  for (const t of tools) {
    if (!t.description || !t.inputSchema || t.inputSchema.type !== "object") fail(`${label}: tool ${t.name} needs a description and an object inputSchema`);
  }
}

/* ── The installed npm package ships what it runs ── */
function checkInstalled(dir) {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const want = new Set(["server.js", "mcp-server.js", "cli.js", "CLAUDE.md", "encoding-profiles.json"]);
  for (const [, f] of html.matchAll(/(?:src|href)="\/?([^"#:?]+)"/g)) if (!/^https?:/.test(f)) want.add(f);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const [, m] of src.matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) want.add(/\.\w+$/.test(m) ? m : m + ".js");
    for (const [, m] of src.matchAll(/(?:addModule|new Worker)\(\s*["']\/?([^"']+\.js)["']/g)) want.add(m);
  }
  const missing = [...want].filter((f) => !fs.existsSync(path.join(dir, f)));
  check(!missing.length, `installed package ships the ${want.size} files the page and server load`,
    `installed package is missing: ${missing.join(", ")} — add them to package.json "files"`);
  const v = spawnSync(process.execPath, [path.join(dir, "cli.js"), "-v"], { encoding: "utf8" });
  check(v.status === 0 && v.stdout.trim() === V, `fablecut -v → ${V}`, `fablecut -v printed "${(v.stdout || v.stderr).trim()}"`);
}

(async () => {
  section("MCP server (repo)");
  try { checkTools("repo", await mcpTools(ROOT)); } catch (e) { fail("repo MCP server: " + e.message); }
  if (INSTALLED) {
    const dir = path.resolve(INSTALLED);
    section(`Installed package (${dir})`);
    checkInstalled(dir);
    try { checkTools("installed", await mcpTools(dir)); } catch (e) { fail("installed MCP server: " + e.message); }
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall release checks passed");
  process.exit(failed ? 1 : 0);
})();
