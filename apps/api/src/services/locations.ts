import {
  getCanonicalLocation,
  getKnownCoordinates,
  type AuditionWithCount,
  type LocationGroup,
} from "@ac/shared";
import { publicClient } from "../supabase";
import { resolve, getCachedEntry } from "../geocode";

/** Published auditions with their visible (verified) testimony counts. */
export async function fetchPublishedAuditions(): Promise<AuditionWithCount[]> {
  const { data, error } = await publicClient
    .from("auditions")
    .select("*, testimonies(count)")
    .eq("status", "published")
    .order("date", { ascending: false });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const { testimonies, ...audition } = row as typeof row & {
      testimonies?: { count: number }[];
    };
    return { ...audition, testimony_count: testimonies?.[0]?.count ?? 0 };
  });
}

function groupByCanonical(
  auds: AuditionWithCount[],
): Map<string, AuditionWithCount[]> {
  const map = new Map<string, AuditionWithCount[]>();
  for (const a of auds) {
    const canonical = getCanonicalLocation(a.location);
    const list = map.get(canonical) ?? [];
    list.push(a);
    map.set(canonical, list);
  }
  return map;
}

/** Build map groups from known coords + the cached geocode entries (no
 *  network). Prefers hardcoded rule coordinates for precise markers, and
 *  attaches the administrative area from the cached BAN entry. */
export async function buildLocationGroups(): Promise<LocationGroup[]> {
  const grouped = groupByCanonical(await fetchPublishedAuditions());
  const groups: LocationGroup[] = [];
  for (const [canonical, list] of grouped) {
    const entry = getCachedEntry(canonical) ?? null;
    const coords = getKnownCoordinates(canonical) ?? entry?.coords ?? null;
    if (!coords) continue;
    groups.push({
      canonicalName: canonical,
      coordinates: coords,
      auditions: list,
      totalTestimonies: list.reduce((s, a) => s + a.testimony_count, 0),
      city: entry?.city ?? null,
      citycode: entry?.citycode ?? null,
      arrondissement: entry?.arrondissement ?? null,
      departementCode: entry?.depCode ?? null,
      departementName: entry?.depName ?? null,
      region: entry?.region ?? null,
    });
  }
  return groups;
}

// Resolve any not-yet-cached canonical locations (throttled + cached). All
// canonicals are resolved — even rule-based ones — so they carry an admin area.
let warming: Promise<void> | null = null;

export function warmLocationGeocodes(): Promise<void> {
  if (warming) return warming;
  warming = (async () => {
    try {
      const grouped = groupByCanonical(await fetchPublishedAuditions());
      for (const canonical of grouped.keys()) {
        if (getCachedEntry(canonical) !== undefined) continue;
        await resolve(canonical);
      }
    } catch {
      /* ignore — best-effort warm */
    } finally {
      warming = null;
    }
  })();
  return warming;
}
