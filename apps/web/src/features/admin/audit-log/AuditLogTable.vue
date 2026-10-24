<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { AuditLogRow } from "@ac/shared";
import { api } from "@/shared/api/client";
import AuditionPreviewDialog from "./AuditionPreviewDialog.vue";
import { actionLabel, actorLabel, auditionIdOf, formatDate, formatDetails } from "./auditEntry";

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

// ---- Opening the audition an entry is about ----

const preview = ref<{ auditionId: string; context: string } | null>(null);

function openPreview(entry: AuditLogRow) {
  const auditionId = auditionIdOf(entry);
  if (!auditionId) return;
  preview.value = {
    auditionId,
    context: `${actionLabel(entry.action)} · ${actorLabel(entry)} · ${formatDate(entry.created_at)}`,
  };
}

/** A click anywhere on the row opens it too — unless it ends a text selection
 *  (copying an email out of the log must stay possible). */
function onRowClick(entry: AuditLogRow) {
  if (window.getSelection()?.toString()) return;
  openPreview(entry);
}

onMounted(fetchEntries);
watch(page, fetchEntries);

defineExpose({ refresh: fetchEntries });
</script>

<template>
  <section class="admin-card">
    <h2 class="admin-card-title">Journal d'audit</h2>
    <p class="admin-card-desc">
      Historique des actions d'administration et des confirmations de témoignages. Cliquez sur une
      ligne pour voir l'audition concernée.
    </p>

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
              <th><span class="visually-hidden">Audition</span></th>
            </tr>
          </thead>
          <tbody>
            <!-- The row is clickable for the mouse; the button in its last cell
                 is the same action for the keyboard and screen readers. -->
            <tr
              v-for="entry in entries"
              :key="entry.id"
              :class="{ clickable: auditionIdOf(entry) !== null }"
              @click="onRowClick(entry)"
            >
              <td class="nowrap">{{ formatDate(entry.created_at) }}</td>
              <td>{{ actorLabel(entry) }}</td>
              <td>{{ actionLabel(entry.action) }}</td>
              <td>{{ formatDetails(entry) }}</td>
              <td class="see">
                <button
                  v-if="auditionIdOf(entry) !== null"
                  type="button"
                  class="ac-btn ac-btn--ghost ac-btn--icon ac-btn--sm"
                  title="Voir l'audition"
                  aria-label="Voir l'audition"
                  @click.stop="openPreview(entry)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="17"
                    height="17"
                    aria-hidden="true"
                  >
                    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </td>
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

    <AuditionPreviewDialog
      :audition-id="preview?.auditionId ?? null"
      :context="preview?.context"
      @close="preview = null"
    />
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
  font-size: var(--text-body);
}

.table-wrap {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-ui);
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

.table tr.clickable {
  cursor: pointer;
  transition: var(--transition-smooth);
}

.table tr.clickable:hover td {
  background: hsl(var(--accent) / 0.4);
}

.table td.see {
  width: 1%;
  padding-right: 0;
  text-align: right;
  color: hsl(var(--muted-foreground));
}

/* Said, not shown: the heading of the column that only holds the button. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}
</style>
