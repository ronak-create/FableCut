/* Build the /docs/ pages of fablecut.space from CLAUDE.md.
   Run:  node docs/docs/build.js   (again whenever CLAUDE.md changes)

   CLAUDE.md is the manual an agent reads through fablecut_docs, so these
   pages show exactly what the agent knows, with nothing to keep in sync by
   hand. Zero dependencies, like the rest of the repo: a small Markdown
   renderer covering what the manual uses (headings, paragraphs, nested lists,
   pipe tables, fenced code, bold / italic / code / links). */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = __dirname;
const SITE = "https://fablecut.space";
const REPO = "https://github.com/ronak-create/FableCut";
const MANUAL = REPO + "/blob/main/CLAUDE.md";
const RAW = "https://raw.githubusercontent.com/ronak-create/FableCut/main/CLAUDE.md";
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const SRC = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8").replace(/\r\n/g, "\n");

/* ── The pages. `parts` pick what goes on each: [section] is that `## `
   section's text before its first `### `, [section, sub] one `### `, and
   [section, "*"] all of it. Names match the start of the heading. ── */
const PAGES = [
  {
    slug: "", nav: "Overview", title: "FableCut docs", group: "Start",
    lede: "The manual for FableCut, built from `CLAUDE.md` in the repo: the same text your agent reads through the `fablecut_docs` tool, so what you read here is what it knows.",
    parts: [["Run"], ["How Claude Code edits a video"]],
  },
  {
    slug: "mcp", nav: "MCP tools", title: "MCP tools", group: "Start",
    lede: "Connect an agent, and the calls it uses to read and change your timeline without burning tokens.",
    parts: [["MCP connection", "*"]],
  },
  {
    slug: "project-json", nav: "project.json", title: "project.json", group: "The timeline",
    lede: "The whole edit in one file: canvas, markers, tracks, media and clips.",
    parts: [["project.json schema"]],
  },
  {
    slug: "props", nav: "Clip props", title: "Clip props", group: "The timeline",
    lede: "Every property a clip can carry and its default. A key a clip leaves out falls back to these.",
    parts: [["project.json schema", "props reference"]], promote: true,
  },
  {
    slug: "audio", nav: "Audio mix", title: "Audio mix", group: "The timeline",
    lede: "How clips reach the speakers and the export: clip gain, channels, track faders, the master, and loudness normalize.",
    parts: [["project.json schema", "Audio mix"]],
  },
  {
    slug: "color", nav: "Color", title: "Color", group: "The timeline",
    lede: "Grade a clip with wheels, exposure, white balance and tone, and check it with scopes: in the Color workspace, or from an agent with setGrade and fablecut_scopes.",
    parts: [["project.json schema", "Color"]],
  },
  {
    slug: "masks", nav: "Masks", title: "Masks", group: "The timeline",
    lede: "Cut what a clip shows with rectangles, ellipses, bezier and free-hand shapes: feathered, expanded, inverted, combined and keyframed, from the monitor or from an agent with setMask.",
    parts: [["project.json schema", "Masks"]],
  },
  {
    slug: "compositing", nav: "Track mattes and blending", title: "Track mattes and blending", group: "The timeline",
    lede: "Cut a clip with the picture on another track by its alpha or its brightness, and lay clips over each other with blend modes, from the Inspector or from an agent with setMatte.",
    parts: [["project.json schema", "Track mattes and blending"]],
  },
  {
    slug: "tracking", nav: "Tracking", title: "Motion tracking", group: "The timeline",
    lede: "Follow a point or a region through a video clip, then make a mask follow it or pin a title, sticker or another clip to it, from the Inspector or from an agent with fablecut_track.",
    parts: [["project.json schema", "Tracking"]],
  },
  {
    slug: "editing", nav: "Editing rules", title: "Editing rules", group: "The timeline",
    lede: "How tracks, links, locks, targeting and the trim tools behave, for people and agents alike.",
    parts: [["project.json schema", "Semantics"]],
  },
  {
    slug: "library", nav: "Asset library", title: "Asset library", group: "The timeline",
    lede: "Sound effects, overlays, fonts and animated SVGs that ship with the editor, and how to make your own.",
    parts: [["The asset library", "*"], ["Authoring animated SVGs", "*"]],
  },
  {
    slug: "recipes", nav: "Recipes", title: "Recipes", group: "Guides",
    lede: "Short answers for common edits: grades, captions, speed ramps, transitions and more, each one a few props away.",
    parts: [["Recipes", "*"]], promote: 3,
  },
  {
    slug: "remake", nav: "Remake a reference", title: "Remake a reference video", group: "Guides",
    lede: "Turn a video you like into a blueprint of shots, beats and energy, then rebuild it with your own footage.",
    parts: [["Remake a reference video", "*"]],
  },
  {
    slug: "rest-api", nav: "REST API", title: "REST API", group: "Reference",
    lede: "The HTTP endpoints behind the editor, for scripts and tools that don't speak MCP.",
    parts: [["REST API", "*"]],
  },
  {
    slug: "export", nav: "Export", title: "Export", group: "Reference",
    lede: "The three export engines, which range gets exported, and the ffmpeg encoding profiles.",
    parts: [["Export", "*"]],
  },
];

/* ── Split the manual into `## ` sections and their `### ` subsections ── */
function parseManual(src) {
  const sections = [];
  let cur = null, sub = null, fence = false;
  src.split("\n").forEach((ln, i) => {
    if (/^\s*```/.test(ln)) fence = !fence;
    if (!fence && /^## /.test(ln)) {
      cur = { title: ln.slice(3).trim(), line: i + 1, intro: [], subs: [] };
      sections.push(cur);
      sub = null;
      return;
    }
    if (!fence && cur && /^### /.test(ln)) {
      sub = { title: ln.slice(4).trim(), line: i + 1, lines: [] };
      cur.subs.push(sub);
      return;
    }
    if (sub) sub.lines.push(ln);
    else if (cur) cur.intro.push(ln);
  });
  return sections;
}

/* ── Inline Markdown ── */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => esc(s).replace(/"/g, "&quot;");
const plain = (s) => s.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
/* The site's copy doesn't use em dashes; the manual does. */
const undash = (s) => s.replace(/ — /g, " - ").replace(/—/g, "-");
function slugify(s) {
  return plain(s).toLowerCase().replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
}

let sectionLinks = []; // [quoted name, href] filled once the pages are known

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = undash(esc(s));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${attr(u)}">${t}</a>`);
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  // "Recipes", "Remake a reference video"... become links to their page
  for (const [name, href] of sectionLinks) {
    s = s.split(`"${name}"`).join(`<a href="${href}">${name}</a>`);
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code class="ic">${esc(codes[+n])}</code>`);
}

/* ── Code blocks: the same quiet monochrome tokens as the playground ── */
function highlight(code, lang) {
  if (/^(jsonc?|js)$/.test(lang)) {
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(\/\/.*$|\/\*.*?\*\/)|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b/gm;
    return tokens(code, re, (m) =>
      m[1] ? `<span class="${m[2] ? "tk-k" : "tk-s"}">${esc(m[1])}</span>${m[2] ? esc(m[2]) : ""}`
        : m[3] ? `<span class="tk-c">${esc(m[3])}</span>`
          : `<span class="tk-n">${esc(m[0])}</span>`);
  }
  if (/^(svg|xml|html)$/.test(lang)) {
    const re = /(<\/?[\w:-]+)|([\w:-]+)(=)|("[^"]*")|(\/?>)/g;
    return tokens(code, re, (m) =>
      m[1] ? `<span class="tk-k">${esc(m[1])}</span>`
        : m[2] ? `<span class="tk-p">${esc(m[2])}</span>=`
          : m[4] ? `<span class="tk-s">${esc(m[4])}</span>`
            : `<span class="tk-k">${esc(m[5])}</span>`);
  }
  return tokens(code, /(#.*$)/gm, (m) => `<span class="tk-c">${esc(m[1])}</span>`);
}
function tokens(code, re, wrap) {
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index)) + wrap(m);
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}
const ICON_COPY = '<svg class="i i-cp" aria-hidden="true"><use href="#i-copy"/></svg><svg class="i i-ok" aria-hidden="true"><use href="#i-check"/></svg>';
function codeBlock(code, lang) {
  return `<div class="code code-card"><pre><code>${highlight(code, lang)}</code></pre>` +
    `<button class="copy" type="button" aria-label="Copy this example">${ICON_COPY}</button></div>`;
}

/* ── Block Markdown ── */
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const FENCE = /^\s*```(\w*)\s*$/;
const isTable = (a, b) => /^\s*\|/.test(a) && b != null && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(b) && b.includes("-");

function splitRow(row) {
  const s = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "", code = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function listHtml(items) {
  let html = "";
  const stack = [];
  for (const it of items) {
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? "ol" : "ul";
      html += `<${tag}${it.ordered && it.num !== 1 ? ` start="${it.num}"` : ""}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
      html += "</li>";
    }
    html += "<li>" + inline(it.text.join(" "));
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/* Blocks → HTML. `ctx.level` is the heading level this content starts at;
   `ctx.promote` turns a "**Name** (note): text" paragraph into a heading,
   which gives the props and recipes pages a real table of contents. */
function render(lines, ctx) {
  let html = "", i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    let m = FENCE.exec(ln);
    if (m) {
      const body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      html += codeBlock(body.join("\n"), m[1]);
      continue;
    }
    m = /^(#{3,6})\s+(.*)$/.exec(ln);
    if (m) { html += heading(ctx.level + m[1].length - 3, m[2], ctx); i++; continue; }
    if (isTable(ln, lines[i + 1])) {
      const head = splitRow(ln);
      let body = "";
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        body += "<tr>" + splitRow(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      }
      html += `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }
    if (LIST.test(ln)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && LIST.test(lines[j])) { i = j; continue; }
          break;
        }
        if (FENCE.test(l)) break;
        const lm = LIST.exec(l);
        if (lm) items.push({ indent: lm[1].length, ordered: /\d/.test(lm[2]), num: parseInt(lm[2], 10) || 1, text: [lm[3]] });
        else items[items.length - 1].text.push(l.trim());
        i++;
      }
      html += listHtml(items);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !LIST.test(lines[i]) &&
      !/^#{3,6}\s/.test(lines[i]) && !isTable(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    const text = para.join(" ");
    const p = ctx.promote && (
      /^\*\*([^*]{1,60}?)\*\*(\s*\(([^)]*)\))?:\s*([\s\S]*)$/.exec(text) ||
      /^\*\*([^*]{1,60}?):\*\*()()\s*([\s\S]*)$/.exec(text) ||
      /^\*\*([^*]{1,46}?)\.\*\*()()\s+([\s\S]*)$/.exec(text));
    if (p) {
      html += heading(typeof ctx.promote === "number" ? ctx.promote : ctx.level, p[1], ctx, p[3]);
      const rest = p[4].trim();
      if (rest) html += `<p>${inline(rest.charAt(0).toUpperCase() + rest.slice(1))}</p>`;
    } else {
      html += `<p>${inline(text)}</p>`;
    }
  }
  return html;
}

function heading(level, text, ctx, note) {
  const title = text.replace(/\s*\(([^)]*)\)\s*$/, (m0, n) => { note = note || n; return ""; });
  let id = slugify(title), n = 2;
  while (ctx.ids.has(id)) id = slugify(title) + "-" + n++;
  ctx.ids.add(id);
  if (level <= 3) ctx.toc.push({ level, id, text: undash(plain(title)) });
  const h = Math.min(6, level);
  return `<h${h} id="${id}">${inline(title)}${note ? ` <span class="h-note">${inline(note)}</span>` : ""}` +
    `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${h}>`;
}

/* ── Assemble each page from its parts ── */
const sections = parseManual(SRC);
const find = (name) => {
  const s = sections.find((x) => x.title.startsWith(name));
  if (!s) throw new Error(`CLAUDE.md has no "## ${name}" section - update PAGES in docs/docs/build.js`);
  return s;
};
const findSub = (s, name) => {
  const sub = s.subs.find((x) => x.title.startsWith(name));
  if (!sub) throw new Error(`"## ${s.title}" has no "### ${name}" - update PAGES in docs/docs/build.js`);
  return sub;
};
const shortTitle = (t) => undash(plain(t)).replace(/\s+-\s.*$/, "").replace(/\s*\([^)]*\)\s*$/, "");

// every part of the manual has to land on some page
const used = new Set();
for (const pg of PAGES) {
  for (const [name, which] of pg.parts) {
    const s = find(name);
    if (!which) used.add(s.title);
    else if (which === "*") { used.add(s.title); s.subs.forEach((x) => used.add(s.title + " > " + x.title)); }
    else used.add(s.title + " > " + findSub(s, which).title);
  }
}
for (const s of sections) {
  if (!used.has(s.title)) {
    console.warn(`! "## ${s.title}" is not on any page yet; it gets a page of its own`);
    PAGES.push({ slug: slugify(shortTitle(s.title)), nav: shortTitle(s.title), title: shortTitle(s.title), group: "More", lede: "", parts: [[s.title, "*"]] });
  }
  for (const x of s.subs) {
    if (!used.has(s.title) && !used.has(s.title + " > " + x.title)) continue;
    if (!used.has(s.title + " > " + x.title) && !PAGES.some((p) => p.parts.some(([n, w]) => s.title.startsWith(n) && w === "*"))) {
      console.warn(`! "### ${x.title}" (in "## ${s.title}") is not on any page`);
    }
  }
}

const href = (from, to) => {
  const up = from.slug ? "../" : "./";
  return to.slug ? up + to.slug + "/" : up;
};
// quoted section names in the text link to the page that holds them
function linksFor(pg) {
  const out = [];
  for (const other of PAGES) {
    for (const [name, which] of other.parts) {
      const s = find(name);
      const titles = which && which !== "*" ? [findSub(s, which).title] : [s.title].concat(which === "*" ? s.subs.map((x) => x.title) : []);
      for (const t of titles) {
        const short = shortTitle(t);
        if (short.length > 3 && other !== pg) out.push([short, href(pg, other)]);
      }
    }
  }
  return out;
}

function pageBody(pg, ctx) {
  // a one-part page lets its title stand in for the section heading
  const multi = pg.parts.length > 1;
  let html = "";
  for (const [name, which] of pg.parts) {
    const s = find(name);
    ctx.lines.push(s.line);
    if (which && which !== "*") {
      const x = findSub(s, which);
      if (multi) html += heading(2, x.title, ctx);
      html += render(x.lines, { ...ctx, level: multi ? 3 : 2 });
      continue;
    }
    if (multi) html += heading(2, shortTitle(s.title), ctx);
    html += render(s.intro, { ...ctx, level: multi ? 3 : 2 });
    if (which === "*") for (const x of s.subs) {
      html += heading(multi ? 3 : 2, x.title, ctx);
      html += render(x.lines, { ...ctx, level: multi ? 4 : 3 });
    }
  }
  return html;
}

/* ── Page shell: the site's nav, footer and icons ── */
// the icon sprite comes from the home page, so the two can't drift apart
const ICONS = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8")
  .match(/<svg width="0" height="0"[\s\S]*?<\/svg>/)[0];

function shell(pg, main, desc) {
  const base = pg.slug ? "../../" : "../";
  const docsHome = pg.slug ? "../" : "./";
  const url = SITE + "/docs/" + (pg.slug ? pg.slug + "/" : "");
  const title = pg.slug ? `${pg.title} - FableCut docs` : "FableCut docs";
  const crumbs = [{ name: "Docs", item: SITE + "/docs/" }].concat(pg.slug ? [{ name: pg.title, item: url }] : []);
  const ld = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, k) => ({ "@type": "ListItem", position: k + 1, name: c.name, item: c.item })),
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(desc)}">
<link rel="icon" type="image/svg+xml" href="${base}favicon.svg">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0a0a0b" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="FableCut">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:image" content="${SITE}/screenshot.png">
<meta property="og:image:width" content="1600">
<meta property="og:image:height" content="900">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/screenshot.png">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script>document.documentElement.classList.add("js");try{var t=localStorage.getItem("fc-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
<link rel="preload" href="${base}fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${base}styles.css?v=32">
</head>
<body class="docs-page">
<!-- Generated by docs/docs/build.js from CLAUDE.md. Edit CLAUDE.md, then rebuild. -->
${ICONS}

<a class="skip" href="#main">Skip to content</a>

<header class="nav" id="nav">
  <div class="wrap nav-inner">
    <a class="brand" href="${base}" aria-label="FableCut home"><svg aria-hidden="true"><use href="#i-logo"/></svg><span>FableCut</span></a>
    <nav class="nav-links" id="navLinks" aria-label="Primary">
      <a href="${base}#playground">Playground</a>
      <a href="${base}start/">Get started</a>
      <a href="${base}community/">Community</a>
      <a href="${docsHome}" aria-current="page">Docs</a>
    </nav>
    <div class="nav-end">
      <a class="gh" href="${REPO}" rel="noopener" target="_blank" aria-label="FableCut on GitHub">
        <svg class="i" aria-hidden="true"><use href="#i-gh"/></svg><span class="gh-label">GitHub</span><span class="gh-count" data-stars></span>
      </a>
      <button class="menu-btn" id="menuBtn" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navLinks"><svg class="i" aria-hidden="true"><use href="#i-menu"/></svg></button>
    </div>
  </div>
</header>

${main}

<footer class="footer">
  <div class="wrap">
    <div class="foot">
      <a class="brand" href="${base}" aria-label="FableCut home"><svg aria-hidden="true"><use href="#i-logo"/></svg><span>FableCut</span></a>
      <nav class="foot-links" aria-label="Footer">
        <a href="${REPO}" rel="noopener" target="_blank">GitHub</a>
        <a href="${docsHome}">Docs</a>
        <a href="https://discord.gg/EFMQH7d6Tv" rel="noopener" target="_blank">Discord</a>
        <a href="${REPO}/releases" rel="noopener" target="_blank">Releases</a>
        <a href="${REPO}/blob/main/SECURITY.md" rel="noopener" target="_blank">Security</a>
        <a href="${REPO}/blob/main/LICENSE" rel="noopener" target="_blank">MIT License</a>
      </nav>
      <div class="foot-end">
        <button class="theme-btn" type="button" data-theme-toggle aria-label="Switch color theme"><svg class="i i-sun" aria-hidden="true"><use href="#i-sun"/></svg><svg class="i i-moon" aria-hidden="true"><use href="#i-moon"/></svg></button>
      </div>
    </div>
    <p class="fine">Built in the browser. Drivable by any agent that speaks JSON.</p>
  </div>
</footer>

<script src="${base}main.js?v=22"></script>
</body>
</html>
`;
}

function build() {
  const groups = [...new Set(PAGES.map((p) => p.group))];
  let written = 0;
  PAGES.forEach((pg, idx) => {
    sectionLinks = linksFor(pg);
    const ctx = { ids: new Set(), toc: [], lines: [], level: 2, promote: pg.promote || false };
    let body = pageBody(pg, ctx);
    if (!pg.slug) {
      body = `<div class="docs-cards">${PAGES.filter((p) => p.slug).map((p) =>
        `<a class="docs-card" href="${href(pg, p)}"><b>${esc(p.nav)}</b><span>${inline(p.lede)}</span></a>`).join("")}</div>` + body;
    }

    const side = groups.map((g) => `<p class="docs-group">${esc(g)}</p>` + PAGES.filter((p) => p.group === g).map((p) =>
      `<a href="${href(pg, p)}"${p === pg ? ' aria-current="page"' : ""}>${esc(p.nav)}</a>`).join("")).join("");
    const toc = ctx.toc.filter((t) => t.level <= 3);
    const top = Math.min(...toc.map((t) => t.level));
    const prev = PAGES[idx - 1], next = PAGES[idx + 1];
    const pn = (p, dir) => p ? `<a class="docs-pn-${dir}" href="${href(pg, p)}"><span>${dir === "prev" ? "Previous" : "Next"}</span><b>${esc(p.nav)}</b></a>` : "<span></span>";

    const main = `<div class="wrap docs" id="main">
  <nav class="docs-side" aria-label="Docs">
    <button class="docs-menu" type="button" aria-expanded="false" aria-controls="docsNav"><svg class="i" aria-hidden="true"><use href="#i-menu"/></svg><span>${esc(pg.nav)}</span></button>
    <div class="docs-nav" id="docsNav">${side}</div>
  </nav>
  <article class="docs-main prose">
    <h1>${esc(pg.title)}</h1>
    ${pg.lede ? `<p class="docs-lede">${inline(pg.lede)}</p>` : ""}
    ${body}
    <div class="docs-end">
      <a class="more" href="${MANUAL}#L${ctx.lines[0]}" rel="noopener" target="_blank">Edit this in CLAUDE.md <svg class="i i-ne" aria-hidden="true"><use href="#i-ne"/></svg></a>
      <a class="more" href="${RAW}" rel="noopener" target="_blank">The whole manual as Markdown <svg class="i i-ne" aria-hidden="true"><use href="#i-ne"/></svg></a>
    </div>
    <nav class="docs-pn" aria-label="Previous and next page">${pn(prev, "prev")}${pn(next, "next")}</nav>
  </article>
  ${toc.length > 1 ? `<aside class="docs-toc" aria-label="On this page"><p>On this page</p>${toc.map((t) =>
      `<a href="#${t.id}"${t.level > top ? ' class="sub"' : ""}>${esc(t.text)}</a>`).join("")}</aside>` : "<aside class=\"docs-toc\"></aside>"}
</div>`;

    const dir = path.join(OUT, pg.slug);
    fs.mkdirSync(dir, { recursive: true });
    const desc = plain(pg.lede) || `${pg.title}, from the FableCut manual.`;
    fs.writeFileSync(path.join(dir, "index.html"), shell(pg, main, `${desc} FableCut v${VERSION}.`));
    written++;
  });
  return written;
}

const n = build();
console.log(`docs: ${n} pages from CLAUDE.md (FableCut v${VERSION}) in ${path.relative(ROOT, OUT) || "."}/`);
module.exports = { PAGES };
