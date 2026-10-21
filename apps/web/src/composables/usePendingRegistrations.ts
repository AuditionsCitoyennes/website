import { computed } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import type { PendingRegistration } from "@ac/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/** Start of the query's key: what the other admin panels invalidate. */
export const PENDING_REGISTRATIONS_KEY = ["admin", "pending-registrations"] as const;

/**
 * The registrations waiting for a super admin's decision.
 *
 * ONE shared query: the list under "Administrateurs" and the red dot on its
 * button read the same data, so accepting or refusing someone clears the dot
 * without the two having to talk to each other.
 *
 * Unlike the public data (see main.ts) this one is kept fresh — on return to
 * the tab, and once a minute while the tab is in front — so a registration
 * that arrives while the page is open shows up by itself. It is a handful of
 * rows, asked for by super admins only.
 */
export function usePendingRegistrations() {
  const auth = useAuthStore();
  const queryClient = useQueryClient();

  // Per account: nothing cached for one user is shown to the next one who
  // signs in on the same tab.
  const queryKey = computed(() => [...PENDING_REGISTRATIONS_KEY, auth.user?.id ?? null]);

  const query = useQuery({
    queryKey,
    queryFn: () => api.get<PendingRegistration[]>("/api/admin/registrations", true),
    enabled: computed(() => auth.isSuperAdmin),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
    retry: false,
  });

  // A failed load reads as "none": no dot, and the list says so itself.
  const registrations = computed(() => (auth.isSuperAdmin ? (query.data.value ?? []) : []));

  return {
    registrations,
    count: computed(() => registrations.value.length),
    /** True until the first answer, good or bad (not during later refreshes). */
    loading: computed(() => auth.isSuperAdmin && !query.isFetched.value),
    /** Answered at least once, and never successfully. */
    failed: computed(
      () => auth.isSuperAdmin && query.isFetched.value && query.data.value === undefined,
    ),
    refresh: () => query.refetch(),
    /** Someone has just been accepted or refused: gone from the list (and the
     *  dot) at once, without waiting for the refresh — which may fail. */
    remove: (userId: string) =>
      queryClient.setQueryData<PendingRegistration[]>(queryKey.value, (list) =>
        list?.filter((r) => r.user_id !== userId),
      ),
  };
}
