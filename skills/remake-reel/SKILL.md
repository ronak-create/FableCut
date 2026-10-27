---
description: Analyze a reference video (a reel, montage, or ad the user likes) into an edit blueprint — shot boundaries, music beats, BPM, energy curve, the drop — and rebuild the same structure with the user's own footage. Use when someone says "make it like this video", "remake this reel with my clips", or asks what makes an edit tick.
---

# Remaking a reference edit

Given a video the user likes, FableCut extracts what is *measurable* about the
edit — where the cuts land, where the beats are, how energy moves — and hands it
back as a blueprint. The structure is deterministic; the creative mapping onto
new footage is yours.

## Get the blueprint

```
fablecut_analyze_reference {path:"C:\\…\\ref.mp4"}
```

Needs ffmpeg on PATH. It returns shot boundaries (`cuts`, `shots[]` with a
per-shot `energy` 0–100), music `beats[]` and `bpm`, a loudness `energy` curve,
and `drop` — the biggest musical rise. It also extracts the reference's music
track into the project and registers it as media, so the rebuild can sit on the
same song.

If obvious cuts were missed, lower `threshold`; if camera motion is being read
as cuts, raise it.

## Rebuild

1. Match the canvas: copy the reference's `width`/`height`/`fps` onto the
   project. Write `beats` into `markers` so the user can see the grid and the UI
   snaps drags to it.
2. Music on A1, `in: 0`, running the full reference duration.
3. One clip per `shots[]` entry on V1 at the same `start` and `duration`. Match
   footage to each shot's `energy` — calm material under ~40, motion over ~70 —
   and choose each clip's `in` so something actually happens inside the window.
4. Land the hero shot on `drop`. The standard garnish is a speed ramp settling
   into it, an `adjust` layer with `shake` + `rgbSplit` for one impact frame, or
   a whip transition on the way in.
5. Pace to taste: shots under ~0.6 s read as beat-flashes. `avgShotLen` tells
   you the reference's overall rhythm.
6. With the user's own music instead of the reference's, `fablecut_beats
   {clipId}` finds its tempo, beat and drop; `snap:true` rolls the cuts onto
   the beat, `retime:{every:2}` re-cuts V1 so each shot lasts 2 beats.
7. Posting it vertically: `fablecut_reframe {aspect:"9:16"}` makes a copy whose
   shots follow their subject.

Full recipe, including the exact keyframe shapes for speed ramps and impact
layers: `fablecut_docs {section:"Remake a reference video"}` and
`fablecut_docs {section:"Recipes"}`.

## Be honest about what this does

The blueprint captures *structure* — timing, pacing, where the energy sits. It
does not capture look, subject, or performance. Tell the user that a rebuild
matches the rhythm of the reference and that the grade, footage, and titles are
separate choices, rather than implying the result will look like the original.

Only analyze video the user has the right to use as a reference, and don't
reproduce a reference's actual footage — the point is to reuse the structure
with their own material.
