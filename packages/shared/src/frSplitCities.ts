// Paris, Lyon and Marseille: the three French communes split into
// arrondissements municipaux, each with an INSEE code of its own (Lyon 7e is
// 69387, Lyon itself 69123). One table for the API's geocoder and town halls
// and the site's commune picker and map tree.

export interface SplitCity {
  name: "Paris" | "Lyon" | "Marseille";
  /** INSEE code of the whole commune. */
  commune: string;
  /** Its département. */
  dep: string;
  /** Arrondissement n's INSEE code is base + n. */
  base: number;
  /** How many arrondissements. */
  count: number;
}

export const FR_SPLIT_CITIES: readonly SplitCity[] = [
  { name: "Paris", commune: "75056", dep: "75", base: 75100, count: 20 },
  { name: "Lyon", commune: "69123", dep: "69", base: 69380, count: 9 },
  { name: "Marseille", commune: "13055", dep: "13", base: 13200, count: 16 },
];

/** The split city named so ("Lyon"), as the map's ville is labelled. */
export function splitCityNamed(name: string): SplitCity | undefined {
  return FR_SPLIT_CITIES.find((c) => c.name === name);
}

/** The split city whose whole commune has this INSEE code (69123 → Lyon). */
export function splitCityOfCommune(code: string): SplitCity | undefined {
  return FR_SPLIT_CITIES.find((c) => c.commune === code);
}

/** The split city an arrondissement's INSEE code belongs to (69387 → Lyon); null for any other code. */
export function splitCityOfArrondissement(citycode: string | null | undefined): SplitCity | null {
  if (!citycode || !/^\d{5}$/.test(citycode)) return null;
  const n = Number(citycode);
  return FR_SPLIT_CITIES.find((c) => n > c.base && n <= c.base + c.count) ?? null;
}

/** French ordinal for an arrondissement number: 1 → "1er", n → "ne". */
export function ordinalFr(n: number): string {
  return n === 1 ? "1er" : `${n}e`;
}

/**
 * Arrondissement label for the big three cities ("Lyon 7e", "Paris 11e",
 * "Marseille 1er"), from its INSEE code. Null elsewhere: most communes have
 * no arrondissements.
 */
export function arrondissementFromCitycode(citycode: string | null | undefined): string | null {
  const city = splitCityOfArrondissement(citycode);
  return city ? `${city.name} ${ordinalFr(Number(citycode) - city.base)}` : null;
}

/** The INSEE codes of a split city's arrondissements, 1er first. */
export function arrondissementCodes(city: SplitCity): string[] {
  return Array.from({ length: city.count }, (_, i) => String(city.base + i + 1));
}

/**
 * Arrondissements whose town hall is another's: Paris 1er–4e share Paris
 * Centre's (in the 3e), and Marseille's sixteen share eight, one per sector
 * (filed under its first arrondissement). One online audition per town hall.
 */
export const SHARED_MAIRIE: Readonly<Record<string, string>> = {
  "75101": "75103",
  "75102": "75103",
  "75104": "75103",
  "13207": "13201",
  "13203": "13202",
  "13204": "13205",
  "13206": "13208",
  "13210": "13209",
  "13211": "13212",
  "13213": "13214",
  "13216": "13215",
};
