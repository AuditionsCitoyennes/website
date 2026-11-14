// The plateau's lid: the basemap snapshot over the raised unit (its hidden
// map, plateau/mapSnapshot), its resolution bookkeeping, and the re-capture
// over the visible slice as the camera closes in (or the whole unit again as
// it pulls back). The whole-unit pictures are kept by the layer, a few of them
// (ac:lid-cache, plateau/lidCache.ts): a unit selected again shows its kept
// picture at once, with no shot.

import type mapboxgl from "mapbox-gl";
import type { Bounds } from "@/features/geo";
import { perfNote, perfOn, perfSpan } from "@/shared/perf/perf";
import { deviceSignals, deviceTier } from "@/shared/device/deviceTier";
import type { OutlineFC } from "../types";
import type { LidKeptMeta, PlateauWallLayer } from "../gl/PlateauWallLayer";
import { SnapshotManager, type Snapshot } from "../plateau/mapSnapshot";
import { lidCheck, lidMode } from "../plateau/lidSwitch";
import { keptAnswers, lidCacheBudget } from "../plateau/lidCache";
import { lidCacheMode } from "../plateau/lidCacheSwitch";
import { lidMap, lidMapFor, warmupAtLoad, type LidMapPlan } from "../plateau/lidMapSwitch";
import { boundsOfFeatures, unionBounds } from "../lib/polygon";
import { whenMapStill } from "../lib/stillMap";

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
  const snapshotMgr = new SnapshotManager(lidMode, lidCheck);
  // "ancien" (DEV, plateau/lidSwitch): the lid as before, its sizes and its
  // bookkeeping.
  const before = lidMode === "ancien";
  // When the hidden map is created, and whether there is one at all
  // (plateau/lidMapSwitch.ts): "none" — a device whose tier is "minimal", the
  // switch, or `ac:lid` on "aucun" — is no capture and no hidden map, the
  // plateau's top being the live map. Read at the map's load and at each
  // selection, with the device's tier of that moment.
  const planNow = (): LidMapPlan => lidMapFor(lidMap, deviceTier(), lidMode);
  // The plan the last selection read (the load's before any): a plateau
  // standing keeps the lid it has until the next selection.
  let plan: LidMapPlan = planNow();

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
  // The unit the lid's bookkeeping is for ("" when its features do not say).
  let lidFor = "";
  // The capture running, by key and by number: a superseded capture's end must
  // not clear the newer one's (it would let a refine or a re-run of the same
  // shot start over it, and cancel it). `inFlightSeq` is the plateau run it
  // lands for: a re-run asking for the same shot adopts it (its seq), or the
  // shot would land tagged with the superseded run and be thrown away.
  let inFlightKey = "";
  let inFlightId = 0;
  let inFlightSeq = 0;
  // The running shot's rectangle and px: a re-run asking for the same rectangle
  // at under LID_REFINE_RATIO more px adopts it rather than starting over.
  let inFlightBounds = "";
  let inFlightPx = 0;
  // A select's whole-unit shot (captureLid) is running ("ecran"). Until it
  // lands, the lid showing is the previous unit's, so hasTexture() says no:
  // a same-unit re-run of ensurePlateau then asks again and adopts the shot,
  // instead of bumping the plateau seq past it.
  let selectInFlight = false;
  let captureCount = 0;
  // Diagnostics for __acPlateau(): asks skipped because the same shot was
  // showing or running, and the running shots a newer plateau run adopted.
  let dedupeSkips = 0;
  let adopted = 0;
  let lastCapturePx = 0; // backing-store width the last capture asked for
  // What waits for the shot running to end (whenIdle).
  const idleJobs = new Set<() => void>();
  // ac:lid-cache: the asks a kept picture answered, the shots of a run since
  // left that were handed to the layer to keep, and the one of those held
  // until the map is still (its upload is not for the flight or the rise of
  // the unit selected since).
  let keeps = false; // pictures are kept (the budget at the last ask)
  let cacheHits = 0;
  let straysKept = 0;
  let strayHeld: { snap: Snapshot; key: string; meta: LidKeptMeta; cancel: () => void } | null =
    null;
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
  // slice a refine would capture is no finer than the texture showing (in
  // "ecran" by texel density, in "ancien" by rectangle span), so re-shooting
  // would not sharpen anything.
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

  /** What the layer may keep of the lid pictures now (plateau/lidCache.ts),
   *  handed to it at each ask: the switch and the device's tier can change
   *  under a page. Nothing under "ancien" (the lid as before). True: it keeps. */
  function syncCache(): boolean {
    const budget = lidCacheBudget({
      on: !before && lidCacheMode.value === "on",
      tier: deviceTier(),
      phone:
        (window.matchMedia?.("(pointer: coarse)").matches ?? false) &&
        Math.min(window.innerWidth, window.innerHeight) < 600,
      lowMemory: (deviceSignals().deviceMemory ?? Infinity) <= 4,
    });
    plateauWall.setLidKeepBudget(budget);
    keeps = budget.bytes > 0;
    return keeps;
  }

  /** The held picture of a run since left is given up. */
  function dropStray() {
    if (!strayHeld) return;
    strayHeld.cancel();
    strayHeld.snap.bitmap.close();
    strayHeld = null;
  }

  /** The whole-unit shot of a run since left: kept for the way back, uploaded
   *  once the map is still. One is held at a time. */
  function keepStray(snap: Snapshot, key: string, meta: LidKeptMeta) {
    dropStray();
    const cancel = whenMapStill(() => {
      strayHeld = null;
      plateauWall.keepLidTexture(snap, { key, meta });
      straysKept++;
    });
    strayHeld = { snap, key, meta, cancel };
  }

  /** The lid is this picture from now on: its resolution, what it covers. */
  function nowShowing(key: string, meta: LidKeptMeta, b: Bounds, raised: OutlineFC["features"]) {
    lidTargetKey = `${key}@${meta.px}`;
    lidMpp = meta.mpp;
    lidPx = meta.width;
    lidCovered = b;
    lidRaised = raised;
    lidFor = unitOf(raised);
  }

  /** The unit a lid is asked for ("" when its features do not say). */
  const unitOf = (raised: OutlineFC["features"]) => String(raised[0]?.properties?.id ?? "");

  /** A whole-unit shot: a new selection's, the "Carte" (DEV) one with the slabs. */
  async function captureLid(
    seq: number,
    raised: OutlineFC["features"],
    over?: Bounds,
    /** Re-shoot even the rectangle already showing (the DEV "Carte" lid). */
    force = false,
  ) {
    // A new selection (or the load's first): the plan is read again. "none"
    // from here on: the hidden map goes, and the lid showing with it.
    plan = planNow();
    if (plan === "none") return dropLid();
    if (force || before) return shootLid(seq, raised, over, force, true, true, !over);
    // A select asks from the outline's watcher, which runs before the camera's
    // (GeoDrillMap): let that flush end, then the flight a list row or a crumb
    // issues is under way. None (the scope followed a pan or a wheel, or the
    // outline came after the landing): the live camera is the unit's own.
    await Promise.resolve();
    return shootLid(seq, raised, over, false, !!getMap()?.isEasing(), true, !over);
  }

  /** No lid from now on ("none"): the hidden map removed (its WebGL context,
   *  its style and its tiles freed), the texture showing dropped, the shot
   *  running left to end unapplied (the manager's counter moved on). The
   *  pictures kept (ac:lid-cache) go too, and the one held for a still map:
   *  none of them will show. What waited for the running shot's end
   *  (whenIdle) runs now: that end will no longer say so. */
  function dropLid() {
    if (snapshotMgr.has()) snapshotMgr.destroy();
    dropStray();
    plateauWall.cancelKeptLid();
    if (keeps) plateauWall.setLidKeepBudget({ bytes: 0, count: 0 });
    keeps = false;
    if (lidCovered || Number.isFinite(lidMpp)) plateauWall.setLidTexture(null);
    reset();
    inFlightKey = "";
    inFlightId = 0;
    selectInFlight = false;
    for (const job of [...idleJobs]) {
      idleJobs.delete(job);
      job();
    }
  }

  async function shootLid(
    seq: number,
    raised: OutlineFC["features"],
    over: Bounds | undefined,
    force: boolean,
    /** Asked before a camera flight: the live camera is not this shot's. */
    preFlight: boolean,
    /** A whole-unit shot from captureLid (a select, the DEV "Carte" shot). */
    select = false,
    /** The rectangle is the unit's own (not a refine's slice). */
    whole = false,
  ) {
    if (plan === "none") return;
    if (force) lidTargetKey = "";
    const shot = over ?? boundsOfFeatures(raised);
    if (!shot) return;
    // "Carte" (DEV): the slabs' lids show the snapshot too.
    const extra = lidExtra();
    const b = extra ? unionBounds(shot, extra) : shot;
    // ac:lid-cache: a whole-unit picture can be kept, and a kept one shown.
    // Not the DEV "Carte" shot's wider rectangle, nor a forced re-shoot.
    const keepable = syncCache() && whole && !extra && !force;
    // Resolve the pixel budget HERE so it can go in the identity key below: the
    // same rectangle at a bigger budget is a genuinely sharper texture, and
    // keying on bounds alone would suppress that re-capture as a duplicate.
    // A shot asked for before a camera flight (a select from a list row or a
    // crumb, the DEV "Carte" shot) takes the floor: the live camera is still the
    // previous unit's — a zoom-OUT select (Lyon → Rhône) read the close camera
    // and asked for the ceiling. Every other shot (a refine, the widen back, a
    // scope that followed a pan or a wheel) is sized from the camera it is for,
    // between the floor and the ceiling.
    const wantPx = before || !preFlight ? lidPixelBudget(b) : 0;
    const px = snapshotMgr.pixelBudget(wantPx, plateauWall.maxTextureSize);
    // Already showing (or fetching) exactly this rectangle at this resolution →
    // don't cancel it to re-shoot the same thing. Fetching it counts too: before
    // the first lid lands, every re-run of ensurePlateau (each outline identity
    // change) asked again and the hidden map dropped the shot to start over.
    const rect = boundsKey(b);
    const key = `${rect}@${px}`;
    // The run asking for the rectangle already running adopts the shot: it
    // lands for that run ("ancien" did not, and dropped it as superseded). At
    // more px too, short of LID_REFINE_RATIO: a select's re-run after its
    // flight landed sizes from the camera, and starting over cancelled a shot
    // nearly done for a gain the refresh would not re-shoot for. A real
    // sharpening is left to refreshLidForZoom once it has landed.
    const adopt =
      !before &&
      !force &&
      !!inFlightKey &&
      inFlightBounds === rect &&
      px < inFlightPx * LID_REFINE_RATIO;
    if (adopt || (key === lidTargetKey && Number.isFinite(lidMpp))) {
      if (adopt) {
        inFlightSeq = seq;
        adopted++;
      }
      dedupeSkips++;
      return;
    }
    if (keepable) {
      // This unit's picture is kept, at least as fine as the one asked: it is
      // the unit's lid — no shot, no upload —, showing from its plateau's
      // commit on (at once if it stands already): the plateau standing keeps
      // its own lid while it sinks. A shot running for another run goes on,
      // and is kept when it lands.
      const kept = plateauWall.keptLid(rect);
      if (kept && keptAnswers(kept, px)) {
        // The one showing already, or waiting for its plateau: nothing to do.
        const current = plateauWall.keptLidCurrent() === rect;
        if (current || plateauWall.showKeptLid(rect, unitOf(raised))) {
          if (current) dedupeSkips++;
          else {
            cacheHits++;
            if (perfOn) perfNote("lid.kept", 0, { px: kept.px, from: "cache" });
          }
          nowShowing(rect, kept, b, raised);
          selectInFlight = false;
          return;
        }
      }
      // …or it landed for a run since left and is held for a still map: it
      // is this run's now, uploaded as a landing shot is.
      if (strayHeld && strayHeld.key === rect && keptAnswers(strayHeld.meta, px)) {
        const { snap, meta, cancel } = strayHeld;
        cancel();
        strayHeld = null;
        nowShowing(rect, meta, b, raised);
        selectInFlight = false;
        plateauWall.setLidTexture(snap, { key: rect, meta });
        cacheHits++;
        if (perfOn) perfNote("lid.kept", 0, { px: meta.px, from: "held" });
        return;
      }
    }
    // A picture of this rectangle held for a still map is about to be stale.
    if (strayHeld?.key === rect) dropStray();
    // A kept lid waiting for another unit's plateau will not show: this
    // shot's unit is the one selected now. (This unit's own stays: it shows
    // at the commit if this shot, a finer one, has not landed by then.)
    if (unitOf(raised) !== lidFor) plateauWall.cancelKeptLid();
    lidTargetKey = key;
    const id = ++captureCount;
    inFlightKey = key;
    inFlightId = id;
    inFlightSeq = seq;
    inFlightBounds = rect;
    inFlightPx = px;
    selectInFlight = select && !before;
    lastCapturePx = px;
    const endCapture = perfOn ? perfSpan("lid.capture", { px, preFlight }) : null;
    // "ancien" sizes without it, so its span reads the flight as "ecran" does,
    // once the select's watchers have run: `preFlight` means the same in both.
    let flightSeen = preFlight;
    if (endCapture && before)
      void Promise.resolve().then(() => {
        flightSeen = !!getMap()?.isEasing();
      });
    let got = false;
    let applied = false;
    try {
      const snap = await snapshotMgr.capture(style, b, px, plateauWall.maxTextureSize);
      got = !!snap;
      if (!snap) return;
      const meta: LidKeptMeta = { px, width: snap.bitmap.width, mpp: snapshotMpp(snap, b) };
      // The run it lands for: the newest one that asked for it while it ran.
      if ((inFlightId === id ? inFlightSeq : seq) !== plateauSeq()) {
        // Its run was left. A whole-unit picture is kept for the way back
        // (ac:lid-cache); any other is of no use.
        if (keepable) keepStray(snap, rect, meta);
        else snap.bitmap.close();
        return;
      }
      lidMpp = meta.mpp;
      lidPx = meta.width;
      lidCovered = b;
      lidRaised = raised;
      lidFor = unitOf(raised);
      plateauWall.setLidTexture(snap, keepable ? { key: rect, meta } : null);
      applied = true;
    } catch {
      /* no lid → status quo (walls + draped terrain) */
    } finally {
      // `got`: a bitmap came back; `applied`: it is the lid now.
      if (endCapture) endCapture({ got, applied, preFlight: flightSeen });
      // "ancien": any capture's end cleared the flag, as before.
      if (before || inFlightId === id) {
        inFlightKey = "";
        inFlightId = 0;
        selectInFlight = false;
        // No shot is running any more: what waited for that runs, once.
        for (const job of [...idleJobs]) {
          idleJobs.delete(job);
          job();
        }
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
    if (plan === "none" || !map || !plateauActive() || !lidRaised.length) return;
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
    // A re-shoot only helps if it is genuinely FINER than the texture showing.
    // Comparing against the screen alone is canvas-dependent — on a wide display
    // the snapshot can never beat it, and every settle would fire a fresh capture
    // forever. Requiring a real improvement makes this self-limiting. "ecran"
    // compares densities (the slice's ground span over the pixels it would get),
    // so a lid taken at the floor can refine to the ceiling over the same
    // rectangle; "ancien" compared the rectangles' spans alone, as before.
    const spanOf = (b: Bounds) => {
      const cos = Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180) || 1e-6;
      return Math.max((b.maxLng - b.minLng) * cos, b.maxLat - b.minLat);
    };
    const gain = !lidCovered
      ? Infinity
      : before
        ? spanOf(lidCovered) / Math.max(spanOf(want), 1e-9)
        : lidMpp /
          (boundsGroundSpanM(want) /
            snapshotMgr.pixelBudget(lidPixelBudget(want), plateauWall.maxTextureSize));
    const tooCoarse = lidMpp > mpp * LID_REFINE_RATIO;
    const wantsFiner = tooCoarse && gain >= LID_REFINE_RATIO;
    lidRefineBlockedByGain = tooCoarse && !wantsFiner;
    const tooFine = lidMpp * LID_WIDEN_RATIO < mpp;
    if (covers && !wantsFiner && !tooFine) return;
    // Uncovered or zoomed back out → the whole unit; otherwise the padded slice.
    const whole = tooFine || !covers;
    // A slice that is the whole unit (all of it in view) is a whole-unit
    // picture too: kept in place of the coarser one (ac:lid-cache).
    const wholeUnit = whole || boundsKey(want) === boundsKey(sel);
    void shootLid(plateauSeq(), lidRaised, whole ? sel : want, false, false, false, wholeUnit);
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
    lidFor = "";
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
      // True when the lid IS too coarse but a refine cannot help: the slice it
      // would capture is no finer than the texture showing (its rectangle no
      // smaller, or its pixels already at the ceiling). Separates "the refine
      // never fired" from "the lid is capped at selectionSpan / SNAP_PX".
      lidRefineBlockedByGain,
      // How the lid is captured (plateau/lidSwitch), what the last capture
      // asked for, and the hidden map's drawing buffer now (small once parked).
      lidMode,
      lidCapturePx: lastCapturePx || null,
      hiddenMapPx: snapshotMgr.hiddenMapPx(),
      // When the hidden map is created (plateau/lidMapSwitch): the switch, the
      // plan in force, what created the one there is (null: none), and how
      // many this page has created.
      lidMap,
      lidMapPlan: plan,
      hiddenMapBy: snapshotMgr.createdBy,
      hiddenMapsCreated: snapshotMgr.created,
      // How shots are judged, how they ended, and how many read pixels back.
      lidCheck,
      lidShotEnds: { ...snapshotMgr.ends },
      lidReadbacks: snapshotMgr.readbacks,
      // Asks the in-flight dedupe skipped, and running shots a re-run adopted.
      lidDedupeSkips: dedupeSkips,
      lidAdopted: adopted,
      // ac:lid-cache: the switch, the asks a kept picture answered, the shots
      // of a run since left handed to the layer to keep, the one held for a
      // still map, and the layer's textures — what
      // is kept (the least recently shown first), its bytes and the cap, the
      // key showing, the uploads and the pictures shown again without one.
      lidCache: {
        mode: lidCacheMode.value,
        hits: cacheHits,
        straysKept,
        strayHeld: strayHeld?.key ?? null,
        ...plateauWall.lidTextureStats(),
      },
    };
  }

  return {
    capture: captureLid,
    /** After a gesture settles: bring the texture up to the camera's resolution. */
    scheduleRefresh: scheduleLidRefresh,
    reset,
    /** A texture is showing (or has been): its resolution is known. Not while a
     *  select's shot runs ("ecran"): the lid showing is the previous unit's.
     *  Nor, while pictures are kept (ac:lid-cache), when the lid is another
     *  unit's than the plateau standing — a kept lid waiting for a plateau
     *  the visitor left before it stood: the run for the standing unit then
     *  asks for its own again. */
    hasTexture: () =>
      Number.isFinite(lidMpp) &&
      !selectInFlight &&
      (!keeps || !lidFor || !plateauWall.scopeId || lidFor === plateauWall.scopeId),
    /** The rectangle the current lid texture covers. */
    covered: () => lidCovered,
    /** A shot is running (the hidden map is loading tiles and rendering). */
    busy: () => !!inFlightKey,
    /** Runs `job` once no shot is running: now if none is, else when the one
     *  running ends (landed or not). Returns its cancellation. */
    whenIdle: (job: () => void): (() => void) => {
      if (!inFlightKey) {
        job();
        return () => {};
      }
      idleJobs.add(job);
      return () => void idleJobs.delete(job);
    },
    /** The visible map's load: the hidden map created now — on the world
     *  ("boot"), or on the first place a plateau will stand on, when one is
     *  known ("first-place": `outline`, the rectangle of the scope's outline,
     *  else `framed`, the one the first camera command frames) — or not at
     *  all yet (plateau/lidMapSwitch.ts). */
    warmup: (outline: Bounds | null = null, framed: Bounds | null = null) => {
      plan = planNow();
      const warm = warmupAtLoad(plan, outline, framed);
      if (!warm) return;
      // On a place: at the size of a select's shot taken before its flight
      // (the floor), which the first shot is when the intro's tilt starts it.
      snapshotMgr.warmup(
        style,
        warm.place,
        warm.place ? snapshotMgr.pixelBudget(0, plateauWall.maxTextureSize) : 0,
      );
    },
    /** The main map's WebGL context was lost: the layer's lid textures went
     *  with it, and the lid's bookkeeping starts over. */
    contextLost: () => {
      plateauWall.forgetLidTextures();
      reset();
    },
    destroy: () => {
      dropStray();
      snapshotMgr.destroy();
    },
    probe,
  };
}
