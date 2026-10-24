<script setup lang="ts">
import { computed, watch } from "vue";
import { FiltersDialog, FilterChips } from "@/features/filters";
import { GeoNav } from "@/features/geo-nav";
import { useMapGroupsQuery, useTestimoniesQuery } from "./api/queries";
import { useTestimonyFiltering } from "./useTestimonyFiltering";
import { useAnalysesToggle } from "./useAnalysesToggle";

// The testimonies map — the page, or (preview) the card on the home page: the
// same instance moves between the two (see MapStage).
const props = defineProps<{ preview?: boolean }>();

const testimoniesQuery = useTestimoniesQuery(computed(() => !props.preview));

const loading = computed(() => testimoniesQuery.isLoading.value);
const isError = computed(() => testimoniesQuery.isError.value);

const mapQuery = useMapGroupsQuery();

const ownGroups = computed(() => mapQuery.data.value ?? []);

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
  filteredTestimonies,
  groups,
  resultCount,
  locationTree,
  dateBounds,
  topicOptions,
} = useTestimonyFiltering({
  preview: () => Boolean(props.preview),
  testimonies: testimoniesQuery.data,
  ownGroups,
});

const { analyses, analysesBtn } = useAnalysesToggle(() => Boolean(props.preview));

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
</style>
