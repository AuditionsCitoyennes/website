// What the location combobox asks the Base Adresse Nationale and which of its
// results it offers. No `type=` parameter: BAN keeps only the last of
// repeated `type` values and refuses a comma list (checked 2026-11-09), so
// one request cannot ask for streets, house numbers and lieux-dits at once.
// Instead more results are asked for and the communes are dropped here.

import { BAN_PICK_TYPES, type BanPick } from "@ac/shared";

/** How many BAN results are asked for: communes are dropped, so more than are shown. */
export const BAN_ASKED = 10;
/** How many suggestions are shown. */
export const BAN_SHOWN = 5;

/** The fields of a BAN result the filter reads. */
export interface BanFeatureLike {
  geometry?: { coordinates?: [number, number] };
  properties: { citycode?: string; type?: string };
}

export function banSearchUrl(query: string): string {
  return `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=${BAN_ASKED}`;
}

export const isPickType = (t: string | undefined): t is BanPick["type"] =>
  (BAN_PICK_TYPES as readonly string[]).includes(t ?? "");

/** The results an admin may pick, in BAN's order: a precise type, a commune code and a point. */
export function preciseSuggestions<F extends BanFeatureLike>(features: readonly F[]): F[] {
  return features
    .filter((f) => {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      return (
        isPickType(f.properties.type) &&
        !!f.properties.citycode &&
        typeof lat === "number" &&
        typeof lng === "number"
      );
    })
    .slice(0, BAN_SHOWN);
}
