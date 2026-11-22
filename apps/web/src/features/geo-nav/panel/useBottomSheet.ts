// Mobile bottom sheet. Below 900px the panel is a sheet. It rests LOWERED at
// the bottom of the map, showing only a grip and its title row (the trail and
// the page's buttons, GeoPanel), so the map
// stays usable; dragging that strip up raises it and dragging it down lowers
// it again (the grip also toggles on tap/keyboard).
//
// Raised, it stands as tall as its head and its content need, up to the full
// panel (sheetFit.ts, « Ajusté »; « Plein », sheetFitSwitch: always full).
// The panel's box never changes — it is the full sheet —: a shorter one is
// that box slid down (`--sheet-raised`, a transform like the lowered one), so
// the scroller, the lowered offset and the drag's numbers stay those of the
// full box. Its content is measured whenever it changes (its own observer on
// the list and its body), an audition unfolding or folding at the height its
// tween goes to (ExpandTransition's `data-height-tween`); while something
// loads (`hold`) it may only grow, and while an open audition's text is on
// its way (`expectFull`) it stands full. A fit that would leave the map less
// room above it than its controls need (`mapControlsPx`, under the header's
// tiles) goes full instead. A refit eases like a raise and retargets an ease
// still running (a raise included, on any device); a sheet at rest refits in
// one step (`sheetRefit`) on a weak device and on a change of the box itself.
// Desktop ignores all of this: the classes it drives only exist inside the
// mobile media query.
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { motionNow } from "@/shared/device/motion";
import type { NavState } from "../navState";
import {
  MAP_CONTROLS_FALLBACK_REM,
  MAP_ROOM_MARGIN_REM,
  MIN_BODY_REM,
  raisedOffset,
  refitMotion,
  sheetSettle,
  type SheetFitMode,
} from "./sheetFit";

export interface BottomSheetInputs {
  nav: NavState;
  isDesktop: Ref<boolean>;
  /** The panel (`.panel`): its box is the sheet's RAISED position. */
  panelEl: Ref<HTMLElement | null>;
  /** Grip + title row — what stays on screen when lowered, and the drag handle.
   *  Its own bottom padding is the room between the row and the screen's edge
   *  (GeoPanel's phone `.title-row`): the strip measured is all that shows. */
  peekEl: Ref<HTMLElement | null>;
  /** Zero-size probe whose padding resolves `env(safe-area-inset-bottom)`. */
  safeEl: Ref<HTMLElement | null>;
  /** The list's scroller (`.panel-list`): where the content starts, its paddings. */
  listEl: Ref<HTMLElement | null>;
  /** The list's content (`.panel-list-body`), whatever the scroller shows. */
  bodyEl: Ref<HTMLElement | null>;
  /** « Ajusté », « Ajusté, centré » or « Plein » (sheetFitSwitch), read at
   *  each measure. */
  fitMode: () => SheetFitMode;
  /** Something the sheet shows is loading: a raised sheet may grow, not shrink.
   *  Read at a measure and watched from the mount on, never before. */
  hold: () => boolean;
  /** An open audition's testimonies are on their way: the sheet stands full
   *  (sheetFit's `expectFull`). Read and watched as `hold`. */
  expectFull: () => boolean;
  /** The height (px) of the map's controls stacked in a corner, which go up
   *  above a fitted sheet (GeoNav); 0 when not measured yet. */
  mapControlsPx?: () => number;
}

export function useBottomSheet(inputs: BottomSheetInputs) {
  const { nav, isDesktop, panelEl, peekEl, safeEl, listEl, bodyEl } = inputs;
  const { sheetOpen } = nav;

  /** Height left showing when lowered, home-indicator inset included. */
  const sheetPeekPx = ref(72);
  /** How far down the lowered sheet sits (its translateY); null until measured. */
  const sheetLoweredPx = ref<number | null>(null);
  /** How far down the RAISED sheet sits (its translateY): 0 is the full panel. */
  const sheetRaisedPx = ref(0);
  /** The panel's box and the content measured last (the testing probe's). */
  const sheetFullPx = ref(0);
  const sheetContentPx = ref(0);
  /** A refit to be made in one step: the transition is off for this render. */
  const sheetRefit = ref(false);
  /** Live offset under the finger while dragging, else null. */
  const sheetDragPx = ref<number | null>(null);
  const sheetLowered = computed(() => !isDesktop.value && !sheetOpen.value);
  /** Raised and shorter than the full panel (`.panel.sheet-fitted`). */
  const sheetFitted = computed(
    () => !isDesktop.value && sheetOpen.value && sheetRaisedPx.value > 0,
  );
  /** Lowered and at rest: everything under the strip is off screen. */
  const sheetHidden = computed(() => sheetLowered.value && sheetDragPx.value === null);
  // Finger travel before a press on the strip counts as a drag rather than a tap
  // on one of its buttons.
  const SHEET_DRAG_SLOP_PX = 6;
  // A release faster than this (px/ms) follows the flick, whatever the position.
  const SHEET_FLICK = 0.35;

  function measureSheet() {
    const panel = panelEl.value;
    const peek = peekEl.value;
    // Not shown (the map is a card): nothing to measure — a hidden panel's zero
    // height would raise the sheet over the map the moment it appears.
    if (!panel || !peek || !panel.getClientRects().length) return;
    const safe = safeEl.value ? parseFloat(getComputedStyle(safeEl.value).paddingBottom) || 0 : 0;
    // Both rects carry the sheet's own translate, so their difference does not.
    const strip = peek.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
    sheetPeekPx.value = Math.round(strip + safe);
    sheetLoweredPx.value = Math.max(0, panel.offsetHeight - sheetPeekPx.value);
    fitSheet(panel);
  }

  /** The box the last refit was made for. */
  let lastFull = 0;
  /** The sheet was raised at the previous measure: a raise itself is never held. */
  let wasOpen = false;
  let refitFrame = 0;

  /** The raised sheet's offset, from the content as it is now. */
  function fitSheet(panel: HTMLElement) {
    if (isDesktop.value) return;
    const list = listEl.value;
    const body = bodyEl.value;
    const full = panel.offsetHeight;
    let content = full;
    if (list && body) {
      const cs = getComputedStyle(list);
      // The list's offsetParent is the panel: its top is the head's height,
      // whatever the scroll or the transforms; the bottom padding holds the
      // home indicator's inset.
      content =
        list.offsetTop +
        (parseFloat(cs.paddingTop) || 0) +
        body.getBoundingClientRect().height +
        (parseFloat(cs.paddingBottom) || 0);
      // A block tweening its height (an audition unfolding or folding) counts
      // at the height it goes to: one refit for the whole tween, from its
      // first frame — not a step per frame behind it.
      for (const el of body.querySelectorAll<HTMLElement>("[data-height-tween]")) {
        const to = parseFloat(el.style.height);
        if (Number.isFinite(to)) content += to - el.getBoundingClientRect().height;
      }
    }
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const open = sheetOpen.value;
    const raising = open && !wasOpen;
    const held = open && wasOpen && inputs.hold();
    // The panel's box starts under the header's tiles (GeoPanel's phone
    // `.panel` top): the map's controls, which stand on a fitted sheet's top,
    // fit in its offset, with a margin, or the sheet goes full.
    const controls = inputs.mapControlsPx?.() || MAP_CONTROLS_FALLBACK_REM * rem;
    const next = raisedOffset({
      mode: inputs.fitMode(),
      fullPx: full,
      contentPx: content,
      minPx: sheetPeekPx.value + MIN_BODY_REM * rem,
      minOffsetPx: controls + MAP_ROOM_MARGIN_REM * rem,
      heldOffset: held ? sheetRaisedPx.value : null,
      expectFull: open && inputs.expectFull(),
    });
    sheetFullPx.value = full;
    sheetContentPx.value = Math.round(content);
    const prev = sheetRaisedPx.value;
    const fullChanged = lastFull !== 0 && full !== lastFull;
    lastFull = full;
    wasOpen = open;
    if (next === prev) return;
    // Only a sheet that stays raised refits on screen; a raise or a lower
    // eases as it always has (and a lowered sheet does not show this offset).
    if (open && sheetDragPx.value === null) {
      const how = refitMotion({
        fullChanged,
        short: motionNow() === "short",
        // A raise measured as it starts, or any ease of the sheet still on
        // its way: a step in one go would cut it short.
        easing: raising || transformEasing(panel),
      });
      cancelAnimationFrame(refitFrame);
      refitFrame = 0;
      if (how === "snap") {
        sheetRefit.value = true;
        // Two frames: the offset is painted without a transition first.
        refitFrame = requestAnimationFrame(() => {
          refitFrame = requestAnimationFrame(() => (sheetRefit.value = false));
        });
      } else {
        // Eased: never under a step's `transition: none` still in place.
        sheetRefit.value = false;
      }
    }
    sheetRaisedPx.value = next;
  }

  /** The sheet's transform is being eased (a raise, a lower, an eased refit). */
  function transformEasing(panel: HTMLElement): boolean {
    if (typeof panel.getAnimations !== "function") return false;
    return panel
      .getAnimations()
      .some(
        (a) =>
          a.playState === "running" &&
          (a as Animation & { transitionProperty?: string }).transitionProperty === "transform",
      );
  }

  // The content and the head change without the panel's box changing: the
  // list (shorter when the head grows) and its body (a level swapped, an
  // audition unfolding, the wait dots) are watched on their own.
  let fitRO: ResizeObserver | null = null;
  watch(
    [listEl, bodyEl],
    ([list, body]) => {
      fitRO?.disconnect();
      fitRO = null;
      if (typeof ResizeObserver === "undefined") return;
      fitRO = new ResizeObserver(() => measureSheet());
      if (list) fitRO.observe(list);
      if (body) fitRO.observe(body);
    },
    { immediate: true },
  );
  // A raise, a choice of the switch, a hold that starts or ends: measured at
  // the next frame, once the render's own hooks have run — an audition's
  // unfolding starts from no height in its enter hook, after the watchers: a
  // measure before it would see the whole body for an instant, and the sheet
  // would shrink back as the unfolding starts.
  let measureFrame = 0;
  const measureSoon = () => {
    if (measureFrame) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      measureSheet();
    });
  };
  watch([sheetOpen, () => inputs.fitMode()], measureSoon, { flush: "post" });
  // The hold is read once the page is set up (the caller may make it later).
  let stopHold: (() => void) | null = null;
  onMounted(() => {
    stopHold = watch([() => inputs.hold(), () => inputs.expectFull()], measureSoon, {
      flush: "post",
    });
  });
  onBeforeUnmount(() => {
    stopHold?.();
    fitRO?.disconnect();
    cancelAnimationFrame(refitFrame);
    cancelAnimationFrame(measureFrame);
  });

  const sheetStyle = computed(() => {
    if (isDesktop.value) return undefined;
    return {
      "--sheet-lowered": sheetLoweredPx.value === null ? undefined : `${sheetLoweredPx.value}px`,
      "--sheet-raised": `${sheetRaisedPx.value}px`,
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
      from: sheetOpen.value ? sheetRaisedPx.value : sheetLoweredPx.value,
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
    // Between the two rests: a short sheet is not pulled up into empty space.
    const lowered = sheetLoweredPx.value ?? 0;
    sheetDragPx.value = Math.min(
      lowered,
      Math.max(Math.min(sheetRaisedPx.value, lowered), g.from + dy),
    );
  }

  function onSheetPointerUp(e: PointerEvent) {
    const g = sheetGesture;
    if (!g || e.pointerId !== g.id) return;
    sheetGesture = null;
    if (!g.dragging) return; // a tap: whatever button is under it gets its click
    const at = sheetDragPx.value ?? g.from;
    // A flick decides by its direction; a slow release settles on the nearer rest.
    sheetOpen.value = sheetSettle({
      at,
      v: g.v,
      raisedPx: sheetRaisedPx.value,
      loweredPx: sheetLoweredPx.value ?? 0,
      flick: SHEET_FLICK,
    });
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

  return {
    sheetPeekPx,
    sheetLoweredPx,
    sheetRaisedPx,
    sheetFullPx,
    sheetContentPx,
    sheetDragPx,
    sheetLowered,
    sheetFitted,
    sheetRefit,
    sheetHidden,
    sheetStyle,
    measureSheet,
    /** The sheet itself is under a finger: that gesture decides where it rests. */
    dragging: () => sheetGesture !== null,
    onSheetPointerDown,
    onSheetPointerMove,
    onSheetPointerUp,
  };
}

export type BottomSheet = ReturnType<typeof useBottomSheet>;
