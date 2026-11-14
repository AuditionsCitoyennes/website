// The pending mark's stroke (gl/PendingMarkPass.ts), as named constants: the
// boundary lines' own vertex shaders (gl/plateauShaders.ts LINE_VS, G_LINE_VS:
// each vertex carries its segment's other end and a side, extruded
// perpendicular in SCREEN space to a constant pixel width) with two changes a
// wide line needs — a square cap half a width past each end, so two segments
// overlap at their joint instead of leaving a notch on the outside of a
// corner, and a colour given by the frame (the lines' is the plateau's violet,
// written in their shader). The fill needs no shader: the hover fill's
// programs draw it.

import { GLOBE_PROJECT_GLSL } from "./program";

/** The offset of a vertex from its end of the segment, in the lines' own
 *  units (viewport × NDC, two per pixel): across by its side, and back past
 *  its end (away from the other end `q`) by half the width. */
const MARK_OFFSET_GLSL = `
    vec2 d = (q.xy / q.w - p.xy / p.w) * uViewport;
    float len = length(d);
    vec2 along = len > 0.0 ? d / len : vec2(0.0, 0.0);
    vec2 n = vec2(-along.y, along.x);
    vSide = aGeomSide;
    vec2 off = n * aSide * (uWidth + 2.0) - along * uWidth;
    gl_Position = p + vec4(off / uViewport * p.w, 0.0, 0.0);`;

export const MARK_VS = `attribute vec3 aPos;
  attribute vec3 aOther;
  attribute float aSide;
  attribute float aGeomSide;
  uniform mat4 uMatrix;
  uniform float uScale;
  uniform vec2 uViewport;
  uniform float uWidth;
  varying float vSide;
  void main() {
    vec4 p = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
    vec4 q = uMatrix * vec4(aOther.xy, aOther.z * uScale, 1.0);${MARK_OFFSET_GLSL}
  }`;

export const G_MARK_VS = `attribute vec3 aMerc;
  attribute vec3 aEcefLo;
  attribute vec3 aEcefHi;
  attribute vec3 aOMerc;
  attribute vec3 aOEcefLo;
  attribute vec3 aOEcefHi;
  attribute float aSide;
  attribute float aGeomSide;
  uniform vec2 uViewport;
  uniform float uWidth;
  varying float vSide;
  ${GLOBE_PROJECT_GLSL}
  void main() {
    vec4 p = morphProject(aMerc, aEcefLo, aEcefHi);
    vec4 q = morphProject(aOMerc, aOEcefLo, aOEcefHi);${MARK_OFFSET_GLSL}
  }`;

// uColor at uAlpha, premultiplied (custom layers blend premultiplied), with
// the lines' 1 px alpha feather at the edges.
export const MARK_FS = `precision highp float;
  varying float vSide;
  uniform float uWidth;
  uniform float uAlpha;
  uniform vec3 uColor;
  void main() {
    float a = clamp((uWidth * 0.5 + 1.0) * (1.0 - abs(vSide)), 0.0, 1.0) * uAlpha;
    gl_FragColor = vec4(uColor, 1.0) * a;
  }`;
