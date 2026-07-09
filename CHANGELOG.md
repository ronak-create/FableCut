# Changelog

All notable changes to FableCut are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The default asset library now ships with the repo where licensing allows:
  20 Google Fonts in `library/fonts/` (OFL, listed in `LICENSES.md`) and the
  self-authored overlay SVGs in `library/elements/`. `library/sfx/` stays
  local-only (SFX-site licenses generally prohibit redistribution) — its new
  README points to good free sources.

## [1.3.0] - 2026-07-09

### Added
- **Reference-remake pipeline** — give FableCut a reference video and get back an
  *edit blueprint* to rebuild the same idea with different footage over the same
  music. New zero-dependency analyzer (`analyze.js`, needs ffmpeg): shot-boundary
  detection with adaptive threshold, music beat + BPM detection (onset envelope +
  autocorrelation, span-refined), a 0.5 s loudness curve, per-shot audio energy,
  drop detection, and extraction of the reference's music track into `media/`.
  Exposed as MCP tool `fablecut_analyze_reference`, REST `POST /api/analyze`
  (cached under `./analysis/`, `GET /api/analyze?src=…`), and CLI
  `node analyze.js <video>`. New CLAUDE.md section "Remake a reference video"
  documents the blueprint schema and the rebuild recipe.
- **Token-efficient agent surface**:
  - `fablecut_patch_project` — targeted ops (`addClip`, `updateClip`,
    `removeClip`, `addMedia`, `removeMedia`, `setProject`) applied to the latest
    on-disk document in one atomic, merge-safe write — no more round-tripping the
    whole project JSON for a one-prop change.
  - `fablecut_get_project {compact:true}` — one-line-per-clip timeline summary
    (non-default props only, keyframe/transition digests), ~10× smaller.
  - `fablecut_docs {section:"…"}` — fetch only matching `## ` sections of the manual.
  - `fablecut_status` now caps long media listings.
  - New CLAUDE.md section "Token-efficient editing" with agent guidance.

### Changed
- Full `fablecut_get_project` now returns minified JSON (was pretty-printed).
- MCP server bumped to version **1.3.0**.

## [1.2.0] - 2026-07-09

### Added
- **Timeline multi-select** — rubber-band marquee (drag on empty track area)
  selects every clip the box touches. Ctrl/Cmd/Shift+click adds or removes
  individual clips. Ctrl+A selects all; Esc deselects.
- **Group move** — dragging any selected clip moves the whole selection by the
  same time delta (clamped at 0). Vertical track moves remain per-clip.
- **Batch Delete / Split** — Delete removes all selected clips; S splits every
  selected clip that sits under the playhead.
- **Multi-select inspector** — shows an "N clips selected" banner; edits the
  primary (white-outlined) clip; secondary clips show a lighter outline.
- **Conflict-safe `PUT /api/project`** — rejects stale writes with **409** when
  the request body's `revision` ≤ the on-disk revision; response body is
  `{error, revision}` with the current value. Append `?force=1` to overwrite
  deliberately. Writes are now atomic (tmp file + rename).
- **Conflict-safe MCP `fablecut_set_project`** — tracks the revision from the
  last `fablecut_get_project` and errors with "CONFLICT — not saved" if
  `project.json` changed on disk since that read. Recovery: re-read, re-apply,
  save. New optional `force: true` argument bypasses the check.

### Changed
- Editor UI syncs by exact revision comparison (no timing heuristics); detects
  external changes even during the previous 1.5 s blind window; defers reloads
  during drag/export and applies them immediately after; preserves clip
  selection across external reloads (pruned to clips that still exist); shows a
  toast ("Project was updated externally…") when an external write supersedes an
  unsaved local tweak.
- Selection state survives undo/redo.
- `CLAUDE.md` and `README.md` updated to document all of the above.
- MCP server bumped to version **1.2.0**.

## [1.1.0] - 2026-07-07

### Added
- **Motion FX** (all animatable): camera `shake` / `shakeSpeed`, `rgbSplit`
  chromatic aberration, and boiling film `grain`.
- **Speed ramps** — `speed` is now keyframable. The engine time-remaps media time
  as `in + ∫ speed dt` in both preview and the offline export audio mix (the
  fast-into-slow-motion reel move).
- **Adjustment layers** — a new `kind:"adjust"` clip that re-renders everything
  drawn below it through its own grade/filter/shake/grain/vignette stack,
  Premiere-style. Added the *+ Adjust* button, inspector, and timeline styling.
- **Neon caption glow** (`glow` / `glowColor`).
- Four new kinetic text animations: `letter-pop`, `wave`, `bounce`, `shake`.
- Two new transitions: `glitch` (RGB split + jitter) and `pop` (overshoot scale).
- Project-level `background` color, persisted and drawn behind all clips.
- 16 new animated library SVGs (subscribe pill/bell, rating stars, arrows,
  badges, progress/loading bars, speech bubble, hearts, equalizer, pulses…).

### Changed
- `CLAUDE.md` and `README.md` expanded to document all of the above.
- MCP server validation now exempts `adjust` clips from the `mediaId` check.

## [1.0.0] - 2026-07-06

### Added
- Initial public release: a zero-dependency, Premiere-style browser video editor
  whose entire timeline is a single `project.json` document.
- **Editing** — 4 video + 3 audio tracks, drag/trim/split/snap, undo/redo, beat &
  cue markers, real decoded audio waveforms, aspect presets + safe-area guides.
- **Look** — 12 filter presets, full grade controls (temperature/tint/vignette),
  blend modes, fit/crop/corner-radius/flip, chroma key, in-browser AI background
  removal (MediaPipe).
- **Motion** — keyframe animation with easing, per-clip speed, 15 transitions.
- **Text** — kinetic captions, gradient/outline/pill styling, any Google Font by
  name, drop-in custom fonts.
- **Animated SVG clips** — a first-class `svg` kind rendered frame-accurately from
  CSS `@keyframes`.
- **Export** — fast browser-rendered frames + offline audio mix encoded by ffmpeg
  (CRF-18 MP4), with a realtime MediaRecorder fallback.
- Three control surfaces for AI agents: **MCP server**, direct `project.json`
  editing, and a **REST API** with live-reload over server-sent events.

[1.3.0]: https://github.com/ronak-create/FableCut/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ronak-create/FableCut/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ronak-create/FableCut/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ronak-create/FableCut/releases/tag/v1.0.0
