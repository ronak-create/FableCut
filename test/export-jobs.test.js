/* Agent-requested exports: POST /api/export/request hands a job to an editor
   tab over SSE; the tab claims it, reports progress and the finished file;
   fablecut_export waits for that and returns the path. The test plays the
   editor tab itself (an SSE reader that claims and reports), so the protocol
   is covered without a browser — the headless launch path needs Chrome and is
   exercised by hand. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeDataDir, seedProject, startServer, startMcp } = require("./helpers");

let HAS_FFMPEG = false;
try { HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; } catch {}
const skip = HAS_FFMPEG ? false : "export requests need ffmpeg on PATH";

/* An open editor tab, as far as the server can tell: an SSE subscriber. */
function fakeTab(t, base) {
  const tickets = [];
  const waiters = [];
  let buf = "";
  const req = http.get(base + "/api/events", (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev !== "export") continue;
        const ticket = JSON.parse(data);
        const w = waiters.shift();
        if (w) w(ticket); else tickets.push(ticket);
      }
    });
  });
  req.on("error", () => {});
  t.after(() => req.destroy());
  return {
    next: () => tickets.length ? Promise.resolve(tickets.shift()) : new Promise((r) => waiters.push(r)),
    connected: async () => {
      // the server counts it once the stream is open
      for (let i = 0; i < 100 && !req.socket?.readyState; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}
const post = (base, p, body) => fetch(base + p, { method: "POST", body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

const boot = async (t, project = seedProject({ revision: 7 })) => {
  const dir = makeDataDir(t, project);
  const srv = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1", FABLECUT_CHROME: path.join(dir, "no-such-browser") });
  return { dir, ...srv };
};

test("where:tab with no editor open is refused, and so is a bad range", { skip }, async (t) => {
  const { base } = await boot(t);
  const r = await post(base, "/api/export/request", { where: "tab" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no editor tab is open/);
  assert.equal((await post(base, "/api/export/request", { range: "half" })).status, 400);
  assert.equal((await post(base, "/api/export/request", { profile: "no-such-profile" })).status, 400);
});

test("with no tab and no browser, auto explains how to get one", { skip }, async (t) => {
  const { base } = await boot(t);
  const r = await post(base, "/api/export/request", {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /FABLECUT_CHROME/);
});

test("a tab claims the job once, reports progress, and fablecut_export returns the file", { skip }, async (t) => {
  const { dir, base, port } = await boot(t);
  const tab = fakeTab(t, base);
  await tab.connected();
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });

  const pending = mcp.callTool("fablecut_export", { range: "entire" });
  const ticket = await tab.next();
  assert.equal(ticket.range, "entire");
  assert.equal(ticket.revision, 7, "the job carries the revision the tab must have loaded");

  assert.equal((await post(base, "/api/export/job/claim?id=" + ticket.id)).status, 200);
  assert.equal((await post(base, "/api/export/job/claim?id=" + ticket.id)).status, 409, "a second tab cannot take it");
  const progress = await post(base, "/api/export/job/report?id=" + ticket.id, { progress: 0.5 });
  assert.deepEqual(progress.body, { cancel: false });
  const job = await fetch(base + "/api/export/job?id=" + ticket.id).then((r) => r.json());
  assert.equal(job.status, "running");
  assert.equal(job.progress, 0.5);

  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  fs.writeFileSync(path.join(dir, "exports", "Test Project.mp4"), Buffer.alloc(2048));
  await post(base, "/api/export/job/report?id=" + ticket.id, { status: "done", src: "/exports/Test%20Project.mp4" });

  const { text, isError } = await pending;
  assert.equal(isError, false, text);
  assert.match(text, /done → .*Test Project\.mp4/);
  assert.ok(text.includes(path.join(dir, "exports")), "the path is on disk, under the data dir");
});

test("one export at a time; a cancel reaches the running tab", { skip }, async (t) => {
  const { dir, base, port } = await boot(t);
  const tab = fakeTab(t, base);
  await tab.connected();
  const first = await post(base, "/api/export/request", { where: "tab" });
  assert.equal(first.status, 200);
  const ticket = await tab.next();
  await post(base, "/api/export/job/claim?id=" + ticket.id);
  const second = await post(base, "/api/export/request", {});
  assert.equal(second.status, 409);
  assert.match(second.body.error, /still running/);

  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const status = await mcp.callTool("fablecut_export", { job: ticket.id });
  assert.match(status.text, /running/, "a status check answers without waiting");
  const cancelled = await mcp.callTool("fablecut_export", { cancel: ticket.id });
  assert.match(cancelled.text, /cancelled/);
  const reply = await post(base, "/api/export/job/report?id=" + ticket.id, { progress: 0.6 });
  assert.deepEqual(reply.body, { cancel: true }, "the tab learns on its next report and stops");
  assert.equal((await post(base, "/api/export/request", { where: "tab" })).status, 200, "and the slot is free again");
});
