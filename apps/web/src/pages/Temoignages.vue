<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import { api } from "@/shared/api/client";
import {
  buildLocationTree,
  buildTopicOptions,
  dateBoundsOf,
  passesContent as testimonyPasses,
  passesDate as dateIn,
  passesLocation as areaIn,
} from "@/lib/filters";
import { useFilters } from "@/composables/useFilters";
import GeoNav from "@/components/GeoNav.vue";
import FiltersDialog from "@/components/FiltersDialog.vue";
import FilterChips from "@/components/FilterChips.vue";

// The testimonies map — the page, or (preview) the card on the home page: the
// same instance moves between the two (see MapStage).
const props = defineProps<{ preview?: boolean }>();

const testimoniesQuery = useQuery({
  queryKey: ["testimonies"],
  queryFn: () => api.get<PublicTestimony[]>("/api/testimonies"),
  // Not for the home page's card: it has no filters and no panel, so nothing
  // there reads the corpus — 1.5 MB per visit saved. Fetched once the card
  // becomes the page.
  enabled: computed(() => !props.preview),
  // shallow: vue-query wraps data in reactive()+readonly() by default, so every
  // nested object of these bulk payloads becomes a double Proxy and each read in
  // the hierarchy/mesh hot paths pays a trap. Nothing mutates this data.
  shallow: true,
});

// Imported report TEXT is not loaded here — it is ~3 MB across the corpus and
// only ever shown for one audition at a time, so GeoNav fetches it per audition
// when one is opened (/api/imported-auditions/testimonies?audition=…).
const allTestimonies = computed(() => testimoniesQuery.data.value ?? []);
const loading = computed(() => testimoniesQuery.isLoading.value);
const isError = computed(() => testimoniesQuery.isError.value);

// Map groups are server-side geocoded + cached; poll until the count stabilises
// (the warm pass resolves any not-yet-cached locations).
let mapStableTicks = 0;
let mapLastLen = -1;

const mapQuery = useQuery({
  queryKey: ["map"],
  queryFn: () => api.get<LocationGroup[]>("/api/map"),
  refetchInterval: (query) => {
    const len = query.state.data?.length ?? -1;
    if (len === mapLastLen) mapStableTicks += 1;
    else {
      mapStableTicks = 0;
      mapLastLen = len;
    }
    return mapStableTicks >= 3 ? false : 2500;
  },
  shallow: true,
});

// Imported open-data events (e.g. Grand Débat), served in the same LocationGroup
// shape. Immutable + pre-baked, so no polling — one fetch, generously cached.
const importedQuery = useQuery({
  queryKey: ["imported-map"],
  queryFn: () => api.get<LocationGroup[]>("/api/imported-auditions/map"),
  staleTime: 5 * 60_000,
  shallow: true,
});

const ownGroups = computed(() => mapQuery.data.value ?? []);
const importedGroups = computed(() => importedQuery.data.value ?? []);

// ---- Filter state (the page owns it: one filtered set drives BOTH the map
// pins/counts and the testimonies panel) --------------------------------------
const allGroups = computed(() => [...ownGroups.value, ...importedGroups.value]);
// The place picker: every lieu that has something, weighted by its testimonies.
const locationTree = computed(() =>
  buildLocationTree(allGroups.value.map((g) => ({ area: g, weight: g.totalTestimonies }))),
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

// A content filter (free text or themes) cannot be evaluated for imported
// places: their report text is fetched one audition at a time, so it simply is not
// here to search. Rather than pretend they match, they drop out while such a
// filter is active — and the UI says so.
const contentFilterActive = computed(() => Boolean(needle.value) || topics.value.length > 0);

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
  if (props.preview || !testimoniesQuery.data.value) return ownGroups.value;
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

const filteredImportedGroups = computed<LocationGroup[]>(() => {
  // Imported reports are collective and never went through the verification
  // flow, so "verified only" excludes them by definition.
  if (contentFilterActive.value || verified.value) return [];
  return importedGroups.value.filter(
    (g) => passesLocation(g) && g.auditions.some((a) => passesDate(a.date)),
  );
});

const groups = computed(() => [...filteredOwnGroups.value, ...filteredImportedGroups.value]);

const resultCount = computed(() =>
  props.preview ? 0 : filteredTestimonies.value.length + filteredImportedGroups.value.length,
);

// ---- Filter option sources ---------------------------------------------------
// Earliest/latest audition date present — the picker is bounded by these so a
// range that can only ever return nothing is not offered in the first place.
const dateBounds = computed(() =>
  dateBoundsOf(allGroups.value.flatMap((g) => g.auditions.map((a) => a.date))),
);

const topicOptions = computed(() => buildTopicOptions(allTestimonies.value.map((t) => t.topics)));

// ---- Analyses (drawn by GeoNav on the map, around the raised territory) -----
const analyses = ref(false);

// Kept in the address (?analyses=1, where the old /analyses page now leads),
// but only while this is the page: the same map is also the home page's card,
// whose reset must not write onto "/".
const route = useRoute();
const router = useRouter();
watch(
  [() => route.name, () => route.query.analyses],
  ([name, flag]) => {
    if (name === "temoignages") analyses.value = flag === "1";
  },
  { immediate: true },
);
// Turned off from the plates (their close button, Esc), the focus was on them
// and they are gone: it comes back to the toggle, rather than to the top of
// the page. Only when it has nowhere else to be. (Read before they go: this
// runs before GeoNav takes them off the page.)
const analysesBtn = ref<HTMLButtonElement | null>(null);
watch(analyses, (on) => {
  if (!on && !props.preview && document.activeElement?.closest(".analyses-layer")) {
    void nextTick(() => {
      const active = document.activeElement;
      if (!active || active === document.body) analysesBtn.value?.focus({ preventScroll: true });
    });
  }
  if (props.preview || route.name !== "temoignages") return;
  if ((route.query.analyses === "1") === on) return;
  void router.replace({
    query: { ...route.query, analyses: on ? "1" : undefined },
    hash: route.hash,
  });
});

// Back to a card: it shows everything again.
watch(
  () => props.preview,
  (preview) => {
    if (!preview) return;
    filtersOpen.value = false;
    analyses.value = false;
    resetFilters();
  },
);
</script>

<template>
  <div class="temoignages">
    <GeoNav
      v-model:analyses="analyses"
      :groups="groups"
      :testimonies="filteredTestimonies"
      :loading="loading"
      :is-error="isError"
      :highlight="text"
      :sort="sort"
      :filtered="chips.length > 0"
      :theme-filter="topics"
      :preview="preview"
    >
      <template #head-actions>
        <div class="head-actions">
          <span class="result-count">
            {{ resultCount }} résultat{{ resultCount > 1 ? "s" : "" }}
          </span>
          <button
            type="button"
            class="ac-btn ac-btn--ghost filters-btn"
            :aria-expanded="filtersOpen"
            @click="filtersOpen = true"
          >
            Filtres
            <span v-if="chips.length" class="filters-count">{{ chips.length }}</span>
          </button>
          <!-- On a phone this row is the sheet's drag handle: a plain click,
               nothing stopped on pointerdown, or the strip no longer drags. -->
          <button
            ref="analysesBtn"
            type="button"
            class="ac-btn ac-btn--ghost filters-btn analyses-btn"
            aria-label="Analyses"
            :aria-pressed="analyses"
            @click="analyses = !analyses"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="16"
              height="16"
              aria-hidden="true"
            >
              <path d="M3 3v16a2 2 0 0 0 2 2h16" />
              <path d="M8 17v-3" />
              <path d="M13 17V9" />
              <path d="M18 17V5" />
            </svg>
            <span class="analyses-label">Analyses</span>
          </button>
        </div>
      </template>

      <template #head-below>
        <FilterChips v-if="chips.length" :chips="chips" class="head-chips" @remove="removeChip" />

        <p v-if="contentFilterActive && importedGroups.length" class="filter-note">
          Les témoignages importés (Grand Débat) sont masqués pendant une recherche par texte ou par
          thème : leur contenu n'est chargé qu'à l'ouverture d'une audition.
        </p>
      </template>
    </GeoNav>

    <FiltersDialog
      v-model:locations="locations"
      v-model:date-from="dateFrom"
      v-model:date-to="dateTo"
      v-model:topics="topics"
      v-model:sort="sort"
      v-model:text="text"
      v-model:verified="verified"
      :open="filtersOpen"
      :chips="chips"
      :location-tree="locationTree"
      :date-bounds="dateBounds"
      :topic-options="topicOptions"
      :result-count="resultCount"
      @close="filtersOpen = false"
      @remove="removeChip"
      @reset="resetFilters"
    />
  </div>
</template>

<style scoped>
.temoignages {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* --- Panel head controls (slotted into GeoNav's header) --------------------
   Free-text search lives in the filters dialog alongside every other filter,
   so the header stays down to the result count + the way into them. */
.head-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  /* One line, whatever the width: on a phone this row sits in the sheet's
     measured strip, and a taller strip moves the camera. Squeezed, the count
     shortens rather than push the buttons out (narrow phones also drop the
     Analyses label, then the count: below). */
  min-width: 0;
}
/* Reads as a control, not a caption: the ghost button is otherwise bare text
   against the panel, and this is the only way into the filters. */
.filters-btn {
  flex-shrink: 0;
  white-space: nowrap;
  padding: 0.35rem 0.75rem;
  font-size: var(--text-ui);
  border: 1px solid hsl(var(--border));
  border-radius: 0.5rem;
}

.filters-btn:hover {
  border-color: hsl(var(--primary) / 0.6);
}
.filters-count {
  margin-left: 0.4rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-size: var(--text-caption);
}
/* Pressed: tinted, at the same size as when it is not (the row must not move). */
.analyses-btn[aria-pressed="true"] {
  background: hsl(var(--primary) / 0.12);
  border-color: hsl(var(--primary));
}
.analyses-btn[aria-pressed="true"]:hover:not(:disabled) {
  background: hsl(var(--primary) / 0.18);
}
.analyses-btn svg {
  flex-shrink: 0;
  color: hsl(var(--primary));
}
.result-count {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
}
/* Narrow phones: the Analyses toggle down to its icon (its aria-label says
   it), a square as tall as Filtres; narrower still, the count goes — the
   filters dialog repeats it on its button. */
@media (max-width: 419px) {
  .analyses-btn {
    width: 2.5rem;
    padding: 0;
  }
  .analyses-label {
    display: none;
  }
}
@media (max-width: 359px) {
  .result-count {
    display: none;
  }
}
.head-chips {
  margin-top: 0.55rem;
}
.filter-note {
  margin: 0.55rem 0 0;
  font-size: var(--text-ui);
  line-height: 1.35;
  color: hsl(var(--muted-foreground));
}
</style>
