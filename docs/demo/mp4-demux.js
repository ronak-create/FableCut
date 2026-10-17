/* FableCut MP4 demuxer — the sample table of an MP4 / MOV video track, so the
   exporter can feed WebCodecs' VideoDecoder frame by frame instead of seeking a
   <video> element and waiting for it to present each frame. Zero dependencies.
   Loaded by the editor as a plain script (global `FableCutMp4`) and required by
   the tests.

   Only what decoding needs is read: the first video track's codec string and
   decoder config (avcC / hvcC / vpcC / av1C), and per sample its byte range,
   whether it is a sync sample, and its presentation time in seconds after the
   track's edit list, which is the clock a <video> element shows. Fragmented
   MP4 (moof) is not supported: findMoov / parseMovie return null and the
   caller keeps the <video> path. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutMp4 = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
  const VIDEO_ENTRIES = new Set(["avc1", "avc3", "hvc1", "hev1", "vp09", "av01"]);

  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const i64 = (b, o) => i32(b, o) * 4294967296 + u32(b, o + 4);
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const hex2 = (n) => n.toString(16).padStart(2, "0").toUpperCase();

  /** The boxes directly inside b[start, end): [{ type, start, body, end }]. */
  function boxes(b, start = 0, end = b.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o), body = o + 8;
      const type = fourcc(b, o + 4);
      if (size === 1) { if (o + 16 > end) break; size = u64(b, o + 8); body = o + 16; }
      else if (size === 0) size = end - o;
      if (size < body - o || o + size > end) break;
      out.push({ type, start: o, body, end: o + size });
      o += size;
    }
    return out;
  }
  const child = (b, box, type) => boxes(b, box.body, box.end).find((x) => x.type === type) || null;
  function path(b, box, ...types) {
    let cur = box;
    for (const t of types) { cur = cur && child(b, cur, t); if (!cur) return null; }
    return cur;
  }

  /** Walk the top-level boxes through `read(start, end) → Promise<Uint8Array>`
   *  (an HTTP Range fetch) and return the moov box's bytes, or null (no moov,
   *  or a fragmented file). Faststart files answer from the first read. */
  async function findMoov(read, fileSize) {
    let o = 0, head = null, headAt = -1;
    while (o + 8 <= fileSize) {
      if (!head || o < headAt || o + 16 > headAt + head.length) {
        headAt = o; head = await read(o, Math.min(fileSize, o + 65536));
      }
      const r = o - headAt;
      let size = u32(head, r), hdr = 8;
      const type = fourcc(head, r + 4);
      if (size === 1) { size = u64(head, r + 8); hdr = 16; }
      else if (size === 0) size = fileSize - o;
      if (size < hdr) return null;
      if (type === "moof") return null;
      if (type === "moov") {
        const have = head.length - r;
        return have >= size ? head.subarray(r, r + size) : await read(o, o + size);
      }
      o += size;
    }
    return null;
  }

  /** Codec string for VideoDecoder.configure from the sample entry's config box. */
  function codecString(entry, b, cfg) {
    const d = b.subarray(cfg.body, cfg.end);
    if (entry === "avc1" || entry === "avc3")
      return `${entry}.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`;
    if (entry === "hvc1" || entry === "hev1") {   // ISO/IEC 14496-15 Annex E
      const space = ["", "A", "B", "C"][d[1] >> 6], tier = (d[1] >> 5) & 1 ? "H" : "L", idc = d[1] & 31;
      let compat = u32(d, 2), rev = 0;
      for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
      const cons = [];
      for (let i = 6; i < 12; i++) cons.push(d[i]);
      while (cons.length && cons[cons.length - 1] === 0) cons.pop();
      return [entry, space + idc, (rev >>> 0).toString(16).toUpperCase(), tier + d[12], ...cons.map((x) => x.toString(16).toUpperCase())].join(".");
    }
    if (entry === "vp09") {   // vpcC is a full box: version + flags first
      const p = d.subarray(4);
      const two = (n) => String(n).padStart(2, "0");
      return `vp09.${two(p[0])}.${two(p[1])}.${two(p[2] >> 4)}`;
    }
    if (entry === "av01") {
      const profile = d[1] >> 5, level = d[1] & 31, tier = d[2] >> 7 ? "H" : "M";
      const bits = (d[2] >> 6) & 1 ? ((d[2] >> 5) & 1 ? 12 : 10) : 8;
      return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(bits).padStart(2, "0")}`;
    }
    return null;
  }

  /** The first video track of a moov box: { codec, description, width, height,
   *  timescale, samples: [{ offset, size, key, pts, dur }] in decode order }.
   *  pts and dur are seconds on the presentation clock (edit list applied). */
  function parseMovie(moov) {
    const b = moov, root = { body: 0, end: b.length, type: "root" };
    const moovBox = child(b, root, "moov") || (fourcc(b, 4) === "moov" ? boxes(b)[0] : null);
    if (!moovBox) return null;
    if (child(b, moovBox, "mvex")) return null;   // fragmented: samples live in moof boxes
    const mvhd = child(b, moovBox, "mvhd");
    const movieScale = mvhd ? (b[mvhd.body] === 1 ? u32(b, mvhd.body + 20) : u32(b, mvhd.body + 12)) : 1000;
    for (const trak of boxes(b, moovBox.body, moovBox.end).filter((x) => x.type === "trak")) {
      const hdlr = path(b, trak, "mdia", "hdlr");
      if (!hdlr || fourcc(b, hdlr.body + 8) !== "vide") continue;
      const mdhd = path(b, trak, "mdia", "mdhd"), stbl = path(b, trak, "mdia", "minf", "stbl");
      if (!mdhd || !stbl) continue;
      // A rotated or mirrored track (phone footage) is turned by the player, not
      // by the decoder: leave those to the <video> element.
      const tkhd = child(b, trak, "tkhd");
      if (tkhd) {
        const m = tkhd.body + (b[tkhd.body] === 1 ? 52 : 40);
        if (u32(b, m) !== 0x10000 || u32(b, m + 4) !== 0 || u32(b, m + 12) !== 0 || u32(b, m + 16) !== 0x10000) return null;
      }
      const v1 = b[mdhd.body] === 1;
      const timescale = v1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12);
      const stsd = child(b, stbl, "stsd");
      if (!stsd || !timescale) continue;
      const entryBox = boxes(b, stsd.body + 8, stsd.end)[0];
      if (!entryBox || !VIDEO_ENTRIES.has(entryBox.type)) continue;
      const entry = entryBox.type;
      const width = (b[entryBox.body + 24] << 8) | b[entryBox.body + 25];
      const height = (b[entryBox.body + 26] << 8) | b[entryBox.body + 27];
      const cfgType = { avc1: "avcC", avc3: "avcC", hvc1: "hvcC", hev1: "hvcC", vp09: "vpcC", av01: "av1C" }[entry];
      const cfg = boxes(b, entryBox.body + 78, entryBox.end).find((x) => x.type === cfgType);
      if (!cfg) continue;
      const codec = codecString(entry, b, cfg);
      if (!codec) continue;
      // vpcC carries no decoder description; the others hand the box body over as is
      const description = entry === "vp09" ? undefined : b.slice(cfg.body, cfg.end);
      const samples = sampleTable(b, stbl, timescale);
      if (!samples) continue;
      applyEdits(b, trak, samples, timescale, movieScale);
      return { codec, description, width, height, timescale, samples };
    }
    return null;
  }

  function sampleTable(b, stbl, timescale) {
    const box = (t) => child(b, stbl, t);
    const stsz = box("stsz"), stz2 = box("stz2"), stsc = box("stsc"), stts = box("stts");
    const stco = box("stco"), co64 = box("co64"), stss = box("stss"), ctts = box("ctts");
    if (!(stsz || stz2) || !stsc || !stts || !(stco || co64)) return null;
    // sizes
    const sizes = [];
    if (stsz) {
      const fixed = u32(b, stsz.body + 4), n = u32(b, stsz.body + 8);
      for (let i = 0; i < n; i++) sizes.push(fixed || u32(b, stsz.body + 12 + i * 4));
    } else {
      const field = b[stz2.body + 7], n = u32(b, stz2.body + 8), o = stz2.body + 12;
      for (let i = 0; i < n; i++) {
        if (field === 4) sizes.push(i & 1 ? b[o + (i >> 1)] & 15 : b[o + (i >> 1)] >> 4);
        else if (field === 8) sizes.push(b[o + i]);
        else sizes.push((b[o + i * 2] << 8) | b[o + i * 2 + 1]);
      }
    }
    const n = sizes.length;
    // chunk offsets → sample offsets via sample-to-chunk
    const chunks = [];
    if (stco) { const c = u32(b, stco.body + 4); for (let i = 0; i < c; i++) chunks.push(u32(b, stco.body + 8 + i * 4)); }
    else { const c = u32(b, co64.body + 4); for (let i = 0; i < c; i++) chunks.push(u64(b, co64.body + 8 + i * 8)); }
    const runs = [];
    for (let i = 0, c = u32(b, stsc.body + 4); i < c; i++)
      runs.push({ first: u32(b, stsc.body + 8 + i * 12) - 1, per: u32(b, stsc.body + 12 + i * 12) });
    const offsets = new Array(n);
    let s = 0;
    for (let r = 0; r < runs.length && s < n; r++) {
      const last = r + 1 < runs.length ? runs[r + 1].first : chunks.length;
      for (let ch = runs[r].first; ch < last && s < n; ch++) {
        let o = chunks[ch];
        for (let k = 0; k < runs[r].per && s < n; k++) { offsets[s] = o; o += sizes[s]; s++; }
      }
    }
    if (s < n) return null;
    // decode times, composition offsets, sync samples
    const dts = new Array(n), durs = new Array(n);
    let t = 0, i = 0;
    for (let e = 0, c = u32(b, stts.body + 4); e < c; e++) {
      const count = u32(b, stts.body + 8 + e * 8), delta = u32(b, stts.body + 12 + e * 8);
      for (let k = 0; k < count && i < n; k++, i++) { dts[i] = t; durs[i] = delta; t += delta; }
    }
    for (; i < n; i++) { dts[i] = t; durs[i] = 0; }
    const cto = new Array(n).fill(0);
    if (ctts) {
      const signed = b[ctts.body] === 1;
      let j = 0;
      for (let e = 0, c = u32(b, ctts.body + 4); e < c; e++) {
        const count = u32(b, ctts.body + 8 + e * 8);
        const off = signed ? i32(b, ctts.body + 12 + e * 8) : u32(b, ctts.body + 12 + e * 8);
        for (let k = 0; k < count && j < n; k++, j++) cto[j] = off;
      }
    }
    const key = new Array(n).fill(!stss);
    if (stss) for (let e = 0, c = u32(b, stss.body + 4); e < c; e++) {
      const k = u32(b, stss.body + 8 + e * 4) - 1;
      if (k >= 0 && k < n) key[k] = true;
    }
    const out = new Array(n);
    for (let k = 0; k < n; k++)
      out[k] = { offset: offsets[k], size: sizes[k], key: key[k], cts: dts[k] + cto[k], pts: (dts[k] + cto[k]) / timescale, dur: durs[k] / timescale };
    return out;
  }

  /** Move pts onto the presentation clock, as a <video> element does: the first
   *  non-empty edit's media_time is presentation 0, after any leading empty
   *  edits (dwell, in movie-timescale units). */
  function applyEdits(b, trak, samples, timescale, movieScale) {
    const elst = path(b, trak, "edts", "elst");
    if (!elst) return;
    const v1 = b[elst.body] === 1, count = u32(b, elst.body + 4), size = v1 ? 20 : 12;
    let empty = 0, mediaTime = null;
    for (let e = 0; e < count; e++) {
      const o = elst.body + 8 + e * size;
      const dur = v1 ? u64(b, o) : u32(b, o), mt = v1 ? i64(b, o + 8) : i32(b, o + 4);
      if (mt === -1) { empty += dur; continue; }
      mediaTime = mt; break;
    }
    const shift = (empty / movieScale) - (mediaTime || 0) / timescale;
    if (!shift) return;
    for (const s of samples) s.pts = s.cts / timescale + shift;
  }

  /** Index (decode order) of the frame a player shows at presentation time t:
   *  the latest pts ≤ t (+ a microsecond for float noise); the first frame
   *  before the track starts. `order` is the decode indices sorted by pts. */
  function frameAt(samples, order, t) {
    let lo = 0, hi = order.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (samples[order[mid]].pts <= t + 1e-6) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return order[best];
  }
  const presentationOrder = (samples) => samples.map((_, i) => i).sort((a, b) => samples[a].pts - samples[b].pts);
  /** The sync sample at or before decode index k (where decoding must start). */
  function syncBefore(samples, k) {
    for (let i = k; i >= 0; i--) if (samples[i].key) return i;
    return 0;
  }

  return { boxes, findMoov, parseMovie, codecString, frameAt, presentationOrder, syncBefore };
});
