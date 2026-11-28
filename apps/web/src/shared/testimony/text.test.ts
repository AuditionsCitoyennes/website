// How a testimony's text is laid out for reading (text.ts). Run with
// `node --import tsx --test apps/web/src/shared/testimony/text.test.ts`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTestimonyText } from "./text";

const lineBreaks = (text: string) => text.split("\n").length - 1;

test("each sentence starts a paragraph", () => {
  assert.equal(
    formatTestimonyText("Ça va. Pas trop mal.  On fait avec. et puis voilà."),
    "Ça va.\n\nPas trop mal.\n\nOn fait avec. et puis voilà.",
  );
  assert.equal(formatTestimonyText(""), "");
  // Line breaks typed by the witness stay.
  assert.equal(formatTestimonyText("Un.\nDeux. Trois."), "Un.\n\nDeux.\n\nTrois.");
});

test("a long testimony keeps a paragraph for every sentence", () => {
  const sentence = "Voilà ce que j'en pense.";
  for (const count of [60, 400, 800]) {
    const sentences = Array.from({ length: count }, () => sentence);
    assert.equal(formatTestimonyText(sentences.join(" ")), sentences.join("\n\n"));
  }
  // Short ones too, in a short text.
  const short = Array.from({ length: 76 }, () => "Oui.");
  assert.equal(formatTestimonyText(short.join(" ")), short.join("\n\n"));
});

test("in a text of sentences a few characters long, the later ones follow on the line", () => {
  // 1,499 characters: 75 sentences set apart (one for every 20 characters would be 74).
  const text = Array.from({ length: 500 }, () => "A.").join(" ");
  const shown = formatTestimonyText(text);
  assert.equal(lineBreaks(shown), 2 * 75);
  assert.equal(shown.replace(/\n\n/g, " "), text);
  assert.ok(shown.startsWith("A.\n\nA.\n\n"));
  assert.ok(shown.endsWith("A. A. A."));
  // 19,999 characters: one for every 20.
  const long = Array.from({ length: 4000 }, () => "Non.").join(" ");
  assert.equal(lineBreaks(formatTestimonyText(long)), 2 * 999);
});
