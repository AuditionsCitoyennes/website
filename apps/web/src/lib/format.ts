// Date helpers (French), hand-rolled on Intl to avoid a date library.

/** Parse a date string. Date-only values (YYYY-MM-DD) are read as local time
 *  to avoid an off-by-one day from UTC midnight. */
export function parseDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}

const longFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const shortFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** e.g. "9 juin 2026" */
export function formatDateLong(value: string): string {
  return longFmt.format(parseDate(value));
}

/** e.g. "9 juin 2026" (abbreviated month) */
export function formatDateShort(value: string): string {
  return shortFmt.format(parseDate(value));
}

/**
 * Improve testimony readability: add paragraph breaks after sentences
 * (ported from the old app's formatText).
 */
export function formatTestimonyText(text: string): string {
  if (!text) return "";
  return text.replace(/\.(\s+)([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ])/g, ".\n\n$2").trim();
}
