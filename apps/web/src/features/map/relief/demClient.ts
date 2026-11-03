// The client relief's shell (ac:relief=client, reliefSwitch.ts): the answer
// policy (demAnswer.ts) wired to the relief worker (demWorker.ts) and to a
// main-thread renderer, one per page. Loaded only by a page in "client"
// (demHook.ts), as a chunk of its own.
//
// The route, one tile: Mapbox asks transformRequest for
// `ac-dem://<key>/z/x/y` → a tile clear of the selection is the ground tile
// on the main thread (demGround.ts), any other the worker's render
// (demRaster.ts) → `{ url: <data: PNG> }`, through the frame budget.
//
// The worker is created at the map's load (`warmRelief`). Its health: an
// `error` or `messageerror` → it is terminated and every pending call
// replayed on the main thread (`failover`, for the rest of the session); so
// is a worker that has said nothing at all (not even its `ready`) 10 s after
// the first job was posted. Any message from it disarms that timer, and a
// timer that comes due waits one more task before it fails the worker, giving
// the messages a busy main thread left queued a turn. The main-thread renderer is the same
// demRaster.ts, imported on first use. Both failing a tile → the session's
// route goes "serveur" (demoteRelief) and the plateau standing runs again on
// it (`onReliefLost`).
//
// `window.__acDem` (testing tools): stats(), reset() (the counters only),
// cacheSize(), and the live `mode` ("worker" | "main" | "none": no worker
// yet) and `route` (reliefRoute()).

import { createDemAnswer, type Bbox, type DemRecord } from "./demAnswer";
import { GROUND_DATA_URL } from "./demGround";
import { keyOfJson, vertexCount, type Polygon } from "./demGeometry";
import type { DemSelection } from "./demRaster";
import { FrameBudget } from "./demTiles";
import type { DemJob, DemReply } from "./demWorkerCore";
import {
  demoteRelief,
  reliefBudget,
  reliefBudgetGround,
  reliefCommitHold,
  reliefDelay,
  reliefRoute,
} from "./reliefSwitch";

type Raster = typeof import("./demRaster");

/** Nothing heard from the worker this long after the first job posted: dead (ms). */
export const READY_TIMEOUT_MS = 10_000;

/** Selections the main-thread renderer keeps projected. */
const MAIN_SELECTIONS = 8;

/** What the shell needs of a Worker (`Worker` is one). */
export interface ReliefWorker {
  onmessage: ((e: { data: DemReply | { t: "ready" } }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
  postMessage(m: DemJob): void;
  terminate(): void;
}

export interface ReliefClientDeps {
  /** May throw (no module workers): the main thread then renders everything. */
  makeWorker(): ReliefWorker;
  loadRaster(): Promise<Raster>;
  budget: FrameBudget;
  /** Ground answers skip the budget. */
  groundFree?: boolean;
  delayMs?: number;
  stats?: boolean;
  /** Both renderers failed a tile: called once. */
  onLost(): void;
}

export function createReliefClient(deps: ReliefClientDeps) {
  let started = false;
  let worker: ReliefWorker | null = null;
  // Anything at all from the worker, its `ready` included: it lives.
  let heard = false;
  let health: ReturnType<typeof setTimeout> | null = null;
  let lost = false;
  const mainSels = new Map<string, DemSelection>();

  function keep(key: string, sel: DemSelection): DemSelection {
    mainSels.delete(key);
    mainSels.set(key, sel);
    if (mainSels.size > MAIN_SELECTIONS) mainSels.delete(mainSels.keys().next().value as string);
    return sel;
  }

  async function mainSet(
    json: string,
    height: number,
  ): Promise<{ key: string; bbox: Bbox; vertices: number }> {
    const r = await deps.loadRaster();
    const polys = (JSON.parse(json) as { polys: Polygon[] }).polys;
    const key = await keyOfJson(json);
    // A hit keeps the first height, as the worker's store does.
    const sel = keep(key, mainSels.get(key) ?? r.makeSelection(polys, height));
    return { key, bbox: sel.bbox, vertices: vertexCount(polys) };
  }

  async function mainRender(rec: DemRecord, z: number, x: number, y: number): Promise<string> {
    const r = await deps.loadRaster();
    const sel =
      mainSels.get(rec.key) ??
      keep(
        rec.key,
        r.makeSelection((JSON.parse(rec.json) as { polys: Polygon[] }).polys, rec.height),
      );
    const tile = r.renderDemTile(sel, z, x, y);
    if (tile.constant === "ground") return GROUND_DATA_URL;
    const rgb = tile.constant === "plateau" ? r.constantRgb(sel.height) : tile.rgb;
    return r.pngDataUrl(await r.encodePNG(rgb, r.SIZE, r.SIZE));
  }

  function disarm() {
    if (health !== null) clearTimeout(health);
    health = null;
  }

  function workerDied() {
    disarm();
    try {
      worker?.terminate();
    } catch {
      /* already gone */
    }
    worker = null;
    answer.failover();
  }

  function start(): ReliefWorker | null {
    if (started) return worker;
    started = true;
    try {
      const w = deps.makeWorker();
      w.onmessage = (e) => {
        heard = true;
        disarm();
        const m = e.data;
        // `ready` is the worker's hello, no reply: the policy expects call ids.
        if ("t" in m) return;
        answer.receive(m);
      };
      w.onerror = workerDied;
      w.onmessageerror = workerDied;
      worker = w;
    } catch {
      answer.failover();
    }
    return worker;
  }

  function armHealth() {
    if (heard || health !== null) return;
    health = setTimeout(() => {
      // Due, and maybe late on a busy main thread: one more task, so the
      // worker's messages already queued get a turn first.
      health = setTimeout(() => {
        health = null;
        if (!heard) workerDied();
      }, 0);
    }, READY_TIMEOUT_MS);
  }

  const answer = createDemAnswer({
    post(msg) {
      const w = start();
      // No worker: failover() answers this very call on the main thread.
      if (!w) return answer.failover();
      w.postMessage(msg);
      armHealth();
    },
    ground: GROUND_DATA_URL,
    mainSet,
    mainRender,
    now: () => performance.now(),
    budget: deps.budget,
    groundFree: deps.groundFree,
    delayMs: deps.delayMs,
    stats: deps.stats,
    onClientLost() {
      if (lost) return;
      lost = true;
      deps.onLost();
    },
  });

  return {
    /** The worker, created now (the map's load) rather than on the first selection. */
    warm(): void {
      start();
    },
    answer: answer.answer,
    registerSelection: answer.registerSelection,
    holdSlot: answer.holdSlot,
    releaseSlot: answer.releaseSlot,
    get mode(): "worker" | "main" | "none" {
      return answer.mode === "main" ? "main" : worker ? "worker" : "none";
    },
    stats: answer.stats,
    resetStats: answer.resetStats,
    cacheSize: answer.cacheSize,
  };
}

// ---- the page's client ----

let raster: Promise<Raster> | null = null;
let rerun: (() => void) | null = null;

const relief = createReliefClient({
  makeWorker: () =>
    new Worker(new URL("./demWorker.ts", import.meta.url), {
      type: "module",
    }) as unknown as ReliefWorker,
  loadRaster: () => (raster ??= import("./demRaster")),
  budget: new FrameBudget(reliefBudget),
  groundFree: reliefBudgetGround === "exempt",
  delayMs: reliefDelay,
  stats: __TEST_TOOLS__,
  onLost() {
    demoteRelief("render");
    // Out of the answer's chain: the plateau standing again, on "serveur".
    if (rerun) setTimeout(rerun, 0);
  },
});

/** Creates the relief worker (the map's load). */
export const warmRelief = relief.warm;
/** The answer to one `ac-dem://` request (demHook.ts). */
export const answer = relief.answer;
/** A selection's version key, the worker holding it from then on (usePlateau). */
export const registerSelection = relief.registerSelection;
/** A DEM slot shows `key` / no longer stands (usePlateau). */
export const holdSlot = relief.holdSlot;
export const releaseSlot = relief.releaseSlot;

/**
 * The registration's hold before a commit with nothing standing, `ms` (the
 * `ac:relief-commit-hold` arm, DEFAULT_RELIEF_COMMIT_HOLD_MS in reliefSwitch.ts
 * says why); 0 resolves with no timer.
 */
export function commitHold(ms: number = reliefCommitHold): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

/** What to run once the client is lost: the plateau again (usePlateau's ensurePlateau). */
export function onReliefLost(cb: () => void): void {
  rerun = cb;
}

if (__TEST_TOOLS__) {
  (window as unknown as { __acDem?: unknown }).__acDem = {
    stats: () => relief.stats(),
    reset: () => relief.resetStats(),
    cacheSize: () => relief.cacheSize(),
    get mode() {
      return relief.mode;
    },
    get route() {
      return reliefRoute();
    },
  };
}
