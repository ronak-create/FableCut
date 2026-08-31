/* Shared harness for the FableCut test suite.

   Every test runs against a throwaway FABLECUT_DATA_DIR and a private port, so
   the suite never touches the developer's real project.json or collides with an
   editor they already have open on 7777. Readiness is always established by
   polling for a real response — never by sleeping for a guessed interval. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

/* A minimal but schema-valid project, used as the starting state for tests. */
function seedProject(over = {}) {
  return {
    name: "Test Project", width: 1280, height: 720, fps: 30, revision: 1,
    media: [{ id: "m_a", name: "a.mp4", kind: "video", src: "/media/a.mp4", duration: 10 }],
    clips: [{ id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 5 }],
    ...over,
  };
}

/* Temp data dir, removed when the test finishes (pass or fail). */
function makeDataDir(t, project = seedProject()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-test-"));
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(project, null, 2));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
const writeProject = (dir, doc) =>
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(doc, null, 2));

/* Ask the OS for a port nobody is using, then release it for the child. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/* Start server.js on its own port + data dir and wait until it actually
   answers. Rejects fast if the child dies instead of hanging until timeout. */
async function startServer(t, dataDir, extraEnv = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: {
        ...process.env, ...extraEnv,
        PORT: String(port), HOST: "127.0.0.1",
        FABLECUT_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let exited = null;
    child.on("exit", (code) => { exited = code; });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    child.stdout.resume();

    const base = `http://127.0.0.1:${port}`;
    const stop = () => new Promise((resolve) => {
      if (exited !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
    });

    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline && exited === null) {
      try {
        const r = await fetch(base + "/api/project");
        if (r.status === 200) { await r.text(); ready = true; break; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (ready) {
      t.after(stop);
      return { base, port, child, stop };
    }
    await stop();
    // A lost port race is the only retryable failure; anything else is a bug.
    if (!/EADDRINUSE/.test(stderr)) {
      throw new Error(`server.js did not become ready (exit=${exited})\n${stderr}`);
    }
  }
  throw new Error("could not find a free port for server.js after 3 attempts");
}

/* A raw HTTP GET that sends the request line and headers verbatim.

   fetch() cannot express these tests: it refuses to set a Host header, and the
   WHATWG URL parser collapses `%2e%2e` before the request leaves the client, so
   a traversal attempt would never reach the server at all. */
function rawGet(port, rawPath, headers = {}) {
  const http = require("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: rawPath, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    req.on("error", reject);
    req.end();
  });
}

/* Line-delimited JSON-RPC client for mcp-server.js over stdio. Responses are
   matched by id, so out-of-order or interleaved replies cannot cross wires. */
function startMcp(t, dataDir, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "mcp-server.js")], {
    cwd: ROOT,
    env: { ...process.env, FABLECUT_DATA_DIR: dataDir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const inbox = [];           // messages with no matching request (notifications)
  let exited = null, stderr = "", buf = "";
  child.on("exit", (code) => {
    exited = code;
    for (const { reject } of pending.values())
      reject(new Error(`mcp-server exited (code ${code}) with the request in flight\n${stderr}`));
    pending.clear();
  });
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); } else inbox.push(msg);
    }
  });

  let nextId = 1;
  const api = {
    child,
    get exited() { return exited; },
    get stderr() { return stderr; },
    /* Unsolicited messages received so far — used to prove notifications get
       no reply, and that nothing extra is written to the wire. */
    unmatched: () => inbox.slice(),
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    request(method, params, { timeout = 15_000 } = {}) {
      if (exited !== null) return Promise.reject(new Error(`mcp-server already exited (${exited})`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for a response to ${method}`));
        }, timeout);
        pending.set(id, {
          resolve: (m) => { clearTimeout(timer); resolve(m); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    /* Convenience: call a tool and return its text payload. */
    async callTool(name, args = {}) {
      const res = await api.request("tools/call", { name, arguments: args });
      assert.ok(res.result, `tools/call ${name} returned no result: ${JSON.stringify(res)}`);
      return { text: res.result.content[0].text, isError: !!res.result.isError };
    },
    stop: () => new Promise((resolve) => {
      if (exited !== null) return resolve();
      child.once("exit", () => resolve());
      child.stdin.end();
      child.kill();
    }),
  };
  t.after(api.stop);
  return api;
}

module.exports = { ROOT, seedProject, makeDataDir, readProject, writeProject, startServer, startMcp, rawGet };
