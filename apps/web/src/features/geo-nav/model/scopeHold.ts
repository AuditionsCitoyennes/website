// The hold: the zone a selection holds. No import: loadable under node
// (scopeHold.test.ts).
//
// The scope is read off the view (geo's scopeForView): a branch is kept while
// its box holds the view's centre. A unit framed by a tap spans about 0.8 of
// the view, so on a 360 px phone (a view 288 px wide) the centre leaves its
// box after 115 px of thumb, and the zone just chosen, half of it still on
// screen, was replaced by a neighbour — its plateau sinking under the finger,
// the neighbour's rising, and the same again on the way back.
//
// So a zone that was SELECTED — the scope a camera command was sent for and
// landed on: a tap on a row, on the map, a crumb, the boot's frame — is held:
// while it is the scope and meaningfully in view (geo's holdInView: a tenth
// of its box in the view, or a tenth of the view covered by it — by its
// contour when that is loaded, else by its box), a pan does not replace it.
// Zooming out past it, zooming in onto one of its children, or panning it
// out of view changes the scope as it always did. A scope the view alone
// arrived at is not held: it follows the view, so the way back to the held
// zone restores it.
//
// The zone is held on a touch device (its main pointer is coarse: a phone, a
// tablet); a mouse device follows the view's centre, where a framed zone is
// wide and the centre rule already leaves room (useScope).

/**
 * Which zone is held: the scope a camera command landed on.
 *
 * `view(scopeId, commanded, byUser)`: the map reports a view, `scopeId` the
 * scope as it is before the view is read. `commanded`: it is the first view
 * since a camera command — the command's scope (the unit tapped, written
 * ahead of the flight) is held from here, in place of any other. When the
 * flight landed by itself (not `byUser`), the scope read off that landing is
 * the one held: `derived(scopeId)`, called with each scope read off a view,
 * takes it once — the boot's frame is sent with the world as the scope and
 * lands on France. A user who took the camera over in flight keeps the
 * command's unit held, wherever the view then is.
 *
 * `of(scope)`: the unit to hold in a derivation — the scope itself while it
 * is the held zone, else null. The zone stays the held one when the scope
 * leaves it: coming back to it holds it again; only another command replaces
 * it.
 */
export function createScopeHold() {
  let held: string | null = null;
  /** A command's flight has landed by itself and its view is not read yet. */
  let settling = false;
  return {
    view(scopeId: string, commanded: boolean, byUser: boolean) {
      if (commanded) {
        held = scopeId;
        settling = !byUser;
      } else if (byUser) settling = false;
    },
    derived(scopeId: string) {
      if (!settling) return;
      settling = false;
      held = scopeId;
    },
    of<T extends { id: string }>(scope: T): T | null {
      return held !== null && scope.id === held ? scope : null;
    },
    id: () => held,
  };
}

export type ScopeHold = ReturnType<typeof createScopeHold>;
