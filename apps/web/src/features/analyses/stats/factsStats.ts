// The analyses' figures as the database sums them (map phase 1, design E1):
// every unit of the server's tree comes with its facts (place_counts'
// `facts`: the same sums buildUnitStats makes of the corpus). The index is
// built once per filter key and store version; a unit whose facts have not
// come yet has none (figuresOf: undefined), and the analyses wait for them.

import type { PlaceFacts } from "@ac/shared";
import { statsIndex, type UnitFigures, type UnitStatsIndex } from "./scopeStats";

/** A unit's facts as figures. */
export function figuresOfFacts(f: PlaceFacts): UnitFigures {
  const [terrain, cahier2019, archive] = f.cohorts;
  return {
    testimonies: f.testimonies,
    auditions: f.auditions,
    lieux: f.lieux,
    communes: f.communes,
    cohorts: { terrain, cahier2019, archive },
    themes: f.themes,
    themeAuditions: f.themeAuditions,
    themeBase: f.themeBase,
    untagged: f.untagged,
    approx: f.approx,
    first: f.first,
    last: f.last,
    largest: f.largest ? { n: f.largest[3], key: f.largest[2], city: f.largest[4] } : null,
  };
}

/** The index over the facts the store holds, by unit id. */
export function buildFactsIndex(facts: ReadonlyMap<string, PlaceFacts>): UnitStatsIndex {
  const figures = new Map<string, UnitFigures>();
  return statsIndex((id) => {
    let f = figures.get(id);
    if (!f) {
      const raw = facts.get(id);
      if (!raw) return undefined;
      f = figuresOfFacts(raw);
      figures.set(id, f);
    }
    return f;
  });
}

/** A short fingerprint of a unit's figures: an analysis made of the same
 *  figures is the same analysis (useScopeAnalysis's memo). */
export function figuresHash(f: UnitFigures): string {
  const c = f.cohorts;
  return [
    f.testimonies,
    f.auditions,
    f.lieux,
    f.communes,
    c.terrain,
    c.cahier2019,
    c.archive,
    Array.from(f.themes).join(","),
    Array.from(f.themeAuditions).join(","),
    f.themeBase,
    f.untagged,
    f.approx,
    f.first,
    f.last,
    f.largest ? `${f.largest.n}|${f.largest.key}|${f.largest.city}` : "",
  ].join(";");
}
