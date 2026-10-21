<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { testimonyInputSchema } from "@ac/shared";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import ModalDialog from "@/components/ModalDialog.vue";
import LocationCombobox from "@/components/LocationCombobox.vue";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
  close: [];
  created: [];
}>();

const { toast } = useToast();
const loading = ref(false);

interface DraftTestimony {
  /** Stable identity (the position changes when one is removed). */
  key: number;
  person_name: string;
  person_info: string;
  content: string;
  email: string;
}

// The dialog is a row of views, one at a time: the audition first, then ONE
// VIEW PER TESTIMONY. "Ajouter un témoignage" opens the first testimony,
// "Ajouter un autre témoignage" a new view for the next one, and the arrow at
// the top left goes back one view. The audition is created from any testimony.
/** 0: the audition. n: the nth testimony. */
const step = ref(0);
const viewsEl = ref<HTMLElement | null>(null);
// Which way the view being shown comes in: from the right when moving on, from
// the left when going back.
const slide = ref<"view-next" | "view-prev">("view-next");
// Bumped when a change of view puts a button that DOES something under the
// pointer ("Créer l'audition", "+ Ajouter…", the trash): the dialog then
// ignores the 2nd click of a double-click (see ModalDialog's `viewKey`).
// Plain paging — back, "suivant" — is left alone, so it can be clicked fast.
const guard = ref(0);

const form = ref({
  title: "",
  date: "",
  location: "",
  content: "",
  status: "published" as "published" | "draft",
});
const draftTestimonies = ref<DraftTestimony[]>([]);
let nextDraftKey = 1;

const blankDraft = (): DraftTestimony => ({
  key: nextDraftKey++,
  person_name: "",
  person_info: "",
  content: "",
  email: "",
});

/** The testimony of the view being shown (none on the audition's view). */
const current = computed(() =>
  step.value > 0 ? (draftTestimonies.value[step.value - 1] ?? null) : null,
);
const isLastTestimony = computed(() => step.value === draftTestimonies.value.length);

/** A draft nothing was typed into: ignored when the audition is created. */
const isBlank = (t: DraftTestimony) =>
  !t.person_name.trim() && !t.person_info.trim() && !t.content.trim() && !t.email.trim();

/** The testimonies that will be created with the audition. */
const filledCount = computed(() => draftTestimonies.value.filter((t) => !isBlank(t)).length);

function fail(description: string) {
  toast({ title: "Erreur", description, variant: "destructive" });
}

function auditionIsComplete(): boolean {
  const { title, date, location, content } = form.value;
  return Boolean(title.trim() && date && location.trim() && content.trim());
}

/** What the API will receive for a testimony. */
const payloadOf = (t: DraftTestimony) => ({
  person_name: t.person_name,
  person_info: t.person_info || null,
  content: t.content,
  email: t.email.trim() || null,
});

/** What is wrong with a testimony that was started, if anything. Checked with
 *  the API's own rules, so that what passes here is not refused there — where
 *  the refusal could not say which testimony it is about. */
function problemWith(t: DraftTestimony): string | null {
  if (!t.person_name.trim() || !t.content.trim()) return "le nom et le contenu sont requis";
  const parsed = testimonyInputSchema.safeParse(payloadOf(t));
  if (parsed.success) return null;
  const field = parsed.error.issues[0]?.path[0];
  if (field === "person_name") return "le nom est trop long (200 caractères au plus)";
  if (field === "person_info") {
    return "les informations sont trop longues (500 caractères au plus)";
  }
  return "l'adresse email n'est pas valide";
}

/** Shows a view, from its top. The cursor goes in the testimony's first field
 *  when it is still empty — otherwise on the dialog itself, as when it opens:
 *  the button that changed the view is gone, and the focus must not be left on
 *  the page behind. */
async function goTo(n: number) {
  slide.value = n < step.value ? "view-prev" : "view-next";
  step.value = n;
  await nextTick();
  const dialog = viewsEl.value?.closest<HTMLElement>(".dialog");
  dialog?.scrollTo({ top: 0 });
  const t = current.value;
  // The visible one: the view just left may still be in the page for a frame.
  const field =
    t && isBlank(t)
      ? [...(viewsEl.value?.querySelectorAll<HTMLElement>("#draft-name") ?? [])].find(
          (f) => f.offsetParent !== null,
        )
      : null;
  (field ?? dialog)?.focus({ preventScroll: true });
}

async function showTestimonies() {
  if (!auditionIsComplete()) {
    fail("Veuillez remplir tous les champs de l'audition");
    return;
  }
  // A first, empty one to fill in. Coming back here later shows them as left.
  if (draftTestimonies.value.length === 0) draftTestimonies.value.push(blankDraft());
  guard.value++;
  await goTo(1);
}

/** The arrow: one view back (the previous testimony, then the audition). */
async function back() {
  if (step.value > 0) await goTo(step.value - 1);
}

/** Onwards from a testimony: to the next one if there is one already (after
 *  coming back), otherwise to a new, empty one. */
async function forward() {
  const t = current.value;
  if (!t) return;
  // Moving on leaves this view: what is wrong with it is said here and now.
  // (Left entirely empty, it may only be stepped over, not followed by a new one.)
  const problem = isBlank(t) && !isLastTestimony.value ? null : problemWith(t);
  if (problem) {
    fail(problem.charAt(0).toUpperCase() + problem.slice(1));
    return;
  }
  if (isLastTestimony.value) draftTestimonies.value.push(blankDraft());
  // Onto the last one, where the same button adds yet another: guarded.
  if (step.value + 1 === draftTestimonies.value.length) guard.value++;
  await goTo(step.value + 1);
}

/** Drops the testimony being shown; its neighbour takes the view. */
async function removeCurrent() {
  if (draftTestimonies.value.length < 2 || step.value < 1) return;
  draftTestimonies.value.splice(step.value - 1, 1);
  guard.value++;
  await goTo(Math.min(step.value, draftTestimonies.value.length));
}

async function handleCreate() {
  if (loading.value) return;
  if (!auditionIsComplete()) {
    fail("Veuillez remplir tous les champs de l'audition");
    guard.value++;
    await goTo(0);
    return;
  }
  // A testimony that was started is not dropped in silence: it is complete, or
  // the audition is not created yet. (One left entirely empty is ignored.)
  const testimonies = draftTestimonies.value.filter((t) => !isBlank(t));
  for (const t of testimonies) {
    const problem = problemWith(t);
    if (problem) {
      const n = draftTestimonies.value.indexOf(t) + 1;
      fail(`Témoignage ${n} : ${problem}`);
      if (n !== step.value) {
        guard.value++;
        await goTo(n);
      }
      return;
    }
  }

  loading.value = true;
  try {
    const result = await api.post<{ emailReport: { success: boolean; failed: number } | null }>(
      "/api/auditions",
      {
        ...form.value,
        testimonies: testimonies.map(payloadOf),
      },
    );
    toast({ title: "Succès!", description: "Audition créée avec succès" });
    if (result.emailReport && !result.emailReport.success) {
      toast({
        title: "Attention",
        description: `${result.emailReport.failed} email(s) de vérification n'ont pas pu être envoyés`,
        variant: "destructive",
      });
    }
    form.value = { title: "", date: "", location: "", content: "", status: "published" };
    draftTestimonies.value = [];
    step.value = 0;
    emit("created");
    emit("close");
  } catch (e) {
    fail(e instanceof ApiError ? e.message : "Une erreur est survenue");
  } finally {
    loading.value = false;
  }
}

// Reopened, the dialog starts on the audition again — with whatever had been
// typed before it was closed, testimonies included.
watch(
  () => props.open,
  (open) => {
    if (open) step.value = 0;
  },
);

const title = computed(() => {
  if (step.value === 0) return "Nouvelle Audition";
  const total = draftTestimonies.value.length;
  return total > 1 ? `Témoignage ${step.value} sur ${total}` : "Témoignage";
});
</script>

<template>
  <ModalDialog
    :open="open"
    :title="title"
    :description="
      step === 0 ? 'Ajoutez une nouvelle audition citoyenne' : `Audition « ${form.title} »`
    "
    :view-key="String(guard)"
    dismissible
    wide
    tall
    @close="emit('close')"
  >
    <template v-if="step > 0" #lead>
      <button
        type="button"
        class="ac-btn ac-btn--ghost ac-btn--icon ac-btn--sm back"
        :title="step === 1 ? 'Retour à l\'audition' : 'Témoignage précédent'"
        :aria-label="step === 1 ? 'Retour à l\'audition' : 'Témoignage précédent'"
        :disabled="loading"
        @click="back"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
      </button>
    </template>

    <!-- One view at a time, sliding in from the side it is reached from. -->
    <div ref="viewsEl" class="views">
      <Transition :name="slide">
        <!-- The audition -->
        <div v-if="!current" key="audition" class="form">
          <div class="form-field">
            <label class="form-label" for="aud-title">Titre</label>
            <input
              id="aud-title"
              v-model="form.title"
              class="form-input"
              placeholder="Ex: Audition citoyenne du marché des Gratte-Ciel"
            />
          </div>

          <div class="grid-2">
            <div class="form-field">
              <label class="form-label" for="aud-date">Date</label>
              <input id="aud-date" v-model="form.date" class="form-input" type="date" />
            </div>
            <div class="form-field">
              <label class="form-label">Lieu</label>
              <LocationCombobox v-model="form.location" placeholder="Ex: Villeurbanne" />
            </div>
          </div>

          <div class="form-field fill">
            <label class="form-label" for="aud-content">Contexte de l'audition</label>
            <textarea
              id="aud-content"
              v-model="form.content"
              class="form-input form-textarea"
              placeholder="Décrivez l'audition..."
              rows="4"
            ></textarea>
          </div>

          <div class="form-field">
            <label class="form-label" for="aud-status">Statut</label>
            <select id="aud-status" v-model="form.status" class="form-input">
              <option value="published">Publié</option>
              <option value="draft">Brouillon</option>
            </select>
          </div>

          <button
            type="button"
            class="ac-btn ac-btn--primary ac-btn--block"
            @click="showTestimonies"
          >
            {{
              filledCount > 0
                ? `Reprendre les témoignages (${filledCount})`
                : "Ajouter un témoignage"
            }}
          </button>
        </div>

        <!-- One testimony (keyed: each one gets fields of its own), and the creation -->
        <div v-else :key="current.key" class="form">
          <div class="grid-2">
            <div class="form-field">
              <label class="form-label" for="draft-name">Nom/Prénom</label>
              <input
                id="draft-name"
                v-model="current.person_name"
                class="form-input"
                placeholder="Ex: Marie"
              />
            </div>
            <div class="form-field">
              <label class="form-label" for="draft-info">Informations (optionnel)</label>
              <input
                id="draft-info"
                v-model="current.person_info"
                class="form-input"
                placeholder="Ex: 45 ans, enseignante"
              />
            </div>
          </div>
          <div class="form-field">
            <label class="form-label" for="draft-email">Email (optionnel)</label>
            <input
              id="draft-email"
              v-model="current.email"
              class="form-input"
              type="email"
              placeholder="Ex: marie@email.com"
            />
            <p class="hint">
              Si fourni, un email sera envoyé pour permettre à la personne de valider son
              témoignage.
            </p>
          </div>
          <div class="form-field fill">
            <label class="form-label" for="draft-content">Témoignage</label>
            <textarea
              id="draft-content"
              v-model="current.content"
              class="form-input form-textarea"
              placeholder="Le contenu du témoignage..."
              rows="4"
            ></textarea>
          </div>

          <div class="foot">
            <div class="foot-row">
              <!-- Only once there is more than one: a single one is simply left
               empty to create the audition without it. -->
              <button
                v-if="draftTestimonies.length > 1"
                type="button"
                class="ac-btn ac-btn--outline ac-btn--icon"
                title="Retirer ce témoignage"
                aria-label="Retirer ce témoignage"
                :disabled="loading"
                @click="removeCurrent"
              >
                🗑
              </button>
              <button
                type="button"
                class="ac-btn ac-btn--outline foot-main"
                :disabled="loading"
                @click="forward"
              >
                {{ isLastTestimony ? "+ Ajouter un autre témoignage" : "Témoignage suivant →" }}
              </button>
            </div>
            <button
              type="button"
              class="ac-btn ac-btn--primary ac-btn--block"
              :disabled="loading"
              @click="handleCreate"
            >
              {{ loading ? "Création..." : "Créer l'audition" }}
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* The popup is as tall as the screen allows (ModalDialog's `tall`), and each
   view fills it: the short fields keep their size, and the long text — the
   audition's context, a testimony — takes all the height that is left. */
.form {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.fill {
  flex: 1 0 auto;
}

/* Never less than its own four lines (`rows`), which is what it was before it
   stretched: a screen the form used to fit on still shows it whole, and on one
   too short for it the popup scrolls, as it did. No resize handle — it already
   has all the room. */
.fill .form-textarea {
  flex: 1 0 auto;
  resize: none;
}

/* The views slide in: from the right when moving on, from the left when going
   back — the same move as the levels of the Témoignages panel. Clipped
   sideways, so the arriving view does not give the popup a scrollbar; the
   clip sits a little outside the fields, to leave their focus ring whole. */
.views {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  overflow-x: clip;
  margin-inline: -0.5rem;
  padding-inline: 0.5rem;
}

.view-next-enter-active,
.view-prev-enter-active {
  transition:
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.35s ease;
}

.view-next-enter-from {
  opacity: 0;
  transform: translateX(28px);
}

.view-prev-enter-from {
  opacity: 0;
  transform: translateX(-28px);
}

/* Only the arriving view moves. The one being left goes at once: two forms on
   top of each other, even for a moment, would make the popup jump. */
.view-next-leave-active,
.view-prev-leave-active {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .view-next-enter-active,
  .view-prev-enter-active {
    transition: none;
  }
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

/* Pulled into the dialog's padding like the close cross opposite, so the arrow
   sits in the corner rather than level with the form's left edge. */
.back {
  flex-shrink: 0;
  margin: -0.45rem 0 0 -0.5rem;
  color: hsl(var(--muted-foreground));
}

.back:hover:not(:disabled) {
  color: hsl(var(--foreground));
}

.foot {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.foot-row {
  display: flex;
  gap: 0.6rem;
}

.foot-main {
  flex: 1;
  min-width: 0;
}
</style>
