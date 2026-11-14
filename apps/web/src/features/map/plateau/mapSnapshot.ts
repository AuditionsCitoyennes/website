import mapboxgl from "mapbox-gl";
import { DEFAULT_LID_CHECK, type LidCheck, type LidMode } from "./lidSwitch";
import {
  settleAndGrab,
  settleAndGrabPixels,
  uniformSample,
  type Shot,
  type ShotEnd,
  type ShotIO,
} from "./lidShot";
import { lidTier, shotPixels, type LidTier } from "./lidTier";
import { labelGlyphOptions } from "../labelFont";
import { nativePixelRatio, screenPerMapPixel } from "../pixelRatio";

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
//
// A blank capture (a buffer never drawn, cleared, or a lost context) is told
// from the hidden map's own signals, counted here and judged in lidShot.ts: no
// pixel is read on the main thread, except for a shot with a map error since
// its jump (failed tiles draw a plain background), which still gets the 8×8
// readback (looksBlank). `ac:lid-check=pixels` (lidSwitch.ts, the testing
// tools) keeps the readback on every shot, as before lid-readback.

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
 *  each ask so a rotated phone or a resized window gets its own. In screen
 *  pixels: the screen's ratio, whatever the maps draw at (pixelRatio.ts). */
function tierForScreen(): LidTier {
  return lidTier({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: nativePixelRatio(),
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
// A hidden map warmed up on its first place (lidMapSwitch.ts "first-place")
// is created at its first shot's size instead, on that shot's rectangle: the
// tiles and the frame it prepares are the first lid's. It waits for that shot
// up to WARM_PARK_DELAY_MS (a slow boot's first selection comes long after
// the load), then parks like any other.
const WARM_PX = 512;
const PARK_CSS = 64;
const LID_PARK_DELAY_MS = 6000;
const WARM_PARK_DELAY_MS = 30000;
/** The margin around a shot's rectangle, css px of the hidden map. */
const SHOT_PADDING = 8;

export class SnapshotManager {
  private map: mapboxgl.Map | null = null;
  private container: HTMLDivElement | null = null;
  private loaded = false;
  private seq = 0;
  private px = 0; // 0 while parked: the next shot resizes it back
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private shooting = 0; // captures running
  // The hidden map's signals (lidShot.ts ShotSignals), kept by its listeners.
  private readonly sig = { renders: 0, clearedAt: 0, lost: false, errors: 0 };
  /** How each shot ended, and how many ran the 8×8 readback — for diagnostics. */
  readonly ends: Record<ShotEnd, number> = {
    ok: 0,
    superseded: 0,
    timeout: 0,
    lost: 0,
    undrawn: 0,
    blank: 0,
    failed: 0,
  };
  readbacks = 0;

  /** What created the hidden map, for diagnostics: the load's warm-up on the
   *  world ("boot") or on the first place ("place"), or a shot ("shot"). */
  createdBy: "boot" | "place" | "shot" | null = null;
  /** Hidden maps created by this manager so far (each one is a Mapbox map). */
  created = 0;

  /** `mode`: "ecran" sizes from the screen and parks; "ancien" is the lid as before.
   *  `check`: how a shot is judged before it is returned (lidSwitch.ts). */
  constructor(
    private readonly mode: LidMode = "ecran",
    private readonly check: LidCheck = DEFAULT_LID_CHECK,
  ) {}

  /**
   * Backing-store size this manager will capture at, given what the caller wants.
   * Rounded to a multiple of 256 so ordinary window resizes don't churn the
   * hidden map, and clamped by both the device's memory tier and `hardMax`
   * (GL_MAX_TEXTURE_SIZE — a larger bitmap simply fails to upload). Settled
   * in screen pixels (lidTier.ts shotPixels): the same number as ever while
   * the maps draw at the screen's ratio.
   */
  private budget(wantPx: number, hardMax: number): number {
    const tier =
      this.mode === "ancien"
        ? { floor: SNAP_PX_FLOOR, ceiling: ceilingForDevice() }
        : tierForScreen();
    return shotPixels(wantPx, hardMax, tier, SNAP_PX_FLOOR, screenPerMapPixel());
  }

  /** The hidden map, created if there is none: on `place` when one is given
   *  (the camera a shot of that rectangle takes), else on Mapbox's default
   *  view. `by`: who asks, kept for diagnostics. */
  private ensureMap(
    style: string,
    px: number,
    place: SnapshotBounds | null,
    by: "boot" | "place" | "shot",
  ): mapboxgl.Map {
    if (this.map) {
      this.resizeTo(px);
      return this.map;
    }
    this.px = px;
    this.createdBy = by;
    this.created++;
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
      // The main map's labels (ac:glyphs): the picture shows the letters the map shows.
      ...labelGlyphOptions(),
      // Created on its first shot's rectangle: the tiles it asks for from its
      // first frame are that shot's, not the world's.
      ...(place
        ? {
            bounds: [
              [place.minLng, place.minLat],
              [place.maxLng, place.maxLat],
            ] as [[number, number], [number, number]],
            fitBoundsOptions: { padding: SHOT_PADDING },
          }
        : {}),
    });
    map.on("load", () => {
      this.loaded = true;
    });
    // What a capture's frame went through (lidShot.ts): a resize or a context
    // restore clears the drawing buffer until the next render.
    map.on("render", () => {
      this.sig.renders++;
    });
    map.on("resize", () => {
      this.sig.clearedAt = this.sig.renders;
    });
    map.on("webglcontextlost", () => {
      this.sig.lost = true;
    });
    map.on("webglcontextrestored", () => {
      this.sig.lost = false;
      this.sig.clearedAt = this.sig.renders;
    });
    map.on("error", (e) => {
      this.sig.errors++;
      console.error(e.error); // Mapbox's own line when nobody listens (Evented.fire)
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
   *  real capture doesn't pay initialisation. With a `place` ("ecran" only):
   *  created on that rectangle at `px`, the size of the shot expected first,
   *  so that shot's tiles and frame are being made ready too. */
  warmup(style: string, place: SnapshotBounds | null = null, px = 0) {
    if (this.map) return;
    if (!place || this.mode === "ancien" || px <= 0) {
      this.ensureMap(
        style,
        this.mode === "ancien"
          ? this.budget(SNAP_PX_FLOOR, SNAP_PX_CEIL)
          : Math.round(WARM_PX / screenPerMapPixel()),
        null,
        "boot",
      );
      return;
    }
    this.ensureMap(style, px, place, "place");
    // No shot may come for it (a visit that never selects): its drawing
    // buffer is given back as after a shot, only later.
    const seq = this.seq;
    this.cancelPark();
    this.parkTimer = setTimeout(() => {
      if (seq === this.seq && !this.shooting) this.park();
      else this.parkTimer = null;
    }, WARM_PARK_DELAY_MS);
  }

  /** Whether the hidden map exists. */
  has(): boolean {
    return !!this.map;
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
   *  capture, on timeout, or when the frame is blank (lidShot.ts ShotEnd).
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
    // No hidden map yet (no place was known at the load, lidMapSwitch.ts):
    // created here, on this shot's rectangle.
    const map = this.ensureMap(style, this.budget(wantPx, hardMax), bounds, "shot");
    // Wait for the style (first capture only; later ones resolve immediately).
    // A shot superseded meanwhile (a newer one, or the hidden map removed)
    // stops waiting at once.
    await this.until(() => this.loaded || seq !== this.seq, 15000);
    if (seq !== this.seq || !this.map) return null;
    map.jumpTo(
      map.cameraForBounds(
        [
          [bounds.minLng, bounds.minLat],
          [bounds.maxLng, bounds.maxLat],
        ],
        { padding: SHOT_PADDING },
      ) as mapboxgl.CameraOptions,
    );
    // A frame after the jump even when the camera did not move (the hidden
    // map was created on this very rectangle): the shot is judged on one.
    map.triggerRepaint();
    const at = { renders: this.sig.renders, errors: this.sig.errors };
    // Let tiles + outline settle. `idle` can be flaky right after jumpTo — poll
    // loaded() with a hard timeout instead of trusting a single event, then the
    // 60 ms settle margin (lidShot.ts SETTLE_MS). A "client" run's commit hold
    // is timed against that wait (relief/reliefSwitch.ts
    // DEFAULT_RELIEF_COMMIT_HOLD_MS): change one, measure both. Under
    // ac:lid-check=signaux (the default) no pixel is read after it
    // (plateau/lidShot.ts).
    const canvas = map.getCanvas();
    const io: ShotIO<ImageBitmap> = {
      map,
      signals: this.sig,
      alive: () => !!this.map,
      current: () => seq === this.seq && !!this.map,
      glLost: () =>
        (canvas.getContext("webgl2") as WebGL2RenderingContext | null)?.isContextLost() ?? true,
      frame: () => this.frame(),
      wait: (ms) => this.wait(ms),
      until: (cond, ms) => this.until(cond, ms),
      grab: () => createImageBitmap(canvas),
      close: (b) => b.close(),
      blank: (b) => {
        this.readbacks++;
        return this.looksBlank(b);
      },
    };
    let shot: Shot<ImageBitmap>;
    if (__TEST_TOOLS__ && this.check === "pixels") {
      try {
        shot = await settleAndGrabPixels(io);
      } catch (e) {
        this.ends.failed++; // a grab that rejects reaches the caller, as before
        throw e;
      }
    } else {
      shot = await settleAndGrab(io, at);
    }
    this.ends[shot.end]++;
    // Superseded, timed out, lost, undrawn or blank: the caller keeps the status quo (no lid).
    if (!shot.bitmap) return null;
    const bitmap = shot.bitmap;
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
      // uniform frame = blank/black capture
      return uniformSample(ctx.getImageData(0, 0, 8, 8).data);
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
    this.px = 0;
    this.createdBy = null;
    // A new hidden map counts from 0.
    Object.assign(this.sig, { renders: 0, clearedAt: 0, lost: false, errors: 0 });
  }
}
