/* ═══════════════════════════════════════════════════════════════
   Static-mode shim for the FableCut playground.

   The editor normally talks to server.js: it GETs /api/project, PUTs it
   back on every edit, and listens on /api/events for someone else (an
   agent, an editor, a text editor) writing the file. None of that exists
   on a static host, so this file answers those four calls from memory and
   loads BEFORE app.js. Everything above it is the real editor, untouched.

   The parent page drives it over postMessage:
     parent -> frame   { type: "fc:set", json }    replace project.json
     frame  -> parent  { type: "fc:ready", json }  first paint done
     frame  -> parent  { type: "fc:project", json} the UI changed the project
     frame  -> parent  { type: "fc:error", message } JSON didn't parse

   Setting a project takes the same path a real agent write takes: bump the
   revision, emit a "change" event, let the editor pull and re-render.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var DEMO = {
    name: "Playground reel",
    width: 1080,
    height: 1920,
    fps: 30,
    background: "#05050a",
    revision: 1,
    markers: [{ t: 3.2, label: "cut" }, { t: 6.4, label: "whip" }],
    media: [
      { id: "m_violet", name: "plate-violet.mp4", kind: "video", src: "/media/plate-violet.mp4", duration: 6, width: 1080, height: 1920 },
      { id: "m_amber", name: "plate-amber.mp4", kind: "video", src: "/media/plate-amber.mp4", duration: 6, width: 1080, height: 1920 },
      { id: "m_teal", name: "plate-teal.mp4", kind: "video", src: "/media/plate-teal.mp4", duration: 6, width: 1080, height: 1920 },
      { id: "m_pad", name: "pad.mp3", kind: "audio", src: "/media/pad.mp3", duration: 14 }
    ],
    clips: [
      {
        id: "v1", mediaId: "m_violet", kind: "video", track: "V1", name: "violet",
        start: 0, in: 0, duration: 3.4,
        props: { fit: "cover", volume: 0 },
        keyframes: { scale: [{ t: 0, v: 1 }, { t: 3.4, v: 1.12 }] }
      },
      {
        id: "v2", mediaId: "m_amber", kind: "video", track: "V1", name: "amber",
        start: 3.2, in: 0, duration: 3.4,
        props: { fit: "cover", volume: 0, filterPreset: "cinematic" },
        transitionIn: { type: "fade", duration: 0.4 }
      },
      {
        id: "v3", mediaId: "m_teal", kind: "video", track: "V1", name: "teal",
        start: 6.4, in: 0, duration: 3.2,
        props: { fit: "cover", volume: 0, vignette: 30 },
        transitionIn: { type: "whip", duration: 0.25 }
      },
      {
        id: "t1", kind: "text", track: "V2", name: "title",
        start: 0.4, duration: 2.8,
        props: {
          text: "EDIT THIS JSON", font: "Anton", fontSize: 128, color: "#ffffff",
          uppercase: true, textAnim: "word-pop", wordRate: 0.14, textShadow: 18, y: 420
        }
      },
      {
        id: "t2", kind: "text", track: "V2", name: "kicker",
        start: 3.6, duration: 2.6,
        props: {
          text: "watch it happen", font: "Playfair Display", fontSize: 96,
          color: "#ffffff", color2: "#ffd24a", textAnim: "clip-reveal", y: -80
        }
      },
      {
        id: "a1", mediaId: "m_pad", kind: "audio", track: "A1", name: "pad",
        start: 0, in: 0, duration: 9.6, props: { volume: 0.6 },
        transitionOut: { type: "fade", duration: 1.5 }
      }
    ],
    inPoint: null,
    outPoint: null
  };

  /* The editor is served from /demo/, the clips live in /demo/media, but a
     project.json written by hand says "/media/...". Keep the canonical form
     in the text the visitor edits and rewrite on the way into the editor. */
  function toLocal(obj) {
    var copy = JSON.parse(JSON.stringify(obj));
    (copy.media || []).forEach(function (m) {
      if (typeof m.src === "string" && m.src.charAt(0) === "/") m.src = m.src.slice(1);
    });
    return copy;
  }
  function toCanonical(obj) {
    var copy = JSON.parse(JSON.stringify(obj));
    (copy.media || []).forEach(function (m) {
      if (typeof m.src === "string" && m.src.indexOf("media/") === 0) m.src = "/" + m.src;
    });
    return copy;
  }

  var store = { project: DEMO, transcripts: {} };
  var listeners = [];   // live fake EventSources

  function emit(name) {
    listeners.forEach(function (es) {
      (es._on[name] || []).forEach(function (fn) { try { fn({ type: name }); } catch (e) { } });
      if (name === "change" && typeof es.onmessage === "function") {
        try { es.onmessage({ data: "" }); } catch (e) { }
      }
    });
  }

  function reply(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { "Content-Type": "application/json" }
    }));
  }

  /* ── the four endpoints app.js actually needs, plus polite refusals ── */
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var path;
    try { path = new URL(url, location.href).pathname; } catch (e) { path = url; }
    // the templates' library files sit next to the playground (sync.js copies them)
    if (path.indexOf("/library/") === 0) return nativeFetch(path.slice(1), init);
    if (path.indexOf("/api/") === -1) return nativeFetch(input, init);
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

    if (path === "/api/project") {
      if (method === "PUT") {
        try {
          store.project = toCanonical(JSON.parse((init && init.body) || "{}"));
          post({ type: "fc:project", json: text() });
        } catch (e) { }
        return reply({ ok: true });
      }
      return reply(toLocal(store.project));
    }
    if (path === "/api/export/ffmpeg") return reply({ available: false });
    // transcripts made in the Transcript tab live as long as the page
    if (path === "/api/transcript") {
      var src = new URL(url, location.href).searchParams.get("src") || "";
      if (method === "POST") {
        try { var doc = JSON.parse((init && init.body) || "{}"); store.transcripts[src] = doc; return reply({ src: src, words: (doc.words || []).length }); }
        catch (e) { return reply({ error: "bad transcript" }, 400); }
      }
      return reply({ transcript: store.transcripts[src] || null });
    }
    if (path === "/api/library") return reply([]);
    if ((path === "/api/presets" || path === "/api/templates") && method === "GET") return reply([]);
    if (path === "/api/export/profiles") return reply({}, 404);
    if (path === "/api/upload" || path === "/api/library/install") {
      return reply({ error: "The playground runs in the browser with no server, so it can't take new files. Clone the repo to import your own footage." }, 501);
    }
    return reply({ error: "not available in the playground" }, 501);
  };

  /* ── a fake SSE channel: the parent page plays the part of the agent ── */
  var NativeES = window.EventSource;
  function FakeES() {
    this._on = {};
    this.onmessage = null;
    this.readyState = 1;
    listeners.push(this);
  }
  FakeES.prototype.addEventListener = function (name, fn) {
    (this._on[name] = this._on[name] || []).push(fn);
  };
  FakeES.prototype.removeEventListener = function (name, fn) {
    this._on[name] = (this._on[name] || []).filter(function (f) { return f !== fn; });
  };
  FakeES.prototype.close = function () {
    listeners = listeners.filter(function (es) { return es !== this; }, this);
    this.readyState = 2;
  };
  window.EventSource = FakeES;
  window.EventSource.native = NativeES;

  /* ── bridge to the page that embeds us ── */
  /* What the visitor sees and edits: everything except the media list. There
     is no file system behind this page, so an editable src could only point
     at something that does not exist. The real project.json has it. */
  function text() {
    var p = JSON.parse(JSON.stringify(store.project));
    delete p.media;
    return JSON.stringify(p, null, 2);
  }
  function post(msg) {
    if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*");
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.type === "fc:select") {
      var c = (typeof project !== "undefined" ? project.clips : []).filter(function (x) { return x.id === d.id; })[0];
      try {
        selectClip(d.id);
        // land past any entrance animation (a wipe/pop runs ~0.5s), so the
        // monitor shows the settled frame rather than a half-revealed line
        if (c) setTime(c.start + Math.min(1.1, Math.max(0.7, (c.duration || 1) / 2)));
      } catch (err) { }
      return;
    }
    if (!d || d.type !== "fc:set") return;
    var parsed;
    try { parsed = JSON.parse(d.json); }
    catch (err) { post({ type: "fc:error", message: String(err.message || err) }); return; }
    if (!parsed || !Array.isArray(parsed.clips)) {
      post({ type: "fc:error", message: "Needs a \"clips\" array." });
      return;
    }
    // an external write always lands on a new revision - that is what makes
    // the editor pull it instead of assuming it is looking at its own save
    parsed.revision = (store.project.revision || 0) + 1;
    parsed.media = JSON.parse(JSON.stringify(DEMO.media));   // not the visitor’s to change
    store.project = toCanonical(parsed);
    post({ type: "fc:ok" });
    emit("change");
  });

  /* ── embed mode (?embed=1): monitor + inspector only ──
     On the landing page the point is "change the document, watch the picture
     change", so the asset bin, the timeline and every server-backed control
     are hidden. A row of clip chips replaces the timeline as the way to put a
     clip in the inspector. The editor's own code is untouched. */
  var EMBED = /(?:^|[?&])embed=1/.test(location.search);
  /* view=monitor: the picture and transport only (the landing page's JSON pane
     is the inspector there) */
  var MONITOR_ONLY = EMBED && /(?:^|[?&])view=monitor(?:&|$)/.test(location.search);

  function styleEmbed() {
    var css = document.createElement("style");
    css.textContent = [
      "html.fc-embed, html.fc-embed body { overflow: hidden; }",
      "html.fc-embed .panel.bin, html.fc-embed #timelinePanel, html.fc-embed .v-split,",
      "html.fc-embed .topbar { display: none !important; }",
      "html.fc-embed .app { padding: 0; gap: 0; height: 100vh; }",
      // the editor's upper row is a 3-column grid (bin | monitor | inspector);
      // with the bin gone it becomes monitor + a narrower inspector
      // the label only pushes the controls onto a second line in here
      "html.fc-embed .panel.monitor .panel-head-title, html.fc-embed #monitorRes,",
      "html.fc-embed #vuMeter, html.fc-embed #btnSpeed { display: none !important; }",
      "html.fc-embed .upper { grid-template-columns: minmax(0, 1fr) var(--side-panel-w, 320px) !important; }",,
      // the frame's width IS its viewport, so plain media queries handle the
      // narrow cases: inspector under the monitor, then monitor alone
      "@media (max-width: 820px) {",
      "  html.fc-embed .upper { grid-template-columns: minmax(0, 1fr) !important;",
      "    grid-template-rows: minmax(0, 1fr) auto !important; }",
      "  html.fc-embed .panel.inspector { max-height: 230px; border-top: 1px solid var(--border, #26262e); }",
      "}",
      "@media (max-width: 560px) {",
      "  html.fc-embed .panel.inspector { display: none !important; }",
      // a phone-width frame has room for the playhead time and play controls only
      "  html.fc-embed .tc-slash, html.fc-embed #tcTotal, html.fc-embed #btnHome, html.fc-embed #btnEnd,",
      "  html.fc-embed #btnSpeed, html.fc-embed #exportFrameSel, html.fc-embed #btnExportFrame,",
      "  html.fc-embed #btnGuides { display: none !important; }",
      "  html.fc-embed .upper { grid-template-rows: minmax(0, 1fr) !important; }",
      "}"
    ].concat(MONITOR_ONLY ? [
      "html.fc-embed .panel.inspector, html.fc-embed .panel.monitor .panel-head { display: none !important; }",
      "html.fc-embed .upper { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: minmax(0, 1fr) !important; }",
      "html.fc-embed .panel.monitor { border: 0 !important; border-radius: 0 !important; }"
    ] : []).join("\n");
    document.head.appendChild(css);
    document.documentElement.classList.add("fc-embed");
  }

  /* Park the playhead a beat in once the clips have decoded, so the monitor
     opens on a real frame instead of the black one at 00:00. */
  function nudge(t) {
    try { if (typeof window.setTime === "function") window.setTime(t); } catch (e) { }
  }
  if (EMBED) styleEmbed();

  /* The canvas only draws with faces that are already loaded, so fetch the
     title fonts the demo and the landing page's example edits use up front.
     CORS mode keeps the canvas origin-clean. */
  (function preloadTitleFonts() {
    var families = ["Anton", "Playfair Display", "Bebas Neue", "Roboto"];
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.crossOrigin = "anonymous";
    link.href = "https://fonts.googleapis.com/css2?family=Anton&family=Playfair+Display:wght@400;700" +
      "&family=Bebas+Neue&family=Roboto:wght@400;600;700&display=swap";
    link.onload = function () {
      if (!document.fonts || !document.fonts.load) return;
      families.forEach(function (f) {
        ["400", "700"].forEach(function (w) {
          document.fonts.load(w + ' 64px "' + f + '"').catch(function () { });
        });
      });
    };
    document.head.appendChild(link);
  })();

  window.addEventListener("load", function () {
    setTimeout(function () { nudge(1.2); }, 700);
    setTimeout(function () {
      nudge(1.2);
     
      post({ type: "fc:ready", json: text() });
    }, 1600);
  });

  /* handy for the console */
  window.__fcDemo = { store: store, emit: emit, text: text };
})();
