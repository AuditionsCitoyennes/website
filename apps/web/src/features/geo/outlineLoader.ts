// Fetches the outline files of one build into an OutlineStore (outlines.ts).
// Pure: fetch, timers, the wrap and the perf hooks are injected, so node tests
// drive it with a fake clock. Nothing at import but declarations.
//
// Only files a row or an entry declares (its k/u/g flag) are ever requested.
// One request per URL at a time: the shared request holds fetch + check +
// parse + validate, never the write; each caller then writes through the
// store, which skips a file already loaded, so a URL shared by two callers is
// fetched once and written once. A failure is per file: root.json and k/FR
// end the session (the fallback: no outlines at all); so does a release skew on any file
// (the host holds another build, or none: a tab opened before a deploy), once
// a refetch past the HTTP cache confirms it (after the network retry too); a
// network failure is retried once, then failed, until the next ensure after
// `failedMs` asks again; a missing or malformed file is final at once. Once
// the session fell back, nothing is requested any more, not even the next
// attempt of a request under way. A boot still under way after `bootMs` is
// not a failure: `ready` turns "late" (the page stops waiting for it) and the
// boot goes on — a main thread busy with the map's own start can hold a
// response that has long arrived (`bootCap: "fallback"` ends the session
// there instead). With `bootRetryMs`, a network failure of root.json or k/FR
// does not end the session either: `ready` turns "late" and the boot is
// asked again after each wait in turn, then only when `reconnect()` says the
// network may be back (the page: the browser back online, the page shown
// again) — which also starts the waits over, and lets every file failed on
// the network be asked again by the next ensure, without its failedMs. An overseas région's files are its département's
// (OutlineStore.filesIdOf): each public method reads them by that id.
//
// A batch can be "low" (decoration: ensureGlobe and batchSelf's `low`): its
// requests go at low fetch priority, at most `lowParallel` at a time — a
// request's abort timer starts when its turn comes, never while it waits —
// and its one write goes through `applyLow` (the page: when the map is
// still). A caller that is not low asking a URL still waiting for its turn
// starts it at once, at the default priority.

import {
  checkResponse,
  fileKey,
  fileUrl,
  isReleaseSkew,
  parseBody,
  rootUrl,
  validateBody,
  verticesOf,
  type Checked,
  type OutlineFileV1,
  type OutlineKind,
  type OutlineReason,
  type OutlineStore,
  type OutlineWrap,
  type RootV1,
} from "./outlines";

/** How long a plateau waits for its self file before rising on what it has. */
export const OUTLINE_WAIT_MS = 1200;

export type OutlineStatus = "loaded" | "absent" | "failed" | "fallback";
export type OutlineMode = "fichiers" | "fallback";
export type OutlineReady = "loading" | "late" | "ok" | "fallback";

/** What the loader reads of a response. */
export interface OutlineResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
type Timer = unknown;
type Detail = Record<string, unknown>;

export interface OutlineLoaderOptions {
  store: OutlineStore;
  /** Default credentials and no custom header: no CORS preflight. */
  fetchFn: (
    url: string,
    init: { signal: AbortSignal; cache?: "reload"; priority?: "low" },
  ) => Promise<OutlineResponse>;
  /** Ends with "/". */
  base: string;
  build: string;
  wrap: OutlineWrap;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
  onWrite: (version: number) => void;
  /** `failed` or `gaveUp` was replaced. */
  onSets: () => void;
  onMode: (
    mode: OutlineMode,
    ready: OutlineReady,
    why?: { reason: OutlineReason; key: string },
  ) => void;
  span?: (name: string, detail: Detail) => (more?: Detail) => void;
  waitMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  /** The boot (root.json, k/FR) still under way this long after ensureRoot
   *  (none: no deadline) turns `ready` to "late": the page stops waiting for
   *  files that may not come, while the boot goes on. */
  bootMs?: number;
  /** What the deadline does: "late" (the default) turns `ready` to "late"
   *  and lets the boot go on; "fallback" ends the session there, its
   *  requests aborted (the cap before 2026-11-10). */
  bootCap?: "late" | "fallback";
  /** A file failed on the network is asked again by the first ensure this
   *  long after (not before: a dead network is not asked on every move). */
  failedMs?: number;
  /** A boot failed on the network is asked again after each of these waits
   *  in turn, then on `reconnect()` alone; meanwhile `ready` is "late"
   *  (none: the session falls back at once, as a skew does). */
  bootRetryMs?: readonly number[];
  /** At most this many low requests at once (none: no limit); the others
   *  wait their turn, their abort timer not armed yet. */
  lowParallel?: number;
  /** How a low batch's write is applied (none: at once). It must call
   *  `write` once; the batch settles after it. */
  applyLow?: (write: () => void) => void;
}

/** A low request waiting for its turn: its URL and its start (`low`: it
 *  takes a turn; false: started at once by a caller that is not low). */
interface LowWait {
  url: string;
  go: (low: boolean) => void;
}

type Expect = { build: string; kind: "root" } | { build: string; kind: OutlineKind; id: string };
const NETWORK = { ok: false, reason: "network" } as const;

export class OutlineLoader {
  mode: OutlineMode = "fichiers";
  ready: OutlineReady = "loading";
  /** fileKeys whose file will not come this session (replaced on change). */
  failed: ReadonlySet<string> = new Set();
  /** Self files a plateau stopped waiting for (replaced on change). */
  gaveUp: ReadonlySet<string> = new Set();
  private readonly o: OutlineLoaderOptions;
  private readonly inflight = new Map<string, Promise<Checked<unknown>>>();
  private readonly prefetched = new Set<string>();
  private readonly waiting = new Set<string>();
  /** Network failures past their failedMs: the next ensure asks again. */
  private readonly retryable = new Set<string>();
  private readonly live = new Set<AbortController>();
  private root?: Promise<OutlineStatus>;
  /** root.json is in the store (a boot asked again starts at k/FR). */
  private rootIn = false;
  /** The next wait of a boot asked again (an index into bootRetryMs). */
  private bootTry = 0;
  /** Ends the boot's wait before its next attempt, while it waits. */
  private bootWake?: () => void;
  /** Files failed on the network (reconnect() lets them be asked again). */
  private readonly netFailed = new Set<string>();
  /** Low requests running, and those waiting for their turn (in order). */
  private lowRunning = 0;
  private readonly lowQueue: LowWait[] = [];

  constructor(options: OutlineLoaderOptions) {
    this.o = options;
  }

  /** root.json then k/FR; any failure of either ends the session (the
   *  fallback) — but a network one under `bootRetryMs` (header); `bootMs`
   *  passing first turns `ready` to "late" (or ends the session too, under
   *  `bootCap: "fallback"`). */
  ensureRoot(): Promise<OutlineStatus> {
    const first = !this.root;
    this.root ??= this.boot();
    if (first && this.o.bootMs !== undefined) {
      const late = this.o.setTimer(() => {
        if (this.o.bootCap !== "fallback") {
          this.set("fichiers", "late"); // the boot goes on; "ok" when it lands
          return;
        }
        this.fallback("network", "root");
        for (const abort of this.live) abort.abort(); // the boot's: it settles now
      }, this.o.bootMs);
      void this.root.finally(() => this.o.clearTimer(late));
    }
    return this.root;
  }

  /** The network may be back: a boot waiting for its next attempt makes it
   *  now (its waits start over), and every file failed on the network may be
   *  asked again by the next ensure. */
  reconnect(): void {
    for (const key of this.netFailed) this.retryable.add(key);
    if (!this.bootWake) return;
    this.bootTry = 0;
    this.bootWake();
  }

  /** The boot's attempts: the next after each wait when one failed on the
   *  network under `bootRetryMs`, until one is final. */
  private async boot(): Promise<OutlineStatus> {
    for (;;) {
      const status = await this.bootOnce();
      if (status !== "again") return status;
      this.set("fichiers", "late"); // the page stops waiting; the boot goes on
      await this.bootPause();
      if (this.off()) return "fallback";
    }
  }

  /** One attempt of the boot: root.json (unless in), then k/FR; "again": it
   *  failed on the network, and will be asked again. */
  private async bootOnce(): Promise<OutlineStatus | "again"> {
    const { base, build } = this.o;
    if (!this.rootIn) {
      const r = await this.request(rootUrl(base, build), "root", { build, kind: "root" });
      if (this.off()) return "fallback";
      if (!r.ok) return this.bootAgain(r.reason) ? "again" : this.fallback(r.reason, "root");
      this.o.store.putRoot(r.file as RootV1);
      this.rootIn = true;
      this.o.onWrite(this.o.store.version);
      if (!this.o.store.rowOf("FR")?.k) return this.fallback("shape", fileKey("k", "FR"));
    }
    const fr = await this.load("k", "FR", true);
    if (fr === "failed") return "again"; // a network failure under bootRetryMs (fail)
    if (fr !== "loaded") return fr;
    this.set("fichiers", "ok");
    return "loaded";
  }

  /** A boot failure worth another attempt: a network one, under bootRetryMs. */
  private bootAgain(reason: OutlineReason): boolean {
    return reason === "network" && this.o.bootRetryMs !== undefined;
  }

  /** The wait before the boot's next attempt: the schedule's next, or past
   *  it until reconnect() (or the session's fallback) ends it. */
  private bootPause(): Promise<void> {
    return new Promise<void>((resume) => {
      const ms = this.o.bootRetryMs?.[this.bootTry++];
      let timer: Timer | undefined;
      const wake = () => {
        if (timer !== undefined) this.o.clearTimer(timer);
        this.bootWake = undefined;
        resume();
      };
      if (ms !== undefined) timer = this.o.setTimer(wake, ms);
      this.bootWake = wake;
    });
  }

  /** The unit's bundle (its self and its children), if its row says k:1. */
  async ensureBundle(unit: string): Promise<OutlineStatus> {
    if (await this.stopped()) return "fallback";
    const id = this.o.store.filesIdOf(unit);
    if (this.o.store.bundleLoaded(id)) return "loaded";
    return this.o.store.rowOf(id)?.k ? this.load("k", id) : "absent";
  }

  /** The unit's self: nothing to fetch when it is stored (a département's
   *  entry is its self), else its u/ file, else its bundle. */
  async ensureSelf(unit: string): Promise<OutlineStatus> {
    if (await this.stopped()) return "fallback";
    const id = this.o.store.filesIdOf(unit);
    const row = this.o.store.rowOf(id);
    if (!row) return "absent";
    if (this.o.store.has(id, row.st)) return "loaded";
    const kind = this.selfKind(id);
    if (!kind) return "absent";
    const stop = this.waitFor(fileKey(kind, id));
    try {
      return kind === "u" ? await this.load("u", id) : await this.ensureBundle(id);
    } finally {
      stop();
    }
  }

  /** The selves of these units not stored yet, in ONE write (`low`:
   *  decoration, see the header). */
  async batchSelf(units: string[], low = false): Promise<OutlineStatus[]> {
    if (await this.stopped()) return units.map(() => "fallback");
    const ids = units.map((u) => this.o.store.filesIdOf(u));
    return this.many(
      ids,
      (id) => {
        const row = this.o.store.rowOf(id);
        return row && this.o.store.has(id, row.st) ? "loaded" : this.selfKind(id);
      },
      true,
      low,
    );
  }

  /** The world-tier outlines of these countries (g:1 rows), and the u/ of
   *  `selves` (micro-states, drawn with their self), in ONE write. No wait is
   *  armed: no plateau stands on this batch (`low`: decoration, see the
   *  header). */
  async ensureGlobe(ids: string[], selves: string[] = [], low = false): Promise<OutlineStatus[]> {
    const all = [...ids, ...selves];
    if (await this.stopped()) return all.map(() => "fallback");
    const self = new Set(selves);
    const { store } = this.o;
    const want = (id: string) => {
      const kind = self.has(id) ? "u" : "g";
      return store.loaded(kind, id) ? "loaded" : store.rowOf(id)?.[kind] ? kind : null;
    };
    return this.many(all, want, false, low);
  }

  /** Warms the HTTP cache with a declared file (a hover): never writes, never
   *  fails. Settles with its request (or the one under way for that file). */
  prefetch(kind: OutlineKind, unit: string): Promise<void> {
    const id = this.o.store.filesIdOf(unit);
    if (
      this.mode !== "fichiers" ||
      !this.declared(kind, id) ||
      this.o.store.loaded(kind, id) ||
      this.failed.has(fileKey(kind, id))
    )
      return Promise.resolve();
    const url = fileUrl(this.o.base, this.o.build, kind, id);
    const under = this.inflight.get(url);
    if (under || this.prefetched.has(url)) return under ? under.then(() => {}) : Promise.resolve();
    this.prefetched.add(url);
    return this.request(url, fileKey(kind, id), { build: this.o.build, kind, id }).then(() => {});
  }

  isFailed(kind: OutlineKind, id: string): boolean {
    return this.failed.has(fileKey(kind, this.o.store.filesIdOf(id)));
  }
  isGaveUp(kind: OutlineKind, id: string): boolean {
    return this.gaveUp.has(fileKey(kind, this.o.store.filesIdOf(id)));
  }
  /** Its self is stored, or will not come (failed, given up), or none is declared. */
  selfSettled(unit: string): boolean {
    if (this.off()) return true;
    const id = this.o.store.filesIdOf(unit);
    const row = this.o.store.rowOf(id);
    if (row && this.o.store.has(id, row.st)) return true;
    const kind = this.selfKind(id);
    return !kind || this.failed.has(fileKey(kind, id)) || this.gaveUp.has(fileKey(kind, id));
  }

  private off(): boolean {
    return this.mode === "fallback";
  }
  /** Waits for a boot under way; true in fallback. */
  private async stopped(): Promise<boolean> {
    if (this.root && this.mode !== "fallback") await this.root;
    return this.off();
  }
  private selfKind(id: string): OutlineKind | null {
    const row = this.o.store.rowOf(id);
    return row?.u ? "u" : row?.k ? "k" : null;
  }
  private declared(kind: OutlineKind, id: string): boolean {
    return !!this.o.store.rowOf(id)?.[kind];
  }

  /** One file: requested, then written (or its failure recorded). */
  private async load(kind: OutlineKind, id: string, root = false): Promise<OutlineStatus> {
    const key = fileKey(kind, id);
    if (this.failed.has(key) && !this.retry(key)) return "failed";
    const { base, build } = this.o;
    const r = await this.request(fileUrl(base, build, kind, id), key, { build, kind, id });
    if (this.off()) return "fallback";
    if (!r.ok) return this.fail(key, r.reason, root);
    this.write([r.file as OutlineFileV1]);
    return "loaded";
  }

  /** Several files, settled together and written in one call; `hold`: each
   *  self file arms its give-up timer; `low`: a decorative batch (header). */
  private async many(
    ids: string[],
    want: (id: string) => OutlineKind | "loaded" | null,
    hold = true,
    low = false,
  ): Promise<OutlineStatus[]> {
    const { base, build } = this.o;
    const jobs = new Map<string, Promise<Checked<unknown>>>();
    const plan = ids.map((id): { status?: OutlineStatus; key?: string } => {
      const kind = want(id);
      if (kind === "loaded" || !kind) return { status: kind ? "loaded" : "absent" };
      const key = fileKey(kind, id);
      if (this.failed.has(key) && !this.retry(key)) return { status: "failed" };
      if (!jobs.has(key)) {
        const stop = kind === "g" || !hold ? () => {} : this.waitFor(key);
        jobs.set(
          key,
          this.request(fileUrl(base, build, kind, id), key, { build, kind, id }, low).finally(stop),
        );
      }
      return { key };
    });
    const keys = [...jobs.keys()];
    const settled = await Promise.allSettled(jobs.values());
    const results = new Map<string, Checked<unknown>>();
    settled.forEach((s, i) => results.set(keys[i], s.status === "fulfilled" ? s.value : NETWORK));
    const files: OutlineFileV1[] = [];
    const fate = new Map<string, OutlineStatus>();
    for (const [key, r] of results) {
      if (this.off()) break;
      if (r.ok) files.push(r.file as OutlineFileV1);
      fate.set(key, r.ok ? "loaded" : this.fail(key, r.reason, false));
    }
    if (this.off()) return ids.map(() => "fallback");
    const apply = low ? this.o.applyLow : undefined;
    if (apply && files.length) {
      // Its one write when the page says (the map still): never after a fallback.
      await new Promise<void>((done) =>
        apply(() => {
          if (!this.off()) this.write(files);
          done();
        }),
      );
      if (this.off()) return ids.map(() => "fallback");
    } else this.write(files);
    return plan.map((p) => p.status ?? fate.get(p.key!)!);
  }

  /** Writes the files not loaded yet: a caller that joined another's request
   *  finds its file written, and writes (and times) nothing. */
  private write(files: OutlineFileV1[]): void {
    const fresh = files.filter((f) => !this.o.store.loaded(f.kind, f.id));
    if (!fresh.length) return;
    const key = fresh.map((f) => fileKey(f.kind, f.id)).join(" ");
    const before = this.o.store.version;
    const end = this.o.span?.("outline.decode", { key, phase: "write" });
    this.o.store.putMany(fresh, this.o.wrap);
    end?.({ vertices: fresh.reduce((n, f) => n + verticesOf(f), 0) });
    if (this.o.store.version !== before) this.o.onWrite(this.o.store.version);
  }

  private fail(key: string, reason: OutlineReason, root: boolean): OutlineStatus {
    // The boot's file, failed on the network under bootRetryMs: asked again by the boot.
    if (root && this.bootAgain(reason)) return "failed";
    if (root || isReleaseSkew(reason)) return this.fallback(reason, key);
    this.failed = new Set(this.failed).add(key);
    this.o.onSets();
    if (reason === "network") {
      this.netFailed.add(key);
      this.o.setTimer(() => this.retryable.add(key), this.o.failedMs ?? 5_000);
    }
    return "failed";
  }

  /** A network failure past its failedMs leaves `failed`: asked again now. */
  private retry(key: string): boolean {
    if (!this.retryable.delete(key)) return false;
    this.netFailed.delete(key);
    const failed = new Set(this.failed);
    failed.delete(key);
    this.failed = failed;
    this.o.onSets();
    return true;
  }

  /** The session falls back (no outlines for its rest): files from this build must
   *  not mix with nothing for the rest of it. */
  private fallback(reason: OutlineReason, key: string): "fallback" {
    if (this.mode !== "fallback") this.set("fallback", "fallback", { reason, key });
    this.bootWake?.(); // a boot waiting for its next attempt ends now
    return "fallback";
  }

  private set(
    mode: OutlineMode,
    ready: OutlineReady,
    why?: { reason: OutlineReason; key: string },
  ) {
    if (mode === this.mode && ready === this.ready) return;
    this.mode = mode;
    this.ready = ready;
    this.o.onMode(mode, ready, why);
  }

  /** Arms the give-up timer of a self file, once per request of it. */
  private waitFor(key: string): () => void {
    if (this.waiting.has(key) || this.gaveUp.has(key)) return () => {};
    this.waiting.add(key);
    const timer = this.o.setTimer(() => {
      this.gaveUp = new Set(this.gaveUp).add(key);
      this.o.onSets();
    }, this.o.waitMs ?? OUTLINE_WAIT_MS);
    return () => {
      this.o.clearTimer(timer);
      this.waiting.delete(key);
    };
  }

  /** The shared request of a URL: one network retry, then one skew confirm
   *  (whichever attempt saw the skew); no further attempt once the session
   *  fell back (its callers then answer "fallback"). */
  private request(
    url: string,
    key: string,
    expect: Expect,
    low = false,
  ): Promise<Checked<unknown>> {
    let job = this.inflight.get(url);
    if (!job) {
      job = (async () => {
        // A low request waits its turn BEFORE any abort timer is armed: the
        // timer counts from the request's real start, never from its place in
        // the queue. The turn is held through the retry and the skew confirm.
        const held = low ? await this.turn(url) : false;
        try {
          if (this.off()) return NETWORK; // fell back while it waited: never sent
          let r = await this.attempt(url, key, expect, false, held);
          if (!r.ok && r.reason === "network" && !this.off()) {
            await new Promise<void>((done) => this.o.setTimer(done, this.o.retryMs ?? 1_000));
            if (this.off()) return r;
            r = await this.attempt(url, key, expect, false, held);
          }
          // An immutable cache may hold an old SPA answer: ask past it once.
          if (!r.ok && isReleaseSkew(r.reason) && !this.off())
            r = await this.attempt(url, key, expect, true, held);
          return r;
        } finally {
          if (held) this.turnEnd();
        }
      })().finally(() => this.inflight.delete(url));
      this.inflight.set(url, job);
    } else if (!low) this.promote(url);
    return job;
  }

  /** A low request's turn: at once while fewer than `lowParallel` run (true:
   *  it holds a turn, to give back), else when one ends — or at once, holding
   *  none, when a caller that is not low asks its URL (false). */
  private turn(url: string): Promise<boolean> {
    const cap = this.o.lowParallel;
    if (cap === undefined || this.lowRunning < cap) {
      this.lowRunning++;
      return Promise.resolve(true);
    }
    return new Promise((go) => this.lowQueue.push({ url, go }));
  }
  /** A turn given back: the next low request waiting starts. */
  private turnEnd(): void {
    const next = this.lowQueue.shift();
    if (next) next.go(true);
    else this.lowRunning = Math.max(0, this.lowRunning - 1);
  }
  /** A caller that is not low asks this URL: if it waits its turn, it starts now. */
  private promote(url: string): void {
    const at = this.lowQueue.findIndex((w) => w.url === url);
    if (at === -1) return;
    const [waiting] = this.lowQueue.splice(at, 1);
    waiting.go(false);
  }

  /** One attempt, now: `low` sends it at low fetch priority. */
  private async attempt(url: string, key: string, expect: Expect, reload: boolean, low: boolean) {
    const { span } = this.o;
    const abort = new AbortController();
    // Not AbortSignal.timeout: missing on iOS < 16.
    const timer = this.o.setTimer(() => abort.abort(), this.o.timeoutMs ?? 15_000);
    this.live.add(abort);
    try {
      const fetched = span?.("outline.fetch", { key });
      let text: string;
      try {
        const init: { signal: AbortSignal; cache?: "reload"; priority?: "low" } = {
          signal: abort.signal,
        };
        if (reload) init.cache = "reload";
        if (low) init.priority = "low";
        const res = await this.o.fetchFn(url, init);
        const bad = checkResponse({
          ok: res.ok,
          status: res.status,
          contentType: res.headers.get("content-type"),
        });
        if (bad) return { ok: false, reason: bad } as const;
        text = await res.text();
      } catch {
        return NETWORK;
      }
      fetched?.({ bytes: text.length }); // UTF-16 units: the files are near-ASCII
      const parsed = span?.("outline.parse", { key, bytes: text.length });
      const body = parseBody(text);
      parsed?.();
      if (!body.ok) return body;
      const checked = span?.("outline.decode", { key, phase: "check" });
      const r: Checked<unknown> =
        expect.kind === "root" ? validateBody(body.body, expect) : validateBody(body.body, expect);
      checked?.(
        r.ok && expect.kind !== "root" ? { vertices: verticesOf(r.file as OutlineFileV1) } : {},
      );
      return r;
    } finally {
      this.o.clearTimer(timer);
      this.live.delete(abort);
    }
  }
}
