// Mobile bottom sheet. Below 900px the panel is a sheet. It rests LOWERED at
// the bottom of the map, showing only a grip and its title row, so the map
// stays usable; dragging that strip up raises it to the full panel and
// dragging it down lowers it again (the grip also toggles on tap/keyboard).
// Desktop ignores all of this: the classes it drives only exist inside the
// mobile media query.
import { computed, ref, type Ref } from "vue";
import type { NavState } from "../navState";

export interface BottomSheetInputs {
  nav: NavState;
  isDesktop: Ref<boolean>;
  /** The panel (`.panel`): its box is the sheet's RAISED position. */
  panelEl: Ref<HTMLElement | null>;
  /** Grip + title row — what stays on screen when lowered, and the drag handle. */
  peekEl: Ref<HTMLElement | null>;
  /** Zero-size probe whose padding resolves `env(safe-area-inset-bottom)`. */
  safeEl: Ref<HTMLElement | null>;
}

export function useBottomSheet(inputs: BottomSheetInputs) {
  const { nav, isDesktop, panelEl, peekEl, safeEl } = inputs;
  const { sheetOpen } = nav;

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
    const peek = peekEl.value;
    // Not shown (the map is a card): nothing to measure — a hidden panel's zero
    // height would raise the sheet over the map the moment it appears.
    if (!panel || !peek || !panel.getClientRects().length) return;
    const safe = safeEl.value ? parseFloat(getComputedStyle(safeEl.value).paddingBottom) || 0 : 0;
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

  return {
    sheetPeekPx,
    sheetLoweredPx,
    sheetDragPx,
    sheetLowered,
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
