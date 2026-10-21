// ---- Geography -------------------------------------------------------------

/** Map default center (metropolitan France). */
export const FRANCE_CENTER: [number, number] = [46.603354, 1.888334];

/**
 * Normalize a location string: trim, collapse whitespace, title-case.
 * Handles hyphenated words (e.g. "gratte-ciel" -> "Gratte-Ciel").
 */
export function normalizeLocation(location: string): string {
  const trimmed = location.trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;

  return trimmed
    .toLowerCase()
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
        .join("-"),
    )
    .join(" ");
}

/**
 * Keyword rules mapping location variations to canonical names + coordinates.
 * First matching rule wins, so more specific rules come first.
 */
export const LOCATION_RULES: {
  keywords: string[];
  canonical: string;
  coordinates: [number, number];
}[] = [
  {
    keywords: ["gratte-ciel", "villeurbanne"],
    canonical: "Marché des Gratte-Ciel, Villeurbanne",
    coordinates: [45.7676, 4.8799],
  },
  {
    keywords: ["gratte-ciel"],
    canonical: "Marché des Gratte-Ciel, Villeurbanne",
    coordinates: [45.7676, 4.8799],
  },
  {
    keywords: ["charpennes", "villeurbanne"],
    canonical: "Marché des Charpennes, Villeurbanne",
    coordinates: [45.771, 4.8633],
  },
  {
    keywords: ["charles hernu"],
    canonical: "Marché des Charpennes, Villeurbanne",
    coordinates: [45.771, 4.8633],
  },
  { keywords: ["part-dieu"], canonical: "Part-Dieu, Lyon", coordinates: [45.7606, 4.859] },
  {
    keywords: ["croix-rousse"],
    canonical: "Marché de la Croix-Rousse, Lyon",
    coordinates: [45.7743, 4.8316],
  },
  {
    keywords: ["manif", "jean macé"],
    canonical: "Manif Interfac Jean Macé, Lyon 7",
    coordinates: [45.7456, 4.8422],
  },
  {
    keywords: ["jean macé"],
    canonical: "Marché Jean Macé, Lyon 7",
    coordinates: [45.7456, 4.8422],
  },
  {
    keywords: ["grandclément"],
    canonical: "Place Grandclément, Villeurbanne",
    coordinates: [45.766, 4.887],
  },
  {
    keywords: ["granclément"],
    canonical: "Place Grandclément, Villeurbanne",
    coordinates: [45.766, 4.887],
  },
  {
    keywords: ["médiathèque", "bron"],
    canonical: "Parvis Médiathèque, Bron",
    coordinates: [45.7387, 4.9127],
  },
  { keywords: ["bron"], canonical: "Parvis Médiathèque, Bron", coordinates: [45.7387, 4.9127] },
  { keywords: ["cordeliers"], canonical: "Cordeliers, Lyon", coordinates: [45.764, 4.8357] },
  // BAN has no POI for the park; without this it matches "Rue Sergent Blandan"
  // in Lyon 1 (~2.7 km off). Parc Sergent Blandan is in Lyon 7.
  { keywords: ["blandan"], canonical: "Parc Blandan, Lyon", coordinates: [45.7452, 4.8546] },
];

/** Map a raw location string to its canonical form (or the normalized string). */
export function getCanonicalLocation(raw: string): string {
  const normalized = normalizeLocation(raw);
  const lower = normalized.toLowerCase();
  for (const rule of LOCATION_RULES) {
    if (rule.keywords.every((kw) => lower.includes(kw))) return rule.canonical;
  }
  return normalized;
}

/** Hardcoded coordinates for a canonical location, or null (caller geocodes). */
export function getKnownCoordinates(canonicalName: string): [number, number] | null {
  const rule = LOCATION_RULES.find((r) => r.canonical === canonicalName);
  return rule?.coordinates ?? null;
}

/**
 * Generic, non-mappable location values (e.g. the "Anciens témoignages"
 * nationwide bucket). These have no coordinates or administrative area: the API
 * skips geocoding them and the UI shows them as a "Sans lieu précis" node.
 */
export const GENERIC_LOCATION = /^(france|métropole|metropole|en ligne|internet|divers|inconnu)$/i;

/** Whether a (raw or canonical) location is a generic, non-mappable value. */
export function isGenericLocation(location: string): boolean {
  return GENERIC_LOCATION.test(location.trim());
}
