// The camera commands GeoDrillMap is handed: a unit framed so that it becomes
// the scope, a lieu spotlighted, the results framed once the list has stopped
// changing. Every command pins the optimistic scope until the flight lands and
// runs the ring's hook first (ring/useAnalysesRing registers it; neither
// imports the other).
import { markRaw, onBeforeUnmount, ref, shallowRef, type ComputedRef, type Ref } from "vue";
import {
  ancestorsOf,
  type Bounds,
  depCodeOf,
  type GeoUnit,
  lngNear,
  selfFileOf,
  SPAN_DESCEND,
} from "@/features/geo";
import type { CameraCmd } from "@/features/map";
import { frameFill } from "@/features/analyses";
import type { NavState } from "../navState";
import type { OutlineFiles } from "../data/useOutlineFiles";
import { resultBounds } from "./auditions";
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
  allPlaceUnits: ComputedRef<GeoUnit[]>;
  ensureDepFine: (code: string | undefined) => Promise<void>;
  /** The outline files (GeoNav: the server's tree with ac:contours=fichiers). */
  outlines?: OutlineFiles | null;
  mapCmp: Ref<MapHandle | null>;
  listMode: ComputedRef<boolean>;
  /**
   * Where the results' lieux stand, the server's tree being the source (map
   * phase 1; absent: "ready"). "pending": the filters' answer is not on
   * screen yet — the fit waits for it (resultsArrived); "partial": the tree on
   * screen holds only some of them (the lazy path) — no fit, rather than one
   * on the few loaded (PR K brings the server's frame).
   */
  resultsFrame?: () => "ready" | "pending" | "partial";
  /** The server's lists: the results' frame is theirs (the first page's,
   *  resultBounds over every result's lieu), not the tree's lieux'. */
  resultsBounds?: () => Bounds | null;
}

export function useCamera(inputs: CameraInputs) {
  const { nav, index, raisedGeometryFor, containsPoint, allPlaceUnits, ensureDepFine, mapCmp } =
    inputs;
  const { listMode, resultsFrame, resultsBounds } = inputs;
  const outlines = inputs.outlines ?? null;
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
      // A département rises with its own outline (depFine): ask for it now, the
      // frame takes it if it is already in. With the outline files, the unit's
      // bundle (its self and its children's lines; nothing while its row is
      // not known), the same request as the scope's chain will make — a
      // country with no bundle, its u/ (geo's outlineRoles).
      if (outlines?.mode.value === "fichiers") {
        if (unit.levelKey === "country" && selfFileOf(outlines.rowOf(unit.id)) === "u")
          void outlines.ensureSelf(unit.id);
        else void outlines.ensureBundle(unit.id);
      } else void ensureDepFine(depCodeOf(unit));
      const geometry = byBox ? undefined : raisedGeometryFor(unit);
      // markRaw: the command lives in a deep ref, and the geometry must never be
      // proxied (see communeGeo's note).
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

  // The map frames every lieu of the results. Not on each keystroke of a search:
  // once the list has stopped changing. And not from under someone reading an
  // audition — the map is on its lieu.
  let fitTimer = 0;
  /** A fit was due while the results' lieux were on their way. */
  let fitOwed = false;
  function scheduleResultsFit() {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      if (!listMode.value || openAuditions.value.size > 0) return;
      // Not from under a hand on the map (a camera command ends the gesture):
      // it comes back once the map is let go.
      if (mapCmp.value?.inUserHands()) {
        scheduleResultsFit();
        return;
      }
      const frame = resultsFrame?.() ?? "ready";
      fitOwed = frame === "pending";
      if (frame !== "ready") return;
      const bounds = resultsBounds ? resultsBounds() : resultBounds(allPlaceUnits.value);
      if (!bounds) return;
      setCamera({
        type: "fit",
        center: [(bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2],
        bounds,
        animate: true,
      });
      // The slabs of the territory raised are sized for where this lands — not
      // for the camera of the moment, mid-flight (another unit raised once it
      // lands is sized then, for the map as it is).
      framedFit.value = { key: nav.cameraKey.value, unitId: currentScope.value.id };
    }, 350);
  }
  onBeforeUnmount(() => window.clearTimeout(fitTimer));

  /** The results' lieux are on screen (the server's tree swapped in): the fit
   *  that waited for them, if one did. */
  function resultsArrived() {
    if (!fitOwed) return;
    fitOwed = false;
    scheduleResultsFit();
  }

  return {
    camera,
    framedFit,
    setCamera,
    onBeforeCommand,
    flyToUnit,
    spotlightPlace,
    scheduleResultsFit,
    resultsArrived,
  };
}

export type Camera = ReturnType<typeof useCamera>;
