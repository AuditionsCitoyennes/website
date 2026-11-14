// When the plateau's globe set is built, with ac:mesh=merc (plateau/meshSwitch.ts):
// the globe copies of the walls, the lid, the lines and the halo are most of
// the mesh's bytes and time, and are drawn only below zoom 6 (the globe
// programs' smoothstep(5, 6), gl/program.ts). A plateau that stands well past
// it gets its mercator set first (PlateauWallLayer.setGeometry, "lazy") and its
// globe set after the map's next idle, or on the first globe frame drawn
// before that. With ac:mesh=worker the set is asked of the worker; an ask in
// flight is told apart (`ask`, `asking`), so a globe frame can wait for its
// answer instead of building the same set on the page (ac:globe-late,
// ../threadSwitch.ts). Pure: no DOM, no GL.

/** A fit at this canonical DEM zoom or past it (usePlateau.canonicalDemZoom:
 *  floor(flat fit zoom + 1), so a flat fit zoom of 7 or more) stands in the
 *  mercator regime: its globe set can wait. */
export const LAZY_GLOBE_MIN_ZCANON = 8;

/** …when the camera is at this zoom or past it as the mesh is built: the
 *  camera is mid-flight then (the build follows the version key and the sink),
 *  a flight can dip below its start zoom, and 6.5 keeps half a zoom level of
 *  margin over the globe regime (< 6). */
export const LAZY_GLOBE_MIN_ZOOM = 6.5;

/** The deferred pass waits this long after the map's next idle: that idle
 *  comes as the rise's last frame ends, and the half second after the rise is
 *  kept clear of a 15-40 ms build (100 ms at a 4x slower CPU). */
export const GLOBE_PASS_DELAY_MS = 500;

export type GlobeSetMode = "eager" | "lazy";

/** The globe set built with the mercator one ("eager"), or later ("lazy"). */
export function globeSetMode(zCanon: number, zoomNow: number): GlobeSetMode {
  return zCanon >= LAZY_GLOBE_MIN_ZCANON && zoomNow >= LAZY_GLOBE_MIN_ZOOM ? "lazy" : "eager";
}

/** The deferred builds' generations: every setGeometry (eager ones and
 *  teardowns included) begins a new one, so a build held for an older one
 *  never lands over a newer mesh, and the layer's removal cancels what is
 *  held; the inputs a lazy one stored are claimed once, by whichever of the
 *  idle pass and the first globe frame comes first. A build that answers
 *  later (the worker's) is asked for once per generation. */
export interface GlobeDeferral<T> {
  /** A new generation, holding `inputs` for a later build (null: nothing to build). */
  begin(inputs?: T | null): number;
  /** The inputs to build generation `gen` from; null when it is stale, built or cancelled. */
  claim(gen: number): T | null;
  /** Generation `gen`'s globe set is built: a later claim gets nothing. */
  markBuilt(gen: number): void;
  /** The inputs of generation `gen` for a build that answers later, which is
   *  then in flight; null when it is stale, built or cancelled, when one is in
   *  flight already, or when one came back empty (`noAnswer`). */
  ask(gen: number): T | null;
  /** Whether a build asked for generation `gen` is in flight and still wanted. */
  asking(gen: number): boolean;
  /** The build asked for generation `gen` came back without a set: it is in
   *  flight no more and is not asked again (whoever claims it builds it).
   *  False when it was not in flight. */
  noAnswer(gen: number): boolean;
  /** The held inputs dropped: nothing left to build. */
  cancel(): void;
  /** The newest generation. */
  readonly current: number;
}

export function createGlobeDeferral<T>(): GlobeDeferral<T> {
  let gen = 0;
  let held: { gen: number; inputs: T } | null = null;
  // The generation whose build is in flight, and the one whose build came
  // back empty (0: none). A generation is never begun twice, so a newer one
  // needs neither reset.
  let asked = 0;
  let empty = 0;
  const claim = (g: number) => (held && held.gen === g && g === gen ? held.inputs : null);
  return {
    begin(inputs = null) {
      gen++;
      held = inputs === null ? null : { gen, inputs };
      return gen;
    },
    claim,
    markBuilt(g) {
      if (held?.gen === g) held = null;
    },
    ask(g) {
      if (asked === g || empty === g) return null;
      const inputs = claim(g);
      if (inputs !== null) asked = g;
      return inputs;
    },
    asking(g) {
      return asked === g && claim(g) !== null;
    },
    noAnswer(g) {
      if (asked !== g) return false;
      asked = 0;
      empty = g;
      return true;
    },
    cancel() {
      held = null;
    },
    get current() {
      return gen;
    },
  };
}
