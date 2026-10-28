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
// Deliberate differences are tagged with their number in the design (A21):
// D1, the testimonies of drafts (and of no audition) leaving the result count
// and the theme counts. The testing tools only: imported by the explorer in
// comparer mode, never in a production build.

import { reactive, watch } from "vue";
import type { QueryClient } from "@tanstack/vue-query";
import type { PublicTestimony } from "@ac/shared";
import {
  analyseScope,
  buildFactsIndex,
  buildUnitStats,
  type UnitFigures,
  type UnitStatsIndex,
} from "@/features/analyses";
import {
  compareTrees,
  groupOwnAuditions,
  placeLabel,
  type BoundaryFC,
  type UnitTree,
} from "@/features/geo-nav";
import type { LocNode } from "@/shared/ui/select/treeNode";
import type { useTestimonyFiltering } from "./useTestimonyFiltering";
import { testimoniesKeys } from "./api/queries";
import { placeTreeMode } from "./dataSource";

export interface CompareDiff {
  area: "tree" | "figures" | "analysis" | "facets" | "placeTree";
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

/** What the badge shows: the last report's counts. */
export const compareState = reactive({
  key: null as string | null,
  count: null as number | null,
  d1: 0,
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
    const corpusLabels = new Map<string, string>();
    for (const { corpus } of trees.pairs) {
      if (corpus.levelKey === "place" && corpus.canonical)
        corpusLabels.set(corpus.canonical, corpus.label);
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

    // The result count, the theme counts and the date bounds.
    const facet = (field: string, c: unknown, s: unknown, d?: "D1") => {
      if (!same(c, s)) diffs.push({ area: "facets", id: field, field, corpus: c, server: s, d });
    };
    facet("resultCount", filtering.corpus.resultCount.value, filtering.resultCount.value, "D1");
    facet("topicOptions", filtering.corpus.topicOptions.value, filtering.topicOptions.value, "D1");
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

  const w = window as unknown as {
    __acCompare?: CompareReport | null;
    __acCompareRun?: () => CompareReport | null;
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
      preview(),
    ],
    () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(publish, 150);
    },
    { immediate: true },
  );
}
