/*
 * Auditions Citoyennes — data ingestion pipeline
 * Copyright (C) 2026 Auditions Citoyennes
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed WITHOUT ANY WARRANTY;
 * see the GNU Affero General Public License for more details:
 * <https://www.gnu.org/licenses/>.
 */
import { fetchWithRetry, RateLimiter } from "./http.js";
import { GEOCODE_PRECISIONS } from "./schema.js";

// Historical BAN endpoint, with the Géoplateforme successor (same API contract,
// same operator) as fallback in case the legacy domain is retired.
const BAN_ENDPOINTS = [
  "https://api-adresse.data.gouv.fr/search/",
  "https://data.geopf.fr/geocodage/search",
];
let endpointIndex = 0;

export interface BanHit {
  lat: number;
  lng: number;
  type: string; // housenumber | street | locality | municipality
  score: number;
  label: string;
  name: string | null;
  housenumber: string | null;
  street: string | null;
  postcode: string | null;
  city: string | null;
}

type Precision = (typeof GEOCODE_PRECISIONS)[number];

/** Maps a BAN result type onto the normalized geocode_precision enum. */
export function banTypeToPrecision(type: string | null | undefined): Precision {
  switch (type) {
    case "housenumber":
      return "housenumber";
    case "street":
      return "street";
    // BAN "locality" = named place / lieu-dit — closest to a venue.
    case "locality":
      return "venue";
    case "municipality":
      return "municipality";
    default:
      return "unknown";
  }
}

interface BanFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    type?: string;
    score?: number;
    label?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    postcode?: string;
    city?: string;
  };
}

export async function geocodeBan(query: string, limiter: RateLimiter): Promise<BanHit | null> {
  await limiter.take();
  const q = query.trim().replace(/\s+/g, " ").slice(0, 200);
  if (q.length < 3) return null;
  for (let i = endpointIndex; i < BAN_ENDPOINTS.length; i++) {
    const url = `${BAN_ENDPOINTS[i]}?q=${encodeURIComponent(q)}&limit=1`;
    try {
      const res = await fetchWithRetry(url, {}, { retries: 2 });
      if (!res.ok) {
        if (res.status === 400) return null; // query BAN cannot handle (e.g. digits only)
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { features?: BanFeature[] };
      endpointIndex = i; // stick with the endpoint that worked
      const f = body.features?.[0];
      const coords = f?.geometry?.coordinates;
      if (!f || !coords) return null;
      const p = f.properties ?? {};
      return {
        lng: coords[0],
        lat: coords[1],
        type: p.type ?? "unknown",
        score: p.score ?? 0,
        label: p.label ?? "",
        name: p.name ?? null,
        housenumber: p.housenumber ?? null,
        street: p.street ?? p.name ?? null,
        postcode: p.postcode ?? null,
        city: p.city ?? null,
      };
    } catch (err) {
      if (i === BAN_ENDPOINTS.length - 1) throw err;
      console.warn(`BAN endpoint ${BAN_ENDPOINTS[i]} failed (${String(err)}), trying fallback`);
    }
  }
  return null;
}
