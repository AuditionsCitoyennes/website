// FROZEN — the reference of npm run db:parity (scripts/parity): a copy of
// apps/web/src/features/geo-nav/model/usePanelAuditions.ts (placeAuditions,
// resultAuditions, auditionMeta's lieu) and useGeoHierarchy.ts (allPlaceUnits,
// placeByCanonical)
// as of b3cb304, before map phase 1 moved the Témoignages map onto the
// server. Never edited to follow the app; only to run in Node (imports, Vue
// refs turned into arguments).

import type { LocationGroup } from "@ac/shared";
import {
  bySort,
  toPanelAudition,
  type AuditionGroup,
  type AuditionSort,
  type PanelAudition,
} from "./auditions";
import type { GeoUnit } from "./types";

/** Every lieu in the dataset. */
export function allPlaceUnits(index: Map<string, GeoUnit>): GeoUnit[] {
  return [...index.values()].filter((u) => u.levelKey === "place");
}

/** A lieu's unit by its canonical name (its label, for the panel's lines and the analyses). */
export function placeByCanonical(places: GeoUnit[]): Map<string, GeoUnit> {
  const map = new Map<string, GeoUnit>();
  for (const u of places) if (u.canonical) map.set(u.canonical, u);
  return map;
}

// The open lieu's auditions: listed at once from what the map already knows of
// them (title, date, how many testimonies) — nothing is fetched to open a lieu.
export function placeAuditions(
  groups: LocationGroup[],
  canonical: string | undefined,
  sort: AuditionSort | undefined,
  ownAuditions: Map<string, AuditionGroup>,
): PanelAudition[] {
  if (!canonical) return [];
  const rows: PanelAudition[] = [];
  for (const g of groups) {
    if (g.canonicalName !== canonical) continue;
    for (const a of g.auditions) rows.push(toPanelAudition(g, a, ownAuditions));
  }
  return rows.sort((a, b) => bySort(a, b, sort));
}

/** The results (list mode): every audition of the groups, in the order asked for. */
export function resultAuditions(
  groups: LocationGroup[],
  sort: AuditionSort | undefined,
  ownAuditions: Map<string, AuditionGroup>,
): PanelAudition[] {
  const out: PanelAudition[] = [];
  for (const g of groups)
    for (const a of g.auditions) out.push(toPanelAudition(g, a, ownAuditions));
  return out.sort((a, b) => bySort(a, b, sort));
}

/** The lieu a result line names (auditionMeta, list mode). */
export function resultLieuLabel(a: PanelAudition, byCanonical: Map<string, GeoUnit>): string {
  return byCanonical.get(a.canonical)?.label ?? a.canonical;
}
