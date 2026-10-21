<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { themesOf } from "@ac/shared";
import { api } from "@/shared/api/client";
import { formatDateLong } from "@/shared/format/dates";
import TestimonyText from "@/shared/testimony/TestimonyText.vue";

interface DetailTestimony {
  id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
  verification_status: string | null;
  created_at: string | null;
}

interface AuditionDetail {
  id: string;
  title: string;
  date: string;
  location: string;
  content: string;
  testimonies: DetailTestimony[];
}

const route = useRoute();
const id = computed(() => String(route.params.id));

const query = useQuery({
  queryKey: computed(() => ["audition", id.value]),
  queryFn: () => api.get<AuditionDetail>(`/api/auditions/${id.value}`),
  retry: false,
});

const audition = computed(() => query.data.value ?? null);
const testimonies = computed(() => {
  const list = audition.value?.testimonies ?? [];
  // The embedded join has no guaranteed order — oldest first, like the old app.
  return [...list].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
});
</script>

<template>
  <div class="detail container-page">
    <RouterLink to="/temoignages" class="back-link">← Retour aux témoignages</RouterLink>

    <div v-if="query.isLoading.value" class="state">Chargement…</div>

    <div v-else-if="!audition" class="state">
      <h2 class="notfound-title">Audition non trouvée</h2>
      <RouterLink to="/temoignages" class="ac-btn ac-btn--primary">
        Retour aux témoignages
      </RouterLink>
    </div>

    <template v-else>
      <header class="head">
        <h1>{{ audition.title }}</h1>
        <div class="meta">
          <span>{{ formatDateLong(audition.date) }}</span>
          <span class="dot">·</span>
          <span>{{ audition.location }}</span>
          <span class="dot">·</span>
          <span> {{ testimonies.length }} témoignage{{ testimonies.length > 1 ? "s" : "" }} </span>
        </div>
      </header>

      <div class="list">
        <article
          v-for="(t, index) in testimonies"
          :key="t.id"
          class="t fade-in"
          :style="{ animationDelay: `${Math.min(index, 10) * 80}ms` }"
        >
          <header class="t-head">
            <span class="t-name">{{ t.person_name }}</span>
            <template v-if="t.person_info">
              <span class="t-sep" aria-hidden="true">·</span>
              <span class="t-info">{{ t.person_info }}</span>
            </template>
            <span v-if="t.verification_status === 'verified'" class="t-badge">Vérifié</span>
          </header>

          <TestimonyText :content="t.content" format />

          <!-- The grid themes, as on the map and in the filters: the old tags
               ("démocratie", "ruralité"…) stay for the admin only. -->
          <div v-if="themesOf(t.topics).length" class="t-topics">
            <span v-for="theme in themesOf(t.topics)" :key="theme" class="t-topic">{{
              theme
            }}</span>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail {
  max-width: 880px;
  padding-block: 2rem 4rem;
}

.back-link {
  display: inline-block;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
  font-weight: 500;
  margin-bottom: 1.6rem;
  transition: var(--transition-smooth);
}

.back-link:hover {
  color: hsl(var(--primary));
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.2rem;
  padding: 4rem 1rem;
  text-align: center;
  color: hsl(var(--muted-foreground));
}

.notfound-title {
  font-size: var(--text-section);
  text-transform: uppercase;
  color: hsl(var(--foreground));
}

.head {
  margin-bottom: 2.2rem;
}

.head h1 {
  font-size: var(--text-page);
  text-transform: uppercase;
  color: hsl(var(--foreground));
  margin-bottom: 0.7rem;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
}

.dot {
  opacity: 0.5;
}

.list {
  display: flex;
  flex-direction: column;
}

.t {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 1.6rem 0;
}

.t + .t {
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.t-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem 0.5rem;
  font-size: var(--text-ui); /* name · info, and the dot between them */
}

.t-name {
  font-weight: 600;
  color: hsl(var(--foreground));
}

.t-sep {
  color: hsl(var(--muted-foreground) / 0.6);
}

.t-info {
  font-style: italic;
  color: hsl(var(--muted-foreground));
}

.t-badge {
  align-self: center;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  font-size: var(--text-caption);
  font-weight: 600;
  background: hsl(var(--civic-green) / 0.12);
  color: hsl(var(--civic-green));
  border: 1px solid hsl(var(--civic-green) / 0.25);
}

/* Content as a quotation: hanging coloured guillemets + soft left accent.
   (Rendered by TestimonyText — one per answer for a testimony sent online.) */
.t :deep(.t-quote) {
  margin: 0;
  padding-left: 1rem;
  border-left: 2px solid hsl(var(--primary) / 0.25);
  color: hsl(var(--foreground) / 0.92);
  font-size: var(--text-body);
  line-height: var(--lh-body);
  white-space: pre-wrap;
}

.t :deep(.t-quote)::before {
  content: "«\00a0";
  color: hsl(var(--primary));
  font-weight: 600;
}

.t :deep(.t-quote)::after {
  content: "\00a0»";
  color: hsl(var(--primary));
  font-weight: 600;
}

.t-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.t-topic {
  padding: 0.12rem 0.6rem;
  border-radius: 999px;
  background: hsl(var(--secondary) / 0.7);
  color: hsl(var(--secondary-foreground));
  font-size: var(--text-caption);
}
</style>
