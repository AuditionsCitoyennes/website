import { hasServiceRole } from "../config";
import { adminClient } from "./supabase";

// The whole-table endpoints (/api/testimonies, /api/auditions, /api/map) stay,
// deprecated, for as long as the site and any third party read them; past a
// size the 512 MB container cannot serve one whole (staging's load-test
// data, production some day), they refuse and point to the place reads
// (design D8). The count goes through the service role: as anon, the
// testimonies' RESTRICTIVE policy makes it a 32 s scan at 300k rows. Without
// the service role (a developer's API) there is no guard. Below the counts,
// a value too heavy for the legacy family is refused too, by its bytes
// (lib/publicCache.ts): never served uncached, a whole-table pull per view.

/**
 * Testimonies past which /api/testimonies refuses. Not the design's 25,000:
 * the legacy family keeps the corpus up to 16 MB of JSON and gzip, about
 * 12,000 testimonies of the seed's shape (1.36 KB each) and fewer of the
 * real corpus's longer texts; and one pull of 25,000 peaks near 120 MB of
 * the 256 MB heap. Past here the corpus is neither cached nor pulled.
 */
export const TESTIMONIES_MAX = 10_000;
/** Published auditions past which /api/auditions and /api/map refuse. */
export const AUDITIONS_MAX = 5_000;

const COUNT_TIMEOUT_MS = 7000;

/** The table (`what`: its rows, or the cached value's bytes) is too large to be sent whole: 503. */
export class TooLongError extends Error {
  readonly statusCode = 503;
  constructor(
    readonly what: string,
    readonly size: number,
  ) {
    super("Liste trop longue : utilisez /api/places.");
    this.name = "TooLongError";
  }
}

/** The size could not be read (an error, a timeout): 503, never cached. */
export class CountFailedError extends Error {
  readonly statusCode = 503;
  constructor(
    readonly table: string,
    readonly detail: string,
  ) {
    super("Réessayez dans un instant.");
    this.name = "CountFailedError";
  }
}

async function exactCount(table: "testimonies" | "auditions"): Promise<number> {
  const signal = AbortSignal.timeout(COUNT_TIMEOUT_MS);
  const head = { count: "exact", head: true } as const;
  const { count, error } =
    table === "auditions"
      ? await adminClient
          .from("auditions")
          .select("id", head)
          .eq("status", "published")
          .abortSignal(signal)
      : await adminClient.from("testimonies").select("id", head).abortSignal(signal);
  if (error || count === null) throw new CountFailedError(table, error?.message ?? "no count");
  return count;
}

/** Throws unless /api/testimonies may be served whole. */
export async function guardTestimonies(): Promise<void> {
  if (!hasServiceRole) return;
  const count = await exactCount("testimonies");
  if (count > TESTIMONIES_MAX) throw new TooLongError("testimonies", count);
}

/** Throws unless the published auditions may be read whole (/api/auditions, /api/map). */
export async function guardPublishedAuditions(): Promise<void> {
  if (!hasServiceRole) return;
  const count = await exactCount("auditions");
  if (count > AUDITIONS_MAX) throw new TooLongError("auditions", count);
}
