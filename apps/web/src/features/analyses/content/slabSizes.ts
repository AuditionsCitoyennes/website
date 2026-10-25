// The analyses' slabs on the raised territory (ScopeAnalysisOverlay, GeoDrillMap):
// how large their content boxes are. Pure — no Vue — because GeoNav has to
// make room for them before they are drawn (the camera moves as the analyses
// turn on, or as another territory is chosen), and so that the layout can be
// checked offline.
//
// Each analysis is a SLAB: a small piece of ground just outside the
// territory's edge — the themes over the middle of its box's top edge, the
// plaque under the middle of its bottom edge — with raised pieces standing on
// it at the plateau's height, its words lying on their lids, glued to the map
// (map/lib/slabs: how big it is on the map). The plaque is one piece; the themes
// are three in a row, the ground between them: the ring (each part a piece of
// its own), the picked theme's bar, the label's box. Their content boxes are
// laid out here at the type scale's sizes, the very boxes the overlay's style
// draws: right after the camera frames the territory, the words read at a set
// share of those sizes (map/lib/slabs: TEXT_SCALE — the slabs drawn that much
// smaller, never the CSS); zoomed in or out, they grow and shrink with the
// map, as any piece of it.
import type { ScopeAnalysis } from "../stats/scopeStats";
import { SLAB_SAFETY, type PieceBox } from "@/features/map/lib";
import { countLinesOf, countsOf, emptyTextOf, fmtN, shortName, type CountPart } from "./text";
import { measureText, typePx, wrapLines, type Measure } from "./measure";
import { ringOf, RING_OVER_LABEL, type Ring } from "./ring";
import { edgeMargin, NEAR_GROWTH } from "./plateRoom";

// As the overlay's style lays them out (ScopeAnalysisOverlay: keep in step).

// The themes' slab: three pieces in a row, each raised on its own — the
// ring's box, the bar of the theme shown, the label's box —, this much ground
// between two (px: what is seen between them, the ring's box keeping room of
// its own around the ring, see ringPad); the bar's width (px); the label's
// box's padding (rem).
const GROUP_GAP = 6;
const BAR_W = 4;
const LABEL_PAD_Y = 0.3;
const LABEL_PAD_X = 0.45;
/** Over each line measured, px: what rounding and kerning may add. */
const LINE_SLACK = 2;
// The plaque: its padding (rem); its head row, px — the level, the "filtré"
// badge, the ⓘ and × buttons (24 px, the last drawn 4 px into the padding),
// the gaps between (rem); the title's gap and the text's (rem).
const PLAQUE_PAD_Y = 0.35;
const PLAQUE_PAD_X = 0.5;
const HEAD_H = 16;
const HEAD_GAP = 0.25;
const ICON = 24;
const ICON_PULL = 4;
const BADGE_PAD_X = 0.35;
const TITLE_GAP = 0.15;
const TEXT_GAP = 0.2;
/** The plaque's text column, px: at least; at most for its title (a desktop,
 *  a phone) — never narrower than its counts on one line and its head row. */
const PLAQUE_MIN = 120;
const PLAQUE_MAX_WIDE = 230;
const PLAQUE_MAX_COMPACT = 200;

export interface SlabSizes {
  /** Null: no ring to draw (too few testimonies). */
  themes: {
    /** The whole row's box: the slab's. */
    w: number;
    h: number;
    /** Its pieces in it, px from its top left: the ring's box, the bar, the
     *  label's box (vertically centred). */
    ringBox: PieceBox;
    barBox: PieceBox;
    labelBox: PieceBox;
    /** The label's text column, kept whatever it names: no line moves as
     *  another part is picked. */
    labelW: number;
    /** The ring itself: what the overlay lays its targets for, and the parts
     *  GeoDrillMap raises. */
    ring: Ring;
  } | null;
  plaque: {
    w: number;
    h: number;
    /** Its text column, px. */
    inner: number;
    /** The counts in their lines (none: the empty text instead). */
    countLines: CountPart[][];
    titleLines: number;
    /** The lines under the title: the counts', or the empty text's. */
    textLines: number;
  };
}

export interface SizeOpts {
  compact: boolean;
  /** The viewport's width, px (the type scale is fluid with it). */
  vw: number;
  /** The root's font size, px. */
  rem: number;
  /** Filters are on (the "filtré" badge, the empty text's words). */
  filtered: boolean;
  /** The themes picked in Filtres: in every testimony counted, no part. */
  themeFilter: readonly string[];
  /** The ring's band, per px of its outer diameter (RING_THICK). */
  ringThick: number;
  /** The safe rect's width, px: the plaque, as drawn right after a fit, is
   *  never wider (its counts then take more lines). Absent or 0: no bound. */
  safeW?: number;
  /** The slabs' words on screen right after a fit, per CSS px of their boxes
   *  (map/lib/slabs: TEXT_SCALE). */
  textScale: number;
}

/**
 * The slabs' content boxes, px, at the type scale's sizes: every word at
 * --text-caption, the plaque's title in Bebas at --text-title (the least Bebas
 * is drawn at) — drawn on the map at `textScale` of them. The themes' label is
 * as wide as its widest part needs — the share and the short name, the count
 * line —, measured over every part, so that nothing moves as another is
 * picked. The themes' row: the ring's box — the ring RING_OVER_LABEL times as
 * tall as the label's box, the row's height —, GROUP_GAP of ground from the
 * ring at its farthest (a part picked) to the bar, the bar as tall as the
 * label's box, GROUP_GAP, the label's box (both centred on the ring), and the
 * room the ring's box keeps beside the ring at rest, so that the row is
 * centred on what is seen. The plaque: as wide as its counts need on ONE line
 * and its head row (the level, the badge, the buttons), or half its title (on
 * two lines) within the title's bounds — the title wraps, never the counts —;
 * only should that be wider than the safe rect once drawn (`safeW`), as wide
 * as that, the counts then on as many lines as they take.
 */
export function slabSizes(
  s: ScopeAnalysis,
  o: SizeOpts,
  measure: Measure = measureText,
): SlabSizes {
  const t = typePx(o.vw, o.rem);
  const c = t.caption;
  const rem = t.rem;
  const m = (text: string, px: number, weight: number, display = false, sp = 0) =>
    measure(text, px, weight, display ? "display" : "sans", sp);

  let themes: SlabSizes["themes"] = null;
  // The label's box: its two lines and its padding; the bar as tall, the
  // ring twice as tall.
  const labelH = Math.ceil(1.2 * c + 0.1 * rem + 1.3 * c + 2 * LABEL_PAD_Y * rem);
  const ring = ringOf(s, o, RING_OVER_LABEL * labelH);
  if (ring) {
    let text = 0;
    for (const p of ring.parts) {
      text = Math.max(text, m(`${p.pct} ${shortName(p.theme)}`, c, 700), m(p.cited, c, 400));
    }
    const labelW = Math.ceil(text + LINE_SLACK);
    const h = Math.max(ring.box, labelH);
    // The ring's box keeps its focus ring's room past the part picked; the
    // row, as much past the label's box as there is in it beside the ring at
    // rest: what is seen stands in its middle.
    const reach = ring.box / 2 - (ring.R + ring.pick);
    const barX = ring.box + Math.max(0, GROUP_GAP - reach);
    const labelX = barX + BAR_W + GROUP_GAP;
    const labelBoxW = Math.ceil(labelW + 2 * LABEL_PAD_X * rem);
    const y = (h - labelH) / 2;
    themes = {
      w: Math.ceil(labelX + labelBoxW + ring.box / 2 - ring.R),
      h,
      ringBox: { x: 0, y: (h - ring.box) / 2, w: ring.box, h: ring.box },
      barBox: { x: barX, y, w: BAR_W, h: labelH },
      labelBox: { x: labelX, y, w: labelBoxW, h: labelH },
      labelW,
      ring,
    };
  }

  const parts = s.testimonies ? countsOf(s, o.compact) : [];
  const sep = m(" · ", c, 400);
  const lineW = (line: CountPart[]) =>
    line.reduce(
      (sum, p, i) => sum + (i ? sep : 0) + m(fmtN(p.n), c, 700) + m(` ${p.word}`, c, 400),
      0,
    ) + LINE_SLACK;
  // All the counts on one line.
  const countW = parts.length ? lineW(parts) : 0;
  const kicker = m(s.levelLabel.toUpperCase(), c, 700, false, 0.08);
  const badge = o.filtered ? m("filtré", c, 700) + 2 * BADGE_PAD_X * rem + 2 : 0;
  const head =
    kicker +
    (badge ? HEAD_GAP * rem + badge : 0) +
    2 * (HEAD_GAP * rem + ICON) -
    ICON_PULL +
    LINE_SLACK;
  const titleW = (text: string) => m(text, t.title, 400, true, 0.04);
  const max = o.compact ? PLAQUE_MAX_COMPACT : PLAQUE_MAX_WIDE;
  // The widest the plaque may be drawn: the safe rect less its margins, the
  // slab drawn at textScale, its safety, its near edge the wider.
  const pad = 2 * PLAQUE_PAD_X * rem;
  const bound =
    o.safeW && o.safeW > 0
      ? Math.max(
          PLAQUE_MIN,
          Math.floor(
            (o.safeW - 2 * edgeMargin(o.compact)) / (o.textScale * SLAB_SAFETY * NEAR_GROWTH) - pad,
          ),
        )
      : Infinity;
  let inner = Math.min(
    bound,
    Math.ceil(
      Math.max(
        countW,
        head,
        Math.min(max, Math.max(PLAQUE_MIN, (titleW(s.label) + LINE_SLACK) / 2)),
      ),
    ),
  );
  // Half the title is not always two lines (its words break where they
  // break: "Provence-Alpes- / Côte / d'Azur"): wider, as far as the bounds go.
  const titleMax = Math.min(max, bound);
  let titleLines = Math.max(1, wrapLines(s.label, inner, titleW));
  while (titleLines > 2 && inner < titleMax) {
    inner = Math.min(titleMax, inner + 4);
    titleLines = Math.max(1, wrapLines(s.label, inner, titleW));
  }
  const countLines = countLinesOf(parts, (line) => lineW(line) <= inner + 0.5);
  const textLines =
    countLines.length || wrapLines(emptyTextOf(o.filtered), inner, (x) => m(x, c, 400));
  return {
    themes,
    plaque: {
      w: Math.ceil(inner + pad),
      h: Math.ceil(
        2 * PLAQUE_PAD_Y * rem +
          HEAD_H +
          TITLE_GAP * rem +
          titleLines * t.title +
          TEXT_GAP * rem +
          textLines * 1.3 * c,
      ),
      inner,
      countLines,
      titleLines,
      textLines,
    },
  };
}
