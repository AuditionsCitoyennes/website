import { getCanonicalLocation, type OnlinePlace } from "@ac/shared";

/**
 * Where an audition is filed on the map. An online audition's location is its
 * town hall's name, already unique and exact: it is never run through the
 * keyword rules of getCanonicalLocation (they would turn "Mairie de
 * Montbron" into Bron's médiathèque).
 */
export function placeKeyOf(a: { location: string; audition_en_ligne?: boolean | null }): string {
  return a.audition_en_ligne ? a.location : getCanonicalLocation(a.location);
}

/** An online audition's town hall, as stored with it (null for any other). */
export function onlinePlaceOf(a: {
  audition_en_ligne?: boolean | null;
  place?: unknown;
}): OnlinePlace | null {
  if (!a.audition_en_ligne || !a.place || typeof a.place !== "object") return null;
  const p = a.place as Partial<OnlinePlace>;
  return typeof p.lat === "number" && typeof p.lng === "number" ? (p as OnlinePlace) : null;
}
