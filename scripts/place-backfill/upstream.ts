// The public services the plan asks — the Base Adresse Nationale and
// geo.api.gouv.fr — asked gently: one request at a time, a gap between two,
// each answer kept for the run (and, with a cache file, for the next runs, so
// that a dry run and the run after it see the same answers).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BanError,
  banClient,
  lookUpLieu,
  type BanClient,
} from "../../apps/api/src/modules/geo/ban";
import { frChain, frDepartementChain, frRegionChain } from "../../apps/api/src/modules/places/fr";
import type { PlanDeps } from "./plan";

export const DEFAULT_BAN = "https://api-adresse.data.gouv.fr";
export const GEO_API_HOST = "geo.api.gouv.fr";
const GAP_MS = 250;
const BAN_TIMEOUT_MS = 10_000;

interface Kept {
  status: number;
  type: string;
  body: string;
}

/**
 * Routes the GETs to these hosts through one queue, GAP_MS apart, and keeps
 * their final answers — a 200, and a 404 from `notFoundHosts` only (geo.api's
 * "no such code"; a 404 from BAN means a wrong base URL, not "no such lieu");
 * returns the function that puts fetch back (and writes the cache file, if any).
 */
export function installGentleFetch(
  hosts: string[],
  cacheFile?: string,
  notFoundHosts: string[] = [GEO_API_HOST],
): () => void {
  const real = globalThis.fetch;
  const final = (url: string, status: number) =>
    status === 200 || (status === 404 && notFoundHosts.includes(new URL(url).host));
  const kept = new Map<string, Kept>(
    cacheFile && existsSync(cacheFile)
      ? Object.entries(JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, Kept>).filter(
          ([url, k]) => final(url, k.status),
        )
      : [],
  );
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "GET" || !hosts.includes(url.host)) return real(input, init);
    const key = url.toString();
    const hit = kept.get(key);
    if (hit) {
      return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.type } });
    }
    const turn = queue.then(async () => {
      const wait = GAP_MS - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await real(input, init);
      } finally {
        last = Date.now();
      }
    });
    queue = turn.then(
      () => undefined,
      () => undefined,
    );
    const res = await turn;
    if (!final(key, res.status)) return res;
    const answer: Kept = {
      status: res.status,
      type: res.headers.get("content-type") ?? "application/json",
      body: await res.text(),
    };
    kept.set(key, answer);
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": answer.type },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
    if (cacheFile) writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(kept)));
  };
}

/** The hosts installGentleFetch should slow down for this BAN. */
export const upstreamHosts = (ban: string) => [new URL(ban).host, GEO_API_HOST];

/** BAN refusing the query text itself: the lieu has no place. */
const REFUSED = new Set([400, 422]);

/**
 * BAN and the commune API, as the API asks them (geocode.ts, fr.ts), but
 * stricter, since the backfill is written once: a query BAN refuses (400,
 * 422) has no place; a timeout, a 5xx or a 429 is 'retry' — and so is a
 * failed reverse geocode of a curated lieu's point, which the API's lookup
 * would pass over (filing the lieu under the forward match's commune); any
 * other status (404, 410: a wrong --ban, a retired service) stops the run.
 */
export function upstreamDeps(ban: string): PlanDeps {
  const base = ban.replace(/\/+$/, "");
  const client = banClient(base, BAN_TIMEOUT_MS);
  return {
    async locate(key) {
      let reverseFailed: unknown;
      const watched: BanClient = {
        search: client.search,
        reverse: (coords) =>
          client.reverse(coords).catch((e: unknown) => {
            reverseFailed = e;
            throw e;
          }),
      };
      try {
        const found = await lookUpLieu(key, watched);
        if (reverseFailed !== undefined) throw reverseFailed;
        return found;
      } catch (e) {
        if (!(e instanceof BanError) || e.status === 429 || e.status >= 500) return "retry";
        if (REFUSED.has(e.status) && e !== reverseFailed) return null;
        throw new Error(
          `${key}: ${e.message} from ${base}. Not a passing failure: is --ban right? Nothing was written.`,
        );
      }
    },
    commune: frChain,
    departement: frDepartementChain,
    region: frRegionChain,
  };
}
