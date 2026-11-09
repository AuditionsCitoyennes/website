// The auditions as the panel lists them — pure: how the association's own
// testimonies group by audition, the ordering, a group's line for the panel
// (or a server list's row), the frame the results are shown in, the page
// size. No Vue, no DOM.
import type { LocationGroup, PlaceResultLieu, PublicTestimony } from "@ac/shared";
import type { Bounds, GeoUnit } from "@/features/geo";

export interface AuditionGroup {
  id: string;
  title: string;
  date: string | null;
  location: string;
  testimonies: PublicTestimony[];
}

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

// The association's own testimonies (all loaded with the page), grouped by
// audition. Found by ID, never by lieu: an audition whose lieu was just edited
// sits under a different place in a snapshot taken a moment earlier — it is
// still one of ours, with its testimonies right here.
export function groupOwnAuditions(testimonies: PublicTestimony[]): Map<string, AuditionGroup> {
  const byAud = new Map<string, AuditionGroup>();
  for (const t of testimonies) {
    const a = t.audition;
    if (!a) continue;
    let g = byAud.get(a.id);
    if (!g) {
      g = { id: a.id, title: a.title, date: a.date, location: a.location, testimonies: [] };
      byAud.set(a.id, g);
    }
    g.testimonies.push(t);
  }
  for (const g of byAud.values()) {
    g.testimonies.sort((x, y) => (x.created_at ?? "").localeCompare(y.created_at ?? ""));
  }
  return byAud;
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

/** The panel's line for an audition of a group, with its testimonies (all
 *  loaded with the page) once they are here; `placeIds`: the lieux' unit ids
 *  by canonical name. */
export function toPanelAudition(
  g: LocationGroup,
  a: LocationGroup["auditions"][number],
  ownAuditions: Map<string, AuditionGroup>,
  placeIds: Map<string, string>,
): PanelAudition {
  const mine = ownAuditions.get(a.id);
  return {
    id: a.id,
    title: a.title,
    date: a.date,
    canonical: g.canonicalName,
    placeId: placeIds.get(g.canonicalName) ?? null,
    count: mine ? mine.testimonies.length : a.testimony_count,
    testimonies: mine ? mine.testimonies : null,
  };
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

// The frame of every lieu of the results (the comparer's twin of the server's
// first-page frame). Not used by the camera.
export function resultBounds(places: GeoUnit[]): Bounds | null {
  if (!places.length) return null;
  const lats = places.map((u) => u.center[0]).sort((a, b) => a - b);
  const lngs = places.map((u) => u.center[1]).sort((a, b) => a - b);
  // A handful of far-flung lieux (overseas, among a thousand in the métropole)
  // would stretch the frame to the whole globe and show nothing. With enough
  // of them to tell, the frame holds the bulk — all but the outermost 3% on
  // each side; the few left outside are still in the list.
  const cut = places.length >= 30 ? Math.floor(places.length * 0.03) : 0;
  const minLat = lats[cut];
  const maxLat = lats[lats.length - 1 - cut];
  const minLng = lngs[cut];
  const maxLng = lngs[lngs.length - 1 - cut];
  // A margin, and a real extent when there is a single lieu.
  const padLat = Math.max((maxLat - minLat) * 0.08, 0.004);
  const padLng = Math.max((maxLng - minLng) * 0.08, 0.004);
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLng: minLng - padLng,
    maxLng: maxLng + padLng,
  };
}
