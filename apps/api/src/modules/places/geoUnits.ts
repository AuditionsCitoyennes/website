import type { GeoUnit } from "@ac/shared";
import { adminClient } from "../../lib/supabase";
import { PAGE, selectAll } from "../../lib/paging";
import type { GeoUnitWrite } from "./fr";

// geo_units: the units auditions are filed under, and only those some row
// references. Server only (RLS on, no policy, nothing granted to anon or
// authenticated): read and written through the service role alone.

// The ids written by this process: a unit already there is not sent again.
// An id is never changed in place (a remap inserts a new unit), so a hit
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
 * One that exists already keeps its id, its parent and its level (C7); its
 * name, code and point follow the unit arriving when that one is of a newer
 * release of the same source (refreshUnits). Throws on a database error.
 */
export async function upsertGeoUnits(units: readonly GeoUnitWrite[]): Promise<void> {
  const unique = [...new Map(units.map((u) => [u.id, u])).values()];
  const missing = unique.filter((u) => !written.has(u.id));
  if (missing.length === 0) return;
  let sent = missing;
  let { data, error } = await insertUnits(sent);
  if (error?.code === "23503") {
    written.clear();
    sent = unique;
    ({ data, error } = await insertUnits(sent));
  }
  if (error) throw new Error(`geo_units: ${error.message}`);
  const inserted = new Set((data ?? []).map((u) => u.id));
  await refreshUnits(sent.filter((u) => !inserted.has(u.id)));
  for (const u of unique) written.add(u.id);
  // The units the reads keep are short of these now.
  unitsRead = null;
}

/** The units not there yet, inserted: the answer names them. */
function insertUnits(units: GeoUnitWrite[]) {
  return adminClient
    .from("geo_units")
    .upsert(units, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
}

/**
 * The units that were there already, brought to the release arriving when
 * theirs is older: a release's corrected name, code or point replaces the
 * stored one. Releases of one source sort as text ("geoapi-2026" before
 * "geoapi-2027"); a unit of another source, or of the same or a newer
 * release, is left as it is. Guarded by the release read: of two processes
 * arriving together, one writes.
 */
async function refreshUnits(units: GeoUnitWrite[]): Promise<void> {
  if (units.length === 0) return;
  const { data, error } = await adminClient
    .from("geo_units")
    .select("id, source, geo_release")
    .in(
      "id",
      units.map((u) => u.id),
    );
  if (error) throw new Error(`geo_units: ${error.message}`);
  const stored = new Map(data.map((u) => [u.id, u]));
  for (const u of units) {
    const old = stored.get(u.id);
    if (!old || old.source !== u.source || old.geo_release >= u.geo_release) continue;
    // A unit arriving without a point (an area above the leaf) keeps the stored one.
    const point = u.lat !== null && u.lng !== null ? { lat: u.lat, lng: u.lng } : {};
    const { error: refused } = await adminClient
      .from("geo_units")
      .update({
        name: u.name,
        code: u.code,
        ...point,
        geo_release: u.geo_release,
        updated_at: new Date().toISOString(),
      })
      .eq("id", u.id)
      .eq("geo_release", old.geo_release);
    if (refused) throw new Error(`geo_units: ${refused.message}`);
  }
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
