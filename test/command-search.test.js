/* Command search ranking (command-search.js): how typed words find editor
   actions, panels, settings, media and shortcuts. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../command-search");

const items = [
  { label: "Split", group: "Action" },
  { label: "Ripple delete", group: "Action" },
  { label: "Delete", group: "Action" },
  { label: "Mixer", group: "Panel", keywords: ["tab", "show"] },
  { label: "Link timeline and Project bin selection", group: "Setting", keywords: ["settings"] },
  { label: "Café opening.mp4", group: "Media", keywords: ["video"] },
  { label: "Play / pause", group: "Shortcut", keywords: ["Playback", "Space"] },
];
const labels = (q) => S.rank(q, items).map((i) => i.label);

test("every word has to match; word starts beat insides, insides beat letters in order", () => {
  assert.deepEqual(labels("rip del"), ["Ripple delete"]);
  assert.equal(labels("delete")[0], "Delete", "an exact word in a short label first");
  assert.ok(labels("delete").includes("Ripple delete"));
  assert.deepEqual(labels("rpdl"), ["Ripple delete"], "letters in order");
  assert.deepEqual(labels("split nothing"), [], "one word that matches nothing drops the item");
});

test("case, accents and punctuation don't matter; groups and keywords count less than the label", () => {
  assert.deepEqual(labels("CAFE"), ["Café opening.mp4"]);
  assert.deepEqual(labels("opening mp4"), ["Café opening.mp4"]);
  assert.deepEqual(labels("space"), ["Play / pause"], "found by a keyword");
  assert.deepEqual(labels("settings bin"), ["Link timeline and Project bin selection"]);
  const mixer = { label: "Mixer", group: "Panel" }, other = { label: "Audio tab", group: "Panel", keywords: ["mixer"] };
  assert.deepEqual(S.rank("mixer", [other, mixer]).map((i) => i.label), ["Mixer", "Audio tab"]);
});

test("an empty query keeps the given order, and the limit caps the list", () => {
  assert.deepEqual(labels(""), items.map((i) => i.label));
  assert.equal(S.rank("", items, 3).length, 3);
  assert.equal(S.score("", items[0]), 1);
  assert.equal(S.fold("  Ripple—Délete! "), "ripple delete");
});

test("letters of any script count; a symbol-only query matches only the keys that hold it", () => {
  const items = [{ label: "猫.mp4", group: "Media" }, { label: "犬.mp4", group: "Media" }, { label: "Café intro", group: "Clip" },
    { label: "Lift", group: "Shortcut", keys: [";"] }, { label: "Extract", group: "Shortcut", keys: ["'"] }];
  assert.deepEqual(S.rank("猫", items).map((x) => x.label), ["猫.mp4"]);
  assert.deepEqual(S.rank("cafe", items).map((x) => x.label), ["Café intro"]);
  assert.deepEqual(S.rank(";", items).map((x) => x.label), ["Lift"]);
  assert.deepEqual(S.rank("@@", items), [], "no match runs nothing");
  assert.equal(S.rank("  ", items).length, items.length, "a blank query still lists everything");
});
