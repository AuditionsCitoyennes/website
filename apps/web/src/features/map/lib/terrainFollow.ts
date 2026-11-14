// The plateau's rise as ONE terrain transition (plateau/riseSwitch.ts,
// `ac:rise=transition`): what usePlateau needs of mapbox to hand it a rise or
// a sink in a single setTerrain and still keep the plateau's own layer on the
// ground mapbox draws. Pure: a map-like object, no mapbox import — run with
// `node --import tsx --test` (root "test:scripts").
//
// INTERNAL to mapbox-gl 3.34 (read on 3.34.1, the range is ^3.34.1; re-check
// on upgrade). Three facts of its code this stands on:
//
// 1. A terrain's exaggeration is a transitionable property: a setTerrain with
//    an `exaggeration-transition` starts a transition from the height shown
//    to the new one (ease-in-out, mapbox's own curve), chained on the one in
//    flight if there is one.
// 2. Mapbox evaluates that transition only in a frame whose style is dirty,
//    and a terrain's transition does not make it so (the style's
//    `hasTransitions()` asks the lights, the fog, the sources and the layers,
//    not the terrain): on a still camera the height would stay where it is
//    until something else dirties the style. `map._update(true)` — what
//    mapbox itself calls at each zoom step of a flight — marks the next frame
//    dirty and asks for it: `pumpTransition`, called once a frame for the
//    transition's time and no longer.
// 3. The height the terrain is drawn with in a frame is the renderer's
//    (`map.painter.terrain.exaggeration()`), set before the layers draw: read
//    from inside a custom layer's render it is that frame's, so a uniform
//    taken from it cannot be a frame early or late (`frameExaggeration`).
//
// Why one call matters: each setTerrain is a style change (a `data` event of
// type "style"), on which mapbox's terrain throws away its cache of draped
// ground tiles and draws them all again at the next frame; a transition's
// steps are not style changes, and nothing in the cache's rules
// (`_shouldDisableRenderCache`) looks at the terrain's transition.

/** What is read of a map (mapbox-gl's Map has it all, underscore and all). */
export interface FollowMap {
  painter?: { terrain?: { exaggeration?: () => unknown } | null } | null;
  _update?: (updateStyle?: boolean) => unknown;
}

/** Whether this map can be followed: the two internals are where 3.34 has
 *  them. False sends the caller back to its per-frame steps. */
export function canFollowTerrain(map: FollowMap | null | undefined): boolean {
  return (
    !!map && typeof map._update === "function" && !!map.painter && typeof map.painter === "object"
  );
}

/** The exaggeration the terrain is drawn with this frame; null where mapbox
 *  runs no terrain (none set, the flat map) or the renderer is not where
 *  3.34 has it. */
export function frameExaggeration(map: FollowMap | null | undefined): number | null {
  try {
    const terrain = map?.painter?.terrain;
    if (!terrain || typeof terrain.exaggeration !== "function") return null;
    const v = terrain.exaggeration();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** The next frame evaluates the terrain's transition (fact 2), and is asked
 *  for. False: this map cannot be pumped. */
export function pumpTransition(map: FollowMap | null | undefined): boolean {
  if (!map || typeof map._update !== "function") return false;
  try {
    map._update(true);
    return true;
  } catch {
    return false;
  }
}

/** The one setTerrain of a rise or a sink: `source` at `to`, reached in `ms`
 *  (whole milliseconds, 1 at least: a 0 would snap). */
export function transitionSpec(source: string, to: number, ms: number) {
  return {
    source,
    exaggeration: to,
    "exaggeration-transition": { duration: Math.max(1, Math.ceil(ms)), delay: 0 },
  };
}

/** Whether a transition due to end at `endAt` is over: its time has passed
 *  AND a frame has been drawn at the target (`shown`: the last frame's
 *  exaggeration). Never on the clock alone: the last frame before the end
 *  shows a height short of the target. */
export function transitionSettled(now: number, endAt: number, shown: number, to: number): boolean {
  return now >= endAt && shown === to;
}
