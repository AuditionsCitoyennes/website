import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { AdminAuditionFilter } from "@ac/shared";
import { api } from "@/shared/api/client";
import { useAuthStore } from "@/features/auth";
import {
  buildLocationTree,
  dateBoundsOf,
  passesDate,
  passesLocation,
  TEXT_DEBOUNCE_MS,
  topicOptionsOf,
  useFilters,
} from "@/features/filters";
import {
  contentAskOf,
  contentOn,
  haysOf,
  passesContentMatches,
  textCountsOf,
  themeCountsOf,
  type ContentAsk,
  type ContentMatches,
  type FilterableTestimony,
} from "./contentMatches";
import type { AdminAudition } from "./useAdminAuditions";

const MATCHES_KEY = ["admin", "audition-filter"] as const;
const FILTERABLE_KEY = ["admin", "filterable-testimonies"] as const;

/** A server's answer, and the admin it was given to. */
type Answer = ContentMatches & { user: string | null };

/**
 * The filters of the Témoignages map, applied to the admin list's auditions.
 * Place, dates, themes, verified only, free text and order. Place and dates are
 * the audition's own; themes, "verified" and the text are judged on its
 * testimonies — an audition passes when one of them does (the free text may
 * also be found in the audition's title, place or context). The testimonies
 * are judged by the server (/api/auditions/admin/filter, contentMatches.ts),
 * the text 300 ms after the last keystroke; the list stays as it was until
 * its answer is in. A text longer than the server searches is looked for here,
 * in every testimony (/api/testimonies/admin/filterable, until PR Q).
 *
 * `auditions`: every audition the list holds, judged once per change;
 * `reachableAuditions`: those the signed-in admin may open — what the place
 * and date options and the result count are drawn from (the server counts
 * the themes over the same auditions).
 */
export function useAuditionFilters(
  auditions: Ref<AdminAudition[]>,
  reachableAuditions: Ref<AdminAudition[]>,
) {
  const auth = useAuthStore();

  const locationTree = computed(() =>
    buildLocationTree(
      reachableAuditions.value.flatMap((a) => (a.area ? [{ area: a.area, weight: 1 }] : [])),
    ),
  );
  const {
    text,
    topics,
    locations,
    dateFrom,
    dateTo,
    verified,
    sort,
    needle,
    chips,
    removeChip,
    reset: resetFilters,
  } = useFilters(locationTree);
  const filtersOpen = ref(false);
  const filterOn = computed(() => chips.value.length > 0);

  // The text, once typing has paused: each change is a round trip. Emptied at
  // once (a chip taken off).
  const typed = ref(text.value);
  let typing: ReturnType<typeof setTimeout> | undefined;
  watch(text, (next) => {
    clearTimeout(typing);
    if (!next.trim()) {
      typed.value = next;
      return;
    }
    typing = setTimeout(() => (typed.value = next), TEXT_DEBOUNCE_MS);
  });
  onScopeDispose(() => clearTimeout(typing));

  /** The content filters as the server is asked them. */
  const ask = computed(() =>
    contentAskOf({ verified: verified.value, topics: topics.value, text: typed.value }),
  );

  // What the server says of the testimonies is only asked for when it is
  // needed: while the filters are open (the themes offered), or while a filter
  // judged on testimonies is on. Most visits to this page never filter — and
  // neither switching tabs nor editing an audition asks again.
  const queryClient = useQueryClient();
  const testimonyFilterOn = computed(
    () => verified.value || topics.value.length > 0 || Boolean(needle.value),
  );
  const matchesQuery = useQuery({
    queryKey: computed(() => [...MATCHES_KEY, auth.user?.id ?? null, ask.value] as const),
    queryFn: async ({ queryKey, signal }): Promise<Answer> => {
      const asked = queryKey[3];
      const qs = new URLSearchParams(asked.params).toString();
      const answer = await api.get<AdminAuditionFilter>(
        `/api/auditions/admin/filter${qs ? `?${qs}` : ""}`,
        true,
        signal,
      );
      return { ...answer, ask: asked, user: queryKey[2] };
    },
    enabled: computed(() => filtersOpen.value || contentOn(ask.value)),
    staleTime: 5 * 60_000,
    // The answer before stays on screen until the next one is in.
    placeholderData: keepPreviousData,
    shallow: true,
  });
  // A text longer than the server searches: every testimony, to look for it
  // in (as the list always did), fetched only while such a text is asked.
  const filterableQuery = useQuery({
    queryKey: computed(() => [...FILTERABLE_KEY, auth.user?.id ?? null]),
    queryFn: ({ signal }) =>
      api.get<FilterableTestimony[]>("/api/testimonies/admin/filterable", true, signal),
    enabled: computed(() => ask.value.textUnsent),
    staleTime: 5 * 60_000,
    shallow: true,
  });
  /** Its testimonies, each with the text searched in folded once. */
  const hays = computed(() => {
    const rows = filterableQuery.data.value;
    return rows ? haysOf(rows) : null;
  });
  function openFilters() {
    filtersOpen.value = true;
    // A first load that failed is tried again (an enabled query would not be).
    if (matchesQuery.isError.value && !matchesQuery.data.value) void matchesQuery.refetch();
  }
  /** The error line's "Réessayer": what failed is asked again. */
  function retryMatches() {
    if (matchesQuery.isError.value) void matchesQuery.refetch();
    if (ask.value.textUnsent && filterableQuery.isError.value) void filterableQuery.refetch();
  }
  /** Testimonies were added, changed, analysed or removed, or an audition
   *  deleted: what the server said is stale. Asked again at once only if it is
   *  in use; else when it next is. */
  function refreshMatches() {
    void queryClient.invalidateQueries({ queryKey: MATCHES_KEY });
    void queryClient.invalidateQueries({ queryKey: FILTERABLE_KEY });
  }
  /** The server could not say (and nothing it said is at hand). */
  const matchesFailed = computed(
    () =>
      (matchesQuery.isError.value && !matchesQuery.data.value) ||
      (ask.value.textUnsent && filterableQuery.isError.value && !filterableQuery.data.value),
  );

  /** What the list is judged by: the answer on screen (the one asked for, or
   *  the one before while it comes) with what it was asked; none at hand, the
   *  filters asked and no testimony passing them. */
  const judged = computed<{
    ask: ContentAsk;
    matches: AdminAuditionFilter["matches"] | null;
    textCounts: Map<string, number> | null;
  }>(() => {
    const m = matchesQuery.data.value;
    if (!contentOn(ask.value) || !m) return { ask: ask.value, matches: null, textCounts: null };
    const h = m.ask.textUnsent ? hays.value : null;
    return { ask: m.ask, matches: m.matches, textCounts: h ? textCountsOf(h, m.ask) : null };
  });

  // The theme counts do not depend on the filters: the last answer's stay
  // through a failed one (the admin's own).
  const themeCounts = shallowRef<{ user: string | null; themes: number[] } | null>(null);
  watch(
    () => matchesQuery.data.value,
    (m) => {
      if (m) themeCounts.value = { user: m.user, themes: m.themes };
    },
    { immediate: true },
  );
  const topicOptions = computed(() => {
    const kept = themeCounts.value;
    const mine = kept && kept.user === (auth.user?.id ?? null);
    return topicOptionsOf(themeCountsOf(mine ? kept.themes : []));
  });
  const dateBounds = computed(() => dateBoundsOf(reachableAuditions.value.map((a) => a.date)));

  /** A filter on the testimonies is asked for, and nothing the server said is
   *  at hand yet (nor, for a text longer than it searches, the testimonies). */
  const waitingForTestimonies = computed(
    () =>
      contentOn(ask.value) &&
      (!matchesQuery.data.value || (ask.value.textUnsent && !hays.value)) &&
      !matchesFailed.value,
  );

  function passes(a: AdminAudition): boolean {
    if (!passesDate(a.date, dateFrom.value, dateTo.value)) return false;
    if (!passesLocation(a.area ?? null, locations.value)) return false;
    const { ask: asked, matches, textCounts } = judged.value;
    return passesContentMatches(a, asked, matches, textCounts);
  }

  /** Newest first, or oldest first; undated last either way. */
  function bySort(a: AdminAudition, b: AdminAudition): number {
    if (!a.date !== !b.date) return a.date ? -1 : 1;
    const cmp = (a.date ?? "").localeCompare(b.date ?? "");
    return sort.value === "ancien" ? cmp : -cmp;
  }
  // Judged once per change of the filters (or of the data), for every list
  // and count that shows them.
  const passingIds = computed(() =>
    filterOn.value ? new Set(auditions.value.filter(passes).map((a) => a.id)) : null,
  );
  /** `list`, filtered and in the order asked for. */
  function shown(list: AdminAudition[]): AdminAudition[] {
    const ids = passingIds.value;
    return (ids ? list.filter((a) => ids.has(a.id)) : [...list]).sort(bySort);
  }
  const resultCount = computed(() => shown(reachableAuditions.value).length);

  return {
    // The values picked, their chips, and the ways to take them off.
    text,
    topics,
    locations,
    dateFrom,
    dateTo,
    verified,
    sort,
    chips,
    removeChip,
    resetFilters,
    // The dialog, and what it offers.
    filtersOpen,
    openFilters,
    locationTree,
    topicOptions,
    dateBounds,
    // What the server says of the testimonies.
    matchesFailed,
    retryMatches,
    refreshMatches,
    testimonyFilterOn,
    waitingForTestimonies,
    // What passes.
    filterOn,
    shown,
    resultCount,
  };
}
