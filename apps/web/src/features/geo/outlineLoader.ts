// Fetches the outline files of one build into an OutlineStore (outlines.ts).
// Pure: fetch, timers, the wrap and the perf hooks are injected, so node tests
// drive it with a fake clock. Nothing at import but declarations.
//
// Only files a row or an entry declares (its k/u/g flag) are ever requested.
// One request per URL at a time: the shared request holds fetch + check +
// parse + validate, never the write; each caller then writes through the
// store, which skips a file already loaded, so a URL shared by two callers is
// fetched once and written once. A failure is per file: root.json and k/FR
// end the session on the API's outlines; so does a release skew on any file
// (the host holds another build, or none: a tab opened before a deploy), once
// a refetch past the HTTP cache confirms it (after the network retry too); a
// network failure is retried once, then failed, until the next ensure after
// `failedMs` asks again; a missing or malformed file is final at once. Once
// the session fell back, nothing is requested any more, not even the next
// attempt of a request under way.

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
export type OutlineReady = "loading" | "ok" | "fallback";

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
    init: { signal: AbortSignal; cache?: "reload" },
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
  /** ensureRoot gives up after this long (none: it waits for its requests),
   *  its requests aborted: a stalled boot must not keep the page waiting for
   *  files that may not come. */
  bootMs?: number;
  /** A file failed on the network is asked again by the first ensure this
   *  long after (not before: a dead network is not asked on every move). */
  failedMs?: number;
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

  constructor(options: OutlineLoaderOptions) {
    this.o = options;
  }

  /** root.json then k/FR; any failure of either, or `bootMs` passing first,
   *  ends the session on the API. */
  ensureRoot(): Promise<OutlineStatus> {
    const first = !this.root;
    this.root ??= (async () => {
      const { base, build } = this.o;
      const r = await this.request(rootUrl(base, build), "root", { build, kind: "root" });
      if (this.off()) return "fallback";
      if (!r.ok) return this.fallback(r.reason, "root");
      this.o.store.putRoot(r.file as RootV1);
      this.o.onWrite(this.o.store.version);
      if (!this.o.store.rowOf("FR")?.k) return this.fallback("shape", fileKey("k", "FR"));
      const fr = await this.load("k", "FR", true);
      if (fr !== "loaded") return fr;
      this.set("fichiers", "ok");
      return "loaded";
    })();
    if (first && this.o.bootMs !== undefined) {
      const late = this.o.setTimer(() => {
        this.fallback("network", "root");
        for (const abort of this.live) abort.abort(); // the boot's: it settles now
      }, this.o.bootMs);
      void this.root.finally(() => this.o.clearTimer(late));
    }
    return this.root;
  }

  /** The unit's bundle (its self and its children), if its row says k:1. */
  async ensureBundle(id: string): Promise<OutlineStatus> {
    if (await this.stopped()) return "fallback";
    if (this.o.store.bundleLoaded(id)) return "loaded";
    return this.o.store.rowOf(id)?.k ? this.load("k", id) : "absent";
  }

  /** The unit's self: nothing to fetch when it is stored (a département's
   *  entry is its self), else its u/ file, else its bundle. */
  async ensureSelf(id: string): Promise<OutlineStatus> {
    if (await this.stopped()) return "fallback";
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

  /** The selves of these units not stored yet, in ONE write. */
  async batchSelf(ids: string[]): Promise<OutlineStatus[]> {
    if (await this.stopped()) return ids.map(() => "fallback");
    return this.many(ids, (id) => {
      const row = this.o.store.rowOf(id);
      return row && this.o.store.has(id, row.st) ? "loaded" : this.selfKind(id);
    });
  }

  /** The world-tier outlines of these countries (g:1 rows), in ONE write. */
  async ensureGlobe(ids: string[]): Promise<OutlineStatus[]> {
    if (await this.stopped()) return ids.map(() => "fallback");
    return this.many(ids, (id) =>
      this.o.store.loaded("g", id) ? "loaded" : this.o.store.rowOf(id)?.g ? "g" : null,
    );
  }

  /** Warms the HTTP cache with a declared file (a hover): never writes, never
   *  fails. Settles with its request (or the one under way for that file). */
  prefetch(kind: OutlineKind, id: string): Promise<void> {
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
    return this.failed.has(fileKey(kind, id));
  }
  isGaveUp(kind: OutlineKind, id: string): boolean {
    return this.gaveUp.has(fileKey(kind, id));
  }
  /** Its self is stored, or will not come (failed, given up), or none is declared. */
  selfSettled(id: string): boolean {
    if (this.off()) return true;
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

  /** Several files, settled together and written in one call. */
  private async many(
    ids: string[],
    want: (id: string) => OutlineKind | "loaded" | null,
  ): Promise<OutlineStatus[]> {
    const { base, build } = this.o;
    const jobs = new Map<string, Promise<Checked<unknown>>>();
    const plan = ids.map((id): { status?: OutlineStatus; key?: string } => {
      const kind = want(id);
      if (kind === "loaded" || !kind) return { status: kind ? "loaded" : "absent" };
      const key = fileKey(kind, id);
      if (this.failed.has(key) && !this.retry(key)) return { status: "failed" };
      if (!jobs.has(key)) {
        const stop = kind === "g" ? () => {} : this.waitFor(key);
        jobs.set(
          key,
          this.request(fileUrl(base, build, kind, id), key, { build, kind, id }).finally(stop),
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
    this.write(files);
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
    if (root || isReleaseSkew(reason)) return this.fallback(reason, key);
    this.failed = new Set(this.failed).add(key);
    this.o.onSets();
    if (reason === "network")
      this.o.setTimer(() => this.retryable.add(key), this.o.failedMs ?? 5_000);
    return "failed";
  }

  /** A network failure past its failedMs leaves `failed`: asked again now. */
  private retry(key: string): boolean {
    if (!this.retryable.delete(key)) return false;
    const failed = new Set(this.failed);
    failed.delete(key);
    this.failed = failed;
    this.o.onSets();
    return true;
  }

  /** The session goes back to the API's outlines: files from this build must
   *  not mix with nothing for the rest of it. */
  private fallback(reason: OutlineReason, key: string): "fallback" {
    if (this.mode !== "fallback") this.set("fallback", "fallback", { reason, key });
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
  private request(url: string, key: string, expect: Expect): Promise<Checked<unknown>> {
    let job = this.inflight.get(url);
    if (!job) {
      job = (async () => {
        let r = await this.attempt(url, key, expect, false);
        if (!r.ok && r.reason === "network" && !this.off()) {
          await new Promise<void>((done) => this.o.setTimer(done, this.o.retryMs ?? 1_000));
          if (this.off()) return r;
          r = await this.attempt(url, key, expect, false);
        }
        // An immutable cache may hold an old SPA answer: ask past it once.
        if (!r.ok && isReleaseSkew(r.reason) && !this.off())
          r = await this.attempt(url, key, expect, true);
        return r;
      })().finally(() => this.inflight.delete(url));
      this.inflight.set(url, job);
    }
    return job;
  }

  private async attempt(url: string, key: string, expect: Expect, reload: boolean) {
    const { span } = this.o;
    const abort = new AbortController();
    // Not AbortSignal.timeout: missing on iOS < 16.
    const timer = this.o.setTimer(() => abort.abort(), this.o.timeoutMs ?? 15_000);
    this.live.add(abort);
    try {
      const fetched = span?.("outline.fetch", { key });
      let text: string;
      try {
        const init = reload
          ? { signal: abort.signal, cache: "reload" as const }
          : { signal: abort.signal };
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
