// The camera: the commands the parent sends (ease, spotlight, fit by the
// unit's silhouette), the flights and their flags (programmatic, the user's,
// in flight), the padding eases and what is owed under a gesture, the cold-load
// intro — and the camera the last fit lands on (`fitCam`), which the slabs
// read to size themselves. Owns `introPending` and `userHolding`; exposes them
// as getters. Nothing here touches the plateau or the slabs directly: the shell
// hands over `onIntroReleased` (raise the plateau) and `afterFit` (size the
// slabs), and `onSettled` for what the map does once the camera rests.

import mapboxgl from "mapbox-gl";
import type { Bounds } from "@/features/geo";
import { FIT_PITCH_DEG, fitSilhouette, type FitShape, type SlabCam } from "../lib";
import { plateauHeightM, pointInPolygon, polysOf, toLngLat, toLngLatBounds } from "../lib/polygon";
import { fitHullOf } from "../lib/projection";
import { WALL_OVERSHOOT } from "../gl/mesh";
import type { CameraCmd } from "../types";
import { zoomForFill, type Insets, type MapPadding } from "./useMapView";

/** The camera a fit lands on, for the slabs of the unit it framed (`key`: its
 *  command's; `seq`: bumped per fit, so a re-sizing can tell a new fit). */
export type FitCam = SlabCam & { key: number; seq: number };

/** The pitch a raised territory is framed at: the slabs' words are sized for it. */
export const ELEV_PITCH = FIT_PITCH_DEG; // 45

export interface MapCameraInputs {
  getMap: () => mapboxgl.Map | null;
  /** The camera's padding (the `padding` prop). */
  padding: () => MapPadding | undefined;
  /** The rectangle in sight when not the camera's own (`viewPadding`). */
  viewPadding: () => Insets | undefined;
  /** Whether the style renders a globe (useScopeMask.isGlobeStyle). */
  globe: () => boolean;
  /** Tell the parent what is in sight (useMapView.emitView): a deferred padding ease. */
  emitView: () => void;
  /** What the map does once the camera has come to rest (gesture or flight). */
  onSettled: () => void;
  /** The intro has been released (a real flight, or the intro's own tilt): raise the plateau. */
  onIntroReleased: () => void;
  /** A fit has just been issued: size the slabs of the unit it frames for it. */
  afterFit: () => void;
  /** The intro reveals the map: the `ready` emit. */
  onReady: () => void;
}

export function useMapCamera({
  getMap,
  padding: padding_,
  viewPadding,
  globe,
  emitView,
  onSettled,
  onIntroReleased,
  afterFit,
  onReady,
}: MapCameraInputs) {
  // Cold-load INTRO: the refresh shows the FINISHED flat basemap first (instant
  // flat fit, wait for the first idle = tiles painted), THEN one animated tilt to
  // ELEV_PITCH with the plateau rise landing in its tail. While pending, the
  // plateau holds and instant fits stay flat; any real (animated) flight — e.g.
  // the user drills before idle — releases the intro instead (fits tilt already).
  let introPending = true;
  let userInteracted = false;
  let lastCmd: CameraCmd | null = null;
  /** The padding `lastCmd` was framed against (see onPaddingChange). */
  let lastCmdPadKey = "";
  // True while a programmatic camera animation (ease/fit/spotlight) is in flight —
  // suppresses mid-flight scope derivation so a drill doesn't churn through the
  // intermediate levels it flies over. Only `flyCamera` raises and lowers it.
  let programmaticCam = false;
  /** Id of the latest programmatic flight: a superseded one must not lower the flag. */
  let flightSeq = 0;
  /** Id of `lastCmd`'s own flight while it is in the air, else 0 (padding watcher). */
  let cmdFlight = 0;
  /** Inside a camera call — the `moveend` mapbox fires there ends the OLD flight. */
  let issuingCam = false;
  // The user is moving the camera (from a gesture's `movestart` to its `moveend`).
  // EVERY camera call — easeTo, jumpTo, setPadding — begins by resetting mapbox's
  // gesture handlers, i.e. it kills the drag or the pinch in progress. So a
  // padding change that arrives meanwhile is owed, and paid when they let go.
  let userHolding = false;
  let padOwed = false;
  let padTimer = 0;
  /** Pointers currently down on the map: a finger at rest is a gesture to come. */
  const pressed = new Set<number>();

  const SPOTLIGHT_ZOOM = 15.3;
  const SPOTLIGHT_PITCH = 50;
  /** An arc flight (see runCamera) pulls back until the hop is this many views long… */
  const ARC_SCREENS = 3;
  /** …and by this much of a zoom level at least. */
  const ARC_MIN_DIP = 0.5;

  /** The camera the last fit lands on, for sizing the slabs of the unit it
   *  framed (`key`: its command's). Null once the user moves the map, or after
   *  any other command. */
  let fitCam: FitCam | null = null;
  let fitCamSeq = 0;

  /**
   * Issue a programmatic camera move, keeping `programmaticCam` true for exactly
   * as long as it flies.
   *
   * Starting a move ENDS any flight already in the air, and mapbox reports that
   * with a `moveend` fired synchronously from inside the call. That event is not a
   * landing. Treating it as one did two things at once: it cleared the flag for
   * the flight just being started (the listener was registered before the call),
   * and it emitted the half-way view. The parent then saw an un-pinned view from
   * mid-flight — on a phone, where opening a lieu changes the padding and so
   * re-issued the spotlight, that read as "zoomed out past the lieu" and closed
   * the place 30 ms after it opened. Hence: nothing settles while a command is
   * being issued, the flag is raised AFTER the call, and each flight only ever
   * lowers its own.
   *
   * `isCommand` marks the flight as `lastCmd`'s own (see `cmdFlight`).
   */
  function flyCamera(move: (m: mapboxgl.Map) => void, isCommand = false) {
    const m = getMap();
    if (!m) return;
    let issued = false;
    issuingCam = true;
    try {
      move(m);
      issued = true;
    } catch (e) {
      // A camera move that fails stays the map's problem: thrown on, it would
      // abort the page's whole update (the panel, the filters, everything).
      console.error("Map camera move failed:", e);
    } finally {
      issuingCam = false;
      // Mapbox ends the old flight BEFORE it validates the new target, so a throw
      // (a bad centre) leaves the camera stopped with its `moveend` swallowed.
      if (!issued) {
        programmaticCam = false;
        cmdFlight = 0;
        onSettled();
      }
    }
    const id = ++flightSeq;
    if (!m.isEasing()) {
      // Instant (animate: false, or the reader prefers reduced motion) or no move
      // at all: the camera is already at rest, its own `moveend` swallowed above.
      programmaticCam = false;
      cmdFlight = 0;
      onSettled();
      return;
    }
    programmaticCam = true;
    cmdFlight = isCommand ? id : 0;
    m.once("moveend", () => {
      if (id === flightSeq) programmaticCam = false;
      if (id === cmdFlight) cmdFlight = 0;
    });
  }

  /**
   * `cameraForBounds`, blind to the terrain. Past the globe, mapbox frames the
   * box lifted to the terrain's height at the bounds' corners — and our terrain
   * is the plateau, raised over whatever was the scope when the command came:
   * Lyon 9e framed while Lyon stood raised landed a whole zoom level wider than
   * framed from Paris, too loose to become the scope. On flat ground every unit
   * is framed the same way, wherever the camera comes from.
   */
  function flatCamera(
    bounds: mapboxgl.LngLatBoundsLike,
    options: Parameters<mapboxgl.Map["cameraForBounds"]>[1],
  ): ReturnType<mapboxgl.Map["cameraForBounds"]> {
    const m = getMap()!;
    const own = m as unknown as { queryTerrainElevation?: () => number };
    own.queryTerrainElevation = () => 0;
    try {
      return m.cameraForBounds(bounds, options);
    } finally {
      delete own.queryTerrainElevation; // the map's own method again
    }
  }

  /**
   * `aimOffset` as camera options: `{ offset }`, or nothing at all — mapbox
   * fills in its default offset and then copies every key it is given over it,
   * so an `offset: undefined` replaces the default and crashes the move.
   */
  function aimed(padding: MapPadding): { offset?: [number, number] } {
    const offset = aimOffset(padding);
    return offset ? { offset } : {};
  }

  /**
   * Where a command's target is aimed when the rectangle in sight is not the
   * camera's own (`viewPadding`: the panel opened wide over the map, or folded
   * aside while the user is on it). The camera keeps its padding — the globe
   * stays where it is on screen — and the target is aimed at that rectangle's
   * centre with an offset: the map turns under it, the globe does not slide.
   */
  function aimOffset(padding: MapPadding): [number, number] | undefined {
    const view = viewPadding();
    if (!view) return undefined;
    const p =
      typeof padding === "number"
        ? { top: padding, bottom: padding, left: padding, right: padding }
        : padding;
    return [
      (view.left - view.right - (p.left - p.right)) / 2,
      (view.top - view.bottom - (p.top - p.bottom)) / 2,
    ];
  }

  /** A box's edges, [lng, lat] pair after pair, BOX_EDGE_STEPS points each
   *  (the globe bends them): what a fit frames when it has no outline. */
  const BOX_EDGE_STEPS = 16;
  function boxRim(b: Bounds): Float64Array {
    const corners = [
      [b.minLng, b.maxLat],
      [b.maxLng, b.maxLat],
      [b.maxLng, b.minLat],
      [b.minLng, b.minLat],
    ];
    const out = new Float64Array(8 * BOX_EDGE_STEPS);
    let k = 0;
    for (let c = 0; c < 4; c++) {
      const [x0, y0] = corners[c];
      const [x1, y1] = corners[(c + 1) % 4];
      for (let i = 0; i < BOX_EDGE_STEPS; i++) {
        out[k++] = x0 + ((x1 - x0) * i) / BOX_EDGE_STEPS;
        out[k++] = y0 + ((y1 - y0) * i) / BOX_EDGE_STEPS;
      }
    }
    return out;
  }

  /**
   * The camera a fit lands on: the unit's silhouette — its whole outline
   * (`cmd.shape`), islets included: each outer ring's hull (fitHullOf), at the
   * ground and at its lid's height, seen from the camera resting on its
   * plateau — centred in the rectangle in sight (`viewPadding`, else the
   * camera's own), `cmd.fill` of it on the axis that limits it (as large as
   * fits without), up to `maxZoom` and `cmd.fillCap`, the view's centre where
   * the scope is the unit (map/lib/slabs' fitSilhouette). With no outline,
   * the box `cmd.bounds`, on the ground. The camera keeps its padding and aims
   * at that rectangle's centre (see aimOffset): `ox`, `oy` are that aim.
   * Started from mapbox's own fit on flat ground (see flatCamera). Null: no
   * camera to be had.
   */
  function fitCamera(
    m: mapboxgl.Map,
    cmd: CameraCmd,
    padding: MapPadding,
    pitch: number,
    maxZoom: number,
  ): SlabCam | null {
    if (!cmd.bounds) return null;
    const view = viewPadding();
    const pad =
      typeof padding === "number"
        ? { top: padding, bottom: padding, left: padding, right: padding }
        : padding;
    const ins = view ?? pad;
    const w = m.getContainer().clientWidth;
    const h = m.getContainer().clientHeight;
    // No closer than where the unit's children would fill too much of the view.
    const midLat = (cmd.bounds.minLat + cmd.bounds.maxLat) / 2;
    const cap = cmd.fillCap ? zoomForFill(cmd.fillCap, ins, w, h, pitch, midLat) : Infinity;
    if (cap < maxZoom) maxZoom = cap;
    const seed = flatCamera(toLngLatBounds(cmd.bounds), {
      padding: view ?? padding,
      maxZoom,
      pitch,
    });
    if (seed?.zoom === undefined || seed.center === undefined) return null;
    const c = mapboxgl.LngLat.convert(seed.center);
    // The rectangle, from the padded centre (where mapbox puts the target
    // without an offset).
    const pcx = (pad.left + w - pad.right) / 2;
    const pcy = (pad.top + h - pad.bottom) / 2;
    const rect = {
      left: ins.left - pcx,
      top: ins.top - pcy,
      right: w - ins.right - pcx,
      bottom: h - ins.bottom - pcy,
    };
    let shape: FitShape = {
      pts: boxRim(cmd.bounds),
      liftM: 0,
      restM: 0,
      holds: null,
      lands: null,
    };
    const g = cmd.shape?.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (cmd.shape && g?.type) {
      const features = [{ type: "Feature" as const, geometry: g, properties: {} }];
      const pts = fitHullOf(g);
      if (pts.length) {
        const polys = polysOf(g);
        const heightM = plateauHeightM(cmd.shape.heightClass, features);
        const holds = (lng: number, lat: number) => pointInPolygon(lng, lat, polys);
        shape = {
          pts,
          liftM: heightM * WALL_OVERSHOOT,
          restM: heightM,
          holds,
          lands: cmd.shape.lands ?? holds,
        };
      }
    }
    return fitSilhouette({
      shape,
      seed: { lng: c.lng, lat: c.lat, zoom: seed.zoom },
      rect,
      fill: cmd.fill,
      pitch,
      w,
      h,
      globe: globe(),
      maxZoom,
    });
  }

  function runCamera(cmd: CameraCmd) {
    const map = getMap();
    if (!map) return;
    if (cmd.fresh) {
      map.resize();
      userInteracted = false;
    }
    lastCmd = cmd;
    // Only a fit frames a unit for its slabs (see fitCam).
    if (cmd.type !== "fit") fitCam = null;
    const padding = padding_() ?? 50;
    padOwed = false; // every command frames against the padding of the moment
    lastCmdPadKey = JSON.stringify(padding_() ?? null);
    const duration = cmd.animate === false ? 0 : 550;
    if (cmd.type === "spotlight") {
      const center = toLngLat(cmd.center);
      if (cmd.arc && duration > 0) {
        const to = new mapboxgl.LngLat(center[0], center[1]);
        const meters = map.getCenter().distanceTo(to);
        // The further the hop, the longer the flight — but never a long wait.
        const arcMs = Math.min(3000, 900 + 320 * Math.log2(1 + meters / 1000));
        // How far it pulls back on the way: a little. Not to where both ends are
        // in sight — that is the whole city for two lieux a few streets apart —
        // but to the zoom at which the hop is ARC_SCREENS views long: the map is
        // seen travelling, without leaving the neighbourhood for the sky. And by
        // ARC_MIN_DIP of a level at least — mapbox's own curve barely lifts off
        // for a lieu a street away.
        const insets = typeof padding === "number" ? { left: padding, right: padding } : padding;
        const width = Math.max(200, map.getContainer().clientWidth - insets.left - insets.right);
        const metersPerPx0 = 78271.517 * Math.cos((to.lat * Math.PI) / 180); // at zoom 0
        const hopZoom = Math.log2((metersPerPx0 * ARC_SCREENS * width) / Math.max(meters, 1));
        flyCamera(
          (m) =>
            m.flyTo({
              center,
              zoom: SPOTLIGHT_ZOOM,
              pitch: SPOTLIGHT_PITCH,
              padding,
              ...aimed(padding),
              duration: arcMs,
              // (mapbox never lets this exceed the zoom the flight starts from)
              minZoom: Math.min(hopZoom, SPOTLIGHT_ZOOM - ARC_MIN_DIP),
            }),
          true,
        );
        return;
      }
      flyCamera(
        (m) =>
          m.easeTo({
            center,
            zoom: SPOTLIGHT_ZOOM,
            pitch: SPOTLIGHT_PITCH,
            padding,
            ...aimed(padding),
            duration,
          }),
        true,
      );
      return;
    }
    // A real animated flight preempts the load intro: the fit tilts the camera
    // itself, so release the plateau hold and let the outline-driven pipeline run.
    if (introPending && duration > 0) {
      introPending = false;
      onIntroReleased();
    }
    // fit: frame the whole unit so its boundary stays on screen; the viewport-derived
    // scope then resolves to this unit. Tilt so the raised plateau reads. maxZoom
    // guards degenerate (point) bounds. During the intro, instant fits stay FLAT —
    // the tilt is the intro's animated step.
    if (cmd.type === "fit" && cmd.bounds) {
      const bounds = toLngLatBounds(cmd.bounds);
      const pitch = introPending && duration === 0 ? 0 : ELEV_PITCH;
      const maxZoom = cmd.maxZoom ?? 14;
      // The unit has to land in the rectangle that is in sight NOW
      // (`viewPadding`) — the one the scope is read from — while the camera
      // keeps its padding (see aimOffset): its silhouette centred there and as
      // large as fits (fitCamera) — inside the move, so a throw there takes
      // the failed-move path like any other.
      flyCamera((m) => {
        const cam = fitCamera(m, cmd, padding, pitch, maxZoom);
        if (cam) {
          // The camera this fit lands on: the analyses' slabs of the unit it
          // frames are sized for it, whenever they are built (mid-flight).
          fitCam = { key: cmd.key, seq: ++fitCamSeq, ...cam };
          m.flyTo({
            center: [cam.lng, cam.lat],
            zoom: cam.zoom,
            bearing: 0,
            pitch,
            padding,
            ...aimed(padding),
            duration,
          });
        } else {
          fitCam = null;
          // mapbox's fit frames the box edge to edge in the padded rectangle:
          // that rectangle brought in by (1 − fill), about its centre, frames
          // it at `fill` like the silhouette's. Only the camera is asked for in
          // it: the flight keeps the real padding (fitBounds would hand the
          // enlarged one on to the map, owed back by an ease after landing).
          const p =
            typeof padding === "number"
              ? { top: padding, bottom: padding, left: padding, right: padding }
              : padding;
          const k = (1 - (cmd.fill ?? 1)) / 2;
          const dx = k * Math.max(0, m.getContainer().clientWidth - p.left - p.right);
          const dy = k * Math.max(0, m.getContainer().clientHeight - p.top - p.bottom);
          const inset = {
            top: p.top + dy,
            bottom: p.bottom + dy,
            left: p.left + dx,
            right: p.right + dx,
          };
          const c = m.cameraForBounds(bounds, { padding: inset, maxZoom, pitch });
          if (c) m.flyTo({ ...c, pitch, padding, duration });
          else m.fitBounds(bounds, { padding, maxZoom, pitch, duration });
        }
      }, true);
      // The same fit run again (a resize, a new padding: same key) lands on
      // another camera, and no new spec comes to say so: its unit's slabs are
      // sized for it now, not at some later re-sync under a still camera. (A
      // new unit's spec is not there yet: nothing changes then.)
      afterFit();
      return;
    }
    // ease: centre on the unit at the level's canonical zoom (drives scope derivation).
    flyCamera(
      (m) =>
        m.easeTo({
          center: toLngLat(cmd.center),
          zoom: cmd.zoom ?? m.getZoom(),
          pitch: 0,
          padding,
          ...aimed(padding),
          duration,
        }),
      true,
    );
  }

  /** The camera of the moment, as the slabs are sized with: its centre is the
   *  padded centre's ground (no aim offset). */
  function liveSlabCam(): SlabCam {
    const m = getMap()!;
    const c = m.getCenter();
    return {
      lng: c.lng,
      lat: c.lat,
      ox: 0,
      oy: 0,
      zoom: m.getZoom(),
      pitch: m.getPitch(),
      w: m.getContainer().clientWidth,
      h: m.getContainer().clientHeight,
      globe: globe(),
    };
  }

  let introStarted = false;
  /**
   * The cold-load INTRO (the load handler's first idle, or 4 s): the finished
   * flat basemap first, then one animated tilt to ELEV_PITCH with the plateau's
   * rise landing in its tail. A user interaction or an animated flight before
   * that releases the intro on its own (runCamera).
   */
  function beginIntro() {
    const m = getMap();
    if (introStarted || !m) return;
    introStarted = true;
    if (!introPending) {
      // An animated flight released the intro already (runCamera) — the home
      // page's card opened before the basemap was in: no tilt to play, the
      // flight tilted, but the map is presentable only now. And a release
      // before the style's load raised nothing (ensurePlateau waits for it):
      // the plateau goes up now.
      onReady();
      onIntroReleased();
      return;
    }
    introPending = false;
    // Reveal HERE, not once the plateau is up: the tilt + rise below is a
    // designed entrance, and playing it behind a loading screen would trade
    // it for a static finished view.
    onReady();
    if (!userInteracted) {
      const INTRO_TILT_MS = 900;
      // The last fit was flat (the intro's first step): the tilt ends on
      // that fit at the pitch — its unit as a fit leaves it, centred
      // (fitCamera) —, and the slabs of the unit are sized for the
      // camera it ends on. Not a fit: just the tilt.
      const cmd = lastCmd;
      const key = cmd?.key ?? -1;
      fitCam = { key, seq: ++fitCamSeq, ...liveSlabCam(), pitch: ELEV_PITCH };
      flyCamera((mm) => {
        const padding = padding_() ?? 50;
        const cam =
          cmd?.type === "fit" ? fitCamera(mm, cmd, padding, ELEV_PITCH, cmd.maxZoom ?? 14) : null;
        if (!cam) {
          mm.easeTo({ pitch: ELEV_PITCH, duration: INTRO_TILT_MS, essential: true });
          return;
        }
        fitCam = { key, seq: ++fitCamSeq, ...cam };
        mm.easeTo({
          center: [cam.lng, cam.lat],
          zoom: cam.zoom,
          pitch: ELEV_PITCH,
          padding,
          ...aimed(padding),
          duration: INTRO_TILT_MS,
          essential: true,
        });
      });
    }
    onIntroReleased(); // rise plays during the tilt
  }

  // The panel's width changes when an audition opens, which changes `padding`.
  // Mapbox keeps the centre in the middle of the PADDED box, so easing to the new
  // padding slides the map out from under the panel — and unlike re-running the
  // last camera command, it preserves whatever the user panned/zoomed to.
  //
  // Kept in step with `.panel`'s width transition in GeoNav: the panel resizing
  // is what changes the padding, so a shorter ease here reads as the map
  // arriving before the panel has finished moving.
  function easePadding() {
    const pad = padding_();
    const map = getMap();
    if (!map || pad == null) return;
    // Under the user's hands it waits (see `userHolding`): `moveend`, or the
    // release of the press, comes back for it. Meanwhile the parent is told what
    // is in sight now — the logical view follows the prop, not the camera.
    if (pressed.size || (userHolding && map.isMoving())) {
      padOwed = true;
      emitView();
      return;
    }
    padOwed = false;
    flyCamera((m) => m.easeTo({ padding: pad, duration: 550 }));
  }

  /** The camera's padding is the one asked for (it is not, mid-ease). */
  function paddingAtRest(): boolean {
    const want = padding_();
    const map = getMap();
    if (!map || want == null) return true;
    const w =
      typeof want === "number" ? { top: want, bottom: want, left: want, right: want } : want;
    const have = map.getPadding();
    return (["top", "bottom", "left", "right"] as const).every(
      (side) => Math.abs((have[side] ?? 0) - w[side]) < 0.5,
    );
  }

  // Pays the padding owed once the map has been left alone for a moment — not
  // from inside `moveend` (a press that has just cut a flight short is still
  // being set up by mapbox, and a camera call would kill it), and never under a
  // finger. Whoever is in the way calls back: a move ends in `moveend`, a press
  // in `onMapPointerUp`.
  function armPadTimer() {
    window.clearTimeout(padTimer);
    padTimer = window.setTimeout(() => {
      const map = getMap();
      if (!padOwed || !map || programmaticCam || pressed.size || map.isMoving()) return;
      easePadding();
    }, 250);
  }

  function onMapPointerDown(e: PointerEvent) {
    pressed.add(e.pointerId);
    window.clearTimeout(padTimer);
  }

  function onMapPointerUp(e: PointerEvent) {
    if (!pressed.delete(e.pointerId) || pressed.size) return;
    if (padOwed) armPadTimer(); // a tap, or a catch, ends without a `moveend`
  }

  let lastPadKey = "";
  /** The `padding` prop changed (the watcher is the shell's, `immediate`). */
  function onPaddingChange(pad: MapPadding | undefined) {
    const key = JSON.stringify(pad ?? null);
    if (key === lastPadKey) return;
    const first = lastPadKey === "";
    lastPadKey = key;
    // The first run only seeds the key: the initial padding rides along with
    // whatever camera command frames the map on load.
    if (first || !getMap() || pad == null) return;
    // A COMMAND still in flight (opening a place spotlights it) would be
    // CANCELLED by a bare padding ease, stranding the camera short of its
    // target. Re-issue that command instead — it re-frames against the new
    // padding and still lands where it was going. Only for the command's own
    // flight, though: `map.isEasing()` is also true while the map coasts after
    // a fling, or during this watcher's own padding ease, and re-running the
    // last command then would throw away wherever the user had got to.
    if (cmdFlight && lastCmd) {
      // …unless that flight was framed against this very padding: the command
      // and the padding often change in the same tick (opening a lieu on a
      // phone), and runCamera reads the padding live. Restarting it then would
      // only stutter the flight.
      if (key === lastCmdPadKey) return;
      // (Directly, when it was an arc: a second pull-back mid-flight would
      // read as the map changing its mind.)
      runCamera({ ...lastCmd, animate: true, arc: false });
      return;
    }
    easePadding();
  }

  /** The camera this frame's `moveend` ends: nothing settles while a command is
   *  being issued (that `moveend` is the OLD flight's, not a landing). */
  function isIssuing(): boolean {
    return issuingCam;
  }

  /** `moveend`, after the shell has run what settles (onSettled): the gesture is
   *  over, and a padding owed is paid once the map has been left alone. */
  function onMoveEnd() {
    userHolding = false;
    // A padding ease (or a flight) cut short by a press left the camera's
    // padding half-way: that is owed too.
    if (lastCmd && !paddingAtRest()) padOwed = true;
    if (padOwed) armPadTimer();
  }

  // "The user has started moving the map" (see the `userGesture` emit). A
  // `movestart` that carries the DOM event behind it is a gesture — except
  // mapbox's own answer to a window resize, which carries one too.
  const NOT_A_GESTURE = /resize|orientationchange|fullscreenchange/i;
  /** `movestart`: true when it is the user's — the camera is theirs now. */
  function onMoveStart(e: { originalEvent?: Event }): boolean {
    const oe = e.originalEvent;
    if (!oe || NOT_A_GESTURE.test(oe.type)) return false;
    userHolding = true; // until the `moveend` every such start is followed by
    fitCam = null; // the camera is the user's now: no fit to size slabs for
    return true;
  }

  /** drag/zoom/rotate/pitch start: the user has taken the camera (a resize no
   *  longer re-applies the last framing). */
  function markInteracted(e: unknown) {
    if ((e as { originalEvent?: unknown })?.originalEvent) userInteracted = true;
  }

  /** The container was resized: re-apply the last framing until the user takes the camera. */
  function onResize() {
    if (!userInteracted && lastCmd) runCamera({ ...lastCmd, animate: false });
  }

  /** Pointers down on the map (see `pressed`). Released anywhere: a mouse can
   *  be let go outside the canvas. */
  function attachPointerTracking(canvasBox: HTMLElement) {
    canvasBox.addEventListener("pointerdown", onMapPointerDown, true);
    window.addEventListener("pointerup", onMapPointerUp, true);
    window.addEventListener("pointercancel", onMapPointerUp, true);
  }

  /** Unmount: the padding timer and the window listeners. */
  function dispose() {
    window.clearTimeout(padTimer);
    window.removeEventListener("pointerup", onMapPointerUp, true);
    window.removeEventListener("pointercancel", onMapPointerUp, true);
  }

  return {
    runCamera,
    beginIntro,
    /** `cameraForBounds`, blind to the terrain (the DEM's canonical zoom reads it too). */
    flatCamera,
    /** The camera of the moment, as the slabs are sized with. */
    liveSlabCam,
    isIssuing,
    onMoveStart,
    onMoveEnd,
    markInteracted,
    onResize,
    onPaddingChange,
    attachPointerTracking,
    dispose,
    /** A programmatic flight is in the air (no scope derivation meanwhile). */
    programmatic: () => programmaticCam,
    /** The user is moving the camera (a gesture's `movestart` to its `moveend`). */
    userHolding: () => userHolding,
    /** The cold-load intro has not played yet: the plateau holds, instant fits stay flat. */
    introPending: () => introPending,
    /** Unmount: a new map plays the intro again. */
    resetIntro: () => {
      introPending = true;
    },
    /** A finger or the mouse is on the map, or it is still gliding from one: a
     *  camera command now would cut that gesture short. */
    inUserHands: () => pressed.size > 0 || (userHolding && Boolean(getMap()?.isMoving())),
    /** The camera the last fit lands on (null: the user moved, or another
     *  command): the slabs only read it. */
    fitCam: {
      get: () => fitCam,
      set: (cam: FitCam | null) => {
        fitCam = cam;
      },
      clear: () => {
        fitCam = null;
      },
    },
  };
}
