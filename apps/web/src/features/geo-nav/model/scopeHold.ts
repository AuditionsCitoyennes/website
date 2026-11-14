// The hold: the zone a selection holds, and the switch that says whether a
// pan may take it away. No import but Vue's ref: loadable under node
// (scopeHold.test.ts, devOptions.test.ts).
//
// The scope is read off the view (geo's scopeForView): a branch is kept while
// its box holds the view's centre. A unit framed by a tap spans about 0.8 of
// the view, so on a 360 px phone (a view 288 px wide) the centre leaves its
// box after 115 px of thumb, and the zone just chosen, half of it still on
// screen, was replaced by a neighbour — its plateau sinking under the finger,
// the neighbour's rising, and the same again on the way back.
//
// So a zone that was SELECTED — the scope a camera command was sent for: a
// tap on a row, on the map, a crumb, the boot's frame — is held: while it is
// the scope and meaningfully in view (geo's keptInView: a tenth of its box in
// the view, or its box a tenth of the view), a pan does not replace it.
// Zooming out past it, zooming in onto one of its children, or panning it
// out of view changes the scope as it always did. A scope the view alone
// arrived at is not held: it follows the view, so the way back to the held
// zone restores it.
//
// `ac:scope-drag`, compared live in the builds with the testing tools (the
// dev server and staging: __TEST_TOOLS__, vite.config), kept in localStorage
// and drawn as the Témoignages page's DEV row « Glisser la carte ». Read at
// each derivation: no reload.
// - "auto" (the default): "keep" on a touch device (its main pointer is
//   coarse: a phone, a tablet), "follow" on a mouse device, where a framed
//   zone is wide and the centre rule already leaves room.
// - "keep": the selected zone is held on every device.
// - "follow": nothing is held: the scope follows the view's centre, as
//   before.
// Production has neither key nor row: DEFAULT_SCOPE_DRAG.

import { ref } from "vue";

export type ScopeDragMode = "auto" | "keep" | "follow";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_SCOPE_DRAG: ScopeDragMode = "auto";

export const SCOPE_DRAG_MODES: readonly ScopeDragMode[] = ["auto", "keep", "follow"];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The mode now (a ref: the DEV dialog redraws its row from it). A build
 *  without the testing tools reads no key: the default. */
export const scopeDragMode = ref<ScopeDragMode>(
  __TEST_TOOLS__
    ? stored("ac:scope-drag", SCOPE_DRAG_MODES, DEFAULT_SCOPE_DRAG)
    : DEFAULT_SCOPE_DRAG,
);

/** Another mode: kept, and in force from the next view the map reports. */
export function setScopeDragMode(mode: ScopeDragMode) {
  if (!__TEST_TOOLS__) return;
  scopeDragMode.value = mode;
  try {
    localStorage.setItem("ac:scope-drag", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** Whether a pan keeps the selected zone under `mode`. `coarse`: the
 *  device's main pointer is a finger (matchMedia "(pointer: coarse)"). */
export function dragKeepsZone(mode: ScopeDragMode, coarse: boolean): boolean {
  if (mode === "keep") return true;
  if (mode === "follow") return false;
  return coarse;
}

/**
 * Which zone is held. `landed(id)`: a camera command has landed (or the user
 * took the camera over in flight) and `id` is the scope it was sent for —
 * that zone is held from here, in place of any other. `of(scope)`: the unit
 * to hold in a derivation — the scope itself while it is the held zone, else
 * null. The zone stays the held one when the scope leaves it: coming back to
 * it holds it again; only another command replaces it.
 */
export function createScopeHold() {
  let held: string | null = null;
  return {
    landed(scopeId: string) {
      held = scopeId;
    },
    of<T extends { id: string }>(scope: T): T | null {
      return held !== null && scope.id === held ? scope : null;
    },
    id: () => held,
  };
}

export type ScopeHold = ReturnType<typeof createScopeHold>;
