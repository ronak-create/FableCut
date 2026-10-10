# Contributing to FableCut

Thanks for your interest in FableCut! This is a zero-dependency, single-purpose
project, and contributions of all sizes are welcome — bug reports, new
transitions, filter presets, animated SVG starters, docs, or core engine work.

## Ground rules

- **No runtime dependencies.** FableCut ships as plain HTML/CSS/JS + a Node
  standard-library server. Please keep it that way — no `npm install` should ever
  be required to run the editor. Dev-only tooling in `devDependencies` is fine if
  it earns its place.
- **One compositor.** Preview and export share the same `drawFrame(t)` code path.
  Any visual feature must render identically in both — never fork the renderer.
- **Match the surrounding style.** Terse, no framework, no build step. Look at how
  neighbouring code reads and follow it.

## Getting set up

```bash
git clone https://github.com/ronak-create/FableCut.git
cd FableCut
node server.js        # → http://localhost:7777
```

Requirements: **Node 18+**, a Chromium-based browser, and (optional but
recommended) **ffmpeg on PATH** for fast export and upload remuxing.

## Where things live

| File | What it is |
| --- | --- |
| `server.js` | HTTP server: static hosting, REST API, SSE, ffmpeg export pipeline |
| `app.js` | The editor — timeline UI, compositor, keyframes, text engine, SVG rasterizer, chroma key, exporters |
| `index.html` / `style.css` | Single-page UI + dark theme |
| `mcp-server.js` | stdio MCP server exposing the editor to AI agents |
| `CLAUDE.md` | The agent manual — schema, semantics, recipes. **Keep this in sync with any schema change.** |

## Making a change

1. Fork and branch from `main` (`git checkout -b my-feature`).
2. Make your change. Keep commits focused.
3. **Run the test suite** before pushing:
   ```bash
   npm test          # node --test — no install needed, no dependencies
   ```
   It covers the MCP protocol and tools, the REST API and its path/Host guards,
   and the shipped SVG library. CI runs the same command on Node 18, 20 and 22
   for every pull request. Add a test with your change when it touches any of
   those surfaces — see [`test/`](test/) and the harness in `test/helpers.js`
   (every test gets a throwaway data dir and its own port, so the suite never
   touches your real `project.json`).

   Then open the editor and confirm your change renders in **both** preview and a
   test export — the compositor itself runs in the browser and is not covered by
   the suite.
4. If you touched the `project.json` schema, props, transitions, text anims, or
   the API, **update `CLAUDE.md` and the `README.md` feature list** in the same PR.
5. Open a pull request against `main` using the PR template. Describe what changed
   and how you verified it.

## Shipping a feature: the checklist

FableCut is published in several places (npm, the MCP registry, the `.mcpb`
bundle, the Claude Code plugin, Glama, the website and its playground), and
an agent reads the same manual a person does. A feature is done when all of
these agree. CI's **Release readiness** job checks the starred (★) items for you.

**The code**
- Preview and export go through the same compositor path; check both by hand.
- A new shared module (UMD, like `color.js` or `mask.js`) is loaded in
  `index.html` in dependency order and added to the copy list in
  `docs/demo/sync.js`. Root `*.js` files ship in the npm package automatically. ★
- No runtime dependencies, and nothing fetched at load time.
- `npm test` passes; add tests for anything an agent or the REST API can reach.

**Agent parity** (whatever a person can do in the editor, an agent can do too)
- A new patch op is listed in the `fablecut_patch_project` description and in
  the unknown-op error, validated strictly (a bad op refuses the whole patch),
  and respects locks (`refuseLocked`, `force:true`).
- A new MCP tool is added to `manifest.json` `tools` ★ and to the tool list at
  the top of `CLAUDE.md`.
- A new prop shows up in the compact project view when it is set.

**Docs and site**
- `CLAUDE.md` describes it (schema, props, ops, a recipe), then run
  `node docs/docs/build.js` ★. A new `###` section needs a page entry in that
  script, plus a `docs/sitemap.xml` entry.
- `node docs/demo/sync.js` refreshes the playground ★.
- The English `README.md` feature list, `docs/llms.txt`, and the feature list
  in `docs/index.html` (JSON-LD) mention it.
- `CHANGELOG.md` gets an entry under **Unreleased**.

**Releasing** (maintainers)
- Bump the version in every place it is written ★: `package.json`,
  `server.json` (twice, plus the `.mcpb` URL), `manifest.json`,
  `.claude-plugin/plugin.json`, and `serverInfo` in `mcp-server.js`; date the
  CHANGELOG and rebuild the docs.
- Pack the `.mcpb` bundle from a clean `git archive` copy and put its sha256 in
  `server.json`.
- Merge the release PR, then publish a GitHub release on that commit: npm
  (`publish-npm.yml`) and the Discord announcement run from it. Publishing to the
  MCP registry (`mcp-publisher`) is a separate step.

Run the CI checks locally with `node .github/scripts/release-check.js`.

## Adding common things

- **A transition** — extend the `TRANSITIONS` array and `applyTransition()` in
  `app.js`. Transitions modulate evaluated props; keep them deterministic so they
  export identically.
- **A filter preset** — add an entry to `FILTER_PRESETS` in `app.js`.
- **A text animation** — add to `TEXT_ANIMS` and handle it in `drawText()`.
- **An animated SVG starter** — drop a self-contained `.svg` into `library/svg/`
  following the conventions in
  [CLAUDE.md](CLAUDE.md#authoring-animated-svgs-the-svg-clip-kind) (use `--d` for
  staggered delays, CSS `@keyframes` only — never SMIL).

## Translations (`docs/i18n/`)

The English `README.md` is the single source of truth; `docs/i18n/` holds full
translations of it, section for section.

- **Don't translate identifiers.** Prop names, tool names, file paths, CLI
  commands, filter/transition/text-anim names, UI labels that appear in the app
  in English (`Source`, `Browse file…`, `Scale to fit`, `Fit`, `Limit`) and
  everything inside code fences stay as-is. Translate the prose around them.
- Each file ends with a sync note giving the `README.md` commit it was written
  against. Update that short SHA whenever you re-sync a translation.
- Adding a language: copy `docs/i18n/README.es.md`, translate, then add your
  language to the selector line at the top of **every** i18n file and of the
  root `README.md`. Relative links resolve from `docs/i18n/`, so the repo root
  is `../../` (e.g. `../../CLAUDE.md`) and the screenshot is `../screenshot.png`.
- **Feature PRs only need to touch the English README.** Translations are
  re-synced separately; a translation that lags is expected, and the sync note
  tells readers how far behind it is.

## Reporting bugs & requesting features

Use the issue templates. For bugs, include your OS, browser, Node version, and —
if relevant — a minimal `project.json` that reproduces the problem.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
