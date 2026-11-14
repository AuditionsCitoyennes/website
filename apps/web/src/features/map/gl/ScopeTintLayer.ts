// The flat view's grey: a custom WebGL layer, one mesh of the whole mercator
// world with the selection cut out (the globe's grey is the draped sheet,
// GeoDrillMap's). Also the grey's two measures both renderers share: its
// opacity, and what the draped sheet's colour looks like on screen.

import type mapboxgl from "mapbox-gl";
import { perfNote, perfOn, perfSpan } from "@/shared/perf/perf";
import { tintCut } from "../threadSwitch";
import { digestParts } from "./meshDigest";
import { buildProgram, type GlProg, type MapFogInternals } from "./program";
import { createTintCuts, type TintCutFn } from "./tintCuts";
import { cutTintSheet, type MaskGeom, type TintSheet } from "./tintSheet";

export type { MaskGeom } from "./tintSheet";
export { sameGeoms } from "./tintCuts";

/** ac:tint-cut=worker: who cuts the sheet off the page (the mesh worker,
 *  gl/meshClient.ts; `ms`: the cut's own time). Null: no sheet (the worker
 *  lost, or the cut superseded) — cut here if it is still wanted. `live()`
 *  false before the worker is there and once it is lost. */
export type TintCutter = { live(): boolean; cut: TintCutFn };

/** The grey's opacity — the draped sheet's (`fill-opacity`) and the GL sheet's. */
export const MASK_OPACITY = 0.5;
// What MASK_COLOR (the draped sheet's grey, GeoDrillMap) looks like ON SCREEN. The draped fill is lit by the Standard
// style's lights when the terrain is composited, which warms it; the GL sheet is
// drawn straight to the framebuffer and gets no lighting, so it has to output
// the lit result to look the same (and to make the globe ↔ flat handover
// invisible). Measured by sampling the same pixels with the draped mask on and
// off, then matched against the GL sheet to within ~1/255 per channel. If the
// style's lighting ever changes, re-measure — a mismatch shows as a colour step
// when the zoom crosses GLOBE_MAX_ZOOM. (Same caveat for a style colour theme:
// the GL sheet takes this colour and the fog's as-is, without the theme's LUT.)
export const TINT_RGB = [144, 131, 122] as const;

// ---- The flat view's grey: a custom WebGL layer --------------------------------
// One mesh lying on the ground: the whole mercator world with the selection's
// outer rings as holes, plus the selection's enclaves filled back in. It is
// rebuilt when the selection's geometry changes and at no other time — the
// camera can go anywhere without it needing anything.
//
// Depth is what makes a FLAT sheet correct around a RAISED plateau: tested
// against the terrain (renderingMode "3d" shares its depth range), the ground
// behind the plateau is hidden by it exactly as the eye expects, with no lid
// needed. The sheet is coplanar with the flat terrain everywhere else, so it is
// pulled toward the camera with polygon offset — a bias in DEPTH units, which
// holds at every zoom, where lifting the mesh by some metres does not (a few
// metres is under one depth step once zoomed out to a region) and would also
// slide the hole's edge off the boundary under pitch.
//
// One consequence of being flat: a plateau that is still SINKING hides the sheet
// until it is nearly down, so the outgoing selection greys at the end of its
// sink rather than at the click. Its lid covered it for that long anyway.
//
// It sits in the "middle" slot. With terrain on mapbox draws every draped layer
// first whatever its slot, so in practice that means: after the whole ground,
// before the labels and the 3D layers — place names stay un-greyed, as they
// were under the draped sheet.
const TINT_DEPTH_BIAS_FACTOR = -1;
/** In steps of a 24-bit depth buffer; scaled down for a shallower one (onAdd). */
const TINT_DEPTH_BIAS_UNITS = -64;
// Mapbox's own constants for when fog starts to show, by camera pitch.
const FOG_PITCH_START = 45;
const FOG_PITCH_END = 65;

export class ScopeTintLayer implements mapboxgl.CustomLayerInterface {
  id = "scope-tint";
  type = "custom" as const;
  renderingMode = "3d" as const;
  slot = "middle";
  /** Called (not during the draw) when mapbox starts handing this layer the
   *  other projection — the draped sheet has to change hands with it. */
  onRegimeChange: ((globe: boolean) => void) | null = null;
  private map: mapboxgl.Map | null = null;
  private prog: GlProg | null = null;
  private buffer: WebGLBuffer | null = null;
  private positions = new Float32Array(0);
  private vertexCount = 0;
  private dirty = false;
  private origin: [number, number] = [0, 0];
  private mat = new Float32Array(16);
  private biasUnits = TINT_DEPTH_BIAS_UNITS;
  private globe: boolean | null = null;

  /** Called when a sheet cut off the page is laid (setSelection had answered
   *  false: on its way). */
  onLaid: (() => void) | null = null;
  /** ac:tint-cut=worker: who cuts the sheet off the page (null: this layer). */
  private cutter: TintCutter | null = null;
  /** Testing tools: who cut the sheet laid, and how many were laid. */
  private laid = { via: "page" as "page" | "worker", count: 0 };
  /** Which sheet is laid and which is on its way (gl/tintCuts.ts). */
  private cuts = createTintCuts({
    cutter: () => (tintCut.value === "worker" && this.cutter?.live() ? this.cutter.cut : null),
    cutHere: (geoms) => {
      const end = perfOn ? perfSpan("tint.setSelection") : null;
      const sheet = cutTintSheet(geoms);
      if (end) end({ vertices: sheet.positions.length / 2 });
      return sheet;
    },
    lay: (sheet, via) => this.lay(sheet, via),
    onLate: () => this.onLaid?.(),
    onCut: (ms, vertices) => {
      if (perfOn) perfNote("tint.workerCut", ms, { vertices });
    },
  });

  /** ac:tint-cut=worker: who cuts the sheet off the page. Null (the map's
   *  unmount): nobody, and a cut on its way is forgotten. */
  setCutter(c: TintCutter | null) {
    this.cutter = c;
    if (!c) this.cuts.drop();
  }

  /** ac:tint-cut=worker: the sheet around `geoms` asked of the cutter ahead
   *  of the setSelection that will lay it (a plateau about to stand: the
   *  grey changes in the block that puts its mesh up). Nothing without a
   *  live cutter, for no geometry, or for the selection laid or on its way. */
  prepare(geoms: MaskGeom[]) {
    this.cuts.prepare(geoms);
  }

  /** Cut the sheet around `geoms` (empty → no grey). Rebuilds only when the
   *  geometry OBJECTS change: boundary data is identity-stable, and this is
   *  called on every pass of the plateau pipeline. Returns whether the sheet
   *  laid changed in this call — false too when its cut is on its way from
   *  the cutter (ac:tint-cut=worker): `onLaid` is called when it lands. */
  setSelection(geoms: MaskGeom[]): boolean {
    return this.cuts.select(geoms);
  }

  /** A cut sheet laid: drawn from the next frame on. */
  private lay(sheet: TintSheet, via: "page" | "worker") {
    this.positions = sheet.positions;
    this.vertexCount = sheet.positions.length / 2;
    // No triangle: nothing is drawn, the origin stays where it was.
    if (this.vertexCount) this.origin = sheet.origin;
    this.dirty = true;
    if (__TEST_TOOLS__) this.laid = { via, count: this.laid.count + 1 };
    this.map?.triggerRepaint();
  }

  /** The testing tools' fingerprint of the sheet laid (`__acTintHash`,
   *  dev/probes.ts): its triangles' bytes and its origin, so a sheet cut by
   *  the worker and one cut by the page are compared bit for bit; who cut
   *  it, how many were laid, and the cut on its way. Null without the
   *  tools. */
  digest() {
    if (!__TEST_TOOLS__) return null;
    const { total, parts } = digestParts([
      ["positions", this.positions],
      ["origin", JSON.stringify(this.vertexCount ? this.origin : null)],
    ]);
    return {
      total,
      parts,
      vertices: this.vertexCount,
      holes: this.cuts.laid().length,
      via: this.laid.via,
      laid: this.laid.count,
      pending: this.cuts.pending(),
    };
  }

  onAdd(map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    // The grey is FOGGED like the ground it lies on. The draped sheet got that
    // for free (mapbox fogs the terrain it is baked into); a flat colour drawn
    // over already-fogged ground instead stays full strength to the horizon and
    // shows as a dark band under it. Mixing the colour toward the fog's by the
    // fog's own opacity is exactly equivalent to fogging a draped sheet. The
    // opacity is mapbox's formula for the ground, verbatim (fog_opacity ×
    // fog_horizon_blending below the horizon, both carrying the fog's alpha).
    this.prog = buildProgram(
      gl,
      `attribute vec2 aPos;
       uniform mat4 uMatrix;
       uniform mat4 uFogMatrix;
       uniform vec2 uOrigin;
       varying vec3 vFogPos;
       void main() {
         gl_Position = uMatrix * vec4(aPos, 0.0, 1.0);
         vFogPos = (uFogMatrix * vec4(aPos + uOrigin, 0.0, 1.0)).xyz;
       }`,
      `precision highp float;
       uniform vec3 uTint;
       uniform float uAlpha;
       uniform vec3 uFogColor;
       uniform vec3 uFog; // range start, range end, alpha²
       varying vec3 vFogPos;
       void main() {
         float t = (length(vFogPos) - uFog.x) / (uFog.y - uFog.x);
         float falloff = 1.0 - min(1.0, exp(-6.0 * t));
         falloff *= falloff * falloff;
         float fog = uFog.z * min(1.0, 1.00747 * falloff);
         gl_FragColor = vec4(mix(uTint, uFogColor, fog) * uAlpha, uAlpha);
       }`,
      ["aPos"],
      ["uMatrix", "uFogMatrix", "uOrigin", "uTint", "uAlpha", "uFogColor", "uFog"],
    );
    this.buffer = gl.createBuffer();
    // Polygon-offset units are steps of THIS depth buffer. The constant is tuned
    // for 24 bits; on a 16-bit buffer the same number would be 256× the bias and
    // let the ground behind a plateau draw through it.
    const bits = Math.min(24, (gl.getParameter(gl.DEPTH_BITS) as number) || 24);
    this.biasUnits = Math.min(-1, TINT_DEPTH_BIAS_UNITS / 2 ** (24 - bits));
    // A fresh context (remount) knows nothing of a sheet built before it.
    this.dirty = true;
    this.globe = null;
  }

  onRemove(_map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    if (this.prog) gl.deleteProgram(this.prog.prog);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.prog = null;
    this.buffer = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, matrix: number[], projection?: unknown) {
    // On the globe mapbox calls with its extended argument list, and the grey
    // there is the draped sheet's job (see MASK_SOURCE's note). This call IS the
    // regime, whatever decided it — so it is what the draped sheet is finally
    // held to: `syncDrapedMask` predicts it from the zoom to switch in the same
    // frame, and a prediction that ever disagrees is corrected from here.
    const globe = projection !== undefined;
    if (globe !== this.globe) {
      this.globe = globe;
      const notify = this.onRegimeChange;
      if (notify) queueMicrotask(() => notify(globe)); // never restyle mid-draw
    }
    if (globe || !this.map || !this.prog || !this.buffer || !this.vertexCount) return;
    const m = matrix;
    const [tx, ty] = this.origin;
    const t = this.mat;
    t.set(m);
    t[12] = m[0] * tx + m[4] * ty + m[12];
    t[13] = m[1] * tx + m[5] * ty + m[13];
    t[14] = m[2] * tx + m[6] * ty + m[14];
    t[15] = m[3] * tx + m[7] * ty + m[15];
    const u = this.prog.uni;
    gl.useProgram(this.prog.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.dirty) {
      gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
      this.dirty = false;
    }
    gl.uniformMatrix4fv(u.uMatrix, false, t);
    gl.uniform3f(u.uTint, TINT_RGB[0] / 255, TINT_RGB[1] / 255, TINT_RGB[2] / 255);
    gl.uniform1f(u.uAlpha, MASK_OPACITY);
    // Fog: only above FOG_PITCH_START, and only if mapbox's internals are where
    // this version keeps them. Otherwise alpha² stays 0 and the tint is plain.
    // `state` is a getter that computes, so it can throw as well as be missing —
    // and an exception here would abort mapbox's whole frame.
    const pitchK = Math.min(
      1,
      Math.max(0, (this.map.getPitch() - FOG_PITCH_START) / (FOG_PITCH_END - FOG_PITCH_START)),
    );
    let range: [number, number] | undefined;
    let fogMatrix: Float32Array | undefined;
    let fogColor: { r: number; g: number; b: number; a: number } | undefined;
    if (pitchK > 0) {
      try {
        const internals = this.map as unknown as MapFogInternals;
        const fog = internals.style?.fog;
        range = fog?.state?.range;
        fogMatrix = internals.transform?.mercatorFogMatrix;
        fogColor = fog?.properties?.get?.("color");
      } catch {
        range = undefined;
      }
    }
    if (range && fogMatrix && fogColor && fogColor.a > 0) {
      const a = pitchK * pitchK * (3 - 2 * pitchK) * fogColor.a; // smoothstep, as mapbox
      gl.uniformMatrix4fv(u.uFogMatrix, false, fogMatrix);
      gl.uniform2f(u.uOrigin, tx, ty);
      // Straight rgb (mapbox premultiplies only when it builds a render colour).
      gl.uniform3f(u.uFogColor, fogColor.r, fogColor.g, fogColor.b);
      gl.uniform3f(u.uFog, range[0], range[1], a * a);
    } else {
      gl.uniform3f(u.uFog, 0, 1, 0);
    }
    gl.enableVertexAttribArray(this.prog.attr.aPos);
    gl.vertexAttribPointer(this.prog.attr.aPos, 2, gl.FLOAT, false, 8, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // Read the terrain's depth, never write our own: the walls, lid and lines
    // drawn after this must still test against the terrain, not against a sheet.
    gl.depthMask(false);
    // Mapbox neither tracks nor resets polygon offset — left on, it would skew
    // every later draw in this frame and all the following ones.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(TINT_DEPTH_BIAS_FACTOR, this.biasUnits);
    try {
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    } finally {
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(0, 0);
      gl.depthMask(true);
    }
  }
}
