// Which reads of the map page wait (audit candidate C05), compared live in
// the builds with the testing tools (the dev server and staging,
// __TEST_TOOLS__), kept in localStorage and drawn as two rows of the DEV
// dialog:
//
// `ac:filters-load` (« Données des filtres »): when the Filtres dialog's own
// data is asked for — the place picker's tree (every audition on the map,
// /api/places?…&empty=1) and the theme counts and date bounds
// (/api/places/facets). Only the dialog reads them.
// - "repos" (the default): once the page's own tree is on screen, at the
//   browser's first idle moment FILTERS_IDLE_MS later, so that they never
//   share the link with what the first view needs; or at once when the
//   dialog opens first. A dialog opened before they are in shows its
//   loading state for the time of the read.
// - "ouverture": only when the dialog opens.
// - "demarrage": as before — the picker's tree as soon as the page's own tree
//   is on screen, the facets at the page's start.
// A place already chosen (a stored filter, a link) asks for the picker's tree
// at once in every mode: its chip is named from it.
//
// `ac:prefetch` (« Préchargement des témoignages »): how many of an open
// lieu's auditions have their first page of testimonies asked for ahead.
// - "auto" (the default): one when the browser says the visitor saves data
//   or the connection is slow (2g, 3g), three otherwise — as before.
// - "trois": three on every connection, as before.
// - "un": one on every connection.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: the defaults. No import: loadable under node
// (bootReadsSwitch.test.ts).

export type FiltersLoad = "repos" | "ouverture" | "demarrage";
export type Prefetch = "auto" | "trois" | "un";

/** The modes of a build without the testing tools, and the switches' defaults. */
export const DEFAULT_FILTERS_LOAD: FiltersLoad = "repos";
export const DEFAULT_PREFETCH: Prefetch = "auto";

export const FILTERS_LOADS: readonly FiltersLoad[] = ["repos", "ouverture", "demarrage"];
export const PREFETCHES: readonly Prefetch[] = ["auto", "trois", "un"];

/** Under "repos", the dialog's data waits this long after the page's own
 *  tree is on screen, then for an idle moment (at most FILTERS_IDLE_CAP_MS). */
export const FILTERS_IDLE_MS = 3000;
export const FILTERS_IDLE_CAP_MS = 2000;

/** Auditions whose first testimony page is asked for ahead, as before. */
export const PREFETCH_FULL = 3;

function stored<T extends string>(key: string, all: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (all as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The kept modes, else the defaults (garbage or blocked storage too). */
export function storedFiltersLoad(): FiltersLoad {
  return stored("ac:filters-load", FILTERS_LOADS, DEFAULT_FILTERS_LOAD);
}
export function storedPrefetch(): Prefetch {
  return stored("ac:prefetch", PREFETCHES, DEFAULT_PREFETCH);
}

/** This page load's modes. */
export const filtersLoad: FiltersLoad = __TEST_TOOLS__ ? storedFiltersLoad() : DEFAULT_FILTERS_LOAD;
export const prefetch: Prefetch = __TEST_TOOLS__ ? storedPrefetch() : DEFAULT_PREFETCH;

function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** Another mode: kept, and the page loaded again with it. */
export function setFiltersLoad(mode: FiltersLoad) {
  if (!__TEST_TOOLS__ || mode === filtersLoad) return;
  keep("ac:filters-load", mode);
  window.location.reload();
}
export function setPrefetch(mode: Prefetch) {
  if (!__TEST_TOOLS__ || mode === prefetch) return;
  keep("ac:prefetch", mode);
  window.location.reload();
}

/** What the browser says of the connection (navigator.connection: Chrome and
 *  Android; nothing on Safari or Firefox). */
export interface LinkSignals {
  saveData?: boolean;
  effectiveType?: string;
}

/** A link the visitor wants spared: data saver, or a 2g or 3g connection. */
export function linkSpared(link: LinkSignals | null | undefined): boolean {
  if (!link) return false;
  return link.saveData === true || /^(slow-2g|2g|3g)$/.test(link.effectiveType ?? "");
}

/** How many of an open lieu's auditions have their first page asked ahead. */
export function prefetchCount(mode: Prefetch, link: LinkSignals | null | undefined): number {
  if (mode === "un") return 1;
  if (mode === "trois") return PREFETCH_FULL;
  return linkSpared(link) ? 1 : PREFETCH_FULL;
}

/** Whether the dialog's data is asked for now: `opened` (the dialog opened
 *  once), `idle` (the "repos" wait passed), `treeShown` (the page's own tree
 *  is on screen). */
export function filtersDataWanted(
  mode: FiltersLoad,
  s: { opened: boolean; idle: boolean; treeShown: boolean },
): boolean {
  if (s.opened) return true;
  if (mode === "demarrage") return s.treeShown;
  if (mode === "repos") return s.treeShown && s.idle;
  return false;
}
