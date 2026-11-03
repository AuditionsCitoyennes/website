import mapboxgl from "mapbox-gl";
import type { LidMode } from "./lidSwitch";
import { lidTier, type LidTier } from "./lidTier";

// One persistent HIDDEN Mapbox map used to snapshot the basemap for the plateau's
// map-textured top ("lid"). The lid mesh is vector-crisp (it shares the selection's
// exact boundary with the black wall), and its texture comes from here: the same
// style rendered top-down over the selection's bounds, captured once per selection.
// A single instance is reused across captures (each `new Map()` is a billed map
// load and a fresh WebGL context — never create one per drill).
//
// The snapshot is the PURE basemap: boundary outlines are NOT baked in — a baked
// line is a raster that fattens as you zoom past the capture. The focus outlines
// are drawn over the lid as constant-width GL vector lines (PlateauWallLayer).

export interface SnapshotBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface Snapshot {
  bitmap: ImageBitmap;
  /** Mercator rectangle the bitmap actually covers (the square canvas over-covers
   *  a non-square selection — UVs must use this, not the requested bounds). */
  merc: { minX: number; minY: number; spanX: number; spanY: number };
}

// Backing-store pixels of the square capture. This is a RESOLUTION budget, not a
// constant: the lid's ground-metres-per-texel is (captured span / this), so a
// budget below the main canvas's device width guarantees a plateau top softer
// than the live map beside it, however well the re-capture logic works. 2048
// against a 2×-DPR canvas capped the lid at ~1.65× coarser than the screen.
const SNAP_PX_FLOOR = 2048; // 16 MB RGBA
const SNAP_PX_CEIL = 4096; // 64 MB RGBA — only asked for when the display needs it

/**
 * Memory-tiered ceiling. Only a *known* low-memory device clamps hard: the ask
 * itself is demand-driven (callers size it from the screen's own resolution), so
 * a small display never requests a big budget and the ceiling stays a safety
 * cap. Treating the unknown case (Firefox/Safari do not expose `deviceMemory`)
 * as low-memory would deny the fix to exactly the users who reported it.
 */
function ceilingForDevice(): number {
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  if (mem !== undefined && mem <= 4) return 1024;
  return SNAP_PX_CEIL;
}

/** "ecran": the floor and the ceiling from this window (lidTier.ts), read at
 *  each ask so a rotated phone or a resized window gets its own. */
function tierForScreen(): LidTier {
  return lidTier({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory,
    coarse: window.matchMedia?.("(pointer: coarse)").matches ?? false,
  });
}

// "ecran": the hidden map is created this small (device px) — the style, its
// shaders and the workers are what the warm-up is for, not a big drawing
// buffer — and parked at PARK_CSS css px once idle, its 1-4k px buffer freed.
// Not right after a shot: a select's refine follows it within seconds, and
// parked in between it paid the resize and the re-render back (phones: ~1 s
// more to the lid). LID_PARK_DELAY_MS without a new shot, then it parks.
const WARM_PX = 512;
const PARK_CSS = 64;
const LID_PARK_DELAY_MS = 6000;

export class SnapshotManager {
  private map: mapboxgl.Map | null = null;
  private container: HTMLDivElement | null = null;
  private loaded = false;
  private seq = 0;
  private px = 0; // 0 while parked: the next shot resizes it back
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private shooting = 0; // captures running

  /** `mode`: "ecran" sizes from the screen and parks; "ancien" is the lid as before. */
  constructor(private readonly mode: LidMode = "ecran") {}

  /**
   * Backing-store size this manager will capture at, given what the caller wants.
   * Rounded to a multiple of 256 so ordinary window resizes don't churn the
   * hidden map, and clamped by both the device's memory tier and `hardMax`
   * (GL_MAX_TEXTURE_SIZE — a larger bitmap simply fails to upload).
   */
  private budget(wantPx: number, hardMax: number): number {
    const tier =
      this.mode === "ancien"
        ? { floor: SNAP_PX_FLOOR, ceiling: ceilingForDevice() }
        : tierForScreen();
    const ceil = Math.min(tier.ceiling, hardMax > 0 ? hardMax : SNAP_PX_FLOOR);
    const want = Math.ceil(Math.max(wantPx, 1) / 256) * 256;
    return Math.max(Math.min(want, ceil), Math.min(tier.floor, ceil));
  }

  private ensureMap(style: string, px: number): mapboxgl.Map {
    if (this.map) {
      this.resizeTo(px);
      return this.map;
    }
    this.px = px;
    const cssPx = Math.round(px / (window.devicePixelRatio || 1));
    const el = document.createElement("div");
    el.style.cssText = `position:fixed;left:-10000px;top:0;width:${cssPx}px;height:${cssPx}px;`;
    document.body.appendChild(el);
    this.container = el;
    const map = new mapboxgl.Map({
      container: el,
      style,
      interactive: false,
      attributionControl: false,
      performanceMetricsCollection: false, // as the main map (GeoDrillMap)
      preserveDrawingBuffer: true, // required: we read the canvas after idle
      pitch: 0,
      bearing: 0,
      fadeDuration: 0,
      // Always mercator (the main map runs the style's globe, this one must not): a globe-rendered capture below ~z6 would be curved and useless as a
      // flat mercator lid texture.
      projection: "mercator",
    });
    map.on("load", () => {
      this.loaded = true;
    });
    this.map = map;
    return map;
  }

  /** Reusing the map beats re-creating it (each `new Map()` is a billed load), so
   *  a changed budget resizes in place. */
  private resizeTo(px: number) {
    if (!this.map || !this.container || px === this.px) return;
    this.px = px;
    const cssPx = Math.round(px / (window.devicePixelRatio || 1));
    this.container.style.width = `${cssPx}px`;
    this.container.style.height = `${cssPx}px`;
    this.map.resize();
  }

  /** Free the drawing buffer between shots ("ecran"): the map, its style and
   *  its workers stay, only the canvas shrinks. */
  private park() {
    this.parkTimer = null;
    if (!this.map || !this.container || this.px === 0) return;
    this.px = 0;
    this.container.style.width = `${PARK_CSS}px`;
    this.container.style.height = `${PARK_CSS}px`;
    this.map.resize();
  }

  /** Create the hidden map ahead of time (style + workers warm), so the first
   *  real capture doesn't pay initialisation. */
  warmup(style: string) {
    this.ensureMap(
      style,
      this.mode === "ancien" ? this.budget(SNAP_PX_FLOOR, SNAP_PX_CEIL) : WARM_PX,
    );
  }

  /** The hidden map's drawing-buffer width (device px) — for diagnostics. */
  hiddenMapPx(): number | null {
    return this.map?.getCanvas().width ?? null;
  }

  /** Backing-store size the next capture would use — for diagnostics. */
  pixelBudget(wantPx: number, hardMax: number): number {
    return this.budget(wantPx, hardMax);
  }

  /** Snapshot the style over `bounds`. Resolves null when superseded by a newer
   *  capture, on timeout, or when the frame looks blank.
   *  `wantPx`/`hardMax` size the capture — see `budget()`. */
  async capture(
    style: string,
    bounds: SnapshotBounds,
    wantPx = SNAP_PX_FLOOR,
    hardMax = SNAP_PX_CEIL,
  ): Promise<Snapshot | null> {
    const seq = ++this.seq;
    if (this.mode === "ancien") return this.shoot(seq, style, bounds, wantPx, hardMax);
    this.cancelPark();
    this.shooting++;
    try {
      return await this.shoot(seq, style, bounds, wantPx, hardMax);
    } finally {
      this.shooting--;
      // Landed, timed out or blank: park once idle. Superseded: the newer shot
      // owns the map.
      if (seq === this.seq) {
        this.cancelPark();
        this.parkTimer = setTimeout(() => {
          if (seq === this.seq && !this.shooting) this.park();
          else this.parkTimer = null;
        }, LID_PARK_DELAY_MS);
      }
    }
  }

  private cancelPark() {
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = null;
  }

  private async shoot(
    seq: number,
    style: string,
    bounds: SnapshotBounds,
    wantPx: number,
    hardMax: number,
  ): Promise<Snapshot | null> {
    const map = this.ensureMap(style, this.budget(wantPx, hardMax));
    // Wait for the style (first capture only; later ones resolve immediately).
    await this.until(() => this.loaded, 15000);
    if (seq !== this.seq || !this.map) return null;
    map.jumpTo(
      map.cameraForBounds(
        [
          [bounds.minLng, bounds.minLat],
          [bounds.maxLng, bounds.maxLat],
        ],
        { padding: 8 },
      ) as mapboxgl.CameraOptions,
    );
    // Let tiles + outline settle. `idle` can be flaky right after jumpTo — poll
    // loaded() with a hard timeout instead of trusting a single event.
    await this.frame();
    const ok = await this.until(() => !!this.map && this.map.loaded(), 12000);
    if (seq !== this.seq || !this.map) return null;
    if (!ok) return null;
    await this.wait(60); // small raster/label settle margin
    if (seq !== this.seq || !this.map) return null;

    const canvas = map.getCanvas();
    const bitmap = await createImageBitmap(canvas);
    if (seq !== this.seq) {
      bitmap.close();
      return null;
    }
    if (this.looksBlank(bitmap)) {
      bitmap.close();
      return null; // failed capture → caller keeps the status quo (no lid)
    }
    // Actual coverage: at pitch 0 / bearing 0 the canvas maps to an axis-aligned
    // mercator rectangle.
    const b = map.getBounds();
    if (!b) {
      bitmap.close();
      return null;
    }
    const nw = mapboxgl.MercatorCoordinate.fromLngLat({ lng: b.getWest(), lat: b.getNorth() });
    const se = mapboxgl.MercatorCoordinate.fromLngLat({ lng: b.getEast(), lat: b.getSouth() });
    return {
      bitmap,
      merc: { minX: nw.x, minY: nw.y, spanX: se.x - nw.x, spanY: se.y - nw.y },
    };
  }

  /** Guard against shipping a black/blank lid: sample the bitmap and require some
   *  variation between pixels. */
  private looksBlank(bitmap: ImageBitmap): boolean {
    try {
      const c = document.createElement("canvas");
      c.width = 8;
      c.height = 8;
      const ctx = c.getContext("2d");
      if (!ctx) return false;
      ctx.drawImage(bitmap, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let min = 255;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      return max - min < 4; // uniform frame = blank/black capture
    } catch {
      return false;
    }
  }

  private frame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    const t0 = performance.now();
    while (!cond()) {
      if (performance.now() - t0 > timeoutMs) return false;
      await this.wait(40);
    }
    return true;
  }

  destroy() {
    this.cancelPark();
    this.seq++;
    this.map?.remove();
    this.map = null;
    this.container?.remove();
    this.container = null;
    this.loaded = false;
  }
}
