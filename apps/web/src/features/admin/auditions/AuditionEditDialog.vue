<script setup lang="ts">
import { ref, watch } from "vue";
import type { BanPick } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import LocationCombobox, { type LocationPick } from "./LocationCombobox.vue";
import type { AdminAudition } from "./useAdminAuditions";

// The audition's edit form, opened from its popup: seeded from the audition
// when it opens, saved with a PATCH. An online audition keeps its date and
// place: they are shown, not editable.

const props = defineProps<{
  open: boolean;
  /** The audition being edited (the form is seeded from it when the dialog opens). */
  audition: AdminAudition | null;
}>();

const emit = defineEmits<{
  close: [];
  /** Saved: the list fetches its auditions again. */
  updated: [];
}>();

const { toast } = useToast();

const form = ref({
  title: "",
  date: "",
  location: "",
  content: "",
  status: "published" as "published" | "draft",
});

/** The audition being edited is an online one (its date and place are fixed). */
const editingOnline = ref(false);

/** The address picked in this dialog: the audition is placed there. */
const pick = ref<BanPick | null>(null);

function onPick({ label, ...where }: LocationPick) {
  pick.value = label === form.value.location ? { kind: "ban", ...where } : null;
}

watch(
  () => [props.audition, props.open] as const,
  ([audition, open]) => {
    if (audition && open) {
      editingOnline.value = Boolean(audition.audition_en_ligne);
      pick.value = null;
      form.value = {
        title: audition.title,
        date: audition.date,
        location: audition.location,
        content: audition.content,
        status: (audition.status ?? "published") as "published" | "draft",
      };
    }
  },
  { immediate: true },
);

const saving = ref(false);

async function handleUpdate() {
  if (!props.audition || saving.value) return;
  if (!form.value.title || !form.value.date || !form.value.location || !form.value.content) {
    toast({
      title: "Erreur",
      description: "Veuillez remplir tous les champs",
      variant: "destructive",
    });
    return;
  }
  saving.value = true;
  try {
    await api.patch(`/api/auditions/${props.audition.id}`, {
      ...form.value,
      ...(pick.value && !editingOnline.value ? { place: pick.value } : {}),
    });
    toast({ title: "Succès!", description: "Audition modifiée" });
    emit("close");
    emit("updated");
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ModalDialog
    :open="open"
    title="Modifier l'audition"
    description="Modifiez les informations de l'audition"
    dismissible
    wide
    @close="emit('close')"
  >
    <div class="form">
      <div class="form-field">
        <label class="form-label" for="edit-aud-title">Titre</label>
        <input id="edit-aud-title" v-model="form.title" class="form-input" />
      </div>
      <div class="grid-2">
        <!-- An online audition's month and town hall are fixed (the next
             testimony finds it by them): shown, not editable. -->
        <div class="form-field">
          <label class="form-label" for="edit-aud-date">Date</label>
          <input
            id="edit-aud-date"
            v-model="form.date"
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
            :value="form.location"
            disabled
            aria-label="Lieu"
          />
          <LocationCombobox v-else v-model="form.location" @pick="onPick" />
        </div>
      </div>
      <div class="form-field">
        <label class="form-label" for="edit-aud-content">Contexte de l'audition</label>
        <textarea
          id="edit-aud-content"
          v-model="form.content"
          class="form-input form-textarea"
          rows="4"
        ></textarea>
      </div>
      <div class="form-field">
        <label class="form-label" for="edit-aud-status">Statut</label>
        <select id="edit-aud-status" v-model="form.status" class="form-input">
          <option value="published">Publié</option>
          <option value="draft">Brouillon</option>
        </select>
      </div>
      <button
        type="button"
        class="ac-btn ac-btn--primary ac-btn--block"
        :disabled="saving"
        @click="handleUpdate"
      >
        {{ saving ? "Enregistrement..." : "Enregistrer" }}
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
</style>
