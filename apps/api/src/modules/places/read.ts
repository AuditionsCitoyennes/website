import type { Json, RpcPlaceFilters } from "@ac/shared";
import { dbErrorOf, dbGate, type DbGate, type DbTiming } from "../../lib/dbGate";
import { adminClient } from "../../lib/supabase";

// The read RPCs (supabase/migrations/20261026200000_read_rpcs.sql), each call
// through the gate (lib/dbGate.ts) with its abort signal, through the service
// role: they are granted to it alone. A failed call throws what the routes
// map: DbTimeoutError (57014, the abort) → 503, DbRefusedError (22023) →
// 400, anything else → 500.

/** Units per place_counts_many call (the function takes 1 to 20). */
export const UNITS_PER_CALL = 20;

export interface CountsArgs {
  depth: number;
  facts: boolean;
  empty: boolean;
  budget: number;
  filters: RpcPlaceFilters;
}

interface RpcAnswer {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** One gated call: `run` gets the signal its request must carry. */
async function gated(
  run: (signal: AbortSignal) => PromiseLike<RpcAnswer>,
  timing?: DbTiming,
  gate: DbGate = dbGate,
): Promise<unknown> {
  return gate.run(async (signal) => {
    const { data, error } = await run(signal);
    if (error) throw dbErrorOf(error, signal);
    return data;
  }, timing);
}

const asJson = (f: RpcPlaceFilters) => f as Json;

/** place_counts for 1 to 20 units, in their order. */
export async function placeCountsMany(
  units: string[],
  a: CountsArgs,
  timing?: DbTiming,
): Promise<unknown[]> {
  const data = await gated(
    (signal) =>
      adminClient
        .rpc("place_counts_many", {
          p_units: units,
          p_filters: asJson(a.filters),
          p_depth: a.depth,
          p_facts: a.facts,
          p_budget: a.budget,
          p_empty: a.empty,
        })
        .abortSignal(signal),
    timing,
  );
  if (!Array.isArray(data) || data.length !== units.length) {
    throw new Error(`place_counts_many: ${units.length} answers expected`);
  }
  return data;
}

export function lieuAuditions(
  lieu: string,
  filters: RpcPlaceFilters,
  sort: string,
  timing?: DbTiming,
): Promise<unknown> {
  return gated(
    (signal) =>
      adminClient
        .rpc("lieu_auditions", { p_lieu: lieu, p_filters: asJson(filters), p_sort: sort })
        .abortSignal(signal),
    timing,
  );
}

export interface ResultsArgs {
  filters: RpcPlaceFilters;
  sort: string;
  after: string[] | null;
  limit: number;
  through: string | null;
}

export function auditionResults(a: ResultsArgs, timing?: DbTiming): Promise<unknown> {
  return gated(
    (signal) =>
      adminClient
        .rpc("audition_results", {
          p_filters: asJson(a.filters),
          p_sort: a.sort,
          p_limit: a.limit,
          ...(a.after && { p_after: a.after }),
          ...(a.through && { p_through: a.through }),
        })
        .abortSignal(signal),
    timing,
  );
}

export interface TestimonyPageArgs {
  audition: string;
  filters: RpcPlaceFilters;
  after: (string | null)[] | null;
  limit: number;
}

export function testimonyPage(a: TestimonyPageArgs, timing?: DbTiming): Promise<unknown> {
  return gated(
    (signal) =>
      adminClient
        .rpc("testimony_page", {
          p_audition: a.audition,
          p_filters: asJson(a.filters),
          p_limit: a.limit,
          ...(a.after && { p_after: a.after }),
        })
        .abortSignal(signal),
    timing,
  );
}

export function placeFacets(timing?: DbTiming): Promise<unknown> {
  return gated((signal) => adminClient.rpc("place_facets").abortSignal(signal), timing);
}

/** The admin list's content filters; `reachableBy` null for a super admin (every audition). */
export function adminAuditionFilter(
  filters: RpcPlaceFilters,
  reachableBy: string | null,
  timing?: DbTiming,
): Promise<unknown> {
  return gated(
    (signal) =>
      adminClient
        .rpc("admin_audition_filter", {
          p_filters: asJson(filters),
          ...(reachableBy && { p_reachable_by: reachableBy }),
        })
        .abortSignal(signal),
    timing,
  );
}
