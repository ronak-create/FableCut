/* MCP wire protocol: the handshake and JSON-RPC framing every client depends on.
   Regression cover for #58 / #59 — an initialize that echoed a version the
   server does not speak, and handshake edge cases that must not kill the
   process. Each case also proves the server is still alive afterwards, because
   "answered once, then died" is exactly the failure that was reported. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, makeDataDir, startMcp } = require("./helpers");

const SUPPORTED = ["2025-11-25", "2025-06-18", "2024-11-05"];
const LATEST = "2025-11-25";

async function stillAlive(mcp) {
  const pong = await mcp.request("ping", {});
  assert.deepEqual(pong.result, {}, "server should answer ping after the handshake");
}

test("initialize echoes each protocol version the server actually speaks", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  for (const version of SUPPORTED) {
    const res = await mcp.request("initialize", { protocolVersion: version, capabilities: {} });
    assert.equal(res.result.protocolVersion, version, `should echo supported ${version}`);
  }
  await stillAlive(mcp);
});

test("initialize downgrades an unsupported version instead of echoing it", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  for (const bogus of ["2099-01-01", "not-a-version", "2024-01-01", ""]) {
    const res = await mcp.request("initialize", { protocolVersion: bogus, capabilities: {} });
    assert.notEqual(res.result.protocolVersion, bogus,
      `must not claim to speak ${JSON.stringify(bogus)}`);
    assert.equal(res.result.protocolVersion, LATEST);
  }
  await stillAlive(mcp);
});

test("initialize without a version is served on the default and does not kill the server", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  for (const params of [undefined, {}, { capabilities: {} }]) {
    const res = await mcp.request("initialize", params);
    assert.equal(res.result.protocolVersion, LATEST);
  }
  await stillAlive(mcp);
});

test("initialize result carries the capabilities and serverInfo clients read", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  const { result } = await mcp.request("initialize", { protocolVersion: LATEST });
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.serverInfo.name, "fablecut");
  assert.match(result.serverInfo.version, /^\d+\.\d+\.\d+$/);
});

test("the advertised server version tracks package.json", async () => {
  // Drift here means clients report a version the release does not match.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const src = fs.readFileSync(path.join(ROOT, "mcp-server.js"), "utf8");
  const declared = (src.match(/serverInfo:\s*\{[^}]*version:\s*"([^"]+)"/) || [])[1];
  assert.equal(declared, pkg.version,
    "mcp-server.js serverInfo.version and package.json version must be bumped together");
});

test("tools/list advertises well-formed tools", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: LATEST });
  const { result } = await mcp.request("tools/list");
  assert.ok(Array.isArray(result.tools) && result.tools.length > 0);
  for (const tool of result.tools) {
    assert.match(tool.name, /^fablecut_[a-z_]+$/, `odd tool name: ${tool.name}`);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema must be an object schema`);
    for (const req of tool.inputSchema.required || []) {
      assert.ok(tool.inputSchema.properties?.[req],
        `${tool.name} marks "${req}" required but never defines it`);
    }
  }
  // The documented surface must stay present; extra tools are allowed to appear.
  const names = result.tools.map((x) => x.name);
  for (const expected of ["fablecut_status", "fablecut_docs", "fablecut_get_project",
    "fablecut_set_project", "fablecut_patch_project", "fablecut_import_media",
    "fablecut_analyze_reference", "fablecut_frame", "fablecut_encode_profiles"]) {
    assert.ok(names.includes(expected), `missing documented tool ${expected}`);
  }
});

test("every tools/call answer is well-formed content blocks", async (t) => {
  // fablecut_frame answers with an image alongside its text; the rest answer
  // with text only. Whatever a tool returns must reach the client as valid
  // content blocks, and at least one text block must lead so an agent can read
  // what it is looking at without decoding an image.
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: LATEST });
  const { result } = await mcp.request("tools/list");
  for (const tool of result.tools) {
    if (tool.name === "fablecut_status") continue; // spawns the editor server
    const res = await mcp.request("tools/call", { name: tool.name, arguments: {} });
    assert.ok(res.result, `${tool.name} returned no result`);
    const content = res.result.content;
    assert.ok(Array.isArray(content) && content.length, `${tool.name} returned no content blocks`);
    assert.equal(content[0].type, "text", `${tool.name} must lead with a text block`);
    for (const block of content) {
      if (block.type === "text") assert.equal(typeof block.text, "string");
      else if (block.type === "image") {
        assert.match(block.mimeType || "", /^image\//, "an image block needs its mime type");
        assert.match(block.data || "", /^[A-Za-z0-9+/]+={0,2}$/, "image data must be base64");
      } else assert.fail(`${tool.name} returned an unknown block type: ${block.type}`);
    }
  }
  await stillAlive(mcp);
});

test("tools/call on an unknown tool is an error result, not a crash", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: LATEST });
  const { text, isError } = await mcp.callTool("fablecut_does_not_exist", {});
  assert.ok(isError, "unknown tool must be flagged isError");
  assert.match(text, /Unknown tool/i);
  await stillAlive(mcp);
});

test("an unknown method returns JSON-RPC -32601", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  const res = await mcp.request("resources/list");
  assert.equal(res.error.code, -32601);
  assert.equal(res.result, undefined, "an error response must not also carry a result");
  await stillAlive(mcp);
});

test("notifications get no reply", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: LATEST });
  mcp.notify("notifications/initialized", {});
  mcp.notify("notifications/cancelled", { requestId: 999 });
  // Round-trip a real request: anything the notifications wrongly emitted would
  // have arrived by the time this reply does.
  await stillAlive(mcp);
  assert.deepEqual(mcp.unmatched(), [], "notifications must not produce responses");
});
