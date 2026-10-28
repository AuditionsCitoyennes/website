<script setup lang="ts">
// The auditions being listed, each unfolding its testimonies: those of the
// selected lieu (exiting goes through the breadcrumb — any ancestor crumb
// closes the lieu), or, with filters on, EVERY audition that matches them,
// wherever it was held.
import { ref } from "vue";
import type { GeoUnit } from "@/features/geo";
import TestimonyCard from "@/shared/testimony/TestimonyCard.vue";
import ExpandTransition from "@/shared/ui/transition/ExpandTransition.vue";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import { testimoniesOf, type PanelAudition } from "../model/auditions";

defineProps<{
  /** Filters are on: the results, not a lieu's detail. */
  listMode: boolean;
  /** The open lieu (its title and count head the list). */
  place: GeoUnit | null;
  /** How many auditions match the filters (the results' heading). */
  resultCount: number;
  /** The auditions listed: the results' page, or the lieu's own. */
  auditions: PanelAudition[];
  /** The place-detail accordion (single-open): the ids unfolded. */
  open: Set<string>;
  /** Date, and in the results the lieu too (usePanelAuditions' auditionMeta). */
  meta: (a: PanelAudition) => string;
  /** Another audition is being closed to open one: its body drops in one step. */
  swapping: boolean;
  /** Free-text query — highlighted inside each testimony (TestimonyCard). */
  highlight?: string;
  /** More results than are listed: the next page comes as the sentinel nears
   *  the bottom of the panel (or on a press). */
  more: boolean;
  /** The open lieu's auditions are on their way (the server's lazy path). */
  loading?: boolean;
}>();

const emit = defineEmits<{
  toggle: [id: string];
  /** The next page of results. */
  more: [];
  /** The open audition's next testimonies (the server's lists). */
  moreTestimonies: [];
}>();

/** The "more results" sentinel (usePanelAuditions observes it). */
const moreEl = ref<HTMLElement | null>(null);
/** The open audition's "more testimonies" sentinel (the same). */
const moreTestimoniesEl = ref<HTMLElement | null>(null);
function setMoreTestimoniesEl(el: unknown) {
  moreTestimoniesEl.value = el instanceof HTMLElement ? el : null;
}
defineExpose({ moreEl, moreTestimoniesEl });
</script>

<template>
  <div class="place-detail">
    <template v-if="listMode">
      <h2 class="place-title">{{ resultCount }} audition{{ resultCount > 1 ? "s" : "" }}</h2>
      <p class="place-meta" :class="{ 'place-empty': !resultCount }">
        {{
          resultCount ? "correspondant aux filtres" : "Aucune audition ne correspond aux filtres."
        }}
      </p>
    </template>
    <template v-else-if="place">
      <h2 class="place-title">{{ place.label }}</h2>
      <p class="place-meta">{{ place.count }} témoignage{{ place.count > 1 ? "s" : "" }}</p>
    </template>
    <LoadingDots v-if="loading" label="Chargement des auditions…" />

    <div v-for="g in auditions" :key="g.id" class="aud-group">
      <button
        type="button"
        class="aud-header"
        :class="{ open: open.has(g.id) }"
        :aria-expanded="open.has(g.id)"
        :data-aud="g.id"
        @click="emit('toggle', g.id)"
      >
        <div class="aud-info">
          <h3 class="aud-title">{{ g.title }}</h3>
          <p v-if="meta(g)" class="aud-meta" :title="meta(g)">
            {{ meta(g) }}
          </p>
        </div>
        <span class="aud-count">{{ g.count }}</span>
        <svg
          class="aud-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="18"
          height="18"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <!-- Its testimonies are still loading: the dots, right under its
           line. The text then unfolds to its own height — measured once
           it is there. -->
      <LoadingDots
        v-if="open.has(g.id) && testimoniesOf(g) === null"
        class="aud-loading"
        label="Chargement des témoignages…"
      />
      <ExpandTransition :instant-leave="swapping">
        <div v-if="open.has(g.id) && testimoniesOf(g) !== null" class="aud-body">
          <p v-if="g.failed" class="aud-empty">Impossible de charger les témoignages.</p>
          <p v-else-if="!testimoniesOf(g)?.length" class="aud-empty">
            Aucun témoignage à afficher.
          </p>
          <TestimonyCard
            v-for="t in testimoniesOf(g) ?? []"
            :key="t.id"
            :testimony="t"
            :highlight="highlight"
            hide-audition
          />
          <!-- More testimonies than are listed (the server's pages): the next
               come as this nears the bottom of the panel (or on a press). -->
          <button
            v-if="g.more"
            :ref="setMoreTestimoniesEl"
            type="button"
            class="ac-btn ac-btn--ghost ac-btn--sm more-results"
            @click="emit('moreTestimonies')"
          >
            Afficher plus de témoignages
          </button>
        </div>
      </ExpandTransition>
    </div>

    <!-- More results than are listed: the next page comes as this nears
         the bottom of the panel (or on a press). -->
    <button
      v-if="listMode && more"
      ref="moreEl"
      type="button"
      class="ac-btn ac-btn--ghost ac-btn--sm more-results"
      @click="emit('more')"
    >
      Afficher plus d'auditions
    </button>
  </div>
</template>

<style scoped>
/* ---- Place detail ---- */
.place-detail {
  display: flex;
  flex-direction: column;
}

.place-title {
  font-size: var(--text-title);
  font-weight: 700;
  color: hsl(var(--primary));
}

.place-meta {
  margin: 0.1rem 0 0.6rem;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

/* No result: the line is the panel's whole message, read like the others. */
.place-empty {
  font-size: var(--text-body);
}

.aud-group + .aud-group {
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.more-results {
  align-self: center;
  margin: 0.6rem 0 0.2rem;
  color: hsl(var(--muted-foreground));
}

.aud-header {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.6rem 0.5rem;
  background: transparent;
  border: none;
  border-radius: 0.5rem;
  text-align: left;
  cursor: pointer;
}

.aud-header:hover {
  background: hsl(var(--accent) / 0.4);
}

.aud-info {
  flex: 1;
  min-width: 0;
}

/* An h3, but a row title in a dense list: below --text-title Bebas reads too
   small, so the sans at reading size (line-height as the sans h4-h6 — the
   h3's 1.05 would clip its accents and descenders under overflow: hidden). */
.aud-title {
  font-family: var(--font-sans);
  font-size: var(--text-body);
  font-weight: 600;
  letter-spacing: normal;
  line-height: 1.3;
  color: hsl(var(--foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aud-meta {
  margin: 0.05rem 0 0;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

/* One line where the panel changes width (desktop: it widens as an audition
   opens). A meta line that wrapped would re-flow as it does, and move every
   line below it — the one just clicked included — from under the pointer. */
@media (min-width: 900px) {
  .aud-meta {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.aud-count {
  flex-shrink: 0;
  padding: 0.12rem 0.55rem;
  border-radius: 999px;
  font-size: var(--text-caption);
  font-weight: 700;
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
}

.aud-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
  transition: transform 0.28s ease;
}

.aud-header.open .aud-chevron {
  transform: rotate(180deg);
}

.aud-body {
  display: flex;
  flex-direction: column;
  padding: 0.1rem 0.5rem 0.6rem 0.9rem;
}

/* Where the body will be: the same inset. */
.aud-loading {
  padding-left: 0.9rem;
  padding-right: 0.5rem;
}

.aud-empty {
  padding: 0.4rem 0;
  font-size: var(--text-body);
  color: hsl(var(--muted-foreground));
}

.aud-body :deep(.testimony) {
  padding: 0.7rem 0;
}

.aud-body :deep(.testimony) + :deep(.testimony) {
  border-top: 1px solid hsl(var(--border) / 0.45);
}
</style>
