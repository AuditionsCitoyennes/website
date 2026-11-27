// The audition a lieu opens with. Pure (no Vue, no DOM): what is known of a
// lieu's auditions the moment it is opened, and the rule that picks the
// audition to open with it (useNavActions' openPlace, which every way of
// opening a lieu goes through: its pin on the map, clicked, tapped or pressed
// with Enter, its row in the panel and its crumb).
//
// - A lieu with one audition opens it, whichever way it is opened: the list
//   of one line it would show is a step with nothing to choose.
// - A lieu of several auditions opens its list, whichever way it is opened:
//   the reader picks the audition. With the filters on, a pin already opens
//   the first result held there.
//
// Known at once, so the audition opens in the same tick as the lieu — one
// camera command, aimed with the panel already as wide as an open audition
// makes it: the server's tree row says how many auditions the lieu holds
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
 * The audition to open with a lieu, or null (the lieu's list). Only for a
 * lieu newly opened — the one already open, opened again (its crumb, its own
 * pin), only brings the map back to it and leaves the reader's audition as it
 * is, open or closed. (With the filters on, openPlace never gets here: a pin
 * there already opens its audition in the results.)
 */
export function auditionToOpen(o: {
  newLieu: boolean;
  known: LieuAuditionsKnown | null;
}): string | null {
  if (!o.newLieu || !o.known) return null;
  return o.known.count === 1 ? o.known.first : null;
}

/**
 * The phone's sheet waits for the text of the audition a lieu opened with
 * (true; panel/sheetFit's textWait), so that it moves once, the text in:
 * the lieu opened from its pin or from its row in the panel, with its one
 * audition open at once. Its crumb never opens a lieu anew — it is the lieu
 * already open — and leaves the sheet under the rule of any open audition.
 */
export function waitsForText(o: { only: string | null; via: "map" | "panel" | "crumb" }): boolean {
  return o.only !== null && o.via !== "crumb";
}

/**
 * The lieu's crumb, or the back arrow, folds the audition being read back
 * into the lieu's list (true) — or the crumb only brings the map back to the
 * lieu and the arrow goes up to the territory (false): an audition read
 * from a lieu's list goes back to that list. Only for a lieu of several
 * auditions — the list of one line a lieu of one would show is the step
 * lieuSingle leaves out — and only with one of them open.
 */
export function foldsToList(o: {
  lieuOpen: boolean;
  auditionOpen: boolean;
  count: number;
}): boolean {
  return o.lieuOpen && o.auditionOpen && o.count >= 2;
}
