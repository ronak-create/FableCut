/* FableCut music search — openly licensed music and sound effects from
   Openverse (https://openverse.org), with each track's licence spelled out.
   Zero dependencies; loaded by the editor as a plain script (global
   `FableCutMusic`) and required by the MCP server, so the bin's Music tab and
   `fablecut_music` search the same way and label licences the same way.

   Openverse indexes Jamendo, Freesound, ccMixter, Wikimedia Commons and more.
   Its API needs no key: anonymous use allows 20 results a page, 240 results
   per search (12 pages) and about 200 searches a day per address. Its terms
   ask apps to say they are made with Openverse (not endorsed by it) and to
   credit the works, which is what `credits` and `creditLine` are for.

   searchUrl(opts) → the API URL · track(result) → a plain track · licence(code,
   version) → what it allows · mediaLicense(track) → what a media entry keeps
   (m.license) · credits(doc, uses) → the credits the edit needs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutMusic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const API = "https://api.openverse.org/v1/audio/";
  const PAGE_SIZE = 20;   // the most an anonymous request may ask for
  const MAX_PAGE = 12;    // 240 results deep
  const MAX_QUERY = 200;
  // Openverse's length buckets, checked against its results
  const LENGTHS = {
    shortest: "under 30 s", short: "30 s – 2 min", medium: "2 – 10 min", long: "over 10 min",
  };
  // sound effects: Freesound's (Openverse leaves their category empty, so a category filter misses them)
  const KINDS = { music: { category: "music" }, sfx: { source: "freesound" } };
  const MOODS = ["upbeat", "chill", "cinematic", "epic", "lo-fi", "acoustic", "electronic",
    "happy", "sad", "ambient", "piano", "corporate", "hip hop", "rock"];
  const SFX_WORDS = ["whoosh", "impact", "riser", "swoosh", "pop", "click", "ding", "glitch",
    "boom", "camera shutter", "typing", "applause", "footsteps", "crowd"];

  /* What each licence lets a video editor do. edits: may it be cut, looped and
     put under picture? Creative Commons counts music synced to moving images as
     an adaptation, so ND (no derivatives) music can't go into an edit. */
  const LICENSES = {
    cc0: { label: "CC0", commercial: true, edits: true, credit: false, note: "public domain dedication — use it any way you like" },
    pdm: { label: "Public domain", commercial: true, edits: true, credit: false, note: "public domain — use it any way you like" },
    by: { label: "CC BY", commercial: true, edits: true, credit: true, note: "any use, credit the artist" },
    "by-sa": { label: "CC BY-SA", commercial: true, edits: true, credit: true, note: "any use, credit the artist; the video must be shared under CC BY-SA too" },
    "by-nc": { label: "CC BY-NC", commercial: false, edits: true, credit: true, note: "non-commercial only (no ads, sponsored or monetized videos), credit the artist" },
    "by-nc-sa": { label: "CC BY-NC-SA", commercial: false, edits: true, credit: true, note: "non-commercial only, credit the artist; the video must be shared under CC BY-NC-SA too" },
    "by-nd": { label: "CC BY-ND", commercial: true, edits: false, credit: true, note: "no derivatives: music set to video counts as one, so it can't go into an edit" },
    "by-nc-nd": { label: "CC BY-NC-ND", commercial: false, edits: false, credit: true, note: "non-commercial and no derivatives: music set to video counts as one, so it can't go into an edit" },
    // Sampling licences allow transforming parts of a track, not setting the whole track to video as it is
    "sampling+": { label: "Sampling+", commercial: false, edits: true, sampling: true, credit: true, note: "parts may be sampled and transformed, also commercially (not in ads); the whole track as it is only shared non-commercially, not set to video; credit the artist" },
    "nc-sampling+": { label: "NC Sampling+", commercial: false, edits: true, sampling: true, credit: true, note: "parts may be sampled and transformed, non-commercially only; the whole track as it is can't be set to video; credit the artist" },
  };

  /** What a licence allows: {code, label ("CC BY 4.0"), commercial, edits, credit, note, url}. */
  function licence(code, version, url) {
    const c = String(code || "").toLowerCase();
    const base = LICENSES[c] || { label: c ? c.toUpperCase() : "Unknown licence", commercial: false, edits: false, credit: true, note: "unknown licence — check the track's page before using it" };
    const v = version && !/^(cc0|pdm)$/.test(c) ? String(version) : "";
    return { code: c, label: base.label + (v ? " " + v : ""), commercial: base.commercial, edits: base.edits,
      sampling: !!base.sampling, credit: base.credit, note: base.note, url: url || "" };
  }

  /** The words that sum a licence up for a badge: "free to use", "credit", "non-commercial", "no edits", "samples only", "share alike". */
  function flags(lic) {
    const out = [];
    if (!lic.credit && lic.commercial && lic.edits) out.push("free to use");
    if (lic.credit) out.push("credit");
    if (!lic.commercial) out.push("non-commercial");
    if (!lic.edits) out.push("no edits");
    if (lic.sampling) out.push("samples only");
    if (/-sa$/.test(lic.code)) out.push("share alike");
    return out;
  }

  /** Why a licence limits a video, one line each (credits and the import reply). */
  function warnings(lic) {
    const out = [];
    if (!lic.edits) out.push(lic.label + " allows no derivatives — music set to video counts as one");
    if (lic.sampling) out.push(lic.label + " allows only sampled, transformed parts — not the whole track under a video");
    if (!lic.commercial) out.push(lic.label + " is non-commercial only");
    if (/-sa$/.test(lic.code)) out.push(lic.label + ": share the video under the same licence");
    return out;
  }

  /** Only http(s) links reach a page's href; anything else becomes "". */
  function webUrl(u) {
    try { const x = new URL(String(u || "")); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; }
    catch (_) { return ""; }
  }

  /** The Openverse search URL. opts: {query, kind:'music'|'sfx', length:'shortest'|'short'|'medium'|'long',
   *  commercial:true (only licences that allow commercial use), edits:true (only ones that allow
   *  edits), licenses:[codes], page}. */
  function searchUrl(opts = {}) {
    const q = String(opts.query == null ? "" : opts.query).trim().slice(0, MAX_QUERY);
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    else p.set("unstable__sort_by", "indexed_on");   // nothing typed: the newest
    const kind = KINDS[opts.kind] || KINDS.music;
    for (const k of Object.keys(kind)) p.set(k, kind[k]);
    if (opts.length && LENGTHS[opts.length]) p.set("length", opts.length);
    // commercial / edits pick licence codes by FableCut's own table: Openverse's "commercial" group
    // includes Sampling+, which FableCut labels non-commercial for a whole track. edits means "may
    // go under a video as it is", so it leaves out ND and the Sampling licences.
    let lic = (opts.licenses || []).map((l) => String(l).toLowerCase()).filter((l) => LICENSES[l]);
    if (opts.commercial || opts.edits) {
      const ok = (c) => (!opts.commercial || LICENSES[c].commercial) && (!opts.edits || (LICENSES[c].edits && !LICENSES[c].sampling));
      const picked = (lic.length ? lic : Object.keys(LICENSES)).filter(ok);
      if (!picked.length) throw new Error("none of those licences allow " + [opts.commercial && "commercial use", opts.edits && "edits"].filter(Boolean).join(" and "));
      lic = picked;
    }
    if (lic.length) p.set("license", lic.join(","));
    p.set("mature", "false");
    p.set("page_size", String(PAGE_SIZE));
    const page = Math.max(1, Math.min(MAX_PAGE, Math.floor(+opts.page || 1)));
    if (page > 1) p.set("page", String(page));
    return API + "?" + p.toString();
  }

  /** One track's details by its Openverse id. */
  function trackUrl(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) throw new Error("not an Openverse track id: " + id);
    return API + String(id).toLowerCase() + "/";
  }

  // titles and names come HTML-escaped from some sources ("Jaief &amp; Asong")
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  const unescape = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENT[e]).trim();

  /** An Openverse result as a plain track. */
  function track(r) {
    r = r || {};
    const lic = licence(r.license, r.license_version, webUrl(r.license_url));
    return {
      id: r.id, title: unescape(r.title || "Untitled"), creator: unescape(r.creator || "Unknown artist"),
      creatorUrl: webUrl(r.creator_url), duration: r.duration ? Math.round(r.duration / 100) / 10 : null,
      license: lic, flags: flags(lic),
      url: webUrl(r.url), page: webUrl(r.foreign_landing_url), source: r.source || r.provider || "",
      genres: (r.genres || []).slice(0, 6), tags: (r.tags || []).map((t) => t && t.name).filter(Boolean).slice(0, 10),
      filetype: r.filetype || "", attribution: r.attribution || "",
    };
  }

  /** A search answer → {count, pages, page, tracks}. */
  function results(json, page) {
    json = json || {};
    return { count: json.result_count || 0, pages: Math.min(json.page_count || 0, MAX_PAGE), page: page || json.page || 1,
      tracks: (json.results || []).filter((r) => r && r.url).map(track) };
  }

  /** 125.4 → "2:05"; under 10 s with a tenth (a 0.4 s swipe reads "0.4 s", not "0:00"). */
  function fmtLen(sec) {
    if (+sec < 10) return (Math.round((+sec || 0) * 10) / 10) + " s";
    const s = Math.round(+sec);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /** A friendly file name for the download: "Title - Artist.mp3". */
  function fileName(t) {
    const ft = String(t.filetype || "mp3").toLowerCase();
    const ext = { mp32: "mp3", mp31: "mp3", oga: "ogg", opus: "ogg", aif: "wav", aiff: "wav" }[ft] || ft;
    return (t.title + " - " + t.creator).replace(/[^\w.\- ()\[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) + "." + ext;
  }

  /** What a media entry keeps about where its file came from (m.license). */
  function mediaLicense(t) {
    return { code: t.license.code, label: t.license.label, url: t.license.url, title: t.title, creator: t.creator,
      page: t.page, source: t.source, openverse: t.id, attribution: t.attribution };
  }

  /** A media entry's licence as stored: only its text fields, trimmed; null when it isn't one. */
  function cleanLicense(l) {
    if (!l || typeof l !== "object" || Array.isArray(l) || !l.code) return null;
    const out = {};
    for (const k of ["code", "label", "url", "title", "creator", "page", "source", "openverse", "attribution"]) {
      if (typeof l[k] !== "string" || !l[k]) continue;
      // links are kept whole or not at all: a cut URL would point somewhere else
      if (k === "url" || k === "page") { const u = webUrl(l[k]); if (u && u.length <= 2000) out[k] = u; }
      else out[k] = l[k].slice(0, k === "attribution" ? 1000 : 300);
    }
    if (!out.label) out.label = licence(out.code).label;
    return out;
  }

  /** The credit to put in a video's description: "Title" by Artist (source) — CC BY 4.0 — page. */
  function creditLine(l) {
    if (!l) return "";
    return `"${l.title}" by ${l.creator}` + (l.source ? ` (${l.source})` : "") + ` — ${l.label}` +
      (l.url ? ` (${l.url})` : "") + (l.page ? ` — ${l.page}` : "");
  }

  /** How often each media file is placed in the edit itself: the open sequence's clips and the
   *  compositions placed in it (nested ones too) — not other sequences or comps nothing places.
   *  A linked group counts once. → Map(media id → placements) for `credits`. */
  function editUsage(doc) {
    const n = new Map(), comps = new Map(((doc && doc.comps) || []).map((c) => [c.id, c]));
    // lo / hi: the stretch of these clips' timeline that is shown (a comp instance shows its comp
    // from `in` for `duration`, as the renderer flattens it); clips outside it aren't in the edit
    const scan = (clips, depth, inComps, lo, hi) => {
      const seen = new Set();
      for (const c of clips || []) {
        const start = +c.start || 0, end = start + (+c.duration || 0);
        if (end <= lo || start >= hi) continue;
        if (c.kind === "comp" && comps.has(c.compId) && depth < 8 && !inComps.has(c.compId)) {
          const off = (+c.in || 0) - start;   // parent time → comp time
          scan(comps.get(c.compId).clips, depth + 1, new Set([...inComps, c.compId]), Math.max(lo, start) + off, Math.min(hi, end) + off);
        }
        if (!c.mediaId) continue;
        const key = (c.linkGroup ? "g:" + c.linkGroup : "c:" + c.id) + "|" + c.mediaId;
        if (seen.has(key)) continue;
        seen.add(key);
        n.set(c.mediaId, (n.get(c.mediaId) || 0) + 1);
      }
    };
    scan(doc && doc.clips, 0, new Set(), -Infinity, Infinity);
    return n;
  }

  /** The credits an edit needs: every licensed file the edit uses (a denoised
   *  copy counts as its original, and its credit says the sound was changed).
   *  uses: media id → placements (MediaLib.usageCounts).
   *  → [{mediaId, name, license, line, needsCredit, changes, warnings}] */
  function credits(doc, uses) {
    const media = (doc && doc.media) || [];
    const byId = new Map(media.map((m) => [m.id, m]));
    const origin = (m) => {
      for (let i = 0; m && !m.license && m.derivedFrom && i < 8; i++) m = byId.get(m.derivedFrom);
      return m && m.license ? m : null;
    };
    const byWork = new Map();
    for (const m of media) {
      if (!(uses && uses.get ? uses.get(m.id) : 0)) continue;
      const o = origin(m);
      if (!o) continue;
      const key = o.license.openverse || o.id;
      if (!byWork.has(key)) byWork.set(key, { o, changes: new Set() });
      // a denoised copy may carry the licence itself (and so be its own origin here)
      if (m.denoise) byWork.get(key).changes.add("noise reduced");
      else if (m !== o) byWork.get(key).changes.add("processed");
    }
    return [...byWork.values()].map(({ o, changes }) => {
      const lic = licence(o.license.code), ch = [...changes];
      return { mediaId: o.id, name: o.name, license: o.license, needsCredit: lic.credit, changes: ch,
        line: creditLine(o.license) + (ch.length ? ` — changed: ${ch.join(", ")}` : ""), warnings: warnings(lic) };
    });
  }

  const ABOUT = "Music from Openverse (openverse.org) — made with Openverse, not endorsed or certified by it. Each track's licence is the artist's: check it before you publish.";

  return { API, PAGE_SIZE, MAX_PAGE, LENGTHS, KINDS, MOODS, SFX_WORDS, LICENSES, ABOUT,
    licence, flags, warnings, webUrl, searchUrl, trackUrl, track, results, fmtLen, fileName, mediaLicense, cleanLicense, creditLine, editUsage, credits };
});
