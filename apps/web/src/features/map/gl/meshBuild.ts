// The plateau's mesh, built (PlateauWallLayer.setGeometry and its deferred
// globe pass, ac:mesh=merc): every array the layer draws the raised unit and
// its boundary lines with, and what goes with them — the rim the frame bus
// follows, the origin, the line groups' draw ranges, the units a hover may
// fill, the halo's width. A pure function of its inputs and the per-geometry
// projection caches (lib/projection.ts): no mapbox-gl, no page, no layer state
// (lib/corePurity.test.ts), so it can run where the page is not (a worker).
// The layer applies what it returns in one synchronous block (applyMesh), the
// deferred globe pass the globe set alone (applyGlobe).

import type { OutlineFC } from "../types";
import { boundsIntersect, polysOf, ringBounds } from "../lib/polygon";
import { lidBasesOf, ringBasesOf, sampleRim, type PBase } from "../lib/projection";
import { WALL_OVERSHOOT, buildHaloRing, pushGlobeVert, pushHaloVert, pushWallRing } from "./mesh";
import { concatGroups } from "./meshConcat";

/** A boundary line group's draw range (vertices) and its uniforms. */
export interface LineRange {
  width: number;
  alpha: number;
  raised: boolean;
  start: number;
  count: number;
}

/** A unit a hover may fill, by its place in `focus` or `context` (the layer
 *  re-attaches its geometry: fillsFromRecords), at `altM`, raised or on the
 *  ground. */
export interface FillRecord {
  id: string;
  kind: "focus" | "context";
  index: number;
  altM: number;
  raised: boolean;
}

/** A unit a hover may fill: its geometry, at `altM`, raised or on the ground. */
export type PendingFill = {
  g: { type?: string; coordinates?: unknown };
  altM: number;
  raised: boolean;
};

/** The mesh. The mercator set (`rim` to `haloPositions`, and the four counts)
 *  is null (0) unless `want.merc`, the globe set (`g*`) unless `want.globe`;
 *  the rest comes from the rings and is the same whatever `want` is. */
export interface MeshOut {
  /** The raised unit's id, "" when none. */
  scopeId: string;
  /** Its plateau height (0 with no unit). */
  heightM: number;
  /** Its sampled rim, packed (lib/projection.ts: STRIDE). */
  rim: Float64Array | null;
  rimCount: number;
  positions: Float32Array<ArrayBuffer> | null;
  lidPositions: Float32Array<ArrayBuffer> | null;
  linePositions: Float32Array<ArrayBuffer> | null;
  haloPositions: Float32Array<ArrayBuffer> | null;
  gWallPositions: Float32Array<ArrayBuffer> | null;
  gLidPositions: Float32Array<ArrayBuffer> | null;
  gLinePositions: Float32Array<ArrayBuffer> | null;
  gHaloPositions: Float32Array<ArrayBuffer> | null;
  vertexCount: number;
  lidVertexCount: number;
  lineVertexCount: number;
  haloVertexCount: number;
  /** The first scope ring vertex (else the first line vertex), in mercator:
   *  what every array is relative to. Null: nothing drawn. */
  origin: [number, number] | null;
  lineGroups: LineRange[];
  /** The halo's width (° of latitude-equivalent) and longitude scale. Null:
   *  untouched (no origin). */
  haloW: number | null;
  haloCos: number | null;
  /** Empty unless there is an origin and a raised unit: focus first, then
   *  context, each in its order. */
  fillRecords: FillRecord[];
}

/** One rebuild of the plateau's mesh: one quad (two triangles) per boundary
 *  edge for the walls, the lid, the boundary lines, the halo. `want.concat`:
 *  the line groups packed with one TypedArray.set each (ac:mesh=concat and
 *  merc, gl/meshConcat.ts), the same values as pushing them one by one. */
export function buildPlateauMesh(
  features: OutlineFC["features"],
  heightM: number,
  focus: OutlineFC["features"],
  context: OutlineFC["features"],
  want: { merc: boolean; globe: boolean; concat: boolean },
): MeshOut {
  // The frame bus follows the raised unit's rim (sampled from the same cached
  // bases the walls stand on). A teardown, with no features, empties it. The
  // globe-only pass does not resample it.
  const rim = want.merc ? sampleRim(features) : null;
  const verts: number[] | null = want.merc ? [] : null;
  const lidVerts: number[] | null = want.merc ? [] : null;
  const gWall: number[] | null = want.globe ? [] : null;
  const gLid: number[] | null = want.globe ? [] : null;
  let origin: [number, number] | null = null;
  const h = heightM * WALL_OVERSHOOT;
  // Per-vertex projections come from the per-geometry caches (PBase): both the
  // Mercator z and the ECEF (lib/mercator.ts, mapbox's toEcef replayed) are
  // LINEAR in altitude, so a cached ground point + per-metre delta reconstructs
  // any height with a multiply-add — no re-projection on rebuild.
  for (const f of features) {
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!g?.type) continue;
    const polyBases = ringBasesOf(g);
    // Lid: earcut + curvature subdivision, cached per geometry (see lidBasesOf).
    const lids = lidBasesOf(g);
    for (let pi = 0; pi < polyBases.length; pi++) {
      for (const ring of polyBases[pi]) {
        if (!origin && ring.length >= 2) origin = [ring[0].x, ring[0].y];
        if (origin) pushWallRing(ring, origin, h, verts, gWall);
      }
      if (origin) {
        for (const p of lids[pi]) {
          lidVerts?.push(p.x - origin[0], p.y - origin[1], h * p.zPerM);
          pushGlobeVert(gLid, p, h);
        }
      }
    }
  }
  // ALL boundary lines (focus children on the lid + context siblings and the
  // world-scope country outline on the ground) as line quads. Each vertex
  // carries the segment's OTHER endpoint + a side sign; the shader extrudes
  // perpendicular in SCREEN space (constant px width — the reason these are
  // GL, not a draped layer: draping bakes lines into integer-zoom tile
  // textures whose magnification breathes with the fractional zoom). A vertex
  // stored at B sees the segment direction flipped, so its side signs invert.
  // Vertices accumulate into per-(width, alpha, raised) groups, concatenated
  // afterwards so each regime keeps ONE buffer with per-group draw ranges.
  // 0.2% above the lid: lid and lines triangulate the same curved surface
  // differently, so exact depth ties would lose fragments to LEQUAL noise.
  const hl = h * 1.002;
  // Ground lines float 12 m up (same clearance as the halo): in the mercator
  // regime they are DEPTH-TESTED against the map's own depth buffer — that is
  // what hides the parts running behind the raised plateau — so they need
  // enough altitude not to z-fight the flat terrain surface they sit on.
  const GROUND_ALT = 12;
  const raisedPlateau = features.length > 0 && h > 0;
  type LineGroup = {
    width: number;
    alpha: number;
    raised: boolean;
    /** Its vertices, 6 a segment, counted from the rings: its draw range
     *  and whether it is drawn at all, whichever sets are built. */
    n: number;
    verts: number[] | null;
    gVerts: number[] | null;
  };
  const lineGroupMap = new Map<string, LineGroup>();
  const addLineFeature = (
    f: OutlineFC["features"][number],
    alt: number,
    alpha: number,
    raised: boolean,
  ) => {
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!g?.type) return;
    // Width follows the FEATURE's own level (country/région outlines read
    // heavy at full width), so context siblings keep the exact weight they
    // had when they were the focus one level up.
    const level = String(f.properties?.level ?? "");
    const width = level === "country" || level === "region" ? 0.9 : 1.7;
    const key = `${width}|${alpha}|${raised}`;
    let grp = lineGroupMap.get(key);
    if (!grp) {
      grp = {
        width,
        alpha,
        raised,
        n: 0,
        verts: want.merc ? [] : null,
        gVerts: want.globe ? [] : null,
      };
      lineGroupMap.set(key, grp);
    }
    // Globe line vertex: self + other endpoint (each merc + ECEF pair) + offset
    // side + GEOMETRIC side — 20 floats. `side` drives the screen-space offset
    // (its sign inverts at the B end, where the direction vector flips);
    // `geomSide` is the CONSISTENT left/right used by the feather varying —
    // reusing `side` there makes the feather cross zero mid-segment and hit ±1
    // at every join, which beads dense contours into near-invisibility.
    const pushGL = (p: PBase, o: PBase, side: number, geomSide: number) => {
      const gv = grp!.gVerts;
      if (!gv) return;
      gv.push(p.x, p.y, alt * p.zPerM, p.lo[0], p.lo[1], p.lo[2]);
      gv.push(p.lo[0] + alt * p.d[0], p.lo[1] + alt * p.d[1], p.lo[2] + alt * p.d[2]);
      gv.push(o.x, o.y, alt * o.zPerM, o.lo[0], o.lo[1], o.lo[2]);
      gv.push(o.lo[0] + alt * o.d[0], o.lo[1] + alt * o.d[1], o.lo[2] + alt * o.d[2]);
      gv.push(side, geomSide);
    };
    for (const rings of ringBasesOf(g)) {
      for (const pts of rings) {
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          // No walls (world scope) → the first line vertex anchors the origin.
          if (!origin) origin = [a.x, a.y];
          const ax = a.x - origin[0];
          const ay = a.y - origin[1];
          const bx = b.x - origin[0];
          const by = b.y - origin[1];
          const az = alt * a.zPerM;
          const bz = alt * b.zPerM;
          // Quad corners A+ B+ B- A- as two triangles (last two floats:
          // offset side, geometric side).
          grp!.n += 6;
          grp!.verts?.push(ax, ay, az, bx, by, bz, +1, +1); // A+
          grp!.verts?.push(bx, by, bz, ax, ay, az, -1, +1); // B+
          grp!.verts?.push(bx, by, bz, ax, ay, az, +1, -1); // B-
          grp!.verts?.push(ax, ay, az, bx, by, bz, +1, +1); // A+
          grp!.verts?.push(bx, by, bz, ax, ay, az, +1, -1); // B-
          grp!.verts?.push(ax, ay, az, bx, by, bz, -1, -1); // A-
          pushGL(a, b, +1, +1);
          pushGL(b, a, -1, +1);
          pushGL(b, a, +1, -1);
          pushGL(a, b, +1, +1);
          pushGL(b, a, +1, -1);
          pushGL(a, b, -1, -1);
        }
      }
    }
  };
  // Focus children sit ON the lid while a plateau stands; with no plateau
  // (world scope) they draw at ground level like everything else. Lifting
  // them is safe because the raised outline comes from the same source as
  // they do (GeoNav: the outline files, the scope's self and its bundle's
  // entries cut by one run), so it holds them. Only a unit whose self could
  // not be had rises with its coarser entry, which a child can cross by up
  // to ~1 km. A child
  // is lifted only where its box meets one of the raised polygons': the data
  // can file a unit under a scope whose outline leaves it out (Saint-Martin
  // under the Guadeloupe, some 250 km off its islands), and that one stays
  // on the ground, where it is.
  const boxesOf = (f: OutlineFC["features"][number]) =>
    polysOf((f.geometry ?? {}) as { type?: string; coordinates?: unknown }).map((poly) =>
      ringBounds(poly[0]),
    );
  const lidBoxes = raisedPlateau ? features.flatMap(boxesOf) : [];
  const lifted = new Set(
    focus.filter((f) => boxesOf(f).some((b) => lidBoxes.some((l) => boundsIntersect(b, l)))),
  );
  for (const f of focus) {
    addLineFeature(f, lifted.has(f) ? hl : GROUND_ALT, 0.95, lifted.has(f));
  }
  for (const f of context) addLineFeature(f, GROUND_ALT, 0.85, false);
  const lineVerts: number[] = [];
  const gLine: number[] = [];
  const lineGroups: LineRange[] = [];
  // ac:mesh=concat and merc (plateau/meshSwitch.ts): the same non-empty
  // groups in the same order, each copied ONCE into one Float32Array per
  // regime (the globe set has the same vertex ranges, 20 floats a vertex).
  const fast = want.concat;
  let packed: {
    lines: Float32Array<ArrayBuffer> | null;
    gLines: Float32Array<ArrayBuffer> | null;
  } | null = null;
  if (fast) {
    const groups: LineGroup[] = [];
    for (const grp of lineGroupMap.values()) {
      const count = grp.n;
      if (!count) continue;
      groups.push(grp);
    }
    let start = 0;
    for (const grp of groups) {
      lineGroups.push({
        width: grp.width,
        alpha: grp.alpha,
        raised: grp.raised,
        start,
        count: grp.n,
      });
      start += grp.n;
    }
    packed = {
      lines: want.merc ? concatGroups(groups.map((grp) => grp.verts ?? [])).array : null,
      gLines: want.globe ? concatGroups(groups.map((grp) => grp.gVerts ?? [])).array : null,
    };
  } else {
    for (const grp of lineGroupMap.values()) {
      const count = grp.n;
      if (!count) continue;
      lineGroups.push({
        width: grp.width,
        alpha: grp.alpha,
        raised: grp.raised,
        start: lineVerts.length / 8,
        count,
      });
      for (const v of grp.verts ?? []) lineVerts.push(v);
      for (const v of grp.gVerts ?? []) gLine.push(v);
    }
  }
  // Hover fills: opaque violet sweep that FILLS FROM THE BOUNDARY INWARD. Each
  // unit's polygon is earcut then refined (edge ≤ ~span/9) so vertices exist in
  // the interior, and every vertex carries its normalized distance to the
  // unit's boundary — the shader animates an alpha threshold over that varying.
  // FOCUS units sit just above the lid; CONTEXT siblings sit ~3 m above the
  // ground (they're outside the plateau). One concatenated mesh, drawn by
  // per-unit vertex range.
  // LAZY: at most ONE fill is ever drawn (the hovered unit; a retracting one is
  // copied out at beginSelection), yet building them all here cost ~373k
  // vertices and ~159M distance-field ops per drill — measured at ~985 ms, the
  // single biggest cost on the map. Record what COULD be filled and build the
  // one unit on demand in ensureFill().
  const fillRecords: FillRecord[] = [];
  // No plateau (world scope) → skip: the GL sweep only runs with a plateau up
  // (the draped scope-hover-fill is the fallback there), so the refined fill
  // meshes would be dead weight.
  if (origin && features.length) {
    const record = (
      f: OutlineFC["features"][number],
      kind: FillRecord["kind"],
      index: number,
      altM: number,
      raised: boolean,
    ) => {
      const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
      if (!g?.type) return;
      fillRecords.push({ id: String(f.properties?.id ?? ""), kind, index, altM, raised });
    };
    // Above the lid (h), below the lines — on the ground, a child left there.
    focus.forEach((f, i) => {
      if (lifted.has(f)) record(f, "focus", i, h * 1.001, true);
      else record(f, "focus", i, GROUND_ALT, false);
    });
    // Context siblings live at ground level, depth-tested like the ground
    // lines (their fill must hide behind the raised plateau too).
    context.forEach((f, i) => record(f, "context", i, GROUND_ALT, false));
  }
  // Halo: a CONTINUOUS ribbon hugging the scope boundary — the ring is first
  // SIMPLIFIED to segments comparable to the band width (per-segment screen
  // quads on a jagged boundary read as separate spikes), then each kept vertex
  // is offset OUTWARD along its miter normal in GEO space (width ∝ unit size).
  // Inner edge d=0 sits at the wall base, outer edge d=1. Layouts match the
  // fill meshes ([pos, d]) so the programs stay simple. 12 m off the ground:
  // outside the plateau the DEM is flat 0, and the offset avoids drape z-fight.
  const haloVerts: number[] | null = want.merc ? [] : null; // [x, y, z, d]
  const gHalo: number[] | null = want.globe ? [] : null; // [merc3, lo3, hi3, d]
  let haloW: number | null = null; // null: untouched (no origin)
  let haloCos = 1;
  if (origin) {
    const HALO_ALT = 12;
    // Band width in degrees, proportional to the selection's own span.
    let mnLa = 90;
    let mxLa = -90;
    let mnLo = 180;
    let mxLo = -180;
    for (const f of features) {
      const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
      if (!g?.type) continue;
      for (const poly of polysOf(g)) {
        for (const ring of poly) {
          for (const [lng, lat] of ring) {
            if (lat < mnLa) mnLa = lat;
            if (lat > mxLa) mxLa = lat;
            if (lng < mnLo) mnLo = lng;
            if (lng > mxLo) mxLo = lng;
          }
        }
      }
    }
    const cosH = Math.cos((((mnLa + mxLa) / 2) * Math.PI) / 180) || 1e-6;
    const spanH = Math.max(mxLa - mnLa, (mxLo - mnLo) * cosH);
    const W = Math.max(spanH / 95, 0.003); // ° of latitude-equivalent
    // Kept for the analyses' slabs: their glow is the plateau's.
    haloW = features.length ? W : 0;
    haloCos = cosH;
    const pushHV = (b: PBase, d: number) => pushHaloVert(haloVerts, gHalo, b, d, origin!, HALO_ALT);
    for (const f of features) {
      const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
      if (!g?.type) continue;
      for (const rings of ringBasesOf(g)) {
        for (const ringB of rings) buildHaloRing(ringB, W, cosH, pushHV);
      }
    }
  }
  const positions = verts ? new Float32Array(verts) : null;
  const lidPositions = lidVerts ? new Float32Array(lidVerts) : null;
  const linePositions = want.merc ? (packed?.lines ?? new Float32Array(lineVerts)) : null;
  const haloPositions = haloVerts ? new Float32Array(haloVerts) : null;
  return {
    scopeId: String(features[0]?.properties?.id ?? ""),
    heightM: features.length ? heightM : 0,
    rim: rim ? rim.pack : null,
    rimCount: rim ? rim.count : 0,
    positions,
    lidPositions,
    linePositions,
    haloPositions,
    gWallPositions: gWall ? new Float32Array(gWall) : null,
    gLidPositions: gLid ? new Float32Array(gLid) : null,
    gLinePositions: want.globe ? (packed?.gLines ?? new Float32Array(gLine)) : null,
    gHaloPositions: gHalo ? new Float32Array(gHalo) : null,
    vertexCount: positions ? positions.length / 3 : 0,
    lidVertexCount: lidPositions ? lidPositions.length / 3 : 0,
    lineVertexCount: linePositions ? linePositions.length / 8 : 0,
    haloVertexCount: haloPositions ? haloPositions.length / 4 : 0,
    origin,
    lineGroups,
    haloW,
    haloCos: haloW === null ? null : haloCos,
    fillRecords,
  };
}

/** The hover fills a mesh's records stand for, by unit id, each with its own
 *  geometry object from `focus` / `context` (fillBasesOf caches on it): in
 *  record order, a later record of the same id replacing an earlier one. */
export function fillsFromRecords(
  records: readonly FillRecord[],
  focus: OutlineFC["features"],
  context: OutlineFC["features"],
): Map<string, PendingFill> {
  const fills = new Map<string, PendingFill>();
  for (const { id, kind, index, altM, raised } of records) {
    const g = (kind === "focus" ? focus : context)[index].geometry as PendingFill["g"];
    fills.set(id, { g, altM, raised });
  }
  return fills;
}
