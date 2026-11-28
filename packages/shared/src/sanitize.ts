import { cleanLine, cleanText } from "./text";

/**
 * A text as it is stored: cleaned by the text policy (cleanText), then its
 * email addresses and phone numbers replaced with "***".
 * Applied to all user-facing text fields except the dedicated email field.
 */

// Email pattern: standard user@domain.tld. The runs are bounded (as real
// addresses are): unbounded, a long run of letters with no "@" made the
// engine retry from every position — seconds of blocked server for 100 KB.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,63}/g;

// What stands between the groups of a phone number: a space (plain,
// non-breaking or narrow), a dot or a hyphen.
const SEP = "[ \\u00A0\\u202F.\\-]";

// A French number: ten digits from 01 to 09, in pairs, with the same
// separator all along or none.
//   06 12 34 56 78  |  06.12.34.56.78  |  06-12-34-56-78  |  0612345678
const FRENCH = `0[1-9](?<sep>${SEP}?)\\d{2}(?:\\k<sep>\\d{2}){3}`;

// A number with its country code, after "+" or "00": runs of digits, each new
// one after a separator or around a pair of brackets.
//   +33 6 12 34 56 78  |  +33612345678  |  0033 6 12 34 56 78
//   +33 (0)6 12 34 56 78  |  +1 (555) 123-4567  |  +44 20 7946 0958
// Written so that a run of digits can be read one way only (the engine never
// tries another split of it), and bounded, as real numbers are.
const INTERNATIONAL = `(?:\\+|00)[1-9]\\d{0,14}(?:${SEP}?\\(\\d{1,4}\\)\\d{0,14}|${SEP}\\d{1,14}){0,9}`;

// Either, standing alone: no digit right before (kept by the first group) nor
// right after. A year range (2023-2024), a date (12.10.2025, 2025-10-12), a
// law number (2021-1104) or an amount (100 000 000) is none of these shapes.
const PHONE_REGEX = new RegExp(`(^|\\D)(${FRENCH}|${INTERNATIONAL})(?!\\d)`, "g");

/** A number with its country code has at least eight digits. (A French one,
 *  by its shape, has ten.) */
function looksLikePhone(number: string): boolean {
  return number.replace(/^00|\D/g, "").length >= 8;
}

export function sanitizeText(text: string): string {
  // Cleaned first: a number or an address cut by characters nobody sees is
  // then whole. Emails before phones (more specific).
  return cleanText(text)
    .replace(EMAIL_REGEX, "***")
    .replace(PHONE_REGEX, (match, before: string, number: string) =>
      looksLikePhone(number) ? `${before}***` : match,
    );
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
