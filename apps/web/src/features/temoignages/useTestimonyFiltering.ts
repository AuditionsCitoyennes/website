import { computed, getCurrentScope, markRaw, onScopeDispose, ref, watch, type Ref } from "vue";
import { useQuery, type QueryClient } from "@tanstack/vue-query";
import { AUDITION_THEMES, fold, type PlaceFacets } from "@ac/shared";
import { buildPlaceTree, topicOptionsOf, useFilters, useServerFilters } from "@/features/filters";
import {
  EMPTY_KEY,
  FILTERS_IDLE_CAP_MS,
  FILTERS_IDLE_MS,
  fetchFacets,
  filtersDataWanted,
  filtersLoad,
  placesKeys,
  retryable,
  retryWait,
  RETRIES,
  useUnitTree,
  type UnitTree,
} from "@/features/geo-nav";
import type { LocNode } from "@/shared/ui/select/treeNode";
import type { PlaceTreeMode } from "./placeTreeSwitch";

// ---- Filter state (the page owns it: one filtered set drives BOTH the map
// pins/counts and the testimonies panel) --------------------------------------
//
// From the server's place reads (map phase 1): the map's units and counts,
// the result count, the theme counts, the date bounds and the place picker (a
// filter applies once its key's answer is in, the text 300 ms after the last
// keystroke); the auditions' lists from the server's lists beside it (GeoNav).

export function useTestimonyFiltering(input: {
  /** The home page's card rather than the page: no filters. */
  preview: () => boolean;
  queryClient: QueryClient;
  /** "Arbre des lieux" (DEV): the arrondissements kept in the place picker. */
  placeTreeMode: Ref<PlaceTreeMode>;
}) {
  const { preview, queryClient, placeTreeMode } = input;

  // Every audition on the map (empty=1), by unit and lieu ids. On the lazy
  // path (a tree too big for one answer), a place opened in the picker asks
  // for its children; a whole tree (production's) asks for nothing. Set just
  // below: the tree is made after the filters it is asked with.
  let tree: UnitTree | null = null;
  const locationTree = computed(() => {
    const t = tree;
    const data = t?.emptyData();
    return t && data
      ? buildPlaceTree(data, {
          arrondissements: placeTreeMode.value === "avec",
          statusOf: (id) => t.emptyStatus(id),
        })
      : [];
  });

  const filters = useFilters(locationTree);
  const { locations } = filters;
  const filtersOpen = ref(false);
  /** The Filtres dialog opened once: its data is wanted from then on. */
  const dialogOpened = ref(false);
  watch(filtersOpen, (open) => {
    if (open) dialogOpened.value = true;
  });
  /** Under `ac:filters-load` "repos": the idle moment after the page's own
   *  tree is on screen passed (FILTERS_IDLE_MS, then an idle callback). */
  const filtersIdle = ref(false);
  // Not once the dialog is closing (a node still open as it fades out).
  const loadLocationChildren = (node: LocNode) => {
    if (filtersOpen.value) tree?.loadEmpty([node.token]);
  };

  // ---- The server's filters and tree -------------------------------------------
  const serverFilters = useServerFilters(filters);
  const sf = serverFilters;
  const unitTree: UnitTree = markRaw(
    useUnitTree({
      queryClient,
      // The figures only where something reads them: the analyses.
      facts: __ANALYSES__,
      onTextIgnored: (req, minChars) =>
        sf.noteTextIgnored(fold((req.params.q ?? "").trim()), minChars),
    }),
  );
  tree = unitTree;
  // The card shows every audition on the map; the page, what the filters
  // keep (the previous answer on screen until the next one is in).
  watch(
    () => (preview() ? EMPTY_KEY : sf.key.value),
    (key) => unitTree.request({ key, params: key === EMPTY_KEY ? {} : sf.params.value }),
    { immediate: true },
  );
  // "repos": the page's own tree on screen, FILTERS_IDLE_MS later the
  // browser's first idle moment (at most FILTERS_IDLE_CAP_MS more) lets the
  // dialog's data come.
  if (filtersLoad === "repos") {
    let timer = 0;
    let idle = 0;
    const stopWatch = watch(
      () => !preview() && unitTree.shownKey() !== null,
      (shown) => {
        if (!shown || timer || filtersIdle.value) return;
        timer = window.setTimeout(() => {
          const done = () => (filtersIdle.value = true);
          if (typeof window.requestIdleCallback === "function")
            idle = window.requestIdleCallback(done, { timeout: FILTERS_IDLE_CAP_MS });
          else done();
        }, FILTERS_IDLE_MS);
      },
      { immediate: true },
    );
    if (getCurrentScope())
      onScopeDispose(() => {
        stopWatch();
        window.clearTimeout(timer);
        if (idle) window.cancelIdleCallback(idle);
      });
  }
  // The place picker's tree: asked for once the page's own tree is on
  // screen (the card's is that tree) and the dialog's data is wanted
  // (`ac:filters-load`, geo-nav/data/bootReadsSwitch: by default at an idle
  // moment after that, or at the dialog's first opening), so that the
  // dialog opens on it, and again at each opening, should it have failed.
  // A place chosen asks for it at once: its chip is named from it.
  watch(
    () =>
      (!preview() &&
        filtersDataWanted(filtersLoad, {
          opened: dialogOpened.value,
          idle: filtersIdle.value,
          treeShown: unitTree.shownKey() !== null,
        })) ||
      locations.value.length > 0,
    (want) => {
      if (want) unitTree.wantEmpty();
    },
    { immediate: true },
  );
  // Closed: the places opened in the picker are not asked for again.
  watch(filtersOpen, (open) => {
    if (open) unitTree.openEmpty();
    else unitTree.idleEmpty();
  });

  // ---- The filters dialog's own data -------------------------------------------
  // Not for the home card (no filters there).
  // Retried as the tree's reads are (after Retry-After, or 1, 2, 4 s), and
  // again at the dialog's opening should it have failed.
  const facetsQuery = useQuery({
    queryKey: placesKeys.facets(),
    queryFn: ({ signal }) => fetchFacets(signal),
    // The dialog's own data (`ac:filters-load`): from the start under
    // "demarrage", as the place picker's tree otherwise.
    enabled: computed(
      () =>
        !preview() &&
        (filtersLoad === "demarrage" ||
          filtersDataWanted(filtersLoad, {
            opened: dialogOpened.value,
            idle: filtersIdle.value,
            treeShown: unitTree.shownKey() !== null,
          })),
    ),
    retry: (failures, err) => retryable(err) && failures < RETRIES,
    retryDelay: (failures, err) => retryWait(failures + 1, err),
    shallow: true,
  });
  watch(filtersOpen, (open) => {
    if (open && facetsQuery.isError.value) void facetsQuery.refetch();
  });
  const facets = computed<PlaceFacets | null>(() => facetsQuery.data.value ?? null);

  /** N résultats: the matching testimonies on the map and on no point. */
  const resultCount = computed(() => {
    if (preview()) return 0;
    const root = unitTree.root();
    return root ? root.self.n + (root.unplaced?.n ?? 0) : 0;
  });
  // Earliest/latest audition date present — the picker is bounded by these so a
  // range that can only ever return nothing is not offered in the first place.
  const dateBounds = computed(() => {
    const d = facets.value?.dates;
    return d ? { min: d[0], max: d[1] } : { min: null, max: null };
  });
  const topicOptions = computed(() =>
    topicOptionsOf(new Map((facets.value?.themes ?? []).map((t) => [AUDITION_THEMES[t.i], t.n]))),
  );

  /** Filters are on: the panel lists the results. Once the filters' key is
   *  (the text debounced, a text too short not counted). */
  const listFiltered = computed(() => serverFilters.key.value !== "");

  /** Under the search field, when the text typed is not searched. */
  const searchHint = computed(() =>
    serverFilters.textTooShort.value
      ? `Saisissez au moins ${serverFilters.minChars.value} caractères pour lancer la recherche.`
      : null,
  );

  return {
    ...filters,
    filtersOpen,
    resultCount,
    locationTree,
    loadLocationChildren,
    dateBounds,
    topicOptions,
    listFiltered,
    searchHint,
    unitTree,
    serverFilters,
    facets,
  };
}
