// What the map can start while it HOLDS for an outline on its way (a cold
// tap: the chosen unit's own outline is not in memory, usePlateau's hold),
// under ac:cold-start (plateau/coldTapSwitch.ts):
//
// - "hold": nothing. The plateau standing stays up until the outline lands;
//   its sink and the new unit's lid shot start then, as before.
// - "early": the plateau standing starts sinking at once, and the new unit's
//   lid is shot over its box — the box of its row, which is the box of the
//   outline on its way, so the run that raises it finds that shot running or
//   landed (`boxCovers`: it asks for that same rectangle again whenever
//   the shape it raises lies within it, the fine outline as a coarser one).
//   Neither then stands between the outline landing and the rise.
//
// Nothing starts without the unit on its way (the scope followed a pan with
// no row known), nor for the unit that stands already. No import: loadable
// under node (coldStart.test.ts).

/** A box, as geo's Bounds. */
export interface ColdBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** The unit the map holds for: its id and its box. */
export interface ComingUnit {
  id: string;
  bounds: ColdBox;
}

export interface ColdStartState {
  mode: "hold" | "early";
  /** The unit the map holds for; null: none known. */
  coming: ComingUnit | null | undefined;
  /** The unit whose plateau stands ("": none). */
  standingId: string;
  /** That plateau is up on the terrain (there is something to sink). */
  standingUp: boolean;
}

export interface ColdStartPlan {
  /** The plateau standing sinks now. */
  sink: boolean;
  /** The box the new unit's lid is shot over now; null: no shot. */
  lid: ColdBox | null;
}

const NOTHING: ColdStartPlan = { sink: false, lid: null };

/** A box with a real extent on both axes (a lid shot needs one). */
const hasExtent = (b: ColdBox) =>
  Number.isFinite(b.minLat + b.maxLat + b.minLng + b.maxLng) &&
  b.maxLat > b.minLat &&
  b.maxLng > b.minLng;

/** What starts now, while the map holds. */
export function coldStartPlan(s: ColdStartState): ColdStartPlan {
  if (s.mode !== "early" || !s.coming || !s.coming.id) return NOTHING;
  if (s.coming.id === s.standingId) return NOTHING;
  return { sink: s.standingUp, lid: hasExtent(s.coming.bounds) ? s.coming.bounds : null };
}

/** `inner` lies within `outer` (to a hair: a coarser outline of a unit, cut
 *  from its fine one, never leaves the fine one's box by more). Null: no. */
export function boxCovers(outer: ColdBox, inner: ColdBox | null | undefined, eps = 1e-6): boolean {
  return (
    !!inner &&
    inner.minLat >= outer.minLat - eps &&
    inner.maxLat <= outer.maxLat + eps &&
    inner.minLng >= outer.minLng - eps &&
    inner.maxLng <= outer.maxLng + eps
  );
}

/** A unit's box as a feature the lid can be shot over (a closed rectangle,
 *  counter-clockwise, [lng, lat]). */
export function boxFeature(unit: ComingUnit) {
  const b = unit.bounds;
  return {
    type: "Feature" as const,
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [b.minLng, b.minLat],
          [b.maxLng, b.minLat],
          [b.maxLng, b.maxLat],
          [b.minLng, b.maxLat],
          [b.minLng, b.minLat],
        ],
      ],
    },
    properties: { kind: "scope", id: unit.id } as Record<string, unknown>,
  };
}
