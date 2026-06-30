<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import mapboxgl from "mapbox-gl";
import type { LocationGroup } from "@ac/shared";
import { FRANCE_CENTER } from "@ac/shared";
import { formatDateShort } from "@/lib/format";

const props = defineProps<{
  groups: LocationGroup[];
  /** Canonical names of the groups to highlight (the auditions matching the
   *  current filter). null = highlight none. */
  activeLocations: string[] | null;
  /** Camera padding for fit/fly — lets a parent reserve space for overlays
   *  (e.g. the floating panel on the Témoignages page). Default 50px. */
  fitPadding?: number | { top: number; bottom: number; left: number; right: number };
  /** Canonical location names the camera should frame (the auditions in the
   *  visible list). null/undefined = frame all groups. The camera re-frames
   *  whenever this changes. */
  focusLocations?: string[] | null;
  /** How a marker behaves:
   *  - "audition" (default): the popup lists the auditions, clicking one emits
   *    `select` (used by Analyses to open that audition).
   *  - "location": hovering shows just the audition count, clicking the marker
   *    emits `selectLocation` for the whole place (used by Témoignages). */
  mode?: "audition" | "location";
  /** Canonical location to zoom in on (the opened audition's place). When set,
   *  the camera flies there at street level instead of framing the list. */
  spotlight?: string | null;
}>();

const emit = defineEmits<{
  select: [payload: { id: string; date: string; location: string }];
  selectLocation: [payload: { location: string }];
}>();

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? "";
// Single fixed style (the published custom one), independent of the site
// theme. Falls back to stock dark when the env var is unset.
const STYLE = import.meta.env.VITE_MAPBOX_STYLE || "mapbox://styles/mapbox/dark-v11";

const el = ref<HTMLElement | null>(null);
const unavailable = ref(!TOKEN);

let map: mapboxgl.Map | null = null;
let markers: { marker: mapboxgl.Marker; element: HTMLElement; group: LocationGroup }[] = [];
let fitted = false;
let userInteracted = false;
let resizeObserver: ResizeObserver | null = null;

// LocationGroup stores [lat, lon]; Mapbox wants [lng, lat].
function toLngLat([lat, lon]: [number, number]): [number, number] {
  return [lon, lat];
}

function isActive(group: LocationGroup): boolean {
  return props.activeLocations != null && props.activeLocations.includes(group.canonicalName);
}

function makeMarkerElement(group: LocationGroup): HTMLElement {
  const dot = document.createElement("div");
  dot.className = isActive(group) ? "marker-dot marker-dot-active" : "marker-dot";
  return dot;
}

// Location-mode popup: the place name, how many auditions it holds, and a
// button that lists them in the panel.
function buildCountPopup(group: LocationGroup): HTMLElement {
  const root = document.createElement("div");
  root.className = "map-popup map-popup-count";

  const title = document.createElement("h3");
  title.className = "map-popup-title";
  title.textContent = group.canonicalName;
  root.appendChild(title);

  const n = group.auditions.length;
  const meta = document.createElement("div");
  meta.className = "map-popup-meta";
  meta.textContent = `${n} audition${n > 1 ? "s" : ""}`;
  root.appendChild(meta);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "map-popup-action";
  btn.textContent = n > 1 ? "Voir les auditions" : "Voir l'audition";
  btn.addEventListener("click", () => {
    emit("selectLocation", { location: group.canonicalName });
    markers.forEach((m) => m.marker.getPopup()?.remove());
  });
  root.appendChild(btn);

  return root;
}

function buildPopup(group: LocationGroup): HTMLElement {
  const root = document.createElement("div");
  root.className = "map-popup";

  const title = document.createElement("h3");
  title.className = "map-popup-title";
  title.textContent = group.canonicalName;
  root.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "map-popup-meta";
  const n = group.totalTestimonies;
  meta.textContent = `${n} témoignage${n > 1 ? "s" : ""}`;
  root.appendChild(meta);

  const list = document.createElement("div");
  list.className = "map-popup-list";
  for (const a of group.auditions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-popup-item";

    const t = document.createElement("span");
    t.className = "map-popup-item-title";
    t.textContent = a.title;
    btn.appendChild(t);

    const d = document.createElement("span");
    d.className = "map-popup-item-date";
    d.textContent = formatDateShort(a.date);
    btn.appendChild(d);

    btn.addEventListener("click", () => {
      emit("select", { id: a.id, date: a.date, location: a.location });
      markers.forEach((m) => m.marker.getPopup()?.remove());
    });
    list.appendChild(btn);
  }
  root.appendChild(list);

  return root;
}

function clearMarkers() {
  for (const { marker } of markers) marker.remove();
  markers = [];
}

function buildMarkers() {
  if (!map) return;
  clearMarkers();
  const locationMode = props.mode === "location";
  for (const group of props.groups) {
    const element = makeMarkerElement(group);
    // Clicking the marker opens the popup. In location mode it shows the
    // audition count + a button that lists them; in audition mode it lists the
    // auditions directly. The panel action is always triggered from the popup.
    const popup = new mapboxgl.Popup({
      offset: 14,
      maxWidth: "min(300px, calc(100vw - 4rem))",
    }).setDOMContent(locationMode ? buildCountPopup(group) : buildPopup(group));

    // Dot lies flat on the ground (tilts with the map) so it reads correctly
    // when the camera pitches.
    const marker = new mapboxgl.Marker({ element, pitchAlignment: "map", rotationAlignment: "map" })
      .setLngLat(toLngLat(group.coordinates))
      .setPopup(popup)
      .addTo(map);

    markers.push({ marker, element, group });
  }

  if (!fitted && props.groups.length > 0) {
    recenter(false);
  }
}

// The groups the camera should frame: the focused subset (auditions in the
// visible list), or all groups when there's no focus.
function focusTargets(): LocationGroup[] {
  const focus = props.focusLocations;
  if (focus == null) return props.groups;
  const set = new Set(focus);
  return props.groups.filter((g) => set.has(g.canonicalName));
}

let fitRetries = 0;

function frame(animate: boolean) {
  if (!map) return;
  const targets = focusTargets();
  if (targets.length === 0) return; // nothing to frame (e.g. zero filtered results)

  // A fit computed against a not-yet-laid-out container (Mapbox falls back
  // to 300×150) produces a near-zero zoom. Wait for real layout, retrying
  // on animation frames (~2s max), then sync the canvas and fit.
  const rect = el.value?.getBoundingClientRect();
  if ((!rect || rect.width < 100 || rect.height < 100) && fitRetries < 120) {
    fitRetries += 1;
    requestAnimationFrame(() => frame(animate));
    return;
  }
  fitRetries = 0;
  map.resize();

  const padding = props.fitPadding ?? 50;
  const duration = animate ? 600 : 0;

  if (targets.length === 1) {
    map.easeTo({
      center: toLngLat(targets[0].coordinates),
      zoom: Math.min(Math.max(map.getZoom(), 11), 13),
      pitch: 0,
      padding,
      duration,
    });
  } else {
    const bounds = new mapboxgl.LngLatBounds();
    for (const g of targets) bounds.extend(toLngLat(g.coordinates));
    map.fitBounds(bounds, { padding, maxZoom: 13, pitch: 0, duration });
  }
  fitted = true;
}

// Street-level zoom + camera tilt used when an audition is opened (reset flat
// on close).
const SPOTLIGHT_ZOOM = 15.3;
const SPOTLIGHT_PITCH = 50;
const SPOTLIGHT_FLY_MS = 1300;

function flyToSpotlight(loc: string, animate: boolean) {
  if (!map) return;
  const group = props.groups.find((g) => g.canonicalName === loc);
  if (!group) {
    frame(animate);
    return;
  }
  const center = toLngLat(group.coordinates);
  const padding = props.fitPadding ?? 50;
  fitted = true;

  // Resize/initial re-centres: snap straight to the final camera.
  if (!animate) {
    map.easeTo({ center, zoom: SPOTLIGHT_ZOOM, pitch: SPOTLIGHT_PITCH, padding, duration: 0 });
    return;
  }

  // One continuous flight: it pans first and the zoom + tilt blend in toward the
  // end. minZoom caps the pull-back at the current view so it never zooms out —
  // the camera holds the wide zoom while moving, then zooms in as it arrives.
  map.flyTo({
    center,
    zoom: SPOTLIGHT_ZOOM,
    pitch: SPOTLIGHT_PITCH,
    padding,
    minZoom: Math.min(map.getZoom(), SPOTLIGHT_ZOOM),
    duration: SPOTLIGHT_FLY_MS,
  });
}

// Re-centre an already-shown spotlight with a simple ease (no "going there"
// fly) — used when the panel geometry changes (an audition opens/closes within
// the focused place) so the pin sits in the new visible centre.
function repadSpotlight(loc: string, animate: boolean) {
  if (!map) return;
  const group = props.groups.find((g) => g.canonicalName === loc);
  if (!group) {
    frame(animate);
    return;
  }
  map.easeTo({
    center: toLngLat(group.coordinates),
    zoom: SPOTLIGHT_ZOOM,
    pitch: SPOTLIGHT_PITCH,
    padding: props.fitPadding ?? 50,
    duration: animate ? 600 : 0,
  });
  fitted = true;
}

// Resize / initial layout: keep the current intent without the fly — re-centre
// the spotlight if one is set, otherwise frame the list.
function recenter(animate: boolean) {
  if (!map) return;
  if (props.spotlight) repadSpotlight(props.spotlight, animate);
  else frame(animate);
}

function paddingKey(): string {
  const p = props.fitPadding;
  if (p == null) return "";
  return typeof p === "number" ? String(p) : `${p.top},${p.bottom},${p.left},${p.right}`;
}

function updateActiveMarkers() {
  for (const { element, group } of markers) {
    element.classList.toggle("marker-dot-active", isActive(group));
  }
}

onMounted(() => {
  if (!el.value || !TOKEN) return;

  try {
    mapboxgl.accessToken = TOKEN;
    map = new mapboxgl.Map({
      container: el.value,
      style: STYLE,
      center: toLngLat(FRANCE_CENTER),
      zoom: 5,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-left");
    if (import.meta.env.DEV) (window as unknown as { __acMap?: mapboxgl.Map }).__acMap = map;

    // An invalid token doesn't throw at construction — it fails async on the
    // style request (401/403). Fall back instead of showing an empty canvas.
    // One-shot flag rather than isStyleLoaded(): that returns false again
    // during setStyle() theme swaps and tile settling, which would let a
    // transient 403 tear down a working map.
    let initialLoadDone = false;
    map.once("load", () => {
      initialLoadDone = true;
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

    // Settle sizing once the surrounding layout is laid out.
    setTimeout(() => map?.resize(), 0);
    setTimeout(() => map?.resize(), 300);

    // Re-apply the initial fit once the style is fully ready: an early fit
    // may have been computed against a not-yet-laid-out canvas.
    map.once("load", () => {
      if (!userInteracted) recenter(false);
    });

    // The container can be laid out LATE (grid settling, fonts, window
    // resizes) — a fit computed against the early narrow box is garbage.
    // Refit on every size change until the user takes over the camera.
    // originalEvent is only present on user gestures, not programmatic moves.
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
      if (!userInteracted) recenter(false);
    });
    resizeObserver.observe(el.value);

    buildMarkers();
  } catch (e) {
    // Typically: WebGL unavailable. Tear down anything half-constructed —
    // a leaked Map keeps a WebGL context and RAF loop alive.
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

watch(
  () => props.groups,
  () => buildMarkers(),
);

// activeLocations only drives marker highlighting now — the camera is framed
// by focusLocations (the visible list).
watch(
  () => (props.activeLocations == null ? "" : [...props.activeLocations].sort().join("|")),
  () => updateActiveMarkers(),
);

// Single camera driver, reacting to spotlight / panel-geometry / visible-list
// changes (all deliberate, so they override a prior manual pan):
//   - spotlight changed to a place → fly there (two-phase move-then-zoom).
//   - same place, only geometry/list changed (an audition opened/closed and
//     widened the panel) → re-centre with a simple ease, so the pin lands in
//     the new visible centre.
//   - no spotlight → frame the whole visible list.
// Combining the three into one watcher means a simultaneous spotlight+padding
// change (opening an audition from the list) fires once and flies — it never
// also re-pads and cuts the fly short.
watch(
  () => [
    props.spotlight ?? "",
    paddingKey(),
    props.focusLocations == null ? "ALL" : [...props.focusLocations].sort().join("|"),
  ],
  (cur, prev) => {
    const sp = props.spotlight;
    if (sp) {
      if (cur[0] !== prev[0]) flyToSpotlight(sp, true);
      else repadSpotlight(sp, true);
    } else {
      frame(true);
    }
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
  border-radius: 0.85rem;
  overflow: hidden;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--muted));
  /* Caps Mapbox's internal stacking below the sticky header (z 50). */
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

.map-fallback code {
  background: hsl(var(--muted));
  border: 1px solid hsl(var(--border));
  border-radius: 0.3rem;
  padding: 0.05rem 0.35rem;
  font-size: 0.8rem;
}
</style>
