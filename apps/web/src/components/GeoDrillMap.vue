<script lang="ts">
// Exported types live in a plain <script> block — `<script setup>` can't export.
import type { Bounds } from "@/lib/geo";

/** A pin to plot: an aggregated admin unit, or a leaf place. */
export interface MapUnit {
  id: string;
  label: string;
  count: number;
  center: [number, number]; // [lat, lng]
  isLeaf: boolean;
  /** The unit's geographic bbox — a macro pin only shows while this (its boundary)
   *  still intersects the viewport. */
  bounds?: Bounds;
  /** The unit's boundary polygon — the pin is anchored over the VISIBLE part of
   *  it, so it always sits on its own territory. */
  geometry?: unknown;
}

/** A camera command. `key` changes each time the parent wants a move. */
export interface CameraCmd {
  key: number;
  type: "ease" | "spotlight";
  center: [number, number]; // [lat, lng]
  zoom?: number;
  animate?: boolean;
}

/** Boundary outlines (GeoJSON) for the current scope's children. */
export interface OutlineFC {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; geometry: unknown; properties: Record<string, unknown> }>;
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import mapboxgl from "mapbox-gl";
import { FRANCE_CENTER } from "@ac/shared";
import { abbrevCount } from "@/lib/geo";

const props = defineProps<{
  units: MapUnit[];
  camera: CameraCmd | null;
  outline?: OutlineFC | null;
  padding?: { top: number; bottom: number; left: number; right: number } | number;
}>();

const EMPTY_FC: OutlineFC = { type: "FeatureCollection", features: [] };
const OUTLINE_SOURCE = "scope-outline";

const emit = defineEmits<{
  unitClick: [id: string];
  viewChange: [view: { zoom: number; center: [number, number]; bounds: Bounds }];
}>();

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? "";
const STYLE = import.meta.env.VITE_MAPBOX_STYLE || "mapbox://styles/mapbox/dark-v11";

const el = ref<HTMLElement | null>(null);
const unavailable = ref(!TOKEN);

let map: mapboxgl.Map | null = null;
let markers: mapboxgl.Marker[] = [];
let sticky: {
  marker: mapboxgl.Marker;
  el: HTMLElement;
  lngLat: [number, number];
  bounds?: Bounds;
  geometry?: unknown;
}[] = [];
let resizeObserver: ResizeObserver | null = null;
let userInteracted = false;
let lastCmd: CameraCmd | null = null;

const SPOTLIGHT_ZOOM = 15.3;
const SPOTLIGHT_PITCH = 50;

function toLngLat([lat, lng]: [number, number]): [number, number] {
  return [lng, lat];
}

function makePin(unit: MapUnit): HTMLElement {
  const root = document.createElement("button");
  root.type = "button";
  root.addEventListener("click", (e) => {
    e.stopPropagation();
    emit("unitClick", unit.id);
  });

  // Lieu (leaf): the original flat ground dot (.marker-dot "point au sol") with
  // the audition count on it.
  if (unit.isLeaf) {
    root.className = "geo-pin geo-pin-leaf";
    root.textContent = abbrevCount(unit.count);
    return root;
  }

  // Aggregated unit: a uniform outlined pill with the count + name.
  root.className = "geo-pin";
  const bubble = document.createElement("span");
  bubble.className = "geo-pin-bubble";
  const num = document.createElement("span");
  num.className = "geo-pin-num";
  num.textContent = abbrevCount(unit.count);
  const lab = document.createElement("span");
  lab.className = "geo-pin-name";
  lab.textContent = unit.label;
  bubble.append(num, lab);
  root.appendChild(bubble);
  return root;
}

function clearMarkers() {
  for (const m of markers) m.remove();
  markers = [];
  sticky = [];
}

function buildMarkers() {
  if (!map) return;
  clearMarkers();
  for (const unit of props.units) {
    // Lieu dots lie flat on the ground (tilt with the map), centred on the point;
    // aggregated pills stay billboard (face the camera) like UI chips.
    const el = makePin(unit);
    const opts: mapboxgl.MarkerOptions = unit.isLeaf
      ? { element: el, pitchAlignment: "map", rotationAlignment: "map" }
      : { element: el };
    const lngLat = toLngLat(unit.center);
    const marker = new mapboxgl.Marker(opts).setLngLat(lngLat).addTo(map);
    markers.push(marker);
    // Macro pins (pills) follow their unit's visible territory and stick to the
    // screen edge when it's off-screen, so the surrounding context never vanishes.
    if (!unit.isLeaf) sticky.push({ marker, el, lngLat, bounds: unit.bounds, geometry: unit.geometry });
  }
  updateSticky();
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng;
}

// A point STRICTLY INSIDE the unit's polygon and inside the visible area: scan
// horizontal lines across the unit's visible latitude band, take the midpoint of
// the widest inside segment (clipped to the visible longitudes). Even-odd over all
// rings excludes holes. Returns [lng, lat] or null. Guarantees the pin sits on its
// own land — never on a border or outside it.
function interiorInView(geom: unknown, b: Bounds, v: Bounds): [number, number] | null {
  const g = geom as { type?: string; coordinates?: unknown } | undefined;
  if (!g?.type) return null;
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) as number[][][][];
  const latLo = Math.max(b.minLat, v.minLat);
  const latHi = Math.min(b.maxLat, v.maxLat);
  const lngLo = Math.max(b.minLng, v.minLng);
  const lngHi = Math.min(b.maxLng, v.maxLng);
  if (latLo >= latHi || lngLo >= lngHi) return null;
  const K = 19;
  let best: [number, number] | null = null;
  let bestW = 0;
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
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const lo = Math.max(xs[i], lngLo);
      const hi = Math.min(xs[i + 1], lngHi);
      if (hi - lo > bestW) {
        bestW = hi - lo;
        best = [(lo + hi) / 2, lat];
      }
    }
  }
  return best;
}

// Keep each macro pin strictly inside its unit, over the visible part of it. Pins
// glide with the map during a gesture (a fixed interior point) and re-settle on
// moveend; hidden when none of the unit is in view.
function updateSticky() {
  if (!map || !sticky.length) return;
  const c = map.getContainer();
  const pad = props.padding ?? 50;
  const ins = typeof pad === "number" ? { top: pad, bottom: pad, left: pad, right: pad } : pad;
  const m = 28;
  const left = ins.left + m;
  const right = c.clientWidth - ins.right - m;
  const top = ins.top + m;
  const bottom = c.clientHeight - ins.bottom - m;
  const tl = map.unproject([left, top]);
  const br = map.unproject([right, bottom]);
  const view: Bounds = {
    minLat: Math.min(tl.lat, br.lat),
    maxLat: Math.max(tl.lat, br.lat),
    minLng: Math.min(tl.lng, br.lng),
    maxLng: Math.max(tl.lng, br.lng),
  };
  for (const s of sticky) {
    const pt =
      s.bounds && s.geometry && boundsIntersect(s.bounds, view)
        ? interiorInView(s.geometry, s.bounds, view)
        : null;
    if (!pt) {
      s.marker.setLngLat(s.lngLat); // nothing visible → leave at the true (hidden) spot
      s.el.classList.remove("geo-pin-stuck");
      continue;
    }
    s.marker.setLngLat(pt);
    const p = map.project(pt);
    const nearEdge = p.x < left + 44 || p.x > right - 44 || p.y < top + 44 || p.y > bottom - 44;
    s.el.classList.toggle("geo-pin-stuck", nearEdge);
  }
}

function runCamera(cmd: CameraCmd) {
  if (!map) return;
  lastCmd = cmd;
  const padding = props.padding ?? 50;
  const duration = cmd.animate === false ? 0 : 700;
  if (cmd.type === "spotlight") {
    map.easeTo({
      center: toLngLat(cmd.center),
      zoom: SPOTLIGHT_ZOOM,
      pitch: SPOTLIGHT_PITCH,
      padding,
      duration,
    });
    return;
  }
  // ease: centre on the unit at the level's canonical zoom (drives scope derivation).
  map.easeTo({
    center: toLngLat(cmd.center),
    zoom: cmd.zoom ?? map.getZoom(),
    pitch: 0,
    padding,
    duration,
  });
}

// Boundary outline of the current scope's children (added once the style loads).
function setupOutline() {
  if (!map || map.getSource(OUTLINE_SOURCE)) return;
  map.addSource(OUTLINE_SOURCE, {
    type: "geojson",
    data: EMPTY_FC as unknown as GeoJSON.FeatureCollection,
  });
  map.addLayer({
    id: "scope-outline-fill",
    type: "fill",
    source: OUTLINE_SOURCE,
    paint: { "fill-color": "#7c5cff", "fill-opacity": 0.07 },
  });
  map.addLayer({
    id: "scope-outline-line",
    type: "line",
    source: OUTLINE_SOURCE,
    paint: { "line-color": "#7c5cff", "line-width": 2, "line-opacity": 0.85 },
  });
}

function applyOutline() {
  const src = map?.getSource(OUTLINE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
  src?.setData((props.outline ?? EMPTY_FC) as unknown as GeoJSON.FeatureCollection);
}

function emitView() {
  if (!map) return;
  const b = map.getBounds();
  if (!b) return;
  const c = map.getCenter();
  emit("viewChange", {
    zoom: map.getZoom(),
    center: [c.lat, c.lng],
    bounds: { minLat: b.getSouth(), maxLat: b.getNorth(), minLng: b.getWest(), maxLng: b.getEast() },
  });
}

onMounted(() => {
  if (!el.value || !TOKEN) return;
  try {
    mapboxgl.accessToken = TOKEN;
    map = new mapboxgl.Map({
      container: el.value,
      style: STYLE,
      center: toLngLat(FRANCE_CENTER),
      zoom: 4.5,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-left");
    if (import.meta.env.DEV) (window as unknown as { __acMap?: mapboxgl.Map }).__acMap = map;

    let initialLoadDone = false;
    map.once("load", () => {
      initialLoadDone = true;
      setupOutline();
      applyOutline();
      buildMarkers();
      if (props.camera) runCamera({ ...props.camera, animate: false });
      emitView();
    });
    map.on("error", (e) => {
      const status = (e.error as { status?: number } | undefined)?.status;
      if ((status === 401 || status === 403) && map && !initialLoadDone) {
        console.error("Mapbox style request unauthorized — check VITE_MAPBOX_TOKEN");
        unavailable.value = true;
        clearMarkers();
        map.remove();
        map = null;
      }
    });

    map.on("moveend", emitView);
    map.on("moveend", updateSticky); // re-settle pins on their visible interior when motion ends

    // The container can be laid out late (grid/flex settling, fonts) — keep the
    // canvas synced and re-apply the last framing until the user takes the camera.
    const markInteracted = (e: unknown) => {
      if ((e as { originalEvent?: unknown })?.originalEvent) userInteracted = true;
    };
    map.on("dragstart", markInteracted);
    map.on("zoomstart", markInteracted);
    map.on("rotatestart", markInteracted);
    map.on("pitchstart", markInteracted);

    resizeObserver = new ResizeObserver(() => {
      if (!map) return;
      map.resize();
      if (!userInteracted && lastCmd) runCamera({ ...lastCmd, animate: false });
    });
    resizeObserver.observe(el.value);

    setTimeout(() => map?.resize(), 0);
    setTimeout(() => map?.resize(), 300);
  } catch (e) {
    console.error("Mapbox init failed:", e);
    unavailable.value = true;
    clearMarkers();
    try {
      map?.remove();
    } catch {
      /* already broken */
    }
    map = null;
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  clearMarkers();
  map?.remove();
  map = null;
});

watch(() => props.units, () => buildMarkers(), { deep: false });
watch(() => props.outline, () => applyOutline());
watch(
  () => props.camera?.key,
  () => {
    if (props.camera) runCamera(props.camera);
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
  font-size: 0.82rem;
}
</style>
