import { type SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeLocation,
  type LocationGroup,
  type MapAudition,
  type PublicTestimony,
} from "@ac/shared";
import { adminClient, publicClient } from "../../lib/supabase";
import { hasServiceRole } from "../../config";
import { arrondissementFromCitycode } from "../geo/geocode";
import { FR_DEPARTMENTS, departementFromPostcode } from "./frDepartments";

// Imported, located citizen-participation events (data-ingestion → the
// `imported_auditions` table). Served in the SAME shapes the map already
// consumes — LocationGroup for the pins/drill, PublicTestimony for the place
// panel — so the frontend renders them with no rework.
//
// PAYLOAD DISCIPLINE: the report text is ~92% of this data (~3 MB across ~1.1k
// rows) and the map never renders it, so the map query does not even SELECT it.
// Text is fetched one audition at a time (see buildImportedTestimonies + the
// `?audition=` filter on the route). This is the same lesson as PR #16: never ship
// the whole corpus to draw pins.
//
// Read via the service-role client when available (so draft imports show up
// while the RGPD gate is still open — this is a preview/test surface);
// otherwise the anon client, which RLS limits to published rows.

interface BaseRow {
  id: string;
  title: string;
  held_on: string | null;
  address: string | null;
}
interface GroupRow extends BaseRow {
  city: string | null;
  postcode: string | null;
  citycode: string | null;
  lat: number | null;
  lng: number | null;
}
interface TestimonyRow extends BaseRow {
  testimony: string;
  topics: string[] | null;
}

// `imported_auditions` isn't in the generated Database types yet, so query
// through an untyped client and cast the rows.
const db = (hasServiceRole ? adminClient : publicClient) as unknown as SupabaseClient;

/**
 * The cache keys of the two imported reads (lib/cache.ts) and how long they
 * are served before a refill: the set is pre-baked and immutable, so long.
 */
export const IMPORTED_CACHE_KEYS = {
  map: "imported:map",
  testimonies: "imported:testimonies",
} as const;
export const IMPORTED_CACHE_TTL_MS = 300_000;

// Pins/drill: no `testimony`, no `topics` — keeps this payload ~440 KB not 3.7 MB.
const GROUP_COLUMNS = "id,title,held_on,address,city,postcode,citycode,lat,lng";
const TESTIMONY_COLUMNS = "id,title,held_on,address,testimony,topics";

/**
 * The place key for an imported row. Deliberately `normalizeLocation` and NOT
 * `getCanonicalLocation`: the latter applies the association's LOCATION_RULES
 * (Lyon-area keyword overrides), which would rewrite unrelated imported
 * addresses — "2 rue Jean Macé, Nîmes" → "Marché Jean Macé, Lyon 7". Plain
 * normalization is idempotent, so the client's canonicalisation of the same
 * string round-trips back to it and the panel finds its testimonies.
 */
function placeKey(r: BaseRow): string {
  return normalizeLocation(r.address || r.title);
}

async function fetchRows<T>(columns: string): Promise<T[]> {
  // PostgREST caps a response at 1000 rows and reports NO error when it does —
  // a bare select() just returned a short array, silently dropping imported
  // places from the map. Page explicitly (same pattern as modules/testimonies/routes.ts),
  // ordered by id so the pages are stable and can't repeat or skip a row.
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("imported_auditions")
      .select(columns)
      .not("lat", "is", null)
      .not("lng", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      // Migration not applied yet (table absent) → degrade to empty so the rest
      // of the map keeps working instead of 500-ing.
      if (/does not exist|schema cache|not find the table/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

export async function buildImportedGroups(): Promise<LocationGroup[]> {
  const rows = await fetchRows<GroupRow>(GROUP_COLUMNS);
  return rows.map((r) => {
    const depCode = departementFromPostcode(r.postcode);
    const dep = depCode ? FR_DEPARTMENTS[depCode] : undefined;
    // The map's view of an audition (title + date for the popup, the text is
    // fetched per audition when one is opened). `held_on` may be null; the map
    // treats a missing date as such.
    const audition = {
      id: r.id,
      title: r.title,
      date: r.held_on,
      location: placeKey(r),
      testimony_count: 1,
    } as MapAudition;

    return {
      canonicalName: placeKey(r),
      coordinates: [r.lat as number, r.lng as number],
      auditions: [audition],
      totalTestimonies: 1,
      city: r.city,
      citycode: r.citycode,
      // Paris/Lyon/Marseille: BAN gives the arrondissement INSEE code, and the
      // drill nests those under an `arr` node — decode it so imported places
      // land in the same node as the association's own.
      arrondissement: arrondissementFromCitycode(r.citycode),
      departementCode: depCode,
      departementName: dep?.name ?? null,
      region: dep?.region ?? null,
    } satisfies LocationGroup;
  });
}

/**
 * Every imported report as PublicTestimony. Cached server-side and filtered by
 * audition (or place) on the route — the full array is never sent to a browser.
 *
 * These are COLLECTIVE meeting reports, not one person's words, so they carry no
 * author name and no verification status — they never went through AC's
 * email-verification flow.
 */
export async function buildImportedTestimonies(): Promise<PublicTestimony[]> {
  const rows = await fetchRows<TestimonyRow>(TESTIMONY_COLUMNS);
  return rows.map((r) => ({
    id: r.id,
    person_name: "Compte-rendu de la réunion",
    person_info: "Grand Débat National 2019",
    content: r.testimony,
    topics: r.topics,
    verification_status: null,
    created_at: r.held_on,
    audition: {
      id: r.id,
      title: r.title,
      location: placeKey(r),
      date: r.held_on ?? "",
    },
  }));
}
