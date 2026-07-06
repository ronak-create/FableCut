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
- `fablecut_docs` — returns this document.
- `fablecut_get_project` / `fablecut_set_project` — read / replace the timeline JSON.
- `fablecut_import_media` — copy a local file into `./media/` and register it.

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
  "revision": 7,                              // bump on every write!
  "markers": [ { "t": 2.5 }, { "t": 5.0, "label": "drop" } ],
  // ^ beat/cue markers: gold diamonds on the ruler, snap targets for clip edges.
  "media": [
    { "id": "m_abc", "name": "intro.mp4", "kind": "video",  // video|audio|image|svg
      "src": "/media/intro.mp4",             // path under ./media or ./library
      "duration": 12.4, "width": 1920, "height": 1080 }
  ],
  "clips": [
    {
      "id": "c_xyz",             // unique string
      "mediaId": "m_abc",        // null for kind:"text"
      "kind": "video",           // video | audio | image | svg | text
      "track": "V1",             // V4 V3 V2 V1 (top→bottom video) | A1 A2 A3 (audio)
      "start": 0,                // timeline position, seconds
      "in": 2.5,                 // offset into source media, seconds (0 for image/svg/text)
      "duration": 5,             // clip length on timeline, seconds
      "name": "intro",
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
| `filterPreset` | "none" | one of: cinematic · teal-orange · noir · vintage · faded · warm · cold · pop · dreamy · retro · bw-soft · cyberpunk. Combines non-destructively with the sliders below. |
| `brightness` `contrast` `saturation` | 100 | % (100 = neutral) |
| `hue` | 0 | degrees |
| `temperature` | 0 | −100 (cool blue) … +100 (warm orange) |
| `tint` | 0 | −100 (magenta) … +100 (green) |
| `blur` | 0 | px |
| `grayscale` `sepia` `invert` `vignette` | 0 | % |

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
| `speed` | 1 | 0.25–4× playback rate. Source window consumed = `duration × speed`, so `in + duration×speed ≤ media.duration`. |

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
| `align` | "center" | left · center · right (multi-line block alignment) |
| `letterSpacing` | 0 | px |
| `lineHeight` | 1.2 | multiplier |
| `textShadow` | 12 | soft drop shadow amount, 0 = off |
| `strokeWidth` `strokeColor` | 0, "#000" | text outline |
| `bgColor` `bgOpacity` | "#000", 0 | rounded pill behind each line |
| `textAnim` | "none" | typewriter · word-pop · word-slide · karaoke |
| `wordRate` | 0.15 | seconds per word (typewriter: /4 per character) |

**Animatable props** (usable in `keyframes`): x, y, scale, rotation, opacity,
volume, brightness, contrast, saturation, hue, blur, grayscale, sepia, invert,
temperature, tint, vignette, cornerRadius, fontSize, letterSpacing.

**Transition types**: fade · slide-left/right/up/down · zoom · wipe (=wipe-left)
· wipe-right/up/down · iris (circular) · spin · blur · whip (whip-pan).

### Semantics

- Rendering order: V1 is drawn first, then V2, V3, V4 on top. A video clip's own
  audio plays with it (control via `props.volume`); A1/A2/A3 are for standalone
  audio files. SVG/image/text clips go on any V track (V3/V4 are handy overlay
  lanes).
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

## REST API (alternative to file editing)

- `GET  /api/project` — current project JSON
- `PUT  /api/project` — replace project JSON (body = full document)
- `GET  /api/media`   — list files in ./media (name, src, size)
- `GET  /api/library?dir=sfx|elements|svg|fonts` — list library assets
- `POST /api/upload?name=foo.mp4` — raw body saved into ./media, returns `{src}`.
  MP4/MOV/M4V uploads are auto-remuxed with `+faststart` (needs ffmpeg on PATH).
  Files copied straight into ./media by external tools skip this — remux big ones
  yourself (`ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`) or playback stalls.
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

**Light-leak / dust overlay**: element from `library/elements` on V4 with
`props: {blend:"screen", opacity:0.6, fit:"cover"}`.

**Reel caption**: text clip with `props: {textAnim:"word-pop", wordRate:0.15,
strokeWidth:6, bgColor:"#000000", bgOpacity:0.45, fontSize:88}`. `karaoke`
dims words until "spoken"; `typewriter` for terminal vibes.

**Branded title**: `props: {font:"Bebas Neue", weight:700, letterSpacing:6,
uppercase:true, color:"#ffffff", color2:"#7b6cff", textShadow:20}` — any Google
Font name just works.

**Custom font**: drop `MyBrand.ttf` into `library/fonts/`, then
`props.font: "MyBrand"`.

**Animated sticker**: author an SVG (convention above) into `library/svg/`,
register `{kind:"svg", src:"/library/svg/foo.svg"}`, clip on V3/V4. Scale/move/
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
