import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Administrative boundary geometry, sourced from open data and served to the
// map (outlines) + used for real centroids/extents.
//   - régions, départements → france-geojson (IGN-derived, simplified, open).
//   - communes + arrondissements municipaux → the official Géo API (precise).
// The endpoint is the single seam: today it reads these sources; later it can be
// swapped to a PostGIS-backed store + vector tiles without the frontend changing.

type LngLat = [number, number];
type Ring = LngLat[];
type Polygon = Ring[];
type Geometry =
  { type: "Polygon"; coordinates: Polygon } | { type: "MultiPolygon"; coordinates: Polygon[] };

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** One administrative unit's outline + derived centre/extent (centre = [lat,lng]). */
export interface BoundaryFeature {
  type: "Feature";
  geometry: Geometry;
  properties: { code: string; nom: string; center: LngLat; bounds: Bounds };
}

export interface BoundaryCollection {
  type: "FeatureCollection";
  features: BoundaryFeature[];
}

const FR_GEOJSON = "https://raw.githubusercontent.com/gregoiredavid/france-geojson/master";
const GEO_API = "https://geo.api.gouv.fr";
const UA = { "User-Agent": "AuditionsCitoyennes/1.0" };

function polygonsOf(geom: Geometry): Polygon[] {
  return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
}

function computeBounds(geom: Geometry): Bounds {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const poly of polygonsOf(geom)) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    }
  }
  return { minLat, maxLat, minLng, maxLng };
}

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

// Area-weighted centroid of the unit's largest polygon ring — a representative
// interior point for the pin (good enough for admin shapes; not pole-of-
// inaccessibility, which we can add later if a concave unit misplaces a pin).
function computeCenter(geom: Geometry): LngLat {
  let best: Ring | null = null;
  let bestArea = -1;
  for (const poly of polygonsOf(geom)) {
    const area = Math.abs(ringArea(poly[0]));
    if (area > bestArea) {
      bestArea = area;
      best = poly[0];
    }
  }
  if (!best || best.length < 3) {
    const b = computeBounds(geom);
    return [(b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2];
  }
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const f = best[j][0] * best[i][1] - best[i][0] * best[j][1];
    x += (best[j][0] + best[i][0]) * f;
    y += (best[j][1] + best[i][1]) * f;
    a += f;
  }
  a *= 0.5;
  if (!a) return [best[0][1], best[0][0]];
  return [y / (6 * a), x / (6 * a)]; // [lat, lng]
}

function enrich(feature: {
  geometry: Geometry;
  properties: Record<string, unknown>;
}): BoundaryFeature {
  const p = feature.properties;
  return {
    type: "Feature",
    geometry: feature.geometry,
    properties: {
      code: String(p.code ?? ""),
      nom: String(p.nom ?? ""),
      center: computeCenter(feature.geometry),
      bounds: computeBounds(feature.geometry),
    },
  };
}

// ---- Caching (régions/départements are static — keep on disk across restarts) ----
const CACHE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".boundaries-cache.json",
);
const memory = new Map<string, BoundaryCollection>();
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw) as Record<string, BoundaryCollection>;
    for (const [k, v] of Object.entries(obj)) memory.set(k, v);
  } catch {
    /* no cache yet */
  }
}

async function persist(): Promise<void> {
  const obj: Record<string, BoundaryCollection> = {};
  for (const [k, v] of memory) obj[k] = v;
  try {
    await writeFile(CACHE_FILE, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

async function fetchCollection(url: string): Promise<BoundaryCollection> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`boundary fetch ${res.status} for ${url}`);
  const fc = (await res.json()) as {
    features: { geometry: Geometry; properties: Record<string, unknown> }[];
  };
  return { type: "FeatureCollection", features: (fc.features ?? []).map(enrich) };
}

const LEVEL_URL: Record<string, string> = {
  regions: `${FR_GEOJSON}/regions-version-simplifiee.geojson`,
  departements: `${FR_GEOJSON}/departements-version-simplifiee.geojson`,
};

/** Régions / départements as one enriched FeatureCollection (cached). */
export async function getLevel(level: string): Promise<BoundaryCollection> {
  await load();
  const cached = memory.get(level);
  if (cached) return cached;
  const url = LEVEL_URL[level];
  if (!url) throw new Error(`unknown boundary level: ${level}`);
  const fc = await fetchCollection(url);
  memory.set(level, fc);
  await persist();
  return fc;
}

/** A single commune / arrondissement municipal by INSEE code (Géo API, precise). */
export async function getCommune(insee: string): Promise<BoundaryFeature> {
  await load();
  const key = `commune:${insee}`;
  const cached = memory.get(key);
  if (cached?.features[0]) return cached.features[0];
  const url = `${GEO_API}/communes/${encodeURIComponent(insee)}?fields=nom,code,contour&format=geojson&geometry=contour`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`commune fetch ${res.status} for ${insee}`);
  const feat = (await res.json()) as { geometry: Geometry; properties: Record<string, unknown> };
  const enriched = enrich(feat);
  memory.set(key, { type: "FeatureCollection", features: [enriched] });
  await persist();
  return enriched;
}
