// « Ajusté, centré » (sheetFitSwitch) on a phone: while a short sheet stands
// raised over a territory in scope, the territory is framed in the map left
// between the header's tiles and the sheet's top (sheetFit sheetBandInsets),
// not in the lowered sheet's frame, where it would stand half under the sheet.
//
// The band is the phone camera's padding while it applies (usePanelLayout's
// mapPadding; the analyses' ring stands aside, its plates are not drawn under
// a raised phone sheet), so the camera rests on the terrain in the middle of
// what is seen, exactly as under the lowered sheet — aimed from the lowered
// frame's centre instead (an offset of the logical view, as the wide desktop
// panel and the ring do), the terrain under that point moved the territory
// by tens of px. The scope is read off the same rectangle. So, like the ring,
// the band applied (`applied`) may only change together with a fit of the
// scope in the same tick — a smaller rectangle makes a child fill more of it,
// and the scope would descend at rest; a padding changed alone would also
// slide the map by itself (useMapCamera's onPaddingChange):
// - every camera command takes the band of the moment (the hook registered on
//   useCamera): the command and its padding go in the same tick, which the
//   map frames as one flight;
// - a new band (the sheet's rest moved: the list swapped, the sheet raised or
//   lowered by hand) frames the scope again: a flight still in the air is
//   retargeted (the same move, aimed anew as the list it was tapped for comes
//   in), a map at rest is eased there (in one step under short motion);
// - a new band once the tap's flight has landed (its list came in late) with
//   the raised territory still all in sight above the sheet's new top — the
//   map left there only grew, or the plateau as drawn last (`plateauBox`)
//   already clears it, as after a tap from a full list — keeps the territory
//   where the flight put it: one move per tap (« Recadrage tardif » =
//   « Rester », the default; « Recentrer » frames it again); a territory the
//   new top would cover is framed again whatever the switch says;
// - a map the visitor has moved since the last command is left where they
//   put it, the band with it, while the sheet stays raised; so it is in the
//   lieu zone, where nothing is raised. Lowered (or gone full) there, the
//   band goes alone ("drop"): the camera's padding eases back to the lowered
//   frame's, as it eases for any padding, and what the visitor had centred
//   above the sheet comes to the middle of the map now seen — never the
//   band's padding under a lowered sheet, where the analyses' ring would
//   stand under the header's tiles and the zoom buttons zoom about a point
//   high on the map. Raised short again, the map stays the visitor's and
//   the band does not come ("keep", as under « Ajusté »): a band eased in
//   alone would shrink the rectangle the scope is read off, and a child
//   filling most of the lowered map would become the scope at rest, the
//   list swapping under the visitor's finger; the next command takes it;
// - a lowered (or full) sheet takes the band off at once, whatever is still
//   on its way: no band padding under it, no move by itself seconds later;
// - a hand on the map waits to be let go; with filters on, the filters'
//   frame is owed (not at the world for a band that only grew: filters never
//   move the globe by themselves), and a late list in view stays as above;
//   the filters' dialog open over the page waits for it to close (a chip
//   typed in grows the sheet's head behind it: the filters' own frame, when
//   it comes, takes the band of its moment).
// A finger on the sheet changes nothing: only its rest counts (`shownPx`).
import { computed, onScopeDispose, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { motionNow } from "@/shared/device/motion";
import type { GeoUnit } from "@/features/geo";
import type { Insets, NavState } from "../navState";
import type { MapHandle } from "../model/useCamera";
import {
  bandHolds,
  bandMoved,
  bandReframe,
  boxInBand,
  sheetBandInsets,
  type PlateauBox,
  type SheetFitMode,
  type SheetLateMode,
} from "./sheetFit";

export interface SheetBandInputs {
  nav: NavState;
  mode: () => SheetFitMode;
  /** A band that only grew under a landed map: left, or framed again. */
  late: () => SheetLateMode;
  /** The filters' dialog stands over the page. */
  dialogOpen: () => boolean;
  isDesktop: Ref<boolean>;
  /** The map is a card (the home page): no sheet over it. */
  preview: Ref<boolean | undefined>;
  /** The raised sheet stands shorter than the full panel (useBottomSheet). */
  fitted: Ref<boolean>;
  /** How much of the page's bottom the sheet covers at rest (GeoNav's sheetShownPx). */
  shownPx: Ref<number>;
  viewportH: Ref<number>;
  /** How far down the header's tiles reach over the map (useAnalysesRing). */
  headerClearPx: Ref<number>;
  /** The camera's room from the screen's sides (its padding's). */
  sidePx: () => number;
  /** Something the sheet shows is on its way (GeoNav's sheetFitHold). */
  hold: () => boolean;
  /** A lieu is open and the reader is on the panel (useScope). */
  readingPlace: () => boolean;
  /** Where the scope's raised plateau stood on screen at the last frame
   *  drawn, standing at full height; null: none in sight (GeoNav, from the
   *  map's frame bus). */
  plateauBox: () => PlateauBox | null;
  listMode: Ref<boolean>;
  mapCmp: Ref<MapHandle | null>;
  /** The band applied: GeoNav's, the phone camera's padding while set
   *  (usePanelLayout), the ring set aside (useAnalysesRing). */
  applied: ShallowRef<Insets | null>;
  camera: {
    onBeforeCommand: (hook: () => void) => void;
    flyToUnit: (unit: GeoUnit, animate: boolean) => void;
    scheduleFilterFrame: (owed?: boolean) => void;
    movedSinceCommand: () => boolean;
  };
}

export function useSheetBand(inputs: SheetBandInputs) {
  const { nav, isDesktop, preview, fitted, shownPx, viewportH, headerClearPx } = inputs;
  const { applied, camera, mapCmp, listMode } = inputs;
  const { currentScope, selectedPlaceId, sheetOpen, inMicroZone } = nav;

  let remPx = 0;
  function rem(): number {
    if (!remPx) remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return remPx;
  }

  /** The band the sheet asks for now (null: none, the usual frame). */
  const wanted = computed<Insets | null>(() =>
    preview.value
      ? null
      : sheetBandInsets({
          mode: inputs.mode(),
          phone: !isDesktop.value,
          raised: sheetOpen.value,
          fitted: fitted.value,
          lieuOpen: selectedPlaceId.value !== null,
          shownPx: shownPx.value,
          viewportH: viewportH.value,
          headerClearPx: headerClearPx.value,
          sidePx: inputs.sidePx(),
          remPx: rem(),
        }),
  );

  /** The last decision made for a band (the testing probe's). */
  const last = shallowRef<string>("");

  let laterTimer = 0;
  onScopeDispose(() => window.clearTimeout(laterTimer));

  /** A band left as applied (« Rester »: "stay"), and the one it was left
   *  for: asked again with nothing new (the hold ending, say), it stays. */
  let stayed = false;
  let stayedFor: Insets | null = null;
  /** Something the sheet shows was on its way since the last command: a band
   *  changed since came with what was late. Only the tap's own late content:
   *  cleared once its band is decided (left, or framed by a command), and
   *  when the visitor raises or lowers the sheet, whose band is theirs. */
  let heldSinceCommand = false;
  watch(sheetOpen, () => (heldSinceCommand = inputs.hold()), { flush: "sync" });

  /** Takes the band wanted now: only ever with a command (see the hook). */
  function apply() {
    window.clearTimeout(laterTimer);
    laterTimer = 0;
    stayed = false;
    heldSinceCommand = inputs.hold();
    applied.value = wanted.value;
  }
  camera.onBeforeCommand(apply);

  /** Brings the band applied in line with the one wanted, with the fit that
   *  must go with it. */
  function follow() {
    window.clearTimeout(laterTimer);
    laterTimer = 0;
    if (inputs.hold()) heldSinceCommand = true;
    const want = wanted.value;
    if (!bandMoved(applied.value, want)) {
      stayed = false;
      return;
    }
    if (stayed && !bandMoved(stayedFor, want)) return;
    stayed = false;
    const how = bandReframe({
      dialog: inputs.dialogOpen(),
      toNone: want === null,
      fromNone: applied.value === null && want !== null,
      grewOnly: bandHolds(applied.value, want),
      clearsBand: want !== null && boxInBand(inputs.plateauBox(), want),
      world: currentScope.value.levelKey === "world",
      afterHold: heldSinceCommand,
      late: inputs.late(),
      inFlight: nav.scopePinned.value,
      hold: inputs.hold(),
      readingPlace: inputs.readingPlace(),
      microZone: inMicroZone.value,
      listMode: listMode.value,
      inHands: !!mapCmp.value?.inUserHands(),
      movedSinceCommand: camera.movedSinceCommand(),
      short: motionNow() === "short",
    });
    last.value = how;
    switch (how) {
      case "dialog": // its closing runs this again
        return;
      case "drop":
        // No fit may come: the band goes alone, the padding eased
        // (useMapCamera's onPaddingChange), owed under a hand.
        applied.value = want;
        return;
      case "stay":
        stayed = true;
        stayedFor = want;
        heldSinceCommand = inputs.hold(); // the late content's band is decided
        return;
      case "filter":
        camera.scheduleFilterFrame(true); // its command takes the band
        return;
      case "later":
        laterTimer = window.setTimeout(follow, 250);
        return;
      case "hold":
      case "keep":
      case "wait": // the hold's end runs this again
        return;
      case "retarget":
      case "fit":
        camera.flyToUnit(currentScope.value, true); // setCamera applies the band
        return;
      case "instant":
        camera.flyToUnit(currentScope.value, false);
        return;
    }
  }
  watch([wanted, () => inputs.hold(), () => inputs.dialogOpen()], follow, { flush: "post" });

  return { wanted, applied, last, apply };
}

export type SheetBand = ReturnType<typeof useSheetBand>;
