import { isGenericLocation, type AuditionArea } from "@ac/shared";

// How the Témoignages map places an audition's lieu, as the admin list tells
// it: nothing for a point or a commune; for a lieu placed only at its
// département or région, or left off the map, what it means and how to write
// it for the map to place it (see apps/api geo/match.ts).

/** What the list says of a lieu the map does not place on a point or a commune. */
export interface PlacementNote {
  label: string;
  /** What it means, and how to write the lieu for the map to place it. */
  hint: string;
  /** Off the map: a chip that stands out, rather than a light word. */
  off: boolean;
}

const HOW_TO_WRITE = "« Commune, Département » ou « Commune (05) »";

export function placementNote(area: AuditionArea | null | undefined): PlacementNote | null {
  if (!area) return null;
  // "France", "En ligne"…: on no point of the map on purpose.
  if (
    (area.placement === "unplaced" || area.placement === "pending") &&
    isGenericLocation(area.canonicalName)
  ) {
    return {
      label: "sans lieu précis",
      hint: "Lieu général : ses témoignages ne sont sur aucun point de la carte, ils sont rangés sous « Sans lieu précis ».",
      off: false,
    };
  }
  switch (area.placement) {
    case "unplaced": {
      const named = (area.candidates ?? []).map((c) =>
        c.departementCode ? `${c.name} (${c.departementCode})` : c.name,
      );
      return {
        label: "Non placé sur la carte",
        hint: named.length
          ? `Plusieurs communes portent ce nom : ${named.join(", ")}. Précisez laquelle, par exemple « ${named[0]} ».`
          : `Aucune commune, aucun département ni aucune région ne porte ce nom. Écrivez le lieu ${HOW_TO_WRITE}, avec le nom actuel de la commune (celui de la nouvelle, si elle a fusionné).`,
        off: true,
      };
    }
    case "departement": {
      const how =
        area.departementName && area.departementCode
          ? `« Commune, ${area.departementName} » ou « Commune (${area.departementCode}) »`
          : HOW_TO_WRITE;
      return {
        label: "placé au niveau du département",
        hint: `Seul le département est reconnu : le lieu est placé en son centre. Pour un point plus précis, écrivez ${how}.`,
        off: false,
      };
    }
    case "region":
      return {
        label: "placé au niveau de la région",
        hint: `Seule la région est reconnue : le lieu est placé en son centre. Pour un point plus précis, écrivez ${HOW_TO_WRITE}.`,
        off: false,
      };
    case "pending":
      return {
        label: "placement en cours",
        hint: "Ce lieu n'a pas encore été cherché : il l'est en ce moment. Rechargez la page dans un instant pour voir où il est placé.",
        off: false,
      };
    default:
      return null;
  }
}
