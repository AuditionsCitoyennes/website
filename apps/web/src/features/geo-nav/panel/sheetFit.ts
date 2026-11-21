// How tall a phone's raised sheet stands (« Ajusté », sheetFitSwitch): as tall
// as its head and its content need, up to the full panel. The panel's box
// never changes (useBottomSheet, GeoPanel's phone `.panel`): a short sheet is
// the full one slid down, so that only its content's height is left above the
// screen's edge. This module holds the rules alone — the offset, how a refit
// moves and where a released drag settles — on numbers measured by
// useBottomSheet.
//
// No import, nothing run at load: loadable under node (sheetFit.test.ts).

/** A raised sheet shows at least this much (rem) above its lowered strip, so
 *  that it always reads as raised: room for the wait dots, a sentence and its
 *  button, or about two rows. */
export const MIN_BODY_REM = 8;
/** Less map than this (px) left above a fitted sheet reads as a glitch: the
 *  sheet goes full instead. The least the caller may ask for (`minOffsetPx`). */
export const SNAP_FULL_PX = 48;
/** The room (rem) kept between the map's controls, gone up above a fitted
 *  sheet, and the header's tiles over the map's top (useBottomSheet's
 *  `minOffsetPx`). */
export const MAP_ROOM_MARGIN_REM = 0.5;
/** The height (rem) of the map's controls stacked in a corner (the zoom
 *  buttons over mapbox's logo) when they cannot be measured yet. */
export const MAP_CONTROLS_FALLBACK_REM = 6.5;

export type SheetFitMode = "ajuste" | "plein";

/** The switch's choices, in the DEV dialog's order (sheetFitSwitch). */
export const SHEET_FIT_MODES: readonly SheetFitMode[] = ["ajuste", "plein"];

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_SHEET_FIT: SheetFitMode = "ajuste";

export interface RaisedOffsetInputs {
  mode: SheetFitMode;
  /** The panel's box: today's raised (full) sheet. */
  fullPx: number;
  /** The head and the list's content, from the box's top, list paddings included. */
  contentPx: number;
  /** The least the raised sheet shows (its lowered strip plus MIN_BODY_REM). */
  minPx: number;
  /** A fitted sheet slid down less than this (px) goes full: the map left
   *  above it must hold the map's controls, which go up there with it, clear
   *  of the header's tiles (useBottomSheet). Never below SNAP_FULL_PX;
   *  SNAP_FULL_PX when left out. */
  minOffsetPx?: number;
  /** While something loads, the offset now: the sheet may grow, not shrink
   *  (no shrink-then-grow bounce). null: no hold. */
  heldOffset: number | null;
  /** An open audition's testimonies are on their way: its text will unfold
   *  under its line, most often past the screen, so the sheet stands full
   *  from now on rather than fitting the line and rising again once the text
   *  is in (it settles down once in, if the text turns out short). */
  expectFull?: boolean;
}

/** How far down (px) the raised sheet is slid from the full box: 0 is today's
 *  full sheet. */
export function raisedOffset(i: RaisedOffsetInputs): number {
  if (i.mode === "plein" || !(i.fullPx > 0) || i.expectFull) return 0;
  const fit = Math.min(i.fullPx, Math.max(i.contentPx, i.minPx));
  let off = i.fullPx - fit;
  if (off < Math.max(SNAP_FULL_PX, i.minOffsetPx ?? 0)) off = 0;
  if (i.heldOffset !== null) off = Math.min(off, Math.max(0, i.heldOffset));
  return Math.round(off);
}

export interface RefitMotionInputs {
  /** The box itself changed in the same measure (the address bar, a rotation). */
  fullChanged: boolean;
  /** shared/device/motion says "short" (a weak device, reduced motion asked). */
  short: boolean;
  /** An eased move of the sheet is running (a raise, a lower, an eased
   *  refit): a step in one go would cut it short, the ease is retargeted. */
  easing: boolean;
}

/** A raised sheet refitting to new content: eased like a raise, or in one
 *  step. An ease still running carries the new offset, whatever the device (a
 *  raise eases on a weak device too, and a pin's tap swaps the list as the
 *  sheet rises); a sheet at rest steps on a weak device and on a change of
 *  the box itself. */
export function refitMotion(i: RefitMotionInputs): "animate" | "snap" {
  if (i.easing) return "animate";
  if (i.short || i.fullChanged) return "snap";
  return "animate";
}

export interface SheetSettleInputs {
  /** Where the release left the sheet (its translateY, px). */
  at: number;
  /** The finger's speed at the release (px/ms, down positive). */
  v: number;
  /** The raised rest (raisedOffset). */
  raisedPx: number;
  /** The lowered rest. */
  loweredPx: number;
  /** A release faster than this follows the flick, whatever the position. */
  flick: number;
}

/** Where a released drag settles: true raised, false lowered. A flick decides
 *  by its direction; a slow release settles on the nearer rest. */
export function sheetSettle(i: SheetSettleInputs): boolean {
  if (Math.abs(i.v) > i.flick) return i.v < 0;
  return i.at < (i.raisedPx + i.loweredPx) / 2;
}
