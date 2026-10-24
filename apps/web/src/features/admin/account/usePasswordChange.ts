import { computed, ref } from "vue";
import { isAuthError } from "@supabase/supabase-js";
import { supabase } from "@/shared/api/supabase";
import { useAuthStore } from "@/features/auth";
import { checkCurrentPassword, hasPassword, passwordSchema } from "@/features/auth/account";
import { useToast } from "@/shared/ui/toast/useToast";

/**
 * Changing the signed-in account's password: the form's three fields, whether
 * the current password is asked for, and the change itself — the current
 * password checked first, then Supabase's own answer read from its error code.
 */
export function usePasswordChange() {
  const auth = useAuthStore();
  const { toast } = useToast();

  const currentPassword = ref("");
  const editPassword = ref("");
  const editPasswordConfirm = ref("");
  const savingPassword = ref(false);

  // Changing the password asks for the current one first. An account created
  // through Google has none yet: it sets its first password without it — unless
  // Supabase says it does have one (see updatePassword), which the account's
  // description cannot always tell.
  const currentPasswordRequired = ref(false);
  const asksCurrentPassword = computed(
    () => currentPasswordRequired.value || hasPassword(auth.user, auth.session?.access_token),
  );

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

  return {
    currentPassword,
    editPassword,
    editPasswordConfirm,
    savingPassword,
    asksCurrentPassword,
    updatePassword,
  };
}
