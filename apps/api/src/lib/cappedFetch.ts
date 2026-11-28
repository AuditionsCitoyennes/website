// A fetch that reads at most so many bytes of an answer: past them, the body
// is dropped unread and the call fails. The place reads (modules/places/
// read.ts) go through it, so that what one read costs the heap — the body,
// its string, the parsed value, each part serialised again — is bounded by
// the answer, whatever the request asked (a depth, a batch of large units).
// The third parties the API calls (the BAN, geo.api.gouv.fr, Resend,
// Anthropic) go through upstreamFetch: the same limit, and no redirect.

/** The name of the error thrown past the limit; supabase-js reports it as "<name>: <message>". */
export const ANSWER_TOO_LARGE = "AnswerTooLargeError";

export class AnswerTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`answer over ${maxBytes} bytes (${bytes} read)`);
    this.name = ANSWER_TOO_LARGE;
  }
}

/** `base` (globalThis.fetch as it is at call time by default), its answers cut at `maxBytes`. */
export function cappedFetch(
  maxBytes: number,
  base: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new AnswerTooLargeError(declared, maxBytes);
    }
    if (!res.body) return res;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AnswerTooLargeError(bytes, maxBytes);
      }
      chunks.push(value);
    }
    return new Response(Buffer.concat(chunks), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/** The heaviest answer read from the BAN, geo.api.gouv.fr or Resend (theirs weigh a few kB). */
export const UPSTREAM_ANSWER_MAX_BYTES = 256 * 1024;

/**
 * A fetch for a third party's API: its answer cut at `maxBytes`, and a
 * redirect refused (the call fails) instead of followed — none of these
 * APIs redirects, and a followed one would carry the request, its key
 * header and its body to wherever the answer points.
 */
export function upstreamFetch(maxBytes: number = UPSTREAM_ANSWER_MAX_BYTES): typeof fetch {
  const capped = cappedFetch(maxBytes);
  return (input, init) => capped(input, { ...init, redirect: "error" });
}
