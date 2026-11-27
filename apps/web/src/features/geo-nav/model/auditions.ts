// The auditions as the panel lists them — pure: the ordering, a server list's
// row as the panel's line, the page size. No Vue, no DOM.
import type { PlaceResultLieu, PublicTestimony } from "@ac/shared";

/** Audition ordering inside a place's panel. */
export type AuditionSort = "recent" | "ancien";

/** Audition ordering — newest first by default, oldest first when asked. */
export function bySort(
  a: { date: string | null },
  b: { date: string | null },
  sort: AuditionSort | undefined,
): number {
  // Undated ones go last whichever way the dates run.
  if (!a.date !== !b.date) return a.date ? -1 : 1;
  const cmp = (a.date ?? "").localeCompare(b.date ?? "");
  return sort === "ancien" ? cmp : -cmp;
}

/** A lieu's auditions in the order its panel lists them (bySort; the sort is
 *  stable, so equal dates keep the server's order): usePanelAuditions'
 *  placeAuditions. */
export function lieuListOrder<T extends { date: string | null }>(
  rows: readonly T[],
  sort: AuditionSort | undefined,
): T[] {
  return [...rows].sort((a, b) => bySort(a, b, sort));
}

/** An audition as the panel lists it, in a lieu's detail or in the results. */
export interface PanelAudition {
  id: string;
  title: string;
  date: string | null;
  /** The lieu it was held at. */
  canonical: string;
  /** Its lieu's unit id; null when the lieu is not on the map. */
  placeId: string | null;
  count: number;
  /** null: not in memory yet (the testimonies are still loading). */
  testimonies: PublicTestimony[] | null;
  /** The server's lists: more testimonies than are listed (the next page). */
  more?: boolean;
  /** The server's lists: its testimonies could not be had. */
  failed?: boolean;
  /** A result of the server's (its lieu, as the results row places it). */
  lieu?: PlaceResultLieu;
}

/** The panel's line for an audition of the server's lists (map phase 1, K):
 *  its lieu, its testimonies once the open one's are here. */
export function serverPanelAudition(
  a: { id: string; title: string; date: string; n: number },
  place: { id: string; canonical: string; lieu?: PlaceResultLieu },
  testimonies: { list: PublicTestimony[] | null; more: boolean; failed: boolean },
): PanelAudition {
  const out: PanelAudition = {
    id: a.id,
    title: a.title,
    date: a.date,
    canonical: place.canonical,
    placeId: place.id,
    count: a.n,
    testimonies: testimonies.list,
  };
  if (testimonies.more) out.more = true;
  if (testimonies.failed) out.failed = true;
  if (place.lieu) out.lieu = place.lieu;
  return out;
}

/** An audition's testimonies — null while they are not here (yet). */
export function testimoniesOf(a: PanelAudition): PublicTestimony[] | null {
  return a.testimonies;
}

// Many auditions can match a wide filter: the list is filled a page at a time
// as the reader scrolls down it.
export const RESULTS_PAGE = 50;
