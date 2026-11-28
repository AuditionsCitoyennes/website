// A return from Supabase Auth that landed on a page accepting one (/admin,
// /auth, /reset-password), settled before the pages mount: main.ts waits for
// this, so every page finds the session as it will stay. The decision is
// lib/authReturn.ts; here are the client, the question and the messages.

import { ref } from "vue";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { supabase } from "@/shared/api/supabase";
import { authArrival, type AuthArrival } from "@/shared/api/authArrival";
import { useToast } from "@/shared/ui/toast/useToast";
import {
  acceptsAuthReturn,
  isResetPage,
  settleAuthReturn,
  type Account,
  type ReturnDeps,
} from "./lib/authReturn";

/** What the password page finds when it opens (ResetPasswordPage.vue): a
 *  recovery link's session, for the account named; or a recovery link the
 *  visitor did not use, having kept the account that was signed in. */
export type RecoveryHandOver =
  | { state: "none" }
  | { state: "ready"; email: string | null }
  | { state: "kept"; email: string | null };

export const recoveryHandOver = ref<RecoveryHandOver>({ state: "none" });

/** Whether this page load's return is still being settled: main.ts stops
 *  waiting for a slow Auth, and the pages then show their loader meanwhile. */
export const returnPending = ref(authArrival !== null && acceptsAuthReturn(authArrival.path));

/** The new password is set: the recovery is over. */
export function endRecovery() {
  recoveryHandOver.value = { state: "none" };
}

const AUTH_ATTEMPTS = 2;
const AUTH_TIMEOUT_MS = 4000;

/** The account of an access token, asked of Auth directly: the client's own
 *  getUser(token) drops the kept session when Auth does not know the token's. */
async function accountOf(accessToken: string): Promise<Account | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      });
      if (res.ok) {
        const user = (await res.json()) as { id?: unknown; email?: unknown };
        if (typeof user.id !== "string") return null;
        return { id: user.id, email: typeof user.email === "string" ? user.email : null };
      }
      if (res.status < 500 && res.status !== 429) return null;
    } catch {
      /* no answer: asked again below */
    }
    if (attempt === AUTH_ATTEMPTS) throw new Error("Auth cannot be reached");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const accountLabel = (account: Account) => account.email ?? "sans adresse email";

const deps: ReturnDeps = {
  async current() {
    const user = (await supabase.auth.getSession()).data.session?.user;
    return user ? { id: user.id, email: user.email ?? null } : null;
  },
  whoIs: accountOf,
  confirmSwitch: (current, incoming) =>
    window.confirm(
      `Vous êtes connecté avec le compte ${accountLabel(current)}.\n\n` +
        `Le lien que vous venez d'ouvrir connecte un autre compte : ${accountLabel(incoming)}.\n\n` +
        "Changer de compte ?",
    ),
  async leave() {
    await supabase.auth.signOut({ scope: "local" });
  },
  async store(accessToken, refreshToken) {
    // The two tokens only: a provider's own token, when the return has one,
    // is not kept.
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (isAuthRetryableFetchError(error)) throw error;
    if (error || !data.user) return null;
    // The address the browser arrived at held this refresh token, and the
    // browser's history list may keep that address: renewing the session now
    // spends it, so what stays there opens nothing for long.
    await supabase.auth.refreshSession();
    const user = (await supabase.auth.getSession()).data.session?.user;
    return user ? { id: user.id, email: user.email ?? null } : null;
  },
};

export async function consumeAuthReturn(arrival: AuthArrival): Promise<void> {
  const { toast } = useToast();
  const onResetPage = isResetPage(arrival.path);
  const settled = await settleAuthReturn(arrival.ret, deps);
  switch (settled.outcome) {
    case "signed-in":
      if (onResetPage && settled.type === "recovery") {
        recoveryHandOver.value = { state: "ready", email: settled.account.email };
      } else if (settled.type === "email_change") {
        toast({
          title: "Adresse email modifiée",
          description: `Votre compte utilise maintenant l'adresse ${accountLabel(settled.account)}.`,
        });
      }
      break;
    case "kept":
      if (onResetPage) recoveryHandOver.value = { state: "kept", email: settled.account.email };
      toast({
        title: "Compte inchangé",
        description: `Vous restez connecté avec le compte ${accountLabel(settled.account)}.`,
      });
      break;
    case "refused":
      // The password page says it itself (« Lien invalide »).
      if (!onResetPage) {
        toast({
          title: "Lien invalide ou expiré",
          description:
            "La connexion n'a pas abouti. Demandez un nouveau lien, ou reconnectez-vous.",
          variant: "destructive",
        });
      }
      break;
    case "notice":
      toast({
        title: "Première confirmation enregistrée",
        description:
          "Ouvrez maintenant le lien envoyé à l'autre adresse pour terminer le changement d'email.",
      });
      break;
    case "unreachable":
      toast({
        title: "Erreur",
        description: "Le service de connexion ne répond pas. Veuillez réessayer dans un instant.",
        variant: "destructive",
      });
      break;
    case "nothing":
      break;
  }
  returnPending.value = false;
}
