// npm run db:parity — the read RPCs of map phase 1 (place_counts and its
// batched form, lieu_auditions, audition_results, testimony_page,
// place_facets, admin_audition_filter) against the frozen client pipeline
// they replace (scripts/parity/legacy), over the database's rows:
//
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run db:parity
//   PSQL="docker exec -i supabase_db_<project_id> psql -U postgres -d postgres" npm run db:parity
//   … -- --json <file>   the report as JSON too
//
// The old side is what the old endpoints served, read as they read them:
// /api/testimonies as anon, /api/map's groups from the stored places
// (groupsFromRows), the admin list's testimonies as an admin; then the
// frozen hierarchy, analyses, lists, frames and filters over them. The new
// side is the RPCs' answers, read as the web will read them (server.ts).
// Both run over every filter of a matrix (none, verified, each theme,
// needles of 1, 2 and 3+ characters, accents, % and _, dates, places,
// combinations), every unit (whole tree and the lazy path), every lieu, and
// every result and testimony page (7 a page).
//
// Only the design's D1 and D3 may differ (report.ts): each is listed; any
// other difference fails. Drafts are dropped from the old corpus before the
// comparison (D1), and the count it changes is listed. Local databases only;
// every session is rolled back (db.ts).

import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AUDITION_THEMES, fold, type LocationGroup, type PublicTestimony } from "@ac/shared";
import {
  exportLegacy,
  jsonb,
  PLAIN_ADMIN,
  rpcsInstalled,
  runCalls,
  setup,
  type AuditionRow,
  type Call,
  type Exported,
} from "./db";
import { Report } from "./report";
import { lit } from "../db-checks/psql";
import * as S from "./server";
import { applyBoundaries } from "./legacy/boundaries";
import { buildGeoHierarchy, placeLabel, unitChainOf } from "./legacy/hierarchy";
import {
  dateBounds,
  filteredOwnGroups,
  filteredTestimonies,
  locationTree,
  topicOptions,
  type LegacyFilters,
} from "./legacy/testimonyFiltering";
import {
  bySort,
  groupOwnAuditions,
  resultBounds,
  type AuditionGroup,
  type AuditionSort,
} from "./legacy/auditions";
import { analyseScope, buildUnitStats, type UnitStatsIndex } from "./legacy/scopeStats";
import {
  allPlaceUnits,
  placeAuditions,
  placeByCanonical,
  resultAuditions,
  resultLieuLabel,
} from "./legacy/panelAuditions";
import {
  passesContentFilters,
  testimoniesByAudition,
  topicOptions as adminTopicOptions,
} from "./legacy/adminFilters";
import type { LocNode } from "./legacy/filters";
import type { GeoUnit } from "./legacy/types";

const PAGE = 7;
const SORTS: AuditionSort[] = ["recent", "ancien"];
const r = new Report();

// ---- The two id spaces ---------------------------------------------------------

/** Legacy hierarchy ids (name paths) ↔ unit and lieu ids, from the groups' stored paths. */
interface IdMap {
  toServer: Map<string, string>;
  toLegacy: Map<string, string>;
  /** The place picker's tokens (r:, d:, v:, p:) → unit and lieu ids. */
  token: Map<string, Set<string>>;
}

function idMapOf(groups: LocationGroup[]): IdMap {
  r.current = "ids";
  const toServer = new Map<string, string>([["world", "world"]]);
  const toLegacy = new Map<string, string>([["world", "world"]]);
  const token = new Map<string, Set<string>>();
  const link = (legacy: string, server: string) => {
    const had = toServer.get(legacy);
    if (had && had !== server) r.fail(`legacy unit ${legacy} is both ${had} and ${server}`);
    const back = toLegacy.get(server);
    if (back && back !== legacy) r.fail(`unit ${server} is both legacy ${back} and ${legacy}`);
    toServer.set(legacy, server);
    toLegacy.set(server, legacy);
  };
  for (const g of groups) {
    const chain = unitChainOf(g);
    if (!chain || !g.unitPath || !g.lieuId) {
      r.fail(
        `lieu "${g.canonicalName}": legacy chain ${chain?.join(" > ") ?? "none"}, stored ${g.unitPath?.join(" > ") ?? "none"}`,
      );
      continue;
    }
    const server = [...g.unitPath, g.lieuId];
    r.checks++;
    if (chain.length !== server.length) {
      r.fail(
        `lieu "${g.canonicalName}": legacy ${chain.join(" > ")} ≠ stored ${server.join(" > ")}`,
      );
      continue;
    }
    chain.forEach((id, i) => {
      link(id, server[i]);
      if (i === 0) return;
      const seg = id.slice(chain[i - 1].length + 1);
      if (/^[rdvp]:/.test(seg)) {
        const set = token.get(seg) ?? new Set<string>();
        set.add(server[i]);
        token.set(seg, set);
      }
    });
  }
  for (const [t, ids] of token) {
    if (ids.size > 1) r.fail(`the place token ${t} names ${[...ids].join(" and ")} (D2 territory)`);
  }
  return { toServer, toLegacy, token };
}

const sid = (ids: IdMap, legacy: string) => ids.toServer.get(legacy) ?? `?${legacy}`;

// ---- The filter matrix -----------------------------------------------------------

interface Case {
  name: string;
  legacy: LegacyFilters;
  server: Record<string, unknown>;
}

const NONE: LegacyFilters = {
  topics: [],
  locations: [],
  dateFrom: null,
  dateTo: null,
  verified: false,
  needle: "",
};

function serverFilters(f: LegacyFilters, place: { units?: string[]; lieux?: string[] }) {
  const out: Record<string, unknown> = {};
  if (f.verified) out.verified = true;
  const mask = f.topics.reduce(
    (m, t) => m | (1 << (AUDITION_THEMES as readonly string[]).indexOf(t)),
    0,
  );
  if (mask) out.mask = mask;
  if (f.needle) out.like = S.likeOf(f.needle);
  if (f.dateFrom) out.from = f.dateFrom;
  if (f.dateTo) out.to = f.dateTo;
  if (place.units?.length) out.units = place.units;
  if (place.lieux?.length) out.lieux = place.lieux;
  return out;
}

/** The needles: the free text as typed (useFilters folds and trims it). */
function needles(corpus: PublicTestimony[]): string[] {
  const fixed = [
    "a",
    "É",
    "œ",
    "qu",
    "ée",
    "loyer",
    "  Santé ",
    "d'achat",
    "%",
    "_",
    "50 %",
    "a_b",
    "🙏",
    "الأسعار",
    "<script>",
    "yasmine  merci",
  ];
  // A word only one testimony holds.
  const seen = new Map<string, number>();
  for (const t of corpus) {
    const words = new Set(fold(t.content).match(/[a-z]{7,}/g) ?? []);
    for (const w of words) seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  const rare = [...seen]
    .filter(([, n]) => n === 1)
    .map(([w]) => w)
    .sort()[0];
  return rare ? [...fixed, rare] : fixed;
}

function matrix(ex: Exported, corpus: PublicTestimony[], ids: IdMap, all: GeoUnit[]): Case[] {
  const cases: Case[] = [{ name: "none", legacy: NONE, server: {} }];
  const add = (
    name: string,
    f: Partial<LegacyFilters>,
    place: { units?: string[]; lieux?: string[] } = {},
  ) => {
    const legacy = { ...NONE, ...f };
    cases.push({ name, legacy, server: serverFilters(legacy, place) });
  };
  add("verified", { verified: true });
  for (const t of AUDITION_THEMES) add(`theme ${t}`, { topics: [t] });
  add("themes 0+11", { topics: [AUDITION_THEMES[0], AUDITION_THEMES[11]] });
  for (const raw of needles(corpus)) add(`text «${raw}»`, { needle: fold(raw.trim()) });

  const dates = [...new Set(ex.groups.flatMap((g) => g.auditions.map((a) => a.date)))].sort();
  const from = dates[Math.floor(dates.length * 0.3)];
  const to = dates[Math.floor(dates.length * 0.7)];
  add(`dates ${from}..${to}`, { dateFrom: from, dateTo: to });
  add(`from ${to}`, { dateFrom: to });
  add(`to ${from}`, { dateTo: from });

  // Places: the most heard of each level, the split city, an overseas one.
  const tokenOf = (u: GeoUnit) => u.id.slice((u.parentId?.length ?? -1) + 1);
  const place = (u: GeoUnit) => {
    const id = sid(ids, u.id);
    return id.startsWith("l:") ? { lieux: [id] } : { units: [id] };
  };
  const top = (level: GeoUnit["levelKey"], skip = 0) =>
    all.filter((u) => u.levelKey === level).sort((a, b) => b.count - a.count)[skip];
  const picks = [
    top("region"),
    top("region", 1),
    top("dep"),
    all.find((u) => tokenOf(u) === "d:972"),
    all.find((u) => tokenOf(u) === "v:Lyon"),
    top("city"),
    top("place"),
  ].filter((u): u is GeoUnit => Boolean(u));
  for (const u of picks) add(`place ${tokenOf(u)}`, { locations: [tokenOf(u)] }, place(u));
  const dep = top("dep", 1);
  const lieu = top("place", 1);
  if (dep && lieu) {
    add(
      `places ${tokenOf(dep)} + ${tokenOf(lieu)}`,
      { locations: [tokenOf(dep), tokenOf(lieu)] },
      { units: [sid(ids, dep.id)], lieux: [sid(ids, lieu.id)] },
    );
  }

  // Combinations.
  add("verified + «loyer»", { verified: true, needle: "loyer" });
  add(`theme 7 + dates`, { topics: [AUDITION_THEMES[7]], dateFrom: from, dateTo: to });
  const d = top("dep");
  if (d)
    add(
      `verified + «a» + ${tokenOf(d)}`,
      { verified: true, needle: "a", locations: [tokenOf(d)] },
      place(d),
    );
  const reg = top("region");
  if (reg && lieu) {
    add(
      `themes 2+6 + ${tokenOf(reg)} + ${tokenOf(lieu)} + from`,
      {
        topics: [AUDITION_THEMES[2], AUDITION_THEMES[6]],
        locations: [tokenOf(reg), tokenOf(lieu)],
        dateFrom: from,
      },
      { units: [sid(ids, reg.id)], lieux: [sid(ids, lieu.id)] },
    );
  }
  return cases;
}

// ---- The old pipeline, per filter case ---------------------------------------------

interface View {
  filtered: PublicTestimony[];
  groups: LocationGroup[];
  index: Map<string, GeoUnit>;
  own: Map<string, AuditionGroup>;
  stats: UnitStatsIndex;
  places: GeoUnit[];
  byCanonical: Map<string, GeoUnit>;
}

function legacyView(corpus: PublicTestimony[], groups: LocationGroup[], f: LegacyFilters): View {
  const filtered = filteredTestimonies(corpus, groups, f);
  const fgroups = filteredOwnGroups(groups, filtered);
  const { index } = buildGeoHierarchy(fgroups);
  applyBoundaries(index, {});
  const own = groupOwnAuditions(filtered);
  const places = allPlaceUnits(index);
  return {
    filtered,
    groups: fgroups,
    index,
    own,
    stats: buildUnitStats(fgroups, own),
    places,
    byCanonical: placeByCanonical(places),
  };
}

/** What buildUnitStats keeps per unit (scopeStats.ts UnitStats). */
interface LegacyStats {
  own: number;
  members: { canonical: string; testimonies: PublicTestimony[] }[];
  lieux: Set<string>;
  communes: Set<string>;
  cohorts: { terrain: number; cahier2019: number; archive: number };
  themes: Int32Array;
  themeAuditions: Int32Array;
  themeBase: number;
  untagged: number;
  approx: number;
  first: string | null;
  last: string | null;
  largest: { canonical: string; testimonies: PublicTestimony[] } | null;
}

const statsOf = (stats: UnitStatsIndex, id: string) =>
  (stats as unknown as { units: Map<string, LegacyStats> }).units.get(id);

// ---- Comparisons ----------------------------------------------------------------

interface Ctx {
  ex: Exported;
  ids: IdMap;
  /** Per lieu id, the date of its newest audition on the map (its rank). */
  lieuRank: Map<string, string>;
  /** Per audition id, its lieu id. */
  lieuOf: Map<string, string>;
  dateOf: Map<string, string>;
}

/** A legacy unit's rank: its newest lieu among those still matching. */
function ranksOf(view: View, ctx: Ctx): Map<string, string> {
  const rank = new Map<string, string>();
  for (const g of view.groups) {
    const lr = ctx.lieuRank.get(g.lieuId!) ?? "";
    for (const id of ["world", ...(unitChainOf(g) ?? [])]) {
      if ((rank.get(id) ?? "") < lr) rank.set(id, lr);
    }
  }
  return rank;
}

function compareTree(view: View, answer: S.PlaceCounts, ctx: Ctx): Map<string, S.TreeNode> {
  const { ids } = ctx;
  r.eq("whole tree within budget (complete)", true, answer.complete);
  sortedAsTheWebReads(answer);
  const tree = S.treeOf(answer);
  const ranks = ranksOf(view, ctx);
  const key = (id: string) => `${tree.get(id)?.n}|${tree.get(id)?.rank}`;
  const seen = new Set<string>();
  for (const u of view.index.values()) {
    const id = sid(ids, u.id);
    seen.add(id);
    const node = tree.get(id);
    const w = `unit ${id}`;
    if (!node) {
      r.fail(`${w} (${u.id}) missing from place_counts`);
      continue;
    }
    r.eq(`${w} count`, u.count, node.n);
    r.eq(`${w} rank`, ranks.get(u.id) ?? null, node.rank);
    r.eq(`${w} label`, u.label, node.label);
    r.eq(`${w} level`, u.levelKey, node.levelKey);
    r.eq(`${w} parent`, u.parentId ? sid(ids, u.parentId) : null, node.parent);
    if ((u.levelKey === "city" || u.levelKey === "arr") && u.insee !== undefined) {
      r.eq(`${w} INSEE`, u.insee, node.code);
    }
    if (u.levelKey === "place") {
      r.eq(`${w} point`, u.center, [node.lieu!.lat, node.lieu!.lng]);
      r.eq(`${w} key`, u.canonical, node.lieu!.key);
    }
    // FR keeps METRO_FRANCE on the web (design A12); the world box is never drawn.
    if (u.levelKey !== "country" && u.levelKey !== "world")
      r.eq(`${w} bounds`, u.bounds, node.bounds);
    if (node.unit) r.eq(`${w} wrap`, node.unit.bbox[3] - node.unit.bbox[1] > 180, node.unit.wrap);
    r.order(
      `${w} children`,
      u.children.map((c) => sid(ids, c.id)),
      node.children,
      key,
    );
    if (u.levelKey !== "world" && u.levelKey !== "place") compareFacts(view, u, node, ctx);
  }
  for (const id of tree.keys()) {
    if (!seen.has(id)) r.fail(`place_counts has ${id}, the legacy tree does not`);
  }
  return tree;
}

function compareFacts(view: View, u: GeoUnit, node: S.TreeNode, ctx: Ctx): void {
  const w = `facts of ${node.id}`;
  const f = node.facts;
  if (!f) {
    r.fail(`${w}: none in a complete answer`);
    return;
  }
  const st = statsOf(view.stats, u.id);
  r.eq(`${w} testimonies`, st?.own ?? 0, f.testimonies);
  r.eq(`${w} auditions`, st?.members.length ?? 0, f.auditions);
  r.eq(`${w} lieux`, st?.lieux.size ?? 0, f.lieux);
  r.eq(`${w} communes`, st?.communes.size ?? 0, f.communes);
  r.eq(
    `${w} cohorts`,
    st ? [st.cohorts.terrain, st.cohorts.cahier2019, st.cohorts.archive] : [0, 0, 0],
    f.cohorts,
  );
  r.eq(`${w} themes`, st ? [...st.themes] : AUDITION_THEMES.map(() => 0), f.themes);
  r.eq(
    `${w} themeAuditions`,
    st ? [...st.themeAuditions] : AUDITION_THEMES.map(() => 0),
    f.themeAuditions,
  );
  r.eq(
    `${w} themeBase/untagged/approx`,
    [st?.themeBase ?? 0, st?.untagged ?? 0, st?.approx ?? 0],
    [f.themeBase, f.untagged, f.approx],
  );
  r.eq(`${w} first/last`, [st?.first ?? null, st?.last ?? null], [f.first, f.last]);

  // The largest audition: the same, or a tie of count and rank between two lieux (D3).
  const legacyLargest = st?.largest
    ? { id: st.largest.testimonies[0].audition!.id, n: st.largest.testimonies.length }
    : null;
  let tie = false;
  r.checks++;
  if (legacyLargest?.id !== f.largest?.[0]) {
    const lr = legacyLargest && ctx.lieuRank.get(ctx.lieuOf.get(legacyLargest.id) ?? "");
    const sr = f.largest && ctx.lieuRank.get(f.largest[1]);
    tie =
      Boolean(legacyLargest && f.largest) &&
      legacyLargest!.n === f.largest![3] &&
      lr === sr &&
      ctx.lieuOf.get(legacyLargest!.id) !== f.largest![1];
    if (tie)
      r.add(
        "D3",
        `${w} largest audition: ${legacyLargest!.id} → ${f.largest![0]} (same count, same rank)`,
      );
    else
      r.fail(
        `${w} largest: legacy ${JSON.stringify(legacyLargest)} ≠ server ${JSON.stringify(f.largest)}`,
      );
  } else if (f.largest) {
    r.eq(`${w} largest`, [legacyLargest!.n, st!.largest!.canonical], [f.largest[3], f.largest[2]]);
  }

  const labels = (c: string) => view.byCanonical.get(c)?.label ?? c;
  const legacy = analyseScope(u, view.stats, { placeLabel: labels });
  const server = S.analyseFacts({ id: u.id, label: node.label, levelKey: node.levelKey }, f);
  if (!legacy || !server) {
    r.eq(`${w} analysis`, legacy, server);
    return;
  }
  const { concentration: lc, ...lrest } = legacy;
  const { concentration: sc, ...srest } = server;
  r.eq(`${w} analysis`, lrest, srest);
  if (tie && lc && sc) r.eq(`${w} concentration (tie)`, [lc.count, lc.share], [sc.count, sc.share]);
  else r.eq(`${w} concentration`, lc, sc);
}

/** The answer's units, and its lieux, come by testimonies, then the newest, then id. */
function sortedAsTheWebReads(answer: S.PlaceCounts): void {
  const order = (list: { id: string; n: number; rank: string }[]) =>
    [...list].sort(
      (a, b) =>
        b.n - a.n || b.rank.localeCompare(a.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  r.eq(
    `${answer.unit} units in order`,
    order(answer.units).map((u) => u.id),
    answer.units.map((u) => u.id),
  );
  r.eq(
    `${answer.unit} lieux in order`,
    order(answer.lieux).map((l) => l.id),
    answer.lieux.map((l) => l.id),
  );
}

/** A lazy answer for a unit, against the complete tree (already compared with the legacy one). */
function compareLazy(
  lazy: S.PlaceCounts,
  complete: S.PlaceCounts,
  tree: Map<string, S.TreeNode>,
): void {
  const u = lazy.unit;
  const w = `lazy ${u}`;
  sortedAsTheWebReads(lazy);
  const node = tree.get(u);
  r.eq(
    `${w} self`,
    [node?.n ?? 0, node?.auditions ?? 0, node?.rank ?? null],
    [lazy.self.n, lazy.self.auditions, lazy.self.rank],
  );
  if (u !== "world") r.eq(`${w} self facts`, node?.facts ?? ZERO_FACTS, lazy.self.facts);
  else r.eq(`${w} unplaced`, complete.unplaced, lazy.unplaced);
  r.eq(`${w} complete`, !node || node.n === 0, lazy.complete);
  // Units two levels down, lieux of the unit and of its children.
  const below = new Map<string, number>();
  const walk = (id: string, d: number) => {
    for (const c of tree.get(id)?.children ?? []) {
      if (tree.get(c)!.kind !== "unit" || d > 2) continue;
      below.set(c, d);
      walk(c, d + 1);
    }
  };
  if (node) walk(u, 1);
  const units = complete.units.filter((x) => below.has(x.id));
  r.eq(
    `${w} units`,
    units.map((x) => ({
      ...x,
      d: below.get(x.id),
      facts: below.get(x.id) === 1 ? x.facts : undefined,
    })),
    lazy.units.map((x) => ({ ...x, facts: x.facts })),
  );
  const holders = new Set([u, ...[...below].filter(([, d]) => d === 1).map(([id]) => id)]);
  r.eq(
    `${w} lieux`,
    complete.lieux.filter((l) => holders.has(l.unit)).map((l) => ({ ...l, list: undefined })),
    lazy.lieux.map((l) => ({ ...l, list: undefined })),
  );
}

/** A unit's figures when nothing in it matches. */
const ZERO_FACTS: S.Facts = {
  last: null,
  first: null,
  lieux: 0,
  approx: 0,
  themes: AUDITION_THEMES.map(() => 0),
  cohorts: [0, 0, 0],
  largest: null,
  communes: 0,
  untagged: 0,
  auditions: 0,
  themeBase: 0,
  testimonies: 0,
  themeAuditions: AUDITION_THEMES.map(() => 0),
};

interface CaseAnswers {
  complete?: S.PlaceCounts;
  lazy: S.PlaceCounts[];
  lieu: Map<string, S.LieuAuditions>;
  results: Map<AuditionSort, S.ResultsPage[]>;
  through: Map<string, S.ResultsPage[]>;
  pages: Map<string, S.TestimonyPage[]>;
}

function compareLists(view: View, tree: Map<string, S.TreeNode>, a: CaseAnswers, ctx: Ctx): void {
  const { ids } = ctx;
  const legacyLieux = new Set<string>();
  for (const p of view.places) {
    const id = sid(ids, p.id);
    legacyLieux.add(id);
    const node = tree.get(id);
    for (const sort of SORTS) {
      const legacy = placeAuditions(view.groups, p.canonical, sort, view.own).map((x) => [
        x.id,
        x.title,
        x.date,
        x.count,
      ]);
      const embedded = (node?.lieu?.list ?? [])
        .map(([id, title, date, n]) => ({ id, title, date, n }))
        .sort((x, y) => bySort(x, y, sort))
        .map((x) => [x.id, x.title, x.date, x.n]);
      r.eq(`lieu ${id} embedded list (${sort})`, legacy, embedded);
      const answer = a.lieu.get(`${id}|${sort}`);
      r.eq(
        `lieu_auditions ${id} (${sort})`,
        legacy,
        answer?.auditions.map((x) => [x.id, x.title, x.date, x.n]),
      );
      if (sort === "recent" && answer?.lieu) {
        const g = view.groups.find((x) => x.lieuId === id);
        r.eq(
          `lieu_auditions ${id} lieu`,
          {
            key: p.canonical,
            unit: sid(ids, p.parentId!),
            path: g?.unitPath,
            lat: p.center[0],
            lng: p.center[1],
            label: p.label,
          },
          {
            key: answer.lieu.key,
            unit: answer.lieu.unit,
            path: answer.lieu.path,
            lat: answer.lieu.lat,
            lng: answer.lieu.lng,
            label: placeLabel({ canonicalName: answer.lieu.key, city: answer.lieu.city }),
          },
        );
      }
    }
  }
  // Lieux with nothing matching: an empty list.
  for (const [key, answer] of a.lieu) {
    const id = key.split("|")[0];
    if (!legacyLieux.has(id)) r.eq(`lieu_auditions ${key} (nothing matches)`, [], answer.auditions);
  }
}

function compareResults(view: View, a: CaseAnswers, ctx: Ctx): void {
  const { ids } = ctx;
  for (const sort of SORTS) {
    const legacy = resultAuditions(view.groups, sort, view.own);
    const pages = a.results.get(sort) ?? [];
    const rows = pages.flatMap((p) => p.auditions);
    const w = `results (${sort})`;
    r.eq(
      `${w} pages of ${PAGE}`,
      pages.slice(0, -1).every((p) => p.auditions.length === PAGE),
      true,
    );
    r.eq(`${w} no duplicates`, new Set(rows.map((x) => x.id)).size, rows.length);
    const key = (id: string) =>
      `${ctx.dateOf.get(id)}|${ctx.lieuRank.get(ctx.lieuOf.get(id) ?? "")}`;
    r.order(
      w,
      legacy.map((x) => x.id),
      rows.map((x) => x.id),
      key,
    );
    const byId = new Map(rows.map((x) => [x.id, x]));
    for (const x of legacy) {
      const s = byId.get(x.id);
      if (!s) continue;
      const place = view.byCanonical.get(x.canonical);
      const chain = place
        ? (unitChainOf(view.groups.find((g) => g.canonicalName === x.canonical)!) ?? [])
        : [];
      r.eq(
        `${w} row ${x.id}`,
        {
          title: x.title,
          date: x.date,
          n: x.count,
          key: x.canonical,
          lieu: place ? sid(ids, place.id) : null,
          unit: place?.parentId ? sid(ids, place.parentId) : null,
          path: chain.slice(0, -1).map((c) => sid(ids, c)),
          point: place?.center,
          label: resultLieuLabel(x, view.byCanonical),
        },
        {
          title: s.title,
          date: s.date,
          n: s.n,
          key: s.lieu.key,
          lieu: s.lieu.id,
          unit: s.lieu.unit,
          path: s.lieu.path,
          point: [s.lieu.lat, s.lieu.lng],
          label: placeLabel({ canonicalName: s.lieu.key, city: s.lieu.city }),
        },
      );
    }
    const first = pages[0];
    r.eq(
      `${w} total`,
      {
        auditions: legacy.length,
        lieux: view.places.length,
        n: legacy.reduce((s, x) => s + x.count, 0),
      },
      first?.total,
    );
    const b = resultBounds(view.places);
    r.eq(`${w} frame`, b ? [b.minLat, b.minLng, b.maxLat, b.maxLng] : null, first?.frame ?? null);
  }
  // through=: the rows up to the audition being read, then on from there.
  const legacy = resultAuditions(view.groups, "recent", view.own).map((x) => x.id);
  const key = (id: string) => `${ctx.dateOf.get(id)}|${ctx.lieuRank.get(ctx.lieuOf.get(id) ?? "")}`;
  for (const [id, pages] of a.through) {
    const at = legacy.indexOf(id);
    const first = pages[0];
    const w = ` ${id}`;
    r.eq(`through${w} found`, at >= 0, first?.throughFound);
    r.order(
      "through: first answer",
      at >= 0 ? legacy.slice(0, at + 1) : legacy.slice(0, PAGE),
      first?.auditions.map((x) => x.id) ?? [],
      key,
      w,
    );
    r.order(
      "through: then on",
      legacy,
      pages.flatMap((p) => p.auditions.map((x) => x.id)),
      key,
      w,
    );
  }
}

function compareTestimonies(view: View, a: CaseAnswers): void {
  for (const [id, pages] of a.pages) {
    const legacy = (view.own.get(id)?.testimonies ?? []).map((t) => ({
      id: t.id,
      audition_id: id,
      person_name: t.person_name,
      person_info: t.person_info,
      content: t.content,
      topics: t.topics,
      verification_status: t.verification_status,
      created_at: t.created_at,
    }));
    const rows = pages.flatMap((p) => p.testimonies);
    r.eq(
      `testimonies of ${id} pages of ${PAGE}`,
      pages.slice(0, -1).every((p) => p.testimonies.length === PAGE),
      true,
    );
    r.eq(`testimonies of ${id}`, legacy, rows);
  }
}

/** The place picker's tree: the same nodes, labels, counts and order (ties: D3). */
function compareLocationTree(
  legacy: LocNode[],
  server: LocNode[],
  ctx: Ctx,
  nodes: Map<string, S.TreeNode>,
  at: string,
): void {
  const map = (t: string) => {
    const ids = ctx.ids.token.get(t);
    return ids && ids.size === 1 ? [...ids][0] : `?${t}`;
  };
  r.order(
    `place picker ${at}`,
    legacy.map((n) => map(n.token)),
    server.map((n) => n.token),
    (id) => `${nodes.get(id)?.n}|${nodes.get(id)?.rank}`,
  );
  const byToken = new Map(server.map((n) => [n.token, n]));
  for (const n of legacy) {
    const s = byToken.get(map(n.token));
    if (!s) continue;
    r.eq(`place picker ${n.token}`, [n.label, n.hint, n.count], [s.label, s.hint, s.count]);
    compareLocationTree(n.children ?? [], s.children ?? [], ctx, nodes, n.token);
  }
}

// ---- Main ---------------------------------------------------------------------------

function main(argv: string[]): number {
  if (!rpcsInstalled()) {
    console.error("The read RPCs are not installed: apply supabase/migrations first.");
    return 1;
  }
  const started = Date.now();
  const s = setup();
  const ex = exportLegacy(s);
  console.log(
    `Corpus ${ex.corpus.length} testimonies (anon), ${ex.groups.length} lieux on the map, ` +
      `${ex.auditions.length} auditions; ${s.reused} stale rows placed by reuse` +
      (s.leftStale.length ? `, ${s.leftStale.length} left stale (${s.leftStale.join(", ")})` : ""),
  );

  const status = new Map(ex.auditions.map((a) => [a.id, a.status]));
  // D1: drafts' testimonies, and audition-less ones, leave the public counts.
  const corpus = ex.corpus.filter((t) => t.audition && status.get(t.audition.id) === "published");
  const ids = idMapOf(ex.groups);
  const lieuRank = new Map<string, string>();
  const lieuOf = new Map<string, string>();
  const dateOf = new Map<string, string>();
  for (const g of ex.groups) {
    for (const a of g.auditions) {
      lieuOf.set(a.id, g.lieuId!);
      dateOf.set(a.id, a.date);
      if ((lieuRank.get(g.lieuId!) ?? "") < a.date) lieuRank.set(g.lieuId!, a.date);
    }
  }
  const ctx: Ctx = { ex, ids, lieuRank, lieuOf, dateOf };

  const unfiltered = buildGeoHierarchy(ex.groups);
  const cases = matrix(ex, corpus, ids, [...unfiltered.index.values()]);
  const serverUnits = [...ids.toLegacy.keys()].filter((id) => !id.startsWith("l:"));
  const serverLieux = [...ids.toLegacy.keys()].filter((id) => id.startsWith("l:"));
  // Testimony pages: every audition on the map, a few that are not (unplaced,
  // drafts, an online one nobody verified).
  const onMap = ex.groups.flatMap((g) => g.auditions.map((a) => a.id));
  const off = (pred: (a: AuditionRow) => boolean, n: number) =>
    ex.auditions
      .filter((a) => pred(a) && !onMap.includes(a.id))
      .slice(0, n)
      .map((a) => a.id);
  const others = [
    ...off((a) => a.status === "published" && !a.place_path && !a.audition_en_ligne, 4),
    ...off((a) => a.status !== "published", 3),
    ...off((a) => a.audition_en_ligne, 2),
  ];

  const calls: Call[] = [];
  const answers = new Map<string, CaseAnswers>();
  for (const c of cases) {
    const A: CaseAnswers = {
      lazy: [],
      lieu: new Map(),
      results: new Map(),
      through: new Map(),
      pages: new Map(),
    };
    answers.set(c.name, A);
    const F = jsonb(c.server);
    calls.push({
      sql: `select public.place_counts('world', ${F}, 2, true, 600, false)`,
      take: (v) => (A.complete = v as S.PlaceCounts),
    });
    const lazyUnits = ["world", ...serverUnits];
    for (let i = 0; i < lazyUnits.length; i += 20) {
      const batch = lazyUnits.slice(i, i + 20);
      calls.push({
        sql: `select public.place_counts_many(array[${batch.map((u) => `'${u}'`).join(", ")}], ${F}, 2, true, 0, false)`,
        take: (v) => A.lazy.push(...(v as S.PlaceCounts[])),
      });
    }
    for (const lieu of serverLieux) {
      for (const sort of SORTS) {
        calls.push({
          sql: `select public.lieu_auditions('${lieu}', ${F}, '${sort}')`,
          take: (v) => A.lieu.set(`${lieu}|${sort}`, v as S.LieuAuditions),
        });
      }
    }
    for (const sort of SORTS) {
      calls.push({
        sql: `select pg_temp.walk_results(${F}, '${sort}', ${PAGE})`,
        take: (v) => A.results.set(sort, v as S.ResultsPage[]),
      });
    }
    const view = legacyView(corpus, ex.groups, c.legacy);
    const listed = resultAuditions(view.groups, "recent", view.own).map((x) => x.id);
    const throughIds = [
      ...new Set(
        [listed[0], listed[PAGE - 1], listed[PAGE], listed[listed.length - 1]].filter(Boolean),
      ),
      ...others.slice(0, 1),
      onMap.find((id) => !listed.includes(id)),
    ].filter((x): x is string => Boolean(x));
    for (const id of throughIds) {
      calls.push({
        sql: `select pg_temp.walk_results(${F}, 'recent', ${PAGE}, '${id}')`,
        take: (v) => A.through.set(id, v as S.ResultsPage[]),
      });
    }
    for (const id of [...onMap, ...others]) {
      calls.push({
        sql: `select pg_temp.walk_testimonies('${id}', ${F}, ${PAGE})`,
        take: (v) => A.pages.set(id, v as S.TestimonyPage[]),
      });
    }
  }

  let facets: S.Facets | undefined;
  let empty: S.PlaceCounts | undefined;
  calls.push({ sql: "select public.place_facets()", take: (v) => (facets = v as S.Facets) });
  calls.push({
    sql: "select public.place_counts('world', '{}', 2, false, 600, true)",
    take: (v) => (empty = v as S.PlaceCounts),
  });

  // The admin list: every content filter, a super admin (null) and a plain one.
  const byAudition = testimoniesByAudition(ex.filterable);
  const adminNeedles = ["", "a", "loyer", "%", ...titleOnlyNeedles(ex, byAudition)];
  const adminCases: { name: string; f: { verified: boolean; topics: string[]; needle: string } }[] =
    [];
  for (const verified of [false, true]) {
    for (const topics of [[], [AUDITION_THEMES[7]], [AUDITION_THEMES[3], AUDITION_THEMES[11]]]) {
      for (const needle of adminNeedles) {
        if (!verified && !topics.length && !needle) continue;
        adminCases.push({
          name: `admin ${verified ? "verified " : ""}${topics.join("+") || "-"} «${needle}»`,
          f: { verified, topics, needle },
        });
      }
    }
  }
  const adminAnswers = new Map<string, { super?: S.AdminFilter; plain?: S.AdminFilter }>();
  for (const c of adminCases) {
    const F = jsonb(serverFilters({ ...NONE, ...c.f }, {}));
    const slot: { super?: S.AdminFilter; plain?: S.AdminFilter } = {};
    adminAnswers.set(c.name, slot);
    calls.push({
      sql: `select public.admin_audition_filter(${F}, null)`,
      take: (v) => (slot.super = v as S.AdminFilter),
    });
    calls.push({
      sql: `select public.admin_audition_filter(${F}, '${PLAIN_ADMIN}')`,
      take: (v) => (slot.plain = v as S.AdminFilter),
    });
  }

  // Refusals: 22023, never a result.
  const refusals: [string, string][] = [
    ["unknown filter", `select public.place_counts('world', '{"q":"x"}')`],
    ["mask out of range", `select public.place_counts('world', '{"mask":65536}')`],
    ["mask not an integer", `select public.place_counts('world', '{"mask":1.5}')`],
    [
      "like too long",
      `select public.place_counts('world', jsonb_build_object('like', repeat('a', 405)))`,
    ],
    [
      "51 units",
      `select public.place_counts('world', jsonb_build_object('units', (select jsonb_agg('FR'::text) from generate_series(1, 51))))`,
    ],
    [
      "malformed unit",
      `select public.place_counts('world', '{"units":["fr:dep:69; drop table x"]}')`,
    ],
    ["malformed lieu", `select public.place_counts('world', '{"lieux":["l:xyz"]}')`],
    ["no such day", `select public.place_counts('world', '{"from":"2026-02-30"}')`],
    ["malformed date", `select public.place_counts('world', '{"to":"26/10/2026"}')`],
    ["verified not a boolean", `select public.place_counts('world', '{"verified":"yes"}')`],
    ["filters not an object", `select public.place_counts('world', '[1]')`],
    ["malformed unit argument", `select public.place_counts('fr:dep:6/9')`],
    ["depth 4", `select public.place_counts('world', '{}', 4)`],
    ["budget 2001", `select public.place_counts('world', '{}', 2, false, 2001)`],
    [
      "empty with filters",
      `select public.place_counts('world', '{"verified":true}', 2, false, 600, true)`,
    ],
    [
      "21 units",
      `select public.place_counts_many((select array_agg('FR'::text) from generate_series(1, 21)))`,
    ],
    ["no units", `select public.place_counts_many('{}')`],
    ["lieu_auditions malformed lieu", `select public.lieu_auditions('Lyon')`],
    ["lieu_auditions sort", `select public.lieu_auditions('l:0123456789abcdef', '{}', 'random')`],
    ["results limit 101", `select public.audition_results('{}', 'recent', null, 101)`],
    ["results malformed after", `select public.audition_results('{}', 'recent', '["2026-01-01"]')`],
    [
      "results after and through",
      `select public.audition_results('{}', 'recent', '["2026-01-01","2026-01-01","l:0123456789abcdef","00000000-0000-4000-8000-000000000000"]', 7, '00000000-0000-4000-8000-000000000000')`,
    ],
    ["results sort", `select public.audition_results('{}', 'oldest')`],
    [
      "testimony_page limit 0",
      `select public.testimony_page('00000000-0000-4000-8000-000000000000', '{}', null, 0)`,
    ],
    [
      "testimony_page malformed after",
      `select public.testimony_page('00000000-0000-4000-8000-000000000000', '{}', '["x","y"]')`,
    ],
    ["admin filter with a date", `select public.admin_audition_filter('{"from":"2026-01-01"}')`],
    ["admin filter with places", `select public.admin_audition_filter('{"units":["FR"]}')`],
  ];
  const refused = new Map<string, unknown>();
  for (const [name, sql] of refusals) {
    calls.push({
      sql: `select pg_temp.sqlstate_of(${lit(sql)})`,
      take: (v) => refused.set(name, v),
    });
  }

  console.log(
    `${cases.length} filter cases, ${adminCases.length} admin cases, ${calls.length} calls…`,
  );
  const t0 = Date.now();
  runCalls(s, calls);
  console.log(`  answered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ---- Compare ----
  const placedPublic = new Set(onMap);
  const publicTestimonies = new Set(corpus.map((t) => t.id));
  for (const c of cases) {
    r.current = c.name;
    const view = legacyView(corpus, ex.groups, c.legacy);
    const A = answers.get(c.name)!;
    const complete = A.complete!;
    const tree = compareTree(view, complete, ctx);
    // N résultats = the placed and the unplaced, both public.
    r.eq("N résultats", view.filtered.length, complete.self.n + (complete.unplaced?.n ?? 0));
    const withDrafts = filteredTestimonies(ex.corpus, ex.groups, c.legacy).length;
    if (withDrafts !== view.filtered.length) {
      r.add(
        "D1",
        `N résultats: ${withDrafts} → ${view.filtered.length} (drafts' testimonies no longer counted)`,
      );
    }
    for (const lazy of A.lazy) compareLazy(lazy, complete, tree);
    compareLists(view, tree, A, ctx);
    compareResults(view, A, ctx);
    compareTestimonies(view, A);
    // Nothing a draft, an unverified online testimony or an unplaced audition holds is public.
    for (const pages of A.results.values()) {
      for (const x of pages.flatMap((p) => p.auditions)) {
        if (!placedPublic.has(x.id)) r.fail(`results list ${x.id}, not on the map`);
      }
    }
    for (const [id, pages] of A.pages) {
      for (const t of pages.flatMap((p) => p.testimonies)) {
        if (!publicTestimonies.has(t.id)) r.fail(`testimony_page ${id} shows ${t.id}, not public`);
      }
    }
  }

  // The setup's edge auditions reach every cohort of the analyses.
  r.current = "coverage";
  const fr = answers.get("none")!.complete!.units.find((u) => u.level === "country");
  const [terrain, cahier, archive] = fr?.facts?.cohorts ?? [0, 0, 0];
  console.log(
    `Cohorts under the country, no filter: ${terrain} terrain, ${cahier} cahier2019, ${archive} archive`,
  );
  r.eq("the 2019 cahiers and the archive are among the figures", true, cahier > 0 && archive > 0);

  r.current = "facets";
  const legacyTopics = topicOptions(corpus);
  r.eq("theme options", legacyTopics, S.topicOptionsOf(facets!.themes));
  const oldTopics = topicOptions(ex.corpus);
  if (!isDeepStrictEqual(oldTopics, legacyTopics)) {
    const was = new Map(oldTopics.map((o) => [o.value, o.hint]));
    const changed = legacyTopics
      .filter((o) => was.get(o.value) !== o.hint)
      .map((o) => `${o.value} ${was.get(o.value)} → ${o.hint}`);
    r.add("D1", `theme options: ${changed.join("; ")} (drafts' testimonies no longer counted)`);
  }
  const db = dateBounds(ex.groups);
  r.eq("date bounds", db.min ? [db.min, db.max] : null, facets!.dates);

  r.current = "place picker (empty=1)";
  const emptyTree = S.treeOf(empty!);
  compareLocationTree(locationTree(ex.groups), S.locationTreeOf(empty!), ctx, emptyTree, "root");
  // The home card: /api/map's groups, zero-testimony auditions included.
  for (const g of ex.groups) {
    const l = emptyTree.get(g.lieuId!)?.lieu;
    r.eq(
      `empty=1 lieu ${g.lieuId}`,
      {
        n: g.totalTestimonies,
        point: g.coordinates,
        list: g.auditions.map((a) => [a.id, a.title, a.date, a.testimony_count]),
      },
      { n: l?.n, point: l ? [l.lat, l.lng] : undefined, list: l?.list },
    );
  }

  for (const c of adminCases) {
    r.current = c.name;
    const { super: sup = null, plain = null } = adminAnswers.get(c.name)!;
    const legacy = ex.auditions
      .filter((a) => passesContentFilters(a, c.f, byAudition))
      .map((a) => a.id);
    r.eq(
      "passing auditions",
      legacy,
      ex.auditions.filter((a) => S.adminPasses(a, c.f, sup)).map((a) => a.id),
    );
    r.eq(
      "passing auditions (plain admin's call)",
      legacy,
      ex.auditions.filter((a) => S.adminPasses(a, c.f, plain)).map((a) => a.id),
    );
    const all = new Set(ex.auditions.map((a) => a.id));
    const mine = new Set(ex.auditions.filter((a) => a.created_by === PLAIN_ADMIN).map((a) => a.id));
    r.eq(
      "theme options (super admin)",
      adminTopicOptions(ex.filterable, all),
      S.adminTopicOptions(sup?.themes ?? []),
    );
    r.eq(
      "theme options (plain admin)",
      adminTopicOptions(ex.filterable, mine),
      S.adminTopicOptions(plain?.themes ?? []),
    );
  }

  r.current = "refusals";
  for (const [name] of refusals) r.eq(`${name} refused with 22023`, "22023", refused.get(name));

  r.print();
  const fails = r.count("fail");
  console.log(
    `\n${r.checks} checks over ${cases.length} filter cases and ${adminCases.length} admin cases: ` +
      `${r.count("D1")} D1, ${r.count("D3")} D3, ${fails} unexpected (${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  const out = argv[argv.indexOf("--json") + 1];
  if (argv.includes("--json") && out) writeFileSync(out, JSON.stringify(r, null, 2));
  return fails ? 1 : 0;
}

/** Needles found in an audition's title, location or context, and in none of its testimonies. */
function titleOnlyNeedles(
  ex: Exported,
  byAudition: ReturnType<typeof testimoniesByAudition>,
): string[] {
  const out: string[] = [];
  for (const a of ex.auditions) {
    const hays = (byAudition.get(a.id) ?? []).map((e) => e.hay);
    if (!hays.length) continue;
    for (const field of [a.location, a.content]) {
      const word = (fold(field).match(/[a-z]{6,}/g) ?? []).find(
        (w) => !hays.some((h) => h.includes(w)) && !out.includes(w),
      );
      if (word) {
        out.push(word);
        break;
      }
    }
    if (out.length >= 2) break;
  }
  return out;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
