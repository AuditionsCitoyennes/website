// Where the map's loading curtain draws France, its spinner and its words.
// Two components draw that curtain, one after the other: MapStage's
// StageLoading while the map's code is still coming, then GeoNav's boot
// curtain once it is in. Both draw shared/ui/MapCurtain.vue, which reads
// these rules with the same inputs (the curtain's box, the 900 px line, the
// card or the page, a fixed sheet strip, the device's motion), so the
// hand-over from one to the other moves nothing.
//
// France goes where the live map frames it at the moment the curtain starts
// leaving (GeoNav's camera: metropolitan France fitted in the map's box less
// the camera's padding), so the curtain's fade onto the map moves nothing
// either. That moment differs with the motion (shared/device/motion,
// features/map useMapCamera.beginIntro): under "full" the map is shown flat,
// then tilts to 45° in its 0.9 s entrance; under "short" it tilts in one step
// before it is shown.
// - "carte": as the map is shown, flat on the globe under "full", tilted
//   under "short", its outline projected as the camera draws it;
// - "plat": the flat drawing, centred on the tilted map's France and as wide;
// - "avant": the places each stage used before (StageLoading: 10 % in from
//   the box's edges; the boot curtain: the same less the panel's side or the
//   sheet's strip), with its words centred as before.
// The default is "carte"; the others stay behind the testing switch
// (bootPosterSwitch.ts).
//
// How wide the map draws France, and where in the padded box, were measured
// on the live camera (2026-11-23, dev 828c15d: the boot framing, globe at
// zoom 3.3–5.4, at seven screen sizes from 360×740 to 1920×1080; flat at the
// curtain's first leaving frame under `ac:tier=full`, tilted once settled) and
// are pinned in curtainFrame.test.ts. A change to the camera's framing or to
// the panel's widths moves the map's France: measure again.
//
// Pure, no DOM: loadable from the entry and under node (curtainFrame.test.ts).
import type { Motion } from "../device/motion";

/** The desktop panel's width (px) at rest, and the room the camera keeps
 *  beside it (geo-nav/panel/usePanelLayout re-exports both). */
export const PANEL_BASE_PX = 480; // 30rem
export const PANEL_GAP_PX = 40;
/** A phone's camera keeps this much room (px) from the screen's sides. */
export const PHONE_SIDE_PX = 36;
/** The phone sheet's strip at boot (px), home-indicator inset not included:
 *  a constant, so that both curtains read the same value (the panel measures
 *  its own once it is in). */
export const CURTAIN_PEEK_PX = 70;

/** How the curtain draws France: tilted like the map, flat on the map's
 *  France, or where each stage drew it before. */
export type BootPoster = "carte" | "plat" | "avant";
/** The switch's choices, in the DEV dialog's order. */
export const BOOT_POSTERS: readonly BootPoster[] = ["carte", "plat", "avant"];
/** A build without the testing tools draws this one; the switch's default. */
export const DEFAULT_BOOT_POSTER: BootPoster = "carte";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A rectangle in the curtain's box (px from its top-left corner). */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The camera's padding at boot: the home page's card, a desktop's narrow
 *  side panel, a phone's lowered sheet (its strip `peekPx` high, safe area
 *  included). geo-nav/panel/usePanelLayout's `mapPadding` returns these. */
export function insetsFor(o: { desktop: boolean; preview: boolean; peekPx: number }): Insets {
  // In mapPadding's key order (the camera compares paddings by their JSON).
  if (o.preview) return { top: 24, bottom: 24, left: 24, right: 24 };
  if (o.desktop) return { top: 60, bottom: 60, left: 60, right: PANEL_BASE_PX + PANEL_GAP_PX };
  return { top: 30, bottom: o.peekPx + 20, left: PHONE_SIDE_PX, right: PHONE_SIDE_PX };
}

/** The part of the box the camera frames France in. */
export function inSight(w: number, h: number, i: Insets): Rect {
  return {
    left: i.left,
    top: i.top,
    width: Math.max(0, w - i.left - i.right),
    height: Math.max(0, h - i.top - i.bottom),
  };
}

/** Between the points, held past the ends. */
export function readTable(t: readonly (readonly [number, number])[], r: number): number {
  if (r <= t[0][0]) return t[0][1];
  for (let k = 1; k < t.length; k++) {
    const [r1, v1] = t[k];
    if (r <= r1) {
      const [r0, v0] = t[k - 1];
      return v0 + ((v1 - v0) * (r - r0)) / (r1 - r0);
    }
  }
  return t[t.length - 1][1];
}

/** Measured, the map tilted: its France's width over the framed width, by
 *  that width over the box's height (360×740, 412×915, 390×844, 820×1180, 1440×900,
 *  1280×720, 1920×1080). Read between the points, held past the ends. */
export const FRANCE_WIDTH_SHARE: readonly (readonly [number, number])[] = [
  [0.3716, 0.6974],
  [0.3768, 0.6972],
  [0.3892, 0.6962],
  [0.6339, 0.6794],
  [1.0318, 0.6538],
  [1.0711, 0.6516],
  [1.3221, 0.647],
];

export const franceWidthShare = (r: number) => readTable(FRANCE_WIDTH_SHARE, r);

/** Measured, tilted: how far right of the framed part's centre the map's
 *  France stands, as a share of its width (within 0.5 px at the seven sizes). */
export const franceShift = (r: number) => 0.0316 + 0.0235 * r;

/** Measured, tilted: how far below the framed part's middle the map's
 *  France stands, as a share of its height (a few px at most). */
export const FRANCE_DROP: readonly (readonly [number, number])[] = [
  [0.3716, -0.0011],
  [0.3892, -0.0014],
  [0.6339, -0.0023],
  [1.0318, -0.0048],
  [1.0711, -0.0052],
  [1.3221, 0.0029],
];

/** Measured, the map shown flat (full motion): France's outline is as wide
 *  as this share of the framed width (by that width over the box's height,
 *  as FRANCE_WIDTH_SHARE)... */
export const FLAT_WIDTH_SHARE: readonly (readonly [number, number])[] = [
  [0.3716, 0.7287],
  [0.3768, 0.72873],
  [0.3892, 0.72879],
  [0.6339, 0.73008],
];
/** ...unless that makes it higher than this share of the framed height (the
 *  desktops: the fit is held by the height there). */
export const FLAT_HEIGHT_SHARE = 0.7577;
/** The flat map's France: its height over its width (the globe, seen from
 *  above: the same at every measured size). */
export const FLAT_ASPECT = 0.9401;
/** Measured, flat: how far right of the framed part's centre France stands,
 *  as a share of France's width (the camera's centre is not the outline's). */
export const FLAT_SHIFT: readonly (readonly [number, number])[] = [
  [0.3716, 0.03973],
  [0.3892, 0.03969],
  [0.6339, 0.03918],
  [1.0318, 0.03854],
  [1.0711, 0.03863],
  [1.3221, 0.03854],
];
/** Measured, flat: how far below the framed part's middle France stands, as
 *  a share of its height. */
export const FLAT_DROP: readonly (readonly [number, number])[] = [
  [0.3716, -0.00183],
  [0.3768, -0.00189],
  [0.3892, -0.00202],
  [0.6339, -0.0037],
  [1.0318, -0.00702],
  [1.0711, -0.00686],
  [1.3221, -0.00651],
];

/** The map's France on screen: its outline's bounding box, centred. */
export interface FranceAim {
  /** The bounding box's centre (px, in the box). */
  x: number;
  y: number;
  /** The bounding box's width (px). */
  width: number;
}

/** The map's France once tilted, `view` the framed part of a box `boxH` high. */
export function franceAim(view: Rect, boxH: number): FranceAim {
  const r = boxH > 0 ? view.width / boxH : 0;
  return {
    x: view.left + view.width / 2 + view.width * franceShift(r),
    y: view.top + view.height * (0.5 + readTable(FRANCE_DROP, r)),
    width: view.width * franceWidthShare(r),
  };
}

/** The map's France shown flat (full motion), as franceAim. */
export function flatFranceAim(view: Rect, boxH: number): FranceAim {
  const r = boxH > 0 ? view.width / boxH : 0;
  const width = Math.min(
    view.width * readTable(FLAT_WIDTH_SHARE, r),
    (view.height * FLAT_HEIGHT_SHARE) / FLAT_ASPECT,
  );
  return {
    x: view.left + view.width / 2 + width * readTable(FLAT_SHIFT, r),
    y: view.top + view.height * (0.5 + readTable(FLAT_DROP, r)),
    width,
  };
}

/** The poster's drawing (shared/ui/francePoster.ts): its viewBox, and the
 *  bounding box of its outline inside it (pinned in curtainFrame.test.ts). */
export const POSTER_W = 600;
export const POSTER_H = 579;
export const POSTER_OUTLINE = { left: 22, top: 8, right: 592, bottom: 568 } as const;

/** The flat poster's box: its outline as wide as the map's France, centred on it. */
export function flatPosterRect(aim: FranceAim): Rect {
  const o = POSTER_OUTLINE;
  const unit = aim.width / (o.right - o.left);
  return {
    left: aim.x - ((o.left + o.right) / 2) * unit,
    top: aim.y - ((o.top + o.bottom) / 2) * unit,
    width: POSTER_W * unit,
    height: POSTER_H * unit,
  };
}

/** What a curtain draws where: France (the flat drawing in a box, or the
 *  outline projected as the map shows it: `flat` on the globe, or tilted,
 *  aimed at the map's France), and the rectangle its spinner and words are
 *  centred in. */
export interface CurtainLayout {
  poster:
    | { kind: "rect"; rect: Rect }
    | { kind: "carte"; view: Rect; boxH: number; aim: FranceAim; flat: boolean };
  say: Rect;
}

/** Which curtain asks, for "avant" (where each drew France before): MapStage's
 *  StageLoading, or GeoNav's boot curtain with its live cover (`map`: over the
 *  map's box alone, `all`: the card), the desktop panel's side (`cover` px),
 *  the phone sheet's strip (`peek` px, as measured) and whether the panel is
 *  held out of sight. */
export type CurtainStage =
  | { stage: "stage" }
  | { stage: "geo"; mapOnly: boolean; sheet: boolean; cover: number; peek: number; held: boolean };

export function curtainLayout(o: {
  w: number;
  h: number;
  desktop: boolean;
  preview: boolean;
  /** The phone sheet's strip at boot: CURTAIN_PEEK_PX plus the safe area. */
  peekPx: number;
  mode: BootPoster;
  /** How the map will enter: shown flat then tilted ("full"), or tilted
   *  before it is shown ("short"). Read by "carte" only. */
  motion: Motion;
  from: CurtainStage;
  /** France in the middle of the box, as large as the camera frames it
   *  (the map's fallback, with no panel beside it). */
  centred?: boolean;
}): CurtainLayout {
  const { w, h } = o;
  if (o.mode === "avant") return beforeLayout(w, h, o.from);
  const view = inSight(w, h, insetsFor(o));
  if (o.mode === "plat") {
    const aim = franceAim(view, h);
    const [dx, dy] = o.centred ? [w / 2 - aim.x, h / 2 - aim.y] : [0, 0];
    return {
      poster: { kind: "rect", rect: moved(flatPosterRect(aim), dx, dy) },
      say: moved(view, dx, dy),
    };
  }
  const flat = o.motion === "full";
  const aim = flat ? flatFranceAim(view, h) : franceAim(view, h);
  if (!o.centred) return { poster: { kind: "carte", view, boxH: h, aim, flat }, say: view };
  // The same drawing moved whole (its camera's centre with it): its outline's
  // box on the box's centre, its size and shape unchanged.
  const dx = w / 2 - aim.x;
  const dy = h / 2 - aim.y;
  const at = moved(view, dx, dy);
  return {
    poster: { kind: "carte", view: at, boxH: h, aim: { ...aim, x: w / 2, y: h / 2 }, flat },
    say: at,
  };
}

/** `r` moved by (dx, dy). */
const moved = (r: Rect, dx: number, dy: number): Rect => ({
  ...r,
  left: r.left + dx,
  top: r.top + dy,
});

/** Each stage's places before (StageLoading.vue and GeoNav.vue's .boot rules
 *  up to 828c15d). */
function beforeLayout(w: number, h: number, from: CurtainStage): CurtainLayout {
  const whole: Rect = { left: 0, top: 0, width: w, height: h };
  const poster: Rect = { left: 0.1 * w, top: 0.1 * h, width: 0.8 * w, height: 0.8 * h };
  if (from.stage === "stage" || !from.mapOnly)
    return { poster: { kind: "rect", rect: poster }, say: whole };
  if (!from.sheet)
    return {
      poster: { kind: "rect", rect: { ...poster, width: 0.8 * w - from.cover } },
      say: { ...whole, width: w - from.cover },
    };
  return {
    poster: { kind: "rect", rect: { ...poster, height: 0.8 * h - from.peek } },
    say: from.held ? whole : { ...whole, height: h - from.peek },
  };
}
