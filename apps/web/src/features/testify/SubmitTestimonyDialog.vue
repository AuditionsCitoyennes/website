<script setup lang="ts">
import { ref, watch } from "vue";
import { AUDITION_QUESTIONS, ONLINE_ANSWER_MAX, onlineTestimonySchema } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { vAutogrow } from "@/shared/ui/directives/autogrow";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import { ROUTE } from "@/shared/routes";
import CommuneCombobox, { type Commune } from "./CommuneCombobox.vue";

// "Témoigner": anyone — signed in or not — leaves a testimony. It joins the
// online audition of the month of their commune's town hall, and is published
// only once they have clicked the link sent to their email.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const commune = ref<Commune | null>(null);
const personName = ref("");
const personInfo = ref("");
const email = ref("");
/** One answer per question (AUDITION_QUESTIONS), in order. */
const answers = ref(AUDITION_QUESTIONS.map(() => ""));
const consent = ref(false);
/** Never seen by a person: a robot fills it in. */
const website = ref("");

const sending = ref(false);
const error = ref("");
/** Sent: the "check your email" view, with where it will be published. */
const sent = ref<{ townHall?: string; title?: string; devVerificationUrl?: string } | null>(null);

// When the form was opened: a form sent in under a few seconds is a robot's.
let openedAt = 0;
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    if (openedAt === 0) openedAt = Date.now();
    // Reopened after sending: a fresh form.
    if (sent.value) reset();
  },
  { immediate: true },
);

function reset() {
  commune.value = null;
  personName.value = "";
  personInfo.value = "";
  answers.value = AUDITION_QUESTIONS.map(() => "");
  consent.value = false;
  error.value = "";
  sent.value = null;
  website.value = "";
  // Not even the email: on a shared screen, the next person is someone else.
  email.value = "";
  openedAt = Date.now();
}

/** Characters left for one answer — shown once it gets close. */
const remaining = (i: number) => ONLINE_ANSWER_MAX - answers.value[i].length;

async function submit() {
  if (sending.value) return;
  error.value = "";
  const parsed = onlineTestimonySchema.safeParse({
    email: email.value,
    person_name: personName.value,
    person_info: personInfo.value,
    answers: answers.value,
    commune_code: commune.value?.code ?? "",
    consent: consent.value,
    website: website.value,
    elapsed_ms: Date.now() - openedAt,
  });
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? "Formulaire incomplet";
    return;
  }
  sending.value = true;
  try {
    const result = await api.post<{
      ok: true;
      townHall?: string;
      title?: string;
      devVerificationUrl?: string;
    }>("/api/online-testimonies", parsed.data, false);
    sent.value = {
      townHall: result.townHall,
      title: result.title,
      devVerificationUrl: result.devVerificationUrl,
    };
  } catch (e) {
    error.value =
      e instanceof ApiError ? e.message : "Votre témoignage n'a pas pu être envoyé. Réessayez.";
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <ModalDialog
    :open="open"
    :title="sent ? 'Vérifiez vos emails' : 'Témoigner'"
    :description="
      sent ? undefined : 'Racontez ce que vous vivez : votre témoignage sera publié sur le site.'
    "
    :view-key="sent ? 'sent' : 'form'"
    dismissible
    wide
    :tall="!sent"
    @close="emit('close')"
  >
    <!-- Sent: what happens now. -->
    <div v-if="sent" class="sent">
      <p>
        Un email vient de vous être envoyé à <strong>{{ email }}</strong
        >. Cliquez sur le lien qu'il contient pour valider votre témoignage : il ne sera publié
        qu'ensuite.
      </p>
      <p v-if="sent.townHall" class="muted">
        Il rejoindra l'« {{ sent.title }} » de la {{ sent.townHall }}.
      </p>
      <p class="muted">
        Rien reçu ? Regardez dans vos courriers indésirables. Le lien est valable 14 jours.
      </p>
      <!-- Local development without an email key: the link, right here. -->
      <p v-if="sent.devVerificationUrl" class="dev-link">
        Mode développement : aucun email n'a été envoyé (clé Resend absente).
        <a :href="sent.devVerificationUrl">Ouvrir le lien de validation</a>
      </p>
      <button type="button" class="ac-btn ac-btn--primary ac-btn--block" @click="emit('close')">
        Fermer
      </button>
    </div>

    <form v-else class="form" novalidate @submit.prevent="submit">
      <div class="form-field">
        <label class="form-label" id="testify-commune-label">Votre commune</label>
        <CommuneCombobox v-model="commune" aria-labelledby="testify-commune-label" />
        <p class="hint">
          Votre témoignage sera rattaché à la mairie de votre commune — ou de votre arrondissement,
          à Paris, Lyon et Marseille.
        </p>
      </div>

      <div class="grid-2">
        <div class="form-field">
          <label class="form-label" for="testify-name">Nom/Prénom (optionnel)</label>
          <input
            id="testify-name"
            v-model="personName"
            class="form-input"
            placeholder="Laissé vide : « Anonyme »"
            maxlength="80"
            autocomplete="off"
          />
        </div>
        <div class="form-field">
          <label class="form-label" for="testify-info">Informations (optionnel)</label>
          <input
            id="testify-info"
            v-model="personInfo"
            class="form-input"
            placeholder="Ex: 45 ans, enseignante"
            maxlength="300"
          />
        </div>
      </div>

      <div class="form-field">
        <label class="form-label" for="testify-email">Email</label>
        <input
          id="testify-email"
          v-model="email"
          class="form-input"
          type="email"
          placeholder="Ex: marie@email.com"
          maxlength="254"
          autocomplete="email"
          required
        />
        <p class="hint">
          Pour vous envoyer le lien qui valide votre témoignage. Il n'est jamais publié. Un
          témoignage par semaine et par adresse.
        </p>
      </div>

      <!-- The three questions of an audition: one field each, at least one
           answered. They share the height the other fields leave, and each
           grows past it with what is written. A group, not a fieldset: the
           browser draws a legend in the fieldset's border, out of the flow. -->
      <div
        class="questions fill"
        role="group"
        aria-labelledby="testify-answers-label"
        aria-describedby="testify-answers-hint"
      >
        <div class="questions-head">
          <p id="testify-answers-label" class="form-label">Votre témoignage</p>
          <p id="testify-answers-hint" class="hint">Répondez à une, deux ou aux trois questions.</p>
        </div>
        <div v-for="(question, i) in AUDITION_QUESTIONS" :key="question" class="question">
          <label class="question-label" :for="`testify-answer-${i}`">
            <span class="question-num" aria-hidden="true">{{ i + 1 }}</span>
            {{ question }}
          </label>
          <textarea
            :id="`testify-answer-${i}`"
            v-model="answers[i]"
            v-autogrow
            class="form-input form-textarea"
            rows="3"
            :maxlength="ONLINE_ANSWER_MAX"
          ></textarea>
          <p v-if="remaining(i) < 300" class="hint counter" :class="{ low: remaining(i) < 100 }">
            {{ remaining(i) }} caractères restants
          </p>
        </div>
      </div>

      <!-- For robots only: hidden from people and from the keyboard. -->
      <div class="trap" aria-hidden="true">
        <label for="testify-hp">Laissez ce champ vide</label>
        <input id="testify-hp" v-model="website" type="text" tabindex="-1" autocomplete="off" />
      </div>

      <label class="consent">
        <input v-model="consent" type="checkbox" />
        <span>
          J'ai 15 ans ou plus, ou l'accord d'un parent. J'accepte que mon témoignage, avec le nom et
          les informations que j'ai indiqués et ma commune, soit publié sur ce site après sa
          validation par email, et je sais que mes réponses peuvent révéler mes opinions, notamment
          politiques, à tous ceux qui le liront. Mon email ne sert qu'à cette validation et n'est
          jamais publié. Je peux retirer mon témoignage à tout moment.
        </span>
      </label>
      <!-- New tabs: the form stays as it was filled in. -->
      <p class="consent-links">
        <a :href="ROUTE.privacy.path" target="_blank" rel="noopener">Vos données et vos droits</a>
        <span aria-hidden="true">·</span>
        <a :href="ROUTE.rules.path" target="_blank" rel="noopener">Règles de publication</a>
      </p>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <button type="submit" class="ac-btn ac-btn--primary ac-btn--block" :disabled="sending">
        <span v-if="sending" class="spinner" aria-hidden="true"></span>
        {{ sending ? "Envoi..." : "Envoyer mon témoignage" }}
      </button>
    </form>
  </ModalDialog>
</template>

<style scoped>
/* The popup is as tall as the screen allows (ModalDialog's `tall`): the three
   answers share the height the other fields leave. */
.form {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.fill {
  flex: 1 0 auto;
}

.questions {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  min-width: 0;
}

/* The heading and its hint read as one block, as a label and its field do. */
.questions-head {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.question {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.question-label {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: var(--text-ui);
  font-weight: 600;
  color: hsl(var(--foreground));
}

.question-num {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 50%;
  background: hsl(var(--primary) / 0.14);
  color: hsl(var(--primary));
  font-size: var(--text-caption);
  font-weight: 700;
  transform: translateY(-0.05rem);
}

/* Three lines at least, more when the screen leaves room, and as tall as the
   answer once it runs longer (v-autogrow) — no scrollbar inside. The witness
   can still pull one taller. */
.question .form-textarea {
  flex: 1 0 auto;
  min-height: max(6.4rem, var(--autogrow-h, 0px));
  overflow-y: hidden;
  resize: vertical;
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

.counter {
  text-align: right;
}

.counter.low {
  color: hsl(var(--destructive));
}

.consent {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  font-size: var(--text-body);
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
  cursor: pointer;
}

.consent input {
  flex-shrink: 0;
  width: 1.05rem;
  height: 1.05rem;
  margin-top: 0.1rem;
  accent-color: hsl(var(--primary));
}

/* Under the box, aligned with its text. */
.consent-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
  margin-top: -0.4rem;
  padding-left: 1.65rem;
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}

.consent-links a {
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.error {
  font-size: var(--text-ui);
  color: hsl(var(--destructive));
}

/* Off-screen, not display:none: some robots skip fields they see hidden. */
.trap {
  position: absolute;
  left: -10000px;
  width: 1px;
  height: 1px;
  overflow: hidden;
}

.sent {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  line-height: var(--lh-body);
}

.dev-link {
  padding: 0.6rem 0.8rem;
  border: 1px dashed hsl(var(--border));
  border-radius: 0.6rem;
  font-size: var(--text-ui);
}

.dev-link a {
  color: hsl(var(--primary));
  font-weight: 600;
}

.muted {
  font-size: var(--text-body);
  color: hsl(var(--muted-foreground));
}
</style>
