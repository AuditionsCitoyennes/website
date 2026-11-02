// The progress of a rise or sink (usePlateau.animateTerrain,
// usePlateauSlabs.animateSlabs), clamped to [0, 1]. Pure: no DOM — run with
// `node --import tsx --test` (root "test:scripts").
//
// A rAF timestamp is the frame's START, so a frame begun before the animation
// was asked for (`t0 = performance.now()`) hands a `now` that precedes `t0`.
// Unclamped, that `t < 0` eased a rise from 0 to a negative exaggeration
// (mapbox rejects it: a map `error`, the walls drawn below the ground) and a
// sink from 1 above full height. Clamped, that frame shows the start value.

/** How far an animation of `ms` begun at `t0` is at `now`: 0 → 1, never outside. */
export function riseProgress(now: number, t0: number, ms: number): number {
  return Math.min(1, Math.max(0, (now - t0) / ms));
}
