import { computed, ref, type Ref } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { answersText } from "@ac/shared";
import { api } from "@/shared/api/client";
import { useAuthStore } from "@/features/auth";
import {
  buildLocationTree,
  buildTopicOptions,
  dateBoundsOf,
  fold,
  passesContent,
  passesDate,
  passesLocation,
  useFilters,
  type TestimonyContent,
} from "@/features/filters";
import type { AdminAudition } from "./useAdminAuditions";

/** A testimony as the filters judge it (see /api/testimonies/admin/filterable). */
interface FilterableTestimony extends TestimonyContent {
  audition_id: string;
}

const FILTERABLE_KEY = ["admin", "filterable-testimonies"];

/**
 * The filters of the Témoignages map, applied to the admin list's auditions.
 * Place, dates, themes, verified only, free text and order. Place and dates are
 * the audition's own; themes, "verified" and the text are judged on its
 * testimonies — an audition passes when one of them does (the free text may
 * also be found in the audition's title, place or context).
 *
 * `auditions`: every audition the list holds, judged once per change;
 * `reachableAuditions`: those the signed-in admin may open — what the options
 * offered and the result count are drawn from.
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

  // What the testimonies are judged on is only fetched when it is needed: while
  // the filters are open, or while a filter judged on testimonies is on. Most
  // visits to this page never filter — and neither switching tabs nor editing an
  // audition re-downloads it.
  const queryClient = useQueryClient();
  const testimonyFilterOn = computed(
    () => verified.value || topics.value.length > 0 || Boolean(needle.value),
  );
  const filterableQuery = useQuery({
    queryKey: computed(() => [...FILTERABLE_KEY, auth.user?.id ?? null]),
    queryFn: () => api.get<FilterableTestimony[]>("/api/testimonies/admin/filterable", true),
    enabled: computed(() => filtersOpen.value || testimonyFilterOn.value),
    staleTime: 5 * 60_000,
    // Fetched once per change, not walked through its text by Vue on each read.
    shallow: true,
  });
  function openFilters() {
    filtersOpen.value = true;
    // A first load that failed is tried again (an enabled query would not be).
    if (filterableQuery.isError.value && !filterableQuery.data.value)
      void filterableQuery.refetch();
  }
  /** Testimonies were added, changed, analysed or removed: what is filtered on
   *  is stale. Fetched again at once only if it is in use; else when it next is. */
  function refreshFilterable() {
    void queryClient.invalidateQueries({ queryKey: FILTERABLE_KEY });
  }
  /** They could not be fetched (and none are at hand). */
  const filterableFailed = computed(
    () => filterableQuery.isError.value && !filterableQuery.data.value,
  );

  // Each audition's testimonies, with the text the free search looks in folded
  // once — not on every keystroke.
  const testimoniesByAudition = computed(() => {
    const byAudition = new Map<string, { t: FilterableTestimony; hay: string }[]>();
    for (const t of filterableQuery.data.value ?? []) {
      // The witness's words only: not the questions of a testimony sent online.
      const entry = {
        t,
        hay: fold(`${t.person_name} ${t.person_info ?? ""} ${answersText(t.content)}`),
      };
      const list = byAudition.get(t.audition_id);
      if (list) list.push(entry);
      else byAudition.set(t.audition_id, [entry]);
    }
    return byAudition;
  });

  const topicOptions = computed(() => {
    const reachable = new Set(reachableAuditions.value.map((a) => a.id));
    return buildTopicOptions(
      (filterableQuery.data.value ?? [])
        .filter((t) => reachable.has(t.audition_id))
        .map((t) => t.topics),
    );
  });
  const dateBounds = computed(() => dateBoundsOf(reachableAuditions.value.map((a) => a.date)));

  /** A filter on the testimonies is on, and they are on their way. */
  const waitingForTestimonies = computed(
    () => testimonyFilterOn.value && !filterableQuery.data.value && !filterableFailed.value,
  );

  function passes(a: AdminAudition): boolean {
    if (!passesDate(a.date, dateFrom.value, dateTo.value)) return false;
    if (!passesLocation(a.area ?? null, locations.value)) return false;
    const onTestimonies = verified.value || topics.value.length > 0;
    if (!onTestimonies && !needle.value) return true;
    const textInAudition =
      Boolean(needle.value) && fold(`${a.title} ${a.location} ${a.content}`).includes(needle.value);
    const textIn = (hay: string) => !needle.value || textInAudition || hay.includes(needle.value);
    const own = testimoniesByAudition.value.get(a.id) ?? [];
    if (!onTestimonies) return textInAudition || own.some((e) => textIn(e.hay));
    // The text was looked for above, once per testimony: not again inside.
    const others = { verified: verified.value, topics: topics.value, needle: "" };
    return own.some((e) => passesContent(e.t, others) && textIn(e.hay));
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
    // The testimonies the filters are judged on.
    filterableQuery,
    filterableFailed,
    refreshFilterable,
    testimonyFilterOn,
    waitingForTestimonies,
    // What passes.
    filterOn,
    shown,
    resultCount,
  };
}
