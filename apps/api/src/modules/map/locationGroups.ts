import {
  getKnownCoordinates,
  type AuditionWithCount,
  type LocationGroup,
  type MapAudition,
} from "@ac/shared";
import { config, mapSource } from "../../config";
import { cachedPublishedAuditions, onlinePlaceOf, placeKeyOf } from "../auditions/service";
import {
  backoffUntil,
  getCachedEntry,
  loadGeocodeCache,
  placeLieux,
  resolve,
} from "../geo/geocode";
import type { GeoEntry } from "../geo/match";
import { readGeoUnits } from "../places/geoUnits";
import { groupsFromRows, storedPlacementOf } from "../places/groups";
import { nudgePlacementJobFromRead } from "../places/placementJob";
import { legacyCache, PUBLIC_CACHE_KEYS, publicCachesGeneration } from "../../lib/publicCache";

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

/** Where /api/map's groups come from: the stored places, or the geocode cache (see config MAP_SOURCE). */
export type MapSource = "db" | "geocoder";

/** The build a request asks for: MAP_SOURCE's, or — testing tools only — the geocoder's (?source=geocoder). */
export function requestedSource(query: { source?: unknown }): MapSource {
  return config.TEST_TOOLS && query.source === "geocoder" ? "geocoder" : mapSource;
}

interface MapLogger {
  warn(obj: object, msg: string): void;
}
const consoleLog: MapLogger = { warn: (obj, msg) => console.warn(msg, obj) };

/** /api/map's groups, from `source` (MAP_SOURCE by default). */
export function buildLocationGroups(
  source: MapSource = mapSource,
  log?: MapLogger,
): Promise<LocationGroup[]> {
  return source === "db" ? buildFromStoredPlaces(log) : buildFromGeocoder();
}

/**
 * The groups from the places stored on the rows (map phase 1): no geocoder
 * call, no geocode cache — but for the rows not placed yet (the old app's,
 * moved since), filed as the geocoder files them, from its cache, until the
 * placement job places them (nudged here). When the stored places cannot be
 * read (geo_units missing — a database the place migration has not reached
 * yet — or the service role refused), the geocoder's build, logged.
 */
async function buildFromStoredPlaces(log?: MapLogger): Promise<LocationGroup[]> {
  const auditions = await cachedPublishedAuditions();
  let units;
  try {
    units = await readGeoUnits(auditions.map((a) => a.place_path));
  } catch (err) {
    (log ?? consoleLog).warn(
      { err },
      "map: stored places not readable, the geocoder builds the map meanwhile",
    );
    void warmLocationGeocodes();
    return buildFromGeocoder();
  }
  const offline = auditions.filter((a) => !onlinePlaceOf(a));
  let fallback = new Map<string, GeoEntry | null>();
  if (offline.some((a) => storedPlacementOf(a, units).kind === "stale")) {
    nudgePlacementJobFromRead();
    await loadGeocodeCache();
    // Settled against every lieu of the map, as the geocoder build does.
    fallback = placeLieux(new Set(offline.map(placeKeyOf)));
  }
  return groupsFromRows(auditions, units, fallback);
}

/** Build map groups from known coords + the cached geocode entries (no
 *  network). Prefers hardcoded rule coordinates for precise markers, and
 *  attaches the administrative area from the cached BAN entry. The build
 *  before map phase 1 (MAP_SOURCE=geocoder, or no service role). */
async function buildFromGeocoder(): Promise<LocationGroup[]> {
  // The persisted geocode entries, before reading them: the first map after a
  // boot was otherwise built from an empty cache — and cached, pins missing.
  await loadGeocodeCache();
  // Through the same cache as /api/auditions and the warm pass: one Supabase
  // pull for the three, and one invalidation (invalidatePublicCaches) for all.
  const auditions = await cachedPublishedAuditions();
  const grouped = groupByCanonical(auditions);
  // Every geocoded lieu at once: a same-named commune is settled against the
  // others (the Saint-Denis where the association already is, if it is).
  const placed = placeLieux(
    [...grouped].filter(([, list]) => !onlinePlaceOf(list[0])).map(([canonical]) => canonical),
  );
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
    const entry = placed.get(canonical) ?? null;
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
// The geocoder build's (MAP_SOURCE=geocoder): from stored places, the
// placement job does this when an audition is written, never a read.
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
      const auditions = await cachedPublishedAuditions();
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
      if (changed) legacyCache.delete(PUBLIC_CACHE_KEYS.map, PUBLIC_CACHE_KEYS.mapGeocoder);
    } catch {
      /* ignore — best-effort warm */
    } finally {
      warming = null;
    }
  })();
  return warming;
}
