<script setup lang="ts">
import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { AuditionPreview } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { formatDateLong } from "@/shared/format/dates";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import TestimonyCard from "@/shared/testimony/TestimonyCard.vue";

// Read-only look at one audition, opened from an entry of the audit log: what
// an admin added (or touched), as it stands now, draft or published.
const props = defineProps<{
  /** The audition to show; null keeps the dialog closed. */
  auditionId: string | null;
  /** The log entry it was opened from, in a few words (who, what, when). */
  context?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const query = useQuery({
  queryKey: computed(() => ["admin", "audition-preview", props.auditionId]),
  queryFn: () => api.get<AuditionPreview>(`/api/admin/auditions/${props.auditionId}`, true),
  enabled: computed(() => props.auditionId !== null),
  // Always the audition as it is NOW: it may have changed since the entry.
  staleTime: 0,
  gcTime: 0,
  retry: false,
});

const audition = computed(() => (props.auditionId ? (query.data.value ?? null) : null));
// The log outlives what it describes: the audition may be gone by now.
const gone = computed(() => {
  const error = query.error.value;
  return error instanceof ApiError && error.status === 404;
});

const testimonies = computed(() =>
  // The embedded join has no guaranteed order — oldest first, like the public page.
  [...(audition.value?.testimonies ?? [])]
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .map((t) => ({ ...t, audition: null })),
);

const title = computed(() => audition.value?.title ?? "Audition");
const description = computed(() =>
  audition.value
    ? `${formatDateLong(audition.value.date)} · ${audition.value.location}`
    : undefined,
);
</script>

<template>
  <ModalDialog
    :open="auditionId !== null"
    :title="title"
    :description="description"
    dismissible
    wide
    @close="emit('close')"
  >
    <div v-if="query.isPending.value" class="state">
      <span class="spinner" aria-label="Chargement"></span>
    </div>

    <p v-else-if="!audition" class="state state-text">
      {{
        gone
          ? "Cette audition n'existe plus : elle a été supprimée depuis."
          : "Impossible de charger cette audition."
      }}
    </p>

    <div v-else class="preview">
      <div class="facts">
        <span class="chip" :class="audition.status === 'published' ? 'chip--green' : 'chip--amber'">
          {{ audition.status === "published" ? "Publiée" : "Brouillon" }}
        </span>
        <span class="chip chip--outline">
          {{ testimonies.length }} témoignage{{ testimonies.length > 1 ? "s" : "" }}
        </span>
        <span v-if="context" class="context">{{ context }}</span>
      </div>

      <section>
        <h3 class="section-title">Contexte de l'audition</h3>
        <p class="content">{{ audition.content }}</p>
      </section>

      <section>
        <h3 class="section-title">Témoignages</h3>
        <div v-if="testimonies.length > 0" class="testimonies">
          <TestimonyCard
            v-for="t in testimonies"
            :key="t.id"
            :testimony="t"
            hide-audition
            no-report
          />
        </div>
        <p v-else class="none">Aucun témoignage pour cette audition.</p>
      </section>
    </div>
  </ModalDialog>
</template>

<style scoped>
.state {
  display: flex;
  justify-content: center;
  padding: 1.5rem 0;
  color: hsl(var(--primary));
}

.state-text {
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
  text-align: center;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 1.3rem;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
}

.context {
  margin-left: auto;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.section-title {
  margin-bottom: 0.55rem;
  /* An uppercase kicker, set like the audition popup's "Contexte de l'audition"
     (AuditionAdminList .popup-label): an h3 is Bebas, unreadable this small. */
  font-family: var(--font-sans);
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
}

.content {
  color: hsl(var(--foreground) / 0.9);
  font-size: var(--text-body);
  line-height: var(--lh-body);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.testimonies {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.none {
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}
</style>
