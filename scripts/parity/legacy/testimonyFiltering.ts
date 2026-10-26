// FROZEN — the reference of npm run db:parity (scripts/parity): a copy of
// apps/web/src/features/temoignages/useTestimonyFiltering.ts
// as of b3cb304, before map phase 1 moved the Témoignages map onto the
// server. Never edited to follow the app; only to run in Node (imports, Vue
// refs turned into arguments).
//
// The composable's computed values, as functions of the corpus (/api/testimonies),
// the map's groups (/api/map) and the filters' values (useFilters: the needle
// is fold(text.trim())). The page, not the home card: the corpus is there.

import type { LocationGroup, PublicTestimony } from "@ac/shared";
import {
  buildLocationTree,
  buildTopicOptions,
  dateBoundsOf,
  passesContent as testimonyPasses,
  passesDate as dateIn,
  passesLocation as areaIn,
} from "./filters";

/** The values of the filters dialog (useFilters), the needle folded. */
export interface LegacyFilters {
  topics: string[];
  locations: string[];
  dateFrom: string | null;
  dateTo: string | null;
  verified: boolean;
  needle: string;
}

/** Own testimonies surviving every filter (location resolved via their group). */
export function filteredTestimonies(
  allTestimonies: PublicTestimony[],
  ownGroups: LocationGroup[],
  f: LegacyFilters,
): PublicTestimony[] {
  const passesLocation = (g: LocationGroup) => areaIn(g, f.locations);
  const passesDate = (date: string | null | undefined) => dateIn(date, f.dateFrom, f.dateTo);
  const passesContent = (t: PublicTestimony) =>
    testimonyPasses(t, { verified: f.verified, topics: f.topics, needle: f.needle });
  const auditionGroup = new Map<string, LocationGroup>();
  for (const g of ownGroups) for (const a of g.auditions) auditionGroup.set(a.id, g);
  return allTestimonies.filter((t) => {
    if (!t.audition) return false;
    if (!passesContent(t)) return false;
    if (!passesDate(t.audition.date)) return false;
    const g = auditionGroup.get(t.audition.id);
    return g ? passesLocation(g) : !f.locations.length;
  });
}

/** Own groups, narrowed to the auditions that still have matching testimonies. */
export function filteredOwnGroups(
  ownGroups: LocationGroup[],
  filtered: PublicTestimony[],
): LocationGroup[] {
  const perAudition = new Map<string, number>();
  for (const t of filtered) {
    const id = t.audition?.id;
    if (id) perAudition.set(id, (perAudition.get(id) ?? 0) + 1);
  }
  const out: LocationGroup[] = [];
  for (const g of ownGroups) {
    const auditions = g.auditions.filter((a) => perAudition.has(a.id));
    if (!auditions.length) continue;
    const total = auditions.reduce((s, a) => s + (perAudition.get(a.id) ?? 0), 0);
    out.push({
      ...g,
      auditions: auditions.map((a) => ({ ...a, testimony_count: perAudition.get(a.id) ?? 0 })),
      totalTestimonies: total,
    });
  }
  return out;
}

/** "N résultats". */
export function resultCount(filtered: PublicTestimony[]): number {
  return filtered.length;
}

/** The place picker: every lieu that has something, weighted by its testimonies. */
export function locationTree(ownGroups: LocationGroup[]) {
  return buildLocationTree(ownGroups.map((g) => ({ area: g, weight: g.totalTestimonies })));
}

/** Earliest/latest audition date present. */
export function dateBounds(ownGroups: LocationGroup[]) {
  return dateBoundsOf(ownGroups.flatMap((g) => g.auditions.map((a) => a.date)));
}

/** The theme picker's options, over the whole corpus. */
export function topicOptions(allTestimonies: PublicTestimony[]) {
  return buildTopicOptions(allTestimonies.map((t) => t.topics));
}
