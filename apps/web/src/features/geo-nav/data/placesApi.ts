// The place reads of the Témoignages map (map phase 1, design D1, E2): a
// unit's subtree of counts (/api/places), the filter dialog's facets, and the
// vue-query keys they are cached under. The units the store asks for within
// 50 ms go out as ONE units= request (≤ 50): a drill step ensures a dozen
// units at once, and each request costs the visitor a slice of the API's
// miss limit.

import type { PlaceCounts, PlaceCountsBatch, PlaceFacets } from "@ac/shared";
import { PLACE_IDS_MAX } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { EMPTY_KEY, placesKeys } from "../keys";

/** The subtree's depth asked for: a unit's children and grandchildren. */
export const PLACES_DEPTH = 2;

export { EMPTY_KEY, placesKeys };

/** What a counts request is asked under: one filter key's. */
export interface CountsRequest {
  /** The canonical filter key, or EMPTY_KEY. */
  key: string;
  /** The filters' query parameters (none for EMPTY_KEY). */
  params: Readonly<Record<string, string>>;
  /** Analyses figures with every unit (the store always asks; not the card). */
  facts: boolean;
}

/**
 * `?budget=` of the page, passed on (testing tools only; the API honours it
 * only with TEST_TOOLS): budget=0 forces the lazy path at any size.
 */
const BUDGET: string | null = __TEST_TOOLS__
  ? new URLSearchParams(window.location.search).get("budget")
  : null;

/** The answers to one counts request, in the order asked; `ignored`: its
 *  text was (shorter than the API searches, `minChars` when it says). */
export interface CountsAnswer {
  answers: PlaceCounts[];
  ignored: { minChars?: number } | null;
}

/** The answers to one counts request, in the order asked. */
export async function fetchCounts(
  units: readonly string[],
  req: CountsRequest,
  signal?: AbortSignal,
): Promise<CountsAnswer> {
  const q = new URLSearchParams();
  if (units.length === 1) q.set("unit", units[0]);
  else q.set("units", units.join(","));
  q.set("depth", String(PLACES_DEPTH));
  if (req.facts) q.set("facts", "1");
  if (req.key === EMPTY_KEY) q.set("empty", "1");
  for (const [k, v] of Object.entries(req.params)) q.set(k, v);
  if (BUDGET !== null) q.set("budget", BUDGET);
  const body = await api.get<PlaceCounts | PlaceCountsBatch>(`/api/places?${q}`, false, signal);
  const answers = "results" in body ? body.results : [body];
  return {
    answers,
    ignored: body.textIgnored === true ? { minChars: body.minChars } : null,
  };
}

/** The filter dialog's theme counts and date bounds. */
export function fetchFacets(signal?: AbortSignal): Promise<PlaceFacets> {
  return api.get<PlaceFacets>("/api/places/facets", false, signal);
}

/** Tries of a refused read before it is given up: 1, then 3 retries. */
export const RETRIES = 3;
/** Waits before each retry (unless Retry-After says). */
const RETRY_MS = [1000, 2000, 4000];

/** Worth trying again: a rate limit, an API busy or down, no answer at all. */
export function retryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 502;
  // A request that never got an answer (offline, the API down).
  return err instanceof TypeError;
}

/** How long before retry `n` (1-based): Retry-After when the API said, else 1, 2, 4 s. */
export function retryWait(n: number, err: unknown): number {
  const after = err instanceof ApiError ? err.retryAfter : null;
  return after !== null ? Math.max(250, after * 1000) : RETRY_MS[Math.min(n, RETRY_MS.length) - 1];
}

function abortError(): DOMException {
  return new DOMException("The place read was abandoned.", "AbortError");
}

interface Waiting {
  unit: string;
  resolve: (answer: PlaceCounts) => void;
  reject: (err: unknown) => void;
  abandoned: boolean;
  /** The request it went out in, once sent. */
  sent?: Sent;
}

interface Sent {
  ctl: AbortController;
  items: Waiting[];
}

/**
 * Coalesces counts requests: units asked for under one filter key within
 * `windowMs` (or within the same tick, `now`) go out together, `PLACE_IDS_MAX`
 * a request. Each answer is handed to `onAnswers` (all of a request's at
 * once) before the units' own promises settle. A unit abandoned through its
 * signal is dropped; a request whose units are all abandoned is aborted.
 */
export function createCountsBatcher(opts: {
  windowMs: number;
  onAnswers: (req: CountsRequest, answers: PlaceCounts[], ignored: CountsAnswer["ignored"]) => void;
  fetch?: typeof fetchCounts;
}) {
  const send = opts.fetch ?? fetchCounts;
  const queues = new Map<string, { req: CountsRequest; items: Waiting[] }>();
  let timer = 0;
  let soon = false;
  /** Requests sent (the testing tools' probe). */
  let sent = 0;

  function flush() {
    window.clearTimeout(timer);
    timer = 0;
    soon = false;
    const all = [...queues.values()];
    queues.clear();
    for (const { req, items } of all) {
      const live = items.filter((w) => !w.abandoned);
      // One unit once per request, whoever asked.
      const units = [...new Set(live.map((w) => w.unit))];
      for (let i = 0; i < units.length; i += PLACE_IDS_MAX) {
        const slice = new Set(units.slice(i, i + PLACE_IDS_MAX));
        void go(
          req,
          [...slice],
          live.filter((w) => slice.has(w.unit)),
        );
      }
    }
  }

  async function go(req: CountsRequest, units: string[], items: Waiting[]) {
    const out: Sent = { ctl: new AbortController(), items };
    for (const w of items) w.sent = out;
    sent++;
    try {
      const { answers, ignored } = await send(units, req, out.ctl.signal);
      opts.onAnswers(req, answers, ignored);
      const byUnit = new Map(answers.map((a) => [a.unit, a]));
      for (const w of items) {
        if (w.abandoned) continue;
        const answer = byUnit.get(w.unit);
        if (answer) w.resolve(answer);
        else w.reject(new Error(`no answer for ${w.unit}`));
      }
    } catch (err) {
      for (const w of items) if (!w.abandoned) w.reject(err);
    }
  }

  /** A unit's answer under `req`; `now`: sent at the end of this tick rather
   *  than after the window (a filter change's first request). */
  function load(
    req: CountsRequest,
    unit: string,
    signal?: AbortSignal,
    now = false,
  ): Promise<PlaceCounts> {
    return new Promise<PlaceCounts>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const w: Waiting = { unit, resolve, reject, abandoned: false };
      signal?.addEventListener(
        "abort",
        () => {
          w.abandoned = true;
          reject(abortError());
          if (w.sent && w.sent.items.every((x) => x.abandoned)) w.sent.ctl.abort();
        },
        { once: true },
      );
      let q = queues.get(req.key);
      if (!q) {
        q = { req, items: [] };
        queues.set(req.key, q);
      }
      q.items.push(w);
      if (now) {
        if (!soon) {
          soon = true;
          queueMicrotask(flush);
        }
      } else if (!timer && !soon) {
        timer = window.setTimeout(flush, opts.windowMs);
      }
    });
  }

  return { load, sent: () => sent };
}

export type CountsBatcher = ReturnType<typeof createCountsBatcher>;
