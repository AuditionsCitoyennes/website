import { defineStore } from "pinia";
import { ref } from "vue";
import type { Session, User } from "@supabase/supabase-js";
import { api } from "@/shared/api/client";
import {
  loadSupabase,
  visitMayHaveSession,
  whenSupabase,
  type AuthClientInstance,
} from "@/shared/api/supabaseLazy";

interface MeResponse {
  user: { id: string; email: string | null; metadata: Record<string, unknown> };
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref<User | null>(null);
  const session = ref<Session | null>(null);
  const isAdmin = ref(false);
  const isSuperAdmin = ref(false);
  const loading = ref(true);
  let initialized = false;

  async function refreshRoles() {
    if (!session.value) {
      isAdmin.value = false;
      isSuperAdmin.value = false;
      return;
    }
    try {
      const me = await api.get<MeResponse>("/api/me", true);
      isAdmin.value = me.isAdmin;
      isSuperAdmin.value = me.isSuperAdmin;
    } catch {
      isAdmin.value = false;
      isSuperAdmin.value = false;
    }
  }

  /** The session read from the client, then followed: once, as soon as the
   *  client is made (by init, or by a page that signs in). */
  let following: Promise<void> | null = null;
  function follow(client: AuthClientInstance): Promise<void> {
    following ??= followSession(client);
    return following;
  }
  async function followSession(client: AuthClientInstance) {
    const { data } = await client.auth.getSession();
    session.value = data.session;
    user.value = data.session?.user ?? null;
    await refreshRoles();
    loading.value = false;

    client.auth.onAuthStateChange((event, newSession) => {
      // INITIAL_SESSION replays the session we just loaded above — skip it
      // to avoid a duplicate /api/me roundtrip on every app start.
      if (event === "INITIAL_SESSION") return;
      session.value = newSession;
      user.value = newSession?.user ?? null;
      refreshRoles();
    });
  }

  async function init() {
    if (initialized) return;
    initialized = true;

    // The client is downloaded only for a visit that may be signed in
    // (shared/api/authPresence.ts); for any other, nobody is signed in until
    // a page that signs in makes the client, and the store follows it then.
    whenSupabase((client) => void follow(client));
    if (visitMayHaveSession()) {
      await follow(await loadSupabase());
    } else {
      loading.value = false;
      // Signed in from another tab: its session lands in this storage.
      window.addEventListener("storage", onStorage);
    }
  }

  function onStorage() {
    if (!visitMayHaveSession()) return;
    window.removeEventListener("storage", onStorage);
    void loadSupabase();
  }

  async function signOut() {
    await (await loadSupabase()).auth.signOut();
    session.value = null;
    user.value = null;
    isAdmin.value = false;
    isSuperAdmin.value = false;
  }

  return { user, session, isAdmin, isSuperAdmin, loading, init, refreshRoles, signOut };
});
