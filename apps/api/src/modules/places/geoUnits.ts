import type { GeoUnit } from "@ac/shared";
import { adminClient } from "../../lib/supabase";
import { PAGE, selectAll } from "../../lib/paging";
import type { GeoUnitWrite } from "./fr";

// geo_units: the units auditions are filed under, and only those some row
// references. Server only (RLS on, no policy, nothing granted to anon or
// authenticated): read and written through the service role alone.

// The ids written by this process: a unit already there is not sent again.
// A unit is never renamed in place (a remap inserts a new one), so a hit
// stays good — but for a database reset under a running API: the foreign
// key then refuses a child of a unit believed written, and all are sent.
const written = new Set<string>();

// The last read of the whole table, kept for every /api/map build and admin
// list: units only appear (a placement writes them), and a row referencing
// one this read lacks — written by another process since — reads it again.
const UNITS_TTL_MS = 10 * 60_000;
/** A miss re-reads at most this often (a row whose path names a unit no read finds). */
const MISS_REREAD_MS = 30_000;
let unitsRead: { until: number; units: Promise<Map<string, GeoUnitName>> } | null = null;
let lastMissRead = 0;

/**
 * Make sure these units exist, root first (ancestors before descendants).
 * One that exists already is left as it is: an id is never updated (C7).
 * Throws on a database error.
 */
export async function upsertGeoUnits(units: readonly GeoUnitWrite[]): Promise<void> {
  const unique = [...new Map(units.map((u) => [u.id, u])).values()];
  const missing = unique.filter((u) => !written.has(u.id));
  if (missing.length === 0) return;
  let { error } = await insertUnits(missing);
  if (error?.code === "23503") {
    written.clear();
    ({ error } = await insertUnits(unique));
  }
  if (error) throw new Error(`geo_units: ${error.message}`);
  for (const u of unique) written.add(u.id);
  // The units the reads keep are short of these now.
  unitsRead = null;
}

function insertUnits(units: GeoUnitWrite[]) {
  return adminClient.from("geo_units").upsert(units, { onConflict: "id", ignoreDuplicates: true });
}

/** Forget what was written and read (tests: a fresh database). */
export function forgetGeoUnits(): void {
  written.clear();
  unitsRead = null;
}

/** What /api/map and the admin list need of a unit. */
export type GeoUnitName = Pick<GeoUnit, "id" | "parent_id" | "level" | "name" | "code">;

async function fetchGeoUnits(): Promise<Map<string, GeoUnitName>> {
  const { data, error } = await selectAll((last?: GeoUnitName) => {
    const q = adminClient.from("geo_units").select("id, parent_id, level, name, code").order("id");
    return (last ? q.gt("id", last.id) : q).limit(PAGE);
  });
  if (error) throw new Error(`geo_units: ${error.message}`);
  return new Map(data.map((u) => [u.id, u]));
}

function keptUnits(): Promise<Map<string, GeoUnitName>> {
  const now = Date.now();
  if (!unitsRead || unitsRead.until <= now) {
    const units = fetchGeoUnits();
    const read = { until: now + UNITS_TTL_MS, units };
    unitsRead = read;
    // A failed read is not kept.
    units.catch(() => {
      if (unitsRead === read) unitsRead = null;
    });
  }
  return unitsRead.units;
}

/**
 * Every unit, by id (the table holds only the units rows reference), from the
 * last read — read again when one of `paths` names a unit it lacks. Throws on
 * a database error (geo_units missing, the service role refused).
 */
export async function readGeoUnits(
  paths: Iterable<readonly string[] | null | undefined> = [],
): Promise<Map<string, GeoUnitName>> {
  const units = await keptUnits();
  const now = Date.now();
  if (now - lastMissRead < MISS_REREAD_MS) return units;
  for (const path of paths) {
    if (path?.some((id) => !units.has(id))) {
      lastMissRead = now;
      unitsRead = null;
      return keptUnits();
    }
  }
  return units;
}
