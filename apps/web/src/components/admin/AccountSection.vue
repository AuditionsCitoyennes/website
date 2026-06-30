<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { supabase } from "@/lib/supabase";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import { useAuthStore } from "@/stores/auth";
import { passwordSchema, PASSWORD_REQUIREMENTS } from "@/lib/passwordValidation";
import ModalDialog from "@/components/ModalDialog.vue";

const router = useRouter();
const auth = useAuthStore();
const { toast } = useToast();

const dialogOpen = ref(false);
const editUsername = ref("");
const editEmail = ref("");
const editPassword = ref("");
const editPasswordConfirm = ref("");
const savingUsername = ref(false);
const savingEmail = ref(false);
const savingPassword = ref(false);
const deleting = ref(false);

function openDialog() {
  editUsername.value = (auth.user?.user_metadata?.username as string) ?? "";
  editEmail.value = auth.user?.email ?? "";
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

async function updatePassword() {
  const result = passwordSchema.safeParse(editPassword.value);
  if (!result.success) {
    toast({
      title: "Erreur",
      description: result.error.issues[0].message,
      variant: "destructive",
    });
    return;
  }
  if (editPassword.value !== editPasswordConfirm.value) {
    toast({
      title: "Erreur",
      description: "Les mots de passe ne correspondent pas",
      variant: "destructive",
    });
    return;
  }
  savingPassword.value = true;
  const { error } = await supabase.auth.updateUser({ password: editPassword.value });
  savingPassword.value = false;
  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  } else {
    toast({ title: "Succès!", description: "Mot de passe mis à jour" });
    editPassword.value = "";
    editPasswordConfirm.value = "";
  }
}

async function handleSignOut() {
  await auth.signOut();
  router.push("/auth");
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
        <p class="info-value">{{ (auth.user?.user_metadata?.username as string) || "Non défini" }}</p>
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
      <button type="button" class="ac-btn ac-btn--outline" @click="handleSignOut">
        Déconnexion
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
          <label class="form-label" for="acct-password">Nouveau mot de passe</label>
          <input
            id="acct-password"
            v-model="editPassword"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="100"
            autocomplete="new-password"
          />
          <ul class="requirements">
            <li
              v-for="req in PASSWORD_REQUIREMENTS"
              :key="req.label"
              class="requirement"
              :class="{ ok: req.test(editPassword) }"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round" width="13" height="13">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {{ req.label }}
            </li>
          </ul>
          <label class="form-label" for="acct-password-confirm">Confirmer le mot de passe</label>
          <input
            id="acct-password-confirm"
            v-model="editPasswordConfirm"
            class="form-input"
            type="password"
            placeholder="••••••••"
            maxlength="100"
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
  font-size: 0.82rem;
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
  font-size: 0.78rem;
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
  font-size: 0.78rem;
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
