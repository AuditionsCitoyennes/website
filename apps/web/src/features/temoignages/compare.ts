// The comparer (map phase 1, the "comparer" data source, design A20, E5): the
// server's pipeline is on screen, today's corpus pipeline runs beside it on
// the same filters, and every difference is listed in window.__acCompare —
// a DEV badge counts them (DevDataSwitch). Compared, once the key asked for is
// the one on screen and the corpus is in:
// - every unit of the tree: count, label, level, centre, box, codes, outline,
//   lieux and their labels, the children's order (geo-nav's compareTrees);
// - every unit's analyses figures and its analysis (themes' order,
//   reliability, the concentration's lieu);
// - the result count, the theme counts and the date bounds;
// - the place picker's tree (its arrondissements flattened, as the corpus'
//   is: "Arbre des lieux" = sans).
// And the lists (PR K), in window.__acCompareLists once the tree's report is
// made (__acCompareListsRun({ testimonies: true }) for every testimony too):
// - the results, every page, in the panel's order (id, title, date, count,
//   the lieu's label), their totals and the map's frame of them;
// - what the panel lists of them (window.__acLists): the corpus' list as far
//   as it reveals it — a page, or as far as the audition being read —, its
//   heading, nothing of a previous key;
// - every lieu's auditions (its embedded list, or its read when held);
// - each result's testimonies, every page, in order (asked for: all of them).
// Deliberate differences are tagged with their number in the design (A21):
// D1, the testimonies of drafts (and of no audition) leaving the result count
// and the theme counts — checked, not assumed: the corpus' figures without
// them (the published auditions read from /api/auditions) must equal the
// server's, or the difference counts. The testing tools only: imported by the
// explorer in comparer mode, never in a production build.

import { reactive, watch } from "vue";
import type { QueryClient } from "@tanstack/vue-query";
import type {
  PlaceLieuAuditions,
  PlaceResultRow,
  PlaceResultsPage,
  PublicTestimony,
  TestimonyPage,
} from "@ac/shared";
import { buildTopicOptions } from "@/features/filters";
import { api, ApiError } from "@/shared/api/client";
import {
  analyseScope,
  buildFactsIndex,
  buildUnitStats,
  type UnitFigures,
  type UnitStatsIndex,
} from "@/features/analyses";
import {
  bySort,
  compareTrees,
  groupOwnAuditions,
  placeLabel,
  placesKeys,
  resultBounds,
  type BoundaryFC,
  type UnitTree,
} from "@/features/geo-nav";
import type { LocNode } from "@/shared/ui/select/treeNode";
import type { useTestimonyFiltering } from "./useTestimonyFiltering";
import { testimoniesKeys } from "./api/queries";
import { placeTreeMode } from "./dataSource";

export interface CompareDiff {
  area:
    | "tree"
    | "figures"
    | "analysis"
    | "facets"
    | "placeTree"
    | "results"
    | "panel"
    | "frame"
    | "lieu"
    | "testimonies";
  /** The unit (the corpus' path id), or what is compared. */
  id: string;
  field: string;
  corpus: unknown;
  server: unknown;
  /** A deliberate change of the design (A21). */
  d?: "D1";
}

export interface CompareReport {
  key: string;
  at: string;
  /** Units matched, figures compared, place picker nodes compared. */
  checked: { units: number; figures: number; placeTree: number | null };
  /** Units of the server's tree whose children are not known yet. */
  pending: number;
  /** Differences that are no deliberate change. */
  count: number;
  /** D1's. */
  d1: number;
  diffs: CompareDiff[];
}

/** The lists' report (window.__acCompareLists). */
export interface ListsReport {
  key: string;
  sort: "recent" | "ancien";
  at: string;
  /** Results rows, the panel's rows, lieux' lists and testimony lists compared. */
  checked: { results: number; panel: number; lieux: number; testimonies: number };
  /** Lieux whose list the server has not embedded nor been asked for. */
  lieuxUnchecked: number;
  count: number;
  diffs: CompareDiff[];
}

/** What the badge shows: the last reports' counts. */
export const compareState = reactive({
  key: null as string | null,
  count: null as number | null,
  d1: 0,
  /** The lists' differences (null: not compared yet). */
  lists: null as number | null,
});

/** JSON with its objects' keys sorted: values compared, not key orders. */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function figuresJson(f: UnitFigures | undefined) {
  if (!f) return null;
  return { ...f, themes: Array.from(f.themes), themeAuditions: Array.from(f.themeAuditions) };
}

function analysisJson(
  unit: Parameters<typeof analyseScope>[0],
  index: UnitStatsIndex,
  label: (lieu: { key: string; city: string | null }) => string,
) {
  const a = analyseScope(unit, index, { placeLabel: label });
  // The ids differ by design (name paths, unit ids).
  return a && { ...a, scopeId: undefined };
}

/** Two place picker trees, node by node (tokens differ: names and ids). */
function comparePlaceTrees(
  corpus: LocNode[],
  server: LocNode[],
  path: string,
  diffs: CompareDiff[],
): number {
  const strip = (n: LocNode) => ({ label: n.label, hint: n.hint ?? null, count: n.count ?? null });
  if (
    !same(
      corpus.map((n) => n.label),
      server.map((n) => n.label),
    )
  ) {
    diffs.push({
      area: "placeTree",
      id: path || "(racine)",
      field: "children",
      corpus: corpus.map((n) => n.label),
      server: server.map((n) => n.label),
    });
  }
  let n = 0;
  const byLabel = new Map(server.map((s) => [s.label, s]));
  for (const c of corpus) {
    const s = byLabel.get(c.label);
    if (!s) continue;
    n++;
    if (!same(strip(c), strip(s))) {
      diffs.push({
        area: "placeTree",
        id: `${path}/${c.label}`,
        field: "node",
        corpus: strip(c),
        server: strip(s),
      });
    }
    n += comparePlaceTrees(c.children ?? [], s.children ?? [], `${path}/${c.label}`, diffs);
  }
  return n;
}

export function startCompare(inputs: {
  queryClient: QueryClient;
  tree: UnitTree;
  filtering: ReturnType<typeof useTestimonyFiltering>;
  preview: () => boolean;
}) {
  const { queryClient, tree, filtering, preview } = inputs;
  const sf = filtering.serverFilters!;

  // The published auditions (D1: the others' testimonies leave the counts);
  // null until read, or when they cannot be (past the API's guard).
  let published: Set<string> | null = null;
  void queryClient
    .fetchQuery({
      queryKey: ["compare", "published"],
      queryFn: () => api.get<{ id: string }[]>("/api/auditions"),
    })
    .then(
      (rows) => {
        published = new Set(rows.map((a) => a.id));
        publish();
      },
      (err) =>
        console.warn("[comparer] the published auditions could not be read: D1 unchecked", err),
    );

  function run(): CompareReport | null {
    const key = sf.key.value;
    const data = tree.data();
    if (preview() || !data || tree.shownKey() !== key || tree.wantedKey() !== key) return null;
    const testimonies = queryClient.getQueryData<PublicTestimony[]>(testimoniesKeys.list);
    if (!testimonies || !filtering.facets.value) return null;

    const diffs: CompareDiff[] = [];
    const groups = filtering.groups.value;

    // The tree.
    const fcs = {
      regions: queryClient.getQueryData<BoundaryFC>(["boundaries", "regions"]),
      departements: queryClient.getQueryData<BoundaryFC>(["boundaries", "departements"]),
    };
    const trees = compareTrees(groups, data, fcs);
    for (const d of trees.diffs) diffs.push({ area: "tree", ...d });

    // Every unit's figures and analysis.
    const legacy = buildUnitStats(groups, groupOwnAuditions(filtering.filteredTestimonies.value));
    const facts = buildFactsIndex(tree.facts());
    // As the corpus pipeline names a lieu: from all its lieux (placeByCanonical).
    const corpusLabels = new Map<string, string>();
    for (const u of trees.corpusIndex.values()) {
      if (u.levelKey === "place" && u.canonical) corpusLabels.set(u.canonical, u.label);
    }
    let figures = 0;
    for (const { corpus, server } of trees.pairs) {
      if (corpus.levelKey === "world" || corpus.levelKey === "place") continue;
      const c = figuresJson(legacy.figuresOf(corpus.id));
      const s = figuresJson(facts.figuresOf(server.id));
      if (!s && server.childrenPending) continue; // not sent yet (lazy path)
      figures++;
      if (!same(c, s))
        diffs.push({ area: "figures", id: corpus.id, field: "figures", corpus: c, server: s });
      const ca = analysisJson(corpus, legacy, (l) => corpusLabels.get(l.key) ?? l.key);
      const sa = analysisJson(server, facts, (l) => placeLabel(l.key, l.city));
      if (!same(ca, sa))
        diffs.push({ area: "analysis", id: corpus.id, field: "analysis", corpus: ca, server: sa });
    }

    // The result count, the theme counts and the date bounds. D1's two: the
    // corpus' without D1's testimonies must be the server's (else a bug); the
    // corpus' as it is then differs by D1 alone. Unchecked: counted.
    const facet = (field: string, c: unknown, s: unknown) => {
      if (!same(c, s)) diffs.push({ area: "facets", id: field, field, corpus: c, server: s });
    };
    const facetD1 = (field: string, c: unknown, withoutD1: unknown, s: unknown) => {
      if (withoutD1 === null || !same(withoutD1, s)) {
        facet(field, withoutD1 ?? c, s);
      } else if (!same(c, s)) {
        diffs.push({ area: "facets", id: field, field, corpus: c, server: s, d: "D1" });
      }
    };
    const pub = published;
    const kept = (t: PublicTestimony) => !!t.audition && !!pub?.has(t.audition.id);
    facetD1(
      "resultCount",
      filtering.corpus.resultCount.value,
      pub ? filtering.filteredTestimonies.value.filter(kept).length : null,
      filtering.resultCount.value,
    );
    facetD1(
      "topicOptions",
      filtering.corpus.topicOptions.value,
      pub ? buildTopicOptions(testimonies.filter(kept).map((t) => t.topics)) : null,
      filtering.topicOptions.value,
    );
    facet("dateBounds", filtering.corpus.dateBounds.value, filtering.dateBounds.value);

    // The place picker's tree (as the corpus builds it: arrondissements flattened).
    let placeTree: number | null = null;
    if (tree.emptyData() && placeTreeMode.value === "sans") {
      placeTree = comparePlaceTrees(
        filtering.corpus.locationTree.value,
        filtering.locationTree.value,
        "",
        diffs,
      );
    }

    const d1 = diffs.filter((d) => d.d === "D1").length;
    return {
      key,
      at: new Date().toISOString(),
      checked: { units: trees.pairs.length, figures, placeTree },
      pending: trees.pending,
      count: diffs.length - d1,
      d1,
      diffs,
    };
  }

  // ---- The lists (PR K) ----

  /** A read of the API, waited for when refused for now (the miss limits
   *  are shared by every tab of the machine). */
  async function read<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.get<T>(path);
      } catch (err) {
        const again = err instanceof ApiError && (err.status === 429 || err.status === 503);
        if (!again || attempt >= 40) throw err;
        const wait = err instanceof ApiError && err.retryAfter !== null ? err.retryAfter : 1;
        await new Promise((r) => window.setTimeout(r, Math.max(250, wait * 1000)));
      }
    }
  }

  /** Every page of the results under a key and sort (cached for the page). */
  const allResults = new Map<string, Promise<PlaceResultsPage[]>>();
  function resultsOf(params: Readonly<Record<string, string>>, sort: string) {
    const id = `${JSON.stringify(params)}|${sort}`;
    let pages = allResults.get(id);
    if (!pages) {
      pages = (async () => {
        const out: PlaceResultsPage[] = [];
        let after: string | null = null;
        do {
          const q = new URLSearchParams(params);
          q.set("sort", sort);
          q.set("limit", "100");
          if (after) q.set("after", after);
          const page: PlaceResultsPage = await read<PlaceResultsPage>(`/api/places/results?${q}`);
          out.push(page);
          after = page.next ? page.next.join(",") : null;
        } while (after);
        return out;
      })();
      pages.catch(() => allResults.delete(id));
      allResults.set(id, pages);
    }
    return pages;
  }

  /** Every page of an audition's testimonies under the content filters. */
  async function testimoniesOf(audition: string, params: Readonly<Record<string, string>>) {
    const out: TestimonyPage["testimonies"] = [];
    let after: string | null = null;
    do {
      const q = new URLSearchParams();
      for (const k of ["v", "t", "q"]) if (params[k] !== undefined) q.set(k, params[k]);
      q.set("limit", "100");
      if (after) q.set("after", after);
      const page: TestimonyPage = await read<TestimonyPage>(
        `/api/auditions/${audition}/testimonies?${q}`,
      );
      out.push(...page.testimonies);
      after = page.next ? `${page.next[0] ?? ""},${page.next[1]}` : null;
    } while (after);
    return out;
  }

  /** A testimony as the panel's card reads it. */
  const card = (t: Omit<PublicTestimony, "audition">) => ({
    id: t.id,
    person_name: t.person_name,
    person_info: t.person_info,
    content: t.content,
    topics: t.topics,
    verification_status: t.verification_status,
    created_at: t.created_at,
  });

  /** The panel's results (GeoNav's probe), once on screen for this key and
   *  sort — or failed, or still another's after a while. */
  interface PanelResults {
    results: {
      key: string;
      sort: string;
      current: boolean;
      ids: string[];
      total: { auditions: number } | null;
    } | null;
    failed: boolean;
    settling: unknown;
    limit: number;
    open: string | null;
  }
  async function panelResults(key: string, sort: string): Promise<PanelResults | null> {
    const probe = () =>
      (window as unknown as { __acLists?: () => PanelResults | null }).__acLists?.();
    for (let waited = 0; ; waited += 100) {
      const p = probe() ?? null;
      const r = p?.results;
      if (!p || p.failed || waited >= 8000) return p;
      if (r && r.key === key && r.sort === sort && r.current && !p.settling) return p;
      await new Promise((ok) => window.setTimeout(ok, 100));
    }
  }

  async function runLists(opts: { testimonies?: boolean } = {}): Promise<ListsReport | null> {
    const key = sf.key.value;
    const sort = filtering.sort.value === "ancien" ? "ancien" : "recent";
    const data = tree.data();
    if (preview() || !data || tree.shownKey() !== key || tree.wantedKey() !== key) return null;
    const testimonies = queryClient.getQueryData<PublicTestimony[]>(testimoniesKeys.list);
    if (!testimonies) return null;
    const params = { ...sf.params.value };
    const groups = filtering.groups.value;
    const own = groupOwnAuditions(filtering.filteredTestimonies.value);
    const diffs: CompareDiff[] = [];
    const fcs = {
      regions: queryClient.getQueryData<BoundaryFC>(["boundaries", "regions"]),
      departements: queryClient.getQueryData<BoundaryFC>(["boundaries", "departements"]),
    };
    const trees = compareTrees(groups, data, fcs);
    // As the corpus' panel names a lieu: placeByCanonical (the last of a name).
    const corpusLabels = new Map<string, string>();
    for (const u of trees.corpusIndex.values()) {
      if (u.levelKey === "place" && u.canonical) corpusLabels.set(u.canonical, u.label);
    }
    const countOf = (a: { id: string; testimony_count: number }) =>
      own.get(a.id)?.testimonies.length ?? a.testimony_count;

    // The results, in the panel's order (the corpus': every audition of the
    // filtered groups by date, the map's order breaking ties).
    const corpusRows = groups
      .flatMap((g) =>
        g.auditions.map((a) => ({
          id: a.id,
          title: a.title,
          date: a.date,
          count: countOf(a),
          lieu: corpusLabels.get(g.canonicalName) ?? g.canonicalName,
        })),
      )
      .sort((a, b) => bySort(a, b, sort));
    const pages = await resultsOf(params, sort);
    const serverRows = pages
      .flatMap((p) => p.auditions)
      .map((a: PlaceResultRow) => ({
        id: a.id,
        title: a.title,
        date: a.date,
        count: a.n,
        lieu: placeLabel(a.lieu.key, a.lieu.city),
      }));
    const ids = new Set<string>();
    for (const r of serverRows) {
      if (ids.has(r.id))
        diffs.push({ area: "results", id: r.id, field: "duplicate", corpus: null, server: r.id });
      ids.add(r.id);
    }
    if (
      !same(
        corpusRows.map((r) => r.id),
        serverRows.map((r) => r.id),
      )
    ) {
      diffs.push({
        area: "results",
        id: key,
        field: "order",
        corpus: corpusRows.map((r) => r.id),
        server: serverRows.map((r) => r.id),
      });
    }
    const byId = new Map(serverRows.map((r) => [r.id, r]));
    for (const c of corpusRows) {
      const sr = byId.get(c.id);
      if (sr && !same(c, sr))
        diffs.push({ area: "results", id: c.id, field: "row", corpus: c, server: sr });
    }
    const total = pages[0]?.total ?? null;
    const corpusTotal = {
      auditions: corpusRows.length,
      lieux: groups.length,
      n: corpusRows.reduce((s, r) => s + r.count, 0),
    };
    if (!same(corpusTotal, total)) {
      diffs.push({ area: "results", id: key, field: "total", corpus: corpusTotal, server: total });
    }
    // The map's frame of them (the camera's resultBounds over the lieux).
    const places = [...trees.corpusIndex.values()].filter((u) => u.levelKey === "place");
    const corpusFrame = resultBounds(places);
    const f = pages[0]?.frame ?? null;
    const serverFrame = f ? { minLat: f[0], maxLat: f[2], minLng: f[1], maxLng: f[3] } : null;
    if (!same(corpusFrame, serverFrame)) {
      diffs.push({
        area: "frame",
        id: key,
        field: "frame",
        corpus: corpusFrame,
        server: serverFrame,
      });
    }

    // What the panel lists: the corpus' list as far as it reveals it (its
    // first page, or as far as the audition being read; a page more at each
    // end reached), its heading — never a previous key's, nor a failure.
    let panelRows = 0;
    const panel = key !== "" ? await panelResults(key, sort) : null;
    if (panel) {
      const r = panel.results;
      if (panel.failed || !r || r.key !== key || r.sort !== sort) {
        diffs.push({
          area: "panel",
          id: key,
          field: panel.failed ? "failed" : "stale",
          corpus: { key, sort },
          server: r ? { key: r.key, sort: r.sort } : null,
        });
      } else {
        panelRows = r.ids.length;
        const corpusIds = corpusRows.map((c) => c.id);
        if (!same(r.ids, corpusIds.slice(0, r.ids.length))) {
          diffs.push({
            area: "panel",
            id: key,
            field: "rows",
            corpus: corpusIds.slice(0, r.ids.length),
            server: r.ids,
          });
        }
        const at = panel.open ? corpusIds.indexOf(panel.open) : -1;
        const least = Math.min(corpusIds.length, Math.max(panel.limit, at + 1));
        if (r.ids.length < least) {
          diffs.push({
            area: "panel",
            id: key,
            field: "reveal",
            corpus: least,
            server: r.ids.length,
          });
        }
        if (r.total?.auditions !== corpusIds.length) {
          diffs.push({
            area: "panel",
            id: key,
            field: "heading",
            corpus: corpusIds.length,
            server: r.total?.auditions ?? null,
          });
        }
      }
    }

    // Every lieu's auditions: its embedded list, or its read when held.
    let lieux = 0;
    let lieuxUnchecked = 0;
    for (const { corpus, server } of trees.pairs) {
      if (corpus.levelKey !== "place") continue;
      const embedded = data.lieux.get(server.id)?.list?.map(([id, title, date, n]) => ({
        id,
        title,
        date,
        n,
      }));
      const asked = queryClient.getQueryData<PlaceLieuAuditions>(placesKeys.lieu(server.id, key));
      const rows = embedded ?? asked?.auditions;
      if (!rows) {
        lieuxUnchecked++;
        continue;
      }
      lieux++;
      const cl = groups
        .filter((g) => g.canonicalName === corpus.canonical)
        .flatMap((g) =>
          g.auditions.map((a) => ({ id: a.id, title: a.title, date: a.date, count: countOf(a) })),
        )
        .sort((a, b) => bySort(a, b, sort));
      const sl = rows
        .map((a) => ({ id: a.id, title: a.title, date: a.date, count: a.n }))
        .sort((a, b) => bySort(a, b, sort));
      if (!same(cl, sl))
        diffs.push({ area: "lieu", id: corpus.id, field: "auditions", corpus: cl, server: sl });
    }

    // Each result's testimonies, every page (asked for).
    let tested = 0;
    if (opts.testimonies) {
      for (const r of corpusRows) {
        // Paced under the miss limit (30 per 10 s), shared with the page.
        await new Promise((ok) => window.setTimeout(ok, 600));
        const c = (own.get(r.id)?.testimonies ?? []).map(card);
        const s2 = (await testimoniesOf(r.id, params)).map(card);
        tested++;
        if (!same(c, s2)) {
          diffs.push({
            area: "testimonies",
            id: r.id,
            field: "testimonies",
            corpus: c.map((t) => t.id),
            server: s2.map((t) => t.id),
          });
        }
      }
    }
    return {
      key,
      sort,
      at: new Date().toISOString(),
      checked: { results: serverRows.length, panel: panelRows, lieux, testimonies: tested },
      lieuxUnchecked,
      count: diffs.length,
      diffs,
    };
  }

  const w = window as unknown as {
    __acCompare?: CompareReport | null;
    __acCompareRun?: () => CompareReport | null;
    __acCompareLists?: ListsReport | null;
    __acCompareListsRun?: (opts?: { testimonies?: boolean }) => Promise<ListsReport | null>;
  };
  function publish() {
    const report = run();
    if (!report) return null;
    w.__acCompare = report;
    compareState.key = report.key;
    compareState.count = report.count;
    compareState.d1 = report.d1;
    if (report.count) {
      console.warn(
        `[comparer] ${report.count} difference(s) for key "${report.key}"`,
        report.diffs,
      );
    }
    return report;
  }
  w.__acCompareRun = publish;

  async function publishLists(opts: { testimonies?: boolean } = {}) {
    const report = await runLists(opts);
    if (!report) return null;
    w.__acCompareLists = report;
    compareState.lists = report.count;
    if (report.count) {
      console.warn(
        `[comparer] ${report.count} list difference(s) for key "${report.key}"`,
        report.diffs,
      );
    }
    return report;
  }
  w.__acCompareListsRun = publishLists;

  let timer = 0;
  watch(
    () => [
      tree.version.value,
      tree.sideVersion.value,
      tree.status.value,
      sf.key.value,
      filtering.groups.value,
      filtering.filteredTestimonies.value,
      filtering.facets.value,
      filtering.locationTree.value,
      placeTreeMode.value,
      filtering.sort.value,
      preview(),
    ],
    () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (publish()) void publishLists().catch((err) => console.warn("[comparer] lists", err));
      }, 150);
    },
    { immediate: true },
  );
}
