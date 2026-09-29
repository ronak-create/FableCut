"use strict";
const fs = require("fs");

function u64(b, o) {
  const n = b.readBigUInt64BE(o);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 offset exceeds JavaScript's safe integer range");
  return Number(n);
}

function boxes(b, start = 0, end = b.length) {
  const out = [];
  for (let o = start; o + 8 <= end;) {
    let size = b.readUInt32BE(o);
    const type = b.toString("ascii", o + 4, o + 8);
    let head = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = u64(b, o + 8);
      head = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < head || o + size > end) break;
    out.push({ type, start: o, size, head, data: o + head, end: o + size });
    o += size;
  }
  return out;
}

function child(b, parent, type) {
  return boxes(b, parent.data, parent.end).find((x) => x.type === type);
}

function requireChild(b, parent, type) {
  const x = child(b, parent, type);
  if (!x) throw new Error(`MP4 video track is missing ${type}`);
  return x;
}

function readTopLevelBox(fd, fileSize, wanted) {
  const h = Buffer.alloc(16);
  for (let o = 0; o + 8 <= fileSize;) {
    fs.readSync(fd, h, 0, 8, o);
    let size = h.readUInt32BE(0);
    const type = h.toString("ascii", 4, 8);
    let head = 8;
    if (size === 1) {
      fs.readSync(fd, h, 8, 8, o + 8);
      size = u64(h, 8);
      head = 16;
    } else if (size === 0) {
      size = fileSize - o;
    }
    if (size < head || o + size > fileSize) throw new Error("Invalid MP4 top-level box");
    if (type === wanted) {
      if (size - head > 64 * 1024 * 1024) throw new Error("MP4 moov box is too large");
      const data = Buffer.alloc(size - head);
      fs.readSync(fd, data, 0, data.length, o + head);
      // Give the returned root a normal child-box payload range.
      return { buffer: data, box: { type, start: -head, size, head, data: 0, end: data.length } };
    }
    o += size;
  }
  return null;
}

function fullBoxVersion(b, box) {
  return b[box.data];
}

function tableCount(b, box, at, bytesPerEntry, label) {
  if (at + 4 > box.end) throw new Error(`Invalid ${label}`);
  const count = b.readUInt32BE(at);
  const available = Math.floor((box.end - at - 4) / bytesPerEntry);
  if (count > available || count > 2_000_000) throw new Error(`Invalid ${label} entry count`);
  return count;
}

function parseMdhd(b, box) {
  const v = fullBoxVersion(b, box);
  const at = box.data + (v === 1 ? 20 : 12);
  if (at + 4 > box.end) throw new Error("Invalid mdhd");
  return b.readUInt32BE(at);
}

function assertIdentityTrackMatrix(b, tkhd) {
  const at = tkhd.data + (fullBoxVersion(b, tkhd) === 1 ? 52 : 40);
  if (at + 36 > tkhd.end) throw new Error("Invalid tkhd");
  const identity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  for (let i = 0; i < identity.length; i++) {
    if (b.readUInt32BE(at + i * 4) !== identity[i])
      throw new Error("VideoDecoder export does not yet support MP4 display transforms");
  }
}

/* Return the media-time origin applied by the common one-segment edit list.
   More elaborate edit timelines are intentionally rejected to the HTML-media
   fallback rather than silently exporting different frames. */
function editMediaStart(b, trak) {
  const edts = child(b, trak, "edts");
  const elst = edts && child(b, edts, "elst");
  if (!elst) return null;
  const version = fullBoxVersion(b, elst);
  const step = version === 1 ? 20 : 12;
  const count = tableCount(b, elst, elst.data + 4, step, "elst");
  let mediaStart = null;
  let o = elst.data + 8;
  for (let i = 0; i < count; i++, o += step) {
    const segmentDuration = version === 1 ? u64(b, o) : b.readUInt32BE(o);
    const mediaTime = version === 1 ? Number(b.readBigInt64BE(o + 8)) : b.readInt32BE(o + 4);
    const rateAt = o + (version === 1 ? 16 : 8);
    const rateInteger = b.readInt16BE(rateAt);
    const rateFraction = b.readInt16BE(rateAt + 2);
    if (rateInteger !== 1 || rateFraction !== 0)
      throw new Error("VideoDecoder export does not support edited playback rates");
    if (mediaTime < 0) {
      if (segmentDuration > 0)
        throw new Error("VideoDecoder export does not support empty MP4 edits");
      continue;
    }
    if (mediaStart != null)
      throw new Error("VideoDecoder export does not support multi-segment MP4 edits");
    mediaStart = mediaTime;
  }
  return mediaStart;
}

function expandRunTable(b, box, signedValue = false) {
  const count = tableCount(b, box, box.data + 4, 8, box.type);
  const out = [];
  let o = box.data + 8;
  for (let i = 0; i < count; i++, o += 8) {
    if (o + 8 > box.end) throw new Error(`Invalid ${box.type}`);
    out.push({
      count: b.readUInt32BE(o),
      value: signedValue ? b.readInt32BE(o + 4) : b.readUInt32BE(o + 4),
    });
  }
  return out;
}

function sampleSizes(b, stsz) {
  if (stsz.data + 12 > stsz.end) throw new Error("Invalid stsz");
  const fixed = b.readUInt32BE(stsz.data + 4);
  const count = b.readUInt32BE(stsz.data + 8);
  if (count > 2_000_000 || (!fixed && count > Math.floor((stsz.end - stsz.data - 12) / 4)))
    throw new Error("Invalid stsz sample count");
  if (fixed) return new Array(count).fill(fixed);
  const out = new Array(count);
  let o = stsz.data + 12;
  for (let i = 0; i < count; i++, o += 4) {
    if (o + 4 > stsz.end) throw new Error("Invalid stsz");
    out[i] = b.readUInt32BE(o);
  }
  return out;
}

function chunkOffsets(b, box) {
  const wide = box.type === "co64";
  const step = wide ? 8 : 4;
  const count = tableCount(b, box, box.data + 4, step, box.type);
  const out = new Array(count);
  let o = box.data + 8;
  for (let i = 0; i < count; i++, o += step) {
    if (o + step > box.end) throw new Error(`Invalid ${box.type}`);
    out[i] = wide ? u64(b, o) : b.readUInt32BE(o);
  }
  return out;
}

function sampleToChunk(b, stsc) {
  const count = tableCount(b, stsc, stsc.data + 4, 12, "stsc");
  const out = [];
  let o = stsc.data + 8;
  for (let i = 0; i < count; i++, o += 12) {
    if (o + 12 > stsc.end) throw new Error("Invalid stsc");
    const descriptionIndex = b.readUInt32BE(o + 8);
    if (descriptionIndex !== 1)
      throw new Error("VideoDecoder export does not support multiple MP4 sample descriptions");
    out.push({
      firstChunk: b.readUInt32BE(o),
      samplesPerChunk: b.readUInt32BE(o + 4),
      descriptionIndex,
    });
  }
  return out;
}

function syncSamples(b, stss, count) {
  if (!stss) return null; // absent means every sample is a random-access sample
  const n = tableCount(b, stss, stss.data + 4, 4, "stss");
  const out = new Set();
  let o = stss.data + 8;
  for (let i = 0; i < n; i++, o += 4) {
    if (o + 4 > stss.end) throw new Error("Invalid stss");
    const sample = b.readUInt32BE(o) - 1;
    if (sample >= 0 && sample < count) out.add(sample);
  }
  return out;
}

function expandTiming(runs, count, fallback = 0) {
  const out = new Array(count);
  let i = 0;
  for (const run of runs) {
    for (let n = 0; n < run.count && i < count; n++) out[i++] = run.value;
  }
  while (i < count) out[i++] = fallback;
  return out;
}

function avcCodec(avcC) {
  if (avcC.length < 4) throw new Error("Invalid avcC");
  return "avc1." + [avcC[1], avcC[2], avcC[3]]
    .map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function parseVideoSampleEntry(b, stsd) {
  if (stsd.data + 16 > stsd.end || b.readUInt32BE(stsd.data + 4) < 1)
    throw new Error("MP4 video track has no sample description");
  const entry = boxes(b, stsd.data + 8, stsd.end)[0];
  if (!entry) throw new Error("Invalid MP4 video sample description");
  if (entry.type !== "avc1" && entry.type !== "avc3")
    throw new Error(`VideoDecoder export currently supports H.264 MP4, not ${entry.type}`);
  const width = b.readUInt16BE(entry.data + 24);
  const height = b.readUInt16BE(entry.data + 26);
  const avcC = boxes(b, entry.data + 78, entry.end).find((x) => x.type === "avcC");
  if (!avcC) throw new Error("H.264 sample description is missing avcC");
  const description = b.subarray(avcC.data, avcC.end);
  return { codec: avcCodec(description), description, width, height };
}

/* Sample-table duration is decode timing. Frame holding must follow presentation
   order (VFR, reordered B-frames). The last hold is that sample's edit-list-
   normalized presentation end (PTS + stts duration), not the preceding PTS gap. */
function applyPresentationHolds(samples) {
  const presentationTimes = [...new Set(samples.map((sample) => sample.timestamp))]
    .sort((a, z) => a - z);
  const holdByTimestamp = new Map();
  for (let i = 0; i < presentationTimes.length - 1; i++)
    holdByTimestamp.set(presentationTimes[i], presentationTimes[i + 1] - presentationTimes[i]);
  if (presentationTimes.length) {
    const last = presentationTimes[presentationTimes.length - 1];
    let presentationEnd = last;
    for (const sample of samples) {
      if (sample.timestamp !== last) continue;
      presentationEnd = Math.max(presentationEnd, sample.timestamp + sample.duration);
    }
    holdByTimestamp.set(last, Math.max(1, presentationEnd - last));
  }
  for (const sample of samples)
    sample.duration = Math.max(1, holdByTimestamp.get(sample.timestamp) || sample.duration);
}

function parseVideoIndex(file) {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  let root;
  try {
    root = readTopLevelBox(fd, stat.size, "moov");
  } finally {
    fs.closeSync(fd);
  }
  if (!root) throw new Error("MP4 has no moov box");
  const b = root.buffer;
  const tracks = boxes(b, root.box.data, root.box.end).filter((x) => x.type === "trak");
  let videoTrak = null;
  let mdia = null;
  for (const trak of tracks) {
    const candidate = child(b, trak, "mdia");
    const hdlr = candidate && child(b, candidate, "hdlr");
    if (hdlr && b.toString("ascii", hdlr.data + 8, hdlr.data + 12) === "vide") {
      videoTrak = trak;
      mdia = candidate;
      break;
    }
  }
  if (!mdia) throw new Error("MP4 has no video track");
  assertIdentityTrackMatrix(b, requireChild(b, videoTrak, "tkhd"));
  const mediaStart = editMediaStart(b, videoTrak);
  const timescale = parseMdhd(b, requireChild(b, mdia, "mdhd"));
  if (!timescale) throw new Error("MP4 video track has an invalid timescale");
  const minf = requireChild(b, mdia, "minf");
  const stbl = requireChild(b, minf, "stbl");
  const mapping = sampleToChunk(b, requireChild(b, stbl, "stsc"));
  const sampleEntry = parseVideoSampleEntry(b, requireChild(b, stbl, "stsd"));
  const sizes = sampleSizes(b, requireChild(b, stbl, "stsz"));
  const offsetsBox = child(b, stbl, "co64") || requireChild(b, stbl, "stco");
  const chunks = chunkOffsets(b, offsetsBox);
  const durations = expandTiming(expandRunTable(b, requireChild(b, stbl, "stts")), sizes.length);
  const ctts = child(b, stbl, "ctts");
  const compositionOffsets = ctts
    ? expandTiming(expandRunTable(b, ctts, fullBoxVersion(b, ctts) === 1), sizes.length)
    : new Array(sizes.length).fill(0);
  const sync = syncSamples(b, child(b, stbl, "stss"), sizes.length);

  const sampleOffsets = new Array(sizes.length);
  let sample = 0;
  let mapIndex = 0;
  for (let chunk = 1; chunk <= chunks.length && sample < sizes.length; chunk++) {
    while (mapIndex + 1 < mapping.length && mapping[mapIndex + 1].firstChunk <= chunk) mapIndex++;
    if (!mapping[mapIndex] || mapping[mapIndex].firstChunk > chunk) throw new Error("Invalid stsc chunk mapping");
    let offset = chunks[chunk - 1];
    for (let n = 0; n < mapping[mapIndex].samplesPerChunk && sample < sizes.length; n++, sample++) {
      sampleOffsets[sample] = offset;
      offset += sizes[sample];
    }
  }
  if (sample !== sizes.length) throw new Error("MP4 chunk table does not cover all video samples");

  let dts = 0;
  const samples = sizes.map((size, i) => {
    const duration = durations[i];
    const item = {
      offset: sampleOffsets[i],
      size,
      timestamp: Math.round((dts + compositionOffsets[i]) * 1e6 / timescale),
      duration: Math.max(1, Math.round(duration * 1e6 / timescale)),
      key: sync ? sync.has(i) : true,
    };
    dts += duration;
    return item;
  });
  // MP4 edit lists commonly shift an initial B-frame composition offset so
  // HTMLMediaElement currentTime starts at zero. Normalise to that same media
  // timeline; VideoDecoder itself does not apply the container edit list.
  let presentationStart = mediaStart == null
    ? (samples.length ? Math.min(...samples.slice(0, 64).map((sample) => sample.timestamp)) : 0)
    : Math.round(mediaStart * 1e6 / timescale);
  if (presentationStart) {
    for (const sample of samples) sample.timestamp -= presentationStart;
  }
  applyPresentationHolds(samples);
  return {
    codec: sampleEntry.codec,
    description: sampleEntry.description.toString("base64"),
    width: sampleEntry.width,
    height: sampleEntry.height,
    timescale,
    duration: dts / timescale,
    size: stat.size,
    samples,
  };
}

module.exports = { parseVideoIndex, sampleToChunk, applyPresentationHolds };
