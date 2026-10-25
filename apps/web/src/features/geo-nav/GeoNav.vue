<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRef, watch } from "vue";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import { abbrevCount, ancestorsOf } from "@/features/geo";
import { GeoDrillMap } from "@/features/map";
import { analysisSummary, ScopeAnalysisOverlay, useScopeAnalysis } from "@/features/analyses";
import TestimonyCard from "@/shared/testimony/TestimonyCard.vue";
import ExpandTransition from "@/shared/ui/transition/ExpandTransition.vue";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
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

// ---- Breadcrumb overflow: the trail must stay ONE line. When there's no room
// left, the LEADING crumbs collapse into a single "…" (Monde › France › … ›
// Lyon › Lyon 3ᵉ) and clicking the "…" flies back to the deepest hidden
// ancestor. `crumbsCollapsed` = how many leading crumbs are wrapped in it;
// fitCrumbs re-measures from zero (collapse one at a time until the row fits,
// the current unit always stays visible) on every trail change and resize. ----
const crumbsEl = ref<HTMLElement | null>(null);
const crumbsCollapsed = ref(0);
let crumbsFitSeq = 0; // a newer fit run supersedes an in-flight one (awaits nextTick)
async function fitCrumbs() {
  const seq = ++crumbsFitSeq;
  crumbsCollapsed.value = 0;
  await nextTick();
  while (
    seq === crumbsFitSeq &&
    crumbsEl.value &&
    crumbsEl.value.scrollWidth > crumbsEl.value.clientWidth + 1 &&
    crumbsCollapsed.value < breadcrumb.value.length - 1
  ) {
    crumbsCollapsed.value++;
    await nextTick();
  }
}
watch(breadcrumb, () => void fitCrumbs(), { flush: "post" });
// The nav mounts/unmounts with the place detail (v-if) and the panel width can
// change with the viewport — re-fit on both (observe() fires once immediately).
let crumbsRO: ResizeObserver | null = null;
watch(crumbsEl, (el) => {
  crumbsRO?.disconnect();
  crumbsRO = null;
  if (el && typeof ResizeObserver !== "undefined") {
    crumbsRO = new ResizeObserver(() => void fitCrumbs());
    crumbsRO.observe(el);
  }
});
onBeforeUnmount(() => crumbsRO?.disconnect());
const visibleCrumbs = computed(() => breadcrumb.value.slice(crumbsCollapsed.value));
/** The deepest ancestor wrapped in the "…" — where its click flies back to. */
const crumbsHidden = computed(() =>
  crumbsCollapsed.value > 0 ? breadcrumb.value[crumbsCollapsed.value - 1] : undefined,
);

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

// ---- The camera (model/useCamera): what GeoDrillMap is told to frame ----
const panelListEl = ref<HTMLElement | null>(null);
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
  spotlightPlace,
  scheduleResultsFit,
});
const {
  resultAuditions,
  moreResults,
  showMoreResults,
  moreEl,
  panelAuditions,
  auditionMeta,
  testimoniesOf,
  isAudOpen,
  audSwapping,
  toggleAud,
} = panel;

// ---- What the map is handed (model/useMapFeed): outline, pending hold, pins ----
const { outline, scopePending, mapUnits } = useMapFeed({
  nav,
  geo,
  boundaries,
  communes,
  deps,
  panelUnits,
  selectedPlace,
});

// ---- Template refs the panel, the sheet and the ring measure ----
const panelEl = ref<HTMLElement | null>(null);
/** Grip + title row — what stays on screen when lowered, and the drag handle. */
const sheetPeekEl = ref<HTMLElement | null>(null);
/** Zero-size probe whose padding resolves `env(safe-area-inset-bottom)`. */
const sheetSafeEl = ref<HTMLElement | null>(null);
/** The page the map fills. */
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

    <!-- Away while the map is a card; slides in when the card becomes the page. -->
    <Transition name="panel-arrive">
      <aside
        v-show="!preview"
        ref="panelEl"
        class="panel glass-strong elevation-xl"
        :class="{
          wide: panelWide,
          folded: panelFolded,
          flush: panelFlush,
          'sheet-lowered': sheetLowered,
          'sheet-dragging': sheetDragPx !== null,
        }"
        :style="sheetStyle"
        @click.capture="onPanelClick"
        @keydown="onPanelKeydown"
        @focusin="onPanelFocusIn"
        @wheel.passive="returnToPanel"
        @touchstart.passive="returnToPanel"
        @pointermove="onPanelPointerMove"
        @pointerleave="onPanelPointerLeave"
      >
        <span ref="sheetSafeEl" class="sheet-safe" aria-hidden="true"></span>
        <header class="panel-head">
          <!-- On a phone this strip is all that shows of the lowered sheet, and
             it is the handle: drag it up to raise the panel, down to lower it. -->
          <div
            ref="sheetPeekEl"
            class="sheet-peek"
            @pointerdown="onSheetPointerDown"
            @pointermove="onSheetPointerMove"
            @pointerup="onSheetPointerUp"
            @pointercancel="onSheetPointerUp"
          >
            <button
              type="button"
              class="sheet-grip"
              :aria-expanded="sheetOpen"
              :aria-label="sheetOpen ? 'Réduire le panneau' : 'Afficher le panneau'"
              @click="sheetOpen = !sheetOpen"
            >
              <span aria-hidden="true"></span>
            </button>
            <div class="title-row">
              <h1>Témoignages</h1>
              <!-- Filter entry point (the "Filtres" button + its active count).
                 The page owns the filter state, so it fills these slots rather
                 than the state being drilled down into this component. -->
              <slot name="head-actions" />
            </div>
          </div>

          <!-- Search field, active-filter chips, filter notices — same reason.
             (Everything under the strip is off screen while the sheet is
             lowered, so it is made inert: no focus, no screen-reader stops.) -->
          <div :inert="sheetHidden || undefined">
            <slot name="head-below" />
          </div>

          <!-- Breadcrumb: where the map is; click a crumb to fly back out. One
             line only — leading crumbs collapse into "…" when room runs out,
             and the "…" flies back to the deepest ancestor it wraps. With a
             lieu open the trail stays and ends at the lieu itself. -->
          <nav
            v-if="!listMode"
            ref="crumbsEl"
            class="crumbs"
            aria-label="Fil d'Ariane"
            :inert="sheetHidden || undefined"
          >
            <template v-if="crumbsHidden">
              <button
                type="button"
                class="crumb crumb-more"
                :title="crumbsHidden.label"
                :aria-label="`Revenir à ${crumbsHidden.label}`"
                @click="drillToCrumb(crumbsHidden.id)"
              >
                …
              </button>
              <span class="crumb-sep" aria-hidden="true">›</span>
            </template>
            <template v-for="(c, i) in visibleCrumbs" :key="c.id">
              <button
                type="button"
                class="crumb"
                :class="{ current: i === visibleCrumbs.length - 1 }"
                @click="drillToCrumb(c.id)"
              >
                {{ c.label }}
              </button>
              <span v-if="i < visibleCrumbs.length - 1" class="crumb-sep" aria-hidden="true"
                >›</span
              >
            </template>
          </nav>
        </header>

        <div ref="panelListEl" class="panel-list" :inert="sheetHidden || undefined">
          <div v-if="loading" class="state">
            <LoadingDots label="Chargement des témoignages…" />
          </div>
          <div v-else-if="isError" class="state">Impossible de charger les témoignages.</div>

          <!-- The auditions being listed, each unfolding its testimonies: those of
             the selected lieu (exiting goes through the breadcrumb — any ancestor
             crumb closes the lieu), or, with filters on, EVERY audition that
             matches them, wherever it was held. -->
          <div v-else-if="listMode || selectedPlace" class="place-detail">
            <template v-if="listMode">
              <h2 class="place-title">
                {{ resultAuditions.length }} audition{{ resultAuditions.length > 1 ? "s" : "" }}
              </h2>
              <p class="place-meta" :class="{ 'place-empty': !resultAuditions.length }">
                {{
                  resultAuditions.length
                    ? "correspondant aux filtres"
                    : "Aucune audition ne correspond aux filtres."
                }}
              </p>
            </template>
            <template v-else-if="selectedPlace">
              <h2 class="place-title">{{ selectedPlace.label }}</h2>
              <p class="place-meta">
                {{ selectedPlace.count }} témoignage{{ selectedPlace.count > 1 ? "s" : "" }}
              </p>
            </template>

            <div v-for="g in panelAuditions" :key="g.id" class="aud-group">
              <button
                type="button"
                class="aud-header"
                :class="{ open: isAudOpen(g.id) }"
                :aria-expanded="isAudOpen(g.id)"
                :data-aud="g.id"
                @click="toggleAud(g.id)"
              >
                <div class="aud-info">
                  <h3 class="aud-title">{{ g.title }}</h3>
                  <p v-if="auditionMeta(g)" class="aud-meta" :title="auditionMeta(g)">
                    {{ auditionMeta(g) }}
                  </p>
                </div>
                <span class="aud-count">{{ g.count }}</span>
                <svg
                  class="aud-chevron"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  width="18"
                  height="18"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <!-- Its testimonies are still loading: the dots, right under its
                 line. The text then unfolds to its own height — measured once
                 it is there. -->
              <LoadingDots
                v-if="isAudOpen(g.id) && testimoniesOf(g) === null"
                class="aud-loading"
                label="Chargement des témoignages…"
              />
              <ExpandTransition :instant-leave="audSwapping">
                <div v-if="isAudOpen(g.id) && testimoniesOf(g) !== null" class="aud-body">
                  <p v-if="!testimoniesOf(g)?.length" class="aud-empty">
                    Aucun témoignage à afficher.
                  </p>
                  <TestimonyCard
                    v-for="t in testimoniesOf(g) ?? []"
                    :key="t.id"
                    :testimony="t"
                    :highlight="highlight"
                    hide-audition
                  />
                </div>
              </ExpandTransition>
            </div>

            <!-- More results than are listed: the next page comes as this nears
               the bottom of the panel (or on a press). -->
            <button
              v-if="listMode && moreResults"
              ref="moreEl"
              type="button"
              class="ac-btn ac-btn--ghost ac-btn--sm more-results"
              @click="showMoreResults"
            >
              Afficher plus d'auditions
            </button>
          </div>

          <!-- Unit list: children of the scope. The level is swapped as ONE block,
             keyed by scope id — drilling in slides the new list in from the
             right, stepping back out reverses it.
             NOT a per-row TransitionGroup: on a full swap every row leaves at
             once, and a leaving row was taken out of flow with no `top`, so once
             its previous siblings were out of flow too their auto positions all
             collapsed to the same y — the whole list piled up on one line and
             then dropped as the new rows animated down. -->
          <div v-else-if="panelUnits.length" class="unit-viewport">
            <Transition :name="slideName">
              <div :key="currentScope.id" class="unit-list">
                <button
                  v-for="u in panelUnits"
                  :key="u.id"
                  type="button"
                  class="unit-row"
                  @click="activate(u)"
                  @mouseenter="hoveredPanelId = u.id"
                  @mouseleave="hoveredPanelId = null"
                  @focus="hoveredPanelId = u.id"
                  @blur="hoveredPanelId = null"
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
            </Transition>
          </div>

          <div v-else class="state">Aucun lieu à afficher ici.</div>
        </div>
      </aside>
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

/* The panel arriving as the card becomes the page — after the map has started
   making room for it. `translate`, not `transform`: the fold and the phone
   sheet own the transform. (Doubled classes: the panel's own `transition`, in
   the media queries below, would otherwise win.) */
.panel.panel-arrive-enter-active {
  transition:
    opacity 0.45s ease 0.12s,
    translate 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.12s;
}

.panel.panel-arrive-enter-from {
  opacity: 0;
  translate: 2.5rem 0;
}

.panel.panel-arrive-leave-active {
  transition: opacity 0.2s ease;
}

.panel.panel-arrive-leave-to {
  opacity: 0;
}

@media (max-width: 899px) {
  .panel.panel-arrive-enter-from {
    translate: 0 2.5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .panel.panel-arrive-enter-active,
  .panel.panel-arrive-leave-active {
    transition: none;
  }
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

/* Grown down to the bottom edge (measured in script — `panelFlush`), that corner
   sits flush against it and has nothing left to round. */
.panel.flush {
  border-bottom-left-radius: 0;
}

/* Desktop only (see below): a phone's sheet never slides off the side. */
.panel-shade {
  display: none;
}

/* An open audition widens the panel so its testimonies get a comfortable
   measure. In its own min-width query: the mobile block below sets `width:
   auto` at lower specificity, which `.panel.wide` would otherwise beat. */
@media (min-width: 900px) {
  .panel {
    /* Matches the map's padding ease in GeoDrillMap — the two run together, so
       a mismatch reads as the map lagging behind the panel. */
    transition:
      width 0.55s cubic-bezier(0.22, 1, 0.36, 1),
      transform 0.55s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .panel.wide {
    width: 75%;
  }

  /* Out of the way while the user is on the map: slid to the right until only
     the panel's narrow width is left in sight (the rest is clipped by the
     page). A transform — the text keeps its layout, nothing reflows. */
  .panel.folded {
    /* (Never to the left: with a large default font 30rem can exceed 75%.) */
    transform: translateX(max(0px, calc(100% - 30rem)));
  }

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
  .panel,
  .panel-shade {
    transition: none;
  }
}

.panel-head {
  flex-shrink: 0;
  padding: 1rem 1.1rem 0.85rem;
  border-bottom: 1px solid hsl(var(--border) / 0.6);
}

.title-row {
  display: flex;
  align-items: center;
  /* Title left, the head-actions slot (Filtres) hard right. */
  justify-content: space-between;
  gap: 0.75rem;
}

.title-row h1 {
  /* The panel's title, not the page's: panels top out at --text-title. */
  font-size: var(--text-title);
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
  font-size: var(--text-ui);
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
  /* ONE line: no wrap — when room runs out the leading crumbs collapse into
     "…" (measured against scrollWidth, so nothing here may flex-shrink). */
  flex-wrap: nowrap;
  overflow: hidden;
  align-items: center;
  gap: 0.15rem 0.3rem;
  /* On the row, not the crumbs: the "›" between them is the same size. */
  font-size: var(--text-ui);
}

.crumb {
  border: none;
  background: transparent;
  padding: 0.1rem 0.25rem;
  border-radius: 0.3rem;
  color: hsl(var(--muted-foreground));
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
}

/* A single over-long crumb (deep lieu names) caps at the row and ellipsizes. */
.crumb.current {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
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
  flex: none;
}

.level-bar {
  margin-top: 0.7rem;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.level-name {
  font-size: var(--text-body);
  font-weight: 700;
  color: hsl(var(--primary));
}

.level-hint {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.panel-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* The level swap slides sideways: `overflow-y: auto` alone computes
     `overflow-x` to `auto` as well, flashing a scrollbar on every swap. */
  overflow-x: hidden;
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

/* Anchors the outgoing level while it slides out. */
.unit-viewport {
  position: relative;
}

/* Level swap — only the ARRIVING level animates: it slides in from the right
   when drilling deeper (`level-in`) and from the left on the way back up
   (`level-out`). */
.level-in-enter-active,
.level-out-enter-active {
  transition:
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.45s ease;
}

.level-in-enter-from {
  opacity: 0;
  transform: translateX(28px);
}

.level-out-enter-from {
  opacity: 0;
  transform: translateX(-28px);
}

/* The outgoing level is not animated, but it cannot simply be left alone: Vue
   keeps it in the DOM until its transition resolves. Declaring NO transition
   here makes that a single frame — and for that frame it is hidden, out of
   flow so it cannot jump the panel's height, and click-through so a second
   click cannot drill from the level just left. `top: 0` matters: an
   out-of-flow element otherwise falls back to a static position that means
   nothing once its siblings are out of flow too — that was exactly what piled
   the old per-row transitions onto one line. */
.level-in-leave-active,
.level-out-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  opacity: 0;
  pointer-events: none;
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
  font-size: var(--text-body);
  color: hsl(var(--foreground));
}

.unit-count {
  flex-shrink: 0;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-size: var(--text-caption);
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
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* ---- Place detail ---- */
.place-detail {
  display: flex;
  flex-direction: column;
}

.place-title {
  font-size: var(--text-title);
  font-weight: 700;
  color: hsl(var(--primary));
}

.place-meta {
  margin: 0.1rem 0 0.6rem;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

/* No result: the line is the panel's whole message, read like the others. */
.place-empty {
  font-size: var(--text-body);
}

.aud-group + .aud-group {
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.more-results {
  align-self: center;
  margin: 0.6rem 0 0.2rem;
  color: hsl(var(--muted-foreground));
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

/* An h3, but a row title in a dense list: below --text-title Bebas reads too
   small, so the sans at reading size (line-height as the sans h4-h6 — the
   h3's 1.05 would clip its accents and descenders under overflow: hidden). */
.aud-title {
  font-family: var(--font-sans);
  font-size: var(--text-body);
  font-weight: 600;
  letter-spacing: normal;
  line-height: 1.3;
  color: hsl(var(--foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aud-meta {
  margin: 0.05rem 0 0;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

/* One line where the panel changes width (desktop: it widens as an audition
   opens). A meta line that wrapped would re-flow as it does, and move every
   line below it — the one just clicked included — from under the pointer. */
@media (min-width: 900px) {
  .aud-meta {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.aud-count {
  flex-shrink: 0;
  padding: 0.12rem 0.55rem;
  border-radius: 999px;
  font-size: var(--text-caption);
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

/* Where the body will be: the same inset. */
.aud-loading {
  padding-left: 0.9rem;
  padding-right: 0.5rem;
}

.aud-empty {
  padding: 0.4rem 0;
  font-size: var(--text-body);
  color: hsl(var(--muted-foreground));
}

.aud-body :deep(.testimony) {
  padding: 0.7rem 0;
}

.aud-body :deep(.testimony) + :deep(.testimony) {
  border-top: 1px solid hsl(var(--border) / 0.45);
}

/* Bottom-sheet parts: phone only (shown in the media query below). */
.sheet-grip,
.sheet-safe {
  display: none;
}

@media (max-width: 899px) {
  /* A bottom sheet. Its box is the RAISED position; lowered, it is slid down
     until only the grip + title strip is left on screen (`--sheet-lowered` is
     measured in script — the fallback only covers the first frame). */
  .panel {
    top: 4.05rem;
    left: 0.4rem;
    right: 0.4rem;
    bottom: 0;
    width: auto;
    max-height: none;
    border-radius: 0.9rem 0.9rem 0 0;
    transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .panel.sheet-lowered {
    transform: translateY(var(--sheet-lowered, calc(100% - 4.5rem)));
  }

  /* Under the finger the sheet follows 1:1 (inline transform) — no easing. */
  .panel.sheet-dragging {
    transition: none;
  }

  .panel-head {
    padding: 0 0.8rem 0.5rem;
  }

  /* The strip is the handle, so the browser must leave vertical drags on it to
     us instead of scrolling or pulling the page. */
  .sheet-peek {
    touch-action: none;
    cursor: grab;
  }

  .sheet-grip {
    display: flex;
    justify-content: center;
    width: 100%;
    padding: 0.5rem 0 0.45rem;
    border: none;
    background: transparent;
    cursor: inherit;
  }

  .sheet-grip span {
    width: 2.4rem;
    height: 0.25rem;
    border-radius: 999px;
    background: hsl(var(--muted-foreground) / 0.45);
  }

  /* Resolves the home-indicator inset for the script (see measureSheet). */
  .sheet-safe {
    display: block;
    position: absolute;
    height: 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    visibility: hidden;
    pointer-events: none;
  }

  .panel-list {
    padding: 0.5rem 0.6rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  }

  /* The lowered sheet covers the map's bottom edge, which is where mapbox puts
     the zoom buttons, its logo and the attribution — lift them clear of it. */
  .geo-map :deep(.mapboxgl-ctrl-bottom-left),
  .geo-map :deep(.mapboxgl-ctrl-bottom-right) {
    bottom: var(--sheet-peek, 4.5rem);
  }
}

@media (max-width: 899px) and (prefers-reduced-motion: reduce) {
  .panel {
    transition: none;
  }
}
</style>
