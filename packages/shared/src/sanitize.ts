/**
 * Replaces phone numbers and email addresses found in text with "***".
 * Applied to all user-facing text fields except the dedicated email field.
 * (Ported verbatim from the previous app.)
 */

// Email pattern: standard user@domain.tld. The runs are bounded (as real
// addresses are): unbounded, a long run of letters with no "@" made the
// engine retry from every position — seconds of blocked server for 100 KB.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,63}/g;

// Phone patterns covering French and common international formats:
//   +33 6 12 34 56 78  |  +33612345678  |  +1 (555) 123-4567
//   06 12 34 56 78  |  06.12.34.56.78  |  06-12-34-56-78  |  0612345678
const PHONE_REGEX =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g;

function looksLikePhone(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  // A realistic phone number has between 7 and 15 digits
  return digits.length >= 7 && digits.length <= 15;
}

export function sanitizeText(text: string): string {
  // Replace emails first (more specific), then phones
  let result = text.replace(EMAIL_REGEX, "***");
  result = result.replace(PHONE_REGEX, (match) => (looksLikePhone(match) ? "***" : match));
  return result;
}
