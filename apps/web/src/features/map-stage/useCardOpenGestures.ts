import { onBeforeUnmount, onMounted } from "vue";

// ---- Trying to move the map opens it, like a click ------------------------
// A drag with the mouse, a pinch — two fingers on a touch screen, or on a
// trackpad (which the browser reports as a wheel with ctrlKey, no key held).
// Not the plain wheel, a one-finger swipe or a pen stroke: those scroll the
// home page, and must keep doing so over the card. Nor ctrl/⌘ + wheel with the
// key really held: that is the browser's own zoom.
const DRAG_PX = 6;

/**
 * The card's handlers, `open` being what they call. `reset` forgets whatever
 * is pressed (the card's link goes the moment it opens, and with it the events
 * of the fingers still down); `isModifierHeld` says whether ctrl or ⌘ is
 * physically held.
 */
export function useCardOpenGestures(open: () => Promise<void>) {
  let press: { id: number; x: number; y: number } | null = null;
  const fingers = new Set<number>();
  /** Ctrl or ⌘ physically held — a trackpad pinch sets ctrlKey with none. */
  let modifierHeld = false;

  /** A plain click opens the card in place; any other (modifier keys, middle
   *  button) is left to the browser — a new tab, a new window. */
  function onCardClick(e: MouseEvent) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    void open();
  }

  function onCardPointerDown(e: PointerEvent) {
    if (e.pointerType === "touch") {
      fingers.add(e.pointerId);
      if (fingers.size >= 2) void open();
      return;
    }
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // as for clicks
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onCardPointerMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    // The button went up somewhere this card never heard of (a context menu).
    if ((e.buttons & 1) === 0) {
      press = null;
      return;
    }
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
    press = null;
    void open();
  }

  function onCardPointerEnd(e: PointerEvent) {
    if (press?.id === e.pointerId) press = null;
  }

  /** A context menu takes the button's release: no press is left armed. */
  function onCardContextMenu() {
    press = null;
  }

  function onCardWheel(e: WheelEvent) {
    if ((!e.ctrlKey && !e.metaKey) || modifierHeld) return;
    e.preventDefault(); // not the browser's own pinch zoom
    void open();
  }

  // Fingers lifted anywhere (the card's link is gone the moment it opens, and
  // with it the events of the fingers still down): forgotten, wherever.
  function onWindowPointerEnd(e: PointerEvent) {
    fingers.delete(e.pointerId);
  }
  function onKey(e: KeyboardEvent) {
    modifierHeld = e.ctrlKey || e.metaKey;
  }
  function onBlur() {
    modifierHeld = false;
  }
  onMounted(() => {
    window.addEventListener("pointerup", onWindowPointerEnd, true);
    window.addEventListener("pointercancel", onWindowPointerEnd, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("pointerup", onWindowPointerEnd, true);
    window.removeEventListener("pointercancel", onWindowPointerEnd, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("blur", onBlur);
  });

  /** Whatever was pressed on the card is over. */
  function reset() {
    press = null;
    fingers.clear();
  }

  function isModifierHeld() {
    return modifierHeld;
  }

  return {
    onCardClick,
    onCardPointerDown,
    onCardPointerMove,
    onCardPointerEnd,
    onCardContextMenu,
    onCardWheel,
    reset,
    isModifierHeld,
  };
}
