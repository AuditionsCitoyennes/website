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
// starts it at once, at the default priority — or, under the late files'
// rules, for what that caller asks it.
//
// With the late files (below) too: a low request whose text is kept gives
// its turn back as it lands (it is off the network), so the next one waiting
// starts — a low batch kept together could never be whole otherwise; the
// flush writes it, and the low batch's own write then finds it stored.
//
// Late files (`late`, the page's ac:late-files "quiet"; without it nothing
// below applies). Each ask says what it is for: "due" — the selected unit's
// plateau waits for this file — goes at high fetch priority; "late" (a
// unit's children, its neighbours, the world's outlines) and a prefetch go at
// low priority; the boot (root.json, k/FR) is left as it is. Nothing is ever
// aborted for it. When a file's text lands and the page says nothing waits
// for it (`late.urgent`: asked again then, so a file asked "due" for a unit
// since left is late too), the text is KEPT: parsed, checked and written
// only when the map is still (`late.whenStill`), every kept file in ONE write
// — and the flush waits once, `batchMs`, for the late files still on the
// network, so a unit's children and its neighbours make one change. The
// files of one batch (batchSelf, ensureGlobe) stay together: none of them is
// written before all of them are in, however slow the link. A kept file a
// "due" ask joins, or one that turned urgent, is written at once. A request
// only a prefetch made is never kept (it never writes).
//
// A self ahead of its bundle (`selfGraceMs`, the page's ac:region-self
// "first"): the page asks a unit's u/ ("due", ensureSelf) and its bundle
// ("late") together. The u/, once in, waits `selfGraceMs` for a bundle still
// on the network: one that lands in that time is written first — its self is
// the same object, its children come with it, the plateau rises with their
// lines — and the u/ then has nothing left to write. Past it, the u/ is
// written alone and the bundle is a late file like any other.
//
// `reask` (the page's « Réessayer », once a plateau has waited too long): the
// attempts on the network the page says a plateau waits for are dropped and
// made again at once. Such an attempt is none of its request's two: the
// request, its callers and its timers go on as they were.

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
/** How long a flush of the kept files waits, once, for the late files still
 *  on the network (the rest of a batch). */
export const LATE_BATCH_MS = 400;

/** What a file is asked for (the header's last paragraph). */
export type OutlineAsk = "boot" | "due" | "late" | "prefetch";

/** The late files' rules, from the page (see the header). */
export interface OutlineLateOptions {
  /** The selected unit's plateau waits for this file (a fileKey), now. */
  urgent(key: string): boolean;
  /** Runs `job` once the map is still. It must run it, once, whatever happens. */
  whenStill(job: () => void): void;
  /** `held` was replaced. */
  onHeld?(): void;
  batchMs?: number;
}

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
    init: { signal: AbortSignal; cache?: "reload"; priority?: "high" | "low" },
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
  /** The late files' rules (none: every file is parsed and written as it lands). */
  late?: OutlineLateOptions;
  /** How long a self from its u/ waits, once in, for its unit's bundle still
   *  on the network (none, or 0: written at once). */
  selfGraceMs?: number;
}

/** A low request waiting for its turn: its URL and its start (`low`: it
 *  takes a turn; false: started at once by a caller that is not low, for
 *  what that caller asks it: `ask`). */
interface LowWait {
  url: string;
  go: (low: boolean, ask?: OutlineAsk) => void;
}
/** A low request's turn come: `held`, a turn to give back; `ask`, what the
 *  caller that started it sooner asks it for. */
interface LowTurn {
  held: boolean;
  ask?: OutlineAsk;
}

/** A file kept as text until the map is still. */
interface Kept {
  key: string;
  expect: Expect;
  text: string;
  done: (r: Checked<unknown>) => void;
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
  /** fileKeys kept as text, not parsed yet (replaced on change). */
  held: ReadonlySet<string> = new Set();
  /** Files asked "due" that landed (or failed) once nothing waited for them. */
  abandonedDone = 0;
  private readonly o: OutlineLoaderOptions;
  private readonly inflight = new Map<string, Promise<Checked<unknown>>>();
  private readonly prefetched = new Set<string>();
  private readonly waiting = new Set<string>();
  /** Network failures past their failedMs: the next ensure asks again. */
  private readonly retryable = new Set<string>();
  private readonly live = new Set<AbortController>();
  /** The attempt on the network of each URL, and the URLs whose attempt
   *  `reask` dropped (made again at once). */
  private readonly attempts = new Map<string, { key: string; abort: AbortController }>();
  private readonly reasked = new Set<string>();
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
  /** The kept files, by URL; the requests on the network; the URLs a writer
   *  asked (not a prefetch alone). */
  private readonly kept = new Map<string, Kept>();
  private readonly flying = new Map<string, { key: string; due: boolean }>();
  private readonly wanted = new Set<string>();
  /** The batches under way (many), each one's URLs. */
  private readonly batches = new Set<readonly string[]>();
  /** The flush of the kept files: asked of `whenStill`, or waiting `batchMs`. */
  private flush: "idle" | "armed" | "waiting" = "idle";
  private batchWaited = false;

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

  /** The unit's bundle (its self and its children), if its row says k:1.
   *  `due`: the selected unit's plateau waits for it (see the header). */
  async ensureBundle(unit: string, due = false): Promise<OutlineStatus> {
    if (await this.stopped()) return "fallback";
    const id = this.o.store.filesIdOf(unit);
    if (this.o.store.bundleLoaded(id)) return "loaded";
    return this.o.store.rowOf(id)?.k ? this.load("k", id, false, due ? "due" : "late") : "absent";
  }

  /** The unit's self: nothing to fetch when it is stored (a département's
   *  entry is its self), else its u/ file, else its bundle. Asked "due": a
   *  plateau waits for it. */
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
      return kind === "u" ? await this.loadSelf(id) : await this.ensureBundle(id, true);
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
    return this.request(url, fileKey(kind, id), { build: this.o.build, kind, id }, "prefetch").then(
      () => {},
    );
  }

  /** A file asked "due" is still on the network while nothing waits for it
   *  any more (its unit was left): it shares the link with what is due now. */
  abandoned(): boolean {
    const late = this.o.late;
    if (!late) return false;
    for (const f of this.flying.values()) if (f.due && !late.urgent(f.key)) return true;
    return false;
  }

  /** The kept files that turned urgent (the selection came back to their
   *  unit) are parsed and written now. */
  flushDue(): void {
    const late = this.o.late;
    if (!late) return;
    for (const [url, k] of [...this.kept]) if (late.urgent(k.key)) this.flushLate(url);
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

  /** The attempts on the network for a file `waited` names (by its key: the
   *  files a plateau waits for) are dropped and made again now, each one at
   *  the fetch priority it had. A file whose text is in (kept until the map
   *  is still) is left alone. Returns the keys asked again. */
  reask(waited: (key: string) => boolean): string[] {
    const keys: string[] = [];
    if (this.off()) return keys;
    for (const [url, a] of this.attempts) {
      if (this.kept.has(url) || !waited(a.key)) continue;
      this.reasked.add(url);
      a.abort.abort();
      keys.push(a.key);
    }
    return keys;
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
  private async load(
    kind: OutlineKind,
    id: string,
    root = false,
    ask: OutlineAsk = "boot",
  ): Promise<OutlineStatus> {
    const key = fileKey(kind, id);
    if (this.failed.has(key) && !this.retry(key)) return "failed";
    const { base, build } = this.o;
    const r = await this.request(fileUrl(base, build, kind, id), key, { build, kind, id }, ask);
    if (this.off()) return "fallback";
    if (!r.ok) return this.fail(key, r.reason, root);
    this.write([r.file as OutlineFileV1]);
    return "loaded";
  }

  /** A self from its u/, asked "due": requested, then written — after
   *  `selfGraceMs` at most while its unit's bundle is on the network (see the
   *  header), and not at all when that bundle brought the self meanwhile. */
  private async loadSelf(id: string): Promise<OutlineStatus> {
    const key = fileKey("u", id);
    if (this.failed.has(key) && !this.retry(key)) return "failed";
    const { base, build, store } = this.o;
    const expect = { build, kind: "u", id } as const;
    const r = await this.request(fileUrl(base, build, "u", id), key, expect, "due");
    if (this.off()) return "fallback";
    if (!r.ok) return this.fail(key, r.reason, false);
    const bundle = this.inflight.get(fileUrl(base, build, "k", id));
    const grace = this.o.selfGraceMs ?? 0;
    if (bundle && grace > 0) {
      await Promise.race([
        bundle,
        new Promise<void>((done) => this.o.setTimer(() => done(), grace)),
      ]);
      if (this.off()) return "fallback";
      const row = store.rowOf(id);
      if (row && store.has(id, row.st)) return "loaded"; // the bundle's: the same object
    }
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
          this.request(
            fileUrl(base, build, kind, id),
            key,
            { build, kind, id },
            "late",
            low,
          ).finally(stop),
        );
      }
      return { key };
    });
    const keys = [...jobs.keys()];
    // Kept together (the late files): see flushLate.
    const urls =
      this.o.late && jobs.size > 1 ? keys.map((k) => `${base}outlines/${build}/${k}.json`) : null;
    if (urls) this.batches.add(urls);
    const settled = await Promise.allSettled(jobs.values()).finally(() => {
      if (urls) this.batches.delete(urls);
    });
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

  /** Arms the give-up timer of a self file, once per request of it. A wait
   *  the file of a unit since left crossed (`abandoned`) goes on once more. */
  private waitFor(key: string): () => void {
    if (this.waiting.has(key) || this.gaveUp.has(key)) return () => {};
    this.waiting.add(key);
    const ms = this.o.waitMs ?? OUTLINE_WAIT_MS;
    const done0 = this.abandonedDone;
    let crossed = this.abandoned();
    let timer: Timer;
    const end = (extended: boolean) => {
      if (this.held.has(key)) return; // kept as text: in, not given up
      crossed ||= this.abandoned() || this.abandonedDone !== done0;
      if (crossed && !extended) {
        timer = this.o.setTimer(() => end(true), ms);
        return;
      }
      this.gaveUp = new Set(this.gaveUp).add(key);
      this.o.onSets();
    };
    timer = this.o.setTimer(() => end(false), ms);
    return () => {
      this.o.clearTimer(timer);
      this.waiting.delete(key);
    };
  }

  /** The shared request of a URL: one network retry, then one skew confirm
   *  (whichever attempt saw the skew); no further attempt once the session
   *  fell back (its callers then answer "fallback"). `ask`: what the first
   *  caller asks it for (the header's last paragraph); `low`: a decorative
   *  batch's request (it takes a turn). */
  private request(
    url: string,
    key: string,
    expect: Expect,
    ask: OutlineAsk = "boot",
    low = false,
  ): Promise<Checked<unknown>> {
    const late = this.o.late;
    if (late && ask !== "prefetch") this.wanted.add(url);
    let job = this.inflight.get(url);
    if (!job) {
      job = (async () => {
        // A low request waits its turn BEFORE any abort timer is armed: the
        // timer counts from the request's real start, never from its place in
        // the queue. The turn is held through the retry and the skew confirm
        // — or given back sooner, once, when its text is kept (`landed`).
        // A caller that is not low starting it sooner makes it its own ask.
        const mine: LowTurn = low ? await this.turn(url) : { held: false };
        const held = mine.held;
        const as = mine.ask ?? ask;
        let turn = held;
        const landed = () => {
          if (!turn) return;
          turn = false;
          this.turnEnd();
        };
        try {
          if (this.off()) return NETWORK; // fell back while it waited: never sent
          let r = await this.attemptOn(url, key, expect, false, as, held, landed);
          if (!r.ok && r.reason === "network" && !this.off()) {
            await new Promise<void>((done) => this.o.setTimer(done, this.o.retryMs ?? 1_000));
            if (this.off()) return r;
            r = await this.attemptOn(url, key, expect, false, as, held, landed);
          }
          // An immutable cache may hold an old SPA answer: ask past it once.
          if (!r.ok && isReleaseSkew(r.reason) && !this.off())
            r = await this.attemptOn(url, key, expect, true, as, held, landed);
          return r;
        } finally {
          landed();
        }
      })().finally(() => {
        this.inflight.delete(url);
        this.wanted.delete(url);
        // A batch may be whole now (this one failed): its kept files can go.
        if (this.kept.size) this.armFlush();
      });
      this.inflight.set(url, job);
    } else {
      if (!low) this.promote(url, ask);
      // Kept as text, and now a plateau waits for it: written at once.
      if (late && this.kept.has(url) && (ask === "due" || late.urgent(key))) this.flushLate(url);
    }
    return job;
  }

  /** A low request's turn: at once while fewer than `lowParallel` run
   *  (`held`: it holds a turn, to give back), else when one ends — or at
   *  once, holding none, when a caller that is not low asks its URL (with
   *  that caller's `ask`). */
  private turn(url: string): Promise<LowTurn> {
    const cap = this.o.lowParallel;
    if (cap === undefined || this.lowRunning < cap) {
      this.lowRunning++;
      return Promise.resolve({ held: true });
    }
    return new Promise((go) => this.lowQueue.push({ url, go: (held, ask) => go({ held, ask }) }));
  }
  /** A turn given back: the next low request waiting starts. */
  private turnEnd(): void {
    const next = this.lowQueue.shift();
    if (next) next.go(true);
    else this.lowRunning = Math.max(0, this.lowRunning - 1);
  }
  /** A caller that is not low asks this URL: if it waits its turn, it starts
   *  now, for what that caller asks it. */
  private promote(url: string, ask: OutlineAsk): void {
    const at = this.lowQueue.findIndex((w) => w.url === url);
    if (at === -1) return;
    const [waiting] = this.lowQueue.splice(at, 1);
    waiting.go(false, ask);
  }

  /** One attempt of a request — made again, at once, for as long as `reask`
   *  drops it: a dropped attempt is none of the request's (`low`, `landed`:
   *  as `attempt` takes them). */
  private async attemptOn(
    url: string,
    key: string,
    expect: Expect,
    reload: boolean,
    ask: OutlineAsk,
    low = false,
    landed?: () => void,
  ) {
    for (;;) {
      const r = await this.attempt(url, key, expect, reload, ask, low, landed);
      const again = this.reasked.delete(url);
      if (r.ok || !again || this.off()) return r;
    }
  }

  /** One attempt, now: `low` sends it at low fetch priority; `landed` is told
   *  when its text is kept (a low request gives its turn back). */
  private async attempt(
    url: string,
    key: string,
    expect: Expect,
    reload: boolean,
    ask: OutlineAsk,
    low = false,
    landed?: () => void,
  ) {
    const { span, late } = this.o;
    const abort = new AbortController();
    // Not AbortSignal.timeout: missing on iOS < 16.
    const timer = this.o.setTimer(() => abort.abort(), this.o.timeoutMs ?? 15_000);
    this.live.add(abort);
    this.attempts.set(url, { key, abort });
    try {
      const fetched = span?.("outline.fetch", { key });
      let text: string;
      if (late) this.flying.set(url, { key, due: ask === "due" });
      try {
        const init: { signal: AbortSignal; cache?: "reload"; priority?: "high" | "low" } = {
          signal: abort.signal,
        };
        if (reload) init.cache = "reload";
        // A low batch's request, else what the late files' rules say of its ask.
        if (low) init.priority = "low";
        else if (late && ask !== "boot") init.priority = ask === "due" ? "high" : "low";
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
      } finally {
        if (late && this.flying.delete(url) && ask === "due" && !late.urgent(key))
          this.abandonedDone++;
      }
      fetched?.({ bytes: text.length }); // UTF-16 units: the files are near-ASCII
      // Late (nothing waits for it, and a writer asked it): kept as text.
      if (late && ask !== "boot" && this.wanted.has(url) && !late.urgent(key)) {
        this.o.clearTimer(timer); // it is in: no abort while it is kept
        landed?.(); // off the network: a low request's turn goes back
        return await this.keep(url, { key, expect, text });
      }
      return this.settle(key, expect, text);
    } finally {
      this.o.clearTimer(timer);
      this.live.delete(abort);
      this.attempts.delete(url);
    }
  }

  /** A file's text parsed and checked. */
  private settle(key: string, expect: Expect, text: string): Checked<unknown> {
    const { span } = this.o;
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
  }

  /** A late file's text kept: settled by the next flush (or sooner, when a
   *  plateau comes to wait for it). */
  private keep(url: string, k: Omit<Kept, "done">): Promise<Checked<unknown>> {
    return new Promise((done) => {
      this.kept.set(url, { ...k, done });
      this.setHeld();
      this.armFlush();
    });
  }

  private setHeld(): void {
    this.held = new Set([...this.kept.values()].map((k) => k.key));
    this.o.late?.onHeld?.();
  }

  /** The flush asked of the page's still moment, once. */
  private armFlush(): void {
    const late = this.o.late;
    if (!late || this.flush !== "idle") return;
    if (!this.kept.size) {
      this.batchWaited = false; // nothing left of the batch that was waited for
      return;
    }
    this.flush = "armed";
    late.whenStill(() => {
      this.flush = "idle";
      this.flushLate();
    });
  }

  /** The kept files (or the one at `only`) parsed, checked and written in ONE
   *  write, then their requests settled: each caller finds its file written.
   *  The whole flush waits once, `batchMs`, while late files a writer asked
   *  are still on the network; and a file of a batch (many) stays kept until
   *  every file of that batch is in — kept, or its request ended. */
  private flushLate(only?: string): void {
    const late = this.o.late;
    if (!late) return;
    if (only === undefined) {
      if (!this.kept.size) {
        this.batchWaited = false;
        return;
      }
      let more = false;
      for (const [url, f] of this.flying)
        if (this.wanted.has(url) && !late.urgent(f.key)) more = true;
      if (more && !this.batchWaited && !this.off()) {
        this.batchWaited = true;
        this.flush = "waiting";
        this.o.setTimer(() => {
          this.flush = "idle";
          this.armFlush();
        }, late.batchMs ?? LATE_BATCH_MS);
        return;
      }
      this.batchWaited = false;
    }
    const partial = (url: string) => {
      for (const b of this.batches)
        if (b.includes(url) && b.some((u) => !this.kept.has(u) && this.inflight.has(u)))
          return true;
      return false;
    };
    const urls =
      only === undefined
        ? [...this.kept.keys()].filter((url) => this.off() || !partial(url))
        : [only];
    if (!urls.length) return;
    const items = urls.map((url) => this.kept.get(url)!);
    for (const url of urls) this.kept.delete(url);
    this.setHeld();
    if (this.off()) {
      for (const k of items) k.done(NETWORK); // each caller answers "fallback"
      return;
    }
    const results = items.map((k) => this.settle(k.key, k.expect, k.text));
    const files: OutlineFileV1[] = [];
    results.forEach((r, i) => {
      if (r.ok && items[i].expect.kind !== "root") files.push(r.file as OutlineFileV1);
    });
    this.write(files);
    items.forEach((k, i) => k.done(results[i]));
  }
}
