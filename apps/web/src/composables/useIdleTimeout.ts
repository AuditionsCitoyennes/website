import { onBeforeUnmount, onMounted } from "vue";
import { useRouter } from "vue-router";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/composables/useToast";

const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const WARNING_BEFORE = 2 * 60 * 1000; // warn 2 min before
const THROTTLE_MS = 10_000; // reset at most every 10s

/** Auto sign-out after 30 minutes of inactivity (used on the admin page). */
export function useIdleTimeout() {
  const router = useRouter();
  const { toast } = useToast();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReset = Date.now();

  async function signOut() {
    await supabase.auth.signOut();
    toast({
      title: "Session expirée",
      description: "Vous avez été déconnecté après 30 minutes d'inactivité.",
      variant: "destructive",
    });
    router.push("/auth");
  }

  function resetTimers() {
    const now = Date.now();
    if (now - lastReset < THROTTLE_MS) return;
    lastReset = now;

    if (warnTimer) clearTimeout(warnTimer);
    if (idleTimer) clearTimeout(idleTimer);

    warnTimer = setTimeout(() => {
      toast({
        title: "Inactivité détectée",
        description: "Vous serez déconnecté dans 2 minutes si aucune activité n'est détectée.",
      });
    }, IDLE_TIMEOUT - WARNING_BEFORE);

    idleTimer = setTimeout(signOut, IDLE_TIMEOUT);
  }

  const events = ["mousemove", "keydown", "scroll", "touchstart"] as const;

  onMounted(() => {
    events.forEach((e) => window.addEventListener(e, resetTimers, { passive: true }));
    // Arm immediately (bypass throttle for the first run).
    lastReset = 0;
    resetTimers();
  });

  onBeforeUnmount(() => {
    events.forEach((e) => window.removeEventListener(e, resetTimers));
    if (warnTimer) clearTimeout(warnTimer);
    if (idleTimer) clearTimeout(idleTimer);
  });
}
