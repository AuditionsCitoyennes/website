// The camera commands GeoDrillMap is handed: a unit framed so that it becomes
// the scope, a lieu spotlighted, the visitor's country framed once the filters'
// answer has stopped changing. Every command pins the optimistic scope until
// the flight lands and runs the ring's hook first (ring/useAnalysesRing
// registers it; neither imports the other).
import { markRaw, onBeforeUnmount, ref, shallowRef, type ComputedRef, type Ref } from "vue";
import { ancestorsOf, type GeoUnit, lngNear, selfFileOf, SPAN_DESCEND } from "@/features/geo";
import type { CameraCmd } from "@/features/map";
import { frameFill } from "@/features/analyses";
import type { NavState } from "../navState";
import type { OutlineFiles } from "../data/useOutlineFiles";
import { filterFrameUnit, stillFramed } from "./filterFrame";
import { worldFrame } from "./worldFrame";

/** What the camera needs of the map component (GeoDrillMap's exposed API). */
export interface MapHandle {
  /** A finger or the mouse is on the map, or it is still gliding from one. */
  inUserHands: () => boolean;
}

export interface CameraInputs {
  nav: NavState;
  index: ComputedRef<Map<string, GeoUnit>>;
  raisedGeometryFor: (u: GeoUnit) => unknown;
  containsPoint: (u: GeoUnit, lat: number, lng: number) => boolean;
  /** The outline files (GeoNav: under the server's tree); null: none read. */
  outlines: OutlineFiles | null;
  mapCmp: Ref<MapHandle | null>;
  listMode: ComputedRef<boolean>;
}

export function useCamera(inputs: CameraInputs) {
  const { nav, index, raisedGeometryFor, containsPoint, mapCmp } = inputs;
  const { listMode, outlines } = inputs;
  const { currentScope, inMicroZone, openAuditions } = nav;

  const camera = ref<CameraCmd | null>(null);
  /** The last command that framed a unit (flyToUnit): the analyses' slabs of
   *  that unit are sized for the camera it lands on (GeoDrillMap's SlabSpec). */
  const framedFit = shallowRef<{ key: number; unitId: string } | null>(null);
  /** Run before every command, in the same tick: the ring brings itself in line
   *  with the analyses there (see useAnalysesRing). */
  let beforeCommand: (() => void) | null = null;
  function onBeforeCommand(hook: () => void) {
    beforeCommand = hook;
  }
  function setCamera(cmd: Omit<CameraCmd, "key">) {
    nav.scopePinned.value = true; // hold the optimistic scope until the flight lands
    beforeCommand?.();
    camera.value = { key: ++nav.cameraKey.value, ...cmd };
  }
  // Closest a unit is framed: just short of the lieu zone (MICRO_ZONE_ENTER, in
  // useScope), where the map flattens. The map's own default (14) left the smallest
  // arrondissements (Paris 3e) at half the view on a laptop, less on a bigger
  // screen — too small to become the scope.
  const FIT_MAX_ZOOM = 14.9;
  // Right after its fit, a unit's children fill at most this much of the view —
  // a wheel notch or so short of DESCEND, where the one under the view's centre
  // would become the scope. The fit makes the unit large — FRAME_FILL of its
  // rectangle, all of it at DEV's "Cadrage" 100 % — and a big child could reach
  // it: Seine-et-Marne, 0.81 of Île-de-France's view on a desktop framed edge to
  // edge (about 0.65 at FRAME_FILL), the view's centre in it.
  const CHILD_FILL_MAX = SPAN_DESCEND - 0.05;
  // A child this close to its unit's whole box, both ways, is the unit itself (a
  // département that is one city, Paris): descending into it is the way, it
  // caps nothing.
  const CHILD_WHOLE = 0.9;

  /** The widest and the tallest of a unit's children, degrees (see
   *  CameraCmd.fillCap); undefined: none to keep from filling the view. */
  function childSpans(unit: GeoUnit): { lng: number; lat: number } | undefined {
    const uw = unit.bounds.maxLng - unit.bounds.minLng;
    const uh = unit.bounds.maxLat - unit.bounds.minLat;
    let lng = 0;
    let lat = 0;
    for (const c of unit.children) {
      if (c.levelKey === "place") continue;
      const w = c.bounds.maxLng - c.bounds.minLng;
      const h = c.bounds.maxLat - c.bounds.minLat;
      if (w >= CHILD_WHOLE * uw && h >= CHILD_WHOLE * uh) continue;
      lng = Math.max(lng, w);
      lat = Math.max(lat, h);
    }
    return lng > 0 || lat > 0 ? { lng, lat } : undefined;
  }

  // Fly so a unit becomes the scope: FIT its whole boundary into the visible area, so
  // the boundary is always fully on screen (no over-zoom) and the viewport-containment
  // scope then resolves to that unit. Not edge to edge: its silhouette fills
  // FRAME_FILL of the rectangle (map/lib/slabs; DEV: "Cadrage"), the map around it
  // in sight — its own fill still well over the scope's hold (SPAN_ASCEND).
  // `byBox`: framed by its box alone, whatever outline is in (the boot's first
  // fit from the server's tree: see GeoNav).
  function flyToUnit(unit: GeoUnit, animate: boolean, fresh = false, byBox = false) {
    let bounds = unit.bounds;
    // The map frames the unit's silhouette, raised (its outline, when loaded),
    // centred where the scope read off the view is the unit.
    let shape: CameraCmd["shape"];
    let fillCap: CameraCmd["fillCap"];
    let fill: number | undefined;
    if (unit.levelKey === "world") {
      // Inflated so the world scope holds; the globe, whole, for a world of
      // countries no fit holds (worldFrame).
      const frame = worldFrame(unit.bounds);
      if (frame.type === "ease") {
        inMicroZone.value = false;
        setCamera({ type: "ease", center: frame.center, zoom: frame.zoom, animate, fresh });
        framedFit.value = { key: nav.cameraKey.value, unitId: unit.id };
        return;
      }
      bounds = frame.bounds;
    } else {
      // The unit's bundle (its self and its children's lines; nothing while
      // its row is not known): asked now, the frame takes its self if it is
      // already in; the same request as the scope's chain will make — a
      // country with no bundle, its u/ (geo's outlineRoles). Nothing without
      // the files, or once the session fell back.
      if (outlines?.mode.value === "fichiers") {
        if (unit.levelKey === "country" && selfFileOf(outlines.rowOf(unit.id)) === "u")
          void outlines.ensureSelf(unit.id);
        else void outlines.ensureBundle(unit.id);
      }
      const geometry = byBox ? undefined : raisedGeometryFor(unit);
      // markRaw: the command lives in a deep ref, and the geometry must never be
      // proxied (see useOutlineFiles' note).
      if (geometry) {
        shape = markRaw({
          id: unit.id,
          heightClass: unit.heightClass,
          geometry,
          lands: (lng: number, lat: number) => centreLandsOn(unit, lat, lng),
        });
      }
      const spans = childSpans(unit);
      if (spans) fillCap = { ...spans, fill: CHILD_FILL_MAX };
      fill = frameFill.value;
    }
    // Out of the lieu zone as the flight starts (spotlightPlace's mirror): a unit
    // is framed above its hysteresis line (MICRO_ZONE_EXIT), and landing there
    // from a lieu would otherwise leave the map flat under its raised scope.
    inMicroZone.value = false;
    setCamera({
      type: "fit",
      center: unit.center,
      bounds,
      shape,
      fillCap,
      fill,
      animate,
      fresh,
      maxZoom: FIT_MAX_ZOOM,
    });
    framedFit.value = { key: nav.cameraKey.value, unitId: unit.id };
  }

  /**
   * Whether the scope read off a view centred on (lat, lng) is `unit` (the map's
   * fit keeps the view's centre where it is: CameraCmd.shape.lands). Down its
   * chain, the chain preferred (scopeForView), each unit keeps the centre while
   * its outline holds it, or its box does and no rival of its rank claims it —
   * with an outline its own does not share: it lands in the unit, or where no
   * outline is (the sea, a lagoon). A concave unit can have the middle of its
   * box in a neighbour (Meurthe-et-Moselle's is in Moselle, by Metz): framed on
   * that middle, the scope went to the neighbour — which rose instead.
   */
  function centreLandsOn(unit: GeoUnit, lat: number, lng: number): boolean {
    const inBox = (u: GeoUnit) => {
      const x = lngNear(lng, u.bounds); // a country past ±180 (geo's wrap)
      return (
        lat >= u.bounds.minLat &&
        lat <= u.bounds.maxLat &&
        x >= u.bounds.minLng &&
        x <= u.bounds.maxLng
      );
    };
    const chain = ancestorsOf(index.value, unit.id);
    for (let i = 1; i < chain.length; i++) {
      const u = chain[i];
      // Held by its outline, even past its box (scopeForView counts it in).
      if (containsPoint(u, lat, lng)) continue;
      if (!inBox(u)) return false;
      for (const rival of chain[i - 1].children) {
        if (rival !== u && containsPoint(rival, lat, lng)) return false;
      }
    }
    return true;
  }

  /** Flies the map onto a lieu (the framing its testimonies are read in) —
   *  along an arc when asked, for a hop from another lieu. */
  function spotlightPlace(unit: GeoUnit, arc = false) {
    // Optimistic, like the scope in activate(): the plateau sinks as the dive
    // starts, not once it has landed. The landing view confirms it.
    inMicroZone.value = true;
    setCamera({ type: "spotlight", center: unit.center, animate: true, arc });
  }

  // While filters are on, the map frames the country the visitor is in, as its
  // crumb would — not every lieu of the results, a world-wide frame as a rule;
  // at the world it stays put. Not on each keystroke of a search: once the
  // answer has stopped changing. Not again while the map still stands on that
  // frame. And not from under someone reading an audition — the map is on its
  // lieu. The ring's calls owe a command (it flips only with one: see
  // useAnalysesRing): framed even when it stands there, the world at the world.
  let fitTimer = 0;
  /** A ring's call is waiting: the next frame is issued whatever stands. */
  let frameOwed = false;
  /** The camera key a hand last moved the map under: that frame is left. */
  let movedAtKey = -1;
  /** A hand moved the map (GeoDrillMap's userGesture: a wheel's zoom too,
   *  whose view is not `byUser` — mapbox starts it with no DOM event). */
  function handMoved() {
    movedAtKey = nav.cameraKey.value;
  }
  function scheduleFilterFrame(owed = false) {
    frameOwed ||= owed;
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      if (!listMode.value || openAuditions.value.size > 0) {
        frameOwed = false;
        return;
      }
      // Not from under a hand on the map (a camera command ends the gesture):
      // it comes back once the map is let go.
      if (mapCmp.value?.inUserHands()) {
        scheduleFilterFrame();
        return;
      }
      const owe = frameOwed;
      frameOwed = false;
      const country = filterFrameUnit(currentScope.value, index.value, true);
      const unit = country ?? (owe ? currentScope.value : null);
      if (!unit) return; // the world: a filter does not move the map
      const moved = movedAtKey === nav.cameraKey.value;
      if (!owe && stillFramed(unit.id, framedFit.value, nav.cameraKey.value, moved)) return;
      currentScope.value = unit; // optimistic, as a crumb — see useNavActions.activate()
      flyToUnit(unit, true);
    }, 350);
  }
  onBeforeUnmount(() => window.clearTimeout(fitTimer));

  return {
    camera,
    framedFit,
    setCamera,
    onBeforeCommand,
    flyToUnit,
    spotlightPlace,
    scheduleFilterFrame,
    handMoved,
  };
}

export type Camera = ReturnType<typeof useCamera>;
