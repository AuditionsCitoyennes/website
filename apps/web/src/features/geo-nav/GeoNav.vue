<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  markRaw,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  toRef,
  watch,
} from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { ancestorsOf, placeLabel, prefetchKind } from "@/features/geo";
import { GeoDrillMap, type MapGestureSource } from "@/features/map";
import { perfBegin, perfEnd } from "@/shared/perf/perf";
import { deviceSignals, deviceTier } from "@/shared/device/deviceTier";
import { prefersReducedMotion } from "@/shared/device/motion";
import {
  analysisSummary,
  buildFactsIndex,
  loadScopeAnalysisOverlay,
  noScopeAnalysis,
  useScopeAnalysis,
} from "@/features/analyses";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import MapCurtain from "@/shared/ui/MapCurtain.vue";
import CurtainPoster from "@/shared/ui/CurtainPoster.vue";
import GeoPanel from "./panel/GeoPanel.vue";
import UnitList from "./panel/UnitList.vue";
import AuditionList from "./panel/AuditionList.vue";
import SlowWaitNotice from "./panel/SlowWaitNotice.vue";
import { slowWaitPlace } from "./model/retryNotice";
import { createNavState, type Insets, type MapView } from "./navState";
import { bootCurtainCover } from "./bootListSwitch";
import { CURTAIN_FADE_BELT_MS, HOLD_FADE_MS, panelHeldAtBoot } from "./panelBoot";
import { useOutlineFiles } from "./data/useOutlineFiles";
import { boundaryAttribution } from "./data/attribution";
import { hoverPrefetch } from "./data/hoverPrefetch";
import { idlePrefetch, pickPrefetch, prefetchAllowed, prefetchUnits } from "./data/idlePrefetch";
import { liftCheck } from "./model/outlineCheck";
import { useGeoHierarchy } from "./model/useGeoHierarchy";
import { useScope } from "./model/useScope";
import { useMapFeed } from "./model/useMapFeed";
import { usePanelAuditions } from "./model/usePanelAuditions";
import { useCamera } from "./model/useCamera";
import { useNavActions } from "./model/useNavActions";
import { createLieuFollow } from "./model/lieuFollow";
import { useTapPending } from "./model/useTapPending";
import type { SettleHow } from "./model/tapPendingCore";
import { useViewport } from "./panel/useViewport";
import { useBottomSheet } from "./panel/useBottomSheet";
import {
  lieuAimPx,
  TEXT_WAIT_CAP_MS,
  TEXT_WAIT_DOTS_MS,
  textWait,
  type PlateauBox,
} from "./panel/sheetFit";
import { useSheetBand } from "./panel/useSheetBand";
import { sheetLateMode } from "./panel/sheetLateSwitch";
import { testimoniesOf } from "./model/auditions";
import { PANEL_BASE_PX, PHONE_SIDE_PX, usePanelLayout } from "./panel/usePanelLayout";
import { useAnalysesRing } from "./ring/useAnalysesRing";
import { usePlaqueFocus } from "./ring/usePlaqueFocus";
import type { UnitTree } from "./data/useUnitTree";
import { useServerLists } from "./data/useServerLists";
import { usePanelRecovery } from "./data/usePanelRecovery";

const props = defineProps<{
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
  /** The filters' dialog stands over the page: the map behind it does not
   *  frame again for what it changes in the sheet (panel/useSheetBand). */
  filtersOpen?: boolean;
  /**
   * The server's tree (map phase 1): the map, the panel's units, their counts
   * and the analyses come from it, and the auditions' lists from the server's
   * lists beside it (PR K). Set once: it does not change under a mounted page.
   */
  unitTree: UnitTree;
}>();

/** The server's tree (fixed for this instance). */
const unitTree = props.unitTree;

/** The analyses of the raised territory, drawn on the map around it. The page
 *  owns the toggle; the plates' own close button turns it off from here. */
const analyses = defineModel<boolean>("analyses", { default: false });

// ---- Data: the static outline files (data/useOutlineFiles) ----
// The server's tree's unit ids are the files'. A session that falls back — at
// boot (root.json, k/FR), or on a release skew of any later file — is known
// absent from then on (model/outlineRules). A boot past the loader's 6 s cap
// goes on without the curtain (`ready` "late"): the plateau rises when its
// files land.
const outlines = useOutlineFiles();
void outlines.ensureRoot();
// The boundaries' credits (data/attribution), after the data actually drawn:
// the files' only once their session is "ok". « Pays » once a country's file
// is in (a g/, or a u/ other than France's units': the tree holds a country).
const attribution = computed(() =>
  boundaryAttribution({
    session: outlines.ready.value,
    countries: outlines.loadedKeys().some((k) => /^(g\/|u\/(?!fr_))/.test(k)),
  }),
);

// ---- One hierarchy, both nav models read from it (model/useGeoHierarchy) ----
const geo = useGeoHierarchy({ unitTree, outlines });
const { root, index, raisedGeometryFor, containsPoint } = geo;

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

// ---- An open lieu and the map ----
// The visitor's own gesture that really moves the map closes the open lieu,
// and the panel follows the map live (model/lieuFollow, wired below). With
// filters on, the open audition belongs to the results' list, which does not
// follow the map: it stays open, the wide panel folding aside while the map
// is used.
const follows = () => !listMode.value;

// ---- The viewport (panel/useViewport): a desktop or a phone, the window's size ----
const asCard = toRef(props, "preview");
const { isDesktop, viewportW, viewportH } = useViewport();

// ---- Scope (model/useScope): read off the view, held still while a lieu is read ----
const scope = useScope({
  nav,
  root,
  index,
  containsPoint,
  outlined: (u) => !!raisedGeometryFor(u),
  isDesktop,
  // The layout a view must have been measured in: the ring's view padding or
  // the wide panel's when there is one, else the camera's — both set up below.
  mapInsets: () => mapViewPadding.value ?? mapPadding.value,
});
const { readingPlace, deriveScope, onViewChange, selectedPlace, breadcrumb, panelUnits } = scope;

// ---- Boot overlay ------------------------------------------------------------
// A cold load shows an unstyled map, tiles popping in, and an empty panel before
// anything is presentable. Cover the map (and the panel too on the home page's
// card: `bootCover` below; on the page the panel is held out of sight
// meanwhile: `panelHeld`), and lift once the pieces the FIRST view needs are
// in: the basemap painted (GeoDrillMap's `ready`), the
// testimonies, and the outline files that view is drawn from — their boot
// (root.json, k/FR: the country and its régions). Départements and communes
// come on demand when drilling, so waiting on them here would just hold the
// screen longer. A session that falls back there waits for nothing more, nor
// does one past the loader's 6 s cap (`ready` "late": its files are drawn
// when they land).
const mapPresentable = ref(false);
/** The map's box shows its fallback (GeoDrillMap's `fallback`: the map could
 *  not start, or its style could not be had): the panel is held out of sight
 *  meanwhile (panelBoot), and nothing covers the map's box. */
const mapFailed = ref(false);
const booting = ref(true);
// On the page, a map that failed waits for nothing else: the panel those
// reads were for does not show, so the fallback shows as soon as the failure
// is known. The home page's card waits as for a map that came (its curtain
// covers the card whole).
watch(
  () =>
    !mapPresentable.value ||
    ((props.preview || !mapFailed.value) && (props.loading || outlines.ready.value === "loading")),
  (busy) => {
    if (busy) return;
    // A failure told in this same tick: the curtain first renders once more
    // with its France told to the middle (MapCurtain `centred`: it glides
    // there), since a leaving element keeps the props it had; then it fades
    // onto the fallback's once the glide is over (`.boot-failed`).
    if (mapFailed.value && !props.preview) void nextTick(() => (booting.value = false));
    else booting.value = false;
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
// What the curtain covers: the map's box alone, the panel over it
// (bootListSwitch), or the whole card on the home page.
const bootCover = computed(() => bootCurtainCover(props.preview));
// Under that curtain the panel is held out of sight (panelBoot), so that
// only the loading placeholder
// shows, and comes in as the curtain's fade starts: the same latch, so
// whatever lifts the curtain (the map ready, the outlines late, the
// testimonies failing, the cap) shows the panel. Except the map's fallback
// (`mapFailed`): the panel stays out of sight while it shows, and comes in
// the same way if a « Réessayer » brings the map. Held, it keeps its box:
// the sheet's measures and the camera's padding run as once it shows
// (GeoPanel `held`).
//
// Told to leave, the curtain only starts fading two frames later (Vue's
// leave-to), and a heavy first map frame can stretch that to a second or more:
// the panel waits for the fade itself (`awaitingFade`), so the two cross
// rather than the panel arriving over an opaque curtain. The wait ends on the
// fade's start (`transitionrun`), on the leave's end (Vue's own timer, should
// the fade go unseen), or on a belt (CURTAIN_FADE_BELT_MS); never set when the
// curtain was not on screen (a warm map), so that panel shows at once.
const bootEl = ref<HTMLElement | null>(null);
/** The boot curtain has had a frame on screen. */
let bootShown = false;
watch(
  bootEl,
  (el) => {
    if (el && !bootShown) requestAnimationFrame(() => (bootShown = true));
  },
  { flush: "post" },
);
/** The map's failure came while the curtain was on screen: its France and
 *  its words glide to the middle of the box (MapCurtain `centred`) before
 *  it fades (`.boot-failed`). One told before its first frame (no WebGL)
 *  finds them there already: the curtain fades at once. */
const failedInSight = ref(false);
const awaitingFade = ref(false);
let fadeBelt = 0;
function endFadeWait() {
  awaitingFade.value = false;
  clearTimeout(fadeBelt);
}
watch(
  booting,
  (now, was) => {
    if (now || !was || !bootEl.value) return;
    awaitingFade.value = true;
    fadeBelt = window.setTimeout(endFadeWait, CURTAIN_FADE_BELT_MS);
  },
  // Sync: set in the same tick as `booting`, so no render sees the curtain
  // gone and the wait not started (the panel would flash in for a frame).
  { flush: "sync" },
);
onBeforeUnmount(() => clearTimeout(fadeBelt));
/** The leaving curtain (the boot Transition's `leave`): the wait ends as its
 *  own opacity transition runs. One parameter: Vue still runs the CSS leave. */
function onCurtainLeave(el: Element) {
  el.addEventListener("transitionrun", (e) => {
    const t = e as TransitionEvent;
    if (t.target === el && t.propertyName === "opacity") endFadeWait();
  });
}
const panelHeld = computed(() =>
  panelHeldAtBoot({
    booting: booting.value,
    awaitingFade: awaitingFade.value,
    mapFailed: mapFailed.value,
    preview: !!props.preview,
  }),
);
/** France under the curtain's spinner (shared/ui/MapCurtain.vue): with the
 *  map's code, so that the curtain has it from its first render, where
 *  MapStage's StageLoading drew it just before. */
const curtainPoster = markRaw(CurtainPoster);

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

// Under the files, a row held under the pointer asks for its unit's bundle
// before the click (data/hoverPrefetch; a région's self is in it), or a
// country's u/: the file its row declares its self in (geo's prefetchKind).
// Not on a touch screen (a tap's focus can hover the row it opens) nor under Save-Data.
// The map's own hover is not emitted: a pin gets none.
/** The files a tap on unit `id` will ask, asked ahead (the HTTP cache only). */
function prefetchUnit(id: string): Promise<void> {
  const kind = prefetchKind(outlines.rowOf(id));
  if (!kind) return Promise.resolve();
  // A self the click will ask ahead of its bundle: the
  // same two files, in the same order.
  if (kind === "k" && outlines.selfAhead(id))
    return outlines.prefetch("u", id).then(() => outlines.prefetch("k", id));
  return outlines.prefetch(kind, id);
}
const rowHover = hoverPrefetch({
  prefetch: prefetchUnit,
  allowed: () =>
    outlines.mode.value === "fichiers" &&
    window.matchMedia("(hover: hover)").matches &&
    !(navigator as { connection?: { saveData?: boolean } }).connection?.saveData,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (timer) => window.clearTimeout(timer as number),
});
watch(hoveredPanelId, (id) => rowHover.hover(id));
onBeforeUnmount(rowHover.stop);

// ---- Filtered: every matching audition in ONE list ---------------------------
// With filters on, what the reader wants is the answer to them — not a drill
// through territories to find where the answers are. So the panel lists every
// audition that matches, the map frames the country the visitor is in (the
// world: it stays put), and opening one flies the map to its lieu (see
// toggleAud).
const listMode = computed(() => Boolean(props.filtered));

// ---- The server's lists (data/useServerLists, map phase 1): the results, the
// open lieu's auditions, the open audition's testimonies ----
const lists = useServerLists({
  queryClient: useQueryClient(),
  tree: unitTree,
  sort: toRef(props, "sort"),
  listMode,
  nav,
  selectedPlace,
});

// ---- The panel's parts (panel/GeoPanel, AuditionList): what the composables measure ----
const panelCmp = ref<InstanceType<typeof GeoPanel> | null>(null);
const auditionsCmp = ref<InstanceType<typeof AuditionList> | null>(null);
/** The panel (`.panel`), its strip, its safe-area probe, its list's scroller
 *  and the results' sentinel — exposed by the components, read as refs. */
const panelEl = computed(() => panelCmp.value?.el ?? null);
const sheetPeekEl = computed(() => panelCmp.value?.peekEl ?? null);
const sheetSafeEl = computed(() => panelCmp.value?.safeEl ?? null);
const panelListEl = computed(() => panelCmp.value?.listEl ?? null);
const panelBodyEl = computed(() => panelCmp.value?.bodyEl ?? null);
const moreEl = computed(() => auditionsCmp.value?.moreEl ?? null);
const moreTestimoniesEl = computed(() => auditionsCmp.value?.moreTestimoniesEl ?? null);

// ---- The camera (model/useCamera): what GeoDrillMap is told to frame ----
const mapCmp = ref<InstanceType<typeof GeoDrillMap> | null>(null);
/** The map's fallback shows or goes (GeoDrillMap's `fallback`, told before
 *  the render that would show the panel over it). A focus inside the panel,
 *  which goes out of sight (inert), moves to the fallback's « Réessayer »,
 *  the one control left, rather than to the page's body; one in the
 *  fallback, which fades out (a « Réessayer » that brought the map), moves
 *  to the panel coming back, on its trail's current crumb, without
 *  scrolling anything. */
function onMapFallback(shown: boolean) {
  const focusIn = shown && !mapFailed.value && !!panelEl.value?.contains(document.activeElement);
  const focusBack = !shown && mapFailed.value && !!mapCmp.value?.fallbackHasFocus();
  // On screen until now (the map failing after the page was up): the panel
  // fades out over the fallback (the card's own `panel-arrive` leave), out of
  // reach at once (inert); at once under reduced motion.
  const fadeOut = shown && !mapFailed.value && !panelHeld.value && !props.preview;
  if (shown && booting.value && bootShown) failedInSight.value = true;
  mapFailed.value = shown;
  if (focusIn) void nextTick(() => mapCmp.value?.focusFallback());
  if (fadeOut && !prefersReducedMotion())
    void nextTick(() => {
      const p = panelEl.value;
      if (panelHeld.value && typeof p?.animate === "function")
        p.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HOLD_FADE_MS, easing: "ease" });
    });
  if (focusBack)
    void nextTick(() => {
      if (panelHeld.value) return;
      const p = panelEl.value;
      const to =
        p?.querySelector<HTMLElement>(".crumb.current") ??
        p?.querySelector<HTMLElement>("nav.crumbs");
      to?.focus({ preventScroll: true });
    });
}
/** The unit a tap left pending, "" when none (model/useTapPending, made
 *  further down: read when a unit is selected, never before). */
let tappedUnit: () => string = () => "";
const cam = useCamera({
  nav,
  index,
  raisedGeometryFor,
  containsPoint,
  outlines,
  mapCmp,
  listMode,
  // A tapped unit's plateau waits for its children's boundaries.
  tapped: (id) => tappedUnit() === id,
});
const { camera, framedFit, flyToUnit, spotlightPlace, scheduleFilterFrame, handMoved } = cam;

// ---- The panel's auditions (model/usePanelAuditions): a lieu's own, or the results ----
const panel = usePanelAuditions({
  nav,
  sort: toRef(props, "sort"),
  listMode,
  selectedPlace,
  index,
  panelListEl,
  moreEl,
  spotlightPlace,
  scheduleFilterFrame,
  moreTestimoniesEl,
  server: lists,
});
const {
  resultCount,
  moreResults,
  showMoreResults,
  showMoreTestimonies,
  placeLoading,
  placeFailed,
  panelAuditions,
  auditionMeta,
  audSwapping,
  toggleAud,
} = panel;

// ---- What the map is handed (model/useMapFeed): outline, pending hold, pins ----
const { outline, scopePending, outlineReady, mapUnits } = useMapFeed({
  nav,
  geo,
  panelUnits,
  selectedPlace,
  outlines,
  booting,
  // The share of a selected unit's outline file that has arrived: a real
  // step of the tapped unit's loading line on the map.
  onOutlineProgress: (id, share) => mapCmp.value?.pendingStep(id, { t: "outline", frac: share }),
  // A tapped unit waits for its own outline file.
  tapped: (id) => tappedUnit() === id,
});

/** The page the map fills (`.geo-page`), GeoNav's own element. */
const pageEl = ref<HTMLElement | null>(null);

// ---- The phone's sheet (panel/useBottomSheet), the panel's layout (panel/usePanelLayout) ----
// A raised sheet as tall as its content, held while what it
// shows loads and full while an open audition's text is on its way
// (`sheetFitHold`, `sheetExpectFull`, made further down: read at a measure,
// never before the page is set up).
const sheet = useBottomSheet({
  nav,
  isDesktop,
  panelEl,
  peekEl: sheetPeekEl,
  safeEl: sheetSafeEl,
  listEl: panelListEl,
  bodyEl: panelBodyEl,
  hold: () => sheetFitHold.value,
  expectFull: () => sheetExpectFull.value,
  waitText: () => sheetWaitText.value,
  waitGrows: () => pinWaitDots.value,
  mapControlsPx: () => mapControlsPx(),
});
/** The taller of mapbox's two bottom corners (the zoom buttons over its logo
 *  at the left, the credit at the right), which go up above a fitted sheet
 *  (`--sheet-shown`); 0 before the map has them. */
function mapControlsPx(): number {
  let h = 0;
  for (const el of pageEl.value?.querySelectorAll<HTMLElement>(
    ".mapboxgl-ctrl-bottom-left, .mapboxgl-ctrl-bottom-right",
  ) ?? [])
    h = Math.max(h, el.offsetHeight);
  return h;
}
const {
  sheetPeekPx,
  sheetDragPx,
  sheetLowered,
  sheetFitted,
  sheetRefit,
  sheetHidden,
  sheetStyle,
  measureSheet,
  onSheetPointerDown,
  onSheetPointerMove,
  onSheetPointerUp,
} = sheet;
/** How much of the screen's bottom a raised fitted sheet covers (px); else
 *  the lowered strip's: a short sheet leaves the map in sight above it, and
 *  the map's own controls (mapbox's logo, its credit, the zoom) go up there
 *  with it (`--sheet-shown`). A full sheet hides them as it always has. Not
 *  moved by a drag (no restyle of the page as a finger takes the sheet): they
 *  follow where it comes to rest. */
const sheetShownPx = computed(() =>
  sheetFitted.value
    ? Math.max(sheetPeekPx.value, sheet.sheetFullPx.value - sheet.sheetRaisedPx.value)
    : sheetPeekPx.value,
);
/** The testing tools' buttons (the DEV options, the test emails) go up above
 *  a fitted sheet only when it leaves them this much more map (px): over a
 *  thin strip they stay where they were, low over the sheet. */
const SHEET_TOOLS_ROOM_PX = 192;
/** Where the testing tools' buttons sit above (`--sheet-tools`), or null:
 *  where they always were. */
/** The testing tools' menu sits low in the corner: the map's fallback shows
 *  on the page (no panel, no sheet). Always false outside testing builds. */
const toolsLow = computed(() => __TEST_TOOLS__ && mapFailed.value && !props.preview);
const sheetToolsPx = computed(() =>
  sheetShownPx.value > sheetPeekPx.value && sheet.sheetRaisedPx.value >= SHEET_TOOLS_ROOM_PX
    ? sheetShownPx.value
    : null,
);
if (__TEST_TOOLS__) {
  // The test emails' button is the app's, outside this page: told on the
  // document (`--ac-sheet-tools`, features/outbox OutboxLauncher).
  // It moves as the sheet does: in one step when the sheet's refit is made in
  // one (`--ac-sheet-tools-follow`, read at the same change), eased with the
  // sheet's raise, lower or eased refit otherwise.
  const root = document.documentElement.style;
  watch(
    sheetToolsPx,
    (px) => {
      if (sheetRefit.value) root.setProperty("--ac-sheet-tools-follow", "0s");
      else root.removeProperty("--ac-sheet-tools-follow");
      if (px === null) root.removeProperty("--ac-sheet-tools");
      else root.setProperty("--ac-sheet-tools", `${px}px`);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    root.removeProperty("--ac-sheet-tools");
    root.removeProperty("--ac-sheet-tools-follow");
  });
}
/** How much of the screen's bottom the camera keeps clear
 *  of an open lieu's pin (px), the sheet's rest top under a short sheet; null
 *  otherwise (sheetFit lieuAimPx, set further down, once the hold is made). */
const sheetAimPx = ref<number | null>(null);
/** The map left above a short phone sheet, the territory
 *  in scope framed there by the camera's padding (panel/useSheetBand, set up
 *  further down once the sheet's hold is made), or null. The ring stands
 *  aside meanwhile. */
const sheetBand = shallowRef<Insets | null>(null);
/** The sheet came down for the visitor's use of the map (panel/sheetMap),
 *  no camera command since: the band stays as applied. */
const sheetLoweredByMap = ref(false);
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
    aimPx: sheetAimPx,
    band: sheetBand,
  },
  follows,
  loweredByMap: sheetLoweredByMap,
});
const {
  panelWide,
  panelFolded,
  panelFlush,
  panelHeightPx,
  panelPx,
  engageMap,
  tapMap,
  returnToPanel,
  cancelHoverReturn,
  onPanelClick,
  onPanelKeydown,
  onPanelFocusIn,
  onPanelPointerMove,
  onPanelPointerLeave,
  mapPadding,
} = layout;
/** A hand on the map: the panel makes way (a phone's raised sheet comes
 *  down: panel/sheetMap), the frame the camera gave is left (useCamera's
 *  handMoved), and a gesture that has moved the map far enough closes the
 *  open lieu (unless filters are on). */
function onUserGesture(source: MapGestureSource, seq: number) {
  engageMap(source, seq);
  handMoved();
  lieuFollow.gesture();
}
// The panel comes to follow the map while it was folded aside — the filters
// cleared with the results' lieu still open: it comes back, never to fold
// again.
watch(follows, (f) => {
  if (f) mapEngaged.value = false;
});

/**
 * The open lieu closes because the visitor took the map elsewhere (or asked
 * for the analyses of what is in view): the panel follows the map again —
 * the scope catches up with the view (the `readingPlace` watch below), the
 * list and the trail with the scope. A focus in what goes or changes with
 * the lieu (its text in the list, the trail, whose crumbs follow the scope)
 * goes to the trail itself, which stays, without scrolling anything; one
 * elsewhere in the panel (the search, the filters) stays where it is.
 * Nothing is read out.
 */
function closeLieuForMap() {
  const at = document.activeElement;
  const trail = panelEl.value?.querySelector<HTMLElement>("nav.crumbs") ?? null;
  const goes =
    at instanceof HTMLElement &&
    at !== trail &&
    (!!panelListEl.value?.contains(at) || !!trail?.contains(at));
  if (goes) trail?.focus({ preventScroll: true });
  selectedPlaceId.value = null;
  openAuditions.value = new Set();
  hoveredPanelId.value = null;
  // The list that follows is read from its top, wherever the lieu's text had
  // been scrolled to (the list's own scroller; the page does not move).
  panel.listToTop();
}
const lieuFollow = createLieuFollow({
  cameraNow: () => mapCmp.value?.cameraNow() ?? null,
  shiftPx: (at) => mapCmp.value?.screenShift(at.lng, at.lat) ?? null,
  commandKey: () => nav.cameraKey.value,
  gate: () => ({
    lieuOpen: selectedPlaceId.value !== null,
    listMode: listMode.value,
    sinceOpenMs: performance.now() - nav.placeOpenedAt.value,
  }),
  close: closeLieuForMap,
});
// Desktop: how much of the map's right edge the panel covers, which the
// credit's top-left box (desktop) is kept clear of: the narrow width when
// folded (the fold leaves it on screen), the wide one when open wide. None
// while the map's fallback shows: the panel is out of sight, the fallback's
// sentence is centred in the whole box.
const panelCover = computed(() => {
  if (props.preview || !isDesktop.value || mapFailed.value) return 0;
  return panelWide.value && !panelFolded.value ? panelPx.value : PANEL_BASE_PX;
});
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
  bandApplied: sheetBand,
  readingPlace,
  mapCmp,
  camera: cam,
});
const {
  measureHeaderClear,
  headerClearPx,
  ringWanted,
  ringOn,
  ringRoom,
  overlayInsets,
  plateScreen,
  mapViewPadding,
} = ring;

// ---- The answer to a tap (model/useTapPending): the territory tapped is
// marked on the map from the tap until its plateau commits, the list is busy
// meanwhile and one sentence says when it stands ----
const tap = useTapPending({
  nav,
  mapCmp,
  // « Réessayer » (the wait late): only the piece the plateau
  // still misses is asked again, never the selection (the scope, the camera,
  // the lists, the files' chain are as they were). While the map holds for
  // the unit's outline, that is its file: the attempts on the network the
  // plateau waits for are dropped and made again at once. With the outline in
  // memory, it is the plateau's own run: made once more from that outline,
  // unless one is under way.
  reask: (unit) => {
    if (scopePending.value) outlines.reaskWaited();
    else mapCmp.value?.retryPlateau(unit.id);
  },
});
const { pendingUnit, live: tapLive, waitStage } = tap;
tappedUnit = () => pendingUnit.value?.id ?? "";
/** GeoDrillMap's `viewChange`: the scope's read of it, then the landing a
 *  pending unit's long-wait sign waits for. */
/** A frame of the visitor's gesture: once it has moved the map enough, the
 *  view is reported at once, and closes the lieu (lieuFollow's `due`). */
function onGestureMove() {
  if (lieuFollow.due()) mapCmp.value?.reportView();
}
function onMapView(view: MapView) {
  onViewChange(view);
  lieuFollow.view();
  tap.landed();
}
/** « Réessayer » pressed. The button goes with the sentence: a focus it held
 *  moves to the trail's current crumb, not to the page. Shown over the map
 *  while the panel's own failure message is off screen (model/retryNotice),
 *  it asks for what that message's button would have, too. */
function onRetryWait() {
  const held = !!document.activeElement?.closest(".slow-wait");
  if (panelFailureUp.value) retryPanel();
  if (!tap.retry() || !held) return;
  void nextTick(() => panelEl.value?.querySelector<HTMLElement>(".crumb.current")?.focus());
}

// ---- The files asked ahead on a touch screen (data/idlePrefetch):
// no pointer hovers a row there. Once the first plateau stands, its lid has
// landed and the map is at rest, the one or two units under it that hold the
// most testimonies have a file asked, one per rest: France's top régions.
// The ONE file a tap's plateau waits for — the self alone where it goes ahead
// of its bundle, a third of the bytes; the bundle follows
// the tap, as for any unit. Not under Save-Data, not on a link the browser
// calls slow, never while the map moves or a finger is on it; one unit on a
// weak device.
const ahead = idlePrefetch({
  allowed: () => {
    const signals = deviceSignals();
    return prefetchAllowed({
      files: outlines.mode.value === "fichiers",
      hover: window.matchMedia("(hover: hover)").matches,
      saveData: signals.saveData,
      effectiveType: signals.effectiveType,
    });
  },
  targets: (scopeId) =>
    pickPrefetch(
      index.value.get(scopeId)?.children ?? [],
      prefetchUnits(deviceTier()),
      (id) => prefetchKind(outlines.rowOf(id)) !== null,
    ),
  prefetch: (id) => {
    const kind = prefetchKind(outlines.rowOf(id));
    if (!kind) return Promise.resolve();
    return outlines.prefetch(kind === "k" && outlines.selfAhead(id) ? "u" : kind, id);
  },
  whenAtRest: (job) => mapCmp.value?.whenAtRest(job) ?? (() => {}),
});
onBeforeUnmount(ahead.stop);
// Shown as a card (the home page) the map is only looked at: nothing is
// asked ahead until the card is opened into the page — then for the unit
// standing by then.
let standing = "";
/** GeoDrillMap's `plateauSettled`: the pending mark's verdict, and the first
 *  plateau the idle prefetch waits for. */
function onPlateauSettled(scopeId: string, how: SettleHow) {
  tap.settled(scopeId, how);
  standing = how === "cleared" || how === "failed" ? "" : scopeId;
  if (!props.preview) ahead.settled(scopeId, how);
}
watch(
  () => props.preview,
  (card) => {
    if (!card && standing) ahead.settled(standing, "same");
  },
);

// ---- Actions (model/useNavActions): pins, rows, breadcrumb all fly the map ----
const { activate, onUnitClick, drillToCrumb, foldToList, pinOpened } = useNavActions({
  nav,
  index,
  listMode,
  camera: cam,
  panel,
  engageMap,
  follows,
  tap,
});
/** A unit tapped on the map: a phone's raised sheet comes down first, in the
 *  same tick, unless it is a lieu's dot (the lieu opens, the sheet rising
 *  with it): a territory's flight then frames for the lowered sheet
 *  (panel/sheetMap, useSheetBand). A pin chosen with the keys is no use of
 *  the map: the sheet stays as it is. */
function onMapUnitClick(id: string, byKeys = false) {
  const u = index.value.get(id);
  if (u && !byKeys) tapMap(u.levelKey === "place" ? "lieu" : "territory");
  onUnitClick(id);
}

// ---- Analyses ----------------------------------------------------------------
// What the association heard in the raised territory, drawn on the map around
// its plateau (ScopeAnalysisOverlay): its figures, the words' content boxes,
// whether they are on screen, the slabs GeoDrillMap stands and the room the
// camera leaves them — analyses/composables/useScopeAnalysis, handed what it
// reads of this component. None of it may reach `outline`: the plateau would
// be rebuilt for a change it does not show. A build without the analyses
// (__ANALYSES__, see vite.config) has none of it: nothing analysed or drawn,
// and the overlay not even in the bundle. Where it is, its code comes the
// first time the analyses turn on; a fetch that fails (offline, or a tab left
// open across a deploy) turns them back off rather than leave the slabs
// standing without their words.
const ScopeAnalysisOverlay = __ANALYSES__
  ? defineAsyncComponent({
      loader: loadScopeAnalysisOverlay,
      onError(_error, _retry, fail) {
        analyses.value = false;
        fail();
      },
    })
  : null;

/** The filters' themes, as the plates are handed them (one array, not a fresh
 *  one per render). */
const NO_THEMES: string[] = [];
const filterThemes = computed(() => props.themeFilter ?? NO_THEMES);

// The server's figures: indexed once per key and store version (the facts
// come with the tree, so turning the analyses on asks for nothing).
const factsIndex = __ANALYSES__ ? computed(() => markRaw(buildFactsIndex(unitTree.facts()))) : null;

const { scopeAnalysis, analysesVisible, slabSizesNow, slabSpec, roomNow, fontsLoaded } =
  !__ANALYSES__
    ? noScopeAnalysis()
    : useScopeAnalysis({
        analyses,
        preview: toRef(props, "preview"),
        currentScope,
        booting,
        inMicroZone,
        readingPlace,
        isDesktop,
        sheetOpen,
        plateScreen,
        listMode,
        themeFilter: filterThemes,
        framedFit,
        server: {
          stats: () => factsIndex!.value,
          placeLabel: (lieu) => placeLabel(lieu.key, lieu.city),
        },
      });
// The room the plates need, bound late for the camera (navState's roomNow box):
// setCamera reads it at each command, the resize watch above as the width changes.
nav.roomNow.value = roomNow;

// ---- The focus around the plates (ring/usePlaqueFocus) ----
const overlayCmp = ref<{ focusPlaque: () => void } | null>(null);
const { focusPlaqueWhenShown, dropPlaqueFocus } = usePlaqueFocus({
  analyses,
  scopeAnalysis,
  analysesVisible,
  overlayCmp,
});

// Turning the analyses on is asking to see the map.
// - A lieu open: the map is handed the screen as if the user had taken it —
//   the lieu closes, the panel following the map (with filters on it stays
//   open and the wide panel folds); the sheet lowers — and, deep at the lieu
//   where nothing stands, the map pulls back to the territory around it,
//   which rises with its analyses (exactly what a click on that territory
//   does). Higher up, the ring's fit frames the territory already in sight
//   (see applyRing).
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
  if (follows()) closeLieuForMap();
  if (isDesktop.value) {
    mapEngaged.value = !follows();
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
    __ANALYSES__ && analysesVisible.value && scopeAnalysis.value
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
  // Not in the lieu zone: the outline is empty there whatever the scope, the
  // mask is never touched, and there would be nothing to end.
  watch(
    () => currentScope.value.id,
    (id) => {
      if (!inMicroZone.value) perfBegin("scope-mask", id);
    },
    { flush: "sync" },
  );
  watch(
    [() => currentScope.value.id, outlineReady],
    ([id, ready]) => {
      if (ready) perfEnd("drill-boundaries", id);
    },
    { flush: "sync" },
  );
  // `window.__acOutlineCheck()`: the store writes so far, the vertices of the
  // outline handed to the map, by kind, the commune the scope walk finds at a
  // point, and whether the lines lifted onto the lid lie on its edge
  // (model/outlineCheck; null while the outline has no scope feature: the
  // map lifts them only once the plateau rises). Reads the outline and the
  // hierarchy only.
  const outlineCheck = () => {
    const vertices: Record<string, number> = {};
    for (const f of outline.value.features) {
      const g = f.geometry as { type: string; coordinates: unknown[] };
      const n = g.coordinates.flat(g.type === "Polygon" ? 1 : 2).length; // positions
      const kind = String(f.properties.kind);
      vertices[kind] = (vertices[kind] ?? 0) + n;
    }
    // The lift check walks every vertex: only when one of its fields is read.
    const fc = outline.value;
    const of = (kind: string) =>
      fc.features
        .filter((f) => f.properties.kind === kind)
        .map((f) => f.geometry as { type: string; coordinates: unknown });
    let lift: ReturnType<typeof liftCheck> | null = null;
    let checked = false;
    const check = () => {
      if (!checked) {
        const [scopeSelf] = of("scope");
        lift = scopeSelf ? liftCheck(scopeSelf, of("focus")) : null;
        checked = true;
      }
      return lift;
    };
    return {
      writes: outlines.version.value,
      vertices,
      finest: (lat: number, lng: number) => geo.finestAt(lat, lng)?.id ?? null,
      get offLid() {
        return check()?.offLid ?? null;
      },
      get nearMiss() {
        return check()?.nearMiss ?? null;
      },
      get liftedShare() {
        return check()?.liftedShare ?? null;
      },
      get lifted() {
        return check()?.lifted ?? null;
      },
      get boundaryM() {
        return check()?.boundaryM ?? null;
      },
    };
  };
  const wc = window as unknown as { __acOutlineCheck?: typeof outlineCheck };
  wc.__acOutlineCheck = outlineCheck;
  onBeforeUnmount(() => {
    if (wc.__acOutlineCheck === outlineCheck) delete wc.__acOutlineCheck;
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
// this puts the régions in the visible area beside the panel). The server's
// tree comes after the métropole's outline, so France is framed by its box on
// purpose — the same first view, whatever arrives first.
let framed = false;
watch(
  root,
  (r) => {
    if (framed || !r.children.length) return;
    framed = true;
    const country = r.children.find((c) => c.levelKey === "country") ?? r.children[0];
    flyToUnit(country, false, false, true);
  },
  { immediate: true },
);

// ---- The server's tree (map phase 1): what it is asked for --------------------
// After every watcher above (their order is behaviour). The scope's chain is
// what a filter change waits for before swapping trees (the store asks for
// the scope and its parent). On view (design E2): the scope's own answer when
// its units' children are not known yet, so that the next drill step finds
// them — one level ahead, no more — and the communes and arrondissements
// shown whose lieux are not known yet.
/** The scope's children are on their way: the panel shows them loading. */
const scopeChildrenPending = computed(() => currentScope.value.childrenPending === true);
/** The scope's answer (or the filter's) could not be had: the error line. */
const scopeFailed = computed(() => {
  // A folded territory's children are its département's answer.
  const s = currentScope.value;
  return unitTree.failed(s.id) || (!!s.foldedDep && unitTree.failed(s.foldedDep));
});
watch(
  () => currentScope.value.id,
  () => unitTree.setScope(currentScope.value),
  { immediate: true },
);
watch(
  () => {
    const s = currentScope.value;
    const deep = s.children.some((c) => c.levelKey !== "place" && c.childrenPending);
    // The communes around: the scope's siblings (and at an arrondissement,
    // the cities around its ville), as useMapFeed shows them.
    const parent = s.parentId ? index.value.get(s.parentId) : undefined;
    const around = [...(parent?.children ?? [])];
    const grand = s.levelKey === "arr" && parent?.parentId;
    if (grand) around.push(...(index.value.get(grand)?.children ?? []));
    const communes = new Set(
      [s, ...panelUnits.value, ...around]
        .filter((u) => (u.levelKey === "city" || u.levelKey === "arr") && u.childrenPending)
        .map((u) => u.id),
    );
    // An overseas territory's children are its département's: asked by it
    // (its région, loaded from France's answer, holds them only by name).
    const folded = [s, ...s.children]
      .filter((u) => u.foldedDep && u.childrenPending)
      .map((u) => u.foldedDep!);
    return `${deep ? s.id : ""}\n${[...communes].sort().join(",")}\n${folded.join(",")}`;
  },
  (wanted) => {
    const [deep, communes, folded] = wanted.split("\n");
    if (deep) unitTree.ensure([deep], true);
    if (communes) unitTree.ensure(communes.split(","));
    if (folded) unitTree.ensure(folded.split(","));
  },
  { immediate: true },
);
if (__TEST_TOOLS__) {
  const w = window as unknown as { __acUnitTree?: () => unknown; __acLists?: () => unknown };
  const probe = () => unitTree.stats();
  w.__acUnitTree = probe;
  const listsProbe = () => lists.stats();
  w.__acLists = listsProbe;
  onBeforeUnmount(() => {
    if (w.__acUnitTree === probe) delete w.__acUnitTree;
    if (w.__acLists === listsProbe) delete w.__acLists;
  });
}
/** Filters on, the server's results not on screen yet (the panel's dots). */
const listsLoading = computed(() => lists.resultsLoading.value);
/** The results could not be had. */
const listsFailed = computed(() => lists.resultsFailed.value);
/** Something the phone's raised sheet shows is still on its way — the
 *  testimonies, the results, the scope's children, the lieu's auditions: the
 *  sheet may grow meanwhile, not shrink, so that it never shrinks to the wait
 *  dots and grows back (useBottomSheet). */
const sheetFitHold = computed(
  () => props.loading || listsLoading.value || scopeChildrenPending.value || placeLoading.value,
);
/** An open audition's text is on its way — its testimonies, or the lieu's
 *  list its line is in (a lieu of one audition opens with it open,
 *  model/lieuSingle): the phone's raised sheet stands full at once, as the
 *  text will most often make it, rather than fitting the line and the wait
 *  dots and rising again once the text is in (`sheetExpectFull`, below) —
 *  unless a lieu's pin opened it (`sheetWaitText`). An audition without
 *  testimony has nothing to unfold. */
const openTextPending = computed(() => {
  if (!listMode.value && !selectedPlace.value) return false;
  for (const id of openAuditions.value) {
    const a = panelAuditions.value.find((x) => x.id === id);
    if (!a) {
      if (placeLoading.value || listsLoading.value) return true;
    } else if (testimoniesOf(a) === null && a.count !== 0) return true;
  }
  return false;
});
/** TEXT_WAIT_CAP_MS has passed since the pin's tap, the wait not ended. */
const pinWaitCapped = ref(false);
/** TEXT_WAIT_DOTS_MS has passed since the pin's tap: a raised sheet still
 *  waiting may grow to show the audition's line and its loading dots. */
const pinWaitDots = ref(false);
/** The audition a lieu's pin opened is on its way (useNavActions'
 *  `pinOpened`, panel/sheetFit's textWait): the raised sheet holds where it
 *  stands — neither full first (its text may be short) nor fitted to its
 *  line alone — and moves once, the text in: straight to the height it
 *  needs, full for a long one; on a slow link, a raised one grows meanwhile
 *  to show the audition's line and its loading dots (`pinWaitDots`). Past
 *  the cap, full ("full"), and full it stays. */
const pinTextWait = computed(() => {
  const id = pinOpened.value;
  if (id === null || listMode.value || selectedPlace.value?.id !== id) return null;
  return textWait({
    pinOpened: true,
    auditionOpen: openAuditions.value.size > 0,
    textPending: openTextPending.value,
    capped: pinWaitCapped.value,
  });
});
const sheetWaitText = computed(() => pinTextWait.value === "hold");
const sheetExpectFull = computed(
  () => pinTextWait.value === "full" || (openTextPending.value && !sheetWaitText.value),
);
// That wait ends once the text is in (or its read failed), with another lieu,
// when the visitor opens or folds an audition themselves (a line's press,
// the lieu's crumb, the back arrow: `onAudToggle`, useNavActions), drags the
// sheet or lowers it — the sheet then goes on under the rule of any open
// audition. Past TEXT_WAIT_CAP_MS it stands full instead, and stays full once
// the text is in, until the visitor ends the wait in one of those ways.
let pinWaitTimer = 0;
let pinDotsTimer = 0;
watch(pinOpened, (id) => {
  window.clearTimeout(pinWaitTimer);
  window.clearTimeout(pinDotsTimer);
  pinWaitCapped.value = false;
  pinWaitDots.value = false;
  if (id === null) return;
  pinDotsTimer = window.setTimeout(() => {
    if (pinOpened.value === id) pinWaitDots.value = true;
  }, TEXT_WAIT_DOTS_MS);
  pinWaitTimer = window.setTimeout(() => {
    if (pinOpened.value === id) pinWaitCapped.value = true;
  }, TEXT_WAIT_CAP_MS);
});
watch(
  () =>
    pinOpened.value !== null &&
    (selectedPlace.value?.id !== pinOpened.value ||
      (!pinWaitCapped.value && openAuditions.value.size > 0 && !openTextPending.value)),
  (over) => {
    if (over) pinOpened.value = null;
  },
);
watch([() => sheetDragPx.value !== null, sheetOpen], ([dragging, open]) => {
  if (dragging || !open) pinOpened.value = null;
});
onBeforeUnmount(() => {
  window.clearTimeout(pinWaitTimer);
  window.clearTimeout(pinDotsTimer);
});
/** A line pressed (or reached with the keys) in the panel: the visitor's own
 *  open or fold, never the pin's — the sheet goes under the rule of any open
 *  audition from it on. */
function onAudToggle(id: string) {
  pinOpened.value = null;
  void toggleAud(id);
}
watch(
  () =>
    lieuAimPx({
      lieuRaised: !isDesktop.value && Boolean(selectedPlace.value) && sheetOpen.value,
      fitted: sheetFitted.value,
      shownPx: sheetShownPx.value,
      hold: sheetFitHold.value || sheetWaitText.value,
      expectFull: sheetExpectFull.value,
      // The aim decided last: a hold keeps it (re-reading it after a change
      // gives the same aim back).
      prev: sheetAimPx.value,
    }),
  (px) => (sheetAimPx.value = px),
  { immediate: true },
);
// ---- The territory framed in the map left above a short sheet
// (panel/useSheetBand) ----
/** Where the raised plateau stood on screen at the last frame drawn (the
 *  map's frame bus, read when asked: only a band decision reads it), when it
 *  is the scope's and stands at full height: a late list that brings the
 *  sheet down leaves a territory that already clears the sheet's new top
 *  where it is (useSheetBand). A phone's page only. */
function plateauBox(): PlateauBox | null {
  if (isDesktop.value || asCard.value) return null;
  const p = mapCmp.value?.plateauNow() ?? null;
  if (!p || p.rise < 0.99 || p.scopeId === "" || p.scopeId !== nav.currentScope.value.id)
    return null;
  return { ...p.box, w: p.w, h: p.h };
}
const band = useSheetBand({
  nav,
  late: () => sheetLateMode.value,
  dialogOpen: () => Boolean(props.filtersOpen),
  isDesktop,
  preview: asCard,
  fitted: sheetFitted,
  shownPx: sheetShownPx,
  viewportH,
  headerClearPx,
  sidePx: () => PHONE_SIDE_PX,
  hold: () => sheetFitHold.value,
  readingPlace,
  plateauBox,
  listMode,
  mapCmp,
  applied: sheetBand,
  loweredByMap: sheetLoweredByMap,
  camera: cam,
});
if (__TEST_TOOLS__) {
  // `window.__acSheet()`: the phone's sheet as measured last — raised or not,
  // the box, the content, the raised and lowered offsets,
  // the hold (px; desktops have no sheet), and the camera's padding.
  const probe = () => ({
    open: sheetOpen.value,
    fullPx: sheet.sheetFullPx.value,
    contentPx: sheet.sheetContentPx.value,
    raisedPx: sheet.sheetRaisedPx.value,
    loweredPx: sheet.sheetLoweredPx.value,
    peekPx: sheetPeekPx.value,
    // Held out of sight under the boot curtain (panelBoot).
    held: panelHeld.value,
    fitted: sheetFitted.value,
    hold: sheetFitHold.value,
    expectFull: sheetExpectFull.value,
    waitText: sheetWaitText.value,
    // The pin's wait: "hold", "full" (past its cap) or null; long enough for
    // a raised sheet to grow and show the dots.
    pinWait: pinTextWait.value,
    waitGrows: pinWaitDots.value,
    aimPx: sheetAimPx.value,
    // What the camera is told to keep clear: the raised sheet's height, for
    // an open lieu (`aimPx`) or a territory (the band below).
    mapPadding: { ...mapPadding.value },
    // Why the sheet came down for the map last (panel/sheetMap), and whether
    // the band stays for it.
    mapLower: layout.lastMapLower.value,
    loweredByMap: sheetLoweredByMap.value,
    // The band above a short sheet asked for and the one the camera frames
    // in (useSheetBand), and the last decision made.
    band: {
      wanted: band.wanted.value,
      applied: band.applied.value,
      last: band.last.value,
      late: sheetLateMode.value,
      plateauBox: plateauBox(),
    },
  });
  const w = window as unknown as { __acSheet?: () => unknown };
  w.__acSheet = probe;
  onBeforeUnmount(() => {
    if (w.__acSheet === probe) delete w.__acSheet;
  });
}
/** After a network failure, what the panel could not have is asked again by
 *  itself (data/usePanelRecovery). */
const { offline: netOffline, retryNow } = usePanelRecovery({
  state: () =>
    props.isError || scopeFailed.value || listsFailed.value || placeFailed.value
      ? "failed"
      : props.loading || listsLoading.value || placeLoading.value
        ? "busy"
        : "ok",
  retry: () => {
    unitTree.retryFailed();
    lists.retryFailed();
  },
});
/** The panel's reads asked again, and the outline files' start if it waits. */
function retryPanel() {
  outlines.reconnect();
  retryNow();
}
/** The panel's body shows its failure message and its « Réessayer » (the
 *  template's branch below). */
const panelFailureUp = computed(
  () =>
    !(props.loading || listsLoading.value) &&
    (props.isError || scopeFailed.value || listsFailed.value),
);
/** Where the long wait's sentence and its « Réessayer » show: never beside
 *  the panel's own (model/retryNotice). */
const slowWaitAt = computed(() =>
  slowWaitPlace({
    late: waitStage.value === "late",
    sheetHidden: sheetHidden.value,
    preview: !!asCard.value,
    panelFailure: panelFailureUp.value,
  }),
);
/** The panel's « Réessayer ». The only button on screen while the tapped
 *  territory's plateau is late too: it then asks again for the piece that
 *  plateau misses, as the long wait's own button would. */
function retryAll() {
  retryPanel();
  if (waitStage.value === "late") tap.retry();
}
</script>

<template>
  <!-- As a card, nothing in it takes the pointer or the focus (inert): the
       card's own button, over it, opens the page. -->
  <div
    ref="pageEl"
    class="geo-page"
    :class="{ preview }"
    :inert="preview || undefined"
    :style="{
      '--sheet-peek': `${sheetPeekPx}px`,
      '--sheet-shown': `${sheetShownPx}px`,
      '--sheet-tools': sheetToolsPx === null ? undefined : `${sheetToolsPx}px`,
      '--sheet-follow': sheetRefit ? '0s' : undefined,
      '--panel-cover': `${panelCover}px`,
      // The map's fallback (no panel, no sheet): the testing tools' menu
      // (map-tools) sits low in the corner, moved there in one step. Testing
      // builds only: nothing else reads them.
      '--tools-bottom': toolsLow ? 'calc(40px + env(safe-area-inset-bottom, 0px))' : undefined,
      '--tools-ease': toolsLow ? '0s' : undefined,
    }"
  >
    <!-- Under a curtain over its box alone, the map takes no focus (inert): the
         keyboard skips it. The panel is held (inert) until the curtain
         leaves (`panelHeld`). -->
    <GeoDrillMap
      ref="mapCmp"
      class="geo-map"
      :inert="(booting && bootCover === 'map') || undefined"
      :units="mapUnits"
      :camera="camera"
      :outline="outline"
      :padding="mapPadding"
      :view-padding="mapViewPadding"
      :scope-pending="scopePending"
      :stable-outline="outlines.mode.value === 'fichiers'"
      :attribution="attribution"
      :credit-corner="isDesktop ? 'top-left' : 'bottom-right'"
      :preview="preview"
      :hovered-id="hoveredPanelId"
      :active-id="selectedPlaceId"
      :slabs="slabSpec"
      @ready="mapPresentable = true"
      @fallback="onMapFallback"
      @unit-click="onMapUnitClick"
      @empty-tap="tapMap('empty')"
      @plateau-settled="onPlateauSettled"
      @view-change="onMapView"
      @user-gesture="onUserGesture"
      @camera-rest="lieuFollow.end()"
      @gesture-move="onGestureMove"
    />

    <!-- The analyses, around the raised territory. Over the map, under the
         panel: no z-index of its own, and before the panel in the page. -->
    <ScopeAnalysisOverlay
      v-if="ScopeAnalysisOverlay && scopeAnalysis && slabSizesNow"
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
    <!-- The territory just tapped stands on the map, or is long in coming
         (model/useTapPending). -->
    <p class="analyses-live" aria-live="polite">
      {{ waitStage === "late" && slowWaitAt === "none" ? "" : tapLive }}
    </p>
    <!-- …long enough for the page to say so. On a phone whose
         sheet is lowered the panel's notice slot is off screen (only the trail
         row shows): said over the map. -->
    <SlowWaitNotice v-if="slowWaitAt === 'floating'" floating @retry="onRetryWait" />

    <!-- Boot curtain (see `booting`: lifts on its own, inert once gone). Over
         the map's box only (`bootCover` "map", bootListSwitch): no z-index of
         its own and before the panel in the page, so it lies under the panel,
         which is held out of sight meanwhile (`panelHeld`).
         France, the spinner and the words are drawn by shared/ui/MapCurtain:
         France where the camera frames it once the map is up, as MapStage's
         StageLoading drew it just before this curtain (the same rules, the
         same inputs); once the map has failed, gliding to the middle of the
         box, where the fallback it then fades onto draws it. Over map
         AND panel ("all": the card): above everything, so nothing
         half-built is on show. One element, so a card that becomes the page
         mid-boot only narrows it. -->
    <Transition name="boot" @leave="onCurtainLeave" @after-leave="endFadeWait">
      <div
        v-if="booting"
        ref="bootEl"
        class="boot"
        :class="{
          'boot-map': bootCover === 'map',
          'boot-failed': mapFailed && !preview && failedInSight,
        }"
        role="status"
        aria-live="polite"
      >
        <MapCurtain :poster="curtainPoster" :preview="preview" :centred="mapFailed && !preview" />
      </div>
    </Transition>

    <!-- Away while the map is a card; slides in when the card becomes the page.
         The aside's own listeners — a click, a key, the wheel or the pointer
         resting on it bring a folded panel back (usePanelLayout) — are attached
         here, on its root (panel/GeoPanel). -->
    <Transition name="panel-arrive">
      <GeoPanel
        v-show="!preview"
        ref="panelCmp"
        :held="panelHeld"
        :peek-px="sheetPeekPx"
        :wide="panelWide"
        :folded="panelFolded"
        :flush="panelFlush"
        :sheet-lowered="sheetLowered"
        :sheet-dragging="sheetDragPx !== null"
        :sheet-fitted="sheetFitted"
        :sheet-refit="sheetRefit"
        :sheet-style="sheetStyle"
        :sheet-open="sheetOpen"
        :sheet-hidden="sheetHidden"
        :phone="!isDesktop"
        :crumbs="listMode ? null : breadcrumb"
        :back-to-lieu="foldToList"
        :busy="pendingUnit !== null"
        :waiting="waitStage === 'moving'"
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
        <template #head-notice>
          <!-- Not beside the panel's own failure message and its button, below. -->
          <SlowWaitNotice v-if="slowWaitAt === 'head'" @retry="onRetryWait" />
        </template>

        <div v-if="loading || listsLoading" class="state">
          <LoadingDots label="Chargement des témoignages…" />
          <p v-if="netOffline" class="state-note" role="status">
            Pas de connexion à internet pour le moment. Les témoignages s'afficheront dès son
            retour.
          </p>
        </div>
        <div v-else-if="isError || scopeFailed || listsFailed" class="state">
          <p role="status">
            <template v-if="netOffline">
              Pas de connexion à internet pour le moment. Les témoignages s'afficheront dès son
              retour.
            </template>
            <template v-else>
              Les témoignages n'ont pas pu être chargés. La page réessaiera d'elle-même, vous pouvez
              aussi réessayer maintenant.
            </template>
          </p>
          <button
            type="button"
            class="ac-btn ac-btn--outline ac-btn--sm state-retry"
            @click="retryAll"
          >
            Réessayer
          </button>
        </div>

        <!-- The auditions being listed, each unfolding its testimonies: those of
             the selected lieu (exiting goes through the breadcrumb — any ancestor
             crumb closes the lieu), or, with filters on, EVERY audition that
             matches them, wherever it was held. -->
        <AuditionList
          v-else-if="listMode || selectedPlace"
          ref="auditionsCmp"
          :list-mode="listMode"
          :place="selectedPlace"
          :result-count="resultCount"
          :auditions="panelAuditions"
          :open="openAuditions"
          :meta="auditionMeta"
          :swapping="audSwapping"
          :highlight="highlight"
          :more="moreResults"
          :loading="placeLoading"
          :failed="placeFailed"
          @toggle="onAudToggle"
          @more="showMoreResults"
          @more-testimonies="showMoreTestimonies"
        />

        <!-- Unit list: children of the scope. The level is swapped as ONE block,
             keyed by scope id — drilling in slides the new list in from the
             right, stepping back out reverses it. -->
        <UnitList
          v-else-if="panelUnits.length || scopeChildrenPending"
          :units="panelUnits"
          :scope-id="currentScope.id"
          :slide="slideName"
          :pending="scopeChildrenPending"
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

    <!-- Over the map's bottom-right corner (TemoignagesExplorer: the testing
         tools' menu, not in production): inside the page, so it follows
         --panel-cover. -->
    <slot name="map-tools" />
  </div>
</template>

<style scoped>
.boot {
  position: absolute;
  inset: 0;
  /* Above the panel (elevation-xl) and the map's own controls. */
  z-index: 10;
}

/* Over the map's box only: under the panel (no z-index, earlier in the page).
   What it draws where: shared/ui/MapCurtain.vue — France where the camera
   frames it, its words in the part of the map the panel leaves free. */
.boot.boot-map {
  z-index: auto;
}

/* Fade the curtain out only — it is covering the entrance animation, so it must
   not still be fading in over it. */
.boot-leave-active {
  transition: opacity 0.45s ease;
}

.boot-leave-to {
  opacity: 0;
}

/* The map failed under the curtain: its France and its words glide to the
   middle of the box first (MapCurtain `centred`, 0.4 s), where the fallback
   draws them, then it fades onto the fallback: the two Frances meet in place
   rather than crossing. */
.boot.boot-failed.boot-leave-active {
  transition-delay: 0.4s;
}

@media (prefers-reduced-motion: reduce) {
  .boot.boot-failed.boot-leave-active {
    transition-delay: 0s;
  }
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

/* Read out, not shown: the plates themselves are on screen, and so is the
   territory just tapped. */
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

/* Phones: the attribution (bottom right), opened, stays clear of the zoom
   buttons and the logo (bottom left); its plain text in mapbox's own link
   colour on its light ground, not the page's. */
.geo-map :deep(.mapboxgl-ctrl-bottom-right) {
  max-width: calc(100% - 7rem);
}

.geo-map :deep(.mapboxgl-ctrl-attrib) {
  color: rgb(0 0 0 / 0.75);
}

/* Phones: opened, the credit is a tall column on a narrow screen: past the
   site header's edge, it scrolls instead (desktop's is below). */
.geo-map :deep(.mapboxgl-ctrl-attrib-inner) {
  max-height: calc(100dvh - var(--header-space) - 3rem);
  overflow-y: auto;
}

@media (min-width: 900px) {
  /* The attribution sits top left (GeoDrillMap's `creditCorner`), opened to
     its right: a readable line, left of the panel painted over the map's right
     edge, and above the zoom buttons and the logo (bottom left), scrolling
     past them. */
  .geo-map :deep(.mapboxgl-ctrl-top-left) {
    max-width: min(40rem, calc(100% - var(--panel-cover, 0px) - 2rem));
  }

  .geo-map :deep(.mapboxgl-ctrl-top-left .mapboxgl-ctrl-attrib-inner) {
    max-height: calc(100dvh - var(--header-space) - 9rem);
  }
}

.state {
  padding: 2rem 1rem;
  text-align: center;
  color: hsl(var(--muted-foreground));
}
.state-note {
  margin-top: 0.75rem;
}
.state-retry {
  margin-top: 1rem;
}

@media (max-width: 899px) {
  /* The lowered sheet covers the map's bottom edge, which is where mapbox puts
     the zoom buttons, its logo and the attribution — lift them clear of it;
     over a raised sheet shorter than the screen, clear of that sheet's top
     (`--sheet-shown`), moving with it as it rises, refits and lowers: eased
     on the sheet's own curve, in one step when the sheet's refit is made in
     one (`--sheet-follow`, the sheet's `sheetRefit`, read at the same
     render). */
  .geo-map :deep(.mapboxgl-ctrl-bottom-left),
  .geo-map :deep(.mapboxgl-ctrl-bottom-right) {
    bottom: var(--sheet-peek, 4.5rem);
    transform: translateY(
      calc(var(--sheet-peek, 4.5rem) - var(--sheet-shown, var(--sheet-peek, 4.5rem)))
    );
    transition: transform var(--sheet-follow, 0.35s) cubic-bezier(0.22, 1, 0.36, 1);
  }
}

@media (max-width: 899px) and (prefers-reduced-motion: reduce) {
  .geo-map :deep(.mapboxgl-ctrl-bottom-left),
  .geo-map :deep(.mapboxgl-ctrl-bottom-right) {
    transition: none;
  }
}
</style>
