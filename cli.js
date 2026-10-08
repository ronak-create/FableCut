#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   `fablecut` command (npm package).

     fablecut          start the editor  →  http://localhost:7777
     fablecut mcp      run the MCP server on stdio (what agents launch)

   Installed from npm, the user's work lives in ~/FableCut (see paths.js), so
   an update never touches it. FABLECUT_DATA_DIR still overrides.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const cmd = process.argv[2];

if (cmd === "mcp") {
  require("./mcp-server.js");
} else if (!cmd || cmd === "start") {
  require("./server.js");
} else if (cmd === "-v" || cmd === "--version") {
  console.log(require("./package.json").version);
} else {
  const help = cmd === "-h" || cmd === "--help";
  (help ? console.log : console.error)(
    "Usage:\n" +
    "  fablecut          start the editor at http://localhost:7777\n" +
    "  fablecut mcp      run the MCP server on stdio\n" +
    "  fablecut -v       print the version\n\n" +
    "Register with Claude Code:\n" +
    "  claude mcp add -s user fablecut -- npx -y fablecut mcp");
  process.exit(help ? 0 : 1);
}
