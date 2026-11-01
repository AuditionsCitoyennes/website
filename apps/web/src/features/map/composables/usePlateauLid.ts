// The plateau's lid: the basemap snapshot over the raised unit (its hidden
// map, plateau/mapSnapshot), its resolution bookkeeping, and the re-capture
// over the visible slice as the camera closes in (or the whole unit again as
// it pulls back).

import type mapboxgl from "mapbox-gl";
import type { Bounds } from "@/features/geo";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { OutlineFC } from "../types";
import type { PlateauWallLayer } from "../gl/PlateauWallLayer";
import { SnapshotManager, type Snapshot } from "../plateau/mapSnapshot";
import { lidMode } from "../plateau/lidSwitch";
import { boundsOfFeatures, unionBounds } from "../lib/polygon";

export interface PlateauLidInputs {
  getMap: () => mapboxgl.Map | null;
  /** The plateau's layer: the texture goes to it, its GL ceiling caps the budget. */
  wall: PlateauWallLayer;
  /** The map style the hidden snapshot map renders. */
  style: string;
  /** The plateau pipeline's run counter: a capture started by a superseded run is dropped. */
  plateauSeq: () => number;
  /** Whether a plateau is standing (no refine without one). */
  plateauActive: () => boolean;
  /** "Carte" (DEV): the slabs' rectangles the snapshot must take in too; null otherwise. */
  lidExtra: () => Bounds | null;
}

export function usePlateauLid({
  getMap,
  wall: plateauWall,
  style,
  plateauSeq,
  plateauActive,
  lidExtra,
}: PlateauLidInputs) {
  const snapshotMgr = new SnapshotManager(lidMode);
  // "aucun" (DEV, plateau/lidSwitch): no capture, no hidden map — the top is the
  // draped terrain. "ancien": the lid as before, its sizes and its bookkeeping.
  const noLid = lidMode === "aucun";
  const before = lidMode === "ancien";

  // Snapshot the PURE basemap over the selection and hand it to the lid (outlines
  // are drawn over it as constant-width GL vector lines, not baked). Fire-and-forget:
  // the plateau rises on the draped terrain as before; when the snapshot lands (and
  // the selection hasn't changed) the lid appears and fills the rim gap with
  // identical map content — no visible pop.
  // The lid is a FIXED-resolution snapshot of the selection's bounds, so raising a
  // whole région froze its top at ~z8 detail: zooming in showed no more map until
  // you drilled a level down. These track the current texture's ground resolution
  // so the lid can be re-captured over the visible part as the camera closes in —
  // fragments outside a capture discard and fall back to the draped terrain, which
  // is still the real map, so a tighter texture is always safe.
  const EARTH_CIRCUMFERENCE_M = 40075016.686;
  let lidMpp = Infinity; // metres per texel of the lid currently displayed
  let lidPx = 0; // backing-store width the current lid was captured at
  let lidRaised: OutlineFC["features"] = [];
  // The capture running, by key and by number: a superseded capture's end must
  // not clear the newer one's (it would let a refine or a re-run of the same
  // shot start over it, and cancel it).
  let inFlightKey = "";
  let inFlightId = 0;
  let captureCount = 0;
  let lastCapturePx = 0; // backing-store width the last capture asked for
  let lidRecaptureTimer: ReturnType<typeof setTimeout> | null = null;
  // Bounds the current (or in-flight) lid texture covers. Guards against
  // re-shooting a texture we already have — snapshotMgr.capture() bumps its own
  // seq, so a redundant capture CANCELS an in-flight refine and then overwrites
  // lidMpp with the coarse full-selection value, which is exactly what made
  // zooming appear to never sharpen.
  let lidTargetKey = "";
  // Geographic rectangle the current lid texture covers — the lid discards outside
  // it, so the visible plateau must stay inside this or the wall shows through.
  let lidCovered: Bounds | null = null;
  // Diagnostic for __acPlateau(): the lid is coarser than the screen, but the
  // rectangle a refine would capture is no smaller than the one we already have,
  // so re-shooting would not sharpen anything.
  let lidRefineBlockedByGain = false;
  const boundsKey = (b: Bounds) =>
    `${b.minLat.toFixed(4)},${b.maxLat.toFixed(4)},${b.minLng.toFixed(4)},${b.maxLng.toFixed(4)}`;
  // Re-capture once the lid is this much coarser than the screen, or this much
  // finer (zoomed back out, so the crisp patch no longer covers the view).
  // 1.3, not 2: a texture coarser than the screen is visibly soft, and at 2× a
  // département's lid (~46 m/texel) stayed blurry until the view dropped under
  // ~23 km — roughly two zoom levels of "zooming does nothing", which is exactly
  // the reported symptom. A refine lands at ~0.73× the screen resolution, so 1.3
  // is still comfortably clear of a re-trigger (no thrash).
  const LID_REFINE_RATIO = 1.3;
  const LID_WIDEN_RATIO = 4;
  // Fraction of the visible slice added on each side of a refine capture.
  const LID_MARGIN = 0.35;

  /** Ground metres spanned by the LONGER side of `b` — what the square capture fits. */
  function boundsGroundSpanM(b: Bounds): number {
    const lat = (b.minLat + b.maxLat) / 2;
    const wM =
      ((b.maxLng - b.minLng) / 360) * EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
    const hM = ((b.maxLat - b.minLat) / 360) * EARTH_CIRCUMFERENCE_M;
    return Math.max(wM, hM);
  }

  /**
   * Backing-store pixels the capture of `b` needs to resolve as finely as the
   * screen: span / px <= metres-per-device-pixel. Demand-driven on purpose — it
   * scales down on a phone and up on a large HiDPI display, and SnapshotManager
   * clamps it by the device's memory tier and GL_MAX_TEXTURE_SIZE.
   */
  function lidPixelBudget(b: Bounds): number {
    const mpp = viewMpp();
    if (!Number.isFinite(mpp) || mpp <= 0) return 2048;
    return Math.ceil(boundsGroundSpanM(b) / mpp);
  }

  /** Ground metres per texel of a snapshot. */
  function snapshotMpp(snap: Snapshot, b: Bounds): number {
    const lat = (b.minLat + b.maxLat) / 2;
    const groundSpanM = snap.merc.spanX * EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
    return groundSpanM / snap.bitmap.width;
  }

  /**
   * Ground metres per screen pixel at the current camera — DEVICE pixels, to match
   * `snapshotMpp`, which divides by the snapshot's backing-store width.
   *
   * This used `clientWidth` (CSS pixels), so on a HiDPI display the screen looked
   * `devicePixelRatio`× coarser than it is and the lid read as sharp enough when it
   * was not: at dpr 2 the refine threshold was effectively 2.6, not 1.3, and the
   * plateau top stayed visibly softer than the live map around it.
   */
  function viewMpp(): number {
    const map = getMap();
    if (!map) return Infinity;
    const b = map.getBounds();
    const w = map.getCanvas().width;
    if (!b || !w) return Infinity;
    const lat = (b.getNorth() + b.getSouth()) / 2;
    const spanM =
      ((b.getEast() - b.getWest()) / 360) * EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
    return spanM / w;
  }

  /** A whole-unit shot: a new selection's, the "Carte" (DEV) one with the slabs. */
  function captureLid(
    seq: number,
    raised: OutlineFC["features"],
    over?: Bounds,
    /** Re-shoot even the rectangle already showing (the DEV "Carte" lid). */
    force = false,
  ) {
    return shootLid(seq, raised, over, force, false);
  }

  async function shootLid(
    seq: number,
    raised: OutlineFC["features"],
    over: Bounds | undefined,
    force: boolean,
    /** The padded visible slice (a refine), not the whole unit. */
    slice: boolean,
  ) {
    if (noLid) return;
    if (force) lidTargetKey = "";
    const shot = over ?? boundsOfFeatures(raised);
    if (!shot) return;
    // "Carte" (DEV): the slabs' lids show the snapshot too.
    const extra = lidExtra();
    const b = extra ? unionBounds(shot, extra) : shot;
    // Resolve the pixel budget HERE so it can go in the identity key below: the
    // same rectangle at a bigger budget is a genuinely sharper texture, and
    // keying on bounds alone would suppress that re-capture as a duplicate.
    // A whole-unit shot takes the floor, whatever the camera: it is asked for
    // before the flight, so the live camera is the previous unit's — a zoom-OUT
    // select (Lyon → Rhône) read the close camera and asked for the ceiling.
    // A refine is sized from the camera it sharpens for, capped by the ceiling.
    const wantPx = before || slice ? lidPixelBudget(b) : 0;
    const px = snapshotMgr.pixelBudget(wantPx, plateauWall.maxTextureSize);
    // Already showing (or fetching) exactly this rectangle at this resolution →
    // don't cancel it to re-shoot the same thing. Fetching it counts too: before
    // the first lid lands, every re-run of ensurePlateau (each outline identity
    // change) asked again and the hidden map dropped the shot to start over.
    const key = `${boundsKey(b)}@${px}`;
    if (key === lidTargetKey && (Number.isFinite(lidMpp) || (!before && inFlightKey === key))) {
      return;
    }
    lidTargetKey = key;
    const id = ++captureCount;
    inFlightKey = key;
    inFlightId = id;
    lastCapturePx = px;
    try {
      const endCapture = perfOn ? perfSpan("lid.capture", { px }) : null;
      const snap = await snapshotMgr.capture(style, b, px, plateauWall.maxTextureSize);
      if (endCapture) endCapture({ got: !!snap });
      if (!snap) return;
      if (seq !== plateauSeq()) {
        snap.bitmap.close();
        return;
      }
      lidMpp = snapshotMpp(snap, b);
      lidPx = snap.bitmap.width;
      lidCovered = b;
      lidRaised = raised;
      plateauWall.setLidTexture(snap);
    } catch {
      /* no lid → status quo (walls + draped terrain) */
    } finally {
      // "ancien": any capture's end cleared the flag, as before.
      if (before || inFlightId === id) {
        inFlightKey = "";
        inFlightId = 0;
      }
    }
  }

  /**
   * Keep the lid's resolution in step with the camera. Called (debounced) after a
   * gesture settles: if the texture is much coarser than the screen, re-capture
   * over the visible slice of the selection; if the camera pulled far back, widen
   * to the whole selection again.
   */
  function refreshLidForZoom() {
    const map = getMap();
    if (noLid || !map || !plateauActive() || !lidRaised.length) return;
    // A capture is running — come back rather than dropping this refine on the
    // floor (the old code returned here and only retried on the NEXT gesture,
    // so a refine lost to the initial capture never happened at all).
    if (inFlightKey) {
      scheduleLidRefresh();
      return;
    }
    const own = boundsOfFeatures(lidRaised);
    if (!own) return;
    const extra = lidExtra();
    const sel = extra ? unionBounds(own, extra) : own;
    const mpp = viewMpp();
    if (!Number.isFinite(mpp)) return;

    const v = map.getBounds();
    if (!v) return;
    // The visible slice of the selection — the region the lid MUST cover, because
    // the lid shader discards fragments outside the captured rectangle and the
    // hole shows the far wall's inner face straight through the plateau top.
    const clip = {
      minLat: Math.max(sel.minLat, v.getSouth()),
      maxLat: Math.min(sel.maxLat, v.getNorth()),
      minLng: Math.max(sel.minLng, v.getWest()),
      maxLng: Math.min(sel.maxLng, v.getEast()),
    };
    if (clip.minLat >= clip.maxLat || clip.minLng >= clip.maxLng) return; // selection off-screen
    // Generous margin: a capture takes ~1 s, so the texture must already cover
    // where the camera is heading, not just where it is. Doubling the slice keeps
    // ordinary pans and a zoom step inside the existing texture instead of
    // punching a transient hole in the plateau.
    const padLat = (clip.maxLat - clip.minLat) * LID_MARGIN;
    const padLng = (clip.maxLng - clip.minLng) * LID_MARGIN;
    const want: Bounds = {
      minLat: Math.max(sel.minLat, clip.minLat - padLat),
      maxLat: Math.min(sel.maxLat, clip.maxLat + padLat),
      minLng: Math.max(sel.minLng, clip.minLng - padLng),
      maxLng: Math.min(sel.maxLng, clip.maxLng + padLng),
    };

    // Re-capture when the texture is too coarse for the screen, when the camera
    // pulled far enough back that a tight texture is wasteful — OR, the case the
    // resolution test alone missed, when the visible plateau has moved OUTSIDE
    // what the texture covers (a pan at constant zoom, or a fast zoom-out).
    const covers =
      lidCovered !== null &&
      clip.minLat >= lidCovered.minLat &&
      clip.maxLat <= lidCovered.maxLat &&
      clip.minLng >= lidCovered.minLng &&
      clip.maxLng <= lidCovered.maxLng;
    // A capture is a fixed pixel budget over whatever rectangle we ask for, so a
    // re-shoot only sharpens if the new rectangle is genuinely SMALLER than the
    // current one. Comparing against the screen alone is canvas-dependent — on a
    // wide display the snapshot can never beat it, and every settle would fire a
    // fresh capture forever. Requiring a real improvement makes this self-limiting.
    const spanOf = (b: Bounds) => {
      const cos = Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180) || 1e-6;
      return Math.max((b.maxLng - b.minLng) * cos, b.maxLat - b.minLat);
    };
    const gain = lidCovered ? spanOf(lidCovered) / Math.max(spanOf(want), 1e-9) : Infinity;
    const tooCoarse = lidMpp > mpp * LID_REFINE_RATIO;
    const wantsFiner = tooCoarse && gain >= LID_REFINE_RATIO;
    lidRefineBlockedByGain = tooCoarse && !wantsFiner;
    const tooFine = lidMpp * LID_WIDEN_RATIO < mpp;
    if (covers && !wantsFiner && !tooFine) return;
    // Uncovered or zoomed back out → the whole unit; otherwise the padded slice.
    const whole = tooFine || !covers;
    void shootLid(plateauSeq(), lidRaised, whole ? sel : want, false, !whole);
  }

  function scheduleLidRefresh() {
    if (lidRecaptureTimer) clearTimeout(lidRecaptureTimer);
    lidRecaptureTimer = setTimeout(() => {
      lidRecaptureTimer = null;
      refreshLidForZoom();
    }, 350);
  }

  /** No lid any more (the plateau cleared): forget its resolution so a later
   *  plateau starts fresh. */
  function reset() {
    lidMpp = Infinity;
    lidPx = 0;
    lidRaised = [];
    lidTargetKey = "";
    lidCovered = null;
    lidRefineBlockedByGain = false;
  }

  /** The lid's share of the __acPlateau probe (read-only, present in production). */
  function probe() {
    const vm = viewMpp();
    return {
      // Backing-store width the lid was captured at, vs what the current view
      // would ask for and what the device/GL actually allow.
      lidTexturePx: lidPx || null,
      lidTexturePxWanted: lidCovered ? lidPixelBudget(lidCovered) : null,
      lidTexturePxAllowed: lidCovered
        ? snapshotMgr.pixelBudget(lidPixelBudget(lidCovered), plateauWall.maxTextureSize)
        : null,
      glMaxTextureSize: plateauWall.maxTextureSize,
      metresPerDevicePixel: +vm.toFixed(2),
      metresPerLidTexel: Number.isFinite(lidMpp) ? +lidMpp.toFixed(2) : null,
      // >1 means the lid is COARSER than the screen (blurry top).
      lidCoarserThanScreenBy: Number.isFinite(lidMpp) ? +(lidMpp / vm).toFixed(2) : null,
      lidCovers: boundsOfFeatures(lidRaised),
      // True when the lid IS too coarse but a refine cannot help: a capture is
      // a fixed pixel budget over whatever rectangle we ask for, so it only
      // sharpens if that rectangle shrinks — and there is nothing to shrink to
      // while the whole selection is on screen. Separates "the refine never
      // fired" from "the lid is capped at selectionSpan / SNAP_PX".
      lidRefineBlockedByGain,
      // How the lid is captured (plateau/lidSwitch), what the last capture
      // asked for, and the hidden map's drawing buffer now (small once parked).
      lidMode,
      lidCapturePx: lastCapturePx || null,
      hiddenMapPx: snapshotMgr.hiddenMapPx(),
    };
  }

  return {
    capture: captureLid,
    /** After a gesture settles: bring the texture up to the camera's resolution. */
    scheduleRefresh: scheduleLidRefresh,
    reset,
    /** A texture is showing (or has been): its resolution is known. */
    hasTexture: () => Number.isFinite(lidMpp),
    /** The rectangle the current lid texture covers. */
    covered: () => lidCovered,
    /** Hidden lid-snapshot map: pay the style init now (the load handler). */
    warmup: () => {
      if (!noLid) snapshotMgr.warmup(style);
    },
    destroy: () => snapshotMgr.destroy(),
    probe,
  };
}
