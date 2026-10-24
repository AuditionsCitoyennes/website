<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useAuthStore } from "@/features/auth";
import { formatDateLong, formatDateShort } from "@/shared/format/dates";
import { FiltersDialog, FilterChips } from "@/features/filters";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import TestimonyManager from "../testimonies/TestimonyManager.vue";
import PlacementMark from "./PlacementMark.vue";
import AuditionEditDialog from "./AuditionEditDialog.vue";
import { useAdminAuditions } from "./useAdminAuditions";
import { useAuditionFilters } from "./useAuditionFilters";
import { useAuditionPopup } from "./useAuditionPopup";
import { useTopicAnalysis } from "./useTopicAnalysis";

const auth = useAuthStore();

// Two lists: "Vos auditions" for everyone, and under it, for super admins
// only, "Auditions existantes" — every audition of the site, theirs included.
const { auditions, myAuditions, reachableAuditions, fetchAuditions } = useAdminAuditions();

// ---- Filters: the same as the Témoignages map's ------------------------------
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
  resetFilters,
  filtersOpen,
  openFilters,
  locationTree,
  topicOptions,
  dateBounds,
  filterableQuery,
  filterableFailed,
  refreshFilterable,
  testimonyFilterOn,
  waitingForTestimonies,
  filterOn,
  shown,
  resultCount,
} = useAuditionFilters(auditions, reachableAuditions);

const sections = computed(() => [
  {
    id: "mine" as const,
    title: "Vos auditions",
    desc: "Les auditions que vous avez créées, et leurs témoignages",
    items: shown(myAuditions.value),
    empty: filterOn.value
      ? "Aucune de vos auditions ne correspond aux filtres"
      : "Vous n'avez pas encore créé d'audition",
  },
  ...(auth.isSuperAdmin
    ? [
        {
          id: "existing" as const,
          title: "Auditions existantes",
          desc: "Les auditions de tous les administrateurs",
          items: shown(auditions.value),
          empty: filterOn.value
            ? "Aucune audition ne correspond aux filtres"
            : "Aucune audition créée",
        },
      ]
    : []),
]);

// The audition's popup — what it says, the two buttons that used to sit on its
// line (edit, delete), its testimonies — and the edit form opened from it.
const {
  selectedAudition,
  testimonies,
  loadingTestimonies,
  openAudition,
  openNote,
  fetchTestimonies,
  openPopup,
  onLineClick,
  closePopup,
  editing,
  startEditing,
  onTestimoniesChanged,
  onAuditionEmptied,
  deleting,
  handleDelete,
} = useAuditionPopup(reachableAuditions, { fetchAuditions, refreshFilterable });

// The "missing analyses" buttons: the popup's (its audition) and, for super
// admins, the one over "Auditions existantes" (every audition of the site).
const { analyzingAll, analyzingMultiple, handleAnalyzeSelected, handleAnalyzeAllAuditions } =
  useTopicAnalysis({
    auditions,
    selectedAudition,
    testimonies,
    fetchTestimonies,
    refreshFilterable,
  });

onMounted(fetchAuditions);

defineExpose({ refresh: fetchAuditions });
</script>

<template>
  <div>
    <!-- The filters of the Témoignages map, over the lists below. -->
    <div class="filters-bar">
      <button
        type="button"
        class="ac-btn ac-btn--outline ac-btn--sm"
        :aria-expanded="filtersOpen"
        @click="openFilters"
      >
        Filtres
        <span v-if="chips.length" class="filters-count">{{ chips.length }}</span>
      </button>
      <FilterChips v-if="chips.length" :chips="chips" class="filters-chips" @remove="removeChip" />
      <span v-if="filterOn && !waitingForTestimonies" class="filters-result">
        {{ resultCount }} audition{{ resultCount > 1 ? "s" : "" }}
      </span>
      <!-- Without them, "vérifiés", the themes and the text in testimonies
           cannot be judged: the lists below only reflect the rest. -->
      <p v-if="filterableFailed && testimonyFilterOn" class="filters-error">
        Les témoignages n'ont pas pu être chargés : les filtres qui portent sur eux sont incomplets.
        <button
          type="button"
          class="ac-btn ac-btn--outline ac-btn--sm"
          @click="filterableQuery.refetch()"
        >
          Réessayer
        </button>
      </p>
    </div>

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
      :result-count="waitingForTestimonies ? null : resultCount"
      description="Affinez la liste des auditions"
      search-placeholder="Mot ou phrase : titre, lieu, contexte ou témoignages..."
      result-noun="audition"
      @close="filtersOpen = false"
      @remove="removeChip"
      @reset="resetFilters"
    />

    <section v-for="section in sections" :key="section.id" class="admin-card">
      <div class="head">
        <div>
          <h2 class="admin-card-title">{{ section.title }}</h2>
          <p class="admin-card-desc">{{ section.desc }}</p>
        </div>
        <div v-if="section.id === 'existing'" class="head-tools">
          <button
            type="button"
            class="ac-btn ac-btn--outline ac-btn--sm"
            :disabled="analyzingMultiple"
            @click="handleAnalyzeAllAuditions"
          >
            <span v-if="analyzingMultiple" class="spinner"></span>
            <span v-else>✦</span>
            Analyses manquantes
          </button>
        </div>
      </div>

      <div class="list">
        <!-- The whole line opens the audition's popup — where it can be read,
             edited, deleted and its testimonies managed. The eye is the same
             action as a real button, for the keyboard and screen readers. -->
        <!-- A filter on the testimonies, and they are on their way. -->
        <LoadingDots v-if="waitingForTestimonies" label="Chargement des témoignages…" />
        <div
          v-for="audition in waitingForTestimonies ? [] : section.items"
          :key="audition.id"
          class="item"
          @click="onLineClick(audition.id)"
        >
          <div class="item-info">
            <h3 class="item-title">{{ audition.title }}</h3>
            <p class="item-meta">
              {{ formatDateShort(audition.date) }} — {{ audition.location }}
              <PlacementMark :area="audition.area" />
            </p>
            <p class="item-status">
              Statut : {{ audition.status === "published" ? "Publié" : "Brouillon" }}
              <span v-if="audition.audition_en_ligne" class="chip chip--outline online-tag"
                >En ligne</span
              >
            </p>
          </div>
          <button
            type="button"
            class="ac-btn ac-btn--outline ac-btn--sm ac-btn--icon eye"
            title="Voir l'audition"
            :aria-label="`Voir l'audition « ${audition.title} »`"
            @click.stop="openPopup(audition.id)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="17"
              height="17"
              aria-hidden="true"
            >
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>

        <p v-if="section.items.length === 0 && !waitingForTestimonies" class="empty">
          {{ section.empty }}
        </p>
      </div>
    </section>

    <!-- The audition's popup: what it says, the two buttons that used to sit on
         its line (edit, delete), and its testimonies. -->
    <ModalDialog
      :open="openAudition !== null"
      :title="openAudition?.title ?? ''"
      :description="
        openAudition ? `${formatDateLong(openAudition.date)} · ${openAudition.location}` : undefined
      "
      dismissible
      wide
      @close="closePopup"
    >
      <div v-if="openAudition" class="popup">
        <div class="popup-facts">
          <span
            class="chip"
            :class="openAudition.status === 'published' ? 'chip--green' : 'chip--amber'"
          >
            {{ openAudition.status === "published" ? "Publiée" : "Brouillon" }}
          </span>
          <span v-if="openNote?.off" class="chip chip--amber">{{ openNote.label }}</span>
        </div>
        <!-- Where the fix is made (Modifier): what the line's tooltip says. -->
        <p
          v-if="openNote"
          class="popup-placement"
          :class="{ 'popup-placement--off': openNote.off }"
        >
          {{ openNote.hint }}
        </p>

        <section>
          <h3 class="popup-label">Contexte de l'audition</h3>
          <p v-if="openAudition.content" class="popup-content">{{ openAudition.content }}</p>
          <p v-else class="popup-none">Aucun contexte renseigné.</p>
        </section>

        <div class="popup-actions">
          <button
            type="button"
            class="ac-btn ac-btn--outline ac-btn--sm"
            :disabled="deleting"
            @click="startEditing(openAudition)"
          >
            <span aria-hidden="true">✎</span>
            Modifier
          </button>
          <button
            type="button"
            class="ac-btn ac-btn--danger ac-btn--sm"
            :disabled="deleting"
            @click="handleDelete(openAudition.id)"
          >
            <span v-if="deleting" class="spinner"></span>
            <span v-else aria-hidden="true">🗑</span>
            Supprimer
          </button>
        </div>

        <section class="popup-testimonies">
          <div class="detail-head">
            <h4>
              Gestion des témoignages
              <!-- How many there are (once they are loaded). -->
              <span v-if="!loadingTestimonies" class="chip">{{ testimonies.length }}</span>
            </h4>
            <button
              v-if="auth.isSuperAdmin"
              type="button"
              class="ac-btn ac-btn--outline ac-btn--sm ac-btn--icon"
              title="Analyser tous les témoignages"
              :disabled="analyzingAll"
              @click="handleAnalyzeSelected"
            >
              <span v-if="analyzingAll" class="spinner"></span>
              <span v-else>✦</span>
            </button>
          </div>
          <div v-if="loadingTestimonies" class="detail-loading">
            <span class="spinner" aria-label="Chargement"></span>
          </div>
          <TestimonyManager
            v-else
            :audition-id="openAudition.id"
            :testimonies="testimonies"
            :online="Boolean(openAudition.audition_en_ligne)"
            @update="onTestimoniesChanged(openAudition.id)"
            :on-audition-deleted="onAuditionEmptied"
          />
        </section>
      </div>
    </ModalDialog>

    <AuditionEditDialog
      :open="editing !== null"
      :audition="editing"
      @close="editing = null"
      @updated="fetchAuditions"
    />
  </div>
</template>

<style scoped>
.filters-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 1.2rem;
}

.filters-count {
  padding: 0 0.4rem;
  border-radius: 999px;
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-size: var(--text-caption);
}

.filters-chips {
  flex: 1 1 auto;
  min-width: 0;
}

.filters-error {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  font-size: var(--text-ui);
  color: hsl(var(--destructive));
}

.filters-result {
  margin-left: auto;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.head-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-bottom: 1.1rem;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.85rem;
  padding: 1rem;
  border: 1px solid hsl(var(--border));
  border-radius: 0.7rem;
  cursor: pointer;
  transition: var(--transition-smooth);
}

.item:hover {
  border-color: hsl(var(--primary) / 0.45);
}

.item-info {
  min-width: 0;
}

/* The eye lights up with the line it belongs to (and under the keyboard). */
.eye {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}

.item:hover .eye,
.eye:focus-visible {
  border-color: hsl(var(--primary));
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

.item-title {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: var(--text-body);
  letter-spacing: 0;
  line-height: 1.3; /* the h3's Bebas 1.05 crowds sans lines */
  color: hsl(var(--foreground));
}

.item-meta {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.online-tag {
  margin-left: 0.4rem;
}

.item-status {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  margin-top: 0.2rem;
}

.popup {
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
}

.popup-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.popup-placement {
  font-size: var(--text-ui);
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

.popup-placement--off {
  padding: 0.6rem 0.8rem;
  border: 1px solid hsl(38 80% 50% / 0.3);
  border-radius: 0.6rem;
  background: hsl(38 80% 50% / 0.08);
  color: hsl(var(--foreground) / 0.9);
}

.popup-label {
  margin-bottom: 0.5rem;
  font-family: var(--font-sans);
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
}

.popup-content {
  color: hsl(var(--foreground) / 0.9);
  font-size: var(--text-body);
  line-height: var(--lh-body);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.popup-none {
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}

.popup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

/* The testimonies follow the audition in the same popup, set apart by a line.
   No box of their own: a box inside the popup, with each testimony boxed again
   inside it, only took width away from the text. */
.popup-testimonies {
  border-top: 1px solid hsl(var(--border));
  padding-top: 1.2rem;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.85rem;
}

.detail-loading {
  display: flex;
  justify-content: center;
  padding: 1rem;
  color: hsl(var(--primary));
}

.detail-head h4 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: var(--text-body);
  color: hsl(var(--foreground));
}

.empty {
  text-align: center;
  color: hsl(var(--muted-foreground));
  padding: 1.5rem 0;
}
</style>
