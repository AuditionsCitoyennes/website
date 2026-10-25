// The room the camera leaves around the plateau for its slabs: the margins
// and the gap the slabs keep, the bands above and below the territory, the
// least rectangle it is framed in. The analyses' own numbers, not the map's.
import { FIT_PITCH_DEG, SLAB_SAFETY } from "@/features/map/lib";
import type { SlabSizes } from "./slabSizes";

/** From the safe rect's edges to a slab, px: a desktop, a phone. */
export const edgeMargin = (compact: boolean) => (compact ? 8 : 12);
/** From the territory's lid to a slab's near edge, on screen right after a
 *  fit, px: a phone, a desktop. */
export const slabGap = (compact: boolean) => (compact ? 10 : 12);

// mapbox's logo along the map's bottom edge (on a phone, the strip's, above
// the sheet), px from the container's edges, with a little air: the plaque
// stands above its strip wherever it reaches over it.
const LOGO_W = 98;
const LOGO_H = 33;
/** Kept between the plaque and a control, px. */
const CONTROL_GAP = 6;
/** A slab is sized at its far edge: its near edge comes out up to this much
 *  wider (the perspective along its length). */
export const NEAR_GROWTH = 1.1;

/** How far the plateau's box should stay from each edge of the safe rect, px,
 *  for its slabs to stand around it. */
export interface PlateRoom {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
/** The screen the slabs stand on. */
export interface ScreenOpts {
  compact: boolean;
  /** The safe rect's width, px. */
  safeW: number;
  /** The viewport's width, px (the type scale is fluid with it). */
  vw: number;
  /** The root's font size, px. */
  rem: number;
}
export interface RoomOpts extends ScreenOpts {
  /** Slabs drawn long ("Redressé"): each comes out as tall as its box. */
  anamorphic: boolean;
  /** The slabs on screen right after a fit, per CSS px of their boxes
   *  (map/lib/slabs: TEXT_SCALE). */
  textScale: number;
}

/**
 * The ring of room the slabs need around the plateau, so that right after a
 * camera command both stand inside the safe rect. A slab takes a band along
 * ONE side of the box: the themes above it, the plaque below it — none beside
 * it (left and right: 0), each centred on the box's middle, which a fit puts
 * on the safe rect's. The box is the plateau's silhouette, its lid included:
 * that is what a fit frames (GeoDrillMap, map/lib/slabs' fitSilhouette).
 *
 * Above: the margin, the themes' slab as drawn (its box's height at textScale
 * and the safety the slabs are sized with: drawn long, as tall as that; "À
 * plat", the tilt's cos 45° of it), the gap. Below: the margin — or, where
 * the plaque (its near edge the wider) reaches over mapbox's logo, the logo's
 * strip and a gap —, the plaque as drawn (its box's height at textScale and
 * the safety), the gap.
 */
export function plateRoom(z: SlabSizes | null, o: RoomOpts): PlateRoom {
  if (!z) return { top: 0, bottom: 0, left: 0, right: 0 };
  const k = SLAB_SAFETY * o.textScale;
  // "À plat", the themes are seen flatter than the fit's 45° (higher up the
  // screen): at most cos 45° of their box; the plaque, seen more steeply, up
  // to its box — counted whole.
  const f = o.anamorphic ? 1 : Math.cos((FIT_PITCH_DEG * Math.PI) / 180);
  const gap = slabGap(o.compact);
  const top = z.themes ? Math.ceil(edgeMargin(o.compact) + z.themes.h * k * f + gap) : 0;
  const reach = o.safeW / 2 - (z.plaque.w * k * NEAR_GROWTH) / 2;
  const logo = reach < LOGO_W + CONTROL_GAP ? LOGO_H + CONTROL_GAP : 0;
  const bottom = Math.ceil(Math.max(edgeMargin(o.compact), logo) + z.plaque.h * k + gap);
  return { top, bottom, left: 0, right: 0 };
}

/**
 * The least rectangle GeoNav frames the territory in, px: the slabs' bands
 * win over the territory's size down to it, then give way, sharing what is
 * left — the slabs then reach past the safe rect's edges, but the camera
 * still frames for the rectangle (with none, it could not, and its fallback
 * fit ignores the ring). The bands never reach its width (none beside the
 * box). A phone's: 80 px tall; a desktop's: 220.
 */
export const FRAME_MIN_WIDE = { w: 280, h: 220 };
export const FRAME_MIN_COMPACT = { w: 200, h: 80 };
