// A latch: the map's first plateau has stood (finished its rise) since the map
// was made. usePlateau sets it at the end of a rise that is still the current
// run; GeoDrillMap lowers it when a map is made (a new map, a new first
// plateau). What waits for it reads `plateauHasStood()` and hears
// `onPlateauStood` (geo-nav's decorative outline batches,
// geo-nav/data/outlinesDecorSwitch.ts). No import: loadable under node.

let stood = false;
const listeners = new Set<() => void>();

/** The first plateau of the current map has stood. */
export function plateauHasStood(): boolean {
  return stood;
}

/** `listener` runs when the latch rises (not if it is up already: read
 *  `plateauHasStood()` first). Returns its removal. */
export function onPlateauStood(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A plateau has stood: the latch rises (once per map), its listeners run. */
export function markPlateauStood(): void {
  if (stood) return;
  stood = true;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[plateau-stood] listener", err);
    }
  }
}

/** A new map: its first plateau is still to come. */
export function resetPlateauStood(): void {
  stood = false;
}
