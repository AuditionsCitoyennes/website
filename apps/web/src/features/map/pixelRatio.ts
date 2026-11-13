// How many pixels the maps draw per CSS pixel, when that is capped under the
// screen's own ratio (`ac:dpr=1.5`, graphicsSwitch.ts; the testing tools only).
//
// mapbox-gl 3.34.1 has no pixel-ratio setting, neither an option nor a
// setter: it reads `window.devicePixelRatio` through one internal getter, at
// every resize and in every frame (the canvas's size, the viewport, the line
// and symbol shaders, the tiles' requests). Sizing the container smaller and
// stretching it with a CSS scale is no way round: Mapbox then draws a smaller
// map (labels, lines and pins twice their size on screen, another zoom for
// the same view). So the cap answers that property for the page:
// `capPixelRatio(limit)` redefines `window.devicePixelRatio` with a getter
// returning min(limit, the screen's ratio), before the first map is created.
// Mapbox does not support this; it is why no device gets the cap unasked.
//
// With a cap in force:
// - `window.devicePixelRatio` is the ratio of the maps' canvases: the main map
//   and the lid's hidden map size their drawing buffers with it, and the
//   plateau's line widths (gl/PlateauWallLayer) scale by it, as they must.
// - `nativePixelRatio()` is the screen's: what is sized in screen units reads
//   it (the lid's pixel budget, plateau/mapSnapshot).
// - CSS, the DOM (the pins, the analyses' plates, the panel) and media
//   queries are untouched: the page stays at the screen's ratio. Mapbox's
//   camera, its events' points and the plateau's frames are in CSS pixels, so
//   pins, hit tests and plates stand where they stood.
//
// Without a cap nothing is redefined and both ratios are the window's.
//
// No import and nothing run at load: loadable under node (pixelRatio.test.ts).

/** The cap in force, with the screen's own reader; null: none. */
let capped: { limit: number; native: () => number } | null = null;

const ratioOf = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;

/** The screen's ratio (device pixels per CSS pixel), cap or not. */
export function nativePixelRatio(): number {
  if (capped) return capped.native();
  return typeof window === "undefined" ? 1 : ratioOf(window.devicePixelRatio);
}

/** The ratio the maps' canvases draw at: the screen's, or the cap under it. */
export function mapPixelRatio(): number {
  const native = nativePixelRatio();
  return capped ? Math.min(capped.limit, native) : native;
}

/** Screen pixels per pixel of a map's canvas, along a side: 1 without a cap
 *  (and on a screen at or under it), 2 for a cap of 1.5 on a screen at 3. */
export function screenPerMapPixel(): number {
  return capped ? nativePixelRatio() / mapPixelRatio() : 1;
}

/**
 * Cap the ratio the maps draw at, for this page load: call it before the
 * first map is created. Returns whether the cap is in force. False, and
 * nothing redefined, where the property cannot be redefined or `limit` is no
 * ratio; a second call keeps the first cap.
 */
export function capPixelRatio(limit: number): boolean {
  if (capped) return true;
  if (typeof window === "undefined" || !Number.isFinite(limit) || limit <= 0) return false;
  try {
    // The property as the browser defines it: an accessor of the window itself
    // (a global's attributes are its own), else of its prototypes.
    let holder: object | null = window;
    let desc: PropertyDescriptor | undefined;
    while (holder && !(desc = Object.getOwnPropertyDescriptor(holder, "devicePixelRatio"))) {
      holder = Object.getPrototypeOf(holder) as object | null;
    }
    if (!desc) return false;
    const { get, value } = desc as { get?: () => unknown; value?: unknown };
    // Read through the browser's own getter each time: the screen's ratio
    // changes with the browser's zoom and from one monitor to another.
    const native = get ? () => ratioOf(get.call(window)) : () => ratioOf(value);
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      enumerable: true,
      get: () => Math.min(limit, native()),
    });
    capped = { limit, native };
    return true;
  } catch {
    return false; // not configurable here: the maps keep the screen's ratio
  }
}
