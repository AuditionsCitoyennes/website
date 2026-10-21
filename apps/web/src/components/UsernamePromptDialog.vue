<script setup lang="ts">
import { ref } from "vue";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/composables/useToast";
import ModalDialog from "@/components/ModalDialog.vue";

const props = defineProps<{
  open: boolean;
  /** Skip the updateUser call (used during signup when no session exists yet). */
  collectOnly?: boolean;
}>();

const emit = defineEmits<{
  complete: [username: string, bio: string];
  signOut: [];
}>();

const { toast } = useToast();
const username = ref("");
const bio = ref("");
const saving = ref(false);

async function handleSave() {
  const trimmed = username.value.trim();
  if (!trimmed) {
    toast({
      title: "Erreur",
      description: "Veuillez entrer un nom d'utilisateur",
      variant: "destructive",
    });
    return;
  }
  if (props.collectOnly) {
    emit("complete", trimmed, bio.value.trim());
    return;
  }
  saving.value = true;
  const { error } = await supabase.auth.updateUser({
    data: { username: trimmed, bio: bio.value.trim() },
  });
  saving.value = false;
  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  } else {
    emit("complete", trimmed, bio.value.trim());
  }
}
</script>

<template>
  <ModalDialog
    :open="open"
    title="Complétez votre profil"
    description="Ces informations seront visibles par les administrateurs du site."
  >
    <div class="form">
      <div class="form-field">
        <label class="form-label" for="prompt-username">Nom d'utilisateur</label>
        <input
          id="prompt-username"
          v-model="username"
          class="form-input"
          placeholder="Votre nom d'utilisateur"
          maxlength="50"
        />
      </div>
      <div class="form-field">
        <label class="form-label" for="prompt-bio"> Dites nous en plus sur vous (optionnel) </label>
        <textarea
          id="prompt-bio"
          v-model="bio"
          class="form-input form-textarea"
          placeholder="Ex: Votre parcours, vos motivations..."
          rows="4"
          maxlength="500"
        ></textarea>
      </div>
      <button type="button" class="btn-primary-block" :disabled="saving" @click="handleSave">
        <span v-if="saving" class="spinner" aria-hidden="true"></span>
        Confirmer
      </button>
      <!-- This popup cannot be closed, and it covers the page: someone signed
           in with the wrong account needs a way out that is not "fill it in".
           (Not during signup — `collectOnly` — where nobody is signed in yet.) -->
      <button
        v-if="!collectOnly"
        type="button"
        class="btn-outline-block"
        :disabled="saving"
        @click="emit('signOut')"
      >
        Se déconnecter
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
</style>
