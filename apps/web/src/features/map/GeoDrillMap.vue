<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import mapboxgl from "mapbox-gl";
import type * as GeoJSON from "geojson";
import earcut, { flatten } from "earcut";
import { FRANCE_CENTER } from "@ac/shared";
import type { Bounds } from "@/features/geo";
import { SnapshotManager, type Snapshot } from "./plateau/mapSnapshot";
import {
  FIT_PITCH_DEG,
  fitSilhouette,
  homography,
  latOf,
  lngOf,
  pieceOutline,
  ringSectorArcs,
  slabPointPx,
  slabRects,
  solveSlabScales,
  unapplyHomography,
  type FitShape,
  type PieceBox,
  type SlabCam,
  type SlabRect,
  type SlabScales,
} from "./lib/slabs";
import type {
  CameraCmd,
  MapUnit,
  OutlineFC,
  PlateauFrame,
  SlabFrame,
  SlabSpec,
  SlabThemesSpec,
} from "./types";
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
const MASK_OPACITY = 0.5;
// What MASK_COLOR looks like ON SCREEN. The draped fill is lit by the Standard
// style's lights when the terrain is composited, which warms it; the GL sheet is
// drawn straight to the framebuffer and gets no lighting, so it has to output
// the lit result to look the same (and to make the globe ↔ flat handover
// invisible). Measured by sampling the same pixels with the draped mask on and
// off, then matched against the GL sheet to within ~1/255 per channel. If the
// style's lighting ever changes, re-measure — a mismatch shows as a colour step
// when the zoom crosses GLOBE_MAX_ZOOM. (Same caveat for a style colour theme:
// the GL sheet takes this colour and the fog's as-is, without the theme's LUT.)
const TINT_RGB = [144, 131, 122] as const;
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
// being reached: the halo's self-scheduled frames stop (as for a hidden tab),
// and start again once it is back on screen.
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
// Polygon rings precompiled to flat typed arrays (plus a bbox each): hover
// hit-testing runs per mouse move, and traversing nested GeoJSON arrays over
// commune-precision contours is too slow for that.
interface HitRing {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
  xs: Float64Array;
  ys: Float64Array;
}
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

// Flatten a (multi)polygon's rings into typed arrays with per-ring bboxes, for
// fast per-mousemove hit testing. Skipping a ring whose bbox misses the point is
// parity-safe (such a ring contributes an even crossing count).
function buildHitRings(geometry: unknown): HitRing[] {
  const out: HitRing[] = [];
  for (const poly of polysOf(geometry as { type?: string })) {
    for (const ring of poly) {
      const n = ring.length;
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      let minLng = 180;
      let maxLng = -180;
      let minLat = 90;
      let maxLat = -90;
      for (let i = 0; i < n; i++) {
        const x = ring[i][0];
        const y = ring[i][1];
        xs[i] = x;
        ys[i] = y;
        if (x < minLng) minLng = x;
        if (x > maxLng) maxLng = x;
        if (y < minLat) minLat = y;
        if (y > maxLat) maxLat = y;
      }
      out.push({ minLng, maxLng, minLat, maxLat, xs, ys });
    }
  }
  return out;
}

function hitTest(rings: HitRing[], lng: number, lat: number): boolean {
  let inside = false;
  for (const r of rings) {
    if (lng < r.minLng || lng > r.maxLng || lat < r.minLat || lat > r.maxLat) continue;
    const xs = r.xs;
    const ys = r.ys;
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const yi = ys[i];
      const yj = ys[j];
      if (yi > lat !== yj > lat) {
        const xi = xs[i];
        const xj = xs[j];
        if (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng
  );
}

/** A ring's box, once per ring (boundary geometries are identity-stable, see
 *  the per-geometry caches below). */
const ringBoundsCache = new WeakMap<object, Bounds>();
function ringBounds(ring: number[][]): Bounds {
  let b = ringBoundsCache.get(ring);
  if (!b) {
    b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    for (const [lng, lat] of ring) {
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
      if (lng < b.minLng) b.minLng = lng;
      if (lng > b.maxLng) b.maxLng = lng;
    }
    ringBoundsCache.set(ring, b);
  }
  return b;
}

function polysOf(g: { type?: string; coordinates?: unknown }): number[][][][] {
  return (
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
  ) as number[][][][];
}

// ---- Per-geometry projection caches ----------------------------------------
// setGeometry used to re-project every boundary vertex (2× Mercator + 2× ECEF
// each) and re-run earcut + subdivision + the O(verts × edges) distance field
// on EVERY rebuild — profiled at ~28% of total scripting while panning, plus
// ~7% GC for the discarded intermediates. Both projections are LINEAR in
// altitude (merc z = alt·zPerM; ecef(alt) = ecef(0) + alt·d), so everything
// per-vertex — and every derived mesh — is cacheable per GEOMETRY OBJECT
// (boundary FCs and markRaw'd commune entries are identity-stable) with the
// height applied as a multiply-add at assembly time.
interface PBase {
  lng: number;
  lat: number;
  x: number; // mercator at ground
  y: number;
  zPerM: number; // mercator z per metre of altitude
  lo: [number, number, number]; // ecef at ground
  d: [number, number, number]; // ecef delta per metre of altitude
}

function baseOf(lng: number, lat: number): PBase {
  const m0 = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, 0);
  const m1 = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, 1);
  const ll = new mapboxgl.LngLat(lng, lat) as mapboxgl.LngLat & {
    toEcef(altM: number): [number, number, number];
  };
  const lo = ll.toEcef(0);
  const e1 = ll.toEcef(1);
  return {
    lng,
    lat,
    x: m0.x,
    y: m0.y,
    zPerM: m1.z,
    lo,
    d: [e1[0] - lo[0], e1[1] - lo[1], e1[2] - lo[2]],
  };
}

/** Ring vertices, projected once per geometry (walls, lines, halo, fill rings). */
const ringBaseCache = new WeakMap<object, PBase[][][]>();
function ringBasesOf(g: { type?: string; coordinates?: unknown }): PBase[][][] {
  let c = ringBaseCache.get(g as object);
  if (!c) {
    c = polysOf(g).map((poly) => poly.map((ring) => ring.map(([lng, lat]) => baseOf(lng, lat))));
    ringBaseCache.set(g as object, c);
  }
  return c;
}

// ---- Points followed on screen every frame (the plateau's rim) ---------------
// Packed flat, STRIDE floats per point, so following them is a pass over one
// typed array: mercator x, y, z per metre, ECEF at ground, ECEF per metre —
// everything the two projections need — then lng, lat for diagnostics.
const STRIDE = 11;
function packBase(out: Float64Array, i: number, b: PBase) {
  const o = i * STRIDE;
  out[o] = b.x;
  out[o + 1] = b.y;
  out[o + 2] = b.zPerM;
  out[o + 3] = b.lo[0];
  out[o + 4] = b.lo[1];
  out[o + 5] = b.lo[2];
  out[o + 6] = b.d[0];
  out[o + 7] = b.d[1];
  out[o + 8] = b.d[2];
  out[o + 9] = b.lng;
  out[o + 10] = b.lat;
}

// The rim is sampled, not followed vertex by vertex: ~96 points place a box and
// a leader line as well as 1700 would. Rings much smaller than the outline
// (an islet off a coast) are left out — a leader line should never land on one
// — but every ring kept gets a few points, so Corsica is never a single dot.
const RIM_SAMPLES = 96;
const RIM_MIN_PER_RING = 4;
const RIM_MIN_RING_SHARE = 0.03; // of the whole outline's bbox diagonal

/**
 * The raised unit's rim, packed (see STRIDE): the OUTER ring of each of its
 * polygons, from the per-geometry cache, so this costs no projection. Samples
 * are spaced by arc length along each ring and always include the ring's
 * extreme vertices, where a silhouette's box is decided. Each sample is a real
 * boundary vertex: exactly where the wall stands.
 */
function sampleRim(features: OutlineFC["features"]): { pack: Float64Array; count: number } {
  const rings: PBase[][] = [];
  for (const f of features) {
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!g?.type) continue;
    for (const poly of ringBasesOf(g)) {
      if (poly[0] && poly[0].length >= 4) rings.push(poly[0]);
    }
  }
  if (!rings.length) return { pack: new Float64Array(0), count: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const diags = rings.map((ring) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of ring) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
    return Math.hypot(x1 - x0, y1 - y0);
  });
  const whole = Math.hypot(maxX - minX, maxY - minY);
  const biggest = diags.indexOf(Math.max(...diags));
  const kept = rings.filter((_, i) => i === biggest || diags[i] >= RIM_MIN_RING_SHARE * whole);
  // Arc length per ring, in mercator units (proportions are all that matter).
  const lens = kept.map((ring) => {
    let s = 0;
    for (let i = 1; i < ring.length; i++) {
      s += Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y);
    }
    return s;
  });
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const picked: PBase[] = [];
  kept.forEach((ring, ri) => {
    // A closed ring repeats its first vertex last: never sample it twice.
    const a = ring[0];
    const z = ring[ring.length - 1];
    const m = a.lng === z.lng && a.lat === z.lat ? ring.length - 1 : ring.length;
    const k = Math.min(m, Math.max(RIM_MIN_PER_RING, Math.round((RIM_SAMPLES * lens[ri]) / total)));
    const idx = new Set<number>();
    let ex0 = 0;
    let ex1 = 0;
    let ey0 = 0;
    let ey1 = 0;
    for (let i = 1; i < m; i++) {
      if (ring[i].x < ring[ex0].x) ex0 = i;
      if (ring[i].x > ring[ex1].x) ex1 = i;
      if (ring[i].y < ring[ey0].y) ey0 = i;
      if (ring[i].y > ring[ey1].y) ey1 = i;
    }
    idx.add(ex0).add(ex1).add(ey0).add(ey1);
    // The vertex nearest each of k evenly spaced arc positions.
    const step = lens[ri] / k;
    let v = 0;
    let at = 0; // arc length at vertex v
    for (let j = 0; j < k; j++) {
      const target = j * step;
      while (v + 1 < m) {
        const next = at + Math.hypot(ring[v + 1].x - ring[v].x, ring[v + 1].y - ring[v].y);
        // Past the target: keep whichever end of this edge is nearer to it.
        const stop = next > target;
        if (stop && target - at <= next - target) break;
        v++;
        at = next;
        if (stop) break;
      }
      idx.add(v);
    }
    for (const i of [...idx].sort((p, q) => p - q)) picked.push(ring[i]);
  });
  const pack = new Float64Array(picked.length * STRIDE);
  picked.forEach((b, i) => packBase(pack, i, b));
  return { pack, count: picked.length };
}

/** Lid triangles per polygon (earcut + curvature subdivision), every 3 = a tri. */
const LID_MAX_EDGE_DEG = 0.3;
const lidBaseCache = new WeakMap<object, PBase[][]>();
function lidBasesOf(g: { type?: string; coordinates?: unknown }): PBase[][] {
  let cached = lidBaseCache.get(g as object);
  if (cached) return cached;
  const ringBases = ringBasesOf(g);
  cached = ringBases.map((rings) => {
    const out: PBase[] = [];
    const data = flatten(rings.map((ring) => ring.map((p) => [p.x, p.y])));
    const idx = earcut(data.vertices, data.holes, data.dimensions);
    const flat = rings.flat();
    const edgeDeg = (a: PBase, b: PBase) => {
      const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
      const dLng = (a.lng - b.lng) * cos;
      const dLat = a.lat - b.lat;
      return Math.sqrt(dLng * dLng + dLat * dLat);
    };
    const stack: [PBase, PBase, PBase][] = [];
    for (let k = 0; k < idx.length; k += 3) {
      stack.push([flat[idx[k]], flat[idx[k + 1]], flat[idx[k + 2]]]);
    }
    while (stack.length) {
      const [a, b, c] = stack.pop()!;
      const ab = edgeDeg(a, b);
      const bc = edgeDeg(b, c);
      const ca = edgeDeg(c, a);
      const longest = Math.max(ab, bc, ca);
      if (longest <= LID_MAX_EDGE_DEG) {
        out.push(a, b, c);
        continue;
      }
      if (longest === ab) {
        const m = baseOf((a.lng + b.lng) / 2, (a.lat + b.lat) / 2);
        stack.push([a, m, c], [m, b, c]);
      } else if (longest === bc) {
        const m = baseOf((b.lng + c.lng) / 2, (b.lat + c.lat) / 2);
        stack.push([b, m, a], [m, c, a]);
      } else {
        const m = baseOf((c.lng + a.lng) / 2, (c.lat + a.lat) / 2);
        stack.push([c, m, b], [m, a, b]);
      }
    }
    return out;
  });
  lidBaseCache.set(g as object, cached);
  return cached;
}

/** Hover-fill mesh (earcut + refine + boundary-distance field), per geometry. */
const fillBaseCache = new WeakMap<object, { pts: PBase[]; dNorm: number[] }>();
function fillBasesOf(g: { type?: string; coordinates?: unknown }): {
  pts: PBase[];
  dNorm: number[];
} {
  let cached = fillBaseCache.get(g as object);
  if (cached) return cached;
  const polys = polysOf(g);
  // Unit bbox → subdivision threshold + lng scale for distances.
  let mnLa = 90;
  let mxLa = -90;
  let mnLo = 180;
  let mxLo = -180;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lat < mnLa) mnLa = lat;
        if (lat > mxLa) mxLa = lat;
        if (lng < mnLo) mnLo = lng;
        if (lng > mxLo) mxLo = lng;
      }
    }
  }
  const cosU = Math.cos((((mnLa + mxLa) / 2) * Math.PI) / 180) || 1e-6;
  const span = Math.max(mxLa - mnLa, (mxLo - mnLo) * cosU);
  const maxEdge = Math.max(span / 9, 0.015);
  // Sampled boundary edges (cos-scaled) for the distance field.
  const ex0: number[] = [];
  const ey0: number[] = [];
  const ex1: number[] = [];
  const ey1: number[] = [];
  for (const poly of polys) {
    for (const ring of poly) {
      const step = Math.max(1, Math.floor(ring.length / 600));
      for (let i = 0; i < ring.length; i += step) {
        const a = ring[i];
        const b = ring[Math.min(i + step, ring.length - 1)];
        ex0.push(a[0] * cosU);
        ey0.push(a[1]);
        ex1.push(b[0] * cosU);
        ey1.push(b[1]);
      }
    }
  }
  const segDist2 = (i: number, px: number, py: number): number => {
    const ax = ex0[i];
    const ay = ey0[i];
    const dx = ex1[i] - ax;
    const dy = ey1[i] - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px - (ax + dx * t);
    const qy = py - (ay + dy * t);
    return qx * qx + qy * qy;
  };
  // Uniform grid over the boundary edges. The naive nearest-edge scan is O(V×E)
  // — measured at ~159M operations for one drill's fills. Each edge is filed in
  // every cell its bbox touches, so a query tests only nearby edges and stops
  // as soon as the next ring cannot beat the best hit found so far.
  let gMinX = Infinity;
  let gMinY = Infinity;
  let gMaxX = -Infinity;
  let gMaxY = -Infinity;
  for (let i = 0; i < ex0.length; i++) {
    if (Math.min(ex0[i], ex1[i]) < gMinX) gMinX = Math.min(ex0[i], ex1[i]);
    if (Math.min(ey0[i], ey1[i]) < gMinY) gMinY = Math.min(ey0[i], ey1[i]);
    if (Math.max(ex0[i], ex1[i]) > gMaxX) gMaxX = Math.max(ex0[i], ex1[i]);
    if (Math.max(ey0[i], ey1[i]) > gMaxY) gMaxY = Math.max(ey0[i], ey1[i]);
  }
  const GN = 48;
  const cell = Math.max((gMaxX - gMinX) / GN, (gMaxY - gMinY) / GN, 1e-9);
  const gw = Math.max(1, Math.min(GN, Math.floor((gMaxX - gMinX) / cell) + 1));
  const gh = Math.max(1, Math.min(GN, Math.floor((gMaxY - gMinY) / cell) + 1));
  const buckets: (number[] | undefined)[] = new Array(gw * gh);
  const cxOf = (x: number) => Math.max(0, Math.min(gw - 1, Math.floor((x - gMinX) / cell)));
  const cyOf = (y: number) => Math.max(0, Math.min(gh - 1, Math.floor((y - gMinY) / cell)));
  for (let i = 0; i < ex0.length; i++) {
    const ix0 = cxOf(Math.min(ex0[i], ex1[i]));
    const ix1 = cxOf(Math.max(ex0[i], ex1[i]));
    const iy0 = cyOf(Math.min(ey0[i], ey1[i]));
    const iy1 = cyOf(Math.max(ey0[i], ey1[i]));
    for (let y = iy0; y <= iy1; y++) {
      for (let x = ix0; x <= ix1; x++) {
        const k = y * gw + x;
        (buckets[k] ??= []).push(i);
      }
    }
  }
  const distOf = (lng: number, lat: number): number => {
    const px = lng * cosU;
    const py = lat;
    const ix = cxOf(px);
    const iy = cyOf(py);
    let best = Infinity;
    const maxR = Math.max(gw, gh);
    for (let r = 0; r <= maxR; r++) {
      // Unvisited cells sit at least (r-1) cells away — once that exceeds the
      // best hit, nothing farther out can win.
      if (best < Infinity && (r - 1) * cell > Math.sqrt(best)) break;
      const xa = Math.max(0, ix - r);
      const xb = Math.min(gw - 1, ix + r);
      const ya = Math.max(0, iy - r);
      const yb = Math.min(gh - 1, iy + r);
      for (let y = ya; y <= yb; y++) {
        const onEdgeRow = y === iy - r || y === iy + r;
        for (let x = xa; x <= xb; x++) {
          if (!onEdgeRow && x !== ix - r && x !== ix + r) continue; // ring only
          const b = buckets[y * gw + x];
          if (!b) continue;
          for (let j = 0; j < b.length; j++) {
            const d2 = segDist2(b[j], px, py);
            if (d2 < best) best = d2;
          }
        }
      }
    }
    if (best === Infinity) {
      for (let i = 0; i < ex0.length; i++) {
        const d2 = segDist2(i, px, py);
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  };
  const edgeDeg2 = (a: PBase, b: PBase) => {
    const dLng = (a.lng - b.lng) * cosU;
    const dLat = a.lat - b.lat;
    return Math.sqrt(dLng * dLng + dLat * dLat);
  };
  const tris: PBase[] = [];
  const ringBases = ringBasesOf(g);
  for (const rings of ringBases) {
    const data = flatten(rings.map((ring) => ring.map((p) => [p.x, p.y])));
    const idx = earcut(data.vertices, data.holes, data.dimensions);
    const flat = rings.flat();
    const stack: [PBase, PBase, PBase][] = [];
    for (let k = 0; k < idx.length; k += 3) {
      stack.push([flat[idx[k]], flat[idx[k + 1]], flat[idx[k + 2]]]);
    }
    while (stack.length) {
      const [a, b, c] = stack.pop()!;
      const ab = edgeDeg2(a, b);
      const bc = edgeDeg2(b, c);
      const ca = edgeDeg2(c, a);
      const longest = Math.max(ab, bc, ca);
      if (longest <= maxEdge) {
        tris.push(a, b, c);
        continue;
      }
      if (longest === ab) {
        const m = baseOf((a.lng + b.lng) / 2, (a.lat + b.lat) / 2);
        stack.push([a, m, c], [m, b, c]);
      } else if (longest === bc) {
        const m = baseOf((b.lng + c.lng) / 2, (b.lat + c.lat) / 2);
        stack.push([b, m, a], [m, c, a]);
      } else {
        const m = baseOf((c.lng + a.lng) / 2, (c.lat + a.lat) / 2);
        stack.push([c, m, b], [m, a, b]);
      }
    }
  }
  const dNorm = new Array<number>(tris.length);
  let maxD = 1e-9;
  for (let i = 0; i < tris.length; i++) {
    dNorm[i] = distOf(tris[i].lng, tris[i].lat);
    if (dNorm[i] > maxD) maxD = dNorm[i];
  }
  for (let i = 0; i < dNorm.length; i++) dNorm[i] /= maxD;
  cached = { pts: tris, dNorm };
  fillBaseCache.set(g as object, cached);
  return cached;
}

// Even-odd ray cast: is [lng, lat] strictly inside the (multi)polygon? Holes and
// disjoint parts handled by toggling across every ring.
function pointInPolygon(lng: number, lat: number, polys: number[][][][]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}

// Area-weighted centroid of the unit's VISIBLE strips (its "centre of the visible
// zone"), plus the midpoint of the widest strip as a guaranteed-interior fallback.
function scanlineCentroid(
  polys: number[][][][],
  latLo: number,
  latHi: number,
  lngLo: number,
  lngHi: number,
): {
  centroid: [number, number];
  bestMid: [number, number];
  bestW: number; // widest visible strip (° lng) — horizontal room for the pill
  latSpan: number; // lat extent (°) of rows with any interior — vertical room
} | null {
  const K = 15;
  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  let bestW = 0;
  let rows = 0;
  let bestMid: [number, number] | null = null;
  for (let k = 0; k < K; k++) {
    const lat = latLo + ((k + 0.5) / K) * (latHi - latLo);
    const xs: number[] = [];
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const y1 = ring[j][1];
          const y2 = ring[i][1];
          if (y1 <= lat !== y2 <= lat) {
            xs.push(ring[j][0] + ((lat - y1) / (y2 - y1)) * (ring[i][0] - ring[j][0]));
          }
        }
      }
    }
    xs.sort((p, q) => p - q);
    let rowHit = false;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const lo = Math.max(xs[i], lngLo);
      const hi = Math.min(xs[i + 1], lngHi);
      const w = hi - lo;
      if (w > 0) {
        rowHit = true;
        const mx = (lo + hi) / 2;
        sumX += mx * w;
        sumY += lat * w;
        sumW += w;
        if (w > bestW) {
          bestW = w;
          bestMid = [mx, lat];
        }
      }
    }
    if (rowHit) rows++;
  }
  if (!sumW || !bestMid) return null;
  return {
    centroid: [sumX / sumW, sumY / sumW],
    bestMid,
    bestW,
    latSpan: (rows / K) * (latHi - latLo),
  };
}

// Anchor a macro pin at the CENTRE of the unit's visible part: the area-weighted
// centroid of its on-screen strips (or the widest strip's midpoint if the centroid
// itself falls in a concavity). Cheap (one scanline pass) so it can run live on
// every move. Also reports the visible interior's rough extent (° lng of the
// widest strip, ° lat of covered rows) so updateSticky can decide whether the
// pill has clear ROOM to sit inside its own boundary.
// Returns null only when no part of the unit is in view.
interface InteriorHit {
  pt: [number, number];
  bestW: number; // widest visible strip (° lng) — horizontal room for the pill
  latSpan: number; // lat extent (°) of rows with any interior — vertical room
}

function interiorInView(geom: unknown, b: Bounds, v: Bounds): InteriorHit | null {
  const g = geom as { type?: string; coordinates?: unknown } | undefined;
  if (!g?.type) return null;
  const polys = polysOf(g);
  if (!polys.length) return null;
  const latLo = Math.max(b.minLat, v.minLat);
  const latHi = Math.min(b.maxLat, v.maxLat);
  const lngLo = Math.max(b.minLng, v.minLng);
  const lngHi = Math.min(b.maxLng, v.maxLng);
  if (latLo >= latHi || lngLo >= lngHi) return null;
  const c = scanlineCentroid(polys, latLo, latHi, lngLo, lngHi);
  if (!c) return null;
  const pt = pointInPolygon(c.centroid[0], c.centroid[1], polys) ? c.centroid : c.bestMid;
  return { pt, bestW: c.bestW, latSpan: c.latSpan };
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

/** Each outer ring's convex hull, [lng, lat] pair after pair, per geometry:
 *  what a fit frames with an outline. Every vertex lies within it, an islet's
 *  too, and a camera draws what lies within a hull within the hull it draws:
 *  a silhouette's box is decided at its hull's corners, where the frame bus's
 *  rim, sampled, misses the vertices between its samples. Monotone chain, in
 *  mercator. */
const fitHullCache = new WeakMap<object, Float64Array>();
function fitHullOf(g: { type?: string; coordinates?: unknown }): Float64Array {
  let cached = fitHullCache.get(g as object);
  if (cached) return cached;
  const turn = (o: PBase, a: PBase, b: PBase) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const out: number[] = [];
  for (const poly of ringBasesOf(g)) {
    if (!poly[0]?.length) continue;
    const byX = [...poly[0]].sort((p, q) => p.x - q.x || p.y - q.y);
    // One chain west to east, the other back, each dropping its last point
    // while the next one does not turn the hull's way.
    const hull: PBase[] = [];
    for (const chain of [byX, [...byX].reverse()]) {
      const from = hull.length;
      for (const p of chain) {
        while (
          hull.length - from >= 2 &&
          turn(hull[hull.length - 2], hull[hull.length - 1], p) <= 0
        ) {
          hull.pop();
        }
        hull.push(p);
      }
      hull.pop(); // the other chain's first point
    }
    for (const p of hull) out.push(p.lng, p.lat);
  }
  cached = new Float64Array(out);
  fitHullCache.set(g as object, cached);
  return cached;
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

// ---- The plateau's violet wall: a custom WebGL layer ---------------------------
// Zero-thickness vertical quads standing EXACTLY on the selection's vector
// boundary, ground → height, drawn with our own shader and depth-tested against
// the terrain (renderingMode "3d"). This bypasses every Mapbox heuristic that
// broke the previous attempts: no draping (no texel-staircase misalignment), no
// fill-extrusion terrain anchoring (no per-centroid DEM sampling → no sawtooth),
// just exact world-space geometry. The DEM is eroded inward server-side, so the
// terrain wall is always recessed behind this sheet. Height rise/sink is a single
// uniform (uScale) — animated without touching the geometry.
const WALL_OVERSHOOT = 1.02; // top slightly above the plateau: no smeared sliver
// Pace for the halo's self-scheduled frames (~25 Hz). The pulse is a slow 2.6 s
// ribbon, so it reads identically here, but the map gets real idle frames back.
const PULSE_FRAME_MS = 40;

// A compiled program with attribute/uniform locations looked up by name.
interface GlProg {
  prog: WebGLProgram;
  attr: Record<string, number>;
  uni: Record<string, WebGLUniformLocation | null>;
}

function buildProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  attrs: string[],
  unis: string[],
): GlProg | null {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog || !vs || !fs) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (import.meta.env.DEV && !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn(
      "[plateau] program link failed:",
      gl.getProgramInfoLog(prog),
      gl.getShaderInfoLog(vs),
      gl.getShaderInfoLog(fs),
    );
  }
  const attr: Record<string, number> = {};
  for (const a of attrs) attr[a] = gl.getAttribLocation(prog, a);
  const uni: Record<string, WebGLUniformLocation | null> = {};
  for (const u of unis) uni[u] = gl.getUniformLocation(prog, u);
  return { prog, attr, uni };
}

// The globe↔mercator morph, mixed in NDC AFTER the perspective divides — the
// exact endorsed pattern (mapbox debug/satellites-custom-layer.js). Do NOT mix
// the two positions in world space before projecting: the sphere-shell point and
// the flat-plane point are the same SCREEN point but wildly different 3D coords,
// and a linear blend of them projects to garbage mid-band (walls fragment, the
// lid smears, lines vanish for z 5–6 — observed live). Behind-eye vertices (the
// NDC mix defeats hardware near-plane clipping) are thrown to a degenerate
// clipped position instead. t = smoothstep(5, 6, zoom) — 0 = sphere, 1 =
// mercator; at z ≥ 6 mapbox switches to the 2-arg mercator call and the
// (untouched) mercator programs take over, so the handoff is seamless. The
// mercator twin is rescaled around the map centre by the pixels-per-meter ratio
// per the custom-layer contract (the globe camera is equator-referenced).
const GLOBE_PROJECT_GLSL = `
  uniform mat4 uProj;
  uniform mat4 uGlobeToMerc;
  uniform float uT;
  uniform vec2 uCenterMerc;
  uniform float uPxRatio;
  uniform float uScale;
  vec4 morphProject(vec3 merc, vec3 ecefLo, vec3 ecefHi) {
    vec4 p = uProj * uGlobeToMerc * vec4(mix(ecefLo, ecefHi, uScale), 1.0);
    if (p.w <= 0.0) return vec4(0.0, 0.0, 2.0, 1.0);
    p /= p.w;
    if (uT > 0.0) {
      vec4 m = vec4(
        (merc.xy - uCenterMerc) * uPxRatio + uCenterMerc,
        merc.z * uScale * uPxRatio,
        1.0);
      m = uProj * m;
      if (m.w <= 0.0) return vec4(0.0, 0.0, 2.0, 1.0);
      p = mix(p, m / m.w, uT);
    }
    return p;
  }
`;

// ---- Mesh pieces shared by the plateau and the analyses' slabs -------------------

/** A globe vertex: absolute mercator (z at FULL altitude; 0 for a wall's foot)
 *  and the ECEF ground/full pair — 9 floats. */
function pushGlobeVert(arr: number[], b: PBase, alt: number, bottom = false) {
  arr.push(b.x, b.y, bottom ? 0 : alt * b.zPerM, b.lo[0], b.lo[1], b.lo[2]);
  if (bottom) arr.push(b.lo[0], b.lo[1], b.lo[2]);
  else arr.push(b.lo[0] + alt * b.d[0], b.lo[1] + alt * b.d[1], b.lo[2] + alt * b.d[2]);
}

/** One ring's wall: a quad (two triangles) per edge, ground → `h`, mercator
 *  relative to `origin` (3 floats a vertex) and the globe's (9) — each with
 *  `rgb` after it, when given (the slabs' pieces: 6 and 12). */
function pushWallRing(
  ring: PBase[],
  origin: [number, number],
  h: number,
  verts: number[],
  gWall: number[],
  rgb?: readonly number[],
) {
  const put = (b: PBase, top: boolean) => {
    verts.push(b.x - origin[0], b.y - origin[1], top ? h * b.zPerM : 0);
    pushGlobeVert(gWall, b, h, !top);
    if (rgb) {
      verts.push(rgb[0], rgb[1], rgb[2]);
      gWall.push(rgb[0], rgb[1], rgb[2]);
    }
  };
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    put(a, false);
    put(b, false);
    put(b, true);
    put(a, false);
    put(b, true);
    put(a, true);
  }
}

/** A slab piece's top vertex at `h`, coloured: mercator [x, y, z, r, g, b]
 *  relative to `origin`, the globe's [merc3, lo3, hi3, rgb3]. */
function pushPieceVert(
  b: PBase,
  origin: [number, number],
  h: number,
  rgb: readonly number[],
  verts: number[],
  gVerts: number[],
) {
  verts.push(b.x - origin[0], b.y - origin[1], h * b.zPerM, rgb[0], rgb[1], rgb[2]);
  pushGlobeVert(gVerts, b, h);
  gVerts.push(rgb[0], rgb[1], rgb[2]);
}

/** A halo vertex at `alt` m: mercator [x, y, z, d] relative to `origin`, and
 *  the globe's [merc3, lo3, hi3, d]. */
function pushHaloVert(
  verts: number[],
  gVerts: number[],
  b: PBase,
  d: number,
  origin: [number, number],
  alt: number,
) {
  const z = alt * b.zPerM;
  verts.push(b.x - origin[0], b.y - origin[1], z, d);
  gVerts.push(b.x, b.y, z, b.lo[0], b.lo[1], b.lo[2]);
  gVerts.push(b.lo[0] + alt * b.d[0], b.lo[1] + alt * b.d[1], b.lo[2] + alt * b.d[2], d);
}

/**
 * The halo's ribbon along one ring: its inner edge (d = 0) on the ring itself,
 * full resolution — exactly where the wall stands —, its outer edge (d = 1)
 * `W` out (° of latitude-equivalent; longitudes scaled by `cosH`). Only the
 * offset DIRECTION is smoothed (the normal comes from the chord across a
 * ±0.5·W arc window), so the outer edge stays calm on jagged boundaries.
 * Triangles, a vertex at a time, to `push`.
 */
function buildHaloRing(
  ringB: PBase[],
  W: number,
  cosH: number,
  push: (b: PBase, d: number) => void,
) {
  const pts: PBase[] = ringB.slice();
  const p0r = pts[0];
  const pnr = pts[pts.length - 1];
  if (!p0r || !pnr) return;
  if (Math.abs(p0r.lng - pnr.lng) < 1e-9 && Math.abs(p0r.lat - pnr.lat) < 1e-9) pts.pop();
  const n = pts.length;
  if (n < 4) return;
  // Cumulative arc length (scaled-lng metric) for the smoothing window.
  const arc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = (b.lng - a.lng) * cosH;
    const dy = b.lat - a.lat;
    arc[i + 1] = arc[i] + Math.hypot(dx, dy);
  }
  const total = arc[n];
  if (total < W) return; // degenerate speck
  const win = Math.min(W * 0.5, total / 6);
  const at = (s: number): [number, number] => {
    // Point at arc position s (wrapped) via linear scan window — n is
    // walked with two monotone pointers overall, this stays cheap.
    const sw = ((s % total) + total) % total;
    let lo = 0;
    let hi = n;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] <= sw) lo = mid;
      else hi = mid;
    }
    const segLen = arc[lo + 1] - arc[lo] || 1e-12;
    const t = (sw - arc[lo]) / segLen;
    const a = pts[lo];
    const b = pts[(lo + 1) % n];
    return [a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t];
  };
  const normals: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const back = at(arc[i] - win);
    const fwd = at(arc[i] + win);
    const dx = (fwd[0] - back[0]) * cosH;
    const dy = fwd[1] - back[1];
    const len = Math.hypot(dx, dy) || 1e-12;
    normals[i] = [-dy / len, dx / len];
  }
  // Orientation: offset a test point and even-odd test the ring — flip so the
  // band goes OUTWARD.
  const testLng = pts[0].lng + (normals[0][0] * W * 0.5) / cosH;
  const testLat = pts[0].lat + normals[0][1] * W * 0.5;
  let inside = false;
  for (let i = 0, j = ringB.length - 1; i < ringB.length; j = i++) {
    const yi = ringB[i].lat;
    const yj = ringB[j].lat;
    if (
      yi > testLat !== yj > testLat &&
      testLng < ((ringB[j].lng - ringB[i].lng) * (testLat - yi)) / (yj - yi) + ringB[i].lng
    ) {
      inside = !inside;
    }
  }
  const flip = inside ? -1 : 1;
  // Inner ring = the cached bases themselves; only the OFFSET outer ring needs
  // fresh projections.
  const inner = pts;
  const outer = pts.map((b, i) =>
    baseOf(b.lng + (flip * normals[i][0] * W) / cosH, b.lat + flip * normals[i][1] * W),
  );
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(inner[i], 0);
    push(inner[j], 0);
    push(outer[j], 1);
    push(inner[i], 0);
    push(outer[j], 1);
    push(outer[i], 1);
  }
}

// ---- The analyses' slabs' pieces (PlateauWallLayer.setSlabs) ----------------------

/** A box on a slab, by its four corners in the layer's slabCorners from `at`. */
interface SlabQuad {
  name: "ring" | "label" | "plaque" | "bar";
  w: number;
  h: number;
  at: number;
}

/** The ring's part picked and the one hovered (null: the largest picked, none
 *  hovered), as the overlay has them. */
interface SlabRingState {
  picked: string | null;
  hovered: string | null;
}
const NO_RING: SlabRingState = { picked: null, hovered: null };

/** Which of the slabs a mercator draw takes (drawSlabsMercator). */
type SlabPass = "all" | "parts" | "boxes" | "over";

/** The plateau's violet (the walls' shader's), straight sRGB 0..1. */
const VIOLET = [0.486, 0.361, 1.0] as const;
/** A piece's walls against its top: a shade darker, the same hue. */
const WALL_SHADE = 0.8;
const shade = (rgb: readonly number[]) => rgb.map((v) => v * WALL_SHADE);
/** "#rrggbb" as straight sRGB 0..1 (the themes' colours, as the page draws them). */
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** M × T(ox, oy): a mesh's origin folded into the (float64) matrix, so that
 *  its float32 vertices, relative to it, keep sub-metre precision. */
function foldOrigin(m: ArrayLike<number>, ox: number, oy: number, out: Float32Array): Float32Array {
  for (let i = 0; i < 16; i++) out[i] = m[i];
  out[12] = m[0] * ox + m[4] * oy + m[12];
  out[13] = m[1] * ox + m[5] * oy + m[13];
  out[14] = m[2] * ox + m[6] * oy + m[14];
  out[15] = m[3] * ox + m[7] * oy + m[15];
  return out;
}

/** Whether mapbox drew this frame on the globe (zoom < 6): it then hands a
 *  custom layer's render() the projection's extra arguments, all of them. */
function globeFrame(
  projection: unknown,
  globeToMercMatrix?: number[],
  transition?: number,
  centerInMercator?: number[],
  pixelsPerMeterRatio?: number,
): boolean {
  return (
    projection !== undefined &&
    (projection as { name?: string }).name === "globe" &&
    globeToMercMatrix !== undefined &&
    transition !== undefined &&
    centerInMercator !== undefined &&
    pixelsPerMeterRatio !== undefined
  );
}

/** mapbox's depth range for its "3d" layers — the terrain's, the plateau's.
 *  Not public API: absent, the range stays as mapbox last set it. */
interface MapPainterInternals {
  painter?: { depthRangeFor3D?: [number, number] };
}

class PlateauWallLayer implements mapboxgl.CustomLayerInterface {
  id = "plateau-wall";
  type = "custom" as const;
  renderingMode = "3d" as const;
  private map: mapboxgl.Map | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = 0;
  private uMatrix: WebGLUniformLocation | null = null;
  private uScale: WebGLUniformLocation | null = null;
  private positions = new Float32Array(0);
  private origin: [number, number] = [0, 0];
  private vertexCount = 0;
  private dirty = false;
  private scale = 0; // animated rise 0..1
  // ---- what the frame bus reads (see onFrame): the raised unit as last given
  // to setGeometry, its sampled rim, and the camera of the last frame drawn ----
  scopeId = ""; // the raised unit's id, '' when none
  heightM = 0; // its plateau height; the lid stands at heightM × WALL_OVERSHOOT × rise
  rim: Float64Array = new Float64Array(0); // packed rim samples (see STRIDE)
  rimCount = 0;
  rimVersion = 0; // bumped by every setGeometry: the rim may change under the same id
  readonly cam = {
    seq: 0, // bumped per captured frame
    m: new Float64Array(16), // the custom-layer matrix (mercator → clip)
    globe: false, // drawn by the globe programs (zoom < 6)
    g2m: new Float64Array(16), // globe only: ECEF → the world the matrix takes
    t: 0, // globe only: the sphere → mercator morph, smoothstep(5, 6, zoom)
    cx: 0, // globe only: the map centre in mercator…
    cy: 0,
    r: 1, // …and the pixels-per-metre ratio the mercator twin is rescaled by
  };
  get rise(): number {
    return this.scale;
  }
  // ---- the map-textured top ("lid"): same vector boundary as the walls, so the
  // plateau surface reaches the wall exactly, with a vector-smooth edge ----
  private lidProgram: WebGLProgram | null = null;
  private lidBuffer: WebGLBuffer | null = null;
  private lidAPos = 0;
  private lidUMatrix: WebGLUniformLocation | null = null;
  private lidUScale: WebGLUniformLocation | null = null;
  private lidUTexOrigin: WebGLUniformLocation | null = null;
  private lidUTexSpan: WebGLUniformLocation | null = null;
  private lidPositions = new Float32Array(0);
  private lidVertexCount = 0;
  private lidDirty = false;
  private lidTexture: WebGLTexture | null = null;
  /** GL_MAX_TEXTURE_SIZE, read in onAdd — caps the lid snapshot's pixel budget. */
  maxTextureSize = 0;
  // Anisotropic filtering for the lid — probed once (see the upload in render()).
  // maxAniso: 0 = not probed yet, -1 = extension unavailable.
  private anisoExt: EXT_texture_filter_anisotropic | null = null;
  private maxAniso = 0;
  private lidPending: Snapshot | null = null; // uploaded lazily in render (gl there)
  private lidMerc: { minX: number; minY: number; spanX: number; spanY: number } | null = null;
  // ---- focus boundary lines ON the lid: true vectors extruded to screen-space
  // width in the shader, so they stay the same pixel size at every zoom (the old
  // approach baked them into the lid SNAPSHOT — a raster that fattened on zoom) ----
  private lineProgram: WebGLProgram | null = null;
  private lineBuffer: WebGLBuffer | null = null;
  private lineAPos = 0;
  private lineAOther = 0;
  private lineASide = 0;
  private lineAGeomSide = 0;
  private lineUMatrix: WebGLUniformLocation | null = null;
  private lineUScale: WebGLUniformLocation | null = null;
  private lineUViewport: WebGLUniformLocation | null = null;
  private lineUWidth: WebGLUniformLocation | null = null;
  private lineUAlpha: WebGLUniformLocation | null = null;
  private linePositions = new Float32Array(0);
  private lineVertexCount = 0;
  private lineDirty = false;
  // Line vertices are grouped by (width, alpha, raised): width follows each
  // feature's own admin level, raised groups ride the rise animation (uScale)
  // at lid height while ground groups draw at a fixed few metres. One
  // concatenated buffer per regime; each group is a vertex RANGE drawn with its
  // own uniforms.
  private lineGroups: {
    width: number;
    alpha: number;
    raised: boolean;
    start: number;
    count: number;
  }[] = [];
  // ---- GLOBE regime (zoom < 6, experimental custom-layer API) ----
  // Below the globe→mercator transition, mapbox calls render() with extra args
  // (projection, globeToMercMatrix, transition t, centerInMercator, pxPerMeterRatio)
  // and the same meshes are drawn by globe programs: absolute-mercator + dual-ECEF
  // attributes, morphed in-shader between the sphere and mercator by t — the exact
  // pattern of mapbox's own debug/satellites-custom-layer.js. ECEF is linear in
  // altitude, so the rise stays a uniform: ecef = mix(ecefGround, ecefFull, uScale).
  private gWallProg: GlProg | null = null;
  private gLidProg: GlProg | null = null;
  private gLineProg: GlProg | null = null;
  private gWallBuffer: WebGLBuffer | null = null;
  private gLidBuffer: WebGLBuffer | null = null;
  private gLineBuffer: WebGLBuffer | null = null;
  private gWallPositions = new Float32Array(0);
  private gLidPositions = new Float32Array(0);
  private gLinePositions = new Float32Array(0);
  private gWallDirty = false;
  private gLidDirty = false;
  private gLineDirty = false;
  // ---- hovered-zone highlight: a translucent fill for ONE focus unit, drawn
  // between the lid and the boundary lines. Focus units live ON the plateau, so
  // a draped fill layer can't reach them (the lid covers it) — this GL pass can.
  // One concatenated mesh, drawn by per-unit vertex RANGE (no per-vertex ids).
  private fillProg: GlProg | null = null;
  private gFillProg: GlProg | null = null;
  private hovBuffer: WebGLBuffer | null = null;
  private gHovBuffer: WebGLBuffer | null = null;
  private hovPositions = new Float32Array(0);
  private gHovPositions = new Float32Array(0);
  private hovDirty = false;
  private gHovDirty = false;
  private fillRanges = new Map<string, { start: number; count: number; raised: boolean }>();
  // Units whose hover fill COULD be needed, and the origin their mesh must be
  // relative to. The mesh itself is built on first hover (see ensureFill).
  private pendingFills = new Map<
    string,
    { g: { type?: string; coordinates?: unknown }; altM: number; raised: boolean }
  >();
  private fillOrigin: [number, number] | null = null;
  private pulseTimer = 0;

  /**
   * The halo's pulse drives itself: calling triggerRepaint() from inside render()
   * schedules another rAF, which re-enters render() — a loop with no exit, so once
   * a plateau stands the map NEVER goes idle again (verified in mapbox-gl:
   * _triggerFrame clears this._frame before invoking _render, so a repaint
   * requested during render always queues the next frame). That pinned the whole
   * map — placement, elevation sampling, every layer, MSAA — at display rate
   * while the user was just reading, leaving no headroom for panning or hover.
   * Pacing the self-scheduled frames keeps the animation while giving the machine
   * real idle time. The draw itself is untouched: it stays load-bearing.
   */
  private requestPulseFrame() {
    if (this.pulseTimer || document.hidden || offscreen) return;
    this.pulseTimer = window.setTimeout(() => {
      this.pulseTimer = 0;
      this.map?.triggerRepaint();
    }, PULSE_FRAME_MS);
  }

  /**
   * Build the hover-fill mesh for ONE unit, on demand. Only the hovered unit is
   * ever drawn from `hovPositions` (a retracting unit's vertices are copied into
   * `retractPositions` at beginSelection), so the buffer holds exactly one mesh
   * and its range always starts at 0. `fillBasesOf` caches the expensive part
   * (earcut + curvature refine + boundary-distance field) per geometry, so
   * re-hovering a unit is a pure multiply-add assembly.
   */
  private ensureFill(id: string): void {
    if (!id || this.fillRanges.has(id)) return;
    const spec = this.pendingFills.get(id);
    const origin = this.fillOrigin;
    if (!spec || !origin) return;
    const { pts, dNorm } = fillBasesOf(spec.g);
    if (!pts.length) return;
    const { altM, raised } = spec;
    const hov = new Float32Array(pts.length * 4);
    const gHov = new Float32Array(pts.length * 10);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d = dNorm[i];
      const z = altM * p.zPerM;
      const o = i * 4;
      hov[o] = p.x - origin[0];
      hov[o + 1] = p.y - origin[1];
      hov[o + 2] = z;
      hov[o + 3] = d;
      const q = i * 10;
      gHov[q] = p.x;
      gHov[q + 1] = p.y;
      gHov[q + 2] = z;
      gHov[q + 3] = p.lo[0];
      gHov[q + 4] = p.lo[1];
      gHov[q + 5] = p.lo[2];
      gHov[q + 6] = p.lo[0] + altM * p.d[0];
      gHov[q + 7] = p.lo[1] + altM * p.d[1];
      gHov[q + 8] = p.lo[2] + altM * p.d[2];
      gHov[q + 9] = d;
    }
    // One mesh in flight: replace rather than concatenate.
    this.fillRanges.clear();
    this.fillRanges.set(id, { start: 0, count: pts.length, raised });
    this.hovPositions = hov;
    this.gHovPositions = gHov;
    this.hovDirty = true;
    this.gHovDirty = true;
  }
  private hoveredFillId = "";
  private hoverT0 = 0; // sweep start; the fill animates boundary → centre
  // Reverse sweep on SELECTION: the hovered unit's fill is snapshotted into its
  // own buffers (the selection immediately rebuilds the mesh and drops its
  // range) and drained centre → boundary by animating the threshold back down.
  private retractPositions = new Float32Array(0);
  private gRetractPositions = new Float32Array(0);
  private retractBuffer: WebGLBuffer | null = null;
  private gRetractBuffer: WebGLBuffer | null = null;
  private retractDirty = false;
  private gRetractDirty = false;
  private retractT0 = 0;
  private retractActive = false;
  // Whether the snapshotted fill came from a RAISED (focus) unit — ground
  // retracts keep the depth test so they stay hidden behind the plateau.
  private retractRaised = true;
  // Pulsing halo on the SELECTED scope's boundary: a band from the wall base
  // outward, with a ripple traveling away from the plateau.
  private haloPositions = new Float32Array(0);
  private gHaloPositions = new Float32Array(0);
  private haloBuffer: WebGLBuffer | null = null;
  private gHaloBuffer: WebGLBuffer | null = null;
  private haloVertexCount = 0;
  private haloDirty = false;
  private gHaloDirty = false;
  private haloProg: GlProg | null = null;
  private gHaloProg: GlProg | null = null;
  private lastRegimeLog = "";
  /** The halo's width (° of latitude-equivalent) and longitude scale, as the
   *  last setGeometry had them: the slabs glow alike (0: no plateau). */
  private haloW = 0;
  private haloCos = 1;
  // ---- the analyses' SLABS: pieces raised beside the territory (see setSlabs).
  // Their own small mesh — never part of setGeometry, whose rebuild is the
  // map's costliest step — at the plateau's lid height, rising with it
  // (uScale = the plateau's rise × their own presence, slabP) ----
  slabScopeId = ""; // the unit they were built for, '' when none
  slabHeightM = 0;
  /** Boxes on the slabs by their corners (NW, NE, SE, SW, packed from `at`;
   *  see STRIDE): those words are laid on (ring, label, plaque) and the
   *  pieces that hide what is under them (label, plaque, bar; the ring by its
   *  box and slabRingCover). */
  slabCorners: Float64Array = new Float64Array(0);
  slabQuads: SlabQuad[] = [];
  /** The ring in its box, px — its centre, its hole's radius and its picked
   *  part's outer edge: what it hides. Null: no ring. */
  slabRingCover: { c: number; rIn: number; rOut: number } | null = null;
  slabVersion = 0;
  /** How long the ring's parts and the bar took to build, last time, ms. */
  slabPartsMs = 0;
  /** Their presence, 0..1 (animateSlabs): they come and go alone too. */
  private slabP = 0;
  /** The words' pieces' lid (see SlabSpec.lid), and its colour when opaque
   *  (the site's card colour, straight sRGB 0..1). */
  private slabLid: SlabSpec["lid"] = "verre";
  private slabColor: [number, number, number] = [1, 1, 1];
  private slabOrigin: [number, number] = [0, 0];
  /** What the ring's parts and the bar are built from — built again for
   *  another pick or hover (setSlabRing) —, and for which they last were. */
  private slabThemes: { rect: SlabRect; spec: SlabThemesSpec; h: number } | null = null;
  private slabRingKey = "";
  // The meshes: mercator [x, y, z, r, g, b] relative to slabOrigin, the
  // globe's [merc3, lo3, hi3, rgb3]. The words' boxes' walls and lids, built
  // with the slabs, kept to go after the ring's parts' and the bar's in each
  // buffer (the parts' first: slabPartWallCount walls, slabPartLidCount lids);
  // the boxes' glow ([x, y, z, d] / [merc3, lo3, hi3, d]).
  private boxWall = new Float32Array(0);
  private gBoxWall = new Float32Array(0);
  private boxLid = new Float32Array(0);
  private gBoxLid = new Float32Array(0);
  private slabWallPos = new Float32Array(0);
  private slabLidPos = new Float32Array(0);
  private slabHaloPos = new Float32Array(0);
  private gSlabWallPos = new Float32Array(0);
  private gSlabLidPos = new Float32Array(0);
  private gSlabHaloPos = new Float32Array(0);
  private slabWallCount = 0;
  private slabPartWallCount = 0;
  private slabPartLidCount = 0;
  private slabLidCount = 0;
  private slabHaloCount = 0;
  private slabDirty = false;
  private gSlabDirty = false;
  private slabWallBuf: WebGLBuffer | null = null;
  private slabLidBuf: WebGLBuffer | null = null;
  private slabHaloBuf: WebGLBuffer | null = null;
  private gSlabWallBuf: WebGLBuffer | null = null;
  private gSlabLidBuf: WebGLBuffer | null = null;
  private gSlabHaloBuf: WebGLBuffer | null = null;
  private slabPieceProg: GlProg | null = null;
  private gSlabPieceProg: GlProg | null = null;
  private slabMat = new Float32Array(16);
  /**
   * The slabs' own layer, drawn with this one's programs and buffers: mapbox
   * draws the map's labels (the Standard style's have an occlusion opacity)
   * right after its LAST "3d" layer — this one —, so they came out over the
   * slabs' pieces. A "2d" layer after it is drawn after them, and hides those
   * its pieces stand on — the slabs alone on the globe, their walls and opaque
   * lids again in mercator (renderSlabs) —, but for a glass lid's: there they
   * are meant to be seen, through the glass. (The plateau's lid keeps its labels.)
   */
  readonly slabLayer: mapboxgl.CustomLayerInterface = {
    id: "plateau-slabs",
    type: "custom",
    renderingMode: "2d",
    render: (gl, matrix, projection, globeToMerc, t, centre, pxRatio) =>
      this.renderSlabs(gl, matrix, projection, globeToMerc, t, centre, pxRatio),
  };
  /** The slabs' rise this frame: the plateau's, times their presence. */
  get slabRise(): number {
    return this.scale * this.slabP;
  }
  get slabPresence(): number {
    return this.slabP;
  }

  /**
   * Stand the analyses' slabs (`rects`, from map/lib/slabs) for the unit raised
   * now, at its lid's height: on the bottom one the plaque; on the top one,
   * when `themes` gives its row, the label's box, the bar and each of the
   * ring's parts (`ring`: the part picked and the one hovered). The words'
   * boxes (label, plaque) have the plateau's violet walls and glow and a lid of
   * their own (see SlabSpec.lid); the bar and the ring's parts stand in their
   * theme's colour, no glow. Small meshes (some hundreds of vertices): well
   * under a millisecond. Empty: none.
   */
  setSlabs(
    rects: SlabRect[],
    themes: SlabThemesSpec | null,
    heightM: number,
    scopeId: string,
    ring: SlabRingState = NO_RING,
  ) {
    const h = heightM * WALL_OVERSHOOT;
    const top = (themes && rects.find((r) => r.side === "top")) || null;
    const bottom = rects.find((r) => r.side === "bottom") ?? null;
    const quads: SlabQuad[] = [];
    const at: [number, number][] = [];
    const quad = (name: SlabQuad["name"], r: SlabRect, b: PieceBox) => {
      quads.push({ name, w: b.w, h: b.h, at: at.length });
      at.push(
        slabPointPx(r, b.x, b.y),
        slabPointPx(r, b.x + b.w, b.y),
        slabPointPx(r, b.x + b.w, b.y + b.h),
        slabPointPx(r, b.x, b.y + b.h),
      );
    };
    // The words' boxes: raised, violet, glowing.
    const boxes: { r: SlabRect; b: PieceBox }[] = [];
    if (top && themes) {
      quad("ring", top, themes.ringBox);
      quad("label", top, themes.labelBox);
      quad("bar", top, themes.barBox);
      boxes.push({ r: top, b: themes.labelBox });
    }
    if (bottom) {
      const b = { x: 0, y: 0, w: bottom.w, h: bottom.h };
      quad("plaque", bottom, b);
      boxes.push({ r: bottom, b });
    }
    const corners = new Float64Array(at.length * STRIDE);
    at.forEach(([lng, lat], i) => packBase(corners, i, baseOf(lng, lat)));
    const origin: [number, number] = at.length ? [corners[0], corners[1]] : [0, 0];
    const wall: number[] = [];
    const gWall: number[] = [];
    const lid: number[] = [];
    const gLid: number[] = [];
    const halo: number[] = [];
    const gHalo: number[] = [];
    const HALO_ALT = 12;
    for (const { r, b } of boxes) {
      const g = { type: "Polygon", coordinates: [pieceOutline(r, b)] };
      for (const ringB of ringBasesOf(g)[0] ?? []) {
        pushWallRing(ringB, origin, h, wall, gWall, VIOLET);
        if (this.haloW > 0) {
          buildHaloRing(ringB, this.haloW, this.haloCos, (pb, d) =>
            pushHaloVert(halo, gHalo, pb, d, origin, HALO_ALT),
          );
        }
      }
      // Its colour comes from the frame (uTint): the card's, or none (glass).
      for (const p of lidBasesOf(g)[0] ?? []) pushPieceVert(p, origin, h, VIOLET, lid, gLid);
    }
    this.slabScopeId = at.length ? scopeId : "";
    this.slabHeightM = at.length ? heightM : 0;
    this.slabCorners = corners;
    this.slabQuads = quads;
    this.slabRingCover =
      top && themes
        ? {
            c: themes.ring.c,
            rIn: themes.ring.r,
            rOut: themes.ring.R + themes.ring.pick,
          }
        : null;
    this.slabVersion++;
    this.slabOrigin = origin;
    this.slabThemes = top && themes ? { rect: top, spec: themes, h } : null;
    this.boxWall = new Float32Array(wall);
    this.gBoxWall = new Float32Array(gWall);
    this.boxLid = new Float32Array(lid);
    this.gBoxLid = new Float32Array(gLid);
    this.slabHaloPos = new Float32Array(halo);
    this.gSlabHaloPos = new Float32Array(gHalo);
    this.slabHaloCount = halo.length / 4;
    this.slabRingKey = "";
    this.setSlabRing(ring);
  }

  /**
   * The ring's parts and the bar, built again for `ring` (nothing when they
   * already are): each part a sector of the ring (map/lib/slabs: ringSectorArcs),
   * as wide as it is drawn (MIN_ARC widening included), the picked one grown
   * out by `pick`, a part hovered by `hover`; in its theme's colour picked or
   * hovered, else its pastel — its walls a shade darker —; the bar in the
   * colour of the theme the label names (the one hovered, else the picked).
   * Then the words' boxes' meshes after them, as built (setSlabs).
   */
  setSlabRing(ring: SlabRingState) {
    const t = this.slabThemes;
    const parts = t?.spec.ring.parts ?? [];
    const picked =
      ring.picked && parts.some((p) => p.theme === ring.picked)
        ? ring.picked
        : (parts[0]?.theme ?? null);
    const hovered =
      ring.hovered && parts.some((p) => p.theme === ring.hovered) ? ring.hovered : null;
    const key = `${this.slabVersion}|${picked}|${hovered}`;
    if (key === this.slabRingKey) return;
    this.slabRingKey = key;
    const t0 = performance.now();
    const wall: number[] = [];
    const gWall: number[] = [];
    const lid: number[] = [];
    const gLid: number[] = [];
    if (t) {
      const { rect, spec, h } = t;
      const g = spec.ring;
      const o = this.slabOrigin;
      const cx = spec.ringBox.x + g.c;
      const cy = spec.ringBox.y + g.c;
      for (const p of g.parts) {
        const lit = p.theme === picked || p.theme === hovered;
        const rgb = hexRgb(lit ? p.color : p.pastel);
        const grow = p.theme === picked ? g.pick : p.theme === hovered ? g.hover : 0;
        const arcs = ringSectorArcs(rect, cx, cy, g.r, g.R + grow, p.a0, p.a1);
        const out = arcs.outer.map(([lng, lat]) => baseOf(lng, lat));
        const inn = arcs.inner.map(([lng, lat]) => baseOf(lng, lat));
        // Its top: a strip from the outer arc to the inner one.
        for (let i = 0; i + 1 < out.length; i++) {
          for (const v of [out[i], out[i + 1], inn[i + 1], out[i], inn[i + 1], inn[i]]) {
            pushPieceVert(v, o, h, rgb, lid, gLid);
          }
        }
        // Its walls, round its outline: out along the outer arc, back along
        // the inner one.
        pushWallRing([...out, ...[...inn].reverse(), out[0]], o, h, wall, gWall, shade(rgb));
      }
      const named = g.parts.find((p) => p.theme === (hovered ?? picked));
      if (named) {
        const rgb = hexRgb(named.color);
        const bar = { type: "Polygon", coordinates: [pieceOutline(rect, spec.barBox)] };
        for (const ringB of ringBasesOf(bar)[0] ?? []) {
          pushWallRing(ringB, o, h, wall, gWall, shade(rgb));
        }
        for (const p of lidBasesOf(bar)[0] ?? []) pushPieceVert(p, o, h, rgb, lid, gLid);
      }
    }
    const join = (a: number[], b: Float32Array) => {
      const out = new Float32Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    };
    this.slabWallPos = join(wall, this.boxWall);
    this.gSlabWallPos = join(gWall, this.gBoxWall);
    this.slabLidPos = join(lid, this.boxLid);
    this.gSlabLidPos = join(gLid, this.gBoxLid);
    this.slabWallCount = this.slabWallPos.length / 6;
    this.slabPartWallCount = wall.length / 6;
    this.slabPartLidCount = lid.length / 6;
    this.slabLidCount = this.slabLidPos.length / 6;
    this.slabDirty = true;
    this.gSlabDirty = true;
    this.slabPartsMs = Math.round((performance.now() - t0) * 1000) / 1000;
    this.map?.triggerRepaint();
  }

  setSlabPresence(p: number) {
    this.slabP = p;
    this.map?.triggerRepaint();
  }

  /** The words' boxes' lid when opaque (the site's card colour, straight sRGB 0..1). */
  setSlabColor(rgb: [number, number, number]) {
    this.slabColor = rgb;
    this.map?.triggerRepaint();
  }

  setSlabLid(lid: SlabSpec["lid"]) {
    if (lid === this.slabLid) return;
    this.slabLid = lid;
    this.map?.triggerRepaint();
  }

  /** Highlight (or clear) the hovered unit's fill (restarts the inward sweep). */
  setHovered(id: string) {
    if (this.hoveredFillId === id) return;
    this.ensureFill(id); // build this unit's mesh the first time it is hovered
    this.hoveredFillId = id;
    if (id) this.hoverT0 = performance.now();
    this.map?.triggerRepaint();
  }

  /** Sweep progress ∈ [0, 1.15]: threshold past 1+feather so the fill completes.
   *  Keeps repainting until done. */
  private fillSweepT(): number {
    const t = Math.min(1.15, ((performance.now() - this.hoverT0) / 133) * 1.15);
    if (t < 1.15) this.map?.triggerRepaint();
    return t;
  }

  /** The unit is being SELECTED: snapshot its hover fill (if it was the hovered
   *  one) and drain it centre → boundary. Must run BEFORE setGeometry rebuilds
   *  the fill mesh (the selection drops the unit's range). */
  beginSelection(id: string) {
    if (!id || id !== this.hoveredFillId) return;
    const range = this.fillRanges.get(id);
    this.hoveredFillId = "";
    if (!range) return;
    this.retractPositions = this.hovPositions.slice(
      range.start * 4,
      (range.start + range.count) * 4,
    );
    this.gRetractPositions = this.gHovPositions.slice(
      range.start * 10,
      (range.start + range.count) * 10,
    );
    this.retractDirty = true;
    this.gRetractDirty = true;
    this.retractT0 = performance.now();
    this.retractActive = true;
    this.retractRaised = range.raised;
    this.map?.triggerRepaint();
  }

  /** Reverse-sweep threshold: 1.15 → −0.13 over ~350 ms; deactivates at the end. */
  private retractT(): number {
    const t = 1.15 - ((performance.now() - this.retractT0) / 117) * 1.28;
    if (t <= -0.13) {
      this.retractActive = false;
      this.retractPositions = new Float32Array(0);
      this.gRetractPositions = new Float32Array(0);
      return -0.13;
    }
    this.map?.triggerRepaint();
    return t;
  }

  /** Rebuild the wall mesh: one quad (two triangles) per boundary edge. Vertex
   *  coords are Mercator, relative to the first vertex (float32 keeps precision
   *  on small offsets; the origin is re-added into the matrix each frame in
   *  float64). z holds the FULL wall height — uScale animates it. */
  setGeometry(
    features: OutlineFC["features"],
    heightM: number,
    focus: OutlineFC["features"] = [],
    context: OutlineFC["features"] = [],
  ) {
    // NOTE: do NOT early-exit on "identical inputs". onAdd() allocates fresh GL
    // buffers and the render path only uploads while the *Dirty flags are set, so
    // skipping a rebuild after the layer is re-added leaves every buffer empty and
    // nothing draws. The per-geometry caches (ringBasesOf / lidBasesOf /
    // fillBasesOf) already make a repeat build cheap — it is pure array assembly.

    const verts: number[] = [];
    const lidVerts: number[] = [];
    const gWall: number[] = [];
    const gLid: number[] = [];
    let origin: [number, number] | null = null;
    const h = heightM * WALL_OVERSHOOT;
    // The frame bus follows the raised unit's rim (sampled from the same cached
    // bases the walls stand on). A teardown, with no features, empties it.
    const rim = sampleRim(features);
    this.scopeId = String(features[0]?.properties?.id ?? "");
    this.heightM = features.length ? heightM : 0;
    this.rim = rim.pack;
    this.rimCount = rim.count;
    this.rimVersion++;
    // Per-vertex projections come from the per-geometry caches (PBase): both the
    // Mercator z and the experimental LngLat.toEcef are LINEAR in altitude, so a
    // cached ground point + per-metre delta reconstructs any height with a
    // multiply-add — no re-projection on rebuild.
    for (const f of features) {
      const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
      if (!g?.type) continue;
      const polyBases = ringBasesOf(g);
      // Lid: earcut + curvature subdivision, cached per geometry (see lidBasesOf).
      const lids = lidBasesOf(g);
      for (let pi = 0; pi < polyBases.length; pi++) {
        for (const ring of polyBases[pi]) {
          if (!origin && ring.length >= 2) origin = [ring[0].x, ring[0].y];
          if (origin) pushWallRing(ring, origin, h, verts, gWall);
        }
        if (origin) {
          for (const p of lids[pi]) {
            lidVerts.push(p.x - origin[0], p.y - origin[1], h * p.zPerM);
            pushGlobeVert(gLid, p, h);
          }
        }
      }
    }
    // ALL boundary lines (focus children on the lid + context siblings and the
    // world-scope country outline on the ground) as line quads. Each vertex
    // carries the segment's OTHER endpoint + a side sign; the shader extrudes
    // perpendicular in SCREEN space (constant px width — the reason these are
    // GL, not a draped layer: draping bakes lines into integer-zoom tile
    // textures whose magnification breathes with the fractional zoom). A vertex
    // stored at B sees the segment direction flipped, so its side signs invert.
    // Vertices accumulate into per-(width, alpha, raised) groups, concatenated
    // afterwards so each regime keeps ONE buffer with per-group draw ranges.
    // 0.2% above the lid: lid and lines triangulate the same curved surface
    // differently, so exact depth ties would lose fragments to LEQUAL noise.
    const hl = h * 1.002;
    // Ground lines float 12 m up (same clearance as the halo): in the mercator
    // regime they are DEPTH-TESTED against the map's own depth buffer — that is
    // what hides the parts running behind the raised plateau — so they need
    // enough altitude not to z-fight the flat terrain surface they sit on.
    const GROUND_ALT = 12;
    const raisedPlateau = features.length > 0 && h > 0;
    type LineGroup = {
      width: number;
      alpha: number;
      raised: boolean;
      verts: number[];
      gVerts: number[];
    };
    const lineGroupMap = new Map<string, LineGroup>();
    const addLineFeature = (
      f: OutlineFC["features"][number],
      alt: number,
      alpha: number,
      raised: boolean,
    ) => {
      const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
      if (!g?.type) return;
      // Width follows the FEATURE's own level (country/région outlines read
      // heavy at full width), so context siblings keep the exact weight they
      // had when they were the focus one level up.
      const level = String(f.properties?.level ?? "");
      const width = level === "country" || level === "region" ? 0.9 : 1.7;
      const key = `${width}|${alpha}|${raised}`;
      let grp = lineGroupMap.get(key);
      if (!grp) {
        grp = { width, alpha, raised, verts: [], gVerts: [] };
        lineGroupMap.set(key, grp);
      }
      // Globe line vertex: self + other endpoint (each merc + ECEF pair) + offset
      // side + GEOMETRIC side — 20 floats. `side` drives the screen-space offset
      // (its sign inverts at the B end, where the direction vector flips);
      // `geomSide` is the CONSISTENT left/right used by the feather varying —
      // reusing `side` there makes the feather cross zero mid-segment and hit ±1
      // at every join, which beads dense contours into near-invisibility.
      const pushGL = (p: PBase, o: PBase, side: number, geomSide: number) => {
        grp!.gVerts.push(p.x, p.y, alt * p.zPerM, p.lo[0], p.lo[1], p.lo[2]);
        grp!.gVerts.push(p.lo[0] + alt * p.d[0], p.lo[1] + alt * p.d[1], p.lo[2] + alt * p.d[2]);
        grp!.gVerts.push(o.x, o.y, alt * o.zPerM, o.lo[0], o.lo[1], o.lo[2]);
        grp!.gVerts.push(o.lo[0] + alt * o.d[0], o.lo[1] + alt * o.d[1], o.lo[2] + alt * o.d[2]);
        grp!.gVerts.push(side, geomSide);
      };
      for (const rings of ringBasesOf(g)) {
        for (const pts of rings) {
          for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            // No walls (world scope) → the first line vertex anchors the origin.
            if (!origin) origin = [a.x, a.y];
            const ax = a.x - origin[0];
            const ay = a.y - origin[1];
            const bx = b.x - origin[0];
            const by = b.y - origin[1];
            const az = alt * a.zPerM;
            const bz = alt * b.zPerM;
            // Quad corners A+ B+ B- A- as two triangles (last two floats:
            // offset side, geometric side).
            grp!.verts.push(ax, ay, az, bx, by, bz, +1, +1); // A+
            grp!.verts.push(bx, by, bz, ax, ay, az, -1, +1); // B+
            grp!.verts.push(bx, by, bz, ax, ay, az, +1, -1); // B-
            grp!.verts.push(ax, ay, az, bx, by, bz, +1, +1); // A+
            grp!.verts.push(bx, by, bz, ax, ay, az, +1, -1); // B-
            grp!.verts.push(ax, ay, az, bx, by, bz, -1, -1); // A-
            pushGL(a, b, +1, +1);
            pushGL(b, a, -1, +1);
            pushGL(b, a, +1, -1);
            pushGL(a, b, +1, +1);
            pushGL(b, a, +1, -1);
            pushGL(a, b, -1, -1);
          }
        }
      }
    };
    // Focus children sit ON the lid while a plateau stands; with no plateau
    // (world scope) they draw at ground level like everything else. Lifting
    // them is safe because the raised outline comes from the same source as
    // they do (GeoNav: france-geojson for the country and its régions and
    // départements, a département raised as the union of its communes' Géo API
    // contours, those contours for villes and arrondissements), so it holds
    // them. Only a département whose own outline could not be had rises with
    // its france-geojson one, which a commune can cross by up to ~1 km. A child
    // is lifted only where its box meets one of the raised polygons': the data
    // can file a unit under a scope whose outline leaves it out (Saint-Martin
    // under the Guadeloupe, some 250 km off its islands), and that one stays
    // on the ground, where it is.
    const boxesOf = (f: OutlineFC["features"][number]) =>
      polysOf((f.geometry ?? {}) as { type?: string; coordinates?: unknown }).map((poly) =>
        ringBounds(poly[0]),
      );
    const lidBoxes = raisedPlateau ? features.flatMap(boxesOf) : [];
    const lifted = new Set(
      focus.filter((f) => boxesOf(f).some((b) => lidBoxes.some((l) => boundsIntersect(b, l)))),
    );
    for (const f of focus) {
      addLineFeature(f, lifted.has(f) ? hl : GROUND_ALT, 0.95, lifted.has(f));
    }
    for (const f of context) addLineFeature(f, GROUND_ALT, 0.85, false);
    const lineVerts: number[] = [];
    const gLine: number[] = [];
    this.lineGroups = [];
    for (const grp of lineGroupMap.values()) {
      const count = grp.verts.length / 8;
      if (!count) continue;
      this.lineGroups.push({
        width: grp.width,
        alpha: grp.alpha,
        raised: grp.raised,
        start: lineVerts.length / 8,
        count,
      });
      for (const v of grp.verts) lineVerts.push(v);
      for (const v of grp.gVerts) gLine.push(v);
    }
    // Hover fills: opaque violet sweep that FILLS FROM THE BOUNDARY INWARD. Each
    // unit's polygon is earcut then refined (edge ≤ ~span/9) so vertices exist in
    // the interior, and every vertex carries its normalized distance to the
    // unit's boundary — the shader animates an alpha threshold over that varying.
    // FOCUS units sit just above the lid; CONTEXT siblings sit ~3 m above the
    // ground (they're outside the plateau). One concatenated mesh, drawn by
    // per-unit vertex range.
    // LAZY: at most ONE fill is ever drawn (the hovered unit; a retracting one is
    // copied out at beginSelection), yet building them all here cost ~373k
    // vertices and ~159M distance-field ops per drill — measured at ~985 ms, the
    // single biggest cost on the map. Record what COULD be filled and build the
    // one unit on demand in ensureFill().
    this.fillRanges.clear();
    this.pendingFills.clear();
    this.fillOrigin = origin;
    this.hovPositions = new Float32Array(0);
    this.gHovPositions = new Float32Array(0);
    this.hovDirty = true;
    this.gHovDirty = true;
    // No plateau (world scope) → skip: the GL sweep only runs with a plateau up
    // (the draped scope-hover-fill is the fallback there), so the refined fill
    // meshes would be dead weight.
    if (origin && features.length) {
      const record = (f: OutlineFC["features"][number], altM: number, raised: boolean) => {
        const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
        if (!g?.type) return;
        this.pendingFills.set(String(f.properties?.id ?? ""), { g, altM, raised });
      };
      // Above the lid (h), below the lines — on the ground, a child left there.
      for (const f of focus) {
        if (lifted.has(f)) record(f, h * 1.001, true);
        else record(f, GROUND_ALT, false);
      }
      // Context siblings live at ground level, depth-tested like the ground
      // lines (their fill must hide behind the raised plateau too).
      for (const f of context) record(f, GROUND_ALT, false);
    }
    // fillRanges was just cleared, but hoveredFillId still points at the unit
    // under the cursor — the render pass would look up a range that no longer
    // exists and silently drop the highlight, with setHover/setHovered's
    // early-returns making it unrecoverable until the cursor left and re-entered.
    // Re-arm it (rebuilds the discarded mesh; skips nothing load-bearing).
    const stillHovered = this.hoveredFillId;
    if (stillHovered) {
      this.hoveredFillId = "";
      this.setHovered(stillHovered);
    }
    // Halo: a CONTINUOUS ribbon hugging the scope boundary — the ring is first
    // SIMPLIFIED to segments comparable to the band width (per-segment screen
    // quads on a jagged boundary read as separate spikes), then each kept vertex
    // is offset OUTWARD along its miter normal in GEO space (width ∝ unit size).
    // Inner edge d=0 sits at the wall base, outer edge d=1. Layouts match the
    // fill meshes ([pos, d]) so the programs stay simple. 12 m off the ground:
    // outside the plateau the DEM is flat 0, and the offset avoids drape z-fight.
    const haloVerts: number[] = []; // [x, y, z, d]
    const gHalo: number[] = []; // [merc3, lo3, hi3, d]
    if (origin) {
      const HALO_ALT = 12;
      // Band width in degrees, proportional to the selection's own span.
      let mnLa = 90;
      let mxLa = -90;
      let mnLo = 180;
      let mxLo = -180;
      for (const f of features) {
        const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
        if (!g?.type) continue;
        for (const poly of polysOf(g)) {
          for (const ring of poly) {
            for (const [lng, lat] of ring) {
              if (lat < mnLa) mnLa = lat;
              if (lat > mxLa) mxLa = lat;
              if (lng < mnLo) mnLo = lng;
              if (lng > mxLo) mxLo = lng;
            }
          }
        }
      }
      const cosH = Math.cos((((mnLa + mxLa) / 2) * Math.PI) / 180) || 1e-6;
      const spanH = Math.max(mxLa - mnLa, (mxLo - mnLo) * cosH);
      const W = Math.max(spanH / 95, 0.003); // ° of latitude-equivalent
      // Kept for the analyses' slabs: their glow is the plateau's.
      this.haloW = features.length ? W : 0;
      this.haloCos = cosH;
      const pushHV = (b: PBase, d: number) =>
        pushHaloVert(haloVerts, gHalo, b, d, origin!, HALO_ALT);
      for (const f of features) {
        const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
        if (!g?.type) continue;
        for (const rings of ringBasesOf(g)) {
          for (const ringB of rings) buildHaloRing(ringB, W, cosH, pushHV);
        }
      }
    }
    this.haloPositions = new Float32Array(haloVerts);
    this.gHaloPositions = new Float32Array(gHalo);
    this.haloVertexCount = haloVerts.length / 4;
    this.haloDirty = true;
    this.gHaloDirty = true;

    this.positions = new Float32Array(verts);
    this.vertexCount = verts.length / 3;
    this.lidPositions = new Float32Array(lidVerts);
    this.lidVertexCount = lidVerts.length / 3;
    this.linePositions = new Float32Array(lineVerts);
    this.lineVertexCount = lineVerts.length / 8;
    this.gWallPositions = new Float32Array(gWall);
    this.gLidPositions = new Float32Array(gLid);
    this.gLinePositions = new Float32Array(gLine);
    this.origin = origin ?? [0, 0];
    this.dirty = true;
    this.lidDirty = true;
    this.lineDirty = true;
    this.gWallDirty = true;
    this.gLidDirty = true;
    this.gLineDirty = true;
    this.map?.triggerRepaint();
  }

  /** Provide/replace the lid's map texture (a hidden-map snapshot). Uploaded on
   *  the next render. Passing null drops the lid (walls-only, the status quo). */
  setLidTexture(snap: Snapshot | null) {
    if (this.lidPending) {
      this.lidPending.bitmap.close();
      this.lidPending = null;
    }
    if (!snap) {
      this.lidMerc = null; // render skips the lid; old GL texture freed on next upload
      this.map?.triggerRepaint();
      return;
    }
    this.lidPending = snap;
    this.map?.triggerRepaint();
  }

  setScale(v: number) {
    this.scale = v;
    this.map?.triggerRepaint();
  }

  /**
   * Keep the camera this frame is drawn with, for the frame bus. Copied into
   * preallocated arrays: mapbox hands over fresh ones every frame
   * (customLayerMatrix() is a slice), and nothing here holds on to them.
   */
  private captureCamera(
    matrix: ArrayLike<number>,
    onGlobe: boolean,
    globeToMerc?: ArrayLike<number>,
    transition?: number,
    centre?: ArrayLike<number>,
    pxRatio?: number,
  ) {
    const cam = this.cam;
    for (let i = 0; i < 16; i++) cam.m[i] = matrix[i];
    cam.globe = onGlobe;
    if (onGlobe && globeToMerc && centre) {
      for (let i = 0; i < 16; i++) cam.g2m[i] = globeToMerc[i];
      cam.t = transition ?? 0;
      cam.cx = centre[0];
      cam.cy = centre[1];
      cam.r = pxRatio ?? 1;
    }
    cam.seq++;
  }

  /**
   * Project packed points (see STRIDE) at `altM` metres with the camera of the
   * last frame drawn, exactly as this layer's own vertex shaders place the
   * plateau: px into out[2i], out[2i + 1], validity into ok[i].
   *  - mercator (z ≥ 6): clip = M·[x, y, altM·zPerM, 1], as the wall program
   *    does once its origin fold is undone (float64 here: no fold needed).
   *  - globe (z < 6): GLOBE_PROJECT_GLSL's morphProject line for line — the
   *    sphere point M·G·[lo + altM·d, 1] / w, then, through z 5–6 (t > 0),
   *    mixed in NDC toward the mercator twin rescaled around the centre by the
   *    pixels-per-metre ratio. Both w ≤ 0 rejections are kept: such a vertex
   *    is clipped there, so it is not valid here.
   * Not map.project: in mercator it adds the terrain SAMPLED under the point
   * (double height inside the plateau, ~0 on the eroded rim, 0 where DEM tiles
   * are missing); on the globe, the centre's altitude.
   */
  projectInto(
    src: Float64Array,
    count: number,
    altM: number,
    w: number,
    h: number,
    out: Float32Array,
    ok: Uint8Array,
    /** The first point of `src` to project (the points before it skipped). */
    start = 0,
  ) {
    const { m, g2m: g, globe, t, cx, cy, r } = this.cam;
    const hw = w / 2;
    const hh = h / 2;
    for (let i = 0; i < count; i++) {
      const o = (start + i) * STRIDE;
      const x = src[o];
      const y = src[o + 1];
      const z = altM * src[o + 2];
      let nx: number;
      let ny: number;
      if (!globe) {
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (!(cw > 0)) {
          ok[i] = 0;
          continue;
        }
        nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
        ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      } else {
        // mix(ecefLo, ecefHi, uScale) = lo + (h·uScale)·d = lo + altM·d
        const ex = src[o + 3] + altM * src[o + 6];
        const ey = src[o + 4] + altM * src[o + 7];
        const ez = src[o + 5] + altM * src[o + 8];
        const gx = g[0] * ex + g[4] * ey + g[8] * ez + g[12];
        const gy = g[1] * ex + g[5] * ey + g[9] * ez + g[13];
        const gz = g[2] * ex + g[6] * ey + g[10] * ez + g[14];
        const gw = g[3] * ex + g[7] * ey + g[11] * ez + g[15];
        const pw = m[3] * gx + m[7] * gy + m[11] * gz + m[15] * gw;
        if (!(pw > 0)) {
          ok[i] = 0;
          continue;
        }
        nx = (m[0] * gx + m[4] * gy + m[8] * gz + m[12] * gw) / pw;
        ny = (m[1] * gx + m[5] * gy + m[9] * gz + m[13] * gw) / pw;
        if (t > 0) {
          // merc.z·uScale·uPxRatio, with merc.z = h·zPerM: altM·zPerM·r
          const mx = (x - cx) * r + cx;
          const my = (y - cy) * r + cy;
          const mz = z * r;
          const mw = m[3] * mx + m[7] * my + m[11] * mz + m[15];
          if (!(mw > 0)) {
            ok[i] = 0;
            continue;
          }
          nx += ((m[0] * mx + m[4] * my + m[8] * mz + m[12]) / mw - nx) * t;
          ny += ((m[1] * mx + m[5] * my + m[9] * mz + m[13]) / mw - ny) * t;
        }
      }
      out[2 * i] = (nx + 1) * hw;
      out[2 * i + 1] = (1 - ny) * hh;
      ok[i] = 1;
    }
  }

  onAdd(map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    // Ceiling for the lid snapshot: asking for a bitmap wider than this uploads
    // nothing and the plateau falls back to bare draped terrain.
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = compile(
      gl.VERTEX_SHADER,
      `attribute vec3 aPos;
       uniform mat4 uMatrix;
       uniform float uScale;
       void main() { gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0); }`,
    );
    const fs = compile(
      gl.FRAGMENT_SHADER,
      `void main() { gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0); }`,
    );
    const p = gl.createProgram();
    if (!p || !vs || !fs) return;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    this.program = p;
    this.aPos = gl.getAttribLocation(p, "aPos");
    this.uMatrix = gl.getUniformLocation(p, "uMatrix");
    this.uScale = gl.getUniformLocation(p, "uScale");
    this.buffer = gl.createBuffer();
    // Lid program: UV derived from the vertex's mercator position (an affine map
    // into the snapshot's mercator rectangle) — no UV attribute needed, so
    // re-snapshots never touch the mesh. Fragments outside the snapshot discard
    // (the draped terrain below shows instead — still the map).
    const lvs = compile(
      gl.VERTEX_SHADER,
      `attribute vec3 aPos;
       uniform mat4 uMatrix;
       uniform float uScale;
       uniform vec2 uTexOrigin;
       uniform vec2 uTexSpan;
       varying vec2 vUV;
       void main() {
         vUV = (aPos.xy - uTexOrigin) / uTexSpan;
         gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
       }`,
    );
    const lfs = compile(
      gl.FRAGMENT_SHADER,
      `precision mediump float;
       varying vec2 vUV;
       uniform sampler2D uTex;
       void main() {
         if (vUV.x < 0.0 || vUV.x > 1.0 || vUV.y < 0.0 || vUV.y > 1.0) discard;
         gl_FragColor = texture2D(uTex, vUV);
       }`,
    );
    const lp = gl.createProgram();
    if (lp && lvs && lfs) {
      gl.attachShader(lp, lvs);
      gl.attachShader(lp, lfs);
      gl.linkProgram(lp);
      this.lidProgram = lp;
      this.lidAPos = gl.getAttribLocation(lp, "aPos");
      this.lidUMatrix = gl.getUniformLocation(lp, "uMatrix");
      this.lidUScale = gl.getUniformLocation(lp, "uScale");
      this.lidUTexOrigin = gl.getUniformLocation(lp, "uTexOrigin");
      this.lidUTexSpan = gl.getUniformLocation(lp, "uTexSpan");
      this.lidBuffer = gl.createBuffer();
    }
    // Line program: perpendicular extrusion in screen space → constant pixel width
    // at any zoom (what a Mapbox line layer does, but at the lid's height). The
    // quad is 1 px wider each side and the fragment alpha feathers over that
    // pixel (vSide interpolates -1…1 across the width) — analytic anti-aliasing,
    // since hard quad edges alias badly on dense commune contours.
    const nvs = compile(
      gl.VERTEX_SHADER,
      `attribute vec3 aPos;
       attribute vec3 aOther;
       attribute float aSide;
       attribute float aGeomSide;
       uniform mat4 uMatrix;
       uniform float uScale;
       uniform vec2 uViewport;
       uniform float uWidth;
       varying float vSide;
       void main() {
         vec4 p = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
         vec4 q = uMatrix * vec4(aOther.xy, aOther.z * uScale, 1.0);
         vec2 d = (q.xy / q.w - p.xy / p.w) * uViewport;
         float len = length(d);
         vec2 n = len > 0.0 ? vec2(-d.y, d.x) / len : vec2(0.0, 0.0);
         vSide = aGeomSide;
         gl_Position = p + vec4(n * aSide * (uWidth + 2.0) / uViewport * p.w, 0.0, 0.0);
       }`,
    );
    const nfs = compile(
      gl.FRAGMENT_SHADER,
      // #7c5cff at the group's opacity, premultiplied (custom layers blend
      // premultiplied), with a 1 px alpha feather at the edges.
      `precision highp float;
       varying float vSide;
       uniform float uWidth;
       uniform float uAlpha;
       void main() {
         float a = clamp((uWidth * 0.5 + 1.0) * (1.0 - abs(vSide)), 0.0, 1.0) * uAlpha;
         gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0) * a;
       }`,
    );
    const np = gl.createProgram();
    if (np && nvs && nfs) {
      gl.attachShader(np, nvs);
      gl.attachShader(np, nfs);
      gl.linkProgram(np);
      this.lineProgram = np;
      this.lineAPos = gl.getAttribLocation(np, "aPos");
      this.lineAOther = gl.getAttribLocation(np, "aOther");
      this.lineASide = gl.getAttribLocation(np, "aSide");
      this.lineAGeomSide = gl.getAttribLocation(np, "aGeomSide");
      this.lineUMatrix = gl.getUniformLocation(np, "uMatrix");
      this.lineUScale = gl.getUniformLocation(np, "uScale");
      this.lineUViewport = gl.getUniformLocation(np, "uViewport");
      this.lineUWidth = gl.getUniformLocation(np, "uWidth");
      this.lineUAlpha = gl.getUniformLocation(np, "uAlpha");
      this.lineBuffer = gl.createBuffer();
    }
    // ---- globe-regime programs (zoom < 6): the same three passes, positions
    // morph-projected between the sphere (ECEF) and mercator by the transition ----
    const GLOBE_UNIS = ["uProj", "uGlobeToMerc", "uT", "uCenterMerc", "uPxRatio", "uScale"];
    this.gWallProg = buildProgram(
      gl,
      `attribute vec3 aMerc;
       attribute vec3 aEcefLo;
       attribute vec3 aEcefHi;
       ${GLOBE_PROJECT_GLSL}
       void main() { gl_Position = morphProject(aMerc, aEcefLo, aEcefHi); }`,
      `void main() { gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0); }`,
      ["aMerc", "aEcefLo", "aEcefHi"],
      GLOBE_UNIS,
    );
    this.gLidProg = buildProgram(
      gl,
      `attribute vec3 aMerc;
       attribute vec3 aEcefLo;
       attribute vec3 aEcefHi;
       uniform vec2 uTexOrigin;
       uniform vec2 uTexSpan;
       varying vec2 vUV;
       ${GLOBE_PROJECT_GLSL}
       void main() {
         vUV = (aMerc.xy - uTexOrigin) / uTexSpan;
         gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
       }`,
      `precision mediump float;
       varying vec2 vUV;
       uniform sampler2D uTex;
       void main() {
         if (vUV.x < 0.0 || vUV.x > 1.0 || vUV.y < 0.0 || vUV.y > 1.0) discard;
         gl_FragColor = texture2D(uTex, vUV);
       }`,
      ["aMerc", "aEcefLo", "aEcefHi"],
      [...GLOBE_UNIS, "uTexOrigin", "uTexSpan"],
    );
    this.gLineProg = buildProgram(
      gl,
      `attribute vec3 aMerc;
       attribute vec3 aEcefLo;
       attribute vec3 aEcefHi;
       attribute vec3 aOMerc;
       attribute vec3 aOEcefLo;
       attribute vec3 aOEcefHi;
       attribute float aSide;
       attribute float aGeomSide;
       uniform vec2 uViewport;
       uniform float uWidth;
       varying float vSide;
       ${GLOBE_PROJECT_GLSL}
       void main() {
         vec4 p = morphProject(aMerc, aEcefLo, aEcefHi);
         vec4 q = morphProject(aOMerc, aOEcefLo, aOEcefHi);
         vec2 d = (q.xy / q.w - p.xy / p.w) * uViewport;
         float len = length(d);
         vec2 n = len > 0.0 ? vec2(-d.y, d.x) / len : vec2(0.0, 0.0);
         vSide = aGeomSide;
         gl_Position = p + vec4(n * aSide * (uWidth + 2.0) / uViewport * p.w, 0.0, 0.0);
       }`,
      `precision highp float;
       varying float vSide;
       uniform float uWidth;
       uniform float uAlpha;
       void main() {
         float a = clamp((uWidth * 0.5 + 1.0) * (1.0 - abs(vSide)), 0.0, 1.0) * uAlpha;
         gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0) * a;
       }`,
      ["aMerc", "aEcefLo", "aEcefHi", "aOMerc", "aOEcefLo", "aOEcefHi", "aSide", "aGeomSide"],
      [...GLOBE_UNIS, "uViewport", "uWidth", "uAlpha"],
    );
    this.gWallBuffer = gl.createBuffer();
    this.gLidBuffer = gl.createBuffer();
    this.gLineBuffer = gl.createBuffer();
    // Hover-fill programs: OPAQUE boundary-violet, swept inward — each vertex
    // carries its normalized distance to the unit's boundary and uFillT animates
    // the filled band from the edge (d = 0) toward the centre (d = 1).
    const FILL_FS = `precision highp float;
       varying float vDist;
       uniform float uFillT;
       void main() {
         float a = (1.0 - smoothstep(uFillT - 0.12, uFillT, vDist)) * 0.6;
         gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0) * a;
       }`;
    this.fillProg = buildProgram(
      gl,
      `attribute vec3 aPos;
       attribute float aDist;
       uniform mat4 uMatrix;
       uniform float uScale;
       varying float vDist;
       void main() {
         vDist = aDist;
         gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
       }`,
      FILL_FS,
      ["aPos", "aDist"],
      ["uMatrix", "uScale", "uFillT"],
    );
    this.gFillProg = buildProgram(
      gl,
      `attribute vec3 aMerc;
       attribute vec3 aEcefLo;
       attribute vec3 aEcefHi;
       attribute float aDist;
       varying float vDist;
       ${GLOBE_PROJECT_GLSL}
       void main() {
         vDist = aDist;
         gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
       }`,
      FILL_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aDist"],
      [...GLOBE_UNIS, "uFillT"],
    );
    this.hovBuffer = gl.createBuffer();
    this.gHovBuffer = gl.createBuffer();
    this.retractBuffer = gl.createBuffer();
    this.gRetractBuffer = gl.createBuffer();
    // Halo programs: a continuous glow ribbon fading outward from the wall base,
    // with a smooth breathing swell whose phase drifts outward (a continuous
    // sine — a fract() ramp gives hard moving fronts that read as spikes).
    const HALO_FS = `precision highp float;
       varying float vD;
       uniform float uPulseT;
       void main() {
         float wave = 0.5 + 0.5 * sin(6.2831853 * (uPulseT - vD * 0.4));
         float a = pow(1.0 - vD, 1.6) * (0.22 + 0.4 * wave);
         gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0) * a;
       }`;
    this.haloProg = buildProgram(
      gl,
      `attribute vec3 aPos;
       attribute float aDist;
       uniform mat4 uMatrix;
       uniform float uScale;
       varying float vD;
       void main() {
         vD = aDist;
         gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
       }`,
      HALO_FS,
      ["aPos", "aDist"],
      ["uMatrix", "uScale", "uPulseT"],
    );
    this.gHaloProg = buildProgram(
      gl,
      `attribute vec3 aMerc;
       attribute vec3 aEcefLo;
       attribute vec3 aEcefHi;
       attribute float aDist;
       varying float vD;
       ${GLOBE_PROJECT_GLSL}
       void main() {
         vD = aDist;
         gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
       }`,
      HALO_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aDist"],
      [...GLOBE_UNIS, "uPulseT"],
    );
    this.haloBuffer = gl.createBuffer();
    this.gHaloBuffer = gl.createBuffer();
    // The slabs' pieces: each vertex in its colour — the ring's parts and the
    // bar their theme's, the words' boxes' walls the plateau's violet —, or
    // the one colour uTint gives where its alpha is 1 (the words' boxes'
    // lids, opaque: the site's card). Straight to the framebuffer, opaque:
    // premultiplied or not, the same.
    const PIECE_FS = `precision mediump float;
       varying vec3 vColor;
       uniform vec4 uTint;
       void main() { gl_FragColor = vec4(mix(vColor, uTint.rgb, uTint.a), 1.0); }`;
    this.slabPieceProg = buildProgram(
      gl,
      `attribute vec3 aPos;
       attribute vec3 aColor;
       uniform mat4 uMatrix;
       uniform float uScale;
       varying vec3 vColor;
       void main() {
         vColor = aColor;
         gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
       }`,
      PIECE_FS,
      ["aPos", "aColor"],
      ["uMatrix", "uScale", "uTint"],
    );
    this.gSlabPieceProg = buildProgram(
      gl,
      `attribute vec3 aMerc;
       attribute vec3 aEcefLo;
       attribute vec3 aEcefHi;
       attribute vec3 aColor;
       varying vec3 vColor;
       ${GLOBE_PROJECT_GLSL}
       void main() {
         vColor = aColor;
         gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
       }`,
      PIECE_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aColor"],
      [...GLOBE_UNIS, "uTint"],
    );
    this.slabWallBuf = gl.createBuffer();
    this.slabLidBuf = gl.createBuffer();
    this.slabHaloBuf = gl.createBuffer();
    this.gSlabWallBuf = gl.createBuffer();
    this.gSlabLidBuf = gl.createBuffer();
    this.gSlabHaloBuf = gl.createBuffer();
    // A fresh context knows nothing of the slabs built before it.
    this.slabDirty = true;
    this.gSlabDirty = true;
  }

  onRemove(_map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = 0;
    }
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.lidProgram) gl.deleteProgram(this.lidProgram);
    if (this.lidBuffer) gl.deleteBuffer(this.lidBuffer);
    if (this.lidTexture) gl.deleteTexture(this.lidTexture);
    if (this.lidPending) this.lidPending.bitmap.close();
    if (this.lineProgram) gl.deleteProgram(this.lineProgram);
    if (this.lineBuffer) gl.deleteBuffer(this.lineBuffer);
    for (const p of [
      this.gWallProg,
      this.gLidProg,
      this.gLineProg,
      this.fillProg,
      this.gFillProg,
      this.haloProg,
      this.gHaloProg,
      this.slabPieceProg,
      this.gSlabPieceProg,
    ]) {
      if (p) gl.deleteProgram(p.prog);
    }
    for (const b of [
      this.gWallBuffer,
      this.gLidBuffer,
      this.gLineBuffer,
      this.hovBuffer,
      this.gHovBuffer,
      this.retractBuffer,
      this.gRetractBuffer,
      this.haloBuffer,
      this.gHaloBuffer,
      this.slabWallBuf,
      this.slabLidBuf,
      this.slabHaloBuf,
      this.gSlabWallBuf,
      this.gSlabLidBuf,
      this.gSlabHaloBuf,
    ]) {
      if (b) gl.deleteBuffer(b);
    }
    this.slabPieceProg = null;
    this.gSlabPieceProg = null;
    this.slabWallBuf = null;
    this.slabLidBuf = null;
    this.slabHaloBuf = null;
    this.gSlabWallBuf = null;
    this.gSlabLidBuf = null;
    this.gSlabHaloBuf = null;
    this.program = null;
    this.buffer = null;
    this.lidProgram = null;
    this.lidBuffer = null;
    this.lidTexture = null;
    this.lidPending = null;
    this.lidMerc = null;
    this.lineProgram = null;
    this.lineBuffer = null;
    this.gWallProg = null;
    this.gLidProg = null;
    this.gLineProg = null;
    this.gWallBuffer = null;
    this.gLidBuffer = null;
    this.gLineBuffer = null;
    this.fillProg = null;
    this.gFillProg = null;
    this.hovBuffer = null;
    this.gHovBuffer = null;
    this.retractBuffer = null;
    this.gRetractBuffer = null;
    this.haloProg = null;
    this.gHaloProg = null;
    this.haloBuffer = null;
    this.gHaloBuffer = null;
    this.retractActive = false;
    this.map = null;
  }

  render(
    gl: WebGL2RenderingContext,
    matrix: number[],
    projection?: unknown,
    globeToMercMatrix?: number[],
    transition?: number,
    centerInMercator?: number[],
    pixelsPerMeterRatio?: number,
  ) {
    // GLOBE regime (zoom < 6): mapbox passes the extra projection args and the
    // camera is the globe camera — draw via the morph programs. At z ≥ 6 it calls
    // with 2 args (pure mercator pipeline) and the classic path below runs.
    const onGlobe = globeFrame(
      projection,
      globeToMercMatrix,
      transition,
      centerInMercator,
      pixelsPerMeterRatio,
    );
    // Kept on EVERY frame, before anything can bail out below: the frame bus
    // projects with it whether or not there is anything to draw.
    this.captureCamera(
      matrix,
      onGlobe,
      globeToMercMatrix,
      transition,
      centerInMercator,
      pixelsPerMeterRatio,
    );
    // Boundary lines render even with no plateau standing (world scope / sunk),
    // so only bail when there is nothing at all to draw.
    if ((!this.vertexCount || this.scale <= 0.001) && !this.lineVertexCount) return;
    // Upload a freshly captured snapshot (bitmap → texture) whichever regime draws.
    if (this.lidPending) {
      const snap = this.lidPending;
      this.lidPending = null;
      // Reuse the texture object: deleting one the driver may still be sampling
      // forces a sync, and texImage2D fully re-specs (a different size is fine),
      // so there is nothing to gain from a fresh name. The lid is now re-captured
      // on zoom, making this a repeated cost rather than a one-off.
      const tex = this.lidTexture ?? gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // row 0 = north = min mercator y
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap.bitmap);
      // The lid is a texture on a plane the camera looks ALONG at ELEV_PITCH, so
      // its far half is minified and its near half magnified. A plain LINEAR
      // min-filter takes a single bilinear tap per fragment, which drops detail
      // and shimmers across the far half — while the live basemap beside it
      // stays crisp, because mapbox mipmaps its own rasters. Hence trilinear,
      // plus anisotropy: that is what recovers the foreshortened axis, which
      // mipmapping ALONE would blur away (it picks a LOD for the worse axis).
      // WebGL2 (mapbox-gl v3 requires it), so NPOT mipmaps are legal.
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.maxAniso === 0) {
        const ext = gl.getExtension("EXT_texture_filter_anisotropic");
        this.anisoExt = ext;
        this.maxAniso = ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : -1;
      }
      if (this.anisoExt && this.maxAniso > 1) {
        gl.texParameterf(
          gl.TEXTURE_2D,
          this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, this.maxAniso),
        );
      }
      this.lidTexture = tex;
      this.lidMerc = snap.merc;
      snap.bitmap.close();
    }
    gl.disable(gl.CULL_FACE); // wall sheet is double-sided; lid winding is mixed
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    if (import.meta.env.DEV) {
      const regime = onGlobe ? `globe(t=${transition?.toFixed(2)})` : "mercator";
      if (this.lastRegimeLog !== regime) {
        this.lastRegimeLog = regime;
        console.info(
          `[plateau] render ${regime} verts=${this.vertexCount} lid=${this.lidVertexCount} ` +
            `lines=${this.lineVertexCount} scale=${this.scale.toFixed(2)} ` +
            `progs=${[!!this.gWallProg, !!this.gLidProg, !!this.gLineProg].join(",")}`,
        );
      }
    }
    if (onGlobe) {
      this.renderGlobe(
        gl,
        matrix,
        globeToMercMatrix!,
        transition!,
        centerInMercator!,
        pixelsPerMeterRatio!,
      );
      return;
    }
    if (!this.program || !this.buffer) return;
    // Fold the mesh origin into the (float64) matrix so float32 vertices keep
    // sub-metre precision: M' = M × T(origin).
    const m = matrix;
    const [tx, ty] = this.origin;
    const t = m.slice();
    t[12] = m[0] * tx + m[4] * ty + m[12];
    t[13] = m[1] * tx + m[5] * ty + m[13];
    t[14] = m[2] * tx + m[6] * ty + m[14];
    t[15] = m[3] * tx + m[7] * ty + m[15];
    const mat = new Float32Array(t);

    gl.disable(gl.CULL_FACE); // wall sheet is double-sided; lid winding is mixed
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // ---- lid DEPTH pre-pass ----
    // The plateau top must own the depth buffer BEFORE the walls draw. The far
    // wall's inner face lives underneath the lid, so it is only ever hidden by
    // something nearer — and the textured lid below cannot be relied on for
    // that: it is skipped when no snapshot has landed yet, and it DISCARDS
    // wherever the texture doesn't reach (after a scope change the texture
    // still covers the PREVIOUS unit until the new capture lands ~1 s later).
    // In that window the wall showed straight through the plateau top. Colour
    // writes are off — this contributes depth only, so the visible surface is
    // still the textured lid, or the draped terrain where it discards.
    if (this.program && this.lidBuffer && this.lidVertexCount && this.scale >= 0.15) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lidBuffer);
      if (this.lidDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.lidPositions, gl.STATIC_DRAW);
        this.lidDirty = false;
      }
      gl.uniformMatrix4fv(this.uMatrix, false, mat);
      gl.uniform1f(this.uScale, this.scale);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 12, 0);
      gl.colorMask(false, false, false, false);
      gl.drawArrays(gl.TRIANGLES, 0, this.lidVertexCount);
      gl.colorMask(true, true, true, true);
    }

    // ---- walls ----
    if (this.vertexCount && this.scale > 0.001) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      if (this.dirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
        this.dirty = false;
      }
      gl.uniformMatrix4fv(this.uMatrix, false, mat);
      gl.uniform1f(this.uScale, this.scale);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 12, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }

    // ---- lid (map-textured top) ----
    // Skip while no texture, or during the first rise frames (lid/terrain
    // separation collapses toward 0 → depth shimmer).
    if (
      this.lidProgram &&
      this.lidBuffer &&
      this.lidVertexCount &&
      this.lidTexture &&
      this.lidMerc &&
      this.scale >= 0.15
    ) {
      gl.useProgram(this.lidProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lidBuffer);
      if (this.lidDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.lidPositions, gl.STATIC_DRAW);
        this.lidDirty = false;
      }
      gl.uniformMatrix4fv(this.lidUMatrix, false, mat);
      gl.uniform1f(this.lidUScale, this.scale);
      // UV affine: positions are origin-relative, so shift the texture origin too.
      gl.uniform2f(
        this.lidUTexOrigin,
        this.lidMerc.minX - this.origin[0],
        this.lidMerc.minY - this.origin[1],
      );
      gl.uniform2f(this.lidUTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
      gl.enableVertexAttribArray(this.lidAPos);
      gl.vertexAttribPointer(this.lidAPos, 3, gl.FLOAT, false, 12, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.lidVertexCount);
    }

    // ---- the analyses' slabs: their lids, then their walls (depth written:
    // the ground lines and glows drawn after hide behind them, and blend over
    // their feet). Glass, the words' boxes go after those (below): what lies
    // under a glass is seen through it, the lines as the map's labels. Drawn
    // again over the map's labels: renderSlabs ----
    const ss = this.scale * this.slabP;
    const slabs = this.slabWallCount > 0 && ss > 0.001;
    const glass = this.slabLid === "verre";
    if (slabs) {
      this.uploadSlabsMercator(gl);
      foldOrigin(matrix, this.slabOrigin[0], this.slabOrigin[1], this.slabMat);
      this.drawSlabsMercator(gl, this.slabMat, ss, glass ? "parts" : "all");
    }

    // ---- hovered-zone fill (opaque violet, swept boundary → centre) ----
    // RAISED (focus) fills float 0.1%·h above the lid and draw with depth OFF:
    // depth precision during zooms let the lid speckle through, and painter's
    // order already guarantees correctness (lid drew before, lines draw after).
    // GROUND (context) fills KEEP the depth test — that is what hides the parts
    // running behind the raised plateau (the terrain wrote nearer depth).
    const hovRange = this.hoveredFillId ? this.fillRanges.get(this.hoveredFillId) : undefined;
    if (this.fillProg && this.hovBuffer && hovRange && this.scale >= 0.15) {
      if (hovRange.raised) gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.fillProg.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hovBuffer);
      if (this.hovDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.hovPositions, gl.STATIC_DRAW);
        this.hovDirty = false;
      }
      gl.uniformMatrix4fv(this.fillProg.uni.uMatrix, false, mat);
      gl.uniform1f(this.fillProg.uni.uScale, hovRange.raised ? this.scale : 1);
      gl.uniform1f(this.fillProg.uni.uFillT, this.fillSweepT());
      gl.enableVertexAttribArray(this.fillProg.attr.aPos);
      gl.vertexAttribPointer(this.fillProg.attr.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this.fillProg.attr.aDist);
      gl.vertexAttribPointer(this.fillProg.attr.aDist, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.TRIANGLES, hovRange.start, hovRange.count);
      gl.enable(gl.DEPTH_TEST);
    }
    // ---- selection retract (the snapshotted fill draining centre → boundary) ----
    if (this.fillProg && this.retractBuffer && this.retractActive && this.retractPositions.length) {
      if (this.retractRaised) gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.fillProg.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.retractBuffer);
      if (this.retractDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.retractPositions, gl.STATIC_DRAW);
        this.retractDirty = false;
      }
      gl.uniformMatrix4fv(this.fillProg.uni.uMatrix, false, mat);
      gl.uniform1f(this.fillProg.uni.uScale, this.retractRaised ? this.scale : 1);
      gl.uniform1f(this.fillProg.uni.uFillT, this.retractT());
      gl.enableVertexAttribArray(this.fillProg.attr.aPos);
      gl.vertexAttribPointer(this.fillProg.attr.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this.fillProg.attr.aDist);
      gl.vertexAttribPointer(this.fillProg.attr.aDist, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.TRIANGLES, 0, this.retractPositions.length / 4);
      gl.enable(gl.DEPTH_TEST);
    }

    // ---- boundary lines (constant screen width; focus on the lid, context and
    // the world-scope outline on the ground) ----
    // The ONLY line renderer now (no draped layer), so no scale gate: focus
    // lines ride the rise with uScale, ground groups pin uScale to 1. Depth is
    // per group: GROUND lines keep the test — the raised terrain wrote nearer
    // depth, which is what hides the parts running behind the plateau (12 m of
    // altitude keeps them clear of ties with the flat surface they sit on) —
    // while RAISED lines sit on top of everything and draw with it off (their
    // 0.2%·h lid clearance speckles under zoom depth precision).
    if (this.lineProgram && this.lineBuffer && this.lineVertexCount) {
      gl.useProgram(this.lineProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      if (this.lineDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.linePositions, gl.STATIC_DRAW);
        this.lineDirty = false;
      }
      gl.uniformMatrix4fv(this.lineUMatrix, false, mat);
      gl.uniform2f(this.lineUViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.enableVertexAttribArray(this.lineAPos);
      gl.vertexAttribPointer(this.lineAPos, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(this.lineAOther);
      gl.vertexAttribPointer(this.lineAOther, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(this.lineASide);
      gl.vertexAttribPointer(this.lineASide, 1, gl.FLOAT, false, 32, 24);
      gl.enableVertexAttribArray(this.lineAGeomSide);
      gl.vertexAttribPointer(this.lineAGeomSide, 1, gl.FLOAT, false, 32, 28);
      const dpr = window.devicePixelRatio || 1;
      for (const grp of this.lineGroups) {
        if (grp.raised) gl.disable(gl.DEPTH_TEST);
        else gl.enable(gl.DEPTH_TEST);
        gl.uniform1f(this.lineUScale, grp.raised ? this.scale : 1);
        gl.uniform1f(this.lineUWidth, grp.width * dpr);
        gl.uniform1f(this.lineUAlpha, grp.alpha);
        gl.drawArrays(gl.TRIANGLES, grp.start, grp.count);
      }
      gl.enable(gl.DEPTH_TEST);
    }

    // ---- pulsing halo (continuous ribbon from the wall base outward) ----
    if (this.haloProg && this.haloBuffer && this.haloVertexCount && this.scale >= 0.15) {
      const p = this.haloProg;
      gl.useProgram(p.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.haloBuffer);
      if (this.haloDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.haloPositions, gl.STATIC_DRAW);
        this.haloDirty = false;
      }
      gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
      gl.uniform1f(p.uni.uScale, this.scale);
      gl.uniform1f(p.uni.uPulseT, (performance.now() / 2600) % 1);
      gl.enableVertexAttribArray(p.attr.aPos);
      gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(p.attr.aDist);
      gl.vertexAttribPointer(p.attr.aDist, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.TRIANGLES, 0, this.haloVertexCount);
      this.requestPulseFrame(); // the pulse is continuous — but paced, not rAF-bound
    }
    // ---- the words' glass boxes (their lids' depth, their walls), then the
    // slabs' glow, the plateau's ----
    if (slabs) {
      if (glass) this.drawSlabsMercator(gl, this.slabMat, ss, "boxes");
      this.drawSlabHaloMercator(gl, this.slabMat, ss);
    }
  }

  /**
   * The slabs, for their own layer (slabLayer): after the plateau's whole draw
   * and the map's labels. Mercator: their walls and opaque lids again, over
   * the labels — the plateau's draw (render) has them under the labels and,
   * but for the glass boxes, under its ground passes.
   */
  private renderSlabs(
    gl: WebGL2RenderingContext,
    matrix: number[],
    projection?: unknown,
    globeToMercMatrix?: number[],
    transition?: number,
    centerInMercator?: number[],
    pixelsPerMeterRatio?: number,
  ) {
    const ss = this.scale * this.slabP;
    if (!this.slabWallCount || ss <= 0.001) return;
    gl.disable(gl.CULL_FACE); // wall sheet is double-sided; lid winding is mixed
    if (
      globeFrame(projection, globeToMercMatrix, transition, centerInMercator, pixelsPerMeterRatio)
    ) {
      this.drawSlabsGlobe(
        gl,
        matrix,
        globeToMercMatrix!,
        transition!,
        centerInMercator!,
        pixelsPerMeterRatio!,
        ss,
      );
      return;
    }
    // mapbox leaves a "2d" layer's depth test off, but its buffer still holds
    // the terrain's and the plateau's: nothing clears it between their draw
    // and this one, and the labels drawn in between only read it. Tested
    // against it in the "3d" layers' own range, a slab is hidden wherever the
    // raised plateau stands in front of it.
    const range = (this.map as unknown as MapPainterInternals | null)?.painter?.depthRangeFor3D;
    if (range) gl.depthRange(range[0], range[1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    // The same triangles with the same matrix as in render: each lands on the
    // depth it wrote there, and passes (LEQUAL) wherever its slab is still the
    // nearest — over the labels. Where the plateau's ground passes or the
    // slabs' glow blended over a foot since, they wrote nearer: kept as drawn.
    this.uploadSlabsMercator(gl);
    const mat = foldOrigin(matrix, this.slabOrigin[0], this.slabOrigin[1], this.slabMat);
    this.drawSlabsMercator(gl, mat, ss, "over");
  }

  /** The slabs' meshes into their buffers (mercator), once after a rebuild. */
  private uploadSlabsMercator(gl: WebGL2RenderingContext) {
    if (!this.slabDirty) return;
    const up = (buf: WebGLBuffer | null, data: Float32Array) => {
      if (!buf) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    };
    up(this.slabWallBuf, this.slabWallPos);
    up(this.slabLidBuf, this.slabLidPos);
    up(this.slabHaloBuf, this.slabHaloPos);
    this.slabDirty = false;
  }

  /**
   * The slabs (mercator), at rise `ss`; `mat`: the frame's, their origin folded
   * in. Their lids first: the ring's parts' and the bar's in their colours;
   * the words' boxes' as SlabSpec.lid has them — glass in depth only (the far
   * wall's inner face stays hidden behind it, the map is seen: the overlay
   * lays a glass of its own there), opaque in the card's colour, "Carte" the
   * raised map's snapshot over it (LEQUAL: the same triangles). Then their
   * walls. `pass`: "all" of them; the ring's parts and the bar alone
   * ("parts"), or the words' boxes ("boxes"); "over", all drawn again over the
   * map's labels (renderSlabs) — but for a glass lid, whose depth stands
   * already, and under which the labels are to be seen.
   */
  private drawSlabsMercator(
    gl: WebGL2RenderingContext,
    mat: Float32Array,
    ss: number,
    pass: SlabPass,
  ) {
    const p = this.slabPieceProg;
    if (!p) return;
    const parts = pass !== "boxes";
    const words = pass !== "parts";
    if (ss >= 0.05 && this.slabLidCount) {
      this.usePieces(gl, p, this.slabLidBuf, mat, ss);
      if (parts && this.slabPartLidCount) gl.drawArrays(gl.TRIANGLES, 0, this.slabPartLidCount);
      const first = this.slabPartLidCount;
      const boxes = words ? this.slabLidCount - first : 0;
      if (boxes && this.slabLid === "verre") {
        if (pass !== "over") {
          gl.colorMask(false, false, false, false);
          gl.drawArrays(gl.TRIANGLES, first, boxes);
          gl.colorMask(true, true, true, true);
        }
      } else if (boxes) {
        const [r, g, b] = this.slabColor;
        gl.uniform4f(p.uni.uTint, r, g, b, 1);
        gl.drawArrays(gl.TRIANGLES, first, boxes);
        if (this.slabLid === "carte" && this.lidProgram && this.lidTexture && this.lidMerc) {
          gl.useProgram(this.lidProgram);
          gl.uniformMatrix4fv(this.lidUMatrix, false, mat);
          gl.uniform1f(this.lidUScale, ss);
          gl.uniform2f(
            this.lidUTexOrigin,
            this.lidMerc.minX - this.slabOrigin[0],
            this.lidMerc.minY - this.slabOrigin[1],
          );
          gl.uniform2f(this.lidUTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.slabLidBuf);
          gl.enableVertexAttribArray(this.lidAPos);
          gl.vertexAttribPointer(this.lidAPos, 3, gl.FLOAT, false, 24, 0);
          gl.drawArrays(gl.TRIANGLES, first, boxes);
        }
      }
    }
    const from = parts ? 0 : this.slabPartWallCount;
    const to = words ? this.slabWallCount : this.slabPartWallCount;
    this.usePieces(gl, p, this.slabWallBuf, mat, ss);
    gl.drawArrays(gl.TRIANGLES, from, to - from);
  }

  /** The pieces' program (mercator) on buffer `buf`, coloured per vertex. */
  private usePieces(
    gl: WebGL2RenderingContext,
    p: GlProg,
    buf: WebGLBuffer | null,
    mat: Float32Array,
    ss: number,
  ) {
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
    gl.uniform1f(p.uni.uScale, ss);
    gl.uniform4f(p.uni.uTint, 0, 0, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(p.attr.aPos);
    gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(p.attr.aColor);
    gl.vertexAttribPointer(p.attr.aColor, 3, gl.FLOAT, false, 24, 12);
  }

  private drawSlabHaloMercator(gl: WebGL2RenderingContext, mat: Float32Array, ss: number) {
    const p = this.haloProg;
    if (ss < 0.15 || !p || !this.slabHaloCount) return;
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.slabHaloBuf);
    gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
    gl.uniform1f(p.uni.uScale, ss);
    gl.uniform1f(p.uni.uPulseT, (performance.now() / 2600) % 1);
    gl.enableVertexAttribArray(p.attr.aPos);
    gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(p.attr.aDist);
    gl.vertexAttribPointer(p.attr.aDist, 1, gl.FLOAT, false, 16, 12);
    gl.drawArrays(gl.TRIANGLES, 0, this.slabHaloCount);
    this.requestPulseFrame();
  }

  /** The globe-regime draw: same three passes, positions morphed sphere↔mercator
   *  in-shader. Attributes are ABSOLUTE (no origin fold — float32 is plenty below
   *  z6, where a pixel is kilometres). */
  private renderGlobe(
    gl: WebGL2RenderingContext,
    matrix: number[],
    globeToMerc: number[],
    t: number,
    center: number[],
    pxRatio: number,
  ) {
    // NO depth test on the globe: mapbox draws the sphere/terrain through an
    // infinite-far projection while custom layers get the finite-far matrix — the
    // depth values aren't comparable and the mismatch (~1e-3) dwarfs the plateau's
    // separation, so LEQUAL rejects every fragment (verified live: geometry
    // appears the instant the test is off). Painter's order handles our own
    // occlusion (walls → lid → lines), and a France-scoped plateau is always on
    // the camera-facing side of the sphere.
    gl.disable(gl.DEPTH_TEST);
    const { setCommon, bindTriple } = this.globeBinders(
      gl,
      matrix,
      globeToMerc,
      t,
      center,
      pxRatio,
    );
    // The plateau's depth can't be tested against (see above), so GROUND-level
    // geometry (context fills/lines, the world-scope outline) draws FIRST and
    // the plateau (walls + lid) paints OVER it — that is what keeps neighbour
    // boundaries from leaking onto the raised top. RAISED geometry follows the
    // lid. The draw closures are shared between the two passes.
    const hovRange = this.hoveredFillId ? this.fillRanges.get(this.hoveredFillId) : undefined;
    const drawHoverFill = () => {
      if (!this.gFillProg || !this.gHovBuffer || !hovRange || this.scale < 0.15) return;
      setCommon(this.gFillProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gHovBuffer);
      if (this.gHovDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gHovPositions, gl.STATIC_DRAW);
        this.gHovDirty = false;
      }
      gl.uniform1f(this.gFillProg.uni.uFillT, this.fillSweepT());
      if (!hovRange.raised) gl.uniform1f(this.gFillProg.uni.uScale, 1);
      bindTriple(this.gFillProg, 40);
      gl.enableVertexAttribArray(this.gFillProg.attr.aDist);
      gl.vertexAttribPointer(this.gFillProg.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.drawArrays(gl.TRIANGLES, hovRange.start, hovRange.count);
    };
    const drawRetract = () => {
      if (!this.gFillProg || !this.gRetractBuffer || !this.gRetractPositions.length) return;
      setCommon(this.gFillProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gRetractBuffer);
      if (this.gRetractDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gRetractPositions, gl.STATIC_DRAW);
        this.gRetractDirty = false;
      }
      gl.uniform1f(this.gFillProg.uni.uFillT, this.retractT());
      if (!this.retractRaised) gl.uniform1f(this.gFillProg.uni.uScale, 1);
      bindTriple(this.gFillProg, 40);
      gl.enableVertexAttribArray(this.gFillProg.attr.aDist);
      gl.vertexAttribPointer(this.gFillProg.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.gRetractPositions.length / 10);
    };
    // Boundary lines: no scale gate — this is the only line renderer. Ground
    // groups pin uScale to 1 (their altitude is absolute; with lo == hi the
    // ECEF mix is inert).
    const drawLines = (raised: boolean) => {
      if (!this.gLineProg || !this.gLineBuffer || !this.lineVertexCount) return;
      // drawLines is called once for raised and once for ground. At world scope
      // no group is raised, so one of the two passes set up ~25 GL calls (program
      // bind, 8 attribute pointers, uniforms) and then drew nothing.
      if (!this.lineGroups.some((g) => g.raised === raised)) return;
      setCommon(this.gLineProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gLineBuffer);
      if (this.gLineDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gLinePositions, gl.STATIC_DRAW);
        this.gLineDirty = false;
      }
      const p = this.gLineProg;
      bindTriple(p, 80);
      gl.enableVertexAttribArray(p.attr.aOMerc);
      gl.vertexAttribPointer(p.attr.aOMerc, 3, gl.FLOAT, false, 80, 36);
      gl.enableVertexAttribArray(p.attr.aOEcefLo);
      gl.vertexAttribPointer(p.attr.aOEcefLo, 3, gl.FLOAT, false, 80, 48);
      gl.enableVertexAttribArray(p.attr.aOEcefHi);
      gl.vertexAttribPointer(p.attr.aOEcefHi, 3, gl.FLOAT, false, 80, 60);
      gl.enableVertexAttribArray(p.attr.aSide);
      gl.vertexAttribPointer(p.attr.aSide, 1, gl.FLOAT, false, 80, 72);
      gl.enableVertexAttribArray(p.attr.aGeomSide);
      gl.vertexAttribPointer(p.attr.aGeomSide, 1, gl.FLOAT, false, 80, 76);
      gl.uniform2f(p.uni.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      const dpr = window.devicePixelRatio || 1;
      for (const grp of this.lineGroups) {
        if (grp.raised !== raised) continue;
        gl.uniform1f(p.uni.uScale, grp.raised ? this.scale : 1);
        gl.uniform1f(p.uni.uWidth, grp.width * dpr);
        gl.uniform1f(p.uni.uAlpha, grp.alpha);
        gl.drawArrays(gl.TRIANGLES, grp.start, grp.count);
      }
    };
    // ---- GROUND pass (hidden behind the plateau by paint order) ----
    if (hovRange && !hovRange.raised) drawHoverFill();
    if (this.retractActive && !this.retractRaised) drawRetract();
    drawLines(false);
    // ---- walls ----
    if (this.gWallProg && this.gWallBuffer && this.vertexCount) {
      setCommon(this.gWallProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gWallBuffer);
      if (this.gWallDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gWallPositions, gl.STATIC_DRAW);
        this.gWallDirty = false;
      }
      bindTriple(this.gWallProg, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }
    // ---- lid ----
    if (
      this.gLidProg &&
      this.gLidBuffer &&
      this.lidVertexCount &&
      this.lidTexture &&
      this.lidMerc &&
      this.scale >= 0.15
    ) {
      setCommon(this.gLidProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gLidBuffer);
      if (this.gLidDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gLidPositions, gl.STATIC_DRAW);
        this.gLidDirty = false;
      }
      // Globe attrs are ABSOLUTE mercator → unshifted texture origin.
      gl.uniform2f(this.gLidProg.uni.uTexOrigin, this.lidMerc.minX, this.lidMerc.minY);
      gl.uniform2f(this.gLidProg.uni.uTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
      bindTriple(this.gLidProg, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.lidVertexCount);
    }
    // ---- RAISED pass (on the plateau top) ----
    if (hovRange && hovRange.raised) drawHoverFill();
    if (this.retractActive && this.retractRaised) drawRetract();
    drawLines(true);

    // ---- pulsing halo (continuous ribbon from the wall base outward) ----
    if (this.gHaloProg && this.gHaloBuffer && this.haloVertexCount && this.scale >= 0.15) {
      const hp = this.gHaloProg;
      setCommon(hp);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gHaloBuffer);
      if (this.gHaloDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gHaloPositions, gl.STATIC_DRAW);
        this.gHaloDirty = false;
      }
      bindTriple(hp, 40);
      gl.enableVertexAttribArray(hp.attr.aDist);
      gl.vertexAttribPointer(hp.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.uniform1f(hp.uni.uPulseT, (performance.now() / 2600) % 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.haloVertexCount);
      this.requestPulseFrame(); // the pulse is continuous — but paced, not rAF-bound
    }
  }

  /** The globe programs' setup for a frame: `setCommon(p)` binds program p
   *  with the frame's camera and the plateau's rise (uScale), `bindTriple(p,
   *  stride)` its mercator + ECEF attributes. */
  private globeBinders(
    gl: WebGL2RenderingContext,
    matrix: number[],
    globeToMerc: number[],
    t: number,
    center: number[],
    pxRatio: number,
  ) {
    const proj = new Float32Array(matrix);
    const g2m = new Float32Array(globeToMerc);
    const setCommon = (p: GlProg) => {
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.uni.uProj, false, proj);
      gl.uniformMatrix4fv(p.uni.uGlobeToMerc, false, g2m);
      gl.uniform1f(p.uni.uT, t);
      gl.uniform2f(p.uni.uCenterMerc, center[0], center[1]);
      gl.uniform1f(p.uni.uPxRatio, pxRatio);
      gl.uniform1f(p.uni.uScale, this.scale);
    };
    const bindTriple = (p: GlProg, stride: number) => {
      gl.enableVertexAttribArray(p.attr.aMerc);
      gl.vertexAttribPointer(p.attr.aMerc, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(p.attr.aEcefLo);
      gl.vertexAttribPointer(p.attr.aEcefLo, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(p.attr.aEcefHi);
      gl.vertexAttribPointer(p.attr.aEcefHi, 3, gl.FLOAT, false, stride, 24);
    };
    return { setCommon, bindTriple };
  }

  /** The slabs on the globe, at rise `ss`: no depth test there (see
   *  renderGlobe) — painter's order, their glow, walls, lids. Drawn after
   *  everything of the plateau (their layer comes after its), which they never
   *  stand in front of: at globe zooms a slab's wall stands a few px at most,
   *  short of the gap between it and the plateau. A glass lid is not drawn:
   *  with no depth to hide them, the walls' inner faces would show under the
   *  glass — the glass boxes' walls are culled to their outer faces. */
  private drawSlabsGlobe(
    gl: WebGL2RenderingContext,
    matrix: number[],
    globeToMerc: number[],
    t: number,
    center: number[],
    pxRatio: number,
    ss: number,
  ) {
    gl.disable(gl.DEPTH_TEST);
    const { setCommon, bindTriple } = this.globeBinders(
      gl,
      matrix,
      globeToMerc,
      t,
      center,
      pxRatio,
    );
    if (this.gSlabDirty) {
      const up = (buf: WebGLBuffer | null, data: Float32Array) => {
        if (!buf) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      };
      up(this.gSlabWallBuf, this.gSlabWallPos);
      up(this.gSlabLidBuf, this.gSlabLidPos);
      up(this.gSlabHaloBuf, this.gSlabHaloPos);
      this.gSlabDirty = false;
    }
    if (ss >= 0.15 && this.gHaloProg && this.slabHaloCount) {
      const hp = this.gHaloProg;
      setCommon(hp);
      gl.uniform1f(hp.uni.uScale, ss);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gSlabHaloBuf);
      bindTriple(hp, 40);
      gl.enableVertexAttribArray(hp.attr.aDist);
      gl.vertexAttribPointer(hp.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.uniform1f(hp.uni.uPulseT, (performance.now() / 2600) % 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.slabHaloCount);
    }
    const p = this.gSlabPieceProg;
    if (!p) return;
    setCommon(p);
    gl.uniform1f(p.uni.uScale, ss);
    gl.uniform4f(p.uni.uTint, 0, 0, 0, 0);
    this.bindGlobePieces(gl, p, this.gSlabWallBuf, bindTriple);
    if (this.slabLid === "verre") {
      // The words' boxes' walls, culled to their outer faces: their outlines
      // turn clockwise seen from above (map/lib/slabs: pieceOutline), so an outer
      // face winds clockwise on screen.
      const parts = this.slabPartWallCount;
      gl.drawArrays(gl.TRIANGLES, 0, parts);
      gl.enable(gl.CULL_FACE);
      gl.frontFace(gl.CW);
      gl.cullFace(gl.BACK);
      gl.drawArrays(gl.TRIANGLES, parts, this.slabWallCount - parts);
      gl.disable(gl.CULL_FACE);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, this.slabWallCount);
    }
    if (ss < 0.05 || !this.slabLidCount) return;
    this.bindGlobePieces(gl, p, this.gSlabLidBuf, bindTriple);
    if (this.slabPartLidCount) gl.drawArrays(gl.TRIANGLES, 0, this.slabPartLidCount);
    const first = this.slabPartLidCount;
    const boxes = this.slabLidCount - first;
    if (!boxes || this.slabLid === "verre") return;
    const [r, g, b] = this.slabColor;
    gl.uniform4f(p.uni.uTint, r, g, b, 1);
    gl.drawArrays(gl.TRIANGLES, first, boxes);
    if (this.slabLid === "carte" && this.gLidProg && this.lidTexture && this.lidMerc) {
      const lp = this.gLidProg;
      setCommon(lp);
      gl.uniform1f(lp.uni.uScale, ss);
      gl.uniform2f(lp.uni.uTexOrigin, this.lidMerc.minX, this.lidMerc.minY);
      gl.uniform2f(lp.uni.uTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gSlabLidBuf);
      bindTriple(lp, 48);
      gl.drawArrays(gl.TRIANGLES, first, boxes);
    }
  }

  /** The pieces' globe buffer `buf` bound to `p`, coloured per vertex:
   *  [merc3, lo3, hi3, rgb3]. */
  private bindGlobePieces(
    gl: WebGL2RenderingContext,
    p: GlProg,
    buf: WebGLBuffer | null,
    bindTriple: (p: GlProg, stride: number) => void,
  ) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    bindTriple(p, 48);
    gl.enableVertexAttribArray(p.attr.aColor);
    gl.vertexAttribPointer(p.attr.aColor, 3, gl.FLOAT, false, 48, 36);
  }
}

/** A (multi)polygon whose rings the grey is cut around. */
type MaskGeom = { type?: string; coordinates?: unknown };
const sameGeoms = (a: MaskGeom[], b: MaskGeom[]) =>
  a.length === b.length && a.every((g, i) => g === b[i]);

// ---- The flat view's grey: a custom WebGL layer --------------------------------
// One mesh lying on the ground: the whole mercator world with the selection's
// outer rings as holes, plus the selection's enclaves filled back in. It is
// rebuilt when the selection's geometry changes and at no other time — the
// camera can go anywhere without it needing anything.
//
// Depth is what makes a FLAT sheet correct around a RAISED plateau: tested
// against the terrain (renderingMode "3d" shares its depth range), the ground
// behind the plateau is hidden by it exactly as the eye expects, with no lid
// needed. The sheet is coplanar with the flat terrain everywhere else, so it is
// pulled toward the camera with polygon offset — a bias in DEPTH units, which
// holds at every zoom, where lifting the mesh by some metres does not (a few
// metres is under one depth step once zoomed out to a region) and would also
// slide the hole's edge off the boundary under pitch.
//
// One consequence of being flat: a plateau that is still SINKING hides the sheet
// until it is nearly down, so the outgoing selection greys at the end of its
// sink rather than at the click. Its lid covered it for that long anyway.
//
// It sits in the "middle" slot. With terrain on mapbox draws every draped layer
// first whatever its slot, so in practice that means: after the whole ground,
// before the labels and the 3D layers — place names stay un-greyed, as they
// were under the draped sheet.
const TINT_DEPTH_BIAS_FACTOR = -1;
/** In steps of a 24-bit depth buffer; scaled down for a shallower one (onAdd). */
const TINT_DEPTH_BIAS_UNITS = -64;
// Mapbox's own constants for when fog starts to show, by camera pitch.
const FOG_PITCH_START = 45;
const FOG_PITCH_END = 65;

/** The pieces of mapbox's fog the sheet has to reproduce. None of this is public
 *  API, so every field is optional and its absence just means "no fog". */
interface MapFogInternals {
  style?: {
    fog?: {
      state?: { range?: [number, number] };
      properties?: { get?(name: "color"): { r: number; g: number; b: number; a: number } };
    };
  };
  transform?: { mercatorFogMatrix?: Float32Array };
}

class ScopeTintLayer implements mapboxgl.CustomLayerInterface {
  id = "scope-tint";
  type = "custom" as const;
  renderingMode = "3d" as const;
  slot = "middle";
  /** Called (not during the draw) when mapbox starts handing this layer the
   *  other projection — the draped sheet has to change hands with it. */
  onRegimeChange: ((globe: boolean) => void) | null = null;
  private map: mapboxgl.Map | null = null;
  private prog: GlProg | null = null;
  private buffer: WebGLBuffer | null = null;
  private geoms: MaskGeom[] = [];
  private positions = new Float32Array(0);
  private vertexCount = 0;
  private dirty = false;
  private origin: [number, number] = [0, 0];
  private mat = new Float32Array(16);
  private biasUnits = TINT_DEPTH_BIAS_UNITS;
  private globe: boolean | null = null;

  /** Cut the sheet around `geoms` (empty → no grey). Rebuilds only when the
   *  geometry OBJECTS change: boundary data is identity-stable, and this is
   *  called on every pass of the plateau pipeline. */
  setSelection(geoms: MaskGeom[]) {
    if (sameGeoms(geoms, this.geoms)) return;
    this.geoms = geoms;
    // Outer rings become holes; a selection's INNER rings are enclaves of some
    // other unit (the Enclave des Papes is Vaucluse, wholly surrounded by
    // Drôme), which the plateau leaves un-raised — so they are greyed back in,
    // as polygons of their own sitting exactly inside a hole. Assumes what
    // admin boundaries give: outer rings that neither overlap nor nest (no part
    // of the selection inside its own enclave) — `worldMaskData` shares that.
    const holes: PBase[][] = [];
    const enclaves: PBase[][] = [];
    for (const g of geoms) {
      for (const rings of ringBasesOf(g)) {
        if (!rings[0]?.length) continue;
        holes.push(rings[0]);
        for (let i = 1; i < rings.length; i++) if (rings[i]?.length) enclaves.push(rings[i]);
      }
    }
    const out: number[] = [];
    if (holes.length) {
      // Coordinates are relative to a vertex of the selection: float32 keeps
      // sub-metre precision on those small offsets, and the origin is re-added
      // in the (float64) matrix each frame — the same fold PlateauWallLayer uses.
      const ox = holes[0][0].x;
      const oy = Math.min(1, Math.max(0, holes[0][0].y));
      this.origin = [ox, oy];
      // The world, one copy to each side so the grey does not stop at ±180°.
      const W = [-1 - ox, -oy, 2 - ox, 1 - oy];
      // Mercator y runs off to infinity toward the poles. Pin it to the world's
      // edge so every hole stays inside the frame below — earcut silently drops
      // a hole that pokes out of its outer ring, which would grey the selection.
      const relY = (p: PBase) => Math.min(W[3], Math.max(W[1], p.y - oy));
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const ring of holes) {
        for (const p of ring) {
          x0 = Math.min(x0, p.x - ox);
          x1 = Math.max(x1, p.x - ox);
          y0 = Math.min(y0, relY(p));
          y1 = Math.max(y1, relY(p));
        }
      }
      // Earcut works inside a FRAME one selection-span wide around the holes,
      // not against the world's corners: its triangles stay short and local
      // (where the float32 fold is precise). The rest of the world is the ring
      // of eight triangles between frame and world — they share the frame's
      // corners with earcut's output, so no T-junction can open a crack.
      const pad = Math.max(x1 - x0, y1 - y0, 1e-7);
      const F = [
        Math.max(W[0], x0 - pad),
        Math.max(W[1], y0 - pad),
        Math.min(W[2], x1 + pad),
        Math.min(W[3], y1 + pad),
      ];
      const sheet: number[] = [F[0], F[1], F[2], F[1], F[2], F[3], F[0], F[3]];
      const holeStarts: number[] = [];
      for (const ring of holes) {
        holeStarts.push(sheet.length / 2);
        for (const p of ring) sheet.push(p.x - ox, relY(p));
      }
      for (const i of earcut(sheet, holeStarts, 2)) out.push(sheet[i * 2], sheet[i * 2 + 1]);
      const corners = (r: number[]) => [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]];
      const f = corners(F);
      const w = corners(W);
      for (let i = 0; i < 4; i++) {
        const j = ((i + 1) % 4) * 2;
        const k = i * 2;
        out.push(w[k], w[k + 1], w[j], w[j + 1], f[j], f[j + 1]);
        out.push(w[k], w[k + 1], f[j], f[j + 1], f[k], f[k + 1]);
      }
      for (const ring of enclaves) {
        const flat: number[] = [];
        for (const p of ring) flat.push(p.x - ox, relY(p));
        for (const i of earcut(flat, undefined, 2)) out.push(flat[i * 2], flat[i * 2 + 1]);
      }
    }
    this.positions = new Float32Array(out);
    this.vertexCount = out.length / 2;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  onAdd(map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    // The grey is FOGGED like the ground it lies on. The draped sheet got that
    // for free (mapbox fogs the terrain it is baked into); a flat colour drawn
    // over already-fogged ground instead stays full strength to the horizon and
    // shows as a dark band under it. Mixing the colour toward the fog's by the
    // fog's own opacity is exactly equivalent to fogging a draped sheet. The
    // opacity is mapbox's formula for the ground, verbatim (fog_opacity ×
    // fog_horizon_blending below the horizon, both carrying the fog's alpha).
    this.prog = buildProgram(
      gl,
      `attribute vec2 aPos;
       uniform mat4 uMatrix;
       uniform mat4 uFogMatrix;
       uniform vec2 uOrigin;
       varying vec3 vFogPos;
       void main() {
         gl_Position = uMatrix * vec4(aPos, 0.0, 1.0);
         vFogPos = (uFogMatrix * vec4(aPos + uOrigin, 0.0, 1.0)).xyz;
       }`,
      `precision highp float;
       uniform vec3 uTint;
       uniform float uAlpha;
       uniform vec3 uFogColor;
       uniform vec3 uFog; // range start, range end, alpha²
       varying vec3 vFogPos;
       void main() {
         float t = (length(vFogPos) - uFog.x) / (uFog.y - uFog.x);
         float falloff = 1.0 - min(1.0, exp(-6.0 * t));
         falloff *= falloff * falloff;
         float fog = uFog.z * min(1.0, 1.00747 * falloff);
         gl_FragColor = vec4(mix(uTint, uFogColor, fog) * uAlpha, uAlpha);
       }`,
      ["aPos"],
      ["uMatrix", "uFogMatrix", "uOrigin", "uTint", "uAlpha", "uFogColor", "uFog"],
    );
    this.buffer = gl.createBuffer();
    // Polygon-offset units are steps of THIS depth buffer. The constant is tuned
    // for 24 bits; on a 16-bit buffer the same number would be 256× the bias and
    // let the ground behind a plateau draw through it.
    const bits = Math.min(24, (gl.getParameter(gl.DEPTH_BITS) as number) || 24);
    this.biasUnits = Math.min(-1, TINT_DEPTH_BIAS_UNITS / 2 ** (24 - bits));
    // A fresh context (remount) knows nothing of a sheet built before it.
    this.dirty = true;
    this.globe = null;
  }

  onRemove(_map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    if (this.prog) gl.deleteProgram(this.prog.prog);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.prog = null;
    this.buffer = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, matrix: number[], projection?: unknown) {
    // On the globe mapbox calls with its extended argument list, and the grey
    // there is the draped sheet's job (see MASK_SOURCE's note). This call IS the
    // regime, whatever decided it — so it is what the draped sheet is finally
    // held to: `syncDrapedMask` predicts it from the zoom to switch in the same
    // frame, and a prediction that ever disagrees is corrected from here.
    const globe = projection !== undefined;
    if (globe !== this.globe) {
      this.globe = globe;
      const notify = this.onRegimeChange;
      if (notify) queueMicrotask(() => notify(globe)); // never restyle mid-draw
    }
    if (globe || !this.map || !this.prog || !this.buffer || !this.vertexCount) return;
    const m = matrix;
    const [tx, ty] = this.origin;
    const t = this.mat;
    t.set(m);
    t[12] = m[0] * tx + m[4] * ty + m[12];
    t[13] = m[1] * tx + m[5] * ty + m[13];
    t[14] = m[2] * tx + m[6] * ty + m[14];
    t[15] = m[3] * tx + m[7] * ty + m[15];
    const u = this.prog.uni;
    gl.useProgram(this.prog.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.dirty) {
      gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
      this.dirty = false;
    }
    gl.uniformMatrix4fv(u.uMatrix, false, t);
    gl.uniform3f(u.uTint, TINT_RGB[0] / 255, TINT_RGB[1] / 255, TINT_RGB[2] / 255);
    gl.uniform1f(u.uAlpha, MASK_OPACITY);
    // Fog: only above FOG_PITCH_START, and only if mapbox's internals are where
    // this version keeps them. Otherwise alpha² stays 0 and the tint is plain.
    // `state` is a getter that computes, so it can throw as well as be missing —
    // and an exception here would abort mapbox's whole frame.
    const pitchK = Math.min(
      1,
      Math.max(0, (this.map.getPitch() - FOG_PITCH_START) / (FOG_PITCH_END - FOG_PITCH_START)),
    );
    let range: [number, number] | undefined;
    let fogMatrix: Float32Array | undefined;
    let fogColor: { r: number; g: number; b: number; a: number } | undefined;
    if (pitchK > 0) {
      try {
        const internals = this.map as unknown as MapFogInternals;
        const fog = internals.style?.fog;
        range = fog?.state?.range;
        fogMatrix = internals.transform?.mercatorFogMatrix;
        fogColor = fog?.properties?.get?.("color");
      } catch {
        range = undefined;
      }
    }
    if (range && fogMatrix && fogColor && fogColor.a > 0) {
      const a = pitchK * pitchK * (3 - 2 * pitchK) * fogColor.a; // smoothstep, as mapbox
      gl.uniformMatrix4fv(u.uFogMatrix, false, fogMatrix);
      gl.uniform2f(u.uOrigin, tx, ty);
      // Straight rgb (mapbox premultiplies only when it builds a render colour).
      gl.uniform3f(u.uFogColor, fogColor.r, fogColor.g, fogColor.b);
      gl.uniform3f(u.uFog, range[0], range[1], a * a);
    } else {
      gl.uniform3f(u.uFog, 0, 1, 0);
    }
    gl.enableVertexAttribArray(this.prog.attr.aPos);
    gl.vertexAttribPointer(this.prog.attr.aPos, 2, gl.FLOAT, false, 8, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // Read the terrain's depth, never write our own: the walls, lid and lines
    // drawn after this must still test against the terrain, not against a sheet.
    gl.depthMask(false);
    // Mapbox neither tracks nor resets polygon offset — left on, it would skew
    // every later draw in this frame and all the following ones.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(TINT_DEPTH_BIAS_FACTOR, this.biasUnits);
    try {
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    } finally {
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(0, 0);
      gl.depthMask(true);
    }
  }
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

function boundsOfFeatures(features: OutlineFC["features"]): Bounds | null {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const f of features) {
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!g?.type) continue;
    for (const poly of polysOf(g)) {
      for (const ring of poly) {
        for (const [lng, lat] of ring) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
        }
      }
    }
  }
  if (minLat > maxLat) return null;
  return { minLat, maxLat, minLng, maxLng };
}

// Plateau height for a selection: ~1.25% of the unit's own max bbox span, clamped.
// Derived from the GEOMETRY, not the viewport, so the height is deterministic per
// unit no matter what view it was selected from.
function heightForSelection(features: OutlineFC["features"]): number {
  const b = boundsOfFeatures(features);
  if (!b) return 500;
  const cos = Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180) || 1e-6;
  const span = Math.max((b.maxLat - b.minLat) * 110574, (b.maxLng - b.minLng) * 111320 * cos);
  return Math.min(3500, Math.max(75, span * 0.0125));
}

/**
 * The plateau's height for the unit `scopeId` (its outline: `features`), m —
 * the lid stands WALL_OVERSHOOT over it. Height scales with the SELECTION's own
 * size (max bbox span), NOT the current viewport — selecting a small commune
 * from a zoomed-out view must not produce a kilometres-tall tower. A small
 * fraction of the unit's span reads as a consistent lift once the camera fits
 * it. Département/ville/arrondissement get HALF that: their fit views sit much
 * closer to the ground, where the full proportional lift reads too tall.
 * (Scope ids are path-encoded — the last segment's prefix is the level:
 * d:/v:/a:.) The fit reads it too (fitCamera): the lid is part of what it frames.
 */
function plateauHeightM(scopeId: string, features: OutlineFC["features"]): number {
  const lastSeg = scopeId.split("/").pop() ?? "";
  const halfHeight = /^(d|v|a):/.test(lastSeg);
  return heightForSelection(features) * (halfHeight ? 0.5 : 1);
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

const unionBounds = (a: Bounds, b: Bounds): Bounds => ({
  minLat: Math.min(a.minLat, b.minLat),
  maxLat: Math.max(a.maxLat, b.maxLat),
  minLng: Math.min(a.minLng, b.minLng),
  maxLng: Math.max(a.maxLng, b.maxLng),
});
const boundsContain = (a: Bounds, b: Bounds) =>
  b.minLat >= a.minLat && b.maxLat <= a.maxLat && b.minLng >= a.minLng && b.maxLng <= a.maxLng;

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
