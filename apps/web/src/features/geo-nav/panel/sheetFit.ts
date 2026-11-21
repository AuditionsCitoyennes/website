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
 *  sheet goes full instead. */
export const SNAP_FULL_PX = 48;
/** A refit this small (px)… */
export const FOLLOW_PX = 48;
/** …this soon (ms) after the previous one follows the content in one step:
 *  an audition unfolding (its height tween) is followed frame by frame,
 *  not chased by an ease of its own. */
export const FOLLOW_MS = 120;

export type SheetFitMode = "ajuste" | "plein";

export interface RaisedOffsetInputs {
  mode: SheetFitMode;
  /** The panel's box: today's raised (full) sheet. */
  fullPx: number;
  /** The head and the list's content, from the box's top, list paddings included. */
  contentPx: number;
  /** The least the raised sheet shows (its lowered strip plus MIN_BODY_REM). */
  minPx: number;
  /** While something loads, the offset now: the sheet may grow, not shrink
   *  (no shrink-then-grow bounce). null: no hold. */
  heldOffset: number | null;
}

/** How far down (px) the raised sheet is slid from the full box: 0 is today's
 *  full sheet. */
export function raisedOffset(i: RaisedOffsetInputs): number {
  if (i.mode === "plein" || !(i.fullPx > 0)) return 0;
  const fit = Math.min(i.fullPx, Math.max(i.contentPx, i.minPx));
  let off = i.fullPx - fit;
  if (off < SNAP_FULL_PX) off = 0;
  if (i.heldOffset !== null) off = Math.min(off, Math.max(0, i.heldOffset));
  return Math.round(off);
}

export interface RefitMotionInputs {
  /** The change of the offset (px). */
  deltaPx: number;
  /** Since the previous refit (ms). */
  sinceLastMs: number;
  /** The box itself changed in the same measure (the address bar, a rotation). */
  fullChanged: boolean;
  /** shared/device/motion says "short" (a weak device, reduced motion asked). */
  short: boolean;
}

/** A raised sheet refitting to new content: eased like a raise, or in one step. */
export function refitMotion(i: RefitMotionInputs): "animate" | "snap" {
  if (i.short || i.fullChanged) return "snap";
  if (Math.abs(i.deltaPx) < FOLLOW_PX && i.sinceLastMs < FOLLOW_MS) return "snap";
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
