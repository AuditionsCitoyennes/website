// What GeoDrillMap is handed, from the scope: the outline the plateau rises
// with (scope, focus, context), whether that outline is still on its way, the
// units pinned on the map (the scope's children, its neighbours — across a
// région border too —, every lieu in sight deep in the lieu zone), and the
// contours fetched ahead for what is shown.
import { computed, watch, type ComputedRef } from "vue";
import {
  type Bounds,
  centerInBounds,
  communeCodeOf,
  depCodeOf,
  type GeoUnit,
  outlineSourceOf,
  unitsByLevelKey,
} from "@/features/geo";
import type { MapUnit, OutlineFC } from "@/features/map";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { NavState } from "../navState";
import type { BoundaryQueries } from "../data/useBoundaryQueries";
import type { CommuneGeoStore } from "../data/useCommuneGeo";
import type { DepFineStore } from "../data/useDepFine";
import type { GeoHierarchy } from "./useGeoHierarchy";

export interface MapFeedInputs {
  nav: NavState;
  geo: GeoHierarchy;
  boundaries: BoundaryQueries;
  communes: CommuneGeoStore;
  deps: DepFineStore;
  panelUnits: ComputedRef<GeoUnit[]>;
  selectedPlace: ComputedRef<GeoUnit | null>;
}

export function useMapFeed(inputs: MapFeedInputs) {
  const { nav, geo, boundaries, communes, deps, panelUnits, selectedPlace } = inputs;
  const { currentScope, selectedPlaceId, inMicroZone, mapView } = nav;
  const { root, index, geometryFor, raisedGeometryFor, raisedOutlineDue, allPlaceUnits } = geo;
  const { regionsQuery, depsQuery, metroQuery } = boundaries;
  const { communeGeo, failedInsee, ensureGeo } = communes;
  const { depFine, depGaveUp, fetchDepFine, addDepFine, ensureDepFine } = deps;

  const EMPTY_FC: OutlineFC = { type: "FeatureCollection", features: [] };

  function outlineForUnits(
    units: GeoUnit[],
    kind: "scope" | "focus" | "context",
    geometryOf: (u: GeoUnit) => unknown = geometryFor,
  ): OutlineFC["features"] {
    const features: OutlineFC["features"] = [];
    for (const u of units) {
      const geometry = geometryOf(u);
      // `id` lets the map detect a selection change instantly (before any network
      // round-trip) and start the plateau transition without dead time. `level`
      // drives per-feature stroke width (country/région outlines are thinner),
      // `heightClass` how high the unit rises when raised.
      if (geometry) {
        features.push({
          type: "Feature",
          geometry,
          properties: { kind, id: u.id, level: u.levelKey, heightClass: u.heightClass },
        });
      }
    }
    return features;
  }

  // The SELECTED unit (current scope) is what gets raised into the plateau ("scope").
  // Its children are outlined as subdivisions on top ("focus"); the surrounding
  // siblings are faint context. All cleared deep in the micropin zone — which is
  // where opening a lieu takes the camera.
  // NOTE: this deliberately returns a FRESH object on every recompute. The map
  // watches `props.outline` by identity and re-establishes the plateau (terrain +
  // wall mesh) when it changes; memoizing the identity meant a re-evaluation that
  // landed on the same content never re-fired that watcher, so after a teardown
  // (style reload, layer re-add) nothing rose again. Rebuilds are cheap now — the
  // per-geometry projection/mesh caches in GeoDrillMap absorb the real cost.
  const outline = computed<OutlineFC>(() => {
    // Deep in the micropin zone → no plateau, no boundaries: the empty outline
    // drives the map's animated teardown (sink, then clear). An open lieu does
    // not decide this by itself: zoomed back out with it still open, the map is
    // explored exactly as if nothing were open.
    if (inMicroZone.value) return EMPTY_FC;
    const end = perfOn ? perfSpan("vue.outline") : null;
    // The scope rises with its own outline (raisedGeometryFor) — none while that
    // is still due: the map holds the plateau standing (scopePending) rather than
    // raise one shape and reshape it a moment later.
    const scope = currentScope.value;
    const fc: OutlineFC = {
      type: "FeatureCollection",
      features: [
        ...(raisedOutlineDue(scope) ? [] : outlineForUnits([scope], "scope", raisedGeometryFor)),
        ...outlineForUnits(panelUnits.value, "focus"),
        ...outlineForUnits(scopeSiblings.value, "context", raisedGeometryFor),
      ],
    };
    if (end) end({ features: fc.features.length });
    return fc;
  });

  // True while the scope SHOULD have boundary geometry but it hasn't loaded yet
  // (cold cache: commune contours / région outlines still streaming in). The map
  // holds the current plateau instead of tearing it down for a transient blank.
  const scopePending = computed(() => {
    // Micropin zone → the map clears, it must never HOLD a plateau.
    if (inMicroZone.value) return false;
    const s = currentScope.value;
    if (s.levelKey === "world") return false; // only the world level has no plateau
    if (raisedOutlineDue(s)) return true; // a département's own outline (depFine)
    if (raisedGeometryFor(s)) return false;
    // Geometry absent: hold only while it can still ARRIVE — a terminal fetch
    // failure must release the hold (teardown beats a stale wrong plateau), and
    // a unit no source holds (outside France) has nothing to wait for.
    const src = outlineSourceOf(s);
    if (!src) return false;
    if (src.kind === "metropole") return !metroQuery.isError.value;
    if (src.kind === "regions") return !regionsQuery.isError.value;
    // Loaded without it: an overseas département (france-geojson has none) whose
    // own outline was given up on — it rises when that lands.
    if (src.kind === "departements") return !depsQuery.isError.value && !depsQuery.data.value;
    return !failedInsee.value.has(src.insee);
  });

  /** The outline has every geometry it will get: nothing of the scope's own,
   *  its children's or its neighbours' is still on its way (the perf probes'
   *  "drill → boundaries ready", shared/perf; a neighbouring département's own
   *  outline, which refines a line already drawn, is not waited for). */
  const outlineReady = computed(() => {
    if (inMicroZone.value) return true;
    if (scopePending.value) return false;
    const geo = communeGeo.value;
    const failed = failedInsee.value;
    for (const u of [...panelUnits.value, ...scopeSiblings.value]) {
      const code = communeCodeOf(u);
      if (code && !geo[code] && !failed.has(code)) return false;
    }
    const code = depCodeOf(currentScope.value);
    return !code || !!depFine.value[code] || depGaveUp.value.has(code);
  });

  // Départements of OTHER régions, while they are on screen.
  //
  // A région border is not a wall: at département focus the neighbour across it is
  // just as plausible a target as the ones beside it, but the hierarchy only ever
  // offered same-parent siblings — so reaching it meant climbing back up to the
  // région and down again.
  //
  // Two constraints shape this. It is bounded by the VIEWPORT, because every
  // département in the data would otherwise be meshed and hit-tested at once. And
  // it is REFERENCE-STABLE while the visible set is unchanged: `outline` identity
  // is what re-runs ensurePlateau, so handing back a fresh array on every pan
  // frame would re-mesh the plateau continuously. Same trick as placesInView.
  let lastPeerSig = "";
  let lastPeerUnits: GeoUnit[] = [];
  const crossRegionDeps = computed<GeoUnit[]>(() => {
    const s = currentScope.value;
    if (s.levelKey !== "dep" || !s.parentId) return [];
    const view = mapView.value?.screen;
    if (!view) return [];
    const out = unitsByLevelKey(root.value, "dep").filter((u) => {
      if (u.parentId === s.parentId) return false; // same région → already a sibling
      const b = u.bounds;
      return (
        !!b &&
        b.minLat <= view.maxLat &&
        b.maxLat >= view.minLat &&
        b.minLng <= view.maxLng &&
        b.maxLng >= view.minLng
      );
    });
    const sig = out.map((u) => u.id).join("|");
    if (sig === lastPeerSig) return lastPeerUnits;
    lastPeerSig = sig;
    lastPeerUnits = out;
    return out;
  });

  // The scope's same-level neighbours (focus + context): kept on the MAP as macro
  // pins + boundaries so the surrounding units don't vanish when you drill in.
  const scopeSiblings = computed<GeoUnit[]>(() => {
    const s = currentScope.value;
    const parent = s.parentId ? index.value.get(s.parentId) : undefined;
    if (!parent) return [];
    const sibs = parent.children.filter((c) => c.id !== s.id);
    // At ARRONDISSEMENT scope, the surrounding CITIES stay visible too (the parent
    // ville's siblings) — without them, drilling past the ville level erased
    // Villeurbanne & co. The parent itself is excluded: its polygon CONTAINS the
    // scope, which would swallow every hover/click inside it.
    if (s.levelKey === "arr" && parent.parentId) {
      const gp = index.value.get(parent.parentId);
      if (gp) sibs.push(...gp.children.filter((c) => c.id !== parent.id));
    }
    return [...sibs, ...crossRegionDeps.value];
  });

  /** `geometryOf`: the outline the unit is hit by — the one its line is drawn
   *  with (see outline). */
  function toMapUnit(u: GeoUnit, geometryOf: (u: GeoUnit) => unknown = geometryFor): MapUnit {
    return {
      id: u.id,
      label: u.label,
      count: u.count,
      center: u.center,
      isLeaf: u.levelKey === "place",
      bounds: u.bounds,
      geometry: u.levelKey === "place" ? undefined : geometryOf(u),
    };
  }

  // Every lieu in the dataset. Deep in the micropin zone the map drops the
  // plateau and boundaries (outline is already empty then) and shows ALL
  // micropins whatever their location, so the reader can hop from place to place
  // directly.
  //
  // VIEWPORT-SCOPED: with thousands of lieux, emitting every leaf spawns
  // one DOM marker each and makes panning crawl. Off-screen pins are invisible
  // anyway, so restricting to the current view (padded, so edge pins don't pop)
  // changes nothing visually and keeps the marker count in the dozens. The
  // selected lieu is always kept so it can never vanish from under the panel.
  const VIEW_PAD = 0.15; // 15% of the span on each side

  // The view is emitted ~4×/s mid-gesture, so a fresh array each time would make
  // `watch(() => props.units)` rebuild markers throughout every drag — which is
  // exactly the churn this is meant to avoid. Hand back the SAME array while the
  // visible set is unchanged, so the marker layer only reacts to real changes.
  let lastViewSig = "";
  let lastViewPlaces: GeoUnit[] = [];

  const placesInView = computed<GeoUnit[]>(() => {
    const places = allPlaceUnits.value;
    // `screen`, not `bounds`: `bounds` is the symmetric box the scope logic
    // measures span against, which under pitch covers far less ground than the
    // screen shows toward the horizon — culling against it made pins wink out
    // well before they left the view.
    const b = mapView.value?.screen;
    if (!b) return places;
    const padLat = (b.maxLat - b.minLat) * VIEW_PAD;
    const padLng = (b.maxLng - b.minLng) * VIEW_PAD;
    const padded: Bounds = {
      minLat: b.minLat - padLat,
      maxLat: b.maxLat + padLat,
      minLng: b.minLng - padLng,
      maxLng: b.maxLng + padLng,
    };
    const selected = selectedPlaceId.value;
    const visible = places.filter((u) => u.id === selected || centerInBounds(u, padded));
    const sig = visible.map((u) => u.id).join("|");
    if (sig === lastViewSig) return lastViewPlaces;
    lastViewSig = sig;
    lastViewPlaces = visible;
    return visible;
  });

  // The micropin zone is entered optimistically when a lieu is opened (see
  // spotlightPlace), before the camera has dived: until it has, `placesInView` is
  // still culled against the view being LEFT, which from afar holds the whole
  // dataset. The dots wait for a view close enough to hold only a neighbourhood.
  const MICRO_PINS_MIN_ZOOM = 12;

  // A boolean of its own: read inside `mapUnits`, the zoom would re-run it on
  // every view the map emits and rebuild the markers throughout each drag.
  const showMicroPins = computed(
    () => inMicroZone.value && (mapView.value?.zoom ?? 0) >= MICRO_PINS_MIN_ZOOM,
  );

  const mapUnits = computed<MapUnit[]>(() => {
    const end = perfOn ? perfSpan("vue.mapUnits") : null;
    // Deep-zoomed into the micropin zone: every lieu in view.
    if (showMicroPins.value) {
      const dots = placesInView.value.map((u) => toMapUnit(u));
      if (end) end({ units: dots.length, micro: true });
      return dots;
    }
    // Focused level's units (detail) + surrounding siblings (context macro pins).
    const units = [
      ...panelUnits.value.map((u) => toMapUnit(u)),
      ...scopeSiblings.value.map((u) => toMapUnit(u, raisedGeometryFor)),
    ];
    // The lieu being read keeps its dot (and its halo) wherever the map has gone:
    // it is what the text belongs to, and clicking it flies back. Once only — it
    // may already be in the list, and a pin handed over twice is never removed.
    const open = selectedPlace.value;
    if (open && !units.some((u) => u.id === open.id)) units.push(toMapUnit(open));
    if (end) end({ units: units.length, micro: false });
    return units;
  });

  // Fetch geometry for any ville/arrondissement currently shown. Keyed on the SET of
  // INSEE codes so it only fires when that set changes, not on every re-centre.
  const visibleInsee = computed(() => {
    const codes: string[] = [];
    const add = (u: GeoUnit) => {
      const code = communeCodeOf(u);
      if (code) codes.push(code);
    };
    panelUnits.value.forEach(add); // the focused level's villes/arrondissements
    add(currentScope.value); // the scope itself (its outline at the lieu level)
    scopeSiblings.value.forEach(add); // surrounding sibling villes/arrondissements
    return codes;
  });
  watch(
    () => [...visibleInsee.value].sort().join(","),
    () => ensureGeo(visibleInsee.value),
    { immediate: true },
  );
  // …and the scope's own outline, a département reached by panning (see depFine).
  watch(
    () => depCodeOf(currentScope.value),
    (code) => void ensureDepFine(code),
    { immediate: true },
  );
  // …then, once it is in, the outlines of the départements beside it (their box
  // meeting its own): drawn and hit beside its raised edge, they meet it there.
  watch(
    () => {
      const s = currentScope.value;
      const code = depCodeOf(s);
      if (!code || !depFine.value[code]) return "";
      const b = s.bounds;
      return scopeSiblings.value
        .filter(
          (u) =>
            u.levelKey === "dep" &&
            u.bounds.minLat <= b.maxLat &&
            u.bounds.maxLat >= b.minLat &&
            u.bounds.minLng <= b.maxLng &&
            u.bounds.maxLng >= b.minLng,
        )
        .map((u) => depCodeOf(u))
        .join(",");
    },
    (codes) => {
      if (!codes) return;
      void Promise.all(codes.split(",").map(fetchDepFine)).then(addDepFine);
    },
  );

  return { outline, scopePending, outlineReady, mapUnits };
}
