// A fetch that reads at most so many bytes of an answer: past them, the body
// is dropped unread and the call fails. The place reads (modules/places/
// read.ts) go through it, so that what one read costs the heap — the body,
// its string, the parsed value, each part serialised again — is bounded by
// the answer, whatever the request asked (a depth, a batch of large units).

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
