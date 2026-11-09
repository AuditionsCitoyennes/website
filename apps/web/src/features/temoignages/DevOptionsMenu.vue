<script setup lang="ts">
// The Témoignages page's testing options, all in one dialog: a small « DEV »
// button over the map's bottom-right corner (GeoNav's `map-tools` slot: on a
// desktop left of the panel, its width followed through --panel-cover, above
// mapbox's attribution button; on a phone above the lowered sheet) opens
// « Options de test », a row for each switch of devOptions.ts — the data
// source and the place tree (dataSource.ts), the plateau's lid, its check, its
// mesh and the relief's prefetch (map), the framing and the analyses' slabs
// (analyses/devSwitch) —, each with its sentences for a tester and a mark on
// the ones that reload the page. In comparer mode a badge counting the
// differences (compare.ts: window.__acCompare, the tree's, and
// window.__acCompareLists, the lists'). The testing tools only: the explorer
// loads it behind `__TEST_TOOLS__`.
import { nextTick, ref, useId } from "vue";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import {
  frameFill,
  pendingAnalysesMode,
  ringBandMode,
  setFrameFill,
  setPendingAnalysesMode,
  setRingBandMode,
  setSlabLidMode,
  setSlabTextMode,
  setSlabTextScale,
  slabLidMode,
  slabTextMode,
  slabTextScale,
  type PendingAnalysesMode,
  type RingBandMode,
  type SlabLidMode,
  type SlabTextMode,
} from "@/features/analyses";
import {
  lidCheck,
  lidMode,
  meshMode,
  reliefPrefetch,
  setLidCheck,
  setLidMode,
  setMeshMode,
  setReliefPrefetch,
  type LidCheck,
  type LidMode,
  type MeshMode,
  type ReliefPrefetch,
} from "@/features/map";
import {
  dataSource,
  placeTreeMode,
  setDataSource,
  setPlaceTreeMode,
  type DataSource,
  type PlaceTreeMode,
} from "./dataSource";
import { compareState } from "./compare";
import {
  DEV_DESCRIPTION,
  DEV_OPTIONS,
  DEV_SECTIONS,
  type DevKey,
  type DevOption,
} from "./devOptions";

/** A share as the switch stores it ("80"), and back. */
const pct = (v: number) => String(Math.round(v * 100));

/** Each row's choice now, and its switch's setter (the modules' own). */
const BINDINGS: Record<DevKey, { now: () => string; set: (id: string) => void }> = {
  "ac:data-source": { now: () => dataSource, set: (id) => setDataSource(id as DataSource) },
  "ac:place-tree": {
    now: () => placeTreeMode.value,
    set: (id) => setPlaceTreeMode(id as PlaceTreeMode),
  },
  "ac:lid": { now: () => lidMode, set: (id) => setLidMode(id as LidMode) },
  "ac:lid-check": { now: () => lidCheck, set: (id) => setLidCheck(id as LidCheck) },
  "ac:mesh": { now: () => meshMode, set: (id) => setMeshMode(id as MeshMode) },
  "ac:relief-prefetch": {
    now: () => reliefPrefetch,
    set: (id) => setReliefPrefetch(id as ReliefPrefetch),
  },
  "ac:frame-fill": { now: () => pct(frameFill.value), set: (id) => setFrameFill(Number(id) / 100) },
  "ac:analyses-pending": {
    now: () => pendingAnalysesMode.value,
    set: (id) => setPendingAnalysesMode(id as PendingAnalysesMode),
  },
  "ac:slab-lid-verre": {
    now: () => slabLidMode.value,
    set: (id) => setSlabLidMode(id as SlabLidMode),
  },
  "ac:slab-text": {
    now: () => slabTextMode.value,
    set: (id) => setSlabTextMode(id as SlabTextMode),
  },
  "ac:slab-size": {
    now: () => pct(slabTextScale.value),
    set: (id) => setSlabTextScale(Number(id) / 100),
  },
  "ac:ring-band": {
    now: () => ringBandMode.value,
    set: (id) => setRingBandMode(id as RingBandMode),
  },
};

const now = (key: DevKey) => BINDINGS[key].now();
const set = (key: DevKey, id: string) => BINDINGS[key].set(id);
const inactive = (o: DevOption) =>
  !!o.inactiveWhen && now(o.inactiveWhen.key) === o.inactiveWhen.id;
const rowsOf = (section: string) => DEV_OPTIONS.filter((o) => o.section === section);

const uid = useId();
const explainId = (o: DevOption) => `${uid}-${o.key.slice(3)}`;

const open = ref(false);
const btn = ref<HTMLButtonElement | null>(null);

// Back on the button once closed. ModalDialog puts the focus back where it
// was at the opening, but WebKit does not focus a button on a click: there it
// was the page's body.
function close() {
  open.value = false;
  void nextTick(() => btn.value?.focus({ preventScroll: true }));
}

function diffCount() {
  return compareState.count === null ? "…" : compareState.count + (compareState.lists ?? 0);
}

function showReport() {
  const w = window as unknown as { __acCompare?: unknown; __acCompareLists?: unknown };
  console.info(w.__acCompare ?? null, w.__acCompareLists ?? null);
}
</script>

<template>
  <div class="dev-options">
    <button
      ref="btn"
      type="button"
      class="dev-options-btn"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-label="`Options de test (DEV · ${dataSource})`"
      @click="open = true"
    >
      DEV · {{ dataSource }}
      <span v-if="dataSource === 'comparer'" class="diff-count">Δ {{ diffCount() }}</span>
    </button>

    <ModalDialog
      :open="open"
      title="Options de test"
      :description="DEV_DESCRIPTION"
      dismissible
      medium
      @close="close"
    >
      <section v-for="s in DEV_SECTIONS" :key="s.id" class="dev-section">
        <h3>{{ s.title }}</h3>
        <p class="sec-intro">{{ s.intro }}</p>
        <div
          v-for="o in rowsOf(s.id)"
          :key="o.key"
          class="opt"
          role="group"
          :aria-label="o.label"
          :aria-describedby="explainId(o)"
        >
          <div class="opt-head">
            <span class="opt-name">{{ o.label }}</span>
            <span v-if="o.reloads" class="opt-reload">↻ recharge la page</span>
            <button
              v-if="o.key === 'ac:data-source' && dataSource === 'comparer'"
              type="button"
              class="diff-badge"
              :class="{ clean: compareState.count === 0 && !compareState.lists }"
              :title="`Différences (hors D1) — arbre : ${compareState.count ?? '…'}, listes : ${compareState.lists ?? '…'} — D1 : ${compareState.d1}`"
              @click.prevent="showReport"
            >
              Δ {{ diffCount() }}
            </button>
          </div>
          <div class="seg">
            <button
              v-for="c in o.choices"
              :key="c.id"
              type="button"
              class="seg-btn"
              :aria-pressed="now(o.key) === c.id"
              :disabled="inactive(o)"
              @click="set(o.key, c.id)"
            >
              {{ c.label }}
            </button>
          </div>
          <p :id="explainId(o)" class="opt-explain">{{ o.explain }}</p>
        </div>
      </section>
    </ModalDialog>
  </div>
</template>

<style scoped>
/* Over the map's bottom-right corner, inside the page (GeoNav's slot): left of
   the panel and of its covered width, above mapbox's attribution button. */
.dev-options {
  position: absolute;
  right: calc(var(--panel-cover, 0px) + 12px);
  bottom: 40px;
  z-index: 5;
  transition: right 0.55s cubic-bezier(0.22, 1, 0.36, 1);
}

@media (prefers-reduced-motion: reduce) {
  .dev-options {
    transition: none;
  }
}

@media (max-width: 899px) {
  /* Clear of the lowered sheet and of the map's controls above it (the zoom
     buttons and the logo at the left, the attribution button at the right). */
  .dev-options {
    right: 12px;
    bottom: calc(11.5rem + env(safe-area-inset-bottom));
  }
}

.dev-options-btn {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.45rem;
  border: none;
  border-radius: 0.45rem;
  background: hsl(var(--muted));
  box-shadow: var(--shadow-sm);
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.diff-count {
  color: hsl(var(--primary));
  font-weight: 700;
}

.diff-badge {
  padding: 0 0.4rem;
  border: none;
  border-radius: 999px;
  background: hsl(var(--destructive));
  color: white;
  font-size: var(--text-caption);
  font-weight: 700;
  cursor: pointer;
}

.diff-badge.clean {
  background: hsl(142 60% 36%);
}

.dev-section + .dev-section {
  margin-top: 1.25rem;
}

.sec-intro {
  margin: 0.15rem 0 0.5rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
}

.opt {
  padding: 0.6rem 0;
  border-top: 1px solid hsl(var(--border));
}

.opt-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.5rem;
}

.opt-name {
  font-size: var(--text-ui);
  font-weight: 600;
}

.opt-reload {
  padding: 0 0.4rem;
  border-radius: 999px;
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
  font-weight: 600;
  white-space: nowrap;
}

.seg {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.15rem;
  margin-top: 0.35rem;
  padding: 0.15rem;
  border-radius: 0.45rem;
  background: hsl(var(--muted));
}

.seg-btn {
  padding: 0.15rem 0.55rem;
  border: none;
  border-radius: 0.3rem;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
  font-weight: 600;
  cursor: pointer;
}

.seg-btn[aria-pressed="true"] {
  background: hsl(var(--card));
  color: hsl(var(--primary));
  box-shadow: var(--shadow-sm);
}

.seg-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.opt-explain {
  margin: 0.35rem 0 0;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
  line-height: 1.4;
}
</style>
