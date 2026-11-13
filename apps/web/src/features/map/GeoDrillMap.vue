<script setup lang="ts">
// The map component: the one Mapbox instance GeoNav drives. A thin shell —
// props and emits, the map's creation, the wiring of the composables under
// features/map/composables and of the two GL layers, the lifecycle and the
// watchers in today's order. Everything that is a responsibility of its own
// lives in a composable, each taking `getMap` and explicit getters or
// callbacks, never this component; the hot per-frame state (the map, the GL
// layer, typed arrays, frame buffers) is plain `let`s owned by one module and
// never wrapped in ref/reactive.
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import mapboxgl from "mapbox-gl";
// Mapbox's own stylesheet, with the map's code rather than in the stylesheet
// every page waits for (main.ts): Vite loads it before this chunk runs.
import "mapbox-gl/dist/mapbox-gl.css";
import { FRANCE_CENTER } from "@ac/shared";
import { perfNote, perfOn } from "@/shared/perf/perf";
import { toLngLat } from "./lib/polygon";
import { stillMap } from "./lib/stillMap";
import { resetPlateauStood } from "./lib/plateauStood";
import { PlateauWallLayer } from "./gl/PlateauWallLayer";
import type { MeshClient } from "./gl/meshClientCore";
import { meshMode } from "./plateau/meshSwitch";
import { bootWorkers, workersStartAt } from "./bootWorkersSwitch";
import { labelGlyphOptions, whenLabelFont } from "./labelFont";
import { useMapView, type MapView } from "./composables/useMapView";
import { useScopeMask } from "./composables/useScopeMask";
import { usePlateauFrames } from "./composables/usePlateauFrames";
import { useSlabOcclusion } from "./composables/useSlabOcclusion";
import { usePlateauLid } from "./composables/usePlateauLid";
import { useMapCamera } from "./composables/useMapCamera";
import { useMapPins } from "./composables/useMapPins";
import { usePlateau, type PlateauSettle } from "./composables/usePlateau";
import { usePlateauSlabs } from "./composables/usePlateauSlabs";
import { installProbes } from "./dev/probes";
import { installPmtilesProbe } from "./dev/pmtiles";
import { demTransformRequest, loadReliefClient } from "./relief/demHook";
import type { MarkGeometry } from "./gl/pendingMark";
import type { TapMark } from "./plateau/tapAnswerSwitch";
import type { CameraCmd, MapUnit, OutlineFC, SlabSpec } from "./types";
import { MAP_MOVED_EVENT } from "./events";
import { fallbackForced, fallbackView, mapFallback, MAP_FALLBACK_TEXT } from "./fallbackSwitch";

// The picture of France under the fallback sentence: a rare path (the map
// nearly always starts), so its file is asked for only when it shows.
const FrancePoster = defineAsyncComponent(() => import("@/shared/ui/FrancePoster.vue"));

const props = defineProps<{
  units: MapUnit[];
  camera: CameraCmd | null;
  outline?: OutlineFC | null;
  padding?: { top: number; bottom: number; left: number; right: number } | number;
  /**
   * The rectangle actually clear of the panel RIGHT NOW, when that is not the
   * one `padding` describes — the panel opened wide over the map. It moves the
   * LOGICAL view (what the scope is read from, which pins are in sight) and
   * where commands aim (see aimOffset): it never moves the camera by itself,
   * so the panel widening, folding or unfolding leaves the globe where it is.
   */
  viewPadding?: { top: number; bottom: number; left: number; right: number };
  /** The scope's boundary geometry is still loading (cold cache) — hold the
   *  current plateau instead of tearing it down for a transient blank. */
  scopePending?: boolean;
  /** Unit hovered OUTSIDE the map (a panel row) — drives the same highlight the
   *  map's own pointer does. Null/absent leaves the map's hover to the pointer. */
  hoveredId?: string | null;
  /** The lieu whose testimonies the panel is showing — its pin carries a pulsing
   *  halo so the reader can tell which dot the text belongs to. */
  activeId?: string | null;
  /** The analyses' slabs on the raised unit (see SlabSpec); null: none. */
  slabs?: SlabSpec | null;
  /** The outline's geometry objects change only with their shape (the outline
   *  files): of two outlines holding a point, the smaller box is hit (pins'
   *  `smallerWins`). */
  stableOutline?: boolean;
  /** Credits for the app's own data (the boundaries' sources), shown before
   *  Mapbox's in the map's attribution. Mapbox HTML: http(s) anchors only. */
  attribution?: readonly string[];
  /** The map corner the credits' « i » sits in (default bottom right, where
   *  mapbox's own goes). */
  creditCorner?: "top-left" | "bottom-right";
}>();

const emit = defineEmits<{
  unitClick: [id: string];
  /** The view, measured (composables/useMapView): what the scope is read from. */
  viewChange: [view: MapView];
  /**
   * The basemap is painted and the intro is about to play — i.e. the map is
   * presentable. Fires once. Also fires when the map is declared unavailable, so
   * a boot overlay is never left waiting on a map that will never arrive.
   */
  ready: [];
  /**
   * The USER has just started moving the map — a drag, the wheel, a pinch, a
   * double-click, the keyboard, the zoom buttons. Never a camera command, the
   * padding ease, a resize, a hover or a click on a pin. Fires again for each
   * gesture (and for each wheel notch): the listener must be idempotent.
   */
  userGesture: [];
  /**
   * A run of the plateau pipeline has come to its verdict for unit `scopeId`
   * ("" when the map was cleared): see PlateauSettle. Fires inside the block
   * that applies the plateau, before its first rise frame: what a pending
   * mark (`markPending`) waits for.
   */
  plateauSettled: [scopeId: string, how: PlateauSettle];
}>();

/** `ready` fires at most once. */
let readyEmitted = false;
function emitReady() {
  if (readyEmitted) return;
  readyEmitted = true;
  emit("ready");
}

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? "";
const STYLE = import.meta.env.VITE_MAPBOX_STYLE || "mapbox://styles/mapbox/dark-v11";

const el = ref<HTMLElement | null>(null);
// No map: no token in the build, or not started on purpose (`ac:map-fallback`
// "essai"); later, the style refused or the engine failing. What the box then
// shows: fallbackSwitch.ts.
const unavailable = ref(!TOKEN || fallbackForced(mapFallback));
const fallback = fallbackView(mapFallback);

// The map, a plain variable: the composables read it through `getMap`, never
// hold it. Null before mount and after unmount.
let map: mapboxgl.Map | null = null;
const getMap = () => map;
// The attribution control, ours (the map's own is off): mapbox reads
// customAttribution once, at the control's creation, and has no setter, so a
// change of `attribution` replaces it (the last watcher).
let attrib: mapboxgl.AttributionControl | null = null;
// Compact (mapbox's « i », opened on demand) at every width: with the
// boundaries' credits the line is far longer than the room the zoom buttons
// and the logo leave it. Closed until the visitor opens it (mapbox's own
// click), and it closes on that click again or when the last watcher
// replaces it.
const newAttribution = () =>
  new mapboxgl.AttributionControl({
    compact: true,
    customAttribution: [...(props.attribution ?? [])],
  });
const creditCorner = () => props.creditCorner ?? "bottom-right";
// True once the style's load event fired. The plateau pipeline MUST NOT mutate
// the style (addSource/addLayer/setTerrain) before then: pre-load mutations sit
// in the style's change-set and permanently wedge style.loaded() → the load
// event never fires → the wall/outline layers are never added. Reachable since
// the country became a plateau scope (its pipeline starts ~1 s into a fresh
// page, racing the style load); the load handler runs ensurePlateau itself.
let mapReady = false;
let resizeObserver: ResizeObserver | null = null;

// The plateau's violet wall (and the analyses' slabs' pieces): our custom
// WebGL layer, created here, added to the style by the mask once it loads.
const plateauWall = new PlateauWallLayer();
// ac:mesh=worker (plateau/meshSwitch.ts): this map's own mesh worker, made at
// its load and disposed with it. Null before then and in every other mode.
let meshClient: MeshClient | null = null;

// ---- The composables, in dependency order ----------------------------------------
// None registers a Vue watcher (the watchers below are the shell's, in today's
// order), so the order only says who reads whom. An input that points at a
// composable created LATER is a thunk (`() => plateau.active()`), called at
// runtime only — never during setup: view → mask → frames → occlusion → lid →
// camera → pins → plateau → slabs. The flags read across responsibilities
// stay plain lets of their owner, exposed as getters: `plateauActive` and
// `plateauSeq` (usePlateau), `introPending` and `userHolding` (useMapCamera),
// `isGlobeStyle` (useScopeMask), `fitCam` (useMapCamera: the slabs only read
// it), `lidExtra` (usePlateauSlabs), `mapReady` (here).
const view = useMapView({
  getMap,
  padding: () => props.padding,
  viewPadding: () => props.viewPadding,
  userHolding: () => camera.userHolding(),
  onView: (v) => emit("viewChange", v),
});
const mask = useScopeMask({
  getMap,
  wall: plateauWall,
  outline: () => props.outline,
  scopePending: () => props.scopePending,
  plateauActive: () => plateau.active(),
});
const frames = usePlateauFrames({ getMap, wall: plateauWall });
const occlusion = useSlabOcclusion({ getMap, wall: plateauWall, frames });
const lid = usePlateauLid({
  getMap,
  wall: plateauWall,
  style: STYLE,
  plateauSeq: () => plateau.seq(),
  plateauActive: () => plateau.active(),
  lidExtra: () => slabs.lidExtra(),
});
const camera = useMapCamera({
  getMap,
  padding: () => props.padding,
  viewPadding: () => props.viewPadding,
  globe: mask.isGlobeStyle,
  emitView: view.emitView,
  onSettled: onCameraSettled,
  // A real animated flight (or the intro's own tilt) releases the intro: the
  // outline-driven pipeline runs — the rise plays in the flight's tail.
  onIntroReleased: () => void plateau.ensurePlateau(),
  mapReady: () => mapReady,
  // The same fit run again (a resize, a new padding) lands on another camera:
  // its unit's slabs are sized for it now.
  afterFit: () => slabs.syncSlabs(),
  onReady: emitReady,
});
const pins = useMapPins({
  getMap,
  units: () => props.units,
  hoveredId: () => props.hoveredId,
  activeId: () => props.activeId,
  wall: plateauWall,
  plateauActive: () => plateau.active(),
  screenBoundsInset: view.screenBoundsInset,
  occlusion,
  onUnitClick: (id) => emit("unitClick", id),
  smallerWins: () => !!props.stableOutline,
});
const plateau = usePlateau({
  getMap,
  wall: plateauWall,
  mapReady: () => mapReady,
  introPending: camera.introPending,
  outline: () => props.outline,
  scopePending: () => props.scopePending,
  lid,
  flatCamera: camera.flatCamera,
  applyMask: mask.applyMask,
  syncSlabs: (atSwap) => slabs.syncSlabs(atSwap),
  clearSlabs: () => slabs.clearSlabs(),
  forgetLidExtra: () => slabs.forgetLidExtra(),
  meshClient: () => meshClient,
  onSettled: (scopeId, how) => emit("plateauSettled", scopeId, how),
});
const slabs = usePlateauSlabs({
  getMap,
  wall: plateauWall,
  slabs: () => props.slabs,
  fitCam: camera.fitCam.get,
  liveSlabCam: camera.liveSlabCam,
  plateau,
  lid,
  hidePinsUnderSlabs: pins.hidePinsUnderSlabs,
});

// ---- A tapped unit's PENDING mark (the parent decides when: see GeoNav's
// model/tapPendingCore) — drawn by the plateau's layer in buffers of its own,
// and worn by the unit's pill ----
/**
 * Mark unit `id` as tapped, its plateau on its way: `mark.stroke` and
 * `mark.fill` on its territory, from its outline as it is in `units` NOW (so
 * before the selection replaces them), `mark.pill` on its pill. One repaint;
 * nothing moves until `endPending`. A newer mark replaces this one. Answers
 * "shown", "none" (nothing could be shown: no map yet, a unit with no outline
 * in memory and no pill) or "standing" (the unit's plateau stands already:
 * nothing is on its way, no verdict will come).
 */
function markPending(id: string, mark: TapMark): "shown" | "none" | "standing" {
  if (!map || !mapReady) return "none";
  if (plateau.active() && plateauWall.scopeId === id) {
    endPending("off");
    return "standing";
  }
  const unit = props.units.find((u) => u.id === id);
  const pill = mark.pill && !!unit && !unit.isLeaf;
  const g = unit && !unit.isLeaf ? (unit.geometry as MarkGeometry | undefined) : undefined;
  const drawn = !!g && (mark.stroke || mark.fill);
  if (drawn) plateauWall.setPending(id, g, mark);
  else plateauWall.clearPending();
  pins.setPendingPin(pill ? id : "");
  return drawn || pill ? "shown" : "none";
}
/**
 * The pending mark ends. "rise": its unit's plateau has just committed (call
 * it from `plateauSettled`): the mark moves onto the new lid and fades as it
 * rises — or goes at once under reduced motion. "off": at once (the
 * selection went elsewhere, or no plateau will come). The pill goes at once.
 */
function endPending(how: "rise" | "off") {
  pins.setPendingPin("");
  if (how === "rise") {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    plateauWall.commitPending(!still);
  } else plateauWall.clearPending();
}

/** What the map does once the camera has come to rest (gesture or flight). */
function onCameraSettled() {
  // Run the exact pass the mid-move throttle skipped.
  pins.scheduleSticky(true);
  // …and bring the plateau's lid texture up to the camera's resolution.
  lid.scheduleRefresh();
  mask.syncDrapedMask(); // a gesture can end on a zoom no `move` reported
  view.emitView();
}

let uninstallProbes: () => void = () => {};

/** The relief worker and the mesh worker, started once per mount, before the
 *  first selection needs them: with the map object (ac:boot-workers "early",
 *  the default) or in its `load` handler ("load", as before). */
let workersStarted = false;
function startWorkers() {
  if (workersStarted) return;
  workersStarted = true;
  void loadReliefClient().then(
    (c) => c.warmRelief(),
    () => {},
  );
  // ac:mesh=worker: the mesh worker started now (a fresh worker's first
  // build is its slowest). Only this guard reaches the client: "worker" is
  // the default (plateau/meshSwitch.ts), so every build emits its chunk and
  // the worker, a page on another mode never loads them.
  if (meshMode === "worker") {
    void import("./gl/meshClient").then(
      ({ warmMeshWorker, globeProviderOf }) => {
        if (!map) return; // unmounted meanwhile (or the map was declared unavailable)
        meshClient = warmMeshWorker();
        plateauWall.setGlobeProvider(globeProviderOf(meshClient));
      },
      () => {},
    );
  }
}

/** The map's creation waiting for the labels' font (labelFont.ts), cancelled
 *  by an unmount meanwhile. */
let cancelMount: () => void = () => {};
onMounted(() => {
  if (!TOKEN && import.meta.env.DEV) {
    console.warn("No map: set VITE_MAPBOX_TOKEN in apps/web/.env");
  }
  if (!el.value || unavailable.value) {
    emitReady(); // no map will ever load — release the boot overlay
    return;
  }
  // At once, unless the labels are drawn with the site's font and it is not
  // in yet (ac:glyphs, glyphSwitch.ts).
  cancelMount = whenLabelFont(mountMap);
});

function mountMap() {
  if (!el.value) return;
  try {
    mapboxgl.accessToken = TOKEN;
    resetPlateauStood(); // a new map: its first plateau is still to come
    map = new mapboxgl.Map({
      container: el.value,
      style: STYLE,
      center: toLngLat(FRANCE_CENTER),
      zoom: 4.5,
      // MSAA for the custom layers: mapbox's own layers anti-alias analytically
      // in-shader, but the plateau wall/lid/lines are raw geometry and alias
      // hard without it.
      antialias: true,
      // Its own resize watching off: ours (below) resizes, re-frames AND draws
      // at once. With both, mapbox's could clear the canvas after ours drew it.
      trackResize: false,
      // Ours instead, with the boundaries' credits (`attribution`, below).
      attributionControl: false,
      // Its « i », compact at every width (below): a French label.
      locale: { "AttributionControl.ToggleAttribution": "Afficher les crédits" },
      // No performance metrics sent to Mapbox: not needed for the map to work
      // (the privacy page lists what Mapbox still receives).
      performanceMetricsCollection: false,
      // The style's "globe" projection applies as-is: the plateau layer is
      // globe-native (dual mercator/ECEF programs morphed onto the sphere below
      // z6 via the experimental custom-layer API), so no projection juggling.
      // The plateau's `ac-dem://` DEM tiles answered in the page (relief/demHook.ts),
      // every other URL left alone. Typed as sync by mapbox's .d.ts, but awaited
      // at runtime (`params || {url}`): one cast.
      transformRequest: demTransformRequest as unknown as mapboxgl.MapOptions["transformRequest"],
      // The labels' letters: the style's files, or drawn on the device with
      // the site's font (ac:glyphs, labelFont.ts). The lid's map gets the same.
      ...labelGlyphOptions(),
    });
    // The two workers start with the map object (ac:boot-workers, default
    // "early"): neither touches the style, so neither waits for its load.
    if (workersStartAt(bootWorkers) === "mount") startWorkers();
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-left");
    attrib = newAttribution();
    map.addControl(attrib, creditCorner());
    // The still-map scheduler (lib/stillMap.ts) watches this map: its moves and
    // the pointers down on it. No job is scheduled by anything yet.
    stillMap.attach(map);
    uninstallProbes = installProbes({
      getMap,
      frames,
      plateau,
      lid,
      slabs,
      meshDigest: __TEST_TOOLS__ ? (o) => plateauWall.meshDigest(o) : null,
      pendingMark: () => plateauWall.pendingState(),
    });

    // The slabs' opaque lids take the site's card colour, and follow the theme.
    slabs.observeTheme();

    let initialLoadDone = false;
    map.once("load", () => {
      initialLoadDone = true;
      mapReady = true;
      // The layers, in their order, only now that the style has loaded.
      mask.setupLayers();
      mask.applyOutline();
      mask.applyMask();
      pins.buildMarkers();
      lid.warmup(); // hidden lid-snapshot map: pay style init now
      // ac:boot-workers=load: the two workers start only now.
      if (workersStartAt(bootWorkers) === "load") startWorkers();
      // Testing tools: a PMTiles archive named in the address, laid over the map.
      if (__TEST_TOOLS__) {
        const m = getMap();
        if (m) installPmtilesProbe(m);
      }
      if (props.camera) camera.runCamera({ ...props.camera, animate: false });
      view.emitView();
      // INTRO: wait for the first idle (basemap fully painted, capped at 4 s),
      // then tilt + raise in one gesture (useMapCamera.beginIntro). A user
      // interaction or an animated flight before that releases the intro on
      // its own.
      map?.once("idle", camera.beginIntro);
      window.setTimeout(camera.beginIntro, 4000);
    });
    map.on("error", (e) => {
      const status = (e.error as { status?: number } | undefined)?.status;
      if ((status === 401 || status === 403) && map && !initialLoadDone) {
        console.error(
          import.meta.env.DEV
            ? "Mapbox style request unauthorized — check VITE_MAPBOX_TOKEN"
            : "Mapbox style request unauthorized",
        );
        unavailable.value = true;
        emitReady(); // nothing more is coming — never strand a boot overlay
        pins.clear();
        stillMap.detach(map);
        map.remove();
        map = null;
      }
    });

    map.on("moveend", () => {
      // A flight cut short by the command replacing it has not landed anywhere:
      // the replacement settles when IT lands — or at once, in flyCamera, if it
      // was instant or did not move at all.
      if (camera.isIssuing()) return;
      // ORDER: what settles runs FIRST, while `userHolding` still says whose
      // move this was (the view emitted says `byUser`); the camera clears it
      // after, and pays a padding owed.
      onCameraSettled();
      camera.onMoveEnd();
    });
    // Pointers down on the map: a finger at rest is a gesture to come.
    camera.attachPointerTracking(map.getCanvasContainer());
    // Which pointer is on the map: only a mouse's mousemove hovers a unit.
    pins.attachPointerTracking(map.getCanvasContainer());
    // A restored WebGL context comes back empty, and mapbox does not run onAdd
    // again for custom layers: the tint sheet is set up again (useScopeMask).
    map.on("webglcontextrestored", () => mask.onContextRestored());
    // Hover (a mouse's) inside a unit's boundary reveals its (possibly
    // room-hidden) macro pin and shows a pointer; clicking inside the boundary
    // SELECTS the unit — the whole territory is the click target, the pin is
    // just its label.
    map.on("mousemove", (e) => pins.onHover(e.lngLat, e.point));
    map.on("mouseout", pins.onMouseOut);
    map.on("click", pins.onClick);
    // During FREE navigation, emit the view (throttled) while the gesture is still
    // going, so the scope — and the plateau transition — react mid-zoom instead of
    // waiting for moveend. Suppressed during programmatic flights (a drill must
    // not churn through the levels it flies over).
    let lastMoveEmit = 0;
    map.on("move", () => {
      pins.scheduleSticky(); // re-centre pins on their visible part (≤1×/frame)
      // Outside the programmaticCam guard on purpose — a flight crosses into the
      // globe just as readily as a drag, and the grey must change hands with it.
      mask.syncDrapedMask();
      if (camera.programmatic()) return;
      const now = performance.now();
      if (now - lastMoveEmit > 250) {
        lastMoveEmit = now;
        // Said again as the gesture goes on: the parent may have had a reason
        // to ignore its first moments.
        if (camera.userHolding()) emit("userGesture");
        view.emitView();
      }
    });
    // The frame bus (usePlateauFrames): fired at the end of every frame drawn.
    map.on("render", frames.emitFrame);

    // The container can be laid out late (grid/flex settling, fonts) — keep the
    // canvas synced and re-apply the last framing until the user takes the camera.
    map.on("dragstart", camera.markInteracted);
    map.on("zoomstart", camera.markInteracted);
    map.on("rotatestart", camera.markInteracted);
    map.on("pitchstart", camera.markInteracted);

    // "The user has started moving the map" (see the `userGesture` emit).
    map.on("movestart", (e) => {
      if (camera.onMoveStart(e)) emit("userGesture");
    });
    // Two starts that carry no DOM event: the box zoom (shift-drag), whose
    // flight has none, and the wheel zoom when mapbox starts it from its own
    // 40 ms timer. They only signal — neither is guaranteed a `moveend`.
    map.on("boxzoomstart", () => emit("userGesture"));
    map.on("wheel", (e) => {
      if (e.originalEvent.deltaY !== 0) emit("userGesture");
    });

    resizeObserver = new ResizeObserver((entries) => {
      if (!map) return;
      const box = entries[entries.length - 1]?.contentRect;
      if (box) frames.setContainerSize(box.width, box.height);
      map.resize();
      pins.onResize(); // the pills' sizes, measured anew
      camera.onResize(); // the last framing again, until the user takes the camera
      drawNow();
    });
    resizeObserver.observe(el.value);

    setTimeout(() => map?.resize(), 0);
    setTimeout(() => map?.resize(), 300);
  } catch (e) {
    console.error("Mapbox init failed:", e);
    unavailable.value = true;
    emitReady(); // nothing more is coming — never strand a boot overlay
    pins.clear();
    try {
      map?.remove();
    } catch {
      /* already broken */
    }
    map = null;
  }
}

/**
 * Draw now rather than at the next frame. A resized canvas is blank until it
 * is drawn again — and while it is resized every frame (the home page's card
 * growing into the page) each frame's resize cleared the last frame's drawing
 * before it was ever shown: the whole growth showed an empty box. Moving the
 * map to another place in the page (MapStage) can blank it the same way.
 * mapbox-gl has no public synchronous redraw: `_render` is what its own frame
 * loop calls.
 */
function drawNow() {
  if (!map || !mapReady) return;
  try {
    (map as unknown as { _render?: (now: number) => void })._render?.(performance.now());
  } catch {
    // Drawn at the next frame, as usual.
  }
}
const onMapMoved = () => drawNow();
window.addEventListener(MAP_MOVED_EVENT, onMapMoved);

// Teardown, in today's order: the window listener; the pins' pending frames;
// the camera's padding timer and pointer listeners; the plateau's and the
// slabs' animations and the theme observer; the plateau pipeline aborted; the
// lid's hidden map; the resize observer; the markers; the still-map scheduler
// let go of the map; the map itself; the flags; the frame bus; the probes.
onBeforeUnmount(() => {
  cancelMount();
  window.removeEventListener(MAP_MOVED_EVENT, onMapMoved);
  pins.dispose();
  camera.dispose();
  plateau.cancelAnimation();
  slabs.dispose();
  plateau.abort(); // abort any in-flight ensurePlateau
  // Its worker terminated, its pending meshes resolved null (and dropped).
  meshClient?.dispose();
  meshClient = null;
  plateauWall.setGlobeProvider(null);
  lid.destroy();
  resizeObserver?.disconnect();
  resizeObserver = null;
  pins.clear();
  plateauWall.clearPending();
  if (map) stillMap.detach(map);
  map?.remove();
  map = null;
  mapReady = false;
  camera.resetIntro();
  frames.dispose();
  uninstallProbes();
});

// ---- The watchers, in today's order (watchers run in the order they are made) ----
watch(
  () => props.units,
  () => pins.buildMarkers(),
  { deep: false },
);
watch(
  // scopePending is a source too: the outline can keep the SAME identity (e.g. the
  // shared EMPTY_FC in the micropin zone) across a pending→resolved transition, and
  // ensurePlateau's hold/teardown decision must re-run when that happens.
  () => [props.outline, props.scopePending] as const,
  () => {
    if (perfOn) {
      perfNote("outline.change", 0, {
        features: props.outline?.features.length ?? 0,
        pending: props.scopePending,
      });
    }
    mask.applyOutline();
    mask.applyMask(); // the hole is cut from props.outline — follow it immediately
    void plateau.ensurePlateau(); // selection changed → re-raise the new area
  },
);
watch(
  () => props.camera?.key,
  () => {
    if (props.camera) camera.runCamera(props.camera);
  },
);
// After the camera's watcher (watchers run in the order they are made): a
// command and the spec it frames for come in the same tick, and the slabs are
// sized for the fit that command has just started.
watch(
  () => JSON.stringify(props.slabs ?? null),
  () => slabs.syncSlabs(),
);

// Panel-driven hover. Goes through the SAME setHover the pointer uses, so a
// panel row lights the zone, lifts the pill and sweeps the plateau identically.
// The two never fight: moving the pointer off the canvas onto the panel fires
// the canvas `mouseout` (clearing the map's hover) BEFORE the row's mouseenter,
// and leaving the row clears before the next canvas mousemove takes over.
watch(
  () => props.hoveredId,
  (id) => pins.setHover(id ?? ""),
);
watch(() => props.activeId, pins.applyActivePin);

defineExpose({
  /** A finger or the mouse is on the map, or it is still gliding from one: a
   *  camera command now would cut that gesture short. */
  inUserHands: camera.inUserHands,
  /** Where the raised plateau stands on screen, once per frame drawn (see
   *  PlateauFrame); returns the unsubscribe. */
  onFrame: frames.onFrame,
  /** The analyses' ring: the part picked and the one hovered on the unit
   *  `scopeId`'s — the raised parts and the bar follow. */
  setRing: slabs.setRing,
  /** A tapped unit's pending mark, set and ended (see the functions). */
  markPending,
  endPending,
  /** A wheel turned over something laid on the map (the analyses' plates):
   *  mapbox listens on its canvas container only, so it is handed
   *  over there as the map's own — deltas, mode, position and modifier keys,
   *  all its scroll zoom reads. The page must not scroll instead. */
  forwardWheel: (e: WheelEvent) => {
    const el = map?.getCanvasContainer();
    if (!el) return;
    e.preventDefault();
    el.dispatchEvent(new WheelEvent("wheel", e));
  },
});

// The panel's width changes when an audition opens, which changes `padding`:
// the camera eases to it, or re-issues the command in flight (useMapCamera.
// onPaddingChange). `immediate`: the first run only seeds the key — the
// initial padding rides along with whatever camera command frames the map on
// load.
watch(
  () => props.padding,
  (pad) => camera.onPaddingChange(pad),
  { immediate: true },
);

// The logical view changed without the camera moving (the panel folded or
// unfolded): tell the parent what is in sight now. Never mid-flight — a flight
// reports where it lands.
watch(
  () => JSON.stringify(props.viewPadding ?? null),
  () => {
    void nextTick(() => {
      if (map && !camera.programmatic()) view.emitView();
    });
  },
);

// The credits or their corner changed (the outline files' session came in,
// or fell back, say; the window crossed the desktop line): a new control with
// the new text, in the new corner — mapbox has no setter and no "move".
// On the joined text, so a fresh array with the same strings does nothing.
// An expanded « i » closes again: a few times a session (the files' boot under
// the curtain, « Pays » once a country file is in, a fallback, a resize).
watch([() => props.attribution?.join("\n") ?? "", creditCorner], () => {
  const m = getMap();
  if (!m || !attrib) return;
  m.removeControl(attrib);
  attrib = newAttribution();
  m.addControl(attrib, creditCorner());
});
</script>

<template>
  <div v-if="unavailable && fallback.developerHint" class="map-root map-fallback">
    <p>
      Carte indisponible.<br />
      <span class="hint">Configurez <code>VITE_MAPBOX_TOKEN</code> dans apps/web/.env</span>
    </p>
  </div>
  <div v-else-if="unavailable" class="map-root map-fallback map-fallback--poster">
    <FrancePoster class="map-fallback-poster" />
    <p class="map-fallback-text">{{ MAP_FALLBACK_TEXT }}</p>
  </div>
  <div v-else ref="el" class="map-root"></div>
</template>

<style scoped>
.map-root {
  width: 100%;
  height: 100%;
  position: relative;
  z-index: 0;
}

.map-fallback {
  display: grid;
  place-items: center;
  text-align: center;
  color: hsl(var(--muted-foreground));
  padding: 1.5rem;
}

.map-fallback .hint {
  font-size: var(--text-caption);
}

/* France, muted, behind one sentence: it reads as a stand-in, not as the map. */
.map-fallback--poster {
  overflow: hidden;
  background: var(--gradient-surface);
  /* In the part of the box the panel leaves free (GeoNav's --panel-cover). */
  padding-right: calc(1.5rem + var(--panel-cover, 0px));
}

.map-fallback-poster {
  position: absolute;
  top: 8%;
  left: 8%;
  width: calc(84% - var(--panel-cover, 0px));
  height: 84%;
  opacity: 0.55;
}

.map-fallback-text {
  position: relative;
  max-width: 22rem;
  padding: 0.6rem 1rem;
  border-radius: 999px;
  background: hsl(var(--background) / 0.9);
  color: hsl(var(--foreground));
  font-size: var(--text-body);
  box-shadow: var(--shadow-lg);
}
</style>
