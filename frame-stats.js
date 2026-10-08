/* ═══════════════════════════════════════════════════════════════════════════
   Frame statistics — describe a frame in words, for anyone who can't see it.

   `fablecut_frame` hands a multimodal model an actual image, which is the point.
   But not every MCP client, and not every model behind it, can read one: a
   text-only agent gets the coordinates of the picture and nothing else, so it
   learns nothing about the footage it was asked to judge.

   This closes that gap with measurements instead of pixels — brightness, the
   dominant colours, and how much a moment differs from the one before it — the
   same numbers `fablecut_scopes` reports for the composed picture, applied to a
   source frame. Deliberately NOT a caption: no zero-dependency way to describe
   what is in the picture honestly. What it gives instead is enough to rank and
   route footage ("bright outdoor, high motion, dominant green") without a
   picture at all.

   Pure functions over a raw RGB buffer. No ffmpeg, no canvas, no dependencies,
   so the whole thing is testable on its own. ═══════════════════════════════════ */
"use strict";

/* Rec. 709 luma weights — the same coefficients the browser uses, so a number
   here means the same thing as a number from fablecut_scopes. */
const WR = 0.2126, WG = 0.7152, WB = 0.0722;

/* Perceptual buckets. A 4-bit-per-channel histogram is 4096 entries: fine
   enough to separate a lime from a green, coarse enough that JPEG noise in a
   gradient lands in one bucket instead of smearing across a hundred. */
const BITS = 4, SHIFT = 8 - BITS, BUCKETS = 1 << (BITS * 3);

/** Rec. 709 luma of one pixel, 0–255. */
function luma(r, g, b) { return WR * r + WG * g + WB * b; }

/* Named colours a model can reason about, matched against the histogram's top
   buckets. These are the useful coarse categories — "sky", "foliage", "skin",
   "night" — rather than 4096 hex codes nobody can picture. Nearest match by
   weighted RGB distance, so a slightly-off bucket still lands sensibly. */
const NAMED = [
  { name: "black", rgb: [10, 10, 12] },
  { name: "deep blue", rgb: [16, 26, 74] },
  { name: "blue", rgb: [40, 84, 190] },
  { name: "sky blue", rgb: [128, 186, 235] },
  { name: "cyan", rgb: [56, 190, 200] },
  { name: "green", rgb: [56, 142, 62] },
  { name: "lime", rgb: [140, 205, 60] },
  { name: "olive", rgb: [120, 118, 52] },
  { name: "yellow", rgb: [226, 200, 62] },
  { name: "orange", rgb: [222, 122, 44] },
  { name: "red", rgb: [196, 52, 44] },
  { name: "dark red", rgb: [104, 26, 26] },
  { name: "magenta", rgb: [176, 58, 168] },
  { name: "skin", rgb: [214, 168, 132] },
  { name: "grey", rgb: [128, 128, 130] },
  { name: "light grey", rgb: [206, 206, 208] },
  { name: "white", rgb: [242, 242, 244] },
];
function nameColor(r, g, b) {
  let best = NAMED[0], bestD = Infinity;
  for (const c of NAMED) {
    /* Plain Euclidean RGB distance. Luma weighting looks principled and is
       wrong here: Rec.709 gives blue a weight of 0.07, so a bucket that differs
       from "blue" mostly in blue reads as "deep blue" instead. For naming a
       colour, hue is the thing being asked about. */
    const d = (r - c.rgb[0]) ** 2 + (g - c.rgb[1]) ** 2 + (b - c.rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best.name;
}

/** Bucket a pixel into the 4-bit-per-channel histogram. */
const bucketOf = (r, g, b) => ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
function bucketRgb(i) {
  return [((i >> (BITS * 2)) & 0xf) << SHIFT, ((i >> BITS) & 0xf) << SHIFT, (i & 0xf) << SHIFT];
}

/**
 * Describe one frame.
 *
 * @param rgb  raw RGB24 bytes (w*h*3)
 * @param w,h  its dimensions
 * @param opts {stride} — bytes per row, when rgb is a window into a bigger
 *          buffer (the contact sheet slices cells out of one grid image)
 * @returns {{luma:object, brightness:string, colours:Array, saturation:number,
 *            meanRgb:number[], texture:number, samples:number}}
 */
function describe(rgb, w, h, { stride = w * 3, offset = 0 } = {}) {
  const n = w * h;
  const hist = new Uint32Array(BUCKETS);
  const lums = new Float64Array(n);
  let sr = 0, sg = 0, sb = 0, k = 0;
  for (let y = 0; y < h; y++) {
    let i = offset + y * stride;
    for (let x = 0; x < w; x++, i += 3, k++) {
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      sr += r; sg += g; sb += b;
      lums[k] = luma(r, g, b);
      hist[bucketOf(r, g, b)]++;
    }
  }
  // Percentiles need a sort; a frame is at most a few hundred thousand samples,
  // and this runs once per call, not per frame of a render.
  const sorted = Float64Array.prototype.slice.call(lums).sort();
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += lums[i];
  const mean = sum / n;
  const meanRgb = [sr / n, sg / n, sb / n];

  // Saturation 0–1, from mean chroma against mean luma (the cheap version —
  // no per-pixel HSV pass).
  const chroma = (Math.max(...meanRgb) - Math.min(...meanRgb)) / 255;
  const lum01 = mean / 255;
  const saturation = lum01 < 0.005 ? 0 : Math.min(1, chroma / (lum01 * 2));

  /* "Texture": the mean absolute luma step between horizontally adjacent
     samples, as a percentage of full range. Smooth sky or a locked-off tripod
     shot scores near 0; foliage, crowds or a busy frame score clearly higher.
     Reported on the same 0–100 scale as the analyzer's per-shot `energy`, so
     the two can be compared directly. It measures detail *within* the frame,
     not change over time — motionScore() is the change-over-time one. */
  let diff = 0, dN = 0;
  for (let y = 0; y < h; y++) {
    // Start one pixel in: the step reads the pixel before the cursor, and on
    // the first row that would be rgb[-3] — undefined, and silently NaN.
    let i = offset + y * stride + 3;
    for (let x = 1; x < w; x++, i += 3) {
      diff += Math.abs(luma(rgb[i], rgb[i + 1], rgb[i + 2]) - luma(rgb[i - 3], rgb[i - 2], rgb[i - 1]));
      dN++;
    }
  }
  // A single-pixel-wide sample has no horizontal neighbours; report no texture
  // rather than NaN.
  const detail = dN ? Math.round(diff / dN / 255 * 1000) / 10 : 0;

  // Top colour buckets, merged when they are neighbours so a sky reads as one
  // entry rather than four.
  const top = [];
  for (let i = 0; i < BUCKETS; i++) {
    if (hist[i]) top.push([i, hist[i]]);
  }
  top.sort((a, b) => b[1] - a[1]);
  const colours = [];
  for (const [idx, count] of top) {
    const [r, g, b] = bucketRgb(idx);
    const near = colours.find((c) =>
      (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2 < 900);
    if (near) {
      // Weighted mean, so the merged entry points at the colour actually seen.
      const tot = near.count + count;
      near.rgb = near.rgb.map((v, j) => Math.round((v * near.count + [r, g, b][j] * count) / tot));
      near.count = tot;
      near.pct = tot;
    } else {
      colours.push({ rgb: [r, g, b], count, pct: count });
    }
  }
  colours.sort((a, b) => b.count - a.count);
  const shown = colours.slice(0, 3);
  for (const c of shown) {
    c.pct = Math.round(c.pct / n * 100);
    c.hex = "#" + c.rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
    c.name = nameColor(c.rgb[0], c.rgb[1], c.rgb[2]);
  }

  const l = mean / 255;
  return {
    luma: {
      min: Math.round(q(0)), p1: Math.round(q(0.01)), median: Math.round(q(0.5)),
      mean: Math.round(l * 1000) / 1000, p99: Math.round(q(0.99)), max: Math.round(q(1)),
    },
    brightness: l < 0.12 ? "very dark" : l < 0.35 ? "dark" : l < 0.65 ? "mid" : l < 0.85 ? "bright" : "very bright",
    colours: shown,
    meanRgb: meanRgb.map((v) => Math.round(v)),
    saturation: Math.round(saturation * 100) / 100,
    texture: detail,
    samples: n,
  };
}

/**
 * Mean absolute per-channel difference between two equally sized regions,
 * 0–1. High means the picture changed a lot between them — a cut, or fast
 * motion. This is the "is this a different shot" signal a contact sheet's cells
 * can be ranked by.
 */
function motionScore(rgbA, rgbB, w, h) {
  const n = w * h * 3;
  if (!n || !rgbA || !rgbB || rgbA.length < n || rgbB.length < n) return 0;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(rgbA[i] - rgbB[i]);
  return Math.round(d / n / 255 * 1000) / 1000;
}

/**
 * Describe a tiled contact sheet cell by cell. `rgb` is the whole grid image;
 * cells are read left→right then top→bottom, so cell i is the frame at times[i].
 *
 * Each cell reports its own brightness/colours, plus motion against the previous
 * populated cell — which is what lets a text-only agent find the cut points and
 * pick the high-motion moments without seeing anything.
 *
 * @param rgb  raw RGB24 of the whole grid
 * @param w,h  grid dimensions
 * @param cols,rows  the tile layout
 * @param times  one timestamp per cell, in cell order
 */
function describeGrid(rgb, w, h, cols, rows, times = []) {
  // tile lays cells out edge to edge, so the cell size is the grid divided by
  // the layout. Guard the rounding: a width that doesn't divide evenly would
  // drift a pixel per row and smear the last column.
  const cw = Math.floor(w / cols), ch = Math.floor(h / rows);
  const cells = [];
  let prev = null, prevIdx = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c;
      const time = times[index];
      // Fewer timestamps than cells means tile padded the last row with black —
      // say so rather than describing a padding cell as a black frame.
      if (time == null) { cells.push({ index, padded: true }); continue; }
      const ox = c * cw, oy = r * ch;
      const view = new Uint8Array(cw * ch * 3);
      for (let y = 0; y < ch; y++) {
        const from = ((oy + y) * w + ox) * 3;
        view.set(rgb.subarray(from, from + cw * 3), y * cw * 3);
      }
      const stats = describe(view, cw, ch);
      const cell = { index, time, ...stats };
      // Compare against the previous *real* cell, skipping padding, so the last
      // filled cell of a short row is still measured against its neighbour.
      cell.motion = prev ? motionScore(view, prev, cw, ch) : 0;
      cells.push(cell);
      prev = view; prevIdx = index;
    }
  }
  return { cols, rows, cellWidth: cw, cellHeight: ch, cells };
}

/** One line per thing worth saying, for a single frame. These lines are the whole
 *  point of the text fallback: read by a model that never sees the pixels.
 *  Keep them short — this is what an agent gets instead of the image. */
function frameLines(label, stats) {
  const L = stats.luma;
  const cols = stats.colours.map((c) => `${c.name} ${c.hex} ${c.pct}%`).join(", ");
  return [
    `${label}: ${stats.brightness} (luma mean ${L.mean}, median ${L.median}, range ${L.min}–${L.max})`,
    `  dominant: ${cols || "flat"}`,
    `  texture ${stats.texture}/100 · saturation ${stats.saturation} · mean rgb [${stats.meanRgb.join(", ")}]`,
  ];
}

/** One line per cell, for a contact sheet. `motion` is the change since the
 *  previous cell, so it spikes at a cut *and* during fast movement — it ranks
 *  the most active moments, it does not prove there was a cut. */
function gridLines(grid) {
  const lines = grid.cells.map((c) => {
    if (c.padded) return `  cell ${c.index + 1}: (padding — not a frame in this clip)`;
    return `  cell ${c.index + 1} @ ${c.time}s: ${c.brightness}, ${c.colours.map((x) => `${x.name} ${x.pct}%`).join(" / ") || "flat"}`
      + ` · texture ${c.texture}/100 · change ${c.motion}`;
  });
  return [`Contact sheet ${grid.cols}x${grid.rows}, ${grid.cells.filter((c) => !c.padded).length} frames:`, ...lines];
}

module.exports = { describe, describeGrid, motionScore, luma, nameColor, frameLines, gridLines };