/* FableCut timeline-ruler worker.
   Draws the ruler canvas (ticks, time labels, IN/OUT flags, beat markers,
   playhead) off the main thread via a transferred OffscreenCanvas. This is a
   clean Worker candidate — unlike the program-monitor compositor (app.js
   drawFrame/drawClip), the ruler never touches <video>/<audio> elements or
   any other main-thread-only DOM state, only the small set of numbers/arrays
   sent in each "draw" message. Keep this in sync with app.js's drawRuler()
   fallback (used when OffscreenCanvas/transferControlToOffscreen isn't
   available) if the look changes. */
let cv = null, g = null;

function fmt(t, fps) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60),
    f = Math.floor((t % 1) * (fps > 0 ? fps : 1));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(m)}:${p(s)}:${p(f)}`;
}

function draw(msg) {
  if (!g) return;
  const { w, h, dpr, sl, pps, markers, inPoint, outPoint, time, fps } = msg;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * pps >= 70) || 600;
  const minor = step / 5;
  const i0 = Math.max(0, Math.floor(sl / pps / minor));
  // ticks + time labels first so IN/OUT can difference-blend over them
  g.strokeStyle = "#4a4a55";
  g.fillStyle = "#9a9aa6";
  g.font = "10px Consolas, monospace";
  g.beginPath();
  for (let i = i0; i * minor * pps < sl + w; i++) {
    const t = i * minor;
    const x = Math.round(t * pps - sl) + 0.5;
    const isMajor = i % 5 === 0;
    g.moveTo(x, isMajor ? 8 : 17); g.lineTo(x, h);
    if (isMajor) g.fillText(fmt(Math.round(t * 1000) / 1000, fps).slice(0, 5), x + 4, 12);
  }
  g.stroke();
  // dim timeline outside the IN–OUT work area
  if (inPoint != null && outPoint != null && outPoint > inPoint) {
    const x0 = inPoint * pps - sl, x1 = outPoint * pps - sl;
    g.fillStyle = "#00000055";
    if (x0 > 0) g.fillRect(0, 0, Math.min(w, x0), h);
    if (x1 < w) g.fillRect(Math.max(0, x1), 0, w - Math.max(0, x1), h);
  }
  // beat/cue markers
  for (const mk of markers || []) {
    const x = mk.t * pps - sl;
    if (x < -6 || x > w + 6) continue;
    g.fillStyle = "#ffd166";
    g.beginPath();
    g.moveTo(x, h - 9); g.lineTo(x + 4, h - 5); g.lineTo(x, h - 1); g.lineTo(x - 4, h - 5);
    g.closePath(); g.fill();
  }
  // IN / OUT — bottom-aligned; `difference` keeps time glyphs readable where they overlap
  const mkH = (h - 4) * 0.75, bot = h - 1, top = bot - mkH, mid = (top + bot) / 2;
  g.globalCompositeOperation = "difference";
  if (inPoint != null) {
    const x = inPoint * pps - sl;
    if (x >= -10 && x <= w + 10) {
      g.fillStyle = "#5eead4";
      g.beginPath();
      g.moveTo(x, top); g.lineTo(x, bot); g.lineTo(x + 8, mid);
      g.closePath(); g.fill();
    }
  }
  if (outPoint != null) {
    const x = outPoint * pps - sl;
    if (x >= -10 && x <= w + 10) {
      g.fillStyle = "#fb923c";
      g.beginPath();
      g.moveTo(x, top); g.lineTo(x, bot); g.lineTo(x - 8, mid);
      g.closePath(); g.fill();
    }
  }
  g.globalCompositeOperation = "source-over";
  // playhead marker on ruler
  const px = time * pps - sl;
  if (px >= -8 && px <= w + 8) {
    g.fillStyle = "#ff4d6a";
    g.beginPath();
    g.moveTo(px - 6, 12); g.lineTo(px + 6, 12); g.lineTo(px + 6, 19); g.lineTo(px, 25); g.lineTo(px - 6, 19);
    g.closePath(); g.fill();
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === "init") {
    cv = msg.canvas;
    g = cv.getContext("2d");
  } else if (msg.type === "draw") {
    draw(msg);
  }
};
