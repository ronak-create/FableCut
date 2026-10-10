<!-- Thanks for contributing to FableCut! -->

## What does this PR do?

<!-- A short description of the change and the motivation. Link any related issue. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature (transition / preset / text anim / effect / API)
- [ ] Docs
- [ ] Refactor / internal

## How was it verified?

- [ ] `npm test` passes (CI runs it on Node 18 / 20 / 22)
- [ ] Added or updated a test in `test/` if this touches the MCP surface, the REST API, or the SVG library
- [ ] Opened the editor and confirmed the change in **preview**
- [ ] Confirmed the change in an **export** (fast or realtime), if it affects rendering
- [ ] Updated `CLAUDE.md` / `README.md` if the schema, props, or API changed

## Checklist

See [Shipping a feature](../CONTRIBUTING.md#shipping-a-feature-the-checklist) for the details.

- [ ] No new runtime dependencies added
- [ ] Preview and export render identically (single compositor)
- [ ] Agents can do it too: patch op / MCP tool (+ `manifest.json` tools), validated, respects locks
- [ ] A new shared module is in `index.html` and `docs/demo/sync.js`
- [ ] `CLAUDE.md` updated, then `node docs/docs/build.js` and `node docs/demo/sync.js` rerun
- [ ] README feature list, `docs/llms.txt` and the site feature list mention user-facing features
- [ ] `CHANGELOG.md` entry under Unreleased
- [ ] Commits are focused and messages are descriptive
