// The panel's lists from the server (map phase 1, design E1 (K), A21 D10,
// D13), beside the tree (useUnitTree) they belong to:
//
// - The results (filters on): keyset pages of /api/places/results under the
//   filter key asked of the tree (one with a text once the tree shows it: a
//   key typed past costs no search of its own), a page as the reader scrolls.
//   A new answer goes on screen with the tree of its key — the previous one
//   stays meanwhile (D6) —, read first as far as it must be (resultsPages'
//   readTarget: the audition being read, or the rows of the same list on
//   screen). Its first page gives the heading's total and the map's frame. A
//   key or order come back to is read again from its first page, as the
//   corpus' reveal restarts. Failed for good, the panel's error line shows,
//   and the next scope change asks again.
// - The open lieu's auditions: its row's own list when the tree's answer
//   embedded it (a complete answer: production's case, nothing is fetched);
//   else /api/places/lieu, LoadingDots meanwhile (D13).
// - The open audition's testimonies, 50 at a time, oldest first; the first
//   page of the open lieu's first auditions asked for ahead (D10).
//
// Every read is a vue-query entry under placesKeys.all (an audition created
// invalidates them all, PR L), tried again after Retry-After when refused.

import { computed, onScopeDispose, shallowRef, watch, type ComputedRef, type Ref } from "vue";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type QueryClient,
} from "@tanstack/vue-query";
import type {
  PlaceResultLieu,
  PlaceResultRow,
  PlaceResultsCursor,
  PlaceResultsPage,
  PlaceSort,
  PublicTestimony,
  TestimonyPageCursor,
} from "@ac/shared";
import type { Bounds, GeoUnit } from "@/features/geo";
import { EMPTY_KEY, placesKeys } from "../keys";
import type { NavState } from "../navState";
import { bySort, type AuditionSort } from "../model/auditions";
import type { UnitTree } from "./useUnitTree";
import {
  contentOf,
  fetchLieuAuditions,
  fetchResults,
  fetchTestimonyPage,
  RESULTS_LIMIT,
  retryDelay,
  retryRefused,
  type LieuAuditions,
  type TestimoniesPage,
} from "./listsApi";
import {
  firstPageOnly,
  orderSig,
  readTarget,
  rowsOf,
  setSig,
  withThrough,
  type ResultsData,
  type ResultsPage,
} from "./resultsPages";

/** A list's answer is fresh this long (the app's default). */
const STALE_MS = 5 * 60 * 1000;
/** The open lieu's first auditions (panel order) whose first testimony page
 *  is asked for ahead: each is a miss the visitor pays for (30 per 10 s). */
const PREFETCH_MAX = 3;

/** An audition of a list: what the panel's line shows. */
export interface ListedAudition {
  id: string;
  title: string;
  date: string;
  n: number;
}

/** An audition's testimonies as the panel shows them. */
export interface ListedTestimonies {
  /** null: not here yet (LoadingDots). */
  list: PublicTestimony[] | null;
  /** More pages to come (the sentinel at the end of its text). */
  more: boolean;
  /** They could not be had. */
  failed: boolean;
}

const NOT_HERE: ListedTestimonies = { list: null, more: false, failed: false };

/** Whether an audition is among the results, read as far as it: "failed",
 *  the server could not say. */
export type ThroughAnswer = "found" | "absent" | "failed";

interface ShownResults {
  key: string;
  sort: PlaceSort;
  pages: readonly ResultsPage[];
  /** The audition being read, when whether it still matches could not be
   *  read: kept open rather than closed on a guess. */
  unknown: string | null;
}

export interface ServerListsInputs {
  queryClient: QueryClient;
  tree: UnitTree;
  sort: Ref<AuditionSort | undefined>;
  /** Filters are on: the results are listed. */
  listMode: ComputedRef<boolean>;
  nav: NavState;
  /** The open lieu. */
  selectedPlace: ComputedRef<GeoUnit | null>;
}

/** Resolves true once `ready()` holds, false after `ms`. */
function until(ready: () => boolean, ms = 3000): Promise<boolean> {
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      stop();
      resolve(false);
    }, ms);
    const stop = watch(ready, (ok) => {
      if (!ok) return;
      window.clearTimeout(timer);
      stop();
      resolve(true);
    });
  });
}

export function useServerLists(inputs: ServerListsInputs) {
  const { queryClient, tree, sort, listMode, nav, selectedPlace } = inputs;
  const { openAuditions, currentScope, selectedPlaceId } = nav;

  const sortNow = computed<PlaceSort>(() => (sort.value === "ancien" ? "ancien" : "recent"));
  /** The audition being read (single-open accordion). */
  const openId = computed<string | null>(() => {
    for (const id of openAuditions.value) return id;
    return null;
  });

  /** A kept key's filters, or a failure (its store dropped: nothing to ask). */
  function paramsOf(key: string): Readonly<Record<string, string>> {
    const params = tree.paramsOf(key);
    if (!params) throw new Error(`No filters held for "${key}".`);
    return params;
  }

  // ---- The results --------------------------------------------------------------

  /** The filter key the results are wanted under: the tree's last asked, filters on. */
  const resultsKey = computed<string | null>(() => {
    if (!listMode.value) return null;
    const key = tree.wantedKey();
    return key && key !== EMPTY_KEY ? key : null;
  });
  /** The key they are asked under: a key with a text once the tree shows it
   *  (typing, each key costs a search: one typed past costs one, not two). */
  const resultsAsked = computed<string | null>(() => {
    const key = resultsKey.value;
    if (key === null) return null;
    return tree.paramsOf(key)?.q !== undefined && tree.shownKey() !== key ? null : key;
  });
  const resultsQueryKey = (key: string, s: PlaceSort) => placesKeys.results(key, s, RESULTS_LIMIT);

  /** The results on screen (null: none yet, or failed). */
  const settled = shallowRef<ShownResults | null>(null);

  // A key or order come back to is read from its first page again (the
  // corpus' reveal restarts at a new list): the pages kept beyond it are
  // dropped before the query is pointed at it — a stale one is then read
  // again as one page, not as many as were loaded.
  watch(
    [resultsAsked, sortNow],
    ([key, s]) => {
      const on = settled.value;
      if (key === null || (on && on.key === key && on.sort === s)) return;
      const queryKey = resultsQueryKey(key, s);
      const state = queryClient.getQueryState<ResultsData>(queryKey);
      const first = firstPageOnly(state?.data);
      if (state && first !== state.data) {
        queryClient.setQueryData(queryKey, first, { updatedAt: state.dataUpdatedAt });
      }
    },
    { flush: "sync" },
  );

  const resultsQuery = useInfiniteQuery({
    queryKey: computed(() => resultsQueryKey(resultsAsked.value ?? "", sortNow.value)),
    enabled: computed(() => resultsAsked.value !== null),
    queryFn: async ({ queryKey, pageParam, signal }): Promise<ResultsPage> => {
      const key = queryKey[2];
      const sortAsked = queryKey[3] as PlaceSort;
      const page = await fetchResults(
        paramsOf(key),
        sortAsked,
        { after: pageParam, limit: RESULTS_LIMIT },
        signal,
      );
      return { ...page, key, sort: sortAsked };
    },
    initialPageParam: null as PlaceResultsCursor | null,
    getNextPageParam: (last: ResultsPage) => last.next ?? undefined,
    staleTime: STALE_MS,
    retry: retryRefused,
    retryDelay,
    shallow: true,
  });

  /**
   * Whether an audition is among a key's results, read as far as it
   * (results?through=, tried again when refused); found, the rows beyond
   * the pages loaded are appended to them.
   */
  async function readThrough(key: string, s: PlaceSort, id: string): Promise<ThroughAnswer> {
    let page: PlaceResultsPage;
    try {
      page = await queryClient.fetchQuery({
        queryKey: placesKeys.through(key, s, id, RESULTS_LIMIT),
        queryFn: ({ signal }) =>
          fetchResults(paramsOf(key), s, { through: id, limit: RESULTS_LIMIT }, signal),
        staleTime: STALE_MS,
        retry: retryRefused,
        retryDelay,
      });
    } catch {
      return "failed";
    }
    if (!page.throughFound) return "absent";
    const queryKey = resultsQueryKey(key, s);
    const state = queryClient.getQueryState<ResultsData>(queryKey);
    if (state?.data) {
      queryClient.setQueryData<ResultsData>(queryKey, (old) => withThrough(old, page, key, s), {
        updatedAt: state.dataUpdatedAt,
      });
    }
    return "found";
  }

  // A new answer (key or order) goes on screen once the tree of its key is,
  // read first as far as it must be; the pages appended to the one on screen
  // follow it at once.
  let settleTokens = 0;
  /** A new answer on its way to the screen (its read through an audition). */
  let settling: {
    key: string;
    sort: PlaceSort;
    token: number;
    through: readonly unknown[];
  } | null = null;
  function letGoSettling() {
    if (!settling) return;
    void queryClient.cancelQueries({ queryKey: settling.through, exact: true });
    settling = null;
  }

  function syncResults() {
    if (!listMode.value) {
      letGoSettling();
      settled.value = null;
      return;
    }
    const key = resultsKey.value;
    const s = sortNow.value;
    const pages = resultsQuery.data.value?.pages as ResultsPage[] | undefined;
    const first = pages?.[0];
    if (!pages || !first || first.key !== key || first.sort !== s || tree.shownKey() !== key) {
      return;
    }
    const on = settled.value;
    if (on && on.key === key && on.sort === s) {
      if (on.pages !== pages) settled.value = { ...on, pages };
      return;
    }
    if (settling && settling.key === key && settling.sort === s) return;
    void settle(key, s, pages, on);
  }

  async function settle(
    key: string,
    s: PlaceSort,
    pages: readonly ResultsPage[],
    before: ShownResults | null,
  ) {
    letGoSettling();
    const token = ++settleTokens;
    const target = readTarget(pages, before, before ? openId.value : null);
    let unknown: string | null = null;
    if (target) {
      settling = {
        key,
        sort: s,
        token,
        through: placesKeys.through(key, s, target, RESULTS_LIMIT),
      };
      const answer = await readThrough(key, s, target);
      if (settling?.token !== token) return; // another answer took over
      settling = null;
      if (answer === "failed" && target === openId.value) unknown = target;
    }
    if (!listMode.value || resultsKey.value !== key || sortNow.value !== s) return;
    if (tree.shownKey() !== key) return;
    const now = queryClient.getQueryData<ResultsData>(resultsQueryKey(key, s))?.pages ?? pages;
    settled.value = { key, sort: s, pages: now, unknown };
  }

  watch(
    [() => resultsQuery.data.value, resultsKey, sortNow, () => tree.shownKey(), listMode],
    syncResults,
  );

  /** The key's results could not be had (its tree on screen, or nothing
   *  shown before): the panel's error line, not the previous ones. */
  const resultsFailed = computed(
    () =>
      listMode.value &&
      resultsAsked.value !== null &&
      resultsQuery.isError.value &&
      !resultsQuery.data.value &&
      (tree.shownKey() === resultsKey.value || !settled.value),
  );
  watch(resultsFailed, (failed) => {
    if (!failed) return;
    letGoSettling();
    settled.value = null;
  });

  const shownResults = computed<ShownResults | null>(() =>
    resultsFailed.value ? null : settled.value,
  );

  /** The results on screen, every page loaded, each audition once. */
  const resultRows = computed<PlaceResultRow[]>(() => {
    const shown = shownResults.value;
    return shown ? rowsOf(shown.pages) : [];
  });

  /** The results' totals (their first page's). */
  const resultsTotal = computed(() => shownResults.value?.pages[0].total ?? null);

  /** The frame of every result's lieu (the server's resultBounds). */
  function resultsFrame(): Bounds | null {
    const f = shownResults.value?.pages[0].frame;
    return f ? { minLat: f[0], maxLat: f[2], minLng: f[1], maxLng: f[3] } : null;
  }

  /** A new list, not a page appended to it (resultsPages' orderSig). */
  const resultsSig = computed(() => {
    const first = shownResults.value?.pages[0];
    return first ? orderSig(first) : "";
  });
  /** Which auditions match, whatever their order (resultsPages' setSig). */
  const resultSetSig = computed(() => {
    const first = shownResults.value?.pages[0];
    return first ? setSig(first) : "";
  });

  /** The results on screen are the ones wanted (not the previous key's). */
  const resultsCurrent = computed(() => {
    const s = shownResults.value;
    return !!s && s.key === resultsKey.value && s.sort === sortNow.value;
  });
  const moreResults = computed(() => {
    const pages = shownResults.value?.pages;
    return resultsCurrent.value && !!pages?.[pages.length - 1].next;
  });
  function loadMoreResults() {
    if (!moreResults.value || resultsQuery.isFetchingNextPage.value) return;
    void resultsQuery.fetchNextPage({ cancelRefetch: false });
  }

  /** Filters on, the tree not failed, and nothing to show yet. */
  const resultsLoading = computed(
    () => listMode.value && !shownResults.value && !resultsFailed.value && !tree.failed(),
  );

  /** The audition being read, whether it still matches unknown (its read failed). */
  function unknownOpen(): string | null {
    return shownResults.value?.unknown ?? null;
  }

  /**
   * The results on screen read as far as this audition (through=), the rows
   * beyond those loaded appended. Resolves whether it is among them now —
   * "failed": the server could not say.
   */
  async function loadThrough(id: string): Promise<ThroughAnswer> {
    const shown = shownResults.value;
    if (!shown || !resultsCurrent.value) return "failed";
    if (resultRows.value.some((a) => a.id === id)) return "found";
    if (!shown.pages[shown.pages.length - 1].next) return "absent";
    const answer = await readThrough(shown.key, shown.sort, id);
    if (answer !== "found") return answer;
    return (await until(() => resultRows.value.some((a) => a.id === id))) ? "found" : "failed";
  }

  // ---- A lieu's auditions ----------------------------------------------------------

  async function lieuAuditions(
    id: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<LieuAuditions> {
    return { ...(await fetchLieuAuditions(id, paramsOf(key), signal)), id, key };
  }

  /**
   * The first of a lieu's results (its own auditions in the results' order:
   * by date, then id), asked of the server — a lieu further down the results
   * than the pages loaded. null: none, or the server could not say.
   */
  async function firstAuditionAt(lieuId: string): Promise<string | null> {
    const shown = shownResults.value;
    if (!shown) return null;
    try {
      const d = await queryClient.fetchQuery({
        queryKey: placesKeys.lieu(lieuId, shown.key),
        queryFn: ({ signal }) => lieuAuditions(lieuId, shown.key, signal),
        staleTime: STALE_MS,
        retry: retryRefused,
        retryDelay,
      });
      return [...d.auditions].sort((a, b) => bySort(a, b, shown.sort))[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  const openLieu = computed(() => {
    const u = selectedPlace.value;
    return u?.levelKey === "place" ? u : null;
  });
  /** The open lieu's row in the tree on screen. */
  const lieuRow = computed(() => {
    const id = openLieu.value?.id;
    return id ? (tree.data()?.lieux.get(id) ?? null) : null;
  });
  /** The open lieu's auditions are asked for: none embedded (the lazy path). */
  const lieuWanted = computed(() => {
    const u = openLieu.value;
    const key = tree.shownKey();
    if (listMode.value || !u || key === null || lieuRow.value?.list) return null;
    return { id: u.id, key };
  });
  const lieuQuery = useQuery({
    queryKey: computed(() =>
      placesKeys.lieu(lieuWanted.value?.id ?? "", lieuWanted.value?.key ?? ""),
    ),
    enabled: computed(() => lieuWanted.value !== null),
    queryFn: ({ queryKey, signal }) => lieuAuditions(queryKey[2], queryKey[3], signal),
    staleTime: STALE_MS,
    retry: retryRefused,
    retryDelay,
    shallow: true,
  });

  /** The open lieu's auditions (newest first, as the server sends them). */
  const placeList = computed<{ rows: ListedAudition[]; loading: boolean; failed: boolean }>(() => {
    const u = openLieu.value;
    if (!u) return { rows: [], loading: false, failed: false };
    const list = lieuRow.value?.list;
    if (list) {
      const rows = list.map(([id, title, date, n]) => ({ id, title, date, n }));
      return { rows, loading: false, failed: false };
    }
    const d = lieuQuery.data.value;
    if (d && d.id === u.id && d.key === tree.shownKey()) {
      return { rows: d.auditions, loading: false, failed: false };
    }
    const failed = lieuQuery.isError.value;
    return { rows: [], loading: !failed, failed };
  });

  // ---- An audition's testimonies ------------------------------------------------

  /** The filter key of the lists on screen: the results', or the tree's. */
  const listedKey = computed(() =>
    listMode.value ? (shownResults.value?.key ?? null) : tree.shownKey(),
  );
  /** Content filter keys' parameters (verified, themes, text), as asked. */
  const contentParams = new Map<string, Record<string, string>>();
  /** The content filters (verified, themes, text) of the lists on screen. */
  const contentKey = computed<string | null>(() => {
    const key = listedKey.value;
    const params = key !== null ? tree.paramsOf(key) : null;
    if (!params) return null;
    const c = contentOf(params);
    contentParams.set(c.key, c.params);
    return c.key;
  });

  async function testimoniesPage(ctx: {
    queryKey: readonly unknown[];
    pageParam: TestimonyPageCursor | null;
    signal?: AbortSignal;
  }): Promise<TestimoniesPage> {
    const audition = ctx.queryKey[2] as string;
    const content = ctx.queryKey[3] as string;
    const params = contentParams.get(content);
    if (!params) throw new Error(`No content filters held for "${content}".`);
    const page = await fetchTestimonyPage(audition, params, ctx.pageParam, ctx.signal);
    return { ...page, audition, contentKey: content };
  }
  const nextTestimonies = (last: TestimoniesPage) => last.next ?? undefined;

  const testimoniesQuery = useInfiniteQuery({
    queryKey: computed(() => placesKeys.testimonies(openId.value ?? "", contentKey.value ?? "")),
    enabled: computed(() => openId.value !== null && contentKey.value !== null),
    queryFn: testimoniesPage,
    initialPageParam: null as TestimonyPageCursor | null,
    getNextPageParam: nextTestimonies,
    // The same audition under new filters: its testimonies stay until the
    // new ones are in (D6).
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    retry: retryRefused,
    retryDelay,
    shallow: true,
  });

  /** The panel's testimonies: the API's rows as the corpus' (no audition:
   *  the panel never shows it), one array per pages loaded. */
  const asPublic = new WeakMap<readonly TestimoniesPage[], PublicTestimony[]>();
  function publicOf(pages: readonly TestimoniesPage[]): PublicTestimony[] {
    let out = asPublic.get(pages);
    if (!out) {
      out = pages.flatMap((p) =>
        p.testimonies.map((t) => ({
          id: t.id,
          person_name: t.person_name,
          person_info: t.person_info,
          content: t.content,
          topics: t.topics,
          verification_status: t.verification_status,
          created_at: t.created_at,
          audition: null,
        })),
      );
      asPublic.set(pages, out);
    }
    return out;
  }

  /** An audition's testimonies: the open one's, once here. */
  function testimoniesFor(id: string): ListedTestimonies {
    if (id !== openId.value) return NOT_HERE;
    const pages = testimoniesQuery.data.value?.pages;
    if (pages?.[0]?.audition === id) {
      return { list: publicOf(pages), more: testimoniesQuery.hasNextPage.value, failed: false };
    }
    return testimoniesQuery.isError.value ? { list: [], more: false, failed: true } : NOT_HERE;
  }

  /** How many of the open audition's testimonies are in (a page came). */
  const openTestimonies = computed(() => {
    const pages = testimoniesQuery.data.value?.pages;
    return pages ? pages.reduce((n, p) => n + p.testimonies.length, 0) : 0;
  });

  function loadMoreTestimonies() {
    if (!testimoniesQuery.hasNextPage.value || testimoniesQuery.isFetchingNextPage.value) return;
    if (testimoniesQuery.isPlaceholderData.value) return;
    void testimoniesQuery.fetchNextPage({ cancelRefetch: false });
  }

  // The first page of the open lieu's first auditions, asked for ahead:
  // opening one is then as quick as today (D10). Those still on their way
  // when the lieu (or its filters) changes are let go — not the one being read.
  const prefetchSig = computed(() => {
    const c = contentKey.value;
    if (listMode.value || c === null || !placeList.value.rows.length) return "";
    return [c, ...placeList.value.rows.map((r) => r.id)].join("\n");
  });
  let prefetched: { content: string; ids: string[] } | null = null;
  watch(prefetchSig, (sig) => {
    const content = contentKey.value;
    const ids =
      sig && content !== null
        ? [...placeList.value.rows]
            .sort((a, b) => bySort(a, b, sort.value))
            .slice(0, PREFETCH_MAX)
            .map((r) => r.id)
        : [];
    if (prefetched) {
      for (const id of prefetched.ids) {
        if (id === openId.value || (prefetched.content === content && ids.includes(id))) continue;
        void queryClient.cancelQueries({
          queryKey: placesKeys.testimonies(id, prefetched.content),
          exact: true,
        });
      }
    }
    prefetched = content !== null && ids.length ? { content, ids } : null;
    for (const id of ids) {
      void queryClient.prefetchInfiniteQuery({
        queryKey: placesKeys.testimonies(id, content!),
        queryFn: testimoniesPage,
        initialPageParam: null as TestimonyPageCursor | null,
        getNextPageParam: nextTestimonies,
        staleTime: STALE_MS,
        retry: false,
      });
    }
  });

  // What failed is asked for again at the next scope change, as the tree's
  // units are.
  watch(
    () => currentScope.value.id,
    () => {
      if (resultsFailed.value) void resultsQuery.refetch();
      if (placeList.value.failed) void lieuQuery.refetch();
    },
  );

  // ---- The tree ---------------------------------------------------------------------

  /**
   * A result's lieu, into the tree on screen until its own row comes (the
   * lazy path): its testimonies as far as the results loaded know them. Only
   * for a row of the key the tree shows — the previous key's rows, still on
   * screen over a new tree, may match nothing there. Whether it went in.
   */
  function addStub(lieu: PlaceResultLieu): boolean {
    const shown = shownResults.value;
    if (!shown || shown.key !== tree.shownKey()) return false;
    const n = resultRows.value.reduce((s, a) => (a.lieu.id === lieu.id ? s + a.n : s), 0);
    return tree.addStub({ ...lieu, n });
  }

  // The open lieu goes along when the tree on screen changes (a filter
  // removed, the lazy path): selected, it stays so until the new tree says.
  tree.setCarry(() => selectedPlaceId.value);
  onScopeDispose(() => tree.setCarry(null));

  /** For the testing tools' probe. */
  function stats() {
    const shown = shownResults.value;
    return {
      results: shown
        ? {
            key: shown.key,
            sort: shown.sort,
            pages: shown.pages.length,
            rows: resultRows.value.length,
            total: shown.pages[0].total ?? null,
            frame: shown.pages[0].frame ?? null,
            current: resultsCurrent.value,
            more: moreResults.value,
            unknown: shown.unknown,
            ids: resultRows.value.map((a) => a.id),
          }
        : null,
      failed: resultsFailed.value,
      settling: settling ? { key: settling.key, sort: settling.sort } : null,
      limit: RESULTS_LIMIT,
      lieu: openLieu.value
        ? {
            id: openLieu.value.id,
            embedded: !!lieuRow.value?.list,
            rows: placeList.value.rows.length,
            loading: placeList.value.loading,
            failed: placeList.value.failed,
          }
        : null,
      open: openId.value,
      contentKey: contentKey.value,
    };
  }

  return {
    resultRows,
    resultsTotal,
    resultsFrame,
    resultsSig,
    resultSetSig,
    resultsCurrent,
    moreResults,
    loadMoreResults,
    resultsLoading,
    resultsFailed,
    unknownOpen,
    loadThrough,
    firstAuditionAt,
    placeList,
    testimoniesFor,
    openTestimonies,
    loadMoreTestimonies,
    addStub,
    stats,
  };
}

export type ServerLists = ReturnType<typeof useServerLists>;
