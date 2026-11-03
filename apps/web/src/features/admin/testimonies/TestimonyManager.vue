<script setup lang="ts">
import { ref } from "vue";
import type { Testimony } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import { useAuthStore } from "@/features/auth";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import TestimonyEditDialog from "./TestimonyEditDialog.vue";
import WitnessConsentNote from "./WitnessConsentNote.vue";

const props = defineProps<{
  auditionId: string;
  testimonies: Testimony[];
  /** An online audition: a testimony is published only once validated by email. */
  online?: boolean;
  /**
   * Its last testimony deleted, the audition is gone too. A callback, not an
   * event: the popup may have been closed (and this component unmounted)
   * while the deletion was on its way, and the list must hear of it anyway.
   */
  onAuditionDeleted?: (auditionId: string) => void;
}>();

const emit = defineEmits<{
  update: [];
}>();

const { toast } = useToast();
const auth = useAuthStore();

const loading = ref(false);
// Set: several analyses can be in flight at once.
const analyzing = ref(new Set<string>());
const addDialogOpen = ref(false);
const editDialogOpen = ref(false);
const editingTestimony = ref<Testimony | null>(null);
const newTestimony = ref({ person_name: "", person_info: "", content: "", email: "" });

const isVerified = (t: Testimony) => t.verification_status === "verified";
const isMine = (t: Testimony) => t.created_by === auth.user?.id;

// Once its witness has verified it, a testimony is theirs: nobody edits it any
// more, super admins included (the API refuses it too).
function canEdit(t: Testimony): boolean {
  return !isVerified(t) && (auth.isSuperAdmin || isMine(t));
}

// Removing one stays possible (a witness may ask for it): for a super admin
// always, for its author as long as it is not verified.
function canDelete(t: Testimony): boolean {
  return auth.isSuperAdmin || (isMine(t) && !isVerified(t));
}

async function handleAdd() {
  if (!newTestimony.value.person_name || !newTestimony.value.content) {
    toast({
      title: "Erreur",
      description: "Le nom et le contenu sont requis",
      variant: "destructive",
    });
    return;
  }
  if (props.online && !newTestimony.value.email) {
    toast({
      title: "Erreur",
      description:
        "Un email est requis : un témoignage d'audition en ligne n'est publié qu'une fois validé par email.",
      variant: "destructive",
    });
    return;
  }
  if (newTestimony.value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newTestimony.value.email)) {
    toast({
      title: "Erreur",
      description: "L'adresse email n'est pas valide",
      variant: "destructive",
    });
    return;
  }

  loading.value = true;
  try {
    const result = await api.post<{ emailSent: boolean; emailError: string | null }>(
      "/api/testimonies",
      {
        audition_id: props.auditionId,
        person_name: newTestimony.value.person_name,
        person_info: newTestimony.value.person_info || null,
        content: newTestimony.value.content,
        email: newTestimony.value.email || null,
      },
    );
    if (newTestimony.value.email && !result.emailSent) {
      toast({
        title: "Attention",
        description: "Témoignage ajouté mais l'email de vérification n'a pas pu être envoyé",
        variant: "destructive",
      });
    } else if (newTestimony.value.email) {
      toast({ title: "Succès!", description: "Témoignage ajouté et email de vérification envoyé" });
    } else {
      toast({ title: "Succès!", description: "Témoignage ajouté" });
    }
    newTestimony.value = { person_name: "", person_info: "", content: "", email: "" };
    addDialogOpen.value = false;
    emit("update");
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    loading.value = false;
  }
}

async function handleDelete(id: string) {
  // An audition never outlives its last testimony: said before, not after.
  const question =
    props.testimonies.length === 1
      ? "C'est le dernier témoignage de cette audition : l'audition sera supprimée avec lui. Continuer ?"
      : "Êtes-vous sûr de vouloir supprimer ce témoignage?";
  if (!confirm(question)) return;
  const auditionId = props.auditionId;
  try {
    const result = await api.del<{ auditionDeleted?: boolean } | undefined>(
      `/api/testimonies/${id}`,
    );
    if (result?.auditionDeleted) {
      toast({
        title: "Succès!",
        description: "Témoignage supprimé, et l'audition avec lui : elle n'en avait plus d'autre",
      });
      props.onAuditionDeleted?.(auditionId);
      return;
    }
    toast({ title: "Succès!", description: "Témoignage supprimé" });
    emit("update");
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  }
}

function openEdit(t: Testimony) {
  editingTestimony.value = t;
  editDialogOpen.value = true;
}

async function handleAnalyze(t: Testimony) {
  analyzing.value.add(t.id);
  try {
    const { topics } = await api.post<{ topics: string[] }>(`/api/testimonies/${t.id}/analyze`);
    if (topics.length > 0) {
      toast({ title: "Analyse terminée", description: `${topics.length} thèmes identifiés` });
      emit("update");
    } else {
      toast({
        title: "Aucun thème",
        description: "Aucun thème n'a été identifié dans ce témoignage",
      });
    }
  } catch (e) {
    toast({
      title: "Erreur d'analyse",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    analyzing.value.delete(t.id);
  }
}
</script>

<template>
  <div class="manager">
    <button
      type="button"
      class="ac-btn ac-btn--primary ac-btn--block"
      @click="addDialogOpen = true"
    >
      + Ajouter un témoignage
    </button>

    <ModalDialog
      :open="addDialogOpen"
      title="Ajouter un témoignage"
      description="Ajoutez un nouveau témoignage à cette audition"
      dismissible
      @close="addDialogOpen = false"
    >
      <div class="form">
        <WitnessConsentNote />
        <div class="grid-2">
          <div class="form-field">
            <label class="form-label" for="add-name">Nom/Prénom</label>
            <input
              id="add-name"
              v-model="newTestimony.person_name"
              class="form-input"
              placeholder="Ex: Marie, ou Anonyme"
            />
          </div>
          <div class="form-field">
            <label class="form-label" for="add-info">Informations (optionnel)</label>
            <input
              id="add-info"
              v-model="newTestimony.person_info"
              class="form-input"
              placeholder="Ex: 45 ans, enseignante"
            />
          </div>
        </div>
        <div class="form-field">
          <label class="form-label" for="add-email">
            {{ online ? "Email (obligatoire)" : "Email (optionnel)" }}
          </label>
          <input
            id="add-email"
            v-model="newTestimony.email"
            class="form-input"
            type="email"
            placeholder="Ex: marie@email.com"
          />
          <p class="hint">
            Si fourni, un email sera envoyé pour permettre à la personne de valider son témoignage.
          </p>
        </div>
        <div class="form-field">
          <label class="form-label" for="add-content">Témoignage</label>
          <textarea
            id="add-content"
            v-model="newTestimony.content"
            class="form-input form-textarea"
            placeholder="Le contenu du témoignage..."
            rows="4"
          ></textarea>
        </div>
        <button
          type="button"
          class="ac-btn ac-btn--primary ac-btn--block"
          :disabled="loading"
          @click="handleAdd"
        >
          {{ loading ? "Ajout..." : "Ajouter le témoignage" }}
        </button>
      </div>
    </ModalDialog>

    <div v-if="testimonies.length > 0" class="list">
      <article v-for="t in testimonies" :key="t.id" class="t-card">
        <header class="t-head">
          <div class="t-meta">
            <p class="t-name">{{ t.person_name }}</p>
            <p v-if="t.person_info" class="t-info">{{ t.person_info }}</p>
            <div class="t-chips">
              <span
                v-if="t.verification_status === 'verified'"
                class="chip chip--green"
                title="Vérifié par son auteur : ce témoignage ne peut plus être modifié"
                >Vérifié</span
              >
              <span v-else-if="t.verification_status === 'pending'" class="chip chip--outline"
                >En attente</span
              >
              <span
                v-else-if="online"
                class="chip chip--outline"
                title="Sans validation par email, un témoignage d'audition en ligne n'est pas publié"
                >Non publié</span
              >
              <span
                v-if="auth.isSuperAdmin && (!t.topics || t.topics.length === 0)"
                class="chip chip--red"
              >
                Non analysé
              </span>
            </div>
          </div>
          <div class="t-actions">
            <button
              v-if="canEdit(t)"
              type="button"
              class="ac-btn ac-btn--outline ac-btn--sm ac-btn--icon"
              title="Modifier"
              @click="openEdit(t)"
            >
              ✎
            </button>
            <button
              v-if="auth.isSuperAdmin"
              type="button"
              class="ac-btn ac-btn--outline ac-btn--sm ac-btn--icon"
              title="Analyser"
              :disabled="analyzing.has(t.id)"
              @click="handleAnalyze(t)"
            >
              <span v-if="analyzing.has(t.id)" class="spinner"></span>
              <span v-else>✦</span>
            </button>
            <button
              v-if="canDelete(t)"
              type="button"
              class="ac-btn ac-btn--danger ac-btn--sm ac-btn--icon"
              title="Supprimer"
              @click="handleDelete(t.id)"
            >
              🗑
            </button>
          </div>
        </header>
        <p class="t-content">{{ t.content }}</p>
        <div v-if="t.topics && t.topics.length > 0" class="t-topics">
          <span v-for="topic in t.topics" :key="topic" class="chip">{{ topic }}</span>
        </div>
      </article>
    </div>

    <TestimonyEditDialog
      :open="editDialogOpen"
      :testimony="editingTestimony"
      @close="editDialogOpen = false"
      @updated="emit('update')"
    />
  </div>
</template>

<style scoped>
.manager {
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
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

.hint {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.list {
  display: flex;
  flex-direction: column;
}

/* One after the other across the popup's full width, a line between two — not
   a box each: boxes inside the popup only cost the text its width. */
.t-card {
  padding-block: 1rem;
}

.t-card + .t-card {
  border-top: 1px solid hsl(var(--border));
}

.t-card:first-child {
  padding-top: 0;
}

.t-card:last-child {
  padding-bottom: 0;
}

.t-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
}

.t-name {
  font-weight: 600;
  font-size: var(--text-ui);
  color: hsl(var(--foreground));
}

.t-info {
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}

.t-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.4rem;
}

.t-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.t-content {
  font-size: var(--text-body);
  color: hsl(var(--muted-foreground));
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 0.6rem;
  white-space: pre-line;
}

.t-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
</style>
