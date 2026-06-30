<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { getCanonicalLocation, type LocationGroup, type PublicTestimony } from "@ac/shared";
import { api } from "@/lib/api";
import { formatDateShort } from "@/lib/format";
import {
  abbrevCount,
  ancestorsOf,
  applyBoundaries,
  type Bounds,
  buildGeoHierarchy,
  type GeoUnit,
  scopeForView,
  showZoomFor,
  type UnitGeo,
} from "@/lib/geo";
import GeoDrillMap, {
  type CameraCmd,
  type MapUnit,
  type OutlineFC,
} from "@/components/GeoDrillMap.vue";
import TestimonyCard from "@/components/TestimonyCard.vue";
import ExpandTransition from "@/components/ExpandTransition.vue";

const props = defineProps<{
  groups: LocationGroup[];
  testimonies: PublicTestimony[];
  loading: boolean;
  isError: boolean;
}>();

// ---- Boundary geometry (régions/départements outlines + real centroids) ----
interface BoundaryFeature {
  type: "Feature";
  geometry: unknown;
  properties: { code: string; nom: string; center: [number, number]; bounds: Bounds };
}
interface BoundaryFC {
  type: "FeatureCollection";
  features: BoundaryFeature[];
}

const regionsQuery = useQuery({
  queryKey: ["boundaries", "regions"],
  queryFn: () => api.get<BoundaryFC>("/api/boundaries/regions"),
  staleTime: Infinity,
});
const depsQuery = useQuery({
  queryKey: ["boundaries", "departements"],
  queryFn: () => api.get<BoundaryFC>("/api/boundaries/departements"),
  staleTime: Infinity,
});

function lookupOf(fc?: BoundaryFC): Map<string, UnitGeo> {
  const m = new Map<string, UnitGeo>();
  for (const f of fc?.features ?? []) {
    m.set(f.properties.nom, { center: f.properties.center, bounds: f.properties.bounds });
  }
  return m;
}
const regionByNom = computed(() => lookupOf(regionsQuery.data.value));
const depByNom = computed(() => lookupOf(depsQuery.data.value));

// Commune / arrondissement geometry, fetched on demand by INSEE code (the Géo API
// serves precise contours one unit at a time) and cached.
interface CommuneGeo {
  center: [number, number];
  bounds: Bounds;
  geometry: unknown;
}
const communeGeo = ref<Record<string, CommuneGeo>>({});
const pendingInsee = new Set<string>();

async function ensureGeo(codes: string[]) {
  const missing = codes.filter((c) => c && !communeGeo.value[c] && !pendingInsee.has(c));
  if (!missing.length) return;
  missing.forEach((c) => pendingInsee.add(c));
  await Promise.all(
    missing.map(async (code) => {
      try {
        const f = await api.get<BoundaryFeature>(`/api/boundaries/commune/${code}`);
        communeGeo.value = {
          ...communeGeo.value,
          [code]: { center: f.properties.center, bounds: f.properties.bounds, geometry: f.geometry },
        };
      } catch {
        /* leave uncached → unit keeps its data-derived centre */
      } finally {
        pendingInsee.delete(code);
      }
    }),
  );
}

const inseeGeo = computed(() => {
  const m = new Map<string, UnitGeo>();
  for (const [code, g] of Object.entries(communeGeo.value)) {
    m.set(code, { center: g.center, bounds: g.bounds });
  }
  return m;
});

// ---- One hierarchy, both nav models read from it (enriched with real geometry) ----
const hierarchy = computed(() => {
  const h = buildGeoHierarchy(props.groups);
  applyBoundaries(h.index, { region: regionByNom.value, dep: depByNom.value }, inseeGeo.value);
  return h;
});
const root = computed(() => hierarchy.value.root);
const index = computed(() => hierarchy.value.index);

const EMPTY_FC: OutlineFC = { type: "FeatureCollection", features: [] };

// Boundary geometry for a set of units: régions/départements from the bundled
// FCs (by nom), villes/arrondissements from the on-demand commune geometry (by
// INSEE). Other levels have no outline source.
// The boundary polygon for a unit (régions/deps by nom, villes/arr by INSEE).
function geometryFor(u: GeoUnit): unknown {
  if (u.levelKey === "region" || u.levelKey === "dep") {
    const fc = u.levelKey === "region" ? regionsQuery.data.value : depsQuery.data.value;
    return fc?.features.find((x) => x.properties.nom === u.label)?.geometry;
  }
  if ((u.levelKey === "city" || u.levelKey === "arr") && u.insee) {
    return communeGeo.value[u.insee]?.geometry;
  }
  return undefined;
}

function outlineForUnits(units: GeoUnit[]): OutlineFC["features"] {
  const features: OutlineFC["features"] = [];
  for (const u of units) {
    const geometry = geometryFor(u);
    if (geometry) features.push({ type: "Feature", geometry, properties: {} });
  }
  return features;
}

// Outlines: the focused level + the surrounding siblings (focus + context). At the
// lieu level we outline the SCOPE itself (the ville/arrondissement we're inside)
// rather than its lieux. All cleared once a lieu is opened.
const outline = computed<OutlineFC>(() => {
  if (selectedPlace.value) return EMPTY_FC;
  const lvl = panelUnits.value[0]?.levelKey;
  const focus = lvl === "place" ? outlineForUnits([currentScope.value]) : outlineForUnits(panelUnits.value);
  return { type: "FeatureCollection", features: focus.concat(outlineForUnits(scopeSiblings.value)) };
});

interface AuditionGroup {
  id: string;
  title: string;
  date: string | null;
  location: string;
  testimonies: PublicTestimony[];
}

// Testimonies grouped by audition, bucketed under their canonical location, so a
// place's detail view can list its auditions + testimonies.
const auditionsByCanonical = computed(() => {
  const byAud = new Map<string, AuditionGroup>();
  for (const t of props.testimonies) {
    const a = t.audition;
    if (!a) continue;
    let g = byAud.get(a.id);
    if (!g) {
      g = { id: a.id, title: a.title, date: a.date, location: a.location, testimonies: [] };
      byAud.set(a.id, g);
    }
    g.testimonies.push(t);
  }
  const map = new Map<string, AuditionGroup[]>();
  for (const g of byAud.values()) {
    g.testimonies.sort((x, y) => (x.created_at ?? "").localeCompare(y.created_at ?? ""));
    const canon = getCanonicalLocation(g.location);
    const arr = map.get(canon) ?? [];
    arr.push(g);
    map.set(canon, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return map;
});

// ---- Nav state ----
// One unified system: the map is free pan/zoom; the SCOPE is read off the live
// view (zoom → level, centre → which unit). The panel shows the scope's children
// + a breadcrumb to fly back out. Reaching a lieu opens its testimonies.
const selectedPlaceId = ref<string | null>(null);
const mapView = ref<{ center: [number, number]; zoom: number; bounds: Bounds } | null>(null);

const desktopQuery = window.matchMedia("(min-width: 900px)");
const isDesktop = ref(desktopQuery.matches);
const onMedia = (e: MediaQueryListEvent) => (isDesktop.value = e.matches);
desktopQuery.addEventListener("change", onMedia);
onBeforeUnmount(() => desktopQuery.removeEventListener("change", onMedia));

// Scope = the unit the map is currently "inside", derived from the live view.
const currentScope = computed(() =>
  mapView.value ? scopeForView(root.value, mapView.value.center, mapView.value.zoom) : root.value,
);
const selectedPlace = computed(() =>
  selectedPlaceId.value ? (index.value.get(selectedPlaceId.value) ?? null) : null,
);
const breadcrumb = computed(() => ancestorsOf(index.value, currentScope.value.id));

// The list of units the panel shows = the scope's children.
const panelUnits = computed<GeoUnit[]>(() => currentScope.value.children);

// The scope's same-level neighbours (focus + context): kept on the MAP as macro
// pins + boundaries so the surrounding units don't vanish when you drill in.
const scopeSiblings = computed<GeoUnit[]>(() => {
  const s = currentScope.value;
  const parent = s.parentId ? index.value.get(s.parentId) : undefined;
  return parent ? parent.children.filter((c) => c.id !== s.id) : [];
});

function toMapUnit(u: GeoUnit): MapUnit {
  return {
    id: u.id,
    label: u.label,
    count: u.count,
    center: u.center,
    isLeaf: u.levelKey === "place",
    bounds: u.bounds,
    geometry: u.levelKey === "place" ? undefined : geometryFor(u),
  };
}

const mapUnits = computed<MapUnit[]>(() => {
  if (selectedPlace.value) return [toMapUnit(selectedPlace.value)];
  // Focused level's units (detail) + surrounding siblings (context macro pins).
  return [...panelUnits.value, ...scopeSiblings.value].map(toMapUnit);
});

const placeAuditions = computed<AuditionGroup[]>(() => {
  const p = selectedPlace.value;
  return p?.canonical ? (auditionsByCanonical.value.get(p.canonical) ?? []) : [];
});

// Fetch geometry for any ville/arrondissement currently shown. Keyed on the SET of
// INSEE codes so it only fires when that set changes, not on every re-centre.
const visibleInsee = computed(() => {
  const codes: string[] = [];
  const add = (u: GeoUnit) => {
    if ((u.levelKey === "city" || u.levelKey === "arr") && u.insee) codes.push(u.insee);
  };
  panelUnits.value.forEach(add); // the focused level's villes/arrondissements
  add(currentScope.value); // the scope itself (its outline at the lieu level)
  scopeSiblings.value.forEach(add); // surrounding sibling villes/arrondissements
  return codes;
});
watch(
  () => [...visibleInsee.value].sort().join(","),
  () => ensureGeo(visibleInsee.value),
  { immediate: true },
);

// ---- Camera ----
let cameraKey = 0;
const camera = ref<CameraCmd | null>(null);
function setCamera(cmd: Omit<CameraCmd, "key">) {
  camera.value = { key: ++cameraKey, ...cmd };
}
// Fly so a unit becomes the scope: centre on it at its level's canonical zoom,
// which the view-derived scope then resolves to that unit.
function flyToUnit(unit: GeoUnit, animate: boolean) {
  setCamera({ type: "ease", center: unit.center, zoom: showZoomFor(unit.levelKey), animate });
}

const mapPadding = computed(() => {
  if (isDesktop.value) return { top: 60, bottom: 60, left: 60, right: 520 };
  const h = window.innerHeight;
  if (selectedPlace.value) return { top: 24, bottom: Math.max(0, h - 70), left: 30, right: 30 };
  return { top: 30, bottom: Math.round(h * 0.62) + 20, left: 36, right: 36 };
});

// ---- Actions (pins, rows, breadcrumb all fly the map; the scope follows) ----
function activate(unit: GeoUnit) {
  if (unit.levelKey === "place") {
    openPlace(unit);
    return;
  }
  selectedPlaceId.value = null;
  flyToUnit(unit, true);
}

function onUnitClick(id: string) {
  const u = index.value.get(id);
  if (u) activate(u);
}

function drillToCrumb(id: string) {
  const u = index.value.get(id);
  if (!u) return;
  selectedPlaceId.value = null;
  flyToUnit(u, true);
}

function openPlace(unit: GeoUnit) {
  selectedPlaceId.value = unit.id;
  openAuditions.value.clear();
  setCamera({ type: "spotlight", center: unit.center, animate: true });
}

function closePlace() {
  const p = selectedPlace.value;
  selectedPlaceId.value = null;
  // Fly back to the lieu's container so its siblings show again.
  const parent = p?.parentId ? index.value.get(p.parentId) : undefined;
  if (parent) flyToUnit(parent, true);
}

function onViewChange(view: { zoom: number; center: [number, number]; bounds: Bounds }) {
  mapView.value = view;
}

// ---- Place-detail accordion (single-open) ----
const openAuditions = ref(new Set<string>());
function isAudOpen(id: string) {
  return openAuditions.value.has(id);
}
function toggleAud(id: string) {
  const was = openAuditions.value.has(id);
  openAuditions.value.clear();
  if (!was) openAuditions.value.add(id);
}

// Nudge the camera onto France once the hierarchy has data (the map starts wide;
// this puts the régions in the visible area beside the panel).
let framed = false;
watch(
  root,
  (r) => {
    if (framed || !r.children.length) return;
    framed = true;
    const country = r.children.find((c) => c.levelKey === "country") ?? r.children[0];
    flyToUnit(country, false);
  },
  { immediate: true },
);
</script>

<template>
  <div class="geo-page">
    <GeoDrillMap
      class="geo-map"
      :units="mapUnits"
      :camera="camera"
      :outline="outline"
      :padding="mapPadding"
      @unit-click="onUnitClick"
      @view-change="onViewChange"
    />

    <aside class="panel glass-strong elevation-xl">
      <header class="panel-head">
        <div class="title-row">
          <h1>Témoignages</h1>
        </div>

        <!-- Breadcrumb: where the map is; click a crumb to fly back out. -->
        <nav v-if="!selectedPlace" class="crumbs" aria-label="Fil d'Ariane">
          <template v-for="(c, i) in breadcrumb" :key="c.id">
            <button
              type="button"
              class="crumb"
              :class="{ current: i === breadcrumb.length - 1 }"
              @click="drillToCrumb(c.id)"
            >
              {{ c.label }}
            </button>
            <span v-if="i < breadcrumb.length - 1" class="crumb-sep" aria-hidden="true">›</span>
          </template>
        </nav>
      </header>

      <div class="panel-list">
        <div v-if="loading" class="state">Chargement…</div>
        <div v-else-if="isError" class="state">Impossible de charger les témoignages.</div>

        <!-- Place detail: the selected lieu's auditions + testimonies. -->
        <div v-else-if="selectedPlace" class="place-detail">
          <button type="button" class="back-btn" @click="closePlace">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Retour
          </button>
          <h2 class="place-title">{{ selectedPlace.label }}</h2>
          <p class="place-meta">{{ selectedPlace.count }} témoignage{{ selectedPlace.count > 1 ? "s" : "" }}</p>

          <div v-for="g in placeAuditions" :key="g.id" class="aud-group">
            <button
              type="button"
              class="aud-header"
              :class="{ open: isAudOpen(g.id) }"
              :aria-expanded="isAudOpen(g.id)"
              @click="toggleAud(g.id)"
            >
              <div class="aud-info">
                <h3 class="aud-title">{{ g.title }}</h3>
                <p v-if="g.date" class="aud-meta">{{ formatDateShort(g.date) }}</p>
              </div>
              <span class="aud-count">{{ g.testimonies.length }}</span>
              <svg class="aud-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <ExpandTransition>
              <div v-if="isAudOpen(g.id)" class="aud-body">
                <TestimonyCard v-for="t in g.testimonies" :key="t.id" :testimony="t" hide-audition />
              </div>
            </ExpandTransition>
          </div>
        </div>

        <!-- Unit list: children of the scope (Exploration) or units at the
             current zoom level (Zoom). -->
        <div v-else-if="panelUnits.length" class="unit-list">
          <button
            v-for="u in panelUnits"
            :key="u.id"
            type="button"
            class="unit-row"
            @click="activate(u)"
          >
            <span class="unit-label">{{ u.label }}</span>
            <span class="unit-count">{{ abbrevCount(u.count) }}</span>
            <svg
              v-if="u.levelKey !== 'place'"
              class="unit-chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="16"
              height="16"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
            <span v-else class="unit-leaf-tag">lieu</span>
          </button>
        </div>

        <div v-else class="state">Aucun lieu à afficher ici.</div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.geo-page {
  position: relative;
  flex: 1;
  min-height: 480px;
  overflow: hidden;
}

.geo-map {
  position: absolute;
  inset: 0;
}

.panel {
  position: absolute;
  top: 2rem;
  right: 0;
  max-height: calc(100% - 2rem);
  width: min(30rem, 100%);
  display: flex;
  flex-direction: column;
  border-radius: 0.9rem 0 0 0.9rem;
  overflow: hidden;
}

.panel-head {
  flex-shrink: 0;
  padding: 1rem 1.1rem 0.85rem;
  border-bottom: 1px solid hsl(var(--border) / 0.6);
}

.title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.title-row h1 {
  font-size: clamp(1.3rem, 0.95rem + 1.6vw, 1.6rem);
  color: hsl(var(--foreground));
}

.mode-toggle {
  margin-left: auto;
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.2rem;
  border-radius: 0.55rem;
  background: hsl(var(--muted) / 0.6);
}

.mode-btn {
  padding: 0.25rem 0.7rem;
  border-radius: 0.4rem;
  border: none;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition-smooth);
}

.mode-btn.active {
  background: hsl(var(--card));
  color: hsl(var(--primary));
  box-shadow: var(--shadow-sm);
}

.crumbs {
  margin-top: 0.7rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.15rem 0.3rem;
}

.crumb {
  border: none;
  background: transparent;
  padding: 0.1rem 0.25rem;
  border-radius: 0.3rem;
  color: hsl(var(--muted-foreground));
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
}

.crumb:hover {
  background: hsl(var(--accent) / 0.5);
  color: hsl(var(--foreground));
}

.crumb.current {
  color: hsl(var(--primary));
}

.crumb-sep {
  color: hsl(var(--muted-foreground) / 0.6);
}

.level-bar {
  margin-top: 0.7rem;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.level-name {
  font-size: 0.95rem;
  font-weight: 700;
  color: hsl(var(--primary));
}

.level-hint {
  font-size: 0.74rem;
  color: hsl(var(--muted-foreground));
}

.panel-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.6rem 0.7rem 0.9rem;
}

.state {
  padding: 2rem 1rem;
  text-align: center;
  color: hsl(var(--muted-foreground));
}

.unit-list {
  display: flex;
  flex-direction: column;
}

.unit-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.7rem 0.6rem;
  background: transparent;
  border: none;
  border-radius: 0.5rem;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s ease;
}

.unit-row + .unit-row {
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.unit-row:hover {
  background: hsl(var(--accent) / 0.45);
}

.unit-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 0.95rem;
  color: hsl(var(--foreground));
}

.unit-count {
  flex-shrink: 0;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
}

.unit-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}

.unit-leaf-tag {
  flex-shrink: 0;
  font-size: 0.68rem;
  color: hsl(var(--muted-foreground));
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* ---- Place detail ---- */
.place-detail {
  display: flex;
  flex-direction: column;
}

.back-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.5rem 0.25rem 0.35rem;
  margin-bottom: 0.4rem;
  border: 1px solid hsl(var(--border));
  border-radius: 0.45rem;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.back-btn:hover {
  background: hsl(var(--accent) / 0.5);
  color: hsl(var(--foreground));
}

.place-title {
  font-size: 1.05rem;
  font-weight: 700;
  color: hsl(var(--primary));
}

.place-meta {
  margin: 0.1rem 0 0.6rem;
  font-size: 0.8rem;
  color: hsl(var(--muted-foreground));
}

.aud-group + .aud-group {
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.aud-header {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.6rem 0.5rem;
  background: transparent;
  border: none;
  border-radius: 0.5rem;
  text-align: left;
  cursor: pointer;
}

.aud-header:hover {
  background: hsl(var(--accent) / 0.4);
}

.aud-info {
  flex: 1;
  min-width: 0;
}

.aud-title {
  font-size: 0.92rem;
  font-weight: 600;
  color: hsl(var(--foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aud-meta {
  margin: 0.05rem 0 0;
  font-size: 0.78rem;
  color: hsl(var(--muted-foreground));
}

.aud-count {
  flex-shrink: 0;
  padding: 0.12rem 0.55rem;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 700;
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
}

.aud-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
  transition: transform 0.28s ease;
}

.aud-header.open .aud-chevron {
  transform: rotate(180deg);
}

.aud-body {
  display: flex;
  flex-direction: column;
  padding: 0.1rem 0.5rem 0.6rem 0.9rem;
}

.aud-body :deep(.testimony) {
  padding: 0.7rem 0;
}

.aud-body :deep(.testimony) + :deep(.testimony) {
  border-top: 1px solid hsl(var(--border) / 0.45);
}

@media (max-width: 899px) {
  .panel {
    top: 4.05rem;
    left: 0.4rem;
    right: 0.4rem;
    bottom: 0;
    width: auto;
    max-height: none;
    border-radius: 0.9rem 0.9rem 0 0;
  }

  .panel-head {
    padding: 0.6rem 0.8rem 0.5rem;
  }

  .panel-list {
    padding: 0.5rem 0.6rem 0.6rem;
  }
}
</style>
