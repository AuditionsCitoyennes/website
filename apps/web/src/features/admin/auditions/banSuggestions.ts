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
  properties: { citycode?: string; type?: string; label?: string; name?: string };
}

export function banSearchUrl(query: string): string {
  return `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=${BAN_ASKED}`;
}

export const isPickType = (t: string | undefined): t is BanPick["type"] =>
  (BAN_PICK_TYPES as readonly string[]).includes(t ?? "");

/**
 * The results an admin may pick, in BAN's order: a precise type, a commune
 * code and a point. A label BAN gives twice (a street and a lieu-dit of the
 * same name in the same commune) is offered once.
 */
export function preciseSuggestions<F extends BanFeatureLike>(features: readonly F[]): F[] {
  const seen = new Set<string>();
  return features
    .filter((f) => {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      const precise =
        isPickType(f.properties.type) &&
        !!f.properties.citycode &&
        typeof lat === "number" &&
        typeof lng === "number";
      const label = f.properties.label;
      if (!precise || (label !== undefined && seen.has(label))) return false;
      if (label !== undefined) seen.add(label);
      return true;
    })
    .slice(0, BAN_SHOWN);
}

/**
 * The commune BAN matched the query to, if any. It is not offered, and BAN
 * ranks same-named streets elsewhere before that commune's own ("bron" lists
 * "Bron, Tourch" before any street of Bron 69500, 2026-11-09): the volunteer is told to
 * add the street.
 */
export function typedCommune(features: readonly BanFeatureLike[]): string | null {
  const commune = features.find((f) => f.properties.type === "municipality");
  return commune?.properties.name ?? null;
}
