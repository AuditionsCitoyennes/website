<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import mapboxgl from "mapbox-gl";
import { FRANCE_CENTER } from "@ac/shared";
import type { Bounds } from "@/features/geo";
import {
  FIT_PITCH_DEG,
  fitSilhouette,
  slabRects,
  solveSlabScales,
  type FitShape,
  type SlabCam,
  type SlabRect,
  type SlabScales,
} from "./lib";
import {
  boundsContain,
  boundsIntersect,
  boundsOfFeatures,
  buildHitRings,
  hitTest,
  interiorInView,
  plateauHeightM,
  pointInPolygon,
  polysOf,
  unionBounds,
  type HitRing,
  type InteriorHit,
} from "./lib/polygon";
import { fitHullOf } from "./lib/projection";
import { WALL_OVERSHOOT } from "./gl/mesh";
import { NO_RING, PlateauWallLayer, type SlabRingState } from "./gl/PlateauWallLayer";
import { useMapView, zoomForFill, type MapView } from "./composables/useMapView";
import { useScopeMask } from "./composables/useScopeMask";
import { usePlateauFrames } from "./composables/usePlateauFrames";
import { useSlabOcclusion } from "./composables/useSlabOcclusion";
import { usePlateauLid } from "./composables/usePlateauLid";
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

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

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

let map: mapboxgl.Map | null = null;
// True once the style's load event fired. The plateau pipeline MUST NOT mutate
// the style (addSource/addLayer/setTerrain) before then: pre-load mutations sit
// in the style's change-set and permanently wedge style.loaded() → the load
// event never fires → the wall/outline layers are never added. Reachable since
// the country became a plateau scope (its pipeline starts ~1 s into a fresh
// page, racing the style load); the load handler runs ensurePlateau itself.
let mapReady = false;
// Cold-load INTRO: the refresh shows the FINISHED flat basemap first (instant
// flat fit, wait for the first idle = tiles painted), THEN one animated tilt to
// ELEV_PITCH with the plateau rise landing in its tail. While pending, the
// plateau holds and instant fits stay flat; any real (animated) flight — e.g.
// the user drills before idle — releases the intro instead (fits tilt already).
let introPending = true;
// The map out of sight — a card further down the home page, loaded ahead of
// being reached: the halo's self-scheduled frames stop (as for a hidden tab,
// plateauWall.setPaused), and start again once it is back on screen.
let offscreen = false;
let visibilityObserver: IntersectionObserver | null = null;
// Whether a plateau is currently standing — the draped hover-fill fallback only
// applies when none is (world scope); otherwise the GL sweep owns the highlight.
let plateauActive = false;
// Markers are keyed by unit id and DIFFED across updates. The view is emitted
// ~4×/s while a gesture is in flight, and a pan usually changes only a handful
// of units at the edges — tearing every pin's DOM down and rebuilding it on each
// emit is what made panning crawl once the imported lieux landed.
interface MarkerEntry {
  marker: mapboxgl.Marker;
  el: HTMLElement;
  sig: string; // what makePin baked in — rebuild only when this changes
  lng: number;
  lat: number;
  // A pill's half size as laid out, read once needed (hidePinsUnderSlabs): 0
  // until then, while it can't be (not laid out) and after a resize — its
  // label's size follows the viewport's width (the type scale).
  halfW: number;
  halfH: number;
}
let markerById = new Map<string, MarkerEntry>();
// Hit rings cost a pass over every polygon ring, so cache them per unit and
// rebuild only when the geometry object itself changes.
const hitById = new Map<string, { geometry: unknown; hit: HitRing[] }>();
let sticky: {
  marker: mapboxgl.Marker;
  el: HTMLElement;
  lngLat: [number, number];
  bounds?: Bounds;
  geometry?: unknown;
  hit?: HitRing[];
  id: string;
  onScreen: boolean; // cached by updateSticky — hover toggles reuse it
}[] = [];
// The macro pin under the cursor's unit (hover reveals pins hidden for lack of
// room; clicking inside a unit's boundaries selects it). `pinHoveredId` tracks
// the cursor sitting on a pin ELEMENT — DOM-wise that's outside the canvas, so
// the map fires mouseout and would otherwise clear the hover and hide the pin
// under the cursor (a flicker loop).
let hoveredUnitId = "";
let pinHoveredId = "";
// The pin currently wearing `.geo-pin-active` (props.activeId, once applied).
let activePinId = "";
let resizeObserver: ResizeObserver | null = null;
let userInteracted = false;
let lastCmd: CameraCmd | null = null;
/** The padding `lastCmd` was framed against (see the padding watcher). */
let lastCmdPadKey = "";
// True while a programmatic camera animation (ease/fit/spotlight) is in flight —
// suppresses mid-flight scope derivation so a drill doesn't churn through the
// intermediate levels it flies over. Only `flyCamera` raises and lowers it.
let programmaticCam = false;
/** Id of the latest programmatic flight: a superseded one must not lower the flag. */
let flightSeq = 0;
/** Id of `lastCmd`'s own flight while it is in the air, else 0 (padding watcher). */
let cmdFlight = 0;
/** Inside a camera call — the `moveend` mapbox fires there ends the OLD flight. */
let issuingCam = false;
// The user is moving the camera (from a gesture's `movestart` to its `moveend`).
// EVERY camera call — easeTo, jumpTo, setPadding — begins by resetting mapbox's
// gesture handlers, i.e. it kills the drag or the pinch in progress. So a
// padding change that arrives meanwhile is owed, and paid when they let go.
let userHolding = false;
let padOwed = false;
let padTimer = 0;
/** Pointers currently down on the map: a finger at rest is a gesture to come. */
const pressed = new Set<number>();

const SPOTLIGHT_ZOOM = 15.3;
const SPOTLIGHT_PITCH = 50;
/** An arc flight (see runCamera) pulls back until the hop is this many views long… */
const ARC_SCREENS = 3;
/** …and by this much of a zoom level at least. */
const ARC_MIN_DIP = 0.5;

function toLngLat([lat, lng]: [number, number]): [number, number] {
  return [lng, lat];
}

function toLngLatBounds(b: Bounds): [[number, number], [number, number]] {
  return [
    [b.minLng, b.minLat],
    [b.maxLng, b.maxLat],
  ];
}

function makePin(unit: MapUnit): HTMLElement {
  const root = document.createElement("button");
  root.type = "button";
  root.addEventListener("click", (e) => {
    e.stopPropagation();
    emit("unitClick", unit.id);
  });
  // A double-click on a pin is the same selection twice — not the map's
  // double-click zoom, which would also count as the user taking the camera.
  root.addEventListener("dblclick", (e) => e.stopPropagation());

  // Lieu (leaf): the original flat ground dot (.marker-dot "point au sol"), no label.
  if (unit.isLeaf) {
    root.className = "geo-pin geo-pin-leaf";
    return root;
  }

  // Aggregated unit: a uniform outlined pill with just the name (no count).
  root.className = "geo-pin";
  const bubble = document.createElement("span");
  bubble.className = "geo-pin-bubble";
  const lab = document.createElement("span");
  lab.className = "geo-pin-name";
  lab.textContent = unit.label;
  bubble.appendChild(lab);
  root.appendChild(bubble);
  return root;
}

function clearMarkers() {
  for (const e of markerById.values()) e.marker.remove();
  markerById.clear();
  hitById.clear();
  wholeShapeInterior.clear();
  sticky = [];
}

/** What makePin renders — a pin is reusable as long as this is unchanged. */
function pinSignature(unit: MapUnit): string {
  return unit.isLeaf ? "leaf" : `pill:${unit.label}`;
}

/** Hit rings for a macro unit, reusing the cached pass when geometry is same. */
function hitRingsFor(unit: MapUnit): HitRing[] | undefined {
  if (!unit.geometry) return undefined;
  const cached = hitById.get(unit.id);
  if (cached && cached.geometry === unit.geometry) return cached.hit;
  const hit = buildHitRings(unit.geometry);
  hitById.set(unit.id, { geometry: unit.geometry, hit });
  return hit;
}

function buildMarkers() {
  if (!map) return;
  // Anything still in `stale` once we've walked the new units has left the view.
  const stale = markerById;
  const next = new Map<string, MarkerEntry>();
  const wasOnScreen = new Map(sticky.map((s) => [s.id, s.onScreen]));
  const nextSticky: typeof sticky = [];

  for (const unit of props.units) {
    const [lng, lat] = toLngLat(unit.center);
    const sig = pinSignature(unit);
    let entry = stale.get(unit.id);

    if (entry && entry.sig === sig) {
      // Survivor: keep its DOM node and listeners, just move it if it shifted.
      stale.delete(unit.id);
      if (entry.lng !== lng || entry.lat !== lat) {
        entry.marker.setLngLat([lng, lat]);
        entry.lng = lng;
        entry.lat = lat;
      }
    } else {
      if (entry) {
        entry.marker.remove();
        stale.delete(unit.id);
      }
      // Lieu dots lie flat on the ground (tilt with the map), centred on the
      // point; aggregated pills stay billboard (face the camera) like UI chips.
      const el = makePin(unit);
      const opts: mapboxgl.MarkerOptions = unit.isLeaf
        ? { element: el, pitchAlignment: "map", rotationAlignment: "map" }
        : { element: el };
      const marker = new mapboxgl.Marker(opts).setLngLat([lng, lat]).addTo(map);
      entry = { marker, el, sig, lng, lat, halfW: 0, halfH: 0 };
      if (!unit.isLeaf) {
        // The pin element sits ABOVE the canvas: hovering it fires the canvas
        // mouseout, which must not clear the hover that revealed this very pin.
        el.addEventListener("mouseenter", () => {
          pinHoveredId = unit.id;
          setHover(unit.id);
        });
        el.addEventListener("mouseleave", (e) => {
          pinHoveredId = "";
          // Back onto the map → the next mousemove takes over seamlessly; out of
          // the map entirely → clear now.
          const to = (e as MouseEvent).relatedTarget as Node | null;
          if (!map || !to || !map.getContainer().contains(to)) setHover("");
        });
      }
    }

    next.set(unit.id, entry);
    // Macro pins (pills) follow their unit's visible territory; they show only
    // when their boundary has clear room for the pill (or on hover — see
    // updateSticky), and clicking anywhere inside the boundary selects the unit.
    if (!unit.isLeaf) {
      nextSticky.push({
        marker: entry.marker,
        el: entry.el,
        lngLat: [lng, lat],
        bounds: unit.bounds,
        geometry: unit.geometry,
        hit: hitRingsFor(unit),
        id: unit.id,
        // Keep the cached visibility so a surviving pill doesn't flicker.
        onScreen: wasOnScreen.get(unit.id) ?? false,
      });
    }
  }

  for (const e of stale.values()) e.marker.remove();
  for (const id of hitById.keys()) if (!next.has(id)) hitById.delete(id);
  for (const id of wholeShapeInterior.keys()) if (!next.has(id)) wholeShapeInterior.delete(id);
  markerById = next;
  sticky = nextSticky;
  updateSticky();
  applyActivePin(); // a rebuilt pin is a fresh element — re-mark it
}

/** Move `.geo-pin-active` (the pulsing halo, styled in features/map/geo-pins.css) onto the pin
 *  of the lieu being read. */
function applyActivePin() {
  const id = props.activeId ?? "";
  if (id !== activePinId) markerById.get(activePinId)?.el.classList.remove("geo-pin-active");
  activePinId = id;
  if (id) markerById.get(id)?.el.classList.add("geo-pin-active");
}

const STICKY_MARGIN = 28; // keep pins this far inside the visible edge

// Re-centre each macro pin on the centre of its unit's VISIBLE part, so the pin
// follows the on-screen territory as you pan. A pin shows only when its unit's
// visible interior has clear ROOM for the pill (so labels never sprawl over
// neighbours), or while the cursor hovers inside the unit's boundary — clicking
// inside the boundary selects the unit, pin or no pin. Throttled to one run per
// animation frame (move can fire several times a frame) to stay smooth.
// When a unit is entirely inside the view, clamping does nothing, so its
// interior point is a property of the SHAPE alone — constant while it stays
// fully visible. Cache it per unit instead of re-scanning every polygon vertex.
const wholeShapeInterior = new Map<string, { geometry: unknown; hit: InteriorHit }>();

function interiorWhenFullyVisible(s: (typeof sticky)[number]): InteriorHit | null {
  const cached = wholeShapeInterior.get(s.id);
  if (cached && cached.geometry === s.geometry) return cached.hit;
  const hit = interiorInView(s.geometry, s.bounds!, s.bounds!);
  if (hit) wholeShapeInterior.set(s.id, { geometry: s.geometry, hit });
  return hit;
}

function updateSticky() {
  if (!map) return;
  const view = sticky.length ? screenBoundsInset(STICKY_MARGIN) : null;
  if (view) {
    for (const s of sticky) {
      let hit: InteriorHit | null = null;
      // applyPinVisibility only ever shows the HOVERED pill, so recomputing an
      // interior point (a scanline pass over the unit's polygon) + setLngLat for
      // every other sticky entry moved markers nobody can see — pure cost on every
      // sticky pass, growing with the number of units on screen.
      const couldBeVisible = s.id === hoveredUnitId;
      if (couldBeVisible && s.geometry && s.bounds && boundsIntersect(s.bounds, view)) {
        const b = s.bounds;
        const fullyVisible =
          b.minLat >= view.minLat &&
          b.maxLat <= view.maxLat &&
          b.minLng >= view.minLng &&
          b.maxLng <= view.maxLng;
        hit = fullyVisible ? interiorWhenFullyVisible(s) : interiorInView(s.geometry, b, view);
      }
      s.onScreen = !!hit;
      applyPinVisibility(s);
      if (hit) s.marker.setLngLat(hit.pt);
    }
  }
  // The lieu dots too, which no sticky entry holds.
  hidePinsUnderSlabs();
}

// Visibility from CACHED state — hover enter/leave calls this for the two
// affected pins only. Macro pins are HOVER-ONLY: the territory is the visible
// UI (boundaries + highlight), the pill appears as its label while pointed at.
function applyPinVisibility(s: (typeof sticky)[number]) {
  s.el.style.visibility =
    s.onScreen && hoveredUnitId === s.id && !pinsUnderSlab.has(s.id) ? "" : "hidden";
}

// ---- Pins under the analyses' slabs -------------------------------------------
// A pin is HTML over the canvas: one drawn on a slab's piece (see
// slabsOnScreen) would show over it, and a click on it would pick its unit
// through the piece — nothing is picked there (unitAt). Such a pin is hidden
// (`visibility`, which the pointer passes through too; mapbox writes its fade
// into `opacity` and `pointer-events`), each time the pins or the slabs
// change: every sticky pass, a hover, the slabs built or gone.
let pinsUnderSlab = new Set<string>();
/** How far above its point a hovered pill is drawn: geo-pins.css,
 *  `.geo-pin-hover .geo-pin-bubble { transform: translateY(-32px) }` — keep
 *  the two in step. */
const PILL_LIFT_PX = 32;
/** A lieu dot's radius: geo-pins.css, `.geo-pin-leaf` (16 px, border-box). */
const DOT_RADIUS_PX = 8;
/** Around a pin's centre, the points looked at too (× its half-size): a
 *  pill's corners, a dot's rim across and along. */
const PILL_CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;
const DOT_RIM = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/** Whether a pin drawn around (x, y) is on a piece slabsOnScreen found: its
 *  centre, or any of `pts` (× `hw`, `hh`) off it. */
function pinOnSlab(
  x: number,
  y: number,
  hw: number,
  hh: number,
  pts: typeof PILL_CORNERS | typeof DOT_RIM,
): boolean {
  if (onSlab(x, y)) return true;
  for (const [u, v] of pts) if (onSlab(x + u * hw, y + v * hh)) return true;
  return false;
}

/** Hide the pins drawn on a slab now, and show again those no longer there.
 *  Their points are where mapbox places them (map.project). A pill shows only
 *  while hovered (applyPinVisibility): only that one is looked at, its boxes
 *  as drawn — the bubble's, lifted, and the marker's own at its point. The
 *  dots may be many: only those standing where a slab can be drawn over them
 *  (slabDotBoxes) are projected at all. */
function hidePinsUnderSlabs() {
  if (!map) return;
  const was = pinsUnderSlab;
  const now = new Set<string>();
  if (slabsOnScreen()) {
    const boxes = slabDotBoxes(DOT_RADIUS_PX);
    for (const [id, e] of markerById) {
      const dot = e.sig === "leaf";
      if (dot ? !mayBeUnderSlab(boxes, e.lng, e.lat) : id !== hoveredUnitId) continue;
      const p = map.project(e.marker.getLngLat());
      let on: boolean;
      if (dot) on = pinOnSlab(p.x, p.y, DOT_RADIUS_PX, DOT_RADIUS_PX, DOT_RIM);
      else {
        e.halfW ||= e.el.offsetWidth / 2;
        e.halfH ||= e.el.offsetHeight / 2;
        // The marker's own box is transparent, but takes the pointer too.
        on =
          pinOnSlab(p.x, p.y - PILL_LIFT_PX, e.halfW, e.halfH, PILL_CORNERS) ||
          pinOnSlab(p.x, p.y, e.halfW, e.halfH, PILL_CORNERS);
      }
      if (on) now.add(id);
    }
  }
  if (!now.size && !was.size) return;
  pinsUnderSlab = now;
  // Every pin either side, not only the changed ones: a pin rebuilt since
  // (buildMarkers) is a fresh element, shown.
  for (const id of was) applyPinCover(id);
  for (const id of now) if (!was.has(id)) applyPinCover(id);
}

function applyPinCover(id: string) {
  const e = markerById.get(id);
  if (!e) return;
  if (e.sig === "leaf") {
    e.el.style.visibility = pinsUnderSlab.has(id) ? "hidden" : "";
    return;
  }
  const s = sticky.find((x) => x.id === id);
  if (s) applyPinVisibility(s);
}

/** The macro unit whose boundary contains [lng, lat] (bbox pre-filter, then flat
 *  precompiled-ring containment) — the hover/click target. Nothing on a
 *  piece of the analyses' slabs, its screen point `at` on one as drawn (see
 *  slabsOnScreen): it is not a unit, and what lies under it is hidden. */
function unitAt(lng: number, lat: number, at?: { x: number; y: number }): string {
  if (at && slabsOnScreen() && onSlab(at.x, at.y)) return "";
  for (const s of sticky) {
    if (!s.hit || !s.bounds) continue;
    const b = s.bounds;
    if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) continue;
    if (hitTest(s.hit, lng, lat)) return s.id;
  }
  return "";
}

// Central hover switch: updates the cursor, lifts the hovered pin, highlights
// the zone (GL fill on the plateau + draped fill on the ground), and toggles
// only the two affected pins from cached room/visibility state.
function setHover(id: string) {
  if (id === hoveredUnitId) return;
  const prev = hoveredUnitId;
  hoveredUnitId = id;
  // The newly hovered pill is the only one that will be shown, and updateSticky
  // now positions only the hovered entry — so place this one right away instead
  // of waiting for the next sticky pass (which would show it at a stale point).
  if (id) {
    const s = sticky.find((x) => x.id === id);
    const view = screenBoundsInset(STICKY_MARGIN);
    if (s?.geometry && s.bounds && view && boundsIntersect(s.bounds, view)) {
      const hit = interiorInView(s.geometry, s.bounds, view);
      s.onScreen = !!hit;
      if (hit) s.marker.setLngLat(hit.pt);
    }
    // …and not over a slab (a row of the panel hovered: its pill may land there).
    hidePinsUnderSlabs();
  }
  if (map) map.getCanvas().style.cursor = id ? "pointer" : "";
  for (const s of sticky) {
    if (s.id === prev || s.id === id) {
      s.el.classList.toggle("geo-pin-hover", s.id === id);
      applyPinVisibility(s);
    }
  }
  plateauWall.setHovered(id);
  // Draped fallback only when no plateau is up (world scope) — with a plateau,
  // the GL sweep covers focus AND context, and doubling would break the sweep.
  if (map?.getLayer("scope-hover-fill")) {
    const drapedId = plateauActive ? "__none__" : id || "__none__";
    map.setFilter("scope-hover-fill", [
      "all",
      ["!=", ["get", "kind"], "scope"],
      ["==", ["get", "id"], drapedId],
    ]);
  }
}

let hoverRaf = 0;
let lastHoverPt: { x: number; y: number } | null = null;
let pendingHoverLngLat: { lng: number; lat: number } | null = null;
let pendingHoverPt: { x: number; y: number } | undefined;
function onMapHover(lngLat: { lng: number; lat: number }, point?: { x: number; y: number }) {
  // Mousemove floods; only re-test once the cursor actually travelled a few px.
  if (point && lastHoverPt) {
    const dx = point.x - lastHoverPt.x;
    const dy = point.y - lastHoverPt.y;
    if (dx * dx + dy * dy < 9) return;
  }
  if (point) lastHoverPt = point;
  // Always keep the LATEST position for the pending frame — a mouseout landing
  // while a mousemove's rAF is queued must not be swallowed by stale coords.
  pendingHoverLngLat = lngLat;
  pendingHoverPt = point;
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    // A panel row grabbed the hover while this frame was pending. Moving the
    // pointer off the canvas ONTO the panel fires the canvas mouseout, which
    // queues a clear here, and the row's mouseenter then runs synchronously
    // before this frame — so without this the panel's highlight would appear
    // and be wiped one frame later. While the panel owns the hover, the
    // pointer-derived one stands down.
    if (props.hoveredId) return;
    const ll = pendingHoverLngLat;
    if (ll) setHover(unitAt(ll.lng, ll.lat, pendingHoverPt));
  });
}

let stickyRaf = 0;
let lastStickyAt = 0;
// A pill nudging along its shape does not need 60 Hz — recomputing every macro
// pin's interior point per frame meant ~15 scanlines × every polygon vertex ×
// every visible pin, every frame. ~14 Hz is visually identical while doing a
// quarter of the work; `moveend` always runs a final exact pass.
const STICKY_MIN_MS = 70;

function scheduleSticky(force = false) {
  if (stickyRaf) return;
  stickyRaf = requestAnimationFrame(() => {
    stickyRaf = 0;
    const now = performance.now();
    if (!force && now - lastStickyAt < STICKY_MIN_MS) return;
    lastStickyAt = now;
    updateSticky();
  });
}

/** What the map does once the camera has come to rest (gesture or flight). */
function onCameraSettled() {
  // Run the exact pass the mid-move throttle skipped.
  scheduleSticky(true);
  // …and bring the plateau's lid texture up to the camera's resolution.
  lid.scheduleRefresh();
  syncDrapedMask(); // a gesture can end on a zoom no `move` reported
  emitView();
}

/**
 * Issue a programmatic camera move, keeping `programmaticCam` true for exactly
 * as long as it flies.
 *
 * Starting a move ENDS any flight already in the air, and mapbox reports that
 * with a `moveend` fired synchronously from inside the call. That event is not a
 * landing. Treating it as one did two things at once: it cleared the flag for
 * the flight just being started (the listener was registered before the call),
 * and it emitted the half-way view. The parent then saw an un-pinned view from
 * mid-flight — on a phone, where opening a lieu changes the padding and so
 * re-issued the spotlight, that read as "zoomed out past the lieu" and closed
 * the place 30 ms after it opened. Hence: nothing settles while a command is
 * being issued, the flag is raised AFTER the call, and each flight only ever
 * lowers its own.
 *
 * `isCommand` marks the flight as `lastCmd`'s own (see `cmdFlight`).
 */
function flyCamera(move: (m: mapboxgl.Map) => void, isCommand = false) {
  const m = map;
  if (!m) return;
  let issued = false;
  issuingCam = true;
  try {
    move(m);
    issued = true;
  } catch (e) {
    // A camera move that fails stays the map's problem: thrown on, it would
    // abort the page's whole update (the panel, the filters, everything).
    console.error("Map camera move failed:", e);
  } finally {
    issuingCam = false;
    // Mapbox ends the old flight BEFORE it validates the new target, so a throw
    // (a bad centre) leaves the camera stopped with its `moveend` swallowed.
    if (!issued) {
      programmaticCam = false;
      cmdFlight = 0;
      onCameraSettled();
    }
  }
  const id = ++flightSeq;
  if (!m.isEasing()) {
    // Instant (animate: false, or the reader prefers reduced motion) or no move
    // at all: the camera is already at rest, its own `moveend` swallowed above.
    programmaticCam = false;
    cmdFlight = 0;
    onCameraSettled();
    return;
  }
  programmaticCam = true;
  cmdFlight = isCommand ? id : 0;
  m.once("moveend", () => {
    if (id === flightSeq) programmaticCam = false;
    if (id === cmdFlight) cmdFlight = 0;
  });
}

/**
 * `cameraForBounds`, blind to the terrain. Past the globe, mapbox frames the
 * box lifted to the terrain's height at the bounds' corners — and our terrain
 * is the plateau, raised over whatever was the scope when the command came:
 * Lyon 9e framed while Lyon stood raised landed a whole zoom level wider than
 * framed from Paris, too loose to become the scope. On flat ground every unit
 * is framed the same way, wherever the camera comes from.
 */
function flatCamera(
  bounds: mapboxgl.LngLatBoundsLike,
  options: Parameters<mapboxgl.Map["cameraForBounds"]>[1],
): ReturnType<mapboxgl.Map["cameraForBounds"]> {
  const m = map!;
  const own = m as unknown as { queryTerrainElevation?: () => number };
  own.queryTerrainElevation = () => 0;
  try {
    return m.cameraForBounds(bounds, options);
  } finally {
    delete own.queryTerrainElevation; // the map's own method again
  }
}

/**
 * `aimOffset` as camera options: `{ offset }`, or nothing at all — mapbox
 * fills in its default offset and then copies every key it is given over it,
 * so an `offset: undefined` replaces the default and crashes the move.
 */
function aimed(padding: NonNullable<typeof props.padding>): { offset?: [number, number] } {
  const offset = aimOffset(padding);
  return offset ? { offset } : {};
}

/**
 * Where a command's target is aimed when the rectangle in sight is not the
 * camera's own (`viewPadding`: the panel opened wide over the map, or folded
 * aside while the user is on it). The camera keeps its padding — the globe
 * stays where it is on screen — and the target is aimed at that rectangle's
 * centre with an offset: the map turns under it, the globe does not slide.
 */
function aimOffset(padding: NonNullable<typeof props.padding>): [number, number] | undefined {
  const view = props.viewPadding;
  if (!view) return undefined;
  const p =
    typeof padding === "number"
      ? { top: padding, bottom: padding, left: padding, right: padding }
      : padding;
  return [
    (view.left - view.right - (p.left - p.right)) / 2,
    (view.top - view.bottom - (p.top - p.bottom)) / 2,
  ];
}

/** A box's edges, [lng, lat] pair after pair, BOX_EDGE_STEPS points each
 *  (the globe bends them): what a fit frames when it has no outline. */
const BOX_EDGE_STEPS = 16;
function boxRim(b: Bounds): Float64Array {
  const corners = [
    [b.minLng, b.maxLat],
    [b.maxLng, b.maxLat],
    [b.maxLng, b.minLat],
    [b.minLng, b.minLat],
  ];
  const out = new Float64Array(8 * BOX_EDGE_STEPS);
  let k = 0;
  for (let c = 0; c < 4; c++) {
    const [x0, y0] = corners[c];
    const [x1, y1] = corners[(c + 1) % 4];
    for (let i = 0; i < BOX_EDGE_STEPS; i++) {
      out[k++] = x0 + ((x1 - x0) * i) / BOX_EDGE_STEPS;
      out[k++] = y0 + ((y1 - y0) * i) / BOX_EDGE_STEPS;
    }
  }
  return out;
}

/**
 * The camera a fit lands on: the unit's silhouette — its whole outline
 * (`cmd.shape`), islets included: each outer ring's hull (fitHullOf), at the
 * ground and at its lid's height, seen from the camera resting on its
 * plateau — centred in the rectangle in sight (`viewPadding`, else the
 * camera's own), `cmd.fill` of it on the axis that limits it (as large as
 * fits without), up to `maxZoom` and `cmd.fillCap`, the view's centre where
 * the scope is the unit (map/lib/slabs' fitSilhouette). With no outline,
 * the box `cmd.bounds`, on the ground. The camera keeps its padding and aims
 * at that rectangle's centre (see aimOffset): `ox`, `oy` are that aim.
 * Started from mapbox's own fit on flat ground (see flatCamera). Null: no
 * camera to be had.
 */
function fitCamera(
  m: mapboxgl.Map,
  cmd: CameraCmd,
  padding: NonNullable<typeof props.padding>,
  pitch: number,
  maxZoom: number,
): SlabCam | null {
  if (!cmd.bounds) return null;
  const view = props.viewPadding;
  const pad =
    typeof padding === "number"
      ? { top: padding, bottom: padding, left: padding, right: padding }
      : padding;
  const ins = view ?? pad;
  const w = m.getContainer().clientWidth;
  const h = m.getContainer().clientHeight;
  // No closer than where the unit's children would fill too much of the view.
  const midLat = (cmd.bounds.minLat + cmd.bounds.maxLat) / 2;
  const cap = cmd.fillCap ? zoomForFill(cmd.fillCap, ins, w, h, pitch, midLat) : Infinity;
  if (cap < maxZoom) maxZoom = cap;
  const seed = flatCamera(toLngLatBounds(cmd.bounds), {
    padding: view ?? padding,
    maxZoom,
    pitch,
  });
  if (seed?.zoom === undefined || seed.center === undefined) return null;
  const c = mapboxgl.LngLat.convert(seed.center);
  // The rectangle, from the padded centre (where mapbox puts the target
  // without an offset).
  const pcx = (pad.left + w - pad.right) / 2;
  const pcy = (pad.top + h - pad.bottom) / 2;
  const rect = {
    left: ins.left - pcx,
    top: ins.top - pcy,
    right: w - ins.right - pcx,
    bottom: h - ins.bottom - pcy,
  };
  let shape: FitShape = {
    pts: boxRim(cmd.bounds),
    liftM: 0,
    restM: 0,
    holds: null,
    lands: null,
  };
  const g = cmd.shape?.geometry as { type?: string; coordinates?: unknown } | undefined;
  if (cmd.shape && g?.type) {
    const features = [{ type: "Feature" as const, geometry: g, properties: {} }];
    const pts = fitHullOf(g);
    if (pts.length) {
      const polys = polysOf(g);
      const heightM = plateauHeightM(cmd.shape.id, features);
      const holds = (lng: number, lat: number) => pointInPolygon(lng, lat, polys);
      shape = {
        pts,
        liftM: heightM * WALL_OVERSHOOT,
        restM: heightM,
        holds,
        lands: cmd.shape.lands ?? holds,
      };
    }
  }
  return fitSilhouette({
    shape,
    seed: { lng: c.lng, lat: c.lat, zoom: seed.zoom },
    rect,
    fill: cmd.fill,
    pitch,
    w,
    h,
    globe: isGlobeStyle(),
    maxZoom,
  });
}

function runCamera(cmd: CameraCmd) {
  if (!map) return;
  if (cmd.fresh) {
    map.resize();
    userInteracted = false;
  }
  lastCmd = cmd;
  // Only a fit frames a unit for its slabs (see fitCam).
  if (cmd.type !== "fit") fitCam = null;
  const padding = props.padding ?? 50;
  padOwed = false; // every command frames against the padding of the moment
  lastCmdPadKey = JSON.stringify(props.padding ?? null);
  const duration = cmd.animate === false ? 0 : 550;
  if (cmd.type === "spotlight") {
    const center = toLngLat(cmd.center);
    if (cmd.arc && duration > 0) {
      const to = new mapboxgl.LngLat(center[0], center[1]);
      const meters = map.getCenter().distanceTo(to);
      // The further the hop, the longer the flight — but never a long wait.
      const arcMs = Math.min(3000, 900 + 320 * Math.log2(1 + meters / 1000));
      // How far it pulls back on the way: a little. Not to where both ends are
      // in sight — that is the whole city for two lieux a few streets apart —
      // but to the zoom at which the hop is ARC_SCREENS views long: the map is
      // seen travelling, without leaving the neighbourhood for the sky. And by
      // ARC_MIN_DIP of a level at least — mapbox's own curve barely lifts off
      // for a lieu a street away.
      const insets = typeof padding === "number" ? { left: padding, right: padding } : padding;
      const width = Math.max(200, map.getContainer().clientWidth - insets.left - insets.right);
      const metersPerPx0 = 78271.517 * Math.cos((to.lat * Math.PI) / 180); // at zoom 0
      const hopZoom = Math.log2((metersPerPx0 * ARC_SCREENS * width) / Math.max(meters, 1));
      flyCamera(
        (m) =>
          m.flyTo({
            center,
            zoom: SPOTLIGHT_ZOOM,
            pitch: SPOTLIGHT_PITCH,
            padding,
            ...aimed(padding),
            duration: arcMs,
            // (mapbox never lets this exceed the zoom the flight starts from)
            minZoom: Math.min(hopZoom, SPOTLIGHT_ZOOM - ARC_MIN_DIP),
          }),
        true,
      );
      return;
    }
    flyCamera(
      (m) =>
        m.easeTo({
          center,
          zoom: SPOTLIGHT_ZOOM,
          pitch: SPOTLIGHT_PITCH,
          padding,
          ...aimed(padding),
          duration,
        }),
      true,
    );
    return;
  }
  // A real animated flight preempts the load intro: the fit tilts the camera
  // itself, so release the plateau hold and let the outline-driven pipeline run.
  if (introPending && duration > 0) {
    introPending = false;
    void ensurePlateau();
  }
  // fit: frame the whole unit so its boundary stays on screen; the viewport-derived
  // scope then resolves to this unit. Tilt so the raised plateau reads. maxZoom
  // guards degenerate (point) bounds. During the intro, instant fits stay FLAT —
  // the tilt is the intro's animated step.
  if (cmd.type === "fit" && cmd.bounds) {
    const bounds = toLngLatBounds(cmd.bounds);
    const pitch = introPending && duration === 0 ? 0 : ELEV_PITCH;
    const maxZoom = cmd.maxZoom ?? 14;
    // The unit has to land in the rectangle that is in sight NOW
    // (`viewPadding`) — the one the scope is read from — while the camera
    // keeps its padding (see aimOffset): its silhouette centred there and as
    // large as fits (fitCamera) — inside the move, so a throw there takes
    // the failed-move path like any other.
    flyCamera((m) => {
      const cam = fitCamera(m, cmd, padding, pitch, maxZoom);
      if (cam) {
        // The camera this fit lands on: the analyses' slabs of the unit it
        // frames are sized for it, whenever they are built (mid-flight).
        fitCam = { key: cmd.key, seq: ++fitCamSeq, ...cam };
        m.flyTo({
          center: [cam.lng, cam.lat],
          zoom: cam.zoom,
          bearing: 0,
          pitch,
          padding,
          ...aimed(padding),
          duration,
        });
      } else {
        fitCam = null;
        // mapbox's fit frames the box edge to edge in the padded rectangle:
        // that rectangle brought in by (1 − fill), about its centre, frames
        // it at `fill` like the silhouette's. Only the camera is asked for in
        // it: the flight keeps the real padding (fitBounds would hand the
        // enlarged one on to the map, owed back by an ease after landing).
        const p =
          typeof padding === "number"
            ? { top: padding, bottom: padding, left: padding, right: padding }
            : padding;
        const k = (1 - (cmd.fill ?? 1)) / 2;
        const dx = k * Math.max(0, m.getContainer().clientWidth - p.left - p.right);
        const dy = k * Math.max(0, m.getContainer().clientHeight - p.top - p.bottom);
        const inset = {
          top: p.top + dy,
          bottom: p.bottom + dy,
          left: p.left + dx,
          right: p.right + dx,
        };
        const c = m.cameraForBounds(bounds, { padding: inset, maxZoom, pitch });
        if (c) m.flyTo({ ...c, pitch, padding, duration });
        else m.fitBounds(bounds, { padding, maxZoom, pitch, duration });
      }
    }, true);
    // The same fit run again (a resize, a new padding: same key) lands on
    // another camera, and no new spec comes to say so: its unit's slabs are
    // sized for it now, not at some later re-sync under a still camera. (A
    // new unit's spec is not there yet: nothing changes then.)
    syncSlabs();
    return;
  }
  // ease: centre on the unit at the level's canonical zoom (drives scope derivation).
  flyCamera(
    (m) =>
      m.easeTo({
        center: toLngLat(cmd.center),
        zoom: cmd.zoom ?? m.getZoom(),
        pitch: 0,
        padding,
        ...aimed(padding),
        duration,
      }),
    true,
  );
}

// Boundary outline of the current scope's children (added once the style loads).
// ---- Plateau elevation: raise the SELECTED area's real map as a flat-topped
// plateau (custom DEM served by the API). The camera tilts so the relief reads. ----
const ELEV_PITCH = FIT_PITCH_DEG; // 45: the slabs' words are sized for it
const RISE_MS = 300; // plateau rise animation
const SINK_MS = 150; // plateau sink (before swapping to a new selection)
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
  map?.setTerrain({
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
      if (map?.getSource(terrainSrc)) setTerrainRaw(terrainSrc, v);
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
      if (!map) return finish();
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

const plateauWall = new PlateauWallLayer();
const getMap = () => map;

// ---- The composables (features/map/composables), in dependency order ------------
// None of them registers a Vue watcher, so the order only says who reads whom:
// the view; the grey (which installs the layers); the frame bus; what the slabs
// hide (reads the frame bus); the lid. Each takes `getMap` and explicit getters
// or callbacks, never the component. The flags they read across
// responsibilities (`plateauActive`, `plateauSeq`, `userHolding`, `lidExtra`)
// stay plain `let`s of their owner here, handed over as getters.
const view = useMapView({
  getMap,
  padding: () => props.padding,
  viewPadding: () => props.viewPadding,
  userHolding: () => userHolding,
  onView: (v) => emit("viewChange", v),
});
const { screenBoundsInset, emitView } = view;
const mask = useScopeMask({
  getMap,
  wall: plateauWall,
  outline: () => props.outline,
  scopePending: () => props.scopePending,
  plateauActive: () => plateauActive,
});
const { setupLayers, applyOutline, applyMask, syncDrapedMask, isGlobeStyle } = mask;
const frames = usePlateauFrames({ getMap, wall: plateauWall });
const { slabsOnScreen, onSlab, slabDotBoxes, mayBeUnderSlab } = useSlabOcclusion({
  getMap,
  wall: plateauWall,
  frames,
});
const lid = usePlateauLid({
  getMap,
  wall: plateauWall,
  style: STYLE,
  plateauSeq: () => plateauSeq,
  plateauActive: () => plateauActive,
  lidExtra: () => lidExtra,
});

// The DEM's canonical tile zoom for a selection: one level past its fit zoom. The
// source is capped there (maxzoom), so flying/zooming NEVER requests new terrain
// tiles — the same small set gets over/under-scaled. (The overzoom slope this puts
// on the raster edge stays hidden: it spans ~±0.5 texel around an edge that the
// erosion already keeps 2.5 texels behind the vector wall.)
function canonicalDemZoom(b: Bounds): number {
  // On flat ground: the plateau standing elsewhere must not change the answer.
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
  if (!map || !mapReady || introPending) return;
  const seq = ++plateauSeq;
  // The raised plateau is the SELECTED unit itself (the "scope" feature), not its
  // children — so drilling to a région lifts that whole région.
  const raised = (props.outline?.features ?? []).filter((f) => f.properties?.kind === "scope");
  // Child + sibling boundaries — ALWAYS drawn by the GL layer (constant-width
  // vector lines): on the lid when a plateau stands, at ground level otherwise
  // (there is no draped line layer anymore).
  const focus = (props.outline?.features ?? []).filter((f) => f.properties?.kind === "focus");
  const context = (props.outline?.features ?? []).filter((f) => f.properties?.kind === "context");
  if (!raised.length) {
    // The scope's geometry is merely still LOADING (cold cache) → hold the current
    // plateau; the geometry's arrival re-fires this watcher with the real shape.
    if (props.scopePending) return;
    // Nothing selected (world level, or the micropin zone) → sink, then clear the
    // plateau; the outline's own lines (e.g. the country boundary at world
    // scope) stay, grounded.
    if (plateauVersion && map.getTerrain()) {
      await animateTerrain(0, SINK_MS);
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
  if (changed) lidExtra = null;
  if (changed || !lid.hasTexture()) void lid.capture(seq, raised);
  // Selection changed → the old plateau starts sinking NOW, while the POST runs.
  // (A different scope id always hashes to a different DEM version, so this never
  // sinks a plateau that the same-version path would have kept up.)
  const sinkP =
    changed && plateauVersion && map.getTerrain() ? animateTerrain(0, SINK_MS) : Promise.resolve();
  try {
    const res = await fetch(`${API_BASE}/api/dem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features: raised, height: heightM }),
    });
    if (!res.ok) throw new Error(`dem POST ${res.status}`);
    const { version } = (await res.json()) as { version?: string };
    if (!version) throw new Error("dem POST returned no version");
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
    await animateTerrain(1, RISE_MS);
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

// ---- The analyses' slabs (see SlabSpec, PlateauWallLayer.setSlabs) --------------
// Raised pieces beside the unit standing raised, drawn with its plateau: built
// for it at its swap (they rise with it from 0) or when the analyses come on
// over it (they rise alone), gone with it — another unit raised, the world
// view, the lieu zone, a failure — or when the analyses go (they sink alone).
// Sized once per unit framed (map/lib/slabs), for the camera the fit lands on.
// The ring's parts follow the overlay's pick and hover (setRing).

/** The camera the last fit lands on, for sizing the slabs of the unit it
 *  framed (`key`: its command's). Null once the user moves the map, or after
 *  any other command. */
let fitCam: (SlabCam & { key: number; seq: number }) | null = null;
let fitCamSeq = 0;
/** The standing plateau's unit and box, as last given to setGeometry. */
let plateauRaised: OutlineFC["features"] = [];
let plateauBbox: Bounds | null = null;
/** What the slabs standing now were built from. */
let slabState: {
  scopeId: string;
  framedBy: number | null;
  /** The fit they were sized for (its seq; -1: the camera of the moment). */
  seq: number;
  anamorphic: boolean;
  textScale: number;
  gapPx: number;
  heightM: number;
  cam: SlabCam;
  scales: SlabScales;
  key: string;
  buildMs: number;
  rects: SlabRect[];
} | null = null;
/** "Carte" (DEV): the slabs' rectangles, which the lid's snapshot must take in. */
let lidExtra: Bounds | null = null;
/** The ring's part picked and the one hovered, as the overlay has them, for
 *  the unit its words are about (setRing). */
let ringState: SlabRingState & { scopeId: string } = { scopeId: "", ...NO_RING };
/** The ring's state for the unit `scopeId`: the overlay's, when its words are
 *  about it; else (they trail the scope a moment) its largest picked. */
const ringStateFor = (scopeId: string): SlabRingState =>
  ringState.scopeId === scopeId ? ringState : NO_RING;

/** The overlay's pick and hover on the ring of `scopeId`: the raised parts
 *  and the bar follow (a small mesh, built again only when they change). */
function setRing(scopeId: string, picked: string | null, hovered: string | null) {
  ringState = { scopeId, picked, hovered };
  if (plateauWall.slabScopeId === scopeId) plateauWall.setSlabRing(ringState);
}

/** The camera of the moment, as the slabs are sized with: its centre is the
 *  padded centre's ground (no aim offset). */
function liveSlabCam(): SlabCam {
  const m = map!;
  const c = m.getCenter();
  return {
    lng: c.lng,
    lat: c.lat,
    ox: 0,
    oy: 0,
    zoom: m.getZoom(),
    pitch: m.getPitch(),
    w: m.getContainer().clientWidth,
    h: m.getContainer().clientHeight,
    globe: isGlobeStyle(),
  };
}

let slabAnim: {
  raf: number;
  timer: number;
  resolve: () => void;
  target: number;
  done: Promise<void>;
} | null = null;

function cancelSlabAnim() {
  if (!slabAnim) return;
  cancelAnimationFrame(slabAnim.raf);
  clearTimeout(slabAnim.timer);
  const r = slabAnim.resolve;
  slabAnim = null;
  r();
}

/** The slabs' presence eased to `to` (animateTerrain's pattern: rAF, and a
 *  timeout snap for a hidden tab, where rAF stalls). */
function animateSlabs(to: number, ms: number): Promise<void> {
  if (slabAnim && slabAnim.target === to) return slabAnim.done;
  if (!slabAnim && plateauWall.slabPresence === to) return Promise.resolve();
  cancelSlabAnim();
  const done: Promise<void> = new Promise((resolve) => {
    const from = plateauWall.slabPresence;
    const t0 = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const finish = () => {
      if (!slabAnim) return;
      cancelAnimationFrame(slabAnim.raf);
      clearTimeout(slabAnim.timer);
      slabAnim = null;
      plateauWall.setSlabPresence(to);
      resolve();
    };
    const tick = (now: number) => {
      if (!slabAnim) return;
      const t = Math.min(1, (now - t0) / ms);
      if (t >= 1 || !map) return finish();
      plateauWall.setSlabPresence(from + (to - from) * ease(t));
      slabAnim.raf = requestAnimationFrame(tick);
    };
    slabAnim = {
      raf: requestAnimationFrame(tick),
      timer: window.setTimeout(finish, ms + 300),
      resolve,
      target: to,
      done: Promise.resolve(),
    };
  });
  if (slabAnim) slabAnim.done = done;
  return done;
}

/** No slabs at all (the plateau gone, or another standing without any). */
function clearSlabs() {
  cancelSlabAnim();
  if (plateauWall.slabQuads.length || plateauWall.slabScopeId) {
    plateauWall.setSlabs([], null, 0, "");
  }
  plateauWall.setSlabPresence(0);
  slabState = null;
  lidExtra = null;
  hidePinsUnderSlabs(); // the pins they hid, back
}

/** Whether the slabs asked for are for the plateau standing now. */
const slabsWanted = () =>
  Boolean(props.slabs && plateauWall.scopeId && props.slabs.scopeId === plateauWall.scopeId);

/**
 * Bring the slabs in line with the spec and the plateau standing. `atSwap`:
 * a new plateau has just been put in place, still flat — its slabs (if any)
 * rise with it, from 0 (any others go at once: the old plateau has sunk).
 */
function syncSlabs(atSwap = false) {
  if (!map) return;
  const layer = plateauWall;
  const spec = props.slabs ?? null;
  const scope = layer.scopeId;
  const standing = scope !== "" && layer.heightM > 0 && plateauBbox !== null;
  if (!standing) {
    clearSlabs();
    return;
  }
  if (!spec || spec.scopeId !== scope) {
    if (atSwap) clearSlabs();
    // The analyses gone from over this plateau: its slabs sink alone. (Asked
    // for another unit: they stay, and sink with their plateau.)
    else if (!spec && layer.slabScopeId === scope) {
      void animateSlabs(0, SINK_MS).then(() => {
        if (!slabsWanted()) clearSlabs();
      });
    }
    return;
  }
  const t0 = performance.now();
  const bbox = plateauBbox!;
  const box = {
    minLng: bbox.minLng,
    minLat: bbox.minLat,
    maxLng: bbox.maxLng,
    maxLat: bbox.maxLat,
  };
  const liftM = layer.heightM * WALL_OVERSHOOT;
  // Sized for the fit that framed this unit, when it is the one the camera
  // flies (or flew) to; else for the camera of the moment. Once sized, kept:
  // the slabs are ground then — the camera moving changes nothing, a content
  // box changing (a filter) keeps the scale; only a new fit sizes them anew.
  const fresh = fitCam && spec.framedBy !== null && fitCam.key === spec.framedBy ? fitCam : null;
  const st = slabState;
  let cam: SlabCam;
  let seq: number;
  let scales: SlabScales;
  const solve = (c: SlabCam) =>
    solveSlabScales({
      bbox: box,
      liftM,
      cam: c,
      top: spec.top,
      bottom: spec.bottom,
      gapPx: spec.gapPx,
      anamorphic: spec.anamorphic,
      textScale: spec.textScale,
    });
  if (
    st &&
    st.scopeId === scope &&
    st.framedBy === spec.framedBy &&
    st.anamorphic === spec.anamorphic &&
    st.textScale === spec.textScale &&
    st.gapPx === spec.gapPx &&
    st.heightM === layer.heightM &&
    (!fresh || fresh.seq === st.seq)
  ) {
    cam = st.cam;
    seq = st.seq;
    scales = st.scales;
    // A slab newly needed (the ring now drawn): sized for the same camera.
    if (spec.top && !scales.top) {
      const more = solve(cam);
      scales = { ...scales, top: more.top, metres: { ...scales.metres, top: more.metres.top } };
    }
  } else {
    cam = fresh ?? liveSlabCam();
    seq = fresh?.seq ?? -1;
    scales = solve(cam);
  }
  const rects = slabRects(box, scales, { top: spec.top, bottom: spec.bottom });
  const key = JSON.stringify([
    scope,
    layer.heightM,
    rects.map((r) => [r.side, r.corners]),
    spec.top,
  ]);
  let buildMs = st?.buildMs ?? 0;
  if (key !== st?.key || layer.slabScopeId !== scope) {
    layer.setSlabs(rects, spec.top, layer.heightM, scope, ringStateFor(scope));
    buildMs = Math.round((performance.now() - t0) * 1000) / 1000;
  }
  slabState = {
    scopeId: scope,
    framedBy: spec.framedBy,
    seq,
    anamorphic: spec.anamorphic,
    textScale: spec.textScale,
    gapPx: spec.gapPx,
    heightM: layer.heightM,
    cam,
    scales,
    key,
    buildMs,
    rects,
  };
  // The words' pieces' lid: glass, the card's colour, or (the DEV switch, in
  // the testing tools) the raised map's snapshot over it — which must then
  // take in the slabs' rectangles too.
  const carte = __TEST_TOOLS__ && spec.lid === "carte";
  layer.setSlabLid(carte ? "carte" : spec.lid === "opaque" ? "opaque" : "verre");
  lidExtra = carte && rects.length ? rects.map(rectBounds).reduce(unionBounds) : null;
  const covered = lid.covered();
  if (lidExtra && !(covered && boundsContain(covered, lidExtra))) {
    const whole = boundsOfFeatures(plateauRaised);
    if (whole) void lid.capture(plateauSeq, plateauRaised, unionBounds(whole, lidExtra), true);
  }
  // Their presence: at a swap they ride the plateau's rise; over a plateau
  // already up they rise alone.
  if (atSwap) {
    cancelSlabAnim();
    layer.setSlabPresence(1);
  } else if (layer.slabPresence < 1 || slabAnim) {
    void animateSlabs(1, RISE_MS);
  }
  hidePinsUnderSlabs(); // the pins they stand over now
}

const rectBounds = (r: SlabRect): Bounds => ({
  minLat: r.minLat,
  maxLat: r.maxLat,
  minLng: r.minLng,
  maxLng: r.maxLng,
});

/** The site's card colour (shared/styles/tokens.css --card, an HSL triplet), as sRGB 0..1. */
function readCardRgb(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
  const m = raw.match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (!m) return [1, 1, 1];
  const h = (((Number(m[1]) % 360) + 360) % 360) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return s === 0 ? [l, l, l] : [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}
let themeObserver: MutationObserver | null = null;

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
    if (import.meta.env.DEV) (window as unknown as { __acMap?: mapboxgl.Map }).__acMap = map;
    // Read-only probe, present in production too: the plateau/terrain path only
    // runs in a real browser (never in a headless preview), so diagnosing "the
    // map looks low-detail" needs a way to read the live state from the console.
    (window as unknown as { __acPlateau?: () => unknown }).__acPlateau = () => {
      return {
        zoom: map ? +map.getZoom().toFixed(2) : null,
        terrainActive: !!map?.getTerrain(),
        plateauActive,
        scope: plateauScopeId,
        demSource: terrainSrc,
        demMaxzoom: (map?.getStyle().sources?.[terrainSrc] as { maxzoom?: number })?.maxzoom,
        dpr: window.devicePixelRatio || 1,
        canvasDevicePx: map?.getCanvas().width ?? null,
        // The lid's texture: its size, resolution and cover (usePlateauLid).
        ...lid.probe(),
        // The analyses' slabs standing (see syncSlabs).
        slabs: slabState && {
          scopeId: slabState.scopeId,
          p: +plateauWall.slabPresence.toFixed(3),
          rise: +plateauWall.slabRise.toFixed(3),
          framedBy: slabState.framedBy,
          sizedForFit: slabState.seq >= 0,
          textScale: slabState.textScale,
          scales: slabState.scales,
          rects: slabState.rects.map((r) => ({
            side: r.side,
            w: r.w,
            h: r.h,
            minLng: +r.minLng.toFixed(5),
            maxLng: +r.maxLng.toFixed(5),
            minLat: +r.minLat.toFixed(5),
            maxLat: +r.maxLat.toFixed(5),
          })),
          sizingCam: slabState.cam,
          buildMs: slabState.buildMs,
          // The ring's parts and the bar, built again at each pick or hover.
          partsMs: plateauWall.slabPartsMs,
          ring: ringStateFor(slabState.scopeId),
        },
      };
    };

    // The slabs' opaque lids take the site's card colour, and follow the theme.
    plateauWall.setSlabColor(readCardRgb());
    themeObserver = new MutationObserver(() => plateauWall.setSlabColor(readCardRgb()));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    let initialLoadDone = false;
    map.once("load", () => {
      initialLoadDone = true;
      mapReady = true;
      setupLayers();
      applyOutline();
      applyMask();
      buildMarkers();
      lid.warmup(); // hidden lid-snapshot map: pay style init now
      if (props.camera) runCamera({ ...props.camera, animate: false });
      emitView();
      // INTRO: wait for the first idle (basemap fully painted, capped at 4 s),
      // then tilt + raise in one gesture. A user interaction or an animated
      // flight before that releases the intro on its own.
      let introStarted = false;
      const beginIntro = () => {
        const m = map;
        if (introStarted || !introPending || !m) return;
        introStarted = true;
        introPending = false;
        // Reveal HERE, not once the plateau is up: the tilt + rise below is a
        // designed entrance, and playing it behind a loading screen would trade
        // it for a static finished view.
        emitReady();
        if (!userInteracted) {
          const INTRO_TILT_MS = 900;
          // The last fit was flat (the intro's first step): the tilt ends on
          // that fit at the pitch — its unit as a fit leaves it, centred
          // (fitCamera) —, and the slabs of the unit are sized for the
          // camera it ends on. Not a fit: just the tilt.
          const cmd = lastCmd;
          const key = cmd?.key ?? -1;
          fitCam = { key, seq: ++fitCamSeq, ...liveSlabCam(), pitch: ELEV_PITCH };
          flyCamera((mm) => {
            const padding = props.padding ?? 50;
            const cam =
              cmd?.type === "fit"
                ? fitCamera(mm, cmd, padding, ELEV_PITCH, cmd.maxZoom ?? 14)
                : null;
            if (!cam) {
              mm.easeTo({ pitch: ELEV_PITCH, duration: INTRO_TILT_MS, essential: true });
              return;
            }
            fitCam = { key, seq: ++fitCamSeq, ...cam };
            mm.easeTo({
              center: [cam.lng, cam.lat],
              zoom: cam.zoom,
              pitch: ELEV_PITCH,
              padding,
              ...aimed(padding),
              duration: INTRO_TILT_MS,
              essential: true,
            });
          });
        }
        void ensurePlateau(); // rise plays during the tilt
      };
      map?.once("idle", beginIntro);
      window.setTimeout(beginIntro, 4000);
    });
    map.on("error", (e) => {
      const status = (e.error as { status?: number } | undefined)?.status;
      if ((status === 401 || status === 403) && map && !initialLoadDone) {
        console.error("Mapbox style request unauthorized — check VITE_MAPBOX_TOKEN");
        unavailable.value = true;
        emitReady(); // nothing more is coming — never strand a boot overlay
        clearMarkers();
        map.remove();
        map = null;
      }
    });

    map.on("moveend", () => {
      // A flight cut short by the command replacing it has not landed anywhere:
      // the replacement settles when IT lands — or at once, in flyCamera, if it
      // was instant or did not move at all.
      if (issuingCam) return;
      onCameraSettled();
      userHolding = false;
      // A padding ease (or a flight) cut short by a press left the camera's
      // padding half-way: that is owed too.
      if (lastCmd && !paddingAtRest()) padOwed = true;
      if (padOwed) armPadTimer();
    });
    // Pointers down on the map (see `pressed`). Released anywhere: a mouse can
    // be let go outside the canvas.
    const canvasBox = map.getCanvasContainer();
    canvasBox.addEventListener("pointerdown", onMapPointerDown, true);
    window.addEventListener("pointerup", onMapPointerUp, true);
    window.addEventListener("pointercancel", onMapPointerUp, true);
    // A restored WebGL context comes back empty, and mapbox does not run onAdd
    // again for custom layers: the tint sheet is set up again (useScopeMask).
    map.on("webglcontextrestored", () => mask.onContextRestored());
    // Hover inside a unit's boundary reveals its (possibly room-hidden) macro pin
    // and shows a pointer; clicking inside the boundary SELECTS the unit — the
    // whole territory is the click target, the pin is just its label.
    map.on("mousemove", (e) => onMapHover(e.lngLat, e.point));
    map.on("mouseout", (e) => {
      // Moving onto one of our pin ELEMENTS also fires canvas mouseout — the
      // pin's own mouseenter keeps the hover; don't clear it out from under it.
      // (pinHoveredId additionally guards stray mouseouts while ON a pin.)
      const to = (e.originalEvent as MouseEvent | undefined)?.relatedTarget as Element | null;
      if (pinHoveredId || to?.closest?.(".geo-pin")) return;
      onMapHover({ lng: -999, lat: -999 });
    });
    map.on("click", (e) => {
      const id = unitAt(e.lngLat.lng, e.lngLat.lat, e.point);
      if (id) emit("unitClick", id);
    });
    // During FREE navigation, emit the view (throttled) while the gesture is still
    // going, so the scope — and the plateau transition — react mid-zoom instead of
    // waiting for moveend. Suppressed during programmatic flights (a drill must
    // not churn through the levels it flies over).
    let lastMoveEmit = 0;
    map.on("move", () => {
      scheduleSticky(); // re-centre pins on their visible part (≤1×/frame)
      // Outside the programmaticCam guard on purpose — a flight crosses into the
      // globe just as readily as a drag, and the grey must change hands with it.
      syncDrapedMask();
      if (programmaticCam) return;
      const now = performance.now();
      if (now - lastMoveEmit > 250) {
        lastMoveEmit = now;
        // Said again as the gesture goes on: the parent may have had a reason
        // to ignore its first moments.
        if (userHolding) emit("userGesture");
        emitView();
      }
    });
    // The frame bus (see emitFrame): fired at the end of every frame drawn.
    map.on("render", frames.emitFrame);
    if (import.meta.env.DEV) {
      (window as unknown as { __acFrame?: () => unknown }).__acFrame = frames.probe;
    }

    // The container can be laid out late (grid/flex settling, fonts) — keep the
    // canvas synced and re-apply the last framing until the user takes the camera.
    const markInteracted = (e: unknown) => {
      if ((e as { originalEvent?: unknown })?.originalEvent) userInteracted = true;
    };
    map.on("dragstart", markInteracted);
    map.on("zoomstart", markInteracted);
    map.on("rotatestart", markInteracted);
    map.on("pitchstart", markInteracted);

    // "The user has started moving the map" (see the `userGesture` emit). A
    // `movestart` that carries the DOM event behind it is a gesture — except
    // mapbox's own answer to a window resize, which carries one too.
    const NOT_A_GESTURE = /resize|orientationchange|fullscreenchange/i;
    map.on("movestart", (e) => {
      const oe = (e as { originalEvent?: Event }).originalEvent;
      if (!oe || NOT_A_GESTURE.test(oe.type)) return;
      userHolding = true; // until the `moveend` every such start is followed by
      fitCam = null; // the camera is the user's now: no fit to size slabs for
      emit("userGesture");
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
      for (const e of markerById.values()) e.halfW = e.halfH = 0; // measured anew
      if (!userInteracted && lastCmd) runCamera({ ...lastCmd, animate: false });
      drawNow();
    });
    resizeObserver.observe(el.value);

    visibilityObserver = new IntersectionObserver((entries) => {
      const seen = entries.some((e) => e.isIntersecting);
      const wasOffscreen = offscreen;
      offscreen = !seen;
      plateauWall.setPaused(offscreen);
      if (wasOffscreen && seen) map?.triggerRepaint(); // the halo picks up again
    });
    visibilityObserver.observe(el.value);

    setTimeout(() => map?.resize(), 0);
    setTimeout(() => map?.resize(), 300);
  } catch (e) {
    console.error("Mapbox init failed:", e);
    unavailable.value = true;
    emitReady(); // nothing more is coming — never strand a boot overlay
    clearMarkers();
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

onBeforeUnmount(() => {
  window.removeEventListener(MAP_MOVED_EVENT, onMapMoved);
  if (stickyRaf) cancelAnimationFrame(stickyRaf);
  if (hoverRaf) cancelAnimationFrame(hoverRaf);
  window.clearTimeout(padTimer);
  window.removeEventListener("pointerup", onMapPointerUp, true);
  window.removeEventListener("pointercancel", onMapPointerUp, true);
  cancelExagAnim();
  cancelSlabAnim();
  themeObserver?.disconnect();
  themeObserver = null;
  plateauSeq++; // abort any in-flight ensurePlateau
  lid.destroy();
  resizeObserver?.disconnect();
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  offscreen = false;
  plateauWall.setPaused(false);
  resizeObserver = null;
  clearMarkers();
  map?.remove();
  map = null;
  mapReady = false;
  introPending = true;
  frames.dispose();
  if (import.meta.env.DEV) {
    const w = window as unknown as { __acFrame?: () => unknown };
    if (w.__acFrame === frames.probe) delete w.__acFrame;
  }
});

watch(
  () => props.units,
  () => buildMarkers(),
  { deep: false },
);
watch(
  // scopePending is a source too: the outline can keep the SAME identity (e.g. the
  // shared EMPTY_FC in the micropin zone) across a pending→resolved transition, and
  // ensurePlateau's hold/teardown decision must re-run when that happens.
  () => [props.outline, props.scopePending] as const,
  () => {
    applyOutline();
    applyMask(); // the hole is cut from props.outline — follow it immediately
    ensurePlateau(); // selection changed → re-raise the new area
  },
);
watch(
  () => props.camera?.key,
  () => {
    if (props.camera) runCamera(props.camera);
  },
);
// After the camera's watcher (watchers run in the order they are made): a
// command and the spec it frames for come in the same tick, and the slabs are
// sized for the fit that command has just started.
watch(
  () => JSON.stringify(props.slabs ?? null),
  () => syncSlabs(),
);

// Panel-driven hover. Goes through the SAME setHover the pointer uses, so a
// panel row lights the zone, lifts the pill and sweeps the plateau identically.
// The two never fight: moving the pointer off the canvas onto the panel fires
// the canvas `mouseout` (clearing the map's hover) BEFORE the row's mouseenter,
// and leaving the row clears before the next canvas mousemove takes over.
watch(
  () => props.hoveredId,
  (id) => setHover(id ?? ""),
);
watch(() => props.activeId, applyActivePin);

// The panel's width changes when an audition opens, which changes `padding`.
// Mapbox keeps the centre in the middle of the PADDED box, so easing to the new
// padding slides the map out from under the panel — and unlike re-running the
// last camera command, it preserves whatever the user panned/zoomed to.
//
// Kept in step with `.panel`'s width transition in GeoNav: the panel resizing
// is what changes the padding, so a shorter ease here reads as the map
// arriving before the panel has finished moving.
function easePadding() {
  const pad = props.padding;
  if (!map || pad == null) return;
  // Under the user's hands it waits (see `userHolding`): `moveend`, or the
  // release of the press, comes back for it. Meanwhile the parent is told what
  // is in sight now — the logical view follows the prop, not the camera.
  if (pressed.size || (userHolding && map.isMoving())) {
    padOwed = true;
    emitView();
    return;
  }
  padOwed = false;
  flyCamera((m) => m.easeTo({ padding: pad, duration: 550 }));
}

defineExpose({
  /** A finger or the mouse is on the map, or it is still gliding from one: a
   *  camera command now would cut that gesture short. */
  inUserHands: () => pressed.size > 0 || (userHolding && Boolean(map?.isMoving())),
  /** Where the raised plateau stands on screen, once per frame drawn (see
   *  PlateauFrame); returns the unsubscribe. */
  onFrame: frames.onFrame,
  /** The analyses' ring: the part picked and the one hovered on the unit
   *  `scopeId`'s — the raised parts and the bar follow. */
  setRing,
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

/** The camera's padding is the one asked for (it is not, mid-ease). */
function paddingAtRest(): boolean {
  const want = props.padding;
  if (!map || want == null) return true;
  const w = typeof want === "number" ? { top: want, bottom: want, left: want, right: want } : want;
  const have = map.getPadding();
  return (["top", "bottom", "left", "right"] as const).every(
    (side) => Math.abs((have[side] ?? 0) - w[side]) < 0.5,
  );
}

// Pays the padding owed once the map has been left alone for a moment — not
// from inside `moveend` (a press that has just cut a flight short is still
// being set up by mapbox, and a camera call would kill it), and never under a
// finger. Whoever is in the way calls back: a move ends in `moveend`, a press
// in `onMapPointerUp`.
function armPadTimer() {
  window.clearTimeout(padTimer);
  padTimer = window.setTimeout(() => {
    if (!padOwed || !map || programmaticCam || pressed.size || map.isMoving()) return;
    easePadding();
  }, 250);
}

function onMapPointerDown(e: PointerEvent) {
  pressed.add(e.pointerId);
  window.clearTimeout(padTimer);
}

function onMapPointerUp(e: PointerEvent) {
  if (!pressed.delete(e.pointerId) || pressed.size) return;
  if (padOwed) armPadTimer(); // a tap, or a catch, ends without a `moveend`
}

let lastPadKey = "";
watch(
  () => props.padding,
  (pad) => {
    const key = JSON.stringify(pad ?? null);
    if (key === lastPadKey) return;
    const first = lastPadKey === "";
    lastPadKey = key;
    // The first run only seeds the key: the initial padding rides along with
    // whatever camera command frames the map on load.
    if (first || !map || pad == null) return;
    // A COMMAND still in flight (opening a place spotlights it) would be
    // CANCELLED by a bare padding ease, stranding the camera short of its
    // target. Re-issue that command instead — it re-frames against the new
    // padding and still lands where it was going. Only for the command's own
    // flight, though: `map.isEasing()` is also true while the map coasts after
    // a fling, or during this watcher's own padding ease, and re-running the
    // last command then would throw away wherever the user had got to.
    if (cmdFlight && lastCmd) {
      // …unless that flight was framed against this very padding: the command
      // and the padding often change in the same tick (opening a lieu on a
      // phone), and runCamera reads the padding live. Restarting it then would
      // only stutter the flight.
      if (key === lastCmdPadKey) return;
      // (Directly, when it was an arc: a second pull-back mid-flight would
      // read as the map changing its mind.)
      runCamera({ ...lastCmd, animate: true, arc: false });
      return;
    }
    easePadding();
  },
  { immediate: true },
);

// The logical view changed without the camera moving (the panel folded or
// unfolded): tell the parent what is in sight now. Never mid-flight — a flight
// reports where it lands.
watch(
  () => JSON.stringify(props.viewPadding ?? null),
  () => {
    void nextTick(() => {
      if (map && !programmaticCam) emitView();
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
