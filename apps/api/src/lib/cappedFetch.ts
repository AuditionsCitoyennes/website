// A fetch that reads at most so many bytes of an answer: past them, the body
// is dropped unread and the call fails. The place reads (modules/places/
// read.ts) go through it, so that what one read costs the heap — the body,
// its string, the parsed value, each part serialised again — is bounded by
// the answer, whatever the request asked (a depth, a batch of large units).
// The body is read here, under the caller's signal: a time limit given with
// the call covers the whole answer, however slowly its body comes.
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

/**
 * `base` (globalThis.fetch as it is at call time by default), its answers
 * cut at `maxBytes` and read to their end before the call resolves. The
 * call's signal ends that reading by itself (the call then fails with the
 * signal's reason, the rest of the body dropped): Node's fetch does not
 * always pass an abort on to a body being read, when it was asked to refuse
 * redirects for one.
 */
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
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    let abort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal?.reason as Error);
    });
    // Settled or not, never left unhandled: only the read below waits on it.
    aborted.catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new AnswerTooLargeError(bytes, maxBytes);
        chunks.push(value);
      }
    } catch (e) {
      // The rest is not read; dropping it is not waited for (a body that stalled may not end).
      void reader.cancel().catch(() => {});
      throw e;
    } finally {
      signal?.removeEventListener("abort", abort);
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
 * redirect fails the call — these APIs answer at the address asked.
 */
export function upstreamFetch(maxBytes: number = UPSTREAM_ANSWER_MAX_BYTES): typeof fetch {
  const capped = cappedFetch(maxBytes);
  return (input, init) => capped(input, { ...init, redirect: "error" });
}

/**
 * Why a call through upstreamFetch failed, when the reason is what the
 * third party answered rather than the network or the clock: a redirect, an
 * answer past the limit, a body that is not JSON. Null for anything else.
 * For the log: such a failure lasts until someone looks at it (a base URL
 * that moved, an API that changed), where a timeout passes by itself.
 */
export function answerFault(err: unknown): string | null {
  if (err instanceof AnswerTooLargeError) return err.message;
  if (err instanceof SyntaxError) return "answer is not JSON";
  // How Node's fetch reports a redirect met under `redirect: "error"`.
  const cause = err instanceof TypeError ? err.cause : null;
  if (cause instanceof Error && cause.message === "unexpected redirect") return "redirect refused";
  return null;
}
