// The panel's lists from the server (map phase 1, design E1 (K), A21 D10,
// D13), beside the tree (useUnitTree) they belong to:
//
// - The results (filters on): keyset pages of /api/places/results under the
//   filter key asked of the tree, a page as the reader scrolls. They go on
//   screen with the tree of their key — the previous ones stay meanwhile
//   (D6). Their first page gives the heading's total and the map's frame.
//   The first page of a new key or sort reaches as far as the audition being
//   read (through=): whether it still matches comes with it.
// - The open lieu's auditions: its row's own list when the tree's answer
//   embedded it (a complete answer: production's case, nothing is fetched);
//   else /api/places/lieu, LoadingDots meanwhile (D13).
// - The open audition's testimonies, 50 at a time, oldest first; the first
//   page of the open lieu's auditions asked for ahead (D10).
//
// Every read is a vue-query entry under placesKeys.all (an audition created
// invalidates them all, PR L), tried again after Retry-After when refused.

import { computed, watch, type ComputedRef, type Ref } from "vue";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/vue-query";
import type {
  PlaceResultLieu,
  PlaceResultRow,
  PlaceResultsCursor,
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
  type ResultsPage,
  type TestimoniesPage,
} from "./listsApi";

/** A list's answer is fresh this long (the app's default). */
const STALE_MS = 5 * 60 * 1000;
/** The open lieu's auditions whose first testimony page is asked for ahead. */
const PREFETCH_MAX = 8;

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

interface ShownResults {
  key: string;
  sort: PlaceSort;
  pages: readonly ResultsPage[];
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
  const { openAuditions } = nav;

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

  /** The filter key the results are asked under: the tree's last asked, filters on. */
  const resultsKey = computed<string | null>(() => {
    if (!listMode.value) return null;
    const key = tree.wantedKey();
    return key && key !== EMPTY_KEY ? key : null;
  });

  const resultsQuery = useInfiniteQuery({
    queryKey: computed(() =>
      placesKeys.results(resultsKey.value ?? "", sortNow.value, RESULTS_LIMIT),
    ),
    enabled: computed(() => resultsKey.value !== null),
    queryFn: async ({ queryKey, pageParam, signal }): Promise<ResultsPage> => {
      const key = queryKey[2];
      const sortAsked = queryKey[3] as PlaceSort;
      // A first page reaches as far as the audition being read: whether it
      // still matches the new key or order comes with it (throughFound).
      const through = pageParam === null ? openId.value : null;
      const page = await fetchResults(
        paramsOf(key),
        sortAsked,
        { after: pageParam, through, limit: RESULTS_LIMIT },
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

  // On screen once the tree of their key is (D6: the previous results stay
  // meanwhile, from the same list mode only).
  let lastShown: ShownResults | null = null;
  const shownResults = computed<ShownResults | null>(() => {
    if (!listMode.value) return (lastShown = null);
    const pages = resultsQuery.data.value?.pages;
    const first = pages?.[0];
    if (
      pages &&
      first &&
      first.key === resultsKey.value &&
      first.sort === sortNow.value &&
      first.key === tree.shownKey() &&
      lastShown?.pages !== pages
    ) {
      lastShown = { key: first.key, sort: first.sort, pages };
    }
    return lastShown;
  });

  /** The results on screen, every page loaded, each audition once. */
  const resultRows = computed<PlaceResultRow[]>(() => {
    const shown = shownResults.value;
    if (!shown) return [];
    if (shown.pages.length === 1) return shown.pages[0].auditions;
    const seen = new Set<string>();
    const out: PlaceResultRow[] = [];
    for (const p of shown.pages) {
      for (const a of p.auditions) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        out.push(a);
      }
    }
    return out;
  });

  /** The results' totals (their first page's). */
  const resultsTotal = computed(() => shownResults.value?.pages[0].total ?? null);

  /** The frame of every result's lieu (the server's resultBounds). */
  function resultsFrame(): Bounds | null {
    const f = shownResults.value?.pages[0].frame;
    return f ? { minLat: f[0], maxLat: f[2], minLng: f[1], maxLng: f[3] } : null;
  }

  /** A new answer, not a page appended to it: its key, order and first page. */
  const resultsSig = computed(() => {
    const s = shownResults.value;
    return s ? `${s.key}|${s.sort}|${s.pages[0].auditions.map((a) => a.id).join(",")}` : "";
  });
  /** Which auditions match, whatever their order: its key and totals. */
  const resultSetSig = computed(() => {
    const s = shownResults.value;
    const t = s?.pages[0].total;
    return s ? `${s.key}|${t?.auditions ?? 0}|${t?.n ?? 0}` : "";
  });

  /** The results on screen are the ones asked for (not the previous key's). */
  const resultsCurrent = computed(
    () => !!shownResults.value && shownResults.value.pages === resultsQuery.data.value?.pages,
  );
  const moreResults = computed(() => resultsCurrent.value && resultsQuery.hasNextPage.value);
  function loadMoreResults() {
    if (!moreResults.value || resultsQuery.isFetchingNextPage.value) return;
    void resultsQuery.fetchNextPage({ cancelRefetch: false });
  }

  /** Filters on, the tree not failed, and nothing to show yet. */
  const resultsLoading = computed(
    () => listMode.value && !shownResults.value && !resultsQuery.isError.value && !tree.failed(),
  );
  const resultsFailed = computed(
    () => listMode.value && !shownResults.value && resultsQuery.isError.value,
  );

  /**
   * The results on screen read as far as this audition (through=), the rows
   * beyond those loaded appended as one page. Resolves whether it is among
   * them now.
   */
  async function loadThrough(id: string): Promise<boolean> {
    const shown = shownResults.value;
    if (!shown) return false;
    let page;
    try {
      page = await fetchResults(paramsOf(shown.key), shown.sort, {
        through: id,
        limit: RESULTS_LIMIT,
      });
    } catch {
      return false;
    }
    if (!page.throughFound) return false;
    const queryKey = placesKeys.results(shown.key, shown.sort, RESULTS_LIMIT);
    queryClient.setQueryData<InfiniteData<ResultsPage, PlaceResultsCursor | null>>(
      queryKey,
      (old) => {
        if (!old?.pages.length) return old;
        const loaded = old.pages.flatMap((p) => p.auditions);
        if (page.auditions.length <= loaded.length) return old;
        const tagged: ResultsPage = { ...page, key: shown.key, sort: shown.sort };
        // The rows moved under the pages loaded: the answer up to it stands
        // for them all.
        if (loaded.some((a, i) => page.auditions[i].id !== a.id)) {
          return { pages: [tagged], pageParams: [null] };
        }
        const last = old.pages[old.pages.length - 1];
        const rest: ResultsPage = {
          auditions: page.auditions.slice(loaded.length),
          next: page.next,
          key: shown.key,
          sort: shown.sort,
        };
        return { pages: [...old.pages, rest], pageParams: [...old.pageParams, last.next] };
      },
    );
    return until(() => resultRows.value.some((a) => a.id === id));
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
   * than the pages loaded.
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

  function loadMoreTestimonies() {
    if (!testimoniesQuery.hasNextPage.value || testimoniesQuery.isFetchingNextPage.value) return;
    if (testimoniesQuery.isPlaceholderData.value) return;
    void testimoniesQuery.fetchNextPage({ cancelRefetch: false });
  }

  // The first page of the open lieu's auditions, asked for ahead: opening one
  // is then as quick as today (D10).
  const prefetchSig = computed(() => {
    const c = contentKey.value;
    if (listMode.value || c === null || !placeList.value.rows.length) return "";
    return [c, ...placeList.value.rows.map((r) => r.id)].join("\n");
  });
  watch(prefetchSig, (sig) => {
    const content = contentKey.value;
    if (!sig || content === null) return;
    const rows = [...placeList.value.rows].sort((a, b) => bySort(a, b, sort.value));
    for (const r of rows.slice(0, PREFETCH_MAX)) {
      void queryClient.prefetchInfiniteQuery({
        queryKey: placesKeys.testimonies(r.id, content),
        queryFn: testimoniesPage,
        initialPageParam: null as TestimonyPageCursor | null,
        getNextPageParam: nextTestimonies,
        staleTime: STALE_MS,
        retry: false,
      });
    }
  });

  // ---- The tree ---------------------------------------------------------------------

  /** A result's lieu, into the tree on screen until its own row comes (the
   *  lazy path): its testimonies as far as the results loaded know them. */
  function addStub(lieu: PlaceResultLieu) {
    const n = resultRows.value.reduce((s, a) => (a.lieu.id === lieu.id ? s + a.n : s), 0);
    tree.addStub({ ...lieu, n });
  }

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
          }
        : null,
      limit: RESULTS_LIMIT,
      lieu: openLieu.value
        ? {
            id: openLieu.value.id,
            embedded: !!lieuRow.value?.list,
            rows: placeList.value.rows.length,
            loading: placeList.value.loading,
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
    loadThrough,
    firstAuditionAt,
    placeList,
    testimoniesFor,
    loadMoreTestimonies,
    addStub,
    stats,
  };
}

export type ServerLists = ReturnType<typeof useServerLists>;
