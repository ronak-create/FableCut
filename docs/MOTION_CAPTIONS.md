# Motion Captions Studio

Development based on FableCut (MIT). Upstream commit: 579b08ec1a789baec5cbf06d7430373460508d09.

See PLAN.md for milestones. Current stage: M1 caption styles & editable scenes (`clean`, `bold`, `editorial`).

Local test data is kept in ../local-data, outside this repository. Never publish source clips, masks, credentials or exports.

## Prepare a clean M1 fixture (no external video needed)

`node scripts/prepare-m1.cjs` (pass `--force` to overwrite an existing `../local-data/project.json`)

Generates a clean 9-second 1080×1920/30 fps vertical video with audio via FFmpeg and seeds three editable caption scenes (`clean`, `bold`, `editorial` mixed-type) on `V2`.

## Prepare the M0 reference fixture

`node scripts/prepare-m0.cjs <absolute-path-to-reference-video>`

Refuses to overwrite an existing project. Extracts a local four-second H.264 proxy, creates three editable scenes. The source already contains captions; this is a technical test, not a clean visual recreation.

## Run

Set FABLECUT_DATA_DIR to the absolute ../local-data path and PORT to 7788, then run `node server.js`. Open http://127.0.0.1:7788.

`node scripts/run-m0.cjs` checks MCP editing and stale-revision rejection, then queues a headless export. The server must already be running. The mask test downloads the upstream MediaPipe model and needs internet on first run.

## Agent connection

Use the existing stdio MCP server: node <absolute-app-path>/mcp-server.js, with the same FABLECUT_DATA_DIR and FABLECUT_PORT=7788. Read CLAUDE.md before editing. No global agent configuration is changed by setup.
