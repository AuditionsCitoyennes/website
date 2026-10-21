<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { AuditAction, AuditLogRow } from "@ac/shared";
import { api } from "@/shared/api/client";
import { formatDateShort } from "@/shared/format/dates";
import AuditionPreviewDialog from "./AuditionPreviewDialog.vue";

// Keyed by AuditAction, so an action added to the shared list without a label
// here fails the typecheck.
const ACTION_LABELS: Record<AuditAction, string> = {
  registration_approved: "Inscription acceptée",
  registration_declined: "Inscription refusée",
  role_deleted: "Rôle supprimé",
  account_deleted: "Compte supprimé",
  audition_created: "Audition créée",
  audition_updated: "Audition modifiée",
  audition_deleted: "Audition supprimée",
  testimony_created: "Témoignage ajouté",
  testimony_updated: "Témoignage modifié",
  testimony_deleted: "Témoignage supprimé",
  testimony_verified: "Témoignage confirmé",
  testimony_rejected: "Témoignage refusé",
  testimony_submitted: "Témoignage déposé en ligne",
};

// What the witness does through the emailed link: nobody is signed in.
const WITNESS_ACTIONS: readonly string[] = ["testimony_verified", "testimony_rejected"];

const FIELD_LABELS: Record<string, string> = {
  title: "titre",
  date: "date",
  location: "lieu",
  content: "texte",
  status: "statut",
  person_name: "nom",
  person_info: "informations",
  email: "email",
  topics: "thèmes",
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

function actionLabel(action: string): string {
  return Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action as AuditAction] : action;
}

/** Who did it. Without an account behind the entry it is the witness (their
 *  verification link) or, for everything else, an account deleted since: the
 *  entry outlives its author, whose id is then cleared. */
function actorLabel(entry: AuditLogRow): string {
  if (entry.user_email) return entry.user_email;
  if (WITNESS_ACTIONS.includes(entry.action)) return "Témoin (lien de vérification)";
  // The audition a witness's withdrawal left empty, deleted with it.
  if ((entry.metadata as Record<string, unknown> | null)?.by_witness === true) {
    return "Témoin (lien de vérification)";
  }
  if (entry.action === "testimony_submitted") return "Visiteur (formulaire Témoigner)";
  // Deleting one's own account: the author is the account named in the entry.
  const own = (entry.metadata as Record<string, unknown> | null)?.target_email;
  if (entry.action === "account_deleted" && typeof own === "string") return own;
  return "Compte supprimé depuis";
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** One readable line from an entry's metadata. Every field is optional: older
 *  entries and best-effort lookups leave gaps, and a gap is just left out. */
function formatDetails(entry: AuditLogRow): string {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : "");
  const count = (key: string) => (typeof meta[key] === "number" ? (meta[key] as number) : null);
  const fields = Array.isArray(meta.fields)
    ? meta.fields
        .filter((f): f is string => typeof f === "string")
        .map((f) => (Object.hasOwn(FIELD_LABELS, f) ? FIELD_LABELS[f] : f))
        .join(", ")
    : "";
  // Anything but a plain date is shown as it is: the formatter throws on a
  // date it cannot parse, and one bad row must not take the table down.
  const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDateShort(v) : v);
  const parts: string[] = [];

  switch (entry.action as AuditAction) {
    case "audition_created":
    case "audition_updated":
    case "audition_deleted": {
      const n = count("testimonies");
      if (text("title")) parts.push(`« ${text("title")} »`);
      if (entry.action !== "audition_updated") {
        const where = [text("date") && day(text("date")), text("location")];
        if (where.some(Boolean)) parts.push(where.filter(Boolean).join(", "));
      }
      if (fields) parts.push(`modifié : ${fields}`);
      if (text("status")) parts.push(text("status") === "published" ? "publiée" : "en brouillon");
      if (meta.emptied === true) parts.push("supprimée avec son dernier témoignage");
      if (n) {
        parts.push(
          entry.action === "audition_deleted"
            ? plural(n, "témoignage supprimé", "témoignages supprimés")
            : plural(n, "témoignage", "témoignages"),
        );
      }
      break;
    }
    case "testimony_created":
    case "testimony_updated":
    case "testimony_deleted":
    case "testimony_verified":
    case "testimony_rejected":
    case "testimony_submitted": {
      const n = count("testimonies");
      const again = entry.action === "testimony_updated" ? "nouvelle " : "";
      if (text("audition_title")) parts.push(`Audition « ${text("audition_title")} »`);
      if (n) parts.push(plural(n, "témoignage supprimé", "témoignages supprimés"));
      if (fields) parts.push(`modifié : ${fields}`);
      if (text("verification") === "sent") parts.push(`${again}vérification demandée par email`);
      if (text("verification") === "failed") parts.push("email de vérification non envoyé");
      if (text("verification") === "none") parts.push("sans vérification");
      if (meta.edited === true) parts.push("avec corrections du témoin");
      if (entry.action === "testimony_rejected") parts.push("témoignage retiré");
      if (entry.action === "testimony_submitted") {
        if (text("town_hall")) parts.push(text("town_hall") as string);
        if (meta.audition_created === true) parts.push("audition en ligne créée");
        parts.push("en attente de validation par email");
      }
      break;
    }
    default: {
      // Accounts and roles.
      const who = [text("target_email"), text("target_username") && `(${text("target_username")})`];
      if (who.some(Boolean)) parts.push(who.filter(Boolean).join(" "));
      if (text("role")) parts.push(`rôle ${text("role")}`);
    }
  }
  return parts.join(" · ");
}

// ---- Opening the audition an entry is about ----

/** The audition behind an entry, when there is one left to look at: the
 *  audition itself, or the one a testimony belongs to. */
function auditionIdOf(entry: AuditLogRow): string | null {
  if (entry.action === "audition_deleted") return null;
  if (entry.target_type === "audition" && entry.target_id) return entry.target_id;
  const id = (entry.metadata as Record<string, unknown> | null)?.audition_id;
  return typeof id === "string" && id ? id : null;
}

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
