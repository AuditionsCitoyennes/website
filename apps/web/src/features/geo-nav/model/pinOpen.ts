// What a click (or a tap, or Enter) on a lieu's pin opens, on the map with no
// filters on, for a lieu of several auditions: "premiere" (the default) — the
// audition at the top of the lieu's list, open at once, its list one press
// away (that audition's line, pressed, folds it back into the list) — or
// "liste": the lieu's list, nothing open (as before). A lieu of one audition
// opens it either way (lieuSingle), a lieu's row in the panel opens its list
// either way, and with the filters on a pin already opens the first result
// held there. The testing options menu compares the two (pinOpenSwitch).
//
// Pure: no imports (devOptions.test.ts loads it under node).

export const PIN_OPEN_MODES = ["premiere", "liste"] as const;
export type PinOpenMode = (typeof PIN_OPEN_MODES)[number];
export const DEFAULT_PIN_OPEN: PinOpenMode = "premiere";
