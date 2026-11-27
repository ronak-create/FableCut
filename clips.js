/* FableCut clips — a long video into short clips, one call. The agent picks the
   segments (from the transcript: a tip, an answer, a story); for each one this makes
   a new sequence on the clip's canvas holding only that part of the open timeline,
   then frames it (reframe), adds a hook title and captions, and can export it.
   Zero dependencies; loaded by the editor as a plain script (global
   `FableCutClips`) and required by the MCP server, so fablecut_clips and Studio
   run the same steps. The steps themselves are the editor's own tools, passed in
   as `env`: read() the project, patch(ops), reframe(args), captions(args),
   exportClip(args) — each answering text, or throwing — and, optionally, progress(text)
   as each clip and step starts. exportClip gets a `timeout` (seconds) for that clip and
   answers once its export has ended (done, failed, or stopped when its time was up): the
   next clip opens another sequence, and the editor renders the open one live. An answer
   that says it is still running stops the batch there. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutClips = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ASPECTS = { "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5], "16:9": [16, 9] };
  const CAPTION_STYLES = ["pop", "highlight", "karaoke", "subtitle"];
  const MAX_CLIPS = 10, MIN_LEN = 3, MAX_LEN = 180, TITLE_SECS = 3;
  // each clip's export gets this long (3 min, or 6 s per second of the clip): one stuck past it is stopped
  // and reported, so it can't hold up the clips after it
  const EXPORT_MIN_S = 180, EXPORT_PER_S = 6;

  /** The canvas for a shape, keeping the project's shorter side (1920×1080 → 1080×1920 for 9:16), even sizes. */
  function canvasFor(aspect, W, H) {
    const r = ASPECTS[aspect];
    if (!r) throw new Error(`aspect must be one of ${Object.keys(ASPECTS).join(", ")}`);
    const short = Math.min(W || 1920, H || 1080);
    const even = (v) => Math.max(16, Math.round(v / 2) * 2);
    return r[0] <= r[1] ? { width: even(short), height: even(short * r[1] / r[0]) } : { width: even(short * r[0] / r[1]), height: even(short) };
  }
  const end = (doc) => (doc.clips || []).reduce((m, c) => Math.max(m, (+c.start || 0) + (+c.duration || 0)), 0);
  const clean = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const fileName = (s) => clean(s, 60).replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").toLowerCase() || "clip";

  /** Checked arguments: {clips:[{from, to, name, title}], aspect, captions, title, exportPreset}. Throws on anything wrong. */
  function options(args, doc) {
    args = args || {};
    const list = args.clips;
    if (!Array.isArray(list) || !list.length) throw new Error("clips must be a list of {from, to, name?, title?} — the parts of the timeline to make into clips (seconds)");
    if (list.length > MAX_CLIPS) throw new Error(`up to ${MAX_CLIPS} clips at a time`);
    const len = end(doc);
    if (!(len > 0)) throw new Error("the open timeline is empty — put the long video on it first");
    // each clip is cut out of a copy by extracting the rest, and an extract leaves locked material as it is:
    // the copy would keep it whole and out of step with the rest, so the call is refused before anything changes
    const lockedLanes = new Set(Array.isArray(doc.lockedTracks) ? doc.lockedTracks : []);
    const locked = (doc.clips || []).filter((c) => c && (c.locked || lockedLanes.has(c.track)));
    if (locked.length) throw new Error(`the timeline has locked material (${locked.slice(0, 4).map((c) => c.id + " on " + c.track).join(", ")}${locked.length > 4 ? ", …" : ""}): ` +
      "clips are cut out of a copy by extracting the rest, and locked clips can't be cut — unlock them (updateClip set:{locked:null}, or the lane's lock) only if the user agrees, then call again");
    const clips = list.map((c, i) => {
      const from = +(c && c.from), to = +(c && c.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`clip ${i + 1}: from and to must be numbers (timeline seconds)`);
      if (from < 0 || to > len + 0.05) throw new Error(`clip ${i + 1}: ${from}–${to} s is outside the timeline (0–${len.toFixed(2)} s)`);
      if (to - from < MIN_LEN) throw new Error(`clip ${i + 1}: at least ${MIN_LEN} s`);
      if (to - from > MAX_LEN) throw new Error(`clip ${i + 1}: at most ${MAX_LEN} s`);
      return { from: Math.round(from * 1000) / 1000, to: Math.round(Math.min(to, len) * 1000) / 1000,
        name: clean(c.name, 80) || `Clip ${i + 1}`, title: clean(c.title, 120) };
    });
    const aspect = args.aspect == null ? "9:16" : String(args.aspect);
    if (!ASPECTS[aspect]) throw new Error(`aspect must be one of ${Object.keys(ASPECTS).join(", ")}`);
    let captions = args.captions == null ? "pop" : args.captions;
    if (captions !== false && !CAPTION_STYLES.includes(captions)) throw new Error(`captions must be one of ${CAPTION_STYLES.join(", ")}, or false`);
    const exportPreset = args.export == null || args.export === false ? null : String(args.export);
    return { clips, aspect, captions, title: args.title !== false, reframe: args.reframe !== false, exportPreset };
  }

  /** The hook title: big outlined words in the top third, popping in for the first seconds. */
  function titleClip(id, text, track, W, H, len) {
    const size = Math.round(Math.min(W, H) * 0.085);
    return { id, kind: "text", mediaId: null, track, start: 0, in: 0, duration: Math.min(TITLE_SECS, len), name: "Hook title",
      props: { text, font: "Anton", fontSize: size, uppercase: true, color: "#ffffff", strokeWidth: Math.max(3, Math.round(size * 0.07)),
        strokeColor: "#000000", textShadow: 12, align: "center", boxW: Math.round(W * 0.86), boxH: Math.round(H * 0.22), boxFit: true,
        y: -Math.round(H * 0.36), textAnim: "word-pop", wordRate: 0.12 },
      transitionOut: { type: "fade", duration: 0.3 } };
  }
  /** The top video lane, when nothing is on it during the title; else null (the title is left out). */
  function freeTopLane(doc, until) {
    const lanes = (Array.isArray(doc.tracks) && doc.tracks.length ? doc.tracks : [{ id: "V3", kind: "video" }, { id: "V2", kind: "video" }, { id: "V1", kind: "video" }])
      .filter((t) => t && t.kind === "video").map((t) => t.id).sort((a, b) => +b.slice(1) - +a.slice(1));
    const top = lanes[0];
    if (!top || (doc.lockedTracks || []).includes(top)) return null;
    return (doc.clips || []).some((c) => c.track === top && c.start < until && c.start + c.duration > 0) ? null : top;
  }
  const first = (s) => String(s || "").split("\n")[0].slice(0, 200);

  /** Make the clips. Returns the reply text. */
  async function run(args, env) {
    const doc0 = await env.read();
    const o = options(args, doc0);
    const canvas = canvasFor(o.aspect, doc0.width, doc0.height);
    const reshaped = canvas.width * (doc0.height || 1080) !== canvas.height * (doc0.width || 1920);
    let source = doc0.sequence || null, opened = false, halted = "";
    const taken = new Set((doc0.sequences || []).map((s) => s.id));
    const made = [], lines = [];
    const step = (i, what) => { if (typeof env.progress === "function") env.progress(`clip ${i + 1} of ${o.clips.length}, ${what}`, made.length); };
    // measured on the source as it was (the open sequence may be the last clip by now); every lane named,
    // since an extract given none skips the untargeted ones, and those must be cut too
    const total = end(doc0);
    const lanes = doc0.tracks && doc0.tracks.length ? doc0.tracks.map((t) => t.id) : [...new Set((doc0.clips || []).map((x) => x.track).filter(Boolean))];
    for (let i = 0; i < o.clips.length; i++) {
      const c = o.clips[i];
      step(i, "cutting");
      let id = "seq_clip" + (i + 1);
      for (let n = 2; taken.has(id); n++) id = "seq_clip" + (i + 1) + "_" + n;
      taken.add(id);
      // the copy: the source timeline on the clip's canvas, cut down to from → to
      const ops = [];
      if (opened) ops.push({ op: "openSequence", id: source });   // the last clip's sequence is open
      ops.push({ op: "addSequence", id, name: c.name, from: "open", width: canvas.width, height: canvas.height, open: true });
      if (c.to < total - 0.001) ops.push({ op: "extract", from: c.to, to: total + 1, tracks: lanes });
      if (c.from > 0.001) ops.push({ op: "extract", from: 0, to: c.from, tracks: lanes });
      ops.push({ op: "setProject", set: { inPoint: null, outPoint: null } });
      // a patch saves all of it or nothing: a clip that can't be cut is reported, and the next one goes on
      try { await env.patch(ops); }
      catch (e) { lines.push(`  ${i + 1}. "${c.name}": not made (${first(e.message)})`); continue; }
      opened = true;
      if (!source) source = ((await env.read()).sequences || []).find((s) => s.id !== id)?.id || "main";
      const len = Math.round((c.to - c.from) * 1000) / 1000, notes = [];
      if (o.reframe && reshaped) {
        step(i, "framing");
        // the editor may save while the footage is read (just after opening, probing media): try once more
        let err = null;
        for (let k = 0; k < 2; k++) {
          try { await env.reframe({}); err = null; break; }
          catch (e) { err = e; if (!/changed/i.test(e.message)) break; }
        }
        notes.push(err ? "not reframed (" + first(err.message) + ")" : "framed on the subject");
      }
      if (o.title && c.title) {
        const now = await env.read(), lane = freeTopLane(now, Math.min(TITLE_SECS, len));
        if (lane) {
          try { await env.patch([{ op: "addClip", clip: titleClip(id + "_title", c.title, lane, canvas.width, canvas.height, len) }]); notes.push(`hook title "${c.title}"`); }
          catch (e) { notes.push("no title (" + first(e.message) + ")"); }
        } else notes.push("no title (the top video lane is busy or locked — add a lane, then a title)");
      }
      if (o.captions) {
        step(i, "captions");
        try {
          const r = String(await env.captions({ style: o.captions }));
          // still transcribing (Studio answers before a long first transcription is done): say so, don't claim them
          if (/call \S+ again|carries on/i.test(r)) notes.push("captions not added yet: the speech is still being transcribed — then openSequence and fablecut_captions {style:\"" + o.captions + "\"}");
          else notes.push(o.captions + " captions");
        }
        catch (e) { notes.push("no captions (" + first(e.message) + ")"); }
      }
      let file = "";
      if (o.exportPreset) {
        step(i, "exporting");
        try {
          const r = String(await env.exportClip({ preset: o.exportPreset, name: fileName(c.name), timeout: Math.max(EXPORT_MIN_S, Math.ceil(len * EXPORT_PER_S)) }));
          file = (r.match(/exports\/[^\s"'),]+/) || [""])[0];
          // an export that hasn't ended still renders the open sequence: opening another one would change its frames
          if (/\bExport \S+ (pending|running|queued)\b/.test(r)) { file = ""; halted = c.name; notes.push("not exported (" + first(r) + ")"); }
          // only a finished export counts: a stopped one is reported as it is
          else if (file && !/ (failed|cancelled)\b|check again/i.test(r)) notes.push("exported → " + file);
          else { file = ""; notes.push("not exported (" + first(r) + ")"); }
        } catch (e) { notes.push("not exported (" + first(e.message) + ")"); }
      }
      made.push({ id, name: c.name, file });
      lines.push(`  ${i + 1}. "${c.name}" (${id}, ${len.toFixed(1)} s from ${c.from.toFixed(2)}–${c.to.toFixed(2)} s): ${notes.join(", ") || "made"}`);
      if (halted) {
        if (i + 1 < o.clips.length) lines.push(`  The clips after "${halted}" weren't made: its export is still running, and opening another sequence would change what it renders. ` +
          "Once it has ended (fablecut_export {job}), call again with those parts.");
        break;
      }
    }
    if (!made.length) throw new Error("no clip was made:\n" + lines.join("\n"));
    if (made.length > 1 && !halted) { try { await env.patch([{ op: "openSequence", id: made[0].id }]); } catch { } }
    return `Made ${made.length} clip${made.length === 1 ? "" : "s"} on ${canvas.width}×${canvas.height} (${o.aspect}), each its own sequence; the source timeline is left as it was:\n` +
      lines.join("\n") + (halted ? `\n"${halted}" stays open while its export runs. ` : `\nOpened "${made[0].name}". `) + "Check each with fablecut_frame {time} after openSequence; " +
      (o.exportPreset ? "the files are in exports/." : "export one with openSequence then fablecut_export {preset, name}, or call again with export:\"tiktok\".");
  }

  return { ASPECTS, CAPTION_STYLES, MAX_CLIPS, MIN_LEN, MAX_LEN, canvasFor, options, titleClip, freeTopLane, run };
});
