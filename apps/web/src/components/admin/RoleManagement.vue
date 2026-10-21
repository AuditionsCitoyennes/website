<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import type { RoleWithDetails } from "@ac/shared";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import { PENDING_REGISTRATIONS_KEY } from "@/composables/usePendingRegistrations";
import { useAuthStore } from "@/stores/auth";

const { toast } = useToast();
const auth = useAuthStore();
const queryClient = useQueryClient();
const roles = ref<RoleWithDetails[]>([]);

async function fetchRoles() {
  try {
    roles.value = await api.get<RoleWithDetails[]>("/api/admin/roles", true);
  } catch {
    roles.value = [];
  }
}

async function removeRole(role: RoleWithDetails) {
  if (!confirm("Êtes-vous sûr de vouloir supprimer ce rôle?")) return;
  try {
    await api.del(`/api/admin/roles/${role.id}`);
    toast({ title: "Succès!", description: "Rôle supprimé" });
    // An account left without a role is a registration waiting again: the
    // list above and the dot on the button follow at once.
    void queryClient.invalidateQueries({ queryKey: PENDING_REGISTRATIONS_KEY });
    await fetchRoles();
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  }
}

onMounted(fetchRoles);

defineExpose({ refresh: fetchRoles });
</script>

<template>
  <section class="admin-card">
    <h2 class="admin-card-title">Gestion des administrateurs</h2>
    <p class="admin-card-desc">Gérez les rôles d'administration</p>

    <div v-if="roles.length > 0" class="list">
      <div v-for="role in roles" :key="role.id" class="row">
        <div>
          <p class="row-name">
            {{ role.username || "Sans nom" }}{{ role.user_id === auth.user?.id ? " (Moi)" : "" }}
          </p>
          <p class="row-email">{{ role.email }}</p>
          <span class="chip">{{ role.role }}</span>
        </div>
        <button
          v-if="role.role !== 'super_admin'"
          type="button"
          class="ac-btn ac-btn--danger ac-btn--sm ac-btn--icon"
          title="Supprimer ce rôle"
          @click="removeRole(role)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="15"
            height="15"
          >
            <polyline points="3 6 5 6 21 6" />
            <path
              d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
            />
          </svg>
        </button>
      </div>
    </div>
    <p v-else class="empty">Aucun rôle configuré</p>
  </section>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-radius: 0.6rem;
  background: hsl(var(--muted));
}

.row-name {
  font-weight: 600;
  font-size: var(--text-body);
  color: hsl(var(--foreground));
}

.row-email {
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
  margin-bottom: 0.3rem;
}

.empty {
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}
</style>
