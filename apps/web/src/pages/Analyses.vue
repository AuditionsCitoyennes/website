<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import type { AuditionWithCount, LocationGroup, PublicTestimony } from "@ac/shared";
import { api } from "@/lib/api";
import { formatDateShort, formatMonthYear } from "@/lib/format";
import TestimoniesMap from "@/components/TestimoniesMap.vue";
import MonthBarChart from "@/components/charts/MonthBarChart.vue";
import TopicDonutChart from "@/components/charts/TopicDonutChart.vue";

const router = useRouter();

const auditionsQuery = useQuery({
  queryKey: ["auditions"],
  queryFn: () => api.get<AuditionWithCount[]>("/api/auditions"),
});

const testimoniesQuery = useQuery({
  queryKey: ["testimonies"],
  queryFn: () => api.get<PublicTestimony[]>("/api/testimonies"),
});

const mapQuery = useQuery({
  queryKey: ["map"],
  queryFn: () => api.get<LocationGroup[]>("/api/map"),
});

const auditions = computed(() => auditionsQuery.data.value ?? []);
const testimonies = computed(() => testimoniesQuery.data.value ?? []);
const groups = computed(() => mapQuery.data.value ?? []);
const loading = computed(
  () => auditionsQuery.isLoading.value || testimoniesQuery.isLoading.value,
);
const isError = computed(
  () => auditionsQuery.isError.value || testimoniesQuery.isError.value,
);

// ---- Aggregations (ported from the old Analysis page) ----

const totalAuditions = computed(() => auditions.value.length);
const totalTestimonies = computed(() => testimonies.value.length);

const topicsCount = computed(() => {
  const map: Record<string, number> = {};
  for (const t of testimonies.value) {
    for (const topic of t.topics ?? []) map[topic] = (map[topic] || 0) + 1;
  }
  return map;
});

const sortedTopics = computed(() =>
  Object.entries(topicsCount.value).sort(([, a], [, b]) => b - a),
);

const topTopics = computed(() =>
  sortedTopics.value.slice(0, 10).map(([name, value]) => ({ name, value })),
);

const average = computed(() =>
  totalAuditions.value > 0
    ? Math.round(totalTestimonies.value / totalAuditions.value)
    : 0,
);

// Auditions per month, chronological.
const byMonth = computed(() => {
  const map = new Map<string, number>(); // key: YYYY-MM
  for (const a of auditions.value) {
    const key = a.date.slice(0, 7);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ label: formatMonthYear(`${key}-01`), count }));
});

const byLocation = computed(() => {
  const map: Record<string, number> = {};
  for (const a of auditions.value) map[a.location] = (map[a.location] || 0) + 1;
  return Object.entries(map)
    .sort(([, a], [, b]) => b - a)
    .map(([name, value]) => ({ name, value }));
});

function onMapSelect(payload: { id: string }) {
  router.push(`/audition/${payload.id}`);
}
</script>

<template>
  <div class="analyses container-page">
    <header class="page-head">
      <h1>Analyse des Auditions</h1>
      <p class="lead">
        Visualisez les données et tendances issues des auditions citoyennes
      </p>
    </header>

    <div v-if="loading" class="state">Chargement…</div>

    <div v-else-if="isError" class="state">
      Impossible de charger les données d'analyse.
    </div>

    <template v-else>
      <!-- Stat cards -->
      <div class="stats">
        <div class="stat-card">
          <p class="stat-label">Total Auditions</p>
          <p class="stat-value">{{ totalAuditions }}</p>
          <p class="stat-sub">Sessions d'écoute</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Témoignages</p>
          <p class="stat-value">{{ totalTestimonies }}</p>
          <p class="stat-sub">Voix citoyennes</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Thèmes</p>
          <p class="stat-value">{{ sortedTopics.length }}</p>
          <p class="stat-sub">Sujets différents</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Moyenne</p>
          <p class="stat-value">{{ average }}</p>
          <p class="stat-sub">Témoignages/audition</p>
        </div>
      </div>

      <!-- Charts -->
      <div class="charts">
        <section class="panel">
          <h2 class="panel-title">Auditions par mois</h2>
          <p class="panel-desc">Évolution temporelle des sessions</p>
          <MonthBarChart :data="byMonth" />
        </section>

        <section class="panel">
          <h2 class="panel-title">Top 10 des thèmes</h2>
          <p class="panel-desc">Les sujets les plus mentionnés</p>
          <TopicDonutChart :data="topTopics" />
        </section>
      </div>

      <!-- Map -->
      <section class="panel">
        <h2 class="panel-title">Carte des auditions</h2>
        <p class="panel-desc">
          Cliquez sur un point pour ouvrir les auditions de ce lieu
        </p>
        <div class="map-zone">
          <TestimoniesMap :groups="groups" :active-locations="null" @select="onMapSelect" />
        </div>
      </section>

      <!-- Locations -->
      <section class="panel">
        <h2 class="panel-title">Répartition par lieu</h2>
        <p class="panel-desc">Nombre d'auditions par localité</p>
        <div class="locations">
          <div v-for="loc in byLocation" :key="loc.name" class="loc-card">
            <span class="loc-name">{{ loc.name }}</span>
            <span class="loc-value">{{ loc.value }}</span>
            <span class="loc-sub">audition{{ loc.value > 1 ? "s" : "" }}</span>
          </div>
        </div>
      </section>

      <!-- Audition list -->
      <section class="panel">
        <h2 class="panel-title">Détail des auditions</h2>
        <p class="panel-desc">Liste complète avec nombre de témoignages</p>
        <div class="aud-list">
          <RouterLink
            v-for="a in auditions"
            :key="a.id"
            :to="`/audition/${a.id}`"
            class="aud-row"
          >
            <div class="aud-info">
              <h3 class="aud-title">{{ a.title }}</h3>
              <p class="aud-meta">
                {{ formatDateShort(a.date) }}
                <span class="dot">·</span>
                {{ a.location }}
              </p>
            </div>
            <span class="chip chip--primary">
              {{ a.testimony_count }} témoignage{{ a.testimony_count > 1 ? "s" : "" }}
            </span>
          </RouterLink>
        </div>
      </section>

      <!-- All topics -->
      <section class="panel">
        <h2 class="panel-title">Tous les thèmes mentionnés</h2>
        <p class="panel-desc">
          Liste exhaustive des préoccupations citoyennes ({{ sortedTopics.length }} thèmes)
        </p>
        <div class="topics">
          <span v-for="[topic, count] in sortedTopics" :key="topic" class="topic-pill">
            {{ topic }} <span class="topic-count">({{ count }})</span>
          </span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analyses {
  padding-block: 2.5rem 4rem;
}

.page-head {
  text-align: center;
  margin-bottom: 2.5rem;
}

.page-head h1 {
  font-size: clamp(2.2rem, 6vw, 3.6rem);
  text-transform: uppercase;
  color: hsl(var(--foreground));
}

.lead {
  color: hsl(var(--muted-foreground));
  max-width: 600px;
  margin: 0.6rem auto 0;
}

.state {
  padding: 4rem 1rem;
  text-align: center;
  color: hsl(var(--muted-foreground));
}

.stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  margin-bottom: 1.6rem;
}

@media (min-width: 880px) {
  .stats {
    grid-template-columns: repeat(4, 1fr);
  }
}

.stat-card {
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 0.85rem;
  box-shadow: var(--shadow-sm);
  padding: 1.2rem 1.4rem;
}

.stat-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
}

.stat-value {
  font-family: var(--font-display);
  font-size: 2.8rem;
  letter-spacing: 0.04em;
  color: hsl(var(--foreground));
  margin-top: 0.3rem;
}

.stat-sub {
  font-size: 0.78rem;
  color: hsl(var(--muted-foreground));
}

.charts {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.6rem;
}

@media (min-width: 980px) {
  .charts {
    grid-template-columns: 1fr 1fr;
  }
}

.panel {
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 0.85rem;
  box-shadow: var(--shadow-sm);
  padding: 1.5rem;
  margin-bottom: 1.6rem;
}

.panel-title {
  font-size: 1.5rem;
  color: hsl(var(--foreground));
}

.panel-desc {
  font-size: 0.85rem;
  color: hsl(var(--muted-foreground));
  margin: 0.25rem 0 1.2rem;
}

.map-zone {
  height: 460px;
}

.locations {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.9rem;
}

.loc-card {
  display: flex;
  flex-direction: column;
  padding: 1rem;
  border-radius: 0.7rem;
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border) / 0.5);
}

.loc-name {
  font-weight: 500;
  font-size: 0.88rem;
  color: hsl(var(--foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loc-value {
  font-family: var(--font-display);
  font-size: 2.2rem;
  color: hsl(var(--primary));
  margin-top: 0.3rem;
}

.loc-sub {
  font-size: 0.72rem;
  color: hsl(var(--muted-foreground));
}

.aud-list {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.aud-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.9rem;
  padding: 1rem 1.1rem;
  border-radius: 0.7rem;
  background: hsl(var(--muted) / 0.35);
  border: 1px solid hsl(var(--border) / 0.4);
  transition: var(--transition-smooth);
}

.aud-row:hover {
  background: hsl(var(--muted) / 0.6);
  border-color: hsl(var(--primary) / 0.35);
}

.aud-info {
  min-width: 0;
}

.aud-title {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: 0.98rem;
  letter-spacing: 0;
  color: hsl(var(--foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aud-row:hover .aud-title {
  color: hsl(var(--primary));
}

.aud-meta {
  font-size: 0.82rem;
  color: hsl(var(--muted-foreground));
  margin-top: 0.2rem;
}

.dot {
  opacity: 0.5;
}

.chip--primary {
  background: hsl(var(--primary) / 0.1);
  color: hsl(var(--primary));
  border-color: hsl(var(--primary) / 0.2);
  flex-shrink: 0;
}

.topics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.topic-pill {
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border) / 0.5);
  font-size: 0.85rem;
  font-weight: 500;
  color: hsl(var(--foreground));
}

.topic-count {
  color: hsl(var(--muted-foreground));
  font-size: 0.75rem;
}

@media (max-width: 560px) {
  .aud-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
