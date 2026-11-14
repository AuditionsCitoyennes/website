// What GeoDrillMap is handed, from the scope: the outline the plateau rises
// with (scope, focus, context), whether that outline is still on its way, the
// units pinned on the map (the scope's children, its neighbours — across a
// région border too —, every lieu in sight deep in the lieu zone), and the
// outline files fetched ahead for what is shown (`outlines`, outlineRules.ts):
// the scope's chain of bundles and its neighbours' selves.
import { computed, onScopeDispose, shallowRef, watch, type ComputedRef, type Ref } from "vue";
import {
  type Bounds,
  centerInBounds,
  globeBatch,
  type GeoUnit,
  selfFileOf,
  siblingSelves,
  unitsByLevelKey,
} from "@/features/geo";
import type { MapUnit, OutlineFC } from "@/features/map";
import { onPlateauStood, plateauHasStood } from "@/features/map/lib";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { NavState } from "../navState";
import type { OutlineFiles } from "../data/useOutlineFiles";
import { DECOR_CAP_MS, decorOpen, outlinesDecor } from "../data/outlinesDecorSwitch";
import type { GeoHierarchy } from "./useGeoHierarchy";
import { bundlesFor, outlineReadyFiles, refinementBatch } from "./outlineRules";

export interface MapFeedInputs {
  nav: NavState;
  geo: GeoHierarchy;
  panelUnits: ComputedRef<GeoUnit[]>;
  selectedPlace: ComputedRef<GeoUnit | null>;
  /** The outline files (GeoNav: under the server's tree); null: none read. */
  outlines: OutlineFiles | null;
  /** The page's boot overlay is up (GeoNav): the countries' files wait. */
  booting?: Ref<boolean>;
}

export function useMapFeed(inputs: MapFeedInputs) {
  const { nav, geo, panelUnits, selectedPlace, outlines } = inputs;
  const { currentScope, selectedPlaceId, inMicroZone, mapView } = nav;
  const {
    root,
    index,
    geometryFor,
    geometryKnownAbsent,
    raisedGeometryFor,
    raisedOutlineDue,
    allPlaceUnits,
    filesActive,
    outlineView,
    chainOf,
  } = geo;

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
  // The map does not run its pipeline for each of them all the same: it judges
  // every fresh outline against the plateau that STANDS (ac:late-files "quiet",
  // map/lib/outlineChange.ts) — the same content does nothing while it stands
  // and raises it again once it does not, which a memoised identity could not.
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
  // (cold cache: its bundles still streaming in). The map holds the current
  // plateau instead of tearing it down for a transient blank: while the
  // scope's self is due, or none is in and its chain may still bring one
  // (outlineRules, rule 2). An outline known never to come holds nothing —
  // with no file read, or once the session fell back, that is every unit's
  // (outlineRules' NO_FILES): teardown beats a stale wrong plateau.
  const scopePending = computed(() => {
    // Micropin zone → the map clears, it must never HOLD a plateau.
    if (inMicroZone.value) return false;
    const s = currentScope.value;
    if (s.levelKey === "world") return false; // only the world level has no plateau
    return raisedOutlineDue(s) || (!raisedGeometryFor(s) && !geometryKnownAbsent(s));
  });

  /** The outline has every geometry it will get: nothing of the scope's own,
   *  its children's or its neighbours' is still on its way (the perf probes'
   *  "drill → boundaries ready", shared/perf; a neighbouring département's own
   *  outline, which refines a line already drawn, is not waited for). */
  const outlineReady = computed(() => {
    if (inMicroZone.value) return true;
    if (scopePending.value) return false;
    if (!filesActive()) return true; // nothing on its way
    // The files: every bundle of the scope's chain settled.
    return outlineReadyFiles(outlineView!, chainOf(currentScope.value), false);
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

  if (outlines) {
    const files = outlines;
    const view = outlineView!;
    // The decorative batches below (the neighbour countries' selves, the
    // world outlines) under ac:outlines-decor "after" (the default): once the
    // map's first plateau stood, or DECOR_CAP_MS after the boot curtain lifted
    // (data/outlinesDecorSwitch.ts). "boot": as soon as the curtain lifts.
    const decorStood = shallowRef(plateauHasStood());
    const decorCapPassed = shallowRef(false);
    if (outlinesDecor === "after") {
      onScopeDispose(onPlateauStood(() => (decorStood.value = true)));
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      onScopeDispose(() => clearTimeout(capTimer));
      watch(
        () => !!inputs.booting?.value,
        (booting) => {
          if (booting || capTimer !== undefined) return;
          capTimer = setTimeout(() => (decorCapPassed.value = true), DECOR_CAP_MS);
        },
        { immediate: true },
      );
    }
    const decorGo = (level: string) =>
      decorOpen({
        mode: outlinesDecor,
        level,
        plateauStood: decorStood.value,
        capPassed: decorCapPassed.value,
      });
    // The late files' rule (ac:late-files, data/useOutlineFiles): a file is
    // urgent — stored as it lands, asked at high priority — only while the
    // scope's plateau is pending and the file is on its chain (its bundles,
    // a country's u/, the u/ a région's or a département's self is asked
    // from ahead of its bundle). Every other file (a standing scope's children, its
    // neighbours, the world's outlines, the file of a scope since left) is
    // kept and stored when the map is still.
    const urgent = (key: string): boolean => {
      if (!filesActive() || !scopePending.value) return false;
      const s = currentScope.value;
      if (
        key === files.keyOf("u", s.id) &&
        (files.selfAhead(s.id) ||
          (s.levelKey === "country" && selfFileOf(files.rowOf(s.id)) === "u"))
      )
        return true;
      return bundlesFor(view, chainOf(s)).some((b) => files.keyOf("k", b) === key);
    };
    files.setUrgent(urgent);
    onScopeDispose(() => files.setUrgent(null));
    // The scope's chain (rule 6): its bundles root first, each awaited — a
    // commune's row comes with its département's bundle, an arrondissement's
    // with its ville's. A newer scope runs its own chain: this one stops at
    // its next step. A self due from the start is waited for OUTLINE_WAIT_MS
    // — or, with a coarser outline of the scope in memory to rise on, for
    // what ac:outline-wait says (at 0: not at all, it rises on that one in
    // this very flush).
    watch(
      () => currentScope.value.id,
      async (id, left) => {
        // A hold-out that was for the visit of the scope left ends with it.
        if (left) files.leaveSelf(left);
        if (!filesActive()) return;
        const scope = currentScope.value;
        if (raisedOutlineDue(scope)) files.holdSelf(id, !!raisedGeometryFor(scope));
        // A file of this scope's chain kept as text (it landed while the
        // scope was elsewhere) and now waited for: stored at once.
        files.flushDue();
        // A country with no bundle: its u/ first (once its row is known).
        if (scope.levelKey === "country")
          void files.ensureRoot().then(() => {
            if (currentScope.value.id === id && selfFileOf(files.rowOf(id)) === "u")
              void files.ensureSelf(id);
          });
        // A scope whose self is declared alone in a u/ (ac:region-self
        // "first"): that file first, due — its plateau rises on it, or, risen
        // on a coarser shape already (ac:outline-wait), is reshaped with it —
        // and its chain's bundles then bring lines only.
        const ahead = !files.selfOf(id) && files.selfAhead(id);
        if (ahead) void files.ensureSelf(id);
        for (const b of bundlesFor(view, chainOf(scope))) {
          // Due while the scope's plateau waits (its fetch priority).
          await files.ensureBundle(b, !ahead && scopePending.value);
          if (currentScope.value.id !== id) return;
        }
      },
      { immediate: true },
    );
    // The neighbours' selves (rule 4), in ONE write once the scope's bundle
    // has settled: régions beside a région (none for now: REFINE_CAPS), and,
    // once the flight has landed (mapView is the view left until then), the
    // départements of other régions on screen. Not waited for: they refine
    // lines already drawn, or draw lines that had none.
    watch(
      () => {
        if (!filesActive()) return "";
        void mapView.value; // a landing re-reads the pin below
        const s = currentScope.value;
        const cross = crossRegionDeps.value;
        // Its bundle settled — or in memory, kept until the map is still: the
        // neighbours are asked meanwhile and stored with it, in one write.
        if (view.bundleState(s.id) === "loading" && !files.isHeld("k", s.id)) return "";
        const parent = s.parentId ? index.value.get(s.parentId) : undefined;
        // At a country, the countries whose box meets its own, once its self
        // is in (or given up on): their lines beside its raised edge.
        if (s.levelKey === "country") {
          if (raisedOutlineDue(s) || inputs.booting?.value) return "";
          if (!decorGo(s.levelKey)) return "";
          const countries = root.value.children.filter((c) => c.levelKey === "country");
          const ids = siblingSelves(s, countries, files.rowOf).join(",");
          return ids ? `decor|${ids}` : ""; // decoration (outlinesDecorSwitch.ts)
        }
        const landed = !nav.scopePinned.value;
        return refinementBatch(view, s, parent?.children ?? [], landed ? cross : []).join(",");
      },
      (key) => {
        if (!key) return;
        const decor = key.startsWith("decor|");
        void files.batchSelf((decor ? key.slice(6) : key).split(","), decor);
      },
    );
    // The countries' world outlines (geo's globeBatch), in ONE write, at the
    // world's scope and at a country's, once the boot is over (the overlay
    // waits for none of them): the tree's first countries, then those beyond
    // whose box meets the view — asked once the user's move rests (its view
    // comes every 250 ms). Keyed on the id set, never on the store's version:
    // a write must not ask again.
    const GLOBE_REST_MS = 400; // over the view's 250 ms during a gesture
    let globeTimer: ReturnType<typeof setTimeout> | undefined;
    onScopeDispose(() => clearTimeout(globeTimer));
    watch(
      () => {
        const s = currentScope.value;
        if (!filesActive() || inputs.booting?.value) return "";
        if (s.levelKey !== "world" && s.levelKey !== "country") return "";
        if (!decorGo(s.levelKey)) return ""; // decoration: after the first plateau
        if (raisedOutlineDue(s)) return ""; // a country's own u/ first
        const countries = root.value.children.filter((c) => c.levelKey === "country");
        const { g, u } = globeBatch(countries, files.rowOf, mapView.value?.screen);
        // At a country they are decoration; at the world's scope, its content.
        const decor = s.levelKey === "country" ? "decor" : "";
        return g.length || u.length ? `${decor}|${g.join(",")}|${u.join(",")}` : "";
      },
      (key) => {
        clearTimeout(globeTimer);
        if (!key) return;
        const [decor, g, u] = key.split("|").map((ids) => (ids ? ids.split(",") : []));
        const ask = () => void files.ensureGlobe(g, u, decor.length > 0);
        if (mapView.value?.byUser) globeTimer = setTimeout(ask, GLOBE_REST_MS);
        else ask();
      },
      { immediate: true },
    );
    // Every file the outline draws from stays in the store (an evicted line
    // would vanish and be fetched again): the chain, the scope, its children,
    // its neighbours (a country's g/ and u/ alike) — pinned again as each
    // file lands.
    watch(
      () => {
        if (!filesActive()) return "";
        const s = currentScope.value;
        const ids = [
          ...bundlesFor(view, chainOf(s)),
          s.id,
          ...panelUnits.value.map((u) => u.id),
          ...scopeSiblings.value.map((u) => u.id),
        ];
        return `${files.version.value} ${ids.join(",")}`;
      },
      (key) => {
        if (key) files.pin(key.slice(key.indexOf(" ") + 1).split(","));
      },
      { immediate: true },
    );
  }

  return { outline, scopePending, outlineReady, mapUnits };
}
