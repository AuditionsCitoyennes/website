import {
  getCanonicalLocation,
  getKnownCoordinates,
  type AuditionWithCount,
  type LocationGroup,
  type OnlinePlace,
} from "@ac/shared";
import { publicClient } from "../supabase";
import { resolve, getCachedEntry } from "../geocode";
import { cached, invalidate, PUBLIC_CACHE_KEYS, publicCachesGeneration } from "../cache";

/**
 * Where an audition is filed on the map. An online audition's location is its
 * town hall's name, already unique and exact: it is never run through the
 * keyword rules of getCanonicalLocation (they would turn "Mairie de
 * Montbron" into Bron's médiathèque).
 */
export function placeKeyOf(a: { location: string; audition_en_ligne?: boolean | null }): string {
  return a.audition_en_ligne ? a.location : getCanonicalLocation(a.location);
}

/** An online audition's town hall, as stored with it (null for any other). */
export function onlinePlaceOf(a: {
  audition_en_ligne?: boolean | null;
  place?: unknown;
}): OnlinePlace | null {
  if (!a.audition_en_ligne || !a.place || typeof a.place !== "object") return null;
  const p = a.place as Partial<OnlinePlace>;
  return typeof p.lat === "number" && typeof p.lng === "number" ? (p as OnlinePlace) : null;
}

/** Published auditions with their visible (verified) testimony counts. */
export async function fetchPublishedAuditions(): Promise<AuditionWithCount[]> {
  const { data, error } = await publicClient
    .from("auditions")
    .select("*, testimonies(count)")
    .eq("status", "published")
    .order("date", { ascending: false });
  if (error) throw new Error(error.message);

  return (
    (data ?? [])
      .map((row) => {
        const { testimonies, ...audition } = row as typeof row & {
          testimonies?: { count: number }[];
        };
        return { ...audition, testimony_count: testimonies?.[0]?.count ?? 0 };
      })
      // An online audition is public once it holds a verified testimony. The
      // database already hides it until then; this holds even if it did not.
      .filter((a) => !(a.audition_en_ligne && a.testimony_count === 0))
  );
}

function groupByCanonical(auds: AuditionWithCount[]): Map<string, AuditionWithCount[]> {
  const map = new Map<string, AuditionWithCount[]>();
  for (const a of auds) {
    const canonical = placeKeyOf(a);
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
    // An online audition's town hall was located when it was created.
    const online = onlinePlaceOf(list[0]);
    if (online) {
      groups.push({
        canonicalName: canonical,
        coordinates: [online.lat, online.lng],
        auditions: list,
        totalTestimonies: list.reduce((s, a) => s + a.testimony_count, 0),
        city: online.commune,
        citycode: online.insee,
        arrondissement: online.arrondissement,
        departementCode: online.departementCode,
        departementName: online.departementName,
        region: online.region,
      });
      continue;
    }
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

// Set once a pass finds nothing left to resolve. /api/map calls this on EVERY
// request, and `warming` only collapses CONCURRENT calls (it is nulled in the
// finally), so without this every hit on the hottest endpoint started a fresh
// pass — each one an uncached full-table read of published auditions.
//
// It holds the WRITE GENERATION that pass looked at, not a plain "done": an
// audition created or moved afterwards may bring a lieu never geocoded, and a
// latch that stayed shut would keep it off the map until the API restarts.
let warmGeneration = -1;

export function warmLocationGeocodes(): Promise<void> {
  if (warmGeneration === publicCachesGeneration()) return Promise.resolve();
  if (warming) return warming;
  warming = (async () => {
    try {
      // Read before the data: a write landing during the pass leaves the two
      // unequal, and the next request looks again.
      const generation = publicCachesGeneration();
      // Route through the same cache the read endpoints use, so a warm pass
      // costs at most one Supabase read per TTL instead of one per request.
      // invalidatePublicCaches() already drops this key on every write, so
      // freshness is unchanged.
      const auditions = await cached(PUBLIC_CACHE_KEYS.auditions, 60_000, fetchPublishedAuditions);
      // Online auditions are not geocoded: their town hall is stored with them.
      const grouped = groupByCanonical(auditions.filter((a) => !a.audition_en_ligne));
      let resolvedAny = false;
      let pending = 0;
      for (const canonical of grouped.keys()) {
        if (getCachedEntry(canonical) !== undefined) continue;
        pending++;
        await resolve(canonical);
        resolvedAny = true;
      }
      if (pending === 0) warmGeneration = generation;
      // Newly geocoded locations only reach the client if the cached map
      // response is dropped — otherwise they wait out the full TTL, which is
      // longer than the client's entire polling window.
      if (resolvedAny) invalidate(PUBLIC_CACHE_KEYS.map);
    } catch {
      /* ignore — best-effort warm */
    } finally {
      warming = null;
    }
  })();
  return warming;
}
