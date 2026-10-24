<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { noteOutboxAddress } from "@/shared/api/outbox";
import { useAuthStore } from "@/features/auth";
import { PASSWORD_REQUIREMENTS } from "@/features/auth/account";
import { ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import { deleteAccount, setEmail, setUsername } from "./api";
import { usePasswordChange } from "./usePasswordChange";

const router = useRouter();
const auth = useAuthStore();
const { toast } = useToast();

const dialogOpen = ref(false);
const editUsername = ref("");
const editEmail = ref("");
const savingUsername = ref(false);
const savingEmail = ref(false);
const deleting = ref(false);

// The password form: its fields, whether the current password is asked for,
// and the change itself.
const {
  currentPassword,
  editPassword,
  editPasswordConfirm,
  savingPassword,
  asksCurrentPassword,
  updatePassword,
} = usePasswordChange();

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
  const { error } = await setUsername(trimmed);
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
  const { error } = await setEmail(editEmail.value.trim());
  savingEmail.value = false;
  if (__TEST_TOOLS__ && !error) noteOutboxAddress(editEmail.value);
  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  } else {
    toast({
      title: "Succès!",
      description: "Un email de confirmation a été envoyé à votre nouvelle adresse",
    });
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
    await deleteAccount();
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
