// What the backfill writes on each audition read from the target: the API's
// own placement code (apps/api/src/modules/places), text only — no admin
// pick, no reuse of rows already placed — so the backfilled rows are what the
// API would have written.
//
//   - Offline rows: one placement per lieu key (getCanonicalLocation), for
//     every raw spelling of it. Same-named communes are settled at the end,
//     against the plan's own published offline lieux placed without them (as
//     placement_support() counts stored rows, as the geocoder's map build
//     settled them over every lieu of the map).
//   - Online rows: per town hall code, its units (geo.api); each month keeps
//     the point it stored (the UPDATE reads place.lat/lng), a month without
//     one is on no point — as the placement job files them (placeOnline).

import {
  getCanonicalLocation,
  getKnownCoordinates,
  isGenericLocation,
  normalizeLocation,
  type Json,
  type PlaceCandidate,
} from "@ac/shared";
import { isHomonyms } from "../../apps/api/src/modules/geo/match";
import { PlaceError, type GeoUnitWrite } from "../../apps/api/src/modules/places/fr";
import { onlinePlaceOf } from "../../apps/api/src/modules/places/lieu";
import {
  placeLieu,
  placeOnline,
  rulesHash,
  settleCandidates,
  unplaced,
  type PlaceDeps,
  type Placement,
} from "../../apps/api/src/modules/places/placeLieu";
import type { Backfill, BackfillValue } from "./sql";

/** An audition as the publishable key reads it. */
export interface SourceRow {
  id: string;
  title: string;
  date: string;
  location: string;
  status: string | null;
  audition_en_ligne: boolean;
  citycode: string | null;
  place: Json | null;
  created_at: string | null;
}

/** What the review calls a lieu's outcome. */
export type LieuClass =
  "address" | "commune" | "departement" | "region" | "homonym" | "unplaced" | "generic" | "online";

export interface PlannedLieu {
  online: boolean;
  /** Offline: the lieu key (canonical name). Online: the town hall code. */
  key: string;
  /** Offline: the raw spellings the UPDATE matches. Online: the labels of its months. */
  locations: string[];
  rows: SourceRow[];
  /** Offline: the lieu's. Online: what the newest month with a point gets (else the newest month). */
  placement: Placement;
  /** Online: the town hall's units and precision, for every month (each at its own point). */
  hall?: Placement;
  klass: LieuClass;
  /** Online: the months whose stored point is not the newest's (each keeps its own). */
  otherPoints?: SourceRow[];
  /** Online: the months with no point of their own (on no point). */
  pointless?: SourceRow[];
  /** Same-named communes: the unit they were settled on (null: not settled). */
  settledOn?: string | null;
}

export interface Plan {
  /** placed_rules of the offline rows: the LOCATION_RULES hash. */
  rules: string;
  lieux: PlannedLieu[];
  /** Every unit the placements reference, ancestors first. */
  units: GeoUnitWrite[];
  /** Per département code, the lieux that settle same-named communes. */
  support: Map<string, number>;
}

/** What the plan asks of the outside world: BAN and the commune API. */
export type PlanDeps = Pick<PlaceDeps, "locate" | "commune" | "departement" | "region">;

export interface PlanOptions {
  /** An upstream that did not answer is asked again after each of these waits (ms), then the run stops. */
  retryWaits?: number[];
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asked again while an upstream does not answer; past the waits, the run stops (nothing written). */
async function answered<T>(
  what: string,
  attempt: () => Promise<T | "retry">,
  opts: PlanOptions,
): Promise<T> {
  const waits = opts.retryWaits ?? [2_000, 10_000, 30_000];
  for (let i = 0; ; i++) {
    const r = await attempt();
    if (r !== "retry") return r;
    if (i >= waits.length) {
      throw new Error(
        `${what}: the geocoder or the commune API did not answer (${i + 1} tries). Nothing was written; run it again later.`,
      );
    }
    opts.log?.(`  ${what}: no answer, again in ${waits[i] / 1000} s`);
    await sleep(waits[i]);
  }
}

/** placeOnline needs a point to place a month; the town hall's units and precision do not depend on it. */
const STAND_IN: Json = { lat: 0, lng: 0 };

/**
 * Before anything is placed: BAN finds Lyon and geo.api knows its code. A
 * wrong --ban, a retired service or a geocoder answering nothing would
 * otherwise file every lieu on no point, for good.
 */
export async function checkUpstreams(deps: PlanDeps, opts: PlanOptions = {}): Promise<void> {
  const lyon = await answered("Lyon (canary)", () => deps.locate("Lyon"), opts);
  if (!lyon || isHomonyms(lyon) || lyon.citycode !== "69123") {
    throw new Error(
      "The geocoder does not place Lyon in 69123: is --ban right? Nothing was written.",
    );
  }
  const chain = await answered(
    "69123 (canary)",
    async () => {
      try {
        return await deps.commune("69123");
      } catch (e) {
        if (e instanceof PlaceError && e.status === 503) return "retry";
        throw e;
      }
    },
    opts,
  );
  if (chain?.localityId !== "fr:com:69123") {
    throw new Error("geo.api.gouv.fr does not know Lyon (69123). Nothing was written.");
  }
}

const newestFirst = (a: SourceRow, b: SourceRow) =>
  b.date.localeCompare(a.date) ||
  (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
  a.id.localeCompare(b.id);

/** The département of a placed path (fr:dep:<code>), as placement_support() reads it. */
export const departementOf = (path: readonly string[] | null) =>
  path?.find((id) => id.startsWith("fr:dep:"))?.slice("fr:dep:".length) ?? null;

export function classOf(lieu: Pick<PlannedLieu, "online" | "key" | "placement">): LieuClass {
  if (lieu.online) return "online";
  const c = lieu.placement.columns;
  if (c.place_candidates) return "homonym";
  if (c.place_path) return c.place_precision as LieuClass;
  return isGenericLocation(lieu.key) ? "generic" : "unplaced";
}

/** Every unit once, ancestors before descendants, then by id. */
export function orderUnits(units: GeoUnitWrite[]): GeoUnitWrite[] {
  const byId = new Map<string, GeoUnitWrite>();
  for (const u of units) if (!byId.has(u.id)) byId.set(u.id, u);
  const depth = (u: GeoUnitWrite): number => {
    const parent = u.parent_id ? byId.get(u.parent_id) : undefined;
    return parent ? depth(parent) + 1 : 0;
  };
  return [...byId.values()].sort((a, b) => depth(a) - depth(b) || a.id.localeCompare(b.id));
}

/**
 * The plan for these rows: every offline lieu and town hall placed (or on
 * no point), with the units they need. Throws when an upstream keeps not
 * answering — a lieu is never left out silently.
 */
export async function buildPlan(
  rows: SourceRow[],
  deps: PlanDeps,
  opts: PlanOptions = {},
): Promise<Plan> {
  // Every member given: none of defaultPlaceDeps (the API's database and
  // geocoder) is ever reached from here.
  const placeDeps: PlaceDeps = {
    ...deps,
    // The plan's own lieux, not the target's stored places: nothing is reused,
    // and same-named communes are settled below, against the plan.
    reuse: async () => null,
    support: async () => {
      throw new Error("same-named communes are settled against the plan");
    },
  };
  const lieux: PlannedLieu[] = [];

  const offline = new Map<string, SourceRow[]>();
  for (const row of rows.filter((r) => !r.audition_en_ligne)) {
    const key = getCanonicalLocation(row.location);
    offline.set(key, [...(offline.get(key) ?? []), row]);
  }
  const deferred: { lieu: PlannedLieu; candidates: PlaceCandidate[] }[] = [];
  for (const [key, list] of [...offline].sort(([a], [b]) => a.localeCompare(b, "fr"))) {
    opts.log?.(`  ${key}`);
    const placement = await answered(
      key,
      () => placeLieu(list[0].location, { deps: placeDeps, settle: false }),
      opts,
    );
    const lieu: PlannedLieu = {
      online: false,
      key,
      locations: [...new Set(list.map((r) => r.location))].sort(),
      rows: list,
      placement,
      klass: "unplaced",
    };
    if (placement.homonyms) deferred.push({ lieu, candidates: placement.homonyms });
    lieux.push(lieu);
  }

  // Support: the published offline lieux placed without same-named communes, per département.
  const support = new Map<string, number>();
  for (const lieu of lieux) {
    const c = lieu.placement.columns;
    const dep = departementOf(c.place_path ?? null);
    if (!dep || c.place_candidates || !lieu.rows.some((r) => r.status === "published")) continue;
    support.set(dep, (support.get(dep) ?? 0) + 1);
  }
  for (const { lieu, candidates } of deferred) {
    const settled = await answered(
      lieu.key,
      () =>
        settleCandidates(lieu.rows[0].location, lieu.key, candidates, {
          ...placeDeps,
          support: async () => support,
        }),
      opts,
    );
    lieu.placement = settled ?? unplaced(lieu.rows[0].location, lieu.key, candidates);
    lieu.settledOn = settled?.columns.place_unit ?? null;
  }

  const online = new Map<string, SourceRow[]>();
  for (const row of rows.filter((r) => r.audition_en_ligne)) {
    // A CHECK keeps an online row's code; one without would be the sweep's.
    if (!row.citycode) continue;
    online.set(row.citycode, [...(online.get(row.citycode) ?? []), row]);
  }
  for (const [citycode, list] of [...online].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort(newestFirst);
    const shown = list.find((r) => onlinePlaceOf(r)) ?? list[0];
    opts.log?.(`  ${citycode} (${shown.location})`);
    const hall = await answered(
      citycode,
      () => placeOnline({ ...shown, place: STAND_IN }, placeDeps),
      opts,
    );
    const placement = await answered(citycode, () => placeOnline(shown, placeDeps), opts);
    const point = onlinePlaceOf(shown);
    const pointless = list.filter((r) => !onlinePlaceOf(r));
    const otherPoints = list.filter((r) => {
      const p = onlinePlaceOf(r);
      return point && p && (p.lat !== point.lat || p.lng !== point.lng);
    });
    lieux.push({
      online: true,
      key: citycode,
      locations: [...new Set(list.map((r) => r.location))].sort(),
      rows: list,
      placement,
      hall,
      klass: "online",
      ...(otherPoints.length ? { otherPoints } : {}),
      ...(pointless.length ? { pointless } : {}),
    });
  }

  for (const lieu of lieux) lieu.klass = classOf(lieu);
  return {
    rules: rulesHash(),
    lieux,
    units: orderUnits(lieux.flatMap((l) => (l.hall ?? l.placement).units)),
    support,
  };
}

/**
 * Why the plan looks like a geocoder answering wrongly — most offline lieux
 * (generic texts aside) on no point, which passes the canary only by luck —
 * or null when it does not.
 */
export function mostlyNowhere(plan: Plan): string | null {
  const offline = plan.lieux.filter((l) => !l.online && l.klass !== "generic");
  const nowhere = offline.filter((l) => !l.placement.columns.place_path).length;
  return offline.length >= 4 && nowhere * 2 > offline.length
    ? `${nowhere} of ${offline.length} offline lieux land on no point: the geocoder may be answering wrongly.`
    : null;
}

/** Whether a LOCATION_RULES keyword rule files a raw spelling under another lieu name than its own. */
export const ruleCollapses = (location: string) =>
  getCanonicalLocation(location).toLowerCase() !== normalizeLocation(location).toLowerCase();

/** A lieu's curated point (LOCATION_RULES), if it has one. */
export const curatedPoint = (key: string) => getKnownCoordinates(key);

/**
 * The plan as the SQL writes it: one value per offline spelling, one per town
 * hall (its units, no point: each month's own is read from its row).
 */
export function backfillOf(
  plan: Plan,
  meta: Pick<Backfill, "version" | "generated" | "source">,
): Backfill {
  const values: BackfillValue[] = [];
  for (const l of plan.lieux) {
    const c = (l.hall ?? l.placement).columns;
    if (c.placed_rules !== (l.online ? null : plan.rules)) {
      throw new Error(`${l.key}: placed under rules ${c.placed_rules}, not ${plan.rules}`);
    }
    const place = {
      unit: c.place_unit,
      path: c.place_path,
      locality: c.locality_id,
      lat: c.lat,
      lng: c.lng,
      precision: c.place_precision ?? "unplaced",
      candidates: c.place_candidates,
      release: c.geo_release,
    };
    if (l.online) {
      values.push({
        online: true,
        location: l.rows[0].location,
        citycode: l.key,
        key: null,
        ...place,
        lat: null,
        lng: null,
      });
      continue;
    }
    for (const location of l.locations) {
      values.push({ online: false, location, citycode: null, key: c.lieu_key, ...place });
    }
  }
  return {
    ...meta,
    rules: plan.rules,
    units: plan.units.map((u) => ({ ...u })),
    values,
  };
}
