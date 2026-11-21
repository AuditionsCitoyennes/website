// The figures behind the on-map analyses: for every unit of the hierarchy, what
// the association heard there (its own testimonies, auditions, lieux, themes).
// A Grand Débat report is never a témoignage and never adds to them.
//
// Every unit's figures come with the server's tree (its facts, factsStats):
// what a scope's analysis is made of.

import { AUDITION_THEMES, type AuditionTheme } from "@ac/shared";
import type { GeoUnit, LevelKey } from "@/features/geo";

export type Reliability = "solide" | "indicatif" | "chips" | "trop-peu";

export interface ScopeAnalysis {
  scopeId: string; // = GeoUnit.id
  label: string; // unit label ("Rhône")
  levelLabel: string; // "Pays" | "Région" | "Département" | "Ville" | "Arrondissement"
  testimonies: number; // own testimonies PLACED in this unit (archive never counted)
  auditions: number; // own auditions
  lieux: number; // own lieux (distinct canonicals)
  communes: number; // own communes (distinct v: ids)
  concentration: { lieu: string; count: number; share: number } | null; // the largest single audition when it holds > 25 %
  themes: { theme: AuditionTheme; count: number; auditions: number }[]; // all 16, count desc (testimonies citing it, not tags)
  themeBase: number; // testimonies with >= 1 grid theme
  untagged: number; // own testimonies with no topics yet
  approx: number; // testimonies whose grid themes are approximate-only
  reliability: Reliability;
  reliabilityReason: string | null; // short French reason when not "solide"
}

/** A unit's figures — what its analysis is made of: read from the database's
 *  facts (factsStats). */
export interface UnitFigures {
  testimonies: number;
  auditions: number;
  lieux: number;
  communes: number;
  cohorts: { terrain: number; cahier2019: number; archive: number };
  /** Per AUDITION_THEMES index: testimonies citing it. */
  themes: ArrayLike<number>;
  /** Per AUDITION_THEMES index: auditions with a testimony citing it. */
  themeAuditions: ArrayLike<number>;
  themeBase: number;
  untagged: number;
  approx: number;
  /** Its real audition dates' span (the reliability's "2025-26"). */
  first: string | null;
  last: string | null;
  /** The audition with the most testimonies: how many, and its lieu (canonical
   *  name and ville, as the lieu is labelled). */
  largest: { n: number; key: string; city: string | null } | null;
}

/** Opaque to callers: built once per data load (buildFactsIndex from the
 *  server's facts). */
export interface UnitStatsIndex {
  readonly kind: "unit-stats";
  /** A unit's figures; undefined: none known (yet). */
  figuresOf(id: string): UnitFigures | undefined;
}

const THEME_COUNT = AUDITION_THEMES.length;

/** What a scope's analysis owes to its figures alone, kept per scope id. */
interface ScopeCore {
  themes: ScopeAnalysis["themes"];
  reliability: Reliability;
  reason: string | null;
  share: number;
}

interface IndexImpl extends UnitStatsIndex {
  cores: Map<string, ScopeCore>;
}

/** A unit with no own audition: nothing heard there. */
export const NO_FIGURES: UnitFigures = Object.freeze({
  testimonies: 0,
  auditions: 0,
  lieux: 0,
  communes: 0,
  cohorts: Object.freeze({ terrain: 0, cahier2019: 0, archive: 0 }),
  themes: new Int32Array(THEME_COUNT),
  themeAuditions: new Int32Array(THEME_COUNT),
  themeBase: 0,
  untagged: 0,
  approx: 0,
  first: null,
  last: null,
  largest: null,
});

/** An index over figures already gathered (`figuresOf`). */
export function statsIndex(figuresOf: (id: string) => UnitFigures | undefined): UnitStatsIndex {
  const index: IndexImpl = { kind: "unit-stats", figuresOf, cores: new Map() };
  return index;
}

const LEVEL_NAME: Record<LevelKey, string> = {
  world: "Monde",
  country: "Pays",
  region: "Région",
  dep: "Département",
  city: "Ville",
  arr: "Arrondissement",
  place: "Lieu",
};

// "2025-26", "2026": the years a unit's own street auditions span.
function yearsOf(first: string | null, last: string | null): string {
  if (!first || !last) return "récents";
  const a = first.slice(0, 4);
  const b = last.slice(0, 4);
  return a === b ? a : `${a}-${b.slice(2)}`;
}

/**
 * How far a unit's themes can be read. n = testimonies with a grid theme:
 * under 5 nothing is shown, under 10 rough shares only. "solide" asks for 30 of them
 * from at least 3 auditions, none holding more than half, all of one period.
 */
function reliabilityOf(s: UnitFigures): { level: Reliability; reason: string | null } {
  const n = s.themeBase;
  if (n < 5) return { level: "trop-peu", reason: "moins de 5 témoignages analysés" };
  if (n < 10) return { level: "chips", reason: "moins de 10 témoignages analysés" };
  const count = s.auditions;
  const maxShare = s.testimonies ? (s.largest?.n ?? 0) / s.testimonies : 0;
  const top = Math.max(s.cohorts.terrain, s.cohorts.cahier2019, s.cohorts.archive);
  const mono = top >= 0.9 * s.testimonies;
  if (n >= 30 && count >= 3 && maxShare <= 0.5 && mono) return { level: "solide", reason: null };
  let reason: string;
  if (n < 30) reason = "moins de 30 témoignages analysés";
  else if (count < 3) reason = count === 1 ? "une seule audition" : "deux auditions seulement";
  else if (maxShare > 0.5) reason = "plus de la moitié vient d'une seule audition";
  else if (s.cohorts.terrain && s.cohorts.cahier2019 && !s.cohorts.archive) {
    reason = `témoignages 2019 et ${yearsOf(s.first, s.last)} mêlés`;
  } else reason = "témoignages d'époques différentes mêlés";
  return { level: "indicatif", reason };
}

function coreOf(index: IndexImpl, id: string, s: UnitFigures): ScopeCore {
  let core = index.cores.get(id);
  if (core) return core;
  const themes = AUDITION_THEMES.map((theme, i) => ({
    theme,
    count: s.themes[i],
    auditions: s.themeAuditions[i],
  })).sort((a, b) => b.count - a.count || b.auditions - a.auditions);
  const { level, reason } = reliabilityOf(s);
  core = {
    themes,
    reliability: level,
    reason,
    share: s.testimonies ? (s.largest?.n ?? 0) / s.testimonies : 0,
  };
  index.cores.set(id, core);
  return core;
}

// ---- One scope ---------------------------------------------------------------

/** An analysis shown on another unit: its figures, that unit's name and
 *  plateau (the server's tree, while the unit's own figures are on their way:
 *  "Analyses en attente" = garder). */
export function analysisOn(a: ScopeAnalysis, unit: GeoUnit): ScopeAnalysis {
  return { ...a, scopeId: unit.id, label: unit.label, levelLabel: LEVEL_NAME[unit.levelKey] };
}

/** The analysis of one unit, from the index built for the data on screen
 *  (`placeLabel`: the largest audition's lieu, as the map names it). A unit
 *  the index has no figures for has heard nothing. */
export function analyseScope(
  unit: GeoUnit,
  index: UnitStatsIndex,
  opts: { placeLabel: (lieu: { key: string; city: string | null }) => string },
): ScopeAnalysis | null {
  if (unit.levelKey === "world") return null;
  const idx = index as IndexImpl;
  const s = idx.figuresOf(unit.id) ?? NO_FIGURES;
  const core = coreOf(idx, unit.id, s);
  const largest = s.largest;
  return {
    scopeId: unit.id,
    label: unit.label,
    levelLabel: LEVEL_NAME[unit.levelKey],
    testimonies: s.testimonies,
    auditions: s.auditions,
    lieux: s.lieux,
    communes: s.communes,
    // Among several auditions only: one alone holds everything by definition.
    concentration:
      largest && s.auditions > 1 && core.share > 0.25
        ? {
            lieu: opts.placeLabel(largest),
            count: largest.n,
            share: core.share,
          }
        : null,
    themes: core.themes,
    themeBase: s.themeBase,
    untagged: s.untagged,
    approx: s.approx,
    reliability: core.reliability,
    reliabilityReason: core.reason,
  };
}
