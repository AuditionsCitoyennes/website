<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { isAuthError } from "@supabase/supabase-js";
import { supabase } from "@/shared/api/supabase";
import { checkCurrentPassword, hasPassword } from "@/lib/reauth";
import { api, ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import { useAuthStore } from "@/stores/auth";
import { passwordSchema, PASSWORD_REQUIREMENTS } from "@/lib/passwordValidation";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";

const router = useRouter();
const auth = useAuthStore();
const { toast } = useToast();

const dialogOpen = ref(false);
const editUsername = ref("");
const editEmail = ref("");
const currentPassword = ref("");
const editPassword = ref("");
const editPasswordConfirm = ref("");
const savingUsername = ref(false);
const savingEmail = ref(false);
const savingPassword = ref(false);
const deleting = ref(false);

// Changing the password asks for the current one first. An account created
// through Google has none yet: it sets its first password without it — unless
// Supabase says it does have one (see updatePassword), which the account's
// description cannot always tell.
const currentPasswordRequired = ref(false);
const asksCurrentPassword = computed(
  () => currentPasswordRequired.value || hasPassword(auth.user, auth.session?.access_token),
);

function openDialog() {
  editUsername.value = (auth.user?.user_metadata?.username as string) ?? "";
  editEmail.value = auth.user?.email ?? "";
  currentPassword.value = "";
  editPassword.value = "";
  editPasswordConfirm.value = "";
  dialogOpen.value = true;
}

async function updateUsername() {
  const trimmed = editUsername.value.trim();
  if (!trimmed) {
    toast({
      title: "Erreur",
      description: "Veuillez entrer un nom d'utilisateur",
      variant: "destructive",
    });
    return;
  }
  savingUsername.value = true;
  const { error } = await supabase.auth.updateUser({
    data: { username: trimmed },
  });
  savingUsername.value = false;
  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  } else {
    toast({ title: "Succès!", description: "Nom d'utilisateur mis à jour" });
  }
}

async function updateEmail() {
  if (!editEmail.value.trim()) {
    toast({ title: "Erreur", description: "Veuillez entrer un email", variant: "destructive" });
    return;
  }
  savingEmail.value = true;
  const { error } = await supabase.auth.updateUser({ email: editEmail.value.trim() });
  savingEmail.value = false;
  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  } else {
    toast({
      title: "Succès!",
      description: "Un email de confirmation a été envoyé à votre nouvelle adresse",
    });
  }
}

function passwordError(description: string) {
  toast({ title: "Erreur", description, variant: "destructive" });
}

/** What Supabase answers to a refused password change, in French. Read from
 *  the error CODE: several of them share one English message. */
function passwordUpdateError(error: unknown): string {
  const code = isAuthError(error) ? error.code : undefined;
  switch (code) {
    // Both only when the project itself requires the current password.
    case "current_password_required":
      return "Veuillez entrer votre mot de passe actuel";
    case "current_password_invalid":
      return "Mot de passe actuel incorrect";
    case "same_password":
      return "Le nouveau mot de passe doit être différent de l'actuel";
    case "weak_password":
      return "Ce mot de passe est trop faible, choisissez-en un autre";
    case "validation_failed":
      return "Mot de passe trop long (72 caractères au plus, les lettres accentuées comptent double)";
    case "reauthentication_needed":
      return "Par sécurité, reconnectez-vous puis réessayez";
    case "over_request_rate_limit":
      return "Trop de tentatives, veuillez réessayer plus tard";
    default:
      return isAuthError(error) && error.name === "AuthSessionMissingError"
        ? "Votre session a expiré, veuillez vous reconnecter"
        : "Le mot de passe n'a pas pu être modifié, veuillez réessayer";
  }
}

async function updatePassword() {
  if (savingPassword.value) return;
  // The form as it is NOW: what is checked below is what gets sent, whatever
  // is typed (or reset) while the requests are on their way.
  const current = currentPassword.value;
  const next = editPassword.value;
  const asksCurrent = asksCurrentPassword.value;
  if (asksCurrent && !current) {
    passwordError("Veuillez entrer votre mot de passe actuel");
    return;
  }
  const result = passwordSchema.safeParse(next);
  if (!result.success) {
    passwordError(result.error.issues[0].message);
    return;
  }
  if (next !== editPasswordConfirm.value) {
    passwordError("Les mots de passe ne correspondent pas");
    return;
  }
  if (asksCurrent && next === current) {
    passwordError("Le nouveau mot de passe doit être différent de l'actuel");
    return;
  }

  savingPassword.value = true;
  try {
    if (asksCurrent) {
      // Nothing is changed unless the current password is the right one — for
      // the account as Supabase knows it now: the copy held here can be behind
      // (an email change confirmed on another device).
      const { data: fresh } = await supabase.auth.getUser();
      const account = fresh.user ?? auth.user;
      const check = account?.email
        ? await checkCurrentPassword(account.email, current, account.id)
        : "failed";
      if (check !== "ok") {
        passwordError(
          check === "wrong"
            ? "Mot de passe actuel incorrect"
            : check === "rate-limited"
              ? "Trop de tentatives, veuillez réessayer plus tard"
              : "Le mot de passe actuel n'a pas pu être vérifié, veuillez réessayer",
        );
        return;
      }
    }
    const { error } = await supabase.auth.updateUser({
      password: next,
      ...(asksCurrent
        ? // Checked again by Supabase itself when the project requires it.
          { current_password: current }
        : // A first password: leave the mark that makes the next change ask
          // for it (see hasPassword).
          { data: { has_password: true } }),
    });
    if (error) {
      // The account has a password after all: ask for it from now on.
      if (isAuthError(error) && error.code === "current_password_required") {
        currentPasswordRequired.value = true;
      }
      passwordError(passwordUpdateError(error));
      return;
    }
    // Supabase closes every other session of the account on a password change.
    toast({
      title: "Succès!",
      description: "Mot de passe mis à jour. Vos autres appareils ont été déconnectés.",
    });
    // From here on the account has a password, whatever it had before.
    currentPasswordRequired.value = true;
    currentPassword.value = "";
    editPassword.value = "";
    editPasswordConfirm.value = "";
  } finally {
    savingPassword.value = false;
  }
}

async function handleDeleteAccount() {
  if (
    !confirm("Êtes-vous sûr de vouloir supprimer votre compte ? Cette action est irréversible.")
  ) {
    return;
  }
  deleting.value = true;
  try {
    await api.del("/api/me");
    await auth.signOut();
    toast({
      title: "Compte supprimé",
      description: "Votre compte et vos accès ont été supprimés.",
    });
    router.push("/");
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "La suppression a échoué",
      variant: "destructive",
    });
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <section class="admin-card">
    <h2 class="admin-card-title">Mon compte</h2>
    <p class="admin-card-desc">Gérez vos informations personnelles</p>

    <div class="info">
      <div>
        <p class="info-label">Nom d'utilisateur</p>
        <p class="info-value">
          {{ (auth.user?.user_metadata?.username as string) || "Non défini" }}
        </p>
      </div>
      <div>
        <p class="info-label">Email</p>
        <p class="info-value">{{ auth.user?.email }}</p>
      </div>
    </div>

    <div class="actions">
      <button type="button" class="ac-btn ac-btn--outline" @click="openDialog">
        Modifier mes identifiants
      </button>
      <button
        type="button"
        class="ac-btn ac-btn--danger"
        :disabled="deleting"
        @click="handleDeleteAccount"
      >
        <span v-if="deleting" class="spinner"></span>
        Supprimer mon compte
      </button>
    </div>

    <ModalDialog
      :open="dialogOpen"
      title="Modifier mes identifiants"
      description="Mettez à jour vos informations de connexion"
      dismissible
      @close="dialogOpen = false"
    >
      <div class="dialog-sections">
        <div class="section">
          <label class="form-label" for="acct-username">Nom d'utilisateur</label>
          <input
            id="acct-username"
            v-model="editUsername"
            class="form-input"
            placeholder="Votre nom d'utilisateur"
            maxlength="50"
          />
          <button
            type="button"
            class="ac-btn ac-btn--primary ac-btn--sm ac-btn--block"
            :disabled="savingUsername"
            @click="updateUsername"
          >
            <span v-if="savingUsername" class="spinner"></span>
            Enregistrer le nom
          </button>
        </div>

        <hr class="sep" />

        <div class="section">
          <label class="form-label" for="acct-email">Email</label>
          <input
            id="acct-email"
            v-model="editEmail"
            class="form-input"
            type="email"
            placeholder="votre@email.com"
            maxlength="255"
          />
          <p class="hint">Un email de confirmation sera envoyé à la nouvelle adresse.</p>
          <button
            type="button"
            class="ac-btn ac-btn--primary ac-btn--sm ac-btn--block"
            :disabled="savingEmail"
            @click="updateEmail"
          >
            <span v-if="savingEmail" class="spinner"></span>
            Modifier l'email
          </button>
        </div>

        <hr class="sep" />

        <div class="section">
          <template v-if="asksCurrentPassword">
            <label class="form-label" for="acct-password-current">Mot de passe actuel</label>
            <input
              id="acct-password-current"
              :disabled="savingPassword"
              v-model="currentPassword"
              class="form-input"
              type="password"
              placeholder="••••••••"
              maxlength="72"
              autocomplete="current-password"
            />
            <p class="hint">
              Oublié ? Déconnectez-vous, puis utilisez « Mot de passe oublié ? » sur la page de
              connexion.
            </p>
          </template>
          <p v-else class="hint">
            Votre compte se connecte avec Google : il n'a pas encore de mot de passe. Vous pouvez en
            définir un ci-dessous.
          </p>
          <label class="form-label" for="acct-password">Nouveau mot de passe</label>
          <input
            id="acct-password"
            :disabled="savingPassword"
            v-model="editPassword"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="72"
            autocomplete="new-password"
          />
          <ul class="requirements">
            <li
              v-for="req in PASSWORD_REQUIREMENTS"
              :key="req.label"
              class="requirement"
              :class="{ ok: req.test(editPassword) }"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                width="13"
                height="13"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {{ req.label }}
            </li>
          </ul>
          <label class="form-label" for="acct-password-confirm">Confirmer le mot de passe</label>
          <input
            id="acct-password-confirm"
            :disabled="savingPassword"
            v-model="editPasswordConfirm"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="72"
            autocomplete="new-password"
          />
          <button
            type="button"
            class="ac-btn ac-btn--primary ac-btn--sm ac-btn--block"
            :disabled="savingPassword"
            @click="updatePassword"
          >
            <span v-if="savingPassword" class="spinner"></span>
            Modifier le mot de passe
          </button>
        </div>
      </div>
    </ModalDialog>
  </section>
</template>

<style scoped>
.info {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  margin-bottom: 1.1rem;
}

.info-label {
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}

.info-value {
  font-weight: 600;
  color: hsl(var(--foreground));
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.dialog-sections {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.sep {
  border: none;
  border-top: 1px solid hsl(var(--border));
}

.hint {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.requirements {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.requirement {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}

.requirement svg {
  color: hsl(var(--muted-foreground) / 0.4);
  flex-shrink: 0;
}

.requirement.ok,
.requirement.ok svg {
  color: hsl(var(--civic-green));
}
</style>
