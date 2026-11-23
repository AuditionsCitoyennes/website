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

/** "ajuste": as tall as the content, the camera framed as under a full
 *  sheet; "centre": as tall as the content, and what the map shows aimed into
 *  the map left above a short sheet — an open lieu's pin (`lieuAimPx`), the
 *  raised territory in scope otherwise (`sheetBandInsets`, useSheetBand);
 *  "plein": always full. */
export type SheetFitMode = "ajuste" | "centre" | "plein";

/** The switch's choices, in the DEV dialog's order (sheetFitSwitch). */
export const SHEET_FIT_MODES: readonly SheetFitMode[] = ["ajuste", "centre", "plein"];

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_SHEET_FIT: SheetFitMode = "ajuste";

/** « Ajusté, centré », the sheet's height changing once a tap's flight has
 *  landed (its list came in late), the raised territory still all in sight
 *  above the sheet's new top (the map left there only grew, or the plateau
 *  as drawn last already clears it — a tap from a full list, say):
 *  "rester" — the territory stays where the flight put it (one move per
 *  tap); "recentrer" — it is centred in the new band by a second, eased move
 *  (useSheetBand). A territory the sheet's new top would cover is framed
 *  again whatever the switch says. */
export type SheetLateMode = "rester" | "recentrer";

/** The switch's choices, in the DEV dialog's order (sheetFitSwitch). */
export const SHEET_LATE_MODES: readonly SheetLateMode[] = ["rester", "recentrer"];

/** The rule of a build without the testing tools, and the switch's default. */
export const DEFAULT_SHEET_LATE: SheetLateMode = "rester";

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
  /** An audition opened with its lieu from the lieu's pin (waitsForText),
   *  its text on its way: the offset the sheet stands at now — raised, its
   *  raised offset; on its way up, its lowered one —, kept as it is, so that
   *  the sheet moves once, when the text is in, straight to the height it
   *  needs. It comes before `expectFull`. null: no wait. */
  waitAt?: number | null;
}

/** How far down (px) the raised sheet is slid from the full box: 0 is today's
 *  full sheet. */
export function raisedOffset(i: RaisedOffsetInputs): number {
  if (i.mode === "plein" || !(i.fullPx > 0)) return 0;
  if (i.waitAt != null && i.waitAt >= 0) return Math.round(Math.min(i.waitAt, i.fullPx));
  if (i.expectFull) return 0;
  const fit = Math.min(i.fullPx, Math.max(i.contentPx, i.minPx));
  let off = i.fullPx - fit;
  if (off < Math.max(SNAP_FULL_PX, i.minOffsetPx ?? 0)) off = 0;
  if (i.heldOffset !== null) off = Math.min(off, Math.max(0, i.heldOffset));
  return Math.round(off);
}

/** How long (ms) a sheet waits for the text of an audition its lieu's pin
 *  opened (waitsForText) before it goes on as for any open audition (full
 *  while the text is on its way, `expectFull`): on a slow link the sheet does
 *  not stand still for long after the tap. */
export const TEXT_WAIT_MS = 800;

export interface TextWaitInputs {
  /** The open lieu was opened from its pin with an audition to open at once
   *  (model/pinOpen's "premiere", or a lieu of one under it), and the wait
   *  has not ended yet (TEXT_WAIT_MS, or the text came in once). */
  pinOpened: boolean;
  /** One of its auditions is open. */
  auditionOpen: boolean;
  /** The open audition's text is on its way (its testimonies, or the lieu's
   *  list its line is in). */
  textPending: boolean;
  /** The lieu's list is on its way (the server's lazy path: its top opens
   *  once it is listed, model/lieuSingle's AWAIT_LIST). */
  listPending: boolean;
}

/** Whether the raised sheet holds still (`waitAt`) while the audition a
 *  pin opened is on its way: not knowing the text's height, it neither
 *  stands full first nor fits the line alone and rises again — it moves once,
 *  the text in. Before the audition opens, only while its lieu's list is
 *  coming (the lazy path: its top opens once listed). */
export function waitsForText(i: TextWaitInputs): boolean {
  if (!i.pinOpened) return false;
  return i.auditionOpen ? i.textPending : i.listPending;
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

export interface LieuAimInputs {
  mode: SheetFitMode;
  /** A phone, a lieu open, its sheet raised. */
  lieuRaised: boolean;
  /** The raised sheet stands shorter than the full panel. */
  fitted: boolean;
  /** How much of the screen's bottom the raised sheet covers at rest (px). */
  shownPx: number;
  /** Something the sheet shows is on its way (useBottomSheet's hold). */
  hold: boolean;
  /** The sheet stands full while an opened audition's text is on its way. */
  expectFull: boolean;
  /** The aim decided last. */
  prev: number | null;
}

/** « Ajusté, centré »: how much of the screen's bottom the camera keeps clear
 *  of an open lieu's pin (px), so that the pin stands in the map left above a
 *  short sheet — or null: the strip at the top of the map, as under a full
 *  sheet. Kept as it was while what the sheet shows loads (the sheet's height
 *  is not known yet: the map moves once, when it is); the top strip as soon as
 *  the sheet is to stand full. */
export function lieuAimPx(i: LieuAimInputs): number | null {
  if (i.mode !== "centre" || !i.lieuRaised || i.expectFull) return null;
  if (i.hold) return i.prev;
  return i.fitted && i.shownPx > 0 ? Math.round(i.shownPx) : null;
}

/** The map left above a short sheet, as the camera frames into it (insets
 *  from the page's edges, px). */
export interface BandInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The room (px) kept between the raised territory and the band's edges: the
 *  header's tiles above, the sheet's top below. */
export const BAND_MARGIN_PX = 12;
/** A band shorter than this (rem) is no room to frame a territory in: the
 *  camera frames as under « Ajusté » then. */
export const MIN_BAND_REM = 10;

export interface SheetBandInputs {
  mode: SheetFitMode;
  /** Below the desktop line: the panel is a sheet. */
  phone: boolean;
  /** The sheet is raised (at rest or on its way there: never a drag). */
  raised: boolean;
  /** The raised sheet stands shorter than the full panel. */
  fitted: boolean;
  /** A lieu is open: its pin is aimed by the camera's padding (lieuAimPx). */
  lieuOpen: boolean;
  /** How much of the page's bottom the raised sheet covers at rest (px): its
   *  rest target, never where a finger holds it. */
  shownPx: number;
  /** The page's height (px). */
  viewportH: number;
  /** How far down the header's tiles reach over the map (px). */
  headerClearPx: number;
  /** The camera's own room from the screen's sides (px). */
  sidePx: number;
  /** The root's font size (px). */
  remPx: number;
}

/** « Ajusté, centré »: the rectangle a territory in scope is framed in while
 *  a short sheet stands raised — the map left between the header's tiles and
 *  the sheet's top, a margin inside each —, or null: framed as under
 *  « Ajusté » (the lowered sheet's frame, the analyses' ring's). Only a
 *  sheet's rest decides it: a drag changes nothing. */
export function sheetBandInsets(i: SheetBandInputs): BandInsets | null {
  if (i.mode !== "centre" || !i.phone || !i.raised || !i.fitted || i.lieuOpen) return null;
  if (!(i.shownPx > 0) || !(i.viewportH > 0)) return null;
  const top = Math.round(i.headerClearPx + BAND_MARGIN_PX);
  const bottom = Math.round(i.shownPx + BAND_MARGIN_PX);
  if (i.viewportH - top - bottom < MIN_BAND_REM * i.remPx) return null;
  return { top, bottom, left: Math.round(i.sidePx), right: Math.round(i.sidePx) };
}

/** Whether band `b` holds band `a` (each edge of `b` as far out as `a`'s, or
 *  less than `tolPx` in): a map that only grew. Never with none. */
export function bandHolds(a: BandInsets | null, b: BandInsets | null, tolPx = 16): boolean {
  if (a === null || b === null) return false;
  return (
    b.top <= a.top + tolPx &&
    b.bottom <= a.bottom + tolPx &&
    b.left <= a.left + tolPx &&
    b.right <= a.right + tolPx
  );
}

/** Where the raised plateau stands on screen (its silhouette's box, px from
 *  the map's top left corner), and the map's size. */
export interface PlateauBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

/** Whether the plateau at `box` already stands inside band `b` (each side
 *  past the band's edge by less than `tolPx`: the band's own margin), so that
 *  the sheet's top and the header's tiles leave it all in sight. Never
 *  without a box or a band. */
export function boxInBand(
  box: PlateauBox | null,
  b: BandInsets | null,
  tolPx = BAND_MARGIN_PX,
): boolean {
  if (!box || !b || !(box.w > 0) || !(box.h > 0)) return false;
  return (
    box.minY >= b.top - tolPx &&
    box.maxY <= box.h - b.bottom + tolPx &&
    box.minX >= b.left - tolPx &&
    box.maxX <= box.w - b.right + tolPx
  );
}

/** Whether the band moved enough to frame again: null against a band always
 *  does; otherwise an edge moving more than `tolPx`. */
export function bandMoved(a: BandInsets | null, b: BandInsets | null, tolPx = 16): boolean {
  if (a === null || b === null) return a !== b;
  return (
    Math.abs(a.top - b.top) > tolPx ||
    Math.abs(a.bottom - b.bottom) > tolPx ||
    Math.abs(a.left - b.left) > tolPx ||
    Math.abs(a.right - b.right) > tolPx
  );
}

export interface BandReframeInputs {
  /** The filters' dialog stands over the page: the map behind it waits for
   *  it to close (what the filters change is framed by their own frame). */
  dialog: boolean;
  /** The band wanted now is none (the sheet lowered, or full): the camera's
   *  padding must not stay the band's. */
  toNone: boolean;
  /** No band is applied and one is wanted (the sheet raised short, or come
   *  down from full). */
  fromNone: boolean;
  /** The band wanted holds the one applied (`bandHolds`): the map left above
   *  the sheet only grew, the territory framed in it is still all in sight. */
  grewOnly: boolean;
  /** The raised plateau, as drawn last, already stands inside the band
   *  wanted (`boxInBand`): all in sight above the sheet's new top. */
  clearsBand: boolean;
  /** The scope is the world: with filters on, the map moves there only when
   *  the sheet would cover it (useCamera's filter frame never moves it). */
  world: boolean;
  /** Something the sheet shows was on its way since the last command (its
   *  list came in late): a band that only grew is then the late content's. */
  afterHold: boolean;
  /** What such a band does under a landed map (SheetLateMode). */
  late: SheetLateMode;
  /** A camera command's flight is still in the air. */
  inFlight: boolean;
  /** Something the sheet shows is on its way (useBottomSheet's hold): its
   *  height is not known yet. */
  hold: boolean;
  /** A lieu is open and read (the scope holds still). */
  readingPlace: boolean;
  /** Deep in the lieu zone: nothing raised, the scope held. */
  microZone: boolean;
  /** Filters on: the map frames the visitor's country (useCamera's filter frame). */
  listMode: boolean;
  /** A finger or the mouse is on the map. */
  inHands: boolean;
  /** The visitor has moved the map since the last command. */
  movedSinceCommand: boolean;
  /** shared/device/motion says "short" (a weak device, reduced motion). */
  short: boolean;
  /** The sheet came down because the visitor used the map (sheetMap.ts),
   *  and no camera command has been given since. */
  byMap?: boolean;
}

/** What a new band asks of the camera (useSheetBand), the band applied
 *  changing only with a fit of the scope in the same tick, or alone when no
 *  fit may come: "dialog" — asked again once the filters' dialog closes;
 *  "hold" — left for the next command where the scope holds still (the lieu
 *  read, the lieu zone: nothing raised to frame); "filter" — the filters'
 *  frame owed; "later" — asked again once the map is let go; "keep" — the
 *  map left where the visitor put it, the band as applied (the sheet still
 *  raised; none when raised short again after a lowering: a band eased in
 *  alone would shrink the rectangle the scope is read off, and a child
 *  would become the scope at rest; the sheet lowered by the visitor's use
 *  of the map: the camera theirs, nothing moved by itself), until the next
 *  command; "drop" — no fit may come and the band wanted is none (the sheet
 *  lowered after the visitor moved the map, or in the lieu zone): the band
 *  goes alone, the map easing to the lowered frame's padding as it eases
 *  for any padding (what the visitor centred above the sheet comes to the
 *  middle of the map they now see, the analyses' ring and the zoom's centre
 *  with it); "wait" — the sheet's content is on its way, framed once it is
 *  in; "retarget" — the flight in the air framed anew; "stay" — a landed map
 *  whose band only grew as the sheet's late content came in, left as it is
 *  under « Rester » (the band as applied); "fit" / "instant" — the map at
 *  rest framed again, eased or in one step. */
export type BandReframe =
  | "dialog"
  | "hold"
  | "filter"
  | "later"
  | "keep"
  | "drop"
  | "wait"
  | "retarget"
  | "stay"
  | "fit"
  | "instant";

export function bandReframe(i: BandReframeInputs): BandReframe {
  if (i.dialog) return "dialog";
  // Lowered by the visitor's own use of the map: the camera is theirs, and
  // nothing moves it by itself — the band stays the camera's padding under
  // the lowered sheet until the next command (or a raise) takes it off.
  if (i.byMap && i.toNone) return "keep";
  if (i.readingPlace || i.microZone) return i.toNone ? "drop" : "hold";
  // A late list in, the flight landed, the territory still all in sight.
  const lateStays =
    (i.grewOnly || i.clearsBand) && i.afterHold && i.late === "rester" && !i.inFlight && !i.hold;
  if (i.listMode) return lateStays || (i.world && i.grewOnly && !i.inFlight) ? "stay" : "filter";
  if (i.inHands) return "later";
  if (i.movedSinceCommand) return i.toNone ? "drop" : "keep";
  if (i.inFlight) return "retarget";
  if (i.hold && !i.toNone) return "wait";
  if (lateStays) return "stay";
  return i.short ? "instant" : "fit";
}
