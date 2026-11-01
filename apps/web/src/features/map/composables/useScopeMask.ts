// The grey outside the raised unit, and the layers it stands among: the
// outline source (the draped hover-fill fallback, fed only when no plateau
// stands or is coming), the draped mask the globe
// shows, the GL tint sheet the flat view shows, the plateau's wall and slab
// layers — installed once the style has loaded, in this order (setupLayers).
// Owns the regime flags: which renderer holds the grey, whether the style is
// a globe at all (`isGlobeStyle`, which the fit and the slabs' sizing read).

import type mapboxgl from "mapbox-gl";
import type * as GeoJSON from "geojson";
import type { Bounds } from "@/features/geo";
import { perfEnd, perfNote, perfOn, perfSpan } from "@/shared/perf/perf";
import type { OutlineFC } from "../types";
import { nextOutlineUpload } from "../lib/outlineUpload";
import type { PlateauWallLayer } from "../gl/PlateauWallLayer";
import { MASK_OPACITY, ScopeTintLayer, sameGeoms, type MaskGeom } from "../gl/ScopeTintLayer";

export interface ScopeMaskInputs {
  getMap: () => mapboxgl.Map | null;
  /** The plateau's layer (and its slabs'), added in setupLayers in their place. */
  wall: PlateauWallLayer;
  /** The scope's outline: the `outline` prop. */
  outline: () => OutlineFC | null | undefined;
  /**
   * The scope's boundary is still loading (the `scopePending` prop): the grey
   * is held, and no outline goes to the hover-fill source (a plateau is coming).
   */
  scopePending: () => boolean | undefined;
  /** Whether a plateau is standing — the grey is cut around it. */
  plateauActive: () => boolean;
}

export function useScopeMask({
  getMap,
  wall,
  outline,
  scopePending,
  plateauActive,
}: ScopeMaskInputs) {
  const EMPTY_FC: OutlineFC = { type: "FeatureCollection", features: [] };
  const OUTLINE_SOURCE = "scope-outline";

  // ---- "Everything but the plateau" grey: dims the map outside the raised area so
  // the selection reads as the subject.
  //
  // One shape in both renderers: a world-sized sheet with the raised rings as
  // HOLES, so the plateau is excluded by geometry the moment the selection
  // changes. WHO draws that sheet depends on the projection mapbox is running:
  //
  //  - FLAT (zoom ≥ GLOBE_MAX_ZOOM): `ScopeTintLayer`, a custom GL layer. The
  //    sheet is a mesh in the map's own coordinates, so it has no tiles, no worker
  //    and no terrain re-drape — it is on screen in the frame it changes and cannot
  //    be outrun by the camera.
  //  - GLOBE (below): a draped fill on the GeoJSON source below, as before. A flat
  //    mesh cannot follow the sphere, and a world-sized draped sheet never needs
  //    rebuilding on camera movement there anyway.
  //
  // The draped sheet used to serve the flat view too, bounded to the viewport and
  // rebuilt whenever the camera left it. Every rebuild was a worker re-tile plus a
  // terrain re-drape, so a fast zoom-out showed un-greyed map until it landed.
  //
  // Earlier designs worth remembering:
  //  1. A draped polygon with the whole WORLD as its outer ring, four corners
  //     only. Tessellated per tile it produced triangles spanning the globe, which
  //     projected as flat angular slabs. `maskRing` densifies the ring instead.
  //  2. A `background` layer — no geometry, so no artifacts, but nothing can be
  //     cut out of it. The plateau could only be un-greyed by its LID drawing over
  //     it, and the lid is an async capture (~1 s), so either the incoming
  //     selection sat grey until its texture landed or the outgoing one stayed lit.
  //     A hole has no such wait: it is the reason this is geometry.
  const MASK_SOURCE = "scope-mask";
  const MASK_LAYER = "scope-mask-fill";
  const MASK_COLOR = "#8b9098"; // neutral grey — desaturates without heavy darkening
  // Its opacity, and what it looks like on screen (the GL sheet reproduces both):
  // ../gl/ScopeTintLayer's MASK_OPACITY and TINT_RGB.
  /**
   * Mapbox renders the style's globe below this zoom and the flat (mercator)
   * pipeline from it up — custom layers get a different `render` call on each side.
   */
  const GLOBE_MAX_ZOOM = 6;
  // The draped sheet's tiles take a worker round trip to appear, so they have to
  // exist a little BEFORE the camera reaches the globe. This is its layer's
  // `maxzoom`: from here down mapbox keeps the tiles loaded (transparent until the
  // globe takes over); above it the source is unused and holds none, so nothing in
  // the flat view pays for it — every tile that loads, visible or not, makes
  // mapbox re-drape the terrain under it.
  const MASK_ARM_ZOOM = 7;

  const scopeTint = new ScopeTintLayer();

  // ---- Grey outside the selection: state shared by both renderers ----------------
  // The draped (globe) sheet: which selection its GeoJSON source holds ([] =
  // empty), and whether its layer is opaque right now.
  let drapedGeoms: MaskGeom[] = [];
  let drapedShown = false;
  // Whether the style renders a globe at all (decided once the style is loaded).
  let globeStyle = false;
  // The perf probes: when the draped sheet's data was last handed to the
  // worker, until it reports it indexed (0: nothing pending).
  let drapedSetAt = 0;
  // What the outline source holds now: EMPTY_FC, or the outline object last
  // uploaded (compared by identity, see nextOutlineUpload).
  let outlineUploaded: OutlineFC = EMPTY_FC;

  /**
   * The draped sheet covers the world. On the globe a lat/lng rectangle cannot
   * describe what is on screen — the visible region is a spherical cap, not a box
   * — so there is no smaller rectangle to compute; `maskRing` densifies this one
   * so its size costs nothing in tessellation quality.
   */
  const WORLD_RECT: Bounds = { minLat: -85, maxLat: 85, minLng: -180, maxLng: 180 };

  /**
   * Ring for `b`, carrying intermediate vertices rather than just four corners.
   *
   * A straight edge between two distant corners is drawn straight in SCREEN space,
   * so on the globe it cuts across the sphere instead of following it — that is
   * what turned the very first world-sized mask into flat angular slabs. Short
   * edges track the curvature closely enough to be invisible (~260 points).
   */
  function maskRing(b: Bounds): [number, number][] {
    const STEP_DEG = 4;
    const pts: [number, number][] = [];
    const edge = (x0: number, y0: number, x1: number, y1: number) => {
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / STEP_DEG));
      for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
    };
    edge(b.minLng, b.minLat, b.maxLng, b.minLat);
    edge(b.maxLng, b.minLat, b.maxLng, b.maxLat);
    edge(b.maxLng, b.maxLat, b.minLng, b.maxLat);
    edge(b.minLng, b.maxLat, b.minLng, b.minLat);
    pts.push([b.minLng, b.minLat]); // close
    return pts;
  }

  /** The draped sheet for `geoms`: the world, minus their outer rings. */
  function worldMaskData(geoms: MaskGeom[]): GeoJSON.FeatureCollection {
    // Outer rings become holes in the grey; a selection's INNER rings are enclaves
    // of some other unit (the Enclave des Papes is Vaucluse, wholly surrounded by
    // Drôme), which the plateau leaves un-raised — so they have to be greyed back
    // in. A flat ring list cannot express that nesting: everything after the first
    // ring is a hole, so an enclave ring added there would cut MORE out. They go in
    // as separate polygons of a MultiPolygon instead, each sitting exactly inside a
    // hole, so nothing overlaps and no area is double-darkened.
    const holes: [number, number][][] = [];
    const enclaves: [number, number][][] = [];
    const addRings = (rings: [number, number][][]) => {
      if (!rings?.[0]?.length) return;
      holes.push(rings[0]);
      for (let i = 1; i < rings.length; i++) if (rings[i]?.length) enclaves.push(rings[i]);
    };
    for (const g of geoms) {
      if (g.type === "Polygon") {
        addRings(g.coordinates as [number, number][][]);
      } else if (g.type === "MultiPolygon") {
        for (const poly of (g.coordinates as [number, number][][][]) ?? []) addRings(poly);
      }
    }
    if (!holes.length) return EMPTY_FC as unknown as GeoJSON.FeatureCollection;
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiPolygon",
            coordinates: [[maskRing(WORLD_RECT), ...holes], ...enclaves.map((e) => [e])],
          },
        },
      ],
    } as unknown as GeoJSON.FeatureCollection;
  }

  /**
   * Grey outside the plateau, cut around the current selection.
   *
   * Keyed on `plateauActive` (and held as-is while the next scope's boundary is
   * still loading). The hole is what keeps the selection clear, so this needs
   * nothing from the lid: in the flat view the sheet is re-cut right here,
   * synchronously, and clicking a zone colours it in that frame.
   */
  function applyMask() {
    const src = getMap()?.getSource(MASK_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    const geoms: MaskGeom[] = [];
    if (plateauActive()) {
      for (const f of outline()?.features ?? []) {
        if (f.properties?.kind !== "scope") continue;
        const g = f.geometry as MaskGeom | undefined;
        if (g?.type === "Polygon" || g?.type === "MultiPolygon") geoms.push(g);
      }
      // The new scope's boundary is still loading: ensurePlateau keeps the old
      // plateau standing meanwhile, so keep the grey that is up too (normally cut
      // around that plateau). Clearing it here would flash the whole map in full
      // colour until the geometry arrives.
      if (!geoms.length && scopePending()) return;
    }
    const recut = scopeTint.setSelection(geoms);
    // The globe's sheet always holds the current selection, whatever the zoom:
    // re-tiling only costs anything while its tiles are loaded (MASK_ARM_ZOOM), and
    // having the data already indexed is what lets those tiles appear in time
    // when a fast zoom-out or a flight heads for the globe.
    if (!sameGeoms(geoms, drapedGeoms)) {
      drapedGeoms = geoms;
      const endSet = perfOn ? perfSpan("mask.setData") : null;
      src.setData(worldMaskData(geoms));
      if (endSet) endSet();
      if (perfOn) drapedSetAt = performance.now();
    }
    syncDrapedMask();
    // The perf probes: the grey re-cut around the new selection is the end of
    // "scope change → mask updated" (the GL sheet is on screen next frame; the
    // draped sheet's indexing is noted apart, mask.drapedIndexed). No re-cut
    // ends it as unchanged only when none can follow: the outline has nothing
    // to raise (the world scope) and nothing on its way. With a unit to raise
    // and no plateau standing yet (the first drill of a session, a drill out
    // of the lieu zone), this pass greys nothing and ensurePlateau re-cuts
    // once the plateau is up: that cut is the end.
    if (perfOn) {
      if (recut) perfEnd("scope-mask", undefined, { holes: geoms.length });
      else if (
        !scopePending() &&
        !outline()?.features.some((f) => f.properties?.kind === "scope")
      ) {
        perfEnd("scope-mask", undefined, { unchanged: true });
      }
    }
  }

  /**
   * Show the draped sheet on the globe and hide it everywhere else — the mirror
   * image of ScopeTintLayer, which draws in the flat view only.
   *
   * Called from `move`, it predicts the projection mapbox is about to render with
   * (same rule, same zoom) so that the opacity lands in the very frame the tint
   * starts or stops: `move` fires before mapbox restyles and paints. `regime` is
   * the projection a frame was ACTUALLY drawn with, reported by the tint layer —
   * the correction if the prediction was ever wrong (the zoom can be nudged
   * without a `move`, e.g. when a drag ends over the plateau).
   */
  function syncDrapedMask(regime?: boolean) {
    const map = getMap();
    if (!map) return;
    // On every `move`, so the common case must stay this cheap: a zoom read and a
    // comparison. (Both flags are false until setupOutline has added the layer.)
    const show = regime ?? (globeStyle && map.getZoom() < GLOBE_MAX_ZOOM);
    if (show === drapedShown) return;
    try {
      map.setPaintProperty(MASK_LAYER, "fill-opacity", show ? MASK_OPACITY : 0);
      drapedShown = show;
    } catch {
      // The style is mid-reload: leave the flag as it was so the next call retries.
    }
  }

  function applyOutline() {
    // The outline source only feeds the draped hover-fill fallback now — the
    // boundary LINES are GL geometry rebuilt by ensurePlateau (line widths are
    // per-feature, derived from `level` inside setGeometry). That fallback only
    // shows when no plateau stands, so the outline goes up only when none is
    // coming: no `kind === "scope"` feature (the predicate ensurePlateau raises
    // on) and no boundary pending. Every other case holds EMPTY_FC, which also
    // keeps a stale outline out: the hover filter outlives the click (setHover
    // returns early on the same id), so the previous outline would keep painting
    // over the new plateau. A drill costs one empty write, the way back to the
    // world one outline write. `plateauActive` is not read: it still describes
    // the PREVIOUS selection at this point (ensurePlateau sets it after the DEM
    // POST).
    //
    // Accepted: no draped hover during the DEM POST (~40-80 ms) and the
    // deep-link intro flight, during a cold hold (the département merge, 0.5-1 s)
    // and after a DEM failure — the GL sweep draws nothing there either.
    //
    // The dedupe compares objects, which holds because useMapFeed builds a fresh
    // outline on every recompute and nothing mutates one.
    const src = getMap()?.getSource(OUTLINE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    const next = nextOutlineUpload(outlineUploaded, outline(), !!scopePending(), EMPTY_FC);
    if (!next) return;
    outlineUploaded = next;
    const end = perfOn ? perfSpan("outline.setData", { features: next.features.length }) : null;
    src.setData(next as unknown as GeoJSON.FeatureCollection);
    if (end) end();
  }

  function setupLayers() {
    const map = getMap();
    if (!map || map.getSource(OUTLINE_SOURCE)) return;
    map.addSource(OUTLINE_SOURCE, {
      type: "geojson",
      data: EMPTY_FC as unknown as GeoJSON.FeatureCollection,
    });
    outlineUploaded = EMPTY_FC;
    // Grey everything outside the raised area (see MASK_LAYER's note). It must
    // land ABOVE the basemap's fills but BELOW its labels — greying the map is the
    // point, illegible place names are not.
    //
    // Anchoring it takes BOTH mechanisms, because the configured style decides
    // which one exists. This project's style imports `mapbox://styles/mapbox/
    // standard`, and a Standard style keeps its layers inside that import:
    // `getStyle().layers` is EMPTY, so there is no symbol layer to put a beforeId
    // in front of, and the layer would silently append above the labels. Slots are
    // the Standard mechanism; `beforeId` is the classic one and is what applies if
    // VITE_MAPBOX_STYLE ever points at a non-Standard style. Each is ignored by
    // the style that does not use it.
    const firstSymbol = map.getStyle()?.layers?.find((l) => l.type === "symbol")?.id;
    map.addSource(MASK_SOURCE, {
      type: "geojson",
      data: EMPTY_FC as unknown as GeoJSON.FeatureCollection,
      // Only ever SEEN on the globe, whose tiles stop at this zoom anyway — no
      // point indexing the sheet any deeper.
      maxzoom: GLOBE_MAX_ZOOM - 1,
    });
    map.addLayer(
      {
        id: MASK_LAYER,
        type: "fill",
        source: MASK_SOURCE,
        slot: "middle",
        maxzoom: MASK_ARM_ZOOM,
        paint: {
          "fill-color": MASK_COLOR,
          // Starts hidden: `syncDrapedMask` shows it on the globe only.
          "fill-opacity": 0,
          // The switch to/from the GL sheet must land in ONE frame. A fade would
          // leave both greys (or neither) on screen for its duration, and mapbox
          // re-drapes the whole terrain on every frame of a paint transition.
          "fill-opacity-transition": { duration: 0, delay: 0 },
          // The hole's edge is the selection's boundary, which the plateau wall
          // already draws — antialiasing it too leaves a pale seam along it.
          "fill-antialias": false,
        },
      },
      firstSymbol,
    );
    drapedGeoms = [];
    drapedShown = false;
    if (perfOn) {
      // The worker has indexed the sheet's new data: how long after setData.
      map.on("sourcedata", (e) => {
        if (e.sourceId !== MASK_SOURCE || e.sourceDataType !== "content" || !drapedSetAt) return;
        perfNote("mask.drapedIndexed", performance.now() - drapedSetAt);
        drapedSetAt = 0;
      });
    }
    // A style with no globe is flat at every zoom: the draped sheet never shows.
    globeStyle = map.getProjection()?.name === "globe";
    // The flat view's grey (see ScopeTintLayer). Same anchoring as the draped
    // sheet: the slot on a Standard style, `beforeId` on a classic one.
    scopeTint.onRegimeChange = syncDrapedMask;
    map.addLayer(scopeTint, firstSymbol);
    // The plateau's violet wall: our custom WebGL layer (see PlateauWallLayer) —
    // exact quads on the vector boundary, depth-tested against the terrain.
    map.addLayer(wall);
    // The analyses' slabs: right after it, a layer of their own — drawn over the
    // map's labels (see PlateauWallLayer.slabLayer).
    map.addLayer(wall.slabLayer);
    // Hovered-zone highlight FALLBACK for the no-plateau case only (the world
    // scope, and scopes with no raisable boundary of their own, such as the DROM
    // or other countries): with a plateau up, BOTH focus and context highlights
    // come from the GL sweep pass in PlateauWallLayer (draped paint can't reach
    // the lid, and the sweep animation only exists there). Its source is empty
    // whenever a plateau stands or is coming (applyOutline), so it draws nothing
    // then.
    map.addLayer({
      id: "scope-hover-fill",
      type: "fill",
      source: OUTLINE_SOURCE,
      filter: ["==", ["get", "id"], "__none__"],
      paint: { "fill-color": "#7c5cff", "fill-opacity": 0.6 },
    });
    // NO draped line layer: with terrain active (which is nearly always — every
    // selection stands a plateau, and even teardown revives the style fragment's
    // own terrain), mapbox rasterises draped lines into per-tile textures at
    // INTEGER zooms and magnifies them by up to 2× with the fractional zoom, so
    // their width visibly breathed while zooming. ALL boundary lines — focus,
    // context siblings, and the world-scope country outline — are GL quads in
    // PlateauWallLayer instead (true constant screen-space width).
  }

  /** A restored WebGL context comes back empty, and mapbox does not run onAdd
   *  again for custom layers: the tint sheet is set up again by hand (its own
   *  layers recover by themselves — the draped grey used to — so without this
   *  the flat view would stay un-greyed until a reload). */
  function onContextRestored() {
    const map = getMap();
    const gl = map?.getCanvas().getContext("webgl2");
    if (map && gl) scopeTint.onAdd(map, gl);
  }

  return {
    setupLayers,
    applyOutline,
    applyMask,
    syncDrapedMask,
    /** Whether the style renders a globe at all (decided once it has loaded). */
    isGlobeStyle: () => globeStyle,
    onContextRestored,
  };
}
