/**
 * Format a date-only string (YYYY-MM-DD) as DD/MM/YYYY without going through
 * Date — `new Date("YYYY-MM-DD")` parses as UTC midnight, which shifts a day
 * on servers running west of UTC.
 */
export function frDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return new Date(date).toLocaleDateString("fr-FR", { timeZone: "UTC" });
}
