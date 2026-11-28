<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { supabase } from "@/shared/api/supabase";
import { ROUTE } from "@/shared/routes";
import { useToast } from "@/shared/ui/toast/useToast";
import { passwordSchema } from "../lib/password";
import { newPasswordError } from "../authErrors";
import { endRecovery, recoveryHandOver, returnPending } from "../returnArrival";
import AuthCard from "../components/AuthCard.vue";
import PasswordRequirements from "../components/PasswordRequirements.vue";
import SecondFactorCode from "../components/SecondFactorCode.vue";

const router = useRouter();
const { toast } = useToast();

const password = ref("");
const confirmPassword = ref("");
const loading = ref(false);
const done = ref(false);

// The page opens from a recovery link, whose session was settled before it
// mounted (../returnArrival.ts). What it shows follows what the link gave:
// its account's password form; a notice when the visitor kept the account
// that was signed in; « Lien invalide » for anything else (an expired link,
// the page opened by hand).
const account = computed(() =>
  recoveryHandOver.value.state === "none" ? null : recoveryHandOver.value.email,
);

// An account with a second factor gives its code before its password can
// change: Auth refuses the change otherwise.
const factorOwed = ref<string | null>(null);
const checked = ref(false);

async function readSecondFactor() {
  if (recoveryHandOver.value.state !== "ready") return;
  // Read from the session the link just gave: its account as Auth sent it.
  const { data } = await supabase.auth.getSession();
  const factor = data.session?.user.factors?.find(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );
  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  factorOwed.value = factor && level?.currentLevel !== "aal2" ? factor.id : null;
  checked.value = true;
}

onMounted(readSecondFactor);
// A slow Auth: the link's session may land after the page.
watch(recoveryHandOver, readSecondFactor);

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
    toast({ title: "Erreur", description: newPasswordError(error), variant: "destructive" });
  } else {
    endRecovery();
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
    <!-- Success -->
    <AuthCard v-if="done">
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
      <button type="button" class="btn-primary-block" @click="router.push(ROUTE.admin.path)">
        Accéder à l'administration
      </button>
    </AuthCard>

    <!-- The link's session still being settled, or its second factor read -->
    <AuthCard
      v-else-if="returnPending || (recoveryHandOver.state === 'ready' && !checked)"
      loading
    />

    <!-- Another account was signed in, and the visitor kept it -->
    <AuthCard v-else-if="recoveryHandOver.state === 'kept'">
      <h1 class="card-title">Lien non utilisé</h1>
      <p class="card-desc center">
        Vous êtes resté connecté avec le compte <strong>{{ account }}</strong
        >. Pour utiliser ce lien, déconnectez-vous puis ouvrez-le de nouveau.
      </p>
      <RouterLink :to="ROUTE.admin.path" class="btn-primary-block link-block">
        Retour à l'administration
      </RouterLink>
    </AuthCard>

    <!-- Invalid / expired link -->
    <AuthCard v-else-if="recoveryHandOver.state === 'none'">
      <h1 class="card-title">Lien invalide</h1>
      <p class="card-desc center">
        Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.
      </p>
      <RouterLink :to="ROUTE.auth.path" class="btn-primary-block link-block">
        Retour à la connexion
      </RouterLink>
    </AuthCard>

    <!-- The account's second factor, before its password -->
    <AuthCard v-else-if="factorOwed">
      <h1 class="card-title">Double authentification</h1>
      <p class="card-desc center">
        Le compte <strong>{{ account }}</strong> est protégé par une double authentification.
        Saisissez le code de votre application pour choisir un nouveau mot de passe.
      </p>
      <SecondFactorCode :factor-id="factorOwed" action="Continuer" @verified="factorOwed = null" />
    </AuthCard>

    <!-- New password form -->
    <AuthCard v-else>
      <h1 class="card-title">Nouveau mot de passe</h1>
      <p class="card-desc center">
        Choisissez un nouveau mot de passe pour le compte <strong>{{ account }}</strong>
      </p>

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
  overflow-wrap: anywhere;
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
