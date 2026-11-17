// The PENDING mark: what a tapped territory wears from the tap until its
// plateau rises — a flat violet fill over its surface and, along its
// boundary, a loading line that covers the share of the boundary's length
// the data of its plateau has reached. A pass of PlateauWallLayer's with
// buffers of its own, the way the selection retract has its own: nothing the
// plateau's mesh does to itself (a rebuild at the commit, the hover fill's
// single buffer, the rise's scale gates) can take the mark away.
//
// The sequence (the caller drives it; every time is the arrival of its
// event, never the first frame drawn after it):
// - `set`: the fill at once, the line at the progress given (0: not drawn,
//   not even built);
// - `setProgress`: a real step — the line eases to its new length
//   (`stepMs`; 0: it jumps), a step that comes during an ease retargets it;
// - `finish`: the data is all in — the line goes to the whole boundary and,
//   under "then", the fill fades out (`unfillMs`) once the line's head has
//   run most of its last step (half that ease: the line is whole before the
//   violet has visibly thinned); `gateMs()` is what is left until the fill
//   is gone, which the plateau's rise waits for;
// - `release`: the plateau starts to rise — the line (and a fill still
//   showing: "together") rides the new lid and fades (`outMs`);
// - `drain`: no plateau came (a long wait turned late) — both fade where
//   they stand; `clear`: at once.
//
// Never a frame of its own accord while nothing moves: a repaint is asked
// once per change and for the frames of an ease, a fade or a creep's tick —
// bounded loops, as the hover sweep's and the retract's are
// (PlateauWallLayer.fillSweepT). A still map with a mark held, its line full
// or waiting, draws no frame. Progress is a uniform: nothing is rebuilt
// while the line moves, nor when the mark goes from the ground to a lid
// (the meshes stand at a reference height, the draw scales it:
// gl/pendingMark.ts).
//
// Where the meshes are built (gl/pendingMark.ts markBuildPlace): a small
// unit's on the page, in the first frame that draws them, the fill and the
// line from one projection of the outline. A wide unit's on the globe (a
// country from the world view) the same, its fill plain — the bisection is
// what costs — and the bisected fill, asked off the frame behind the unit's
// own mesh, takes its place when it lands (never ahead of the plateau's
// mesh: the tap's frame and the mesh stay as light as for any other unit).
// A large unit's (more than 4,000 boundary vertices: six countries' world
// outlines, the finest unit files) off that frame altogether — by the mesh
// worker (`setProvider`) or, without one, in a task of the page's own after
// the frame — and its fill and line join the mark when they land, unless
// the data was all in by then. That is the accepted cost of never
// triangulating a large outline in the tap's frame: such a unit's violet
// comes one or two frames after the tap on a desktop, up to about 200 ms on
// a weak phone (its pill is pending from the first frame; under a mouse its
// hover fill stays until then). Only the regime being drawn is built, and
// never a fill that can no longer show. The meshes are kept for the geometry
// last marked, so « Réessayer » and a second tap rebuild nothing, and dropped
// with the pending state (`forget`) or when another geometry is marked; the
// GPU's copies are emptied by the next frame.
//
// Where it stands:
// - on the ground (a neighbour, or no plateau standing): the line with the
//   ground lines, depth-tested so a standing plateau hides its far side;
// - on the standing plateau's lid (one of its children): at lid height,
//   riding the plateau's scale, so it comes down with the old plateau;
// - once its own plateau rises: on the new lid, riding the rise while it
//   fades — over the lid, depth test off, so the rising terrain cannot bury
//   it.
// The globe programs have no depth test: the layer draws the ground mark
// before the walls and the lid, the raised one after (painter's order).

import { createAfterFrame } from "../lib/afterFrame";
import { LINE_CORNERS, SEGMENT_VERTICES } from "./lineSegments";
import { buildProgram, foldOrigin, GLOBE_UNIS, type GlProg } from "./program";
import {
  G_MARK_FILL_FLOATS,
  G_MARK_LINE_FLOATS,
  MARK_FILL_FLOATS,
  MARK_FILL_SHARE,
  MARK_GROUND_FILL_M,
  MARK_GROUND_LINE_M,
  MARK_CREEP_FREEZE_MS,
  MARK_CREEP_TICK_MS,
  MARK_LINE_FLOATS,
  MARK_LINE_HOLD_CAP_MS,
  MARK_REF_M,
  buildMark,
  buildMarkFill,
  buildMarkLine,
  creepShown,
  easeStep,
  fadeAlpha,
  fillThreshold,
  markBuildPlace,
  markLidFillM,
  markLidLineM,
  markLineWidth,
  ringVertexCount,
  unfillAlpha,
  type MarkFill,
  type MarkGeometry,
  type MarkLine,
  type MarkRegime,
} from "./pendingMark";
import { G_MARK_LEAN_VS, MARK_FS, MARK_LEAN_VS, MARK_PROGRESS_FULL } from "./pendingMarkShaders";

/** A mark to show. */
export interface PendingMarkSpec {
  /** The tapped unit. */
  id: string;
  /** Its outline in memory at the tap. */
  g: MarkGeometry;
  /** Its box's wider side, degrees (where its meshes are built). */
  spanDeg: number;
  line: boolean;
  fill: boolean;
  /** On the standing plateau's lid (riding its scale), `lidM` metres up;
   *  false: on the ground. */
  raised: boolean;
  lidM: number;
  /** The line's colour, straight sRGB 0..1. */
  rgb: readonly [number, number, number];
  /** The line also slides toward the next step while it waits
   *  (`ac:tap-steps`), a repaint asked every `creepTickMs` at most
   *  (MARK_CREEP_TICK_MS by default). */
  creep: boolean;
  creepTickMs?: number;
}

/** How the mark moves now (the page's motion setting). `animate` false
 *  (reduced motion): no fade at all. `stepMs` 0: the line jumps. */
export interface MarkMotion {
  animate: boolean;
  stepMs: number;
  unfillMs: number;
  outMs: number;
}

/** Which of the layer's two moments a draw is for: the fill goes where the
 *  hover fill does, the line after the boundary lines. */
export type MarkPhase = "fill" | "line";

/** The globe frame's binders (PlateauWallLayer.globeBinders). */
export interface GlobeBinders {
  setCommon: (p: GlProg) => void;
  bindTriple: (p: GlProg, stride: number) => void;
}

/** A regime's fill and line, built off the page. */
export interface MarkBuffers {
  line: MarkLine;
  fill: MarkFill;
}

/** Who builds a large unit's mark off the page (the mesh worker). */
export interface MarkProvider {
  live(): boolean;
  /** Null: not built (the caller builds it in a task of its own). `front`:
   *  the tap's own request, ahead of the builds queued. Never rejects. */
  build(g: MarkGeometry, regime: MarkRegime, front: boolean): Promise<MarkBuffers | null>;
}

export interface MarkPassDeps {
  /** One more frame of the map (the layer's triggerRepaint). */
  repaint(): void;
  /** A fill built off the frame has joined the mark of unit `id` (the page
   *  hands the unit's draped hover fill over to it). */
  onFill?(id: string): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(id: unknown): void;
  /** Runs `job` in a task of its own, after the next frame is drawn. */
  defer?(job: () => void): void;
  /** The device's pixel ratio. */
  dpr?(): number;
  /** Compiles a program (./program buildProgram; the tests give their own). */
  program?: typeof buildProgram;
}

type PartState = "none" | "pending" | "ready" | "failed";

interface RegimeSets {
  fill: MarkFill | null;
  fillState: PartState;
  fillDirty: boolean;
  /** The fill landed too late for the mark held (the data was all in). */
  fillLate: boolean;
  line: MarkLine | null;
  lineState: PartState;
  lineDirty: boolean;
  /** The fill is the plain one of a wide unit on the globe: its bisected
   *  one is still to take its place (`asked`: it has been asked for). */
  fillPlain: boolean;
  refineAsked: boolean;
  fillBuf: WebGLBuffer | null;
  lineBuf: WebGLBuffer | null;
  /** The buffers hold an upload (emptied once its mesh is dropped). */
  fillOnGpu: boolean;
  lineOnGpu: boolean;
  vao: WebGLVertexArrayObject | null;
  vaoSet: boolean;
}

const emptyRegime = (): RegimeSets => ({
  fill: null,
  fillState: "none",
  fillDirty: false,
  fillLate: false,
  line: null,
  lineState: "none",
  lineDirty: false,
  fillPlain: false,
  refineAsked: false,
  fillBuf: null,
  lineBuf: null,
  fillOnGpu: false,
  lineOnGpu: false,
  vao: null,
  vaoSet: false,
});

const clamp01 = (v: number) => (v >= 1 ? 1 : v > 0 ? v : 0);

export class PendingMarkPass {
  private spec: PendingMarkSpec | null = null;
  private phase: "held" | "released" | "draining" = "held";
  /** The geometry the kept meshes are for, its boundary vertices, and
   *  whether they outlive the mark (until `forget`). */
  private keptG: MarkGeometry | null = null;
  private vertices = 0;
  private keep = false;
  /** A mesh of this mark was asked off the frame already (the next one is
   *  not the tap's own). */
  private asked = false;
  // ---- the line's progress: an ease from `from` to `goal`, begun at `easeT0` ----
  private target = 0;
  private from = 0;
  private goal = 0;
  private easeT0 = 0;
  private easeMs = 0;
  /** When the last real step came (the creep counts from it). */
  private stepAt = 0;
  // ---- the end ----
  private finished = false;
  private order: "then" | "together" = "then";
  private unfillT0 = 0;
  private unfillMs = 0;
  private outT0 = 0;
  private outMs = 0;
  private outLidM = 0;
  // ---- what the testing tools read ----
  private setAt = 0;
  private fillDrawn = false;
  private fillVia: "page" | "deferred" | "worker" | null = null;
  private fillLateMs: number | null = null;
  private linked: boolean | null = null;

  /** The regime last made ready for a frame (null: no frame since the mark was set). */
  private regime: MarkRegime | null = null;
  private capTimer: unknown = null;
  private creepTimer: unknown = null;
  /** Frames made ready (`prepare`), their count at the creep's last tick,
   *  and whether that tick asked for one. */
  private frames = 0;
  private framesAtTick = 0;
  private tickAsked = false;
  private provider: MarkProvider | null = null;
  /** The camera's zoom at the last frame made ready (the line's width). */
  private zoom = 22;
  /** Meshes were dropped: the GPU's copies are emptied by the next frame. */
  private emptyBuffers = false;

  private merc = emptyRegime();
  private globe = emptyRegime();
  private prog: GlProg | null = null;
  private gProg: GlProg | null = null;
  /** The instanced ends' locations, in buffer order (a vec3 each). */
  private locs: number[] = [];
  private gLocs: number[] = [];
  private cornerBuf: WebGLBuffer | null = null;
  private cornersDirty = false;
  private gl: WebGL2RenderingContext | null = null;
  private mat = new Float32Array(16);

  private readonly repaint: () => void;
  private readonly onFill: (id: string) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly defer: (job: () => void) => void;
  private readonly dpr: () => number;
  private readonly program: typeof buildProgram;

  constructor(deps: MarkPassDeps | (() => void)) {
    const d: MarkPassDeps = typeof deps === "function" ? { repaint: deps } : deps;
    this.repaint = d.repaint;
    this.onFill = d.onFill ?? (() => {});
    this.now = d.now ?? (() => performance.now());
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.defer = d.defer ?? ((job) => createAfterFrame().schedule(job));
    this.dpr = d.dpr ?? (() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
    this.program = d.program ?? buildProgram;
  }

  /** The unit marked, "" when none. */
  get id(): string {
    return this.spec?.id ?? "";
  }

  /** Something to draw: the layer must not skip its frame. */
  get active(): boolean {
    return this.spec !== null;
  }

  /** Who builds a large unit's mark off the page (null: the page does). */
  setProvider(provider: MarkProvider | null) {
    this.provider = provider;
  }

  /** The mark asks for a fill. */
  get wantsFill(): boolean {
    return !!this.spec?.fill;
  }

  /** Whether the mark has its fill in `regime` (ready, and in time): the
   *  layer then leaves the unit's hover fill out for as long as the mark
   *  lasts, so the violet neither doubles, nor drops, nor comes back once
   *  the mark's has faded. Call `prepare` first in a frame. */
  ownsFill(regime: MarkRegime): boolean {
    const s = this.spec;
    if (!s || !s.fill) return false;
    const r = regime === "merc" ? this.merc : this.globe;
    return r.fillState === "ready" && !r.fillLate && !!r.fill?.fillCount;
  }

  /** Whether the fill of a mark set now would be drawn by its first frame
   *  in `regime` (kept from the mark before, or built on the page). */
  fillAtOnce(regime: MarkRegime): boolean {
    const s = this.spec;
    if (!s || !s.fill) return false;
    if (this.ownsFill(regime)) return true;
    const r = regime === "merc" ? this.merc : this.globe;
    return (
      r.fillState === "none" && markBuildPlace(this.vertices, s.spanDeg, regime) !== "off-frame"
    );
  }

  /** The frame's first call, before the layer's hover fill: the regime's
   *  meshes made ready (built, asked for, uploaded), so that `ownsFill`
   *  tells the frame the fill is first drawn in. */
  prepare(gl: WebGL2RenderingContext, regime: MarkRegime, zoom?: number) {
    if (this.spec) {
      if (zoom !== undefined) this.zoom = zoom;
      this.frames++;
      const r = regime === "merc" ? this.merc : this.globe;
      this.ensure(gl, r, regime, this.shownAt(this.now()));
    }
    // After the frame's own uploads: a buffer filled again is left alone.
    if (this.emptyBuffers) this.shrink(gl);
  }

  /** What the testing tools read of it (`withLink`: the programs' link
   *  status too, read once). */
  state(withLink = false) {
    const s = this.spec;
    if (!s) return null;
    const now = this.now();
    const sets = this.merc.fill || this.merc.line ? this.merc : this.globe;
    if (withLink && this.linked === null && this.gl && this.prog && this.gProg) {
      const gl = this.gl;
      this.linked =
        !!gl.getProgramParameter(this.prog.prog, gl.LINK_STATUS) &&
        !!gl.getProgramParameter(this.gProg.prog, gl.LINK_STATUS);
    }
    return {
      id: s.id,
      line: s.line,
      fill: s.fill,
      raised: s.raised,
      phase: this.phase,
      fading: this.phase !== "held",
      finished: this.finished,
      progress: { target: this.target, shown: this.shownAt(now) },
      fillAlpha: this.fillDrawn ? this.fillAlphaAt(now) : 0,
      lineAlpha: this.lineAlphaAt(now),
      gateMs: this.gateMs(),
      fillVia: this.fillVia,
      fillLateMs: this.fillLateMs,
      fillPlain: sets.fillPlain,
      lineBytes: (this.merc.line?.segs.byteLength ?? 0) + (this.globe.line?.segs.byteLength ?? 0),
      fillBytes: (this.merc.fill?.fill.byteLength ?? 0) + (this.globe.fill?.fill.byteLength ?? 0),
      lineSegs: sets.line?.segCount ?? null,
      fillVerts: sets.fill?.fillCount ?? null,
      ...(withLink ? { linked: this.linked } : {}),
    };
  }

  /**
   * Mark a unit (replacing any other), held until `release`, `drain` or
   * `clear`, its line at `progress` (no ease: the value a retry kept). The
   * same geometry object as the mark before: its meshes are used again.
   * `regime`: the one the map draws in now — a large unit's meshes are
   * asked for it at once, without waiting for the next frame.
   */
  set(spec: PendingMarkSpec, progress = 0, regime?: MarkRegime) {
    this.stopTimers();
    if (!spec.line && !spec.fill) {
      this.clear();
      return;
    }
    if (this.keptG !== spec.g) {
      this.dropSets();
      this.keptG = spec.g;
      try {
        this.vertices = ringVertexCount(spec.g);
      } catch {
        this.vertices = 0;
      }
    }
    for (const r of [this.merc, this.globe]) r.fillLate = false;
    this.keep = true;
    this.asked = false;
    this.spec = spec;
    this.phase = "held";
    const now = this.now();
    this.target = this.from = this.goal = clamp01(progress);
    this.easeT0 = 0;
    this.easeMs = 0;
    this.stepAt = now;
    this.finished = false;
    this.order = "then";
    this.unfillT0 = 0;
    this.unfillMs = 0;
    this.outT0 = 0;
    this.outMs = 0;
    this.setAt = now;
    this.fillDrawn = false;
    this.fillVia = null;
    this.fillLateMs = null;
    this.regime = null;
    if (spec.creep) this.armCreep();
    if (regime) this.askAhead(regime);
    this.repaint();
  }

  /** A large unit's meshes asked off the frame, if they are not there yet. */
  private askAhead(regime: MarkRegime) {
    const s = this.spec;
    if (!s) return;
    const r = regime === "merc" ? this.merc : this.globe;
    if (r.fillState !== "none" || r.lineState !== "none") return;
    if (markBuildPlace(this.vertices, s.spanDeg, regime) !== "off-frame") return;
    r.fillState = r.lineState = "pending";
    // The tap's own request goes ahead of the builds queued; a later one
    // (the other regime) behind them.
    const front = !this.asked;
    this.asked = true;
    this.ask(s.g, regime, front);
  }

  /** A real step: the line goes to `target` (never back), easing over
   *  `motion.stepMs` from what it shows now. */
  setProgress(target: number, motion: MarkMotion) {
    if (!this.spec || this.phase !== "held" || this.finished) return;
    const t = clamp01(target);
    if (t <= this.target) return;
    this.step(t, motion);
    if (this.spec.creep && this.creepTimer === null) this.armCreep();
    this.repaint();
  }

  private step(target: number, motion: MarkMotion) {
    const now = this.now();
    const shown = this.shownAt(now);
    this.target = target;
    this.stepAt = now;
    // A creep may have gone past the step: the line never goes back.
    this.goal = Math.max(target, shown);
    if (motion.animate && motion.stepMs > 0 && this.goal > shown) {
      this.from = shown;
      this.easeT0 = now;
      this.easeMs = motion.stepMs;
    } else {
      this.from = this.goal;
      this.easeT0 = 0;
      this.easeMs = 0;
    }
  }

  /**
   * The data is all in: the line goes to the whole boundary and, under
   * "then", the fill starts to fade out. Once per mark; a fill still on its
   * way (a large unit's) no longer joins.
   */
  finish(motion: MarkMotion, order: "then" | "together") {
    if (!this.spec || this.phase !== "held" || this.finished) return;
    this.step(1, motion);
    this.finished = true;
    this.order = order;
    this.stopCreep();
    if (order === "then") {
      // The line first: the fill starts to leave once the head has run most
      // of its last step (ease-out: seven eighths of it by half its time).
      this.unfillT0 = this.now() + this.easeMs / 2;
      this.unfillMs = motion.animate ? Math.max(0, motion.unfillMs) : 0;
    }
    this.armCap(this.easeMs / 2 + this.unfillMs + MARK_LINE_HOLD_CAP_MS);
    this.repaint();
  }

  /** A safety: a full line whose plateau never rises does not stay. */
  private armCap(ms: number) {
    this.clearTimer(this.capTimer);
    this.capTimer = this.setTimer(() => {
      this.capTimer = null;
      if (this.spec && this.phase === "held") this.end(true);
    }, ms);
  }

  /** How long the plateau's rise still waits for the fill to be gone, ms: 0
   *  unless the mark is finished under "then" with a fill on screen (or
   *  about to be: a small unit's, built by its first frame) — or draining
   *  with its fill still on screen (what is left of that fade). */
  gateMs(): number {
    const s = this.spec;
    if (s && this.phase === "draining") {
      return this.fillDrawn && s.fill ? Math.max(0, this.outT0 + this.outMs - this.now()) : 0;
    }
    if (!s || this.phase !== "held" || !this.finished || this.order !== "then") return 0;
    if (!this.fillDrawn && !this.fillComes()) return 0;
    return Math.max(0, this.unfillT0 + this.unfillMs - this.now());
  }

  /** A fill not drawn yet that the next frame draws: ready, or built by that
   *  frame — in the regime last drawn or, before any frame, in either. */
  private fillComes(): boolean {
    const s = this.spec;
    if (!s || !s.fill || this.vertices < 3) return false;
    for (const regime of this.regime ? [this.regime] : (["merc", "globe"] as const)) {
      const r = regime === "merc" ? this.merc : this.globe;
      if (r.fillState === "ready" && !r.fillLate && r.fill?.fillCount) return true;
      if (
        r.fillState === "none" &&
        markBuildPlace(this.vertices, s.spanDeg, regime) !== "off-frame"
      )
        return true;
    }
    return false;
  }

  /**
   * The marked unit's plateau starts to rise, its lid `lidM` metres up: the
   * line (and a fill still showing) moves onto that lid and fades as it
   * rises — or the mark goes at once (`motion.animate` false).
   */
  release(lidM: number, motion: MarkMotion) {
    if (!this.spec) return;
    if (!motion.animate) {
      this.end(true);
      return;
    }
    if (this.phase === "draining") return; // fading already, where it stands
    this.outLidM = lidM;
    if (this.phase === "released") return;
    if (!this.finished) this.step(1, motion); // no verdict told: the line is full all the same
    this.finished = true;
    this.phase = "released";
    this.outT0 = this.now();
    this.outMs = Math.max(0, motion.outMs);
    this.stopTimers();
    this.repaint();
  }

  /** No plateau came for the marked unit: the mark fades where it stands
   *  (bounded, nothing rebuilt) — or goes at once (`motion.animate` false).
   *  Its meshes are kept: a retry draws them again. */
  drain(motion: MarkMotion) {
    if (!this.spec) return;
    if (!motion.animate) {
      this.end(true);
      return;
    }
    if (this.phase !== "held") return; // fading already
    this.phase = "draining";
    this.outT0 = this.now();
    this.outMs = Math.max(0, motion.outMs);
    this.stopTimers();
    this.repaint();
  }

  /** No mark, at once, and nothing kept. */
  clear() {
    this.keep = false;
    if (this.spec) this.end(true);
    else this.dropSets();
  }

  /** The pending state is over: the kept meshes go, at once or, while the
   *  mark still fades, when it has. */
  forget() {
    this.keep = false;
    if (!this.spec) this.dropSets();
  }

  /** The mark is over. */
  private end(repaint: boolean) {
    this.spec = null;
    this.stopTimers();
    if (!this.keep) this.dropSets();
    if (repaint) this.repaint();
  }

  private dropSets() {
    this.keptG = null;
    this.vertices = 0;
    for (const r of [this.merc, this.globe]) {
      r.fill = null;
      r.line = null;
      r.fillState = r.lineState = "none";
      r.fillDirty = r.lineDirty = false;
      r.fillLate = false;
      r.fillPlain = r.refineAsked = false;
      if (r.fillOnGpu || r.lineOnGpu) this.emptyBuffers = true;
    }
  }

  /** The buffers of meshes dropped since the last frame, emptied: a large
   *  unit's (megabytes) do not stay on the GPU for the rest of the session. */
  private shrink(gl: WebGL2RenderingContext) {
    this.emptyBuffers = false;
    for (const r of [this.merc, this.globe]) {
      if (!r.fill && r.fillOnGpu && r.fillBuf) {
        gl.bindBuffer(gl.ARRAY_BUFFER, r.fillBuf);
        gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
        r.fillOnGpu = false;
      }
      if (!r.line && r.lineOnGpu && r.lineBuf) {
        gl.bindBuffer(gl.ARRAY_BUFFER, r.lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
        r.lineOnGpu = false;
      }
    }
  }

  private stopTimers() {
    this.clearTimer(this.capTimer);
    this.capTimer = null;
    this.stopCreep();
  }

  // ---- ac:tap-steps=creep: a tick asks for a frame while the line slides,
  // unless the map drew one of its own since the tick before (a flight, an
  // ease); it stops with the slide ----
  private armCreep(first = true) {
    this.stopCreep();
    if (first) {
      this.framesAtTick = this.frames;
      this.tickAsked = false;
    }
    this.creepTimer = this.setTimer(() => {
      this.creepTimer = null;
      const s = this.spec;
      if (!s || this.phase !== "held" || this.finished) return;
      if (this.now() - this.stepAt >= MARK_CREEP_FREEZE_MS) {
        // The slide has stopped: one last frame at its resting value.
        this.repaint();
        return;
      }
      // Frames since the last tick, the one that tick asked for left out.
      const others = this.frames - this.framesAtTick - (this.tickAsked ? 1 : 0);
      this.framesAtTick = this.frames;
      this.tickAsked = others <= 0;
      if (this.tickAsked) this.repaint();
      this.armCreep(false);
    }, this.spec?.creepTickMs ?? MARK_CREEP_TICK_MS);
  }

  private stopCreep() {
    this.clearTimer(this.creepTimer);
    this.creepTimer = null;
  }

  /** The share of the boundary the line covers `now`. */
  private shownAt(now: number): number {
    const eased =
      this.easeMs > 0
        ? easeStep(this.from, this.goal, (now - this.easeT0) / this.easeMs)
        : this.goal;
    if (!this.spec?.creep || this.finished || this.goal >= 1) return eased;
    return eased + (creepShown(this.goal, now - this.stepAt) - this.goal);
  }

  private fillAlphaAt(now: number): number {
    const s = this.spec;
    if (!s || !s.fill) return 0;
    const out = this.phase === "held" ? 1 : fadeAlpha(now, this.outT0, this.outMs);
    return unfillAlpha(now, this.unfillT0, this.unfillMs) * out;
  }

  private lineAlphaAt(now: number): number {
    const s = this.spec;
    if (!s || !s.line) return 0;
    return this.phase === "held" ? 1 : fadeAlpha(now, this.outT0, this.outMs);
  }

  /** This frame's values, the next frame asked for while something moves
   *  (an ease, a fade: bounded); null: the mark is over. */
  private tick(now: number) {
    const s = this.spec;
    if (!s) return null;
    if (this.phase !== "held" && fadeAlpha(now, this.outT0, this.outMs) <= 0) {
      this.end(false);
      return null;
    }
    const fillA = this.fillAlphaAt(now);
    const easing = this.easeMs > 0 && now < this.easeT0 + this.easeMs;
    const unfilling = this.unfillT0 > 0 && now < this.unfillT0 + this.unfillMs;
    if (this.phase !== "held" || easing || unfilling) this.repaint();
    return { fillA, lineA: this.lineAlphaAt(now), shown: this.shownAt(now) };
  }

  onAdd(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.linked = null;
    this.prog = this.program(
      gl,
      MARK_LEAN_VS,
      MARK_FS,
      ["aA", "aB", "aLen", "aCorner"],
      ["uMatrix", "uScale", "uViewport", "uWidth", "uAlpha", "uColor", "uProgress"],
    );
    this.gProg = this.program(
      gl,
      G_MARK_LEAN_VS,
      MARK_FS,
      ["aAMerc", "aAEcefLo", "aAEcefHi", "aBMerc", "aBEcefLo", "aBEcefHi", "aLen", "aCorner"],
      [...GLOBE_UNIS, "uViewport", "uWidth", "uAlpha", "uColor", "uProgress"],
    );
    this.locs = this.prog ? [this.prog.attr.aA, this.prog.attr.aB] : [];
    const gp = this.gProg;
    this.gLocs = gp
      ? ["aAMerc", "aAEcefLo", "aAEcefHi", "aBMerc", "aBEcefLo", "aBEcefHi"].map(
          (name) => gp.attr[name],
        )
      : [];
    // Filled at the first draw, like every buffer of the layer's: binding
    // one now, outside a frame, would change the bound buffer behind
    // mapbox's back. A fresh context knows nothing of a mesh built before.
    this.cornerBuf = gl.createBuffer();
    this.cornersDirty = true;
    for (const r of [this.merc, this.globe]) {
      r.fillBuf = gl.createBuffer();
      r.lineBuf = gl.createBuffer();
      r.vao = gl.createVertexArray();
      r.vaoSet = false;
      r.fillOnGpu = r.lineOnGpu = false; // new buffers: nothing in them
      r.fillDirty = r.fill !== null;
      r.lineDirty = r.line !== null;
    }
    // A mark held across a context given back: its timers again (onRemove
    // stopped them).
    if (this.spec && this.phase === "held") {
      if (this.finished) this.armCap(MARK_LINE_HOLD_CAP_MS);
      else if (this.spec.creep) this.armCreep();
    }
  }

  onRemove(gl: WebGL2RenderingContext) {
    this.stopTimers(); // no tick and no cap once the layer is gone
    this.emptyBuffers = false;
    for (const p of [this.prog, this.gProg]) if (p) gl.deleteProgram(p.prog);
    this.prog = null;
    this.gProg = null;
    if (this.cornerBuf) gl.deleteBuffer(this.cornerBuf);
    this.cornerBuf = null;
    for (const r of [this.merc, this.globe]) {
      if (r.fillBuf) gl.deleteBuffer(r.fillBuf);
      if (r.lineBuf) gl.deleteBuffer(r.lineBuf);
      if (r.vao) gl.deleteVertexArray(r.vao);
      r.fillBuf = r.lineBuf = null;
      r.fillOnGpu = r.lineOnGpu = false;
      r.vao = null;
      r.vaoSet = false;
    }
    this.gl = null;
  }

  /** A unit's meshes asked off the frame: the worker, else a task of the
   *  page's own after the frame. `front`: ahead of the builds the worker
   *  has queued (a large unit's, at the tap). */
  private ask(g: MarkGeometry, regime: MarkRegime, front: boolean) {
    const onPage = () =>
      this.defer(() => {
        if (this.keptG !== g) return;
        const r = regime === "merc" ? this.merc : this.globe;
        // Built here only for a mark that can still show it: held, its data
        // still coming. Otherwise nothing is triangulated: a plain fill
        // stays as it is; a large unit gets its line alone (no
        // triangulation) if it is held with its line full, and the regime
        // is left to be asked again by a later mark of this geometry.
        const s = this.spec;
        const held = !!s && s.g === g && this.phase === "held";
        if (!held || this.finished) {
          if (r.fillPlain) {
            r.refineAsked = false;
            return;
          }
          let line: MarkLine | null = null;
          if (held && s.line) {
            try {
              line = buildMarkLine(g, regime);
            } catch {
              line = null;
            }
          }
          r.fillState = "none";
          r.line = line;
          r.lineState = line ? "ready" : "none";
          r.lineDirty = line !== null;
          if (line) this.repaint();
          return;
        }
        if (r.fillPlain) {
          // The bisected fill alone: the line stands.
          let fill: MarkFill | null = null;
          try {
            fill = buildMarkFill(g, regime);
          } catch {
            fill = null;
          }
          this.refine(g, r, fill);
          return;
        }
        let built: MarkBuffers | null = null;
        try {
          built = buildMark(g, regime);
        } catch {
          built = null;
        }
        this.adopt(g, regime, built, "deferred");
      });
    const provider = this.provider;
    if (!provider?.live()) return onPage();
    void provider
      .build(g, regime, front)
      .then((b) => (b ? this.adopt(g, regime, b, "worker") : onPage()), onPage);
  }

  /** Meshes built off the frame have landed: kept if they are still the
   *  marked geometry's; the fill joins a mark still waiting for its data —
   *  or takes the place of the plain fill a wide unit was first drawn with. */
  private adopt(
    g: MarkGeometry,
    regime: MarkRegime,
    b: MarkBuffers | null,
    via: "deferred" | "worker",
  ) {
    if (this.keptG !== g) return;
    const r = regime === "merc" ? this.merc : this.globe;
    if (r.fillPlain) {
      this.refine(g, r, b?.fill ?? null);
      return;
    }
    if (!b) {
      r.fillState = r.lineState = "failed";
      return;
    }
    r.fill = b.fill;
    r.line = b.line;
    r.fillState = r.lineState = "ready";
    r.fillDirty = r.lineDirty = true;
    const s = this.spec;
    if (!s || s.g !== g) return;
    if (this.phase === "held" && !this.finished) {
      if (this.fillVia === null) {
        this.fillVia = via;
        this.fillLateMs = this.now() - this.setAt;
      }
      if (s.fill && r.fill.fillCount) this.onFill(s.id);
    } else r.fillLate = true;
    this.repaint();
  }

  /** The bisected fill of a wide unit takes its plain one's place: the same
   *  violet, without the seam — nothing else changes. */
  private refine(g: MarkGeometry, r: RegimeSets, fill: MarkFill | null) {
    if (!fill?.fillCount) return;
    r.fill = fill;
    r.fillDirty = true;
    r.fillPlain = false;
    if (this.spec?.g === g) this.repaint();
  }

  /** A regime's meshes for this frame: built here for a small unit, asked
   *  off the frame for a large one, uploaded when new. */
  private ensure(gl: WebGL2RenderingContext, r: RegimeSets, regime: MarkRegime, shown: number) {
    const s = this.spec;
    if (!s) return;
    this.regime = regime;
    const place = markBuildPlace(this.vertices, s.spanDeg, regime);
    if (place !== "off-frame") {
      // A wide unit on the globe: its fill plain in this frame.
      const bisect = place === "page";
      // A fill that can no longer show (the data all in and the violet
      // gone, the mark on its way out) is not built: a regime first drawn
      // then (a flight across zoom 6) needs the line alone.
      const fillShows =
        this.phase === "held" &&
        !(this.finished && this.order === "then" && this.fillAlphaAt(this.now()) <= 0);
      const wantFill = s.fill && r.fillState === "none" && fillShows;
      // The line with the fill, from one projection of the outline — so its
      // build is never a later frame's — or alone at its first progress.
      const wantLine = s.line && r.lineState === "none" && (wantFill || shown > 0);
      if (wantFill && wantLine) {
        let both: MarkBuffers | null = null;
        try {
          both = buildMark(s.g, regime, bisect);
        } catch {
          both = null;
        }
        r.fill = both?.fill ?? null;
        r.line = both?.line ?? null;
      } else if (wantFill) {
        try {
          r.fill = buildMarkFill(s.g, regime, bisect);
        } catch {
          r.fill = null;
        }
      } else if (wantLine) {
        try {
          r.line = buildMarkLine(s.g, regime);
        } catch {
          r.line = null;
        }
      }
      if (wantFill) {
        r.fillState = r.fill ? "ready" : "failed";
        r.fillDirty = r.fill !== null;
        r.fillPlain = !bisect && r.fill !== null;
        if (r.fill && this.fillVia === null) this.fillVia = "page";
      }
      // The bisected fill of a plain one, asked once, behind the worker's
      // builds, while the mark can still show it.
      if (r.fillPlain && !r.refineAsked && this.phase === "held" && !this.finished) {
        r.refineAsked = true;
        this.ask(s.g, regime, false);
      }
      if (wantLine) {
        r.lineState = r.line ? "ready" : "failed";
        r.lineDirty = r.line !== null;
      }
    } else this.askAhead(regime);
    if (r.fillDirty && r.fill) {
      gl.bindBuffer(gl.ARRAY_BUFFER, r.fillBuf);
      gl.bufferData(gl.ARRAY_BUFFER, r.fill.fill, gl.DYNAMIC_DRAW);
      r.fillDirty = false;
      r.fillOnGpu = true;
    }
    if (r.lineDirty && r.line) {
      gl.bindBuffer(gl.ARRAY_BUFFER, r.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, r.line.segs, gl.DYNAMIC_DRAW);
      r.lineDirty = false;
      r.lineOnGpu = true;
    }
  }

  /** Whether the mark stands over a lid (depth test off, the globe's raised
   *  pass) rather than on the ground. */
  private lifted(): boolean {
    return this.phase === "released" || !!this.spec?.raised;
  }

  /** The height the fill or the line stands at this frame, as the draw's
   *  scale of the reference height. `rise`: the plateau's this frame. */
  private heightScale(part: MarkPhase, rise: number): number {
    const s = this.spec!;
    const lid = part === "fill" ? markLidFillM : markLidLineM;
    const ground = part === "fill" ? MARK_GROUND_FILL_M : MARK_GROUND_LINE_M;
    let m: number;
    if (this.phase === "released") {
      // On the new lid as it rises, never under where a ground mark stood.
      m = Math.max(s.raised ? 0 : ground, lid(this.outLidM) * rise);
    } else m = s.raised ? lid(s.lidM) * rise : ground;
    return m / MARK_REF_M;
  }

  /** The line's uniforms beyond the projection's, for program `p` in use. */
  private lineUniforms(
    gl: WebGL2RenderingContext,
    p: GlProg,
    alpha: number,
    shown: number,
    scale: number,
  ) {
    const s = this.spec!;
    gl.uniform1f(p.uni.uScale, scale);
    gl.uniform2f(p.uni.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(p.uni.uWidth, markLineWidth(s.spanDeg, this.zoom) * this.dpr());
    gl.uniform1f(p.uni.uAlpha, alpha);
    gl.uniform3f(p.uni.uColor, s.rgb[0], s.rgb[1], s.rgb[2]);
    gl.uniform1f(p.uni.uProgress, shown >= 1 ? MARK_PROGRESS_FULL : shown);
  }

  /**
   * The line's segments drawn as instances of the quad's six corners, from
   * the regime's own vertex array object: no divisor and no instanced
   * pointer is ever written to the default one, which every other draw of
   * the layers uses, and which is bound again on the way out. `locs`: the
   * instanced vec3 attributes in buffer order, then `aLen`.
   */
  private drawSegments(
    gl: WebGL2RenderingContext,
    p: GlProg,
    r: RegimeSets,
    locs: readonly number[],
    floats: number,
    count: number,
  ) {
    gl.bindVertexArray(r.vao);
    const len = p.attr.aLen;
    if (!r.vaoSet) {
      const corner = p.attr.aCorner;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
      if (this.cornersDirty) {
        gl.bufferData(gl.ARRAY_BUFFER, LINE_CORNERS, gl.STATIC_DRAW);
        this.cornersDirty = false;
      }
      gl.enableVertexAttribArray(corner);
      gl.vertexAttribPointer(corner, 3, gl.FLOAT, false, 12, 0);
      for (let i = 0; i <= locs.length; i++) {
        const loc = i < locs.length ? locs[i] : len;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribDivisor(loc, 1);
      }
      r.vaoSet = true;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, r.lineBuf);
    const stride = floats * 4;
    for (let i = 0; i < locs.length; i++) {
      gl.vertexAttribPointer(locs[i], 3, gl.FLOAT, false, stride, i * 12);
    }
    gl.vertexAttribPointer(len, 2, gl.FLOAT, false, stride, locs.length * 12);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, SEGMENT_VERTICES, count);
    gl.bindVertexArray(null);
  }

  /**
   * The mercator draw of one phase. `rise`: the plateau's this frame (a mark
   * on a lid rides it; a ground one stands at its own height). `fillProg`:
   * the layer's hover-fill program, which draws the flat fill. Leaves the
   * depth test and the depth writes on, as it found them.
   */
  drawMercator(
    gl: WebGL2RenderingContext,
    matrix: ArrayLike<number>,
    rise: number,
    phase: MarkPhase,
    fillProg: GlProg | null,
  ) {
    const f = this.tick(this.now());
    const s = this.spec;
    if (!f || !s) return;
    const r = this.merc;
    this.ensure(gl, r, "merc", f.shown);
    const fill = phase === "fill";
    if (fill) {
      if (!fillProg || f.fillA <= 0 || r.fillState !== "ready" || r.fillLate) return;
      if (!r.fill?.fillCount) return;
    } else {
      if (!this.prog || f.lineA <= 0 || f.shown <= 0 || r.lineState !== "ready") return;
      if (!r.line?.segCount) return;
    }
    const origin = (fill ? r.fill : r.line)!.origin;
    const mat = foldOrigin(matrix, origin[0], origin[1], this.mat);
    const lifted = this.lifted();
    // Over a lid: nothing nearer than it — the test off, as for the lines on
    // the lid. On the ground: tested, so a standing plateau hides the far side.
    if (lifted) gl.disable(gl.DEPTH_TEST);
    else gl.enable(gl.DEPTH_TEST);
    // Read, never written: nothing drawn after the mark needs its depth.
    gl.depthMask(false);
    const scale = this.heightScale(phase, rise);
    if (fill && fillProg && r.fill) {
      gl.useProgram(fillProg.prog);
      gl.uniformMatrix4fv(fillProg.uni.uMatrix, false, mat);
      gl.uniform1f(fillProg.uni.uScale, scale);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.fillBuf);
      gl.uniform1f(fillProg.uni.uFillT, fillThreshold(MARK_FILL_SHARE * f.fillA));
      const stride = MARK_FILL_FLOATS * 4;
      gl.enableVertexAttribArray(fillProg.attr.aPos);
      gl.vertexAttribPointer(fillProg.attr.aPos, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(fillProg.attr.aDist);
      gl.vertexAttribPointer(fillProg.attr.aDist, 1, gl.FLOAT, false, stride, 12);
      gl.drawArrays(gl.TRIANGLES, 0, r.fill.fillCount);
      this.fillDrawn = true;
    } else if (this.prog && r.line) {
      const p = this.prog;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.uni.uMatrix, false, mat);
      this.lineUniforms(gl, p, f.lineA, f.shown, scale);
      // On the ground the unit's own boundary line lies at the same height:
      // pulled a hair toward the camera, the loading line wins that tie
      // everywhere and still hides behind a plateau standing in front of it.
      if (!lifted) {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-2, -8);
      }
      this.drawSegments(gl, p, r, this.locs, MARK_LINE_FLOATS, r.line.segCount);
      if (!lifted) gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // As mapbox hands a "3d" layer its frame: tested and written.
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /**
   * The globe draw of one phase, for the layer's ground pass (`raised`
   * false: before the walls and the lid) or its raised pass (after them): a
   * mark draws in the one that is its own. No depth test on the globe.
   * `rise`: the plateau's this frame. `fillProg`: the layer's globe
   * hover-fill program.
   */
  drawGlobe(
    gl: WebGL2RenderingContext,
    binders: GlobeBinders,
    raised: boolean,
    rise: number,
    phase: MarkPhase,
    fillProg: GlProg | null,
  ) {
    if (!this.spec || this.lifted() !== raised) return;
    const f = this.tick(this.now());
    const s = this.spec;
    if (!f || !s) return;
    const r = this.globe;
    this.ensure(gl, r, "globe", f.shown);
    const scale = this.heightScale(phase, rise);
    const { setCommon, bindTriple } = binders;
    if (phase === "fill") {
      if (!fillProg || f.fillA <= 0 || r.fillState !== "ready" || r.fillLate) return;
      if (!r.fill?.fillCount) return;
      setCommon(fillProg);
      gl.uniform1f(fillProg.uni.uScale, scale);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.fillBuf);
      gl.uniform1f(fillProg.uni.uFillT, fillThreshold(MARK_FILL_SHARE * f.fillA));
      const stride = G_MARK_FILL_FLOATS * 4;
      bindTriple(fillProg, stride);
      gl.enableVertexAttribArray(fillProg.attr.aDist);
      gl.vertexAttribPointer(fillProg.attr.aDist, 1, gl.FLOAT, false, stride, 36);
      gl.drawArrays(gl.TRIANGLES, 0, r.fill.fillCount);
      this.fillDrawn = true;
      return;
    }
    const p = this.gProg;
    if (!p || f.lineA <= 0 || f.shown <= 0 || r.lineState !== "ready") return;
    if (!r.line?.segCount) return;
    setCommon(p);
    this.lineUniforms(gl, p, f.lineA, f.shown, scale);
    this.drawSegments(gl, p, r, this.gLocs, G_MARK_LINE_FLOATS, r.line.segCount);
  }
}
