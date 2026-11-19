"use strict";
/* Prepare a clean synthetic M1 fixture (1080x1920, 30 fps, 9s) outside Git in ../local-data.
   Generates a clean dark-studio vertical video with audio tone via FFmpeg (no external copyrighted footage),
   seeds editable caption scenes for all three M1 styles (clean, bold, editorial), and writes a matching
   transcript sidecar so GUI and MCP caption workflows can be tested end-to-end immediately. */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const C = require("../captions.js");

const root = path.resolve(__dirname, "..");
const data = path.resolve(root, "../local-data");
const force = process.argv.includes("--force");

if (!force && fs.existsSync(path.join(data, "project.json"))) {
  throw new Error("Existing project in ../local-data/project.json; pass --force to overwrite");
}

fs.mkdirSync(path.join(data, "media"), { recursive: true });
const videoOut = path.join(data, "media", "m1-clean-vertical.mp4");

const ff = spawnSync(
  "ffmpeg",
  [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=#141821:s=1080x1920:r=30:d=9",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=9",
    "-vf", "drawbox=x=90:y=260:w=900:h=1400:color=#1f2633@0.65:t=fill",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-y", videoOut,
  ],
  { stdio: "inherit", windowsHide: true }
);
if (ff.status !== 0) throw new Error("FFmpeg failed to generate synthetic M1 fixture");

const cues = [
  {
    style: "clean",
    cue: {
      start: 0.2, end: 2.8, text: "Twoje napisy w czystym stylu",
      words: [
        { w: "Twoje", s: 0.2, e: 0.7 },
        { w: "napisy", s: 0.7, e: 1.3 },
        { w: "w", s: 1.3, e: 1.5 },
        { w: "czystym", s: 1.5, e: 2.1 },
        { w: "stylu", s: 2.1, e: 2.7 },
      ],
    },
  },
  {
    style: "bold",
    cue: {
      start: 3.1, end: 5.7, text: "MOCNY RYTM",
      words: [
        { w: "MOCNY", s: 3.1, e: 4.1 },
        { w: "RYTM", s: 4.2, e: 5.4 },
      ],
    },
  },
  {
    style: "editorial",
    cue: {
      start: 6.0, end: 8.8, text: "Twoje SŁOWA w ruchu.",
      words: [
        { w: "Twoje", s: 6.0, e: 6.6 },
        { w: "SŁOWA", s: 6.7, e: 7.5 },
        { w: "w", s: 7.5, e: 7.8 },
        { w: "ruchu.", s: 7.8, e: 8.6 },
      ],
    },
  },
];

const captionClips = [];
cues.forEach((item, idx) => {
  const made = C.sceneClips(item.cue, {
    style: item.style,
    width: 1080,
    height: 1920,
    track: "V2",
    id: `cap_m1_${idx + 1}`,
    sceneId: `cs_m1_${idx + 1}`,
  });
  captionClips.push(...made);
});

const doc = {
  name: "Motion Captions — M1 Clean Fixture",
  width: 1080,
  height: 1920,
  fps: 30,
  revision: 1,
  panSchema: 1,
  background: "#141821",
  tracks: [
    { id: "V3", kind: "video" },
    { id: "V2", kind: "video" },
    { id: "V1", kind: "video" },
    { id: "A1", kind: "audio" },
  ],
  markers: [
    { t: 0.2, label: "01 / Clean" },
    { t: 3.1, label: "02 / Bold kinetic" },
    { t: 6.0, label: "03 / Editorial mixed" },
  ],
  media: [
    { id: "m_clean", name: "m1-clean-vertical.mp4", kind: "video", src: "/media/m1-clean-vertical.mp4", duration: 9, width: 1080, height: 1920 },
  ],
  clips: [
    { id: "c_bg", name: "Clean background", kind: "video", mediaId: "m_clean", track: "V1", start: 0, in: 0, duration: 9, props: { fit: "cover", volume: 0.2 } },
    ...captionClips,
  ],
};

fs.writeFileSync(path.join(data, "project.json"), JSON.stringify(doc, null, 2));
console.log(`Prepared clean M1 fixture in ${data} (${captionClips.length} editable caption clips across 3 styles).`);
