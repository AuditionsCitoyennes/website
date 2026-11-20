// Which reads of the map page wait (audit candidate C05).
//
// The Filtres dialog's own data — the place picker's tree (every audition on
// the map, /api/places?…&empty=1) and the theme counts and date bounds
// (/api/places/facets), which only the dialog reads — is asked for once the
// page's own tree is on screen, at the browser's first idle moment
// FILTERS_IDLE_MS later, so that it never shares the link with what the first
// view needs; or at once when the dialog opens first. A dialog opened before
// it is in shows its loading state for the time of the read. A place already
// chosen (a stored filter, a link) asks for the picker's tree at once: its
// chip is named from it.
//
// An open lieu's auditions have their first page of testimonies asked for
// ahead: one when the browser says the visitor saves data or the connection
// is slow (2g, 3g), PREFETCH_FULL otherwise.
//
// No import: loadable under node (bootReadsSwitch.test.ts).

/** The dialog's data waits this long after the page's own tree is on screen,
 *  then for an idle moment (at most FILTERS_IDLE_CAP_MS). */
export const FILTERS_IDLE_MS = 3000;
export const FILTERS_IDLE_CAP_MS = 2000;

/** Auditions whose first testimony page is asked for ahead. */
export const PREFETCH_FULL = 3;

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
export function prefetchCount(link: LinkSignals | null | undefined): number {
  return linkSpared(link) ? 1 : PREFETCH_FULL;
}

/** Whether the dialog's data is asked for now: `opened` (the dialog opened
 *  once), `idle` (the wait passed), `treeShown` (the page's own tree is on
 *  screen). */
export function filtersDataWanted(s: {
  opened: boolean;
  idle: boolean;
  treeShown: boolean;
}): boolean {
  return s.opened || (s.treeShown && s.idle);
}
