import {
  getCanonicalLocation,
  getKnownCoordinates,
  type Audition,
  type PlaceCandidate,
} from "@ac/shared";
import { config, hasServiceRole, isDev, localDatabase, mapSource } from "../../config";
import { quoted } from "../../lib/paging";
import { invalidatePublicCaches } from "../../lib/publicCache";
import { adminClient } from "../../lib/supabase";
import { backoffUntil } from "../geo/geocode";
import { FR_GEO_RELEASE, frChain, PlaceError } from "./fr";
import { forgetGeoUnits, upsertGeoUnits } from "./geoUnits";
import { onlinePlaceOf } from "./lieu";
import {
  defaultPlaceDeps,
  keepPlacedAbroad,
  placeLieu,
  rulesHash,
  settleCandidates,
  storedCandidates,
  unplaced,
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
// audition (debounced). One pass at a time. Opt-in (PLACEMENT_JOB): a
// database is placed for the first time by its reviewed backfill or the
// sweep below, dry run first. At boot, a rules pass first: LOCATION_RULES
// live in code, so a deploy that changes them leaves stored lieux computed
// under the old ones; those whose name or curated point the new rules change
// are made stale (and so placed again), the others stamped. Every write is
// guarded by the row's location: an edit landing meanwhile is never
// overwritten, and that row is placed on the next pass.
//
// Same-named communes are settled at the end of a pass, against every lieu
// the pass placed: a pass over many rows (a first run, the cutover sweep, a
// rules change) settles them as the geocoder's whole-map build did, not
// against the rows older than each one.

const PAGE_SIZE = 25;
/** The rules pass reads and stamps this many rows at a time (no upstream call per row). */
const RULES_PAGE_SIZE = 100;
const BOOT_DELAY_MS = 10_000;
const EVERY_MS = 10 * 60_000;
const AFTER_WRITE_MS = 2_000;
/** A read finding rows not placed yet nudges the job at most this often. */
const READ_NUDGE_MS = 60_000;
/**
 * This many lookups in a row failed, for lieux never seen failing before:
 * the upstream is down. The rest of the pass makes no upstream call (what
 * the caches and the stored lieux place is placed), and the job backs off.
 */
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
  /** Report what would be written, write nothing (same-named communes: settled against the support already stored). */
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

type Counter = "placed" | "unplaced" | "settled";

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

/**
 * The lieux (canonical names; online town halls by code) whose last
 * placement could not be made, across passes: one failing again does not
 * count towards an outage — a few names BAN keeps failing must not hold
 * every newer row back. Forgotten once placed.
 */
const failing = new Set<string>();

const failKey = (row: JobRow) =>
  row.audition_en_ligne ? `online:${row.citycode}` : getCanonicalLocation(row.location);

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

/** A placement stored: its units, then the row (counted under `counter`, or by what it is). */
async function store(
  row: JobRow,
  placement: Placement,
  opts: PassOptions,
  report: PassReport,
  counter?: Counter,
): Promise<void> {
  const kind: Counter = counter ?? (placement.columns.place_path ? "placed" : "unplaced");
  if (opts.dryRun) {
    report[kind]++;
    return;
  }
  try {
    await upsertGeoUnits(placement.units);
  } catch (e) {
    report.failed++;
    opts.log?.error({ err: e, audition: row.id }, "placement: units not written");
    return;
  }
  if (await writePlace(row, placement.columns, report, opts.log)) report[kind]++;
}

const FAILED = Symbol("failed");

/** A row whose placement threw (a bug, not an upstream down): counted and logged, the pass goes on. */
async function orFailed<T>(
  work: Promise<T>,
  row: JobRow,
  report: PassReport,
  log: JobLogger | undefined,
): Promise<T | typeof FAILED> {
  try {
    return await work;
  } catch (err) {
    report.failed++;
    log?.error({ err, audition: row.id }, "placement: failed");
    return FAILED;
  }
}

/** placement_support(), read once for the pass: settling a homonym never changes it. */
function supportOnce(deps: Partial<PlaceDeps> = {}): PlaceDeps["support"] {
  let support: ReturnType<PlaceDeps["support"]> | null = null;
  return () => (support ??= (deps.support ?? defaultPlaceDeps.support)());
}

/**
 * Where a stale row goes; 'retry' when an upstream did not answer (or, with
 * `cachedOnly`, was not to be asked). Same-named communes come back
 * unsettled, with `homonyms`.
 */
async function placementOf(
  row: JobRow,
  deps: Partial<PlaceDeps>,
  cachedOnly: boolean,
): Promise<Placement | "retry"> {
  // Placed abroad (a gazetteer pick): the place stays, only the name follows the text.
  const abroad = keepPlacedAbroad(row);
  if (abroad) return abroad;
  if (row.audition_en_ligne) return placeOnline(row, deps, cachedOnly);
  return placeLieu(row.location, { deps, settle: false, cachedOnly });
}

/** An online audition: its town hall's units, its stored point, its own label as lieu key. */
async function placeOnline(
  row: JobRow,
  deps: Partial<PlaceDeps>,
  cachedOnly: boolean,
): Promise<Placement | "retry"> {
  const online = onlinePlaceOf(row);
  const none: Placement = {
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
  if (!online || !row.citycode) return none;
  let chain;
  try {
    chain = await (deps.commune ?? frChain)(row.citycode, { cachedOnly });
  } catch (e) {
    if (e instanceof PlaceError && e.status === 503) return "retry";
    throw e;
  }
  if (!chain) return none;
  return {
    units: chain.units,
    columns: {
      place_unit: chain.unit,
      place_path: chain.path,
      locality_id: chain.localityId,
      lieu_key: row.location,
      lat: online.lat,
      lng: online.lng,
      // As the online form files it (resolveTownHall): the town hall's own
      // point, or the commune's centre where geo.api has no town hall.
      place_precision: chain.mairie ? "address" : "commune",
      place_candidates: null,
      placed_location: row.location,
      placed_rules: null,
      geo_release: FR_GEO_RELEASE,
    },
  };
}

/** A lieu among same-named communes, waiting for the end of the pass: its rows. */
interface Deferred {
  candidates: PlaceCandidate[];
  rows: JobRow[];
}

/**
 * Places every stale row, oldest first. Returns true when the upstreams
 * looked down (a streak of fresh failures): the rest of that pass made no
 * upstream call.
 */
async function stalePass(opts: PassOptions, report: PassReport): Promise<boolean> {
  const deps = opts.deps ?? {};
  let last: JobRow | undefined;
  let streak = 0;
  let down = false;
  // By lieu key: settled once every other row of the pass is placed.
  const deferred = new Map<string, Deferred>();
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
      const key = failKey(row);
      // Its lieu already waits among same-named communes: so does it (no lookup).
      const waiting =
        row.audition_en_ligne || keepPlacedAbroad(row) ? undefined : deferred.get(key);
      if (waiting) {
        waiting.rows.push(row);
        continue;
      }
      // Failed before, or still backing off in the geocoder (no call made).
      const knownToFail =
        failing.has(key) || (!row.audition_en_ligne && backoffUntil(key) !== undefined);
      const placement = await orFailed(placementOf(row, deps, down), row, report, opts.log);
      if (placement === FAILED) continue;
      if (placement === "retry") {
        report.retried++;
        if (down) continue; // not asked: nothing failed
        failing.add(key);
        if (!knownToFail && ++streak >= RETRY_STREAK) down = true;
        continue;
      }
      failing.delete(key);
      streak = 0;
      if (placement.homonyms) {
        deferred.set(key, { candidates: placement.homonyms, rows: [row] });
        continue;
      }
      await store(row, placement, opts, report);
    }
    if (data.length < PAGE_SIZE) break;
    last = data[data.length - 1];
  }
  // During an outage most of the lieux that settle them are not placed yet:
  // they wait (stale, filed by the geocoder meanwhile) for a pass without one.
  if (down) report.retried += [...deferred.values()].reduce((n, d) => n + d.rows.length, 0);
  else await settleDeferred(deferred, opts, report);
  return down;
}

/** The lieux among same-named communes, settled against the support of every lieu the pass placed. */
async function settleDeferred(
  deferred: Map<string, Deferred>,
  opts: PassOptions,
  report: PassReport,
): Promise<void> {
  if (!deferred.size) return;
  const deps = { ...opts.deps, support: supportOnce(opts.deps) };
  for (const [key, { candidates, rows }] of deferred) {
    const settled = await orFailed(
      settleCandidates(rows[0].location, key, candidates, deps),
      rows[0],
      report,
      opts.log,
    );
    if (settled === FAILED) continue;
    if (settled === "retry") {
      report.retried += rows.length;
      continue;
    }
    const placement = settled ?? unplaced(rows[0].location, key, candidates);
    for (const row of rows) {
      const own = { ...placement.columns, placed_location: row.location };
      await store(row, { units: placement.units, columns: own }, opts, report);
    }
  }
}

/** Same-named communes settled again, against the lieux placed since: no geocoder call. */
async function candidatePass(opts: PassOptions, report: PassReport): Promise<void> {
  const deps = { ...opts.deps, support: supportOnce(opts.deps) };
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
      const placement = await orFailed(
        settleCandidates(row.location, key, candidates, deps),
        row,
        report,
        opts.log,
      );
      if (placement === "retry") {
        report.retried++;
        continue;
      }
      if (placement === FAILED || !placement) continue;
      await store(row, placement, opts, report, "settled");
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
 * stale (placed_location NULL), so that the stale pass places it again; the
 * others are stamped with the current rules, a page at a time.
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
      .limit(RULES_PAGE_SIZE);
    const { data, error } = await (last ? q.gt("id", last.id) : q);
    if (error) throw new PassError(`rules: ${error.message}`);
    // The rows only to stamp, by the rules they were placed under.
    const stamp = new Map<string | null, string[]>();
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
      if (!moved) {
        stamp.set(row.placed_rules, [...(stamp.get(row.placed_rules) ?? []), row.id]);
        continue;
      }
      const { error: werror, count } = await adminClient
        .from("auditions")
        .update({ placed_location: null }, { count: "exact" })
        .eq("id", row.id)
        .eq("placed_location", row.placed_location!);
      if (werror) {
        report.failed++;
        opts.log?.error({ err: werror, audition: row.id }, "placement: rules write refused");
      } else if (count === 0) report.skipped++;
      else report.rulesStaled++;
    }
    for (const [old, ids] of stamp) {
      // Guarded: a row moved meanwhile (stale), or placed again, is left alone.
      const update = adminClient
        .from("auditions")
        .update({ placed_rules: hash }, { count: "exact" })
        .in("id", ids)
        .eq("place_stale", false);
      const { error: werror, count } = await (old === null
        ? update.is("placed_rules", null)
        : update.eq("placed_rules", old));
      if (werror) {
        report.failed += ids.length;
        opts.log?.error({ err: werror, rows: ids.length }, "placement: rules stamp refused");
        continue;
      }
      report.rulesRestamped += count ?? 0;
      report.skipped += ids.length - (count ?? 0);
    }
    if (data.length < RULES_PAGE_SIZE) return;
    last = data[data.length - 1];
  }
}

/**
 * One pass: the rules pass (when asked), the stale rows, then the unplaced
 * lieux with same-named communes (when asked). `upstreamDown`: the geocoder
 * or the commune API did not answer; the end of the pass made no upstream call.
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

/** Forget the lieux known to fail (tests). */
export function forgetFailures(): void {
  failing.clear();
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

/** Why the job does not run here, if it does not. */
function whyOff(): { reason: string; warn: boolean } | null {
  if (!config.PLACEMENT_JOB) {
    return { reason: "PLACEMENT_JOB is not true (the sweep places a database)", warn: false };
  }
  if (!hasServiceRole) return { reason: "SUPABASE_SERVICE_ROLE_KEY is not set", warn: true };
  if (mapSource !== "db") return { reason: "MAP_SOURCE is not db", warn: true };
  // A developer's API against a hosted database (apps/api/.env): never a
  // mass write from a laptop.
  if (isDev && !localDatabase) {
    return { reason: "APP_ENV=local against a hosted database", warn: true };
  }
  return null;
}

/**
 * Start the job, when PLACEMENT_JOB asks for it (and the service role, the
 * stored map and, in development, a local database are there): a pass 10 s
 * after boot (the rules pass first), then every 10 minutes.
 */
export function startPlacementJob(logger: JobLogger): void {
  log = logger;
  const off = whyOff();
  if (off) {
    (off.warn ? logger.warn : logger.info).call(logger, {}, `placement job off: ${off.reason}`);
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

/**
 * A read that found rows not placed yet (the old app's, /api/map), or one
 * that cannot tell (the place reads, /api/places): a pass soon, at most once
 * a minute — so an old-app write is placed, and shows, within about a minute
 * while the site is being read.
 */
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
