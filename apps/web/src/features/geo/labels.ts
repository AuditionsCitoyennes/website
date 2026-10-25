// What the counts are called on screen.

/** Abbreviate a count: 1000 → "1K", 1_300_000 → "1.3M". */
export function abbrevCount(n: number): string {
  const fmt = (v: number, suffix: string) => {
    const s = v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
    return s + suffix;
  };
  if (n < 1000) return String(n);
  if (n < 1_000_000) return fmt(n / 1000, "K");
  if (n < 1_000_000_000) return fmt(n / 1_000_000, "M");
  return fmt(n / 1_000_000_000, "B");
}
