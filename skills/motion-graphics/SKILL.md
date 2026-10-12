---
description: Build motion graphics in FableCut — shape layers (rectangles, ellipses, polygons, stars, lines, bezier paths, groups), draw-on trim paths, null objects, parenting, anchor points, curved motion paths with auto-orient, motion blur, text on a path, reusable compositions (nested sequences), animation presets and templates (lower thirds, logo animations, social layouts), all keyframed. Use when the user wants a lower third, an animated logo or icon, a callout, a progress bar or loading ring, shapes that pop or slide in, a title that "comes in" or "goes out", a vertical story or a quote card, a graphic reused across the edit, or anything to "move together", "orbit", "draw on" or "precompose".
---

# Motion graphics with FableCut

Motion graphics in FableCut are ordinary clips on the timeline, so everything
you know about clips (tracks, keyframes, transitions, masks, blend) still
applies. Three pieces do the work:

- **Shape layer**: a clip with `kind:"shape"` that draws vector items from
  `props.shapes`. It stays sharp at any scale and needs no media.
- **Null**: a clip with `kind:"null"` that never renders. It exists to be a
  parent.
- **Parent**: `"parent":"<clip id>"` makes a clip move, turn and scale with
  another one. Every visual clip also has an **anchor point** (`anchorX`,
  `anchorY`) that it turns and scales around.

For the full key table, read `fablecut_docs {section:"schema"}` once and see
its "Shapes, nulls and parenting", "Motion paths, motion blur and text on a
path", "Compositions (nested sequences)" and "Presets and templates" parts. The notes below cover how to use it well.

## Coordinates (get these right first)

- A clip's `x`/`y` are px from the **canvas centre**. When it has a parent,
  they are px from the **parent's centre**, in the parent's turned and scaled
  space.
- A shape item's `x`/`y` are px from the **layer's origin** (the layer clip's
  `x`/`y`). Path and line `points` are px around the item's own `x`/`y`.
- `rotation` is in degrees, clockwise, and y points down.
- Item `keys[].t` and clip `keyframes[].t` are seconds from the **clip's
  start**, not from the timeline.

## Workflow

1. `fablecut_get_project {compact:true}` to see the tracks and what is free.
   Shapes usually go on V2/V3 above the footage.
2. Add the layer with its items in one `addClip`, or add an empty layer and
   then `setShape` items into it by name. Name every item you plan to touch
   again (`name:"Bar"`), so later edits say `shape:"Bar"` and not an index.
3. Animate the items with `keys`, and the whole layer with clip `keyframes`
   (`x`, `y`, `scale`, `rotation`, `opacity`, `trimEnd`, and so on).
4. Group things that move as one: put shapes in a `group` item inside a layer,
   or parent whole clips (titles, images, other layers) to a null with
   `setParent`.
5. Check it: `fablecut_get_project {compact:true}` shows each layer as
   `[3 shapes: rect #ffd166 2 keys, …]` and each child as `parent:c_…`.

```
fablecut_patch_project {ops:[
  {op:"addClip", clip:{id:"c_lt", kind:"shape", track:"V2", start:1, duration:5,
    props:{x:-330, y:230, shapes:[
      {type:"rect", name:"Bar", x:0, w:560, h:96, radius:10, fill:"#111827e6",
        keys:[{t:0, w:0}, {t:0.5, w:560, ease:"ease-out"}]},
      {type:"rect", name:"Accent", x:-276, w:8, h:96, fill:"#ffd166"},
      {type:"line", name:"Rule", y:64, points:[[-280,0],[280,0]], stroke:"#ffd166", strokeWidth:4,
        keys:[{t:0.3, trimEnd:0}, {t:1, trimEnd:100, ease:"ease-out"}]}]},
    transitionOut:{type:"fade", duration:0.4}}},
  {op:"addClip", clip:{id:"c_name", kind:"text", track:"V3", start:1.2, duration:4.8,
    props:{text:"Ava Moreno", font:"Archivo Black", fontSize:44, align:"left", x:-560, y:-8, textAnim:"rise-mask"}}},
  {op:"setParent", id:"c_name", parent:"c_lt"}
]}
```

`setParent` keeps the title where it is on screen and rewrites its `x`/`y`
into the layer's space. After that, keyframing the layer's `x` slides both of
them out together.

## Timing that looks designed

- Entrances take 0.3–0.6 s with `ease:"ease-out"` on the arriving key. Exits
  are faster (0.2–0.4 s) with `ease-in`. Use `linear` only for things that keep
  turning or running (spinners, tickers, a `trimOffset` loop).
- Stagger related items by 0.08–0.15 s so they settle one after another
  instead of all at once.
- Overshoot comes from three keys, not from an ease: `scale` 0 → 1.12 → 1
  over about 0.35 s.
- Hold a finished graphic for at least 2 s before it leaves.
- Use two or three colours: one strong accent, one neutral (`#111827`,
  `#ffffff`), and a translucent backing (`#rrggbbaa`, such as `#000000a0`).

## Recipes

- **Draw-on logo or icon**: `path` items with `stroke` and `fill:"none"`, each
  with `keys:[{t:a, trimEnd:0}, {t:a+0.8, trimEnd:100}]`, staggered. Then fade
  in the fill: `keys:[{t:1.2, fill:"#ffffff00"}, {t:1.6, fill:"#ffffff"}]`.
  The `fill` must be keyed in the same item as the draw-on.
- **Whole-layer draw-on**: key the clip's own `trimEnd` 0 → 100 in its
  `keyframes`. It trims every path in the layer at once.
- **Loading ring**: `{type:"ellipse", w:120, h:120, fill:"none", stroke:"#ffffff",
  strokeWidth:10, trimEnd:25, keys:[{t:0, trimOffset:0}, {t:1, trimOffset:100, ease:"linear"}]}`.
  For more turns, add more keys (`trimOffset` 200 at t 2, and so on).
- **Progress bar**: a backing `rect` and a fill `rect` with
  `keys:[{t:0, w:0, x:-200}, {t:3, w:400, x:0, ease:"linear"}]`. Key `x`
  together with `w` so the bar grows from its left edge.
- **Orbit**: a null at the centre with `rotation` keyed 0 → 360 (`linear`),
  and a shape or image parented to it with `x:300`. A second null parented to
  the first gives a moon.
- **Swing or hinge**: put the anchor on the edge it should hang from
  (`anchorY: -h/2` for the top edge), then key `rotation` −8 ↔ 8.
- **Pop-in sticker**: a `star` or `ellipse` item with keys
  `[{t:0, scale:0}, {t:0.25, scale:1.15}, {t:0.4, scale:1}]` and
  `rotation` −15 → 0.
- **Callout**: an open `path` (`closed:false`) from the subject to a label,
  drawn on with `trimEnd`, plus a small `ellipse` dot at its start.
- **Burst**: a `group` of six `line` items with `rotation` 0, 60, 120… and
  `points:[[40,0],[90,0]]`. Key the group's `scale` 0.4 → 1.2 and its
  `opacity` 1 → 0 over 0.5 s.

## Curves, blur and text on a path

- **Curved moves**: key `x` and `y` together at two or more times (position
  keys), then call `{op:"setMotionPath", id, path:"smooth"}`. For a precise
  arc, write the handles yourself: `pout` on the leaving key and `pin` on the
  arriving key, on both the x and y keys, in px from the key's position. A fly-in
  that arches up: x `{t:0, v:-500, pout:200}` → `{t:1, v:0, pin:-200}`,
  y `{t:0, v:200, pout:-250}` → `{t:1, v:0, pin:0}`.
- **Auto-orient** (`autoOrient:true` or `setMotionPath … autoOrient:true`) makes
  arrows, planes and cars point where they go. Draw them pointing right
  (0°), the direction of travel.
- **Motion blur**: `motionBlur:180` on anything that moves fast (whips,
  fly-ins, spinning logos). Use 360 for a heavy smear. Leave it off on slow
  drifts, where it only costs render time. 8 samples is enough for most
  shots; use 12–16 for very fast spins.
- **Text on a path**: `{op:"setTextPath", id, path:"circle"}` (or `"arc"`,
  `"wave"`, `"line"`, or a shape item such as `{type:"path", points:[…], closed:false}`).
  Key `pathOffset` 0 → 100 with `ease:"linear"` to send text around a ring.
  Add a trailing " • " so the ends don't touch. Size the path to the text:
  the circle's circumference (π × w) should be a bit longer than the text.
  `pathAlign:"center"` with `pathOffset:50` centres a title on an arc.
- Multi-line text on a path: each line after the first runs on a parallel
  curve one line-height below. Every `textAnim` works on a path;
  `letter-pop` and `rise-mask` read especially well on arcs.

## Compositions: build once, use anywhere

A **comp** (`project.comps`) is a timeline of its own; a `kind:"comp"` clip
places it, drawn like one picture of the comp's size. Use one when the same
graphic appears more than once, or when several clips should move, fade, mask
or grade as a unit.

```
fablecut_patch_project {ops:[
  {op:"addComp", comp:{id:"sting", name:"Logo sting", duration:2.5, clips:[
    {id:"ring", kind:"shape", track:"V1", start:0, duration:2.5, props:{shapes:[
      {type:"ellipse", w:220, h:220, fill:"none", stroke:"#ffd166", strokeWidth:10,
       keys:[{t:0, trimEnd:0}, {t:0.8, trimEnd:100, ease:"ease-out"}]}]}},
    {id:"word", kind:"text", track:"V2", start:0.5, duration:2, props:{text:"FC", font:"Anton", fontSize:96, textAnim:"zoom-in"}}]}},
  {op:"addClip", clip:{kind:"comp", compId:"sting", track:"V3", start:0, duration:2.5}},
  {op:"addClip", clip:{kind:"comp", compId:"sting", track:"V3", start:58, duration:2.5, props:{scale:0.6, x:480, y:260}}}
]}
```

- Edit what is inside with `{op:"inComp", comp:"sting", ops:[…]}` (the same
  clip ops, with comp times). Every placement updates.
- `{op:"precompose", ids:[…]}` turns clips you already built into a comp and
  leaves one comp clip in their place; then animate, mask or fade that clip
  as a whole (this is the fix for "parenting doesn't pass opacity").
- A comp clip's `in` is where in the comp it starts. A comp clip shows nothing
  past the comp's `duration`, so lengthen the comp (`updateComp`) before
  stretching the clip.
- The comp's frame is its `width` × `height`, transparent unless it has a
  `background`. Make a graphic's comp the canvas size so `x`/`y` inside it
  read the same as on the timeline.
- Sound inside a comp plays through the main timeline's track of the same
  name, so a whoosh in a sting follows the A-track fader it is on.

## Presets and templates: start from something designed

Reach for these before keying by hand.

```
fablecut_patch_project {ops:[
  {op:"addTemplate", template:"lower-third-bar", id:"c_lt_ava", track:"V3", start:4,
    fields:{name:"Ava Moreno", title:"Director of Photography", accent:"#22d3ee"}},
  {op:"addTemplate", template:"logo-ring", track:"V3", start:0, fields:{logo:"m_logo", brand:"NORTHWIND"}},
  {op:"applyPreset", ids:["c_title1", "c_title2"], preset:"rise-blur"},
  {op:"applyPreset", ids:["c_title1", "c_title2"], preset:"fade-out"},
  {op:"applyPreset", id:"c_badge", preset:"pulse", at:12.5}
]}
```

- **Templates** (`addTemplate`): lower thirds `lower-third-bar`,
  `lower-third-underline`, `lower-third-boxes` (fields `name`, `title`,
  `accent`…); logos `logo-ring`, `logo-slam`, `logo-lines` (`logo` takes a
  media id: import the user's logo first); social `social-story` (1080×1920),
  `social-quote` (1080×1080), `social-end-card`. Each placement is its own comp,
  so one per speaker is right. Change it later with
  `{op:"setTemplate", id:"c_lt_ava", fields:{…}, duration:7}`; a longer
  template holds longer and keeps its exit. For a vertical template, set the
  canvas to its size first (`setProject {width:1080, height:1920}`) or it sits
  letterboxed in a 16:9 frame.
- **Presets** (`applyPreset`) key relative to the clip, so put the clip where
  it should rest first, then apply. One In and one Out per clip; an At preset
  (`pulse`, `shake`, `wobble`, `bounce`, `flash`) on a beat; a loop
  (`float`, `breathe`, `sway`, `spin`, `wiggle`) for something that lives on
  screen. `length` stretches one (`length:1.2` for a slow, grand entrance).
- Use one family of entrances across an edit (say `rise-blur` for titles and
  `pop-in` for stickers) rather than a different preset on every clip.
- Save what the user likes: `savePreset {id, name}` from a clip they animated,
  `saveTemplate {comp, name}` from a comp they built. Both go to the library
  and work in every project.

## Things that trip agents up

- Shape and null clips have `mediaId:null`. Don't register media for them.
- A new item needs `type`. `setShape` without `shape` (or with a new name)
  adds an item; with an index, name or path (`"2.0"` = item 0 in group 2) it
  edits that item and merges key by key.
- `keys` in `setShape` replaces that item's whole key list, so send all of
  them. `points` keys must have the same number of points as the path.
- Lines have exactly 2 points. Paths need 2 to 128, and a closed path needs
  3 or more to show any area.
- A stroke with `strokeWidth:0` is invisible. Setting `stroke` without a width
  gives 6 px (8 px on lines and open paths).
- A trimmed closed shape fills only the part that is drawn. For a clean
  outline draw-on, use `fill:"none"` and fade the fill in afterwards.
- Parenting carries only the transform. Opacity, transitions, shake and
  effects don't pass to the children, so fade each child with its own
  `transitionOut`, or put everything in one shape layer's groups.
- Rotate or scale around a corner by moving the anchor, not by adjusting
  `x`/`y` keys in every frame.
- Parent loops (for example, a null to its own child) are refused, and so are
  parents that are audio or adjustment clips.
- A comp can't contain itself (directly or through another comp), and
  `removeComp` is refused while a clip still uses it. Comps nest 4 deep.
