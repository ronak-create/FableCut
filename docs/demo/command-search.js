/* FableCut command search (Ctrl/Cmd+K) — how typed words find editor actions,
   panels, settings, Inspector sections, media, clips and shortcuts. Zero
   dependencies. Loaded by the editor as a plain script (global
   `FableCutSearch`) and required by the tests; the editor builds the items
   (app.js) and runs the one that is picked.

     rank(query, items, limit?) → items that match, best first
       item: {label, group?, keywords?, ...anything}
     score(query, item)        → a number, 0 = no match

   Every typed word has to be found in the item's label, group or keywords:
   at the start of a word (best), inside a word, or as letters in order
   from the start of a word in the label ("rpdl" finds "Ripple delete",
   weakest). Case, accents and punctuation don't matter; letters of any script
   count ("猫" finds "猫.mp4"). A query of symbols only (";") matches items
   whose `keys` hold it. An empty query matches everything, in the order given. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FableCutSearch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const fold = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFD")
    // accents on Latin, Greek and Cyrillic letters go (Café = cafe); other scripts' marks are
    // part of the letter (दिन is not दीन), so they stay
    .replace(/(\p{Script=Latin}|\p{Script=Greek}|\p{Script=Cyrillic})\p{M}+/gu, "$1")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
  const words = (s) => fold(s).split(" ").filter(Boolean);

  /** How well one typed word matches a text (folded, its words given): 0 when it doesn't.
      Letters in order count only when asked (the label), starting at one of its words. */
  function wordScore(w, text, parts, loose) {
    if (parts.some((p) => p === w)) return 10;
    if (parts.some((p) => p.startsWith(w))) return 8;
    if (text.includes(w)) return 5;
    if (!loose || w.length < 2) return 0;
    for (let s = 0; s < text.length; s++) {
      if (text[s] !== w[0] || (s && text[s - 1] !== " ")) continue;
      let i = 1;
      for (let k = s + 1; k < text.length && i < w.length; k++) if (text[k] === w[i]) i++;
      if (i === w.length) return 2;
    }
    return 0;
  }
  /** A query with no letters or digits: the items whose `keys` hold exactly that. */
  const symbolOnly = (query) => !words(query).length && String(query || "").trim() !== "";
  const symbolScore = (query, item) => {
    const q = String(query).trim();
    // "+ / -" holds "+"; "Shift+;" holds ";"
    return (item.keys || []).some((k) => String(k).trim() === q || String(k).split(/[\s/,·]+/).includes(q) || String(k).split(/[\s/,+·]+/).includes(q)) ? 10 : 0;
  };
  function score(query, item) {
    if (symbolOnly(query)) return symbolScore(query, item);
    const q = words(query);
    if (!q.length) return 1;
    const label = fold(item.label), lp = label.split(" ");
    const extra = fold([item.group, ...(item.keywords || [])].join(" ")), ep = extra.split(" ").filter(Boolean);
    let total = 0;
    for (const w of q) {
      const inLabel = wordScore(w, label, lp, true);
      const inExtra = wordScore(w, extra, ep, false) * 0.6;   // the label counts for more than group and keywords
      const s = Math.max(inLabel, inExtra);
      if (!s) return 0;
      total += s;
    }
    if (label.startsWith(q.join(" "))) total += 6;      // the label begins with what was typed
    return total - Math.min(label.length, 60) / 100;    // a shorter label wins a tie
  }
  function rank(query, items, limit = 50) {
    if (!words(query).length && !symbolOnly(query)) return items.slice(0, limit);
    return items.map((it, i) => ({ it, i, s: score(query, it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.it);
  }
  return { rank, score, fold };
});
