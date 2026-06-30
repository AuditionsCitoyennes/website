<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { Testimony } from "@ac/shared";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import { useAuthStore } from "@/stores/auth";
import { formatDateShort } from "@/lib/format";
import ModalDialog from "@/components/ModalDialog.vue";
import LocationCombobox from "@/components/LocationCombobox.vue";
import TestimonyManager from "./TestimonyManager.vue";

interface AdminAudition {
  id: string;
  title: string;
  date: string;
  location: string;
  content: string;
  status: string | null;
  created_by: string | null;
}

const { toast } = useToast();
const auth = useAuthStore();

const auditions = ref<AdminAudition[]>([]);
const selectedAudition = ref<string | null>(null);
const testimonies = ref<Testimony[]>([]);
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

const visibleAuditions = computed(() => {
  if (auth.isSuperAdmin) return auditions.value;
  return auditions.value.filter((a) => a.created_by === auth.user?.id);
});

async function fetchAuditions() {
  try {
    auditions.value = await api.get<AdminAudition[]>("/api/auditions/admin/list", true);
  } catch {
    auditions.value = [];
  }
}

async function fetchTestimonies(auditionId: string) {
  try {
    const rows = await api.get<Testimony[]>(
      `/api/testimonies/for-audition/${auditionId}`,
      true,
    );
    // Drop responses that no longer match the expanded audition (the user
    // switched or collapsed while the request was in flight).
    if (selectedAudition.value !== auditionId) return;
    testimonies.value = rows;
  } catch {
    if (selectedAudition.value === auditionId) testimonies.value = [];
  }
}

async function toggleAudition(id: string) {
  if (selectedAudition.value === id) {
    selectedAudition.value = null;
    testimonies.value = [];
  } else {
    selectedAudition.value = id;
    testimonies.value = []; // never show the previous audition's rows
    await fetchTestimonies(id);
  }
}

function startEditing(audition: AdminAudition) {
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
  if (!editForm.value.title || !editForm.value.date || !editForm.value.location || !editForm.value.content) {
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

async function handleDelete(id: string) {
  if (!confirm("Êtes-vous sûr de vouloir supprimer cette audition?")) return;
  try {
    await api.del(`/api/auditions/${id}`);
    toast({ title: "Succès!", description: "Audition supprimée" });
    if (selectedAudition.value === id) {
      selectedAudition.value = null;
      testimonies.value = [];
    }
    await fetchAuditions();
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
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

// Analyze every testimony missing topics in the expanded audition.
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
    // The user may have collapsed/switched during the batch.
    if (selectedAudition.value === auditionId) await fetchTestimonies(auditionId);
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

// Analyze every testimony missing topics across all visible auditions.
async function handleAnalyzeAllAuditions() {
  analyzingMultiple.value = true;
  let totalAnalyzed = 0;
  let totalAuditions = 0;
  try {
    for (const audition of visibleAuditions.value) {
      const list = await api.get<Testimony[]>(
        `/api/testimonies/for-audition/${audition.id}`,
        true,
      );
      const missing = list.filter((t) => !t.topics || t.topics.length === 0);
      if (missing.length === 0) continue;
      totalAuditions++;
      totalAnalyzed += await analyzeMissing(list);
    }
    if (selectedAudition.value) await fetchTestimonies(selectedAudition.value);
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
  <section class="admin-card">
    <div class="head">
      <div>
        <h2 class="admin-card-title">Auditions existantes</h2>
        <p class="admin-card-desc">Gérez vos auditions et témoignages</p>
      </div>
      <button
        v-if="auth.isSuperAdmin"
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

    <div class="list">
      <div v-for="audition in visibleAuditions" :key="audition.id" class="item">
        <div class="item-row">
          <div class="item-info">
            <h3 class="item-title">{{ audition.title }}</h3>
            <p class="item-meta">
              {{ formatDateShort(audition.date) }} — {{ audition.location }}
            </p>
            <p class="item-status">
              Statut : {{ audition.status === "published" ? "Publié" : "Brouillon" }}
            </p>
          </div>
          <div class="item-actions">
            <button
              type="button"
              class="ac-btn ac-btn--outline ac-btn--sm ac-btn--icon"
              :title="selectedAudition === audition.id ? 'Replier' : 'Déplier'"
              @click="toggleAudition(audition.id)"
            >
              {{ selectedAudition === audition.id ? "▲" : "▼" }}
            </button>
            <button
              type="button"
              class="ac-btn ac-btn--outline ac-btn--sm ac-btn--icon"
              title="Modifier"
              @click="startEditing(audition)"
            >
              ✎
            </button>
            <button
              type="button"
              class="ac-btn ac-btn--danger ac-btn--sm ac-btn--icon"
              title="Supprimer"
              @click="handleDelete(audition.id)"
            >
              🗑
            </button>
          </div>
        </div>

        <div v-if="selectedAudition === audition.id" class="item-detail">
          <div class="detail-head">
            <h4>Gestion des témoignages</h4>
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
          <TestimonyManager
            :audition-id="audition.id"
            :testimonies="testimonies"
            @update="fetchTestimonies(audition.id)"
          />
        </div>
      </div>

      <p v-if="visibleAuditions.length === 0" class="empty">Aucune audition créée</p>
    </div>

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
          <div class="form-field">
            <label class="form-label" for="edit-aud-date">Date</label>
            <input id="edit-aud-date" v-model="editForm.date" class="form-input" type="date" />
          </div>
          <div class="form-field">
            <label class="form-label">Lieu</label>
            <LocationCombobox v-model="editForm.location" />
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
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.item {
  border: 1px solid hsl(var(--border));
  border-radius: 0.7rem;
  overflow: hidden;
}

.item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.85rem;
  padding: 1rem;
}

.item-title {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: 0.98rem;
  letter-spacing: 0;
  color: hsl(var(--foreground));
}

.item-meta {
  font-size: 0.85rem;
  color: hsl(var(--muted-foreground));
}

.item-status {
  font-size: 0.75rem;
  color: hsl(var(--muted-foreground));
  margin-top: 0.2rem;
}

.item-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.item-detail {
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--muted) / 0.35);
  padding: 1rem;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.85rem;
}

.detail-head h4 {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: 0.95rem;
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
  .item-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
