<script setup lang="ts">
import {
  AUDITION_QUESTIONS,
  ONLINE_ANSWER_MAX,
  ONLINE_TESTIMONY_MAX,
  composeAnswers,
  parseAnswers,
} from "@ac/shared";
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api, ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import { formatDateLong } from "@/shared/format/dates";
import TestimonyText from "@/shared/testimony/TestimonyText.vue";

interface VerifyTestimonyData {
  id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  verification_status: string | null;
  created_at: string | null;
  audition: {
    title: string;
    location: string;
    date: string;
    /** Sent from the site's "Témoigner" form: published only once validated. */
    audition_en_ligne?: boolean;
  } | null;
}

interface Edits {
  person_name: string;
  person_info: string | null;
  content: string;
}

const route = useRoute();
const { toast } = useToast();
const token = String(route.params.token ?? "");

const loading = ref(true);
const processing = ref(false);
const errorMessage = ref<string | null>(null);
const testimony = ref<VerifyTestimonyData | null>(null);
const completed = ref<"verified" | "rejected" | null>(null);
const editing = ref(false);
const pendingEdits = ref<Edits | null>(null);
const editForm = ref({ person_name: "", person_info: "", content: "" });
/** A testimony sent through the form: edited answer by answer (one per
 *  question, in order), and written back as one text. null: as one text. */
const editAnswers = ref<string[] | null>(null);

onMounted(async () => {
  if (!token) {
    errorMessage.value = "Token de vérification manquant";
    loading.value = false;
    return;
  }
  try {
    testimony.value = await api.get<VerifyTestimonyData>(`/api/verify/${token}`);
  } catch (e) {
    errorMessage.value =
      e instanceof ApiError ? e.message : "Témoignage introuvable ou déjà traité";
  } finally {
    loading.value = false;
  }
});

function startEditing() {
  const current = pendingEdits.value ?? testimony.value;
  if (!current) return;
  editForm.value = {
    person_name: current.person_name,
    person_info: current.person_info ?? "",
    content: current.content,
  };
  // Answer by answer only for a testimony sent through the form (its limits are
  // the form's); one noted at an audition is edited as the text it is.
  const answers = testimony.value?.audition?.audition_en_ligne
    ? parseAnswers(current.content)
    : null;
  editAnswers.value = answers
    ? AUDITION_QUESTIONS.map((q) => answers.find((a) => a.question === q)?.answer ?? "")
    : null;
  editing.value = true;
}

function saveEdit() {
  if (editAnswers.value) {
    if (!editAnswers.value.some((a) => a.trim())) {
      toast({
        title: "Erreur",
        description: "Répondez à au moins une des questions",
        variant: "destructive",
      });
      return;
    }
    editForm.value.content = composeAnswers(editAnswers.value);
  }
  if (!editForm.value.person_name || !editForm.value.content) {
    toast({
      title: "Erreur",
      description: "Le nom et le contenu sont requis",
      variant: "destructive",
    });
    return;
  }
  // Staged client-side — sent to the server on "Valider" (the server sanitizes).
  pendingEdits.value = {
    person_name: editForm.value.person_name,
    person_info: editForm.value.person_info || null,
    content: editForm.value.content,
  };
  editing.value = false;
  toast({
    title: "Modifications enregistrées",
    description: 'Cliquez sur "Valider" pour confirmer votre témoignage.',
  });
}

async function handleVerify() {
  processing.value = true;
  try {
    await api.post(
      `/api/verify/${token}`,
      {
        action: "verify",
        ...(pendingEdits.value ? { edits: pendingEdits.value } : {}),
      },
      false,
    );
    completed.value = "verified";
    toast({
      title: "Témoignage validé !",
      description: pendingEdits.value
        ? "Vos modifications ont été enregistrées et votre témoignage sera publié avec un badge vérifié."
        : "Votre témoignage a été validé et sera publié avec un badge vérifié.",
    });
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    processing.value = false;
  }
}

async function handleReject() {
  processing.value = true;
  try {
    await api.post(`/api/verify/${token}`, { action: "reject" }, false);
    completed.value = "rejected";
    toast({
      title: "Témoignage supprimé",
      description: "Votre témoignage a été supprimé de notre base de données.",
    });
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    processing.value = false;
  }
}
</script>

<template>
  <div class="verify container-page">
    <!-- Loading -->
    <div v-if="loading" class="state">
      <span class="spinner spinner-lg" aria-label="Chargement"></span>
    </div>

    <!-- Invalid / expired link -->
    <div v-else-if="errorMessage || !testimony" class="card center-card">
      <div class="icon-circle danger" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="30"
          height="30"
        >
          <path
            d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
          />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <h1 class="card-title">Lien invalide</h1>
      <p class="card-desc">
        {{
          errorMessage ||
          "Ce lien de vérification n'est plus valide ou le témoignage a déjà été traité."
        }}
      </p>
      <RouterLink to="/" class="ac-btn ac-btn--outline">Retour à l'accueil</RouterLink>
    </div>

    <!-- Already processed -->
    <div
      v-else-if="testimony.verification_status !== 'pending' && !completed"
      class="card center-card"
    >
      <h1 class="card-title">Témoignage déjà traité</h1>
      <p class="card-desc">
        Ce témoignage a déjà été
        {{ testimony.verification_status === "verified" ? "validé" : "refusé" }}.
      </p>
      <RouterLink to="/" class="ac-btn ac-btn--outline">Retour à l'accueil</RouterLink>
    </div>

    <!-- Done -->
    <div v-else-if="completed" class="card center-card">
      <div
        class="icon-circle"
        :class="completed === 'verified' ? 'success' : 'danger'"
        aria-hidden="true"
      >
        <svg
          v-if="completed === 'verified'"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="30"
          height="30"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="30"
          height="30"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </div>
      <h1 class="card-title">
        {{ completed === "verified" ? "Merci pour votre validation !" : "Témoignage supprimé" }}
      </h1>
      <p class="card-desc">
        {{
          completed !== "verified"
            ? testimony?.audition?.audition_en_ligne
              ? "Votre témoignage a été supprimé. Vous pouvez en envoyer un nouveau dès maintenant."
              : "Votre témoignage a été retiré de notre base de données."
            : testimony?.audition?.audition_en_ligne
              ? "Votre témoignage est maintenant publié sur notre site."
              : 'Votre témoignage apparaîtra désormais avec un badge "Vérifié" sur notre site.'
        }}
      </p>
      <RouterLink to="/" class="ac-btn ac-btn--outline">Retour à l'accueil</RouterLink>
    </div>

    <!-- Main review view -->
    <template v-else>
      <header class="page-head">
        <h1>Vérification</h1>
        <p class="lead">Veuillez vérifier et valider votre témoignage</p>
      </header>

      <div class="card">
        <!-- Ternary on the pendingEdits OBJECT: a cleared field must show as
             cleared in the preview, not fall back to the original value. -->
        <header class="t-head">
          <div class="who">
            <h2 class="t-name">
              {{ pendingEdits ? pendingEdits.person_name : testimony.person_name }}
            </h2>
            <p
              v-if="pendingEdits ? pendingEdits.person_info : testimony.person_info"
              class="t-info"
            >
              {{ pendingEdits ? pendingEdits.person_info : testimony.person_info }}
            </p>
          </div>
          <div class="badges">
            <span v-if="pendingEdits" class="chip chip--outline">Modifié</span>
            <span class="chip">En attente</span>
          </div>
        </header>

        <!-- An online audition is a month at a town hall: its title says
             which month, where a date (the 1st) would mislead. -->
        <p v-if="testimony.audition?.audition_en_ligne" class="t-meta">
          {{ testimony.audition.title }}
          <span class="dot">·</span>
          {{ testimony.audition.location }}
        </p>
        <p v-else-if="testimony.audition" class="t-meta">
          {{ testimony.audition.location }}
          <span class="dot">·</span>
          {{ formatDateLong(testimony.audition.date) }}
        </p>

        <!-- Edit form -->
        <div v-if="editing" class="edit-form">
          <div class="grid-2">
            <div class="form-field">
              <label class="form-label" for="v-name">Nom/Prénom</label>
              <input
                id="v-name"
                v-model="editForm.person_name"
                class="form-input"
                :maxlength="testimony.audition?.audition_en_ligne ? 80 : 200"
              />
            </div>
            <div class="form-field">
              <label class="form-label" for="v-info">Informations (optionnel)</label>
              <input
                id="v-info"
                v-model="editForm.person_info"
                class="form-input"
                placeholder="Ex: 45 ans, enseignante"
                :maxlength="testimony.audition?.audition_en_ligne ? 300 : 500"
              />
            </div>
          </div>
          <template v-if="editAnswers">
            <div v-for="(question, i) in AUDITION_QUESTIONS" :key="question" class="form-field">
              <label class="form-label" :for="`v-answer-${i}`">{{ question }}</label>
              <textarea
                :id="`v-answer-${i}`"
                v-model="editAnswers[i]"
                class="form-input form-textarea"
                rows="4"
                :maxlength="ONLINE_ANSWER_MAX"
              ></textarea>
            </div>
          </template>
          <div v-else class="form-field">
            <label class="form-label" for="v-content">Témoignage</label>
            <textarea
              id="v-content"
              v-model="editForm.content"
              class="form-input form-textarea"
              rows="8"
              :maxlength="testimony.audition?.audition_en_ligne ? ONLINE_TESTIMONY_MAX : 20000"
            ></textarea>
          </div>
          <div class="edit-actions">
            <button type="button" class="ac-btn ac-btn--primary" @click="saveEdit">
              Enregistrer
            </button>
            <button type="button" class="ac-btn ac-btn--outline" @click="editing = false">
              Annuler
            </button>
          </div>
        </div>

        <!-- Read view -->
        <div v-else class="content-box">
          <TestimonyText
            :content="pendingEdits ? pendingEdits.content : testimony.content"
            as="p"
            text-class="t-content"
          />
        </div>
      </div>

      <div v-if="!editing" class="actions">
        <button
          type="button"
          class="ac-btn ac-btn--primary"
          :disabled="processing"
          @click="handleVerify"
        >
          <span v-if="processing" class="spinner"></span>
          Valider
        </button>
        <button
          type="button"
          class="ac-btn ac-btn--outline"
          :disabled="processing"
          @click="startEditing"
        >
          Modifier
        </button>
        <button
          type="button"
          class="ac-btn ac-btn--danger"
          :disabled="processing"
          @click="handleReject"
        >
          <span v-if="processing" class="spinner"></span>
          Supprimer
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.verify {
  max-width: 720px;
  padding-block: 2.5rem 4rem;
}

.state {
  display: flex;
  justify-content: center;
  padding: 4rem;
}

.page-head {
  text-align: center;
  margin-bottom: 1.8rem;
}

.page-head h1 {
  font-size: var(--text-page);
  text-transform: uppercase;
  color: hsl(var(--foreground));
}

.lead {
  font-size: var(--text-lead);
  color: hsl(var(--muted-foreground));
  margin-top: 0.4rem;
}

.card {
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 0.9rem;
  box-shadow: var(--shadow-md);
  padding: 1.6rem;
  margin-bottom: 1.5rem;
}

.center-card {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.9rem;
  margin-top: 2.5rem;
}

.icon-circle {
  display: grid;
  place-items: center;
  width: 4.2rem;
  height: 4.2rem;
  border-radius: 50%;
}

.icon-circle.success {
  background: hsl(var(--civic-green) / 0.12);
  color: hsl(var(--civic-green));
}

.icon-circle.danger {
  background: hsl(var(--destructive) / 0.12);
  color: hsl(var(--destructive));
}

.card-title {
  font-size: var(--text-section);
  text-transform: uppercase;
  color: hsl(var(--foreground));
}

.card-desc {
  color: hsl(var(--muted-foreground));
  max-width: 420px;
}

.t-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.9rem;
}

.t-name {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: var(--text-ui);
  letter-spacing: 0;
  line-height: 1.3; /* the h2's Bebas 1.05 crowds a wrapped sans name */
  color: hsl(var(--foreground));
}

.t-info {
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
  margin-top: 0.15rem;
}

.badges {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.t-meta {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  margin-top: 0.6rem;
}

.dot {
  opacity: 0.5;
}

.content-box {
  margin-top: 1.1rem;
  padding: 1.25rem;
  border-radius: 0.7rem;
  background: hsl(var(--accent) / 0.3);
  border: 1px solid hsl(var(--border) / 0.5);
}

.content-box :deep(.t-content) {
  margin: 0;
  color: hsl(var(--foreground) / 0.88);
  line-height: var(--lh-body);
  white-space: pre-wrap;
}

.edit-form {
  margin-top: 1.1rem;
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

.edit-actions {
  display: flex;
  gap: 0.6rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.8rem;
}
</style>
