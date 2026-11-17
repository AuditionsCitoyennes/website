// The cold tap: a territory is chosen while its own outline (its "self", the
// fine one its plateau rises on) is not in memory yet — or the boundaries of
// its children are not. Four switches, compared live in the builds with the
// testing tools — the dev server and staging (__TEST_TOOLS__, vite.config),
// kept in localStorage and drawn as the Témoignages page's DEV rows « Attente
// du contour », « Contour seul », « Lignes intérieures » and « Avant le
// contour ». Read at each selection: no reload.
//
// `ac:outline-wait`, how long a plateau waits for its fine outline while a
// coarser one of the same unit is in memory (a région's entry in France's
// file, a country's world outline):
// - "file" (the default): a unit the visitor tapped waits for its file
//   itself — its loading line follows the file as it arrives, and its
//   plateau rises on the fine shape — TAP_OUTLINE_WAIT_MS at most. A
//   selection nobody tapped (a pan, a crumb, a link): up to 1.2 s.
// - "1200": up to 1.2 s, tapped or not, as before the loading line.
// - "400": up to 0.4 s.
// - "0": no wait: it rises on the coarse shape in the tap's own pipeline run.
// Past the wait the plateau rises on the coarse shape. A tapped unit's
// loading line then fades where it stands, short of the whole boundary — the
// file it measured has not come (plateau/tapProgress.ts, `waived`) — and its
// violet leaves as for any tap, as that plateau is about to rise.
// The fine shape, when it lands after the rise, is stored once the map is
// still and swapped in at the plateau's height, with no sink and no rise
// (usePlateau's quiet reshape). A unit with no coarse shape in memory has
// nothing to rise on: its wait stays OUTLINE_WAIT_MS whatever the switch.
//
// `ac:region-self`, which file a French région's or département's plateau
// waits for (their self exists alone in a u/ file, byte-identical to the
// self of their k/ bundle, which also holds every child):
// - "first" (the default): the u/ is asked first, at high fetch priority,
//   and the bundle at low priority. The plateau rises as soon as the self is
//   in; the bundle's children are drawn on it by one reshape in place once
//   the map is still. A bundle landing within SELF_GRACE_MS of the self is
//   stored with it: on a fast link or from the HTTP cache the plateau rises
//   with its children's lines, as before.
// - "bundle": the bundle alone, as before.
//
// `ac:tap-lines`, the boundaries inside a unit the visitor tapped (the
// départements of a région, the communes of a département: they come with
// the unit's bundle, its k/ file):
// - "wait" (the default): the plateau waits for that bundle as it waits for
//   the unit's own outline — under the same cap (ac:outline-wait; nothing at
//   "0") — so it rises with its children's boundaries on its lid, built by
//   the one mesh of its commit; the loading line counts the bundle. Past the
//   cap it rises without them and they join later, as under "late".
// - "upper": only a country and a région wait; a département rises without
//   waiting for its communes.
// - "late": nothing waits: the bundle is a late file, its lines are drawn on
//   the standing plateau once the map is still, as before.
// A selection nobody tapped (a crumb, a link, a search, a pan, the boot)
// never waits for them.
//
// `ac:cold-start`, what the map does while it holds for an outline on its way:
// - "hold" (the default): the plateau standing stays up until the outline
//   lands, as before.
// - "early": the plateau standing sinks at the tap and the new unit's lid is
//   shot over its box, so that neither stands between the outline landing and
//   the rise.
//
// Production has neither key nor row: the defaults.

import { ref } from "vue";

export type OutlineWait = "1200" | "file" | "400" | "0";
export type RegionSelfMode = "first" | "bundle";
export type TapLinesMode = "wait" | "upper" | "late";
export type ColdStartMode = "hold" | "early";

/** The modes of a build without the testing tools, and the switches' defaults. */
export const DEFAULT_OUTLINE_WAIT: OutlineWait = "file";
export const DEFAULT_REGION_SELF: RegionSelfMode = "first";
export const DEFAULT_TAP_LINES: TapLinesMode = "wait";
export const DEFAULT_COLD_START: ColdStartMode = "hold";

export const OUTLINE_WAITS: readonly OutlineWait[] = ["file", "1200", "400", "0"];

/** How long a tapped unit waits for its own outline file under "file", ms:
 *  it ends a second before the long wait's sentence (geo-nav's
 *  tapPendingCore SLOW_WAIT_MS), so a file that does not come ends in a
 *  plateau on the coarse shape, not in that sentence. A wait crossed by a
 *  file of a unit since left goes on once, as long again (selfHold). */
export const TAP_OUTLINE_WAIT_MS = 4000;
export const REGION_SELF_MODES: readonly RegionSelfMode[] = ["first", "bundle"];
export const TAP_LINES_MODES: readonly TapLinesMode[] = ["wait", "upper", "late"];
export const COLD_START_MODES: readonly ColdStartMode[] = ["hold", "early"];

/** How long a self asked ahead of its bundle (ac:region-self "first") waits,
 *  once in, for a bundle still on the network before it is stored alone. */
export const SELF_GRACE_MS = 80;

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** The modes now (refs: the DEV dialog redraws its rows from them). A build
 *  without the testing tools reads no key: the defaults. */
export const outlineWait = ref<OutlineWait>(
  __TEST_TOOLS__
    ? stored("ac:outline-wait", OUTLINE_WAITS, DEFAULT_OUTLINE_WAIT)
    : DEFAULT_OUTLINE_WAIT,
);
export const regionSelfMode = ref<RegionSelfMode>(
  __TEST_TOOLS__
    ? stored("ac:region-self", REGION_SELF_MODES, DEFAULT_REGION_SELF)
    : DEFAULT_REGION_SELF,
);
export const tapLinesMode = ref<TapLinesMode>(
  __TEST_TOOLS__ ? stored("ac:tap-lines", TAP_LINES_MODES, DEFAULT_TAP_LINES) : DEFAULT_TAP_LINES,
);
export const coldStartMode = ref<ColdStartMode>(
  __TEST_TOOLS__
    ? stored("ac:cold-start", COLD_START_MODES, DEFAULT_COLD_START)
    : DEFAULT_COLD_START,
);

/** Another wait: kept, and in force from the next selection. */
export function setOutlineWait(wait: OutlineWait) {
  if (!__TEST_TOOLS__) return;
  outlineWait.value = wait;
  store("ac:outline-wait", wait);
}

/** Another first file: kept, and in force from the next selection. */
export function setRegionSelfMode(mode: RegionSelfMode) {
  if (!__TEST_TOOLS__) return;
  regionSelfMode.value = mode;
  store("ac:region-self", mode);
}

/** Another wait for the inner boundaries: kept, and in force from the next tap. */
export function setTapLinesMode(mode: TapLinesMode) {
  if (!__TEST_TOOLS__) return;
  tapLinesMode.value = mode;
  store("ac:tap-lines", mode);
}

/** Whether a tapped unit of level `levelKey` waits for its bundle (its
 *  children's boundaries) under `mode`: every unit that can have one under
 *  "wait", a country and a région under "upper", none under "late" — and
 *  none when the plateau waits for nothing (`wait` "0"). */
export function tapLinesWaitFor(mode: TapLinesMode, wait: OutlineWait, levelKey: string): boolean {
  if (mode === "late" || wait === "0") return false;
  if (levelKey === "world" || levelKey === "place") return false;
  return mode === "wait" || levelKey === "country" || levelKey === "region";
}

/** Another start: kept, and in force from the next selection. */
export function setColdStartMode(mode: ColdStartMode) {
  if (!__TEST_TOOLS__) return;
  coldStartMode.value = mode;
  store("ac:cold-start", mode);
}

/**
 * How long a plateau waits for its unit's fine outline, ms. `coarse`: a
 * coarser outline of the unit is in memory, so there is a shape to rise on
 * meanwhile — the switch's wait (under "file": TAP_OUTLINE_WAIT_MS for a
 * unit the visitor `tapped`, `full` for any other); none: `full`
 * (OUTLINE_WAIT_MS), whatever the switch, since rising sooner would raise
 * nothing.
 */
export function outlineWaitFor(
  wait: OutlineWait,
  coarse: boolean,
  full: number,
  tapped = false,
): number {
  if (!coarse) return full;
  if (wait === "file") return tapped ? TAP_OUTLINE_WAIT_MS : full;
  return Number(wait);
}
