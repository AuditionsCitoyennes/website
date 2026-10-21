// The figures behind the on-map analyses: for every unit of the hierarchy, what
// the association heard there (its own testimonies, auditions, lieux, themes).
// A Grand Débat report is never a témoignage and never adds to them.
//
// The figures of every unit are gathered in ONE pass over the groups, keyed by
// the units' path ids (unitChainOf): those stay the same when the hierarchy is
// rebuilt around the same data (commune contours arriving), so nothing here has
// to be recomputed then.

import {
  AUDITION_THEMES,
  auditionCohort,
  isPlaceholderAuditionDate,
  themesApproximate,
  themesOf,
  type AuditionCohort,
  type AuditionTheme,
  type LocationGroup,
  type PublicTestimony,
} from "@ac/shared";
import { unitChainOf, type GeoUnit, type LevelKey } from "@/features/geo";

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

/** Opaque to callers: built once per data load by buildUnitStats. */
export interface UnitStatsIndex {
  readonly kind: "unit-stats";
}

/** One of the association's own auditions, with its (filtered) testimonies
 *  (keyed by its id). */
export interface OwnAudition {
  title: string;
  date: string | null;
  location: string;
  testimonies: PublicTestimony[];
}

const THEME_COUNT = AUDITION_THEMES.length;
const THEME_INDEX = new Map<AuditionTheme, number>(AUDITION_THEMES.map((t, i) => [t, i]));

/** An own audition, read once: what every unit it sits in adds up. */
interface AuditionFacts {
  canonical: string;
  /** Its date when real; null for a placeholder (or none). */
  realDate: string | null;
  cohort: AuditionCohort;
  testimonies: PublicTestimony[];
  themes: Int32Array;
  base: number;
  untagged: number;
  approx: number;
}

interface UnitStats {
  own: number;
  members: AuditionFacts[];
  lieux: Set<string>;
  communes: Set<string>;
  cohorts: { terrain: number; cahier2019: number; archive: number };
  themes: Int32Array;
  themeAuditions: Int32Array;
  themeBase: number;
  untagged: number;
  approx: number;
  /** Its real audition dates' span (the reliability's "2025-26"). */
  first: string | null;
  last: string | null;
  largest: AuditionFacts | null;
}

/** What a scope's analysis owes to its figures alone, kept per scope id. */
interface ScopeCore {
  themes: ScopeAnalysis["themes"];
  reliability: Reliability;
  reason: string | null;
  share: number;
}

interface IndexImpl extends UnitStatsIndex {
  units: Map<string, UnitStats>;
  cores: Map<string, ScopeCore>;
}

function emptyStats(): UnitStats {
  return {
    own: 0,
    members: [],
    lieux: new Set(),
    communes: new Set(),
    cohorts: { terrain: 0, cahier2019: 0, archive: 0 },
    themes: new Int32Array(THEME_COUNT),
    themeAuditions: new Int32Array(THEME_COUNT),
    themeBase: 0,
    untagged: 0,
    approx: 0,
    first: null,
    last: null,
    largest: null,
  };
}

function readAudition(a: OwnAudition, canonical: string): AuditionFacts {
  const themes = new Int32Array(THEME_COUNT);
  let base = 0;
  let untagged = 0;
  let approx = 0;
  for (const t of a.testimonies) {
    if (!t.topics?.length) untagged += 1;
    const list = themesOf(t.topics);
    if (!list.length) continue;
    base += 1;
    if (themesApproximate(t.topics)) approx += 1;
    for (const theme of list) themes[THEME_INDEX.get(theme)!] += 1;
  }
  return {
    canonical,
    realDate: isPlaceholderAuditionDate(a) ? null : a.date,
    cohort: auditionCohort(a),
    testimonies: a.testimonies,
    themes,
    base,
    untagged,
    approx,
  };
}

function addAudition(s: UnitStats, f: AuditionFacts, commune: string | null): void {
  const n = f.testimonies.length;
  s.own += n;
  s.members.push(f);
  s.lieux.add(f.canonical);
  if (commune) s.communes.add(commune);
  s.cohorts[f.cohort] += n;
  for (let i = 0; i < THEME_COUNT; i++) {
    s.themes[i] += f.themes[i];
    if (f.themes[i] > 0) s.themeAuditions[i] += 1;
  }
  s.themeBase += f.base;
  s.untagged += f.untagged;
  s.approx += f.approx;
  if (!s.largest || n > s.largest.testimonies.length) s.largest = f;
  const d = f.realDate;
  if (d) {
    if (!s.first || d < s.first) s.first = d;
    if (!s.last || d > s.last) s.last = d;
  }
}

// The commune of a chain: the entry whose own segment (after its parent's id)
// is a ville. Read from the parent's length, as a lieu's name may hold a "/".
function communeOf(chain: string[]): string | null {
  for (let i = 1; i < chain.length - 1; i++) {
    if (chain[i].startsWith("v:", chain[i - 1].length + 1)) return chain[i];
  }
  return null;
}

/**
 * Every unit's figures, in one pass. `ownAuditions` is the association's own
 * testimonies grouped by audition (as GeoNav holds them): an audition of a group
 * that is not in it is a Grand Débat report, left out. So is an own audition on
 * no unit (the archive, which has no lieu; a lieu not on the map yet).
 */
export function buildUnitStats(
  groups: LocationGroup[],
  ownAuditions: Map<string, OwnAudition>,
): UnitStatsIndex {
  const units = new Map<string, UnitStats>();
  const statsOf = (id: string) => {
    let s = units.get(id);
    if (!s) {
      s = emptyStats();
      units.set(id, s);
    }
    return s;
  };
  const placed = new Set<string>();
  for (const g of groups) {
    const chain = unitChainOf(g);
    if (!chain) continue;
    // Only a unit with an own audition in it gets figures (a Grand Débat group none).
    let at: UnitStats[] | undefined;
    let commune: string | null = null;
    for (const a of g.auditions) {
      const own = ownAuditions.get(a.id);
      if (!own) continue;
      // An audition is one lieu: counted once even if a snapshot lists it twice.
      if (placed.has(a.id)) continue;
      placed.add(a.id);
      if (!at) {
        at = chain.map(statsOf);
        commune = communeOf(chain);
      }
      const facts = readAudition(own, g.canonicalName);
      for (const s of at) addAudition(s, facts, commune);
    }
  }
  const index: IndexImpl = {
    kind: "unit-stats",
    units,
    cores: new Map(),
  };
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
function reliabilityOf(s: UnitStats | undefined): { level: Reliability; reason: string | null } {
  const n = s?.themeBase ?? 0;
  if (!s || n < 5) return { level: "trop-peu", reason: "moins de 5 témoignages analysés" };
  if (n < 10) return { level: "chips", reason: "moins de 10 témoignages analysés" };
  const count = s.members.length;
  const maxShare = s.own ? (s.largest?.testimonies.length ?? 0) / s.own : 0;
  const top = Math.max(s.cohorts.terrain, s.cohorts.cahier2019, s.cohorts.archive);
  const mono = top >= 0.9 * s.own;
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

function coreOf(index: IndexImpl, id: string, s: UnitStats): ScopeCore {
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
    share: s.own ? (s.largest?.testimonies.length ?? 0) / s.own : 0,
  };
  index.cores.set(id, core);
  return core;
}

// ---- One scope ---------------------------------------------------------------

/** The analysis of one unit, from the index built for the data on screen
 *  (`placeLabel`: a lieu's name, as the map shows it). */
export function analyseScope(
  unit: GeoUnit,
  index: UnitStatsIndex,
  opts: { placeLabel: (canonical: string) => string },
): ScopeAnalysis | null {
  if (unit.levelKey === "world") return null;
  const idx = index as IndexImpl;
  const s = idx.units.get(unit.id) ?? emptyStats();
  const core = coreOf(idx, unit.id, s);
  const largest = s.largest;
  return {
    scopeId: unit.id,
    label: unit.label,
    levelLabel: LEVEL_NAME[unit.levelKey],
    testimonies: s.own,
    auditions: s.members.length,
    lieux: s.lieux.size,
    communes: s.communes.size,
    // Among several auditions only: one alone holds everything by definition.
    concentration:
      largest && s.members.length > 1 && core.share > 0.25
        ? {
            lieu: opts.placeLabel(largest.canonical),
            count: largest.testimonies.length,
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
