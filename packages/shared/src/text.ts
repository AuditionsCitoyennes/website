// The text policy: what a name, an information line or a testimony may hold,
// whoever types it (a visitor in the form, a volunteer in the admin, a witness
// on the emailed page).
//
// Two layers. cleanText() tidies without refusing anything: it is what
// sanitizeText() applies first, so every write path gets it. The rules below it
// refuse, with a sentence for the person typing; the schemas attach them.
//
// No zod here: a page that only cleans or checks a text loads none for it. And
// every pattern reads its text once: a body of spaces or of marks costs what
// its length costs, no more.

/** Every way a text says "new line", read as one. */
const LINE_BREAKS = /\r\n?|[\u000B\u000C\u0085\u{2028}\u{2029}]/gu;

/** Characters that draw nothing and are no space to the engine (the tab, the
 *  braille blank, the Hangul fillers): a space each. */
const BLANKS = /[\t\u{2800}\u{3164}\u{115F}\u{1160}\u{FFA0}]/gu;

/** The two joiners scripts and emoji are written with. */
const JOINERS = "\u{200C}\u{200D}";

/**
 * Characters no stored text keeps: they draw nothing, and some reorder or hide
 * what stands around them.
 *  - control characters (the line break is kept);
 *  - halves of a surrogate pair on their own;
 *  - format characters: the bidirectional marks, embeddings, overrides and
 *    isolates (U+200E, U+200F, U+061C, U+202A-202E, U+2066-2069), the
 *    zero-width space and its kin (U+200B, U+2060, U+FEFF), the soft hyphen,
 *    the tag characters and the rest of their class.
 * Kept from that class: the two joiners and the signs that are drawn (Arabic
 * and Syriac number and verse marks).
 */
const DROPPED =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cs}]|(?![\u{200C}\u{200D}\u{0600}-\u{0605}\u{06DD}\u{070F}\u{0890}\u{0891}\u{08E2}\u{110BD}\u{110CD}])\p{Cf}/gu;

/** Most combining marks kept on one letter. Vocalised Arabic, pointed Hebrew
 *  with its cantillation and Vietnamese stay under it. */
const MARKS_MAX = 4;

/** A letter's marks past that count. A joiner between two marks does not start
 *  a new count: the marks after it are drawn on the same letter. */
const MARKS_OVER = new RegExp(
  `((?:\\p{M}[${JOINERS}]*){${MARKS_MAX}})((?:\\p{M}[${JOINERS}]*)+)`,
  "gu",
);

/** Something a reader sees: a letter, a digit, a punctuation sign, a symbol. */
const DRAWN = /[\p{L}\p{N}\p{P}\p{S}]/u;

/**
 * A text as the site stores it: composed (Unicode NFC), without the characters
 * of DROPPED, at most four combining marks on a letter, one kind of line break,
 * nothing but the break at the end of a line, at most one empty line in a row,
 * no space around the whole; empty when nothing in it is drawn. What a reader
 * sees of an ordinary text is unchanged; applying it twice changes nothing
 * more.
 */
export function cleanText(text: string): string {
  const cleaned = text
    .replace(LINE_BREAKS, "\n")
    .replace(BLANKS, " ")
    .replace(DROPPED, "")
    .normalize("NFC")
    .replace(MARKS_OVER, (_, kept: string, over: string) => kept + over.replace(/\p{M}/gu, ""))
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return DRAWN.test(cleaned) ? cleaned : "";
}

/** cleanText for a field of one line (a name, an information, a title, a
 *  place): a line break becomes a space, several spaces become one. */
export function cleanLine(text: string): string {
  return cleanText(text)
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ");
}

/** What a client is told about a text the database cannot hold. */
export const TEXT_NOT_STORABLE = "Texte invalide.";

/** Whether Postgres can store the text: its text type takes neither U+0000
 *  nor half a surrogate pair. Asked of the text as it arrives, before any
 *  cleaning: such a character comes from a program, not from a keyboard. */
export function isStorableText(text: string): boolean {
  return !/[\u0000\p{Cs}]/u.test(text);
}

// ---- Names and information lines ------------------------------------------

/**
 * What a name is written with: letters of any script with their marks, digits,
 * spaces, and the punctuation names and nicknames use:
 *   . , ' ‘ ’ " “ ” - ( ) & / · « » : ! ? ° +
 * the two other hyphens of Unicode (U+2010, U+2011), and the asterisk, which is
 * what the masking of sanitizeText() writes.
 * Everything else is refused, which leaves out the symbols (check marks,
 * arrows, emoji) and the en and em dashes: a name is printed beside the site's
 * own labels and must not read as one of them.
 */
const NAME_CHARACTER =
  /^[\p{L}\p{Mn}\p{Mc}\p{Nd}\p{Zs}\u{200C}\u{200D}.,'\u{2018}\u{2019}"\u{201C}\u{201D}\-\u{2010}\u{2011}()&/\u{00B7}\u{00AB}\u{00BB}:!?\u{00B0}+*]$/u;

/** The selector that turns the character before it into its emoji. */
const EMOJI_SELECTOR = "\u{FE0F}";

/** A symbol an information line does not take: the symbol classes of Unicode
 *  past Latin-1 (so °, ±, × and the keyboard's own signs stay), the enclosing
 *  marks and the emoji selector. Dashes and every other punctuation stay. */
function isPictograph(ch: string): boolean {
  return (
    ch === EMOJI_SELECTOR ||
    ((ch.codePointAt(0) ?? 0) > 0xff && /[\p{So}\p{Sk}\p{Sm}\p{Me}]/u.test(ch))
  );
}

/** The refused character as a message shows it; nothing for one that draws
 *  nothing by itself. */
function shown(ch: string): string {
  return DRAWN.test(ch) ? ` (« ${ch} »)` : "";
}

/** What is wrong with a name, as a sentence for the person typing; null when
 *  it may be stored. Asked of the name once cleaned (cleanLine). */
export function personNameIssue(name: string): string | null {
  for (const ch of name) {
    if (ch === EMOJI_SELECTOR || !NAME_CHARACTER.test(ch)) {
      return `Le nom contient un caractère non accepté${shown(ch)}. Utilisez des lettres, des chiffres et une ponctuation simple.`;
    }
  }
  return null;
}

/** The same for an information line. */
export function personInfoIssue(info: string): string | null {
  for (const ch of info) {
    if (isPictograph(ch)) {
      return `Les informations contiennent un symbole non accepté${shown(ch)}.`;
    }
  }
  return null;
}
