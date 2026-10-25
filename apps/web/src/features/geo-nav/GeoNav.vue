<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, ref, shallowRef, toRef, watch } from "vue";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import { headerTilesBottomPx } from "@/shared/dom/header";
import { abbrevCount, ancestorsOf, depCodeOf, type GeoUnit, SPAN_DESCEND } from "@/features/geo";
import { GeoDrillMap, type CameraCmd } from "@/features/map";
import {
  analysisSummary,
  edgeMargin,
  FRAME_MIN_COMPACT,
  FRAME_MIN_WIDE,
  frameFill,
  ScopeAnalysisOverlay,
  slabTextMode,
  slabTextScale,
  useScopeAnalysis,
  type PlateRoom,
  type ScreenOpts,
} from "@/features/analyses";
import TestimonyCard from "@/shared/testimony/TestimonyCard.vue";
import ExpandTransition from "@/shared/ui/transition/ExpandTransition.vue";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import { createNavState, type Insets } from "./navState";
import { useBoundaryQueries } from "./data/useBoundaryQueries";
import { useCommuneGeo } from "./data/useCommuneGeo";
import { useDepFine } from "./data/useDepFine";
import { useGeoHierarchy } from "./model/useGeoHierarchy";
import { useScope } from "./model/useScope";
import { useMapFeed } from "./model/useMapFeed";
import { groupOwnAuditions, resultBounds } from "./model/auditions";
import { usePanelAuditions } from "./model/usePanelAuditions";

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

const desktopQuery = window.matchMedia("(min-width: 900px)");
const isDesktop = ref(desktopQuery.matches);
const onMedia = (e: MediaQueryListEvent) => (isDesktop.value = e.matches);
desktopQuery.addEventListener("change", onMedia);
onBeforeUnmount(() => desktopQuery.removeEventListener("change", onMedia));

// The map's padding is derived from how much of the canvas the panel covers, so
// the viewport size has to be reactive.
const viewportW = ref(window.innerWidth);
const viewportH = ref(window.innerHeight);
const onViewportResize = () => {
  viewportW.value = window.innerWidth;
  viewportH.value = window.innerHeight;
};
window.addEventListener("resize", onViewportResize);
onBeforeUnmount(() => window.removeEventListener("resize", onViewportResize));

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

// ---- The panel's auditions (model/usePanelAuditions): a lieu's own, or the results ----
const panelListEl = ref<HTMLElement | null>(null);
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
  shownCount,
  moreResults,
  showMoreResults,
  moreEl,
  panelAuditions,
  auditionMeta,
  testimoniesOf,
  isAudOpen,
  audSwapping,
  toggleAud,
  audToTop,
  keepAtTop,
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

// The map frames every lieu of the results. Not on each keystroke of a search:
// once the list has stopped changing. And not from under someone reading an
// audition — the map is on its lieu.
const mapCmp = ref<InstanceType<typeof GeoDrillMap> | null>(null);
let fitTimer = 0;
function scheduleResultsFit() {
  window.clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    if (!listMode.value || openAuditions.value.size > 0) return;
    // Not from under a hand on the map (a camera command ends the gesture):
    // it comes back once the map is let go.
    if (mapCmp.value?.inUserHands()) {
      scheduleResultsFit();
      return;
    }
    const bounds = resultBounds(allPlaceUnits.value);
    if (!bounds) return;
    setCamera({
      type: "fit",
      center: [(bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2],
      bounds,
      animate: true,
    });
    // The slabs of the territory raised are sized for where this lands — not
    // for the camera of the moment, mid-flight (another unit raised once it
    // lands is sized then, for the map as it is).
    framedFit.value = { key: nav.cameraKey.value, unitId: currentScope.value.id };
  }, 350);
}
onBeforeUnmount(() => window.clearTimeout(fitTimer));

// ---- Camera ----
const camera = ref<CameraCmd | null>(null);
/** The last command that framed a unit (flyToUnit): the analyses' slabs of
 *  that unit are sized for the camera it lands on (GeoDrillMap's SlabSpec). */
const framedFit = shallowRef<{ key: number; unitId: string } | null>(null);
function setCamera(cmd: Omit<CameraCmd, "key">) {
  nav.scopePinned.value = true; // hold the optimistic scope until the flight lands
  // Every command frames against the analyses' ring as it should be now, so
  // the ring never changes without a camera command in the same tick (see
  // `ringOn`). A flip still waiting for the map to be let go is taken along,
  // and so is the room the plates of the territory now framed need on the
  // screen as it is now (`ringRoom`).
  window.clearTimeout(ringTimer);
  ringTimer = 0;
  ringOn.value = ringWanted.value;
  if (ringOn.value) ringRoom.value = nav.roomNow.value();
  camera.value = { key: ++nav.cameraKey.value, ...cmd };
}
// Closest a unit is framed: just short of the lieu zone (MICRO_ZONE_ENTER, below),
// where the map flattens. The map's own default (14) left the smallest
// arrondissements (Paris 3e) at half the view on a laptop, less on a bigger
// screen — too small to become the scope.
const FIT_MAX_ZOOM = 14.9;
// Right after its fit, a unit's children fill at most this much of the view —
// a wheel notch or so short of DESCEND, where the one under the view's centre
// would become the scope. The fit makes the unit large — FRAME_FILL of its
// rectangle, all of it at DEV's "Cadrage" 100 % — and a big child could reach
// it: Seine-et-Marne, 0.81 of Île-de-France's view on a desktop framed edge to
// edge (about 0.65 at FRAME_FILL), the view's centre in it.
const CHILD_FILL_MAX = SPAN_DESCEND - 0.05;
// A child this close to its unit's whole box, both ways, is the unit itself (a
// département that is one city, Paris): descending into it is the way, it
// caps nothing.
const CHILD_WHOLE = 0.9;

/** The widest and the tallest of a unit's children, degrees (see
 *  CameraCmd.fillCap); undefined: none to keep from filling the view. */
function childSpans(unit: GeoUnit): { lng: number; lat: number } | undefined {
  const uw = unit.bounds.maxLng - unit.bounds.minLng;
  const uh = unit.bounds.maxLat - unit.bounds.minLat;
  let lng = 0;
  let lat = 0;
  for (const c of unit.children) {
    if (c.levelKey === "place") continue;
    const w = c.bounds.maxLng - c.bounds.minLng;
    const h = c.bounds.maxLat - c.bounds.minLat;
    if (w >= CHILD_WHOLE * uw && h >= CHILD_WHOLE * uh) continue;
    lng = Math.max(lng, w);
    lat = Math.max(lat, h);
  }
  return lng > 0 || lat > 0 ? { lng, lat } : undefined;
}

// Fly so a unit becomes the scope: FIT its whole boundary into the visible area, so
// the boundary is always fully on screen (no over-zoom) and the viewport-containment
// scope then resolves to that unit. Not edge to edge: its silhouette fills
// FRAME_FILL of the rectangle (map/lib/slabs; DEV: "Cadrage"), the map around it
// in sight — its own fill still well over the scope's hold (SPAN_ASCEND).
function flyToUnit(unit: GeoUnit, animate: boolean, fresh = false) {
  let bounds = unit.bounds;
  // The map frames the unit's silhouette, raised (its outline, when loaded),
  // centred where the scope read off the view is the unit.
  let shape: CameraCmd["shape"];
  let fillCap: CameraCmd["fillCap"];
  let fill: number | undefined;
  if (unit.levelKey === "world") {
    // The root's bounds equal France's (union of children): fitting them verbatim
    // makes the post-flight derive descend straight back into France (span ~0.8 ≥
    // DESCEND) and needlessly churn its plateau. Inflate so France spans ~0.4 of
    // the view and the world scope actually holds.
    const b = unit.bounds;
    const padLat = (b.maxLat - b.minLat) * 0.6;
    const padLng = (b.maxLng - b.minLng) * 0.6;
    bounds = {
      minLat: b.minLat - padLat,
      maxLat: b.maxLat + padLat,
      minLng: b.minLng - padLng,
      maxLng: b.maxLng + padLng,
    };
  } else {
    // A département rises with its own outline (depFine): ask for it now, the
    // frame takes it if it is already in.
    void ensureDepFine(depCodeOf(unit));
    const geometry = raisedGeometryFor(unit);
    // markRaw: the command lives in a deep ref, and the geometry must never be
    // proxied (see communeGeo's note).
    if (geometry) {
      shape = markRaw({
        id: unit.id,
        geometry,
        lands: (lng: number, lat: number) => centreLandsOn(unit, lat, lng),
      });
    }
    const spans = childSpans(unit);
    if (spans) fillCap = { ...spans, fill: CHILD_FILL_MAX };
    fill = frameFill.value;
  }
  // Out of the lieu zone as the flight starts (spotlightPlace's mirror): a unit
  // is framed above its hysteresis line (MICRO_ZONE_EXIT), and landing there
  // from a lieu would otherwise leave the map flat under its raised scope.
  inMicroZone.value = false;
  setCamera({
    type: "fit",
    center: unit.center,
    bounds,
    shape,
    fillCap,
    fill,
    animate,
    fresh,
    maxZoom: FIT_MAX_ZOOM,
  });
  framedFit.value = { key: nav.cameraKey.value, unitId: unit.id };
}

/**
 * Whether the scope read off a view centred on (lat, lng) is `unit` (the map's
 * fit keeps the view's centre where it is: CameraCmd.shape.lands). Down its
 * chain, the chain preferred (scopeForView), each unit keeps the centre while
 * its outline holds it, or its box does and no rival of its rank claims it —
 * with an outline its own does not share: it lands in the unit, or where no
 * outline is (the sea, a lagoon). A concave unit can have the middle of its
 * box in a neighbour (Meurthe-et-Moselle's is in Moselle, by Metz): framed on
 * that middle, the scope went to the neighbour — which rose instead.
 */
function centreLandsOn(unit: GeoUnit, lat: number, lng: number): boolean {
  const inBox = (u: GeoUnit) =>
    lat >= u.bounds.minLat &&
    lat <= u.bounds.maxLat &&
    lng >= u.bounds.minLng &&
    lng <= u.bounds.maxLng;
  const chain = ancestorsOf(index.value, unit.id);
  for (let i = 1; i < chain.length; i++) {
    const u = chain[i];
    // Held by its outline, even past its box (scopeForView counts it in).
    if (containsPoint(u, lat, lng)) continue;
    if (!inBox(u)) return false;
    for (const rival of chain[i - 1].children) {
      if (rival !== u && containsPoint(rival, lat, lng)) return false;
    }
  }
  return true;
}

// Reading a testimony in a 30rem column is cramped, so an open audition widens
// the panel. Desktop only — below 900px the panel already spans the viewport.
const panelWide = computed(
  () => isDesktop.value && Boolean(selectedPlace.value) && openAuditions.value.size > 0,
);
// Folded: the wide panel is slid aside until only its narrow width is left on
// screen (see `.panel.folded`). Slid, not resized — its text keeps its layout,
// so nothing reflows while the map is being dragged and the reader finds every
// line where they left it.
const panelFolded = computed(() => panelWide.value && mapEngaged.value);

// Whether the panel has grown all the way down to the page's bottom edge, where
// its bottom-left corner squares off (`.panel.flush`). Its height follows the
// content, the viewport and the wide/narrow transition, so it is measured.
const panelEl = ref<HTMLElement | null>(null);
const panelFlush = ref(false);
/** The panel's height, for the shadow that stands beside it (`.panel-shade`). */
const panelHeightPx = ref(0);
let panelRO: ResizeObserver | null = null;
watch(panelEl, (el) => {
  panelRO?.disconnect();
  panelRO = null;
  const page = el?.parentElement;
  if (el && page && typeof ResizeObserver !== "undefined") {
    panelRO = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      const gap = page.getBoundingClientRect().bottom - box.bottom;
      panelFlush.value = gap < 0.5; // half a pixel absorbs layout rounding
      panelHeightPx.value = box.height;
      measureSheet();
    });
    panelRO.observe(el);
    panelRO.observe(page);
    if (sheetPeekEl.value) panelRO.observe(sheetPeekEl.value);
  }
});
onBeforeUnmount(() => panelRO?.disconnect());

// ---- Mobile bottom sheet -------------------------------------------------------
// Below 900px the panel is a sheet. It rests LOWERED at the bottom of the map,
// showing only a grip and its title row, so the map stays usable; dragging that
// strip up raises it to the full panel and dragging it down lowers it again
// (the grip also toggles on tap/keyboard). Desktop ignores all of this: the
// classes it drives only exist inside the mobile media query.
/** Grip + title row — what stays on screen when lowered, and the drag handle. */
const sheetPeekEl = ref<HTMLElement | null>(null);
/** Zero-size probe whose padding resolves `env(safe-area-inset-bottom)`. */
const sheetSafeEl = ref<HTMLElement | null>(null);
/** Height left showing when lowered, home-indicator inset included. */
const sheetPeekPx = ref(72);
/** How far down the lowered sheet sits (its translateY); null until measured. */
const sheetLoweredPx = ref<number | null>(null);
/** Live offset under the finger while dragging, else null. */
const sheetDragPx = ref<number | null>(null);
const sheetLowered = computed(() => !isDesktop.value && !sheetOpen.value);
/** Lowered and at rest: everything under the strip is off screen. */
const sheetHidden = computed(() => sheetLowered.value && sheetDragPx.value === null);
// Breathing room under the title row, so it does not sit on the screen's edge.
const SHEET_PEEK_GAP_PX = 10;
// Finger travel before a press on the strip counts as a drag rather than a tap
// on one of its buttons.
const SHEET_DRAG_SLOP_PX = 6;
// A release faster than this (px/ms) follows the flick, whatever the position.
const SHEET_FLICK = 0.35;

function measureSheet() {
  const panel = panelEl.value;
  const peek = sheetPeekEl.value;
  // Not shown (the map is a card): nothing to measure — a hidden panel's zero
  // height would raise the sheet over the map the moment it appears.
  if (!panel || !peek || !panel.getClientRects().length) return;
  const safe = sheetSafeEl.value
    ? parseFloat(getComputedStyle(sheetSafeEl.value).paddingBottom) || 0
    : 0;
  // Both rects carry the sheet's own translate, so their difference does not.
  const strip = peek.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
  sheetPeekPx.value = Math.round(strip + SHEET_PEEK_GAP_PX + safe);
  sheetLoweredPx.value = Math.max(0, panel.offsetHeight - sheetPeekPx.value);
}

const sheetStyle = computed(() => {
  if (isDesktop.value) return undefined;
  return {
    "--sheet-lowered": sheetLoweredPx.value === null ? undefined : `${sheetLoweredPx.value}px`,
    transform: sheetDragPx.value === null ? undefined : `translateY(${sheetDragPx.value}px)`,
  };
});

let sheetGesture: {
  id: number;
  startY: number;
  from: number;
  dragging: boolean;
  lastY: number;
  lastT: number;
  v: number;
} | null = null;

function onSheetPointerDown(e: PointerEvent) {
  if (isDesktop.value) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  measureSheet(); // the gesture is measured against the sheet as it is right now
  if (sheetLoweredPx.value === null) return;
  sheetGesture = {
    id: e.pointerId,
    startY: e.clientY,
    from: sheetOpen.value ? 0 : sheetLoweredPx.value,
    dragging: false,
    lastY: e.clientY,
    lastT: e.timeStamp,
    v: 0,
  };
}

function onSheetPointerMove(e: PointerEvent) {
  const g = sheetGesture;
  if (!g || e.pointerId !== g.id) return;
  const dy = e.clientY - g.startY;
  if (!g.dragging) {
    if (Math.abs(dy) < SHEET_DRAG_SLOP_PX) return;
    g.dragging = true;
    // Keep receiving the gesture once the finger leaves the strip. (Throws if
    // the pointer has just gone away; the drag then simply ends on its own.)
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(g.id);
    } catch {
      /* not capturable — nothing to do */
    }
  }
  const dt = e.timeStamp - g.lastT;
  if (dt > 0) g.v = (e.clientY - g.lastY) / dt;
  g.lastY = e.clientY;
  g.lastT = e.timeStamp;
  sheetDragPx.value = Math.min(sheetLoweredPx.value ?? 0, Math.max(0, g.from + dy));
}

function onSheetPointerUp(e: PointerEvent) {
  const g = sheetGesture;
  if (!g || e.pointerId !== g.id) return;
  sheetGesture = null;
  if (!g.dragging) return; // a tap: whatever button is under it gets its click
  const at = sheetDragPx.value ?? g.from;
  // A flick decides by its direction; a slow release settles on the nearer rest.
  sheetOpen.value = Math.abs(g.v) > SHEET_FLICK ? g.v < 0 : at < (sheetLoweredPx.value ?? 0) / 2;
  sheetDragPx.value = null;
  // The release of a drag must not also press the button it ended on.
  const strip = e.currentTarget as HTMLElement;
  const swallow = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  strip.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => strip.removeEventListener("click", swallow, true), 0);
}

// Opening a lieu is asking to read it: raise the sheet (on a phone the pin was
// tapped on the map, so the sheet was down). Either way the reader starts on
// the panel.
watch(selectedPlaceId, (id) => {
  mapEngaged.value = false;
  if (id) sheetOpen.value = true;
});
watch(isDesktop, () => (mapEngaged.value = false));
// Back on the map (or the lieu closed): the scope, held still meanwhile,
// catches up with wherever the view is now.
watch(readingPlace, (reading) => {
  if (!reading) deriveScope();
});

// The user has started moving the map (GeoDrillMap's `userGesture`; it repeats,
// hence the cheap exits). With a lieu open, the panel gets out of the way.
function engageMap() {
  nav.hoverReturnHeld.value = false; // the hand is on the map now (see onPanelPointerMove)
  if (!selectedPlaceId.value) return;
  // The tail of the very tap that opened the lieu (a double-tap on its pin
  // also zooms the map) is not a wish to leave the text.
  if (performance.now() - nav.placeOpenedAt.value < 400) return;
  if (isDesktop.value) mapEngaged.value = true;
  // Unless the sheet itself is under a finger: that gesture decides.
  else if (!sheetGesture) sheetOpen.value = false;
}

/** Until when the panel is sliding back into place (see onPanelClick). */
let unfoldingUntil = 0;

// The reader is back on the panel (desktop; a phone raises its sheet by hand).
function returnToPanel() {
  cancelHoverReturn();
  if (!mapEngaged.value) return;
  if (panelFolded.value) unfoldingUntil = performance.now() + 600; // the slide, and a bit
  mapEngaged.value = false;
  // Focus landing on a control of the folded panel's off-screen part can have
  // scrolled the page sideways to show it.
  const page = panelEl.value?.parentElement;
  if (page) page.scrollLeft = 0;
}

// A click on the folded panel only brings it back: with half of it off screen
// — or still sliding in, moving under the pointer — it must not also press
// whatever happens to be there. (The key that brought it back is the same:
// its click arrives right behind it.)
function onPanelClick(e: MouseEvent) {
  if (panelFolded.value || performance.now() < unfoldingUntil) {
    e.stopPropagation();
    e.preventDefault();
  }
  returnToPanel();
}

function onPanelKeydown(e: KeyboardEvent) {
  if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) returnToPanel();
}

// Keyboard focus arriving in the panel (Tab) — not the focus a click gives.
function onPanelFocusIn(e: FocusEvent) {
  if (e.target instanceof Element && e.target.matches(":focus-visible")) returnToPanel();
}

// Resting the pointer on the panel brings it back too. Resting, not crossing:
// a mouse on its way elsewhere, or a map drag that strays over the panel,
// leaves it alone.
const HOVER_RETURN_MS = 200;
let hoverReturnTimer = 0;
function cancelHoverReturn() {
  window.clearTimeout(hoverReturnTimer);
  hoverReturnTimer = 0;
}
function onPanelPointerMove(e: PointerEvent) {
  if (
    nav.hoverReturnHeld.value ||
    !mapEngaged.value ||
    e.pointerType !== "mouse" ||
    e.buttons !== 0
  ) {
    cancelHoverReturn();
    return;
  }
  if (!hoverReturnTimer) hoverReturnTimer = window.setTimeout(returnToPanel, HOVER_RETURN_MS);
}
function onPanelPointerLeave() {
  nav.hoverReturnHeld.value = false;
  cancelHoverReturn();
}
onBeforeUnmount(cancelHoverReturn);

// Panel geometry. MUST stay in sync with `.panel` / `.panel.wide` in this
// file's <style> — the camera padding is what keeps the map clear of the panel,
// and a mismatch parks the content under it.
const PANEL_BASE_PX = 480; // 30rem
const PANEL_WIDE_RATIO = 0.75; // 75%
const PANEL_GAP_PX = 40;

const panelPx = computed(() =>
  panelWide.value ? Math.round(viewportW.value * PANEL_WIDE_RATIO) : PANEL_BASE_PX,
);

const mapPadding = computed(() => {
  // A card: no panel to keep clear of.
  if (props.preview) return { top: 24, bottom: 24, left: 24, right: 24 };
  // Desktop: always the narrow panel's framing — the globe never slides on
  // screen. The wide panel (an audition open) only changes what is in sight
  // (`mapViewPadding`): the map turns to bring the place into the strip left
  // beside it, and folding the panel aside moves nothing at all.
  if (isDesktop.value)
    return { top: 60, bottom: 60, left: 60, right: PANEL_BASE_PX + PANEL_GAP_PX };
  // Phone. Raised over a lieu, the sheet leaves only a strip of map at the top:
  // park the place there, where its pin stays in sight above the text.
  const h = viewportH.value;
  if (selectedPlace.value && sheetOpen.value)
    return { top: 24, bottom: Math.max(0, h - 70), left: 30, right: 30 };
  // Otherwise frame for the LOWERED sheet — the only state in which the map is
  // really on screen. Raising the sheet over a list therefore moves nothing.
  return { top: 30, bottom: sheetPeekPx.value + 20, left: 36, right: 36 };
});

// What is really clear of the panel while it is open wide: less than the
// camera's padding says. Only the logical view follows (scope, pins in sight)
// and the commands aim there (GeoDrillMap's aimOffset) — the camera's padding
// stays. Folded aside, the panel leaves the narrow framing in sight again.
const widePanelView = computed(() =>
  panelWide.value && !panelFolded.value && !props.preview
    ? { top: 60, bottom: 60, left: 60, right: panelPx.value + PANEL_GAP_PX }
    : undefined,
);

// The map's own size (the page it fills), for the ring below and the room the
// analyses' plates have. Until measured, the window stands in for it.
const pageEl = ref<HTMLElement | null>(null);
const pageW = ref(0);
const pageH = ref(0);
// Phones: how far down the header's floating tiles reach over the map — the
// tiles themselves, not the header's box: the padding under them is the map's
// (12 px of it, which the plates' band above the territory need not clear).
const headerClearPx = ref(0);
function measureHeaderClear() {
  const page = pageEl.value;
  const bottom = headerTilesBottomPx();
  if (!page || bottom === null) return;
  headerClearPx.value = Math.max(0, Math.round(bottom - page.getBoundingClientRect().top));
}
let pageRO: ResizeObserver | null = null;
watch(pageEl, (el) => {
  pageRO?.disconnect();
  pageRO = null;
  if (el && typeof ResizeObserver !== "undefined") {
    pageRO = new ResizeObserver(([entry]) => {
      pageW.value = Math.round(entry.contentRect.width);
      pageH.value = Math.round(entry.contentRect.height);
      measureHeaderClear();
    });
    pageRO.observe(el);
  }
});
onBeforeUnmount(() => pageRO?.disconnect());

// ---- The analyses' ring ------------------------------------------------------
// The analyses are slabs of the raised territory (the themes over the middle
// of its top edge, the plaque under the middle of its bottom edge: GeoDrillMap
// draws them, ScopeAnalysisOverlay lays their words on them), so while they
// are on, the territory is framed with room around it for them: a band above
// it (the themes), one below it (the plaque). Right after a camera command
// both stand on screen; moved by the user, the map takes them along — they
// are pieces of it. Not by zooming out — the unit would then
// measure right on the scope's ascend threshold and pop to its parent at a
// nudge — and not by changing the camera's padding, which would slide the
// globe: the ring narrows the LOGICAL view instead (on a phone, widens it
// beside the territory: PHONE_SIDE; above it, it keeps the slabs' margin, not
// the camera's padding: withRing), like the wide panel does.
// The fit sizes the unit to the inner rectangle and aims at its centre, the
// scope is read off that rectangle (the framed unit still fills it as usual),
// and free navigation keeps the same thresholds.
//
// How wide each band is depends on what the slabs hold: their content boxes
// say it (slabSizes, plateRoom). Read for the territory being framed at each
// camera command, and kept until the next one (`ringRoom`): the slabs' text
// changing under a still camera (a filter, the data reloading) must not move
// the ring. The bands come from CSS px alone; the fit then gives a zoom, and
// that zoom the slabs' size on the map — nothing goes round in a circle.
//
// The ring changes what the scope is measured against, so it may only change
// TOGETHER with a fit of the scope in the same tick: alone, turning it on
// would descend into the biggest child and turning it off would climb to the
// parent. `ringOn` is the ring applied; setCamera brings it in line with
// `ringWanted` on every command.
//
// It stays on at the world level too: dropping it there would take a fit at
// every crossing of the country's threshold, so the camera would move by
// itself whenever the user zoomed out of France or back in.
//
// On a desktop it stays on with a lieu open as well. The slabs stand beside
// the panel there, and the map turned back to the territory around the lieu
// (turning the analyses on from it, or a click on the map) must leave them
// room — framed edge to edge, the slabs would stand off the map. Opening or
// closing a lieu then changes nothing about the ring. A phone's sheet, raised
// over a lieu, leaves only a strip of map above it: no ring there. Lowered
// again (the analyses turned on from the lieu lower it), the map is the
// phone's whole screen once more, slabs included: the ring is back.
const ringWanted = computed(
  () =>
    analyses.value &&
    !props.preview &&
    (isDesktop.value || !selectedPlaceId.value || !sheetOpen.value),
);
const ringOn = ref(false);
let ringTimer = 0;
onBeforeUnmount(() => window.clearTimeout(ringTimer));

// Until a territory's own slabs are known: slabs of a usual size (a
// département's — the Rhône's plateRoom, 1440 × 900 / 375 × 812, offline, at
// TEXT_SCALE, its ring twice its label's height (RING_OVER_LABEL; its band
// takes no room): the themes above; the plaque below, on a phone over
// mapbox's logo's strip; nothing beside).
const ROOM_WIDE: PlateRoom = { top: 114, bottom: 87, left: 0, right: 0 };
const ROOM_COMPACT: PlateRoom = { top: 104, bottom: 107, left: 0, right: 0 };

// A phone's frame keeps only the slabs' own margin from the screen's sides
// while the analyses are on, where the camera's padding keeps 36: the slabs
// stand above and below the territory, never beside it, so the width is all
// the territory's (mapbox's fit leaves France some 20 px more either side).
const PHONE_SIDE = edgeMargin(true);

/** The room the slabs of the territory in scope need (null: none raised). */
const ringRoom = shallowRef<PlateRoom | null>(null);

let rootRemPx = 0;
function rootRem(): number {
  if (!rootRemPx) {
    rootRemPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }
  return rootRemPx;
}

// The safe rect: the map clear of the panel — on a phone, below the header's
// floating tiles and above the lowered sheet. Right after a camera command
// the slabs stand inside it, their own margin from its edges, clear of
// mapbox's logo (analyses/content/plateRoom): the ring leaves them room.
const overlayInsets = computed<Insets>(() => {
  if (isDesktop.value) {
    return {
      top: 0,
      right: widePanelView.value ? panelPx.value : PANEL_BASE_PX,
      bottom: 0,
      left: 0,
    };
  }
  return { top: headerClearPx.value, right: 0, bottom: sheetPeekPx.value, left: 0 };
});

/** The screen the slabs stand on: the safe rect's width, the type scale's. */
const plateScreen = computed<ScreenOpts>(() => {
  const safe = overlayInsets.value;
  return {
    compact: !isDesktop.value,
    safeW: Math.max(0, (pageW.value || viewportW.value) - safe.left - safe.right),
    vw: viewportW.value,
    rem: rootRem(),
  };
});

// A new width (the window resized, the phone turned — a desktop's slabs are
// not a phone's) reshapes the rectangle the scope is read from anyway: there
// the room kept is measured afresh, both bands, for the slabs now standing
// (the map frames the last command again at a resize until it is moved).
// Between commands otherwise it stays as framed: a ring that only appears
// under a still camera (filters giving a unit enough testimonies) stands
// above the box with no band of its own until the next command — a band
// grown under a still camera would shrink the rectangle the scope is read
// from, and the scope could descend. Not while the map is a card: its size
// is the card's.
let bandW = NaN;
watch([plateScreen, () => props.preview], ([screen, preview]) => {
  if (preview || screen.safeW === bandW) return;
  bandW = screen.safeW;
  if (ringRoom.value) ringRoom.value = nav.roomNow.value() ?? ringRoom.value;
});

/** Two opposite insets brought within `room`: first what the ring adds to its
 *  floor (the camera's padding; PHONE_SIDE beside a phone's territory; `head`
 *  above it) gives way, then (too little map even for that) both, in
 *  proportion. The slabs, pieces of the map, then reach past the safe rect's
 *  edges (under the header's tiles, the sheet). */
function giveWay(a: number, b: number, padA: number, padB: number, room: number) {
  if (a + b <= room) return [a, b];
  const extra = Math.max(0, a - padA) + Math.max(0, b - padB);
  const over = a + b - room;
  if (extra > 0) {
    const k = Math.max(0, 1 - over / extra);
    a = Math.min(a, padA + Math.max(0, a - padA) * k);
    b = Math.min(b, padB + Math.max(0, b - padB) * k);
  }
  if (a + b > room) {
    const k = room / (a + b);
    a *= k;
    b *= k;
  }
  return [a, b];
}

/** The rectangle the territory is framed in while the analyses are on: the
 *  safe rect less the room its plates need on each side, and the camera's
 *  padding (`p`) at least — beside the territory on a phone, PHONE_SIDE
 *  instead; above it, the slabs' own margin (see `head`). */
function withRing(p: Insets): Insets {
  const w = pageW.value || viewportW.value;
  const h = pageH.value || viewportH.value;
  const safe = overlayInsets.value;
  const wide = isDesktop.value;
  const room = ringRoom.value ?? (wide ? ROOM_WIDE : ROOM_COMPACT);
  // The least rectangle the territory is framed in (see FRAME_MIN_WIDE).
  const min = wide ? FRAME_MIN_WIDE : FRAME_MIN_COMPACT;
  const sideL = wide ? p.left : safe.left + PHONE_SIDE;
  const sideR = wide ? p.right : safe.right + PHONE_SIDE;
  const [left, right] = giveWay(
    Math.max(sideL, safe.left + room.left),
    Math.max(sideR, safe.right + room.right),
    sideL,
    sideR,
    Math.max(0, w - min.w),
  );
  // The territory heads a group the plaque closes, at the slabs' margin from
  // the safe rect's bottom edge (on a phone, over mapbox's logo, its strip's:
  // the group stands that much higher). The group's head — the themes, else
  // the territory itself — keeps the same margin from the top edge rather
  // than the camera's padding (48 px lower on a desktop): the group centred.
  const head = safe.top + edgeMargin(!wide);
  const [top, bottom] = giveWay(
    Math.max(head, safe.top + room.top),
    Math.max(p.bottom, safe.bottom + room.bottom),
    head,
    p.bottom,
    Math.max(0, h - min.h),
  );
  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    left: Math.round(left),
    right: Math.round(right),
  };
}

const mapViewPadding = computed<Insets | undefined>(
  () =>
    widePanelView.value ??
    (ringOn.value && !props.preview ? withRing(mapPadding.value) : undefined),
);

/** Brings the ring in line with the analyses, with the fit that must go with it. */
function applyRing() {
  window.clearTimeout(ringTimer);
  ringTimer = 0;
  if (ringOn.value === ringWanted.value) return;
  // Deep in the lieu zone nothing is raised or framed: the ring just follows,
  // and so does the scope, at the user's next move. So it does under a phone's
  // sheet raised over a lieu: the scope holds still while the lieu is read
  // (deriveScope), and the sheet lowered again brings the ring back with a fit.
  if (inMicroZone.value || (!isDesktop.value && readingPlace())) {
    ringOn.value = ringWanted.value;
    return;
  }
  // The results are what the map frames while filters are on: framed again,
  // inside the ring now (that fit waits for the map to be let go itself).
  if (listMode.value) {
    scheduleResultsFit();
    return;
  }
  // Not from under a hand on the map (a camera command ends the gesture): it
  // comes once the map is let go.
  if (mapCmp.value?.inUserHands()) {
    ringTimer = window.setTimeout(applyRing, 250);
    return;
  }
  flyToUnit(currentScope.value, true); // setCamera flips the ring with it
}
// The analyses toggled need the fit here — and on a phone, a lieu closed with
// no flight of its own (opening one turns the ring off and frames the lieu in
// the same tick: setCamera has settled it then), or the sheet lowered over a
// lieu (raised, it only drops the ring: see applyRing). The card becoming the page
// (or a card again) is framed anew by the preview watch below, ring included.
watch([ringWanted, () => props.preview], ([, preview], [, was]) => {
  if (preview !== was) return;
  applyRing();
});

// ---- Actions (pins, rows, breadcrumb all fly the map; the scope follows) ----
function activate(unit: GeoUnit) {
  if (unit.levelKey === "place") {
    openPlace(unit);
    return;
  }
  selectedPlaceId.value = null;
  // Optimistic scope: don't wait for the camera fit to settle (~700 ms) — set the
  // scope now so the plateau transition runs DURING the flight. The moveend
  // derivation confirms it (hysteresis holds the same unit).
  currentScope.value = unit;
  flyToUnit(unit, true);
}

// A click on the MAP: a pin, or anywhere inside a unit's boundary.
function onUnitClick(id: string) {
  const u = index.value.get(id);
  if (!u) return;
  // With a lieu open only another lieu's dot replaces what the panel shows. A
  // territory is the whole of its surface — clicking it is moving around the
  // map, like a drag: the map goes there, the text stays.
  if (selectedPlaceId.value && u.levelKey !== "place") {
    engageMap();
    currentScope.value = u; // optimistic — see activate()
    flyToUnit(u, true);
    return;
  }
  activate(u);
}

function drillToCrumb(id: string) {
  const u = index.value.get(id);
  if (!u) return;
  // The LAST crumb can be the open lieu itself — a place can never become the
  // scope; re-centre its spotlight instead (useful after panning away).
  if (u.levelKey === "place") {
    openPlace(u);
    return;
  }
  selectedPlaceId.value = null;
  currentScope.value = u; // optimistic — see activate()
  flyToUnit(u, true);
}

// The results are listed and a lieu's dot is clicked on the map: that is asking
// for its audition — the first of the list held there.
async function openResultAt(unit: GeoUnit) {
  hoveredPanelId.value = null;
  // The dot of the lieu whose audition is being read: only bring the map (and
  // the panel) back — whichever of its auditions is open stays unfolded.
  if (selectedPlaceId.value === unit.id && openAuditions.value.size > 0) {
    sheetOpen.value = true;
    mapEngaged.value = false;
    spotlightPlace(unit);
    return;
  }
  const at = resultAuditions.value.findIndex((a) => a.canonical === unit.canonical);
  if (at === -1) return;
  const audition = resultAuditions.value[at];
  if (at >= shownCount.value) shownCount.value = at + 1; // its line may not be listed yet
  sheetOpen.value = true;
  await nextTick();
  await toggleAud(audition.id);
  // Its line goes to the top of the list, the text opening in view beneath it,
  // and stays there while that text unfolds.
  audToTop(audition.id);
  keepAtTop(audition);
}

function openPlace(unit: GeoUnit) {
  if (listMode.value) {
    void openResultAt(unit);
    return;
  }
  // Re-opening the lieu already open (its crumb, its own dot on the map) only
  // brings the map back to it: the audition being read stays unfolded.
  if (selectedPlaceId.value !== unit.id) openAuditions.value.clear();
  selectedPlaceId.value = unit.id;
  // The reader is on the panel — said here too, because the watcher that says
  // it does not run when the lieu was already the open one.
  mapEngaged.value = false;
  sheetOpen.value = true;
  nav.placeOpenedAt.value = performance.now();
  // The row just clicked leaves the panel without a mouseleave; left set, the
  // map would keep deferring to a hover that no longer exists.
  hoveredPanelId.value = null;
  spotlightPlace(unit);
}

/** Flies the map onto a lieu (the framing its testimonies are read in) —
 *  along an arc when asked, for a hop from another lieu. */
function spotlightPlace(unit: GeoUnit, arc = false) {
  // Optimistic, like the scope in activate(): the plateau sinks as the dive
  // starts, not once it has landed. The landing view confirms it.
  inMicroZone.value = true;
  setCamera({ type: "spotlight", center: unit.center, animate: true, arc });
}

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

// DEV: the words drawn long or flat, or at another size, take another room,
// and another framing frames otherwise: framed again, the ring with it
// (setCamera reads it afresh), the slabs sized for the new fit.
watch([slabTextMode, slabTextScale, frameFill], () => {
  if (!ringOn.value || props.preview) return;
  if (listMode.value) scheduleResultsFit();
  else if (!inMicroZone.value) flyToUnit(currentScope.value, true);
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

// ---- The focus around the plates ----------------------------------------------
// The plates come before the panel in the page, and a key pressed in the panel
// brings a folded panel back (onPanelKeydown) — which hides the plates before
// the focus could reach them. So the focus is taken to them: once the plaque is
// on screen, onto its title (the overlay's focusPlaque). It waits for the
// territory to rise, and gives up after a while, or as soon as the reader has
// gone somewhere of their own.
const overlayCmp = ref<InstanceType<typeof ScopeAnalysisOverlay> | null>(null);
const PLAQUE_FOCUS_POLL_MS = 120;
const PLAQUE_FOCUS_WAIT_MS = 4000;
let plaqueFocus: {
  /** Where the focus was when it was asked for: it may still be there. */
  from: Element | null;
  /** The plaque of this territory, or of whichever is raised (null). */
  scopeId: string | null;
  until: number;
} | null = null;
let plaqueFocusTimer = 0;
onBeforeUnmount(() => window.clearTimeout(plaqueFocusTimer));

function focusPlaqueWhenShown(from: Element | null, scopeId: string | null = null) {
  window.clearTimeout(plaqueFocusTimer);
  plaqueFocus = { from, scopeId, until: performance.now() + PLAQUE_FOCUS_WAIT_MS };
  // Not at once: the overlay has yet to mount, or the plates of the territory
  // being left have yet to hide.
  plaqueFocusTimer = window.setTimeout(tryFocusPlaque, PLAQUE_FOCUS_POLL_MS);
}

function dropPlaqueFocus() {
  window.clearTimeout(plaqueFocusTimer);
  plaqueFocusTimer = 0;
  plaqueFocus = null;
}

function tryFocusPlaque() {
  plaqueFocusTimer = 0;
  const want = plaqueFocus;
  // The focus has moved on: onto the plaque at the last try, and still on the
  // plates since, it held — anywhere else, the reader has gone somewhere of
  // their own. (Fallen back on the page, it is still owed: the plaque hid
  // again before it was really shown.)
  const active = document.activeElement;
  const movedOn = active && active !== document.body && active !== want?.from;
  if (!want || !analyses.value || movedOn || performance.now() > want.until) {
    dropPlaqueFocus();
    return;
  }
  const a = scopeAnalysis.value;
  // A hidden plate is inert: the focus only lands on the plaque on screen.
  if (analysesVisible.value && a && (!want.scopeId || a.scopeId === want.scopeId)) {
    overlayCmp.value?.focusPlaque();
  }
  plaqueFocusTimer = window.setTimeout(tryFocusPlaque, PLAQUE_FOCUS_POLL_MS);
}

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
