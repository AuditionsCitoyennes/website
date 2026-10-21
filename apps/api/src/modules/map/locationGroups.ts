import {
  getKnownCoordinates,
  type AuditionWithCount,
  type LocationGroup,
  type MapAudition,
} from "@ac/shared";
import { fetchPublishedAuditions, onlinePlaceOf, placeKeyOf } from "../auditions/service";
import { backoffUntil, getCachedEntry, loadGeocodeCache, resolve } from "../geo/geocode";
import { cached, invalidate } from "../../lib/cache";
import {
  PUBLIC_CACHE_KEYS,
  PUBLIC_CACHE_TTL_MS,
  publicCachesGeneration,
} from "../../lib/publicCache";

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

/** What the map is told of an audition: no text, no author id, no timestamps. */
function toMapAudition(a: AuditionWithCount): MapAudition {
  return {
    id: a.id,
    title: a.title,
    date: a.date,
    location: a.location,
    testimony_count: a.testimony_count,
  };
}

/** Build map groups from known coords + the cached geocode entries (no
 *  network). Prefers hardcoded rule coordinates for precise markers, and
 *  attaches the administrative area from the cached BAN entry. */
export async function buildLocationGroups(): Promise<LocationGroup[]> {
  // The persisted geocode entries, before reading them: the first map after a
  // boot was otherwise built from an empty cache — and cached, pins missing.
  await loadGeocodeCache();
  // Through the same cache as /api/auditions and the warm pass: one Supabase
  // pull for the three, and one invalidation (invalidatePublicCaches) for all.
  const auditions = await cached(
    PUBLIC_CACHE_KEYS.auditions,
    PUBLIC_CACHE_TTL_MS.auditions,
    fetchPublishedAuditions,
  );
  const grouped = groupByCanonical(auditions);
  const groups: LocationGroup[] = [];
  for (const [canonical, list] of grouped) {
    // An online audition's town hall was located when it was created.
    const online = onlinePlaceOf(list[0]);
    if (online) {
      groups.push({
        canonicalName: canonical,
        coordinates: [online.lat, online.lng],
        auditions: list.map(toMapAudition),
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
      auditions: list.map(toMapAudition),
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

// Some lieux failed to geocode and back off (geocode.ts): no pass of that
// generation before the earliest of them may be tried again — one would only
// find them still backing off.
let warmNotBefore = 0;
let warmNotBeforeGeneration = -1;

export function warmLocationGeocodes(): Promise<void> {
  const current = publicCachesGeneration();
  if (warmGeneration === current) return Promise.resolve();
  if (warmNotBeforeGeneration === current && Date.now() < warmNotBefore) return Promise.resolve();
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
      const auditions = await cached(
        PUBLIC_CACHE_KEYS.auditions,
        PUBLIC_CACHE_TTL_MS.auditions,
        fetchPublishedAuditions,
      );
      // Online auditions are not geocoded: their town hall is stored with them.
      const grouped = groupByCanonical(auditions.filter((a) => !a.audition_en_ligne));
      // Whether the geocode cache gained an entry (coordinates, or a final no
      // match): only then does the cached map need building again. A lookup
      // that failed leaves no entry and backs off; the pass comes back when
      // the earliest of those may be tried again.
      let changed = false;
      let retryAt = Infinity;
      for (const canonical of grouped.keys()) {
        if (getCachedEntry(canonical) !== undefined) continue;
        await resolve(canonical);
        if (getCachedEntry(canonical) !== undefined) changed = true;
        else retryAt = Math.min(retryAt, backoffUntil(canonical) ?? Date.now());
      }
      if (retryAt === Infinity) {
        warmGeneration = generation;
      } else {
        warmNotBeforeGeneration = generation;
        warmNotBefore = retryAt;
      }
      // Newly geocoded locations only reach the client if the cached map
      // response is dropped — otherwise they wait out the full TTL, which is
      // longer than the client's entire polling window.
      if (changed) invalidate(PUBLIC_CACHE_KEYS.map);
    } catch {
      /* ignore — best-effort warm */
    } finally {
      warming = null;
    }
  })();
  return warming;
}
