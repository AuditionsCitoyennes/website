// The map's logical view: the rectangle in sight beside the panel (its insets),
// the bounds the scope is read from and the ones the pins are culled against,
// the zoom a box fills the view at — and the `viewChange` payload the parent is
// handed. Nothing here moves the camera.

import mapboxgl from "mapbox-gl";
import type { Bounds } from "@/features/geo";

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The map's `padding` prop: one number for all four sides, or each. */
export type MapPadding = Insets | number;

/** What the map reports of its view (the `viewChange` emit). */
export interface MapView {
  zoom: number;
  center: [number, number];
  /** Flat symmetric box — what the SCOPE logic measures span against. */
  bounds: Bounds;
  /** What is actually on screen, pitch included — use this to cull pins. */
  screen: Bounds;
  /** The insets `bounds` was measured inside: the layout this view is OF.
   *  A view measured for another layout than the current one is stale. */
  insets: Insets;
  /** The user is moving the camera (gesture or its glide) — as opposed to a
   *  flight landing, the padding ease, a resize or a re-measure. */
  byUser: boolean;
}

export interface MapViewInputs {
  getMap: () => mapboxgl.Map | null;
  /** The camera's padding (the `padding` prop). */
  padding: () => MapPadding | undefined;
  /** The rectangle clear of the panel right now, when not the camera's (`viewPadding`). */
  viewPadding: () => Insets | undefined;
  /** The user is moving the camera (a gesture's `movestart` to its `moveend`). */
  userHolding: () => boolean;
  /** The view, measured: the `viewChange` emit. */
  onView: (view: MapView) => void;
}

/**
 * The zoom at which a box `lng` × `lat` degrees fills `fill` of the view the
 * scope is read off (visibleBounds' measure, `ins` the rectangle's insets in
 * a map w × h, at `pitch`, about latitude `lat0`). Infinity: no such zoom.
 */
export function zoomForFill(
  box: { lng: number; lat: number; fill: number },
  ins: { top: number; bottom: number; left: number; right: number },
  w: number,
  h: number,
  pitch: number,
  lat0: number,
): number {
  const cosLat = Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const tilt = Math.cos((Math.min(pitch, 60) * Math.PI) / 180);
  const mPerPx =
    Math.max(
      (box.lng * 111320 * cosLat) / (w - ins.left - ins.right),
      (box.lat * 110574 * tilt) / (h - ins.top - ins.bottom),
    ) / box.fill;
  if (!(mPerPx > 0) || !Number.isFinite(mPerPx)) return Infinity;
  return Math.log2((40075016.686 * cosLat) / (512 * mPerPx));
}

export function useMapView({ getMap, padding, viewPadding, userHolding, onView }: MapViewInputs) {
  // Geo bbox of the VISIBLE map rectangle (canvas minus the panel padding, minus an
  // optional inset margin). Shared by the scope derivation (emitView) and pin
  // placement (updateSticky) so both reason about the same on-screen area.
  // Built from the inset CENTRE (stable under pitch — a mid-screen point never nears
  // the horizon) plus a span sized from the zoom and the tilt, NOT by unprojecting
  // the corners (which blow up toward the horizon once the camera is pitched).
  /** Insets of the rectangle that is clear of the panel right now (see `viewPadding`). */
  function viewInsets(): Insets {
    const pad = viewPadding() ?? padding() ?? 50;
    return typeof pad === "number" ? { top: pad, bottom: pad, left: pad, right: pad } : pad;
  }

  /**
   * The ground under a screen point — the FLAT ground, not the terrain. The
   * plateau rises and sinks (its height animated, kilometres at région scale):
   * a ray through the screen hits its raised surface far up the slope from the
   * point actually looked at, and the scope read from there landed on another
   * unit (the 9e raised while the user looked at Lyon 1er). mapbox's `unproject`
   * follows the terrain, and its flat `transform.pointLocation` returns NaN on the
   * globe — so: the camera's own centre, moved by the pixels between it and the
   * point at the ground scale there. Exact at rest when the two centres meet (the
   * panel narrow), first-order across the wide panel's offset.
   */
  function groundAt(x: number, y: number): { lat: number; lng: number } {
    const m = getMap()!;
    const c = m.getContainer();
    const { top = 0, bottom = 0, left = 0, right = 0 } = m.getPadding();
    const dx = x - (left + c.clientWidth - right) / 2;
    const dy = y - (top + c.clientHeight - bottom) / 2;
    const at = m.getCenter();
    if (dx === 0 && dy === 0) return { lat: at.lat, lng: at.lng };
    const cosLat = Math.cos((at.lat * Math.PI) / 180) || 1e-6;
    const mPerPx = (40075016.686 * cosLat) / (512 * Math.pow(2, m.getZoom()));
    // Up the screen is the bearing; a pitched camera stretches the ground along it.
    const b = (m.getBearing() * Math.PI) / 180;
    const along = mPerPx / Math.max(Math.cos((Math.min(m.getPitch(), 80) * Math.PI) / 180), 0.17);
    const east = dx * mPerPx * Math.cos(b) - dy * along * Math.sin(b);
    const north = -dx * mPerPx * Math.sin(b) - dy * along * Math.cos(b);
    return { lat: at.lat + north / 110574, lng: at.lng + east / (111320 * cosLat) };
  }

  function visibleBounds(margin: number): Bounds | null {
    const map = getMap();
    if (!map) return null;
    const c = map.getContainer();
    const ins = viewInsets();
    const left = ins.left + margin;
    const right = c.clientWidth - ins.right - margin;
    const top = ins.top + margin;
    const bottom = c.clientHeight - ins.bottom - margin;
    if (right - left < 8 || bottom - top < 8) return null;
    const ctr = groundAt((left + right) / 2, (top + bottom) / 2);
    const cosLat = Math.cos((ctr.lat * Math.PI) / 180) || 1e-6;
    // Web-Mercator ground resolution (m/px) at the centre, for Mapbox 512px tiles.
    const mPerPx = (40075016.686 * cosLat) / (512 * Math.pow(2, map.getZoom()));
    // Up the screen, a tilted camera sees more ground per pixel (1/cos pitch at
    // the centre row): measured flat, a unit just framed by `fitBounds` at
    // ELEV_PITCH came out 1.27× the view, and its biggest child already "filled"
    // it — clicking Lyon landed in an arrondissement. Capped so a steep tilt
    // cannot balloon the box. The bearing is left out on purpose: the box of a
    // turned rectangle swells and shrinks as the map turns, and a twist of the
    // fingers while pinching would raise and sink the plateau.
    const pitch = (Math.min(map.getPitch(), 60) * Math.PI) / 180;
    const halfLat = ((bottom - top) * mPerPx) / Math.cos(pitch) / 2 / 110574; // ~m per ° latitude
    const halfLng = ((right - left) * mPerPx) / 2 / (111320 * cosLat); // ~m per ° longitude
    return {
      minLat: ctr.lat - halfLat,
      maxLat: ctr.lat + halfLat,
      minLng: ctr.lng - halfLng,
      maxLng: ctr.lng + halfLng,
    };
  }

  /**
   * The TRUE on-screen bbox, pitch included.
   *
   * `visibleBounds` above is a symmetric box ON PURPOSE — scope derivation
   * needs a span that cannot swing toward the horizon. But a pitched camera shows
   * far more ground above the screen centre than that box covers, so anything
   * culled against it vanishes while still plainly on screen. Mapbox's own
   * `getBounds()` walks the view trapezoid, clamps it at the horizon, and already
   * accounts for the camera padding — use it for anything about what the user can
   * actually SEE, and keep `visibleBounds` for what the scope logic measures.
   */
  function screenBounds(): Bounds | null {
    const map = getMap();
    if (!map) return null;
    // `getBounds` can THROW. Past the globe, with terrain, it lifts the top
    // corners to the highest visible DEM tile — and while none of those tiles has
    // its data yet (new tiles after a resize, a fresh DEM slot mid-flight) that
    // height is Number.MAX_VALUE: the corners land at infinity and come back as
    // "Invalid LngLat object: (NaN, …)". Thrown on, it took the whole view emit
    // with it (and the `moveend` handler around it), so the parent's pinned scope
    // was never released. Every caller already falls back on null.
    let b: mapboxgl.LngLatBounds | null;
    try {
      b = map.getBounds();
    } catch {
      return null;
    }
    if (!b) return null;
    const box = {
      minLat: b.getSouth(),
      maxLat: b.getNorth(),
      minLng: b.getWest(),
      maxLng: b.getEast(),
    };
    // Infinity passes mapbox's NaN check: a blown-up box is no box either.
    if (!Object.values(box).every(Number.isFinite)) return null;
    // `getBounds` stops at the CAMERA's padding, and more of the map can be in
    // sight than that: the panel folded (`viewPadding`), or a padding the camera
    // has not eased to yet (owed under a gesture, or cut short by one). Take in
    // the corners of what is really clear, or the area just uncovered would be
    // left without pins. At rest the two rectangles are the same one.
    const c = map.getContainer();
    const ins = viewInsets();
    for (const x of [ins.left, c.clientWidth - ins.right]) {
      for (const y of [ins.top, c.clientHeight - ins.bottom]) {
        // Same failure, one corner at a time: skip it, the box keeps the rest.
        let at: mapboxgl.LngLat;
        try {
          at = map.unproject([x, y]);
        } catch {
          continue;
        }
        if (!Number.isFinite(at.lat) || !Number.isFinite(at.lng)) continue;
        box.minLat = Math.min(box.minLat, at.lat);
        box.maxLat = Math.max(box.maxLat, at.lat);
        box.minLng = Math.min(box.minLng, at.lng);
        box.maxLng = Math.max(box.maxLng, at.lng);
      }
    }
    return box;
  }

  /** `screenBounds` pulled in by `margin` screen pixels — proportional, because
   *  under pitch a pixel is not a fixed ground distance. */
  function screenBoundsInset(margin: number): Bounds | null {
    const b = screenBounds();
    const map = getMap();
    if (!b || !map || margin <= 0) return b;
    const c = map.getContainer();
    const dLat = (b.maxLat - b.minLat) * Math.min(0.4, margin / Math.max(c.clientHeight, 1));
    const dLng = (b.maxLng - b.minLng) * Math.min(0.4, margin / Math.max(c.clientWidth, 1));
    return {
      minLat: b.minLat + dLat,
      maxLat: b.maxLat - dLat,
      minLng: b.minLng + dLng,
      maxLng: b.maxLng - dLng,
    };
  }

  function emitView() {
    const map = getMap();
    if (!map) return;
    // Report the VISIBLE rectangle (canvas minus the panel), so scope derivation
    // measures span against what the user actually sees beside the panel.
    const vb = visibleBounds(0);
    if (!vb) return;
    onView({
      zoom: map.getZoom(),
      center: [(vb.minLat + vb.maxLat) / 2, (vb.minLng + vb.maxLng) / 2],
      bounds: vb,
      screen: screenBounds() ?? vb,
      insets: viewInsets(),
      byUser: userHolding(),
    });
  }

  return { viewInsets, visibleBounds, screenBounds, screenBoundsInset, emitView };
}
