// What the slabs say: the figures as printed ("1 247 témoignages"), a theme's
// short name, the plaque's counts and the lines they are drawn on, the empty
// text. Pure — no Vue (GeoNav and the overlay both read it).
import { themeShortLabel, type AuditionTheme } from "@ac/shared";
import type { ScopeAnalysis } from "../stats/scopeStats";

const NUM = new Intl.NumberFormat("fr-FR");
export const fmtN = (n: number) => NUM.format(n);
/** "1 témoignage", "247 témoignages" (French: 0 and 1 take the singular). */
export const plural = (n: number, one: string, many: string) => `${fmtN(n)} ${n > 1 ? many : one}`;

/** A theme's name in a word or two. */
export const shortName = (theme: string) => themeShortLabel(theme as AuditionTheme) || theme;

export interface CountPart {
  key: string;
  n: number;
  word: string;
}

export function countsOf(s: ScopeAnalysis, compact: boolean): CountPart[] {
  // Within a ville the commune count says nothing (it is one).
  const local = s.levelLabel === "Ville" || s.levelLabel === "Arrondissement";
  const parts: CountPart[] = [
    { key: "t", n: s.testimonies, word: s.testimonies > 1 ? "témoignages" : "témoignage" },
    { key: "a", n: s.auditions, word: s.auditions > 1 ? "auditions" : "audition" },
    { key: "l", n: s.lieux, word: s.lieux > 1 ? "lieux" : "lieu" },
  ];
  if (!local && !compact && s.communes) {
    parts.push({ key: "c", n: s.communes, word: s.communes > 1 ? "communes" : "commune" });
  }
  return parts;
}

/** The plaque's counts in the lines they are drawn on: all on one line
 *  (`fits` says it does) — only past the screen's width, as many on each
 *  line as fit, in their order (a count never split). */
export function countLinesOf(
  parts: CountPart[],
  fits: (line: CountPart[]) => boolean,
): CountPart[][] {
  const lines: CountPart[][] = [];
  for (const p of parts) {
    const line = lines[lines.length - 1];
    if (line && fits([...line, p])) line.push(p);
    else lines.push([p]);
  }
  return lines;
}

export const emptyTextOf = (filtered: boolean) =>
  filtered
    ? "Aucun témoignage de l'association ne correspond aux filtres ici"
    : "Aucune audition de l'association ici pour l'instant";
