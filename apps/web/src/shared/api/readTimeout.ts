// A time limit on the API's reads (shared/api/client.ts): a GET that has not
// finished — its answer read to the end — within READ_TIMEOUT_MS is abandoned
// and sent once more at once, on a new connection; a second one that runs out
// fails with an ApiTimeoutError. A connection that stalls (no byte comes, the
// socket stays open) then ends in a retry and, at worst, an error the page
// shows and recovers from, instead of a wait the browser itself ends minutes
// later. A read abandoned by its caller (its own signal) is never retried.
//
// ApiTimeoutError is a TypeError, as fetch's own network failures are: every
// reader that tries a read again after a network failure (placesApi's
// retryable, the lists' retryRefused) tries it again after a timeout too.
//
// Not AbortSignal.timeout nor AbortSignal.any: missing on iOS before 16 and
// 17.4. Pure: the timers and the read are injected (readTimeout.test.ts).

/** How long one attempt of a read may take, its answer read to the end. */
export const READ_TIMEOUT_MS = 25_000;

/** Attempts of a read that runs out of time: the first, and one more. */
export const READ_ATTEMPTS = 2;

/** A read that ran out of time on every attempt. */
export class ApiTimeoutError extends TypeError {
  constructor(readonly ms: number) {
    super(`The read took longer than ${ms} ms.`);
    this.name = "ApiTimeoutError";
  }
}

type Timer = unknown;
export interface ReadTimers {
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
}

/**
 * Runs `read` with a signal that aborts when the caller's does, or when `ms`
 * pass (an attempt that runs out of time is tried again, up to `attempts`).
 * The caller's abort rejects as the read does (its AbortError); a time-out on
 * the last attempt rejects with an ApiTimeoutError.
 */
export async function readWithin<T>(
  read: (signal: AbortSignal) => Promise<T>,
  opts: ReadTimers & { ms?: number; attempts?: number; signal?: AbortSignal | null },
): Promise<T> {
  const ms = opts.ms ?? READ_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? READ_ATTEMPTS);
  const outer = opts.signal ?? null;
  for (let n = 1; ; n++) {
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort(outer?.reason);
    if (outer?.aborted) ctl.abort(outer.reason);
    else outer?.addEventListener("abort", onAbort, { once: true });
    const timer = opts.setTimer(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
    try {
      return await read(ctl.signal);
    } catch (err) {
      if (!timedOut || outer?.aborted) throw err;
      if (n >= attempts) throw new ApiTimeoutError(ms);
    } finally {
      opts.clearTimer(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}
