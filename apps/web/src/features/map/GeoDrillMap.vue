<script setup lang="ts">
// The map component: the one Mapbox instance GeoNav drives. A thin shell —
// props and emits, the map's creation, the wiring of the composables under
// features/map/composables and of the two GL layers, the lifecycle and the
// watchers in today's order. Everything that is a responsibility of its own
// lives in a composable, each taking `getMap` and explicit getters or
// callbacks, never this component; the hot per-frame state (the map, the GL
// layer, typed arrays, frame buffers) is plain `let`s owned by one module and
// never wrapped in ref/reactive.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import mapboxgl from "mapbox-gl";
import { FRANCE_CENTER } from "@ac/shared";
import { toLngLat } from "./lib/polygon";
import { PlateauWallLayer } from "./gl/PlateauWallLayer";
import { useMapView, type MapView } from "./composables/useMapView";
import { useScopeMask } from "./composables/useScopeMask";
import { usePlateauFrames } from "./composables/usePlateauFrames";
import { useSlabOcclusion } from "./composables/useSlabOcclusion";
import { usePlateauLid } from "./composables/usePlateauLid";
import { useMapCamera } from "./composables/useMapCamera";
import { useMapPins } from "./composables/useMapPins";
import { usePlateau } from "./composables/usePlateau";
import { usePlateauSlabs } from "./composables/usePlateauSlabs";
import { installProbes } from "./dev/probes";
import { installPmtilesProbe } from "./dev/pmtiles";
import type { CameraCmd, MapUnit, OutlineFC, SlabSpec } from "./types";
import { MAP_MOVED_EVENT } from "./events";

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
const unavailable = ref(!TOKEN);

// The map, a plain variable: the composables read it through `getMap`, never
// hold it. Null before mount and after unmount.
let map: mapboxgl.Map | null = null;
const getMap = () => map;
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

onMounted(() => {
  if (!el.value || !TOKEN) {
    emitReady(); // no map will ever load — release the boot overlay
    return;
  }
  try {
    mapboxgl.accessToken = TOKEN;
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
      // The style's "globe" projection applies as-is: the plateau layer is
      // globe-native (dual mercator/ECEF programs morphed onto the sphere below
      // z6 via the experimental custom-layer API), so no projection juggling.
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-left");
    uninstallProbes = installProbes({ getMap, frames, plateau, lid, slabs });

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
        console.error("Mapbox style request unauthorized — check VITE_MAPBOX_TOKEN");
        unavailable.value = true;
        emitReady(); // nothing more is coming — never strand a boot overlay
        pins.clear();
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
    // A restored WebGL context comes back empty, and mapbox does not run onAdd
    // again for custom layers: the tint sheet is set up again (useScopeMask).
    map.on("webglcontextrestored", () => mask.onContextRestored());
    // Hover inside a unit's boundary reveals its (possibly room-hidden) macro pin
    // and shows a pointer; clicking inside the boundary SELECTS the unit — the
    // whole territory is the click target, the pin is just its label.
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
});

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
// lid's hidden map; the resize observer; the markers; the map itself; the flags;
// the frame bus; the probes.
onBeforeUnmount(() => {
  window.removeEventListener(MAP_MOVED_EVENT, onMapMoved);
  pins.dispose();
  camera.dispose();
  plateau.cancelAnimation();
  slabs.dispose();
  plateau.abort(); // abort any in-flight ensurePlateau
  lid.destroy();
  resizeObserver?.disconnect();
  resizeObserver = null;
  pins.clear();
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
</script>

<template>
  <div v-if="unavailable" class="map-root map-fallback">
    <p>
      Carte indisponible.<br />
      <span class="hint">Configurez <code>VITE_MAPBOX_TOKEN</code> dans apps/web/.env</span>
    </p>
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
</style>
