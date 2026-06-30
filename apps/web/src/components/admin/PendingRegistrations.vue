<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { PendingRegistration } from "@ac/shared";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import { formatDateShort } from "@/lib/format";

const emit = defineEmits<{
  approved: [];
}>();

const { toast } = useToast();
const registrations = ref<PendingRegistration[]>([]);
const loading = ref(true);
const processingUserId = ref<string | null>(null);

async function fetchRegistrations() {
  loading.value = true;
  try {
    registrations.value = await api.get<PendingRegistration[]>("/api/admin/registrations", true);
  } catch {
    registrations.value = [];
  } finally {
    loading.value = false;
  }
}

async function handle(action: "approve" | "decline", reg: PendingRegistration) {
  const name = reg.username || reg.email;
  if (
    action === "decline" &&
    !confirm(`Êtes-vous sûr de vouloir refuser l'inscription de ${name} ?`)
  ) {
    return;
  }

  processingUserId.value = reg.user_id;
  try {
    await api.post(`/api/admin/registrations/${reg.user_id}`, {
      action,
      email: reg.email,
      username: reg.username,
    });
    toast({
      title: action === "approve" ? "Inscription acceptée" : "Inscription refusée",
      description:
        action === "approve"
          ? `${name} a été ajouté(e) comme administrateur`
          : `L'inscription de ${name} a été refusée`,
    });
    await fetchRegistrations();
    if (action === "approve") emit("approved");
  } catch (e) {
    toast({
      title: "Erreur",
      description: e instanceof ApiError ? e.message : "Une erreur est survenue",
      variant: "destructive",
    });
  } finally {
    processingUserId.value = null;
  }
}

onMounted(fetchRegistrations);
</script>

<template>
  <section class="admin-card">
    <h2 class="admin-card-title">Inscriptions en attente</h2>
    <p class="admin-card-desc">Validez ou refusez les nouvelles inscriptions</p>

    <div v-if="loading" class="state">
      <span class="spinner" aria-label="Chargement"></span>
    </div>
    <div v-else-if="registrations.length > 0" class="list">
      <div v-for="reg in registrations" :key="reg.user_id" class="row">
        <div class="row-info">
          <p class="row-name">{{ reg.username || "Sans nom" }}</p>
          <p class="row-email">{{ reg.email }}</p>
          <p v-if="reg.bio" class="row-bio">{{ reg.bio }}</p>
          <p class="row-date">Inscrit le {{ formatDateShort(reg.created_at) }}</p>
        </div>
        <div class="row-actions">
          <button
            type="button"
            class="ac-btn ac-btn--success ac-btn--sm"
            :disabled="processingUserId === reg.user_id"
            @click="handle('approve', reg)"
          >
            <span v-if="processingUserId === reg.user_id" class="spinner"></span>
            Accepter
          </button>
          <button
            type="button"
            class="ac-btn ac-btn--danger ac-btn--sm"
            :disabled="processingUserId === reg.user_id"
            @click="handle('decline', reg)"
          >
            <span v-if="processingUserId === reg.user_id" class="spinner"></span>
            Refuser
          </button>
        </div>
      </div>
    </div>
    <p v-else class="empty">Aucune inscription en attente</p>
  </section>
</template>

<style scoped>
.state {
  display: flex;
  justify-content: center;
  padding: 1rem;
  color: hsl(var(--primary));
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  border-radius: 0.6rem;
  background: hsl(var(--muted));
}

.row-info {
  flex: 1;
  min-width: 0;
}

.row-name {
  font-weight: 600;
  color: hsl(var(--foreground));
}

.row-email {
  font-size: 0.85rem;
  color: hsl(var(--muted-foreground));
}

.row-bio {
  font-size: 0.85rem;
  color: hsl(var(--muted-foreground));
  margin-top: 0.25rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.row-date {
  font-size: 0.75rem;
  color: hsl(var(--muted-foreground));
  margin-top: 0.25rem;
}

.row-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.empty {
  color: hsl(var(--muted-foreground));
  font-size: 0.88rem;
}

@media (max-width: 560px) {
  .row {
    flex-direction: column;
  }
}
</style>
