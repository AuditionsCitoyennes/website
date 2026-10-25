// What the two custom layers share of WebGL: a program compiled with its
// locations looked up by name, the globe↔mercator morph every globe shader
// includes, the origin fold that keeps float32 vertices precise, the test for
// a globe frame — and the typings of the mapbox internals they read.

// A compiled program with attribute/uniform locations looked up by name.
export interface GlProg {
  prog: WebGLProgram;
  attr: Record<string, number>;
  uni: Record<string, WebGLUniformLocation | null>;
}

export function buildProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  attrs: string[],
  unis: string[],
): GlProg | null {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog || !vs || !fs) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (import.meta.env.DEV && !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn(
      "[plateau] program link failed:",
      gl.getProgramInfoLog(prog),
      gl.getShaderInfoLog(vs),
      gl.getShaderInfoLog(fs),
    );
  }
  const attr: Record<string, number> = {};
  for (const a of attrs) attr[a] = gl.getAttribLocation(prog, a);
  const uni: Record<string, WebGLUniformLocation | null> = {};
  for (const u of unis) uni[u] = gl.getUniformLocation(prog, u);
  return { prog, attr, uni };
}

// The globe↔mercator morph, mixed in NDC AFTER the perspective divides — the
// exact endorsed pattern (mapbox debug/satellites-custom-layer.js). Do NOT mix
// the two positions in world space before projecting: the sphere-shell point and
// the flat-plane point are the same SCREEN point but wildly different 3D coords,
// and a linear blend of them projects to garbage mid-band (walls fragment, the
// lid smears, lines vanish for z 5–6 — observed live). Behind-eye vertices (the
// NDC mix defeats hardware near-plane clipping) are thrown to a degenerate
// clipped position instead. t = smoothstep(5, 6, zoom) — 0 = sphere, 1 =
// mercator; at z ≥ 6 mapbox switches to the 2-arg mercator call and the
// (untouched) mercator programs take over, so the handoff is seamless. The
// mercator twin is rescaled around the map centre by the pixels-per-meter ratio
// per the custom-layer contract (the globe camera is equator-referenced).
export const GLOBE_PROJECT_GLSL = `
  uniform mat4 uProj;
  uniform mat4 uGlobeToMerc;
  uniform float uT;
  uniform vec2 uCenterMerc;
  uniform float uPxRatio;
  uniform float uScale;
  vec4 morphProject(vec3 merc, vec3 ecefLo, vec3 ecefHi) {
    vec4 p = uProj * uGlobeToMerc * vec4(mix(ecefLo, ecefHi, uScale), 1.0);
    if (p.w <= 0.0) return vec4(0.0, 0.0, 2.0, 1.0);
    p /= p.w;
    if (uT > 0.0) {
      vec4 m = vec4(
        (merc.xy - uCenterMerc) * uPxRatio + uCenterMerc,
        merc.z * uScale * uPxRatio,
        1.0);
      m = uProj * m;
      if (m.w <= 0.0) return vec4(0.0, 0.0, 2.0, 1.0);
      p = mix(p, m / m.w, uT);
    }
    return p;
  }
`;

/** The uniforms GLOBE_PROJECT_GLSL declares (buildProgram looks them up). */
export const GLOBE_UNIS = ["uProj", "uGlobeToMerc", "uT", "uCenterMerc", "uPxRatio", "uScale"];

/** M × T(ox, oy): a mesh's origin folded into the (float64) matrix, so that
 *  its float32 vertices, relative to it, keep sub-metre precision. */
export function foldOrigin(
  m: ArrayLike<number>,
  ox: number,
  oy: number,
  out: Float32Array,
): Float32Array {
  for (let i = 0; i < 16; i++) out[i] = m[i];
  out[12] = m[0] * ox + m[4] * oy + m[12];
  out[13] = m[1] * ox + m[5] * oy + m[13];
  out[14] = m[2] * ox + m[6] * oy + m[14];
  out[15] = m[3] * ox + m[7] * oy + m[15];
  return out;
}

/** Whether mapbox drew this frame on the globe (zoom < 6): it then hands a
 *  custom layer's render() the projection's extra arguments, all of them. */
export function globeFrame(
  projection: unknown,
  globeToMercMatrix?: number[],
  transition?: number,
  centerInMercator?: number[],
  pixelsPerMeterRatio?: number,
): boolean {
  return (
    projection !== undefined &&
    (projection as { name?: string }).name === "globe" &&
    globeToMercMatrix !== undefined &&
    transition !== undefined &&
    centerInMercator !== undefined &&
    pixelsPerMeterRatio !== undefined
  );
}

/** mapbox's depth range for its "3d" layers — the terrain's, the plateau's.
 *  Not public API: absent, the range stays as mapbox last set it. */
export interface MapPainterInternals {
  painter?: { depthRangeFor3D?: [number, number] };
}

/** The pieces of mapbox's fog the sheet has to reproduce. None of this is public
 *  API, so every field is optional and its absence just means "no fog". */
export interface MapFogInternals {
  style?: {
    fog?: {
      state?: { range?: [number, number] };
      properties?: { get?(name: "color"): { r: number; g: number; b: number; a: number } };
    };
  };
  transform?: { mercatorFogMatrix?: Float32Array };
}
