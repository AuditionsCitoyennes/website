// The focus around the plates. The plates come before the panel in the page,
// and a key pressed in the panel brings a folded panel back (onPanelKeydown) —
// which hides the plates before the focus could reach them. So the focus is
// taken to them: once the plaque is on screen, onto its title (the overlay's
// focusPlaque). It waits for the territory to rise, and gives up after a
// while, or as soon as the reader has gone somewhere of their own.
import { onBeforeUnmount, type ComputedRef, type Ref } from "vue";
import type { ScopeAnalysis } from "@/features/analyses";

export interface PlaqueFocusInputs {
  /** The analyses are on (the page's toggle). */
  analyses: Ref<boolean>;
  scopeAnalysis: ComputedRef<ScopeAnalysis | null>;
  analysesVisible: ComputedRef<boolean>;
  /** The overlay (ScopeAnalysisOverlay), for its `focusPlaque`. */
  overlayCmp: Ref<{ focusPlaque: () => void } | null>;
}

export function usePlaqueFocus(inputs: PlaqueFocusInputs) {
  const { analyses, scopeAnalysis, analysesVisible, overlayCmp } = inputs;

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

  return { focusPlaqueWhenShown, dropPlaqueFocus };
}
