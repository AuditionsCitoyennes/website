// A lieu with one audition: opening the lieu opens that audition too — the
// list of one line it would show is a step with nothing to choose. Pure (no
// Vue, no DOM): what is known of a lieu's auditions the moment it is opened,
// and the rule that picks the audition to open with it (useNavActions'
// openPlace, which every way of opening a lieu goes through: its dot on the
// map, clicked, tapped or pressed with Enter, and its row in the panel).
//
// Known at once, so the audition opens in the same tick as the lieu — one
// camera command, aimed with the panel already as wide as an open audition
// makes it:
// the server's tree: the lieu's row says how many auditions it holds
// (`auditions`) and which is the newest (`tie`, or its embedded list's first)
// — the one, when there is one.

/** What is known of a lieu's auditions when it is opened. */
export interface LieuAuditionsKnown {
  /** How many auditions the lieu holds. */
  count: number;
  /** One of them (the newest), when one is known. */
  first: string | null;
}

/** From the server's lieu row (PlaceLieuRow's `auditions`, `tie`, `list`). */
export function knownFromRow(row: {
  auditions: number;
  tie?: string;
  list?: readonly (readonly [string, ...unknown[]])[];
}): LieuAuditionsKnown {
  return { count: row.auditions, first: row.list?.[0]?.[0] ?? row.tie ?? null };
}

/**
 * The audition to open with a lieu, or null (the lieu's list, as before).
 * Only for a lieu newly opened — the one already open, opened again (its
 * crumb, its own dot), only brings the map back to it and leaves the reader's
 * audition as it is, open or closed. (With the filters on, openPlace never
 * gets here: a dot there already opens its audition in the results.)
 */
export function auditionToOpen(o: {
  newLieu: boolean;
  known: LieuAuditionsKnown | null;
}): string | null {
  if (!o.newLieu || !o.known) return null;
  return o.known.count === 1 ? o.known.first : null;
}
