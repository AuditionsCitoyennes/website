// What the map frames while filters are on (useCamera.scheduleFilterFrame):
// the country the visitor is in — framed as its crumb frames it — not every
// matching lieu (a world-wide frame, as a rule). At the world, nothing. Pure:
// no Vue, type imports only.
import type { GeoUnit } from "@/features/geo";

/** The unit the camera frames for the filters: the scope's country (the scope
 *  itself when it is one), found among its ancestors in `index`; null at the
 *  world, with filters off, or when the index does not hold it. */
export function filterFrameUnit(
  scope: GeoUnit,
  index: ReadonlyMap<string, GeoUnit>,
  listMode: boolean,
): GeoUnit | null {
  if (!listMode) return null;
  if (scope.levelKey === "country") return scope;
  for (const id of scope.ancestors) {
    const u = index.get(id);
    if (u?.levelKey === "country") return u;
  }
  return null;
}

/** Whether the camera still stands on the frame it gave `unitId`: the last
 *  unit fit framed it, no command came after it, no hand has moved the map. */
export function stillFramed(
  unitId: string,
  framed: { key: number; unitId: string } | null,
  cameraKey: number,
  movedByUser: boolean,
): boolean {
  return !!framed && framed.unitId === unitId && framed.key === cameraKey && !movedByUser;
}
