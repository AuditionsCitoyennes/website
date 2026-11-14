// A fetch with a time limit, under every Supabase client of the API
// (lib/supabase.ts): a call that has not answered — headers and body — within
// its limit is aborted, and supabase-js reports it as an error
// ("TimeoutError: …", which lib/dbGate.ts reads as a database out of reach).
// A read (GET, HEAD) gets READ_TIMEOUT_MS, anything else WRITE_TIMEOUT_MS:
// the database's own statement timeouts end a slow query long before either,
// so a call that reaches them is a connection that stalled. A caller's own
// signal (supabase-js' abortSignal(), the place reads' gate) still aborts it.
// Nothing is retried here: whether a call may be sent again is the caller's
// call.

/** How long a read may take, its answer read to the end. */
export const READ_TIMEOUT_MS = 15_000;
/** How long any other call may take. */
export const WRITE_TIMEOUT_MS = 30_000;

/** The method of a fetch call, upper-case. */
function methodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : "GET";
}

/** `base` (globalThis.fetch as it is at call time by default), each call
 *  aborted past its limit. */
export function timedFetch(
  base: typeof fetch = (input, init) => globalThis.fetch(input, init),
  limits: { readMs?: number; writeMs?: number } = {},
): typeof fetch {
  return async (input, init) => {
    const method = methodOf(input, init);
    const ms =
      method === "GET" || method === "HEAD"
        ? (limits.readMs ?? READ_TIMEOUT_MS)
        : (limits.writeMs ?? WRITE_TIMEOUT_MS);
    const own = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, own]) : own;
    // The signal also ends the body's reading: the limit covers the whole answer.
    return base(input, { ...init, signal });
  };
}
