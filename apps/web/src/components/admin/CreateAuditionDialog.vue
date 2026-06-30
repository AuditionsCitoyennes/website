<script setup lang="ts">
import { ref } from "vue";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import ModalDialog from "@/components/ModalDialog.vue";
import LocationCombobox from "@/components/LocationCombobox.vue";

defineProps<{ open: boolean }>();

const emit = defineEmits<{
  close: [];
  created: [];
}>();

const { toast } = useToast();
const loading = ref(false);

interface DraftTestimony {
  person_name: string;
  person_info: string;
  content: string;
  email: string;
}

const form = ref({
  title: "",
  date: "",
  location: "",
  content: "",
  status: "published" as "published" | "draft",
});
const draftTestimonies = ref<DraftTestimony[]>([]);

function addDraft() {
  draftTestimonies.value.unshift({ person_name: "", person_info: "", content: "", email: "" });
}

function removeDraft(index: number) {
  draftTestimonies.value.splice(index, 1);
}

async function handleCreate() {
  if (!form.value.title || !form.value.date || !form.value.location || !form.value.content) {
    toast({
      title: "Erreur",
      description: "Veuillez remplir tous les champs",
      variant: "destructive",
    });
    return;
  }

  loading.value = true;
  try {
    const result = await api.post<{ emailReport: { success: boolean; failed: number } | null }>(
      "/api/auditions",
      {
        ...form.value,
        testimonies: draftTestimonies.value
          .filter((t) => t.person_name && t.content)
          .map((t) => ({
            person_name: t.person_name,
            person_info: t.person_info || null,
            content: t.content,
            email: t.email || null,
          })),
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
    emit("created");
    emit("close");
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
</script>

<template>
  <ModalDialog
    :open="open"
    title="Nouvelle Audition"
    description="Ajoutez une nouvelle audition citoyenne"
    dismissible
    wide
    @close="emit('close')"
  >
    <div class="form">
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

      <div class="form-field">
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

      <div class="drafts">
        <div class="drafts-head">
          <span class="form-label">Témoignages ({{ draftTestimonies.length }})</span>
          <button type="button" class="ac-btn ac-btn--outline ac-btn--sm" @click="addDraft">
            + Ajouter
          </button>
        </div>

        <div v-for="(t, i) in draftTestimonies" :key="i" class="draft-card">
          <div class="draft-head">
            <span class="draft-title">Témoignage {{ draftTestimonies.length - i }}</span>
            <button
              type="button"
              class="ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon"
              title="Retirer"
              @click="removeDraft(i)"
            >
              🗑
            </button>
          </div>
          <div class="grid-2">
            <div class="form-field">
              <label class="form-label">Nom/Prénom</label>
              <input v-model="t.person_name" class="form-input" placeholder="Ex: Marie" />
            </div>
            <div class="form-field">
              <label class="form-label">Informations (optionnel)</label>
              <input
                v-model="t.person_info"
                class="form-input"
                placeholder="Ex: 45 ans, enseignante"
              />
            </div>
          </div>
          <div class="form-field">
            <label class="form-label">Email (optionnel)</label>
            <input
              v-model="t.email"
              class="form-input"
              type="email"
              placeholder="Ex: marie@email.com"
            />
            <p class="hint">
              Si fourni, un email sera envoyé pour permettre à la personne de valider son
              témoignage.
            </p>
          </div>
          <div class="form-field">
            <label class="form-label">Témoignage</label>
            <textarea
              v-model="t.content"
              class="form-input form-textarea"
              placeholder="Le contenu du témoignage..."
              rows="4"
            ></textarea>
          </div>
        </div>
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
  </ModalDialog>
</template>

<style scoped>
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
  font-size: 0.78rem;
  color: hsl(var(--muted-foreground));
}

.drafts {
  border-top: 1px solid hsl(var(--border));
  padding-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.drafts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.draft-card {
  border: 1px solid hsl(var(--border));
  border-radius: 0.7rem;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  background: hsl(var(--muted) / 0.4);
}

.draft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.draft-title {
  font-weight: 600;
  font-size: 0.92rem;
  color: hsl(var(--foreground));
}
</style>
