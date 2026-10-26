// The public services the plan asks — the Base Adresse Nationale and
// geo.api.gouv.fr — asked gently: one request at a time, a gap between two,
// each answer kept for the run (and, with a cache file, for the next runs, so
// that a dry run and the run after it see the same answers).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BanError, banClient, lookUpLieu } from "../../apps/api/src/modules/geo/ban";
import { frChain, frDepartementChain, frRegionChain } from "../../apps/api/src/modules/places/fr";
import type { PlanDeps } from "./plan";

export const DEFAULT_BAN = "https://api-adresse.data.gouv.fr";
const GEO_API_HOST = "geo.api.gouv.fr";
const GAP_MS = 250;
const BAN_TIMEOUT_MS = 10_000;

interface Kept {
  status: number;
  type: string;
  body: string;
}

/**
 * Routes the GETs to these hosts through one queue, GAP_MS apart, and keeps
 * their final answers (200, 404); returns the function that puts fetch back
 * (and writes the cache file, if any).
 */
export function installGentleFetch(hosts: string[], cacheFile?: string): () => void {
  const real = globalThis.fetch;
  const kept = new Map<string, Kept>(
    cacheFile && existsSync(cacheFile)
      ? Object.entries(JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, Kept>)
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
    if (res.status !== 200 && res.status !== 404) return res;
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

/**
 * BAN and the commune API, as the API asks them (geocode.ts, fr.ts): a query
 * BAN refuses (a 4xx but 429) has no place; anything else that fails — a
 * timeout, a 5xx, a 429 — is 'retry'.
 */
export function upstreamDeps(ban: string): PlanDeps {
  const client = banClient(ban.replace(/\/+$/, ""), BAN_TIMEOUT_MS);
  return {
    async locate(key) {
      try {
        return await lookUpLieu(key, client);
      } catch (e) {
        if (e instanceof BanError && e.status >= 400 && e.status < 500 && e.status !== 429) {
          return null;
        }
        return "retry";
      }
    },
    commune: frChain,
    departement: frDepartementChain,
    region: frRegionChain,
  };
}
