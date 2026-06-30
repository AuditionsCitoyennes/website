<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { AuditLogRow } from "@ac/shared";
import { api } from "@/lib/api";

const ACTION_LABELS: Record<string, string> = {
  registration_approved: "Inscription acceptée",
  registration_declined: "Inscription refusée",
  role_deleted: "Rôle supprimé",
  account_deleted: "Compte supprimé",
};

const PAGE_SIZE = 10;

const entries = ref<AuditLogRow[]>([]);
const loading = ref(true);
const page = ref(0);
const hasMore = ref(false);

async function fetchEntries() {
  loading.value = true;
  try {
    // Ask for one extra row to know whether a next page exists.
    const rows = await api.get<AuditLogRow[]>(
      `/api/admin/audit-log?limit=${PAGE_SIZE + 1}&offset=${page.value * PAGE_SIZE}`,
      true,
    );
    hasMore.value = rows.length > PAGE_SIZE;
    entries.value = rows.slice(0, PAGE_SIZE);
  } catch {
    entries.value = [];
    hasMore.value = false;
  } finally {
    loading.value = false;
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDetails(entry: AuditLogRow): string {
  const meta = entry.metadata as Record<string, string> | null;
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.target_email) parts.push(meta.target_email);
  if (meta.target_username) parts.push(`(${meta.target_username})`);
  return parts.join(" ");
}

onMounted(fetchEntries);
watch(page, fetchEntries);
</script>

<template>
  <section class="admin-card">
    <h2 class="admin-card-title">Journal d'audit</h2>
    <p class="admin-card-desc">Historique des actions d'administration</p>

    <div v-if="loading && entries.length === 0" class="state">
      <span class="spinner" aria-label="Chargement"></span>
    </div>
    <p v-else-if="entries.length === 0" class="empty">Aucune entrée dans le journal.</p>
    <template v-else>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Utilisateur</th>
              <th>Action</th>
              <th>Détails</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id">
              <td class="nowrap">{{ formatDate(entry.created_at) }}</td>
              <td>{{ entry.user_email || "Système" }}</td>
              <td>{{ ACTION_LABELS[entry.action] || entry.action }}</td>
              <td>{{ formatDetails(entry) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="pager">
        <button
          type="button"
          class="ac-btn ac-btn--outline ac-btn--sm"
          :disabled="page === 0 || loading"
          @click="page -= 1"
        >
          ← Précédent
        </button>
        <span class="page-label">Page {{ page + 1 }}</span>
        <button
          type="button"
          class="ac-btn ac-btn--outline ac-btn--sm"
          :disabled="!hasMore || loading"
          @click="page += 1"
        >
          Suivant →
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.state {
  display: flex;
  justify-content: center;
  padding: 1.25rem;
  color: hsl(var(--primary));
}

.empty {
  color: hsl(var(--muted-foreground));
  font-size: 0.88rem;
}

.table-wrap {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.table th {
  text-align: left;
  padding: 0.5rem 1rem 0.5rem 0;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  border-bottom: 1px solid hsl(var(--border));
}

.table td {
  padding: 0.55rem 1rem 0.55rem 0;
  border-bottom: 1px solid hsl(var(--border) / 0.6);
  color: hsl(var(--foreground));
}

.table tr:last-child td {
  border-bottom: none;
}

.nowrap {
  white-space: nowrap;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 1rem;
}

.page-label {
  font-size: 0.85rem;
  color: hsl(var(--muted-foreground));
}
</style>
