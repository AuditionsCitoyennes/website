// Overseas France as the site shows it. The official geography files each DROM
// as a région over a département of the same name (Guadeloupe 01/971,
// Martinique 02/972, Guyane 03/973, La Réunion 04/974, Mayotte 06/976), and the
// API files a collectivité (975, 977, 978) the same way under one code
// (apps/api places/fr.ts): one territory, shown as ONE level — the région,
// holding what its département holds. One rule for the map's tree, the place
// picker, the corpus and the outline files.

/** A région and a département of these names are one territory. */
export function isOneTerritory(regionName: string, depName: string | null | undefined): boolean {
  return !!depName && depName === regionName;
}

/** A child unit as the fold reads it. */
export interface TerritoryChild {
  id: string;
  name: string;
  /** It is a département (geo_units "county", the outline files' "dep"). */
  isDepartement: boolean;
}

/** The département a région folds into — its only child unit, a département of
 *  its own name — or null: every metropolitan région, and one whose single
 *  département has another name (Île-de-France over Paris). */
export function foldedDepartementOf(
  regionName: string,
  children: readonly TerritoryChild[],
): string | null {
  if (children.length !== 1) return null;
  const [c] = children;
  return c.isDepartement && isOneTerritory(regionName, c.name) ? c.id : null;
}
