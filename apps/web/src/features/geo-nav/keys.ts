// The place reads' vue-query keys (map phase 1): a secondary entry of
// geo-nav, so that what app/ reaches through temoignages' barrel (the
// invalidation after an audition is created) is these few lines — never the
// map, which the barrel would bring along.

/** The key of every audition on the map, testimonies or not (empty=1, no
 *  filters): the home card and the place picker. Never a filter key. */
export const EMPTY_KEY = "empty";

/**
 * vue-query keys. `all` prefixes every place read (app/ invalidates it when
 * an audition is created); a unit's counts are kept per filter key, unit,
 * depth and facts.
 */
export const placesKeys = {
  all: ["places"] as const,
  counts: (fkey: string, unit: string, depth: number, facts: boolean) =>
    [...placesKeys.all, fkey, unit, depth, facts] as const,
  facets: () => [...placesKeys.all, "facets"] as const,
};
