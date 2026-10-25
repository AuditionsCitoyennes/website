// The analyses' slabs on the raised unit (see SlabSpec, PlateauWallLayer.setSlabs):
// sized once per unit framed for the camera the fit lands on (useMapCamera's
// fitCam), their presence animated when they come or go alone, the ring's
// parts following the overlay's pick and hover (setRing), their lid mode and
// the card colour the opaque lids take.

import type mapboxgl from "mapbox-gl";
import type { Bounds } from "@/features/geo";
import { perfNote, perfOn } from "@/shared/perf/perf";
import { slabRects, solveSlabScales, type SlabCam, type SlabRect, type SlabScales } from "../lib";
import { boundsContain, boundsOfFeatures, unionBounds } from "../lib/polygon";
import { WALL_OVERSHOOT } from "../gl/mesh";
import { NO_RING, type PlateauWallLayer, type SlabRingState } from "../gl/PlateauWallLayer";
import type { OutlineFC, SlabSpec } from "../types";
import type { FitCam } from "./useMapCamera";
import { RISE_MS, SINK_MS } from "./usePlateau";
import type { usePlateauLid } from "./usePlateauLid";

export interface PlateauSlabsInputs {
  getMap: () => mapboxgl.Map | null;
  wall: PlateauWallLayer;
  /** The slabs asked for (the `slabs` prop). */
  slabs: () => SlabSpec | null | undefined;
  /** The camera the last fit lands on (useMapCamera.fitCam.get): read only. */
  fitCam: () => FitCam | null;
  /** The camera of the moment, as the slabs are sized with (useMapCamera). */
  liveSlabCam: () => SlabCam;
  /** The standing plateau (usePlateau): its unit, its box, its run counter. */
  plateau: {
    raised: () => OutlineFC["features"];
    bbox: () => Bounds | null;
    seq: () => number;
  };
  /** The lid (usePlateauLid): the DEV "Carte" lid takes the slabs' rectangles in. */
  lid: Pick<ReturnType<typeof usePlateauLid>, "capture" | "covered">;
  /** The pins drawn on a slab, hidden (useMapPins). */
  hidePinsUnderSlabs: () => void;
}

export function usePlateauSlabs({
  getMap,
  wall: plateauWall,
  slabs,
  fitCam,
  liveSlabCam,
  plateau,
  lid,
  hidePinsUnderSlabs,
}: PlateauSlabsInputs) {
  // ---- The analyses' slabs (see SlabSpec, PlateauWallLayer.setSlabs) --------------
  // Raised pieces beside the unit standing raised, drawn with its plateau: built
  // for it at its swap (they rise with it from 0) or when the analyses come on
  // over it (they rise alone), gone with it — another unit raised, the world
  // view, the lieu zone, a failure — or when the analyses go (they sink alone).
  // Sized once per unit framed (map/lib/slabs), for the camera the fit lands on.
  // The ring's parts follow the overlay's pick and hover (setRing).

  /** What the slabs standing now were built from. */
  let slabState: {
    scopeId: string;
    framedBy: number | null;
    /** The fit they were sized for (its seq; -1: the camera of the moment). */
    seq: number;
    anamorphic: boolean;
    textScale: number;
    gapPx: number;
    heightM: number;
    cam: SlabCam;
    scales: SlabScales;
    key: string;
    buildMs: number;
    rects: SlabRect[];
  } | null = null;
  /** "Carte" (DEV): the slabs' rectangles, which the lid's snapshot must take in. */
  let lidExtra: Bounds | null = null;
  /** The ring's part picked and the one hovered, as the overlay has them, for
   *  the unit its words are about (setRing). */
  let ringState: SlabRingState & { scopeId: string } = { scopeId: "", ...NO_RING };
  /** The ring's state for the unit `scopeId`: the overlay's, when its words are
   *  about it; else (they trail the scope a moment) its largest picked. */
  const ringStateFor = (scopeId: string): SlabRingState =>
    ringState.scopeId === scopeId ? ringState : NO_RING;

  /** The overlay's pick and hover on the ring of `scopeId`: the raised parts
   *  and the bar follow (a small mesh, built again only when they change). */
  function setRing(scopeId: string, picked: string | null, hovered: string | null) {
    ringState = { scopeId, picked, hovered };
    if (plateauWall.slabScopeId === scopeId) plateauWall.setSlabRing(ringState);
  }

  let slabAnim: {
    raf: number;
    timer: number;
    resolve: () => void;
    target: number;
    done: Promise<void>;
  } | null = null;

  function cancelSlabAnim() {
    if (!slabAnim) return;
    cancelAnimationFrame(slabAnim.raf);
    clearTimeout(slabAnim.timer);
    const r = slabAnim.resolve;
    slabAnim = null;
    r();
  }

  /** The slabs' presence eased to `to` (animateTerrain's pattern: rAF, and a
   *  timeout snap for a hidden tab, where rAF stalls). */
  function animateSlabs(to: number, ms: number): Promise<void> {
    if (slabAnim && slabAnim.target === to) return slabAnim.done;
    if (!slabAnim && plateauWall.slabPresence === to) return Promise.resolve();
    cancelSlabAnim();
    const done: Promise<void> = new Promise((resolve) => {
      const from = plateauWall.slabPresence;
      const t0 = performance.now();
      const ease = (t: number) => 1 - Math.pow(1 - t, 3);
      const finish = () => {
        if (!slabAnim) return;
        cancelAnimationFrame(slabAnim.raf);
        clearTimeout(slabAnim.timer);
        slabAnim = null;
        plateauWall.setSlabPresence(to);
        resolve();
      };
      const tick = (now: number) => {
        if (!slabAnim) return;
        const t = Math.min(1, (now - t0) / ms);
        if (t >= 1 || !getMap()) return finish();
        plateauWall.setSlabPresence(from + (to - from) * ease(t));
        slabAnim.raf = requestAnimationFrame(tick);
      };
      slabAnim = {
        raf: requestAnimationFrame(tick),
        timer: window.setTimeout(finish, ms + 300),
        resolve,
        target: to,
        done: Promise.resolve(),
      };
    });
    if (slabAnim) slabAnim.done = done;
    return done;
  }

  /** No slabs at all (the plateau gone, or another standing without any). */
  function clearSlabs() {
    cancelSlabAnim();
    if (plateauWall.slabQuads.length || plateauWall.slabScopeId) {
      plateauWall.setSlabs([], null, 0, "");
    }
    plateauWall.setSlabPresence(0);
    slabState = null;
    lidExtra = null;
    hidePinsUnderSlabs(); // the pins they hid, back
  }

  /** Whether the slabs asked for are for the plateau standing now. */
  const slabsWanted = () => {
    const spec = slabs();
    return Boolean(spec && plateauWall.scopeId && spec.scopeId === plateauWall.scopeId);
  };

  /**
   * Bring the slabs in line with the spec and the plateau standing. `atSwap`:
   * a new plateau has just been put in place, still flat — its slabs (if any)
   * rise with it, from 0 (any others go at once: the old plateau has sunk).
   */
  function syncSlabs(atSwap = false) {
    if (!getMap()) return;
    const layer = plateauWall;
    const spec = slabs() ?? null;
    const scope = layer.scopeId;
    const plateauBbox = plateau.bbox();
    const standing = scope !== "" && layer.heightM > 0 && plateauBbox !== null;
    if (!standing) {
      clearSlabs();
      return;
    }
    if (!spec || spec.scopeId !== scope) {
      if (atSwap) clearSlabs();
      // The analyses gone from over this plateau: its slabs sink alone. (Asked
      // for another unit: they stay, and sink with their plateau.)
      else if (!spec && layer.slabScopeId === scope) {
        void animateSlabs(0, SINK_MS).then(() => {
          if (!slabsWanted()) clearSlabs();
        });
      }
      return;
    }
    const t0 = performance.now();
    const bbox = plateauBbox;
    const box = {
      minLng: bbox.minLng,
      minLat: bbox.minLat,
      maxLng: bbox.maxLng,
      maxLat: bbox.maxLat,
    };
    const liftM = layer.heightM * WALL_OVERSHOOT;
    // Sized for the fit that framed this unit, when it is the one the camera
    // flies (or flew) to; else for the camera of the moment. Once sized, kept:
    // the slabs are ground then — the camera moving changes nothing, a content
    // box changing (a filter) keeps the scale; only a new fit sizes them anew.
    const fit = fitCam();
    const fresh = fit && spec.framedBy !== null && fit.key === spec.framedBy ? fit : null;
    const st = slabState;
    let cam: SlabCam;
    let seq: number;
    let scales: SlabScales;
    const solve = (c: SlabCam) =>
      solveSlabScales({
        bbox: box,
        liftM,
        cam: c,
        top: spec.top,
        bottom: spec.bottom,
        gapPx: spec.gapPx,
        anamorphic: spec.anamorphic,
        textScale: spec.textScale,
      });
    if (
      st &&
      st.scopeId === scope &&
      st.framedBy === spec.framedBy &&
      st.anamorphic === spec.anamorphic &&
      st.textScale === spec.textScale &&
      st.gapPx === spec.gapPx &&
      st.heightM === layer.heightM &&
      (!fresh || fresh.seq === st.seq)
    ) {
      cam = st.cam;
      seq = st.seq;
      scales = st.scales;
      // A slab newly needed (the ring now drawn): sized for the same camera.
      if (spec.top && !scales.top) {
        const more = solve(cam);
        scales = { ...scales, top: more.top, metres: { ...scales.metres, top: more.metres.top } };
      }
    } else {
      cam = fresh ?? liveSlabCam();
      seq = fresh?.seq ?? -1;
      scales = solve(cam);
    }
    const rects = slabRects(box, scales, { top: spec.top, bottom: spec.bottom });
    const key = JSON.stringify([
      scope,
      layer.heightM,
      rects.map((r) => [r.side, r.corners]),
      spec.top,
    ]);
    let buildMs = st?.buildMs ?? 0;
    if (key !== st?.key || layer.slabScopeId !== scope) {
      layer.setSlabs(rects, spec.top, layer.heightM, scope, ringStateFor(scope));
      buildMs = Math.round((performance.now() - t0) * 1000) / 1000;
      if (perfOn) perfNote("slabs.sync", buildMs, { scope });
    }
    slabState = {
      scopeId: scope,
      framedBy: spec.framedBy,
      seq,
      anamorphic: spec.anamorphic,
      textScale: spec.textScale,
      gapPx: spec.gapPx,
      heightM: layer.heightM,
      cam,
      scales,
      key,
      buildMs,
      rects,
    };
    // The words' pieces' lid: glass, the card's colour, or (the DEV switch, in
    // the testing tools) the raised map's snapshot over it — which must then
    // take in the slabs' rectangles too.
    const carte = __TEST_TOOLS__ && spec.lid === "carte";
    layer.setSlabLid(carte ? "carte" : spec.lid === "opaque" ? "opaque" : "verre");
    lidExtra = carte && rects.length ? rects.map(rectBounds).reduce(unionBounds) : null;
    const covered = lid.covered();
    if (lidExtra && !(covered && boundsContain(covered, lidExtra))) {
      const raised = plateau.raised();
      const whole = boundsOfFeatures(raised);
      if (whole) void lid.capture(plateau.seq(), raised, unionBounds(whole, lidExtra), true);
    }
    // Their presence: at a swap they ride the plateau's rise; over a plateau
    // already up they rise alone.
    if (atSwap) {
      cancelSlabAnim();
      layer.setSlabPresence(1);
    } else if (layer.slabPresence < 1 || slabAnim) {
      void animateSlabs(1, RISE_MS);
    }
    hidePinsUnderSlabs(); // the pins they stand over now
  }

  const rectBounds = (r: SlabRect): Bounds => ({
    minLat: r.minLat,
    maxLat: r.maxLat,
    minLng: r.minLng,
    maxLng: r.maxLng,
  });

  /** The site's card colour (shared/styles/tokens.css --card, an HSL triplet), as sRGB 0..1. */
  function readCardRgb(): [number, number, number] {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
    const m = raw.match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
    if (!m) return [1, 1, 1];
    const h = (((Number(m[1]) % 360) + 360) % 360) / 360;
    const s = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const ch = (t: number) => {
      const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      if (u < 1 / 6) return p + (q - p) * 6 * u;
      if (u < 1 / 2) return q;
      if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
      return p;
    };
    return s === 0 ? [l, l, l] : [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
  }
  let themeObserver: MutationObserver | null = null;

  /** The slabs' opaque lids take the site's card colour, and follow the theme. */
  function observeTheme() {
    plateauWall.setSlabColor(readCardRgb());
    themeObserver = new MutationObserver(() => plateauWall.setSlabColor(readCardRgb()));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
  }

  /** Unmount: the presence animation and the theme observer. */
  function dispose() {
    cancelSlabAnim();
    themeObserver?.disconnect();
    themeObserver = null;
  }

  /** The slabs' share of the __acPlateau probe (see syncSlabs). */
  function probe() {
    return (
      slabState && {
        scopeId: slabState.scopeId,
        p: +plateauWall.slabPresence.toFixed(3),
        rise: +plateauWall.slabRise.toFixed(3),
        framedBy: slabState.framedBy,
        sizedForFit: slabState.seq >= 0,
        textScale: slabState.textScale,
        scales: slabState.scales,
        rects: slabState.rects.map((r) => ({
          side: r.side,
          w: r.w,
          h: r.h,
          minLng: +r.minLng.toFixed(5),
          maxLng: +r.maxLng.toFixed(5),
          minLat: +r.minLat.toFixed(5),
          maxLat: +r.maxLat.toFixed(5),
        })),
        sizingCam: slabState.cam,
        buildMs: slabState.buildMs,
        // The ring's parts and the bar, built again at each pick or hover.
        partsMs: plateauWall.slabPartsMs,
        ring: ringStateFor(slabState.scopeId),
      }
    );
  }

  return {
    syncSlabs,
    clearSlabs,
    setRing,
    /** "Carte" (DEV): the slabs' rectangles the lid's snapshot must take in (null otherwise). */
    lidExtra: () => lidExtra,
    /** A new unit raised: its first lid shot must not take the old unit's slabs in. */
    forgetLidExtra: () => {
      lidExtra = null;
    },
    observeTheme,
    dispose,
    probe,
  };
}
