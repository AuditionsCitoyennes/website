// What a phone's raised sheet does when the visitor uses the map above it:
// it lowers to its strip, so that the map the visitor reaches for is all in
// sight.
//
// Lowered by:
// - a gesture that moves the camera by hand — a drag, a pinch, a two-finger
//   turn or tilt, a double-tap zoom, the wheel —, at its start (mapbox's
//   `movestart` carrying the DOM event, GeoDrillMap's `userGesture`), once
//   per gesture: the repeats said while it glides on are not new wishes, and
//   a sheet raised again by its grip meanwhile stays raised;
// - a tap on an empty spot, or on a territory (it selects it: the strip's
//   title shows it, the camera makes its usual move).
// Not lowered by:
// - a tap on a lieu's dot: the lieu opens, and the sheet rises with it;
// - the zoom buttons (their `movestart` carries their click): they ride on
//   the sheet's top, and a lowering would carry « + » from under the finger;
// - the keys on a focused map;
// - the camera's own moves (no DOM event: no `userGesture`), a finger on the
//   sheet (its own gesture decides where it rests), a desktop, the home card.
// With a lieu open (usePanelLayout's engageMap): any gesture the visitor makes on the map,
// its repeats too, lowers the sheet once the tap that opened the lieu is
// over (OPEN_TAIL_MS), and the lieu closes as it is taken elsewhere
// (model/lieuFollow).
//
// No import but an import-free module, nothing run at load: loadable under
// node (sheetMap.test.ts).
import { OPEN_TAIL_MS } from "../model/lieuFollow";

/** What the visitor did on the map. A gesture: who moved the camera — a hand
 *  (a finger, the mouse, the wheel), the keys, or the map's zoom buttons —
 *  and whether this is the gesture's first signal (it repeats as the map
 *  moves on). A tap: what was under it. */
export type MapUse =
  | { kind: "gesture"; source: "hand" | "keys" | "controls"; first: boolean }
  | { kind: "tap"; target: "empty" | "territory" | "lieu" };

export interface SheetMapInputs {
  /** Below the desktop line: the panel is a sheet. */
  phone: boolean;
  /** The map is a card (the home page): no sheet. */
  preview: boolean;
  /** The sheet is raised (at rest or on its way there). */
  raised: boolean;
  /** A finger is on the sheet's strip: that gesture decides. */
  sheetDragging: boolean;
  /** A lieu is open. */
  lieuOpen: boolean;
  /** Since the lieu was opened, in ms. */
  sinceLieuOpenMs: number;
  use: MapUse;
}

/** Whether this use of the map lowers the phone's sheet: see the head of the
 *  file. */
export function sheetLowersOnMap(i: SheetMapInputs): boolean {
  if (!i.phone || i.preview || i.sheetDragging) return false;
  // An open lieu: any gesture once the tap that opened it is over.
  if (i.lieuOpen && i.use.kind === "gesture") return i.sinceLieuOpenMs >= OPEN_TAIL_MS;
  if (!i.raised) return false;
  if (i.use.kind === "gesture") return i.use.source === "hand" && i.use.first;
  return i.use.target !== "lieu";
}

/** Tells a gesture's first `userGesture` signal from its repeats: GeoDrillMap
 *  numbers each gesture (`seq`), and every repeat said while it glides on
 *  carries the same number. A signal without one (useNavActions' own call, a
 *  territory tapped with a lieu open) is a use of its own, and does not count
 *  as a gesture seen. */
export function createGestureFirst(): (seq?: number) => boolean {
  let last: number | null = null;
  return (seq) => {
    if (seq === undefined) return true;
    const first = seq !== last;
    last = seq;
    return first;
  };
}
