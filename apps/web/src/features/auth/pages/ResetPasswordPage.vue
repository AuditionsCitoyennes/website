<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { supabase, wasPasswordRecoveryDetected } from "@/shared/api/supabase";
import { useToast } from "@/shared/ui/toast/useToast";
import { passwordSchema } from "../lib/password";
import AuthCard from "../components/AuthCard.vue";
import PasswordRequirements from "../components/PasswordRequirements.vue";

const router = useRouter();
const { toast } = useToast();

const password = ref("");
const confirmPassword = ref("");
const loading = ref(false);
const ready = ref(false);
const invalid = ref(false);
const done = ref(false);

let timeout: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

onMounted(() => {
  // The recovery link signs the user in via the URL. The PASSWORD_RECOVERY
  // event may already have fired before this lazy-loaded page mounted — the
  // module-scope flag in shared/api/supabase covers that window; the live
  // subscription covers a detection that resolves later. Otherwise declare
  // the link invalid after 5s.
  if (wasPasswordRecoveryDetected()) {
    ready.value = true;
    return;
  }

  timeout = setTimeout(() => {
    if (!ready.value) invalid.value = true;
  }, 5000);

  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
      ready.value = true;
      if (timeout) clearTimeout(timeout);
    }
  });
  unsubscribe = () => data.subscription.unsubscribe();
});

onBeforeUnmount(() => {
  if (timeout) clearTimeout(timeout);
  unsubscribe?.();
});

async function handleSubmit() {
  const result = passwordSchema.safeParse(password.value);
  if (!result.success) {
    toast({
      title: "Erreur",
      description: result.error.issues[0].message,
      variant: "destructive",
    });
    return;
  }
  if (password.value !== confirmPassword.value) {
    toast({
      title: "Erreur",
      description: "Les mots de passe ne correspondent pas",
      variant: "destructive",
    });
    return;
  }

  loading.value = true;
  const { error } = await supabase.auth.updateUser({ password: password.value });
  loading.value = false;

  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  } else {
    done.value = true;
    toast({
      title: "Mot de passe mis à jour",
      description: "Vous pouvez maintenant vous connecter.",
    });
  }
}
</script>

<template>
  <div class="reset-page">
    <!-- Invalid / expired link -->
    <AuthCard v-if="invalid">
      <h1 class="card-title">Lien invalide</h1>
      <p class="card-desc center">
        Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.
      </p>
      <RouterLink to="/auth" class="btn-primary-block link-block">
        Retour à la connexion
      </RouterLink>
    </AuthCard>

    <!-- Success -->
    <AuthCard v-else-if="done">
      <div class="icon-wrap success">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="38"
          height="38"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h1 class="card-title">Mot de passe modifié</h1>
      <p class="card-desc center">Votre mot de passe a été mis à jour avec succès.</p>
      <button type="button" class="btn-primary-block" @click="router.push('/admin')">
        Accéder à l'administration
      </button>
    </AuthCard>

    <!-- Waiting for the recovery session -->
    <AuthCard v-else-if="!ready" loading />

    <!-- New password form -->
    <AuthCard v-else>
      <h1 class="card-title">Nouveau mot de passe</h1>
      <p class="card-desc center">Choisissez un nouveau mot de passe pour votre compte</p>

      <form class="stack" @submit.prevent="handleSubmit">
        <div class="form-field">
          <label class="form-label" for="new-password">Nouveau mot de passe</label>
          <input
            id="new-password"
            v-model="password"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="100"
            autocomplete="new-password"
          />
        </div>

        <PasswordRequirements :password="password" />

        <div class="form-field">
          <label class="form-label" for="confirm-password">Confirmer le mot de passe</label>
          <input
            id="confirm-password"
            v-model="confirmPassword"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="100"
            autocomplete="new-password"
          />
        </div>

        <button type="submit" class="btn-primary-block" :disabled="loading">
          {{ loading ? "Mise à jour..." : "Mettre à jour le mot de passe" }}
        </button>
      </form>
    </AuthCard>
  </div>
</template>

<style scoped>
.reset-page {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 1.5rem;
  overflow: hidden;
}

.icon-wrap {
  display: grid;
  place-items: center;
  width: 4.6rem;
  height: 4.6rem;
  margin: 0 auto 1.25rem;
  border-radius: 1.1rem;
}

.icon-wrap.success {
  background: hsl(var(--civic-green) / 0.12);
  color: hsl(var(--civic-green));
}

.card-title {
  font-size: var(--text-section);
  text-transform: uppercase;
  text-align: center;
  color: hsl(var(--foreground));
}

.card-desc {
  margin-top: 0.4rem;
  margin-bottom: 1.4rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}

.center {
  text-align: center;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.link-block {
  text-decoration: none;
}
</style>
