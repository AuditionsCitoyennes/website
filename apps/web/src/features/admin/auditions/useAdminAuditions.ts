import { computed, ref } from "vue";
import type { AuditionArea } from "@ac/shared";
import { api } from "@/shared/api/client";
import { useAuthStore } from "@/features/auth";

/** An audition as the admin list receives it (see /api/auditions/admin/list). */
export interface AdminAudition {
  id: string;
  title: string;
  date: string;
  location: string;
  content: string;
  status: string | null;
  created_by: string | null;
  /** Where the Témoignages map files it (région, département, ville, lieu), and how precisely. */
  area?: AuditionArea | null;
  /** Gathers the testimonies sent from the site for one town hall and month. */
  audition_en_ligne?: boolean;
}

/**
 * The auditions of the admin list, and who may see what. Two lists: "Vos
 * auditions" for everyone, and under it, for super admins only, "Auditions
 * existantes" — every audition of the site, theirs included.
 */
export function useAdminAuditions() {
  const auth = useAuthStore();

  const auditions = ref<AdminAudition[]>([]);

  const myAuditions = computed(() => auditions.value.filter((a) => a.created_by === auth.user?.id));

  // What a plain admin may open is what the first list shows: their own.
  const reachableAuditions = computed(() =>
    auth.isSuperAdmin ? auditions.value : myAuditions.value,
  );

  async function fetchAuditions() {
    try {
      auditions.value = await api.get<AdminAudition[]>("/api/auditions/admin/list", true);
    } catch {
      auditions.value = [];
    }
  }

  return { auditions, myAuditions, reachableAuditions, fetchAuditions };
}
