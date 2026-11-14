// The plateau: the selected unit's real map raised as a flat-topped plateau on
// a custom DEM (rendered in the page by the relief worker: relief/demClient.ts),
// the terrain exaggeration animated
// for the rise and the sink, the DEM source double-buffered so a new
// selection's tiles prefetch while the old plateau sinks, and the ensurePlateau
// state machine (its run counter `plateauSeq` aborts superseded runs). Owns
// `plateauActive`, exposed as a getter.
//
// ac:late-files "quiet" (plateau/lateFilesSwitch.ts): a new outline is first
// judged against what stands (`outlineChanged`, lib/outlineChange.ts). Only a
// new unit, a new shape, or nothing standing runs the pipeline; lines that
// changed around the standing plateau are one mesh applied in place when the
// map is still (`redress`); an outline that changes nothing does nothing.
//
// ac:cold-start "early" (plateau/coldTapSwitch.ts): a run that HOLDS for an
// outline on its way (`scopePending`) starts what needs no outline — the
// standing plateau's sink, the coming unit's lid over its box (`coming`,
// lib/coldStart.ts) — so the run that raises it finds both done.
//
// On flat ground (relief/groundSwitch.ts: a weak device's, or the DEV
// switch's) the same wall, lid and rise stand over a ground that stays where
// it is: no DEM, no relief worker, and a flat terrain of ours in place of the
// style's own — so mapbox runs none on the flat map. A plateau keeps the
// ground it was raised on; the next selection reads the switch again. A flat
// run tells the same verdicts (`onSettled`), and a plateau over flat ground
// is judged standing as one on its DEM slot is.

import type mapboxgl from "mapbox-gl";
import { canonicalCopies, type Bounds, type HeightClass, type WrapGeometry } from "@/features/geo";
import { perfEnd, perfNote, perfOn, perfSpan } from "@/shared/perf/perf";
import { deviceTier } from "@/shared/device/deviceTier";
import { globeSetMode } from "../gl/globeDeferral";
import { WALL_OVERSHOOT } from "../gl/mesh";
import type { MeshClient, MeshResult } from "../gl/meshClientCore";
import { notePlateauRun } from "../dev/motionProbes";
import { boundsOfFeatures, plateauHeightM } from "../lib/polygon";
import {
  outlineVerdict,
  raisedShapeOf,
  retryVerdict,
  sameShape,
  type OutlineVerdict,
  type RaisedShape,
} from "../lib/outlineChange";
import { boxCovers, boxFeature, coldStartPlan, type ComingUnit } from "../lib/coldStart";
import { riseProgress } from "../lib/rise";
import { stillMap } from "../lib/stillMap";
import { markPlateauStood } from "../lib/plateauStood";
import type { PlateauWallLayer } from "../gl/PlateauWallLayer";
import { createDemSlots, repointDemSlot, type DemSlot } from "../plateau/demSlots";
import { liftOf, type PlateauLift } from "../plateau/lift";
import { GROUND_DATA_URL } from "../relief/demGround";
import { loadReliefClient } from "../relief/demHook";
import { demTemplate } from "../relief/demTiles";
import { planPrefetch, type PrefetchPlan } from "../relief/prefetchPlan";
import { groundFor, reliefGround, type Ground } from "../relief/groundSwitch";
import { reliefPrefetch } from "../relief/reliefSwitch";
import type { OutlineFC } from "../types";
import { coldStartMode } from "../plateau/coldTapSwitch";
import { LATE_CAP_MS, lateFilesMode } from "../plateau/lateFilesSwitch";
import { meshMode } from "../plateau/meshSwitch";
import { linesMesh } from "../threadSwitch";
import type { usePlateauLid } from "./usePlateauLid";

export interface PlateauInputs {
  getMap: () => mapboxgl.Map | null;
  /** The plateau's layer: the walls, the lid, the lines. */
  wall: PlateauWallLayer;
  /** The style's load event has fired: no style mutation before then. */
  mapReady: () => boolean;
  /** The cold-load intro has not played yet: the plateau holds (useMapCamera). */
  introPending: () => boolean;
  /** The scope's outline (the `outline` prop) and whether it is still loading (`scopePending`). */
  outline: () => OutlineFC | null | undefined;
  scopePending: () => boolean | undefined;
  /** The unit the map holds for while `scopePending` (its id, its row's box);
   *  none known: null. Read under ac:cold-start "early" only. */
  coming?: () => ComingUnit | null | undefined;
  /** The lid (usePlateauLid): captured for a new selection, reset with the plateau. */
  lid: Pick<ReturnType<typeof usePlateauLid>, "capture" | "reset" | "hasTexture">;
  /** `cameraForBounds` blind to the terrain (useMapCamera): the DEM's canonical zoom. */
  flatCamera: (
    bounds: mapboxgl.LngLatBoundsLike,
    options: Parameters<mapboxgl.Map["cameraForBounds"]>[1],
  ) => ReturnType<mapboxgl.Map["cameraForBounds"]>;
  /** The grey outside the plateau, cut around it (useScopeMask). */
  applyMask: () => void;
  /** A plateau is about to stand for these features: its grey may be cut
   *  ahead (useScopeMask, ac:tint-cut). */
  prepareMask?: (raised: OutlineFC["features"]) => void;
  /** The analyses' slabs (usePlateauSlabs): brought in line with the plateau standing. */
  syncSlabs: (atSwap?: boolean) => void;
  clearSlabs: () => void;
  /** A new unit: the DEV "Carte" lid must not take the old unit's slabs in (usePlateauSlabs). */
  forgetLidExtra: () => void;
  /** ac:mesh=worker: the map's mesh worker (gl/meshClient.ts), once made at
   *  its load. Null (not yet, or another mode): the mesh is built here. */
  meshClient?: () => MeshClient | null;
  /** A run of the pipeline has come to its verdict (see PlateauSettle): what
   *  a tapped unit's pending mark waits for. Called in the block that applies
   *  the mesh, before the rise's first frame. */
  onSettled?: (scopeId: string, how: PlateauSettle) => void;
  /** What stands above flat ground changed (`lift()`): the pins are brought
   *  in line (useMapPins). */
  onLift?: () => void;
}

/**
 * How a run of the plateau pipeline ended, for unit `scopeId`:
 * - "rise": its mesh is applied and it starts rising from the ground;
 * - "same": it was standing already (brought back up if a sink was cut short);
 * - "quiet": it was standing and its shape was refined in place;
 * - "cleared": nothing to raise ("" for the unit): the map is flat;
 * - "failed": the transition failed, the map is left flat.
 * A superseded run and a run that holds for an outline on its way say nothing.
 */
export type PlateauSettle = "rise" | "same" | "quiet" | "cleared" | "failed";

/** The plateau's rise and sink, ms (the slabs ride them too). */
export const RISE_MS = 300;
export const SINK_MS = 150;

export function usePlateau({
  getMap,
  wall: plateauWall,
  mapReady,
  introPending,
  outline,
  scopePending,
  coming,
  lid,
  flatCamera,
  applyMask,
  prepareMask,
  syncSlabs,
  clearSlabs,
  forgetLidExtra,
  meshClient,
  onSettled,
  onLift,
}: PlateauInputs) {
  // Whether a plateau is currently standing — the draped hover-fill fallback only
  // applies when none stands or is coming (the world, or a scope with no boundary
  // of its own: DROM régions, non-FR units); otherwise the GL sweep owns the
  // highlight.
  let plateauActive = false;
  // ---- Plateau elevation: raise the SELECTED area's real map as a flat-topped
  // plateau (custom DEM: the relief worker's). The camera tilts so the relief
  // reads. ----
  // The DEM's version key (the relief worker's).
  let plateauVersion = "";
  let plateauScopeId = ""; // selection identity — detects a change before any network
  let plateauSeq = 0; // guards overlapping ensurePlateau runs (fast drills)
  // What `outlineChanged` judges a new outline against: the shape the run
  // under way raises (null: none past its first checks), the lines the wall
  // was last given (focus, then context), whether the outline must be read
  // again once that run has ended, and the reshapes in place — their counter
  // (a newer one drops the one before it) and how many were applied.
  let runFor: RaisedShape | null = null;
  let dressed: OutlineFC["features"] = [];
  let owed = false;
  let redressSeq = 0;
  let redresses = 0;
  // ac:cold-start "early": the unit whose lid a holding run shot over its box
  // (null: none since a raising run last asked for another shot), and how
  // many such starts there were (testing tools).
  let earlyLid: ComingUnit | null = null;
  let coldStarts = 0;
  // Double-buffered DEM source slots: the NEW selection's tiles prefetch in the spare
  // slot while the old plateau is still sinking, so the rise starts without waiting.
  let terrainSrc: DemSlot = "plateau-dem-a";

  // ---- Flat ground (relief/groundSwitch.ts) ----
  // Whether the map's terrain is the flat one below: laid at the map's load
  // or by a flat run's commit, until a relief run puts a DEM slot in its
  // place or a clear on raised ground takes the terrain off. A plateau
  // standing while it is true stands over flat ground.
  let flatGround = false;
  const FLAT_SRC = "plateau-flat";
  // The flat terrain: the ground tile (0 m everywhere) as the map's own (root)
  // terrain, in place of the style import's, which would otherwise raise the
  // real relief between zoom 6 and 13.7 with its DEM tiles. Its exaggeration
  // is 0 from zoom 6 up, the flat map: for a zoom-dependent exaggeration that
  // evaluates to 0 there, mapbox runs no terrain at all (nothing is draped,
  // nothing is sampled, `queryTerrainElevation` answers null). Below zoom 6
  // the style draws a globe, where mapbox always drapes: there it drapes over
  // this flat tile, and its exaggeration changes no pixel (a flat tile times
  // anything is flat). It is 1 up to zoom 5 so that the expression has a zoom
  // where it drops to 0: from the end of such a drop on, mapbox 3.34 reads the
  // expression as it is; without one it eases its last exaggeration toward
  // the new one over the next camera moves, and a plateau that just left
  // raised ground would keep a terrain running for a while.
  const FLAT_TERRAIN = {
    source: FLAT_SRC,
    exaggeration: ["interpolate", ["linear"], ["zoom"], 5, 1, 6, 0],
  } as unknown as mapboxgl.TerrainSpecification;

  /** The ground a plateau raised now stands on: the switch, and under "auto"
   *  the device's tier of the moment. */
  const groundNow = (): Ground => groundFor(reliefGround.value, deviceTier());

  // setTerrain with the exaggeration transition ZEROED. Terrain exaggeration is a
  // transitionable style property (default ~300 ms ease): each per-frame setTerrain
  // would otherwise start a NEW internal transition, so the terrain lagged our rAF
  // animation and visibly "caught up" in steps after the loop ended — while the wall
  // (a raw shader uniform) moved true. Zeroing it puts both in lockstep.
  function setTerrainRaw(src: string, v: number) {
    // A DEM slot's from here: no longer the flat terrain, if it was (the
    // pins it lifted come down).
    const wasFlat = flatGround;
    flatGround = false;
    getMap()?.setTerrain({
      source: src,
      exaggeration: v,
      "exaggeration-transition": { duration: 0 },
    } as unknown as mapboxgl.TerrainSpecification);
    if (wasFlat) onLift?.();
  }

  // The slots' lifecycle (plateau/demSlots): the slot a swap left is dropped
  // LATER, once a frame has rendered since the swap. The prefetch's removal of
  // the SPARE slot stays synchronous (no terrain mutation in that tick, and the
  // slot must be free for addSource), after a rendered frame on a fast drill,
  // however long it takes.
  const slots = createDemSlots({
    getMap,
    terrainSrc: () => (flatGround ? null : terrainSrc),
    onDrop: (id) => relief?.releaseSlot(id),
  });
  // The client relief, once a run has loaded it. It holds each standing
  // slot's key.
  let relief: Awaited<ReturnType<typeof loadReliefClient>> | null = null;
  // ac:relief-prefetch=terrain0 (relief/reliefSwitch.ts): the spare slot a run
  // made the root terrain at exaggeration 0 before its swap, until a plateau
  // commits or the map is cleared; and (testing tools) how often the spare
  // slot was re-pointed or kept instead of added, and how many early terrains.
  let earlyTerrainSlot: DemSlot | null = null;
  const prefetchRuns = { repoints: 0, keeps: 0, earlyTerrains: 0 };
  // ac:mesh=worker: meshes the worker built and this map applied (the first
  // is the cold worker's).
  let workerApplies = 0;

  // The `dem.tilesReady` probe (testing tools only): a DEM slot's addSource →
  // the first of its tile events after which the source is loaded. Not its
  // first `sourcedata`: the `metadata` event already reads loaded with no tile
  // in. Errored tiles count apart: mapbox reports a 404 tile as `sourcedata`
  // (`sourceDataType: "error"`) but any other failure only as a map `error`
  // carrying the tile, so both are heard (GeoDrillMap already listens to
  // `error`: one more listener changes no console output). Such a failure
  // also makes mapbox read the source loaded for good, so the span ends on it:
  // with errTiles > 0 it is no ready time, only a flag. One pair of
  // listeners at a time, on the map it was put on: a newer slot's addSource
  // drops it (that span is superseded and never ends), and so does abort(). A
  // plain run of the watcher on the same version keeps it — the same source is
  // still loading.
  let offTilesReady: (() => void) | null = null;
  const demReady = { started: 0, ended: 0 };
  function stopTilesReady() {
    offTilesReady?.();
    offTilesReady = null;
  }
  function watchTilesReady(map: mapboxgl.Map, id: string, scope: string) {
    stopTilesReady();
    const end = perfSpan("dem.tilesReady", { scope });
    demReady.started++;
    let tiles = 0;
    let errTiles = 0;
    const onTile = (e: mapboxgl.MapSourceDataEvent) => {
      if (e.sourceId !== id || !e.tile) return;
      if (e.sourceDataType === "error") errTiles++;
      else tiles++;
      endIfLoaded();
    };
    const onTileError = (e: { error?: unknown; sourceId?: string; tile?: unknown }) => {
      if (e.sourceId !== id || !e.tile) return;
      errTiles++;
      endIfLoaded();
    };
    const endIfLoaded = () => {
      // isSourceLoaded on a missing id fires a map `error`: ask only while it stands.
      if (!map.getSource(id)) return;
      let loaded = false;
      try {
        loaded = map.isSourceLoaded(id);
      } catch {
        return;
      }
      if (!loaded) return;
      stopTilesReady();
      demReady.ended++;
      end({ tiles, errTiles });
    };
    map.on("sourcedata", onTile);
    map.on("error", onTileError);
    offTilesReady = () => {
      map.off("sourcedata", onTile);
      map.off("error", onTileError);
    };
  }

  // The plateau rises/sinks by animating the terrain EXAGGERATION (0 → 1 → 0): the
  // DEM stays fixed, only the vertical scale animates. `terrainExag` tracks the value
  // we've applied so an interrupted animation resumes smoothly from where it was.
  let terrainExag = 0;
  let exagAnim: {
    raf: number;
    timer: number;
    resolve: () => void;
    target: number;
    done: Promise<void>;
  } | null = null;

  function cancelExagAnim() {
    if (!exagAnim) return;
    cancelAnimationFrame(exagAnim.raf);
    clearTimeout(exagAnim.timer);
    const r = exagAnim.resolve;
    exagAnim = null;
    stillMap.plateauMotionEnd();
    r();
  }

  function animateTerrain(to: number, ms: number): Promise<void> {
    // IDEMPOTENT: an animation already heading to the same target keeps its
    // timeline — restarting it on every data-driven re-run (e.g. commune contours
    // streaming in) made the rise ease-reset over and over, climbing "forever".
    if (exagAnim && exagAnim.target === to) return exagAnim.done;
    if (!exagAnim && terrainExag === to) return Promise.resolve();
    cancelExagAnim();
    const done: Promise<void> = new Promise((resolve) => {
      const from = terrainExag;
      const t0 = performance.now();
      const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
      const apply = (v: number) => {
        terrainExag = v;
        // On flat ground only the wall and the lid move.
        if (!flatGround && getMap()?.getSource(terrainSrc)) setTerrainRaw(terrainSrc, v);
        // The violet wall sheet rises/sinks with the plateau (one uniform, no
        // geometry rebuild).
        plateauWall.setScale(v);
      };
      const finish = () => {
        if (!exagAnim) return;
        cancelAnimationFrame(exagAnim.raf);
        clearTimeout(exagAnim.timer);
        exagAnim = null;
        apply(to);
        stillMap.plateauMotionEnd();
        resolve();
      };
      const tick = (now: number) => {
        if (!exagAnim) return;
        if (!getMap()) return finish();
        const t = riseProgress(now, t0, ms);
        if (t >= 1) return finish();
        apply(from + (to - from) * ease(t));
        exagAnim.raf = requestAnimationFrame(tick);
      };
      exagAnim = {
        raf: requestAnimationFrame(tick),
        // Safety: rAF can be throttled to a halt in hidden tabs — snap to the target
        // so the plateau never gets stuck mid-height.
        timer: window.setTimeout(finish, ms + 300),
        resolve,
        target: to,
        // Patched to the real promise right below (it doesn't exist yet in here).
        done: Promise.resolve(),
      };
      // The still-map scheduler (lib/stillMap.ts) is told of the rise or the
      // sink, from here to its end (finish, or cancelExagAnim).
      stillMap.plateauMotionBegin();
    });
    if (exagAnim) exagAnim.done = done;
    return done;
  }

  /** A run's verdict, told (PlateauInputs.onSettled). A listener that throws
   *  must not take the run with it: most calls sit in the pipeline's try. */
  function settled(scopeId: string, how: PlateauSettle) {
    try {
      onSettled?.(scopeId, how);
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[plateau] onSettled failed:", err);
    }
  }

  /** The standing plateau's unit and box, as last given to setGeometry. */
  let plateauRaised: OutlineFC["features"] = [];
  let plateauBbox: Bounds | null = null;

  /** The flat terrain made the map's, if it is not already. The DEM slots it
   *  leaves are dropped later (demSlots: never in the tick of a terrain
   *  change), and their keys let go with them. */
  function layFlatGround(map: mapboxgl.Map) {
    const on = map.getTerrain()?.source;
    if (flatGround && on === FLAT_SRC) return;
    if (!map.getSource(FLAT_SRC)) {
      map.addSource(FLAT_SRC, {
        type: "raster-dem",
        tiles: [GROUND_DATA_URL],
        tileSize: 256,
        // One tile for the whole world, and only the globe ever asks for it.
        maxzoom: 0,
        encoding: "mapbox",
      });
    }
    if (map.getLayer("plateau-prefetch")) map.removeLayer("plateau-prefetch");
    // A copy: mapbox writes its defaults into the object it is given.
    map.setTerrain({ ...FLAT_TERRAIN });
    flatGround = true;
    earlyTerrainSlot = null;
    // A terrain change: no slot leaves before a frame has rendered since.
    slots.swapped(map, on === "plateau-dem-a" || on === "plateau-dem-b" ? on : terrainSrc);
    slots.dropDemSourceSoon(map, "plateau-dem-a");
    slots.dropDemSourceSoon(map, "plateau-dem-b");
  }

  /** The map has loaded: on a device (or a switch) that asks for flat ground,
   *  the flat terrain from the first frame on, and no relief worker; else the
   *  relief worker started now, not on the first selection (a no-op where it
   *  started with the map object, ac:boot-workers). */
  function prepareGround() {
    const map = getMap();
    if (!map) return;
    if (groundNow() === "flat") {
      layFlatGround(map);
      return;
    }
    void loadReliefClient().then(
      (c) => c.warmRelief(),
      () => {},
    );
  }

  // What stands above flat ground (plateau/lift.ts), made once per standing
  // plateau: null on raised ground and with no plateau.
  let liftCache: { raised: OutlineFC["features"]; heightM: number; lift: PlateauLift } | null =
    null;
  function lift(): PlateauLift | null {
    if (!flatGround || !plateauActive || !plateauRaised.length) return null;
    const heightM = plateauWall.heightM;
    if (liftCache?.raised !== plateauRaised || liftCache.heightM !== heightM) {
      liftCache = {
        raised: plateauRaised,
        heightM,
        lift: liftOf(plateauRaised, heightM * WALL_OVERSHOOT),
      };
    }
    return liftCache.lift;
  }

  // The DEM's canonical tile zoom for a selection: one level past its fit zoom. The
  // source is capped there (maxzoom), so flying/zooming NEVER requests new terrain
  // tiles — the same small set gets over/under-scaled. (The overzoom slope this puts
  // on the raster edge stays hidden: it spans ~±0.5 texel around an edge that the
  // erosion already keeps 2.5 texels behind the vector wall.)
  function canonicalDemZoom(b: Bounds): number {
    // On flat ground: the plateau standing elsewhere must not change the answer.
    const map = getMap();
    const cam =
      map &&
      flatCamera(
        [
          [b.minLng, b.minLat],
          [b.maxLng, b.maxLat],
        ],
        { padding: 60 },
      );
    return Math.min(15, Math.max(4, Math.floor((cam?.zoom ?? 8) + 1)));
  }

  /** The raised features in [-180, 180] (geo's canonicalCopies): what the
   *  DEM works in — the renderer projects linearly in lng, and mapbox asks for
   *  the canonical world's tiles. The same features for an outline in range. */
  const demFeatures = (raised: OutlineFC["features"]) =>
    raised.map((f) => {
      const g = canonicalCopies(f.geometry as WrapGeometry);
      return g === f.geometry ? f : { ...f, geometry: g };
    });

  /** The raised unit's box and its canonical zoom (12 without a box). */
  function canonicalOf(raised: OutlineFC["features"]) {
    const wb = boundsOfFeatures(raised);
    return { wb, zCanon: wb ? canonicalDemZoom(wb) : 12 };
  }

  /** ac:mesh=worker: a run's mesh awaited, and how long it held the run
   *  (`plateau.meshWait`; `first`: the worker's first mesh on this map). */
  async function meshWait(job: Promise<MeshResult | null>, scope: string, path: string) {
    const t0 = performance.now();
    const res = await job;
    if (perfOn) {
      const first = workerApplies === 0;
      perfNote("plateau.meshWait", performance.now() - t0, { scope, path, first });
    }
    return res;
  }

  /** …with the sink: the wait is the mesh's beyond the sink (0: it came first). */
  async function sinkAndMesh(
    sinkP: Promise<void>,
    job: Promise<MeshResult | null>,
    scope: string,
    path = "swap",
  ) {
    let sunk = 0;
    let built = 0;
    const [, res] = await Promise.all([
      sinkP.then(() => {
        sunk = performance.now();
      }),
      job.then((r) => {
        built = performance.now();
        return r;
      }),
    ]);
    if (perfOn) {
      const first = workerApplies === 0;
      perfNote("plateau.meshWait", Math.max(0, built - sunk), { scope, path, first });
    }
    return res;
  }

  type Features = OutlineFC["features"];
  /** The mesh of a map with no unit raised — its boundary lines alone (Monde,
   *  a scope with no outline of its own, a plateau that failed) — asked of
   *  the mesh worker (ac:lines-mesh, ../threadSwitch.ts), both sets at once:
   *  no unit, so no fit to tell that the globe can wait. Null: built here,
   *  by putLines (the switch on "page", another mesh mode, no worker yet, or
   *  a worker lost). */
  function askLines(focus: Features, context: Features) {
    if (meshMode !== "worker" || linesMesh.value !== "worker") return null;
    const client = meshClient?.() ?? null;
    if (!client || client.mode !== "worker") return null;
    const inputs = { features: [] as Features, heightM: 0, focus, context };
    return { client, inputs, job: client.build(inputs, { merc: true, globe: true }) };
  }

  /** …and put up: the worker's (`res`), else built here as before. */
  function putLines(
    asked: ReturnType<typeof askLines>,
    res: MeshResult | null,
    focus: Features,
    context: Features,
  ) {
    if (asked && res) {
      const zoom = getMap()?.getZoom() ?? 0;
      plateauWall.applyBuilt(res.mesh, asked.inputs, {
        start: "eager",
        globe: "eager",
        zCanon: 0,
        zoom,
        via: res.via,
      });
      asked.client.applied(res);
      workerApplies++;
      return;
    }
    plateauWall.setGeometry([], 0, focus, context);
  }

  // Build/refresh the plateau for the current selection. The transition is fully
  // overlapped so there's no dead time: on a selection change the OLD plateau starts
  // sinking immediately (in parallel with the version key from the relief
  // worker), the NEW selection's tiles prefetch in the spare source slot while
  // it sinks, and the rise starts as soon as the sink ends (short capped wait for
  // any straggler tiles).
  async function ensurePlateau() {
    // Pre-load style mutations wedge the load event; during the intro the plateau
    // holds until the tilt starts (the rise then plays in the tilt's flight tail).
    // `map` is read again after every await: unmounted meanwhile, it is null.
    let map = getMap();
    if (!map || !mapReady() || introPending()) return;
    const seq = ++plateauSeq;
    runFor = null;
    // The raised plateau is the SELECTED unit itself (the "scope" feature), not its
    // children — so drilling to a région lifts that whole région.
    const raised = (outline()?.features ?? []).filter((f) => f.properties?.kind === "scope");
    // Child + sibling boundaries — ALWAYS drawn by the GL layer (constant-width
    // vector lines): on the lid when a plateau stands, at ground level otherwise
    // (there is no draped line layer anymore).
    const focus = (outline()?.features ?? []).filter((f) => f.properties?.kind === "focus");
    const context = (outline()?.features ?? []).filter((f) => f.properties?.kind === "context");
    if (!raised.length) {
      // The scope's geometry is merely still LOADING (cold cache) → hold the current
      // plateau; the geometry's arrival re-fires this watcher with the real shape.
      if (scopePending()) {
        coldStart(seq, map);
        return;
      }
      if (perfOn) notePlateauRun(""); // the perf probes: a run, for no unit
      // Nothing selected (world level, or the micropin zone) → sink, then clear the
      // plateau; the outline's own lines (e.g. the country boundary at world
      // scope) stay, grounded.
      // A terrain0 run superseded by this clear left its slot as the terrain at
      // 0: cleared too, as a hillshade prefetch leaves no terrain.
      const earlyStands =
        __TEST_TOOLS__ &&
        earlyTerrainSlot !== null &&
        map.getTerrain()?.source === earlyTerrainSlot;
      // Over flat ground the wall and the lid sink alone.
      const stood = flatGround
        ? !!plateauVersion
        : !!(plateauVersion || earlyStands) && !!map.getTerrain();
      // ac:lines-mesh: the lines' mesh comes from the worker while the plateau
      // sinks; everything below still happens in one block, once both are done.
      const asked = askLines(focus, context);
      let res: MeshResult | null = null;
      if (stood || asked) {
        const sinkP = stood ? animateTerrain(0, SINK_MS) : Promise.resolve();
        if (asked) res = await sinkAndMesh(sinkP, asked.job, "", "clear");
        else await sinkP;
        map = getMap();
        if (seq !== plateauSeq || !map) return;
      }
      // With nothing standing the ground follows the switch at once: the flat
      // terrain laid (or kept), else the terrain taken off — the style's own
      // comes back, as after every clear on raised ground.
      if (groundNow() === "flat") layFlatGround(map);
      else if (stood || flatGround) {
        flatGround = false;
        map.setTerrain(null);
      }
      earlyTerrainSlot = null;
      putLines(asked, res, focus, context);
      plateauRaised = [];
      plateauBbox = null;
      clearSlabs();
      plateauWall.setLidTexture(null);
      plateauVersion = "";
      plateauScopeId = "";
      plateauActive = false;
      applyMask();
      onLift?.();
      // No lid any more — forget its resolution so a later plateau starts fresh.
      lid.reset();
      // The perf probes: a selection with no plateau (Monde) shows as the map cleared.
      if (perfOn) perfEnd("select-plateau", undefined, { cleared: true });
      settled("", "cleared");
      return;
    }
    const scopeId = String(raised[0]?.properties?.id ?? "");
    if (perfOn) notePlateauRun(scopeId); // the perf probes: a run for this unit
    // The shape this run raises, until it ends (outlineChanged reads it).
    runFor = raisedShapeOf(raised) ?? {
      scopeId,
      geometry: raised[0]?.geometry,
      heightClass: raised[0]?.properties?.heightClass,
    };
    // If the newly selected unit was the hovered one, its opaque fill drains in
    // reverse (centre → boundary). Must precede any setGeometry rebuild below —
    // the new focus set no longer contains the selected unit's fill.
    plateauWall.beginSelection(scopeId);
    const heightM = plateauHeightM(
      raised[0]?.properties?.heightClass as HeightClass | undefined,
      raised,
    );
    // ac:mesh=worker (plateau/meshSwitch.ts): the mesh is built in the worker
    // from now on, while the version key, the sink
    // and the prefetch run; the canonical zoom first, for whether its globe set
    // comes with it (gl/globeDeferral.ts: the camera now). Applied below where
    // the other modes build it, after their awaits, never between the commit
    // and the old slot's drop. Without the client the run is merc's.
    // The grey around the unit, asked ahead of the applyMask that lays it
    // (ac:tint-cut=worker; nothing for a unit whose grey is laid or asked).
    prepareMask?.(raised);
    const client = meshMode === "worker" ? (meshClient?.() ?? null) : null;
    const workerEarly = client ? canonicalOf(raised) : null;
    const startMode = workerEarly ? globeSetMode(workerEarly.zCanon, map.getZoom()) : "eager";
    const job = client
      ? client.build(
          { features: raised, heightM, focus, context },
          { merc: true, globe: startMode === "eager" },
        )
      : null;
    // Its globe set, when it waits: asked of the worker behind the mesh
    // (ac:globe-late, ../threadSwitch.ts), for the apply of this `raised`.
    if (client && startMode === "lazy") {
      plateauWall.askGlobeAhead({ features: raised, heightM, focus, context });
    }
    // Start the lid snapshot IMMEDIATELY — it depends on nothing but the geometry,
    // and it's the longest pole (hidden-map tiles + capture). Started here it runs
    // through the sink, the version key and the whole camera flight, landing around
    // the time the rise completes — so the rim gap is never left showing.
    // Only shoot the full-selection lid for a NEW selection (or when none stands).
    // ensurePlateau re-runs on every outline identity change — including each
    // commune batch arriving mid-pan — and an unconditional capture here threw
    // away any zoom refine and reset the texture to the coarse whole-unit shot.
    const changed = scopeId !== plateauScopeId;
    // "Carte" (DEV): the old unit's slabs are not the new one's — its first shot
    // must not take them in (France's, some 900 km, around Lyon's lid). Its own
    // are added once they are built (syncSlabs).
    if (changed) forgetLidExtra();
    // ac:cold-start "early": a holding run may have shot a lid over a unit's
    // box. This unit's, and its shape lies within that box: the same
    // rectangle is asked again — the shot is adopted while it runs, left
    // alone once landed. Another unit's: it may be the one showing, and this
    // unit's is shot.
    const strayLid = earlyLid !== null && earlyLid.id !== scopeId;
    const sameLid =
      earlyLid !== null && !strayLid && boxCovers(earlyLid.bounds, boundsOfFeatures(raised));
    if (changed || strayLid || !lid.hasTexture()) {
      void lid.capture(seq, sameLid && earlyLid ? [boxFeature(earlyLid)] : raised);
      if (!sameLid) earlyLid = null;
    }
    // Selection changed → the old plateau starts sinking NOW, while the version
    // key comes.
    // (A different scope id always hashes to a different DEM version, so this never
    // sinks a plateau that the same-version path would have kept up.)
    const sinkP =
      changed && plateauVersion && (flatGround || map.getTerrain())
        ? animateTerrain(0, SINK_MS)
        : Promise.resolve();
    // The ground of this run: a plateau standing keeps its own (the same unit
    // again: its outline refined, or a watcher re-run), a new one reads the
    // switch.
    const flat = changed ? groundNow() === "flat" : flatGround;
    // What puts this run's mesh up, made where the run is about to (after its
    // awaits): `early`, and `putMesh`.
    const meshPutter = () => {
      // ac:mesh=merc (plateau/meshSwitch.ts): the canonical zoom first — with the
      // camera at each setGeometry below, it says whether the globe set can wait
      // (gl/globeDeferral.ts). The other modes pass nothing and compute it below.
      const early =
        workerEarly ?? (meshMode === "merc" || meshMode === "worker" ? canonicalOf(raised) : null);
      const globeOpts = () => {
        if (!early) return undefined;
        const zoom = getMap()?.getZoom() ?? 0;
        return { globe: globeSetMode(early.zCanon, zoom), zCanon: early.zCanon, zoom };
      };
      // The mesh standing: the worker's (its globe set's mode for the camera
      // now), else built here.
      const putMesh = (res: MeshResult | null) => {
        dressed = [...focus, ...context];
        const opts = globeOpts();
        if (client && res && opts) {
          plateauWall.applyBuilt(
            res.mesh,
            { features: raised, heightM, focus, context },
            { ...opts, start: startMode, via: res.via },
          );
          client.applied(res);
          workerApplies++;
          return;
        }
        // Null for a current run: not by construction (superseded or disposed
        // only; or a geometry no builder reads, which then throws here into the
        // catch, as in merc).
        if (client && import.meta.env.DEV) console.warn("[plateau] no worker mesh: built here");
        plateauWall.setGeometry(raised, heightM, focus, context, opts);
      };
      return { early, putMesh };
    };
    try {
      if (flat) {
        // FLAT GROUND: no version key, no DEM slot, no tiles, no hold — the
        // mesh, the mask, the slabs and the rise as below, over a ground that
        // stays where it is.
        if (!changed && plateauVersion) {
          // The same unit, standing: its outline refined (boundary data after
          // a cold load) or a watcher re-run. Reshaped in place at the height
          // it is at, and brought back up after an interrupted sink.
          let res: MeshResult | null = null;
          if (job) {
            res = await meshWait(job, scopeId, "same");
            map = getMap();
            if (seq !== plateauSeq || !map) return;
          }
          // ac:late-files "quiet": a refined shape standing (not the watcher's
          // re-run on the very shape) is put up when the map is still, as the
          // quiet swap below does on raised ground, LATE_CAP_MS at the latest.
          const up = raisedShapeOf(plateauRaised);
          const refined = !up || !runFor || !sameShape(runFor, up);
          const upNow = terrainExag === 1 || exagAnim?.target === 1;
          if (refined && upNow && lateFilesMode === "quiet") {
            await new Promise<void>((done) => stillMap.whenStill(done, { timeoutMs: LATE_CAP_MS }));
            map = getMap();
            if (seq !== plateauSeq || !map) return;
          }
          meshPutter().putMesh(res);
          plateauRaised = raised;
          plateauBbox = boundsOfFeatures(raised);
          syncSlabs();
          plateauActive = true;
          applyMask();
          onLift?.();
          settled(scopeId, refined ? "quiet" : "same");
          if (terrainExag !== 1) await animateTerrain(1, RISE_MS);
          if (seq === plateauSeq && terrainExag === 1) markPlateauStood();
          return;
        }
        // ac:mesh=worker: the sink and the mesh both, the commit below one block.
        let res: MeshResult | null = null;
        if (job) res = await sinkAndMesh(sinkP, job, scopeId);
        else await sinkP;
        map = getMap();
        if (seq !== plateauSeq || !map) return;
        // The ground first: a plateau that stood on raised ground has sunk,
        // the terrain leaves its DEM slot for the flat one.
        layFlatGround(map);
        plateauVersion = `flat:${scopeId}`;
        plateauScopeId = scopeId;
        meshPutter().putMesh(res);
        plateauRaised = raised;
        plateauBbox = boundsOfFeatures(raised);
        // Its slabs (the analyses on) rise with it, from 0.
        syncSlabs(true);
        plateauActive = true;
        applyMask();
        onLift?.();
        terrainExag = 0;
        plateauWall.setScale(0);
        // The commit is whole: a pending mark on this unit goes as it rises.
        settled(scopeId, "rise");
        const endFlatRise = perfOn ? perfSpan("plateau.rise", { scope: scopeId }) : null;
        await animateTerrain(1, RISE_MS);
        if (endFlatRise) endFlatRise();
        // The map's first plateau stood (lib/plateauStood.ts), as on raised ground.
        if (seq === plateauSeq && terrainExag === 1) markPlateauStood();
        return;
      }
      // The version key from the relief worker, no request: the same geometry
      // objects the wall meshes (for an outline past ±180, their canonical
      // copy), at this height. The worker keeps the selection. Any rejection
      // (too large, the client lost) takes the catch below: no plateau.
      const demRaised = demFeatures(raised);
      const endKey = perfOn ? perfSpan("dem.key", { scope: scopeId }) : null;
      const c = await loadReliefClient();
      relief = c;
      c.onReliefLost(() => void ensurePlateau());
      const { key } = await c.registerSelection(demRaised, heightM);
      if (endKey) endKey();
      // Nothing standing, so no sink to wait for: a fixed hold after the
      // registration, timed against the lid shot's settle wait so the commit
      // lands just before its readback, not frames ahead of it with GPU work
      // for it to wait on (reliefSwitch DEFAULT_RELIEF_COMMIT_HOLD_MS).
      if (!plateauVersion) await c.commitHold();
      if (!key) throw new Error("dem version missing");
      map = getMap();
      if (seq !== plateauSeq || !map) return; // superseded by a newer selection
      const { early, putMesh } = meshPutter();
      if (key === plateauVersion && map.getSource(terrainSrc)) {
        // Same selection → just make sure it's up (e.g. after an interrupted sink).
        let res: MeshResult | null = null;
        if (job) {
          res = await meshWait(job, scopeId, "same");
          map = getMap();
          if (seq !== plateauSeq || !map) return;
        }
        putMesh(res);
        plateauRaised = raised;
        plateauBbox = boundsOfFeatures(raised);
        syncSlabs();
        plateauActive = true;
        applyMask();
        if (!map.getTerrain()) setTerrainRaw(terrainSrc, terrainExag);
        settled(scopeId, "same");
        if (terrainExag !== 1) await animateTerrain(1, RISE_MS);
        if (seq === plateauSeq && terrainExag === 1) markPlateauStood();
        return;
      }
      // PREFETCH: stand the new DEM up in the spare slot while the old one sinks
      // (the invisible hillshade forces Mapbox to start fetching current-viewport
      // tiles now).
      const { zCanon } = early ?? canonicalOf(raised);
      const next: DemSlot = terrainSrc === "plateau-dem-a" ? "plateau-dem-b" : "plateau-dem-a";
      // A fast drill: the last swap left `next` and no frame has rendered since,
      // so mapbox's evaluated terrain may still name it — its removal waits for
      // that frame (no cap: removing before it is the race).
      if (slots.spareNeedsFrame(map, next)) {
        const rendered = await slots.waitForFrame(map, next);
        map = getMap();
        if (seq !== plateauSeq || !map) return;
        // Abandoned while this run is current (a throw from the map): never
        // removed without a frame — the catch below clears the plateau.
        if (!rendered) throw new Error("spare slot wait abandoned");
      }
      if (map.getLayer("plateau-prefetch")) map.removeLayer("plateau-prefetch");
      const template = demTemplate(key);
      // The spare slot and its prefetch (relief/prefetchPlan.ts): a spare slot
      // that is the terrain (a superseded terrain0 run's) is re-pointed or kept,
      // never removed; its template and maxzoom read from serialize(), the
      // source's options as last set (`tiles` lands only with the TileJSON, a
      // frame later). Without the testing tools the prefetch is the hillshade:
      // only the guard ships, re-pointing at zCanon.
      const quiet = !changed && !!plateauVersion && !!map.getTerrain();
      const spare = map.getSource(next) as
        { serialize?(): { tiles?: string[]; maxzoom?: number } } | undefined;
      const nextIsTerrain = map.getTerrain()?.source === next;
      const spec = __TEST_TOOLS__ ? spare?.serialize?.() : undefined;
      const plan: PrefetchPlan = __TEST_TOOLS__
        ? planPrefetch({
            prefetch: reliefPrefetch,
            standing: !!plateauVersion,
            quiet,
            nextIsTerrain,
            nextExists: !!spare,
            nextTemplate: spec?.tiles?.[0],
            nextMaxzoom: spec?.maxzoom,
            template,
            zCanon,
          })
        : {
            slot: spare && nextIsTerrain ? "repoint" : "add",
            setMaxzoom: true,
            hillshade: true,
            earlyTerrain: false,
          };
      if (plan.slot === "add") {
        // The spare slot's source is replaced: its key is no longer held.
        relief?.releaseSlot(next);
        slots.addDemSlot(map, next, {
          type: "raster-dem",
          tiles: [template],
          tileSize: 256,
          // Capped at the selection's canonical zoom: zooming/flying past it overzooms
          // the SAME tiles instead of fetching new pyramids — no mid-rise tile pops.
          // The visible wall edge is our vector geometry, so the overzoom slope on the
          // (eroded, hidden) raster edge doesn't matter.
          maxzoom: zCanon,
          encoding: "mapbox",
        });
        relief?.holdSlot(next, key);
        // ---- perf probe: dem.tilesReady, this slot's tiles from here (testing tools only) ----
        if (perfOn) watchTilesReady(map, next, scopeId);
        // ---- end perf probe ----
      } else if (plan.slot === "repoint") {
        // The live terrain's source: new tiles in place (no dem.tilesReady
        // span: the probe counts the run apart).
        relief?.releaseSlot(next);
        repointDemSlot(map, next, template, plan.setMaxzoom ? zCanon : undefined);
        relief?.holdSlot(next, key);
        if (perfOn) prefetchRuns.repoints++;
      } else if (perfOn) prefetchRuns.keeps++;
      if (!__TEST_TOOLS__ || plan.hillshade) {
        map.addLayer({
          id: "plateau-prefetch",
          type: "hillshade",
          source: next,
          paint: { "hillshade-exaggeration": 0 },
        });
      } else if (plan.earlyTerrain) {
        // terrain0, nothing of ours standing: the slot is made the root terrain
        // at 0 at once. It starts no tile by itself: with nothing standing the
        // sink is already resolved, so the commit's swap below follows in this
        // same task (one microtask), before any frame — every terrain0 run
        // starts its tiles at the swap. Not with ac:mesh=worker: there the swap
        // also waits for the worker's mesh, frames meanwhile drawing this slot
        // as the terrain at 0 (terrain0 timings are not read with the worker
        // on). It only shapes the state a run superseded inside that microtask
        // leaves. Tracked as a swap (no drop before a frame); no generation
        // bump, addDemSlot just made one.
        // Superseded by a NEW selection, it stays the terrain at 0 until that
        // run re-points or keeps it (an elevated root terrain keeps the
        // import's relief hidden).
        terrainExag = 0;
        earlyTerrainSlot = next;
        setTerrainRaw(next, 0);
        slots.swapped(map, terrainSrc);
        if (perfOn) prefetchRuns.earlyTerrains++;
      }
      if (quiet) {
        // SAME unit, new version → its geometry was merely REFINED (boundary data
        // arrived after a cold load). QUIET swap at the current height: wait for the new
        // tiles (old plateau stays up meanwhile), reshape in place — no sink/rise
        // theatrics for a shape refinement.
        const t0 = performance.now();
        for (;;) {
          map = getMap();
          if (seq !== plateauSeq || !map) return;
          let loaded = true;
          try {
            loaded = map.isSourceLoaded(next);
          } catch {
            /* source gone → don't block */
          }
          if (loaded || performance.now() - t0 > 600) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        map = getMap();
        if (seq !== plateauSeq || !map) return;
        let res: MeshResult | null = null;
        if (job) {
          res = await meshWait(job, scopeId, "quiet");
          map = getMap();
          if (seq !== plateauSeq || !map) return;
        }
        // ac:late-files "quiet": the reshape (a mesh upload, a terrain swap)
        // is applied when the map is still, as a reshape of the lines is
        // (redress), LATE_CAP_MS at the latest: the outline that asked for
        // it was stored at a still moment, and the map may have moved since.
        if (lateFilesMode === "quiet") {
          await new Promise<void>((done) => stillMap.whenStill(done, { timeoutMs: LATE_CAP_MS }));
          map = getMap();
          if (seq !== plateauSeq || !map) return;
        }
        plateauVersion = key;
        plateauScopeId = scopeId;
        earlyTerrainSlot = null;
        const oldSrc = terrainSrc;
        terrainSrc = next;
        setTerrainRaw(next, terrainExag);
        slots.swapped(map, oldSrc);
        if (map.getLayer("plateau-prefetch")) map.removeLayer("plateau-prefetch");
        if (oldSrc !== next) slots.dropDemSourceSoon(map, oldSrc);
        putMesh(res);
        plateauRaised = raised;
        plateauBbox = boundsOfFeatures(raised);
        syncSlabs();
        plateauActive = true;
        applyMask();
        settled(scopeId, "quiet");
        return;
      }
      // ac:mesh=worker: the sink and the mesh both, the commit below one block.
      let res: MeshResult | null = null;
      if (job) res = await sinkAndMesh(sinkP, job, scopeId);
      else await sinkP;
      map = getMap();
      if (seq !== plateauSeq || !map) return;
      // Swap to the prefetched slot and drop the old one. Terrain switches DIRECTLY
      // old→next (same as the quiet swap): a setTerrain(null) gap would resurrect
      // the style fragment's own mapbox-dem terrain, and removing a raster-dem
      // source while THAT terrain re-evaluates crashes inside mapbox's
      // updateTerrain on globe ("Cannot read properties of undefined").
      plateauVersion = key;
      plateauScopeId = scopeId;
      earlyTerrainSlot = null;
      const old = terrainSrc;
      terrainSrc = next;
      if (map.getLayer("plateau-prefetch")) map.removeLayer("plateau-prefetch");
      // New wall mesh; wall and terrain rise together from 0. The OLD lid texture is
      // intentionally KEPT until the new snapshot (capturing since the top of this
      // run) lands: where old/new areas overlap, slightly-stale imagery covers the
      // rim gap; elsewhere the UV discard hides it.
      putMesh(res);
      plateauRaised = raised;
      plateauBbox = boundsOfFeatures(raised);
      // Its slabs (the analyses on) rise with it, from 0.
      syncSlabs(true);
      plateauActive = true;
      applyMask();
      terrainExag = 0;
      setTerrainRaw(next, 0);
      slots.swapped(map, old);
      if (old !== next) slots.dropDemSourceSoon(map, old);
      // The commit is whole: a pending mark on this unit goes as it rises.
      settled(scopeId, "rise");
      // No tile wait (arrival tiles were prefetched during the sink): the rise starts
      // IMMEDIATELY on click and plays during the camera flight. Slight terrain
      // LOD re-tessellation can show mid-flight — chosen over a delayed rise.
      const endRise = perfOn ? perfSpan("plateau.rise", { scope: scopeId }) : null;
      await animateTerrain(1, RISE_MS);
      if (endRise) endRise();
      // The map's first plateau stood (a latch, lib/plateauStood.ts): what
      // waited for it (the decorative outlines) may come now.
      if (seq === plateauSeq && terrainExag === 1) markPlateauStood();
      map = getMap();
      if (import.meta.env.DEV && seq === plateauSeq && map) {
        const c = boundsOfFeatures(raised);
        const elev = c
          ? map.queryTerrainElevation([(c.minLng + c.maxLng) / 2, (c.minLat + c.maxLat) / 2])
          : null;
        console.info(
          `[plateau] up scope=${scopeId} h=${Math.round(heightM)} zoom=${map.getZoom().toFixed(2)} ` +
            `proj=${map.getProjection()?.name} elevAtCentre=${elev == null ? "null" : Math.round(elev)}`,
        );
      }
    } catch (err) {
      map = getMap();
      // Leave the terrain flat AND clear the wall — violet walls must never stand
      // over a plateau that failed to rise. The boundary lines stay (grounded).
      if (import.meta.env.DEV) console.warn("[plateau] transition failed:", err);
      if (seq === plateauSeq) {
        // ac:lines-mesh: the lines' mesh from the worker here too; the wall
        // comes down with it, in the block below.
        const asked = askLines(focus, context);
        const res = asked ? await meshWait(asked.job, "", "failed") : null;
        map = getMap();
        if (asked && (seq !== plateauSeq || !map)) return;
        putLines(asked, res, focus, context);
        plateauRaised = [];
        plateauBbox = null;
        clearSlabs();
        plateauWall.setLidTexture(null);
        // The flat terrain stays: it is the ground, not the plateau.
        if (!flatGround && map?.getTerrain()) map.setTerrain(null);
        plateauActive = false;
        applyMask();
        onLift?.();
        settled(scopeId, "failed");
      }
    } finally {
      if (seq === plateauSeq) runEnded();
    }
  }

  /** A run that holds for an outline on its way (ac:cold-start "early"): the
   *  plateau standing starts its sink, and the coming unit's lid is shot over
   *  its box (lib/coldStart.ts). The run that raises the unit joins that sink
   *  (animateTerrain is idempotent) and adopts that shot, or finds it landed
   *  (usePlateauLid: the same rectangle). A hold run again does neither twice. */
  function coldStart(seq: number, map: mapboxgl.Map) {
    const next = coming?.();
    const plan = coldStartPlan({
      mode: coldStartMode.value,
      coming: next,
      standingId: plateauScopeId,
      standingUp: !!plateauVersion && (flatGround || !!map.getTerrain()) && terrainExag > 0,
    });
    if (!next || (!plan.sink && !plan.lid)) return;
    if (earlyLid?.id !== next.id) {
      coldStarts++;
      if (perfOn) perfNote("plateau.coldStart", 0, { scope: next.id, sink: plan.sink });
    }
    if (plan.sink) void animateTerrain(0, SINK_MS);
    if (plan.lid) {
      earlyLid = { id: next.id, bounds: plan.lid };
      void lid.capture(seq, [boxFeature(earlyLid)]);
    }
  }

  /** The current run has ended (stood, failed, or returned): an outline that
   *  came meanwhile for the very shape it raised is read again, once the map
   *  is still (its lines may have changed: one reshape in place). */
  function runEnded() {
    runFor = null;
    if (!owed) return;
    owed = false;
    stillMap.whenStill(
      () => {
        if (getMap()) outlineChanged();
      },
      { timeoutMs: LATE_CAP_MS },
    );
  }

  /** The plateau standing whole: active, one raised unit, up (or rising to
   *  it), on its own terrain (its DEM slot's, or over flat ground the flat
   *  one). Null otherwise — a plateau cleared, failed or
   *  torn down, a sink cut short —, and the next outline is a pipeline run. */
  function standing(): RaisedShape | null {
    const map = getMap();
    if (!map || !plateauActive || plateauRaised.length !== 1) return null;
    if (terrainExag !== 1 && exagAnim?.target !== 1) return null;
    const ground = flatGround ? FLAT_SRC : terrainSrc;
    if (!map.getSource(ground) || map.getTerrain()?.source !== ground) return null;
    return raisedShapeOf(plateauRaised);
  }

  /** ac:late-files "quiet": the outline changed (GeoDrillMap's watcher). What
   *  it asks of the plateau, judged against what stands (lib/outlineChange.ts),
   *  and done: a pipeline run, a reshape in place, nothing, or — a run for
   *  this very shape being under way — a second look once it has ended. */
  function outlineChanged(): OutlineVerdict {
    const features = outline()?.features ?? [];
    const verdict = outlineVerdict(features, { standing: standing(), running: runFor, dressed });
    if (perfOn) perfNote("plateau.outline", 0, { verdict });
    if (verdict === "run") void ensurePlateau();
    else if (verdict === "redress") void redress();
    else if (verdict === "owed") owed = true;
    return verdict;
  }

  /** The standing plateau's lines brought in line with the outline (its
   *  children's, its neighbours'): one mesh, built off the page when the
   *  worker is there, applied in place when the map is still. The unit, its
   *  shape, its height, its relief, its lid are untouched: no sink, no rise,
   *  no run of the pipeline. Anything else than "the same shape, standing"
   *  when the mesh is ready goes back to `outlineChanged`. */
  async function redress() {
    const map = getMap();
    if (!map || !mapReady()) return;
    const seq = plateauSeq;
    const mine = ++redressSeq;
    const features = outline()?.features ?? [];
    const raised = features.filter((f) => f.properties?.kind === "scope");
    const focus = features.filter((f) => f.properties?.kind === "focus");
    const context = features.filter((f) => f.properties?.kind === "context");
    const shape = raisedShapeOf(raised);
    const up = standing();
    if (!shape || !up || !sameShape(shape, up)) return void outlineChanged();
    const t0 = performance.now();
    const heightM = plateauHeightM(
      raised[0]?.properties?.heightClass as HeightClass | undefined,
      raised,
    );
    // The mesh, as a pipeline run builds it (ac:mesh): the worker's, its globe
    // set's mode for the camera now, else built here at the apply.
    const client = meshMode === "worker" ? (meshClient?.() ?? null) : null;
    const early = meshMode === "merc" || meshMode === "worker" ? canonicalOf(raised) : null;
    const startMode = client && early ? globeSetMode(early.zCanon, map.getZoom()) : "eager";
    const res = client
      ? await client.build(
          { features: raised, heightM, focus, context },
          { merc: true, globe: startMode === "eager" },
        )
      : null;
    const current = () => {
      const now = standing();
      return seq === plateauSeq && mine === redressSeq && !runFor && !!now && sameShape(shape, now);
    };
    if (!current()) return;
    // Applied at a still moment (the mesh's upload is not for a flight, a
    // rise or a gesture), LATE_CAP_MS at the latest.
    stillMap.whenStill(
      () => {
        const m = getMap();
        if (!m || !current()) return;
        const zoom = m.getZoom();
        const opts = early
          ? { globe: globeSetMode(early.zCanon, zoom), zCanon: early.zCanon, zoom }
          : undefined;
        try {
          if (client && res && opts) {
            plateauWall.applyBuilt(
              res.mesh,
              { features: raised, heightM, focus, context },
              { ...opts, start: startMode, via: res.via },
            );
            client.applied(res);
            workerApplies++;
          } else plateauWall.setGeometry(raised, heightM, focus, context, opts);
        } catch (err) {
          // The wall is in an unknown state: the pipeline sets it right.
          if (import.meta.env.DEV) console.warn("[plateau] redress failed:", err);
          void ensurePlateau();
          return;
        }
        dressed = [...focus, ...context];
        syncSlabs();
        applyMask();
        redresses++;
        if (perfOn) {
          perfNote("plateau.redress", performance.now() - t0, {
            scope: shape.scopeId,
            lines: dressed.length,
          });
        }
      },
      { timeoutMs: LATE_CAP_MS },
    );
  }

  /**
   * The plateau of unit `scopeId` asked once more (the panel's « Réessayer »,
   * its outline being in memory): the pipeline is run again, from the outline
   * as it is — no file is asked, no camera moved — unless a run for that
   * unit is under way ("running": it has its own watchdogs, a second one
   * would only add work) or its plateau stands ("standing"). "none": no map,
   * or its style not loaded yet.
   */
  function retry(scopeId: string): "rerun" | "running" | "standing" | "none" {
    if (!getMap() || !mapReady()) return "none";
    const verdict = retryVerdict(scopeId, { standing: standing(), running: runFor });
    if (verdict === "rerun") void ensurePlateau();
    return verdict;
  }

  /** Unmount: the rise/sink animation stops where it is. */
  function cancelAnimation() {
    cancelExagAnim();
  }

  /** Unmount: any in-flight ensurePlateau run is superseded. */
  function abort() {
    plateauSeq++;
    if (perfOn) stopTilesReady();
    slots.abort();
    relief?.releaseSlot("plateau-dem-a");
    relief?.releaseSlot("plateau-dem-b");
  }

  /** The plateau's share of the __acPlateau probe. */
  function probe() {
    const map = getMap();
    return {
      plateauActive,
      scope: plateauScopeId,
      // What the plateau stands on, what the switch asks of the next one, and
      // mapbox's terrain under the camera's centre, m — null: it runs none
      // there (the flat map over flat ground), or its tile is not in yet.
      ground: flatGround ? "flat" : "relief",
      groundWanted: groundNow(),
      centreElevation: map ? (map.queryTerrainElevation(map.getCenter()) ?? null) : null,
      demSource: terrainSrc,
      demMaxzoom: (map?.getStyle().sources?.[terrainSrc] as { maxzoom?: number })?.maxzoom,
      // The dem.tilesReady spans begun and ended, and the listener up (≤ 1).
      ...(perfOn ? { demReady: { ...demReady, live: offTilesReady ? 1 : 0 } } : {}),
      // The reshapes in place applied (ac:late-files "quiet").
      ...(perfOn ? { redresses } : {}),
      // The holds that started early (ac:cold-start "early").
      ...(perfOn ? { coldStarts } : {}),
      // The spare slot's path (ac:relief-prefetch): re-points, keeps, early terrains.
      ...(perfOn ? { prefetch: { mode: reliefPrefetch, ...prefetchRuns } } : {}),
    };
  }

  return {
    ensurePlateau,
    outlineChanged,
    retry,
    cancelAnimation,
    abort,
    /** Whether a plateau is standing. */
    active: () => plateauActive,
    /** The run counter (a capture started by a superseded run is dropped). */
    seq: () => plateauSeq,
    /** The standing plateau's unit and box, as last given to setGeometry. */
    raised: () => plateauRaised,
    bbox: () => plateauBbox,
    /** The map's load: the flat terrain laid, or the relief worker started. */
    prepareGround,
    /** Whether a plateau raised now stands over flat ground (the camera then
     *  comes to rest on the ground, not on the plateau). */
    flatWanted: () => groundNow() === "flat",
    /** What stands above flat ground (plateau/lift.ts); null on raised ground
     *  and with no plateau. */
    lift,
    probe,
  };
}
