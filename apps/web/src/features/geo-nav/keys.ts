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
 * depth and facts; the lists (PR K) under a word no filter key can be: the
 * results per filter key, sort and page size (and a read of them as far as
 * an audition), a lieu's auditions per filter key, an audition's testimonies
 * per content filter key (verified, themes, text: the only filters judged on
 * a testimony).
 */
export const placesKeys = {
  all: ["places"] as const,
  counts: (fkey: string, unit: string, depth: number, facts: boolean) =>
    [...placesKeys.all, fkey, unit, depth, facts] as const,
  facets: () => [...placesKeys.all, "facets"] as const,
  results: (fkey: string, sort: string, limit: number) =>
    [...placesKeys.all, "results", fkey, sort, limit] as const,
  through: (fkey: string, sort: string, audition: string, limit: number) =>
    [...placesKeys.all, "through", fkey, sort, audition, limit] as const,
  lieu: (id: string, fkey: string) => [...placesKeys.all, "lieu", id, fkey] as const,
  testimonies: (audition: string, contentKey: string) =>
    [...placesKeys.all, "testimonies", audition, contentKey] as const,
};
