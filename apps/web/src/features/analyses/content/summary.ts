// What the plates say in words: a territory's analysis in a few sentences for
// a screen reader (GeoNav's live region says it once the territory has
// settled), and what the ring leaves unsaid, for the overlay's reading notes.
import type { ScopeAnalysis } from "../stats/scopeStats";
import { fmtN, plural, shortName } from "./text";

export interface SummaryOpts {
  /** Filters are on: the figures count only what they let through. */
  filtered: boolean;
  /** The themes picked in Filtres: in every testimony counted, only named. */
  themeFilter: readonly string[];
}

export function analysisSummary(a: ScopeAnalysis, o: SummaryOpts): string {
  const filtered = o.filtered;
  const lines = [
    `Analyses : ${a.label}, ${a.levelLabel.toLowerCase()}${filtered ? ", selon les filtres" : ""}.`,
  ];
  if (!a.testimonies) {
    // Filtered, the association's auditions here may only be left out.
    lines.push(
      filtered
        ? "Aucun témoignage de l'association ne correspond aux filtres ici."
        : "Aucune audition de l'association ici pour l'instant.",
    );
  } else {
    lines.push(
      [
        plural(a.testimonies, "témoignage", "témoignages"),
        plural(a.auditions, "audition", "auditions"),
        plural(a.lieux, "lieu", "lieux"),
        plural(a.communes, "commune", "communes"),
      ].join(", ") + ".",
    );
    if (a.concentration) {
      lines.push(
        `Dont ${fmtN(a.concentration.count)} lors d'une seule audition : ${a.concentration.lieu}.`,
      );
    }
    // A theme picked in the filters is in every testimony counted (or one of
    // those picked is): not ranked, only named.
    const chosen = o.themeFilter;
    const top = a.themes.filter((t) => t.count > 0 && !chosen.includes(t.theme)).slice(0, 3);
    if (a.reliability !== "trop-peu" && top.length) {
      const how =
        a.reliability === "solide"
          ? "fiabilité solide"
          : a.reliability === "indicatif"
            ? `indicatif${a.reliabilityReason ? `, ${a.reliabilityReason}` : ""}`
            : "peu de témoignages";
      const besides = chosen.length
        ? `, hors ${chosen.length > 1 ? "thèmes" : "thème"} du filtre (${chosen.join(", ")})`
        : "";
      lines.push(
        `Thèmes les plus abordés${besides} : ${top.map((t) => t.theme).join(", ")} (${how}).`,
      );
    }
  }
  return lines.join(" ");
}

/**
 * What the ring leaves unsaid — how many testimonies it is read from, how far
 * to trust it, what the filters do to it —, for the reading notes. Empty with
 * no testimony. `themeFilter`: the themes picked in Filtres (canonical names).
 */
export function ringReading(s: ScopeAnalysis, themeFilter: readonly string[]): string {
  if (!s.testimonies) return "";
  const analysed = plural(s.themeBase, "témoignage analysé", "témoignages analysés");
  const parts = [s.untagged ? `${analysed}, ${fmtN(s.untagged)} pas encore` : analysed];
  const reason = s.reliabilityReason;
  if (s.reliability === "solide") parts.push("fiabilité solide");
  else if (s.reliability === "indicatif")
    parts.push(reason ? `indicatif : ${reason}` : "indicatif");
  else if (s.reliability === "chips") parts.push("peu de témoignages : parts très approximatives");
  else parts.push("trop peu de témoignages pour en tirer les thèmes");
  if (s.approx) {
    parts.push(`${fmtN(s.approx)} ${s.approx > 1 ? "rattachés" : "rattaché"} à un thème voisin`);
  }
  // The themes picked in Filtres, as the notes name them.
  const named = new Set<string>(themeFilter);
  const f = s.themes.filter((t) => named.has(t.theme)).map((t) => `« ${shortName(t.theme)} »`);
  if (f.length === 1)
    parts.push(`${f[0]} présent dans tous, par le filtre, et laissé hors du cercle`);
  else if (f.length > 1) {
    parts.push(
      `${f.slice(0, -1).join(", ")} ou ${f[f.length - 1]} dans chacun, par le filtre, et laissés hors du cercle`,
    );
  }
  return `Thèmes ici : ${parts.join(" · ")}.`;
}
