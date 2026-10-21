// What the levels and the counts are called on screen.

import { LEVELS, type LevelKey } from "./types";

export const LEVEL_LABEL: Record<LevelKey, string> = {
  world: "Monde",
  country: "Pays",
  region: "Régions",
  dep: "Départements",
  city: "Villes",
  arr: "Arrondissements",
  place: "Lieux",
};

export function levelLabelForDepth(depth: number): string {
  return LEVEL_LABEL[LEVELS[depth] ?? "place"];
}

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
