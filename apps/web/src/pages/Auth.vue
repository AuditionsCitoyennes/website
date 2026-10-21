<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/composables/useToast";
import { passwordSchema, PASSWORD_REQUIREMENTS } from "@/lib/passwordValidation";
import { mapAuthError } from "@/lib/authErrors";
import OAuthButtons from "@/components/OAuthButtons.vue";
import UsernamePromptDialog from "@/components/UsernamePromptDialog.vue";

const loginSchema = z.object({
  email: z.string().email("Email invalide").max(255, "Email trop long"),
  password: z.string().min(1, "Le mot de passe est requis").max(100, "Mot de passe trop long"),
});

const signupSchema = z.object({
  email: z.string().email("Email invalide").max(255, "Email trop long"),
  password: passwordSchema,
});

const router = useRouter();
const { toast } = useToast();

// `?tab=inscription` (the home page's "join" button) opens on the sign-up tab —
// and the plain /auth (the header's "Connexion"), reached from there, goes back
// to the sign-in one: the page stays mounted while only its query changes.
const route = useRoute();
const tab = ref<"login" | "signup">("login");
watch(
  () => route.query.tab,
  (t) => (tab.value = t === "inscription" ? "signup" : "login"),
  { immediate: true },
);
const loading = ref(false);
const email = ref("");
const password = ref("");

const signupDone = ref(false);
const signupEmail = ref("");
const resendCooldown = ref(0);
const resetLoading = ref(false);
const showProfileDialog = ref(false);

let pendingSignup: { email: string; password: string } | null = null;
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  const { data } = await supabase.auth.getSession();
  if (data.session) router.replace("/admin");
});

onBeforeUnmount(() => {
  if (cooldownTimer) clearInterval(cooldownTimer);
});

function startCooldown() {
  resendCooldown.value = 60;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    resendCooldown.value -= 1;
    if (resendCooldown.value <= 0 && cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }, 1000);
}

async function handleAuth(type: "login" | "signup") {
  try {
    const schema = type === "signup" ? signupSchema : loginSchema;
    const validated = schema.parse({ email: email.value.trim(), password: password.value });

    if (type === "signup") {
      // Credentials validated — collect profile info before creating the account.
      pendingSignup = { email: validated.email, password: validated.password };
      showProfileDialog.value = true;
      return;
    }

    loading.value = true;
    const { error } = await supabase.auth.signInWithPassword({
      email: validated.email,
      password: validated.password,
    });
    if (error) throw error;

    toast({ title: "Connexion réussie!", description: "Bienvenue" });
    router.push("/admin");
  } catch (error) {
    if (error instanceof z.ZodError) {
      toast({
        title: "Erreur de validation",
        description: error.issues[0].message,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Erreur",
        description: mapAuthError(error, type),
        variant: "destructive",
      });
    }
  } finally {
    loading.value = false;
  }
}

async function handleProfileComplete(username: string, bio: string) {
  if (!pendingSignup) return;
  showProfileDialog.value = false;
  loading.value = true;
  try {
    const { error } = await supabase.auth.signUp({
      email: pendingSignup.email,
      password: pendingSignup.password,
      options: {
        emailRedirectTo: `${window.location.origin}/admin`,
        data: { username, bio },
      },
    });
    if (error) throw error;
    signupEmail.value = pendingSignup.email;
    signupDone.value = true;
  } catch (error) {
    toast({
      title: "Erreur",
      description: mapAuthError(error, "signup"),
      variant: "destructive",
    });
  } finally {
    loading.value = false;
    pendingSignup = null;
  }
}

async function handleResendVerification() {
  if (resendCooldown.value > 0) return;
  const { error } = await supabase.auth.resend({ type: "signup", email: signupEmail.value });
  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  } else {
    toast({
      title: "Email envoyé",
      description: "Un nouvel email de vérification a été envoyé.",
    });
    startCooldown();
  }
}

async function handleForgotPassword() {
  const trimmedEmail = email.value.trim();
  if (!trimmedEmail) {
    toast({
      title: "Erreur",
      description: "Veuillez entrer votre email ci-dessus.",
      variant: "destructive",
    });
    return;
  }
  resetLoading.value = true;
  await supabase.auth.resetPasswordForEmail(trimmedEmail, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  resetLoading.value = false;
  toast({
    title: "Email envoyé",
    description:
      "Si un compte existe avec cette adresse, vous recevrez un email de réinitialisation.",
  });
}
</script>

<template>
  <div class="auth-page">
    <div class="backdrop gradient-hero" aria-hidden="true"></div>

    <!-- "Vérifiez votre email" screen after signup -->
    <div v-if="signupDone" class="card glass-strong elevation-2xl fade-in">
      <div class="icon-wrap">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="38"
          height="38"
        >
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      </div>
      <h1 class="card-title">Vérifiez votre email</h1>
      <p class="card-desc center">
        Un email de vérification a été envoyé à
        <strong>{{ signupEmail }}</strong
        >.<br />
        Cliquez sur le lien dans l'email pour continuer.
      </p>
      <div class="stack">
        <button
          type="button"
          class="btn-outline-block"
          :disabled="resendCooldown > 0"
          @click="handleResendVerification"
        >
          {{ resendCooldown > 0 ? `Renvoyer l'email (${resendCooldown}s)` : "Renvoyer l'email" }}
        </button>
        <button
          type="button"
          class="btn-ghost-block"
          @click="
            signupDone = false;
            signupEmail = '';
          "
        >
          ← Retour
        </button>
      </div>
    </div>

    <!-- Login / signup card -->
    <div v-else class="card glass-strong elevation-2xl fade-in">
      <div class="icon-wrap">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="38"
          height="38"
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>
      <h1 class="card-title">Administration</h1>
      <p class="card-desc center">Accédez à l'espace d'administration</p>

      <OAuthButtons class="oauth-zone" />

      <div class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="tab"
          :class="{ active: tab === 'login' }"
          :aria-selected="tab === 'login'"
          @click="tab = 'login'"
        >
          Connexion
        </button>
        <button
          type="button"
          role="tab"
          class="tab"
          :class="{ active: tab === 'signup' }"
          :aria-selected="tab === 'signup'"
          @click="tab = 'signup'"
        >
          Inscription
        </button>
      </div>

      <form v-if="tab === 'login'" class="stack" @submit.prevent="handleAuth('login')">
        <div class="form-field">
          <label class="form-label" for="login-email">Email</label>
          <input
            id="login-email"
            v-model="email"
            class="form-input"
            type="email"
            placeholder="votre@email.com"
            maxlength="255"
            autocomplete="email"
          />
        </div>
        <div class="form-field">
          <label class="form-label" for="login-password">Mot de passe</label>
          <input
            id="login-password"
            v-model="password"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="100"
            autocomplete="current-password"
          />
        </div>
        <button type="submit" class="btn-primary-block" :disabled="loading">
          {{ loading ? "Connexion..." : "Se connecter" }}
        </button>
        <div class="center">
          <button
            type="button"
            class="link-btn"
            :disabled="resetLoading"
            @click="handleForgotPassword"
          >
            {{ resetLoading ? "Envoi en cours..." : "Mot de passe oublié ?" }}
          </button>
        </div>
      </form>

      <form v-else class="stack" @submit.prevent="handleAuth('signup')">
        <div class="form-field">
          <label class="form-label" for="signup-email">Email</label>
          <input
            id="signup-email"
            v-model="email"
            class="form-input"
            type="email"
            placeholder="votre@email.com"
            maxlength="255"
            autocomplete="email"
          />
        </div>
        <div class="form-field">
          <label class="form-label" for="signup-password">Mot de passe</label>
          <input
            id="signup-password"
            v-model="password"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="100"
            autocomplete="new-password"
          />
        </div>
        <ul class="requirements">
          <li
            v-for="req in PASSWORD_REQUIREMENTS"
            :key="req.label"
            class="requirement"
            :class="{ ok: req.test(password) }"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="15"
              height="15"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {{ req.label }}
          </li>
        </ul>
        <button type="submit" class="btn-primary-block" :disabled="loading">
          {{ loading ? "Inscription..." : "S'inscrire" }}
        </button>
      </form>
    </div>

    <UsernamePromptDialog
      :open="showProfileDialog"
      collect-only
      @complete="handleProfileComplete"
    />
  </div>
</template>

<style scoped>
.auth-page {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 1.5rem;
  overflow: hidden;
}

.backdrop {
  position: absolute;
  inset: 0;
  opacity: 0.3;
}

.card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 28rem;
  border-radius: 1rem;
  padding: 2rem;
}

.icon-wrap {
  display: grid;
  place-items: center;
  width: 4.6rem;
  height: 4.6rem;
  margin: 0 auto 1.25rem;
  border-radius: 1.1rem;
  background: hsl(var(--primary) / 0.1);
  border: 1px solid hsl(var(--primary) / 0.2);
  color: hsl(var(--primary));
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

.oauth-zone {
  margin-bottom: 1.1rem;
}

.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 0.6rem;
  background: hsl(var(--muted));
  margin-bottom: 1.4rem;
}

.tab {
  height: 2.4rem;
  border: none;
  border-radius: 0.45rem;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-weight: 600;
  font-size: var(--text-ui);
  letter-spacing: 0.02em;
  transition: var(--transition-smooth);
}

.tab.active {
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  box-shadow: var(--shadow-sm);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.requirements {
  list-style: none;
  padding: 0;
  margin: -0.3rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.requirement {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}

.requirement svg {
  color: hsl(var(--muted-foreground) / 0.4);
  flex-shrink: 0;
}

.requirement.ok {
  color: hsl(var(--civic-green));
}

.requirement.ok svg {
  color: hsl(var(--civic-green));
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: var(--text-ui);
  color: hsl(var(--primary));
}

.link-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.link-btn:disabled {
  opacity: 0.5;
}
</style>
