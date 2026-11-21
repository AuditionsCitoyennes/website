<script setup lang="ts">
import { computed, defineAsyncComponent, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { FiltersDialog, FilterChips } from "@/features/filters";
import { GeoNav } from "@/features/geo-nav";
import { useTestimonyFiltering } from "./useTestimonyFiltering";
import { useAnalysesToggle } from "./useAnalysesToggle";

// The testimonies map — the page, or (preview) the card on the home page: the
// same instance moves between the two (see MapStage).
const props = defineProps<{ preview?: boolean }>();

// The figures and the lists come from the server's place reads (map phase 1).
const filtering = useTestimonyFiltering({
  preview: () => Boolean(props.preview),
  queryClient: useQueryClient(),
});
const {
  text,
  topics,
  locations,
  dateFrom,
  dateTo,
  verified,
  sort,
  chips,
  removeChip,
  reset: resetFilters,
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
} = filtering;

// The panel waits for the server's world answer.
const loading = computed(() => unitTree.loading());
const isError = computed(() => unitTree.failed());
// What the results were looked up with: the text as debounced.
const highlight = computed(() => serverFilters.text.value);

const { analyses, analysesBtn } = useAnalysesToggle(() => Boolean(props.preview));
/** The filters button's name: the word, and how many filters are on. */
const filtersLabel = computed(() => {
  const n = chips.value.length;
  return n ? `Filtres, ${n} actif${n > 1 ? "s" : ""}` : "Filtres";
});
// `!!`: a constant the template reads as is, so a build without the analyses drops the button.
const analysesOn = !!__ANALYSES__;

// The testing tools: the testing options menu. Not in a production build.
const DevOptionsMenu = __TEST_TOOLS__
  ? defineAsyncComponent(() => import("./DevOptionsMenu.vue"))
  : null;

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
      :loading="loading"
      :is-error="isError"
      :highlight="highlight"
      :sort="sort"
      :filtered="listFiltered"
      :theme-filter="topics"
      :preview="preview"
      :unit-tree="unitTree"
    >
      <template #head-actions>
        <div class="head-actions">
          <span class="result-count">
            {{ resultCount }} résultat{{ resultCount > 1 ? "s" : "" }}
          </span>
          <!-- On a phone a funnel stands for the word (its aria-label says
               it); the count of active filters is a badge on its corner. -->
          <button
            type="button"
            class="ac-btn ac-btn--ghost filters-btn"
            :aria-label="filtersLabel"
            :aria-expanded="filtersOpen"
            @click="filtersOpen = true"
          >
            <svg
              class="filters-icon"
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
              <path d="M3 4h18l-7 8.5V19l-4 2v-8.5z" />
            </svg>
            <span class="filters-label">Filtres</span>
            <span v-if="chips.length" class="filters-count" aria-hidden="true">{{
              chips.length
            }}</span>
          </button>
          <!-- On a phone this row is the sheet's drag handle: a plain click,
               nothing stopped on pointerdown, or the strip no longer drags. -->
          <button
            v-if="analysesOn"
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
      </template>

      <template #map-tools>
        <DevOptionsMenu v-if="DevOptionsMenu && !preview" />
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
      :load-location-children="loadLocationChildren"
      :date-bounds="dateBounds"
      :topic-options="topicOptions"
      :result-count="resultCount"
      :search-hint="searchHint"
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
     shortens rather than push the buttons out (below 900 px both labels and
     the count go: below). */
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
/* The funnel is a phone's (below). */
.filters-icon {
  display: none;
  flex-shrink: 0;
  color: hsl(var(--primary));
}
/* Phones (the bottom sheet, whose strip this row is, after the trail): both
   buttons down to their icons (their aria-labels say them), squares as tall
   as a button; no result count — the filters dialog says it on its button,
   and the trail has the room. The active filters' count stays on the funnel. */
@media (max-width: 899px) {
  .filters-btn {
    position: relative;
    width: 2.5rem;
    padding: 0;
  }
  .filters-icon {
    display: block;
  }
  .filters-label,
  .analyses-label,
  .result-count {
    display: none;
  }
  /* The active filters' count: a badge on the funnel's top-right corner, so
     the button stays a square like its neighbour. Ringed in the panel's
     ground so it reads apart from the border it sits on. */
  .filters-count {
    position: absolute;
    top: -0.4rem;
    right: -0.4rem;
    min-width: 1.15rem;
    height: 1.15rem;
    margin: 0;
    padding: 0 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    box-shadow: 0 0 0 2px hsl(var(--card));
    pointer-events: none;
  }
}
.head-chips {
  margin-top: 0.55rem;
}
</style>
