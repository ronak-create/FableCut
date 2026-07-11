/* FableCut landing - progressive enhancement only. The page is fully
   readable with JS disabled; this adds nav state, reveals, copy buttons
   and a live latest-release badge. */
(function () {
  "use strict";

  /* Nav: solid border once scrolled, mobile menu toggle */
  var nav = document.getElementById("nav");
  var toggle = document.getElementById("navToggle");
  var links = document.querySelector(".nav-links");

  /* Toggle the nav border via a 1px sentinel + IntersectionObserver
     instead of a scroll handler. */
  if ("IntersectionObserver" in window) {
    var sentinel = document.createElement("div");
    sentinel.style.cssText = "position:absolute;top:0;left:0;height:1px;width:1px;pointer-events:none;";
    document.body.prepend(sentinel);
    new IntersectionObserver(function (entries) {
      nav.classList.toggle("scrolled", !entries[0].isIntersecting);
    }, { threshold: 0 }).observe(sentinel);
  }

  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* Scroll reveal via IntersectionObserver (no scroll handler) */
  var reveals = document.querySelectorAll(".reveal");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.14, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* Copy buttons */
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var el = document.getElementById(btn.getAttribute("data-target"));
      if (!el) return;
      var done = function () {
        var prev = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("done");
        setTimeout(function () { btn.textContent = prev; btn.classList.remove("done"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.innerText).then(done).catch(function () {});
      }
    });
  });

  /* Live latest-release badge from the public GitHub API */
  var tagEl = document.getElementById("relTag");
  var metaEl = document.getElementById("relMeta");
  var linkEl = document.getElementById("relLink");
  if (tagEl && metaEl) {
    fetch("https://api.github.com/repos/ronak-create/FableCut/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (rel) {
        var tag = rel.tag_name || "";
        var name = rel.name && rel.name !== tag ? rel.name : "";
        tagEl.textContent = tag ? "Latest release " + tag : "Latest release";
        var when = rel.published_at
          ? new Date(rel.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
          : "";
        metaEl.textContent = [name, when ? "Published " + when : ""].filter(Boolean).join(" . ")
          || "See the changelog for what shipped.";
        if (linkEl && rel.html_url) linkEl.href = rel.html_url;
      })
      .catch(function () {
        tagEl.textContent = "Latest release";
        metaEl.textContent = "See the releases page for the newest version.";
      });
  }

  /* ── Pointer-driven effects (spotlight, hero tilt, card spotlight) ──
     All coalesced into one rAF and skipped entirely under reduced motion
     or on touch/coarse pointers. */
  var coarse = window.matchMedia("(pointer: coarse)").matches;
  if (!reduce && !coarse) {
    var root = document.documentElement;
    var spot = document.getElementById("fxSpot");
    var shot = document.querySelector(".hero-shot");
    var win = shot ? shot.querySelector(".window") : null;
    var cells = document.querySelectorAll(".cell");
    var px = 0, py = 0, queued = false;

    var apply = function () {
      queued = false;
      if (spot) { spot.style.setProperty("--mx", px + "px"); spot.style.setProperty("--my", py + "px"); }
      if (win) {
        var r = shot.getBoundingClientRect();
        if (r.bottom > 0 && r.top < window.innerHeight) {
          var cx = (px - (r.left + r.width / 2)) / r.width;
          var cy = (py - (r.top + r.height / 2)) / r.height;
          win.style.setProperty("--ty", (cx * 5).toFixed(2) + "deg");
          win.style.setProperty("--tx", (-cy * 4).toFixed(2) + "deg");
        }
      }
    };
    window.addEventListener("pointermove", function (e) {
      px = e.clientX; py = e.clientY;
      if (!queued) { queued = true; requestAnimationFrame(apply); }
    }, { passive: true });

    /* per-card spotlight border follows the cursor within each cell */
    cells.forEach(function (cell) {
      cell.addEventListener("pointermove", function (e) {
        var r = cell.getBoundingClientRect();
        cell.style.setProperty("--cx", (e.clientX - r.left) + "px");
        cell.style.setProperty("--cy", (e.clientY - r.top) + "px");
      });
    });

    /* magnetic pull on the primary CTAs */
    document.querySelectorAll(".btn-primary").forEach(function (btn) {
      btn.addEventListener("pointermove", function (e) {
        var r = btn.getBoundingClientRect();
        var mx = (e.clientX - (r.left + r.width / 2)) / r.width;
        var my = (e.clientY - (r.top + r.height / 2)) / r.height;
        btn.style.transform = "translate(" + (mx * 6).toFixed(1) + "px," + (my * 6).toFixed(1) + "px)";
      });
      btn.addEventListener("pointerleave", function () { btn.style.transform = ""; });
    });
  }
})();
