import { defineStore } from "pinia";
import { ref } from "vue";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";

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

  async function init() {
    if (initialized) return;
    initialized = true;

    const { data } = await supabase.auth.getSession();
    session.value = data.session;
    user.value = data.session?.user ?? null;
    await refreshRoles();
    loading.value = false;

    supabase.auth.onAuthStateChange((event, newSession) => {
      // INITIAL_SESSION replays the session we just loaded above — skip it
      // to avoid a duplicate /api/me roundtrip on every app start.
      if (event === "INITIAL_SESSION") return;
      session.value = newSession;
      user.value = newSession?.user ?? null;
      refreshRoles();
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
    session.value = null;
    user.value = null;
    isAdmin.value = false;
    isSuperAdmin.value = false;
  }

  return { user, session, isAdmin, isSuperAdmin, loading, init, refreshRoles, signOut };
});
