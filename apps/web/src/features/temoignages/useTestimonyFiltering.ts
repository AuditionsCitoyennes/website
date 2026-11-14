import { computed, getCurrentScope, markRaw, onScopeDispose, ref, watch, type Ref } from "vue";
import { useQuery, type QueryClient } from "@tanstack/vue-query";
import {
  AUDITION_THEMES,
  fold,
  type LocationGroup,
  type PlaceFacets,
  type PublicTestimony,
} from "@ac/shared";
import {
  buildLocationTree,
  buildPlaceTree,
  buildTopicOptions,
  dateBoundsOf,
  passesContent as testimonyPasses,
  passesDate as dateIn,
  passesLocation as areaIn,
  passesPlaceIds,
  topicOptionsOf,
  useFilters,
  useServerFilters,
} from "@/features/filters";
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
import type { PlaceTreeMode } from "./dataSource";

// ---- Filter state (the page owns it: one filtered set drives BOTH the map
// pins/counts and the testimonies panel) --------------------------------------

/** The server's tree is the source (map phase 1: "serveur", "comparer"). */
export interface ServerSource {
  queryClient: QueryClient;
  /** "Arbre des lieux" (DEV): the arrondissements kept in the place picker. */
  placeTreeMode: Ref<PlaceTreeMode>;
  /** The comparer runs: the place picker's tree is wanted at once. */
  comparing: boolean;
}

export function useTestimonyFiltering(input: {
  /** The home page's card rather than the page: no filters, and the corpus
   *  is not fetched for it. */
  preview: () => boolean;
  /** The corpus, as its query holds it: undefined until it has arrived. */
  testimonies: Ref<PublicTestimony[] | undefined>;
  ownGroups: Ref<LocationGroup[]>;
  /**
   * The server's tree is the source: the map's units and counts, the result
   * count, the theme counts, the date bounds and the place picker come from
   * the place reads (a filter applies once its key's answer is in, the text
   * 300 ms after the last keystroke); the corpus, filtered the same way,
   * still feeds the auditions' lists.
   */
  server?: ServerSource;
}) {
  const { preview, testimonies, ownGroups, server } = input;

  const allTestimonies = computed(() => testimonies.value ?? []);

  // The place picker: every lieu that has something, weighted by its testimonies.
  const corpusLocationTree = computed(() =>
    buildLocationTree(ownGroups.value.map((g) => ({ area: g, weight: g.totalTestimonies }))),
  );
  // From the server: every audition on the map (empty=1), by unit and lieu ids.
  // On the lazy path (a tree too big for one answer), a place opened in the
  // picker asks for its children; a whole tree (production's) asks for nothing.
  let unitTree: UnitTree | null = null;
  const serverLocationTree = computed(() => {
    const tree = unitTree;
    const data = tree?.emptyData();
    return tree && data
      ? buildPlaceTree(data, {
          arrondissements: server?.placeTreeMode.value === "avec",
          statusOf: (id) => tree.emptyStatus(id),
        })
      : [];
  });
  const locationTree = server ? serverLocationTree : corpusLocationTree;

  const filters = useFilters(locationTree);
  const { topics, locations, dateFrom, dateTo, verified, needle, chips } = filters;
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
  const loadLocationChildren = server
    ? (node: LocNode) => {
        if (filtersOpen.value) unitTree?.loadEmpty([node.token]);
      }
    : undefined;

  // ---- The server's filters and tree -------------------------------------------
  const serverFilters = server ? useServerFilters(filters) : null;
  if (server && serverFilters) {
    const sf = serverFilters;
    unitTree = markRaw(
      useUnitTree({
        queryClient: server.queryClient,
        // The figures only where something reads them: the analyses, the comparer.
        facts: __ANALYSES__ || server.comparing,
        onTextIgnored: (req, minChars) =>
          sf.noteTextIgnored(fold((req.params.q ?? "").trim()), minChars),
      }),
    );
    const tree = unitTree;
    // The card shows every audition on the map; the page, what the filters
    // keep (the previous answer on screen until the next one is in).
    watch(
      () => (preview() ? EMPTY_KEY : sf.key.value),
      (key) => tree.request({ key, params: key === EMPTY_KEY ? {} : sf.params.value }),
      { immediate: true },
    );
    // "repos": the page's own tree on screen, FILTERS_IDLE_MS later the
    // browser's first idle moment (at most FILTERS_IDLE_CAP_MS more) lets the
    // dialog's data come.
    if (filtersLoad === "repos") {
      let timer = 0;
      let idle = 0;
      const stopWatch = watch(
        () => !preview() && tree.shownKey() !== null,
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
        server.comparing ||
        (!preview() &&
          filtersDataWanted(filtersLoad, {
            opened: dialogOpened.value,
            idle: filtersIdle.value,
            treeShown: tree.shownKey() !== null,
          })) ||
        locations.value.length > 0,
      (want) => {
        if (want) tree.wantEmpty();
      },
      { immediate: true },
    );
    // Closed: the places opened in the picker are not asked for again.
    watch(filtersOpen, (open) => {
      if (open) tree.openEmpty();
      else tree.idleEmpty();
    });
  }

  // What the corpus is filtered with: the page's filters — or, from the server,
  // the ones its tree is asked with (the text debounced, places as ids).
  const effective = computed(() => {
    if (!serverFilters) {
      return {
        verified: verified.value,
        topics: topics.value,
        needle: needle.value,
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
        locations: locations.value,
      };
    }
    const f = serverFilters.filters.value;
    return {
      verified: f.verified,
      topics: f.themes.map((i) => AUDITION_THEMES[i]),
      needle: f.needle,
      dateFrom: f.from,
      dateTo: f.to,
      locations: [...f.units, ...f.lieux],
    };
  });

  function passesLocation(g: LocationGroup): boolean {
    return serverFilters
      ? passesPlaceIds(g, effective.value.locations)
      : areaIn(g, effective.value.locations);
  }

  function passesDate(date: string | null | undefined): boolean {
    return dateIn(date, effective.value.dateFrom, effective.value.dateTo);
  }

  /** Content filters can only be judged on testimonies we actually hold. */
  function passesContent(t: PublicTestimony): boolean {
    const f = effective.value;
    return testimonyPasses(t, { verified: f.verified, topics: f.topics, needle: f.needle });
  }

  const auditionGroup = computed(() => {
    const m = new Map<string, LocationGroup>();
    for (const g of ownGroups.value) for (const a of g.auditions) m.set(a.id, g);
    return m;
  });

  /** Own testimonies surviving every filter (location resolved via their group). */
  const filteredTestimonies = computed(() =>
    allTestimonies.value.filter((t) => {
      if (!t.audition) return false;
      if (!passesContent(t)) return false;
      if (!passesDate(t.audition.date)) return false;
      const g = auditionGroup.value.get(t.audition.id);
      return g ? passesLocation(g) : !effective.value.locations.length;
    }),
  );

  /** Own groups, narrowed to the auditions that still have matching testimonies. */
  const filteredOwnGroups = computed<LocationGroup[]>(() => {
    // Nothing to narrow by on the card (no filters, and the corpus is not
    // fetched for it), nor on the page until the corpus has arrived: the pins
    // as the map serves them, so they do not blink out while the card becomes
    // the page and the corpus loads.
    if (preview() || !testimonies.value) return ownGroups.value;
    const perAudition = new Map<string, number>();
    for (const t of filteredTestimonies.value) {
      const id = t.audition?.id;
      if (id) perAudition.set(id, (perAudition.get(id) ?? 0) + 1);
    }
    const out: LocationGroup[] = [];
    for (const g of ownGroups.value) {
      const auditions = g.auditions.filter((a) => perAudition.has(a.id));
      if (!auditions.length) continue;
      const total = auditions.reduce((s, a) => s + (perAudition.get(a.id) ?? 0), 0);
      out.push({
        ...g,
        auditions: auditions.map((a) => ({ ...a, testimony_count: perAudition.get(a.id) ?? 0 })),
        totalTestimonies: total,
      });
    }
    return out;
  });

  const groups = filteredOwnGroups;

  const corpusResultCount = computed(() => (preview() ? 0 : filteredTestimonies.value.length));

  // ---- Filter option sources ---------------------------------------------------
  // Earliest/latest audition date present — the picker is bounded by these so a
  // range that can only ever return nothing is not offered in the first place.
  const corpusDateBounds = computed(() =>
    dateBoundsOf(ownGroups.value.flatMap((g) => g.auditions.map((a) => a.date))),
  );

  const corpusTopicOptions = computed(() =>
    buildTopicOptions(allTestimonies.value.map((t) => t.topics)),
  );

  // ---- From the server ---------------------------------------------------------
  // Not for the home card (no filters there), as the corpus is not.
  // Retried as the tree's reads are (after Retry-After, or 1, 2, 4 s), and
  // again at the dialog's opening should it have failed.
  const facetsQuery = server
    ? useQuery({
        queryKey: placesKeys.facets(),
        queryFn: ({ signal }) => fetchFacets(signal),
        // The dialog's own data (`ac:filters-load`): from the start under
        // "demarrage", as the place picker's tree otherwise.
        enabled: computed(
          () =>
            !preview() &&
            (filtersLoad === "demarrage" ||
              server.comparing ||
              filtersDataWanted(filtersLoad, {
                opened: dialogOpened.value,
                idle: filtersIdle.value,
                treeShown: unitTree?.shownKey() !== null,
              })),
        ),
        retry: (failures, err) => retryable(err) && failures < RETRIES,
        retryDelay: (failures, err) => retryWait(failures + 1, err),
        shallow: true,
      })
    : null;
  if (facetsQuery) {
    watch(filtersOpen, (open) => {
      if (open && facetsQuery.isError.value) void facetsQuery.refetch();
    });
  }
  const facets = computed<PlaceFacets | null>(() => facetsQuery?.data.value ?? null);

  /** N résultats: the matching testimonies on the map and on no point. */
  const serverResultCount = computed(() => {
    if (preview()) return 0;
    const root = unitTree?.root();
    return root ? root.self.n + (root.unplaced?.n ?? 0) : 0;
  });
  const serverDateBounds = computed(() => {
    const d = facets.value?.dates;
    return d ? { min: d[0], max: d[1] } : { min: null, max: null };
  });
  const serverTopicOptions = computed(() =>
    topicOptionsOf(new Map((facets.value?.themes ?? []).map((t) => [AUDITION_THEMES[t.i], t.n]))),
  );

  const resultCount = server ? serverResultCount : corpusResultCount;
  const dateBounds = server ? serverDateBounds : corpusDateBounds;
  const topicOptions = server ? serverTopicOptions : corpusTopicOptions;

  /** Filters are on: the panel lists the results. The server's: once the
   *  filters' key is (the text debounced, a text too short not counted). */
  const listFiltered = computed(() =>
    serverFilters ? serverFilters.key.value !== "" : chips.value.length > 0,
  );

  /** Under the search field, when the text typed is not searched. */
  const searchHint = computed(() =>
    serverFilters?.textTooShort.value
      ? `Saisissez au moins ${serverFilters.minChars.value} caractères pour lancer la recherche.`
      : null,
  );

  return {
    ...filters,
    filtersOpen,
    filteredTestimonies,
    groups,
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
    corpus: {
      resultCount: corpusResultCount,
      dateBounds: corpusDateBounds,
      topicOptions: corpusTopicOptions,
      locationTree: corpusLocationTree,
    },
  };
}
