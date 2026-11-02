// When the plateau's globe set is built, with ac:mesh=merc (plateau/meshSwitch.ts):
// the globe copies of the walls, the lid, the lines and the halo are most of
// the mesh's bytes and time, and are drawn only below zoom 6 (the globe
// programs' smoothstep(5, 6), gl/program.ts). A plateau that stands well past
// it gets its mercator set first (PlateauWallLayer.setGeometry, "lazy") and its
// globe set after the map's next idle, or on the first globe frame drawn
// before that. Pure: no DOM, no GL.

/** A fit at this canonical DEM zoom or past it (usePlateau.canonicalDemZoom:
 *  floor(flat fit zoom + 1), so a flat fit zoom of 7 or more) stands in the
 *  mercator regime: its globe set can wait. */
export const LAZY_GLOBE_MIN_ZCANON = 8;

/** …when the camera is at this zoom or past it as the mesh is built: the
 *  camera is mid-flight then (the build follows the DEM POST and the sink),
 *  a flight can dip below its start zoom, and 6.5 keeps half a zoom level of
 *  margin over the globe regime (< 6). */
export const LAZY_GLOBE_MIN_ZOOM = 6.5;

export type GlobeSetMode = "eager" | "lazy";

/** The globe set built with the mercator one ("eager"), or later ("lazy"). */
export function globeSetMode(zCanon: number, zoomNow: number): GlobeSetMode {
  return zCanon >= LAZY_GLOBE_MIN_ZCANON && zoomNow >= LAZY_GLOBE_MIN_ZOOM ? "lazy" : "eager";
}

/** The deferred builds' generations: every setGeometry (eager ones and
 *  teardowns included) and the layer's removal begins a new one, so a build
 *  held for an older one never lands over a newer mesh; the inputs a lazy one
 *  stored are claimed once, by whichever of the idle pass and the first globe
 *  frame comes first. */
export interface GlobeDeferral<T> {
  /** A new generation, holding `inputs` for a later build (null: nothing to build). */
  begin(inputs?: T | null): number;
  /** The inputs to build generation `gen` from; null when it is stale, built or cancelled. */
  claim(gen: number): T | null;
  /** Generation `gen`'s globe set is built: a later claim gets nothing. */
  markBuilt(gen: number): void;
  /** The held inputs dropped: nothing left to build. */
  cancel(): void;
  /** The newest generation. */
  readonly current: number;
}

export function createGlobeDeferral<T>(): GlobeDeferral<T> {
  let gen = 0;
  let held: { gen: number; inputs: T } | null = null;
  return {
    begin(inputs = null) {
      gen++;
      held = inputs === null ? null : { gen, inputs };
      return gen;
    },
    claim(g) {
      return held && held.gen === g && g === gen ? held.inputs : null;
    },
    markBuilt(g) {
      if (held?.gen === g) held = null;
    },
    cancel() {
      held = null;
    },
    get current() {
      return gen;
    },
  };
}
