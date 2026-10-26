import {
  getCanonicalLocation,
  getKnownCoordinates,
  normalizeLocation,
  type Audition,
} from "@ac/shared";
import { hasServiceRole } from "../../config";
import { quoted } from "../../lib/paging";
import { invalidatePublicCaches } from "../../lib/publicCache";
import { adminClient } from "../../lib/supabase";
import { FR_GEO_RELEASE, frChain, PlaceError } from "./fr";
import { forgetGeoUnits, upsertGeoUnits } from "./geoUnits";
import { onlinePlaceOf } from "./lieu";
import {
  placeLieu,
  rulesHash,
  settleCandidates,
  storedCandidates,
  type PlaceColumns,
  type PlaceDeps,
  type Placement,
} from "./placeLieu";

// The re-placement job: places the auditions whose stored place is missing or
// out of date — `place_stale`: written by the old app (it writes `location`
// only), moved since, or created while the geocoder was slow — and settles
// the unplaced lieux whose same-named communes the lieux placed since now
// tell apart. It replaces the geocoder's read-time pass: a read never asks
// BAN any more.
//
// When: 10 s after boot, every 10 minutes, and 2 s after an admin writes an
// audition (debounced). One pass at a time. At boot, a rules pass first:
// LOCATION_RULES live in code, so a deploy that changes them leaves stored
// lieux computed under the old ones; those whose name or curated point the
// new rules change are made stale (and so placed again), the others stamped.
// Every write is guarded by the row's location: an edit landing meanwhile is
// never overwritten, and that row is placed on the next pass.

const PAGE_SIZE = 25;
const BOOT_DELAY_MS = 10_000;
const EVERY_MS = 10 * 60_000;
const AFTER_WRITE_MS = 2_000;
/** A read finding rows not placed yet nudges the job at most this often. */
const READ_NUDGE_MS = 60_000;
/** This many lookups in a row that could not be made: the upstream is down, the pass stops. */
const RETRY_STREAK = 3;
const BACKOFF_FIRST_MS = 30_000;

export interface PassReport {
  /** Rows placed on a point, or at an area. */
  placed: number;
  /** Rows on no point (generic text, no such place, same-named communes unsettled). */
  unplaced: number;
  /** Unplaced lieux whose same-named communes are now settled. */
  settled: number;
  /** Writes the database refused. */
  failed: number;
  /** Rows whose geocoder or commune API did not answer: tried again later. */
  retried: number;
  /** Rows edited meanwhile: placed on the next pass. */
  skipped: number;
  /** Rules pass: rows made stale (their lieu or curated point changed), and rows only stamped. */
  rulesStaled: number;
  rulesRestamped: number;
}

export interface PassOptions {
  /** Report what would be written, write nothing. */
  dryRun?: boolean;
  /** Run the rules pass. */
  rules?: boolean;
  /** Settle the unplaced lieux with same-named communes again. */
  candidates?: boolean;
  deps?: Partial<PlaceDeps>;
  log?: JobLogger;
}

interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const ROW =
  "id, location, audition_en_ligne, citycode, place, place_path, place_unit, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release, created_at";

type JobRow = Pick<
  Audition,
  | "id"
  | "location"
  | "audition_en_ligne"
  | "citycode"
  | "place"
  | "place_path"
  | "place_unit"
  | "locality_id"
  | "lieu_key"
  | "lat"
  | "lng"
  | "place_precision"
  | "place_candidates"
  | "placed_location"
  | "placed_rules"
  | "geo_release"
  | "created_at"
>;

const emptyReport = (): PassReport => ({
  placed: 0,
  unplaced: 0,
  settled: 0,
  failed: 0,
  retried: 0,
  skipped: 0,
  rulesStaled: 0,
  rulesRestamped: 0,
});

/** The rows after `last` in `created_at` (undated first), id order, as a PostgREST `or` filter. */
const afterCreated = (last: JobRow) =>
  last.created_at === null
    ? `created_at.not.is.null,and(created_at.is.null,id.gt.${last.id})`
    : `created_at.gt.${quoted(last.created_at)},and(created_at.eq.${quoted(last.created_at)},id.gt.${last.id})`;

class PassError extends Error {}

/** The write of one row's place, guarded: only if its location is still the one placed. */
async function writePlace(
  row: JobRow,
  columns: Partial<PlaceColumns>,
  report: PassReport,
  log: JobLogger | undefined,
): Promise<boolean> {
  const { error, count } = await adminClient
    .from("auditions")
    .update(columns, { count: "exact" })
    .eq("id", row.id)
    .eq("location", row.location);
  if (error) {
    // A unit believed written that is not there any more (a database reset).
    if (error.code === "23503") forgetGeoUnits();
    report.failed++;
    log?.error({ err: error, audition: row.id }, "placement: write refused");
    return false;
  }
  if (count === 0) {
    report.skipped++;
    return false;
  }
  return true;
}

/** Where a stale row goes; 'retry' when an upstream did not answer. */
async function placementOf(row: JobRow, deps: Partial<PlaceDeps>): Promise<Placement | "retry"> {
  const path = row.place_path;
  // Placed abroad (a gazetteer pick): the place stays, only the name follows the text.
  if (path && path[0] !== "FR" && row.place_unit && row.lat !== null) {
    return {
      units: [],
      columns: {
        place_unit: row.place_unit,
        place_path: path,
        locality_id: row.locality_id,
        lieu_key: row.audition_en_ligne ? row.location : normalizeLocation(row.location),
        lat: row.lat,
        lng: row.lng,
        place_precision: row.place_precision,
        place_candidates: row.place_candidates,
        placed_location: row.location,
        placed_rules: row.placed_rules,
        geo_release: row.geo_release,
      },
    };
  }
  if (row.audition_en_ligne) return placeOnline(row, deps);
  return placeLieu(row.location, { deps });
}

/** An online audition: its town hall's units, its stored point, its own label as lieu key. */
async function placeOnline(row: JobRow, deps: Partial<PlaceDeps>): Promise<Placement | "retry"> {
  const online = onlinePlaceOf(row);
  const unplaced: Placement = {
    units: [],
    columns: {
      place_unit: null,
      place_path: null,
      locality_id: null,
      lieu_key: row.location,
      lat: null,
      lng: null,
      place_precision: "unplaced",
      place_candidates: null,
      placed_location: row.location,
      placed_rules: null,
      geo_release: null,
    },
  };
  if (!online || !row.citycode) return unplaced;
  let chain;
  try {
    chain = await (deps.commune ?? frChain)(row.citycode);
  } catch (e) {
    if (e instanceof PlaceError && e.status === 503) return "retry";
    throw e;
  }
  if (!chain) return unplaced;
  return {
    units: chain.units,
    columns: {
      place_unit: chain.unit,
      place_path: chain.path,
      locality_id: chain.localityId,
      lieu_key: row.location,
      lat: online.lat,
      lng: online.lng,
      place_precision: "address",
      place_candidates: null,
      placed_location: row.location,
      placed_rules: null,
      geo_release: FR_GEO_RELEASE,
    },
  };
}

/** Places every stale row, oldest first. Stops early (returns true) when the upstreams are down. */
async function stalePass(opts: PassOptions, report: PassReport): Promise<boolean> {
  let last: JobRow | undefined;
  let streak = 0;
  for (;;) {
    const q = adminClient
      .from("auditions")
      .select(ROW)
      .eq("place_stale", true)
      .order("created_at", { ascending: true, nullsFirst: true })
      .order("id")
      .limit(PAGE_SIZE);
    const { data, error } = await (last ? q.or(afterCreated(last)) : q);
    if (error) throw new PassError(`stale rows: ${error.message}`);
    for (const row of data) {
      const placement = await placementOf(row, opts.deps ?? {});
      if (placement === "retry") {
        report.retried++;
        if (++streak >= RETRY_STREAK) return true;
        continue;
      }
      streak = 0;
      const kind = placement.columns.place_path ? "placed" : "unplaced";
      if (opts.dryRun) {
        report[kind]++;
        continue;
      }
      try {
        await upsertGeoUnits(placement.units);
      } catch (e) {
        report.failed++;
        opts.log?.error({ err: e, audition: row.id }, "placement: units not written");
        continue;
      }
      if (await writePlace(row, placement.columns, report, opts.log)) report[kind]++;
    }
    if (data.length < PAGE_SIZE) return false;
    last = data[data.length - 1];
  }
}

/** Same-named communes settled again, against the lieux placed since: no geocoder call. */
async function candidatePass(opts: PassOptions, report: PassReport): Promise<void> {
  let last: JobRow | undefined;
  for (;;) {
    const q = adminClient
      .from("auditions")
      .select(ROW)
      .eq("place_precision", "unplaced")
      .eq("place_stale", false)
      .eq("audition_en_ligne", false)
      .not("place_candidates", "is", null)
      .order("id")
      .limit(PAGE_SIZE);
    const { data, error } = await (last ? q.gt("id", last.id) : q);
    if (error) throw new PassError(`unplaced rows: ${error.message}`);
    for (const row of data) {
      const candidates = storedCandidates(row.place_candidates);
      if (!candidates?.length) continue;
      const key = row.lieu_key ?? getCanonicalLocation(row.location);
      const placement = await settleCandidates(row.location, key, candidates, opts.deps);
      if (placement === "retry") {
        report.retried++;
        continue;
      }
      if (!placement) continue;
      if (opts.dryRun) {
        report.settled++;
        continue;
      }
      try {
        await upsertGeoUnits(placement.units);
      } catch (e) {
        report.failed++;
        opts.log?.error({ err: e, audition: row.id }, "placement: units not written");
        continue;
      }
      if (await writePlace(row, placement.columns, report, opts.log)) report.settled++;
    }
    if (data.length < PAGE_SIZE) return;
    last = data[data.length - 1];
  }
}

const samePoint = (lat: number | null, lng: number | null, p: [number, number]) =>
  lat === p[0] && lng === p[1];

/**
 * The rules pass: the French offline rows placed under other LOCATION_RULES.
 * A row whose lieu name or curated point the current rules change is made
 * stale (placed_location NULL), so that the stale pass places it again; any
 * other is stamped with the current rules.
 */
async function rulesPass(opts: PassOptions, report: PassReport): Promise<void> {
  const hash = rulesHash();
  let last: Pick<JobRow, "id"> | undefined;
  for (;;) {
    const q = adminClient
      .from("auditions")
      .select(ROW)
      .eq("audition_en_ligne", false)
      .eq("place_stale", false)
      .not("placed_location", "is", null)
      .or(`placed_rules.is.null,placed_rules.neq.${hash}`)
      .order("id")
      .limit(PAGE_SIZE);
    const { data, error } = await (last ? q.gt("id", last.id) : q);
    if (error) throw new PassError(`rules: ${error.message}`);
    for (const row of data) {
      // Placed in France, or on no point; never a place picked abroad.
      const french = row.place_unit
        ? row.place_unit.startsWith("fr:")
        : row.place_precision === "unplaced";
      if (!french) continue;
      const key = getCanonicalLocation(row.location);
      const known = getKnownCoordinates(key);
      const moved = key !== row.lieu_key || (known !== null && !samePoint(row.lat, row.lng, known));
      if (opts.dryRun) {
        report[moved ? "rulesStaled" : "rulesRestamped"]++;
        continue;
      }
      const { error: werror, count } = await adminClient
        .from("auditions")
        .update(moved ? { placed_location: null } : { placed_rules: hash }, { count: "exact" })
        .eq("id", row.id)
        .eq("placed_location", row.placed_location!);
      if (werror) {
        report.failed++;
        opts.log?.error({ err: werror, audition: row.id }, "placement: rules write refused");
      } else if (count === 0) report.skipped++;
      else report[moved ? "rulesStaled" : "rulesRestamped"]++;
    }
    if (data.length < PAGE_SIZE) return;
    last = data[data.length - 1];
  }
}

/**
 * One pass: the rules pass (when asked), the stale rows, then the unplaced
 * lieux with same-named communes (when asked). `upstreamDown`: the pass
 * stopped early, the geocoder or the commune API not answering.
 */
export async function runPlacementPass(
  opts: PassOptions = {},
): Promise<PassReport & { upstreamDown: boolean }> {
  const report = emptyReport();
  if (opts.rules) await rulesPass(opts, report);
  const upstreamDown = await stalePass(opts, report);
  if (opts.candidates && !upstreamDown) await candidatePass(opts, report);
  const wrote = report.placed + report.unplaced + report.settled + report.rulesStaled > 0;
  if (wrote && !opts.dryRun) invalidatePublicCaches();
  return { ...report, upstreamDown };
}

// ---- Scheduling --------------------------------------------------------------

let log: JobLogger | undefined;
let started = false;
let running: Promise<unknown> | null = null;
/** What the pass after the running one must also do. */
let queued: { rules: boolean; candidates: boolean } | null = null;
let rulesDone = false;
let debounce: ReturnType<typeof setTimeout> | null = null;
let notBefore = 0;
let backoffMs = 0;
let lastReadNudge = 0;

function trigger(want: { rules?: boolean; candidates?: boolean }): void {
  if (!started) return;
  const next = {
    rules: Boolean(want.rules) || !rulesDone,
    candidates: Boolean(want.candidates),
  };
  if (running) {
    queued = {
      rules: (queued?.rules ?? false) || next.rules,
      candidates: (queued?.candidates ?? false) || next.candidates,
    };
    return;
  }
  const wait = notBefore - Date.now();
  if (wait > 0) {
    // Backing off: once, when it ends.
    schedule(wait, next.candidates);
    return;
  }
  track(runPlacementPass({ ...next, log }), next.rules);
}

/** The pass running now: one at a time, the queued one after it. */
function track(pass: Promise<PassReport & { upstreamDown: boolean }>, rules: boolean): void {
  running = pass
    .then((r) => {
      if (rules) rulesDone = true;
      if (r.upstreamDown) {
        backoffMs = Math.min(EVERY_MS, backoffMs ? backoffMs * 2 : BACKOFF_FIRST_MS);
        notBefore = Date.now() + backoffMs;
        log?.warn({ retryInMs: backoffMs }, "placement: geocoder or commune API not answering");
      } else backoffMs = 0;
      const counts = withoutFlag(r);
      if (Object.values(counts).some((n) => n > 0)) log?.info(counts, "placement pass");
    })
    .catch((err: unknown) => log?.error({ err }, "placement pass failed"))
    .finally(() => {
      running = null;
      if (queued) {
        const again = queued;
        queued = null;
        trigger(again);
      }
    });
}

function schedule(ms: number, candidates = false): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    trigger({ candidates });
  }, ms);
  debounce.unref?.();
}

/**
 * Start the job: a pass 10 s after boot (the rules pass first), then every 10
 * minutes. Without the service role nothing can be read or written: a
 * warning, and no job.
 */
export function startPlacementJob(logger: JobLogger): void {
  log = logger;
  if (!hasServiceRole) {
    logger.warn({}, "placement job off: SUPABASE_SERVICE_ROLE_KEY is not set");
    return;
  }
  started = true;
  schedule(BOOT_DELAY_MS);
  setInterval(() => trigger({ candidates: true }), EVERY_MS).unref();
}

/** An admin wrote an audition: a pass 2 s after the last such write. */
export function nudgePlacementJob(): void {
  if (started) schedule(AFTER_WRITE_MS);
}

/** A read found rows not placed yet (the old app's): a pass soon, at most once a minute. */
export function nudgePlacementJobFromRead(): void {
  const now = Date.now();
  if (!started || now - lastReadNudge < READ_NUDGE_MS) return;
  lastReadNudge = now;
  schedule(AFTER_WRITE_MS);
}

/**
 * A whole pass now, rules and unplaced lieux included, after the one running
 * — the cutover sweep. A dry run writes nothing and reports what would be.
 */
export async function sweepPlacements(dryRun: boolean): Promise<PassReport> {
  while (running) await running;
  const pass = runPlacementPass({ dryRun, rules: true, candidates: true, log });
  if (!dryRun) track(pass, true);
  return withoutFlag(await pass);
}

function withoutFlag(r: PassReport & { upstreamDown: boolean }): PassReport {
  const report: PassReport & { upstreamDown?: boolean } = { ...r };
  delete report.upstreamDown;
  return report;
}
