// What an outline file does when it lands while nothing waits for it — a
// unit's children, its neighbours, the world's outlines, the file of a unit
// the visitor has already left: the file is kept as text and parsed, checked
// and stored only once the map is still (lib/stillMap.ts) — the kept files in
// one write (geo's outlineLoader, `late`). The lines it brings around a
// standing plateau are then drawn by one reshape in place (usePlateau.redress),
// and an outline that changes nothing standing does nothing
// (lib/outlineChange.ts): the plateau pipeline runs once per selection. Each
// file is asked at a fetch priority: high for the one the selected unit's
// plateau waits for, low for the others. A unit's plateau whose own file
// shares the link with the file of a unit just left waits once more for it,
// and is not remembered as slow (data/selfHold.ts).

/** The longest a kept file waits for a still map: past it, it is stored
 *  anyway (a map that never comes to rest still gets its lines). */
export const LATE_CAP_MS = 5000;
