<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { answersText, type AuditionArea, type Testimony } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import { useAuthStore } from "@/features/auth";
import { formatDateLong, formatDateShort } from "@/shared/format/dates";
import {
  buildLocationTree,
  buildTopicOptions,
  dateBoundsOf,
  fold,
  passesContent,
  passesDate,
  passesLocation,
  useFilters,
  FiltersDialog,
  FilterChips,
  type TestimonyContent,
} from "@/features/filters";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import LocationCombobox from "./LocationCombobox.vue";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import TestimonyManager from "../testimonies/TestimonyManager.vue";
import PlacementMark from "./PlacementMark.vue";
import { placementNote } from "./placement";

interface AdminAudition {
  id: string;
  title: string;
  date: string;
  location: string;
  content: string;
  status: string | null;
  created_by: string | null;
  /** Where the Témoignages map files it (région, département, ville, lieu), and how precisely. */
  area?: AuditionArea | null;
  /** Gathers the testimonies sent from the site for one town hall and month. */
  audition_en_ligne?: boolean;
}

/** A testimony as the filters judge it (see /api/testimonies/admin/filterable). */
interface FilterableTestimony extends TestimonyContent {
  audition_id: string;
}

const { toast } = useToast();
const auth = useAuthStore();

const auditions = ref<AdminAudition[]>([]);
// The audition whose popup is open (its line or its eye button was clicked),
// and its testimonies, shown in there.
const selectedAudition = ref<string | null>(null);
const testimonies = ref<Testimony[]>([]);
// Until the first answer for this audition: not to be read as "it has none".
const loadingTestimonies = ref(false);
const analyzingAll = ref(false);
const analyzingMultiple = ref(false);

const editingId = ref<string | null>(null);
const editForm = ref({
  title: "",
  date: "",
  location: "",
  content: "",
  status: "published" as "published" | "draft",
});

// Two lists: "Vos auditions" for everyone, and under it, for super admins
// only, "Auditions existantes" — every audition of the site, theirs included.
const myAuditions = computed(() => auditions.value.filter((a) => a.created_by === auth.user?.id));

// What a plain admin may open is what the first list shows: their own.
const reachableAuditions = computed(() =>
  auth.isSuperAdmin ? auditions.value : myAuditions.value,
);

// ---- Filters: the same as the Témoignages map's ------------------------------
// Place, dates, themes, verified only, free text and order. Place and dates are
// the audition's own; themes, "verified" and the text are judged on its
// testimonies — an audition passes when one of them does (the free text may
// also be found in the audition's title, place or context).
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
const FILTERABLE_KEY = ["admin", "filterable-testimonies"];
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
  if (filterableQuery.isError.value && !filterableQuery.data.value) void filterableQuery.refetch();
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
function shown(list: AdminAudition[]): AdminAudition[] {
  const ids = passingIds.value;
  return (ids ? list.filter((a) => ids.has(a.id)) : [...list]).sort(bySort);
}
const resultCount = computed(() => shown(reachableAuditions.value).length);

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
const openAudition = computed(
  () => reachableAuditions.value.find((a) => a.id === selectedAudition.value) ?? null,
);
const openNote = computed(() => placementNote(openAudition.value?.area));

async function fetchAuditions() {
  try {
    auditions.value = await api.get<AdminAudition[]>("/api/auditions/admin/list", true);
  } catch {
    auditions.value = [];
  }
}

/** The popup changed this audition's testimonies (added, edited, removed…). */
async function onTestimoniesChanged(auditionId: string) {
  refreshFilterable();
  await fetchTestimonies(auditionId);
  // None left: the audition may have gone with its last one, deleted from
  // elsewhere meanwhile (a witness's link, another admin) — the list says
  // whether it is still there, and the popup closes if not.
  if (selectedAudition.value === auditionId && testimonies.value.length === 0) {
    await fetchAuditions();
  }
}

/** Its last testimony deleted, the audition went with it: out of the list. */
async function onAuditionEmptied(auditionId: string) {
  if (selectedAudition.value === auditionId) closePopup();
  refreshFilterable();
  await fetchAuditions();
}

async function fetchTestimonies(auditionId: string) {
  try {
    const rows = await api.get<Testimony[]>(`/api/testimonies/for-audition/${auditionId}`, true);
    // Drop responses that no longer match the expanded audition (the user
    // switched or collapsed while the request was in flight).
    if (selectedAudition.value !== auditionId) return;
    testimonies.value = rows;
  } catch {
    if (selectedAudition.value === auditionId) testimonies.value = [];
  }
}

// The popup opens with the audition's testimonies in it.
async function openPopup(id: string) {
  selectedAudition.value = id;
  testimonies.value = []; // never show the previous audition's rows
  loadingTestimonies.value = true;
  await fetchTestimonies(id);
  // Unless another audition was opened meanwhile (its own load is running).
  if (selectedAudition.value === id) loadingTestimonies.value = false;
}

/** A click anywhere on the line opens it too — unless it ends a text
 *  selection (copying a title out of the list must stay possible). */
function onLineClick(id: string) {
  if (window.getSelection()?.toString()) return;
  openPopup(id);
}

function closePopup() {
  selectedAudition.value = null;
  testimonies.value = [];
  loadingTestimonies.value = false;
  // The edit form is only ever opened from the popup: it goes with it.
  editingId.value = null;
}

// The audition left the list (deleted here or elsewhere): nothing to show, and
// nothing left to edit.
watch(openAudition, (audition) => {
  if (!audition && selectedAudition.value !== null) closePopup();
});

/** The audition being edited is an online one (its date and place are fixed). */
const editingOnline = ref(false);

function startEditing(audition: AdminAudition) {
  editingOnline.value = Boolean(audition.audition_en_ligne);
  editForm.value = {
    title: audition.title,
    date: audition.date,
    location: audition.location,
    content: audition.content,
    status: (audition.status ?? "published") as "published" | "draft",
  };
  editingId.value = audition.id;
}

const savingEdit = ref(false);

async function handleUpdate() {
  if (!editingId.value || savingEdit.value) return;
  if (
    !editForm.value.title ||
    !editForm.value.date ||
    !editForm.value.location ||
    !editForm.value.content
  ) {
    toast({
      title: "Erreur",
      description: "Veuillez remplir tous les champs",
      variant: "destructive",
    });
    return;
  }
  savingEdit.value = true;
  try {
    await api.patch(`/api/auditions/${editingId.value}`, editForm.value);
    toast({ title: "Succès!", description: "Audition modifiée" });
    editingId.value = null;
    await fetchAuditions();
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    savingEdit.value = false;
  }
}

// While the deletion is on its way the popup's buttons are frozen: nothing
// else is started on an audition that is about to disappear.
const deleting = ref(false);

async function handleDelete(id: string) {
  if (deleting.value) return;
  if (!confirm("Êtes-vous sûr de vouloir supprimer cette audition?")) return;
  deleting.value = true;
  try {
    await api.del(`/api/auditions/${id}`);
    toast({ title: "Succès!", description: "Audition supprimée" });
    if (selectedAudition.value === id) closePopup();
    await fetchAuditions();
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    deleting.value = false;
  }
}

async function analyzeMissing(list: Testimony[]): Promise<number> {
  let analyzed = 0;
  for (const t of list.filter((x) => !x.topics || x.topics.length === 0)) {
    try {
      const { topics } = await api.post<{ topics: string[] }>(`/api/testimonies/${t.id}/analyze`);
      if (topics.length > 0) analyzed++;
    } catch (e) {
      // Stop the batch on a configuration error (no API key) — every
      // subsequent call would fail the same way.
      if (e instanceof ApiError && e.status === 503) throw e;
    }
  }
  return analyzed;
}

// Analyze every testimony missing topics in the audition of the popup.
async function handleAnalyzeSelected() {
  const auditionId = selectedAudition.value;
  if (!auditionId) return;
  const missing = testimonies.value.filter((t) => !t.topics || t.topics.length === 0);
  if (missing.length === 0) {
    toast({ title: "Info", description: "Tous les témoignages ont déjà été analysés" });
    return;
  }
  analyzingAll.value = true;
  try {
    const analyzed = await analyzeMissing(testimonies.value);
    // The user may have closed it, or opened another one, during the batch.
    if (selectedAudition.value === auditionId) await fetchTestimonies(auditionId);
    refreshFilterable();
    toast({ title: "Analyse terminée", description: `${analyzed} témoignage(s) analysé(s)` });
  } catch (e) {
    toast({
      title: "Erreur d'analyse",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    analyzingAll.value = false;
  }
}

// Analyze every testimony missing topics across all auditions (super admin).
async function handleAnalyzeAllAuditions() {
  analyzingMultiple.value = true;
  let totalAnalyzed = 0;
  let totalAuditions = 0;
  try {
    for (const audition of auditions.value) {
      const list = await api.get<Testimony[]>(`/api/testimonies/for-audition/${audition.id}`, true);
      const missing = list.filter((t) => !t.topics || t.topics.length === 0);
      if (missing.length === 0) continue;
      totalAuditions++;
      totalAnalyzed += await analyzeMissing(list);
    }
    if (selectedAudition.value) await fetchTestimonies(selectedAudition.value);
    refreshFilterable();
    toast({
      title: "Analyse groupée terminée",
      description: `${totalAnalyzed} témoignage(s) analysé(s) sur ${totalAuditions} audition(s)`,
    });
  } catch (e) {
    toast({
      title: "Erreur d'analyse",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    analyzingMultiple.value = false;
  }
}

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

    <ModalDialog
      :open="editingId !== null"
      title="Modifier l'audition"
      description="Modifiez les informations de l'audition"
      dismissible
      wide
      @close="editingId = null"
    >
      <div class="form">
        <div class="form-field">
          <label class="form-label" for="edit-aud-title">Titre</label>
          <input id="edit-aud-title" v-model="editForm.title" class="form-input" />
        </div>
        <div class="grid-2">
          <!-- An online audition's month and town hall are fixed (the next
               testimony finds it by them): shown, not editable. -->
          <div class="form-field">
            <label class="form-label" for="edit-aud-date">Date</label>
            <input
              id="edit-aud-date"
              v-model="editForm.date"
              class="form-input"
              type="date"
              :disabled="editingOnline"
            />
          </div>
          <div class="form-field">
            <label class="form-label">Lieu</label>
            <input
              v-if="editingOnline"
              class="form-input"
              :value="editForm.location"
              disabled
              aria-label="Lieu"
            />
            <LocationCombobox v-else v-model="editForm.location" />
          </div>
        </div>
        <div class="form-field">
          <label class="form-label" for="edit-aud-content">Contexte de l'audition</label>
          <textarea
            id="edit-aud-content"
            v-model="editForm.content"
            class="form-input form-textarea"
            rows="4"
          ></textarea>
        </div>
        <div class="form-field">
          <label class="form-label" for="edit-aud-status">Statut</label>
          <select id="edit-aud-status" v-model="editForm.status" class="form-input">
            <option value="published">Publié</option>
            <option value="draft">Brouillon</option>
          </select>
        </div>
        <button
          type="button"
          class="ac-btn ac-btn--primary ac-btn--block"
          :disabled="savingEdit"
          @click="handleUpdate"
        >
          {{ savingEdit ? "Enregistrement..." : "Enregistrer" }}
        </button>
      </div>
    </ModalDialog>
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

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}

@media (max-width: 540px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
}
</style>
