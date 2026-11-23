// The audition a lieu opens with. Pure (no Vue, no DOM): what is known of a
// lieu's auditions the moment it is opened, and the rule that picks the
// audition to open with it (useNavActions' openPlace, which every way of
// opening a lieu goes through: its pin on the map, clicked, tapped or pressed
// with Enter, its row in the panel and its crumb).
//
// - A lieu with one audition opens it, whichever way it is opened: the list
//   of one line it would show is a step with nothing to choose.
// - A lieu of several auditions opened from its pin on the map opens the
//   audition at the top of its list (pinOpen.ts: "premiere", the default) —
//   the very line the panel shows first, in the panel's own order
//   (auditions.ts' lieuListOrder, the sort chosen included). Its row in the
//   panel, or the "liste" choice, opens its list.
//
// Known at once, so the audition opens in the same tick as the lieu — one
// camera command, aimed with the panel already as wide as an open audition
// makes it: the server's tree row says how many auditions the lieu holds
// (`auditions`), which is the newest (`tie`, or its embedded list's first)
// and, with its list embedded, which tops the panel's list. Without the list
// (the server's lazy path) a lieu of several auditions waits for it
// (AWAIT_LIST): the newest on the map may not be one the list holds.

import { lieuListOrder, type AuditionSort } from "./auditions";
import type { PinOpenMode } from "./pinOpen";

/** What is known of a lieu's auditions when it is opened. */
export interface LieuAuditionsKnown {
  /** How many auditions the lieu holds. */
  count: number;
  /** One of them (the newest), when one is known. */
  first: string | null;
  /** The one at the top of the panel's list (its embedded list, in the
   *  panel's order); null: the list is not embedded. */
  top: string | null;
}

/** From the server's lieu row (PlaceLieuRow's `auditions`, `tie`, `list`),
 *  the panel's list in `sort`'s order. */
export function knownFromRow(
  row: {
    auditions: number;
    tie?: string;
    list?: readonly (readonly [string, string, string | null, ...unknown[]])[];
  },
  sort?: AuditionSort,
): LieuAuditionsKnown {
  const listed = row.list ? row.list.map(([id, , date]) => ({ id, date })) : null;
  return {
    count: row.auditions,
    first: row.list?.[0]?.[0] ?? row.tie ?? null,
    top: listed ? (lieuListOrder(listed, sort)[0]?.id ?? null) : null,
  };
}

/** A lieu of several auditions whose list is not here yet: its top opens once
 *  it is listed (usePanelAuditions' openTopWhenListed). */
export const AWAIT_LIST = "await-list" as const;

/** How the lieu was opened: its pin on the map, its row in the panel, its crumb. */
export type LieuVia = "map" | "panel" | "crumb";

/**
 * The audition to open with a lieu, AWAIT_LIST, or null (the lieu's list, as
 * before). Only for a lieu newly opened — the one already open, opened again
 * (its crumb, its own pin), only brings the map back to it and leaves the
 * reader's audition as it is, open or closed. (With the filters on, openPlace
 * never gets here: a pin there already opens its audition in the results.)
 */
export function auditionToOpen(o: {
  newLieu: boolean;
  known: LieuAuditionsKnown | null;
  via: LieuVia;
  mode: PinOpenMode;
}): string | typeof AWAIT_LIST | null {
  if (!o.newLieu || !o.known) return null;
  if (o.known.count === 1) return o.known.first;
  if (o.via !== "map" || o.mode !== "premiere" || o.known.count < 2) return null;
  // Never the newest (`first`) for several: the list's top may be another.
  return o.known.top ?? AWAIT_LIST;
}
