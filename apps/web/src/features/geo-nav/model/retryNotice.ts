// One « Réessayer » at a time on the map page. Two things can offer one: the
// panel's own failure message, in its body (its reads could not be had,
// `ac:recover`), and the long wait's sentence (`ac:slow-sign`, the tapped
// territory's plateau five seconds late), in the panel's head or, on a phone
// whose sheet is lowered, over the map. On a dead network both are due at
// once. The panel's message says more and its button asks for more, so it
// wins wherever it can be seen: the long wait's sentence then stays out, and
// each button asks again for what the other would have (GeoNav).
//
// Pure: loadable under node (retryNotice.test.ts).

/** Where the long wait's sentence and its button show. */
export type SlowWaitPlace = "none" | "head" | "floating";

export function slowWaitPlace(o: {
  /** The tapped territory's plateau is late (tapPendingCore's "late"). */
  late: boolean;
  /** A phone's sheet is lowered: nothing of the panel shows but its strip. */
  sheetHidden: boolean;
  /** The page is the home page's card: it takes no pointer. */
  preview: boolean;
  /** The panel's body shows its failure message and its « Réessayer ». */
  panelFailure: boolean;
}): SlowWaitPlace {
  if (!o.late) return "none";
  // The panel's message is off screen with the sheet: over the map.
  if (o.sheetHidden) return o.preview ? "none" : "floating";
  return o.panelFailure ? "none" : "head";
}
