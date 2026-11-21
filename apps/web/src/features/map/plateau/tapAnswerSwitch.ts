// How a tap on a territory is answered while the data of its plateau comes
// in: the PENDING mark, shown on the tapped unit from the tap until its
// plateau rises (gl/PendingMarkPass.ts draws it, geo-nav's
// model/tapPendingCore.ts decides when the pending state ends). The same on
// every device, for a mouse, a finger, a pen or a key:
// - the unit is filled with flat violet at once, without rising; no name tag
//   on the map — the unit's own pin goes with the tap, as any scope's does;
// - when the wait lasts (the data not all in a fifth of a second after the
//   mark's first frame), a loading line runs along its
//   boundary, covering the share of the boundary's length that the data has
//   reached (plateau/tapProgress.ts): from nothing to the whole boundary
//   when everything is in. A shorter wait draws no line at all;
// - then, as the rise is about to start, the violet fades to a fifth of
//   itself (the line with it), and that last share goes with the rise's own
//   first frame: the unit is never bare and flat, and no violet rides a
//   rising lid.
//
// The loading line's colour is the boundary lines' violet #7C5CFF, same hue,
// darker: #3514B8 — it reads over the fill by its depth and stays
// blue-violet (TAP_LINE_RGB).

/** The loading line's colour, straight sRGB 0..1: #3514B8 (the map's violet,
 *  darker). */
export const TAP_LINE_RGB: readonly [number, number, number] = [0.208, 0.078, 0.722];

/** What a tap's mark is made of. */
export interface TapMark {
  line: boolean;
  fill: boolean;
}

/** The mark of a tap, whatever made it: the fill and the line. */
export const TAP_MARK: TapMark = { line: true, fill: true };
