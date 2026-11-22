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
// - a map the visitor has moved since the last command is left where they
//   put it, the band with it, until the next command; so it is in the lieu
//   zone, where nothing is raised; a hand on the map waits to be let go; with
//   filters on, the filters' frame is owed.
// A finger on the sheet changes nothing: only its rest counts (`shownPx`).
import { computed, onBeforeUnmount, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { motionNow } from "@/shared/device/motion";
import type { GeoUnit } from "@/features/geo";
import type { Insets, NavState } from "../navState";
import type { MapHandle } from "../model/useCamera";
import { bandMoved, bandReframe, sheetBandInsets, type SheetFitMode } from "./sheetFit";

export interface SheetBandInputs {
  nav: NavState;
  mode: () => SheetFitMode;
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
  onBeforeUnmount(() => window.clearTimeout(laterTimer));

  /** Takes the band wanted now: only ever with a command (see the hook). */
  function apply() {
    window.clearTimeout(laterTimer);
    laterTimer = 0;
    applied.value = wanted.value;
  }
  camera.onBeforeCommand(apply);

  /** Brings the band applied in line with the one wanted, with the fit that
   *  must go with it. */
  function follow() {
    window.clearTimeout(laterTimer);
    laterTimer = 0;
    if (!bandMoved(applied.value, wanted.value)) return;
    const how = bandReframe({
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
  watch([wanted, () => inputs.hold()], follow, { flush: "post" });

  return { wanted, applied, last, apply };
}

export type SheetBand = ReturnType<typeof useSheetBand>;
