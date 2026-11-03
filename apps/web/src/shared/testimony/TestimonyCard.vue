<script setup lang="ts">
import { computed } from "vue";
import { themesOf, type PublicTestimony } from "@ac/shared";
import { formatDateShort } from "@/shared/format/dates";
import HighlightText from "@/shared/testimony/HighlightText.vue";
import TestimonyText from "@/shared/testimony/TestimonyText.vue";
import ReportLink from "@/shared/testimony/ReportLink.vue";

const props = defineProps<{
  testimony: PublicTestimony;
  hideAudition?: boolean;
  highlight?: string;
  /** No « Signaler » (the admin's previews). */
  noReport?: boolean;
  /** Its audition, for « Signaler », where the testimony comes without it
   *  (the map panel's lists, under their audition). */
  auditionId?: string;
}>();

// Its themes as the theme filter names them (old tags read in the grid).
const themes = computed(() => themesOf(props.testimony.topics));
</script>

<template>
  <article class="testimony">
    <header class="t-head">
      <span class="t-name"><HighlightText :text="testimony.person_name" :query="highlight" /></span>
      <template v-if="testimony.person_info">
        <span class="t-sep" aria-hidden="true">·</span>
        <span class="t-info"
          ><HighlightText :text="testimony.person_info" :query="highlight"
        /></span>
      </template>
      <span v-if="testimony.verification_status === 'verified'" class="t-badge verified">
        Vérifié
      </span>
      <span v-else-if="testimony.verification_status === 'pending'" class="t-badge pending">
        En attente
      </span>
      <RouterLink
        v-if="testimony.audition && !hideAudition"
        :to="`/audition/${testimony.audition.id}`"
        class="t-audition"
      >
        {{ testimony.audition.location }}
        <span class="t-sep" aria-hidden="true">·</span>
        {{ formatDateShort(testimony.audition.date) }}
      </RouterLink>
    </header>

    <TestimonyText :content="testimony.content" :highlight="highlight" />

    <div v-if="themes.length || !noReport" class="t-foot">
      <div v-if="themes.length" class="t-topics">
        <span v-for="theme in themes" :key="theme" class="t-topic">{{ theme }}</span>
      </div>
      <ReportLink
        v-if="!noReport"
        :testimony="testimony"
        :audition-id="auditionId ?? testimony.audition?.id"
      />
    </div>
  </article>
</template>

<style scoped>
.testimony {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* Search-match highlight (rendered by HighlightText, so pierce the scope). */
.testimony :deep(mark.hl) {
  padding: 0 0.12em;
  border-radius: 0.2rem;
  background: hsl(var(--primary) / 0.28);
  color: inherit;
  font-weight: 600;
}

.t-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem 0.5rem;
  /* The byline's size, so the "·" between its parts is that size too. */
  font-size: var(--text-ui);
}

.t-name {
  font-weight: 600;
  font-size: var(--text-ui);
  color: hsl(var(--foreground));
}

.t-sep {
  color: hsl(var(--muted-foreground) / 0.6);
}

.t-info {
  font-size: var(--text-ui);
  font-style: italic;
  color: hsl(var(--muted-foreground));
}

.t-badge {
  align-self: center;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: var(--text-caption);
  font-weight: 600;
  border: 1px solid transparent;
}

.t-badge.verified {
  background: hsl(var(--civic-green) / 0.12);
  color: hsl(var(--civic-green));
  border-color: hsl(var(--civic-green) / 0.25);
}

.t-badge.pending {
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  border-color: hsl(var(--border));
}

.t-audition {
  margin-left: auto;
  align-self: center;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  transition: var(--transition-smooth);
}

.t-audition:hover {
  color: hsl(var(--primary));
}

/* Content as a quotation: hanging coloured guillemets + a soft left accent.
   (Rendered by TestimonyText — one per answer for a testimony sent online.) */
.testimony :deep(.t-quote) {
  margin: 0;
  padding-left: 0.85rem;
  border-left: 2px solid hsl(var(--primary) / 0.25);
  color: hsl(var(--foreground) / 0.9);
  font-size: var(--text-body);
  line-height: var(--lh-body);
  white-space: pre-line;
}

.testimony :deep(.t-quote)::before {
  content: "«\00a0";
  color: hsl(var(--primary));
  font-weight: 600;
}

.testimony :deep(.t-quote)::after {
  content: "\00a0»";
  color: hsl(var(--primary));
  font-weight: 600;
}

.t-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.75rem;
}

.t-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.t-topic {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  background: hsl(var(--secondary) / 0.7);
  color: hsl(var(--secondary-foreground));
  font-size: var(--text-caption);
}
</style>
