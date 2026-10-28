<script setup lang="ts">
// The Témoignages page's data switches (dataSource.ts, analyses/devSwitch.ts),
// map phase 1: "Données" (corpus, serveur, comparer — the page loads again),
// "Analyses en attente" and "Arbre des lieux"; in comparer mode a badge
// counting the differences (compare.ts: window.__acCompare). The testing tools
// only: the explorer loads it behind `__TEST_TOOLS__`. Folded by default, at
// the map's bottom-left corner above mapbox's logo (a phone: above the sheet).
import { pendingAnalysesMode, setPendingAnalysesMode } from "@/features/analyses";
import {
  dataSource,
  placeTreeMode,
  setDataSource,
  setPlaceTreeMode,
  type DataSource,
  type PlaceTreeMode,
} from "./dataSource";
import { compareState } from "./compare";

const SOURCES: readonly { id: DataSource; label: string }[] = [
  { id: "corpus", label: "Corpus" },
  { id: "serveur", label: "Serveur" },
  { id: "comparer", label: "Comparer" },
];
const PENDING: readonly { id: "garder" | "masquer"; label: string }[] = [
  { id: "garder", label: "Garder" },
  { id: "masquer", label: "Masquer" },
];
const TREES: readonly { id: PlaceTreeMode; label: string }[] = [
  { id: "sans", label: "Sans arr." },
  { id: "avec", label: "Avec arr." },
];

function showReport() {
  console.info((window as unknown as { __acCompare?: unknown }).__acCompare ?? null);
}
</script>

<template>
  <details class="dev-data-switch" aria-label="Source des données (DEV)">
    <summary class="switch-fold">
      DEV · {{ dataSource }}
      <button
        v-if="dataSource === 'comparer'"
        type="button"
        class="diff-badge"
        :class="{ clean: compareState.count === 0 }"
        :title="`Différences (hors D1) — D1 : ${compareState.d1}`"
        @click.prevent="showReport"
      >
        Δ {{ compareState.count ?? "…" }}
      </button>
    </summary>
    <div class="switch-rows">
      <div class="seg" role="group" aria-label="Données">
        <span class="seg-label">Données</span>
        <button
          v-for="m in SOURCES"
          :key="m.id"
          type="button"
          class="seg-btn"
          :aria-pressed="dataSource === m.id"
          @click="setDataSource(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="seg" role="group" aria-label="Analyses en attente">
        <span class="seg-label">Analyses en attente</span>
        <button
          v-for="m in PENDING"
          :key="m.id"
          type="button"
          class="seg-btn"
          :aria-pressed="pendingAnalysesMode === m.id"
          @click="setPendingAnalysesMode(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="seg" role="group" aria-label="Arbre des lieux">
        <span class="seg-label">Arbre des lieux</span>
        <button
          v-for="m in TREES"
          :key="m.id"
          type="button"
          class="seg-btn"
          :aria-pressed="placeTreeMode === m.id"
          @click="setPlaceTreeMode(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.dev-data-switch {
  position: fixed;
  left: 12px;
  bottom: 40px;
  z-index: 5;
  padding: 0.15rem;
  border-radius: 0.45rem;
  background: hsl(var(--muted));
  box-shadow: var(--shadow-sm);
  font-size: var(--text-caption);
  white-space: nowrap;
}

@media (max-width: 899px) {
  /* Clear of the lowered sheet. */
  .dev-data-switch {
    bottom: calc(6rem + env(safe-area-inset-bottom));
  }
}

.switch-fold {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.05rem 0.3rem;
  color: hsl(var(--muted-foreground));
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}

.switch-fold::-webkit-details-marker {
  display: none;
}

.dev-data-switch[open] .switch-fold {
  margin-bottom: 0.15rem;
}

.diff-badge {
  padding: 0 0.4rem;
  border: none;
  border-radius: 999px;
  background: hsl(var(--destructive));
  color: white;
  font-size: inherit;
  font-weight: 700;
  cursor: pointer;
}

.diff-badge.clean {
  background: hsl(142 60% 36%);
}

.switch-rows {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.seg {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}

.seg-label {
  min-width: 8.5rem;
  padding: 0 0.3rem;
  color: hsl(var(--muted-foreground));
}

.seg-btn {
  padding: 0.05rem 0.45rem;
  border: none;
  border-radius: 0.3rem;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
}

.seg-btn[aria-pressed="true"] {
  background: hsl(var(--card));
  color: hsl(var(--primary));
  box-shadow: var(--shadow-sm);
}
</style>
