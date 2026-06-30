<script setup lang="ts">
import type { PublicTestimony } from "@ac/shared";
import { formatDateShort } from "@/lib/format";
import HighlightText from "@/components/HighlightText.vue";

defineProps<{ testimony: PublicTestimony; hideAudition?: boolean; highlight?: string }>();
</script>

<template>
  <article class="testimony">
    <header class="t-head">
      <span class="t-name"><HighlightText :text="testimony.person_name" :query="highlight" /></span>
      <template v-if="testimony.person_info">
        <span class="t-sep" aria-hidden="true">·</span>
        <span class="t-info"><HighlightText :text="testimony.person_info" :query="highlight" /></span>
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

    <blockquote class="t-quote"><HighlightText :text="testimony.content" :query="highlight" /></blockquote>

    <div v-if="testimony.topics && testimony.topics.length" class="t-topics">
      <span v-for="topic in testimony.topics" :key="topic" class="t-topic">{{ topic }}</span>
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
}

.t-name {
  font-weight: 600;
  font-size: clamp(0.85rem, 0.69rem + 0.7vw, 0.96rem);
  color: hsl(var(--foreground));
}

.t-sep {
  color: hsl(var(--muted-foreground) / 0.6);
}

.t-info {
  font-size: clamp(0.79rem, 0.65rem + 0.6vw, 0.88rem);
  font-style: italic;
  color: hsl(var(--muted-foreground));
}

.t-badge {
  align-self: center;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.66rem;
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
  font-size: 0.72rem;
  color: hsl(var(--muted-foreground));
  transition: var(--transition-smooth);
}

.t-audition:hover {
  color: hsl(var(--primary));
}

/* Content as a quotation: hanging coloured guillemets + a soft left accent. */
.t-quote {
  margin: 0;
  padding-left: 0.85rem;
  border-left: 2px solid hsl(var(--primary) / 0.25);
  color: hsl(var(--foreground) / 0.9);
  font-size: clamp(0.82rem, 0.66rem + 0.7vw, 0.92rem);
  line-height: 1.62;
  white-space: pre-line;
}

.t-quote::before {
  content: "«\00a0";
  color: hsl(var(--primary));
  font-weight: 600;
}

.t-quote::after {
  content: "\00a0»";
  color: hsl(var(--primary));
  font-weight: 600;
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
  font-size: 0.7rem;
}
</style>
