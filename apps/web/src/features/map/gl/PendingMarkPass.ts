// The PENDING mark: what a tapped territory wears from the tap until its
// plateau rises — a flat violet fill over its surface and, along its
// boundary, a loading line that covers the share of the boundary's length
// the data of its plateau has reached. A pass of PlateauWallLayer's with
// buffers of its own, the way the selection retract has its own: nothing the
// plateau's mesh does to itself (a rebuild at the commit, the hover fill's
// single buffer, the rise's scale gates) can take the mark away.
//
// The sequence (the caller drives it):
// - `set`: the fill at once. The line, under `ac:tap-fast=hide` (the
//   default: `showAfterMs`), is not drawn yet: it becomes due that long
//   after the first frame that drew the mark, and turns on, from nothing,
//   in the first frame that can draw it — unless the data was all in before
//   that: then this mark has no line at all (a wait too short to be read is
//   not drawn as a flash). Under "show" the line is on from `set`, at the
//   progress given;
// - `setProgress`: a real step — the line runs to its new length at a
//   constant speed (`lineFullMs` for the whole boundary, never less than
//   `stepMs` a step; under "show": an ease over `stepMs`, 0: it jumps); a
//   step that comes during a run retargets it from the value shown. Never
//   ahead of the data;
// - `finish`: the data is all in — the line, if it is on, runs to the whole
//   boundary. Under "then" the fill leaves against the REAL start of the
//   rise (`riseEta`, the plateau's: the old plateau's sink, the camera's
//   landing where the rise waits for it): never before a frame has shown the
//   whole line, it fades (`unfillMs`, linear) so as to reach
//   MARK_UNFILL_FLOOR of itself when the rise can start, stays there until
//   the plateau says the rise is cleared (`gateMs(true)`), and the rest
//   leaves then. `gateMs()` is what is left until the fill is gone, which
//   the plateau's rise waits for: no violet rides a rising lid, and the unit
//   is never bare and flat for more than a frame or two. A rise whose start
//   is not known keeps the fill whole until it is cleared. Reduced motion,
//   where nothing eases or fades: two plain steps instead — the line whole
//   over the fill (held MARK_REDUCED_HOLD_MS), then the fill gone
//   (MARK_REDUCED_GAP_MS before the rise);
// - `release`: the plateau starts to rise — the line rides the new lid and
//   fades (`outMs`); under "together" the fill too; under "then" what is
//   left of the fill goes at once;
// - `dropLine`: the file the line measured will not come, the plateau rises
//   without it — the line fades where it stands, the fill stays and leaves
//   by the rule above;
// - `drain`: no plateau came with the data the line measured (a long wait
//   turned late) — both fade where they stand, the line short of the whole
//   boundary; `clear`: at once.
//
// Never a frame of its own accord while nothing moves: a repaint is asked
// once per change and for the frames of a run or a fade — bounded loops,
// as the hover sweep's and the retract's are (PlateauWallLayer.fillSweepT).
// A still map with a mark held, its line full or waiting, or its fill at
// the floor, draws no frame: what is owed later (the line due, the fade's
// start) is a timer. Under short motion a run asks a frame every
// `frameGapMs` only, while the map draws none of its own.
// (`ac:tap-steps=creep` alone adds a tick's frames, a few a second, for the
// first MARK_CREEP_FREEZE_MS after the tap, and none after.) Progress is a
// uniform: nothing is rebuilt while the line moves, nor when the mark goes
// from the ground to a lid (the meshes stand at a reference height, the
// draw scales it: gl/pendingMark.ts).
//
// Where the meshes are built (gl/pendingMark.ts markBuildPlace): a small
// unit's on the page, in the first frame that draws them, the fill and the
// line from one projection of the outline. A wide unit's on the globe (a
// country from the world view) the same, its fill plain — the bisection is
// what costs — and the bisected fill, asked off the frame behind the unit's
// own mesh, takes its place when it lands (never ahead of the plateau's
// mesh: the tap's frame and the mesh stay as light as for any other unit).
// A large unit's (more than 4,000 boundary vertices: six countries' world
// outlines, the finest unit files) are never triangulated in the tap's
// frame: that frame fills it with a stand-in — its outline thinned to about
// 1,500 vertices (gl/pendingMark.ts buildMarkStandIn), the cost of a small
// unit's — so its violet is there as soon as any unit's; its real fill and
// its line are built off the frame — by the mesh worker (`setProvider`) or,
// without one, in a task of the page's own after the frame — and take
// their place when they land (one or two frames later on a desktop, up to
// about 200 ms on a weak phone: the line of such a unit starts then). Only
// the regime being drawn is built, and never a fill that can no longer
// show. A fill still fading on screen when the camera crosses zoom 6 (a mark
// released under "together", or draining, during a flight) is built in the
// regime it enters the same way — a large unit's as its stand-in — so the
// violet fades on to its end there. The meshes are kept for the geometry last marked, so « Réessayer »
// and a second tap rebuild nothing, and dropped with the pending state
// (`forget`) or when another geometry is marked; the GPU's copies are
// emptied by the next frame.
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
  MARK_REDUCED_GAP_MS,
  MARK_REDUCED_HOLD_MS,
  MARK_UNFILL_FLOOR,
  MARK_WHOLE_UNSEEN_MS,
  MARK_REF_M,
  buildMark,
  buildMarkFill,
  buildMarkLine,
  buildMarkStandIn,
  creepShown,
  easeStep,
  fadeAlpha,
  fillThreshold,
  lineEaseMs,
  lineRun,
  markBuildPlace,
  markLidFillM,
  markLidLineM,
  markLineWidth,
  ringVertexCount,
  unfillAlpha,
  unfillEnd,
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
  /** The line also slides a little ahead of what has arrived, over the
   *  first seconds after the tap (`ac:tap-steps`), a repaint asked every
   *  `creepTickMs` at most (MARK_CREEP_TICK_MS by default). */
  creep: boolean;
  creepTickMs?: number;
  /** `ac:tap-fast=hide`: the line is not drawn until this long after the
   *  first frame that drew the mark, ms, and never if the data is all in
   *  before it is on. Absent or 0: the line is on from `set`. */
  showAfterMs?: number;
}

/** How the mark moves now (the page's motion setting). `animate` false
 *  (reduced motion): no run and no fade — plain steps. `lineFullMs` > 0:
 *  the line runs at a constant speed, the whole boundary in that long, a
 *  step never in less than `stepMs`; absent or 0: an ease over `stepMs`
 *  (0: the line jumps). `frameGapMs` > 0: a run asks a frame that often
 *  only (short motion), not every frame. */
export interface MarkMotion {
  animate: boolean;
  stepMs: number;
  unfillMs: number;
  outMs: number;
  lineFullMs?: number;
  frameGapMs?: number;
}

/** When the rise of a unit's plateau can start, as far as the plateau knows
 *  (plateau/riseEta.ts): `at`, a clock time; `landing`: it is the end of the
 *  camera's flight, told a frame after it. */
export interface MarkRiseEta {
  at: number;
  landing: boolean;
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
  /** When the rise of unit `id` can start (null: not known — the fill then
   *  stays whole until the rise is cleared). Absent: the fill leaves as soon
   *  as the data is all in and the whole line was shown, with no floor. */
  riseEta?(id: string): MarkRiseEta | null;
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
  /** The fill is a first one built in the tap's frame — the plain one of a
   *  wide unit on the globe, a large unit's stand-in: its final one is
   *  still to take its place. */
  fillPlain: boolean;
  /** The final meshes have been asked off the frame and not answered yet. */
  refineAsked: boolean;
  /** A large unit's stand-in was tried for this geometry. */
  standInTried: boolean;
  /** The mark (its number) a large unit's meshes were last asked for: once
   *  a mark, whatever the answer. */
  askedFor: number;
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
  standInTried: false,
  askedFor: 0,
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
  /** The marks set so far: this one's number. */
  private markNo = 0;
  // ---- the line's progress: an ease from `from` to `goal`, begun at `easeT0` ----
  private target = 0;
  private from = 0;
  private goal = 0;
  private easeT0 = 0;
  private easeMs = 0;
  /** The run under way is at a constant speed (else an ease-out). */
  private linear = false;
  /** How the mark moves: the motion given last (`set`, a step, `finish`). */
  private motion: MarkMotion | null = null;
  // ---- when the line shows (ac:tap-fast) ----
  /** The first frame that drew this mark (0: none yet). */
  private markSeenAt = 0;
  /** The line is to be drawn from the next frame that can draw it. */
  private lineDue = false;
  /** The line is on screen (turned on in a frame, or at `set`). */
  private lineOn = false;
  /** This mark has no line, or no longer: the data was all in before it was
   *  on, or it was dropped. */
  private lineSkipped = false;
  private lineOutT0 = 0;
  private lineOutMs = 0;
  // ---- the end ----
  private finished = false;
  /** `finish` was told (a `release` with no verdict told also ends the line). */
  private told = false;
  private finishedAt = 0;
  private order: "then" | "together" = "then";
  /** When the line's last run ends, and the first frame that showed it whole. */
  private wholeAt = 0;
  private wholeSeenAt = 0;
  /** The unfill: begun at `unfillT0` (0: not yet), down to `floor` until
   *  the rise is cleared (`goAt`, 0: not yet). */
  private unfillT0 = 0;
  private unfillMs = 0;
  private floor = 0;
  private goAt = 0;
  /** Reduced motion: how long the whole line is held over the fill before
   *  the fill goes… */
  private holdMs = 0;
  /** …and what the rise still waits for once the fill is gone (the
   *  unfilled unit is seen before it rises). */
  private gateTailMs = 0;
  private outT0 = 0;
  private outMs = 0;
  private outLidM = 0;
  /** When the mark was set (the creep's lead counts from it). */
  private setAt = 0;
  // ---- what the testing tools read ----
  private fillDrawn = false;
  private fillVia: "page" | "stand-in" | "deferred" | "worker" | null = null;
  private fillLateMs: number | null = null;
  private linked: boolean | null = null;

  /** The regime last made ready for a frame (null: no frame since the mark was set). */
  private regime: MarkRegime | null = null;
  private capTimer: unknown = null;
  private creepTimer: unknown = null;
  /** The line due; a run's next frame under short motion; the fade's start;
   *  a whole line no frame has shown. */
  private showTimer: unknown = null;
  private frameTimer: unknown = null;
  private fadeTimer: unknown = null;
  private wholeTimer: unknown = null;
  /** The last frame's time and the frames' mean interval, ms. */
  private frameAt = 0;
  private frameMs = 16.7;
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
  private readonly riseEta: ((id: string) => MarkRiseEta | null) | null;
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
    this.riseEta = d.riseEta ?? null;
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
    return this.fillByFrame(regime);
  }

  /** A fill not there yet that the first frame in `regime` builds on the
   *  page: a small unit's own, a large unit's stand-in. */
  private fillByFrame(regime: MarkRegime): boolean {
    const s = this.spec;
    if (!s || !s.fill || this.vertices < 3) return false;
    const r = regime === "merc" ? this.merc : this.globe;
    if (r.fill || r.fillLate) return false;
    if (markBuildPlace(this.vertices, s.spanDeg, regime) !== "off-frame") {
      return r.fillState === "none";
    }
    return !r.standInTried && (r.fillState === "none" || r.fillState === "pending");
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
      lineOn: this.lineOn,
      lineSkipped: this.lineSkipped,
      seenAt: this.markSeenAt,
      wholeSeenAt: this.wholeSeenAt,
      unfillT0: this.unfillT0,
      goAt: this.goAt,
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
  set(spec: PendingMarkSpec, progress = 0, regime?: MarkRegime, motion?: MarkMotion) {
    const held = this.spec;
    if (
      held &&
      this.phase === "held" &&
      held.id === spec.id &&
      this.keptG === spec.g &&
      held.line === spec.line &&
      held.fill === spec.fill &&
      held.raised === spec.raised
    ) {
      // The same unit marked again while its mark is held (tapped once
      // more): the line, the end and the fade under way are left as they are.
      this.keep = true;
      return;
    }
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
    this.markNo++;
    this.spec = spec;
    this.phase = "held";
    const now = this.now();
    this.motion = motion ?? null;
    this.target = clamp01(progress);
    // On from the start ("show"), or due later (`showAfterMs`): from nothing.
    this.lineDue = this.lineOn = !((spec.showAfterMs ?? 0) > 0);
    this.lineSkipped = false;
    this.lineOutT0 = 0;
    this.lineOutMs = 0;
    this.markSeenAt = 0;
    this.from = this.goal = this.lineOn ? this.target : 0;
    this.easeT0 = 0;
    this.easeMs = 0;
    this.linear = false;
    this.finished = false;
    this.told = false;
    this.finishedAt = 0;
    this.order = "then";
    this.wholeAt = 0;
    this.wholeSeenAt = 0;
    this.unfillT0 = 0;
    this.unfillMs = 0;
    this.floor = 0;
    this.goAt = 0;
    this.holdMs = 0;
    this.gateTailMs = 0;
    this.outT0 = 0;
    this.outMs = 0;
    this.setAt = now;
    this.frameAt = 0;
    this.fillDrawn = false;
    this.fillVia = null;
    this.fillLateMs = null;
    this.regime = null;
    if (spec.creep) this.armCreep();
    if (regime) this.askAhead(regime);
    this.repaint();
  }

  /** A large unit's meshes asked off the frame, if they are neither there
   *  nor on their way (nor failed for this geometry) — once a mark: an
   *  answer that left the regime incomplete (the data was all in, nothing
   *  was triangulated) is not asked for again by every frame. */
  private askAhead(regime: MarkRegime) {
    const s = this.spec;
    if (!s) return;
    const r = regime === "merc" ? this.merc : this.globe;
    if (markBuildPlace(this.vertices, s.spanDeg, regime) !== "off-frame") return;
    if (r.refineAsked || r.fillState === "failed" || r.lineState === "failed") return;
    const whole = r.fillState === "ready" && !r.fillPlain && r.lineState === "ready";
    if (whole || r.askedFor === this.markNo) return;
    r.askedFor = this.markNo;
    r.refineAsked = true;
    if (r.fillState === "none") r.fillState = "pending";
    if (r.lineState === "none") r.lineState = "pending";
    // The tap's own request goes ahead of the builds queued; a later one
    // (the other regime) behind them.
    const front = !this.asked;
    this.asked = true;
    this.ask(s.g, regime, front);
  }

  /** A real step: the line goes to `target` (never back), running from
   *  where its real value stands now. A line not on yet keeps the target. */
  setProgress(target: number, motion: MarkMotion) {
    if (!this.spec || this.phase !== "held" || this.finished) return;
    const t = clamp01(target);
    if (t <= this.target) return;
    this.step(t, motion, this.realAt(this.now()));
    this.repaint();
  }

  /** The run to `target`, from `from` (what the line shows of real data
   *  now — at the end, what it shows in all, so a creep's lead is never
   *  given back). A line that is not on only keeps the target. */
  private step(target: number, motion: MarkMotion, from: number) {
    this.target = target;
    this.motion = motion;
    if (!this.lineOn || this.lineSkipped) return;
    this.run(from, target);
  }

  /** The line's run from `from` to `to`: at a constant speed
   *  (`lineFullMs`), an ease (`stepMs`), or a jump. */
  private run(from: number, to: number) {
    const m = this.motion;
    this.goal = Math.max(to, from);
    const full = m?.lineFullMs ?? 0;
    if (m && m.animate && this.goal > from && (full > 0 || m.stepMs > 0)) {
      this.from = from;
      this.easeT0 = this.now();
      this.linear = full > 0;
      this.easeMs = full > 0 ? lineEaseMs(from, this.goal, full, m.stepMs) : m.stepMs;
    } else {
      this.from = this.goal;
      this.easeT0 = 0;
      this.easeMs = 0;
    }
  }

  /** A frame is being drawn: the first one of this mark starts the line's
   *  clock; the frames' interval is kept (what "a frame later" is worth). */
  private sawFrame(now: number) {
    const d = now - this.frameAt;
    if (this.frameAt && d >= 4 && d < 200) {
      this.frameMs = Math.min(100, Math.max(8, 0.7 * this.frameMs + 0.3 * d));
    }
    if (!this.frameAt || d >= 4) this.frameAt = now;
    if (!this.markSeenAt) {
      this.markSeenAt = now;
      this.armShow();
    }
  }

  /** The line becomes due `showAfterMs` after the mark's first frame (one
   *  timer, one repaint) — unless it is on, or will never be. */
  private armShow() {
    const s = this.spec;
    this.clearTimer(this.showTimer);
    this.showTimer = null;
    if (!s || !s.line || this.lineDue || this.lineSkipped || this.finished) return;
    if (this.phase !== "held" || !this.markSeenAt) return;
    const left = Math.max(0, this.markSeenAt + (s.showAfterMs ?? 0) - this.now());
    this.showTimer = this.setTimer(() => {
      this.showTimer = null;
      if (!this.spec || this.lineSkipped || this.finished || this.phase !== "held") return;
      this.lineDue = true;
      this.repaint();
    }, left);
  }

  /** A due line turns on in a frame whose regime has its segments: that
   *  frame draws nothing of it and starts its run to the real value. */
  private turnOn(r: RegimeSets) {
    const s = this.spec;
    if (!s || !s.line || this.lineOn || !this.lineDue || this.lineSkipped) return;
    if (this.phase !== "held" || this.finished) return;
    if (r.lineState !== "ready" || !r.line?.segCount) return;
    this.lineOn = true;
    this.from = this.goal = 0;
    if (this.motion?.animate) this.run(0, this.target);
    else this.from = this.goal = this.target;
  }

  /**
   * The data is all in. A line on screen runs to the whole boundary; one
   * that is not on yet never comes for this mark. Under "then" the fill then
   * leaves against the rise's real start (`scheduleFade`). Once per mark.
   */
  finish(motion: MarkMotion, order: "then" | "together") {
    if (!this.spec || this.phase !== "held" || this.finished) return;
    const now = this.now();
    this.motion = motion;
    if (this.lineOn && !this.lineSkipped) {
      this.step(1, motion, this.shownAt(now));
      this.wholeAt = this.easeMs > 0 ? this.easeT0 + this.easeMs : now;
      this.armWhole();
    } else {
      this.target = 1;
      this.lineSkipped = true;
      this.clearTimer(this.showTimer);
      this.showTimer = null;
      this.wholeAt = now;
    }
    this.finished = true;
    this.told = true;
    this.finishedAt = now;
    this.order = order;
    this.stopCreep();
    this.unfillMs = motion.animate ? Math.max(0, motion.unfillMs) : 0;
    // The floor is held for a rise the plateau tells of; reduced motion's
    // plain steps have none.
    this.floor = order === "then" && this.riseEta && this.unfillMs > 0 ? MARK_UNFILL_FLOOR : 0;
    this.holdMs = motion.animate ? 0 : MARK_REDUCED_HOLD_MS;
    this.gateTailMs = motion.animate ? 0 : MARK_REDUCED_GAP_MS;
    this.armCap(MARK_LINE_HOLD_CAP_MS);
    this.scheduleFade();
    this.repaint();
  }

  /** No frame may ever show the whole line (a hidden tab): it counts as
   *  seen MARK_WHOLE_UNSEEN_MS after its run's end all the same. */
  private armWhole() {
    this.clearTimer(this.wholeTimer);
    this.wholeTimer = this.setTimer(
      () => {
        this.wholeTimer = null;
        if (!this.spec || this.wholeSeenAt) return;
        this.wholeSeenAt = this.now();
        this.scheduleFade();
      },
      Math.max(0, this.wholeAt - this.now()) + MARK_WHOLE_UNSEEN_MS,
    );
  }

  /** The mark has a line on screen that is to be seen whole before the end. */
  private lined(): boolean {
    return this.lineOn && !this.lineSkipped;
  }

  /**
   * When the fill starts to leave ("then"): never before a frame has shown
   * the whole line (reduced motion: held `holdMs` over the fill), and so
   * that it is at the floor when the rise can start (`riseEta`, read again
   * when the timer fires: a rise put off puts the fade off). A rise whose
   * start is not known: the fade waits for it to be cleared (`gateMs(true)`).
   * One timer, no frame until the fade begins.
   */
  private scheduleFade(fromTimer = false) {
    const s = this.spec;
    if (!s || this.phase !== "held" || !this.told || this.order !== "then" || this.unfillT0) return;
    const lined = this.lined();
    if (lined && !this.wholeSeenAt) return;
    const now = this.now();
    this.clearTimer(this.fadeTimer);
    this.fadeTimer = null;
    const min = lined ? this.wholeSeenAt + this.holdMs : this.finishedAt;
    let at = Math.max(now, min);
    // A timer that fires within a frame of the rise's (new) start begins.
    let slack = 0.5;
    if (!this.goAt && this.riseEta) {
      const eta = this.riseEta(s.id);
      if (!eta) return;
      const lead = this.unfillMs > 0 ? (1 - this.floor) * this.unfillMs : this.gateTailMs;
      const byEta = eta.at + (eta.landing ? this.frameMs : 0) - lead;
      if (byEta > at) {
        at = byEta;
        if (fromTimer) slack = this.frameMs;
      }
    }
    if (at - now <= slack) {
      this.unfillT0 = now;
      this.repaint();
      return;
    }
    this.fadeTimer = this.setTimer(() => {
      this.fadeTimer = null;
      this.scheduleFade(true);
    }, at - now);
  }

  /** A safety: a full line whose plateau never rises does not stay. */
  private armCap(ms: number) {
    this.clearTimer(this.capTimer);
    this.capTimer = this.setTimer(() => {
      this.capTimer = null;
      if (this.spec && this.phase === "held") this.end(true);
    }, ms);
  }

  /**
   * How long the plateau's rise still waits for the mark, ms: for a line on
   * screen to have been shown whole and, under "then", for the fill to be
   * gone (0 with no fill on screen and none about to be) — or, draining,
   * what is left of that fade. `cleared`: the plateau says everything else
   * the rise waits for is satisfied — the go: the fill's fade begins now or
   * runs on past its floor, and the answer is what is left of it. Without
   * `cleared` it is a plain query, nothing changes.
   */
  gateMs(cleared = false): number {
    const s = this.spec;
    const now = this.now();
    if (s && this.phase === "draining") {
      return this.fillDrawn && s.fill ? Math.max(0, this.outT0 + this.outMs - now) : 0;
    }
    if (!s || this.phase !== "held" || !this.told) return 0;
    const lined = this.lined();
    // A frame is still to show the whole line.
    const whole = lined && !this.wholeSeenAt ? Math.max(0, this.wholeAt - now) + this.frameMs : 0;
    if (this.order !== "then") return whole;
    if (!this.fillDrawn && !this.fillComes()) return whole;
    if (cleared && !this.goAt) {
      this.goAt = now;
      this.scheduleFade();
      this.repaint();
    }
    if (!this.unfillT0) {
      return whole + (lined ? this.holdMs : 0) + this.unfillMs + this.gateTailMs;
    }
    const end = unfillEnd(this.unfillT0, this.unfillMs, this.floor, this.goAt || now);
    return Math.max(0, end + this.gateTailMs - now);
  }

  /** A fill not drawn yet that the next frame draws: ready, or built by that
   *  frame — in the regime last drawn or, before any frame, in either. */
  private fillComes(): boolean {
    const s = this.spec;
    if (!s || !s.fill || this.vertices < 3) return false;
    for (const regime of this.regime ? [this.regime] : (["merc", "globe"] as const)) {
      if (this.ownsFill(regime) || this.fillByFrame(regime)) return true;
    }
    return false;
  }

  /**
   * The marked unit's plateau starts to rise, its lid `lidM` metres up: the
   * line moves onto that lid and fades as it rises — with the fill under
   * "together", or when no verdict was told; under "then" what is left of
   * the fill goes at once (the gate has passed: no violet rides the lid) —
   * or the mark goes at once (`motion.animate` false).
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
    // No verdict told: a line on screen is full all the same.
    if (!this.finished) this.step(1, motion, this.shownAt(this.now()));
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

  /** The file the line measured will not come and the plateau rises
   *  without it: the line fades where it stands (`outMs`; at once under
   *  reduced motion) and never comes back for this mark; the fill stays,
   *  and leaves by `finish`'s rule. */
  dropLine(motion: MarkMotion) {
    if (!this.spec || this.phase !== "held" || this.lineSkipped) return;
    const now = this.now();
    const shown = this.shownAt(now);
    this.lineSkipped = true;
    this.clearTimer(this.showTimer);
    this.showTimer = null;
    this.clearTimer(this.frameTimer);
    this.frameTimer = null;
    this.stopCreep();
    if (this.lineOn && motion.animate && shown > 0) {
      // Frozen where it stands, and fading.
      this.from = this.goal = shown;
      this.easeMs = 0;
      this.lineOutT0 = now;
      this.lineOutMs = Math.max(0, motion.outMs);
    } else this.lineOn = false;
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
      r.fillPlain = r.refineAsked = r.standInTried = false;
      r.askedFor = 0;
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
    this.clearTimer(this.showTimer);
    this.showTimer = null;
    this.clearTimer(this.frameTimer);
    this.frameTimer = null;
    this.clearTimer(this.fadeTimer);
    this.fadeTimer = null;
    this.clearTimer(this.wholeTimer);
    this.wholeTimer = null;
    this.stopCreep();
  }

  // ---- ac:tap-steps=creep: a tick asks for a frame while the line's lead
  // grows (the first MARK_CREEP_FREEZE_MS after the mark was set), unless
  // the map drew one of its own since the tick before (a flight, an ease);
  // it stops with the lead, and no later step starts it again ----
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
      if (this.now() - this.setAt >= MARK_CREEP_FREEZE_MS) {
        // The lead has stopped: one last frame at its resting value.
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

  /** The share of the boundary the real data has the line at `now` (its
   *  run from one real step to the next). */
  private realAt(now: number): number {
    if (this.easeMs <= 0) return this.goal;
    const t = (now - this.easeT0) / this.easeMs;
    return this.linear ? lineRun(this.from, this.goal, t) : easeStep(this.from, this.goal, t);
  }

  /** The share of the boundary the line covers `now`: nothing until it is
   *  on; then the real value and, under the creep, its small lead until the
   *  data is all in. */
  private shownAt(now: number): number {
    if (!this.lineOn) return 0;
    const real = this.realAt(now);
    if (!this.spec?.creep || this.finished || this.lineSkipped) return real;
    return creepShown(real, now - this.setAt);
  }

  private fillAlphaAt(now: number): number {
    const s = this.spec;
    if (!s || !s.fill) return 0;
    // Its plateau rises after the verdict under "then": nothing rides the lid.
    if (this.phase === "released" && this.told && this.order === "then") return 0;
    const out = this.phase === "held" ? 1 : fadeAlpha(now, this.outT0, this.outMs);
    return unfillAlpha(now, this.unfillT0, this.unfillMs, this.floor, this.goAt) * out;
  }

  private lineAlphaAt(now: number): number {
    const s = this.spec;
    if (!s || !s.line) return 0;
    const drop = this.lineOutT0 ? fadeAlpha(now, this.lineOutT0, this.lineOutMs) : 1;
    return drop * (this.phase === "held" ? 1 : fadeAlpha(now, this.outT0, this.outMs));
  }

  /** A run under way asks for its next frame: every frame, or — under short
   *  motion — one every `frameGapMs` and one at its end, by a timer (frames
   *  the map draws of its own meanwhile show the line where it is). */
  private askRunFrame(now: number) {
    const gap = this.motion?.frameGapMs ?? 0;
    if (gap <= 0) {
      this.repaint();
      return;
    }
    if (this.frameTimer !== null) return;
    const left = this.easeT0 + this.easeMs - now;
    this.frameTimer = this.setTimer(
      () => {
        this.frameTimer = null;
        if (this.spec) this.repaint();
      },
      Math.max(1, Math.min(gap, left)),
    );
  }

  /** This frame's values, in regime `r`; the next frame asked for while
   *  something moves (a run, a fade: bounded); null: the mark is over. */
  private tick(now: number, r: RegimeSets) {
    const s = this.spec;
    if (!s) return null;
    if (this.phase !== "held" && fadeAlpha(now, this.outT0, this.outMs) <= 0) {
      this.end(false);
      return null;
    }
    this.sawFrame(now);
    this.turnOn(r);
    const shown = this.shownAt(now);
    // The first frame that shows the whole line: the fill may leave after it.
    if (this.told && !this.wholeSeenAt && this.lined() && shown >= 1) {
      this.wholeSeenAt = now;
      this.clearTimer(this.wholeTimer);
      this.wholeTimer = null;
      this.scheduleFade();
    }
    const fillA = this.fillAlphaAt(now);
    const running = this.lineOn && this.easeMs > 0 && now < this.easeT0 + this.easeMs;
    // The fill's fade moves: down to its floor, or — cleared — to nothing.
    const unfilling =
      this.phase === "held" &&
      this.unfillT0 > 0 &&
      this.unfillMs > 0 &&
      fillA > (this.goAt ? 0 : this.floor);
    const dropping = this.lineOutT0 > 0 && now < this.lineOutT0 + this.lineOutMs;
    if (this.phase !== "held" || unfilling || dropping) this.repaint();
    else if (running) this.askRunFrame(now);
    return { fillA, lineA: this.lineAlphaAt(now), shown };
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
      if (this.finished) {
        this.armCap(MARK_LINE_HOLD_CAP_MS);
        // The fade still owed, and the whole line's own wait.
        if (this.told && this.lined() && !this.wholeSeenAt) this.armWhole();
        this.scheduleFade();
      } else {
        if (this.spec.creep && this.now() - this.setAt < MARK_CREEP_FREEZE_MS) this.armCreep();
        if (this.markSeenAt) this.armShow();
      }
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
        const s = this.spec;
        const held = !!s && s.g === g && this.phase === "held";
        if (!held || this.finished) {
          // Nothing is triangulated for a mark that can no longer show it
          // (it is on its way out, or its data is all in: a first fill
          // stands as it is). A mark held with its line full and no
          // segments yet gets them alone. The regime is left to be asked
          // again by a later mark of this geometry.
          r.refineAsked = false;
          if (r.fillState === "pending") r.fillState = "none";
          if (r.lineState === "ready") return;
          let line: MarkLine | null = null;
          if (held && s.line && !this.lineSkipped) {
            try {
              line = buildMarkLine(g, regime);
            } catch {
              line = null;
            }
          }
          r.line = line;
          r.lineState = line ? "ready" : "none";
          r.lineDirty = line !== null;
          if (line) this.repaint();
          return;
        }
        if (r.lineState === "ready") {
          // The final fill alone: the line stands.
          let fill: MarkFill | null = null;
          try {
            fill = buildMarkFill(g, regime);
          } catch {
            fill = null;
          }
          this.land(g, regime, fill, null, "deferred");
          return;
        }
        let built: MarkBuffers | null = null;
        try {
          built = buildMark(g, regime);
        } catch {
          built = null;
        }
        this.land(g, regime, built?.fill ?? null, built?.line ?? null, "deferred");
      });
    const provider = this.provider;
    if (!provider?.live()) return onPage();
    void provider
      .build(g, regime, front)
      .then((b) => (b ? this.land(g, regime, b.fill, b.line, "worker") : onPage()), onPage);
  }

  /**
   * Meshes built off the frame have landed (null: that one failed, or was
   * not built): kept if they are still the marked geometry's. The fill takes
   * the place of a first one drawn in the tap's frame (a large unit's
   * stand-in, a wide unit's plain fill: the same violet, on the true
   * boundary, without a seam) or, when none was, joins a mark still waiting
   * for its data — or whose violet has not left it yet. The line joins
   * unless the page built it already.
   */
  private land(
    g: MarkGeometry,
    regime: MarkRegime,
    fill: MarkFill | null,
    line: MarkLine | null,
    via: "deferred" | "worker",
  ) {
    if (this.keptG !== g) return;
    const r = regime === "merc" ? this.merc : this.globe;
    r.refineAsked = false;
    const first = r.fillState === "ready"; // a first fill is drawn already
    if (r.lineState !== "ready") {
      r.line = line?.segCount ? line : null;
      r.lineState = r.line ? "ready" : "failed";
      r.lineDirty = r.line !== null;
    }
    if (fill?.fillCount) {
      r.fill = fill;
      r.fillState = "ready";
      r.fillDirty = true;
      r.fillPlain = false;
    } else if (!first) r.fillState = "failed";
    const s = this.spec;
    if (!s || s.g !== g) return;
    if (!first && r.fillState === "ready") {
      if (this.fillCanShow()) {
        if (this.fillVia === null) {
          this.fillVia = via;
          this.fillLateMs = this.now() - this.setAt;
        }
        if (s.fill) this.onFill(s.id);
      } else r.fillLate = true;
    }
    this.repaint();
  }

  /** Whether a fill that comes now can still show: the mark is held, and
   *  its violet has not begun to leave it (the data all in, under "then"). */
  private fillCanShow(): boolean {
    return this.phase === "held" && !(this.told && this.order === "then" && this.unfillT0 > 0);
  }

  /** Whether a fill on screen is still fading with a mark on its way out
   *  (released under "together", or draining): a regime first drawn then
   *  (the flight crosses zoom 6 during the fade) gets a fill too, so the
   *  violet fades on to its end rather than stopping at the crossing. */
  private fillFading(): boolean {
    return this.phase !== "held" && this.fillDrawn && this.fillAlphaAt(this.now()) > 0;
  }

  /** A regime's meshes for this frame: built here for a small unit, asked
   *  off the frame for a large one (its stand-in fill built here), uploaded
   *  when new. */
  private ensure(gl: WebGL2RenderingContext, r: RegimeSets, regime: MarkRegime, shown: number) {
    const s = this.spec;
    if (!s) return;
    this.regime = regime;
    const place = markBuildPlace(this.vertices, s.spanDeg, regime);
    // A fill that can no longer show is not built: a regime first drawn
    // then (a flight across zoom 6) needs the line alone. One still fading
    // on screen is: a small unit's here, a large unit's as its stand-in
    // (its real fill, asked of the worker, takes its place if it lands
    // before the fade ends; the page's own task builds none).
    const fillShows = this.fillCanShow() || this.fillFading();
    if (place !== "off-frame") {
      // A wide unit on the globe: its fill plain in this frame.
      const bisect = place === "page";
      const wantFill = s.fill && r.fillState === "none" && fillShows;
      // The line with the fill, from one projection of the outline — so its
      // build is never a later frame's — or alone once it is due or at its
      // first progress. Never for a mark whose line will not show.
      const wantLine =
        s.line &&
        !this.lineSkipped &&
        r.lineState === "none" &&
        (wantFill || shown > 0 || (this.lineDue && !this.lineOn));
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
    } else {
      this.askAhead(regime);
      // The stand-in: the unit's violet in this frame, whatever the real
      // fill's build takes.
      if (fillShows && this.fillByFrame(regime)) {
        r.standInTried = true;
        let fill: MarkFill | null = null;
        try {
          fill = buildMarkStandIn(s.g, regime, this.vertices);
        } catch {
          fill = null;
        }
        if (fill) {
          r.fill = fill;
          r.fillState = "ready";
          r.fillDirty = true;
          r.fillPlain = true;
          if (this.fillVia === null) this.fillVia = "stand-in";
        }
      }
    }
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
   * instanced vec3 attributes in buffer order, then `aLen` (a vec3 too: the
   * two lengths and the ring's depth).
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
    gl.vertexAttribPointer(len, 3, gl.FLOAT, false, stride, locs.length * 12);
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
    const r = this.merc;
    const f = this.tick(this.now(), r);
    const s = this.spec;
    if (!f || !s) return;
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
    const r = this.globe;
    const f = this.tick(this.now(), r);
    const s = this.spec;
    if (!f || !s) return;
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
