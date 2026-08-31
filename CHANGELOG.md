# Changelog

All notable changes to FableCut are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Import from URL** — `POST /api/import-url` downloads an HTTPS video, audio
  or image into `./media/` and returns a same-origin `/media/…` src. The
  editor **+ URL** button and `fablecut_import_media` (now accepts `https://`
  as well as a local path) use it. HTTPS-only with SSRF guards (no localhost /
  private / link-local / CGNAT, including after DNS and redirects). Remote SVG
  is refused so a scripted file cannot run on the editor origin. A raw HTTPS
  `media.src` is still unsupported — canvas CORS would break export.
- A real test suite (`npm test`, zero dependencies, `node:test`): MCP protocol
  negotiation and framing, MCP tool semantics including the conflict rules, the
  REST API with its Host/Origin and path-traversal guards, and the shipped SVG
  library. CI runs it on Node 18, 20 and 22 for every pull request.

### Fixed
- MCP `initialize` no longer echoes an unsupported `protocolVersion`. Missing or unknown versions now negotiate to `2025-11-25` instead of claiming a revision the server does not speak (#58).
- `CLAUDE.md` pointed agents at `fablecut_docs {section:"props"}`, which matches no `## ` heading and returns nothing useful; it now names a real section.

## [1.7.0] - 2026-08-25

The community release — 20 merged pull requests. Audio gets real tracks and real
metering, the monitor gets zoom, the Project tab gets folders, and FableCut
installs as a Claude Code plugin.

### Added
- **Installable as a Claude Code plugin.** `.claude-plugin/plugin.json` plus a
  `.claude-plugin/marketplace.json`, so the repo is its own marketplace:
  `/plugin marketplace add ronak-create/FableCut` then
  `/plugin install fablecut@fablecut`. Ships the MCP server via `.mcp.json` and
  two skills (`edit-video`, `remake-reel`).
- `FABLECUT_DATA_DIR` — put `project.json`, `media/`, `exports/`, `analysis/`
  and `library/` somewhere other than the install directory. Unset (the default)
  everything stays where it always has, so `node server.js` is unchanged. The
  plugin points it at the per-plugin data directory, which is what keeps a
  user's timeline and footage from being wiped when a plugin update replaces the
  install directory. On first use with a split data dir the shipped `library/`
  assets are copied across; files you add or edit there are never overwritten.
- Project FPS select in the Program Monitor header (next to aspect presets) —
  pick 24 / 25 / 30 / 50 / 60 fps; writes `project.fps` and persists like canvas
  size. Non-preset rates appear as Custom.
- Preview playback speed — a monitor toolbar toggle plus **J**/**K**/**L** shortcuts cycle the preview player through 1×, 1.5×, 2×, and 4× (L faster, J slower, K play/pause and reset to 1×). It rides on top of each clip's own speed and is forced back to 1× during export, so renders always come out at real time.
  (thanks @ur5fot, #18)
- **Separate audio and video tracks.** Imported video now shows its audio as
  linked companion clips on the A-tracks (sharing a `linkGroup`, relinked on
  project reload), with switchable RMS / LUFS / peak metering and dBFS labels
  (thanks @PlkMarudny, #17)
- **Track enable/disable** buttons, with the disabled state persisted to
  `project.json` as `disabledTracks`, plus an export-time warning when a disabled
  track still holds clips (thanks @PlkMarudny, #20, #22)
- **Keyframe graphs** — interpolated curves drawn on the clip, keyframe markers,
  and a keyframe count per time point (thanks @PlkMarudny, #34)
- **Text layout engine** — word wrapping inside a text box with horizontal and
  vertical alignment (`boxW`/`boxH`/`vAlign`) (thanks @PlkMarudny, #37)
- **Project folders** — a folder tree in the Project tab with drag-and-drop and
  in-place rename, stored as `folders[]` (thanks @PlkMarudny, #38)
- **Monitor zoom** — mousewheel over the Program Monitor zooms the composition
  (clamped to 2× real pixels), with scrollbars when zoomed in and a restyled
  zoom-reset button (thanks @PlkMarudny, #39)
- **Linked selection** between the Project tab and the timeline
  (thanks @PlkMarudny, #40)
- **Audio hold** — a single frame of audio loops while the playhead is held, so
  scrubbing is audible (thanks @PlkMarudny, #42)
- **Clip replacement and rename** — swap a clip's source media in place
  (thanks @PlkMarudny, #45)
- **Animated SVG overlays** — `countdown-ring`, `rec-indicator` and `swipe-up`
  join the shipped `library/svg/` set (thanks @madebysaira, #55)
- **In/out points** on the timeline — `inPoint`/`outPoint` mark the working
  range (thanks @PlkMarudny, #21)
- **Transition overlay** — transitions are now drawn on the clip itself
  (thanks @PlkMarudny, #23)
- **RTL support for titles** — `direction: auto | ltr | rtl`, with every
  `textAnim` mode staggering in reading order (thanks @PlkMarudny, #25)
- `sunset` and `midnight` filter presets (thanks @Azizbek, #29)
- `luxury` title style — Cinzel, cream→gold gradient, wide letter-spacing
  (thanks @Azizbek, #30)
- Ctrl+click an inspector label to reset that property to its default
  (thanks @PlkMarudny, #36)
- Two-column help dialog (thanks @PlkMarudny, #33)
- Word-timestamp auto-caption example (thanks @madebysaira, #53)
- Multi-agent MCP setup documentation (thanks @madebysaira, #54)
- MCP registry metadata — `server.json` plus an MCPB manifest, so FableCut is
  installable as a one-click `.mcpb` bundle.

### Fixed
- **Exports are tagged BT.709**, so they no longer render noticeably darker than
  the preview (thanks @dntmcq, #56)
- **XSS in the Project tab** — user-controlled media and folder names were
  rendered through `innerHTML` unescaped.
- Zoom to timeline now scales the timeline to 95% of the viewport instead of
  overflowing it (thanks @PlkMarudny, #47)
- `syncMedia` no longer desyncs when playout is paused (thanks @PlkMarudny, #32)
- Gap closing on the timeline (thanks @PlkMarudny, #31)
- Vertical drag of clips between tracks.
- Font weight is preserved in `drawText()` on the `font-cut` path.
- Audio meter labels are placed correctly at 'S' track density.

### Changed
- VU meter and timeline ruler now render on canvases rather than DOM nodes — a
  large drop in layout cost during playback (thanks @PlkMarudny, #44)
- Monochrome icons throughout (thanks @PlkMarudny, #19)
- Play button restyled to be more visible (thanks @PlkMarudny, #35)
- Overlapping helpers deduplicated into shared general-purpose functions
  (thanks @PlkMarudny, #43)
- Landing page: liquid-glass theme, live GitHub star count, and a minimal hero
  over an ASCII field.
- README: ASCII block wordmark, zh-CN / ja / es / pt-BR translations, DeepWiki
  link, community Discord link, and a Trendshift badge.

## [1.6.0] - 2026-07-14

### Added
- Resizable monitor/timeline split — drag the divider, double-click to reset (thanks @PlkMarudny, #14)
- S/M/L timeline track-density presets with layout persistence (thanks @PlkMarudny, #15)
- Zoom to selection (Z) now frames all selected clips (thanks @PlkMarudny, #13)
- Title-style picker: each entry renders in its own typeface, and hovering an entry live-previews the style on the monitor (mouse away reverts, click commits)
- Program-monitor hover cursors: the rotate knob shows a rotate cursor, corner handles show direction-aware resize arrows (correct even on rotated clips), and the clip body shows a move cursor

### Fixed
- Changing a title's style no longer resets its position/scale/rotation — style switches only restyle the look; placement applies to newly created titles only
- Selection handles now clamp to the frame edge and stay visible/grabbable when a clip's box extends past the canvas
- Header logo icon/text vertical alignment after the topbar layout change

## [1.5.0] - 2026-07-11

### Added
- **Direct manipulation on the program monitor** — click a clip or title on the
  preview to select it, then drag the body to move, the corner handles to resize,
  and the top handle to rotate (hold Shift to snap rotation to 15°). Gestures map
  straight onto the clip's `x`/`y`/`scale`/`rotation` props. Selection handles are
  drawn only on screen and never appear in an export.

## [1.4.0] - 2026-07-11

### Added
- **Title styles** — text clips no longer all look the same. Adding a title now
  rotates through curated one-tap looks (Impact, Elegant, Kinetic cut, Neon,
  Handwritten, Serif drop, Subtitle, Bold rise), each bundling a **different
  font**, placement and animation. Pick or shuffle them from the inspector, or
  reproduce any look from an agent by writing the same props.
- **Four cinematic caption animations**: `clip-reveal` (wipe-mask sweep),
  `zoom-in` (scale + opacity settle), `font-cut` (rhythmically swaps the typeface
  from a `fontCutSet`, then settles), and `rise-mask` (lower-third reveal). All
  render on the existing frame-accurate path, so they export unchanged.
- Expanded the built-in Google-font list with the display faces the styles use
  (Archivo Black, Abril Fatface, Barlow, Teko, Roboto). Any font name still
  auto-downloads on demand.

## [1.3.1] - 2026-07-11

### Security

Hardening of the local server against network and drive-by attacks, prompted by
the report in [#1](https://github.com/ronak-create/FableCut/issues/1) — thanks
@suthakamal2.

- The server now binds **127.0.0.1 only** by default (previously all
  interfaces, reachable from the whole LAN). Deliberate LAN use is an explicit
  opt-in: `HOST=0.0.0.0 node server.js` plus
  `FABLECUT_ALLOWED_HOSTS=192.168.1.20,mybox.local`.
- Every request is checked against a **Host-header allowlist**
  (localhost/127.0.0.1/[::1] + the opt-ins above), which defeats DNS-rebinding
  attacks, and — when the browser sends one — an **Origin allowlist**, which
  defeats blind cross-origin writes from malicious web pages (e.g. a drive-by
  `POST /api/upload` carried a no-preflight raw body).
- The static file server no longer serves dot-files or dot-directories
  (`.git/`, `.gitignore`, …), and both path-traversal guards now use
  separator-anchored directory prefixes.

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

[1.7.0]: https://github.com/ronak-create/FableCut/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/ronak-create/FableCut/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/ronak-create/FableCut/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/ronak-create/FableCut/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/ronak-create/FableCut/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/ronak-create/FableCut/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ronak-create/FableCut/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ronak-create/FableCut/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ronak-create/FableCut/releases/tag/v1.0.0
