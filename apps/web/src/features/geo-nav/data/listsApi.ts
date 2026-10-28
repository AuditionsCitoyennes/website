// The lists of the Témoignages panel from the server (map phase 1, design D1,
// E1 (K)): the auditions matching the filters, a keyset page at a time (the
// first page with the total and the results' frame); a lieu's matching
// auditions (the lazy path, when the tree's answer did not embed them); an
// audition's matching testimonies, oldest first, a page at a time. And how a
// refused read is tried again.

import {
  contentFiltersOf,
  placeFilterKey,
  placeFilterQuerySchema,
  placeFiltersOf,
  type PlaceLieuAuditions,
  type PlaceResultsCursor,
  type PlaceResultsPage,
  type PlaceSort,
  type TestimonyPage,
  type TestimonyPageCursor,
} from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { RESULTS_PAGE } from "../model/auditions";

/** `?resultsPage=` of the page, 1 to 100: the testing tools page a small
 *  dataset finely with it. */
function pageAsked(): number | null {
  const n = Number(new URLSearchParams(window.location.search).get("resultsPage"));
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/** Results a page: RESULTS_PAGE, as the corpus reveals them. */
export const RESULTS_LIMIT: number = (__TEST_TOOLS__ && pageAsked()) || RESULTS_PAGE;

/** Testimonies a page (design D10). */
export const TESTIMONIES_LIMIT = 50;

/** A results page, with what it was asked under. */
export interface ResultsPage extends PlaceResultsPage {
  key: string;
  sort: PlaceSort;
}

/** A testimony page, with what it was asked under. */
export interface TestimoniesPage extends TestimonyPage {
  audition: string;
  contentKey: string;
}

/** A lieu's auditions, with what they were asked under. */
export interface LieuAuditions extends PlaceLieuAuditions {
  id: string;
  key: string;
}

/** The filters judged on a testimony (verified, themes, text) of a filter key's
 *  parameters, and their own canonical key. */
export function contentOf(params: Readonly<Record<string, string>>): {
  key: string;
  params: Record<string, string>;
} {
  const out: Record<string, string> = {};
  for (const k of ["v", "t", "q"] as const) if (params[k] !== undefined) out[k] = params[k];
  const q = placeFilterQuerySchema.safeParse(out);
  const key = q.success ? placeFilterKey(contentFiltersOf(placeFiltersOf(q.data))) : "";
  return { key, params: out };
}

export function fetchResults(
  params: Readonly<Record<string, string>>,
  sort: PlaceSort,
  page: { after?: PlaceResultsCursor | null; through?: string | null; limit: number },
  signal?: AbortSignal,
): Promise<PlaceResultsPage> {
  const q = new URLSearchParams(params);
  q.set("sort", sort);
  q.set("limit", String(page.limit));
  if (page.after) q.set("after", page.after.join(","));
  else if (page.through) q.set("through", page.through);
  return api.get<PlaceResultsPage>(`/api/places/results?${q}`, false, signal);
}

export function fetchLieuAuditions(
  id: string,
  params: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<PlaceLieuAuditions> {
  const q = new URLSearchParams(params);
  q.set("id", id);
  return api.get<PlaceLieuAuditions>(`/api/places/lieu?${q}`, false, signal);
}

export function fetchTestimonyPage(
  audition: string,
  contentParams: Readonly<Record<string, string>>,
  after: TestimonyPageCursor | null,
  signal?: AbortSignal,
): Promise<TestimonyPage> {
  const q = new URLSearchParams(contentParams);
  q.set("limit", String(TESTIMONIES_LIMIT));
  if (after) q.set("after", `${after[0] ?? ""},${after[1]}`);
  return api.get<TestimonyPage>(
    `/api/auditions/${encodeURIComponent(audition)}/testimonies?${q}`,
    false,
    signal,
  );
}

/** Waits before each retry of a refused read (unless Retry-After says). */
const RETRY_MS = [1000, 2000, 4000];

/** A read refused for now (429, 503, a gateway, no answer at all): tried
 *  again, three times (vue-query's `retry`; `failures` counts from 0). */
export function retryRefused(failures: number, err: unknown): boolean {
  if (failures >= RETRY_MS.length) return false;
  if (err instanceof ApiError) return err.status === 429 || err.status >= 502;
  return err instanceof TypeError;
}

/** After Retry-After when the API says, else 1, 2 and 4 s (`retryDelay`). */
export function retryDelay(failures: number, err: unknown): number {
  const after = err instanceof ApiError ? err.retryAfter : null;
  if (after !== null) return Math.max(250, after * 1000);
  return RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
}
