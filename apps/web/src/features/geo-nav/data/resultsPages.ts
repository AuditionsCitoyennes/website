// The server's results pages as the panel holds them (map phase 1, design E1
// (K)) — pure: when a new answer is the same list as the one on screen (the
// corpus keys that on the auditions' ids; the server's first page and totals
// stand for them), how far it must be read before it goes on screen, and how
// a read through an audition (results?through=) extends the pages loaded. No
// Vue, no DOM, no request.

import type { PlaceResultsCursor, PlaceResultsPage, PlaceSort } from "@ac/shared";

/** A results page, with what it was asked under. */
export interface ResultsPage extends PlaceResultsPage {
  key: string;
  sort: PlaceSort;
}

/** An infinite query's data (vue-query's InfiniteData). */
export interface ResultsData {
  pages: ResultsPage[];
  pageParams: (PlaceResultsCursor | null)[];
}

/** The results' rows over every page loaded, each audition once. */
export function rowsOf<T extends { id: string }>(pages: readonly { auditions: T[] }[]): T[] {
  if (pages.length === 1) return pages[0].auditions;
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of pages) {
    for (const a of p.auditions) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

/** The first page holds every result. */
function whole(first: PlaceResultsPage): boolean {
  return !first.next;
}

/** What the totals and the frame say of the set (the same set: the same). */
function setOf(first: PlaceResultsPage): string {
  const t = first.total;
  return `${t?.auditions ?? 0}|${t?.lieux ?? 0}|${first.frame?.join(",") ?? ""}`;
}

/**
 * The list's signature (corpus: every result's id, in order): read from its
 * top when it changes. Every id when the first page holds them all; else the
 * set's figures and the first page's ids. Never the pages appended after it,
 * nor the filter key: a new key that lists the same auditions in the same
 * order is the same list.
 */
export function orderSig(first: PlaceResultsPage): string {
  const ids = first.auditions.map((a) => a.id).join(",");
  return whole(first) ? ids : `${setOf(first)}|${ids}`;
}

/**
 * The set's signature (corpus: every result's id, sorted): the map frames it
 * again when it changes. Every id when the first page holds them all; else
 * the totals and the frame (the same whichever the order).
 */
export function setSig(first: PlaceResultsPage): string {
  if (whole(first)) {
    return first.auditions
      .map((a) => a.id)
      .sort()
      .join(",");
  }
  return setOf(first);
}

/**
 * The audition a new answer must be read as far as before it goes on screen
 * (results?through=), or null:
 * - the same list as the one on screen (orderSig): as far as its last row,
 *   so that nothing listed goes (the corpus' reveal stays);
 * - else the audition being read, opened from the list on screen (or kept
 *   open there, whether it matched unknown), when the first page does not
 *   hold it: whether it still matches, and where (the corpus' reveal: as far
 *   as it).
 */
export function readTarget(
  pages: readonly PlaceResultsPage[],
  shown: { pages: readonly PlaceResultsPage[]; unknown?: string | null } | null,
  open: string | null,
): string | null {
  const first = pages[0];
  if (!first || !shown?.pages.length) return null;
  const rows = rowsOf(pages);
  const more = !!pages[pages.length - 1].next;
  if (!more) return null;
  const before = rowsOf(shown.pages);
  if (orderSig(first) === orderSig(shown.pages[0])) {
    const last = before[before.length - 1];
    return before.length > rows.length && last ? last.id : null;
  }
  if (!open || (shown.unknown !== open && !before.some((a) => a.id === open))) return null;
  return rows.some((a) => a.id === open) ? null : open;
}

/**
 * The pages loaded, extended by a read through an audition (rows from the
 * first up to it): the rows beyond those loaded as one more page — or that
 * read alone, when the rows moved under the pages loaded. Unchanged when it
 * adds nothing.
 */
export function withThrough(
  old: ResultsData | undefined,
  page: PlaceResultsPage,
  key: string,
  sort: PlaceSort,
): ResultsData | undefined {
  if (!old?.pages.length) return old;
  const loaded = rowsOf(old.pages);
  if (page.auditions.length <= loaded.length) return old;
  if (loaded.some((a, i) => page.auditions[i].id !== a.id)) {
    return { pages: [{ ...page, key, sort }], pageParams: [null] };
  }
  const last = old.pages[old.pages.length - 1];
  const rest: ResultsPage = {
    auditions: page.auditions.slice(loaded.length),
    next: page.next,
    key,
    sort,
  };
  return { pages: [...old.pages, rest], pageParams: [...old.pageParams, last.next] };
}

/** The first page alone (a key or order come back to is read again from its
 *  top, as the corpus' reveal restarts); unchanged when that is all it holds. */
export function firstPageOnly(old: ResultsData | undefined): ResultsData | undefined {
  if (!old || old.pages.length <= 1) return old;
  return { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) };
}
