// The static outline files in the page (the build outlinesBuild.ts names):
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
// `ready` is the page's wait on the boot: "loading" holds the boot curtain,
// "late" (the boot past BOOT_MS, still under way) lets it lift while the
// files keep coming, "ok" turns the credits on.
// Every stored geometry went through markRaw and never goes into a reactive
// container: geometry must stay a plain, identity-stable object (the WeakMap
// caches are keyed on it).
//
// Under `ac:recover` "auto" (shared/net/recoverSwitch.ts), a boot failed on
// the network is not a fallback: the session turns "late" and the boot is
// asked again after RECOVER_DELAYS_MS, then whenever the browser is back
// online or the page shown again — which also lets a file failed on the
// network be asked again by the next move.
//
// Late files (ac:late-files, map/plateau/lateFilesSwitch.ts; "quiet", the
// default): a file nothing waits for — what `setUrgent`'s rule says, GeoNav's
// (model/useMapFeed) — is kept as text by the loader and stored once the map
// is still (the map's whenMapStill, or LATE_CAP_MS at the latest), every kept
// file in one write: one bump of `version`, one rebuild. `held` names them
// meanwhile. "direct": every file stored as it lands, as before.
//
// A self ahead of its bundle (ac:region-self, the map's coldTapSwitch;
// "first", the default): a French région's or département's plateau is not
// made to wait for its bundle (its self and every child) when its row
// declares the self alone in a u/ file — `selfAhead` says so, and the callers
// (model/useCamera, model/useMapFeed) then ask that u/ "due" and the bundle
// "late". The loader stores a bundle that lands within SELF_GRACE_MS of the
// self with it. "bundle": the bundle alone, as before.
//
// A session that falls back has no outlines at all (every unit known absent:
// model/outlineRules.ts), so it says why once, in every build: a bug report's
// only trace of it.
import { markRaw, shallowRef, type ShallowRef } from "vue";
import {
  fileKey,
  OUTLINE_WAIT_MS,
  OutlineLoader,
  OutlineStore,
  rootUrl,
  selfAheadOf,
  type OutlineGeometry,
  type OutlineKind,
  type OutlineReady,
  type OutlineRow,
  type OutlineStatus,
} from "@/features/geo";
import {
  LATE_CAP_MS,
  lateFilesMode,
  outlineWait,
  outlineWaitFor,
  regionSelfMode,
  SELF_GRACE_MS,
} from "@/features/map";
import { whenMapStill } from "@/features/map/lib";
import { absoluteBase } from "@/shared/absoluteUrl";
import { onReconnect } from "@/shared/net/reconnect";
import { recover, RECOVER_DELAYS_MS } from "@/shared/net/recoverSwitch";
import { perfNote, perfOn, perfSpan } from "@/shared/perf/perf";
import type { BundleState } from "../model/outlineRules";
import { outlinesBuild } from "./outlinesBuild";
import { DECOR_PARALLEL, outlinesDecor, stillApply } from "./outlinesDecorSwitch";
import { createSelfHold } from "./selfHold";

export { OUTLINE_WAIT_MS };

export type OutlineFilesStatus = OutlineStatus;

/** How long the boot (root.json, then k/FR) may hold the page: past it the
 *  session turns "late" — the overlay lifts, the boot goes on and the files
 *  are drawn when they land. Not a fallback: at boot the main thread is busy
 *  with the map's own start for seconds at a time, and a response that has
 *  long arrived may wait on it past the cap (seen about one cold load in
 *  forty under load, 2026-11-09). */
const BOOT_MS = 6000;

/** `ac:outlines-boot` (testing tools): "fallback" ends the session at BOOT_MS
 *  instead, its requests aborted — the cap before 2026-11-10, kept to compare. */
function storedBootCap(): "late" | "fallback" {
  try {
    return localStorage.getItem("ac:outlines-boot") === "fallback" ? "fallback" : "late";
  } catch {
    return "late";
  }
}

export interface OutlineFiles {
  mode: ShallowRef<"fichiers" | "fallback">;
  ready: ShallowRef<OutlineReady>;
  /** Bumped by every write to the store. */
  version: ShallowRef<number>;
  /** fileKeys (`k/fr_dep_69`) whose file will not come this session. */
  failed: ShallowRef<ReadonlySet<string>>;
  /** Self files a plateau stopped waiting for (after OUTLINE_WAIT_MS). */
  gaveUp: ShallowRef<ReadonlySet<string>>;
  /** Units whose plateau stopped waiting for its self (holdSelf). */
  heldOut: ShallowRef<ReadonlySet<string>>;
  /** fileKeys in memory as text, not stored yet (the late files, kept quiet). */
  held: ShallowRef<ReadonlySet<string>>;
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
   *  stored by then, the unit joins `heldOut` for the session. Once per wait.
   *  A wait the file of a unit just left crossed goes on once more, and then
   *  holds the unit out until `leaveSelf` only (data/selfHold.ts). `coarse`:
   *  a coarser outline of the unit is in memory — the wait is the one
   *  ac:outline-wait says (the map's coldTapSwitch); at 0 the unit is held
   *  out before this returns, until `leaveSelf`. */
  holdSelf(id: string, coarse?: boolean): void;
  /** The unit is no longer the selection: a hold-out that was for its visit ends. */
  leaveSelf(id: string): void;
  /** Its self is asked ahead of its bundle (ac:region-self "first"): its row
   *  declares a u/ beside its bundle. The caller asks `ensureSelf` for it,
   *  and its bundle not "due". */
  selfAhead(id: string): boolean;
  /** Its file of this kind is in memory as text, not stored yet. */
  isHeld(kind: OutlineKind, id: string): boolean;
  /** The file's key, as `setUrgent`'s rule is asked it. */
  keyOf(kind: OutlineKind, id: string): string;
  /** The rule saying whether the selected unit's plateau waits for a file
   *  (by its key), now; null: none does. Asked as each file lands. */
  setUrgent(rule: ((key: string) => boolean) | null): void;
  /** The kept files that rule now calls urgent are stored at once. */
  flushDue(): void;
  pin(ids: Iterable<string>): number;
  ensureRoot(): Promise<OutlineFilesStatus>;
  /** The network may be back (the panel's « Réessayer »): a start waiting
   *  for its next attempt makes it now (OutlineLoader.reconnect). */
  reconnect(): void;
  /** `due`: the selected unit's plateau waits for it (its fetch priority). */
  ensureBundle(id: string, due?: boolean): Promise<OutlineFilesStatus>;
  ensureSelf(id: string): Promise<OutlineFilesStatus>;
  /** Their g/, and the u/ of `selves` (micro-states), in one write
   *  (`decor`: a decorative batch, see outlinesDecorSwitch.ts). */
  ensureGlobe(ids: string[], selves?: string[], decor?: boolean): Promise<OutlineFilesStatus[]>;
  batchSelf(ids: string[], decor?: boolean): Promise<OutlineFilesStatus[]>;
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
  const mode = shallowRef<OutlineFiles["mode"]["value"]>("fichiers");
  const ready = shallowRef<OutlineFiles["ready"]["value"]>("loading");
  const version = shallowRef(0);
  const failed = shallowRef<ReadonlySet<string>>(new Set());
  const gaveUp = shallowRef<ReadonlySet<string>>(new Set());
  const heldOut = shallowRef<ReadonlySet<string>>(new Set());
  const held = shallowRef<ReadonlySet<string>>(new Set());
  /** The units of `heldOut` held out for their visit only (leaveSelf). */
  const visitOnly = new Set<string>();
  const quiet = lateFilesMode === "quiet";
  let urgent: ((key: string) => boolean) | null = null;
  // The probe's rawCheck reads them; testing tools only (dev and staging).
  // Weak, so an evicted geometry is still collected and the LRU stays real.
  const seen: WeakRef<object>[] = [];
  const wrap = <T extends object>(o: T): T => {
    if (__TEST_TOOLS__) seen.push(new WeakRef(o));
    return markRaw(o);
  };
  const store = new OutlineStore();
  let conflicts = 0;
  // ac:outlines-decor "after" (the default): the decorative batches at low
  // priority, a few at a time, written when the map is still; "boot": as before.
  const decorLow = outlinesDecor === "after";
  const loader: OutlineLoader = new OutlineLoader({
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
      failed.value = loader.failed;
      gaveUp.value = loader.gaveUp;
    },
    onMode(m, r, why) {
      mode.value = m;
      ready.value = r;
      if (r === "late") {
        if (import.meta.env.DEV)
          console.info(
            `[outlines] boot late (past ${BOOT_MS} ms, or failed on the network), still under way`,
          );
        if (perfOn) perfNote("outline.late", 0);
        return;
      }
      if (m !== "fallback") return;
      // Once per session (the loader falls back once), in every build.
      const key = why?.key ?? "root";
      const url = key === "root" ? rootUrl(base, build) : `${base}outlines/${build}/${key}.json`;
      console.warn(
        `[outlines] fallback: ${why?.reason ?? "network"} ${url}` +
          (__TEST_TOOLS__ ? " (see docs/map-outlines.md#local-development)" : ""),
      );
      if (perfOn) perfNote("outline.fallback", 0, { reason: why?.reason, key: why?.key });
    },
    span: perfOn ? perfSpan : undefined,
    bootMs: BOOT_MS,
    bootCap: __TEST_TOOLS__ ? storedBootCap() : "late",
    bootRetryMs: recover === "auto" ? RECOVER_DELAYS_MS : undefined,
    lowParallel: decorLow ? DECOR_PARALLEL : undefined,
    applyLow: decorLow
      ? stillApply({
          whenStill: whenMapStill,
          setTimer: (fn, ms) => window.setTimeout(fn, ms),
          clearTimer: (timer) => window.clearTimeout(timer as number),
        })
      : undefined,
    selfGraceMs: SELF_GRACE_MS,
    late: quiet
      ? {
          urgent: (key) => !!urgent?.(key),
          // The map's still moment — or LATE_CAP_MS, by a timer of its own: the
          // scheduler drops its jobs when the map is unmounted.
          whenStill(job) {
            let ran = false;
            const run = () => {
              if (ran) return;
              ran = true;
              window.clearTimeout(cap);
              cancel();
              job();
            };
            const cancel = whenMapStill(run);
            const cap = window.setTimeout(run, LATE_CAP_MS);
          },
          onHeld() {
            held.value = loader.held;
          },
        }
      : undefined,
  });
  const selfStored = (id: string) => {
    const fid = store.filesIdOf(id); // an overseas région's self is its département's
    const row = store.rowOf(fid);
    return !!row && store.has(fid, row.st);
  };
  const selfHold = createSelfHold({
    waitMs: OUTLINE_WAIT_MS,
    extraMs: OUTLINE_WAIT_MS,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    stored: selfStored,
    abandoned: () => loader.abandoned(),
    abandonedDone: () => loader.abandonedDone,
    onHeldOut(id, session) {
      if (!session) visitOnly.add(id);
      heldOut.value = new Set(heldOut.value).add(id);
    },
  });

  // For the page's life: the loader is the page's, not a mount's.
  if (recover === "auto") onReconnect(() => loader.reconnect());

  // Reads version first: a computed calling an accessor tracks the store.
  const read = <T>(fn: (s: OutlineStore) => T): T => {
    void version.value;
    return fn(store);
  };

  return {
    mode,
    ready,
    version,
    failed,
    gaveUp,
    heldOut,
    held,
    build,
    base,
    isFailed: (kind, id) => {
      void failed.value;
      return loader.isFailed(kind, id);
    },
    isGaveUp: (kind, id) => {
      void gaveUp.value;
      return loader.isGaveUp(kind, id);
    },
    selfSettled: (id) => {
      void mode.value;
      void version.value;
      void failed.value;
      void gaveUp.value;
      return loader.selfSettled(id);
    },
    rowOf: (id) => read((s) => s.rowOf(id)),
    selfOf: (id) => read((s) => s.selfOf(id)),
    entryOf: (id) => read((s) => s.entryOf(id)),
    globeOf: (id) => read((s) => s.globeOf(id)),
    unitsOf: (id) => read((s) => s.unitsOf(id)),
    bundleState: (id) => {
      if (ready.value === "loading") return "loading";
      if (!read((s) => s.rowOf(id)?.k)) return "none";
      if (store.bundleLoaded(id)) return "loaded";
      void failed.value;
      return loader.isFailed("k", id) ? "failed" : "loading";
    },
    has: (id, tier) => read((s) => s.has(id, tier)),
    bundleLoaded: (id) => read((s) => s.bundleLoaded(id)),
    pin: (ids) => store.pin(ids),
    holdSelf: (id, coarse = false) => {
      if (heldOut.value.has(id)) return;
      selfHold.hold(id, outlineWaitFor(outlineWait.value, coarse, OUTLINE_WAIT_MS));
    },
    leaveSelf: (id) => {
      if (!visitOnly.delete(id)) return;
      const next = new Set(heldOut.value);
      next.delete(id);
      heldOut.value = next;
    },
    selfAhead: (id) =>
      regionSelfMode.value === "first" &&
      read((s) => selfAheadOf(s.rowOf(s.filesIdOf(id)))) !== null,
    isHeld: (kind, id) => held.value.has(fileKey(kind, store.filesIdOf(id))),
    keyOf: (kind, id) => fileKey(kind, store.filesIdOf(id)),
    setUrgent: (rule) => {
      urgent = rule;
    },
    flushDue: () => loader.flushDue(),
    ensureRoot: () => loader.ensureRoot(),
    reconnect: () => loader.reconnect(),
    ensureBundle: (id, due = false) => loader.ensureBundle(id, due),
    ensureSelf: (id) => loader.ensureSelf(id),
    ensureGlobe: (ids, selves = [], decor = false) =>
      loader.ensureGlobe(ids, selves, decor && decorLow),
    batchSelf: (ids, decor = false) => loader.batchSelf(ids, decor && decorLow),
    prefetch: (kind, id) => loader.prefetch(kind, id),
    stats: () => read((s) => s.stats()),
    loadedKeys: () => read((s) => s.loadedKeys()),
    wrapped: () => seen.flatMap((r) => r.deref() ?? []),
  };
}
