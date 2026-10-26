// The read RPCs' answers, and how the web reads them (the server data source
// of map phase 1, PR J/K): the unit tree of a complete place_counts, a
// unit's analysis from its figures, the filter dialog's options, the admin
// list's passing test. The harness compares these with the frozen client
// pipeline (legacy/).

import { AUDITION_THEMES, type AuditionTheme, type LieuPlacement } from "@ac/shared";
import { fold } from "./legacy/filters";
import { placeLabel } from "./legacy/hierarchy";
import type { Bounds, LevelKey } from "./legacy/types";
import type { LocNode } from "./legacy/filters";
import type { Reliability, ScopeAnalysis } from "./legacy/scopeStats";

// ---- Answers -------------------------------------------------------------------

export interface Facts {
  testimonies: number;
  auditions: number;
  lieux: number;
  communes: number;
  cohorts: [number, number, number];
  themes: number[];
  themeAuditions: number[];
  themeBase: number;
  untagged: number;
  approx: number;
  first: string | null;
  last: string | null;
  /** [audition id, lieu id, lieu key, n, lieu city] */
  largest: [string, string, string, number, string | null] | null;
}

export type BBox = [number, number, number, number];

export interface UnitRow {
  id: string;
  parent: string | null;
  level: string;
  name: string;
  code: string | null;
  country: string;
  polygon: boolean;
  d: number;
  n: number;
  auditions: number;
  rank: string;
  /** The id of the newest audition of its first lieu (today's order, design A18). */
  tie: string;
  bbox: BBox;
  wrap: boolean;
  facts?: Facts;
}

export interface LieuRow {
  id: string;
  unit: string;
  key: string;
  city: string | null;
  lat: number;
  lng: number;
  precision: LieuPlacement | string;
  n: number;
  auditions: number;
  rank: string;
  /** The id of its newest audition. */
  tie: string;
  /** [id, title, date, n], newest first (complete answers). */
  list?: [string, string, string, number][];
}

export interface PlaceCounts {
  unit: string;
  complete: boolean;
  self: { n: number; auditions: number; rank: string | null; bbox: BBox | null; facts?: Facts };
  unplaced?: { n: number; auditions: number };
  units: UnitRow[];
  lieux: LieuRow[];
}

export interface ResultLieu {
  id: string;
  key: string;
  unit: string;
  path: string[];
  lat: number;
  lng: number;
  city: string | null;
}

export interface ResultRow {
  id: string;
  title: string;
  date: string;
  n: number;
  lieu: ResultLieu;
}

export interface ResultsPage {
  auditions: ResultRow[];
  next: [string, string, string, string] | null;
  total?: { auditions: number; lieux: number; n: number };
  frame?: BBox | null;
  throughFound?: boolean;
}

export interface LieuAuditions {
  lieu: (ResultLieu & { path: string[] }) | null;
  auditions: { id: string; title: string; date: string; n: number }[];
}

export interface TestimonyRow {
  id: string;
  audition_id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
  verification_status: string | null;
  created_at: string | null;
}

export interface TestimonyPage {
  testimonies: TestimonyRow[];
  next: [string | null, string] | null;
}

export interface Facets {
  themes: { i: number; n: number }[];
  dates: [string, string] | null;
}

export interface AdminFilter {
  matches: Record<string, [number, number]>;
  themes: number[];
}

// ---- The unit tree -------------------------------------------------------------

/** A server row's level as the site names it (design E2 step 3). */
export function siteLevel(row: Pick<UnitRow, "level" | "parent">, parentLevel?: string): LevelKey {
  if (row.level === "country" || row.level === "dependency") return "country";
  if (row.level === "region") return "region";
  if (row.level === "county") return "dep";
  return row.level === "locality" && parentLevel === "locality" ? "arr" : "city";
}

const POINT_PAD = 0.012;

/** A point box as the client pads it (bounds.ts pointBounds/unionBounds). */
export function padded(b: BBox): Bounds {
  return {
    minLat: b[0] - POINT_PAD,
    minLng: b[1] - POINT_PAD,
    maxLat: b[2] + POINT_PAD,
    maxLng: b[3] + POINT_PAD,
  };
}

export interface TreeNode {
  id: string;
  kind: "world" | "unit" | "lieu";
  parent: string | null;
  levelKey: LevelKey;
  label: string;
  n: number;
  auditions: number;
  rank: string | null;
  tie: string | null;
  bounds: Bounds | null;
  code: string | null;
  facts?: Facts;
  unit?: UnitRow;
  lieu?: LieuRow;
  children: string[];
}

const byte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Today's order of siblings: testimonies desc, the newest first, then the first lieu's newest audition by id. */
export function childOrder(
  a: { id: string; n: number; rank: string | null; tie: string | null },
  b: { id: string; n: number; rank: string | null; tie: string | null },
): number {
  return (
    b.n - a.n ||
    (b.rank ?? "").localeCompare(a.rank ?? "") ||
    byte(a.tie ?? "", b.tie ?? "") ||
    byte(a.id, b.id)
  );
}

/** The whole tree of a complete answer for 'world', as the web builds it. */
export function treeOf(answer: PlaceCounts): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>();
  nodes.set("world", {
    id: "world",
    kind: "world",
    parent: null,
    levelKey: "world",
    label: "Monde",
    n: answer.self.n,
    auditions: answer.self.auditions,
    rank: answer.self.rank,
    tie: null,
    bounds: answer.self.bbox ? padded(answer.self.bbox) : null,
    code: null,
    children: [],
  });
  const levelOf = new Map(answer.units.map((u) => [u.id, u.level]));
  for (const u of answer.units) {
    nodes.set(u.id, {
      id: u.id,
      kind: "unit",
      parent: u.parent ?? "world",
      levelKey: siteLevel(u, u.parent ? levelOf.get(u.parent) : undefined),
      label: u.name,
      n: u.n,
      auditions: u.auditions,
      rank: u.rank,
      tie: u.tie,
      bounds: padded(u.bbox),
      code: u.code,
      facts: u.facts,
      unit: u,
      children: [],
    });
  }
  for (const l of answer.lieux) {
    nodes.set(l.id, {
      id: l.id,
      kind: "lieu",
      parent: l.unit,
      levelKey: "place",
      label: placeLabel({ canonicalName: l.key, city: l.city }),
      n: l.n,
      auditions: l.auditions,
      rank: l.rank,
      tie: l.tie,
      bounds: padded([l.lat, l.lng, l.lat, l.lng]),
      code: null,
      lieu: l,
      children: [],
    });
  }
  for (const node of nodes.values()) {
    if (node.parent) nodes.get(node.parent)?.children.push(node.id);
  }
  for (const node of nodes.values()) {
    node.children.sort((a, b) => childOrder(nodes.get(a)!, nodes.get(b)!));
  }
  return nodes;
}

// ---- Analyses from the figures (what analyses/stats/factsStats.ts will do) ----------

const LEVEL_NAME: Record<LevelKey, string> = {
  world: "Monde",
  country: "Pays",
  region: "Région",
  dep: "Département",
  city: "Ville",
  arr: "Arrondissement",
  place: "Lieu",
};

function yearsOf(first: string | null, last: string | null): string {
  if (!first || !last) return "récents";
  const a = first.slice(0, 4);
  const b = last.slice(0, 4);
  return a === b ? a : `${a}-${b.slice(2)}`;
}

/** analyseScope (scopeStats.ts) reading a unit's figures instead of its rows. */
export function analyseFacts(
  unit: { id: string; label: string; levelKey: LevelKey },
  facts: Facts | undefined,
): ScopeAnalysis | null {
  if (unit.levelKey === "world") return null;
  const f: Facts = facts ?? {
    testimonies: 0,
    auditions: 0,
    lieux: 0,
    communes: 0,
    cohorts: [0, 0, 0],
    themes: AUDITION_THEMES.map(() => 0),
    themeAuditions: AUDITION_THEMES.map(() => 0),
    themeBase: 0,
    untagged: 0,
    approx: 0,
    first: null,
    last: null,
    largest: null,
  };
  const own = f.testimonies;
  const largestN = f.largest?.[3] ?? 0;
  const share = own ? largestN / own : 0;
  const themes = (AUDITION_THEMES as readonly AuditionTheme[])
    .map((theme, i) => ({ theme, count: f.themes[i], auditions: f.themeAuditions[i] }))
    .sort((a, b) => b.count - a.count || b.auditions - a.auditions);
  const n = f.themeBase;
  let reliability: Reliability;
  let reason: string | null;
  if (n < 5) {
    reliability = "trop-peu";
    reason = "moins de 5 témoignages analysés";
  } else if (n < 10) {
    reliability = "chips";
    reason = "moins de 10 témoignages analysés";
  } else {
    const count = f.auditions;
    const [terrain, cahier2019, archive] = f.cohorts;
    const top = Math.max(terrain, cahier2019, archive);
    const mono = top >= 0.9 * own;
    if (n >= 30 && count >= 3 && share <= 0.5 && mono) {
      reliability = "solide";
      reason = null;
    } else {
      reliability = "indicatif";
      if (n < 30) reason = "moins de 30 témoignages analysés";
      else if (count < 3) reason = count === 1 ? "une seule audition" : "deux auditions seulement";
      else if (share > 0.5) reason = "plus de la moitié vient d'une seule audition";
      else if (terrain && cahier2019 && !archive) {
        reason = `témoignages 2019 et ${yearsOf(f.first, f.last)} mêlés`;
      } else reason = "témoignages d'époques différentes mêlés";
    }
  }
  return {
    scopeId: unit.id,
    label: unit.label,
    levelLabel: LEVEL_NAME[unit.levelKey],
    testimonies: own,
    auditions: f.auditions,
    lieux: f.lieux,
    communes: f.communes,
    concentration:
      f.largest && f.auditions > 1 && share > 0.25
        ? {
            lieu: placeLabel({ canonicalName: f.largest[2], city: f.largest[4] }),
            count: largestN,
            share,
          }
        : null,
    themes,
    themeBase: f.themeBase,
    untagged: f.untagged,
    approx: f.approx,
    reliability,
    reliabilityReason: reason,
  };
}

// ---- The filter dialog's options ---------------------------------------------------

/** buildTopicOptions' list from the facet counts. */
export function topicOptionsOf(counts: { i: number; n: number }[]) {
  return counts
    .filter((c) => c.n > 0)
    .map((c) => ({ value: AUDITION_THEMES[c.i] as string, n: c.n }))
    .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
    .map(({ value, n }) => ({ value, label: value, hint: String(n) }));
}

/**
 * The place picker's tree from an empty=1 answer: région > département >
 * ville > lieu, arrondissements folded into their commune, weighted by
 * testimonies; children in today's order (childOrder).
 */
export function locationTreeOf(answer: PlaceCounts): LocNode[] {
  const nodes = treeOf(answer);
  const build = (id: string): LocNode[] => {
    const out: { node: LocNode; n: number; rank: string | null; tie: string | null; id: string }[] =
      [];
    for (const childId of nodes.get(id)?.children ?? []) {
      const c = nodes.get(childId)!;
      if (c.levelKey === "arr") {
        // Its lieux under the commune, each with its own rank and tie.
        for (const sub of build(childId)) {
          const l = nodes.get(sub.token)!;
          out.push({ node: sub, n: sub.count ?? 0, rank: l.rank, tie: l.tie, id: sub.token });
        }
        continue;
      }
      const children = c.kind === "lieu" ? [] : build(childId);
      out.push({
        node: {
          token: c.id,
          label: c.levelKey === "place" ? c.lieu!.key : c.label,
          hint: c.levelKey === "dep" ? (c.code ?? undefined) : undefined,
          count: c.n,
          children: children.length ? children : undefined,
        },
        n: c.n,
        rank: c.rank,
        tie: c.tie,
        id: c.id,
      });
    }
    // Folded lieux come back sorted with the rest.
    return out.sort(childOrder).map((x) => x.node);
  };
  // The country level is left out while there is one country (design E2 step 8).
  const countries = nodes.get("world")!.children;
  return countries.length === 1 ? build(countries[0]) : build("world");
}

// ---- The admin list ---------------------------------------------------------------

/** useAuditionFilters' passes (content filters), from admin_audition_filter. */
export function adminPasses(
  a: { id: string; title: string; location: string; content: string },
  f: { verified: boolean; topics: string[]; needle: string },
  answer: AdminFilter | null,
): boolean {
  const onTestimonies = f.verified || f.topics.length > 0;
  if (!onTestimonies && !f.needle) return true;
  const textInAudition =
    Boolean(f.needle) && fold(`${a.title} ${a.location} ${a.content}`).includes(f.needle);
  const [nAll, nNoText] = answer?.matches[a.id] ?? [0, 0];
  if (!onTestimonies) return textInAudition || nAll > 0;
  return textInAudition ? nNoText > 0 : nAll > 0;
}

/** The admin theme options from the per-theme counts. */
export function adminTopicOptions(themes: number[]) {
  return topicOptionsOf(themes.map((n, i) => ({ i, n })));
}

/** The like pattern of a folded needle: found anywhere, its % _ and \ taken literally. */
export function likeOf(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
