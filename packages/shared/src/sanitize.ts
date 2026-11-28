import { boundLines, cleanLine, cleanText } from "./text";

/**
 * A text as it is stored: cleaned by the text policy (cleanText), then its
 * email addresses and phone numbers replaced with "***".
 * Applied to all user-facing text fields except the dedicated email field.
 */

// Email pattern: standard user@domain.tld. The runs are bounded (as real
// addresses are): unbounded, a long run of letters with no "@" made the
// engine retry from every position — seconds of blocked server for 100 KB.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,63}/g;

// A space between the groups of a phone number: plain, non-breaking, narrow,
// thin or figure. A line break counts as one: a number cut in two lines is one
// number, on two lines or once they are joined.
const SPACE = "[ \\n\\u00A0\\u202F\\u2009\\u2007]";

// What stands between two groups: a space, a dot or a hyphen.
const SEP = "[ \\n\\u00A0\\u202F\\u2009\\u2007.\\-]";

// A French number after its first two digits, its groups `sep` apart: by
// pairs, or two more digits then pairs or threes, as the numbers of the
// overseas departments and the free numbers are written.
//   06 12 34 56 78  |  0690 12 34 56  |  0800 123 456
const frenchGroups = (sep: string) =>
  `(?:${sep}\\d{2}){4}|\\d{2}(?:${sep}\\d{2}){3}|\\d{2}(?:${sep}\\d{3}){2}`;

// One kind of separator all along: spaces (one or two), dots or hyphens; or
// none. A date followed by a number mixes two kinds and is not one of these.
//   06 12 34 56 78  |  06.12.34.56.78  |  06-12-34-56-78  |  0612345678
const FRENCH_DIGITS = `[1-9](?:${[`${SPACE}{1,2}`, "\\.", "-"].map(frenchGroups).join("|")}|\\d{8})`;

// A French number: ten digits from 01 to 09.
const FRENCH = `0${FRENCH_DIGITS}`;

// The same number with France's country code in place of its first 0.
//   +33 6 12 34 56 78  |  +33612345678  |  0033 6 12 34 56 78
//   +33 (0)6 12 34 56 78  |  (+33) 6 12 34 56 78  |  00 33 6 12 34 56 78
const FRENCH_ABROAD = `\\(?(?:\\+|00)${SPACE}?33\\)?${SPACE}?(?:\\(0\\)${SPACE}?)?${FRENCH_DIGITS}`;

// A number with another country code, after "+" or "00": runs of digits, each
// new one after a separator or around a pair of brackets.
//   +1 (555) 123-4567  |  +44 20 7946 0958  |  +32 470 12 34 56
// Written so that a run of digits can be read one way only (the engine never
// tries another split of it), and bounded, as real numbers are. Where such a
// number ends cannot be told: digits written right after it are read with it.
const INTERNATIONAL = `\\(?(?:\\+|00)[1-9]\\d{0,14}\\)?(?:${SEP}?\\(\\d{1,4}\\)\\d{0,14}|${SEP}\\d{1,14}){0,9}`;

// Any of the three, standing alone: no digit right after, and none right
// before one that starts with a digit (the first group keeps what stands
// there; a "+" needs nothing before it). A year range (2023-2024), a date
// (12.10.2025, 2025-10-12), a law number (2021-1104) or an amount
// (100 000 000) is none of these shapes.
const PHONE_REGEX = new RegExp(
  `(^|\\D|(?=\\(?\\+))(${FRENCH}|${FRENCH_ABROAD}|${INTERNATIONAL})(?!\\d)`,
  "g",
);

// A signed number with its thousands spaced out: +2 500 000.
const SPACED_THOUSANDS = new RegExp(`^\\+\\d{1,3}(?:${SPACE}\\d{3})+$`);

/** A number with its country code has at least eight digits. (A French one,
 *  by its shape, has ten.) Written as spaced thousands it is an amount, unless
 *  it has nine digits or more and they are not all zeros after the first
 *  group: +15 300 000 and +2 000 000 000 stay, +48 123 456 789 is a number. */
function looksLikePhone(number: string): boolean {
  const digits = number.replace(/^\(?00|\D/g, "");
  if (!SPACED_THOUSANDS.test(number)) return digits.length >= 8;
  return digits.length >= 9 && !/^\d{1,3}(?:000)+$/.test(digits);
}

/** Email addresses, then phone numbers (the more specific first), as "***". */
function masked(text: string): string {
  return text
    .replace(EMAIL_REGEX, "***")
    .replace(PHONE_REGEX, (match, before: string, number: string) =>
      looksLikePhone(number) ? `${before}***` : match,
    );
}

export function sanitizeText(text: string): string {
  // Cleaned first: a number or an address cut by characters nobody sees is
  // then whole. Bounded again last: a masked text is shorter, and a shorter
  // text keeps fewer line breaks.
  return boundLines(masked(cleanText(text)));
}

/** sanitizeText for a field of one line (a name, an information line). */
export function sanitizeLine(text: string): string {
  return sanitizeText(cleanLine(text));
}

/**
 * What an edit stores for a field sent over a stored one: the stored text
 * itself when the text sent is that text — as it is, or as storing it again
 * would leave it — and the sent text, sanitised, otherwise. A row written
 * before the text policy is thus neither rewritten nor seen as changed by an
 * edit that leaves the field alone. `sanitize` is the field's own: sanitizeText
 * for a text of several lines, sanitizeLine for a name or an information line.
 */
export function editedText(
  sent: string,
  stored: string | null,
  sanitize: (text: string) => string = sanitizeText,
): string {
  const next = sanitize(sent);
  return stored !== null && next === sanitize(stored) ? stored : next;
}
