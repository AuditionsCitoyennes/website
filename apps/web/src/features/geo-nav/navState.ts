// The one record every piece of the Témoignages experience reads and writes.
// Created once per GeoNav instance, before the composables that read it, so
// that what used to be a lazy forward reference between parts of one file (the
// outline reading the lieu zone and the scope, the pending hold reading the
// lieu zone) is a value handed in. Not a store: the home card and the page are
// the same GeoNav instance under MapStage, and this state must die with it.
//
// One unified system: the map is free pan/zoom; the SCOPE is read off the live
// view (zoom → level, centre → which unit). The panel shows the scope's children
// + a breadcrumb to fly back out. Reaching a lieu opens its testimonies.
//
// Reading a lieu vs. using the map: with a lieu open the panel belongs to the
// reader: NOTHING the map does may replace what it shows (only a crumb, or
// picking another lieu, leaves it). So the two take turns. While the user's
// hands are on the map the panel folds out of the way — on a desktop a wide
// panel slides aside until only a narrow strip of it is left, on a phone the
// sheet lowers — and the map is explored as if nothing were open. Coming back
// to the panel (a click, a key, the wheel, or resting the pointer on it)
// unfolds it exactly as it was: same lieu, same audition, same line.
//
// Beside the refs, `{ value }` boxes for the flags that are NOT reactive
// (nothing renders from them; they are read inside callbacks) and yet cross
// responsibilities: a plain `let` of one composable cannot be written by
// another. `roomNow` is bound late, by the analyses glue, once the room the
// plates need is known — the camera reads it through the box, never by
// importing the ring.
import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { Bounds, GeoUnit } from "@/features/geo";
import type { PlateRoom } from "@/features/analyses";

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** What the map reports of its view (GeoDrillMap's `viewChange`). */
export interface MapView {
  center: [number, number];
  zoom: number;
  bounds: Bounds;
  screen: Bounds;
  insets: Insets;
  byUser: boolean;
}

/** A non-reactive value shared across composables. */
export interface Box<T> {
  value: T;
}

export interface NavState {
  // Scope = the unit the viewport is currently "inside", re-derived whenever
  // the map settles or the hierarchy reloads. Its own previous value seeds the
  // span-ratio hysteresis so the scope doesn't flip levels on a small nudge
  // near a threshold.
  currentScope: ShallowRef<GeoUnit>;
  selectedPlaceId: Ref<string | null>;
  /** Desktop: a lieu is open and the user is on the map, not on the panel. */
  mapEngaged: Ref<boolean>;
  /** A phone's sheet is raised (see useBottomSheet / the panel's `.sheet-lowered`). */
  sheetOpen: Ref<boolean>;
  /** Deep among the lieux: the plateau is down, only dots stand (see onViewChange). */
  inMicroZone: Ref<boolean>;
  /** The place-detail accordion (single-open). */
  openAuditions: Ref<Set<string>>;
  /** Panel row under the pointer (or keyboard focus) — handed to the map so it
   *  runs its own hover highlight for that unit. */
  hoveredPanelId: Ref<string | null>;
  mapView: Ref<MapView | null>;

  // While a programmatic flight is in the air, view emits are suppressed and
  // mapView is STALE (the pre-click view). A mid-flight derivation — hierarchy
  // rebuild or a commune contour arriving, which on a cold cache happens
  // exactly then — would walk that old view away from the clicked unit, and
  // every flip sinks/resurrects the plateau ("dual down" on macropin clicks
  // after a refresh). So the optimistic scope is PINNED from camera command
  // to the next view emit (flight end or user gesture).
  scopePinned: Box<boolean>;
  /** When the lieu was last opened — see engageMap. */
  placeOpenedAt: Box<number>;
  /** The pointer that has just pressed "Analyses" (which hands the map the
   *  screen) is still resting on the panel: it brings the panel back only once
   *  it has left it (see onPanelPointerMove). */
  hoverReturnHeld: Box<boolean>;
  /** The last camera command's key (CameraCmd.key): bumped by setCamera. */
  cameraKey: Box<number>;
  /** The room the slabs of the territory in scope need around the plateau
   *  (null: none raised), on the screen as it is now — the analyses'
   *  (useScopeAnalysis's roomNow), bound once they are set up. */
  roomNow: Box<() => PlateRoom | null>;
}

export function createNavState(root: GeoUnit): NavState {
  return {
    currentScope: shallowRef<GeoUnit>(root),
    selectedPlaceId: ref<string | null>(null),
    mapEngaged: ref(false),
    sheetOpen: ref(false),
    inMicroZone: ref(false),
    openAuditions: ref(new Set<string>()),
    hoveredPanelId: ref<string | null>(null),
    mapView: ref<MapView | null>(null),
    scopePinned: { value: false },
    placeOpenedAt: { value: 0 },
    hoverReturnHeld: { value: false },
    cameraKey: { value: 0 },
    roomNow: { value: () => null },
  };
}
