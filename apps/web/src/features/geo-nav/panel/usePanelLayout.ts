// The panel's layout and who has it: wide with an audition open, folded aside
// while the map is used, flush with the page's bottom edge; the hand-overs
// between the map and the panel (engageMap / returnToPanel and the panel's
// handlers); and the camera padding that keeps the map clear of it.
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import type { GeoUnit } from "@/features/geo";
import type { NavState } from "../navState";

// Panel geometry. MUST stay in sync with `.panel` / `.panel.wide` in GeoNav's
// <style> — the camera padding is what keeps the map clear of the panel, and
// a mismatch parks the content under it.
export const PANEL_BASE_PX = 480; // 30rem
export const PANEL_WIDE_RATIO = 0.75; // 75%
export const PANEL_GAP_PX = 40;

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
   *  a finger is on it, the height it leaves showing when lowered. */
  sheet: {
    peekEl: Ref<HTMLElement | null>;
    measure: () => void;
    dragging: () => boolean;
    peekPx: Ref<number>;
  };
}

export function usePanelLayout(inputs: PanelLayoutInputs) {
  const { nav, isDesktop, viewportW, viewportH, preview, selectedPlace, panelEl, sheet } = inputs;
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
    else if (!sheet.dragging()) sheetOpen.value = false;
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
    if (preview.value) return { top: 24, bottom: 24, left: 24, right: 24 };
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
    return { top: 30, bottom: sheet.peekPx.value + 20, left: 36, right: 36 };
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
