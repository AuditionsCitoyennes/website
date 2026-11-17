// The pending mark's loading line (gl/PendingMarkPass.ts), as named
// constants: the boundary lines' lean vertex shaders (gl/plateauShaders.ts
// LINE_LEAN_VS, G_LINE_LEAN_VS: a segment's two ends are per-instance
// attributes, each of the quad's six corners says which end it stands at and
// its two signs, the quad extruded perpendicular in SCREEN space to a
// constant pixel width) with what a loading line needs:
// - a square cap past each end — half a width, or the segment's own length
//   when it is shorter — so two segments overlap at their joint instead of
//   leaving a notch on the outside of a corner, and a run of segments
//   shorter than the line is wide (a river's meanders) does not pile its
//   caps into a knot;
// - a colour given by the frame;
// - the share of the boundary's length reached at each end (aLen), carried to
//   the fragment with the pixels one unit of it spans on this segment, so
//   the fragment shader draws the line up to uProgress, its head one pixel
//   soft, with no derivative.
// The fill needs no shader: the hover fill's programs draw it.

import { GLOBE_PROJECT_GLSL } from "./program";

/** From `p` (the corner's end) and `q` (the other one), both projected: the
 *  corner's offset in the lines' own units (viewport × NDC, two per pixel) —
 *  across by its side, and back past its end by the cap — and the length
 *  reached there. The cap continues the segment's own slope of length per
 *  pixel, one segment's worth at most (a segment seen end-on has neither
 *  cap nor slope). */
const MARK_EXTRUDE_GLSL = `
    vec2 d = (q.xy / q.w - p.xy / p.w) * uViewport;
    float len = length(d);
    vec2 along = len > 0.0 ? d / len : vec2(0.0, 0.0);
    vec2 n = vec2(-along.y, along.x);
    vSide = aCorner.z;
    float cap = min(uWidth, len);
    vec2 off = n * aCorner.y * (uWidth + 2.0) - along * cap;
    gl_Position = p + vec4(off / uViewport * p.w, 0.0, 0.0);
    float lenSelf = atB ? aLen.y : aLen.x;
    float lenOther = atB ? aLen.x : aLen.y;
    vLen = lenSelf + (cap / max(len, 1e-6)) * (lenSelf - lenOther);
    vPxPerLen = (len * 0.5) / max(abs(lenOther - lenSelf), 1e-9);`;

export const MARK_LEAN_VS = `attribute vec3 aA;
  attribute vec3 aB;
  attribute vec2 aLen;
  attribute vec3 aCorner;
  uniform mat4 uMatrix;
  uniform float uScale;
  uniform vec2 uViewport;
  uniform float uWidth;
  varying float vSide;
  varying float vLen;
  varying float vPxPerLen;
  void main() {
    bool atB = aCorner.x > 0.5;
    vec3 pos = atB ? aB : aA;
    vec3 other = atB ? aA : aB;
    vec4 p = uMatrix * vec4(pos.xy, pos.z * uScale, 1.0);
    vec4 q = uMatrix * vec4(other.xy, other.z * uScale, 1.0);${MARK_EXTRUDE_GLSL}
  }`;

export const G_MARK_LEAN_VS = `attribute vec3 aAMerc;
  attribute vec3 aAEcefLo;
  attribute vec3 aAEcefHi;
  attribute vec3 aBMerc;
  attribute vec3 aBEcefLo;
  attribute vec3 aBEcefHi;
  attribute vec2 aLen;
  attribute vec3 aCorner;
  uniform vec2 uViewport;
  uniform float uWidth;
  varying float vSide;
  varying float vLen;
  varying float vPxPerLen;
  ${GLOBE_PROJECT_GLSL}
  void main() {
    bool atB = aCorner.x > 0.5;
    vec4 a = morphProject(aAMerc, aAEcefLo, aAEcefHi);
    vec4 b = morphProject(aBMerc, aBEcefLo, aBEcefHi);
    vec4 p = atB ? b : a;
    vec4 q = atB ? a : b;${MARK_EXTRUDE_GLSL}
  }`;

// uColor at uAlpha, premultiplied (custom layers blend premultiplied), with
// the lines' 1 px alpha feather at the edges, up to uProgress of the
// boundary's length (its head one pixel soft).
export const MARK_FS = `precision highp float;
  varying float vSide;
  varying float vLen;
  varying float vPxPerLen;
  uniform float uWidth;
  uniform float uAlpha;
  uniform float uProgress;
  uniform vec3 uColor;
  void main() {
    float a = clamp((uWidth * 0.5 + 1.0) * (1.0 - abs(vSide)), 0.0, 1.0) * uAlpha;
    a *= clamp((uProgress - vLen) * vPxPerLen + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(uColor, 1.0) * a;
  }`;

/** uProgress for a full line: past every length a cap can carry. */
export const MARK_PROGRESS_FULL = 1e6;
