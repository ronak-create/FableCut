/* Read a media file's metadata with ffprobe (Node only — the server and the
   MCP server). The parsing is media-lib.js's parseProbe, shared with the
   tests; this file only runs ffprobe and caches the answer per file version.

     probeFile(file) → {size, fps?, codec?, audioCodec?, audioChannels?, sampleRate?,
                        bitrate?, duration?, width?, height?, probe:"ffprobe"|"stat"}
                       or null when the file is not there.
   Without ffprobe on PATH only `size` comes back (probe:"stat"). */
"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");
const MediaLib = require("./media-lib");

let hasProbe = null;
function ffprobeAvailable() {
  if (hasProbe == null) {
    try { hasProbe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0; } catch { hasProbe = false; }
  }
  return hasProbe;
}

const cache = new Map();   // file → {key, info}
const CACHE_MAX = 2000;

function probeFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const key = st.size + ":" + st.mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.key === key) return { ...hit.info };
  let info = { size: st.size, probe: "stat" };
  if (ffprobeAvailable()) {
    try {
      const r = spawnSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 1 << 23 });
      if (r.status === 0 && r.stdout) info = { ...MediaLib.parseProbe(JSON.parse(r.stdout), st.size), probe: "ffprobe" };
    } catch { /* keep the stat answer */ }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(file, { key, info });
  return { ...info };
}

/** The INFO_KEYS of probeFile's answer, ready to merge into a media entry
 *  (duration / width / height only when the entry lacks them). */
function infoForEntry(info, entry) {
  const out = {};
  if (!info) return out;
  for (const k of MediaLib.INFO_KEYS) if (info[k] != null) out[k] = info[k];
  const kind = entry && entry.kind;
  if (kind !== "image" && kind !== "svg" && info.duration > 0 && !(entry && entry.duration > 0)) out.duration = info.duration;
  if (info.width > 0 && !(entry && entry.width > 0)) { out.width = info.width; out.height = info.height; }
  return out;
}

module.exports = { probeFile, infoForEntry, ffprobeAvailable };
