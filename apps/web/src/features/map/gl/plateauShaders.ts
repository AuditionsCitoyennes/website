// PlateauWallLayer's GLSL, as named constants: the mercator programs (a
// position, uMatrix with the mesh origin folded in, uScale the rise) and the
// globe ones (absolute mercator + the ECEF pair, placed by morphProject —
// gl/program's GLOBE_PROJECT_GLSL). The fragment shaders are the same in both
// regimes. Whitespace aside, the sources are what onAdd compiled inline.

import { GLOBE_PROJECT_GLSL } from "./program";

// ---- the walls: the plateau's violet, opaque ----------------------------------
export const WALL_VS = `attribute vec3 aPos;
  uniform mat4 uMatrix;
  uniform float uScale;
  void main() { gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0); }`;
export const WALL_FS = `void main() { gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0); }`;
export const G_WALL_VS = `attribute vec3 aMerc;
  attribute vec3 aEcefLo;
  attribute vec3 aEcefHi;
  ${GLOBE_PROJECT_GLSL}
  void main() { gl_Position = morphProject(aMerc, aEcefLo, aEcefHi); }`;

// ---- the lid: the map's snapshot, its UV an affine map of the vertex's mercator
// position into the snapshot's rectangle (no UV attribute: re-snapshots never
// touch the mesh); fragments outside it discard (the draped terrain shows) ----
export const LID_VS = `attribute vec3 aPos;
  uniform mat4 uMatrix;
  uniform float uScale;
  uniform vec2 uTexOrigin;
  uniform vec2 uTexSpan;
  varying vec2 vUV;
  void main() {
    vUV = (aPos.xy - uTexOrigin) / uTexSpan;
    gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
  }`;
export const LID_FS = `precision mediump float;
  varying vec2 vUV;
  uniform sampler2D uTex;
  void main() {
    if (vUV.x < 0.0 || vUV.x > 1.0 || vUV.y < 0.0 || vUV.y > 1.0) discard;
    gl_FragColor = texture2D(uTex, vUV);
  }`;
export const G_LID_VS = `attribute vec3 aMerc;
  attribute vec3 aEcefLo;
  attribute vec3 aEcefHi;
  uniform vec2 uTexOrigin;
  uniform vec2 uTexSpan;
  varying vec2 vUV;
  ${GLOBE_PROJECT_GLSL}
  void main() {
    vUV = (aMerc.xy - uTexOrigin) / uTexSpan;
    gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
  }`;

// ---- the boundary lines: each vertex carries the segment's other end and a
// side, extruded perpendicular in SCREEN space to a constant pixel width; the
// quad is 1 px wider each side and the fragment feathers over that pixel
// (vSide, the GEOMETRIC side, runs -1…1 across the width) ----
export const LINE_VS = `attribute vec3 aPos;
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
    vec4 q = uMatrix * vec4(aOther.xy, aOther.z * uScale, 1.0);
    vec2 d = (q.xy / q.w - p.xy / p.w) * uViewport;
    float len = length(d);
    vec2 n = len > 0.0 ? vec2(-d.y, d.x) / len : vec2(0.0, 0.0);
    vSide = aGeomSide;
    gl_Position = p + vec4(n * aSide * (uWidth + 2.0) / uViewport * p.w, 0.0, 0.0);
  }`;
// #7c5cff at the group's opacity, premultiplied (custom layers blend
// premultiplied), with a 1 px alpha feather at the edges.
export const LINE_FS = `precision highp float;
  varying float vSide;
  uniform float uWidth;
  uniform float uAlpha;
  void main() {
    float a = clamp((uWidth * 0.5 + 1.0) * (1.0 - abs(vSide)), 0.0, 1.0) * uAlpha;
    gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0) * a;
  }`;
export const G_LINE_VS = `attribute vec3 aMerc;
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
    vec4 q = morphProject(aOMerc, aOEcefLo, aOEcefHi);
    vec2 d = (q.xy / q.w - p.xy / p.w) * uViewport;
    float len = length(d);
    vec2 n = len > 0.0 ? vec2(-d.y, d.x) / len : vec2(0.0, 0.0);
    vSide = aGeomSide;
    gl_Position = p + vec4(n * aSide * (uWidth + 2.0) / uViewport * p.w, 0.0, 0.0);
  }`;

// ---- the hover fill: opaque violet swept inward — each vertex carries its
// normalised distance to the unit's boundary, and uFillT moves the filled
// band from the edge (d = 0) toward the centre (d = 1) ----
export const FILL_VS = `attribute vec3 aPos;
  attribute float aDist;
  uniform mat4 uMatrix;
  uniform float uScale;
  varying float vDist;
  void main() {
    vDist = aDist;
    gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
  }`;
export const FILL_FS = `precision highp float;
  varying float vDist;
  uniform float uFillT;
  void main() {
    float a = (1.0 - smoothstep(uFillT - 0.12, uFillT, vDist)) * 0.6;
    gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0) * a;
  }`;
export const G_FILL_VS = `attribute vec3 aMerc;
  attribute vec3 aEcefLo;
  attribute vec3 aEcefHi;
  attribute float aDist;
  varying float vDist;
  ${GLOBE_PROJECT_GLSL}
  void main() {
    vDist = aDist;
    gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
  }`;

// ---- the halo: a static glow ribbon fading outward from the wall's foot (it used
// to breathe with a 2.6 s swell, which forced a repaint ~25 times a second for as
// long as a plateau stood) ----
export const HALO_VS = `attribute vec3 aPos;
  attribute float aDist;
  uniform mat4 uMatrix;
  uniform float uScale;
  varying float vD;
  void main() {
    vD = aDist;
    gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
  }`;
export const HALO_FS = `precision highp float;
  varying float vD;
  void main() {
    // 0.42 is the time-average of the former swell (0.22 + 0.4 * wave, the wave
    // averaging 0.5; trough 0.22, peak 0.62)
    float a = pow(1.0 - vD, 1.6) * 0.42;
    gl_FragColor = vec4(0.486, 0.361, 1.0, 1.0) * a;
  }`;
export const G_HALO_VS = `attribute vec3 aMerc;
  attribute vec3 aEcefLo;
  attribute vec3 aEcefHi;
  attribute float aDist;
  varying float vD;
  ${GLOBE_PROJECT_GLSL}
  void main() {
    vD = aDist;
    gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
  }`;

// ---- the slabs' pieces: each vertex in its colour, or the one colour uTint
// gives where its alpha is 1 (the words' boxes' opaque lids). Straight to the
// framebuffer, opaque: premultiplied or not, the same ----
export const PIECE_VS = `attribute vec3 aPos;
  attribute vec3 aColor;
  uniform mat4 uMatrix;
  uniform float uScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = uMatrix * vec4(aPos.xy, aPos.z * uScale, 1.0);
  }`;
export const PIECE_FS = `precision mediump float;
  varying vec3 vColor;
  uniform vec4 uTint;
  void main() { gl_FragColor = vec4(mix(vColor, uTint.rgb, uTint.a), 1.0); }`;
export const G_PIECE_VS = `attribute vec3 aMerc;
  attribute vec3 aEcefLo;
  attribute vec3 aEcefHi;
  attribute vec3 aColor;
  varying vec3 vColor;
  ${GLOBE_PROJECT_GLSL}
  void main() {
    vColor = aColor;
    gl_Position = morphProject(aMerc, aEcefLo, aEcefHi);
  }`;
