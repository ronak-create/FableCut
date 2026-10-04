# FableCut — browser video editor, drivable by Claude Code

A production-style non-linear video editor (Premiere-style) that runs in the
browser. An AI agent edits videos by **editing `project.json`** (or calling the
REST API / MCP tools) — the open browser UI live-reloads within ~150 ms via SSE.
No build step, no npm dependencies.

**This file is the master manual.** Any model pointed at this document (or at
the `fablecut_docs` MCP tool, which returns it) has everything needed to fully
drive the editor.

## MCP connection (preferred — works from any session, any directory)

Register the MCP server (`mcp-server.js`) once at user scope as `fablecut`:
`claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"`.
Every Claude Code session then has these tools:

- `fablecut_status` — auto-starts the editor server, returns URL + project summary. Call first.
- `fablecut_docs` — returns this document (`section: "…"` returns only matching `## ` sections).
- `fablecut_get_project` / `fablecut_set_project` — read / replace the timeline JSON.
  `fablecut_get_project {compact:true}` returns a one-line-per-clip summary instead.
- `fablecut_patch_project` — apply targeted ops (add/update/remove clip/media,
  set project fields) without round-tripping the document. **Prefer this for edits.**
- `fablecut_import_media` — copy a local file (or download an `https://` URL)
  into `./media/` and register it. The stored `src` is always `/media/…`.
- `fablecut_analyze_reference` — turn a reference video into an edit blueprint
  (shots, beats, BPM, energy, drop) + extract its music. See "Remake a reference video".
- `fablecut_encode_profiles` — list export presets from `encoding-profiles.json` (each is a
  raw ffmpeg args list). Set `project.encodeProfile` via patch to pin a project default.
- `fablecut_normalize_audio` — measure clips (BS.1770 LUFS or sample peak, via ffmpeg) and
  set their clip gain to a loudness target. See "Audio mix" below.
- `fablecut_auto_duck` — find where the voice tracks speak and write `duck` keyframes that
  dip the music under it. See "Audio mix" below.
- `fablecut_denoise` — reduce background noise on audio clips (renders a cleaned copy of the
  file and switches the clip's stems to it). See "Audio mix" below.
- `fablecut_export` — render the timeline to a file in `exports/` with the editor's own
  Fast export (open tab, or headless Chrome / Edge). See "Export" below.
- `fablecut_scopes` — measure the graded picture at a moment (levels, clipping, colour
  cast), as the editor's scopes see it. See "Color" below.

### Token-efficient editing (important for agents)

Editing via full get→modify→set costs thousands of tokens per change. Cheaper:

1. **Plan** from `fablecut_get_project {compact:true}` (≈10× smaller than the JSON)
   and `fablecut_status` — fetch the full JSON only to inspect exact keyframes.
2. **Edit** with `fablecut_patch_project` ops — send only what changes, e.g.
   `{ops:[{op:"updateClip", id:"c_v2", set:{props:{filterPreset:"noir"}}}]}`.
   It re-reads the latest document internally, so it is merge-safe by design
   (no CONFLICT dance) and never destroys concurrent UI tweaks.
3. **Docs**: request `fablecut_docs {section:"schema"}` (or "Recipes", "Remake", …)
   instead of the whole manual; skip it entirely if the schema is already in context.
4. **Media questions** (duration, fps, size): read them from the registered media
   entries — don't shell out to ffprobe; the browser probes and writes them back.
5. Batch related changes into ONE patch call (ops apply in order, one revision bump).
6. **Cut and trim with the edit ops** (next section) rather than recomputing
   `start` / `in` / `duration` by hand — they keep linked stems in sync.

### Timeline edit ops (`fablecut_patch_project`)

The editor's own split / ripple / trim code (`edit-ops.js`), run on the
document — so linked audio stems ride along, edits land on the **targeted**
tracks (`untargetedTracks`, see Semantics), and locked clips stay put, exactly
as with the keyboard shortcuts. Times are seconds.

| op | does |
|---|---|
| `{op:"split", at, ids?}` | cut at `at` — the named clips (and their stems), or every targeted track |
| `{op:"rippleDelete", ids}` | remove clips; later clips on those tracks close the hole |
| `{op:"closeGap", at}` | close the gap under `at` on every targeted track |
| `{op:"lift" \| "extract", from?, to?}` | remove a range (default: `inPoint`→`outPoint`, which then clear); extract also closes it |
| `{op:"insert" \| "overwrite", mediaId, at, in?, duration?}` | three-point edit: place `in`→`in+duration` of the media at `at` (default: the rest of the media). Insert pushes later clips right; overwrite replaces what is under it. A video brings one linked audio stem per channel. |
| `{op:"rippleTrim", id, side:"in"\|"out", delta}` | move a head / tail; everything after follows |
| `{op:"roll", id, side, delta}` | move the cut between two clips; nothing else moves |
| `{op:"slip", id, delta}` · `{op:"slide", id, delta}` | new source window in place · move a clip between its neighbors |
| `{op:"crossfade", ids? \| at, duration?}` | constant-power audio crossfade at the cuts touching `ids`, or the cut nearest `at` (handles borrowed from both sides) |

Trims are clamped to the source media, the free room and `MIN_DUR`; the result
note shows the applied delta (`… (asked +5, clamped)`). Any edit op takes
`tracks:[…]` to target lanes for that op only, and `force:true` to edit locked
material (only when the user asked). A refused op (nothing under `at`, a
locked clip, a media window past the file's end) aborts the whole patch unsaved.
`setProject` also sets `inPoint` / `outPoint` (`null` clears).

Example — cut the 2 s from 10 s to 12 s out of the edit, then crossfade the new cut:
`{ops:[{op:"extract", from:10, to:12}, {op:"crossfade", at:10, duration:0.5}]}`

**`fablecut_set_project` is conflict-checked.** The MCP server remembers the
`revision` from the most recent `fablecut_get_project` call. If `project.json`
has been written by anyone else since that read (e.g. the user dragged a clip in
the UI), `fablecut_set_project` refuses with a "CONFLICT — not saved" error
instead of overwriting. Protocol:

1. `fablecut_get_project` → read the document and note its `revision`.
2. Apply your edits in memory, bump `revision`.
3. `fablecut_set_project` → if it succeeds you're done.
4. **On conflict**: call `fablecut_get_project` again to get the latest document,
   re-apply your intended changes on top of it, bump `revision`, and call
   `fablecut_set_project` again.

Pass `force: true` to `fablecut_set_project` only when the user explicitly
asks to overwrite conflicting changes. `fablecut_import_media` only appends a
new media entry and always merges safely — no conflict check needed.

For Claude Desktop, add to its MCP config:
`{"mcpServers":{"fablecut":{"command":"node","args":["<path-to>/fablecut/mcp-server.js"]}}}`
Direct file editing of `project.json` (below) works too and is equivalent.

Installing as a Claude Code plugin (`/plugin marketplace add ronak-create/FableCut`,
then `/plugin install fablecut@fablecut`) does the registration for you.

### Where the files are

`project.json`, `media/`, `exports/`, `analysis/` and `library/` normally sit in
the repo next to `server.js`. Set **`FABLECUT_DATA_DIR`** to move all five
somewhere else; the code and the static app files stay in the install directory
either way. The plugin sets this so a plugin update can replace the install
directory without touching anyone's timeline or footage. **Don't assume
`project.json` is beside `mcp-server.js`** — call `fablecut_status`, which
reports the real paths.

Tests (and nothing else) may set **`FABLECUT_NO_FS_WATCH=1`** to skip `fs.watch`.
On Windows, libuv can abort the process when a file is created under a temp
data dir. Production leaves watching on so the UI live-reloads.

## Run

```
node server.js        # → http://localhost:7777
```

Files: `index.html` + `style.css` + `app.js` (editor UI), `server.js` (API + hosting),
`project.json` (the timeline — THE file to edit), `media/` (project footage),
`library/` (default asset library, see below).

## How Claude Code edits a video

1. Ensure the server is running (background: `node server.js`, or `fablecut_status`).
2. Put source files in `./media/` (copy them in, import via the UI / **+ URL**,
   or `fablecut_import_media` with a local path or HTTPS URL).
3. Read `project.json`, modify `media` / `clips`, **increment `revision`**, write it back.
4. The browser UI (if open) reloads instantly. The user previews/exports from the UI.

Rules:
- **Prefer `fablecut_set_project`** over direct file writes — it detects conflicts
  automatically (see the MCP section above). If you do write `project.json`
  directly, read it **immediately** before writing (never write from a stale read:
  if the user tweaked something in the UI between your read and write, that write
  destroys their changes). The UI detects external changes by revision comparison,
  so a write that does not bump `revision` is invisible to it.
- Make each edit a single atomic write (read → modify → write once), and bump
  `revision` (integer). Partial multi-step edits can be picked up half-finished.
- New media entries may omit `duration` — the browser probes it and writes it back.
  If you need the duration yourself, re-read `project.json` after a second or two,
  or probe with ffprobe.
- Don't edit `project.json` while the UI may be mid-drag — the UI defers external
  reloads during gestures, then picks up the next change.

## The asset library (`./library/`) — default media

Reusable assets, visible in the editor's left-panel tabs and never copied:

| Folder      | Editor tab   | Purpose |
| ----------- | ------------ | ------- |
| `library/sfx/`      | **Sound FX** | whooshes, impacts, risers, UI clicks |
| `library/elements/` | **Elements** | overlay art: alpha PNGs, light leaks, textures, stickers |
| `library/svg/`      | **SVG**      | animated vector graphics **you author** (convention below) |
| `library/fonts/`    | font editor  | `.ttf/.otf/.woff/.woff2`, auto-registered, family name = file name; a variable font draws every `weight` |

- List via `GET /api/library?dir=sfx|elements|svg|fonts` (recursive; subfolders OK).
- To use one in the timeline, add a media entry whose `src` is its library path,
  e.g. `{ "id":"m_x", "name":"whoosh.mp3", "kind":"audio", "src":"/library/sfx/whoosh.mp3" }`
  — then reference it from clips like any other media.
- Dropping files into these folders live-refreshes the open UI.

## Authoring animated SVGs (the `svg` clip kind)

You can create your own vector animations/overlays: write an `.svg` file into
`library/svg/` (or `media/`), register it as media with `"kind": "svg"`, and
place it on a video track. The compositor renders it frame-accurately, driven
by the clip's local time (preview and export).

**Conventions (required for time-driven animation):**
1. Root `<svg>` must carry `width` and `height` attributes (or a `viewBox`).
2. Animate with **CSS `@keyframes` inside a `<style>` block** — SMIL
   (`<animate>`) is NOT time-controlled.
3. Never write a literal `animation-delay`. For staggered starts set the custom
   property `--d` on the element instead: `style="--d:0.4s"`. (The engine drives
   time by overriding `animation-delay` to `calc(var(--d,0s) - t)` with
   animations paused.)
4. `animation-fill-mode: both` (or the `both` keyword in the shorthand) for
   one-shot intros; `infinite` for loops — both work.
5. For rotations/scales around an element's own center add
   `transform-box: fill-box; transform-origin: center;`.
6. Keep files self-contained (no external hrefs).

Skeleton:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <style>
    .a { transform-box: fill-box; transform-origin: center;
         animation: pop 0.5s cubic-bezier(.34,1.56,.64,1) both; }
    @keyframes pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  </style>
  <circle class="a" style="--d:0s"   cx="200" cy="225" r="60" fill="#7b6cff"/>
  <circle class="a" style="--d:0.2s" cx="400" cy="225" r="60" fill="#ffd166"/>
</svg>
```

Examples in `library/svg/`: `sparkles.svg` (loop), `lower-third.svg`,
`confetti-burst.svg`, `underline-swoosh.svg` (draw-on via stroke-dashoffset).

## project.json schema

```jsonc
{
  "name": "My Edit",
  "width": 1280, "height": 720, "fps": 30,   // composition canvas + timeline/export rate — sole FPS source (UI: FPS select)
  "exportFrame": { "x": 438, "y": 0, "w": 404, "h": 720 },  // optional delivery crop (even w/h for H.264)
  // ^ omit = export the full canvas. Preview dims outside this rect; Fast export crops
  // JPEGs to w×h. Clip x/y/scale stay relative to the composition center, not the frame.
  // Frame size is always even (yuv420p / libx264); 9:16 on 1280×720 → 404×720, not 405.
  "background": "#000000",                    // canvas color behind all clips (optional)
  "revision": 7,                              // bump on every write!
  "panSchema": 1,                             // 1 = pan-aware; omit only on pre-pan projects (UI migrates once)
  "markers": [ { "t": 2.5 }, { "t": 5.0, "label": "drop", "color": "red" } ],
  // ^ beat/cue markers: diamonds on the ruler (label shown beside them), snap
  //   targets for clip edges. color: gold (default) · red · orange · green ·
  //   cyan · blue · purple · pink. Kept sorted by t; the UI rounds t to 1 ms.
  "inPoint": 10.023, // IN work-area marker (Limit playback + optional export range)
  "outPoint": 21.500, // OUT work-area marker; omit = timeline end
  "folders": [
    // Project-bin virtual folders (tree). Media reference them via folderId.
    { "id": "f_broll", "name": "B-roll", "parentId": null, "open": true }
  ],
  "disabledTracks": [ "A2" ],
  // ^ optional — track ids (e.g. V4 V3 V2 V1 A1 A2 A3) omitted from preview/export when listed
  "lockedTracks": [ "A3" ],
  // ^ optional — locked lanes: nothing on them may be edited or moved (see Semantics)
  "untargetedTracks": [ "V2" ],
  // ^ optional — lanes edits skip (split, insert, ripple, close gap…); default: all targeted
  "encodeProfile": "hq",  // optional — fast-export profile id (see encoding-profiles.json)
  "master": { "gain": -1.5, "fx": [ { "type": "limiter", "ceiling": -1 } ] },
  // ^ optional — master fader, dB (−60 = silence … +12; omit = 0 dB) and master effects (see "Audio mix")
  "tracks": [                          // optional — timeline lanes (default V3…V1 + A1…A4)
    { "id": "V3", "kind": "video" },   // video: higher number drawn on top (V1 under V2 under V3…)
    { "id": "V2", "kind": "video" },
    { "id": "V1", "kind": "video" },
    { "id": "A1", "kind": "audio", "gain": -6, "pan": 0, "out": "B1" },   // audio: A1…An top→bottom; +V/+A appends Vn+1 / An+1
    // ^ gain = track fader in dB (−60 = silence … +12), pan = −1…1, fx = track effects,
    //   out = the submix bus it feeds (default: the master); all optional
    { "id": "A2", "kind": "audio" },
    { "id": "A3", "kind": "audio" },
    { "id": "A4", "kind": "audio" }
  ],
  "buses": [ { "id": "B1", "name": "Dialogue", "gain": -2, "fx": [ { "type": "compressor" } ] } ],
  // ^ optional — submix buses B1…B8: name, gain (dB), pan, mute, fx; tracks route in with `out`
  "media": [
    { "id": "m_abc", "name": "intro.mp4", "kind": "video",  // video|audio|image|svg
      "src": "/media/intro.mp4",             // path under ./media or ./library (never a raw https:// URL)
      "duration": 12.4, "width": 1920, "height": 1080,
      "folderId": null },                    // optional: id of a folders[] entry
    { "id": "m_abd", "name": "intro.denoise-medium.flac", "kind": "audio", "src": "/media/intro.denoise-medium.flac",
      "derivedFrom": "m_abc", "denoise": "medium" }  // a noise-reduced copy of m_abc (see "Audio mix")
  ],
  "clips": [
    {
      "id": "c_xyz",             // unique string
      "mediaId": "m_abc",        // null for kind:"text" and kind:"adjust"
      "kind": "video",           // video | audio | image | svg | text | adjust
      "track": "V1",             // Vn…V1 (video) | A1…An (audio); extras via UI +V/+A or tracks[]
      "start": 0,                // timeline position, seconds
      "in": 2.5,                 // offset into source media, seconds (0 for image/svg/text)
      "duration": 5,             // clip length on timeline, seconds
      "name": "intro",
      "linkGroup": "lg_abc",     // OPTIONAL — AV link: video + per-channel audio stems share one id
      "locked": true,            // OPTIONAL — locked by the user: leave it alone (MCP patch refuses edits)
      "disabled": true,          // OPTIONAL — stays on the timeline, hidden from preview / audio / export
      "unlinked": true,          // OPTIONAL — the user unlinked this clip; never auto-relinked on load
      "props": { /* all optional — see the props reference below */ },
      // OPTIONAL — keyframe animation. Times are seconds RELATIVE TO CLIP START.
      // "ease" sits on the DESTINATION keyframe of each segment:
      // linear | ease-in | ease-out | ease-in-out (default ease-in-out).
      "keyframes": {
        "scale":   [ { "t": 0, "v": 1 }, { "t": 5, "v": 1.25, "ease": "linear" } ],
        "opacity": [ { "t": 0, "v": 0 }, { "t": 0.8, "v": 1 } ]
      },
      // OPTIONAL — audio effects (audio clips), processed in order. See "Audio mix".
      "fx": [ { "type": "highpass", "freq": 80 }, { "type": "compressor", "threshold": -20, "ratio": 4 } ],
      // OPTIONAL — transitions at the clip's head/tail.
      "transitionIn":  { "type": "fade", "duration": 0.8 },
      "transitionOut": { "type": "slide-left", "duration": 0.6 }
    }
  ]
}
```

### props reference

**Transform & compositing** (all visual kinds):
| prop | default | notes |
|---|---|---|
| `x`, `y` | 0 | px offset from canvas center |
| `scale` | 1 | |
| `rotation` | 0 | degrees |
| `opacity` | 1 | 0–1 |
| `blend` | "normal" | multiply · screen · overlay · lighter · soft-light · hard-light · color-dodge · darken · lighten · difference |

**Layout** (video/image/svg):
| prop | default | notes |
|---|---|---|
| `fit` | "contain" | contain · cover (fill canvas, crop overflow) · stretch · none (native px) |
| `cropL` `cropR` `cropT` `cropB` | 0 | % of the source trimmed off each edge |
| `cornerRadius` | 0 | px, rounded corners — the PiP look |
| `flipH`, `flipV` | false | mirror |

**Filter / color** (video/image/svg):
| prop | default | notes |
|---|---|---|
| `filterPreset` | "none" | one of: cinematic · teal-orange · noir · vintage · faded · warm · cold · pop · dreamy · retro · bw-soft · cyberpunk · sunset · midnight. Combines non-destructively with the sliders below. |
| `brightness` `contrast` `saturation` | 100 | % (100 = neutral) |
| `hue` | 0 | degrees |
| `temperature` | 0 | −100 (cool blue) … +100 (warm orange) |
| `tint` | 0 | −100 (magenta) … +100 (green) |
| `blur` | 0 | px |
| `grayscale` `sepia` `invert` `vignette` | 0 | % |

These are quick looks. For real grading use `props.grade` (see "Color" below).

**Motion FX** (video/image/svg/adjust — all animatable):
| prop | default | notes |
|---|---|---|
| `shake` | 0 | camera-shake amplitude in px (deterministic — identical in export) |
| `shakeSpeed` | 8 | shake frequency |
| `rgbSplit` | 0 | chromatic aberration / RGB channel split, px |
| `grain` | 0 | animated film grain, % |

**Keying / cut-out** (video/image):
| prop | default | notes |
|---|---|---|
| `chromaKey` | "" | hex key color, e.g. `"#00ff00"` for green screen ("" = off) |
| `chromaTolerance` | 26 | 0–100, how much color distance is keyed out |
| `chromaSoftness` | 12 | 0–100, edge feather + spill suppression |
| `bgRemove` | false | AI person cut-out (MediaPipe, loads from CDN on first use; needs internet once) |

**Audio / time** (video/audio):
| prop | default | notes |
|---|---|---|
| `volume` | 1 | 0–2 (linear; animatable — fades, ducking) |
| `gain` | 0 | clip gain in dB (−60…+24), applied **before** `volume`, so keyframes and fades ride on top. Set by Normalize. |
| `channelMode` | "stereo" | stereo · mono (L+R folded to one channel) · left · right (use one side) · swap (exchange L/R). Ignored on linked stems — `audioChannel` already picks their channel. |
| `duck` | 0 | ducking in dB (≤ 0), multiplied into `volume`. Normally keyframed by Auto-duck (`keyframes.duck`), so the clip's own volume, keyframes and fades are untouched. |
| `pan` | 0 | −1 (full left) … 0 (center) … +1 (full right). Linked stems default L `−1` / R `+1` / other `0`. Projects saved before pan migrate once on load (`panSchema`); keep `panSchema: 1` (and explicit `pan` on stems) when rewriting the document so a centered stem is not re-hard-panned. |
| `speed` | 1 | 0.25–4× playback rate. **Keyframable → speed ramps**: with `keyframes.speed` the engine time-remaps (media time = `in` + ∫speed dt), in preview and in the export audio mix. Static case: source window consumed = `duration × speed`, so `in + duration×speed ≤ media.duration`. |

**Text clips only:**
| prop | default | notes |
|---|---|---|
| `text` | "Title" | `\n` for multi-line |
| `fontSize` | 72 | px |
| `color` | "#ffffff" | fill |
| `color2` | "" | if set: vertical gradient fill color→color2 |
| `font` | "Segoe UI" | system font, a `library/fonts` family, or ANY Google Font name — unknown names are fetched from Google Fonts automatically |
| `bold` / `weight` | true / 0 | `weight` (300–900) overrides `bold` when non-zero |
| `italic` `uppercase` | false | |
| `align` | "center" | left · center · right · **justify** (inserts spaces between words to fill the text box width, or ~85% of the canvas when no box) |
| `boxW` `boxH` | 0 | px text box; **0 = hug content**. When both > 0, corner handles resize the box (not `scale`). Default: fixed `fontSize`, word-wrap inside the box. |
| `boxFit` | false | when a box is set: `false` = wrap at fixed font size; `true` = scale font down (up to `fontSize`) so the whole text fits |
| `vAlign` | "middle" | top · middle · bottom — vertical alignment of the text block inside the box |
| `direction` | "auto" | auto · ltr · rtl — `auto` detects per line (Hebrew/Arabic → RTL); all `textAnim` modes honor reading direction (wipe, typewriter reveal, word/letter layout) |
| `letterSpacing` | 0 | px |
| `lineHeight` | 1.2 | multiplier |
| `textShadow` | 12 | soft drop shadow amount, 0 = off |
| `glow` | 0 | neon glow strength (0–100); replaces the drop shadow |
| `glowColor` | "" | glow color ("" = use the text color) |
| `strokeWidth` `strokeColor` | 0, "#000" | text outline |
| `bgColor` `bgOpacity` | "#000", 0 | rounded pill behind each line |
| `textAnim` | "none" | typewriter · word-pop · word-slide · karaoke · **letter-pop** (per-character entrance; Arabic/Indic auto-fallback to per-word clusters so joined letters shape correctly) · **wave** (looping per-character ride; same shaping fallback) · **bounce** (looping per-word hop) · **shake** (looping jitter) · **clip-reveal** (wipe-mask sweep, per line) · **zoom-in** (scale + opacity settle) · **font-cut** (rhythmically swaps typeface, then settles — see `fontCutSet`) · **rise-mask** (line rises from behind its baseline, lower-third reveal) |
| `wordRate` | 0.15 | seconds per word (typewriter: /4, letter-pop: /3 per character); also staggers `clip-reveal`/`zoom-in`/`rise-mask` per line |
| `fontCutSet` | (curated) | array of font family names cycled by `font-cut`, e.g. `["Anton","Bebas Neue","Archivo Black","Oswald"]`; each is auto-loaded |

**Title styles (one-tap cohesive looks).** Text clips created in the UI now
rotate through curated styles so titles vary instead of all looking basic (the
old flat `Segoe UI` / no-animation default). Each style bundles a **different
font**, placement and animation. Apply one in the inspector (Title style
dropdown + Shuffle), or reproduce it from an agent by writing the same props:

| Style | Font | Look |
| --- | --- | --- |
| `impact` | Anton | uppercase, lower third, `word-pop`, big shadow |
| `elegant` | Playfair Display | white→gold gradient, centered, `clip-reveal` |
| `kinetic` | Bebas Neue | gold, `font-cut` cycling Anton/Bebas/Archivo/Oswald |
| `neon` | Bebas Neue | cyan `glow`, `wave` |
| `handwritten` | Caveat | rotated −4°, lower-left, `word-slide` |
| `serifDrop` | Abril Fatface | centered, `zoom-in` |
| `subtitle` | Roboto | small, bottom, bg pill, `karaoke` |
| `boldRise` | Archivo Black | uppercase, lower third, `rise-mask` |
| `luxury` | Cinzel | uppercase, cream→gold gradient, wide `letterSpacing`, `clip-reveal` |

**Rule for agents: vary the font per title — never reuse one font across a whole
edit.** Any Google Font name auto-loads; the display faces above ship in
`library/fonts/`. Placement props (`x`/`y`) are canvas-aware in the styles
(lower third ≈ `y: height*0.30`).

Switching the style on an **existing** title (inspector dropdown/Shuffle) only
restyles the look (font, size, colors, shadow/glow, animation) — the clip's
`x`/`y`/`scale`/`rotation`/`align` and its `text` are preserved. The style's
canvas-aware placement is applied only when a title is first created.

**Adjustment layers** (`kind:"adjust"`, `mediaId:null`): a clip that re-renders
everything drawn *below* it (lower tracks + earlier clips) through its own
filter stack — Premiere-style. Supports all Filter/Color props, vignette,
grain, rgbSplit, temperature/tint, whole-frame `shake`, and `opacity` as the
intensity. Keyframe/transition it like any clip. Put it on V2/V3 above the
footage. Example: 0.3 s impact shake over everything =
`{kind:"adjust", track:"V3", duration:0.3, props:{shake:18}}`.

**Animatable props** (usable in `keyframes`): x, y, scale, rotation, opacity,
volume, pan, duck, speed, brightness, contrast, saturation, hue, blur, grayscale, sepia,
invert, temperature, tint, vignette, cornerRadius, shake, rgbSplit, grain,
fontSize, letterSpacing, glow.

**Transition types**: fade · slide-left/right/up/down · zoom · wipe (=wipe-left)
· wipe-right/up/down · iris (circular) · spin · blur · whip (whip-pan) ·
glitch (RGB split + jitter) · pop (overshoot scale — stickers/captions).

### Audio mix

Every clip runs through the same chain in preview **and** export:
`source → channels (audioChannel / channelMode) → gain (dB) → clip fx → volume (keyframes, fades, duck) → pan → its A-track`,
then `track fx → track fader → track pan → (submix bus fx → fader → pan) → master sum → master fx → master fader`.
A track has a fader (`tracks[].gain`, dB), a pan (`tracks[].pan`) and effects
(`tracks[].fx`); the master has a fader (`master.gain`) and effects (`master.fx`).
**Submix buses** (`buses[]`, B1…B8) group tracks: a track with `out:"B1"` feeds
that bus instead of the master, and the bus has its own effects, fader, pan and
mute — e.g. every dialogue lane into one bus with one compressor and one fader.
Audio on a video lane (a clip with `volume > 0` on V1…) goes straight to the
master. In the UI these are the strips in the **Mixer** tab beside the
Inspector (its **FX** button edits that track's or the master's effects);
mute / solo are the existing track switches (`disabledTracks`).

**Effects** (`fx` — an array processed in order; every parameter optional, out-of-range
values are clamped; `on:false` bypasses one without losing its settings):

| type | parameters (default) |
|---|---|
| `eq` | `lowFreq` 120 Hz, `lowGain` 0 dB (low shelf) · `midFreq` 1000, `midGain` 0, `midQ` 1 (peak) · `highFreq` 8000, `highGain` 0 (high shelf); gains −18…+18 |
| `highpass` / `lowpass` | `freq` (80 / 8000 Hz), `q` 0.71 |
| `compressor` | `threshold` −20 dB, `ratio` 4, `attack` 10 ms, `release` 200 ms, `knee` 6 dB, `makeup` 0 dB |
| `limiter` | `ceiling` −1 dB, `release` 80 ms — brickwall, 5 ms lookahead; nothing passes the ceiling |
| `gate` | `threshold` −50 dB, `range` −40 dB (how far it closes), `attack` 2, `hold` 80, `release` 150 ms |
| `delay` | `time` 0.3 s, `feedback` 0.35, `mix` 0.25 |
| `reverb` | `decay` 2 s, `predelay` 20 ms, `mix` 0.25 |
| `distortion` | `drive` 0.3, `mix` 1 |
| `widener` | `width` 1.5 (0 = mono, 1 = as is, 2 = extra wide) |
| `pitch` | `semitones` 0 (−12…+12; changes pitch, not speed — about 30 ms of delay), `mix` 1 |

**Presets** fill the chain with tweakable effects: Voice — `clean-voice`, `podcast`,
`radio`, `deep-voice` (pitch down 4 semitones + a warmer EQ), `telephone`;
Music — `cinematic`, `wide`, `muffled` (next room). Agents apply them (or any chain)
with the patch op `setFx`:
`{op:"setFx", target:"clip", id:"c_vo", preset:"podcast"}` ·
`{op:"setFx", target:"track", id:"A3", fx:[{type:"eq", highGain:-3}]}` ·
`{op:"setFx", target:"master", fx:[{type:"limiter", ceiling:-1}], append:true}` ·
`{op:"setFx", target:"bus", id:"B1", preset:"podcast"}` ·
`fx:null` clears. On a clip it applies to its linked stems too; chains are
validated (unknown effect or preset → the whole patch is refused). The compact
project view shows chains as `fx:highpass·eq·…` (`lowpass~freq` = automated).

**Effect automation** — any effect parameter except reverb `decay` can follow
keyframes: `keys` on the effect, `{param: [{t, v, ease?}]}`. `t` is seconds from
the clip's start for a clip's effects, and timeline seconds for a track's, a
bus's or the master's; `ease` (linear · ease-in · ease-out · ease-in-out, default
ease-in-out) shapes the segment arriving at that key, as with clip keyframes.
While a parameter has keys they set it. Preview and export follow them the same
way (export steps every 20 ms with a short glide). In the effects panel each
parameter has a ◆: set or remove a key at the playhead; with keys, the slider
edits the key under the playhead. Agents:
`{op:"setFxKeys", target:"bus", id:"B1", type:"lowpass", param:"freq", keys:[{t:0, v:18000}, {t:8, v:500, ease:"ease-in"}]}`
(`index` picks the effect when the type repeats; `keys:null` clears) — or write
`keys` inside a `setFx` chain. Example — a filter sweep into the drop: a
`lowpass` on the music clip keyed from 400 Hz up to 20000 Hz over the build.

- Set a track fader / pan: `{op:"setTrack", id:"A2", set:{gain:-8, pan:0}}`
  (`null` or `0` resets). Master: `{op:"setProject", set:{master:{gain:-1}}}`.
- Buses: `{op:"setBus", id:"B1", set:{name:"Dialogue", gain:-2, pan?, mute?}}`
  creates or updates one; route a track in with `{op:"setTrack", id:"A1", set:{out:"B1"}}`
  (`out:"master"` or `null` routes it back); `{op:"removeBus", id:"B1"}` sends
  its tracks back to the master. In the Mixer: **+ Bus**, the **→** menu under a
  track's name, double-click a bus name to rename it.
- **Noise reduction** — `fablecut_denoise {clipIds, amount?:"light"|"medium"|"strong"|"off"}`
  (default medium; the inspector's **Noise** control does the same). The file's
  noise floor is measured (its quietest 50 ms windows), then ffmpeg's FFT
  denoiser pulls everything near it down (10 / 18 / 30 dB) into a FLAC copy of
  the **whole** source file in `media/`, registered with `derivedFrom` (the
  original) and `denoise` (the amount). The clip and its linked audio stems
  switch to that copy; the picture keeps its own file, so links, `in` points
  and timing stay as they were. `off` switches back; a level already rendered
  is reused. Works on audio clips (a video's sound is on its linked stems).
  Needs ffmpeg. Use it before normalizing — the measured loudness changes.
- **Normalize** — `fablecut_normalize_audio {clipIds, mode?:"lufs"|"peak", target?}`
  measures each clip's source window after its channel routing (ITU-R BS.1770
  integrated loudness with EBU R128 gating, or sample peak) and sets
  `props.gain` to hit the target. Linked stems are measured together and share
  one gain; passing a video clip normalizes its stems. Targets: **−14 LUFS**
  streaming / social, **−16 LUFS** podcast / dialogue, **−23 LUFS** broadcast,
  or `mode:"peak", target:-1`. Locked clips are skipped unless `force:true`.
  The inspector's **Normalize** in the editor does the same measurement.
- **Fade curves** — a `fade` transition on an audio clip may carry `curve`:
  `"power"` (constant power — the crossfade default, no dip in the middle),
  `"linear"` (constant gain — for crossfading the *same* material, e.g. a split
  of one take) or `"exp"` (slow start, natural fade to silence). No `curve` keeps
  the original eased shape. Only the volume follows the curve; picture fades
  are unchanged. `{transitionOut:{type:"fade", duration:3, curve:"exp"}}`.
- **Crossfades** — overlap A and B on one track and give A
  `transitionOut:{type:"fade", duration:d, curve:"power"}` and B
  `transitionIn` the same, with `d` = the overlap. **Shift+D** in the editor does
  it for you: it borrows the overlap from spare media on both sides of the cut
  (half each, or more from the side that has it), so nothing after the cut
  moves; for a linked shot the stems crossfade and B's picture dissolves in.
- **Auto-duck** — `fablecut_auto_duck {clipIds:[music…], under?:["A1"], amount?:-12,
  threshold?:-40, attack?:0.3, release?:0.6}` finds where the voice tracks
  (default: every other audio track) are above `threshold` dBFS — short gaps are
  bridged so the music doesn't pump between words — and writes `keyframes.duck`
  on the music: ramp down `attack` s before speech, hold, back up over
  `release` s. It replaces earlier ducking; `amount:0` clears it. Same as the
  inspector's **Auto-duck** section or the clip menu's *Auto-duck under other tracks*.
- In the editor, each audio clip shows its **volume line** (yellow; dashed =
  after ducking): drag it to change the level, Ctrl/Cmd-click to add a keyframe,
  drag a point to move it, Alt-click or double-click to remove one. The corner
  **fade grips** drag a constant-power fade in or out. Both edit linked stems together.
- Use **gain** for "this clip is too quiet / loud", **volume keyframes** for
  shaping, **duck** for dipping under dialogue, the **track fader** to
  balance whole lanes (dialogue against the music bed), and a **bus** when
  several lanes need the same processing or one fader.

### Color

A clip's color grade lives in `props.grade` on any video, image, svg or
adjustment clip (an adjustment layer grades everything below it). It runs on
the GPU (WebGL2; CPU fallback) **before** the clip is composited, in preview and
export alike, so it comes before the Filter / color sliders and presets, which
still apply on top. In the editor: the **Color** workspace (top bar) shows
scopes beside the program monitor and the **Color** tab beside the Inspector
has the wheels and sliders for the selected clip.

The grade is sparse: only keys that differ from neutral are stored.

| key | neutral | range | does |
|---|---|---|---|
| `exposure` | 0 | −5…5 | stops, in linear light |
| `temp` · `tint` | 0 | −100…100 | white balance in linear light: temp > 0 warmer, tint > 0 magenta (±100 ≈ ±1 stop per channel) |
| `lift` · `gamma` · `gain` · `offset` | [0,0,0,0] | each −1…1 | colour wheels, `[r, g, b, master]`; a channel's amount is its own value + master. offset adds, lift raises blacks keeping white (`x + l·(1−x)`), gain multiplies (`x·(1+g)`), gamma bends mids (`x^(1/2^γ)`, > 0 brighter) |
| `contrast` · `pivot` | 1 · 0.435 | 0…3 · 0.05…0.95 | log-style contrast `pivot·(x/pivot)^c` — blacks never crush |
| `blacks` `shadows` `midtones` `highlights` `whites` | 0 | −100…100 | tone bands on luma, darkest → brightest (smooth, overlapping) |
| `lowSoft` · `highSoft` | 0 | 0…100 | soft rolloff into black / white instead of a hard clip |
| `saturation` | 100 | 0…200 | around Rec.709 luma |
| `on` | true | — | `false` bypasses the grade without losing it |

Order: exposure + white balance → offset → lift → gain → gamma → contrast →
tone bands → rolloff → saturation.

**Wheel colours.** A wheel's `r, g, b` normally carry no brightness: they are a
point on the vectorscope's Cb / Cr plane, so pushing a wheel toward a colour
moves the picture's trace toward that colour's target. To tint shadows teal by
about 0.03: `lift: [-0.034, 0.008, 0.012, 0]` (r = 1.5748·Cr, g = −0.1873·Cb −
0.4681·Cr, b = 1.8556·Cb, with Cb = 0.0065, Cr = −0.0216 here). Small values go a
long way — ±0.02…0.05 on lift and offset, ±0.05…0.15 on gamma and gain.

**Agents** set a grade with the patch op `setGrade` and check it with
`fablecut_scopes`:

- `{op:"setGrade", id:"c_a", grade:{exposure:0.3, temp:-15, contrast:1.15}}` — merges
  into the clip's grade key by key; `null` on a key resets it; `replace:true`
  starts from neutral; `grade:null` clears it; `ids:[…]` grades several clips
  at once. Unknown keys or bad values refuse the whole patch. Locks apply
  (`force:true` as elsewhere).
- `fablecut_scopes {time}` renders the graded frame at `time` (default: the
  playhead) exactly as export would — an open editor tab, else headless — and
  returns numbers: luma min / 1st percentile / median / mean / 99th percentile /
  max (0–1), the % of pixels at pure black and pure white, mean R/G/B, average
  saturation, and the midtones' colour cast (hue name, hue angle, strength;
  "neutral" below 0.01), plus the clips on screen and their grades. With an
  `exportFrame` it measures the delivered crop.

Reading the numbers: a normally exposed shot has its median near 0.35–0.5;
`whitePct` above ~1 means clipped highlights (lower `highlights` / `whites`, or
add `highSoft`); `blackPct` above ~2 means crushed shadows. A cast strength
above ~0.03 on a scene that should be neutral wants white balance: move `temp`
against the cast (orange / yellow → lower temp; blue / cyan → raise it) and
`tint` against green / magenta, then measure again.

Workflow for matching shots: grade the hero shot, measure it, then grade every
other shot of the scene until its median and cast land near the hero's. In the
editor, **Copy** / **Paste** on the Color tab pastes one clip's grade onto every
selected clip.

### Semantics

- Rendering order: V1 is drawn first, then V2, V3, … on top. SVG/image/text clips
  go on any V track (higher V lanes are handy overlay lanes). Add lanes with the
  timeline **+V** / **+A** buttons (or by listing them in `tracks`); up to 16 per kind.
  Right-click an empty track header → **Remove track** (disabled if the lane has
  clips or is the last video/audio track).
- **Audio tracks A1–An** hold both standalone audio files *and* linked companions
 for imported video. Dropping a video creates the picture on a V track
 (`props.volume: 0` so it isn't doubled) plus one `kind:"audio"` clip per source
 channel on consecutive A-tracks that share a `linkGroup` (and the same
 `mediaId` / timing). Each stem is mono-isolated then placed with `pan` (defaults
 preserve stereo: L `−1`, R `+1`). Standalone music/SFX also live on A-tracks. Linked partners
 move/trim/split together — edit timing on any member of the group; do not treat
 A-tracks as music-only.
- **Three track switches** (Premiere-style), all in the track header and all
  persisted on `project.json`:
  - **Enable (eye / speaker)** → `disabledTracks`. Output only: a disabled lane
    is left out of preview, audio and export. It does *not* affect editing.
  - **Target (click the track name — lit = targeted)** → `untargetedTracks`.
    Decides which lanes an edit touches when nothing is selected: split at
    playhead (S), insert ripple (`,`), replace punches (`.`), ripple-delete
    shifting (⇧Del), close gap (⇧G), next gap (G), split / trim at IN/OUT
    (T / ⇧T) and jump to cut (↑ / ↓). Source placement follows targeting too:
    the picture lands on V1 if it is targeted, else the lowest targeted video
    lane (none → the edit lands audio-only); stems land on the first two
    targeted audio lanes. A **selection** is always edited wherever it sits.
  - **Lock (padlock)** → `lockedTracks`. Nothing on a locked lane can be
    moved, trimmed, split, deleted or edited in the inspector, and ripples leave
    it where it is while the other lanes shift. A locked lane is never an edit
    target. Typical use: lock the music bed, then ripple the picture freely.
- **Clip lock / enable** — right-click a clip, or use the toggles at the top of
  the inspector. `locked: true` pins one clip the same way a locked lane does.
  `disabled: true` (⇧E) keeps the clip on the timeline but drops it from
  preview, audio and export — like a disabled lane, for a single clip. Both
  apply to the clip's whole linked group.
- **Locks and linked groups** — a linked A/V group with *any* locked member
  (its own flag or its lane) counts as locked as a whole, so sync is never
  broken by a partial move.
- **Sync lock** — edits that shift clips move the targeted lanes; linked AV
  partners always ride along, even on an untargeted lane, and locked groups
  stay put. On reload `relinkClips` rebuilds `linkGroup` from matching
  mediaId / start / in / duration.
- **Unlink / link (Ctrl/Cmd+L)** — unlinking a group removes its `linkGroup`
  and stamps `unlinked: true` on each member, so the reload-time relink leaves
  them apart; picture and audio then move, trim and delete separately. Link
  (select one video clip plus its audio, Ctrl/Cmd+L) only joins clips of the
  same file that line up exactly — same start, in and duration — because a
  link here means identical timing.
- **Agents and locks** — `fablecut_patch_project` refuses `updateClip` /
  `removeClip` on locked material (own flag, locked lane, or a linked partner
  of one) and `addClip` onto a locked lane. Treat locked clips as the user's
  finished work: leave them alone. Only when the user asks you to change one,
  pass `force: true` on that op, or unlock first with
  `updateClip set:{locked:null}` (always allowed). `fablecut_set_project`,
  REST `PUT` and direct file edits are not guarded — respect locks there too.
- Media is `fit`-ted to the canvas (default "contain"), then crop → scale/x/y/
  rotation → flips apply.
- `props` keys are all optional — missing keys get the defaults above.
- Video/audio clips must satisfy `in + duration×speed ≤ media.duration`.
- Keyframes fully override the static prop value while present; they are
  clip-local and are re-based automatically when clips are split or trimmed.
- Transitions modulate the evaluated props (fade also fades audio); they render
  on top of keyframes, so both can coexist.
- Same-track overlap IS the crossfade idiom: overlap A and B by ~1 s and give B
  `transitionIn: {type:"fade"}` (for audio also A `transitionOut`, both with
  `curve:"power"` — see "Audio mix").
- A cut/split is just two clips: first with `duration: t`, second with
  `start: +t, in: +t×speed, duration: rest`.
- **Edit tools** (timeline toolbar picker, or V / B / R / Y / U) change what a
  clip drag does. Agents run the same edits with the patch ops `rippleTrim`,
  `roll`, `slip` and `slide` (see "Timeline edit ops").
  - **Selection (V)** — move and trim, as always.
  - **Ripple edit (B)** — drag a clip edge; everything after it on the targeted
    tracks (and the clip's own lanes) moves with it, so no gap opens or closes.
    Dragging a head keeps the clip's start and trims its source In.
  - **Rolling edit (R)** — drag a cut; the clip on one side lengthens by what
    the other loses, nothing else moves.
  - **Slip (Y)** — drag a clip to change its source In only (dragging left shows
    later source); position and length stay. Video / audio clips only.
  - **Slide (U)** — drag a clip along its track; the clip before it trims its
    tail and the clip after it its head, so the sequence length stays.
  All four are clamped to the available source media, MIN_DUR and the free
  room on the track, take linked partners with them, and refuse on locked
  clips; a readout by the pointer shows the offset while dragging.
- **Lift (;) / Extract (')** — remove IN→OUT on the targeted tracks. Lift
  leaves the gap; Extract closes it. Linked partners are cut too, locked clips
  stay whole, and IN / OUT clear afterwards.
- **Jump to cut** — `↑` / `↓` move the playhead to the previous / next clip
  In or Out. Selection first (that clip’s start then end); no selection walks
  targeted-track cuts. Source monitor: 0 / In / Out / duration. Does not change
  `project.json`.
- `bgRemove` and `chromaKey` can combine with all filters; heavy pixel work is
  automatic (only runs when those props are set).

## Remake a reference video (analyze → blueprint → rebuild)

Given a reference edit (a reel/montage the user likes), FableCut can analyze it
and hand back an **edit blueprint** so the same idea can be rebuilt with
different footage over the same music.

**Run the analysis** (any of):
- MCP: `fablecut_analyze_reference {path:"C:\\…\\ref.mp4"}` (absolute path or an
  existing `/media/...` src; copies the file into `media/` if needed)
- REST: `POST /api/analyze` body `{"src":"/media/ref.mp4", "threshold":0.3, "music":true}`
  (GET `/api/analyze?src=/media/ref.mp4` returns the cached result)
- CLI: `node analyze.js media/ref.mp4` (results also cached in `./analysis/<name>.json`)

**The blueprint** (needs ffmpeg on PATH):
```jsonc
{
  "duration": 21.4, "fps": 30, "width": 1080, "height": 1920,
  "cuts": [1.8, 3.1, ...],            // detected shot boundaries, seconds
  "shots": [                           // one entry per shot between cuts
    { "index": 0, "start": 0, "end": 1.8, "duration": 1.8, "energy": 42 } ],
  "avgShotLen": 1.4, "cutsPerSecond": 0.7,
  "beats": [0.51, 1.02, ...],          // music onsets — snap cut points to these
  "bpm": 118,                          // detected tempo
  "energy": { "step": 0.5, "values": [12, 30, ...] },  // loudness curve 0–100
  "drop": 8.5,                         // biggest musical rise — the money moment
  "music": { "name": "ref-music.m4a", "src": "/media/…", "mediaId": "m_x" }
}                                      // ^ extracted + registered by the MCP tool
```
`threshold` tunes cut sensitivity (default adapts 0.30→0.20→0.12): lower it if
obvious cuts were missed, raise it if motion is being misread as cuts.

**Rebuild recipe** — the analysis is deterministic; the creative mapping is yours:
1. `setProject`: copy the reference's `width/height/fps`; write `beats`
   (or the `cuts`) into `markers` so the user sees the grid.
2. Music: the extracted track on A1, `in:0, duration:<ref duration>`.
3. Structure: one clip per `shots[]` entry on V1 at the same `start`/`duration`
   (hard cuts by default — that's what shot detection saw). Pick source footage
   whose motion matches each shot's `energy` (calm ≤40, action ≥70), and choose
   each clip's `in` so something interesting happens inside the window.
4. The `drop`: put the hero shot there; classic garnish = a speed ramp landing
   on it, an impact `adjust` layer (shake+rgbSplit), or a whip transition.
5. Pacing garnish to taste: shots shorter than ~0.6 s read as beat-flashes;
   `avgShotLen` tells you the reference's overall pace. Captions/grade/SFX per
   the Recipes section — the blueprint gives structure, not style.

## REST API (alternative to file editing)

- `GET  /api/project` — current project JSON
- `PUT  /api/project` — replace project JSON (body = full document).
  **Conflict-safe**: if the body's `revision` ≤ the revision currently on disk,
  the server rejects with **409** and returns `{"error":"…","revision":<current>}`.
  Append `?force=1` to overwrite unconditionally. Writes are atomic (tmp file +
  rename), so a crashed write never corrupts the file.
- `GET  /api/media`   — list files in ./media (name, src, size)
- `GET  /api/library?dir=sfx|elements|svg|fonts` — list library assets
- `POST /api/upload?name=foo.mp4` — raw body saved into ./media, returns `{src}`.
  MP4/MOV/M4V uploads are auto-remuxed with `+faststart` (needs ffmpeg on PATH).
  Files copied straight into ./media by external tools skip this — remux big ones
  yourself (`ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`) or playback stalls.
- `POST /api/import-url` — body `{url:"https://…"}` downloads the file into
  `./media/` and returns `{src,name}` (same-origin `/media/…`, like upload).
  HTTPS only; rejects localhost, private/link-local/CGNAT addresses, and
  redirects to those. Remote SVG is refused (`/media/*.svg` is served
  same-origin as `image/svg+xml` — a scripted SVG opened as a document would
  run on the editor origin). Does not write `project.json` — register the media
  afterwards (UI and `fablecut_import_media` do this). Do **not** put a
  raw `https://` URL (or another origin, including `localhost` on a different
  port) in `media.src`: canvas CORS would taint the compositor and Fast /
  WebCodecs export cannot JPEG-encode. Import into `./media` so `src` is
  `/media/…`, or serve the remote with `Access-Control-Allow-Origin`.
- `POST /api/denoise` — body `{src:"/media/…", amount:"light"|"medium"|"strong"}`: writes a
  noise-reduced FLAC of the whole file into `./media/` (reused if it exists) and returns
  `{src, name, duration, channels}`. Does not touch `project.json` (see "Audio mix").
- `POST /api/analyze` — body `{src:"/media/ref.mp4", threshold?, music?}`: analyze a
  reference video into an edit blueprint (see "Remake a reference video"); extracts
  its music into ./media. `GET /api/analyze?src=…` returns the cached blueprint.
- `GET  /api/events`  — SSE: named event `change` when project.json, ./media or
  ./library changes; named event `profiles` when `encoding-profiles.json` changes
  (UI refreshes the export-profile list only — no project reload)
- Fast / WebCodecs export (browser compositor → server ffmpeg):
  `GET /api/export/ffmpeg` → `{available}` · `GET /api/export/profiles[?detail=1]` →
  `{default, profiles, issues}` · `POST /api/export/begin`
  `{fps,name,mode?,profile?,hasAudio?,pixelFormat?,width?,height?}` → `{id,mode,profile?,label,summary}`
  (`fps` is required — pass `project.fps`, no server-side default;
  `mode` is `"jpeg"` (default, Fast) or `"annexb"` (WebCodecs H.264 elementary stream);
  jpeg **400** if `profile` is not a defined id, or if ffmpeg rejects its args in the dry run;
  optional `pixelFormat:"rgba"` plus `width`/`height` pipes raw canvas frames instead of JPEG)
  · `POST /api/export/frame?id=` (JPEG body for jpeg mode; raw RGBA if `begin`
  used `pixelFormat:"rgba"`; Annex-B for annexb — one POST may concatenate frames
  or AUs. Must be after audio; ffmpeg is spawned on the first frame in both modes)
  · `POST /api/export/audio?id=` (WAV body — must be sent before the first frame)
  · `POST /api/export/end?id=[&discard=1]` → `{src}` under `/exports/`
- Export jobs (what `fablecut_export` drives): `POST /api/export/request`
  `{range?, profile?, where?:"auto"|"tab"|"headless"}` → `{id, status, via, …}`
  (409 if one is already running, or nothing can render it) · `GET /api/export/job?id=`
  → `{status: pending|running|done|failed|cancelled, progress 0–1, src, error}` ·
  `POST /api/export/job/cancel?id=`. The editor tab side: SSE event `export`
  (a ticket), `GET /api/export/job/ticket?id=`, `POST /api/export/job/claim?id=`
  (first tab wins, else 409), `POST /api/export/job/report?id=`
  `{progress} | {status:"done", src} | {status:"failed", error}` → `{cancel}`.

## Recipes

**Assemble a rough cut**: clips back-to-back on V1; each `start` = running sum
of previous durations.

**Insert / replace at playhead (3-point editing)**: load media into the Source
monitor (double-click a bin item or timeline clip), mark the window with I/O,
then `,` (insert icon) splits straddling clips on targeted tracks at the
playhead, ripples everything later to the right by the window length, and drops
the Source window in — video brings its linked audio stems. `.` (replace icon)
overwrites instead: punches the placement tracks (V1 + linked stems) over
[playhead, +window) with no ripple. Placement lanes are resolved against the
live track list and follow targeting — if V1 / A1 / A2 were removed or
untargeted, the lowest remaining targeted lanes of the right kind are used
instead. Locked clips are never punched or split. A locked clip loaded into
Source can't be retargeted with `.` (toast) until it is unlocked. When Source was loaded *from* a timeline
clip, `.` instead retargets that clip's In/Out (and its linked stems) and
ripples later clips on its tracks if the duration changed.

**Ripple delete**: select clip(s), then ⇧Del or the timeline-toolbar **Ripple
delete** — removes the selection (linked partners included) and pulls later
clips left on each targeted track to close the gap. Plain Del lifts (leaves a
gap). Sync lock applies: linked partners on untargeted tracks move with the
ripple, and locked clips are neither deleted nor moved. An unselected clip that merely *overlaps* the deleted range stays put —
its overlap ends up bridging the shifted-in clip, so a crossfade across the cut
survives.

**Tighten a cut without breaking the rest**: Ripple edit (B) on the tail of the
shot that runs long — the rest of the edit follows. To change where a cut
falls between two shots without shifting anything else, Rolling edit (R) the
cut. To keep a shot's timing but use a better take of the same moment, Slip
(Y) it. To pull a whole segment out of the middle: set IN / OUT around it and
Extract (').

**Jump to cut**: select a clip, then ↑ / ↓ — playhead snaps to its In, then
Out (further taps walk neighboring cuts). No selection → previous / next cut
on targeted tracks. Source monitor: same keys jump among 0 / In / Out / duration.

**Protect finished work**: lock the lanes you are done with (`lockedTracks`,
or the padlock), e.g. `setProject {lockedTracks:["A3"]}` for a music bed. Now
insert, ripple delete and close gap re-time the picture without touching it.
To try an alternative without deleting a clip, disable it (⇧E / `disabled:true`).

**Title card**: `{kind:"text", mediaId:null, track:"V2", props:{text,fontSize,color}}`.

**Music bed**: audio file on A1, `props.volume: 0.3`, trim with `in`/`duration`.

**Level a voice-over edit**: `fablecut_normalize_audio {clipIds:[…every VO clip…], target:-16}`
so all takes sit at one loudness, then keep the music on its own lane and pull
that lane down: `{op:"setTrack", id:"A3", set:{gain:-14}}`. Then dip it under the
voice: `fablecut_auto_duck {clipIds:[<music clip>], under:["A1"], amount:-10}`.

**Center a mono stem**: linked or standalone audio clip with `props.pan: 0` (inspector **Pan** slider, −1…+1). Stereo video stems default to L `−1` / R `+1`; set A1 to `0` to center that channel in the mix.

**Cinematic grade**: `props.filterPreset: "teal-orange"` (tweak with
`temperature`/`vignette` on top).

**Balanced, contrasty base grade** (then measure with `fablecut_scopes`):
`{op:"setGrade", id, grade:{contrast:1.15, pivot:0.42, shadows:-10, highlights:-20, highSoft:30, saturation:108}}`.
Teal shadows / warm highlights: add `lift:[-0.034, 0.008, 0.012, 0]` and `gain:[0.04, 0, -0.06, 0]`.
A grade on an adjustment layer over the whole edit = one look for every shot.

**Green-screen composite**: subject clip on V2 with
`props: {chromaKey:"#00ff00", chromaTolerance:30, chromaSoftness:15}`,
background footage on V1.

**Remove background without a green screen** (people):
`props: {bgRemove:true}` — then put anything behind it on V1.

**Picture-in-picture**: clip on V3 with
`props: {scale:0.35, x:380, y:-200, cornerRadius:24}` — add
`transitionIn: {type:"slide-right", duration:0.5}` to fly it in.

**Slow motion / timelapse**: `props.speed: 0.5` (half speed) or `4` (4×).
Remember the source window is `duration × speed`.

**Speed ramp** (the reel move — fast into slow on the beat):
`keyframes: { speed: [ {t:0, v:3}, {t:1.1, v:3}, {t:1.3, v:0.4, "ease":"ease-out"} ] }`
— sync the drop (t:1.3) to a marker; add `transitionIn:{type:"whip",duration:0.2}` before it.

**Impact hit**: adjustment layer, 0.25–0.4 s at the hit:
`{kind:"adjust", track:"V3", props:{shake:20, rgbSplit:8}}` + `impact-hit.mp3`
from `library/sfx` on A2.

**VHS / glitch look**: `props: {rgbSplit:4, grain:35, saturation:120}` +
`library/elements/vhs-scanlines.svg` on V3 with `blend:"soft-light", fit:"stretch"`.
Cut between shots with `transitionIn:{type:"glitch",duration:0.3}`.

**Film look**: adjustment layer across the whole edit:
`props: {filterPreset:"cinematic", grain:18}` — one clip grades every shot.

**Neon caption**: `props: {glow:60, glowColor:"#22d3ee", color:"#ffffff",
font:"Bebas Neue", textAnim:"wave"}` on a dark shot.

**Light leak accent**: `library/elements/light-leak-warm.svg` on V3,
`props:{blend:"screen", fit:"cover", opacity:0.7}`, 1–2 s at scene changes,
`transitionIn/Out: fade`.

**Light-leak / dust overlay**: element from `library/elements` on V3 with
`props: {blend:"screen", opacity:0.6, fit:"cover"}`.

**Reel caption**: text clip with `props: {textAnim:"word-pop", wordRate:0.15,
strokeWidth:6, bgColor:"#000000", bgOpacity:0.45, fontSize:88}`. `karaoke`
dims words until "spoken"; `typewriter` for terminal vibes.

**RTL / Hebrew / Arabic caption**: omit `direction` (defaults to `"auto"`) or set
`direction:"rtl"` explicitly; pick a font with the script's glyphs (Google Fonts
work). Animations wipe and stagger in reading order automatically. `letter-pop` /
`wave` animate whole words on Arabic/Indic lines (not isolated letters) so
cursive joining stays correct.

**Branded title**: `props: {font:"Bebas Neue", weight:700, letterSpacing:6,
uppercase:true, color:"#ffffff", color2:"#7b6cff", textShadow:20}` — any Google
Font name just works.

**Kinetic font-cut title** (rhythmic typeface cuts on the beat, then settle):
`props: {font:"Bebas Neue", fontSize:120, uppercase:true, color:"#ffd166",
textAnim:"font-cut", fontCutSet:["Anton","Bebas Neue","Archivo Black","Oswald"]}`.

**Elegant clip-on title** (letters wipe in): `props: {font:"Playfair Display",
fontSize:88, color:"#ffffff", color2:"#ffd166", letterSpacing:2,
textAnim:"clip-reveal"}` — centered, one clean sweep.

**Lower-third reveal**: `props: {font:"Archivo Black", fontSize:92,
uppercase:true, textAnim:"rise-mask", y:<height*0.30>}` — the line rises from
behind its baseline. Pair with a `serifDrop`/`zoom-in` kicker above it.

**Custom font**: drop `MyBrand.ttf` into `library/fonts/`, then
`props.font: "MyBrand"`.

**Animated sticker**: author an SVG (convention above) into `library/svg/`,
register `{kind:"svg", src:"/library/svg/foo.svg"}`, clip on V2/V3. Scale/move/
rotate with normal props & keyframes; the SVG's own CSS animation plays on top,
frame-accurately.

**Whoosh on a cut**: 0.4 s sfx clip from `library/sfx` on A2 aligned to the cut.

**Ken Burns** (slow push on a photo):
`keyframes: { scale:[{t:0,v:1},{t:D,v:1.2,ease:"linear"}], x:[{t:0,v:0},{t:D,v:-40,ease:"linear"}] }`.

**Crossfade**: overlap two clips on the same track by ~1 s; later clip gets
`transitionIn: {type:"fade", duration:1}`. For audio give the earlier clip the
matching `transitionOut` and both `curve:"power"` (or select a clip and press
Shift+D in the editor).

**Whip-pan cut**: A gets `transitionOut:{type:"whip",duration:0.25}`, B gets
`transitionIn:{type:"whip",duration:0.25}`.

**Beat-synced cut**: write beat times into `markers`, then align clip `start`s
to them (the UI also snaps drags to markers).

**Label the structure**: write named, coloured markers for sections the user
can jump between (⇧M / Alt+⇧M, or the Markers list):
`setProject {markers:[{t:0,label:"intro",color:"blue"},{t:8.5,label:"drop",color:"red"},{t:24,label:"outro",color:"purple"}]}`.
`setProject` replaces the whole list — include the existing markers you want to keep.

**Music fade-out**: audio clip `keyframes: { volume:[{t:D-3,v:0.8},{t:D,v:0}] }`
or simply `transitionOut: {type:"fade", duration:3, curve:"exp"}`.

**Pulse / emphasis**: `keyframes: { scale:[{t:0,v:1},{t:0.3,v:1.12},{t:0.6,v:1}] }`.

**Reframe horizontal → vertical**: keep a wide composition canvas and crop for
delivery — e.g. `width:1920, height:1080` with
`exportFrame:{x:656,y:0,w:608,h:1080}` (9:16 fitted to canvas height). Position
footage with clip `x`/`y`/`scale`; the export frame can be dragged in the UI.
Omit `exportFrame` to export the full canvas.

**Vertical reel**: set project `width:1080, height:1920`; use the UI's safe-area
guides (▦) to keep captions out of platform UI zones.

**Project frame rate**: set `fps` in `project.json` (or the Program Monitor FPS
dropdown — 24 / 25 / 30 / 50 / 60). Preview stepping, timecode frames, Fast /
WebCodecs / Realtime export, and `/api/export/begin` all use this value; pass the same
`fps` when starting an export via the API.

## Export

Export is the Export button → dialog, or `fablecut_export` from an agent (below). Three engines:

1. **Fast** — browser renders each frame with the normal compositor (SVG, keys,
   AI masks), streams JPEGs + an offline WAV mix to the server; a single ffmpeg
   pass encodes them via an **encoding profile** into `./exports/`. Quality /
   software path; keeps rendering if you switch tabs.
2. **WebCodecs** — same frame-accurate compositor loop, but the browser’s
   `VideoEncoder` produces Annex-B H.264 (Main 4:2:0) and the server stream-copies
   (`-c:v copy`) while muxing the WAV. Faster uploads, less server CPU. Requires
   Chromium-class `VideoEncoder` with `avc: { format: "annexb" }` plus ffmpeg.
   Encoding profiles do not apply (the bitstream is already encoded). No ffmpeg-style
   CRF — quality is bitrate + VBR/CBR (export dialog; remembered in localStorage).
   Optional `bitrateMode: "quantizer"` (fixed QP) exists in the spec but is rarely
   supported by hardware encoders with Annex-B. Unavailable while an `exportFrame`
   crop is set — use Fast for cropped delivery.
3. **Realtime (MediaRecorder)** — automatic offline fallback when the server,
   ffmpeg, or WebCodecs is unavailable. Plays the timeline once and records it;
   keep the tab focused.

The exported span is chosen in the Export dialog (**Range**: Entire
timeline / IN–OUT). IN–OUT is the default when `inPoint` / `outPoint` are
set; pick Entire timeline to keep those markers for split/trim. Effective
IN/OUT export bounds are clamped to `projDur` so an IN past the last clip
cannot produce a one-frame black file.

1. Entire timeline (or no markers) → the whole timeline
2. IN–OUT, IN only → from `inPoint` to the end
3. IN–OUT, OUT only → from the start to `outPoint`
4. IN–OUT, both → the range between them

**Agents export with `fablecut_export`** (or `POST /api/export/request`). It is
the same Fast export as the button — same compositor, audio mix and encoding
profile — so it needs ffmpeg on PATH. The job goes to an open editor tab (the
user sees the progress bar), or, with none open, the server starts a headless
Chrome / Edge on the editor and closes it when the file is written
(`FABLECUT_CHROME` picks the browser). The tab first loads the revision the
agent last wrote, so an export right after a patch includes that patch.

- `fablecut_export {}` — waits, then returns the file path under `exports/`.
  Range: `inPoint`→`outPoint` when either is set, else the whole timeline;
  `range:"entire"|"in-out"` overrides. `profile:"hq"` picks an encoding profile.
- `where:"headless"` renders in the background and leaves the user's tab alone;
  `where:"tab"` refuses if no tab is open.
- Long edits: `wait:false` returns a job id at once; poll with `{job:"x_…"}`
  and stop one with `{cancel:"x_…"}`. One export runs at a time.

### Encoding profiles (`encoding-profiles.json`)

User-editable at the repo root. A profile is a **raw ffmpeg argument list** plus the
things that are not ffmpeg arguments: `jpegQuality` (browser frame quality),
`extension` (output container), and optional `color` (output matrix / range tags).
Edit the file while the server runs — the UI hot-reloads the profile list via an SSE
`profiles` event (no full project reload). Fast export only; WebCodecs ignores them.

```jsonc
{
  "default": "delivery",           // profile id used when nothing else is set
  "profiles": {
    "draft": {
      "label": "Draft · H.264 fast",
      "description": "Quick preview — smaller file, faster encode.",
      "jpegQuality": 0.85,         // browser JPEG frame quality (0.1–1)
      "extension": ".mp4",
      // Output color (optional — defaults to BT.709 limited/tv). Independent of
      // -pix_fmt: yuv420p and yuv422p10le both typically use bt709 for HD SDR.
      "color": { "matrix": "bt709", "primaries": "bt709", "trc": "bt709", "range": "tv" },
      "args": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
               "-movflags", "+faststart", "-shortest"]
    }
  }
}
```

Export is **one ffmpeg pass**. The server owns the input side and the output path;
`args` is everything in between (plus JPEG color conversion derived from `color`):

```
ffmpeg -y -f image2pipe -framerate <fps> -i - [-i audio.wav] <jpeg-color> <args…> exports/<name><extension>
```

- **There is no allow-list.** Any codec, filter, container or flag your local ffmpeg
  supports works — ProRes, DNxHD, NVENC/QSV/VideoToolbox, VP9/AV1, 10-bit, HDR tags.
  See the shipped `prores422` and `broadcast1080i50` profiles.
- **Args are validated by ffmpeg itself**, not by a schema: when an export starts the
  server dry-runs the profile against a 0.1 s synthetic input (`lavfi`). A typo or an
  encoder your build lacks is rejected up front with ffmpeg's own message, instead of
  failing after every frame has been rendered.
- Use the **array form** — each element is passed to `spawn` untouched, so no quoting
  is needed (`["-vf", "drawtext=text='hi there'"]` just works). A plain string is
  accepted and split on whitespace.
- **`color`** controls JPEG→YUV conversion and stream tags (`-colorspace` /
  `-color_primaries` / `-color_trc` / `-color_range`). Default is BT.709 limited
  (`range: "tv"`). Use `"range": "pc"` for full-range masters. Do **not** put those
  flags in `args` — the engine strips them and applies `color` so vf and tags stay
  aligned. `-pix_fmt` stays in `args` (sampling / bit depth only).
- Nothing else is injected for you: `+faststart`, `-shortest`, `-strict -2` for Opus
  in MP4 and pixel-format choices are all yours to write.
- Frames arrive as **JPEG (4:2:0)**, so `yuv422p`/`yuv444p` cannot recover chroma the
  source never had; raise `jpegQuality` before reaching for a wider pixel format.
  Optional `pixelFormat:"rgba"` on `/api/export/begin` pipes uncompressed canvas
  frames instead (`-f rawvideo`) when a caller wants full chroma.
- The audio mix is only present when the timeline has audio; with no audio there is a
  single input, so avoid hardcoded `-map 1:a`.

**Note:** Fast export pipes **composited JPEG frames** from the browser (`-f image2pipe`),
not `-i source.mp4`. Filters and codec settings apply to that frame stream. To transcode
an existing file verbatim, run ffmpeg directly — that is outside the compositor path.

**Which profile is used (priority):**
1. Profile picked in the Export dialog (one-off; saved to browser settings unless overridden)
2. `project.encodeProfile` — set via UI reload or `{op:"setProject", set:{encodeProfile:"hq"}}`
3. Browser setting `encodeProfile` in localStorage (set when you change the Export dropdown)
4. `default` in `encoding-profiles.json`

**MCP:** `fablecut_encode_profiles` lists profiles; `{detail:true}` includes each `args`
array; `{profile:"hq"}` returns one profile. `fablecut_status` shows the effective profile.
