import { getKnownCoordinates } from "@ac/shared";
import {
  arrondissementFromCitycode,
  isHomonyms,
  locate,
  parseContext,
  type BanFeature,
  type BanQuery,
  type BanSearch,
  type Located,
} from "./match";

// The Base Adresse Nationale, asked: its /search/ and /reverse/ under a base
// URL (api-adresse.data.gouv.fr, or its successor data.geopf.fr/geocodage),
// and a lieu's lookup from their answers. No cache, no throttle and no
// configuration here: geocode.ts adds them for the API, the backfill
// generator (scripts/place-backfill) its own.

type Coords = [number, number];

/** BAN answered with an error status: 429 and 5xx are passing, another 4xx says the query itself is no good. */
export class BanError extends Error {
  constructor(
    public status: number,
    what: string,
  ) {
    super(`BAN ${what} ${status}`);
    this.name = "BanError";
  }
}

/** The BAN admin fields of the address nearest a point. */
export interface BanReverseHit {
  citycode: string | null;
  context: string | null;
  city: string | null;
}

export interface BanClient {
  /** Query BAN once. Throws on an HTTP error, so the caller can tell a refusal from a failure. */
  search: BanSearch;
  /** Reverse-geocode coordinates → the BAN admin fields of the nearest address. */
  reverse(coords: Coords): Promise<BanReverseHit | null>;
}

interface BanResponse {
  features?: {
    geometry: { coordinates: [number, number] };
    properties?: {
      score?: number;
      type?: string;
      name?: string;
      city?: string;
      citycode?: string;
      postcode?: string;
      context?: string;
      population?: number;
    };
  }[];
}

/** The BAN under `baseUrl` (no trailing slash); every call gives up after `timeoutMs`. */
export function banClient(baseUrl: string, timeoutMs: number): BanClient {
  return {
    async search(q: string, opts: BanQuery = {}): Promise<BanFeature[]> {
      const params = new URLSearchParams({ q, limit: String(opts.limit ?? 5) });
      if (opts.municipality) params.set("type", "municipality");
      if (opts.postcode) params.set("postcode", opts.postcode);
      const res = await fetch(`${baseUrl}/search/?${params}`, {
        headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new BanError(res.status, "search");
      const data = (await res.json()) as BanResponse;
      return (data.features ?? []).map((f) => {
        const p = f.properties ?? {};
        // BAN returns [lon, lat]; we store [lat, lon].
        const [lon, lat] = f.geometry.coordinates;
        return {
          coords: [lat, lon],
          score: p.score ?? 0,
          type: p.type ?? "",
          name: p.name ?? "",
          city: p.city ?? null,
          citycode: p.citycode ?? null,
          postcode: p.postcode ?? null,
          context: p.context ?? null,
          population: p.population ?? null,
        };
      });
    },
    async reverse([lat, lon]: Coords): Promise<BanReverseHit | null> {
      const res = await fetch(`${baseUrl}/reverse/?lat=${lat}&lon=${lon}`, {
        headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new BanError(res.status, "reverse");
      const data = (await res.json()) as {
        features?: { properties?: { context?: string; city?: string; citycode?: string } }[];
      };
      const p = data.features?.[0]?.properties;
      if (!p) return null;
      return { citycode: p.citycode ?? null, context: p.context ?? null, city: p.city ?? null };
    },
  };
}

/**
 * Where a canonical lieu name is, from BAN's answers (match.ts decides what
 * they mean). Throws what the BAN client throws (BanError, a timeout).
 */
export async function lookUpLieu(name: string, ban: BanClient): Promise<Located> {
  let entry = await locate(name, ban.search);

  // Curated locations (LOCATION_RULES coords): the forward search can match a
  // same-named street in the wrong arrondissement (e.g. "Parc Blandan" → Lyon
  // 1 instead of Lyon 7). Reverse-geocode the authoritative coordinates so the
  // arrondissement — and any missing admin area — matches the marker.
  const known = getKnownCoordinates(name);
  if (known) {
    try {
      const rev = await ban.reverse(known);
      if (rev) {
        const ctx = parseContext(rev.context);
        const arrondissement = arrondissementFromCitycode(rev.citycode);
        // The curated coordinates are authoritative, so the reverse-geocode of
        // them wins over the forward match (which may have landed in the wrong
        // commune — the very reason this override exists). Keep a forward field
        // only when reverse didn't return it.
        const forward = entry && !isHomonyms(entry) ? entry : null;
        entry = {
          coords: known,
          arrondissement,
          citycode: rev.citycode ?? forward?.citycode ?? null,
          city: rev.city ?? forward?.city ?? null,
          depCode: ctx.depCode ?? forward?.depCode ?? null,
          depName: ctx.depName ?? forward?.depName ?? null,
          region: ctx.region ?? forward?.region ?? null,
          level: "address",
        };
      }
    } catch {
      /* reverse failed — keep the forward-search entry */
    }
  }
  return entry;
}
