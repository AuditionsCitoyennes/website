// The map's public types: what GeoNav hands GeoDrillMap (units, camera
// commands, outlines, the slabs to stand) and what the map hands back each
// frame (where the plateau and its slabs are on screen).

import type { Bounds, HeightClass } from "@/features/geo";
import type { PieceBox } from "./lib";

/** A pin to plot: an aggregated admin unit, or a leaf place. */
export interface MapUnit {
  id: string;
  label: string;
  count: number;
  center: [number, number]; // [lat, lng]
  isLeaf: boolean;
  /** The unit's geographic bbox — a macro pin only shows while this (its boundary)
   *  still intersects the viewport. */
  bounds?: Bounds;
  /** The unit's boundary polygon — the pin is anchored over the VISIBLE part of
   *  it, so it always sits on its own territory. */
  geometry?: unknown;
}

/** A camera command. `key` changes each time the parent wants a move. */
export interface CameraCmd {
  key: number;
  type: "ease" | "spotlight" | "fit";
  center: [number, number]; // [lat, lng]
  zoom?: number;
  /** For type "fit": the bbox to frame so the whole unit fits the visible area. */
  bounds?: Bounds;
  /** For type "fit": the unit framed, when its outline is known — framed by
   *  its silhouette, raised (`heightClass` says how high), rather than by
   *  `bounds` (see fitCamera). `lands`: whether the view's centre may land on a
   *  ground point, the scope read from there being the unit (absent: inside
   *  its outline). */
  shape?: {
    id: string;
    heightClass: HeightClass;
    geometry: unknown;
    lands?: (lng: number, lat: number) => boolean;
  };
  /** For type "fit": boxes up to `lng` × `lat` degrees (the unit's children)
   *  fill at most `fill` of the view once framed, as the scope measures it
   *  (visibleBounds): the zoom is capped at that. */
  fillCap?: { lng: number; lat: number; fill: number };
  /** For type "fit": how much of the rectangle in sight the unit fills, on
   *  the axis that limits it, centred (map/lib/slabs' fitSilhouette; absent: 1,
   *  edge to edge). */
  fill?: number;
  maxZoom?: number;
  animate?: boolean;
  /** For type "spotlight": fly there along an arc — pull back, travel, come
   *  down — rather than slide at one zoom. For hopping from lieu to lieu. */
  arc?: boolean;
  /** The map has just changed places — the home page's card becoming the
   *  page, or back (MapStage): measure the container again before framing, and
   *  frame as if nobody had touched the map (size changes then frame it again,
   *  as on a fresh page). */
  fresh?: boolean;
}

/** Boundary outlines (GeoJSON) for the current scope's children. Each
 *  feature's properties: `kind` (scope, focus, context), the unit's `id`, its
 *  `level` (LevelKey) and its `heightClass` (HeightClass). */
export interface OutlineFC {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; geometry: unknown; properties: Record<string, unknown> }>;
}

/**
 * Where the raised plateau stands on screen, once per rendered frame (see
 * `onFrame`). Projected with the very matrices the plateau was drawn with, so
 * anything placed from it moves with the plateau in the same frame. The object
 * and its arrays are reused from one frame to the next: read them inside the
 * callback, never keep them.
 */
export interface PlateauFrame {
  /** Id of the raised unit (= GeoUnit.id), '' when no plateau stands. It lags
   *  the parent's scope by the DEM round trip and the old plateau's sink. */
  scopeId: string;
  /** The animated rise, 0..1 (the plateau's own vertical scale). */
  rise: number;
  /** Map container size, CSS px. */
  w: number;
  h: number;
  pitch: number;
  bearing: number;
  zoom: number;
  /** The padded camera centre, container px — the perspective's vanishing point. */
  centre: [number, number];
  /** Rim samples along the raised unit's outer rings. */
  n: number;
  /** 2n: each sample at lid height, px. */
  top: Float32Array;
  /** 2n: each sample at the wall's foot, px. */
  base: Float32Array;
  /** n: 1 when both of the sample's projections are valid (in front of the camera). */
  ok: Uint8Array;
  /** Bounding box of the silhouette (top ∪ base). Null when no plateau stands,
   *  while it is nearly flat (rise < 0.02), or when no sample is in front. */
  box: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** The analyses' slabs on that plateau (see SlabSpec). */
  slabs: PlateauSlabs;
}

/** A box of words on a slab, at its lid's height, on screen this frame. */
export interface SlabFrame {
  /** The box it was built for, CSS px. */
  w: number;
  h: number;
  /** Its corners, px: NW, NE, SE, SW (x, y each) — where the box's corners go. */
  lid: Float32Array;
  /** All four in front of the camera. */
  ok: boolean;
}

export interface PlateauSlabs {
  /** The unit they stand on, '' when none. */
  scopeId: string;
  /** Their rise, 0..1: the plateau's, times their own presence. */
  rise: number;
  /** Bumped at every rebuild. */
  version: number;
  /** The boxes words are laid on (null: none): over the territory, the ring's
   *  (its targets, over its raised parts) and the label's; below it, the
   *  plaque's. */
  ring: SlabFrame | null;
  label: SlabFrame | null;
  plaque: SlabFrame | null;
}

/**
 * The analyses' slabs to stand on the raised unit (GeoNav): two small pieces of
 * ground just outside its edge — `top` over the middle of its box's top edge
 * (null: none), `bottom` under the middle of its bottom edge —, sized on the
 * map so that their content boxes (`w`, `h`, CSS px) read at that size right
 * after the camera that framed the unit (`framedBy`: that command's key; null:
 * the camera of the moment), `gapPx` from its lid. On them, raised pieces: on
 * `bottom` the plaque, the whole box; on `top` the themes' row (see
 * SlabThemesSpec). Only for the unit standing raised: another unit's slabs
 * come with its plateau.
 */
export interface SlabSpec {
  scopeId: string;
  top: SlabThemesSpec | null;
  bottom: { w: number; h: number };
  gapPx: number;
  framedBy: number | null;
  /** Drawn long, its words at their proportions at the fit's pitch. */
  anamorphic: boolean;
  /** Right after that camera, on screen per CSS px of the boxes (map/lib/slabs:
   *  TEXT_SCALE): the words at that share of their sizes. */
  textScale: number;
  /** The lid of the words' pieces (the label's box, the plaque): "verre", glass
   *  — not drawn: the overlay lays its words on a glass of their own, the map
   *  seen through it —; "opaque", the card's colour; "carte" (DEV), the raised
   *  map through it. */
  lid: "verre" | "opaque" | "carte";
}

/**
 * The themes' row on its slab (analyses/content/slabSizes), in CSS px of
 * its content box: the ring's box, the bar, the label's box — the bar and the
 * label's box each a raised piece, and each of the ring's parts. The ring, in
 * its box: its centre, its outer and inner radii, how much farther out the
 * picked part reaches and a part hovered; each part's span (radians,
 * clockwise from 3 o'clock, y down) and colours. Which part is picked and
 * which hovered, the overlay says (setRing).
 */
export interface SlabThemesSpec {
  w: number;
  h: number;
  ringBox: PieceBox;
  barBox: PieceBox;
  labelBox: PieceBox;
  ring: {
    c: number;
    R: number;
    r: number;
    pick: number;
    hover: number;
    parts: { theme: string; a0: number; a1: number; color: string; pastel: string }[];
  };
}
