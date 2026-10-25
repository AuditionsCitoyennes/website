<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRef, watch } from "vue";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import { ancestorsOf } from "@/features/geo";
import { GeoDrillMap } from "@/features/map";
import { perfBegin, perfEnd } from "@/shared/perf/perf";
import { analysisSummary, ScopeAnalysisOverlay, useScopeAnalysis } from "@/features/analyses";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import GeoPanel from "./panel/GeoPanel.vue";
import UnitList from "./panel/UnitList.vue";
import AuditionList from "./panel/AuditionList.vue";
import { createNavState } from "./navState";
import { useBoundaryQueries } from "./data/useBoundaryQueries";
import { useCommuneGeo } from "./data/useCommuneGeo";
import { useDepFine } from "./data/useDepFine";
import { useGeoHierarchy } from "./model/useGeoHierarchy";
import { useScope } from "./model/useScope";
import { useMapFeed } from "./model/useMapFeed";
import { groupOwnAuditions } from "./model/auditions";
import { usePanelAuditions } from "./model/usePanelAuditions";
import { useCamera } from "./model/useCamera";
import { useNavActions } from "./model/useNavActions";
import { useViewport } from "./panel/useViewport";
import { useBottomSheet } from "./panel/useBottomSheet";
import { usePanelLayout } from "./panel/usePanelLayout";
import { useAnalysesRing } from "./ring/useAnalysesRing";
import { usePlaqueFocus } from "./ring/usePlaqueFocus";

const props = defineProps<{
  groups: LocationGroup[];
  testimonies: PublicTestimony[];
  loading: boolean;
  isError: boolean;
  /** Free-text query — highlighted inside each testimony (TestimonyCard). */
  highlight?: string;
  /** Audition ordering inside a place's panel. */
  sort?: "recent" | "ancien";
  /** Filters are on: the panel lists EVERY audition that matches, in one list,
   *  instead of the drill-down by territory. */
  filtered?: boolean;
  /**
   * Shown as a card (the home page): the map alone — no panel, nothing to
   * interact with, the whole country framed. The SAME instance becomes the
   * page when the card is opened (MapStage): turning this off brings the panel
   * in and makes room for it; turning it back on returns to the country.
   */
  preview?: boolean;
  /** The themes picked in the filters (canonical names): every testimony
   *  counted cites one, so the analyses do not rank them. */
  themeFilter?: string[];
}>();

/** The analyses of the raised territory, drawn on the map around it. The page
 *  owns the toggle; the plates' own close button turns it off from here. */
const analyses = defineModel<boolean>("analyses", { default: false });

// ---- Data: the boundaries, the communes' contours, the raised départements' own ----
const boundaries = useBoundaryQueries();
const { regionsQuery, metroQuery } = boundaries;
const communes = useCommuneGeo();
const deps = useDepFine();
const { ensureDepFine } = deps;

// ---- One hierarchy, both nav models read from it (model/useGeoHierarchy) ----
const geo = useGeoHierarchy({ groups: toRef(props, "groups"), boundaries, communes, deps });
const { root, index, raisedGeometryFor, containsPoint, allPlaceUnits, placeByCanonical } = geo;

// The association's own testimonies (all loaded with the page), grouped by
// audition (model/auditions).
const ownAuditions = computed(() => groupOwnAuditions(props.testimonies));

// ---- Nav state (navState.ts): the one record every piece reads and writes ----
const nav = createNavState(root.value);
const {
  currentScope,
  selectedPlaceId,
  mapEngaged,
  sheetOpen,
  inMicroZone,
  openAuditions,
  hoveredPanelId,
} = nav;

// ---- The viewport (panel/useViewport): a desktop or a phone, the window's size ----
const asCard = toRef(props, "preview");
const { isDesktop, viewportW, viewportH } = useViewport();

// ---- Scope (model/useScope): read off the view, held still while a lieu is read ----
const scope = useScope({
  nav,
  root,
  index,
  communeGeo: communes.communeGeo,
  containsPoint,
  isDesktop,
  // The layout a view must have been measured in: the ring's view padding or
  // the wide panel's when there is one, else the camera's — both set up below.
  mapInsets: () => mapViewPadding.value ?? mapPadding.value,
});
const { readingPlace, deriveScope, onViewChange, selectedPlace, breadcrumb, panelUnits } = scope;

// ---- Boot overlay ------------------------------------------------------------
// A cold load shows an unstyled map, tiles popping in, and an empty panel before
// anything is presentable. Cover all of it, and lift once the pieces the FIRST
// view needs are in: the basemap painted (GeoDrillMap's `ready`), the
// testimonies, and the two boundary sets that view is drawn from — régions and
// the country contour. Départements and commune contours are fetched on demand
// when drilling, so waiting on them here would just hold the screen longer.
const mapPresentable = ref(false);
const booting = ref(true);
watch(
  () =>
    !mapPresentable.value ||
    props.loading ||
    metroQuery.isLoading.value ||
    regionsQuery.isLoading.value,
  (busy) => {
    if (!busy) booting.value = false;
  },
  { immediate: true },
);
// Latch: `booting` only ever goes false. Later loading — a refetch, a drill's
// commune contours — must not throw the curtain back up mid-session.
//
// And a hard cap, because every input above can fail to arrive: a query that
// retries for a long time, or a map whose style never loads. Being stuck behind
// a loading screen is worse than a rough first paint.
const bootCap = window.setTimeout(() => (booting.value = false), 10_000);
onBeforeUnmount(() => clearTimeout(bootCap));

// Direction of the level swap, from how deep the new scope sits in the
// hierarchy: going deeper brings the new list in from the right, stepping back
// out reverses it. Depth comes from the ancestor chain rather than counting "/"
// in the id — the root ("world") would otherwise tie with a top-level country.
const slideDir = ref<"in" | "out">("in");
let lastDepth = -1;
watch(
  () => currentScope.value.id,
  (id) => {
    const depth = ancestorsOf(index.value, id).length;
    if (lastDepth >= 0 && depth !== lastDepth) slideDir.value = depth > lastDepth ? "in" : "out";
    lastDepth = depth;
  },
  { immediate: true },
);
const slideName = computed(() => (slideDir.value === "in" ? "level-in" : "level-out"));

// A drill or a filter change can retire the hovered row without any mouseleave
// firing, which would strand the highlight on a unit that is no longer listed.
watch(panelUnits, (units) => {
  if (hoveredPanelId.value && !units.some((u) => u.id === hoveredPanelId.value)) {
    hoveredPanelId.value = null;
  }
});

// ---- Filtered: every matching audition in ONE list ---------------------------
// With filters on, what the reader wants is the answer to them — not a drill
// through territories to find where the answers are. So the panel lists every
// audition that matches, the map frames all of their lieux at once, and opening
// one flies the map to its lieu (see toggleAud).
const listMode = computed(() => Boolean(props.filtered));

// ---- The panel's parts (panel/GeoPanel, AuditionList): what the composables measure ----
const panelCmp = ref<InstanceType<typeof GeoPanel> | null>(null);
const auditionsCmp = ref<InstanceType<typeof AuditionList> | null>(null);
/** The panel (`.panel`), its strip, its safe-area probe, its list's scroller
 *  and the results' sentinel — exposed by the components, read as refs. */
const panelEl = computed(() => panelCmp.value?.el ?? null);
const sheetPeekEl = computed(() => panelCmp.value?.peekEl ?? null);
const sheetSafeEl = computed(() => panelCmp.value?.safeEl ?? null);
const panelListEl = computed(() => panelCmp.value?.listEl ?? null);
const moreEl = computed(() => auditionsCmp.value?.moreEl ?? null);

// ---- The camera (model/useCamera): what GeoDrillMap is told to frame ----
const mapCmp = ref<InstanceType<typeof GeoDrillMap> | null>(null);
const cam = useCamera({
  nav,
  index,
  raisedGeometryFor,
  containsPoint,
  allPlaceUnits,
  ensureDepFine,
  mapCmp,
  listMode,
});
const { camera, framedFit, flyToUnit, spotlightPlace, scheduleResultsFit } = cam;

// ---- The panel's auditions (model/usePanelAuditions): a lieu's own, or the results ----
const panel = usePanelAuditions({
  nav,
  groups: toRef(props, "groups"),
  sort: toRef(props, "sort"),
  listMode,
  ownAuditions,
  selectedPlace,
  placeByCanonical,
  panelListEl,
  moreEl,
  spotlightPlace,
  scheduleResultsFit,
});
const {
  resultAuditions,
  moreResults,
  showMoreResults,
  panelAuditions,
  auditionMeta,
  audSwapping,
  toggleAud,
} = panel;

// ---- What the map is handed (model/useMapFeed): outline, pending hold, pins ----
const { outline, scopePending, outlineReady, mapUnits } = useMapFeed({
  nav,
  geo,
  boundaries,
  communes,
  deps,
  panelUnits,
  selectedPlace,
});

/** The page the map fills (`.geo-page`), GeoNav's own element. */
const pageEl = ref<HTMLElement | null>(null);

// ---- The phone's sheet (panel/useBottomSheet), the panel's layout (panel/usePanelLayout) ----
const sheet = useBottomSheet({ nav, isDesktop, panelEl, peekEl: sheetPeekEl, safeEl: sheetSafeEl });
const {
  sheetPeekPx,
  sheetDragPx,
  sheetLowered,
  sheetHidden,
  sheetStyle,
  measureSheet,
  onSheetPointerDown,
  onSheetPointerMove,
  onSheetPointerUp,
} = sheet;
const layout = usePanelLayout({
  nav,
  isDesktop,
  viewportW,
  viewportH,
  preview: asCard,
  selectedPlace,
  panelEl,
  sheet: {
    peekEl: sheetPeekEl,
    measure: measureSheet,
    dragging: sheet.dragging,
    peekPx: sheetPeekPx,
  },
});
const {
  panelWide,
  panelFolded,
  panelFlush,
  panelHeightPx,
  engageMap,
  returnToPanel,
  cancelHoverReturn,
  onPanelClick,
  onPanelKeydown,
  onPanelFocusIn,
  onPanelPointerMove,
  onPanelPointerLeave,
  mapPadding,
} = layout;
// Back on the map (or the lieu closed): the scope, held still meanwhile,
// catches up with wherever the view is now.
watch(readingPlace, (reading) => {
  if (!reading) deriveScope();
});

// ---- The analyses' ring (ring/useAnalysesRing): the room the camera leaves the plates ----
const ring = useAnalysesRing({
  nav,
  analyses,
  preview: asCard,
  isDesktop,
  viewportW,
  viewportH,
  pageEl,
  sheetPeekPx,
  layout,
  listMode,
  readingPlace,
  mapCmp,
  camera: cam,
});
const {
  measureHeaderClear,
  ringWanted,
  ringOn,
  ringRoom,
  overlayInsets,
  plateScreen,
  mapViewPadding,
} = ring;

// ---- Actions (model/useNavActions): pins, rows, breadcrumb all fly the map ----
const { activate, onUnitClick, drillToCrumb } = useNavActions({
  nav,
  index,
  listMode,
  camera: cam,
  panel,
  engageMap,
});

// ---- Analyses ----------------------------------------------------------------
// What the association heard in the raised territory, drawn on the map around
// its plateau (ScopeAnalysisOverlay): its figures, the words' content boxes,
// whether they are on screen, the slabs GeoDrillMap stands and the room the
// camera leaves them — analyses/composables/useScopeAnalysis, handed what it
// reads of this component. None of it may reach `outline`: the plateau would
// be rebuilt for a change it does not show.

/** The filters' themes, as the plates are handed them (one array, not a fresh
 *  one per render). */
const NO_THEMES: string[] = [];
const filterThemes = computed(() => props.themeFilter ?? NO_THEMES);

const { scopeAnalysis, analysesVisible, slabSizesNow, slabSpec, roomNow, fontsLoaded } =
  useScopeAnalysis({
    analyses,
    preview: toRef(props, "preview"),
    groups: toRef(props, "groups"),
    ownAuditions,
    currentScope,
    placeByCanonical,
    booting,
    inMicroZone,
    readingPlace,
    isDesktop,
    sheetOpen,
    plateScreen,
    listMode,
    themeFilter: filterThemes,
    framedFit,
  });
// The room the plates need, bound late for the camera (navState's roomNow box):
// setCamera reads it at each command, the resize watch above as the width changes.
nav.roomNow.value = roomNow;

// ---- The focus around the plates (ring/usePlaqueFocus) ----
const overlayCmp = ref<InstanceType<typeof ScopeAnalysisOverlay> | null>(null);
const { focusPlaqueWhenShown, dropPlaqueFocus } = usePlaqueFocus({
  analyses,
  scopeAnalysis,
  analysesVisible,
  overlayCmp,
});

// Turning the analyses on is asking to see the map.
// - A lieu open: it stays open (nothing on the map closes it), the map is
//   handed the screen as if the user had taken it — the wide panel folds, the
//   sheet lowers — and, deep at the lieu where nothing stands, the map pulls
//   back to the territory around it, which rises with its analyses (exactly
//   what a click on that territory does). Higher up, the ring's fit frames the
//   territory already in sight (see applyRing).
// - Otherwise on a phone the sheet lowers; a desktop moves nothing (the ring's
//   fit aside).
// Turned on from the keyboard, the focus then goes to the plaque (below).
watch(analyses, (on) => {
  if (!on) {
    dropPlaqueFocus();
    return;
  }
  if (props.preview) return;
  measureHeaderClear();
  const from = document.activeElement;
  if (from && panelEl.value?.contains(from) && from.matches(":focus-visible")) {
    focusPlaqueWhenShown(from);
  }
  const place = selectedPlace.value;
  if (!place) {
    if (!isDesktop.value) sheetOpen.value = false;
    return;
  }
  if (isDesktop.value) {
    mapEngaged.value = true;
    nav.hoverReturnHeld.value = panelEl.value?.matches(":hover") ?? false;
    cancelHoverReturn();
  } else sheetOpen.value = false;
  if (!inMicroZone.value) return;
  const parent = place.parentId ? index.value.get(place.parentId) : undefined;
  if (!parent) return;
  currentScope.value = parent; // optimistic — see activate()
  flyToUnit(parent, true);
});

// ---- What the plates say, for a screen reader (analyses/content/summary) -----
// Said once the territory has settled: the scope can change several times
// while the map is being moved, and each change would otherwise be read out.
const analysesLive = ref("");
let liveTimer = 0;
watch(
  () =>
    analysesVisible.value && scopeAnalysis.value
      ? analysisSummary(scopeAnalysis.value, {
          filtered: listMode.value,
          themeFilter: filterThemes.value,
        })
      : "",
  (text) => {
    window.clearTimeout(liveTimer);
    if (!text) {
      analysesLive.value = "";
      return;
    }
    liveTimer = window.setTimeout(() => (analysesLive.value = text), 700);
  },
);
onBeforeUnmount(() => window.clearTimeout(liveTimer));

if (import.meta.env.DEV) {
  // Probe for checking the ring and the plates' room in a browser.
  const probe = () => ({
    analyses: analyses.value,
    ringOn: ringOn.value,
    ringWanted: ringWanted.value,
    padding: mapPadding.value,
    viewPadding: mapViewPadding.value ?? null,
    room: ringRoom.value,
    insets: overlayInsets.value,
    visible: analysesVisible.value,
    scope: currentScope.value.id,
    analysis: scopeAnalysis.value?.scopeId ?? null,
    framedFit: framedFit.value,
    slabSpec: slabSpec.value,
    slabSizes: slabSizesNow.value,
    fontsLoaded: fontsLoaded.value,
  });
  const w = window as unknown as { __acAnalysesNav?: () => unknown };
  w.__acAnalysesNav = probe;
  onBeforeUnmount(() => {
    if (w.__acAnalysesNav === probe) delete w.__acAnalysesNav;
  });
}

if (__TEST_TOOLS__) {
  // The perf probes (shared/perf): the scope written is where "scope change →
  // mask re-cut" starts (useScopeMask ends it), and a drill's boundaries are
  // ready once the outline of the unit selected has every geometry it will get
  // (useNavActions starts that one). Sync: at the write itself, not at the flush.
  watch(
    () => currentScope.value.id,
    (id) => perfBegin("scope-mask", id),
    { flush: "sync" },
  );
  watch(
    [() => currentScope.value.id, outlineReady],
    ([id, ready]) => {
      if (ready) perfEnd("drill-boundaries", id);
    },
    { flush: "sync" },
  );
}

// The map changing places (MapStage moves it between the home page's card and
// the page once this render is done — hence the wait: it is framed where it
// now is, at its new size).
// - Back to a card: whatever was open closes, and it returns to the country.
// - The card becoming the page: framed again beside the panel now there,
//   rather than the card's framing merely shifted aside.
watch(
  () => props.preview,
  async (preview) => {
    await nextTick();
    if (preview !== props.preview) return; // changed again meanwhile
    if (!preview) {
      measureSheet(); // the phone's sheet, shown at last
      if (!selectedPlaceId.value) flyToUnit(currentScope.value, true, true);
      return;
    }
    const country = root.value.children.find((c) => c.levelKey === "country");
    if (!country) return;
    selectedPlaceId.value = null;
    openAuditions.value = new Set();
    mapEngaged.value = false;
    sheetOpen.value = false;
    currentScope.value = country; // optimistic — see activate()
    flyToUnit(country, true, true);
  },
);

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
  <!-- As a card, nothing in it takes the pointer or the focus (inert): the
       card's own button, over it, opens the page. -->
  <div
    ref="pageEl"
    class="geo-page"
    :class="{ preview }"
    :inert="preview || undefined"
    :style="{ '--sheet-peek': `${sheetPeekPx}px` }"
  >
    <GeoDrillMap
      ref="mapCmp"
      class="geo-map"
      :units="mapUnits"
      :camera="camera"
      :outline="outline"
      :padding="mapPadding"
      :view-padding="mapViewPadding"
      :scope-pending="scopePending"
      :hovered-id="hoveredPanelId"
      :active-id="selectedPlaceId"
      :slabs="slabSpec"
      @ready="mapPresentable = true"
      @unit-click="onUnitClick"
      @view-change="onViewChange"
      @user-gesture="engageMap"
    />

    <!-- The analyses, around the raised territory. Over the map, under the
         panel: no z-index of its own, and before the panel in the page. -->
    <ScopeAnalysisOverlay
      v-if="scopeAnalysis && slabSizesNow"
      ref="overlayCmp"
      :analysis="scopeAnalysis"
      :sizes="slabSizesNow"
      :visible="analysesVisible"
      :insets="overlayInsets"
      :frames="mapCmp"
      :compact="!isDesktop"
      :filtered="listMode"
      :theme-filter="filterThemes"
      @close="analyses = false"
    />
    <p class="analyses-live" aria-live="polite">{{ analysesLive }}</p>

    <!-- Away while the map is a card; slides in when the card becomes the page.
         The aside's own listeners — a click, a key, the wheel or the pointer
         resting on it bring a folded panel back (usePanelLayout) — are attached
         here, on its root (panel/GeoPanel). -->
    <Transition name="panel-arrive">
      <GeoPanel
        v-show="!preview"
        ref="panelCmp"
        :wide="panelWide"
        :folded="panelFolded"
        :flush="panelFlush"
        :sheet-lowered="sheetLowered"
        :sheet-dragging="sheetDragPx !== null"
        :sheet-style="sheetStyle"
        :sheet-open="sheetOpen"
        :sheet-hidden="sheetHidden"
        :crumbs="listMode ? null : breadcrumb"
        @toggle-sheet="sheetOpen = !sheetOpen"
        @sheet-pointerdown="onSheetPointerDown"
        @sheet-pointermove="onSheetPointerMove"
        @sheet-pointerup="onSheetPointerUp"
        @crumb="drillToCrumb"
        @click.capture="onPanelClick"
        @keydown="onPanelKeydown"
        @focusin="onPanelFocusIn"
        @wheel.passive="returnToPanel"
        @touchstart.passive="returnToPanel"
        @pointermove="onPanelPointerMove"
        @pointerleave="onPanelPointerLeave"
      >
        <!-- Filter entry point and the search field / chips: the page owns the
             filter state, so it fills these slots (passed through GeoPanel). -->
        <template #head-actions><slot name="head-actions" /></template>
        <template #head-below><slot name="head-below" /></template>

        <div v-if="loading" class="state">
          <LoadingDots label="Chargement des témoignages…" />
        </div>
        <div v-else-if="isError" class="state">Impossible de charger les témoignages.</div>

        <!-- The auditions being listed, each unfolding its testimonies: those of
             the selected lieu (exiting goes through the breadcrumb — any ancestor
             crumb closes the lieu), or, with filters on, EVERY audition that
             matches them, wherever it was held. -->
        <AuditionList
          v-else-if="listMode || selectedPlace"
          ref="auditionsCmp"
          :list-mode="listMode"
          :place="selectedPlace"
          :result-count="resultAuditions.length"
          :auditions="panelAuditions"
          :open="openAuditions"
          :meta="auditionMeta"
          :swapping="audSwapping"
          :highlight="highlight"
          :more="moreResults"
          @toggle="toggleAud"
          @more="showMoreResults"
        />

        <!-- Unit list: children of the scope. The level is swapped as ONE block,
             keyed by scope id — drilling in slides the new list in from the
             right, stepping back out reverses it. -->
        <UnitList
          v-else-if="panelUnits.length"
          :units="panelUnits"
          :scope-id="currentScope.id"
          :slide="slideName"
          @activate="activate"
          @hover="hoveredPanelId = $event"
        />

        <div v-else class="state">Aucun lieu à afficher ici.</div>
      </GeoPanel>
    </Transition>

    <!-- The shadow the folded panel's text fades into. It belongs to the
         SCREEN's right edge, not to the panel: it stays put while the panel
         slides under it (on the panel it travelled across the text). -->
    <div
      class="panel-shade"
      :class="{ on: panelFolded }"
      :style="{ height: `${panelHeightPx}px` }"
      aria-hidden="true"
    ></div>

    <!-- Boot curtain: covers map AND panel, so nothing half-built is on show.
         Lifts on its own (see `booting`) and is inert once gone. -->
    <Transition name="boot">
      <div v-if="booting" class="boot" role="status" aria-live="polite">
        <span class="spinner spinner-lg" aria-hidden="true"></span>
        <p>Chargement de la carte…</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.boot {
  position: absolute;
  inset: 0;
  /* Above the panel (elevation-xl) and the map's own controls. */
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  background: hsl(var(--background));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}

/* Fade the curtain out only — it is covering the entrance animation, so it must
   not still be fading in over it. */
.boot-leave-active {
  transition: opacity 0.45s ease;
}

.boot-leave-to {
  opacity: 0;
}

.geo-page {
  position: relative;
  flex: 1;
  min-height: 480px;
  overflow: hidden;
  /* Not even by script: focus moving onto a control of the folded panel's
     off-screen part would otherwise scroll the whole page sideways. */
  overflow: clip;
}

.geo-map {
  position: absolute;
  inset: 0;
}

/* Read out, not shown: the plates themselves are on screen. */
.analyses-live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* A card: as tall as the card, whatever that is — and without the zoom
   buttons, which it does not take (the attribution stays: it is owed). */
.geo-page.preview {
  min-height: 0;
}

.geo-page.preview :deep(.mapboxgl-ctrl-group) {
  display: none;
}

/* Desktop only (see below): a phone's sheet never slides off the side. */
.panel-shade {
  display: none;
}

@media (min-width: 900px) {
  /* Folded, the panel's text runs off the edge of the screen. A shadow on that
     edge says that it goes on behind it, instead of leaving the lines cut
     clean. Fixed to the page's right edge, over the panel and as tall as it
     (same `top`; the height is measured), it fades in and out with the slide. */
  .panel-shade {
    display: block;
    position: absolute;
    top: 2rem;
    right: 0;
    width: 4.5rem;
    /* Deeper on the dark theme, whose near-black panel swallows a light
       shadow. (First line: for browsers without light-dark().) */
    background: linear-gradient(to right, transparent, rgb(0 0 0 / 0.45));
    background: linear-gradient(
      to right,
      transparent,
      light-dark(rgb(0 0 0 / 0.28), rgb(0 0 0 / 0.7))
    );
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.55s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .panel-shade.on {
    opacity: 1;
  }
}

@media (min-width: 900px) and (prefers-reduced-motion: reduce) {
  .panel-shade {
    transition: none;
  }
}

.state {
  padding: 2rem 1rem;
  text-align: center;
  color: hsl(var(--muted-foreground));
}

@media (max-width: 899px) {
  /* The lowered sheet covers the map's bottom edge, which is where mapbox puts
     the zoom buttons, its logo and the attribution — lift them clear of it. */
  .geo-map :deep(.mapboxgl-ctrl-bottom-left),
  .geo-map :deep(.mapboxgl-ctrl-bottom-right) {
    bottom: var(--sheet-peek, 4.5rem);
  }
}
</style>
