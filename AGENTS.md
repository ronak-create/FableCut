# Working with FableCut

The complete agent manual is in [CLAUDE.md](CLAUDE.md). Read it before changing the project schema, using the MCP tools, or editing the timeline. This file exists so agents that look for the cross-tool `AGENTS.md` convention, including OpenCode and Codex, find the same source of truth without duplicating it.

## Project constraints

- Keep FableCut zero-runtime-dependency and standard-library only.
- Keep preview and export on the same compositor path.
- Prefer small, focused changes and preserve the existing terse browser-native style.
- If a schema, prop, text animation, API, or MCP surface changes, update `CLAUDE.md` and the English `README.md` in the same change.
- Follow the "Shipping a feature" checklist in [CONTRIBUTING.md](CONTRIBUTING.md#shipping-a-feature-the-checklist): agent parity, docs and site, changelog.
- Run `npm test` and `node .github/scripts/release-check.js` before opening a PR.

## MCP entry point

The local MCP server is `mcp-server.js`. It can be started by any stdio-capable MCP client:

```bash
node /absolute/path/to/FableCut/mcp-server.js
```

Use the existing `CLAUDE.md` recipes and tool descriptions rather than inventing a second protocol or schema.
