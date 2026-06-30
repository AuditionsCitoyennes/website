<script setup lang="ts">
import { ref, watch } from "vue";
import type { Testimony } from "@ac/shared";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import ModalDialog from "@/components/ModalDialog.vue";

const props = defineProps<{
  open: boolean;
  testimony: Testimony | null;
}>();

const emit = defineEmits<{
  close: [];
  updated: [];
}>();

const { toast } = useToast();
const loading = ref(false);
const form = ref({ person_name: "", person_info: "", content: "", email: "" });

watch(
  () => [props.testimony, props.open] as const,
  ([t, open]) => {
    if (t && open) {
      form.value = {
        person_name: t.person_name,
        person_info: t.person_info ?? "",
        content: t.content,
        email: t.email ?? "",
      };
    }
  },
  { immediate: true },
);

async function handleSave() {
  if (!props.testimony) return;
  if (!form.value.person_name || !form.value.content) {
    toast({
      title: "Erreur",
      description: "Le nom et le contenu sont requis",
      variant: "destructive",
    });
    return;
  }
  if (form.value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.value.email)) {
    toast({
      title: "Erreur",
      description: "L'adresse email n'est pas valide",
      variant: "destructive",
    });
    return;
  }

  loading.value = true;
  try {
    const result = await api.patch<{ needsReverification: boolean; reverificationSent: boolean }>(
      `/api/testimonies/${props.testimony.id}`,
      {
        person_name: form.value.person_name,
        person_info: form.value.person_info || null,
        content: form.value.content,
        email: form.value.email || null,
      },
    );
    toast({
      title: "Succès!",
      description: result.needsReverification
        ? result.reverificationSent
          ? "Témoignage mis à jour et email de vérification envoyé"
          : "Témoignage mis à jour (l'email de vérification n'a pas pu être envoyé)"
        : "Témoignage mis à jour",
    });
    emit("updated");
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
    title="Modifier le témoignage"
    description="Modifiez les informations du témoignage ci-dessous"
    dismissible
    @close="emit('close')"
  >
    <div class="form">
      <div class="grid-2">
        <div class="form-field">
          <label class="form-label" for="edit-person-name">Nom/Prénom</label>
          <input id="edit-person-name" v-model="form.person_name" class="form-input" />
        </div>
        <div class="form-field">
          <label class="form-label" for="edit-person-info">Informations (optionnel)</label>
          <input
            id="edit-person-info"
            v-model="form.person_info"
            class="form-input"
            placeholder="Ex: 45 ans, enseignante"
          />
        </div>
      </div>

      <div class="form-field">
        <label class="form-label" for="edit-email">Email (optionnel)</label>
        <input
          id="edit-email"
          v-model="form.email"
          class="form-input"
          type="email"
          placeholder="Ex: marie@email.com"
        />
        <p class="hint">
          Si fourni, un email sera envoyé pour permettre à la personne de valider son témoignage.
        </p>
      </div>

      <div class="form-field">
        <label class="form-label" for="edit-content">Témoignage</label>
        <textarea
          id="edit-content"
          v-model="form.content"
          class="form-input form-textarea"
          rows="8"
        ></textarea>
      </div>

      <div class="dialog-actions">
        <button type="button" class="ac-btn ac-btn--outline" @click="emit('close')">Annuler</button>
        <button
          type="button"
          class="ac-btn ac-btn--primary"
          :disabled="loading"
          @click="handleSave"
        >
          {{ loading ? "Enregistrement..." : "Enregistrer" }}
        </button>
      </div>
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

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
</style>
