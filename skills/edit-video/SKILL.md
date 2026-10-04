---
description: Edit video with FableCut — assemble a cut, add titles and captions, grade, add transitions, keyframe animation, speed ramps, and export. Use whenever the user wants to cut, trim, caption, subtitle, grade, or otherwise edit a video, or asks to open/start the video editor.
---

# Editing video with FableCut

FableCut is a browser video editor whose entire timeline is one JSON document.
You edit video by patching that document; the open editor UI hot-reloads within
~150 ms, so the user watches the timeline rebuild as you work.

## Start here, every time

1. **`fablecut_status`** — starts the editor server if it isn't running and
   returns the URL, the current project summary, and what's in `media/`. Call it
   before anything else. If the user doesn't have a browser tab open, tell them
   the URL so they can watch.
2. **`fablecut_docs`** — the full manual: `project.json` schema, every prop,
   transitions, text animations, and a recipe book. Request a single section
   (`{section:"props"}`, `{section:"Recipes"}`) rather than the whole document.
   Skip it entirely if the schema is already in context.

## Making edits

**Prefer `fablecut_patch_project`.** It sends only what changes, re-reads the
latest document internally, and is merge-safe — it will not clobber a tweak the
user just made in the UI. Batch related changes into one call; ops apply in
order and bump the revision once.

```
fablecut_patch_project {ops:[
  {op:"updateClip", id:"c_v2", set:{props:{filterPreset:"teal-orange"}}}
]}
```

Use `fablecut_get_project {compact:true}` to plan — it's roughly 10× smaller
than the full JSON. Fetch the full document only when you need exact keyframes.

`fablecut_set_project` replaces the whole document and is conflict-checked: if
the user edited in the UI since your last read, it refuses rather than
overwriting. On conflict, re-read, re-apply your change, and call it again.

## Getting footage in

`fablecut_import_media` copies a local file into the project and registers it.
Media entries may omit `duration` — the browser probes it and writes it back, so
re-read after a moment instead of shelling out to ffprobe.

## Things that trip people up

- Cut, ripple, trim and insert with the `fablecut_patch_project` edit ops
  (`split`, `rippleDelete`, `extract`, `insert`, `rippleTrim`, `roll`,
  `slip`, `slide`, `crossfade`) instead of recomputing `start` / `in` by
  hand — they keep linked audio stems in sync and respect the user's locks.
- Video and audio clips must satisfy `in + duration×speed ≤ media.duration`.
- Crossfades are same-track overlap plus `transitionIn: {type:"fade"}` on the
  later clip — not a separate object.
- Vary the font per title. Reusing one typeface across a whole edit is the
  single clearest tell of a machine-made cut; `fablecut_docs {section:"Text"}`
  lists the built-in title styles.
- **Grade** with the `setGrade` patch op (`props.grade`: exposure, temp / tint,
  lift / gamma / gain / offset wheels, tone bands, contrast, saturation) and
  check every grade with `fablecut_scopes` — median luma near 0.35–0.5, no
  clipped whites, cast strength under ~0.03 on neutral scenes.
  `fablecut_docs {section:"Color"}` has the keys and how to read the numbers.
- **Export** with `fablecut_export` — the editor's own Fast export, in the
  user's open tab or a headless Chrome / Edge. It needs ffmpeg on PATH; it
  waits for the file and returns its path.
