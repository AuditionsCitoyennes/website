// Countries across the antimeridian (`wrap`, docs/map-outlines.md): their
// outline file's geometry is unwrapped (Russia 19.6 … 191.0, the United
// States −187.6 … −66.9) and it is THE object — fit hull, lines, mesh, hit
// rings, lid and box all read it. Pure: no Vue, nothing at import but
// declarations.
//
// - lngNear: a point tested against such a box is moved by ±360 to the copy
//   nearest the box's middle (a click on Chukotka at −175 is at 185).
// - boxesMeet: two boxes meet, one of them also shifted by ±360.
// - canonicalCopies: for the consumers that work in [-180, 180] only — the
//   DEM selection (the relief renderer projects linearly in lng) and the globe
//   mask —, a derived geometry with each polygon shifted back into range,
//   whole, or cut at ±180 where the build merged it across (Russia, Fiji).
//   Kept in a WeakMap by the source object: never a second store object.
import type { Bounds } from "./types";

type Position = number[];
export type WrapGeometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

const past180 = (b: Bounds) => b.minLng < -180 || b.maxLng > 180;

/** `lng`, or its copy ±360 nearest the middle of `b` when `b` reaches past ±180. */
export function lngNear(lng: number, b: Bounds): number {
  if (!past180(b)) return lng;
  const mid = (b.minLng + b.maxLng) / 2;
  return lng + 360 * Math.round((mid - lng) / 360);
}

const meet = (a: Bounds, b: Bounds, shift: number) =>
  a.minLat <= b.maxLat &&
  a.maxLat >= b.minLat &&
  a.minLng <= b.maxLng + shift &&
  a.maxLng >= b.minLng + shift;

/** The boxes meet, `b` as it is or shifted a world east or west. */
export const boxesMeet = (a: Bounds, b: Bounds): boolean =>
  meet(a, b, 0) || ((past180(a) || past180(b)) && (meet(a, b, 360) || meet(a, b, -360)));

const copies = new WeakMap<object, WrapGeometry>();

/** The ring's part on one side of the meridian `at` (west: lng ≤ at), closed;
 *  null when fewer than three points are left (Sutherland–Hodgman). */
function cutRing(ring: Position[], at: number, west: boolean): Position[] | null {
  const keeps = (p: Position) => (west ? p[0] <= at : p[0] >= at);
  const out: Position[] = [];
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (keeps(a)) out.push(a);
    if (keeps(a) !== keeps(b)) out.push([at, a[1] + ((at - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]);
  }
  if (out.length < 3) return null;
  out.push(out[0]);
  return out;
}

const shifted = (poly: Position[][], by: number) =>
  poly.map((ring) => ring.map(([lng, lat]) => [lng + by, lat]));

/** The polygon in [-180, 180]: as it is, shifted whole by ±360, or — one the
 *  build merged across ±180 (Russia's mainland with Chukotka, Fiji's
 *  Vanua Levu) — cut there, the far part shifted. */
function canonicalPolys(poly: Position[][]): Position[][][] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [lng] of poly[0] ?? []) {
    if (lng < lo) lo = lng;
    if (lng > hi) hi = lng;
  }
  if (lo >= -180 && hi <= 180) return [poly];
  if (lo >= 180) return [shifted(poly, -360)];
  if (hi <= -180) return [shifted(poly, 360)];
  const at = hi > 180 ? 180 : -180;
  const part = (west: boolean) => {
    const rings = poly.map((r) => cutRing(r, at, west));
    return rings[0] ? rings.filter((r): r is Position[] => !!r) : null;
  };
  const near = part(at === 180);
  const far = part(at !== 180);
  return [...(near ? [near] : []), ...(far ? [shifted(far, at === 180 ? -360 : 360)] : [])];
}

/** The geometry with every polygon in [-180, 180]: the same object when none
 *  needs moving, else one derived copy per source object. */
export function canonicalCopies(g: WrapGeometry): WrapGeometry {
  const cached = copies.get(g);
  if (cached) return cached;
  if (!Array.isArray(g?.coordinates) || (g.type !== "Polygon" && g.type !== "MultiPolygon"))
    return g;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const parts = polys.map(canonicalPolys);
  if (parts.every((p, i) => p.length === 1 && p[0] === polys[i])) {
    copies.set(g, g);
    return g;
  }
  const flat = parts.flat();
  const out: WrapGeometry =
    flat.length === 1
      ? { type: "Polygon", coordinates: flat[0] }
      : { type: "MultiPolygon", coordinates: flat };
  copies.set(g, out);
  copies.set(out, out);
  return out;
}
