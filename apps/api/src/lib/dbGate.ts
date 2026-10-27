// The gate in front of the database's read functions (map phase 1, design
// D4): at most `max` calls at once, `queue` more waiting at most `waitMs`,
// then a 503 that is never cached. Each call is aborted after `timeoutMs`
// (7 s) — the service role's own statement timeout (5 s) normally ends it
// first, as a 57014 — and the slot of an aborted call is held `holdMs` more:
// the statement may still be running on the database, and the gate is what
// keeps the number of those bounded.
//
// What a failed call means (dbErrorOf): a 57014 is a search too broad for
// the statement timeout ("précisez-la"); a database that could not be
// reached or answered nothing usable — PostgREST's connection and pool
// errors (PGRST000-003), a pooler's prepared-statement mix-up, a gateway's
// 5xx, a fetch that threw, the API's own abort — is a moment's trouble
// ("réessayez"). Both are transient: a value still held answers instead.

import { performance } from "node:perf_hooks";
import { ANSWER_TOO_LARGE } from "./cappedFetch";

/** The gate is full: 503, never cached. */
export class DbBusyError extends Error {
  readonly statusCode = 503;
  constructor() {
    super("Réessayez dans un instant.");
    this.name = "DbBusyError";
  }
}

/** The statement ran out of time (57014): 503, never cached. */
export class DbTimeoutError extends Error {
  readonly statusCode = 503;
  constructor(readonly detail: string) {
    super("Recherche trop large : précisez-la.");
    this.name = "DbTimeoutError";
  }
}

/**
 * The database was not reached, or gave no usable answer (connection, pool,
 * gateway, a fetch that threw, the API's abort): 503, never cached.
 */
export class DbUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(readonly detail: string) {
    super("Réessayez dans un instant.");
    this.name = "DbUnavailableError";
  }
}

/** The database refused the arguments (22023, or text it cannot hold: 22P05, 22021): 400. */
export class DbRefusedError extends Error {
  readonly statusCode = 400;
  constructor(readonly detail: string) {
    super("Paramètres invalides.");
    this.name = "DbRefusedError";
  }
}

/** The answer was heavier than a read may bring back (lib/cappedFetch.ts): 400, never cached. */
export class DbTooLargeError extends Error {
  readonly statusCode = 400;
  constructor(readonly detail: string) {
    super("Réponse trop volumineuse : précisez la demande.");
    this.name = "DbTooLargeError";
  }
}

/**
 * Whether a failed call may be answered with a value still held (a timeout,
 * a full gate, a database out of reach).
 */
export function isTransientDbError(err: unknown): boolean {
  return (
    err instanceof DbTimeoutError || err instanceof DbBusyError || err instanceof DbUnavailableError
  );
}

/** Codes of arguments the database refuses: invalid parameter, text it cannot store. */
const REFUSED = new Set(["22023", "22P05", "22021"]);

/**
 * Codes of a database out of reach for a moment: too many connections, a
 * shutdown or restart, and the prepared statements a transaction pooler
 * mixes up (42P05 "already exists", 26000 "does not exist").
 */
const UNAVAILABLE = new Set(["53300", "57P01", "57P02", "57P03", "42P05", "26000"]);

/** The answer of a gated call, as supabase-js gives it. */
export interface DbFailure {
  code?: string;
  message: string;
}

function unavailable(error: DbFailure, status: number | undefined): boolean {
  const code = error.code ?? "";
  // PostgREST's own: no connection (000, 001), schema cache not ready (002), pool timeout (003).
  if (/^PGRST00\d$/.test(code)) return true;
  // Connection exceptions (class 08), and the codes above.
  if (code.startsWith("08") || UNAVAILABLE.has(code)) return true;
  if (/prepared statement .* (already exists|does not exist)/.test(error.message)) return true;
  // supabase-js turns what its fetch threw into "<name>: <message>", status 0.
  if (status === 0 || /^(TypeError|FetchError)\b/.test(error.message)) return true;
  // A gateway's answer (Kong's "An invalid response was received from the
  // upstream server"), or any 5xx without the database's own code.
  if (status === 502 || status === 503 || status === 504) return true;
  return status !== undefined && status >= 500 && code === "";
}

/** What a supabase-js error from a gated call means (`status`: the HTTP status it came with). */
export function dbErrorOf(error: DbFailure, signal: AbortSignal, status?: number): Error {
  if (error.message.startsWith(`${ANSWER_TOO_LARGE}:`)) return new DbTooLargeError(error.message);
  if (error.code === "57014") return new DbTimeoutError(error.message);
  // The API's abort (the call outlived timeoutMs: the database is not answering).
  if (signal.aborted || /^(AbortError|TimeoutError)\b/.test(error.message)) {
    return new DbUnavailableError(error.message);
  }
  if (unavailable(error, status)) return new DbUnavailableError(error.message);
  if (error.code && REFUSED.has(error.code)) return new DbRefusedError(error.message);
  return new Error(error.message);
}

export interface DbGateOptions {
  /** Calls at once. */
  max: number;
  /** Calls waiting for a slot, at most. */
  queue: number;
  /** How long a call waits for a slot before its 503. */
  waitMs: number;
  /** The API's abort of a call. */
  timeoutMs: number;
  /** How long the slot of an aborted call stays taken. */
  holdMs: number;
}

/** Where a request's time went, for Server-Timing. */
export interface DbTiming {
  /** Waiting for a slot. */
  gateMs: number;
  /** In the calls. */
  dbMs: number;
  /** Calls made. */
  calls: number;
}

export const newTiming = (): DbTiming => ({ gateMs: 0, dbMs: 0, calls: 0 });

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class DbGate {
  private active = 0;
  private held = 0;
  private readonly waiting: Waiter[] = [];

  constructor(readonly opts: DbGateOptions) {}

  /** Run `call` in a slot, with the abort signal it must pass to its request. */
  async run<T>(call: (signal: AbortSignal) => Promise<T>, timing?: DbTiming): Promise<T> {
    const queued = performance.now();
    await this.acquire();
    const started = performance.now();
    if (timing) {
      timing.gateMs += started - queued;
      timing.calls++;
    }
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    try {
      return await call(signal);
    } finally {
      if (timing) timing.dbMs += performance.now() - started;
      if (signal.aborted) {
        this.held++;
        setTimeout(() => {
          this.held--;
          this.release();
        }, this.opts.holdMs).unref();
      } else {
        this.release();
      }
    }
  }

  stats(): { active: number; held: number; waiting: number } {
    return { active: this.active, held: this.held, waiting: this.waiting.length };
  }

  private acquire(): Promise<void> {
    if (this.active < this.opts.max) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.opts.queue) return Promise.reject(new DbBusyError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new DbBusyError());
        }, this.opts.waitMs),
      };
      this.waiting.push(waiter);
    });
  }

  /** A slot freed: handed to the first waiter, or given back. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.active--;
    }
  }
}

/** The API's gate for the read RPCs. */
export const dbGate = new DbGate({
  max: 6,
  queue: 50,
  waitMs: 5000,
  timeoutMs: 7000,
  holdMs: 5000,
});
