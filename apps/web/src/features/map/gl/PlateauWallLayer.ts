// The plateau's violet wall and everything drawn with it — the lid, the
// boundary lines, the hover fill and its retract, the halo, the analyses'
// slabs' pieces (and their own layer, slabLayer) — in both of mapbox's
// regimes: the custom WebGL layer the map's whole raised look comes from. The
// documented exemption to the file-size rule (docs/architecture-proposal-
// 2026-10-20.md): a GL class, kept whole; the SlabPieces collaborator is a
// later option. Its collaborators: ../lib/projection (the per-geometry
// caches), ./mesh (the pieces), ./program, ./plateauShaders.

import mapboxgl from "mapbox-gl";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { Snapshot } from "../plateau/mapSnapshot";
import { pieceOutline, ringSectorArcs, slabPointPx, type PieceBox, type SlabRect } from "../lib";
import type { OutlineFC, SlabSpec, SlabThemesSpec } from "../types";
import { boundsIntersect, polysOf, ringBounds } from "../lib/polygon";
import {
  STRIDE,
  baseOf,
  fillBasesOf,
  lidBasesOf,
  packBase,
  ringBasesOf,
  sampleRim,
  type PBase,
} from "../lib/projection";
import {
  GLOBE_UNIS,
  buildProgram,
  foldOrigin,
  globeFrame,
  type GlProg,
  type MapPainterInternals,
} from "./program";
import {
  VIOLET,
  WALL_OVERSHOOT,
  buildHaloRing,
  pushGlobeVert,
  pushHaloVert,
  pushPieceVert,
  pushWallRing,
} from "./mesh";
import {
  FILL_FS,
  FILL_VS,
  G_FILL_VS,
  G_HALO_VS,
  G_LID_VS,
  G_LINE_VS,
  G_PIECE_VS,
  G_WALL_VS,
  HALO_FS,
  HALO_VS,
  LID_FS,
  LID_VS,
  LINE_FS,
  LINE_VS,
  PIECE_FS,
  PIECE_VS,
  WALL_FS,
  WALL_VS,
} from "./plateauShaders";

// ---- The plateau's violet wall: a custom WebGL layer ---------------------------
// Zero-thickness vertical quads standing EXACTLY on the selection's vector
// boundary, ground → height, drawn with our own shader and depth-tested against
// the terrain (renderingMode "3d"). This bypasses every Mapbox heuristic that
// broke the previous attempts: no draping (no texel-staircase misalignment), no
// fill-extrusion terrain anchoring (no per-centroid DEM sampling → no sawtooth),
// just exact world-space geometry. The DEM is eroded inward server-side, so the
// terrain wall is always recessed behind this sheet. Height rise/sink is a single
// uniform (uScale) — animated without touching the geometry.

// ---- The analyses' slabs' pieces (PlateauWallLayer.setSlabs) ----------------------

/** A box on a slab, by its four corners in the layer's slabCorners from `at`. */
export interface SlabQuad {
  name: "ring" | "label" | "plaque" | "bar";
  w: number;
  h: number;
  at: number;
}

/** The ring's part picked and the one hovered (null: the largest picked, none
 *  hovered), as the overlay has them. */
export interface SlabRingState {
  picked: string | null;
  hovered: string | null;
}
export const NO_RING: SlabRingState = { picked: null, hovered: null };

/** Which of the slabs a mercator draw takes (drawSlabsMercator). */
type SlabPass = "all" | "parts" | "boxes" | "over";

/** A piece's walls against its top: a shade darker, the same hue. */
const WALL_SHADE = 0.8;
const shade = (rgb: readonly number[]) => rgb.map((v) => v * WALL_SHADE);
/** "#rrggbb" as straight sRGB 0..1 (the themes' colours, as the page draws them). */
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class PlateauWallLayer implements mapboxgl.CustomLayerInterface {
  id = "plateau-wall";
  type = "custom" as const;
  renderingMode = "3d" as const;
  private map: mapboxgl.Map | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = 0;
  private uMatrix: WebGLUniformLocation | null = null;
  private uScale: WebGLUniformLocation | null = null;
  private positions = new Float32Array(0);
  private origin: [number, number] = [0, 0];
  private vertexCount = 0;
  private dirty = false;
  private scale = 0; // animated rise 0..1
  // ---- what the frame bus reads (see onFrame): the raised unit as last given
  // to setGeometry, its sampled rim, and the camera of the last frame drawn ----
  scopeId = ""; // the raised unit's id, '' when none
  heightM = 0; // its plateau height; the lid stands at heightM × WALL_OVERSHOOT × rise
  rim: Float64Array = new Float64Array(0); // packed rim samples (see STRIDE)
  rimCount = 0;
  rimVersion = 0; // bumped by every setGeometry: the rim may change under the same id
  readonly cam = {
    seq: 0, // bumped per captured frame
    m: new Float64Array(16), // the custom-layer matrix (mercator → clip)
    globe: false, // drawn by the globe programs (zoom < 6)
    g2m: new Float64Array(16), // globe only: ECEF → the world the matrix takes
    t: 0, // globe only: the sphere → mercator morph, smoothstep(5, 6, zoom)
    cx: 0, // globe only: the map centre in mercator…
    cy: 0,
    r: 1, // …and the pixels-per-metre ratio the mercator twin is rescaled by
  };
  get rise(): number {
    return this.scale;
  }
  // ---- the map-textured top ("lid"): same vector boundary as the walls, so the
  // plateau surface reaches the wall exactly, with a vector-smooth edge ----
  private lidProgram: WebGLProgram | null = null;
  private lidBuffer: WebGLBuffer | null = null;
  private lidAPos = 0;
  private lidUMatrix: WebGLUniformLocation | null = null;
  private lidUScale: WebGLUniformLocation | null = null;
  private lidUTexOrigin: WebGLUniformLocation | null = null;
  private lidUTexSpan: WebGLUniformLocation | null = null;
  private lidPositions = new Float32Array(0);
  private lidVertexCount = 0;
  private lidDirty = false;
  private lidTexture: WebGLTexture | null = null;
  /** GL_MAX_TEXTURE_SIZE, read in onAdd — caps the lid snapshot's pixel budget. */
  maxTextureSize = 0;
  // Anisotropic filtering for the lid — probed once (see the upload in render()).
  // maxAniso: 0 = not probed yet, -1 = extension unavailable.
  private anisoExt: EXT_texture_filter_anisotropic | null = null;
  private maxAniso = 0;
  private lidPending: Snapshot | null = null; // uploaded lazily in render (gl there)
  private lidMerc: { minX: number; minY: number; spanX: number; spanY: number } | null = null;
  // ---- focus boundary lines ON the lid: true vectors extruded to screen-space
  // width in the shader, so they stay the same pixel size at every zoom (the old
  // approach baked them into the lid SNAPSHOT — a raster that fattened on zoom) ----
  private lineProgram: WebGLProgram | null = null;
  private lineBuffer: WebGLBuffer | null = null;
  private lineAPos = 0;
  private lineAOther = 0;
  private lineASide = 0;
  private lineAGeomSide = 0;
  private lineUMatrix: WebGLUniformLocation | null = null;
  private lineUScale: WebGLUniformLocation | null = null;
  private lineUViewport: WebGLUniformLocation | null = null;
  private lineUWidth: WebGLUniformLocation | null = null;
  private lineUAlpha: WebGLUniformLocation | null = null;
  private linePositions = new Float32Array(0);
  private lineVertexCount = 0;
  private lineDirty = false;
  // Line vertices are grouped by (width, alpha, raised): width follows each
  // feature's own admin level, raised groups ride the rise animation (uScale)
  // at lid height while ground groups draw at a fixed few metres. One
  // concatenated buffer per regime; each group is a vertex RANGE drawn with its
  // own uniforms.
  private lineGroups: {
    width: number;
    alpha: number;
    raised: boolean;
    start: number;
    count: number;
  }[] = [];
  // ---- GLOBE regime (zoom < 6, experimental custom-layer API) ----
  // Below the globe→mercator transition, mapbox calls render() with extra args
  // (projection, globeToMercMatrix, transition t, centerInMercator, pxPerMeterRatio)
  // and the same meshes are drawn by globe programs: absolute-mercator + dual-ECEF
  // attributes, morphed in-shader between the sphere and mercator by t — the exact
  // pattern of mapbox's own debug/satellites-custom-layer.js. ECEF is linear in
  // altitude, so the rise stays a uniform: ecef = mix(ecefGround, ecefFull, uScale).
  private gWallProg: GlProg | null = null;
  private gLidProg: GlProg | null = null;
  private gLineProg: GlProg | null = null;
  private gWallBuffer: WebGLBuffer | null = null;
  private gLidBuffer: WebGLBuffer | null = null;
  private gLineBuffer: WebGLBuffer | null = null;
  private gWallPositions = new Float32Array(0);
  private gLidPositions = new Float32Array(0);
  private gLinePositions = new Float32Array(0);
  private gWallDirty = false;
  private gLidDirty = false;
  private gLineDirty = false;
  // ---- hovered-zone highlight: a translucent fill for ONE focus unit, drawn
  // between the lid and the boundary lines. Focus units live ON the plateau, so
  // a draped fill layer can't reach them (the lid covers it) — this GL pass can.
  // One concatenated mesh, drawn by per-unit vertex RANGE (no per-vertex ids).
  private fillProg: GlProg | null = null;
  private gFillProg: GlProg | null = null;
  private hovBuffer: WebGLBuffer | null = null;
  private gHovBuffer: WebGLBuffer | null = null;
  private hovPositions = new Float32Array(0);
  private gHovPositions = new Float32Array(0);
  private hovDirty = false;
  private gHovDirty = false;
  private fillRanges = new Map<string, { start: number; count: number; raised: boolean }>();
  // Units whose hover fill COULD be needed, and the origin their mesh must be
  // relative to. The mesh itself is built on first hover (see ensureFill).
  private pendingFills = new Map<
    string,
    { g: { type?: string; coordinates?: unknown }; altM: number; raised: boolean }
  >();
  private fillOrigin: [number, number] | null = null;

  /**
   * Build the hover-fill mesh for ONE unit, on demand. Only the hovered unit is
   * ever drawn from `hovPositions` (a retracting unit's vertices are copied into
   * `retractPositions` at beginSelection), so the buffer holds exactly one mesh
   * and its range always starts at 0. `fillBasesOf` caches the expensive part
   * (earcut + curvature refine + boundary-distance field) per geometry, so
   * re-hovering a unit is a pure multiply-add assembly.
   */
  private ensureFill(id: string): void {
    if (!id || this.fillRanges.has(id)) return;
    const spec = this.pendingFills.get(id);
    const origin = this.fillOrigin;
    if (!spec || !origin) return;
    const { pts, dNorm } = fillBasesOf(spec.g);
    if (!pts.length) return;
    const { altM, raised } = spec;
    const hov = new Float32Array(pts.length * 4);
    const gHov = new Float32Array(pts.length * 10);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d = dNorm[i];
      const z = altM * p.zPerM;
      const o = i * 4;
      hov[o] = p.x - origin[0];
      hov[o + 1] = p.y - origin[1];
      hov[o + 2] = z;
      hov[o + 3] = d;
      const q = i * 10;
      gHov[q] = p.x;
      gHov[q + 1] = p.y;
      gHov[q + 2] = z;
      gHov[q + 3] = p.lo[0];
      gHov[q + 4] = p.lo[1];
      gHov[q + 5] = p.lo[2];
      gHov[q + 6] = p.lo[0] + altM * p.d[0];
      gHov[q + 7] = p.lo[1] + altM * p.d[1];
      gHov[q + 8] = p.lo[2] + altM * p.d[2];
      gHov[q + 9] = d;
    }
    // One mesh in flight: replace rather than concatenate.
    this.fillRanges.clear();
    this.fillRanges.set(id, { start: 0, count: pts.length, raised });
    this.hovPositions = hov;
    this.gHovPositions = gHov;
    this.hovDirty = true;
    this.gHovDirty = true;
  }
  private hoveredFillId = "";
  private hoverT0 = 0; // sweep start; the fill animates boundary → centre
  // Reverse sweep on SELECTION: the hovered unit's fill is snapshotted into its
  // own buffers (the selection immediately rebuilds the mesh and drops its
  // range) and drained centre → boundary by animating the threshold back down.
  private retractPositions = new Float32Array(0);
  private gRetractPositions = new Float32Array(0);
  private retractBuffer: WebGLBuffer | null = null;
  private gRetractBuffer: WebGLBuffer | null = null;
  private retractDirty = false;
  private gRetractDirty = false;
  private retractT0 = 0;
  private retractActive = false;
  // Whether the snapshotted fill came from a RAISED (focus) unit — ground
  // retracts keep the depth test so they stay hidden behind the plateau.
  private retractRaised = true;
  // Halo on the SELECTED scope's boundary: a static glow band from the wall
  // base outward.
  private haloPositions = new Float32Array(0);
  private gHaloPositions = new Float32Array(0);
  private haloBuffer: WebGLBuffer | null = null;
  private gHaloBuffer: WebGLBuffer | null = null;
  private haloVertexCount = 0;
  private haloDirty = false;
  private gHaloDirty = false;
  private haloProg: GlProg | null = null;
  private gHaloProg: GlProg | null = null;
  private lastRegimeLog = "";
  /** The halo's width (° of latitude-equivalent) and longitude scale, as the
   *  last setGeometry had them: the slabs glow alike (0: no plateau). */
  private haloW = 0;
  private haloCos = 1;
  // ---- the analyses' SLABS: pieces raised beside the territory (see setSlabs).
  // Their own small mesh — never part of setGeometry, whose rebuild is the
  // map's costliest step — at the plateau's lid height, rising with it
  // (uScale = the plateau's rise × their own presence, slabP) ----
  slabScopeId = ""; // the unit they were built for, '' when none
  slabHeightM = 0;
  /** Boxes on the slabs by their corners (NW, NE, SE, SW, packed from `at`;
   *  see STRIDE): those words are laid on (ring, label, plaque) and the
   *  pieces that hide what is under them (label, plaque, bar; the ring by its
   *  box and slabRingCover). */
  slabCorners: Float64Array = new Float64Array(0);
  slabQuads: SlabQuad[] = [];
  /** The ring in its box, px — its centre, its hole's radius and its picked
   *  part's outer edge: what it hides. Null: no ring. */
  slabRingCover: { c: number; rIn: number; rOut: number } | null = null;
  slabVersion = 0;
  /** How long the ring's parts and the bar took to build, last time, ms. */
  slabPartsMs = 0;
  /** Their presence, 0..1 (animateSlabs): they come and go alone too. */
  private slabP = 0;
  /** The words' pieces' lid (see SlabSpec.lid), and its colour when opaque
   *  (the site's card colour, straight sRGB 0..1). */
  private slabLid: SlabSpec["lid"] = "verre";
  private slabColor: [number, number, number] = [1, 1, 1];
  private slabOrigin: [number, number] = [0, 0];
  /** What the ring's parts and the bar are built from — built again for
   *  another pick or hover (setSlabRing) —, and for which they last were. */
  private slabThemes: { rect: SlabRect; spec: SlabThemesSpec; h: number } | null = null;
  private slabRingKey = "";
  // The meshes: mercator [x, y, z, r, g, b] relative to slabOrigin, the
  // globe's [merc3, lo3, hi3, rgb3]. The words' boxes' walls and lids, built
  // with the slabs, kept to go after the ring's parts' and the bar's in each
  // buffer (the parts' first: slabPartWallCount walls, slabPartLidCount lids);
  // the boxes' glow ([x, y, z, d] / [merc3, lo3, hi3, d]).
  private boxWall = new Float32Array(0);
  private gBoxWall = new Float32Array(0);
  private boxLid = new Float32Array(0);
  private gBoxLid = new Float32Array(0);
  private slabWallPos = new Float32Array(0);
  private slabLidPos = new Float32Array(0);
  private slabHaloPos = new Float32Array(0);
  private gSlabWallPos = new Float32Array(0);
  private gSlabLidPos = new Float32Array(0);
  private gSlabHaloPos = new Float32Array(0);
  private slabWallCount = 0;
  private slabPartWallCount = 0;
  private slabPartLidCount = 0;
  private slabLidCount = 0;
  private slabHaloCount = 0;
  private slabDirty = false;
  private gSlabDirty = false;
  private slabWallBuf: WebGLBuffer | null = null;
  private slabLidBuf: WebGLBuffer | null = null;
  private slabHaloBuf: WebGLBuffer | null = null;
  private gSlabWallBuf: WebGLBuffer | null = null;
  private gSlabLidBuf: WebGLBuffer | null = null;
  private gSlabHaloBuf: WebGLBuffer | null = null;
  private slabPieceProg: GlProg | null = null;
  private gSlabPieceProg: GlProg | null = null;
  private slabMat = new Float32Array(16);
  /**
   * The slabs' own layer, drawn with this one's programs and buffers: mapbox
   * draws the map's labels (the Standard style's have an occlusion opacity)
   * right after its LAST "3d" layer — this one —, so they came out over the
   * slabs' pieces. A "2d" layer after it is drawn after them, and hides those
   * its pieces stand on — the slabs alone on the globe, their walls and opaque
   * lids again in mercator (renderSlabs) —, but for a glass lid's: there they
   * are meant to be seen, through the glass. (The plateau's lid keeps its labels.)
   */
  readonly slabLayer: mapboxgl.CustomLayerInterface = {
    id: "plateau-slabs",
    type: "custom",
    renderingMode: "2d",
    render: (gl, matrix, projection, globeToMerc, t, centre, pxRatio) =>
      this.renderSlabs(gl, matrix, projection, globeToMerc, t, centre, pxRatio),
  };
  /** The slabs' rise this frame: the plateau's, times their presence. */
  get slabRise(): number {
    return this.scale * this.slabP;
  }
  get slabPresence(): number {
    return this.slabP;
  }

  /**
   * Stand the analyses' slabs (`rects`, from map/lib/slabs) for the unit raised
   * now, at its lid's height: on the bottom one the plaque; on the top one,
   * when `themes` gives its row, the label's box, the bar and each of the
   * ring's parts (`ring`: the part picked and the one hovered). The words'
   * boxes (label, plaque) have the plateau's violet walls and glow and a lid of
   * their own (see SlabSpec.lid); the bar and the ring's parts stand in their
   * theme's colour, no glow. Small meshes (some hundreds of vertices): well
   * under a millisecond. Empty: none.
   */
  setSlabs(
    rects: SlabRect[],
    themes: SlabThemesSpec | null,
    heightM: number,
    scopeId: string,
    ring: SlabRingState = NO_RING,
  ) {
    const h = heightM * WALL_OVERSHOOT;
    const top = (themes && rects.find((r) => r.side === "top")) || null;
    const bottom = rects.find((r) => r.side === "bottom") ?? null;
    const quads: SlabQuad[] = [];
    const at: [number, number][] = [];
    const quad = (name: SlabQuad["name"], r: SlabRect, b: PieceBox) => {
      quads.push({ name, w: b.w, h: b.h, at: at.length });
      at.push(
        slabPointPx(r, b.x, b.y),
        slabPointPx(r, b.x + b.w, b.y),
        slabPointPx(r, b.x + b.w, b.y + b.h),
        slabPointPx(r, b.x, b.y + b.h),
      );
    };
    // The words' boxes: raised, violet, glowing.
    const boxes: { r: SlabRect; b: PieceBox }[] = [];
    if (top && themes) {
      quad("ring", top, themes.ringBox);
      quad("label", top, themes.labelBox);
      quad("bar", top, themes.barBox);
      boxes.push({ r: top, b: themes.labelBox });
    }
    if (bottom) {
      const b = { x: 0, y: 0, w: bottom.w, h: bottom.h };
      quad("plaque", bottom, b);
      boxes.push({ r: bottom, b });
    }
    const corners = new Float64Array(at.length * STRIDE);
    at.forEach(([lng, lat], i) => packBase(corners, i, baseOf(lng, lat)));
    const origin: [number, number] = at.length ? [corners[0], corners[1]] : [0, 0];
    const wall: number[] = [];
    const gWall: number[] = [];
    const lid: number[] = [];
    const gLid: number[] = [];
    const halo: number[] = [];
    const gHalo: number[] = [];
    const HALO_ALT = 12;
    for (const { r, b } of boxes) {
      const g = { type: "Polygon", coordinates: [pieceOutline(r, b)] };
      for (const ringB of ringBasesOf(g)[0] ?? []) {
        pushWallRing(ringB, origin, h, wall, gWall, VIOLET);
        if (this.haloW > 0) {
          buildHaloRing(ringB, this.haloW, this.haloCos, (pb, d) =>
            pushHaloVert(halo, gHalo, pb, d, origin, HALO_ALT),
          );
        }
      }
      // Its colour comes from the frame (uTint): the card's, or none (glass).
      for (const p of lidBasesOf(g)[0] ?? []) pushPieceVert(p, origin, h, VIOLET, lid, gLid);
    }
    this.slabScopeId = at.length ? scopeId : "";
    this.slabHeightM = at.length ? heightM : 0;
    this.slabCorners = corners;
    this.slabQuads = quads;
    this.slabRingCover =
      top && themes
        ? {
            c: themes.ring.c,
            rIn: themes.ring.r,
            rOut: themes.ring.R + themes.ring.pick,
          }
        : null;
    this.slabVersion++;
    this.slabOrigin = origin;
    this.slabThemes = top && themes ? { rect: top, spec: themes, h } : null;
    this.boxWall = new Float32Array(wall);
    this.gBoxWall = new Float32Array(gWall);
    this.boxLid = new Float32Array(lid);
    this.gBoxLid = new Float32Array(gLid);
    this.slabHaloPos = new Float32Array(halo);
    this.gSlabHaloPos = new Float32Array(gHalo);
    this.slabHaloCount = halo.length / 4;
    this.slabRingKey = "";
    this.setSlabRing(ring);
  }

  /**
   * The ring's parts and the bar, built again for `ring` (nothing when they
   * already are): each part a sector of the ring (map/lib/slabs: ringSectorArcs),
   * as wide as it is drawn (MIN_ARC widening included), the picked one grown
   * out by `pick`, a part hovered by `hover`; in its theme's colour picked or
   * hovered, else its pastel — its walls a shade darker —; the bar in the
   * colour of the theme the label names (the one hovered, else the picked).
   * Then the words' boxes' meshes after them, as built (setSlabs).
   */
  setSlabRing(ring: SlabRingState) {
    const t = this.slabThemes;
    const parts = t?.spec.ring.parts ?? [];
    const picked =
      ring.picked && parts.some((p) => p.theme === ring.picked)
        ? ring.picked
        : (parts[0]?.theme ?? null);
    const hovered =
      ring.hovered && parts.some((p) => p.theme === ring.hovered) ? ring.hovered : null;
    const key = `${this.slabVersion}|${picked}|${hovered}`;
    if (key === this.slabRingKey) return;
    this.slabRingKey = key;
    const t0 = performance.now();
    const wall: number[] = [];
    const gWall: number[] = [];
    const lid: number[] = [];
    const gLid: number[] = [];
    if (t) {
      const { rect, spec, h } = t;
      const g = spec.ring;
      const o = this.slabOrigin;
      const cx = spec.ringBox.x + g.c;
      const cy = spec.ringBox.y + g.c;
      for (const p of g.parts) {
        const lit = p.theme === picked || p.theme === hovered;
        const rgb = hexRgb(lit ? p.color : p.pastel);
        const grow = p.theme === picked ? g.pick : p.theme === hovered ? g.hover : 0;
        const arcs = ringSectorArcs(rect, cx, cy, g.r, g.R + grow, p.a0, p.a1);
        const out = arcs.outer.map(([lng, lat]) => baseOf(lng, lat));
        const inn = arcs.inner.map(([lng, lat]) => baseOf(lng, lat));
        // Its top: a strip from the outer arc to the inner one.
        for (let i = 0; i + 1 < out.length; i++) {
          for (const v of [out[i], out[i + 1], inn[i + 1], out[i], inn[i + 1], inn[i]]) {
            pushPieceVert(v, o, h, rgb, lid, gLid);
          }
        }
        // Its walls, round its outline: out along the outer arc, back along
        // the inner one.
        pushWallRing([...out, ...[...inn].reverse(), out[0]], o, h, wall, gWall, shade(rgb));
      }
      const named = g.parts.find((p) => p.theme === (hovered ?? picked));
      if (named) {
        const rgb = hexRgb(named.color);
        const bar = { type: "Polygon", coordinates: [pieceOutline(rect, spec.barBox)] };
        for (const ringB of ringBasesOf(bar)[0] ?? []) {
          pushWallRing(ringB, o, h, wall, gWall, shade(rgb));
        }
        for (const p of lidBasesOf(bar)[0] ?? []) pushPieceVert(p, o, h, rgb, lid, gLid);
      }
    }
    const join = (a: number[], b: Float32Array) => {
      const out = new Float32Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    };
    this.slabWallPos = join(wall, this.boxWall);
    this.gSlabWallPos = join(gWall, this.gBoxWall);
    this.slabLidPos = join(lid, this.boxLid);
    this.gSlabLidPos = join(gLid, this.gBoxLid);
    this.slabWallCount = this.slabWallPos.length / 6;
    this.slabPartWallCount = wall.length / 6;
    this.slabPartLidCount = lid.length / 6;
    this.slabLidCount = this.slabLidPos.length / 6;
    this.slabDirty = true;
    this.gSlabDirty = true;
    this.slabPartsMs = Math.round((performance.now() - t0) * 1000) / 1000;
    this.map?.triggerRepaint();
  }

  setSlabPresence(p: number) {
    this.slabP = p;
    this.map?.triggerRepaint();
  }

  /** The words' boxes' lid when opaque (the site's card colour, straight sRGB 0..1). */
  setSlabColor(rgb: [number, number, number]) {
    this.slabColor = rgb;
    this.map?.triggerRepaint();
  }

  setSlabLid(lid: SlabSpec["lid"]) {
    if (lid === this.slabLid) return;
    this.slabLid = lid;
    this.map?.triggerRepaint();
  }

  /** Highlight (or clear) the hovered unit's fill (restarts the inward sweep). */
  setHovered(id: string) {
    if (this.hoveredFillId === id) return;
    this.ensureFill(id); // build this unit's mesh the first time it is hovered
    this.hoveredFillId = id;
    if (id) this.hoverT0 = performance.now();
    this.map?.triggerRepaint();
  }

  /** Sweep progress ∈ [0, 1.15]: threshold past 1+feather so the fill completes.
   *  Keeps repainting until done. NB triggerRepaint() from inside render() always
   *  queues another frame (mapbox clears _frame before _render), so only BOUNDED
   *  loops may do it, like this sweep and the retract's; an unbounded one never lets
   *  the map rest (the halo pulse once did, later paced at 25 Hz from a timer). */
  private fillSweepT(): number {
    const t = Math.min(1.15, ((performance.now() - this.hoverT0) / 133) * 1.15);
    if (t < 1.15) this.map?.triggerRepaint();
    return t;
  }

  /** The unit is being SELECTED: snapshot its hover fill (if it was the hovered
   *  one) and drain it centre → boundary. Must run BEFORE setGeometry rebuilds
   *  the fill mesh (the selection drops the unit's range). */
  beginSelection(id: string) {
    if (!id || id !== this.hoveredFillId) return;
    const range = this.fillRanges.get(id);
    this.hoveredFillId = "";
    if (!range) return;
    this.retractPositions = this.hovPositions.slice(
      range.start * 4,
      (range.start + range.count) * 4,
    );
    this.gRetractPositions = this.gHovPositions.slice(
      range.start * 10,
      (range.start + range.count) * 10,
    );
    this.retractDirty = true;
    this.gRetractDirty = true;
    this.retractT0 = performance.now();
    this.retractActive = true;
    this.retractRaised = range.raised;
    this.map?.triggerRepaint();
  }

  /** Reverse-sweep threshold: 1.15 → −0.13 over ~117 ms; deactivates at the end. */
  private retractT(): number {
    const t = 1.15 - ((performance.now() - this.retractT0) / 117) * 1.28;
    if (t <= -0.13) {
      this.retractActive = false;
      this.retractPositions = new Float32Array(0);
      this.gRetractPositions = new Float32Array(0);
      return -0.13;
    }
    this.map?.triggerRepaint();
    return t;
  }

  /** Rebuild the wall mesh: one quad (two triangles) per boundary edge. Vertex
   *  coords are Mercator, relative to the first vertex (float32 keeps precision
   *  on small offsets; the origin is re-added into the matrix each frame in
   *  float64). z holds the FULL wall height — uScale animates it. */
  setGeometry(
    features: OutlineFC["features"],
    heightM: number,
    focus: OutlineFC["features"] = [],
    context: OutlineFC["features"] = [],
  ) {
    // NOTE: do NOT early-exit on "identical inputs". onAdd() allocates fresh GL
    // buffers and the render path only uploads while the *Dirty flags are set, so
    // skipping a rebuild after the layer is re-added leaves every buffer empty and
    // nothing draws. The per-geometry caches (ringBasesOf / lidBasesOf /
    // fillBasesOf) already make a repeat build cheap — it is pure array assembly.

    const endSpan = perfOn
      ? perfSpan("plateau.setGeometry", { scope: features[0]?.properties?.id })
      : null;
    const verts: number[] = [];
    const lidVerts: number[] = [];
    const gWall: number[] = [];
    const gLid: number[] = [];
    let origin: [number, number] | null = null;
    const h = heightM * WALL_OVERSHOOT;
    // The frame bus follows the raised unit's rim (sampled from the same cached
    // bases the walls stand on). A teardown, with no features, empties it.
    const rim = sampleRim(features);
    this.scopeId = String(features[0]?.properties?.id ?? "");
    this.heightM = features.length ? heightM : 0;
    this.rim = rim.pack;
    this.rimCount = rim.count;
    this.rimVersion++;
    // Per-vertex projections come from the per-geometry caches (PBase): both the
    // Mercator z and the experimental LngLat.toEcef are LINEAR in altitude, so a
    // cached ground point + per-metre delta reconstructs any height with a
    // multiply-add — no re-projection on rebuild.
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
            lidVerts.push(p.x - origin[0], p.y - origin[1], h * p.zPerM);
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
      verts: number[];
      gVerts: number[];
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
        grp = { width, alpha, raised, verts: [], gVerts: [] };
        lineGroupMap.set(key, grp);
      }
      // Globe line vertex: self + other endpoint (each merc + ECEF pair) + offset
      // side + GEOMETRIC side — 20 floats. `side` drives the screen-space offset
      // (its sign inverts at the B end, where the direction vector flips);
      // `geomSide` is the CONSISTENT left/right used by the feather varying —
      // reusing `side` there makes the feather cross zero mid-segment and hit ±1
      // at every join, which beads dense contours into near-invisibility.
      const pushGL = (p: PBase, o: PBase, side: number, geomSide: number) => {
        grp!.gVerts.push(p.x, p.y, alt * p.zPerM, p.lo[0], p.lo[1], p.lo[2]);
        grp!.gVerts.push(p.lo[0] + alt * p.d[0], p.lo[1] + alt * p.d[1], p.lo[2] + alt * p.d[2]);
        grp!.gVerts.push(o.x, o.y, alt * o.zPerM, o.lo[0], o.lo[1], o.lo[2]);
        grp!.gVerts.push(o.lo[0] + alt * o.d[0], o.lo[1] + alt * o.d[1], o.lo[2] + alt * o.d[2]);
        grp!.gVerts.push(side, geomSide);
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
            grp!.verts.push(ax, ay, az, bx, by, bz, +1, +1); // A+
            grp!.verts.push(bx, by, bz, ax, ay, az, -1, +1); // B+
            grp!.verts.push(bx, by, bz, ax, ay, az, +1, -1); // B-
            grp!.verts.push(ax, ay, az, bx, by, bz, +1, +1); // A+
            grp!.verts.push(bx, by, bz, ax, ay, az, +1, -1); // B-
            grp!.verts.push(ax, ay, az, bx, by, bz, -1, -1); // A-
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
    // they do (GeoNav: france-geojson for the country and its régions and
    // départements, a département raised as the union of its communes' Géo API
    // contours, those contours for villes and arrondissements), so it holds
    // them. Only a département whose own outline could not be had rises with
    // its france-geojson one, which a commune can cross by up to ~1 km. A child
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
    this.lineGroups = [];
    for (const grp of lineGroupMap.values()) {
      const count = grp.verts.length / 8;
      if (!count) continue;
      this.lineGroups.push({
        width: grp.width,
        alpha: grp.alpha,
        raised: grp.raised,
        start: lineVerts.length / 8,
        count,
      });
      for (const v of grp.verts) lineVerts.push(v);
      for (const v of grp.gVerts) gLine.push(v);
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
    this.fillRanges.clear();
    this.pendingFills.clear();
    this.fillOrigin = origin;
    this.hovPositions = new Float32Array(0);
    this.gHovPositions = new Float32Array(0);
    this.hovDirty = true;
    this.gHovDirty = true;
    // No plateau (world scope) → skip: the GL sweep only runs with a plateau up
    // (the draped scope-hover-fill is the fallback there), so the refined fill
    // meshes would be dead weight.
    if (origin && features.length) {
      const record = (f: OutlineFC["features"][number], altM: number, raised: boolean) => {
        const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
        if (!g?.type) return;
        this.pendingFills.set(String(f.properties?.id ?? ""), { g, altM, raised });
      };
      // Above the lid (h), below the lines — on the ground, a child left there.
      for (const f of focus) {
        if (lifted.has(f)) record(f, h * 1.001, true);
        else record(f, GROUND_ALT, false);
      }
      // Context siblings live at ground level, depth-tested like the ground
      // lines (their fill must hide behind the raised plateau too).
      for (const f of context) record(f, GROUND_ALT, false);
    }
    // fillRanges was just cleared, but hoveredFillId still points at the unit
    // under the cursor — the render pass would look up a range that no longer
    // exists and silently drop the highlight, with setHover/setHovered's
    // early-returns making it unrecoverable until the cursor left and re-entered.
    // Re-arm it (rebuilds the discarded mesh; skips nothing load-bearing).
    const stillHovered = this.hoveredFillId;
    if (stillHovered) {
      this.hoveredFillId = "";
      this.setHovered(stillHovered);
    }
    // Halo: a CONTINUOUS ribbon hugging the scope boundary — the ring is first
    // SIMPLIFIED to segments comparable to the band width (per-segment screen
    // quads on a jagged boundary read as separate spikes), then each kept vertex
    // is offset OUTWARD along its miter normal in GEO space (width ∝ unit size).
    // Inner edge d=0 sits at the wall base, outer edge d=1. Layouts match the
    // fill meshes ([pos, d]) so the programs stay simple. 12 m off the ground:
    // outside the plateau the DEM is flat 0, and the offset avoids drape z-fight.
    const haloVerts: number[] = []; // [x, y, z, d]
    const gHalo: number[] = []; // [merc3, lo3, hi3, d]
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
      this.haloW = features.length ? W : 0;
      this.haloCos = cosH;
      const pushHV = (b: PBase, d: number) =>
        pushHaloVert(haloVerts, gHalo, b, d, origin!, HALO_ALT);
      for (const f of features) {
        const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
        if (!g?.type) continue;
        for (const rings of ringBasesOf(g)) {
          for (const ringB of rings) buildHaloRing(ringB, W, cosH, pushHV);
        }
      }
    }
    this.haloPositions = new Float32Array(haloVerts);
    this.gHaloPositions = new Float32Array(gHalo);
    this.haloVertexCount = haloVerts.length / 4;
    this.haloDirty = true;
    this.gHaloDirty = true;

    this.positions = new Float32Array(verts);
    this.vertexCount = verts.length / 3;
    this.lidPositions = new Float32Array(lidVerts);
    this.lidVertexCount = lidVerts.length / 3;
    this.linePositions = new Float32Array(lineVerts);
    this.lineVertexCount = lineVerts.length / 8;
    this.gWallPositions = new Float32Array(gWall);
    this.gLidPositions = new Float32Array(gLid);
    this.gLinePositions = new Float32Array(gLine);
    this.origin = origin ?? [0, 0];
    this.dirty = true;
    this.lidDirty = true;
    this.lineDirty = true;
    this.gWallDirty = true;
    this.gLidDirty = true;
    this.gLineDirty = true;
    if (endSpan) {
      endSpan({
        walls: this.vertexCount,
        lid: this.lidVertexCount,
        lines: this.lineVertexCount,
        halo: this.haloVertexCount,
      });
    }
    this.map?.triggerRepaint();
  }

  /** Provide/replace the lid's map texture (a hidden-map snapshot). Uploaded on
   *  the next render. Passing null drops the lid (walls-only, the status quo). */
  setLidTexture(snap: Snapshot | null) {
    if (this.lidPending) {
      this.lidPending.bitmap.close();
      this.lidPending = null;
    }
    if (!snap) {
      this.lidMerc = null; // render skips the lid; old GL texture freed on next upload
      this.map?.triggerRepaint();
      return;
    }
    this.lidPending = snap;
    this.map?.triggerRepaint();
  }

  setScale(v: number) {
    this.scale = v;
    this.map?.triggerRepaint();
  }

  /**
   * Keep the camera this frame is drawn with, for the frame bus. Copied into
   * preallocated arrays: mapbox hands over fresh ones every frame
   * (customLayerMatrix() is a slice), and nothing here holds on to them.
   */
  private captureCamera(
    matrix: ArrayLike<number>,
    onGlobe: boolean,
    globeToMerc?: ArrayLike<number>,
    transition?: number,
    centre?: ArrayLike<number>,
    pxRatio?: number,
  ) {
    const cam = this.cam;
    for (let i = 0; i < 16; i++) cam.m[i] = matrix[i];
    cam.globe = onGlobe;
    if (onGlobe && globeToMerc && centre) {
      for (let i = 0; i < 16; i++) cam.g2m[i] = globeToMerc[i];
      cam.t = transition ?? 0;
      cam.cx = centre[0];
      cam.cy = centre[1];
      cam.r = pxRatio ?? 1;
    }
    cam.seq++;
  }

  /**
   * Project packed points (see STRIDE) at `altM` metres with the camera of the
   * last frame drawn, exactly as this layer's own vertex shaders place the
   * plateau: px into out[2i], out[2i + 1], validity into ok[i].
   *  - mercator (z ≥ 6): clip = M·[x, y, altM·zPerM, 1], as the wall program
   *    does once its origin fold is undone (float64 here: no fold needed).
   *  - globe (z < 6): GLOBE_PROJECT_GLSL's morphProject line for line — the
   *    sphere point M·G·[lo + altM·d, 1] / w, then, through z 5–6 (t > 0),
   *    mixed in NDC toward the mercator twin rescaled around the centre by the
   *    pixels-per-metre ratio. Both w ≤ 0 rejections are kept: such a vertex
   *    is clipped there, so it is not valid here.
   * Not map.project: in mercator it adds the terrain SAMPLED under the point
   * (double height inside the plateau, ~0 on the eroded rim, 0 where DEM tiles
   * are missing); on the globe, the centre's altitude.
   */
  projectInto(
    src: Float64Array,
    count: number,
    altM: number,
    w: number,
    h: number,
    out: Float32Array,
    ok: Uint8Array,
    /** The first point of `src` to project (the points before it skipped). */
    start = 0,
  ) {
    const { m, g2m: g, globe, t, cx, cy, r } = this.cam;
    const hw = w / 2;
    const hh = h / 2;
    for (let i = 0; i < count; i++) {
      const o = (start + i) * STRIDE;
      const x = src[o];
      const y = src[o + 1];
      const z = altM * src[o + 2];
      let nx: number;
      let ny: number;
      if (!globe) {
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (!(cw > 0)) {
          ok[i] = 0;
          continue;
        }
        nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
        ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      } else {
        // mix(ecefLo, ecefHi, uScale) = lo + (h·uScale)·d = lo + altM·d
        const ex = src[o + 3] + altM * src[o + 6];
        const ey = src[o + 4] + altM * src[o + 7];
        const ez = src[o + 5] + altM * src[o + 8];
        const gx = g[0] * ex + g[4] * ey + g[8] * ez + g[12];
        const gy = g[1] * ex + g[5] * ey + g[9] * ez + g[13];
        const gz = g[2] * ex + g[6] * ey + g[10] * ez + g[14];
        const gw = g[3] * ex + g[7] * ey + g[11] * ez + g[15];
        const pw = m[3] * gx + m[7] * gy + m[11] * gz + m[15] * gw;
        if (!(pw > 0)) {
          ok[i] = 0;
          continue;
        }
        nx = (m[0] * gx + m[4] * gy + m[8] * gz + m[12] * gw) / pw;
        ny = (m[1] * gx + m[5] * gy + m[9] * gz + m[13] * gw) / pw;
        if (t > 0) {
          // merc.z·uScale·uPxRatio, with merc.z = h·zPerM: altM·zPerM·r
          const mx = (x - cx) * r + cx;
          const my = (y - cy) * r + cy;
          const mz = z * r;
          const mw = m[3] * mx + m[7] * my + m[11] * mz + m[15];
          if (!(mw > 0)) {
            ok[i] = 0;
            continue;
          }
          nx += ((m[0] * mx + m[4] * my + m[8] * mz + m[12]) / mw - nx) * t;
          ny += ((m[1] * mx + m[5] * my + m[9] * mz + m[13]) / mw - ny) * t;
        }
      }
      out[2 * i] = (nx + 1) * hw;
      out[2 * i + 1] = (1 - ny) * hh;
      ok[i] = 1;
    }
  }

  onAdd(map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    // Ceiling for the lid snapshot: asking for a bitmap wider than this uploads
    // nothing and the plateau falls back to bare draped terrain.
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, WALL_VS);
    const fs = compile(gl.FRAGMENT_SHADER, WALL_FS);
    const p = gl.createProgram();
    if (!p || !vs || !fs) return;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    this.program = p;
    this.aPos = gl.getAttribLocation(p, "aPos");
    this.uMatrix = gl.getUniformLocation(p, "uMatrix");
    this.uScale = gl.getUniformLocation(p, "uScale");
    this.buffer = gl.createBuffer();
    // Lid program: UV derived from the vertex's mercator position (an affine map
    // into the snapshot's mercator rectangle) — no UV attribute needed, so
    // re-snapshots never touch the mesh. Fragments outside the snapshot discard
    // (the draped terrain below shows instead — still the map).
    const lvs = compile(gl.VERTEX_SHADER, LID_VS);
    const lfs = compile(gl.FRAGMENT_SHADER, LID_FS);
    const lp = gl.createProgram();
    if (lp && lvs && lfs) {
      gl.attachShader(lp, lvs);
      gl.attachShader(lp, lfs);
      gl.linkProgram(lp);
      this.lidProgram = lp;
      this.lidAPos = gl.getAttribLocation(lp, "aPos");
      this.lidUMatrix = gl.getUniformLocation(lp, "uMatrix");
      this.lidUScale = gl.getUniformLocation(lp, "uScale");
      this.lidUTexOrigin = gl.getUniformLocation(lp, "uTexOrigin");
      this.lidUTexSpan = gl.getUniformLocation(lp, "uTexSpan");
      this.lidBuffer = gl.createBuffer();
    }
    // Line program: perpendicular extrusion in screen space → constant pixel width
    // at any zoom (what a Mapbox line layer does, but at the lid's height). The
    // quad is 1 px wider each side and the fragment alpha feathers over that
    // pixel (vSide interpolates -1…1 across the width) — analytic anti-aliasing,
    // since hard quad edges alias badly on dense commune contours.
    const nvs = compile(gl.VERTEX_SHADER, LINE_VS);
    const nfs = compile(gl.FRAGMENT_SHADER, LINE_FS);
    const np = gl.createProgram();
    if (np && nvs && nfs) {
      gl.attachShader(np, nvs);
      gl.attachShader(np, nfs);
      gl.linkProgram(np);
      this.lineProgram = np;
      this.lineAPos = gl.getAttribLocation(np, "aPos");
      this.lineAOther = gl.getAttribLocation(np, "aOther");
      this.lineASide = gl.getAttribLocation(np, "aSide");
      this.lineAGeomSide = gl.getAttribLocation(np, "aGeomSide");
      this.lineUMatrix = gl.getUniformLocation(np, "uMatrix");
      this.lineUScale = gl.getUniformLocation(np, "uScale");
      this.lineUViewport = gl.getUniformLocation(np, "uViewport");
      this.lineUWidth = gl.getUniformLocation(np, "uWidth");
      this.lineUAlpha = gl.getUniformLocation(np, "uAlpha");
      this.lineBuffer = gl.createBuffer();
    }
    // ---- globe-regime programs (zoom < 6): the same three passes, positions
    // morph-projected between the sphere (ECEF) and mercator by the transition ----
    this.gWallProg = buildProgram(
      gl,
      G_WALL_VS,
      WALL_FS,
      ["aMerc", "aEcefLo", "aEcefHi"],
      GLOBE_UNIS,
    );
    this.gLidProg = buildProgram(
      gl,
      G_LID_VS,
      LID_FS,
      ["aMerc", "aEcefLo", "aEcefHi"],
      [...GLOBE_UNIS, "uTexOrigin", "uTexSpan"],
    );
    this.gLineProg = buildProgram(
      gl,
      G_LINE_VS,
      LINE_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aOMerc", "aOEcefLo", "aOEcefHi", "aSide", "aGeomSide"],
      [...GLOBE_UNIS, "uViewport", "uWidth", "uAlpha"],
    );
    this.gWallBuffer = gl.createBuffer();
    this.gLidBuffer = gl.createBuffer();
    this.gLineBuffer = gl.createBuffer();
    // Hover-fill programs: OPAQUE boundary-violet, swept inward — each vertex
    // carries its normalized distance to the unit's boundary and uFillT animates
    // the filled band from the edge (d = 0) toward the centre (d = 1).
    this.fillProg = buildProgram(
      gl,
      FILL_VS,
      FILL_FS,
      ["aPos", "aDist"],
      ["uMatrix", "uScale", "uFillT"],
    );
    this.gFillProg = buildProgram(
      gl,
      G_FILL_VS,
      FILL_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aDist"],
      [...GLOBE_UNIS, "uFillT"],
    );
    this.hovBuffer = gl.createBuffer();
    this.gHovBuffer = gl.createBuffer();
    this.retractBuffer = gl.createBuffer();
    this.gRetractBuffer = gl.createBuffer();
    // Halo programs: a static glow ribbon fading outward from the wall base (no
    // time uniform, no self-scheduled repaint).
    this.haloProg = buildProgram(gl, HALO_VS, HALO_FS, ["aPos", "aDist"], ["uMatrix", "uScale"]);
    this.gHaloProg = buildProgram(
      gl,
      G_HALO_VS,
      HALO_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aDist"],
      GLOBE_UNIS,
    );
    this.haloBuffer = gl.createBuffer();
    this.gHaloBuffer = gl.createBuffer();
    // The slabs' pieces: each vertex in its colour — the ring's parts and the
    // bar their theme's, the words' boxes' walls the plateau's violet —, or
    // the one colour uTint gives where its alpha is 1 (the words' boxes'
    // lids, opaque: the site's card). Straight to the framebuffer, opaque:
    // premultiplied or not, the same.
    this.slabPieceProg = buildProgram(
      gl,
      PIECE_VS,
      PIECE_FS,
      ["aPos", "aColor"],
      ["uMatrix", "uScale", "uTint"],
    );
    this.gSlabPieceProg = buildProgram(
      gl,
      G_PIECE_VS,
      PIECE_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aColor"],
      [...GLOBE_UNIS, "uTint"],
    );
    this.slabWallBuf = gl.createBuffer();
    this.slabLidBuf = gl.createBuffer();
    this.slabHaloBuf = gl.createBuffer();
    this.gSlabWallBuf = gl.createBuffer();
    this.gSlabLidBuf = gl.createBuffer();
    this.gSlabHaloBuf = gl.createBuffer();
    // A fresh context knows nothing of the slabs built before it.
    this.slabDirty = true;
    this.gSlabDirty = true;
  }

  onRemove(_map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.lidProgram) gl.deleteProgram(this.lidProgram);
    if (this.lidBuffer) gl.deleteBuffer(this.lidBuffer);
    if (this.lidTexture) gl.deleteTexture(this.lidTexture);
    if (this.lidPending) this.lidPending.bitmap.close();
    if (this.lineProgram) gl.deleteProgram(this.lineProgram);
    if (this.lineBuffer) gl.deleteBuffer(this.lineBuffer);
    for (const p of [
      this.gWallProg,
      this.gLidProg,
      this.gLineProg,
      this.fillProg,
      this.gFillProg,
      this.haloProg,
      this.gHaloProg,
      this.slabPieceProg,
      this.gSlabPieceProg,
    ]) {
      if (p) gl.deleteProgram(p.prog);
    }
    for (const b of [
      this.gWallBuffer,
      this.gLidBuffer,
      this.gLineBuffer,
      this.hovBuffer,
      this.gHovBuffer,
      this.retractBuffer,
      this.gRetractBuffer,
      this.haloBuffer,
      this.gHaloBuffer,
      this.slabWallBuf,
      this.slabLidBuf,
      this.slabHaloBuf,
      this.gSlabWallBuf,
      this.gSlabLidBuf,
      this.gSlabHaloBuf,
    ]) {
      if (b) gl.deleteBuffer(b);
    }
    this.slabPieceProg = null;
    this.gSlabPieceProg = null;
    this.slabWallBuf = null;
    this.slabLidBuf = null;
    this.slabHaloBuf = null;
    this.gSlabWallBuf = null;
    this.gSlabLidBuf = null;
    this.gSlabHaloBuf = null;
    this.program = null;
    this.buffer = null;
    this.lidProgram = null;
    this.lidBuffer = null;
    this.lidTexture = null;
    this.lidPending = null;
    this.lidMerc = null;
    this.lineProgram = null;
    this.lineBuffer = null;
    this.gWallProg = null;
    this.gLidProg = null;
    this.gLineProg = null;
    this.gWallBuffer = null;
    this.gLidBuffer = null;
    this.gLineBuffer = null;
    this.fillProg = null;
    this.gFillProg = null;
    this.hovBuffer = null;
    this.gHovBuffer = null;
    this.retractBuffer = null;
    this.gRetractBuffer = null;
    this.haloProg = null;
    this.gHaloProg = null;
    this.haloBuffer = null;
    this.gHaloBuffer = null;
    this.retractActive = false;
    this.map = null;
  }

  render(
    gl: WebGL2RenderingContext,
    matrix: number[],
    projection?: unknown,
    globeToMercMatrix?: number[],
    transition?: number,
    centerInMercator?: number[],
    pixelsPerMeterRatio?: number,
  ) {
    // GLOBE regime (zoom < 6): mapbox passes the extra projection args and the
    // camera is the globe camera — draw via the morph programs. At z ≥ 6 it calls
    // with 2 args (pure mercator pipeline) and the classic path below runs.
    const onGlobe = globeFrame(
      projection,
      globeToMercMatrix,
      transition,
      centerInMercator,
      pixelsPerMeterRatio,
    );
    // Kept on EVERY frame, before anything can bail out below: the frame bus
    // projects with it whether or not there is anything to draw.
    this.captureCamera(
      matrix,
      onGlobe,
      globeToMercMatrix,
      transition,
      centerInMercator,
      pixelsPerMeterRatio,
    );
    // Boundary lines render even with no plateau standing (world scope / sunk),
    // so only bail when there is nothing at all to draw.
    if ((!this.vertexCount || this.scale <= 0.001) && !this.lineVertexCount) return;
    // Upload a freshly captured snapshot (bitmap → texture) whichever regime draws.
    if (this.lidPending) {
      const snap = this.lidPending;
      this.lidPending = null;
      // Reuse the texture object: deleting one the driver may still be sampling
      // forces a sync, and texImage2D fully re-specs (a different size is fine),
      // so there is nothing to gain from a fresh name. The lid is now re-captured
      // on zoom, making this a repeated cost rather than a one-off.
      const tex = this.lidTexture ?? gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // row 0 = north = min mercator y
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap.bitmap);
      // The lid is a texture on a plane the camera looks ALONG at ELEV_PITCH, so
      // its far half is minified and its near half magnified. A plain LINEAR
      // min-filter takes a single bilinear tap per fragment, which drops detail
      // and shimmers across the far half — while the live basemap beside it
      // stays crisp, because mapbox mipmaps its own rasters. Hence trilinear,
      // plus anisotropy: that is what recovers the foreshortened axis, which
      // mipmapping ALONE would blur away (it picks a LOD for the worse axis).
      // WebGL2 (mapbox-gl v3 requires it), so NPOT mipmaps are legal.
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.maxAniso === 0) {
        const ext = gl.getExtension("EXT_texture_filter_anisotropic");
        this.anisoExt = ext;
        this.maxAniso = ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : -1;
      }
      if (this.anisoExt && this.maxAniso > 1) {
        gl.texParameterf(
          gl.TEXTURE_2D,
          this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, this.maxAniso),
        );
      }
      this.lidTexture = tex;
      this.lidMerc = snap.merc;
      snap.bitmap.close();
    }
    gl.disable(gl.CULL_FACE); // wall sheet is double-sided; lid winding is mixed
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    if (import.meta.env.DEV) {
      const regime = onGlobe ? `globe(t=${transition?.toFixed(2)})` : "mercator";
      if (this.lastRegimeLog !== regime) {
        this.lastRegimeLog = regime;
        console.info(
          `[plateau] render ${regime} verts=${this.vertexCount} lid=${this.lidVertexCount} ` +
            `lines=${this.lineVertexCount} scale=${this.scale.toFixed(2)} ` +
            `progs=${[!!this.gWallProg, !!this.gLidProg, !!this.gLineProg].join(",")}`,
        );
      }
    }
    if (onGlobe) {
      this.renderGlobe(
        gl,
        matrix,
        globeToMercMatrix!,
        transition!,
        centerInMercator!,
        pixelsPerMeterRatio!,
      );
      return;
    }
    if (!this.program || !this.buffer) return;
    // Fold the mesh origin into the (float64) matrix so float32 vertices keep
    // sub-metre precision: M' = M × T(origin).
    const m = matrix;
    const [tx, ty] = this.origin;
    const t = m.slice();
    t[12] = m[0] * tx + m[4] * ty + m[12];
    t[13] = m[1] * tx + m[5] * ty + m[13];
    t[14] = m[2] * tx + m[6] * ty + m[14];
    t[15] = m[3] * tx + m[7] * ty + m[15];
    const mat = new Float32Array(t);

    gl.disable(gl.CULL_FACE); // wall sheet is double-sided; lid winding is mixed
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // ---- lid DEPTH pre-pass ----
    // The plateau top must own the depth buffer BEFORE the walls draw. The far
    // wall's inner face lives underneath the lid, so it is only ever hidden by
    // something nearer — and the textured lid below cannot be relied on for
    // that: it is skipped when no snapshot has landed yet, and it DISCARDS
    // wherever the texture doesn't reach (after a scope change the texture
    // still covers the PREVIOUS unit until the new capture lands ~1 s later).
    // In that window the wall showed straight through the plateau top. Colour
    // writes are off — this contributes depth only, so the visible surface is
    // still the textured lid, or the draped terrain where it discards.
    if (this.program && this.lidBuffer && this.lidVertexCount && this.scale >= 0.15) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lidBuffer);
      if (this.lidDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.lidPositions, gl.STATIC_DRAW);
        this.lidDirty = false;
      }
      gl.uniformMatrix4fv(this.uMatrix, false, mat);
      gl.uniform1f(this.uScale, this.scale);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 12, 0);
      gl.colorMask(false, false, false, false);
      gl.drawArrays(gl.TRIANGLES, 0, this.lidVertexCount);
      gl.colorMask(true, true, true, true);
    }

    // ---- walls ----
    if (this.vertexCount && this.scale > 0.001) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      if (this.dirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
        this.dirty = false;
      }
      gl.uniformMatrix4fv(this.uMatrix, false, mat);
      gl.uniform1f(this.uScale, this.scale);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 12, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }

    // ---- lid (map-textured top) ----
    // Skip while no texture, or during the first rise frames (lid/terrain
    // separation collapses toward 0 → depth shimmer).
    if (
      this.lidProgram &&
      this.lidBuffer &&
      this.lidVertexCount &&
      this.lidTexture &&
      this.lidMerc &&
      this.scale >= 0.15
    ) {
      gl.useProgram(this.lidProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lidBuffer);
      if (this.lidDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.lidPositions, gl.STATIC_DRAW);
        this.lidDirty = false;
      }
      gl.uniformMatrix4fv(this.lidUMatrix, false, mat);
      gl.uniform1f(this.lidUScale, this.scale);
      // UV affine: positions are origin-relative, so shift the texture origin too.
      gl.uniform2f(
        this.lidUTexOrigin,
        this.lidMerc.minX - this.origin[0],
        this.lidMerc.minY - this.origin[1],
      );
      gl.uniform2f(this.lidUTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
      gl.enableVertexAttribArray(this.lidAPos);
      gl.vertexAttribPointer(this.lidAPos, 3, gl.FLOAT, false, 12, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.lidVertexCount);
    }

    // ---- the analyses' slabs: their lids, then their walls (depth written:
    // the ground lines and glows drawn after hide behind them, and blend over
    // their feet). Glass, the words' boxes go after those (below): what lies
    // under a glass is seen through it, the lines as the map's labels. Drawn
    // again over the map's labels: renderSlabs ----
    const ss = this.scale * this.slabP;
    const slabs = this.slabWallCount > 0 && ss > 0.001;
    const glass = this.slabLid === "verre";
    if (slabs) {
      this.uploadSlabsMercator(gl);
      foldOrigin(matrix, this.slabOrigin[0], this.slabOrigin[1], this.slabMat);
      this.drawSlabsMercator(gl, this.slabMat, ss, glass ? "parts" : "all");
    }

    // ---- hovered-zone fill (opaque violet, swept boundary → centre) ----
    // RAISED (focus) fills float 0.1%·h above the lid and draw with depth OFF:
    // depth precision during zooms let the lid speckle through, and painter's
    // order already guarantees correctness (lid drew before, lines draw after).
    // GROUND (context) fills KEEP the depth test — that is what hides the parts
    // running behind the raised plateau (the terrain wrote nearer depth).
    const hovRange = this.hoveredFillId ? this.fillRanges.get(this.hoveredFillId) : undefined;
    if (this.fillProg && this.hovBuffer && hovRange && this.scale >= 0.15) {
      if (hovRange.raised) gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.fillProg.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hovBuffer);
      if (this.hovDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.hovPositions, gl.STATIC_DRAW);
        this.hovDirty = false;
      }
      gl.uniformMatrix4fv(this.fillProg.uni.uMatrix, false, mat);
      gl.uniform1f(this.fillProg.uni.uScale, hovRange.raised ? this.scale : 1);
      gl.uniform1f(this.fillProg.uni.uFillT, this.fillSweepT());
      gl.enableVertexAttribArray(this.fillProg.attr.aPos);
      gl.vertexAttribPointer(this.fillProg.attr.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this.fillProg.attr.aDist);
      gl.vertexAttribPointer(this.fillProg.attr.aDist, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.TRIANGLES, hovRange.start, hovRange.count);
      gl.enable(gl.DEPTH_TEST);
    }
    // ---- selection retract (the snapshotted fill draining centre → boundary) ----
    if (this.fillProg && this.retractBuffer && this.retractActive && this.retractPositions.length) {
      if (this.retractRaised) gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.fillProg.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.retractBuffer);
      if (this.retractDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.retractPositions, gl.STATIC_DRAW);
        this.retractDirty = false;
      }
      gl.uniformMatrix4fv(this.fillProg.uni.uMatrix, false, mat);
      gl.uniform1f(this.fillProg.uni.uScale, this.retractRaised ? this.scale : 1);
      gl.uniform1f(this.fillProg.uni.uFillT, this.retractT());
      gl.enableVertexAttribArray(this.fillProg.attr.aPos);
      gl.vertexAttribPointer(this.fillProg.attr.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this.fillProg.attr.aDist);
      gl.vertexAttribPointer(this.fillProg.attr.aDist, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.TRIANGLES, 0, this.retractPositions.length / 4);
      gl.enable(gl.DEPTH_TEST);
    }

    // ---- boundary lines (constant screen width; focus on the lid, context and
    // the world-scope outline on the ground) ----
    // The ONLY line renderer now (no draped layer), so no scale gate: focus
    // lines ride the rise with uScale, ground groups pin uScale to 1. Depth is
    // per group: GROUND lines keep the test — the raised terrain wrote nearer
    // depth, which is what hides the parts running behind the plateau (12 m of
    // altitude keeps them clear of ties with the flat surface they sit on) —
    // while RAISED lines sit on top of everything and draw with it off (their
    // 0.2%·h lid clearance speckles under zoom depth precision).
    if (this.lineProgram && this.lineBuffer && this.lineVertexCount) {
      gl.useProgram(this.lineProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      if (this.lineDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.linePositions, gl.STATIC_DRAW);
        this.lineDirty = false;
      }
      gl.uniformMatrix4fv(this.lineUMatrix, false, mat);
      gl.uniform2f(this.lineUViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.enableVertexAttribArray(this.lineAPos);
      gl.vertexAttribPointer(this.lineAPos, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(this.lineAOther);
      gl.vertexAttribPointer(this.lineAOther, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(this.lineASide);
      gl.vertexAttribPointer(this.lineASide, 1, gl.FLOAT, false, 32, 24);
      gl.enableVertexAttribArray(this.lineAGeomSide);
      gl.vertexAttribPointer(this.lineAGeomSide, 1, gl.FLOAT, false, 32, 28);
      const dpr = window.devicePixelRatio || 1;
      for (const grp of this.lineGroups) {
        if (grp.raised) gl.disable(gl.DEPTH_TEST);
        else gl.enable(gl.DEPTH_TEST);
        gl.uniform1f(this.lineUScale, grp.raised ? this.scale : 1);
        gl.uniform1f(this.lineUWidth, grp.width * dpr);
        gl.uniform1f(this.lineUAlpha, grp.alpha);
        gl.drawArrays(gl.TRIANGLES, grp.start, grp.count);
      }
      gl.enable(gl.DEPTH_TEST);
    }

    // ---- halo (static ribbon from the wall base outward) ----
    if (this.haloProg && this.haloBuffer && this.haloVertexCount && this.scale >= 0.15) {
      const p = this.haloProg;
      gl.useProgram(p.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.haloBuffer);
      if (this.haloDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.haloPositions, gl.STATIC_DRAW);
        this.haloDirty = false;
      }
      gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
      gl.uniform1f(p.uni.uScale, this.scale);
      gl.enableVertexAttribArray(p.attr.aPos);
      gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(p.attr.aDist);
      gl.vertexAttribPointer(p.attr.aDist, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.TRIANGLES, 0, this.haloVertexCount);
    }
    // ---- the words' glass boxes (their lids' depth, their walls), then the
    // slabs' glow, the plateau's ----
    if (slabs) {
      if (glass) this.drawSlabsMercator(gl, this.slabMat, ss, "boxes");
      this.drawSlabHaloMercator(gl, this.slabMat, ss);
    }
  }

  /**
   * The slabs, for their own layer (slabLayer): after the plateau's whole draw
   * and the map's labels. Mercator: their walls and opaque lids again, over
   * the labels — the plateau's draw (render) has them under the labels and,
   * but for the glass boxes, under its ground passes.
   */
  private renderSlabs(
    gl: WebGL2RenderingContext,
    matrix: number[],
    projection?: unknown,
    globeToMercMatrix?: number[],
    transition?: number,
    centerInMercator?: number[],
    pixelsPerMeterRatio?: number,
  ) {
    const ss = this.scale * this.slabP;
    if (!this.slabWallCount || ss <= 0.001) return;
    gl.disable(gl.CULL_FACE); // wall sheet is double-sided; lid winding is mixed
    if (
      globeFrame(projection, globeToMercMatrix, transition, centerInMercator, pixelsPerMeterRatio)
    ) {
      this.drawSlabsGlobe(
        gl,
        matrix,
        globeToMercMatrix!,
        transition!,
        centerInMercator!,
        pixelsPerMeterRatio!,
        ss,
      );
      return;
    }
    // mapbox leaves a "2d" layer's depth test off, but its buffer still holds
    // the terrain's and the plateau's: nothing clears it between their draw
    // and this one, and the labels drawn in between only read it. Tested
    // against it in the "3d" layers' own range, a slab is hidden wherever the
    // raised plateau stands in front of it.
    const range = (this.map as unknown as MapPainterInternals | null)?.painter?.depthRangeFor3D;
    if (range) gl.depthRange(range[0], range[1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    // The same triangles with the same matrix as in render: each lands on the
    // depth it wrote there, and passes (LEQUAL) wherever its slab is still the
    // nearest — over the labels. Where the plateau's ground passes or the
    // slabs' glow blended over a foot since, they wrote nearer: kept as drawn.
    this.uploadSlabsMercator(gl);
    const mat = foldOrigin(matrix, this.slabOrigin[0], this.slabOrigin[1], this.slabMat);
    this.drawSlabsMercator(gl, mat, ss, "over");
  }

  /** The slabs' meshes into their buffers (mercator), once after a rebuild. */
  private uploadSlabsMercator(gl: WebGL2RenderingContext) {
    if (!this.slabDirty) return;
    const up = (buf: WebGLBuffer | null, data: Float32Array) => {
      if (!buf) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    };
    up(this.slabWallBuf, this.slabWallPos);
    up(this.slabLidBuf, this.slabLidPos);
    up(this.slabHaloBuf, this.slabHaloPos);
    this.slabDirty = false;
  }

  /**
   * The slabs (mercator), at rise `ss`; `mat`: the frame's, their origin folded
   * in. Their lids first: the ring's parts' and the bar's in their colours;
   * the words' boxes' as SlabSpec.lid has them — glass in depth only (the far
   * wall's inner face stays hidden behind it, the map is seen: the overlay
   * lays a glass of its own there), opaque in the card's colour, "Carte" the
   * raised map's snapshot over it (LEQUAL: the same triangles). Then their
   * walls. `pass`: "all" of them; the ring's parts and the bar alone
   * ("parts"), or the words' boxes ("boxes"); "over", all drawn again over the
   * map's labels (renderSlabs) — but for a glass lid, whose depth stands
   * already, and under which the labels are to be seen.
   */
  private drawSlabsMercator(
    gl: WebGL2RenderingContext,
    mat: Float32Array,
    ss: number,
    pass: SlabPass,
  ) {
    const p = this.slabPieceProg;
    if (!p) return;
    const parts = pass !== "boxes";
    const words = pass !== "parts";
    if (ss >= 0.05 && this.slabLidCount) {
      this.usePieces(gl, p, this.slabLidBuf, mat, ss);
      if (parts && this.slabPartLidCount) gl.drawArrays(gl.TRIANGLES, 0, this.slabPartLidCount);
      const first = this.slabPartLidCount;
      const boxes = words ? this.slabLidCount - first : 0;
      if (boxes && this.slabLid === "verre") {
        if (pass !== "over") {
          gl.colorMask(false, false, false, false);
          gl.drawArrays(gl.TRIANGLES, first, boxes);
          gl.colorMask(true, true, true, true);
        }
      } else if (boxes) {
        const [r, g, b] = this.slabColor;
        gl.uniform4f(p.uni.uTint, r, g, b, 1);
        gl.drawArrays(gl.TRIANGLES, first, boxes);
        if (this.slabLid === "carte" && this.lidProgram && this.lidTexture && this.lidMerc) {
          gl.useProgram(this.lidProgram);
          gl.uniformMatrix4fv(this.lidUMatrix, false, mat);
          gl.uniform1f(this.lidUScale, ss);
          gl.uniform2f(
            this.lidUTexOrigin,
            this.lidMerc.minX - this.slabOrigin[0],
            this.lidMerc.minY - this.slabOrigin[1],
          );
          gl.uniform2f(this.lidUTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.slabLidBuf);
          gl.enableVertexAttribArray(this.lidAPos);
          gl.vertexAttribPointer(this.lidAPos, 3, gl.FLOAT, false, 24, 0);
          gl.drawArrays(gl.TRIANGLES, first, boxes);
        }
      }
    }
    const from = parts ? 0 : this.slabPartWallCount;
    const to = words ? this.slabWallCount : this.slabPartWallCount;
    this.usePieces(gl, p, this.slabWallBuf, mat, ss);
    gl.drawArrays(gl.TRIANGLES, from, to - from);
  }

  /** The pieces' program (mercator) on buffer `buf`, coloured per vertex. */
  private usePieces(
    gl: WebGL2RenderingContext,
    p: GlProg,
    buf: WebGLBuffer | null,
    mat: Float32Array,
    ss: number,
  ) {
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
    gl.uniform1f(p.uni.uScale, ss);
    gl.uniform4f(p.uni.uTint, 0, 0, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(p.attr.aPos);
    gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(p.attr.aColor);
    gl.vertexAttribPointer(p.attr.aColor, 3, gl.FLOAT, false, 24, 12);
  }

  private drawSlabHaloMercator(gl: WebGL2RenderingContext, mat: Float32Array, ss: number) {
    const p = this.haloProg;
    if (ss < 0.15 || !p || !this.slabHaloCount) return;
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.slabHaloBuf);
    gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
    gl.uniform1f(p.uni.uScale, ss);
    gl.enableVertexAttribArray(p.attr.aPos);
    gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(p.attr.aDist);
    gl.vertexAttribPointer(p.attr.aDist, 1, gl.FLOAT, false, 16, 12);
    gl.drawArrays(gl.TRIANGLES, 0, this.slabHaloCount);
  }

  /** The globe-regime draw: same three passes, positions morphed sphere↔mercator
   *  in-shader. Attributes are ABSOLUTE (no origin fold — float32 is plenty below
   *  z6, where a pixel is kilometres). */
  private renderGlobe(
    gl: WebGL2RenderingContext,
    matrix: number[],
    globeToMerc: number[],
    t: number,
    center: number[],
    pxRatio: number,
  ) {
    // NO depth test on the globe: mapbox draws the sphere/terrain through an
    // infinite-far projection while custom layers get the finite-far matrix — the
    // depth values aren't comparable and the mismatch (~1e-3) dwarfs the plateau's
    // separation, so LEQUAL rejects every fragment (verified live: geometry
    // appears the instant the test is off). Painter's order handles our own
    // occlusion (walls → lid → lines), and a France-scoped plateau is always on
    // the camera-facing side of the sphere.
    gl.disable(gl.DEPTH_TEST);
    const { setCommon, bindTriple } = this.globeBinders(
      gl,
      matrix,
      globeToMerc,
      t,
      center,
      pxRatio,
    );
    // The plateau's depth can't be tested against (see above), so GROUND-level
    // geometry (context fills/lines, the world-scope outline) draws FIRST and
    // the plateau (walls + lid) paints OVER it — that is what keeps neighbour
    // boundaries from leaking onto the raised top. RAISED geometry follows the
    // lid. The draw closures are shared between the two passes.
    const hovRange = this.hoveredFillId ? this.fillRanges.get(this.hoveredFillId) : undefined;
    const drawHoverFill = () => {
      if (!this.gFillProg || !this.gHovBuffer || !hovRange || this.scale < 0.15) return;
      setCommon(this.gFillProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gHovBuffer);
      if (this.gHovDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gHovPositions, gl.STATIC_DRAW);
        this.gHovDirty = false;
      }
      gl.uniform1f(this.gFillProg.uni.uFillT, this.fillSweepT());
      if (!hovRange.raised) gl.uniform1f(this.gFillProg.uni.uScale, 1);
      bindTriple(this.gFillProg, 40);
      gl.enableVertexAttribArray(this.gFillProg.attr.aDist);
      gl.vertexAttribPointer(this.gFillProg.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.drawArrays(gl.TRIANGLES, hovRange.start, hovRange.count);
    };
    const drawRetract = () => {
      if (!this.gFillProg || !this.gRetractBuffer || !this.gRetractPositions.length) return;
      setCommon(this.gFillProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gRetractBuffer);
      if (this.gRetractDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gRetractPositions, gl.STATIC_DRAW);
        this.gRetractDirty = false;
      }
      gl.uniform1f(this.gFillProg.uni.uFillT, this.retractT());
      if (!this.retractRaised) gl.uniform1f(this.gFillProg.uni.uScale, 1);
      bindTriple(this.gFillProg, 40);
      gl.enableVertexAttribArray(this.gFillProg.attr.aDist);
      gl.vertexAttribPointer(this.gFillProg.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.gRetractPositions.length / 10);
    };
    // Boundary lines: no scale gate — this is the only line renderer. Ground
    // groups pin uScale to 1 (their altitude is absolute; with lo == hi the
    // ECEF mix is inert).
    const drawLines = (raised: boolean) => {
      if (!this.gLineProg || !this.gLineBuffer || !this.lineVertexCount) return;
      // drawLines is called once for raised and once for ground. At world scope
      // no group is raised, so one of the two passes set up ~25 GL calls (program
      // bind, 8 attribute pointers, uniforms) and then drew nothing.
      if (!this.lineGroups.some((g) => g.raised === raised)) return;
      setCommon(this.gLineProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gLineBuffer);
      if (this.gLineDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gLinePositions, gl.STATIC_DRAW);
        this.gLineDirty = false;
      }
      const p = this.gLineProg;
      bindTriple(p, 80);
      gl.enableVertexAttribArray(p.attr.aOMerc);
      gl.vertexAttribPointer(p.attr.aOMerc, 3, gl.FLOAT, false, 80, 36);
      gl.enableVertexAttribArray(p.attr.aOEcefLo);
      gl.vertexAttribPointer(p.attr.aOEcefLo, 3, gl.FLOAT, false, 80, 48);
      gl.enableVertexAttribArray(p.attr.aOEcefHi);
      gl.vertexAttribPointer(p.attr.aOEcefHi, 3, gl.FLOAT, false, 80, 60);
      gl.enableVertexAttribArray(p.attr.aSide);
      gl.vertexAttribPointer(p.attr.aSide, 1, gl.FLOAT, false, 80, 72);
      gl.enableVertexAttribArray(p.attr.aGeomSide);
      gl.vertexAttribPointer(p.attr.aGeomSide, 1, gl.FLOAT, false, 80, 76);
      gl.uniform2f(p.uni.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      const dpr = window.devicePixelRatio || 1;
      for (const grp of this.lineGroups) {
        if (grp.raised !== raised) continue;
        gl.uniform1f(p.uni.uScale, grp.raised ? this.scale : 1);
        gl.uniform1f(p.uni.uWidth, grp.width * dpr);
        gl.uniform1f(p.uni.uAlpha, grp.alpha);
        gl.drawArrays(gl.TRIANGLES, grp.start, grp.count);
      }
    };
    // ---- GROUND pass (hidden behind the plateau by paint order) ----
    if (hovRange && !hovRange.raised) drawHoverFill();
    if (this.retractActive && !this.retractRaised) drawRetract();
    drawLines(false);
    // ---- walls ----
    if (this.gWallProg && this.gWallBuffer && this.vertexCount) {
      setCommon(this.gWallProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gWallBuffer);
      if (this.gWallDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gWallPositions, gl.STATIC_DRAW);
        this.gWallDirty = false;
      }
      bindTriple(this.gWallProg, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }
    // ---- lid ----
    if (
      this.gLidProg &&
      this.gLidBuffer &&
      this.lidVertexCount &&
      this.lidTexture &&
      this.lidMerc &&
      this.scale >= 0.15
    ) {
      setCommon(this.gLidProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gLidBuffer);
      if (this.gLidDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gLidPositions, gl.STATIC_DRAW);
        this.gLidDirty = false;
      }
      // Globe attrs are ABSOLUTE mercator → unshifted texture origin.
      gl.uniform2f(this.gLidProg.uni.uTexOrigin, this.lidMerc.minX, this.lidMerc.minY);
      gl.uniform2f(this.gLidProg.uni.uTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
      bindTriple(this.gLidProg, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.lidVertexCount);
    }
    // ---- RAISED pass (on the plateau top) ----
    if (hovRange && hovRange.raised) drawHoverFill();
    if (this.retractActive && this.retractRaised) drawRetract();
    drawLines(true);

    // ---- halo (static ribbon from the wall base outward) ----
    if (this.gHaloProg && this.gHaloBuffer && this.haloVertexCount && this.scale >= 0.15) {
      const hp = this.gHaloProg;
      setCommon(hp);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gHaloBuffer);
      if (this.gHaloDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.gHaloPositions, gl.STATIC_DRAW);
        this.gHaloDirty = false;
      }
      bindTriple(hp, 40);
      gl.enableVertexAttribArray(hp.attr.aDist);
      gl.vertexAttribPointer(hp.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.haloVertexCount);
    }
  }

  /** The globe programs' setup for a frame: `setCommon(p)` binds program p
   *  with the frame's camera and the plateau's rise (uScale), `bindTriple(p,
   *  stride)` its mercator + ECEF attributes. */
  private globeBinders(
    gl: WebGL2RenderingContext,
    matrix: number[],
    globeToMerc: number[],
    t: number,
    center: number[],
    pxRatio: number,
  ) {
    const proj = new Float32Array(matrix);
    const g2m = new Float32Array(globeToMerc);
    const setCommon = (p: GlProg) => {
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.uni.uProj, false, proj);
      gl.uniformMatrix4fv(p.uni.uGlobeToMerc, false, g2m);
      gl.uniform1f(p.uni.uT, t);
      gl.uniform2f(p.uni.uCenterMerc, center[0], center[1]);
      gl.uniform1f(p.uni.uPxRatio, pxRatio);
      gl.uniform1f(p.uni.uScale, this.scale);
    };
    const bindTriple = (p: GlProg, stride: number) => {
      gl.enableVertexAttribArray(p.attr.aMerc);
      gl.vertexAttribPointer(p.attr.aMerc, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(p.attr.aEcefLo);
      gl.vertexAttribPointer(p.attr.aEcefLo, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(p.attr.aEcefHi);
      gl.vertexAttribPointer(p.attr.aEcefHi, 3, gl.FLOAT, false, stride, 24);
    };
    return { setCommon, bindTriple };
  }

  /** The slabs on the globe, at rise `ss`: no depth test there (see
   *  renderGlobe) — painter's order, their glow, walls, lids. Drawn after
   *  everything of the plateau (their layer comes after its), which they never
   *  stand in front of: at globe zooms a slab's wall stands a few px at most,
   *  short of the gap between it and the plateau. A glass lid is not drawn:
   *  with no depth to hide them, the walls' inner faces would show under the
   *  glass — the glass boxes' walls are culled to their outer faces. */
  private drawSlabsGlobe(
    gl: WebGL2RenderingContext,
    matrix: number[],
    globeToMerc: number[],
    t: number,
    center: number[],
    pxRatio: number,
    ss: number,
  ) {
    gl.disable(gl.DEPTH_TEST);
    const { setCommon, bindTriple } = this.globeBinders(
      gl,
      matrix,
      globeToMerc,
      t,
      center,
      pxRatio,
    );
    if (this.gSlabDirty) {
      const up = (buf: WebGLBuffer | null, data: Float32Array) => {
        if (!buf) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      };
      up(this.gSlabWallBuf, this.gSlabWallPos);
      up(this.gSlabLidBuf, this.gSlabLidPos);
      up(this.gSlabHaloBuf, this.gSlabHaloPos);
      this.gSlabDirty = false;
    }
    if (ss >= 0.15 && this.gHaloProg && this.slabHaloCount) {
      const hp = this.gHaloProg;
      setCommon(hp);
      gl.uniform1f(hp.uni.uScale, ss);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gSlabHaloBuf);
      bindTriple(hp, 40);
      gl.enableVertexAttribArray(hp.attr.aDist);
      gl.vertexAttribPointer(hp.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.slabHaloCount);
    }
    const p = this.gSlabPieceProg;
    if (!p) return;
    setCommon(p);
    gl.uniform1f(p.uni.uScale, ss);
    gl.uniform4f(p.uni.uTint, 0, 0, 0, 0);
    this.bindGlobePieces(gl, p, this.gSlabWallBuf, bindTriple);
    if (this.slabLid === "verre") {
      // The words' boxes' walls, culled to their outer faces: their outlines
      // turn clockwise seen from above (map/lib/slabs: pieceOutline), so an outer
      // face winds clockwise on screen.
      const parts = this.slabPartWallCount;
      gl.drawArrays(gl.TRIANGLES, 0, parts);
      gl.enable(gl.CULL_FACE);
      gl.frontFace(gl.CW);
      gl.cullFace(gl.BACK);
      gl.drawArrays(gl.TRIANGLES, parts, this.slabWallCount - parts);
      gl.disable(gl.CULL_FACE);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, this.slabWallCount);
    }
    if (ss < 0.05 || !this.slabLidCount) return;
    this.bindGlobePieces(gl, p, this.gSlabLidBuf, bindTriple);
    if (this.slabPartLidCount) gl.drawArrays(gl.TRIANGLES, 0, this.slabPartLidCount);
    const first = this.slabPartLidCount;
    const boxes = this.slabLidCount - first;
    if (!boxes || this.slabLid === "verre") return;
    const [r, g, b] = this.slabColor;
    gl.uniform4f(p.uni.uTint, r, g, b, 1);
    gl.drawArrays(gl.TRIANGLES, first, boxes);
    if (this.slabLid === "carte" && this.gLidProg && this.lidTexture && this.lidMerc) {
      const lp = this.gLidProg;
      setCommon(lp);
      gl.uniform1f(lp.uni.uScale, ss);
      gl.uniform2f(lp.uni.uTexOrigin, this.lidMerc.minX, this.lidMerc.minY);
      gl.uniform2f(lp.uni.uTexSpan, this.lidMerc.spanX, this.lidMerc.spanY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lidTexture);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gSlabLidBuf);
      bindTriple(lp, 48);
      gl.drawArrays(gl.TRIANGLES, first, boxes);
    }
  }

  /** The pieces' globe buffer `buf` bound to `p`, coloured per vertex:
   *  [merc3, lo3, hi3, rgb3]. */
  private bindGlobePieces(
    gl: WebGL2RenderingContext,
    p: GlProg,
    buf: WebGLBuffer | null,
    bindTriple: (p: GlProg, stride: number) => void,
  ) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    bindTriple(p, 48);
    gl.enableVertexAttribArray(p.attr.aColor);
    gl.vertexAttribPointer(p.attr.aColor, 3, gl.FLOAT, false, 48, 36);
  }
}
