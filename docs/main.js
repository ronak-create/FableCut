/* FableCut site. Plain script, no build, no dependencies. */
(function () {
  "use strict";

  var doc = document.documentElement;
  var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  };

  /* ── Theme: follows the system until the visitor picks one ── */
  document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var current = doc.getAttribute("data-theme") ||
        (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
      var next = current === "light" ? "dark" : "light";
      doc.setAttribute("data-theme", next);
      store.set("fc-theme", next);
    });
  });

  /* ── Nav: a hairline once the page moves, and the small-screen menu ── */
  var nav = document.getElementById("nav");
  if (nav && "IntersectionObserver" in window) {
    var sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText = "position:absolute;top:0;left:0;width:1px;height:8px;pointer-events:none";
    document.body.prepend(sentinel);
    new IntersectionObserver(function (entries) {
      nav.classList.toggle("stuck", !entries[0].isIntersecting);
    }).observe(sentinel);
  }
  var menuBtn = document.getElementById("menuBtn");
  if (nav && menuBtn) {
    var setMenu = function (open) {
      nav.classList.toggle("open", open);
      menuBtn.setAttribute("aria-expanded", String(open));
    };
    menuBtn.addEventListener("click", function () { setMenu(!nav.classList.contains("open")); });
    nav.addEventListener("click", function (e) { if (e.target.closest(".nav-links a")) setMenu(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });
  }

  /* ── Reveal on scroll ── */
  var reveals = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); rio.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    reveals.forEach(function (el) { rio.observe(el); });
  }

  /* ── Copy buttons: copy the code block they sit in ── */
  document.querySelectorAll(".copy").forEach(function (btn) {
    var label = btn.getAttribute("aria-label");
    btn.addEventListener("click", function () {
      var code = btn.parentNode.querySelector("pre code");
      if (!code || !navigator.clipboard) return;
      var text = code.innerText.replace(/^\/\/ .*\n/, "").trim();
      navigator.clipboard.writeText(text).then(function () {
        btn.classList.add("done");
        btn.setAttribute("aria-label", "Copied");
        clearTimeout(btn._t);
        btn._t = setTimeout(function () {
          btn.classList.remove("done");
          btn.setAttribute("aria-label", label);
        }, 1600);
      }).catch(function () { });
    });
  });

  /* ── Tabs: one code block per MCP client, the choice remembered across pages ── */
  document.querySelectorAll("[data-tabs]").forEach(function (root) {
    var list = root.querySelector("[role=tablist]");
    var tabs = [].slice.call(root.querySelectorAll("[role=tab]"));
    var ind = root.querySelector(".tab-ind");

    function place(tab, instant) {
      if (!ind || !tab) return;
      if (instant) ind.style.transition = "none";
      ind.style.width = tab.offsetWidth + "px";
      ind.style.transform = "translateX(" + tab.offsetLeft + "px)";
      if (instant) { void ind.offsetWidth; ind.style.transition = ""; }
    }
    function select(tab, focus, instant) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
      place(tab, instant);
      store.set("fc-client", tab.id);
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        var n = null;
        if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") n = tabs[0];
        else if (e.key === "End") n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
    var saved = document.getElementById(store.get("fc-client") || "");
    select(tabs.indexOf(saved) >= 0 ? saved : tabs[0], false, true);
    if ("ResizeObserver" in window) {
      new ResizeObserver(function () {
        place(root.querySelector("[aria-selected=true]"), true);
      }).observe(list);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { place(root.querySelector("[aria-selected=true]"), true); });
    }
  });

  /* ── Demo reel in a dialog; the video only downloads when asked for ── */
  var dlg = document.getElementById("demoDlg");
  if (dlg && typeof dlg.showModal === "function") {
    var video = dlg.querySelector("video");
    document.querySelectorAll("[data-demo]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!video.getAttribute("src")) video.src = video.getAttribute("data-src");
        dlg.showModal();
        var p = video.play();
        if (p && p.catch) p.catch(function () { });
      });
    });
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
    });
    dlg.addEventListener("close", function () { video.pause(); });
  }

  /* ── Showcase reels: load when near, play while on screen, sound on ask ── */
  (function () {
    var vids = document.querySelectorAll(".reel video[data-src]");
    if (!vids.length) return;
    function load(v) { if (!v.getAttribute("src")) v.src = v.getAttribute("data-src"); }
    function play(v) { load(v); var p = v.play(); if (p && p.catch) p.catch(function () { }); }
    vids.forEach(function (v) {
      var snd = v.parentNode.querySelector(".reel-snd");
      v.addEventListener("click", function () { if (v.paused) play(v); else v.pause(); });
      if (snd) snd.addEventListener("click", function () {
        var on = v.muted;
        vids.forEach(function (o) {
          o.muted = true;
          var b = o.parentNode.querySelector(".reel-snd");
          if (b) { b.setAttribute("aria-pressed", "false"); b.setAttribute("aria-label", "Turn sound on"); }
        });
        v.muted = !on;
        snd.setAttribute("aria-pressed", String(on));
        snd.setAttribute("aria-label", on ? "Turn sound off" : "Turn sound on");
        if (on) { v.currentTime = 0; play(v); }
      });
    });
    if (reduced || !("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) play(e.target);
        else if (e.target.getAttribute("src")) e.target.pause();
      });
    }, { rootMargin: "200px 0px", threshold: 0.15 });
    vids.forEach(function (v) { io.observe(v); });
  })();

  /* ── Live numbers from GitHub (stars, latest release), cached per tab ── */
  (function () {
    var starEls = document.querySelectorAll("[data-stars]");
    var tagEls = document.querySelectorAll("[data-rel-tag]");
    var nameEls = document.querySelectorAll("[data-rel-name]");
    var pill = document.getElementById("relPill");
    if (!starEls.length && !tagEls.length) return;

    var KEY = "fc-gh-v2", TTL = 10 * 60 * 1000;
    function fmt(n) {
      return n < 1000 ? String(n) : (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    }
    function paint(d) {
      if (d.stars != null) {
        starEls.forEach(function (el) {
          el.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-star"/></svg>';
          el.appendChild(document.createTextNode(fmt(d.stars)));
          el.setAttribute("aria-label", d.stars + " stars");
        });
      }
      if (d.tag) {
        tagEls.forEach(function (el) { el.textContent = d.tag; });
        if (d.summary) nameEls.forEach(function (el) { el.textContent = d.summary; });
        if (pill && d.url) pill.href = d.url;
      }
    }
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { }
    if (cached && Date.now() - cached.t < TTL) { paint(cached); return; }

    var out = { t: Date.now() };
    var repo = fetch("https://api.github.com/repos/ronak-create/FableCut")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j.stargazers_count === "number") out.stars = j.stargazers_count; })
      .catch(function () { });
    var rel = fetch("https://api.github.com/repos/ronak-create/FableCut/releases/latest")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.tag_name) return;
        out.tag = j.tag_name;
        out.url = j.html_url;
        // "FableCut v1.9.0 — targeting & locks, ..." keeps only what is new
        var parts = String(j.name || "").split(/\s[—–-]\s/);
        var s = parts.length > 1 ? parts.slice(1).join(", ") : "";
        out.summary = s ? s.charAt(0).toUpperCase() + s.slice(1) : "Read the release notes";
      })
      .catch(function () { });
    Promise.all([repo, rel]).then(function () {
      paint(out);
      try { sessionStorage.setItem(KEY, JSON.stringify(out)); } catch (e) { }
    });
  })();

  /* ── Hero: an agent cuts a teaser, on a loop ──
     One clock drives it all. frame(t) works out the whole picture for second
     t of the loop (which edits have landed, where the playhead is, what the
     monitor shows), so looping is just t going back to 0. Reduced motion
     keeps the finished frame the HTML already describes. */
  (function () {
    var root = document.getElementById("cut");
    if (!root || reduced) return;
    var LOOP = 15, TL = 10, FPS = 30;
    var T = { typeFrom: 0.5, typeTo: 1.8, glideFrom: 4.7, glideTo: 5.2, park: 1.4, noir: 6, playFrom: 7, playTo: 12.6, out: 14.3 };

    var $ = function (s) { return root.querySelector(s); };
    var clips = [].map.call(root.querySelectorAll("[data-clip]"), function (el) {
      return {
        id: el.getAttribute("data-clip"), el: el, at: +el.getAttribute("data-at"),
        s: parseFloat(el.style.getPropertyValue("--s")), d: parseFloat(el.style.getPropertyValue("--d"))
      };
    });
    var byId = {};
    clips.forEach(function (c) { byId[c.id] = c; });
    var video = ["v1", "v2", "v3"].map(function (id) { return byId[id]; });
    var plates = {};
    [].forEach.call(root.querySelectorAll("[data-plate]"), function (el) { plates[el.getAttribute("data-plate")] = el; });
    var rows = [].map.call(root.querySelectorAll(".cut-log li"), function (li) {
      return { el: li, at: +li.getAttribute("data-at"), text: [].map.call(li.children, function (c) { return c.textContent; }).join(" ") };
    });
    var prompt = $("[data-cut-prompt]"), PROMPT = prompt.textContent;
    var title = $("[data-cut-title]"), ph = $("[data-cut-ph]");
    var tc = $("[data-cut-tc]"), rev = $("[data-cut-rev]"), tick = $("[data-cut-tick]");

    function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
    function smooth(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
    /* timeline seconds under the playhead at second t of the loop */
    function head(t) {
      if (t < T.glideFrom) return 0;
      if (t < T.playFrom) return T.park * smooth((t - T.glideFrom) / (T.glideTo - T.glideFrom));
      return T.park + (9.6 - T.park) * clamp01((t - T.playFrom) / (T.playTo - T.playFrom));
    }
    function timecode(s) {
      var f = Math.round(s * FPS), two = function (n) { return (n < 10 ? "0" : "") + n; };
      return "00:00:" + two(Math.floor(f / FPS)) + ":" + two(f % FPS);
    }

    var last = {};
    function put(key, val, fn) { if (last[key] !== val) { last[key] = val; fn(val); } }

    function frame(t) {
      clips.forEach(function (c) {
        put("c" + c.id, t >= c.at, function (on) { c.el.classList.toggle("on", on); });
      });
      var n = 0;
      rows.forEach(function (r, k) {
        var on = t >= r.at;
        if (on) n = k + 1;
        put("r" + k, on, function (v) { r.el.classList.toggle("on", v); });
      });
      put("rev", "rev " + (1 + Math.min(n, rows.length - 1)), function (v) { rev.textContent = v; });
      put("tick", n ? rows[n - 1].text : "", function (v) { tick.textContent = v; });

      var typed = Math.round(PROMPT.length * clamp01((t - T.typeFrom) / (T.typeTo - T.typeFrom)));
      put("prompt", typed, function (c) { prompt.textContent = PROMPT.slice(0, c); });
      put("typing", t >= T.typeFrom - 0.2 && t < T.typeTo + 0.4, function (on) { root.classList.toggle("typing", on); });
      put("noir", t >= T.noir, function (on) { root.classList.toggle("noir", on); });
      put("out", t >= T.out || t < 0.3, function (on) { root.classList.toggle("out", on); });

      var h = head(t);
      put("ph", (h / TL).toFixed(4), function (v) { ph.style.setProperty("--ph", v); });
      put("tc", timecode(h), function (v) { tc.textContent = v; });

      // the monitor: whichever V1 clip is under the playhead; where two
      // overlap, the later one fades in over the first 0.2 s
      var under = [];
      video.forEach(function (c) { if (t >= c.at && h >= c.s && h < c.s + c.d) under.push(c); });
      video.forEach(function (c) {
        var k = under.indexOf(c), o = 0;
        if (k === 0) o = 1;
        else if (k > 0) o = smooth((h - c.s) / 0.2);
        put("p" + c.id, o.toFixed(2), function (v) { plates[c.id].style.opacity = v; });
      });
      var t1 = byId.t1;
      put("title", t >= t1.at && h >= t1.s && h < t1.s + t1.d, function (on) { title.classList.toggle("on", on); });
    }

    root.classList.add("live", "snap");
    frame(0);
    void root.offsetWidth;
    root.classList.remove("snap");

    var t0 = null, prev = 0, raf = 0, running = false, begun = false;
    function step(now) {
      raf = requestAnimationFrame(step);
      // the first pass waits for the hero to rise in; a resume carries on
      if (t0 == null) { t0 = now - prev * 1000 + (begun ? 0 : 1100); begun = true; }
      var t = Math.max(0, (now - t0) / 1000) % LOOP;
      if (t < prev - 0.001) {   // wrapped: reset in one untransitioned frame, while faded out
        root.classList.add("snap");
        frame(t);
        void root.offsetWidth;
        root.classList.remove("snap");
      } else {
        frame(t);
      }
      prev = t;
    }
    function run(on) {
      if (on === running) return;
      running = on;
      if (on) { t0 = null; raf = requestAnimationFrame(step); }
      else cancelAnimationFrame(raf);
    }
    var seen = true;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        seen = entries[0].isIntersecting;
        run(seen && !document.hidden);
      }).observe(root);
    }
    document.addEventListener("visibilitychange", function () { run(seen && !document.hidden); });
    run(!document.hidden);
  })();

  /* ── Docs: the small-screen page menu, and the "On this page" list
     following the reader down the page ── */
  (function () {
    var side = document.querySelector(".docs-side");
    var btn = side && side.querySelector(".docs-menu");
    if (btn) btn.addEventListener("click", function () {
      var open = !side.classList.contains("open");
      side.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });

    // sidebar groups: the current page's opens itself; others stay as the reader left them
    var KEY = "fc-docs-open", saved = [];
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch (e) { }
    [].slice.call(document.querySelectorAll(".docs-sec")).forEach(function (d) {
      if (saved.indexOf(d.getAttribute("data-group")) !== -1) d.open = true;
      d.addEventListener("toggle", function () {
        var open = [].slice.call(document.querySelectorAll(".docs-sec[open]")).map(function (x) { return x.getAttribute("data-group"); });
        try { sessionStorage.setItem(KEY, JSON.stringify(open)); } catch (e) { }
      });
    });

    var links = [].slice.call(document.querySelectorAll(".docs-toc a[href^='#']"));
    if (!links.length || !("IntersectionObserver" in window)) return;
    var byId = {};
    links.forEach(function (a) { byId[decodeURIComponent(a.hash.slice(1))] = a; });
    var heads = [].slice.call(document.querySelectorAll(".prose [id]")).filter(function (h) { return byId[h.id]; });
    var visible = {};
    function mark() {
      // the first heading still on screen, else the last one scrolled past
      var cur = null;
      for (var i = 0; i < heads.length; i++) {
        if (visible[heads[i].id]) { cur = heads[i]; break; }
        if (heads[i].getBoundingClientRect().top < 120) cur = heads[i];
      }
      links.forEach(function (a) { a.classList.toggle("on", !!cur && a === byId[cur.id]); });
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      mark();
    }, { rootMargin: "-80px 0px -55% 0px" });
    heads.forEach(function (h) { io.observe(h); });
  })();

  /* ── Playground ───────────────────────────────────────────────
     The textarea is project.json; the iframe is the real editor reading it.
     The chips play the part of an agent: each one rewrites a few fields,
     the changed lines light up, and the editor re-renders the frame. */
  (function () {
    var frame = document.getElementById("pgFrame");
    var view = document.getElementById("pgView");
    var box = document.getElementById("pgJson");
    var back = document.getElementById("pgBack");
    var status = document.getElementById("pgStatus");
    var resetBtn = document.getElementById("pgReset");
    if (!frame || !box || !back) return;
    var chips = [].slice.call(document.querySelectorAll("[data-edit]"));

    var EDITS = {
      noir: { select: "v1", ops: [["v1", "props.filterPreset", "noir"], ["v2", "props.filterPreset", "noir"], ["v3", "props.filterPreset", "noir"]] },
      headline: { select: "t1", ops: [["t1", "props.text", "CUT BY AN AGENT"]] },
      neon: {
        select: "t1", ops: [
          ["t1", "props.font", "Bebas Neue"], ["t1", "props.fontSize", 150],
          ["t1", "props.glow", 75], ["t1", "props.glowColor", "#22d3ee"],
          ["t1", "props.textAnim", "wave"]
        ]
      },
      caption: {
        select: "t3", add: {
          id: "t3", kind: "text", track: "V3", name: "caption", start: 0.6, duration: 2.6,
          props: {
            text: "an agent wrote this caption", font: "Roboto", weight: 600, fontSize: 52,
            color: "#ffffff", bgColor: "#000000", bgOpacity: 0.55,
            textAnim: "word-slide", wordRate: 0.12, y: 610
          }
        }
      },
      warm: { select: "v1", ops: [["v1", "props.temperature", 60], ["v2", "props.temperature", 60], ["v3", "props.temperature", 60]] }
    };

    var original = box.value;     // replaced by the editor's own copy on fc:ready
    var ready = false, sendTimer = null, fadeTimer = null;

    /* ── highlighting: a <pre> under a transparent textarea ── */
    function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    var TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],:])/g;
    function tokenize(line) {
      var out = "", last = 0, m;
      TOKEN.lastIndex = 0;
      while ((m = TOKEN.exec(line))) {
        out += esc(line.slice(last, m.index));
        if (m[1]) out += '<span class="' + (m[2] ? "tk-k" : "tk-s") + '">' + esc(m[1]) + "</span>" + (m[2] ? '<span class="tk-p">' + esc(m[2]) + "</span>" : "");
        else if (m[3] || m[4]) out += '<span class="tk-n">' + m[0] + "</span>";
        else out += '<span class="tk-p">' + m[0] + "</span>";
        last = m.index + m[0].length;
      }
      return out + esc(line.slice(last));
    }
    function paint(changed) {
      var lines = box.value.split("\n");
      var html = "";
      for (var i = 0; i < lines.length; i++) {
        html += '<span class="ln' + (changed && changed[i] ? " chg" : "") + '">' + tokenize(lines[i]) + "</span>";
      }
      back.innerHTML = html;
      sync();
    }
    function sync() {
      back.style.transform = "translate(" + -box.scrollLeft + "px," + -box.scrollTop + "px)";
    }
    box.addEventListener("scroll", sync, { passive: true });

    /* which lines of b are new relative to a (LCS over lines) */
    function changedLines(a, b) {
      var A = a.split("\n"), B = b.split("\n"), n = A.length, m = B.length;
      var dp = [];
      for (var i = 0; i <= n; i++) { dp.push(new Uint16Array(m + 1)); }
      for (i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
          dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      var mark = {}, first = -1;
      i = 0; j = 0;
      while (j < m) {
        if (i < n && A[i] === B[j]) { i++; j++; }
        else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) { i++; }
        else { mark[j] = true; if (first < 0) first = j; j++; }
      }
      mark.first = first;
      return mark;
    }

    function say(msg, bad) {
      status.textContent = msg || "";
      status.classList.toggle("bad", !!bad);
    }

    /* ── the bridge to the editor (same shape as an agent's write) ── */
    function send() {
      if (!ready || !frame.contentWindow) return;
      var d;
      try { d = JSON.parse(box.value); }
      catch (err) { say(String(err.message || err).replace(/^JSON\.parse:\s*/, ""), true); return; }
      // a current-schema document, so the editor applies it as-is instead of
      // migrating it and saving a normalised copy straight back
      if (d && typeof d === "object" && !("panSchema" in d)) d.panSchema = 1;
      frame.contentWindow.postMessage({ type: "fc:set", json: JSON.stringify(d) }, "*");
    }

    /* The editor saves every prop, defaults included. Trim its copy back to
       what the visitor's document actually says, so an inspector tweak shows
       up as the one line it changed. */
    var defaults = {};
    var SCHEMA_KEYS = ["panSchema", "folders", "tracks", "disabledTracks", "lockedTracks", "untargetedTracks"];
    function compact(text, refText) {
      var d, r;
      try { d = JSON.parse(text); } catch (e) { return text; }
      try { r = JSON.parse(refText); } catch (e) { r = {}; }
      SCHEMA_KEYS.forEach(function (k) { if (!(k in r)) delete d[k]; });
      if ("revision" in r) d.revision = r.revision;
      (d.clips || []).forEach(function (c) {
        var rc = clip(r, c.id) || {}, rp = rc.props || {};
        Object.keys(c.props || {}).forEach(function (k) {
          if (k in rp || !(k in defaults)) return;
          if (JSON.stringify(defaults[k]) === JSON.stringify(c.props[k])) delete c.props[k];
        });
        ["keyframes", "transitionIn", "transitionOut", "linkGroup", "linkedId"].forEach(function (k) {
          if (c[k] == null && !(k in rc)) delete c[k];
        });
      });
      return JSON.stringify(orderLike(d, r), null, 2);
    }
    /* keep keys in the order the visitor's document already has them */
    function orderLike(v, ref) {
      if (Array.isArray(v)) {
        return v.map(function (x, i) {
          var rx;
          if (Array.isArray(ref)) {
            rx = x && x.id != null ? ref.filter(function (y) { return y && y.id === x.id; })[0] : ref[i];
          }
          return orderLike(x, rx);
        });
      }
      if (!v || typeof v !== "object") return v;
      var out = {}, r = ref && typeof ref === "object" && !Array.isArray(ref) ? ref : {};
      Object.keys(r).forEach(function (k) { if (k in v) out[k] = orderLike(v[k], r[k]); });
      Object.keys(v).forEach(function (k) { if (!(k in out)) out[k] = orderLike(v[k]); });
      return out;
    }
    function select(id) {
      if (frame.contentWindow) frame.contentWindow.postMessage({ type: "fc:select", id: id }, "*");
    }

    function write(text, from) {
      var mark = changedLines(from, text);
      box.value = text;
      paint(mark);
      if (mark.first >= 0) {
        var lh = 20, top = Math.max(0, (mark.first - 3) * lh);
        var visible = mark.first * lh >= box.scrollTop && (mark.first + 2) * lh <= box.scrollTop + box.clientHeight;
        if (!visible) box.scrollTo({ top: top, behavior: reduced ? "auto" : "smooth" });
      }
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () {
        back.querySelectorAll(".ln.chg").forEach(function (el) { el.classList.remove("chg"); });
      }, 2600);
    }

    /* ── chips ── */
    function getPath(o, path) {
      return path.split(".").reduce(function (x, k) { return x == null ? undefined : x[k]; }, o);
    }
    function setPath(o, path, v) {
      var keys = path.split("."), last = keys.pop();
      keys.forEach(function (k) { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; });
      if (v === undefined) delete o[last]; else o[last] = v;
    }
    function clip(d, id) { return (d.clips || []).filter(function (c) { return c.id === id; })[0]; }
    function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

    function toggle(key, chip) {
      var edit = EDITS[key], d, base;
      try { d = JSON.parse(box.value); } catch (e) { say("Fix the JSON first, then try an edit.", true); return; }
      try { base = JSON.parse(original); } catch (e) { base = {}; }
      var on = chip.getAttribute("aria-pressed") !== "true";
      if (edit.ops) {
        edit.ops.forEach(function (op) {
          var c = clip(d, op[0]);
          if (!c) return;
          setPath(c, op[1], on ? clone(op[2]) : clone(getPath(clip(base, op[0]) || {}, op[1])));
        });
      }
      if (edit.add) {
        d.clips = (d.clips || []).filter(function (c) { return c.id !== edit.add.id; });
        if (on) d.clips.push(clone(edit.add));
      }
      chip.setAttribute("aria-pressed", String(on));
      var before = box.value;
      write(JSON.stringify(d, null, 2), before);
      say("");
      clearTimeout(sendTimer);
      send();
      setTimeout(function () { select(on ? edit.select : (edit.add ? "t1" : edit.select)); }, 380);
    }
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () { toggle(chip.getAttribute("data-edit"), chip); });
    });

    if (resetBtn) resetBtn.addEventListener("click", function () {
      var before = box.value;
      chips.forEach(function (c) { c.setAttribute("aria-pressed", "false"); });
      write(original, before);
      say("");
      send();
    });

    /* ── typing into the file ── */
    var raf = 0;
    box.addEventListener("input", function () {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { paint(null); });
      clearTimeout(sendTimer);
      sendTimer = setTimeout(send, 160);
    });
    box.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); clearTimeout(sendTimer); send(); return; }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        var s = box.selectionStart, t = box.selectionEnd;
        box.value = box.value.slice(0, s) + "  " + box.value.slice(t);
        box.selectionStart = box.selectionEnd = s + 2;
        box.dispatchEvent(new Event("input"));
      }
    });

    window.addEventListener("message", function (e) {
      if (e.source !== frame.contentWindow) return;
      var d = e.data;
      if (!d || typeof d.type !== "string") return;
      if (d.type === "fc:ready") {
        ready = true;
        original = d.json;
        try { defaults = JSON.parse(frame.contentWindow.eval("JSON.stringify(DEFAULT_PROPS)")) || {}; } catch (err) { defaults = {}; }
        if (box.value !== d.json && document.activeElement !== box) { box.value = d.json; paint(null); }
        view.classList.add("ready");
        chips.forEach(function (c) { c.disabled = false; });
        if (resetBtn) resetBtn.disabled = false;
      } else if (d.type === "fc:project") {
        // the editor itself changed the project (inspector, drag)
        if (document.activeElement !== box) {
          var next = compact(d.json, box.value);
          if (next !== box.value) write(next, box.value);
        }
      } else if (d.type === "fc:ok") {
        say("");
      } else if (d.type === "fc:error") {
        say(d.message || "That does not parse yet.", true);
      }
    });

    /* load the editor only once it is about to be seen */
    function boot() { if (!frame.getAttribute("src")) frame.src = frame.getAttribute("data-src"); }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { boot(); io.disconnect(); }
      }, { rootMargin: "600px 0px" });
      io.observe(view);
    } else { boot(); }

    paint(null);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync);
  })();
})();
