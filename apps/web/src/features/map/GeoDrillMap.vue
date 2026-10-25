<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import mapboxgl from "mapbox-gl";
import type * as GeoJSON from "geojson";
import { FRANCE_CENTER } from "@ac/shared";
import type { Bounds } from "@/features/geo";
import { SnapshotManager, type Snapshot } from "./plateau/mapSnapshot";
import {
  FIT_PITCH_DEG,
  fitSilhouette,
  homography,
  latOf,
  lngOf,
  slabRects,
  solveSlabScales,
  unapplyHomography,
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
import { STRIDE, fitHullOf } from "./lib/projection";
import { WALL_OVERSHOOT } from "./gl/mesh";
import {
  NO_RING,
  PlateauWallLayer,
  type SlabQuad,
  type SlabRingState,
} from "./gl/PlateauWallLayer";
import { MASK_OPACITY, ScopeTintLayer, sameGeoms, type MaskGeom } from "./gl/ScopeTintLayer";
import type { CameraCmd, MapUnit, OutlineFC, PlateauFrame, SlabFrame, SlabSpec } from "./types";
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

const EMPTY_FC: OutlineFC = { type: "FeatureCollection", features: [] };
const OUTLINE_SOURCE = "scope-outline";

// ---- "Everything but the plateau" grey: dims the map outside the raised area so
// the selection reads as the subject.
//
// One shape in both renderers: a world-sized sheet with the raised rings as
// HOLES, so the plateau is excluded by geometry the moment the selection
// changes. WHO draws that sheet depends on the projection mapbox is running:
//
//  - FLAT (zoom ≥ GLOBE_MAX_ZOOM): `ScopeTintLayer`, a custom GL layer. The
//    sheet is a mesh in the map's own coordinates, so it has no tiles, no worker
//    and no terrain re-drape — it is on screen in the frame it changes and cannot
//    be outrun by the camera.
//  - GLOBE (below): a draped fill on the GeoJSON source below, as before. A flat
//    mesh cannot follow the sphere, and a world-sized draped sheet never needs
//    rebuilding on camera movement there anyway.
//
// The draped sheet used to serve the flat view too, bounded to the viewport and
// rebuilt whenever the camera left it. Every rebuild was a worker re-tile plus a
// terrain re-drape, so a fast zoom-out showed un-greyed map until it landed.
//
// Earlier designs worth remembering:
//  1. A draped polygon with the whole WORLD as its outer ring, four corners
//     only. Tessellated per tile it produced triangles spanning the globe, which
//     projected as flat angular slabs. `maskRing` densifies the ring instead.
//  2. A `background` layer — no geometry, so no artifacts, but nothing can be
//     cut out of it. The plateau could only be un-greyed by its LID drawing over
//     it, and the lid is an async capture (~1 s), so either the incoming
//     selection sat grey until its texture landed or the outgoing one stayed lit.
//     A hole has no such wait: it is the reason this is geometry.
const MASK_SOURCE = "scope-mask";
const MASK_LAYER = "scope-mask-fill";
const MASK_COLOR = "#8b9098"; // neutral grey — desaturates without heavy darkening
// Its opacity, and what it looks like on screen (the GL sheet reproduces both):
// gl/ScopeTintLayer's MASK_OPACITY and TINT_RGB.
/**
 * Mapbox renders the style's globe below this zoom and the flat (mercator)
 * pipeline from it up — custom layers get a different `render` call on each side.
 */
const GLOBE_MAX_ZOOM = 6;
// The draped sheet's tiles take a worker round trip to appear, so they have to
// exist a little BEFORE the camera reaches the globe. This is its layer's
// `maxzoom`: from here down mapbox keeps the tiles loaded (transparent until the
// globe takes over); above it the source is unused and holds none, so nothing in
// the flat view pays for it — every tile that loads, visible or not, makes
// mapbox re-drape the terrain under it.
const MASK_ARM_ZOOM = 7;
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const emit = defineEmits<{
  unitClick: [id: string];
  viewChange: [
    view: {
      zoom: number;
      center: [number, number];
      /** Flat symmetric box — what the SCOPE logic measures span against. */
      bounds: Bounds;
      /** What is actually on screen, pitch included — use this to cull pins. */
      screen: Bounds;
      /** The insets `bounds` was measured inside: the layout this view is OF.
       *  A view measured for another layout than the current one is stale. */
      insets: { top: number; bottom: number; left: number; right: number };
      /** The user is moving the camera (gesture or its glide) — as opposed to a
       *  flight landing, the padding ease, a resize or a re-measure. */
      byUser: boolean;
    },
  ];
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

// Geo bbox of the VISIBLE map rectangle (canvas minus the panel padding, minus an
// optional inset margin). Shared by the scope derivation (emitView) and pin
// placement (updateSticky) so both reason about the same on-screen area.
// Built from the inset CENTRE (stable under pitch — a mid-screen point never nears
// the horizon) plus a span sized from the zoom and the tilt, NOT by unprojecting
// the corners (which blow up toward the horizon once the camera is pitched).
/** Insets of the rectangle that is clear of the panel right now (see `viewPadding`). */
function viewInsets() {
  const pad = props.viewPadding ?? props.padding ?? 50;
  return typeof pad === "number" ? { top: pad, bottom: pad, left: pad, right: pad } : pad;
}

/**
 * The ground under a screen point — the FLAT ground, not the terrain. The
 * plateau rises and sinks (its height animated, kilometres at région scale):
 * a ray through the screen hits its raised surface far up the slope from the
 * point actually looked at, and the scope read from there landed on another
 * unit (the 9e raised while the user looked at Lyon 1er). mapbox's `unproject`
 * follows the terrain, and its flat `transform.pointLocation` returns NaN on the
 * globe — so: the camera's own centre, moved by the pixels between it and the
 * point at the ground scale there. Exact at rest when the two centres meet (the
 * panel narrow), first-order across the wide panel's offset.
 */
function groundAt(x: number, y: number): { lat: number; lng: number } {
  const m = map!;
  const c = m.getContainer();
  const { top = 0, bottom = 0, left = 0, right = 0 } = m.getPadding();
  const dx = x - (left + c.clientWidth - right) / 2;
  const dy = y - (top + c.clientHeight - bottom) / 2;
  const at = m.getCenter();
  if (dx === 0 && dy === 0) return { lat: at.lat, lng: at.lng };
  const cosLat = Math.cos((at.lat * Math.PI) / 180) || 1e-6;
  const mPerPx = (40075016.686 * cosLat) / (512 * Math.pow(2, m.getZoom()));
  // Up the screen is the bearing; a pitched camera stretches the ground along it.
  const b = (m.getBearing() * Math.PI) / 180;
  const along = mPerPx / Math.max(Math.cos((Math.min(m.getPitch(), 80) * Math.PI) / 180), 0.17);
  const east = dx * mPerPx * Math.cos(b) - dy * along * Math.sin(b);
  const north = -dx * mPerPx * Math.sin(b) - dy * along * Math.cos(b);
  return { lat: at.lat + north / 110574, lng: at.lng + east / (111320 * cosLat) };
}

function visibleBounds(margin: number): Bounds | null {
  if (!map) return null;
  const c = map.getContainer();
  const ins = viewInsets();
  const left = ins.left + margin;
  const right = c.clientWidth - ins.right - margin;
  const top = ins.top + margin;
  const bottom = c.clientHeight - ins.bottom - margin;
  if (right - left < 8 || bottom - top < 8) return null;
  const ctr = groundAt((left + right) / 2, (top + bottom) / 2);
  const cosLat = Math.cos((ctr.lat * Math.PI) / 180) || 1e-6;
  // Web-Mercator ground resolution (m/px) at the centre, for Mapbox 512px tiles.
  const mPerPx = (40075016.686 * cosLat) / (512 * Math.pow(2, map.getZoom()));
  // Up the screen, a tilted camera sees more ground per pixel (1/cos pitch at
  // the centre row): measured flat, a unit just framed by `fitBounds` at
  // ELEV_PITCH came out 1.27× the view, and its biggest child already "filled"
  // it — clicking Lyon landed in an arrondissement. Capped so a steep tilt
  // cannot balloon the box. The bearing is left out on purpose: the box of a
  // turned rectangle swells and shrinks as the map turns, and a twist of the
  // fingers while pinching would raise and sink the plateau.
  const pitch = (Math.min(map.getPitch(), 60) * Math.PI) / 180;
  const halfLat = ((bottom - top) * mPerPx) / Math.cos(pitch) / 2 / 110574; // ~m per ° latitude
  const halfLng = ((right - left) * mPerPx) / 2 / (111320 * cosLat); // ~m per ° longitude
  return {
    minLat: ctr.lat - halfLat,
    maxLat: ctr.lat + halfLat,
    minLng: ctr.lng - halfLng,
    maxLng: ctr.lng + halfLng,
  };
}

/**
 * The zoom at which a box `lng` × `lat` degrees fills `fill` of the view the
 * scope is read off (visibleBounds' measure, `ins` the rectangle's insets in
 * a map w × h, at `pitch`, about latitude `lat0`). Infinity: no such zoom.
 */
function zoomForFill(
  box: { lng: number; lat: number; fill: number },
  ins: { top: number; bottom: number; left: number; right: number },
  w: number,
  h: number,
  pitch: number,
  lat0: number,
): number {
  const cosLat = Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const tilt = Math.cos((Math.min(pitch, 60) * Math.PI) / 180);
  const mPerPx =
    Math.max(
      (box.lng * 111320 * cosLat) / (w - ins.left - ins.right),
      (box.lat * 110574 * tilt) / (h - ins.top - ins.bottom),
    ) / box.fill;
  if (!(mPerPx > 0) || !Number.isFinite(mPerPx)) return Infinity;
  return Math.log2((40075016.686 * cosLat) / (512 * mPerPx));
}

/**
 * The TRUE on-screen bbox, pitch included.
 *
 * `visibleBounds` above is a symmetric box ON PURPOSE — scope derivation
 * needs a span that cannot swing toward the horizon. But a pitched camera shows
 * far more ground above the screen centre than that box covers, so anything
 * culled against it vanishes while still plainly on screen. Mapbox's own
 * `getBounds()` walks the view trapezoid, clamps it at the horizon, and already
 * accounts for the camera padding — use it for anything about what the user can
 * actually SEE, and keep `visibleBounds` for what the scope logic measures.
 */
function screenBounds(): Bounds | null {
  if (!map) return null;
  // `getBounds` can THROW. Past the globe, with terrain, it lifts the top
  // corners to the highest visible DEM tile — and while none of those tiles has
  // its data yet (new tiles after a resize, a fresh DEM slot mid-flight) that
  // height is Number.MAX_VALUE: the corners land at infinity and come back as
  // "Invalid LngLat object: (NaN, …)". Thrown on, it took the whole view emit
  // with it (and the `moveend` handler around it), so the parent's pinned scope
  // was never released. Every caller already falls back on null.
  let b: mapboxgl.LngLatBounds | null;
  try {
    b = map.getBounds();
  } catch {
    return null;
  }
  if (!b) return null;
  const box = {
    minLat: b.getSouth(),
    maxLat: b.getNorth(),
    minLng: b.getWest(),
    maxLng: b.getEast(),
  };
  // Infinity passes mapbox's NaN check: a blown-up box is no box either.
  if (!Object.values(box).every(Number.isFinite)) return null;
  // `getBounds` stops at the CAMERA's padding, and more of the map can be in
  // sight than that: the panel folded (`viewPadding`), or a padding the camera
  // has not eased to yet (owed under a gesture, or cut short by one). Take in
  // the corners of what is really clear, or the area just uncovered would be
  // left without pins. At rest the two rectangles are the same one.
  const c = map.getContainer();
  const ins = viewInsets();
  for (const x of [ins.left, c.clientWidth - ins.right]) {
    for (const y of [ins.top, c.clientHeight - ins.bottom]) {
      // Same failure, one corner at a time: skip it, the box keeps the rest.
      let at: mapboxgl.LngLat;
      try {
        at = map.unproject([x, y]);
      } catch {
        continue;
      }
      if (!Number.isFinite(at.lat) || !Number.isFinite(at.lng)) continue;
      box.minLat = Math.min(box.minLat, at.lat);
      box.maxLat = Math.max(box.maxLat, at.lat);
      box.minLng = Math.min(box.minLng, at.lng);
      box.maxLng = Math.max(box.maxLng, at.lng);
    }
  }
  return box;
}

/** `screenBounds` pulled in by `margin` screen pixels — proportional, because
 *  under pitch a pixel is not a fixed ground distance. */
function screenBoundsInset(margin: number): Bounds | null {
  const b = screenBounds();
  if (!b || !map || margin <= 0) return b;
  const c = map.getContainer();
  const dLat = (b.maxLat - b.minLat) * Math.min(0.4, margin / Math.max(c.clientHeight, 1));
  const dLng = (b.maxLng - b.minLng) * Math.min(0.4, margin / Math.max(c.clientWidth, 1));
  return {
    minLat: b.minLat + dLat,
    maxLat: b.maxLat - dLat,
    minLng: b.minLng + dLng,
    maxLng: b.maxLng - dLng,
  };
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
    const boxes = slabDotBoxes();
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
  scheduleLidRefresh();
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
    globe: globeStyle,
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
function setupOutline() {
  if (!map || map.getSource(OUTLINE_SOURCE)) return;
  map.addSource(OUTLINE_SOURCE, {
    type: "geojson",
    data: EMPTY_FC as unknown as GeoJSON.FeatureCollection,
  });
  // Grey everything outside the raised area (see MASK_LAYER's note). It must
  // land ABOVE the basemap's fills but BELOW its labels — greying the map is the
  // point, illegible place names are not.
  //
  // Anchoring it takes BOTH mechanisms, because the configured style decides
  // which one exists. This project's style imports `mapbox://styles/mapbox/
  // standard`, and a Standard style keeps its layers inside that import:
  // `getStyle().layers` is EMPTY, so there is no symbol layer to put a beforeId
  // in front of, and the layer would silently append above the labels. Slots are
  // the Standard mechanism; `beforeId` is the classic one and is what applies if
  // VITE_MAPBOX_STYLE ever points at a non-Standard style. Each is ignored by
  // the style that does not use it.
  const firstSymbol = map.getStyle()?.layers?.find((l) => l.type === "symbol")?.id;
  map.addSource(MASK_SOURCE, {
    type: "geojson",
    data: EMPTY_FC as unknown as GeoJSON.FeatureCollection,
    // Only ever SEEN on the globe, whose tiles stop at this zoom anyway — no
    // point indexing the sheet any deeper.
    maxzoom: GLOBE_MAX_ZOOM - 1,
  });
  map.addLayer(
    {
      id: MASK_LAYER,
      type: "fill",
      source: MASK_SOURCE,
      slot: "middle",
      maxzoom: MASK_ARM_ZOOM,
      paint: {
        "fill-color": MASK_COLOR,
        // Starts hidden: `syncDrapedMask` shows it on the globe only.
        "fill-opacity": 0,
        // The switch to/from the GL sheet must land in ONE frame. A fade would
        // leave both greys (or neither) on screen for its duration, and mapbox
        // re-drapes the whole terrain on every frame of a paint transition.
        "fill-opacity-transition": { duration: 0, delay: 0 },
        // The hole's edge is the selection's boundary, which the plateau wall
        // already draws — antialiasing it too leaves a pale seam along it.
        "fill-antialias": false,
      },
    },
    firstSymbol,
  );
  drapedGeoms = [];
  drapedShown = false;
  // A style with no globe is flat at every zoom: the draped sheet never shows.
  globeStyle = map.getProjection()?.name === "globe";
  // The flat view's grey (see ScopeTintLayer). Same anchoring as the draped
  // sheet: the slot on a Standard style, `beforeId` on a classic one.
  scopeTint.onRegimeChange = syncDrapedMask;
  map.addLayer(scopeTint, firstSymbol);
  // The plateau's violet wall: our custom WebGL layer (see PlateauWallLayer) —
  // exact quads on the vector boundary, depth-tested against the terrain.
  map.addLayer(plateauWall);
  // The analyses' slabs: right after it, a layer of their own — drawn over the
  // map's labels (see PlateauWallLayer.slabLayer).
  map.addLayer(plateauWall.slabLayer);
  // Hovered-zone highlight FALLBACK for the no-plateau case only (world scope):
  // with a plateau up, BOTH focus and context highlights come from the GL sweep
  // pass in PlateauWallLayer (draped paint can't reach the lid, and the sweep
  // animation only exists there).
  map.addLayer({
    id: "scope-hover-fill",
    type: "fill",
    source: OUTLINE_SOURCE,
    filter: ["==", ["get", "id"], "__none__"],
    paint: { "fill-color": "#7c5cff", "fill-opacity": 0.6 },
  });
  // NO draped line layer: with terrain active (which is nearly always — every
  // selection stands a plateau, and even teardown revives the style fragment's
  // own terrain), mapbox rasterises draped lines into per-tile textures at
  // INTEGER zooms and magnifies them by up to 2× with the fractional zoom, so
  // their width visibly breathed while zooming. ALL boundary lines — focus,
  // context siblings, and the world-scope country outline — are GL quads in
  // PlateauWallLayer instead (true constant screen-space width).
}

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

const scopeTint = new ScopeTintLayer();
const plateauWall = new PlateauWallLayer();
const snapshotMgr = new SnapshotManager();

// ---- Frame bus: where the plateau stands on screen, every frame drawn ---------
// For what is laid over the map and must move WITH the plateau (the analyses
// plates, their leader lines, labels on the lid). mapbox fires `render` at the
// end of every frame it draws, in the same task as the draw: camera moves, the
// rise and sink (camera still — `move` misses those), resizes (drawNow) and the
// halo's paced repaints. The plateau layer keeps the camera each frame was
// drawn with, and the rim is projected with it — never with map.project (see
// projectInto). Per frame nothing allocates and nothing touches Vue state, and
// a frame that would come out identical to the last one is not sent at all:
// that is the halo's 25 Hz while the map stands still.
interface FrameBuf {
  frame: PlateauFrame;
  okTop: Uint8Array;
  okBase: Uint8Array;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** The boxes of words' frames, handed out (or not) as frame.slabs.ring,
   *  .label, .plaque. */
  slabRing: SlabFrame;
  slabLabel: SlabFrame;
  slabPlaque: SlabFrame;
  slabOk: Uint8Array;
}
const makeSlabFrame = (): SlabFrame => ({ w: 0, h: 0, lid: new Float32Array(8), ok: false });
function makeFrameBuf(): FrameBuf {
  return {
    frame: {
      scopeId: "",
      rise: 0,
      w: 0,
      h: 0,
      pitch: 0,
      bearing: 0,
      zoom: 0,
      centre: [0, 0],
      n: 0,
      top: new Float32Array(0),
      base: new Float32Array(0),
      ok: new Uint8Array(0),
      box: null,
      slabs: { scopeId: "", rise: 0, version: 0, ring: null, label: null, plaque: null },
    },
    okTop: new Uint8Array(0),
    okBase: new Uint8Array(0),
    box: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    slabRing: makeSlabFrame(),
    slabLabel: makeSlabFrame(),
    slabPlaque: makeSlabFrame(),
    slabOk: new Uint8Array(4),
  };
}

/** The boxes of words on screen (see PlateauSlabs), at their lids' height,
 *  at their rise this frame. */
function fillSlabs(buf: FrameBuf, camValid: boolean, w: number, h: number) {
  const layer = plateauWall;
  const s = buf.frame.slabs;
  s.scopeId = layer.slabScopeId;
  s.rise = layer.slabRise;
  s.version = layer.slabVersion;
  s.ring = null;
  s.label = null;
  s.plaque = null;
  const alt = layer.slabHeightM * WALL_OVERSHOOT * layer.slabRise;
  for (let i = 0; i < layer.slabQuads.length; i++) {
    const q = layer.slabQuads[i];
    const out =
      q.name === "ring"
        ? buf.slabRing
        : q.name === "label"
          ? buf.slabLabel
          : q.name === "plaque"
            ? buf.slabPlaque
            : null;
    if (!out) continue; // the bar: no words
    out.w = q.w;
    out.h = q.h;
    out.ok = false;
    if (camValid) {
      layer.projectInto(layer.slabCorners, 4, alt, w, h, out.lid, buf.slabOk, q.at);
      out.ok = (buf.slabOk[0] & buf.slabOk[1] & buf.slabOk[2] & buf.slabOk[3]) === 1;
    }
    if (q.name === "ring") s.ring = out;
    else if (q.name === "label") s.label = out;
    else s.plaque = out;
  }
}
const frameBuf = makeFrameBuf();
/** Subscribers; replaced (never mutated) on change, so a callback that
 *  unsubscribes mid-delivery cannot disturb the loop delivering to it. */
let frameSubs: { cb: (f: PlateauFrame) => void; live: boolean }[] = [];
/** Send the next frame even if it matches the last (a new subscriber). */
let frameForce = true;
/** The plateau layer's capture count at the last `render` (see emitFrame). */
let seenCamSeq = 0;
/** Whether the last `render` was drawn with a camera the layer captured. */
let camFresh = false;
// The container's CSS size: mapbox's transform has what its matrices were built
// for (CSS transforms on ancestors already divided out); the ResizeObserver's
// last numbers stand in should those internals ever move.
let roW = 0;
let roH = 0;
let frameW = 0;
let frameH = 0;
// The last frame sent, as numbers: camera, rise, rim, size, padding.
const frameSig = new Float64Array(64).fill(NaN);
let sigAt = 0;
let sigDiff = false;
function sigPut(v: number) {
  if (frameSig[sigAt] !== v) {
    frameSig[sigAt] = v;
    sigDiff = true;
  }
  sigAt++;
}
// DEV probe counters (plain numbers).
let framesSent = 0;
let framesSkipped = 0;

function readFrameSize() {
  const tr = (map as unknown as { transform?: { width?: unknown; height?: unknown } } | null)
    ?.transform;
  const w = tr?.width;
  const h = tr?.height;
  if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
    frameW = w;
    frameH = h;
  } else {
    frameW = roW;
    frameH = roH;
  }
}

interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
/** The camera's padding, without the copy getPadding() allocates. */
function cameraInsets(): Insets | null {
  const ei = (map as unknown as { transform?: { _edgeInsets?: Insets } } | null)?.transform
    ?._edgeInsets;
  if (ei && typeof ei.top === "number" && typeof ei.left === "number") return ei;
  return map ? (map.getPadding() as Insets) : null;
}

/** Fill a frame from the last captured camera (`camValid` false: no camera). */
function fillFrame(buf: FrameBuf, camValid: boolean, pad: Insets | null) {
  const f = buf.frame;
  const layer = plateauWall;
  const n = layer.rimCount;
  // Sized to the rim: reallocated only when the rim changes length.
  if (f.ok.length !== n) {
    f.top = new Float32Array(2 * n);
    f.base = new Float32Array(2 * n);
    f.ok = new Uint8Array(n);
    buf.okTop = new Uint8Array(n);
    buf.okBase = new Uint8Array(n);
  }
  const w = frameW;
  const h = frameH;
  f.scopeId = layer.scopeId;
  f.rise = layer.rise;
  f.w = w;
  f.h = h;
  f.pitch = map ? map.getPitch() : 0;
  f.bearing = map ? map.getBearing() : 0;
  f.zoom = map ? map.getZoom() : 0;
  // mapbox's own padded centre (EdgeInsets.getCenter), clamped to the view.
  const pl = pad?.left ?? 0;
  const pr = pad?.right ?? 0;
  const pt = pad?.top ?? 0;
  const pb = pad?.bottom ?? 0;
  f.centre[0] = Math.min(w, Math.max(0, (pl + w - pr) / 2));
  f.centre[1] = Math.min(h, Math.max(0, (pt + h - pb) / 2));
  f.n = n;
  f.box = null;
  fillSlabs(buf, camValid, w, h);
  if (!camValid || !n) {
    f.ok.fill(0);
    return;
  }
  const rise = layer.rise;
  layer.projectInto(layer.rim, n, layer.heightM * WALL_OVERSHOOT * rise, w, h, f.top, buf.okTop);
  layer.projectInto(layer.rim, n, 0, w, h, f.base, buf.okBase);
  let any = false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = buf.okTop[i] & buf.okBase[i];
    f.ok[i] = v;
    if (!v) continue;
    any = true;
    const tx = f.top[2 * i];
    const ty = f.top[2 * i + 1];
    const bx = f.base[2 * i];
    const by = f.base[2 * i + 1];
    minX = Math.min(minX, tx, bx);
    maxX = Math.max(maxX, tx, bx);
    minY = Math.min(minY, ty, by);
    maxY = Math.max(maxY, ty, by);
  }
  if (any && rise >= 0.02) {
    const b = buf.box;
    b.minX = minX;
    b.minY = minY;
    b.maxX = maxX;
    b.maxY = maxY;
    f.box = b;
  }
}

/** The `render` listener: send this frame's plateau to every subscriber. */
function emitFrame() {
  const cam = plateauWall.cam;
  // The plateau layer is drawn in every frame mapbox renders once the style is
  // up; a frame it was NOT drawn in (style loading or being replaced) has no
  // camera of its own to project with — the plateau isn't on screen either.
  camFresh = cam.seq !== seenCamSeq;
  seenCamSeq = cam.seq;
  const subs = frameSubs;
  if (!subs.length || !map) return;
  readFrameSize();
  const pad = cameraInsets();
  sigAt = 0;
  sigDiff = frameForce;
  frameForce = false;
  sigPut(camFresh ? 1 : 0);
  for (let i = 0; i < 16; i++) sigPut(cam.m[i]);
  sigPut(cam.globe ? 1 : 0);
  if (cam.globe) {
    for (let i = 0; i < 16; i++) sigPut(cam.g2m[i]);
    sigPut(cam.t);
    sigPut(cam.cx);
    sigPut(cam.cy);
    sigPut(cam.r);
  }
  sigPut(plateauWall.rise);
  sigPut(plateauWall.rimVersion);
  sigPut(plateauWall.slabVersion);
  sigPut(plateauWall.slabPresence);
  sigPut(frameW);
  sigPut(frameH);
  if (pad) {
    sigPut(pad.top);
    sigPut(pad.bottom);
    sigPut(pad.left);
    sigPut(pad.right);
  }
  if (!sigDiff) {
    framesSkipped++;
    return;
  }
  fillFrame(frameBuf, camFresh, pad);
  framesSent++;
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (!s.live) continue;
    // Inside mapbox's frame: a throwing subscriber must not abort the rest of it.
    try {
      s.cb(frameBuf.frame);
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[plateau] frame subscriber failed:", err);
    }
  }
}

/** Subscribe to the plateau's frames; the first arrives with the next render. */
function onFrame(cb: (f: PlateauFrame) => void): () => void {
  const sub = { cb, live: true };
  frameSubs = [...frameSubs, sub];
  frameForce = true; // even if nothing has moved since the last frame sent
  map?.triggerRepaint();
  return () => {
    if (!sub.live) return;
    sub.live = false;
    frameSubs = frameSubs.filter((s) => s !== sub);
  };
}

// ---- What the slabs hide on screen ------------------------------------------
// A raised piece hides what is behind it: the map's pins, HTML over the canvas,
// are hidden there (hidePinsUnderSlabs) and nothing is picked there (unitAt) —
// under a glass lid too, which shows the map only blurred. Read off the pieces
// as the layer drew them in the last frame, with the frame bus's own
// projection (projectInto: exactly). A box (the label's, the plaque, the bar):
// its lid, its foot and the walls between — the near one shows under the
// lid's edge, the taller the closer. The ring: its box's plane at RING_LEVELS
// heights from the ground to the lid, a point on it wherever one of them has
// it between the ring's hole and its picked part's outer edge (its walls stand
// between those planes, a pixel or so apart; the gaps between its parts, a
// pixel, count as ring).
/** Per box: its lid's corners (NW, NE, SE, SW), then its foot's; px. */
const slabShapes = [new Float32Array(16), new Float32Array(16), new Float32Array(16)];
const slabShapeLids = slabShapes.map((s) => s.subarray(0, 8));
const slabShapeFeet = slabShapes.map((s) => s.subarray(8, 16));
const slabShapeOk = new Uint8Array(4);
/** A box's faces, by corner (0–3 its lid's, 4–7 its foot's): lid, foot, walls. */
const SLAB_FACES = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
] as const;
const RING_LEVELS = 5;
/** The ring's box's plane at each level, ground to lid: its projective map
 *  (see homography), and those levels' corners' box on screen, px. */
const ringPlanes = Array.from({ length: RING_LEVELS }, () => new Float64Array(8));
const ringQuad = new Float32Array(8);
const ringScreen = { x0: 0, y0: 0, x1: 0, y1: 0 };
const ringPt = [0, 0];
/** What slabsOnScreen found: how many boxes, whether the ring. */
let shapesOn = 0;
let ringOn = false;

/** The pieces on screen (into slabShapes, ringPlanes): how many (0: none). As
 *  they stand, from the moment they are built to the moment they go — their
 *  rise and sink are a few hundred milliseconds, and nothing would come back
 *  to look once over. */
function slabsOnScreen(): number {
  const layer = plateauWall;
  shapesOn = 0;
  ringOn = false;
  if (!layer.slabQuads.length || !(layer.cam.seq > 0) || !camFresh) return 0;
  readFrameSize();
  const lift = layer.slabHeightM * WALL_OVERSHOOT;
  const ok = slabShapeOk;
  const all = () => (ok[0] & ok[1] & ok[2] & ok[3]) === 1;
  for (const q of layer.slabQuads) {
    if (q.name === "ring") {
      ringOn = ringOnScreen(q, lift);
      continue;
    }
    if (shapesOn >= slabShapes.length) continue;
    layer.projectInto(
      layer.slabCorners,
      4,
      lift,
      frameW,
      frameH,
      slabShapeLids[shapesOn],
      ok,
      q.at,
    );
    if (!all()) continue;
    layer.projectInto(layer.slabCorners, 4, 0, frameW, frameH, slabShapeFeet[shapesOn], ok, q.at);
    if (!all()) continue;
    shapesOn++;
  }
  return shapesOn + (ringOn ? 1 : 0);
}

/** The ring's box `q` at each level (see ringPlanes): false if any is off. */
function ringOnScreen(q: SlabQuad, lift: number): boolean {
  const layer = plateauWall;
  if (!layer.slabRingCover) return false;
  const ok = slabShapeOk;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < RING_LEVELS; k++) {
    const alt = (lift * k) / (RING_LEVELS - 1);
    layer.projectInto(layer.slabCorners, 4, alt, frameW, frameH, ringQuad, ok, q.at);
    if (!(ok[0] & ok[1] & ok[2] & ok[3])) return false;
    if (!homography(ringQuad, q.w, q.h, ringPlanes[k])) return false;
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, ringQuad[i]);
      x1 = Math.max(x1, ringQuad[i]);
      y0 = Math.min(y0, ringQuad[i + 1]);
      y1 = Math.max(y1, ringQuad[i + 1]);
    }
  }
  ringScreen.x0 = x0;
  ringScreen.y0 = y0;
  ringScreen.x1 = x1;
  ringScreen.y1 = y1;
  return true;
}

/** Whether screen point (x, y) is on a piece slabsOnScreen found: on a face
 *  of a box (each convex on screen, turning either way), or on the ring. */
function onSlab(x: number, y: number): boolean {
  for (let i = 0; i < shapesOn; i++) {
    const p = slabShapes[i];
    for (const f of SLAB_FACES) {
      let sign = 0;
      let inside = true;
      for (let k = 0; k < 4 && inside; k++) {
        const a = 2 * f[k];
        const b = 2 * f[(k + 1) % 4];
        const cross = (p[b] - p[a]) * (y - p[a + 1]) - (p[b + 1] - p[a + 1]) * (x - p[a]);
        if (cross === 0) continue;
        const s = cross > 0 ? 1 : -1;
        if (sign && s !== sign) inside = false;
        sign = s;
      }
      if (inside) return true;
    }
  }
  const ring = plateauWall.slabRingCover;
  if (ringOn && ring) {
    for (const m of ringPlanes) {
      if (!unapplyHomography(m, x, y, ringPt)) continue;
      const d = Math.hypot(ringPt[0] - ring.c, ringPt[1] - ring.c);
      if (d >= ring.rIn && d <= ring.rOut) return true;
    }
  }
  return false;
}

/**
 * Per piece slabsOnScreen found: the lng/lat box of the ground a lieu dot can
 * stand on and still be drawn on it — what is seen within its box on screen,
 * out by a dot's radius, from the flat ground up to the plateau's lid (a dot
 * stands on the one, or under the other). That takes in the slab's lift and
 * the tilt (its lid is seen over ground farther off), at any bearing, and a
 * dot on the plateau in front of the slab as well as behind it. Null
 * (anywhere) where groundSeenIn has no box.
 */
function slabDotBoxes(): (Bounds | null)[] {
  const layer = plateauWall;
  // The lid's height in mercator, where it is greatest: z per metre grows
  // toward the pole, so at the rim's poleward-most sample. A dot, though,
  // stands on mapbox's terrain, raised (as a marker is) by the z per metre at
  // the camera centre's latitude, not its own — beyond the rim's once the map
  // is panned poleward of the plateau: the greater of the two.
  let zPerM = map ? mapboxgl.MercatorCoordinate.fromLngLat(map.getCenter(), 1).z : 0;
  for (let i = 0; i < layer.rimCount; i++) zPerM = Math.max(zPerM, layer.rim[i * STRIDE + 2]);
  const top = layer.heightM * WALL_OVERSHOOT * zPerM;
  const r = DOT_RADIUS_PX;
  const boxes: (Bounds | null)[] = [];
  for (let i = 0; i < shapesOn; i++) {
    const p = slabShapes[i];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < p.length; k += 2) {
      x0 = Math.min(x0, p[k]);
      x1 = Math.max(x1, p[k]);
      y0 = Math.min(y0, p[k + 1]);
      y1 = Math.max(y1, p[k + 1]);
    }
    boxes.push(groundSeenIn(x0 - r, y0 - r, x1 + r, y1 + r, top));
  }
  if (ringOn) {
    const b = ringScreen;
    boxes.push(groundSeenIn(b.x0 - r, b.y0 - r, b.x1 + r, b.y1 + r, top));
  }
  return boxes;
}

/** Whether a dot at (lng, lat) may be drawn on a slab: within one of `boxes`
 *  (slabDotBoxes). */
function mayBeUnderSlab(boxes: (Bounds | null)[], lng: number, lat: number): boolean {
  for (const b of boxes) {
    if (!b || (lng >= b.minLng && lng <= b.maxLng && lat >= b.minLat && lat <= b.maxLat)) {
      return true;
    }
  }
  return false;
}

/**
 * The lng/lat box of what is seen within the screen box [x0, x1] × [y0, y1],
 * from the flat ground (z = 0) up to mercator height `top`, with the camera of
 * the last frame drawn: projectInto's mercator matrix, solved on both planes
 * for each corner. A box on screen sees a convex quad of a plane, which its
 * corners bound, and a corner's point runs straight along its ray from one
 * plane to the other: the 8 bound every height between. Null on the globe (no
 * such plane: every dot is looked at there, and few show — the open lieu's,
 * the results'), or for a box reaching past the horizon.
 */
function groundSeenIn(x0: number, y0: number, x1: number, y1: number, top: number): Bounds | null {
  const { m, globe } = plateauWall.cam;
  if (globe) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sx of [x0, x1]) {
    for (const sy of [y0, y1]) {
      const nx = (2 * sx) / frameW - 1;
      const ny = 1 - (2 * sy) / frameH;
      const a = m[0] - nx * m[3];
      const b = m[4] - nx * m[7];
      const d = m[1] - ny * m[3];
      const e = m[5] - ny * m[7];
      const det = a * e - b * d;
      for (const z of [0, top]) {
        // M·[x, y, z, 1] lands on (nx, ny): two linear equations in x, y.
        const wz = m[11] * z + m[15];
        const c = nx * wz - (m[8] * z + m[12]);
        const f = ny * wz - (m[9] * z + m[13]);
        const x = (c * e - b * f) / det;
        const y = (a * f - c * d) / det;
        // Behind the camera (w ≤ 0): the corner is above the horizon.
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(m[3] * x + m[7] * y + wz > 0)) {
          return null;
        }
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minLng: lngOf(minX), maxLng: lngOf(maxX), minLat: latOf(maxY), maxLat: latOf(minY) };
}

/** DEV probe (window.__acFrame): a copy of the frame as it stands now, and a
 *  cross-check against mapbox's own projection on the rim. In mercator
 *  map.project adds the terrain sampled under the point, which the eroded DEM
 *  keeps at ~0 on the rim itself — so there `base` should match map.project(ll)
 *  and `top` map.project(ll, lidAltM) to within a pixel or so. On the globe
 *  map.project adds the centre's altitude instead: expect a drift there. */
function probeFrame() {
  if (!map) return null;
  const buf = makeFrameBuf();
  readFrameSize();
  fillFrame(buf, plateauWall.cam.seq > 0 && camFresh, cameraInsets());
  const f = buf.frame;
  const lidAltM = plateauWall.heightM * WALL_OVERSHOOT * plateauWall.rise;
  let checked = 0;
  let baseMax = 0;
  let topMax = 0;
  let baseSum = 0;
  let topSum = 0;
  for (let i = 0; i < f.n; i++) {
    if (!f.ok[i]) continue;
    const o = i * STRIDE;
    const ll: [number, number] = [plateauWall.rim[o + 9], plateauWall.rim[o + 10]];
    const pb = map.project(ll);
    const pt = map.project(ll, lidAltM);
    if (Math.abs(pb.x) > 1e6 || Math.abs(pt.x) > 1e6) continue;
    const db = Math.hypot(pb.x - f.base[2 * i], pb.y - f.base[2 * i + 1]);
    const dt = Math.hypot(pt.x - f.top[2 * i], pt.y - f.top[2 * i + 1]);
    checked++;
    baseSum += db;
    topSum += dt;
    baseMax = Math.max(baseMax, db);
    topMax = Math.max(topMax, dt);
  }
  const cam = plateauWall.cam;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    scopeId: f.scopeId,
    rise: round(f.rise),
    heightM: round(plateauWall.heightM),
    lidAltM: round(lidAltM),
    w: f.w,
    h: f.h,
    pitch: round(f.pitch),
    bearing: round(f.bearing),
    zoom: round(f.zoom),
    centre: [round(f.centre[0]), round(f.centre[1])],
    regime: cam.globe ? `globe(t=${cam.t.toFixed(2)})` : "mercator",
    n: f.n,
    valid: f.ok.reduce((a, v) => a + v, 0),
    box: f.box && {
      minX: round(f.box.minX),
      minY: round(f.box.minY),
      maxX: round(f.box.maxX),
      maxY: round(f.box.maxY),
    },
    top: Array.from(f.top, round),
    base: Array.from(f.base, round),
    ok: Array.from(f.ok),
    slabs: {
      scopeId: f.slabs.scopeId,
      rise: round(f.slabs.rise),
      version: f.slabs.version,
      ...Object.fromEntries(
        (["ring", "label", "plaque"] as const).map((k) => {
          const b = f.slabs[k];
          return [k, b && { w: b.w, h: b.h, ok: b.ok, lid: Array.from(b.lid, round) }];
        }),
      ),
    },
    subscribers: frameSubs.length,
    framesSent,
    framesSkipped,
    vsMapProject: {
      checked,
      baseMeanPx: checked ? round(baseSum / checked) : null,
      baseMaxPx: round(baseMax),
      topMeanPx: checked ? round(topSum / checked) : null,
      topMaxPx: round(topMax),
    },
  };
}

// Snapshot the PURE basemap over the selection and hand it to the lid (outlines
// are drawn over it as constant-width GL vector lines, not baked). Fire-and-forget:
// the plateau rises on the draped terrain as before; when the snapshot lands (and
// the selection hasn't changed) the lid appears and fills the rim gap with
// identical map content — no visible pop.
// The lid is a FIXED-resolution snapshot of the selection's bounds, so raising a
// whole région froze its top at ~z8 detail: zooming in showed no more map until
// you drilled a level down. These track the current texture's ground resolution
// so the lid can be re-captured over the visible part as the camera closes in —
// fragments outside a capture discard and fall back to the draped terrain, which
// is still the real map, so a tighter texture is always safe.
const EARTH_CIRCUMFERENCE_M = 40075016.686;
let lidMpp = Infinity; // metres per texel of the lid currently displayed
let lidPx = 0; // backing-store width the current lid was captured at
let lidRaised: OutlineFC["features"] = [];
let lidCaptureInFlight = false;
let lidRecaptureTimer: ReturnType<typeof setTimeout> | null = null;
// Bounds the current (or in-flight) lid texture covers. Guards against
// re-shooting a texture we already have — snapshotMgr.capture() bumps its own
// seq, so a redundant capture CANCELS an in-flight refine and then overwrites
// lidMpp with the coarse full-selection value, which is exactly what made
// zooming appear to never sharpen.
let lidTargetKey = "";
// Geographic rectangle the current lid texture covers — the lid discards outside
// it, so the visible plateau must stay inside this or the wall shows through.
let lidCovered: Bounds | null = null;
// Diagnostic for __acPlateau(): the lid is coarser than the screen, but the
// rectangle a refine would capture is no smaller than the one we already have,
// so re-shooting would not sharpen anything.
let lidRefineBlockedByGain = false;
const boundsKey = (b: Bounds) =>
  `${b.minLat.toFixed(4)},${b.maxLat.toFixed(4)},${b.minLng.toFixed(4)},${b.maxLng.toFixed(4)}`;
// Re-capture once the lid is this much coarser than the screen, or this much
// finer (zoomed back out, so the crisp patch no longer covers the view).
// 1.3, not 2: a texture coarser than the screen is visibly soft, and at 2× a
// département's lid (~46 m/texel) stayed blurry until the view dropped under
// ~23 km — roughly two zoom levels of "zooming does nothing", which is exactly
// the reported symptom. A refine lands at ~0.73× the screen resolution, so 1.3
// is still comfortably clear of a re-trigger (no thrash).
const LID_REFINE_RATIO = 1.3;
const LID_WIDEN_RATIO = 4;
// Fraction of the visible slice added on each side of a refine capture.
const LID_MARGIN = 0.35;

/** Ground metres spanned by the LONGER side of `b` — what the square capture fits. */
function boundsGroundSpanM(b: Bounds): number {
  const lat = (b.minLat + b.maxLat) / 2;
  const wM =
    ((b.maxLng - b.minLng) / 360) * EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
  const hM = ((b.maxLat - b.minLat) / 360) * EARTH_CIRCUMFERENCE_M;
  return Math.max(wM, hM);
}

/**
 * Backing-store pixels the capture of `b` needs to resolve as finely as the
 * screen: span / px <= metres-per-device-pixel. Demand-driven on purpose — it
 * scales down on a phone and up on a large HiDPI display, and SnapshotManager
 * clamps it by the device's memory tier and GL_MAX_TEXTURE_SIZE.
 */
function lidPixelBudget(b: Bounds): number {
  const mpp = viewMpp();
  if (!Number.isFinite(mpp) || mpp <= 0) return 2048;
  return Math.ceil(boundsGroundSpanM(b) / mpp);
}

/** Ground metres per texel of a snapshot. */
function snapshotMpp(snap: Snapshot, b: Bounds): number {
  const lat = (b.minLat + b.maxLat) / 2;
  const groundSpanM = snap.merc.spanX * EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
  return groundSpanM / snap.bitmap.width;
}

/**
 * Ground metres per screen pixel at the current camera — DEVICE pixels, to match
 * `snapshotMpp`, which divides by the snapshot's backing-store width.
 *
 * This used `clientWidth` (CSS pixels), so on a HiDPI display the screen looked
 * `devicePixelRatio`× coarser than it is and the lid read as sharp enough when it
 * was not: at dpr 2 the refine threshold was effectively 2.6, not 1.3, and the
 * plateau top stayed visibly softer than the live map around it.
 */
function viewMpp(): number {
  if (!map) return Infinity;
  const b = map.getBounds();
  const w = map.getCanvas().width;
  if (!b || !w) return Infinity;
  const lat = (b.getNorth() + b.getSouth()) / 2;
  const spanM =
    ((b.getEast() - b.getWest()) / 360) * EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
  return spanM / w;
}

async function captureLid(seq: number, raised: OutlineFC["features"], over?: Bounds) {
  const shot = over ?? boundsOfFeatures(raised);
  if (!shot) return;
  // "Carte" (DEV): the slabs' lids show the snapshot too.
  const b = lidExtra ? unionBounds(shot, lidExtra) : shot;
  // Resolve the pixel budget HERE so it can go in the identity key below: the
  // same rectangle at a bigger budget is a genuinely sharper texture, and
  // keying on bounds alone would suppress that re-capture as a duplicate.
  const px = snapshotMgr.pixelBudget(lidPixelBudget(b), plateauWall.maxTextureSize);
  // Already showing (or fetching) exactly this rectangle at this resolution →
  // don't cancel it to re-shoot the same thing.
  const key = `${boundsKey(b)}@${px}`;
  if (key === lidTargetKey && Number.isFinite(lidMpp)) return;
  lidTargetKey = key;
  lidCaptureInFlight = true;
  try {
    const snap = await snapshotMgr.capture(STYLE, b, px, plateauWall.maxTextureSize);
    if (!snap) return;
    if (seq !== plateauSeq) {
      snap.bitmap.close();
      return;
    }
    lidMpp = snapshotMpp(snap, b);
    lidPx = snap.bitmap.width;
    lidCovered = b;
    lidRaised = raised;
    plateauWall.setLidTexture(snap);
  } catch {
    /* no lid → status quo (walls + draped terrain) */
  } finally {
    lidCaptureInFlight = false;
  }
}

/**
 * Keep the lid's resolution in step with the camera. Called (debounced) after a
 * gesture settles: if the texture is much coarser than the screen, re-capture
 * over the visible slice of the selection; if the camera pulled far back, widen
 * to the whole selection again.
 */
function refreshLidForZoom() {
  if (!map || !plateauActive || !lidRaised.length) return;
  // A capture is running — come back rather than dropping this refine on the
  // floor (the old code returned here and only retried on the NEXT gesture,
  // so a refine lost to the initial capture never happened at all).
  if (lidCaptureInFlight) {
    scheduleLidRefresh();
    return;
  }
  const own = boundsOfFeatures(lidRaised);
  if (!own) return;
  const sel = lidExtra ? unionBounds(own, lidExtra) : own;
  const mpp = viewMpp();
  if (!Number.isFinite(mpp)) return;

  const v = map.getBounds();
  if (!v) return;
  // The visible slice of the selection — the region the lid MUST cover, because
  // the lid shader discards fragments outside the captured rectangle and the
  // hole shows the far wall's inner face straight through the plateau top.
  const clip = {
    minLat: Math.max(sel.minLat, v.getSouth()),
    maxLat: Math.min(sel.maxLat, v.getNorth()),
    minLng: Math.max(sel.minLng, v.getWest()),
    maxLng: Math.min(sel.maxLng, v.getEast()),
  };
  if (clip.minLat >= clip.maxLat || clip.minLng >= clip.maxLng) return; // selection off-screen
  // Generous margin: a capture takes ~1 s, so the texture must already cover
  // where the camera is heading, not just where it is. Doubling the slice keeps
  // ordinary pans and a zoom step inside the existing texture instead of
  // punching a transient hole in the plateau.
  const padLat = (clip.maxLat - clip.minLat) * LID_MARGIN;
  const padLng = (clip.maxLng - clip.minLng) * LID_MARGIN;
  const want: Bounds = {
    minLat: Math.max(sel.minLat, clip.minLat - padLat),
    maxLat: Math.min(sel.maxLat, clip.maxLat + padLat),
    minLng: Math.max(sel.minLng, clip.minLng - padLng),
    maxLng: Math.min(sel.maxLng, clip.maxLng + padLng),
  };

  // Re-capture when the texture is too coarse for the screen, when the camera
  // pulled far enough back that a tight texture is wasteful — OR, the case the
  // resolution test alone missed, when the visible plateau has moved OUTSIDE
  // what the texture covers (a pan at constant zoom, or a fast zoom-out).
  const covers =
    lidCovered !== null &&
    clip.minLat >= lidCovered.minLat &&
    clip.maxLat <= lidCovered.maxLat &&
    clip.minLng >= lidCovered.minLng &&
    clip.maxLng <= lidCovered.maxLng;
  // A capture is a fixed pixel budget over whatever rectangle we ask for, so a
  // re-shoot only sharpens if the new rectangle is genuinely SMALLER than the
  // current one. Comparing against the screen alone is canvas-dependent — on a
  // wide display the snapshot can never beat it, and every settle would fire a
  // fresh capture forever. Requiring a real improvement makes this self-limiting.
  const spanOf = (b: Bounds) => {
    const cos = Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180) || 1e-6;
    return Math.max((b.maxLng - b.minLng) * cos, b.maxLat - b.minLat);
  };
  const gain = lidCovered ? spanOf(lidCovered) / Math.max(spanOf(want), 1e-9) : Infinity;
  const tooCoarse = lidMpp > mpp * LID_REFINE_RATIO;
  const wantsFiner = tooCoarse && gain >= LID_REFINE_RATIO;
  lidRefineBlockedByGain = tooCoarse && !wantsFiner;
  const tooFine = lidMpp * LID_WIDEN_RATIO < mpp;
  if (covers && !wantsFiner && !tooFine) return;
  // Uncovered or zoomed back out → the whole unit; otherwise the padded slice.
  void captureLid(plateauSeq, lidRaised, tooFine || !covers ? sel : want);
}

function scheduleLidRefresh() {
  if (lidRecaptureTimer) clearTimeout(lidRecaptureTimer);
  lidRecaptureTimer = setTimeout(() => {
    lidRecaptureTimer = null;
    refreshLidForZoom();
  }, 350);
}

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
    lidMpp = Infinity;
    lidPx = 0;
    lidRaised = [];
    lidTargetKey = "";
    lidCovered = null;
    lidRefineBlockedByGain = false;
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
  if (changed || !Number.isFinite(lidMpp)) void captureLid(seq, raised);
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
    globe: globeStyle,
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
  if (lidExtra && !(lidCovered && boundsContain(lidCovered, lidExtra))) {
    const whole = boundsOfFeatures(plateauRaised);
    if (whole) {
      lidTargetKey = "";
      void captureLid(plateauSeq, plateauRaised, unionBounds(whole, lidExtra));
    }
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

// ---- Grey outside the selection: state shared by both renderers ----------------
// The draped (globe) sheet: which selection its GeoJSON source holds ([] =
// empty), and whether its layer is opaque right now.
let drapedGeoms: MaskGeom[] = [];
let drapedShown = false;
// Whether the style renders a globe at all (decided once the style is loaded).
let globeStyle = false;

/**
 * The draped sheet covers the world. On the globe a lat/lng rectangle cannot
 * describe what is on screen — the visible region is a spherical cap, not a box
 * — so there is no smaller rectangle to compute; `maskRing` densifies this one
 * so its size costs nothing in tessellation quality.
 */
const WORLD_RECT: Bounds = { minLat: -85, maxLat: 85, minLng: -180, maxLng: 180 };

/**
 * Ring for `b`, carrying intermediate vertices rather than just four corners.
 *
 * A straight edge between two distant corners is drawn straight in SCREEN space,
 * so on the globe it cuts across the sphere instead of following it — that is
 * what turned the very first world-sized mask into flat angular slabs. Short
 * edges track the curvature closely enough to be invisible (~260 points).
 */
function maskRing(b: Bounds): [number, number][] {
  const STEP_DEG = 4;
  const pts: [number, number][] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / STEP_DEG));
    for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  };
  edge(b.minLng, b.minLat, b.maxLng, b.minLat);
  edge(b.maxLng, b.minLat, b.maxLng, b.maxLat);
  edge(b.maxLng, b.maxLat, b.minLng, b.maxLat);
  edge(b.minLng, b.maxLat, b.minLng, b.minLat);
  pts.push([b.minLng, b.minLat]); // close
  return pts;
}

/** The draped sheet for `geoms`: the world, minus their outer rings. */
function worldMaskData(geoms: MaskGeom[]): GeoJSON.FeatureCollection {
  // Outer rings become holes in the grey; a selection's INNER rings are enclaves
  // of some other unit (the Enclave des Papes is Vaucluse, wholly surrounded by
  // Drôme), which the plateau leaves un-raised — so they have to be greyed back
  // in. A flat ring list cannot express that nesting: everything after the first
  // ring is a hole, so an enclave ring added there would cut MORE out. They go in
  // as separate polygons of a MultiPolygon instead, each sitting exactly inside a
  // hole, so nothing overlaps and no area is double-darkened.
  const holes: [number, number][][] = [];
  const enclaves: [number, number][][] = [];
  const addRings = (rings: [number, number][][]) => {
    if (!rings?.[0]?.length) return;
    holes.push(rings[0]);
    for (let i = 1; i < rings.length; i++) if (rings[i]?.length) enclaves.push(rings[i]);
  };
  for (const g of geoms) {
    if (g.type === "Polygon") {
      addRings(g.coordinates as [number, number][][]);
    } else if (g.type === "MultiPolygon") {
      for (const poly of (g.coordinates as [number, number][][][]) ?? []) addRings(poly);
    }
  }
  if (!holes.length) return EMPTY_FC as unknown as GeoJSON.FeatureCollection;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "MultiPolygon",
          coordinates: [[maskRing(WORLD_RECT), ...holes], ...enclaves.map((e) => [e])],
        },
      },
    ],
  } as unknown as GeoJSON.FeatureCollection;
}

/**
 * Grey outside the plateau, cut around the current selection.
 *
 * Keyed on `plateauActive` (and held as-is while the next scope's boundary is
 * still loading). The hole is what keeps the selection clear, so this needs
 * nothing from the lid: in the flat view the sheet is re-cut right here,
 * synchronously, and clicking a zone colours it in that frame.
 */
function applyMask() {
  const src = map?.getSource(MASK_SOURCE) as mapboxgl.GeoJSONSource | undefined;
  if (!src) return;
  const geoms: MaskGeom[] = [];
  if (plateauActive) {
    for (const f of props.outline?.features ?? []) {
      if (f.properties?.kind !== "scope") continue;
      const g = f.geometry as MaskGeom | undefined;
      if (g?.type === "Polygon" || g?.type === "MultiPolygon") geoms.push(g);
    }
    // The new scope's boundary is still loading: ensurePlateau keeps the old
    // plateau standing meanwhile, so keep the grey that is up too (normally cut
    // around that plateau). Clearing it here would flash the whole map in full
    // colour until the geometry arrives.
    if (!geoms.length && props.scopePending) return;
  }
  scopeTint.setSelection(geoms);
  // The globe's sheet always holds the current selection, whatever the zoom:
  // re-tiling only costs anything while its tiles are loaded (MASK_ARM_ZOOM), and
  // having the data already indexed is what lets those tiles appear in time
  // when a fast zoom-out or a flight heads for the globe.
  if (!sameGeoms(geoms, drapedGeoms)) {
    drapedGeoms = geoms;
    src.setData(worldMaskData(geoms));
  }
  syncDrapedMask();
}

/**
 * Show the draped sheet on the globe and hide it everywhere else — the mirror
 * image of ScopeTintLayer, which draws in the flat view only.
 *
 * Called from `move`, it predicts the projection mapbox is about to render with
 * (same rule, same zoom) so that the opacity lands in the very frame the tint
 * starts or stops: `move` fires before mapbox restyles and paints. `regime` is
 * the projection a frame was ACTUALLY drawn with, reported by the tint layer —
 * the correction if the prediction was ever wrong (the zoom can be nudged
 * without a `move`, e.g. when a drag ends over the plateau).
 */
function syncDrapedMask(regime?: boolean) {
  if (!map) return;
  // On every `move`, so the common case must stay this cheap: a zoom read and a
  // comparison. (Both flags are false until setupOutline has added the layer.)
  const show = regime ?? (globeStyle && map.getZoom() < GLOBE_MAX_ZOOM);
  if (show === drapedShown) return;
  try {
    map.setPaintProperty(MASK_LAYER, "fill-opacity", show ? MASK_OPACITY : 0);
    drapedShown = show;
  } catch {
    // The style is mid-reload: leave the flag as it was so the next call retries.
  }
}

function applyOutline() {
  // The outline source only feeds the draped hover-fill fallback now — the
  // boundary LINES are GL geometry rebuilt by ensurePlateau (line widths are
  // per-feature, derived from `level` inside setGeometry).
  const src = map?.getSource(OUTLINE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
  src?.setData((props.outline ?? EMPTY_FC) as unknown as GeoJSON.FeatureCollection);
}

function emitView() {
  if (!map) return;
  // Report the VISIBLE rectangle (canvas minus the panel), so scope derivation
  // measures span against what the user actually sees beside the panel.
  const vb = visibleBounds(0);
  if (!vb) return;
  emit("viewChange", {
    zoom: map.getZoom(),
    center: [(vb.minLat + vb.maxLat) / 2, (vb.minLng + vb.maxLng) / 2],
    bounds: vb,
    screen: screenBounds() ?? vb,
    insets: viewInsets(),
    byUser: userHolding,
  });
}

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
      const vm = viewMpp();
      return {
        zoom: map ? +map.getZoom().toFixed(2) : null,
        terrainActive: !!map?.getTerrain(),
        plateauActive,
        scope: plateauScopeId,
        demSource: terrainSrc,
        demMaxzoom: (map?.getStyle().sources?.[terrainSrc] as { maxzoom?: number })?.maxzoom,
        dpr: window.devicePixelRatio || 1,
        canvasDevicePx: map?.getCanvas().width ?? null,
        // Backing-store width the lid was captured at, vs what the current view
        // would ask for and what the device/GL actually allow.
        lidTexturePx: lidPx || null,
        lidTexturePxWanted: lidCovered ? lidPixelBudget(lidCovered) : null,
        lidTexturePxAllowed: lidCovered
          ? snapshotMgr.pixelBudget(lidPixelBudget(lidCovered), plateauWall.maxTextureSize)
          : null,
        glMaxTextureSize: plateauWall.maxTextureSize,
        metresPerDevicePixel: +vm.toFixed(2),
        metresPerLidTexel: Number.isFinite(lidMpp) ? +lidMpp.toFixed(2) : null,
        // >1 means the lid is COARSER than the screen (blurry top).
        lidCoarserThanScreenBy: Number.isFinite(lidMpp) ? +(lidMpp / vm).toFixed(2) : null,
        lidCovers: boundsOfFeatures(lidRaised),
        // True when the lid IS too coarse but a refine cannot help: a capture is
        // a fixed pixel budget over whatever rectangle we ask for, so it only
        // sharpens if that rectangle shrinks — and there is nothing to shrink to
        // while the whole selection is on screen. Separates "the refine never
        // fired" from "the lid is capped at selectionSpan / SNAP_PX".
        lidRefineBlockedByGain,
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
      setupOutline();
      applyOutline();
      applyMask();
      buildMarkers();
      snapshotMgr.warmup(STYLE); // hidden lid-snapshot map: pay style init now
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
    // again for custom layers. Its own layers recover by themselves — the draped
    // grey used to — so without this the flat view would stay un-greyed until a
    // reload.
    map.on("webglcontextrestored", () => {
      const gl = map?.getCanvas().getContext("webgl2");
      if (map && gl) scopeTint.onAdd(map, gl);
    });
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
    map.on("render", emitFrame);
    if (import.meta.env.DEV) {
      (window as unknown as { __acFrame?: () => unknown }).__acFrame = probeFrame;
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
      if (box) {
        roW = box.width;
        roH = box.height;
      }
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
  snapshotMgr.destroy();
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
  for (const s of frameSubs) s.live = false;
  frameSubs = [];
  if (import.meta.env.DEV) {
    const w = window as unknown as { __acFrame?: () => unknown };
    if (w.__acFrame === probeFrame) delete w.__acFrame;
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
  onFrame,
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
