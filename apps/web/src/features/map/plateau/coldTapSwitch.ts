// The cold tap: a territory is chosen while its own outline (its "self", the
// fine one its plateau rises on) is not in memory yet — or the boundaries of
// its children are not.
//
// How long a plateau waits for its fine outline while a coarser one of the
// same unit is in memory (a région's entry in France's file, a country's
// world outline): a unit the visitor tapped waits for its file itself — its
// loading line follows the file as it arrives, and its plateau rises on the
// fine shape — TAP_OUTLINE_WAIT_MS at most. A selection nobody tapped (a pan,
// a crumb, a link): up to OUTLINE_WAIT_MS. Past the wait the plateau rises on
// the coarse shape. A tapped unit's loading line then fades where it stands,
// short of the whole boundary — the file it measured has not come
// (plateau/tapProgress.ts, `waived`) — and its violet leaves as for any tap,
// as that plateau is about to rise. The fine shape, when it lands after the
// rise, is stored once the map is still and swapped in at the plateau's
// height, with no sink and no rise (usePlateau's quiet reshape). A unit with
// no coarse shape in memory has nothing to rise on: its wait stays
// OUTLINE_WAIT_MS (`outlineWaitFor`).
//
// A French région's or département's self exists alone in a u/ file,
// byte-identical to the self of their k/ bundle, which also holds every
// child: the u/ is asked first, at high fetch priority, and the bundle at low
// priority. The plateau rises as soon as the self is in; the bundle's
// children are drawn on it by one reshape in place once the map is still. A
// bundle landing within SELF_GRACE_MS of the self is stored with it: on a
// fast link or from the HTTP cache the plateau rises with its children's
// lines.
//
// The boundaries inside a unit the visitor tapped (the départements of a
// région, the communes of a département: they come with the unit's bundle,
// its k/ file): the plateau waits for that bundle as it waits for the unit's
// own outline, under the same cap, so it rises with its children's
// boundaries on its lid, built by the one mesh of its commit; the loading
// line counts the bundle. Past the cap it rises without them and they join
// later, drawn on the standing plateau once the map is still
// (`tapLinesWaitFor`). A selection nobody tapped (a crumb, a link, a search,
// a pan, the boot) never waits for them.
//
// While a plateau holds for an outline on its way, the plateau standing stays
// up until the outline lands.
//
// No import and nothing run at load: loadable under node (coldTapSwitch.test.ts).

/** How long a tapped unit waits for its own outline file, ms: it ends a
 *  second before the long wait's sentence (geo-nav's tapPendingCore
 *  SLOW_WAIT_MS), so a file that does not come ends in a plateau on the
 *  coarse shape, not in that sentence. A wait crossed by a file of a unit
 *  since left goes on once, as long again (selfHold). */
export const TAP_OUTLINE_WAIT_MS = 4000;

/** How long a self asked ahead of its bundle waits, once in, for a bundle
 *  still on the network before it is stored alone. */
export const SELF_GRACE_MS = 80;

/** Whether a tapped unit of level `levelKey` waits for its bundle (its
 *  children's boundaries): every unit that can have one. */
export function tapLinesWaitFor(levelKey: string): boolean {
  return levelKey !== "world" && levelKey !== "place";
}

/**
 * How long a plateau waits for its unit's fine outline, ms. `coarse`: a
 * coarser outline of the unit is in memory, so there is a shape to rise on
 * meanwhile — TAP_OUTLINE_WAIT_MS for a unit the visitor `tapped`, `full`
 * for any other; none: `full` (OUTLINE_WAIT_MS), since rising sooner would
 * raise nothing.
 */
export function outlineWaitFor(coarse: boolean, full: number, tapped = false): number {
  if (!coarse) return full;
  return tapped ? TAP_OUTLINE_WAIT_MS : full;
}
