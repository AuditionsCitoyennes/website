// The PENDING mark: what a tapped territory wears from the tap until its
// plateau commits — a still, lighter, thicker stroke along its boundary and,
// when asked (a touch screen, which has no hover), a flat violet fill. A pass
// of PlateauWallLayer's with buffers of its own, the way the selection
// retract has its own: nothing the plateau's mesh does to itself (a rebuild
// at the commit, the hover fill's single buffer, the rise's scale gates) can
// take the mark away, and a hovered unit's fill draws beside it.
//
// State, not progress: nothing here moves while the mark is held. A repaint
// is asked once per change (set, re-anchor, clear) and, once the plateau
// commits, for the frames of a 117 ms fade — a bounded loop, as the hover
// sweep's and the retract's are (PlateauWallLayer.fillSweepT). A still map
// with a mark held draws no frame.
//
// Where it stands:
// - on the ground (a neighbour, or no plateau standing): the stroke with the
//   ground lines, depth-tested so a standing plateau hides its far side;
// - on the standing plateau's lid (one of its children): at lid height,
//   riding the plateau's scale, so it comes down with the old plateau;
// - once its own plateau commits (`commit`): re-anchored on the new lid,
//   riding the rise while it fades — over the lid, depth test off, so the
//   rising terrain cannot bury it.
// The globe programs have no depth test: the layer draws the ground mark
// before the walls and the lid, the raised one after (painter's order).

import { buildProgram, foldOrigin, GLOBE_UNIS, type GlProg } from "./program";
import {
  MARK_BAND,
  MARK_CORE,
  MARK_FILL_SHARE,
  MARK_GROUND_FILL_M,
  MARK_GROUND_LINE_M,
  buildMarkSet,
  fillThreshold,
  markLidFillM,
  markLidLineM,
  markOpacity,
  type MarkGeometry,
  type MarkSet,
} from "./pendingMark";
import { G_MARK_VS, MARK_FS, MARK_VS } from "./pendingMarkShaders";

/** A mark to show. */
export interface PendingMarkSpec {
  /** The tapped unit. */
  id: string;
  /** Its outline in memory at the tap. */
  g: MarkGeometry;
  stroke: boolean;
  fill: boolean;
  /** On the standing plateau's lid (riding its scale), `lidM` metres up;
   *  false: on the ground. */
  raised: boolean;
  lidM: number;
}

/** Which of the layer's two moments a draw is for: the fill goes where the
 *  hover fill does, the stroke after the boundary lines. */
export type MarkPhase = "fill" | "stroke";

/** The globe frame's binders (PlateauWallLayer.globeBinders). */
export interface GlobeBinders {
  setCommon: (p: GlProg) => void;
  bindTriple: (p: GlProg, stride: number) => void;
}

interface RegimeBuffers {
  set: MarkSet | null;
  line: WebGLBuffer | null;
  fill: WebGLBuffer | null;
  /** The set is not in the buffers yet. */
  dirty: boolean;
  /** The set was asked for and could not be built. */
  failed: boolean;
}

const emptyRegime = (): RegimeBuffers => ({
  set: null,
  line: null,
  fill: null,
  dirty: false,
  failed: false,
});

export class PendingMarkPass {
  private spec: PendingMarkSpec | null = null;
  /** When the fade began (performance.now()); 0: the mark is held. */
  private fadeT0 = 0;
  private merc = emptyRegime();
  private globe = emptyRegime();
  private prog: GlProg | null = null;
  private gProg: GlProg | null = null;
  private mat = new Float32Array(16);

  /** `repaint`: one more frame of the map (the layer's triggerRepaint). */
  constructor(private readonly repaint: () => void) {}

  /** The unit marked, "" when none. */
  get id(): string {
    return this.spec?.id ?? "";
  }

  /** Something to draw: the layer must not skip its frame. */
  get active(): boolean {
    return this.spec !== null;
  }

  /** What the testing tools read of it. */
  state() {
    const s = this.spec;
    return s
      ? {
          id: s.id,
          stroke: s.stroke,
          fill: s.fill,
          raised: s.raised,
          fading: this.fadeT0 > 0,
          lineVerts: (this.merc.set ?? this.globe.set)?.lineCount ?? null,
          fillVerts: (this.merc.set ?? this.globe.set)?.fillCount ?? null,
        }
      : null;
  }

  /** Mark a unit (replacing any other), held until `commit` or `clear`. Its
   *  meshes are built by the first frame that draws each regime. */
  set(spec: PendingMarkSpec) {
    this.spec = spec.stroke || spec.fill ? spec : null;
    this.fadeT0 = 0;
    this.invalidate();
    this.repaint();
  }

  /** The marked unit's plateau has committed, its lid `lidM` metres up: the
   *  mark moves onto that lid and fades as the plateau rises — or goes at
   *  once (`animate` false: reduced motion). */
  commit(lidM: number, animate: boolean) {
    const s = this.spec;
    if (!s) return;
    if (!animate) {
      this.clear();
      return;
    }
    this.spec = { ...s, raised: true, lidM };
    this.fadeT0 = performance.now();
    this.invalidate();
    this.repaint();
  }

  /** No plateau came for the marked unit: the mark fades where it stands
   *  (the commit's fade, MARK_FADE_MS: bounded, nothing rebuilt) — or goes
   *  at once (`animate` false: reduced motion). */
  drain(animate: boolean) {
    if (!this.spec) return;
    if (!animate) {
      this.clear();
      return;
    }
    if (this.fadeT0) return; // fading already
    this.fadeT0 = performance.now();
    this.repaint();
  }

  /** No mark, at once. */
  clear() {
    if (!this.spec) return;
    this.spec = null;
    this.fadeT0 = 0;
    this.invalidate();
    this.repaint();
  }

  private invalidate() {
    for (const r of [this.merc, this.globe]) {
      r.set = null;
      r.dirty = false;
      r.failed = false;
    }
  }

  onAdd(gl: WebGL2RenderingContext) {
    this.prog = buildProgram(
      gl,
      MARK_VS,
      MARK_FS,
      ["aPos", "aOther", "aSide", "aGeomSide"],
      ["uMatrix", "uScale", "uViewport", "uWidth", "uAlpha", "uColor"],
    );
    this.gProg = buildProgram(
      gl,
      G_MARK_VS,
      MARK_FS,
      ["aMerc", "aEcefLo", "aEcefHi", "aOMerc", "aOEcefLo", "aOEcefHi", "aSide", "aGeomSide"],
      [...GLOBE_UNIS, "uViewport", "uWidth", "uAlpha", "uColor"],
    );
    for (const r of [this.merc, this.globe]) {
      r.line = gl.createBuffer();
      r.fill = gl.createBuffer();
      // A fresh context knows nothing of a set built before it.
      r.dirty = r.set !== null;
    }
  }

  onRemove(gl: WebGL2RenderingContext) {
    for (const p of [this.prog, this.gProg]) if (p) gl.deleteProgram(p.prog);
    this.prog = null;
    this.gProg = null;
    for (const r of [this.merc, this.globe]) {
      if (r.line) gl.deleteBuffer(r.line);
      if (r.fill) gl.deleteBuffer(r.fill);
      r.line = null;
      r.fill = null;
    }
  }

  /** The mark's opacity this frame; at the fade's end the mark is dropped.
   *  Asks for the next frame while fading (bounded: MARK_FADE_MS). */
  private opacity(): number {
    const a = markOpacity(performance.now(), this.fadeT0);
    if (a <= 0) {
      this.spec = null;
      this.fadeT0 = 0;
      this.invalidate();
      return 0;
    }
    if (this.fadeT0) this.repaint();
    return a;
  }

  /** A regime's set, built on its first frame and uploaded. Null: none (a
   *  geometry no builder reads: the mark is given up for that regime). */
  private ready(gl: WebGL2RenderingContext, r: RegimeBuffers, regime: "merc" | "globe") {
    const s = this.spec;
    if (!s || r.failed) return null;
    if (!r.set) {
      const lineM = s.raised ? markLidLineM(s.lidM) : MARK_GROUND_LINE_M;
      const fillM = s.raised ? markLidFillM(s.lidM) : MARK_GROUND_FILL_M;
      try {
        r.set = buildMarkSet(s.g, regime, lineM, fillM, s);
      } catch {
        r.set = null;
      }
      if (!r.set) {
        r.failed = true;
        return null;
      }
      r.dirty = true;
    }
    if (r.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, r.line);
      gl.bufferData(gl.ARRAY_BUFFER, r.set.line, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.fill);
      gl.bufferData(gl.ARRAY_BUFFER, r.set.fill, gl.DYNAMIC_DRAW);
      r.dirty = false;
    }
    return r.set;
  }

  /** The stroke's two lines, from the bound buffer: the violet band, then
   *  the light core over it. */
  private strokes(gl: WebGL2RenderingContext, p: GlProg, count: number, opacity: number) {
    const dpr = window.devicePixelRatio || 1;
    gl.uniform2f(p.uni.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    for (const look of [MARK_BAND, MARK_CORE]) {
      gl.uniform1f(p.uni.uWidth, look.width * dpr);
      gl.uniform1f(p.uni.uAlpha, look.alpha * opacity);
      gl.uniform3f(p.uni.uColor, look.rgb[0], look.rgb[1], look.rgb[2]);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    }
  }

  /**
   * The mercator draw of one phase. `scale`: the plateau's rise this frame
   * (a raised mark rides it; a ground one stands at its own height).
   * `fillProg`: the layer's hover-fill program, which draws the flat fill.
   * Leaves the depth test and the depth writes on, as it found them.
   */
  drawMercator(
    gl: WebGL2RenderingContext,
    matrix: ArrayLike<number>,
    scale: number,
    phase: MarkPhase,
    fillProg: GlProg | null,
  ) {
    const s = this.spec;
    if (!s) return;
    const set = this.ready(gl, this.merc, "merc");
    if (!set) return;
    const count = phase === "fill" ? set.fillCount : set.lineCount;
    if (!count) return;
    const opacity = this.opacity();
    if (opacity <= 0) return;
    const p = phase === "fill" ? fillProg : this.prog;
    if (!p) return;
    const mat = foldOrigin(matrix, set.origin[0], set.origin[1], this.mat);
    const rise = s.raised ? scale : 1;
    // Raised: over the lid, nothing nearer than it — the test off, as for
    // the lines on the lid. Ground: tested, so a standing plateau hides the
    // far side.
    if (s.raised) gl.disable(gl.DEPTH_TEST);
    else gl.enable(gl.DEPTH_TEST);
    // Read, never written: the band and the core are the same segments at two
    // widths, and the second would tie with the depth the first wrote and
    // lose half its fragments. Nothing drawn after the mark needs its depth.
    gl.depthMask(false);
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
    gl.uniform1f(p.uni.uScale, rise);
    if (phase === "fill") {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.merc.fill);
      gl.uniform1f(p.uni.uFillT, fillThreshold(MARK_FILL_SHARE * opacity));
      gl.enableVertexAttribArray(p.attr.aPos);
      gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(p.attr.aDist);
      gl.vertexAttribPointer(p.attr.aDist, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.merc.line);
      gl.enableVertexAttribArray(p.attr.aPos);
      gl.vertexAttribPointer(p.attr.aPos, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(p.attr.aOther);
      gl.vertexAttribPointer(p.attr.aOther, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(p.attr.aSide);
      gl.vertexAttribPointer(p.attr.aSide, 1, gl.FLOAT, false, 32, 24);
      gl.enableVertexAttribArray(p.attr.aGeomSide);
      gl.vertexAttribPointer(p.attr.aGeomSide, 1, gl.FLOAT, false, 32, 28);
      // On the ground the unit's own boundary line lies at the same height:
      // pulled a hair toward the camera, the stroke wins that tie everywhere
      // and still hides behind a plateau standing in front of it.
      if (!s.raised) {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-2, -8);
      }
      this.strokes(gl, p, count, opacity);
      if (!s.raised) gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // As mapbox hands a "3d" layer its frame: tested and written.
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /**
   * The globe draw of one phase, for the layer's ground pass (`raised`
   * false: before the walls and the lid) or its raised pass (after them): a
   * mark draws in the one that is its own. No depth test on the globe.
   * `fillProg`: the layer's globe hover-fill program.
   */
  drawGlobe(
    gl: WebGL2RenderingContext,
    binders: GlobeBinders,
    raised: boolean,
    phase: MarkPhase,
    fillProg: GlProg | null,
  ) {
    const s = this.spec;
    if (!s || s.raised !== raised) return;
    const set = this.ready(gl, this.globe, "globe");
    if (!set) return;
    const count = phase === "fill" ? set.fillCount : set.lineCount;
    if (!count) return;
    const opacity = this.opacity();
    if (opacity <= 0) return;
    const { setCommon, bindTriple } = binders;
    if (phase === "fill") {
      if (!fillProg) return;
      setCommon(fillProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.globe.fill);
      gl.uniform1f(fillProg.uni.uFillT, fillThreshold(MARK_FILL_SHARE * opacity));
      if (!s.raised) gl.uniform1f(fillProg.uni.uScale, 1);
      bindTriple(fillProg, 40);
      gl.enableVertexAttribArray(fillProg.attr.aDist);
      gl.vertexAttribPointer(fillProg.attr.aDist, 1, gl.FLOAT, false, 40, 36);
      gl.drawArrays(gl.TRIANGLES, 0, count);
      return;
    }
    const p = this.gProg;
    if (!p) return;
    setCommon(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.globe.line);
    if (!s.raised) gl.uniform1f(p.uni.uScale, 1);
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
    this.strokes(gl, p, count, opacity);
  }
}
