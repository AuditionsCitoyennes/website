// The panel's layout and who has it: wide with an audition open, folded aside
// while the map is used with filters on, flush with the page's bottom edge;
// the hand-overs between the map and the panel (engageMap / returnToPanel and
// the panel's handlers); and the camera padding that keeps the map clear of it.
import { computed, onBeforeUnmount, ref, shallowRef, watch, type ComputedRef, type Ref } from "vue";
import type { GeoUnit } from "@/features/geo";
import type { MapGestureSource } from "@/features/map";
import type { Insets, NavState } from "../navState";
import { insetsFor, PANEL_BASE_PX, PANEL_GAP_PX } from "@/shared/boot/curtainFrame";
import { createGestureFirst, sheetLowersOnMap, type MapUse } from "./sheetMap";

// Panel geometry. MUST stay in sync with `.panel` / `.panel.wide` in GeoNav's
// <style> — the camera padding is what keeps the map clear of the panel, and
// a mismatch parks the content under it.
// The narrow width, the gap and a phone's side room are the map's loading
// curtain's too (shared/boot/curtainFrame.ts, which draws France where this
// padding frames it): one constant each, kept there, and the boot framing
// (the card, the desktop, the lowered sheet) is its `insetsFor`.
export { PANEL_BASE_PX, PANEL_GAP_PX, PHONE_SIDE_PX } from "@/shared/boot/curtainFrame";
export const PANEL_WIDE_RATIO = 0.75; // 75%

export interface PanelLayoutInputs {
  nav: NavState;
  isDesktop: Ref<boolean>;
  viewportW: Ref<number>;
  viewportH: Ref<number>;
  /** The map is a card (the home page): no panel to keep clear of. */
  preview: Ref<boolean | undefined>;
  selectedPlace: ComputedRef<GeoUnit | null>;
  /** The panel (`.panel`). */
  panelEl: Ref<HTMLElement | null>;
  /** The phone's sheet: its strip (measured with the panel), its measure, whether
   *  a finger is on it, the height it leaves showing when lowered, and how much
   *  of the screen's bottom an open lieu's pin is kept clear of (null: the
   *  top strip; sheetFit lieuAimPx) — and the map left above a short sheet
   *  raised over a territory, the camera framed in it (null: none;
   *  panel/useSheetBand). */
  sheet: {
    peekEl: Ref<HTMLElement | null>;
    measure: () => void;
    dragging: () => boolean;
    peekPx: Ref<number>;
    aimPx?: Ref<number | null>;
    band?: Ref<Insets | null>;
  };
  /** No filters on: a gesture that moves the map closes the lieu
   *  (model/lieuFollow) — a desktop's panel stays where it is meanwhile,
   *  never folded. */
  follows: () => boolean;
  /** Set when the sheet comes down for the map with no lieu open, cleared
   *  when it is raised again (and by the next camera command, useSheetBand):
   *  the band above a short sheet stays as applied meanwhile. */
  loweredByMap?: Ref<boolean>;
}

export function usePanelLayout(inputs: PanelLayoutInputs) {
  const { nav, isDesktop, viewportW, viewportH, preview, selectedPlace, panelEl, sheet, follows } =
    inputs;
  const { selectedPlaceId, mapEngaged, sheetOpen, openAuditions } = nav;

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
        sheet.measure();
      });
      panelRO.observe(el);
      panelRO.observe(page);
      if (sheet.peekEl.value) panelRO.observe(sheet.peekEl.value);
    }
  });
  onBeforeUnmount(() => panelRO?.disconnect());

  // Opening a lieu is asking to read it: raise the sheet (on a phone the pin was
  // tapped on the map, so the sheet was down). Either way the reader starts on
  // the panel.
  watch(selectedPlaceId, (id) => {
    mapEngaged.value = false;
    if (id) sheetOpen.value = true;
  });
  watch(isDesktop, () => (mapEngaged.value = false));

  /** A gesture's first signal, told from its repeats (GeoDrillMap's `seq`). */
  const gestureFirst = createGestureFirst();
  /** Why the sheet came down for the map last (the testing probe's; set only
   *  under the testing tools). */
  const lastMapLower = shallowRef("");

  /** A phone: the sheet lowered for this use of the map, if the rule says so
   *  (sheetMap.ts). */
  function lowerForMap(use: MapUse) {
    const lieuOpen = Boolean(selectedPlaceId.value);
    const lowers = sheetLowersOnMap({
      phone: !isDesktop.value,
      preview: Boolean(preview.value),
      raised: sheetOpen.value,
      sheetDragging: sheet.dragging(),
      lieuOpen,
      sinceLieuOpenMs: performance.now() - nav.placeOpenedAt.value,
      use,
    });
    if (!lowers) return;
    // The band's record (useSheetBand), and the probe's (testing tools only).
    if (sheetOpen.value) {
      if (__TEST_TOOLS__)
        lastMapLower.value =
          (lieuOpen ? "lieu:" : "") +
          (use.kind === "gesture" ? `gesture:${use.source}` : `tap:${use.target}`);
      if (!lieuOpen && inputs.loweredByMap) inputs.loweredByMap.value = true;
    }
    sheetOpen.value = false;
  }
  if (inputs.loweredByMap) {
    const loweredByMap = inputs.loweredByMap;
    watch(
      sheetOpen,
      (open) => {
        if (open) loweredByMap.value = false;
      },
      { flush: "sync" },
    );
  }

  // The user has started moving the map (GeoDrillMap's `userGesture`; it repeats,
  // hence the cheap exits). A phone's raised sheet comes down (sheetMap.ts):
  // at a gesture's first signal made by hand; with a lieu open, at any of
  // them once the tap that opened it is over. With a lieu open on a desktop,
  // with filters on, the wide panel folds aside. With none, the panel
  // follows the map: it stays in place, and the gesture that really moves
  // the map closes the lieu instead (model/lieuFollow).
  function engageMap(source: MapGestureSource = "hand", seq?: number) {
    nav.hoverReturnHeld.value = false; // the hand is on the map now (see onPanelPointerMove)
    const first = gestureFirst(seq);
    if (!isDesktop.value) {
      // Unless the sheet itself is under a finger: that gesture decides.
      lowerForMap({ kind: "gesture", source, first });
      return;
    }
    if (!selectedPlaceId.value) return;
    // The tail of the very tap that opened the lieu (a double-tap on its pin
    // also zooms the map) is not a wish to leave the text.
    if (performance.now() - nav.placeOpenedAt.value < 400) return;
    mapEngaged.value = !follows();
  }

  /** A tap on the map: on an empty spot, a territory (it selects it), a
   *  lieu's dot (it opens it, the sheet rising with it). Before the tap's
   *  own answer, in the same tick: a territory's flight then frames for the
   *  lowered sheet (useSheetBand). */
  function tapMap(target: "empty" | "territory" | "lieu") {
    if (!isDesktop.value) lowerForMap({ kind: "tap", target });
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

  const panelPx = computed(() =>
    panelWide.value ? Math.round(viewportW.value * PANEL_WIDE_RATIO) : PANEL_BASE_PX,
  );

  const mapPadding = computed(() => {
    // A card: no panel to keep clear of.
    if (preview.value) return insetsFor({ preview: true, desktop: false, peekPx: 0 });
    // Desktop: always the narrow panel's framing — the globe never slides on
    // screen. The wide panel (an audition open) only changes what is in sight
    // (`mapViewPadding`): the map turns to bring the place into the strip left
    // beside it, and folding the panel aside moves nothing at all.
    if (isDesktop.value) return insetsFor({ preview: false, desktop: true, peekPx: 0 });
    // Phone. Raised over a lieu, the place is parked in the strip at the top of
    // the map, where its pin stays in sight above the text: under a full sheet
    // (a long lieu, while an opened audition's text is on its way — a long
    // text keeps it full) that strip is all the map that shows. Above a short
    // fitted sheet (a lieu of a few auditions) the pin goes to the middle of
    // the map left there instead (`aimPx`): the map moves with the sheet's
    // rest, once what it shows is in (useMapCamera re-aims a flight still on
    // its way).
    const h = viewportH.value;
    const aim = sheet.aimPx?.value ?? null;
    if (selectedPlace.value && sheetOpen.value)
      return {
        top: 24,
        bottom: Math.max(0, aim === null ? h - 70 : Math.min(h - 70, aim + 20)),
        left: 30,
        right: 30,
      };
    // A short sheet raised over a territory: the map left
    // above it (useSheetBand), the territory centred and fitted there. Changed
    // only together with a fit of the scope (the band's own rules), so the
    // map moves once, as the camera is told to frame; the camera's centre —
    // where mapbox rests it on the terrain — stands in the middle of what is
    // seen, as under the lowered sheet: aimed from the lowered frame's centre
    // instead (an offset), the terrain under that point, past the plateau's
    // near edge, moved the territory by tens of px.
    const band = sheet.band?.value;
    if (band) return { ...band };
    // Otherwise frame for the LOWERED sheet — the only state in which the map is
    // sure to be on screen: the sheet lowered, a full sheet over a list, or a
    // band too short to frame in (sheetFit sheetBandInsets).
    return insetsFor({ preview: false, desktop: false, peekPx: sheet.peekPx.value });
  });

  // What is really clear of the panel while it is open wide: less than the
  // camera's padding says. Only the logical view follows (scope, pins in sight)
  // and the commands aim there (GeoDrillMap's aimOffset) — the camera's padding
  // stays. Folded aside, the panel leaves the narrow framing in sight again.
  const widePanelView = computed(() =>
    panelWide.value && !panelFolded.value && !preview.value
      ? { top: 60, bottom: 60, left: 60, right: panelPx.value + PANEL_GAP_PX }
      : undefined,
  );

  return {
    panelWide,
    panelFolded,
    panelFlush,
    panelHeightPx,
    engageMap,
    tapMap,
    lastMapLower,
    returnToPanel,
    cancelHoverReturn,
    onPanelClick,
    onPanelKeydown,
    onPanelFocusIn,
    onPanelPointerMove,
    onPanelPointerLeave,
    panelPx,
    mapPadding,
    widePanelView,
  };
}

export type PanelLayout = ReturnType<typeof usePanelLayout>;
