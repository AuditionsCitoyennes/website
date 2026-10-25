// The plateau: the selected unit's real map raised as a flat-topped plateau on
// a custom DEM (the API's), the terrain exaggeration animated for the rise and
// the sink, the DEM source double-buffered so a new selection's tiles prefetch
// while the old plateau sinks, and the ensurePlateau state machine (its run
// counter `plateauSeq` aborts superseded runs). Owns `plateauActive`, exposed
// as a getter.

import type mapboxgl from "mapbox-gl";
import type { Bounds } from "@/features/geo";
import { perfEnd, perfSpan } from "@/shared/perf/perf";
import { boundsOfFeatures, plateauHeightM } from "../lib/polygon";
import type { PlateauWallLayer } from "../gl/PlateauWallLayer";
import type { OutlineFC } from "../types";
import type { usePlateauLid } from "./usePlateauLid";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

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
  /** The lid (usePlateauLid): captured for a new selection, reset with the plateau. */
  lid: Pick<ReturnType<typeof usePlateauLid>, "capture" | "reset" | "hasTexture">;
  /** `cameraForBounds` blind to the terrain (useMapCamera): the DEM's canonical zoom. */
  flatCamera: (
    bounds: mapboxgl.LngLatBoundsLike,
    options: Parameters<mapboxgl.Map["cameraForBounds"]>[1],
  ) => ReturnType<mapboxgl.Map["cameraForBounds"]>;
  /** The grey outside the plateau, cut around it (useScopeMask). */
  applyMask: () => void;
  /** The analyses' slabs (usePlateauSlabs): brought in line with the plateau standing. */
  syncSlabs: (atSwap?: boolean) => void;
  clearSlabs: () => void;
  /** A new unit: the DEV "Carte" lid must not take the old unit's slabs in (usePlateauSlabs). */
  forgetLidExtra: () => void;
}

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
  lid,
  flatCamera,
  applyMask,
  syncSlabs,
  clearSlabs,
  forgetLidExtra,
}: PlateauInputs) {
  // Whether a plateau is currently standing — the draped hover-fill fallback only
  // applies when none is (world scope); otherwise the GL sweep owns the highlight.
  let plateauActive = false;
  // ---- Plateau elevation: raise the SELECTED area's real map as a flat-topped
  // plateau (custom DEM served by the API). The camera tilts so the relief reads. ----
  let plateauVersion = "";
  let plateauScopeId = ""; // selection identity — detects a change before any network
  let plateauSeq = 0; // guards overlapping ensurePlateau runs (fast drills)
  // Double-buffered DEM source slots: the NEW selection's tiles prefetch in the spare
  // slot while the old plateau is still sinking, so the rise starts without waiting.
  let terrainSrc: "plateau-dem-a" | "plateau-dem-b" = "plateau-dem-a";

  // setTerrain with the exaggeration transition ZEROED. Terrain exaggeration is a
  // transitionable style property (default ~300 ms ease): each per-frame setTerrain
  // would otherwise start a NEW internal transition, so the terrain lagged our rAF
  // animation and visibly "caught up" in steps after the loop ended — while the wall
  // (a raw shader uniform) moved true. Zeroing it puts both in lockstep.
  function setTerrainRaw(src: string, v: number) {
    getMap()?.setTerrain({
      source: src,
      exaggeration: v,
      "exaggeration-transition": { duration: 0 },
    } as unknown as mapboxgl.TerrainSpecification);
  }

  // Removing a raster-dem source in the SAME tick as a terrain change crashes
  // inside mapbox's updateTerrain on globe with fragment styles ("Cannot read
  // properties of undefined (reading 'get')") — hit both when a swap replaced the
  // fragment's own terrain (after a teardown's setTerrain(null)) and when it
  // replaced ours. So old DEM slots are dropped LATER, in a terrain-quiet frame,
  // guarded and swallowed: a stale resident source is harmless, a crashed pipeline
  // is not. The prefetch's synchronous removal of the SPARE slot stays (no terrain
  // mutation in that tick, and the slot must be free for addSource).
  function dropDemSourceSoon(id: string) {
    window.setTimeout(() => {
      const map = getMap();
      try {
        if (map && terrainSrc !== id && map.getTerrain()?.source !== id && map.getSource(id)) {
          map.removeSource(id);
        }
      } catch {
        /* leave it resident — retried implicitly on the next swap into this slot */
      }
    }, 500);
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
        if (getMap()?.getSource(terrainSrc)) setTerrainRaw(terrainSrc, v);
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
        resolve();
      };
      const tick = (now: number) => {
        if (!exagAnim) return;
        if (!getMap()) return finish();
        const t = Math.min(1, (now - t0) / ms);
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
    });
    if (exagAnim) exagAnim.done = done;
    return done;
  }

  /** The standing plateau's unit and box, as last given to setGeometry. */
  let plateauRaised: OutlineFC["features"] = [];
  let plateauBbox: Bounds | null = null;

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

  // Warm EVERY DEM level the camera can touch (coarse flight levels → the canonical
  // zoom) into the browser HTTP cache, so the terrain never materialises in visible
  // chunks mid-rise. Tiles are tiny and the responses are Cache-Control: public.
  function warmDemTiles(version: string, b: Bounds, zCanon: number) {
    const urls: string[] = [];
    for (let z = zCanon; z >= 4 && urls.length < 80; z--) {
      const n = Math.pow(2, z);
      const tx = (lng: number) => Math.floor(((lng + 180) / 360) * n);
      const ty = (lat: number) => {
        const r = (lat * Math.PI) / 180;
        return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
      };
      const x0 = tx(b.minLng);
      const x1 = tx(b.maxLng);
      const y0 = ty(b.maxLat);
      const y1 = ty(b.minLat);
      for (let x = x0; x <= x1 && urls.length < 80; x++) {
        for (let y = y0; y <= y1 && urls.length < 80; y++) {
          urls.push(`${API_BASE}/api/dem/${version}/${z}/${x}/${y}`);
        }
      }
    }
    for (const u of urls) void fetch(u).catch(() => {});
  }

  // Build/refresh the plateau for the current selection. The transition is fully
  // overlapped so there's no dead time: on a selection change the OLD plateau starts
  // sinking immediately (in parallel with the DEM POST), the NEW selection's tiles
  // prefetch in the spare source slot while it sinks, and the rise starts as soon as
  // the sink ends (short capped wait for any straggler tiles).
  async function ensurePlateau() {
    // Pre-load style mutations wedge the load event; during the intro the plateau
    // holds until the tilt starts (the rise then plays in the tilt's flight tail).
    // `map` is read again after every await: unmounted meanwhile, it is null.
    let map = getMap();
    if (!map || !mapReady() || introPending()) return;
    const seq = ++plateauSeq;
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
      if (scopePending()) return;
      // Nothing selected (world level, or the micropin zone) → sink, then clear the
      // plateau; the outline's own lines (e.g. the country boundary at world
      // scope) stay, grounded.
      if (plateauVersion && map.getTerrain()) {
        await animateTerrain(0, SINK_MS);
        map = getMap();
        if (seq !== plateauSeq || !map) return;
        map.setTerrain(null);
      }
      plateauWall.setGeometry([], 0, focus, context);
      plateauRaised = [];
      plateauBbox = null;
      clearSlabs();
      plateauWall.setLidTexture(null);
      plateauVersion = "";
      plateauScopeId = "";
      plateauActive = false;
      applyMask();
      // No lid any more — forget its resolution so a later plateau starts fresh.
      lid.reset();
      // The perf probes: a selection with no plateau (Monde) shows as the map cleared.
      perfEnd("select-plateau", undefined, { cleared: true });
      return;
    }
    const scopeId = String(raised[0]?.properties?.id ?? "");
    // If the newly selected unit was the hovered one, its opaque fill drains in
    // reverse (centre → boundary). Must precede any setGeometry rebuild below —
    // the new focus set no longer contains the selected unit's fill.
    plateauWall.beginSelection(scopeId);
    const heightM = plateauHeightM(scopeId, raised);
    // Start the lid snapshot IMMEDIATELY — it depends on nothing but the geometry,
    // and it's the longest pole (hidden-map tiles + capture). Started here it runs
    // through the sink, the POST and the whole camera flight, landing around the
    // time the rise completes — so the rim gap is never left showing.
    // Only shoot the full-selection lid for a NEW selection (or when none stands).
    // ensurePlateau re-runs on every outline identity change — including each
    // commune batch arriving mid-pan — and an unconditional capture here threw
    // away any zoom refine and reset the texture to the coarse whole-unit shot.
    const changed = scopeId !== plateauScopeId;
    // "Carte" (DEV): the old unit's slabs are not the new one's — its first shot
    // must not take them in (France's, some 900 km, around Lyon's lid). Its own
    // are added once they are built (syncSlabs).
    if (changed) forgetLidExtra();
    if (changed || !lid.hasTexture()) void lid.capture(seq, raised);
    // Selection changed → the old plateau starts sinking NOW, while the POST runs.
    // (A different scope id always hashes to a different DEM version, so this never
    // sinks a plateau that the same-version path would have kept up.)
    const sinkP =
      changed && plateauVersion && map.getTerrain()
        ? animateTerrain(0, SINK_MS)
        : Promise.resolve();
    try {
      const endPost = perfSpan("dem.post", { scope: scopeId });
      const res = await fetch(`${API_BASE}/api/dem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: raised, height: heightM }),
      });
      if (!res.ok) throw new Error(`dem POST ${res.status}`);
      const { version } = (await res.json()) as { version?: string };
      endPost({ status: res.status });
      if (!version) throw new Error("dem POST returned no version");
      map = getMap();
      if (seq !== plateauSeq || !map) return; // superseded by a newer selection
      if (version === plateauVersion && map.getSource(terrainSrc)) {
        // Same selection → just make sure it's up (e.g. after an interrupted sink).
        plateauWall.setGeometry(raised, heightM, focus, context);
        plateauRaised = raised;
        plateauBbox = boundsOfFeatures(raised);
        syncSlabs();
        plateauActive = true;
        applyMask();
        if (!map.getTerrain()) setTerrainRaw(terrainSrc, terrainExag);
        if (terrainExag !== 1) await animateTerrain(1, RISE_MS);
        return;
      }
      // PREFETCH: warm every DEM level the flight can touch into the HTTP cache, and
      // stand the new DEM up in the spare slot while the old one sinks (the invisible
      // hillshade forces Mapbox to start fetching current-viewport tiles now).
      const wb = boundsOfFeatures(raised);
      const zCanon = wb ? canonicalDemZoom(wb) : 12;
      if (wb) warmDemTiles(version, wb, zCanon);
      const next = terrainSrc === "plateau-dem-a" ? "plateau-dem-b" : "plateau-dem-a";
      if (map.getLayer("plateau-prefetch")) map.removeLayer("plateau-prefetch");
      if (map.getSource(next)) map.removeSource(next);
      map.addSource(next, {
        type: "raster-dem",
        tiles: [`${API_BASE}/api/dem/${version}/{z}/{x}/{y}`],
        tileSize: 256,
        // Capped at the selection's canonical zoom: zooming/flying past it overzooms
        // the SAME tiles instead of fetching new pyramids — no mid-rise tile pops.
        // The visible wall edge is our vector geometry, so the overzoom slope on the
        // (eroded, hidden) raster edge doesn't matter.
        maxzoom: zCanon,
        encoding: "mapbox",
      });
      map.addLayer({
        id: "plateau-prefetch",
        type: "hillshade",
        source: next,
        paint: { "hillshade-exaggeration": 0 },
      });
      if (!changed && plateauVersion && map.getTerrain()) {
        // SAME unit, new version → its geometry was merely REFINED (boundary data
        // arrived after a cold load). QUIET swap at the current height: wait for the
        // new tiles (old plateau stays up meanwhile), reshape in place — no
        // sink/rise theatrics for a shape refinement.
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
        plateauVersion = version;
        plateauScopeId = scopeId;
        const oldSrc = terrainSrc;
        terrainSrc = next;
        setTerrainRaw(next, terrainExag);
        if (map.getLayer("plateau-prefetch")) map.removeLayer("plateau-prefetch");
        if (oldSrc !== next) dropDemSourceSoon(oldSrc);
        plateauWall.setGeometry(raised, heightM, focus, context);
        plateauRaised = raised;
        plateauBbox = boundsOfFeatures(raised);
        syncSlabs();
        plateauActive = true;
        applyMask();
        return;
      }
      await sinkP;
      map = getMap();
      if (seq !== plateauSeq || !map) return;
      // Swap to the prefetched slot and drop the old one. Terrain switches DIRECTLY
      // old→next (same as the quiet swap): a setTerrain(null) gap would resurrect
      // the style fragment's own mapbox-dem terrain, and removing a raster-dem
      // source while THAT terrain re-evaluates crashes inside mapbox's
      // updateTerrain on globe ("Cannot read properties of undefined").
      plateauVersion = version;
      plateauScopeId = scopeId;
      const old = terrainSrc;
      terrainSrc = next;
      if (map.getLayer("plateau-prefetch")) map.removeLayer("plateau-prefetch");
      // New wall mesh; wall and terrain rise together from 0. The OLD lid texture is
      // intentionally KEPT until the new snapshot (capturing since the top of this
      // run) lands: where old/new areas overlap, slightly-stale imagery covers the
      // rim gap; elsewhere the UV discard hides it.
      plateauWall.setGeometry(raised, heightM, focus, context);
      plateauRaised = raised;
      plateauBbox = boundsOfFeatures(raised);
      // Its slabs (the analyses on) rise with it, from 0.
      syncSlabs(true);
      plateauActive = true;
      applyMask();
      terrainExag = 0;
      setTerrainRaw(next, 0);
      if (old !== next) dropDemSourceSoon(old);
      // No tile wait (arrival tiles were warmed during the sink): the rise starts
      // IMMEDIATELY on click and plays during the camera flight. Slight terrain
      // LOD re-tessellation can show mid-flight — chosen over a delayed rise.
      const endRise = perfSpan("plateau.rise", { scope: scopeId });
      await animateTerrain(1, RISE_MS);
      endRise();
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
        plateauWall.setGeometry([], 0, focus, context);
        plateauRaised = [];
        plateauBbox = null;
        clearSlabs();
        plateauWall.setLidTexture(null);
        if (map?.getTerrain()) map.setTerrain(null);
        plateauActive = false;
        applyMask();
      }
    }
  }

  /** Unmount: the rise/sink animation stops where it is. */
  function cancelAnimation() {
    cancelExagAnim();
  }

  /** Unmount: any in-flight ensurePlateau run is superseded. */
  function abort() {
    plateauSeq++;
  }

  /** The plateau's share of the __acPlateau probe. */
  function probe() {
    const map = getMap();
    return {
      plateauActive,
      scope: plateauScopeId,
      demSource: terrainSrc,
      demMaxzoom: (map?.getStyle().sources?.[terrainSrc] as { maxzoom?: number })?.maxzoom,
    };
  }

  return {
    ensurePlateau,
    cancelAnimation,
    abort,
    /** Whether a plateau is standing. */
    active: () => plateauActive,
    /** The run counter (a capture started by a superseded run is dropped). */
    seq: () => plateauSeq,
    /** The standing plateau's unit and box, as last given to setGeometry. */
    raised: () => plateauRaised,
    bbox: () => plateauBbox,
    probe,
  };
}
