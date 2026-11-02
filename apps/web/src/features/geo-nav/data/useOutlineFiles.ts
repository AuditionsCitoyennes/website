// The static outline files in the page (ac:contours=fichiers, contoursSwitch.ts):
// one OutlineStore and its OutlineLoader (features/geo) for the whole page, not
// per GeoNav mount, so the session's fallback, the requests under way, the
// failed files and the LRU outlive a remount. Built at the first
// useOutlineFiles() call, nothing at import. GeoNav calls it under the
// server's tree (model/outlineRules.ts says what it reads), and so does the
// testing tools' probe (outlinesProbe.ts).
//
// The store is a plain class: `version` is the reactive handle on it, and
// every accessor reads `version.value` first, so a computed reading a
// geometry re-runs at the next write — one write per file or batch, which is
// what each consumer's rebuild costs. selfSettled also reads `mode`: once the
// session falls back every self counts as settled, and that changes no set.
// Every stored geometry went through markRaw and never goes into a reactive
// container: geometry must stay a plain, identity-stable object (the WeakMap
// caches are keyed on it).
//
// Under ac:contours=api (production's only mode) the instance is inert: no
// loader, every ensure* answers "api", nothing is fetched.
import { markRaw, shallowRef, type ShallowRef } from "vue";
import {
  OUTLINE_WAIT_MS,
  OutlineLoader,
  OutlineStore,
  type OutlineGeometry,
  type OutlineKind,
  type OutlineRow,
  type OutlineStatus,
} from "@/features/geo";
import { absoluteBase } from "@/shared/absoluteUrl";
import { perfNote, perfOn, perfSpan } from "@/shared/perf/perf";
import type { BundleState } from "../model/outlineRules";
import { contoursMode, outlinesBuild } from "./contoursSwitch";

export { OUTLINE_WAIT_MS };

export type OutlineFilesStatus = OutlineStatus | "api";

/** How long the boot (root.json, then k/FR) may take before the session goes
 *  back to the API's outlines: a stalled root must not keep the overlay up
 *  with the API's queries off. */
const BOOT_MS = 6000;

export interface OutlineFiles {
  mode: ShallowRef<"api" | "fichiers" | "fallback">;
  ready: ShallowRef<"idle" | "loading" | "ok" | "fallback">;
  /** Bumped by every write to the store. */
  version: ShallowRef<number>;
  /** fileKeys (`k/fr_dep_69`) whose file will not come this session. */
  failed: ShallowRef<ReadonlySet<string>>;
  /** Self files a plateau stopped waiting for (after OUTLINE_WAIT_MS). */
  gaveUp: ShallowRef<ReadonlySet<string>>;
  /** Units whose plateau stopped waiting for its self (holdSelf). */
  heldOut: ShallowRef<ReadonlySet<string>>;
  build: string;
  /** Ends with "/". */
  base: string;
  isFailed(kind: OutlineKind, id: string): boolean;
  isGaveUp(kind: OutlineKind, id: string): boolean;
  selfSettled(id: string): boolean;
  rowOf(id: string): OutlineRow | undefined;
  selfOf(id: string): OutlineGeometry | undefined;
  entryOf(id: string): OutlineGeometry | undefined;
  globeOf(id: string): OutlineGeometry | undefined;
  /** The entries of its loaded bundle (undefined until k/<id> is in). */
  unitsOf(id: string): ReadonlyMap<string, OutlineGeometry> | undefined;
  /** "none" when no row declares it (k:0, or no row: not yet, or never),
   *  "loading" while it is declared and neither in nor failed — and for
   *  every id while the boot is under way (no row is known yet). */
  bundleState(id: string): BundleState;
  has(id: string, tier: string): boolean;
  bundleLoaded(id: string): boolean;
  /** A plateau waits for this unit's self: in OUTLINE_WAIT_MS, unless it is
   *  stored by then, the unit joins `heldOut` for the session. Once per wait. */
  holdSelf(id: string): void;
  pin(ids: Iterable<string>): number;
  ensureRoot(): Promise<OutlineFilesStatus>;
  ensureBundle(id: string): Promise<OutlineFilesStatus>;
  ensureSelf(id: string): Promise<OutlineFilesStatus>;
  ensureGlobe(ids: string[]): Promise<OutlineFilesStatus[]>;
  batchSelf(ids: string[]): Promise<OutlineFilesStatus[]>;
  /** Settles with its request (at once when nothing is asked). */
  prefetch(kind: OutlineKind, id: string): Promise<void>;
  /** For the probe: the store's counters and its loaded files. */
  stats(): ReturnType<OutlineStore["stats"]>;
  loadedKeys(): string[];
  /** For the probe (testing tools): every geometry handed to the store and
   * still alive (an evicted one drops out once collected). */
  wrapped(): object[];
}

let instance: OutlineFiles | undefined;

/** The page's outline files (one instance, built at the first call). */
export function useOutlineFiles(): OutlineFiles {
  return (instance ??= createOutlineFiles());
}

function createOutlineFiles(): OutlineFiles {
  // absoluteBase strips one trailing "/" (and returns its input on failure).
  const b = absoluteBase(import.meta.env.VITE_MAP_DATA_BASE || "/map-data/", location.origin);
  const base = b.endsWith("/") ? b : b + "/";
  const build = outlinesBuild;
  const on = contoursMode === "fichiers";
  const mode = shallowRef<OutlineFiles["mode"]["value"]>(on ? "fichiers" : "api");
  const ready = shallowRef<OutlineFiles["ready"]["value"]>(on ? "loading" : "idle");
  const version = shallowRef(0);
  const failed = shallowRef<ReadonlySet<string>>(new Set());
  const gaveUp = shallowRef<ReadonlySet<string>>(new Set());
  const heldOut = shallowRef<ReadonlySet<string>>(new Set());
  const holding = new Set<string>();
  // The probe's rawCheck reads them; testing tools only (dev and staging).
  // Weak, so an evicted geometry is still collected and the LRU stays real.
  const seen: WeakRef<object>[] = [];
  const wrap = <T extends object>(o: T): T => {
    if (__TEST_TOOLS__) seen.push(new WeakRef(o));
    return markRaw(o);
  };
  const store = on ? new OutlineStore() : null;
  let conflicts = 0;
  const loader =
    store &&
    new OutlineLoader({
      store,
      fetchFn: (url, init) => fetch(url, init),
      base,
      build,
      wrap,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
      onWrite(v) {
        version.value = v;
        const now = store.stats().conflicts;
        if (import.meta.env.DEV && now > conflicts)
          console.warn(`[outlines] ${now - conflicts} vertex count conflict(s), existing kept`);
        conflicts = now;
      },
      onSets() {
        failed.value = loader!.failed;
        gaveUp.value = loader!.gaveUp;
      },
      onMode(m, r, why) {
        mode.value = m;
        ready.value = r;
        if (m !== "fallback") return;
        if (import.meta.env.DEV)
          console.warn(`[outlines] back to the API's outlines for this session`, why);
        if (perfOn) perfNote("outline.fallback", 0, { reason: why?.reason, key: why?.key });
      },
      span: perfOn ? perfSpan : undefined,
      bootMs: BOOT_MS,
    });

  const api = Promise.resolve("api" as const);
  const apis = (ids: string[]) => Promise.resolve(ids.map(() => "api" as const));
  // Reads version first: a computed calling an accessor tracks the store.
  const read = <T>(fn: (s: OutlineStore) => T, none: T): T => {
    void version.value;
    return store ? fn(store) : none;
  };

  return {
    mode,
    ready,
    version,
    failed,
    gaveUp,
    heldOut,
    build,
    base,
    isFailed: (kind, id) => {
      void failed.value;
      return loader?.isFailed(kind, id) ?? false;
    },
    isGaveUp: (kind, id) => {
      void gaveUp.value;
      return loader?.isGaveUp(kind, id) ?? false;
    },
    selfSettled: (id) => {
      void mode.value;
      void version.value;
      void failed.value;
      void gaveUp.value;
      return loader?.selfSettled(id) ?? true;
    },
    rowOf: (id) => read((s) => s.rowOf(id), undefined),
    selfOf: (id) => read((s) => s.selfOf(id), undefined),
    entryOf: (id) => read((s) => s.entryOf(id), undefined),
    globeOf: (id) => read((s) => s.globeOf(id), undefined),
    unitsOf: (id) => read((s) => s.unitsOf(id), undefined),
    bundleState: (id) => {
      if (ready.value === "loading") return "loading";
      if (!read((s) => s.rowOf(id)?.k, 0)) return "none";
      if (store!.bundleLoaded(id)) return "loaded";
      void failed.value;
      return loader!.isFailed("k", id) ? "failed" : "loading";
    },
    has: (id, tier) => read((s) => s.has(id, tier), false),
    bundleLoaded: (id) => read((s) => s.bundleLoaded(id), false),
    pin: (ids) => store?.pin(ids) ?? 0,
    holdSelf: (id) => {
      if (!store || holding.has(id) || heldOut.value.has(id)) return;
      holding.add(id);
      window.setTimeout(() => {
        holding.delete(id);
        const row = store.rowOf(id);
        if (row && store.has(id, row.st)) return; // in time: nothing given up
        heldOut.value = new Set(heldOut.value).add(id);
      }, OUTLINE_WAIT_MS);
    },
    ensureRoot: () => loader?.ensureRoot() ?? api,
    ensureBundle: (id) => loader?.ensureBundle(id) ?? api,
    ensureSelf: (id) => loader?.ensureSelf(id) ?? api,
    ensureGlobe: (ids) => loader?.ensureGlobe(ids) ?? apis(ids),
    batchSelf: (ids) => loader?.batchSelf(ids) ?? apis(ids),
    prefetch: (kind, id) => loader?.prefetch(kind, id) ?? Promise.resolve(),
    stats: () =>
      read((s) => s.stats(), {
        files: 0,
        objects: 0,
        vertices: 0,
        dedupeHits: 0,
        conflicts: 0,
        evicted: 0,
      }),
    loadedKeys: () => read((s) => s.loadedKeys(), []),
    wrapped: () => seen.flatMap((r) => r.deref() ?? []),
  };
}
