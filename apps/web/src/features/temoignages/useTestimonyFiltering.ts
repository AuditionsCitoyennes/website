import { computed, ref, type Ref } from "vue";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import {
  buildLocationTree,
  buildTopicOptions,
  dateBoundsOf,
  passesContent as testimonyPasses,
  passesDate as dateIn,
  passesLocation as areaIn,
  useFilters,
} from "@/features/filters";

// ---- Filter state (the page owns it: one filtered set drives BOTH the map
// pins/counts and the testimonies panel) --------------------------------------

export function useTestimonyFiltering(input: {
  /** The home page's card rather than the page: no filters, and the corpus
   *  is not fetched for it. */
  preview: () => boolean;
  /** The corpus, as its query holds it: undefined until it has arrived. */
  testimonies: Ref<PublicTestimony[] | undefined>;
  ownGroups: Ref<LocationGroup[]>;
}) {
  const { preview, testimonies, ownGroups } = input;

  const allTestimonies = computed(() => testimonies.value ?? []);

  // The place picker: every lieu that has something, weighted by its testimonies.
  const locationTree = computed(() =>
    buildLocationTree(ownGroups.value.map((g) => ({ area: g, weight: g.totalTestimonies }))),
  );

  const filters = useFilters(locationTree);
  const { topics, locations, dateFrom, dateTo, verified, needle } = filters;
  const filtersOpen = ref(false);

  function passesLocation(g: LocationGroup): boolean {
    return areaIn(g, locations.value);
  }

  function passesDate(date: string | null | undefined): boolean {
    return dateIn(date, dateFrom.value, dateTo.value);
  }

  /** Content filters can only be judged on testimonies we actually hold. */
  function passesContent(t: PublicTestimony): boolean {
    return testimonyPasses(t, {
      verified: verified.value,
      topics: topics.value,
      needle: needle.value,
    });
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
      return g ? passesLocation(g) : !locations.value.length;
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

  const resultCount = computed(() => (preview() ? 0 : filteredTestimonies.value.length));

  // ---- Filter option sources ---------------------------------------------------
  // Earliest/latest audition date present — the picker is bounded by these so a
  // range that can only ever return nothing is not offered in the first place.
  const dateBounds = computed(() =>
    dateBoundsOf(ownGroups.value.flatMap((g) => g.auditions.map((a) => a.date))),
  );

  const topicOptions = computed(() => buildTopicOptions(allTestimonies.value.map((t) => t.topics)));

  return {
    ...filters,
    filtersOpen,
    filteredTestimonies,
    groups,
    resultCount,
    locationTree,
    dateBounds,
    topicOptions,
  };
}
