// The gate in front of the database's read functions (map phase 1, design
// D4): at most `max` calls at once, `queue` more waiting at most `waitMs`,
// then a 503 that is never cached. Each call is aborted after `timeoutMs`
// (7 s) — the service role's own statement timeout (5 s) normally ends it
// first, as a 57014 — and the slot of an aborted call is held `holdMs` more:
// the statement may still be running on the database, and the gate is what
// keeps the number of those bounded.

import { performance } from "node:perf_hooks";

/** The gate is full: 503, never cached. */
export class DbBusyError extends Error {
  readonly statusCode = 503;
  constructor() {
    super("Réessayez dans un instant.");
    this.name = "DbBusyError";
  }
}

/** The statement ran out of time (57014), or the API's abort fired: 503, never cached. */
export class DbTimeoutError extends Error {
  readonly statusCode = 503;
  constructor(readonly detail: string) {
    super("Recherche trop large : précisez-la.");
    this.name = "DbTimeoutError";
  }
}

/** The database refused the arguments (22023): 400. */
export class DbRefusedError extends Error {
  readonly statusCode = 400;
  constructor(readonly detail: string) {
    super("Paramètres invalides.");
    this.name = "DbRefusedError";
  }
}

/** Whether a failed call may be answered with a value still held (a timeout, a full gate). */
export function isTransientDbError(err: unknown): boolean {
  return err instanceof DbTimeoutError || err instanceof DbBusyError;
}

/** What a supabase-js error from a gated call means. */
export function dbErrorOf(error: { code?: string; message: string }, signal: AbortSignal): Error {
  if (
    error.code === "57014" ||
    signal.aborted ||
    /^(AbortError|TimeoutError)\b/.test(error.message)
  ) {
    return new DbTimeoutError(error.message);
  }
  if (error.code === "22023") return new DbRefusedError(error.message);
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
