import { getKnownCoordinates } from "@ac/shared";
import { z } from "zod";
import { upstreamFetch } from "../../lib/cappedFetch";
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
//
// An answer is read within lib/cappedFetch.ts's limit, never through a
// redirect, and checked before anything is made of it: what it says ends up
// on auditions and in geo_units, where nothing corrects it afterwards. A
// feature that is not what the BAN documents — a point outside the globe, a
// code that is no INSEE code, a name of several lines or pages — is left
// out, as if the BAN had not returned it; an answer none of whose features
// can be read is a failed call (BanAnswerError), not "no such place".

/** One line of text: no control character, no line or paragraph separator. */
const ONE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;

/** A line of at most `max` characters. */
export const lineOf = (max: number) => z.string().max(max).regex(ONE_LINE);

/** A name as stored and shown (a commune, a département, a région): one line, 1 to 100 characters. */
export const placeName = lineOf(100).min(1);

/** An INSEE commune code: five digits, or 2A/2B and three digits in Corsica. */
export const inseeCode = z.string().regex(/^(?:\d{2}|2[AB])\d{3}$/);

/** A GeoJSON position, [longitude, latitude], on the globe. */
export const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

const searchFeature = z.object({
  geometry: z.object({ coordinates: lngLat }),
  properties: z
    .object({
      score: z.number().nullish(),
      type: lineOf(40).nullish(),
      name: lineOf(200).nullish(),
      city: placeName.nullish(),
      citycode: inseeCode.nullish(),
      postcode: z
        .string()
        .regex(/^\d{5}$/)
        .nullish(),
      context: lineOf(200).nullish(),
      population: z.number().nullish(),
    })
    .nullish(),
});

const reverseProperties = z.object({
  citycode: inseeCode.nullish(),
  context: lineOf(200).nullish(),
  city: placeName.nullish(),
});

/** The features of an answer, as given: an answer without a list of them has none. */
function featuresOf(data: unknown): unknown[] {
  const features = (data as { features?: unknown } | null)?.features;
  return Array.isArray(features) ? features : [];
}

const banFetch = upstreamFetch();

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

/** BAN answered features, none of them readable: not an answer to keep, the call is to make again. */
export class BanAnswerError extends Error {
  constructor(what: string) {
    super(`BAN ${what}: answer refused`);
    this.name = "BanAnswerError";
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

/** The BAN under `baseUrl` (no trailing slash); every call gives up after `timeoutMs`. */
export function banClient(baseUrl: string, timeoutMs: number): BanClient {
  return {
    async search(q: string, opts: BanQuery = {}): Promise<BanFeature[]> {
      const params = new URLSearchParams({ q, limit: String(opts.limit ?? 5) });
      if (opts.municipality) params.set("type", "municipality");
      if (opts.postcode) params.set("postcode", opts.postcode);
      const res = await banFetch(`${baseUrl}/search/?${params}`, {
        headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new BanError(res.status, "search");
      const given = featuresOf(await res.json());
      const features = given.flatMap((feature): BanFeature[] => {
        const parsed = searchFeature.safeParse(feature);
        if (!parsed.success) return [];
        const p = parsed.data.properties ?? {};
        // BAN returns [lon, lat]; we store [lat, lon].
        const [lon, lat] = parsed.data.geometry.coordinates;
        return [
          {
            coords: [lat, lon],
            score: p.score ?? 0,
            type: p.type ?? "",
            name: p.name ?? "",
            city: p.city ?? null,
            citycode: p.citycode ?? null,
            postcode: p.postcode ?? null,
            context: p.context ?? null,
            population: p.population ?? null,
          },
        ];
      });
      if (given.length > 0 && features.length === 0) throw new BanAnswerError("search");
      return features;
    },
    async reverse([lat, lon]: Coords): Promise<BanReverseHit | null> {
      const res = await banFetch(`${baseUrl}/reverse/?lat=${lat}&lon=${lon}`, {
        headers: { "User-Agent": "AuditionsCitoyennes/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new BanError(res.status, "reverse");
      const [nearest] = featuresOf(await res.json());
      const parsed = reverseProperties.safeParse(
        (nearest as { properties?: unknown } | null | undefined)?.properties,
      );
      if (!parsed.success) return null;
      const p = parsed.data;
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
