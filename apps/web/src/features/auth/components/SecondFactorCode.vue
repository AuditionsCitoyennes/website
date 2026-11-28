<script setup lang="ts">
import { ref } from "vue";
import { supabase } from "@/shared/api/supabase";
import { useToast } from "@/shared/ui/toast/useToast";
import { secondFactorError } from "../authErrors";

// The 6-digit code of an authenticator app, checked against one factor of the
// signed-in account: the first code that confirms a new factor, or the code a
// session owes after its password or its link. Says `verified` once Auth
// accepted it (the session is then at the second level).
const props = defineProps<{
  factorId: string;
  /** The button's text. */
  action: string;
}>();

const emit = defineEmits<{ verified: [] }>();

const { toast } = useToast();
const code = ref("");
const checking = ref(false);

async function verify() {
  const digits = code.value.replace(/\D/g, "");
  if (digits.length !== 6) {
    toast({
      title: "Erreur",
      description: "Saisissez les 6 chiffres affichés par votre application.",
      variant: "destructive",
    });
    return;
  }
  checking.value = true;
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: props.factorId,
    code: digits,
  });
  checking.value = false;
  if (error) {
    code.value = "";
    toast({ title: "Erreur", description: secondFactorError(error), variant: "destructive" });
    return;
  }
  emit("verified");
}
</script>

<template>
  <form class="code-form" @submit.prevent="verify">
    <div class="form-field">
      <label class="form-label" for="second-factor-code">Code à 6 chiffres</label>
      <input
        id="second-factor-code"
        v-model="code"
        class="form-input code-input"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        placeholder="000000"
        maxlength="7"
        :disabled="checking"
      />
    </div>
    <button type="submit" class="btn-primary-block" :disabled="checking">
      {{ checking ? "Vérification..." : action }}
    </button>
  </form>
</template>

<style scoped>
.code-form {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.code-input {
  text-align: center;
  letter-spacing: 0.3em;
  font-variant-numeric: tabular-nums;
}
</style>
