/** The end of a sentence: a full stop, then the capital that starts the next. */
const SENTENCE_END = /\.(\s+)([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ])/g;

/** Sentences any text may have set apart, however short it is. */
const PARAGRAPHS_MIN = 75;

/** Past that count, one sentence is set apart for every so many characters. */
const CHARACTERS_PER_PARAGRAPH = 20;

/**
 * Improve testimony readability: add paragraph breaks after sentences
 * (ported from the old app's formatText).
 *
 * At most 75 sentences are set apart, or one for every 20 characters of the
 * text when that is more: ordinary sentences each get their paragraph,
 * however long the testimony; in a text of sentences a few characters long,
 * the ones past that count follow one another on the line, as they are
 * stored.
 */
export function formatTestimonyText(text: string): string {
  if (!text) return "";
  let left = Math.max(PARAGRAPHS_MIN, Math.floor(text.length / CHARACTERS_PER_PARAGRAPH));
  return text
    .replace(SENTENCE_END, (end, _spaces: string, capital: string) =>
      left-- > 0 ? `.\n\n${capital}` : end,
    )
    .trim();
}
