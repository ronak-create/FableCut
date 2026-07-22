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
- `fablecut_import_media` — copy a local file into `./media/` and register it.
- `fablecut_analyze_reference` — turn a reference video into an edit blueprint
  (shots, beats, BPM, energy, drop) + extract its music. See "Remake a reference video".

### Token-efficient editing (important for agents)

Editing via full get→modify→set costs thousands of tokens per change. Cheaper:

1. **Plan** from `fablecut_get_project {compact:true}` (≈10× smaller than the JSON)
   and `fablecut_status` — fetch the full JSON only to inspect exact keyframes.
2. **Edit** with `fablecut_patch_project` ops — send only what changes, e.g.
   `{ops:[{op:"updateClip", id:"c_v2", set:{props:{filterPreset:"noir"}}}]}`.
   It re-reads the latest document internally, so it is merge-safe by design
   (no CONFLICT dance) and never destroys concurrent UI tweaks.
3. **Docs**: request `fablecut_docs {section:"props"}` (or "Recipes", "Remake", …)
   instead of the whole manual; skip it entirely if the schema is already in context.
4. **Media questions** (duration, fps, size): read them from the registered media
   entries — don't shell out to ffprobe; the browser probes and writes them back.
5. Batch related changes into ONE patch call (ops apply in order, one revision bump).

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

## Run

```
node server.js        # → http://localhost:7777
```

Files: `index.html` + `style.css` + `app.js` (editor UI), `server.js` (API + hosting),
`project.json` (the timeline — THE file to edit), `media/` (project footage),
`library/` (default asset library, see below).

## How Claude Code edits a video

1. Ensure the server is running (background: `node server.js`, or `fablecut_status`).
2. Put source files in `./media/` (copy them in, or the user imports via the UI).
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
| `library/fonts/`    | font editor  | `.ttf/.otf/.woff/.woff2`, auto-registered, family name = file name |

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
  "width": 1280, "height": 720, "fps": 30,   // canvas/export settings
  "background": "#000000",                    // canvas color behind all clips (optional)
  "revision": 7,                              // bump on every write!
  "markers": [ { "t": 2.5 }, { "t": 5.0, "label": "drop" } ],
  // ^ beat/cue markers: gold diamonds on the ruler, snap targets for clip edges.
  "inPoint": 10.023, // in timeline marker; paired with outPoint sets the focus on the part of the timeline
  "outPoint": 21.500, // out timeline marker
  "disabledTracks": [ "A2" ],
  // ^ optional — track ids (V4 V3 V2 V1 A1 A2 A3) omitted from preview/export when listed
  "media": [
    { "id": "m_abc", "name": "intro.mp4", "kind": "video",  // video|audio|image|svg
      "src": "/media/intro.mp4",             // path under ./media or ./library
      "duration": 12.4, "width": 1920, "height": 1080 }
  ],
  "clips": [
    {
      "id": "c_xyz",             // unique string
      "mediaId": "m_abc",        // null for kind:"text" and kind:"adjust"
      "kind": "video",           // video | audio | image | svg | text | adjust
      "track": "V1",             // V3 V2 V1 (top→bottom video) | A1 A2 A3 A4 (audio)
      "start": 0,                // timeline position, seconds
      "in": 2.5,                 // offset into source media, seconds (0 for image/svg/text)
      "duration": 5,             // clip length on timeline, seconds
      "name": "intro",
      "linkGroup": "lg_abc",     // OPTIONAL — AV link: video + its L/R audio companions share one id
      "props": { /* all optional — see the props reference below */ },
      // OPTIONAL — keyframe animation. Times are seconds RELATIVE TO CLIP START.
      // "ease" sits on the DESTINATION keyframe of each segment:
      // linear | ease-in | ease-out | ease-in-out (default ease-in-out).
      "keyframes": {
        "scale":   [ { "t": 0, "v": 1 }, { "t": 5, "v": 1.25, "ease": "linear" } ],
        "opacity": [ { "t": 0, "v": 0 }, { "t": 0.8, "v": 1 } ]
      },
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
| `volume` | 1 | 0–2 |
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
volume, speed, brightness, contrast, saturation, hue, blur, grayscale, sepia,
invert, temperature, tint, vignette, cornerRadius, shake, rgbSplit, grain,
fontSize, letterSpacing, glow.

**Transition types**: fade · slide-left/right/up/down · zoom · wipe (=wipe-left)
· wipe-right/up/down · iris (circular) · spin · blur · whip (whip-pan) ·
glitch (RGB split + jitter) · pop (overshoot scale — stickers/captions).

### Semantics

- Rendering order: V1 is drawn first, then V2, V3 on top. SVG/image/text clips
  go on any V track (V2/V3 are handy overlay lanes).
- **Audio tracks A1–A4** hold both standalone audio files *and* linked companions
  for imported video. Dropping a video creates the picture on a V track
  (`props.volume: 0` so it isn't doubled) plus stereo L/R `kind:"audio"` clips
  on A1/A2 that share a `linkGroup` (and the same `mediaId` / timing). Standalone
  music/SFX also live on A1–A4. Linked partners move/trim/split together — edit
  timing on any member of the group; do not treat A-tracks as music-only.
- Media is `fit`-ted to the canvas (default "contain"), then crop → scale/x/y/
  rotation → flips apply.
- `props` keys are all optional — missing keys get the defaults above.
- Video/audio clips must satisfy `in + duration×speed ≤ media.duration`.
- Keyframes fully override the static prop value while present; they are
  clip-local and are re-based automatically when clips are split or trimmed.
- Transitions modulate the evaluated props (fade also fades audio); they render
  on top of keyframes, so both can coexist.
- Same-track overlap IS the crossfade idiom: overlap A and B by ~1 s and give B
  `transitionIn: {type:"fade"}`.
- A cut/split is just two clips: first with `duration: t`, second with
  `start: +t, in: +t×speed, duration: rest`.
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
- `POST /api/analyze` — body `{src:"/media/ref.mp4", threshold?, music?}`: analyze a
  reference video into an edit blueprint (see "Remake a reference video"); extracts
  its music into ./media. `GET /api/analyze?src=…` returns the cached blueprint.
- `GET  /api/events`  — SSE, emits `change` when project.json, ./media or ./library changes
- Fast export (used by the UI; browser renders frames, ffmpeg encodes):
  `GET /api/export/ffmpeg` → `{available}` · `POST /api/export/begin` `{fps,name}` → `{id}`
  · `POST /api/export/frame?id=` (JPEG body, in order) · `POST /api/export/audio?id=` (WAV body)
  · `POST /api/export/end?id=[&discard=1]` → `{src}` under `/exports/`

## Recipes

**Assemble a rough cut**: clips back-to-back on V1; each `start` = running sum
of previous durations.

**Title card**: `{kind:"text", mediaId:null, track:"V2", props:{text,fontSize,color}}`.

**Music bed**: audio file on A1, `props.volume: 0.3`, trim with `in`/`duration`.

**Cinematic grade**: `props.filterPreset: "teal-orange"` (tweak with
`temperature`/`vignette` on top).

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
`transitionIn: {type:"fade", duration:1}`.

**Whip-pan cut**: A gets `transitionOut:{type:"whip",duration:0.25}`, B gets
`transitionIn:{type:"whip",duration:0.25}`.

**Beat-synced cut**: write beat times into `markers`, then align clip `start`s
to them (the UI also snaps drags to markers).

**Music fade-out**: audio clip `keyframes: { volume:[{t:D-3,v:0.8},{t:D,v:0}] }`
or simply `transitionOut: {type:"fade", duration:3}`.

**Pulse / emphasis**: `keyframes: { scale:[{t:0,v:1},{t:0.3,v:1.12},{t:0.6,v:1}] }`.

**Vertical reel**: set project `width:1080, height:1920`; use the UI's safe-area
guides (▦) to keep captions out of platform UI zones.

## Export

Export is user-driven (Export button → dialog). Two engines: **Fast** (browser
renders each frame with the normal compositor — including SVG frames, keys and
AI masks — streams JPEG frames + an offline WAV mix to the server, ffmpeg
encodes a CRF-18 faststart MP4 into `./exports/`) and **Realtime**
(MediaRecorder fallback). Claude cannot trigger export headlessly — the
compositor lives in the browser; ask the user to click Export, or render with
ffmpeg directly from `media/` sources if a file is needed.
