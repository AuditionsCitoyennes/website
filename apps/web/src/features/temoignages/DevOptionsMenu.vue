<script setup lang="ts">
// The Témoignages page's testing options, all in one dialog: a small « DEV »
// button over the map's bottom-right corner (GeoNav's `map-tools` slot: on a
// desktop left of the panel, its width followed through --panel-cover, above
// mapbox's attribution button; on a phone above the lowered sheet) opens
// « Options de test », a row for each switch of devOptions.ts — the data
// source and the place tree (dataSource.ts), the plateau's lid, its check, the
// pictures of it that are kept, its mesh, its ground, the relief's prefetch and the answer to a tap
// (map), the boot curtain's cover (geo-nav/bootListSwitch), what a pan does to the
// selected zone, the files a touch screen asks ahead and the sign of a long wait
// (geo-nav), the framing and the analyses' slabs
// (analyses/devSwitch), the device's tier (shared/device/deviceTier) with
// what the page knows of the device listed under it —, each with its
// sentences for a tester and a mark on the ones that reload the page. A choice
// that is not its switch's default is marked: a count on the button,
// « modifié » on its row, and at the top of the dialog the count again with
// « Tout remettre par défaut », which removes the stored keys (and the device
// tier's kept measure) and loads the page again. In comparer mode a badge
// counting the differences (compare.ts: window.__acCompare, the tree's, and
// window.__acCompareLists, the lists'). The testing tools only: the explorer
// loads it behind `__TEST_TOOLS__`.
import { computed, nextTick, ref, useId } from "vue";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import {
  decideTier,
  deviceSignals,
  deviceVerdict,
  forgetMeasuredStep,
  probeRenderer,
  setTierChoice,
  tierChoice,
} from "@/shared/device/deviceTier";
import { glass, setGlass } from "@/shared/device/glassSwitch";
import { mapPreload, setMapPreload } from "@/shared/boot/mapPreload";
import { authClient, setAuthClient } from "@/shared/api/authClientSwitch";
import { poster, setPoster } from "@/shared/ui/posterSwitch";
import { cardOpen, setCardOpen } from "@/shared/device/cardOpenSwitch";
import { hero, homeBoot, setHero, setHomeBoot } from "@/shared/boot/homeBoot";
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
} from "@/features/analyses";
import {
  bootWorkers,
  glyphs,
  coldStartMode,
  lateFilesMode,
  lidCacheMode,
  lidCheck,
  lidMode,
  meshMode,
  outlineWait,
  regionSelfMode,
  reliefGround,
  reliefPrefetch,
  setBootWorkers,
  setGlyphs,
  setColdStartMode,
  setLateFilesMode,
  setLidCacheMode,
  setLidCheck,
  mapFallback,
  setLidMode,
  setMapFallback,
  setMeshMode,
  setOutlineWait,
  setRegionSelfMode,
  setReliefGround,
  setReliefPrefetch,
  setTapAnswerMode,
  setTapFrameMode,
  tapAnswerMode,
  tapFrameMode,
} from "@/features/map";
import {
  bootList,
  filtersLoad,
  outlinesDecor,
  prefetch,
  prefetchMode,
  scopeDragMode,
  setBootList,
  setFiltersLoad,
  setOutlinesDecor,
  setPrefetch,
  setPrefetchMode,
  setScopeDragMode,
  setSlowSignMode,
  slowSignMode,
} from "@/features/geo-nav";
import { recover, setRecover } from "@/shared/net/recoverSwitch";
import { dataSource, placeTreeMode, setDataSource, setPlaceTreeMode } from "./dataSource";
import { compareState } from "./compare";
import {
  DEV_CHANGED_MARK,
  DEV_DESCRIPTION,
  DEV_NONE_CHANGED,
  DEV_OPTIONS,
  DEV_RESET_LABEL,
  DEV_SECTIONS,
  changedCount,
  changedOptions,
  clearOptions,
  tierFacts,
  type DevKey,
  type DevOption,
} from "./devOptions";

type Binding = { now: () => string; set: (id: string) => void };
/** A row's choice now and its switch's own setter (a choice's id is the switch's value). */
const bind = <T extends string>(now: () => T, set: (v: T) => void): Binding => ({
  now,
  set: (id) => set(id as T),
});
/** A share, as the switch stores it ("80"). */
const share = (now: () => number, set: (v: number) => void): Binding => ({
  now: () => String(Math.round(now() * 100)),
  set: (id) => set(Number(id) / 100),
});

const BINDINGS: Record<DevKey, Binding> = {
  "ac:data-source": bind(() => dataSource, setDataSource),
  "ac:place-tree": bind(() => placeTreeMode.value, setPlaceTreeMode),
  "ac:lid": bind(() => lidMode, setLidMode),
  "ac:lid-check": bind(() => lidCheck, setLidCheck),
  "ac:mesh": bind(() => meshMode, setMeshMode),
  "ac:relief-prefetch": bind(() => reliefPrefetch, setReliefPrefetch),
  "ac:frame-fill": share(() => frameFill.value, setFrameFill),
  "ac:tap-answer": bind(() => tapAnswerMode.value, setTapAnswerMode),
  "ac:tap-frame": bind(() => tapFrameMode.value, setTapFrameMode),
  "ac:late-files": bind(() => lateFilesMode, setLateFilesMode),
  "ac:outline-wait": bind(() => outlineWait.value, setOutlineWait),
  "ac:region-self": bind(() => regionSelfMode.value, setRegionSelfMode),
  "ac:cold-start": bind(() => coldStartMode.value, setColdStartMode),
  "ac:scope-drag": bind(() => scopeDragMode.value, setScopeDragMode),
  "ac:outlines-ahead": bind(() => prefetchMode.value, setPrefetchMode),
  "ac:lid-cache": bind(() => lidCacheMode.value, setLidCacheMode),
  "ac:slow-sign": bind(() => slowSignMode.value, setSlowSignMode),
  "ac:analyses-pending": bind(() => pendingAnalysesMode.value, setPendingAnalysesMode),
  "ac:slab-lid-verre": bind(() => slabLidMode.value, setSlabLidMode),
  "ac:slab-text": bind(() => slabTextMode.value, setSlabTextMode),
  "ac:slab-size": share(() => slabTextScale.value, setSlabTextScale),
  "ac:ring-band": bind(() => ringBandMode.value, setRingBandMode),
  "ac:tier": bind(() => tierChoice, setTierChoice),
  "ac:boot-list": bind(() => bootList, setBootList),
  "ac:boot-workers": bind(() => bootWorkers, setBootWorkers),
  "ac:outlines-decor": bind(() => outlinesDecor, setOutlinesDecor),
  "ac:glyphs": bind(() => glyphs, setGlyphs),
  "ac:map-preload": bind(() => mapPreload, setMapPreload),
  "ac:glass": bind(() => glass, setGlass),
  "ac:auth-client": bind(() => authClient, setAuthClient),
  "ac:map-fallback": bind(() => mapFallback, setMapFallback),
  "ac:poster": bind(() => poster, setPoster),
  "ac:card-open": bind(() => cardOpen, setCardOpen),
  "ac:home-boot": bind(() => homeBoot, setHomeBoot),
  "ac:hero": bind(() => hero, setHero),
  "ac:recover": bind(() => recover, setRecover),
  "ac:filters-load": bind(() => filtersLoad, setFiltersLoad),
  "ac:prefetch": bind(() => prefetch, setPrefetch),
  "ac:relief-ground": bind(() => reliefGround.value, setReliefGround),
};

const now = (key: DevKey) => BINDINGS[key].now();
const set = (key: DevKey, id: string) => BINDINGS[key].set(id);
const inactive = (o: DevOption) =>
  !!o.inactiveWhen && now(o.inactiveWhen.key) === o.inactiveWhen.id;
const rowsOf = (section: string) => DEV_OPTIONS.filter((o) => o.section === section);

/** The rows off their default: what this browser shows differently. */
const changed = computed(() => changedOptions(now));
const buttonLabel = computed(
  () =>
    `Options de test (DEV · ${dataSource})` +
    (changed.value.length ? `, ${changedCount(changed.value.length)}` : ""),
);

/** Every stored choice removed, and the page loaded again with the defaults. */
function resetAll() {
  try {
    clearOptions((key) => localStorage.removeItem(key));
  } catch {
    /* storage blocked: nothing was kept, the reload alone brings the defaults back */
  }
  forgetMeasuredStep(); // the device is judged again
  window.location.reload();
}

const uid = useId();
const explainId = (o: DevOption) => `${uid}-${o.key.slice(3)}`;

const open = ref(false);
const btn = ref<HTMLButtonElement | null>(null);

/** What the page knows of the device, read each time the dialog opens (the
 *  graphics chip's name from a throwaway context, once per page). */
const deviceFacts = computed(() => {
  if (!open.value) return [];
  const signals = deviceSignals(probeRenderer());
  return tierFacts(signals, decideTier(signals), deviceVerdict());
});
/** A measured step down is kept: the reset is offered for it alone too. */
const measureKept = computed(() => open.value && deviceSignals().measured !== null);

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
      :aria-label="buttonLabel"
      :title="buttonLabel"
      @click="open = true"
    >
      DEV · {{ dataSource }}
      <span v-if="dataSource === 'comparer'" class="diff-count">Δ {{ diffCount() }}</span>
      <span v-if="changed.length" class="changed-count">{{ changed.length }}</span>
    </button>

    <ModalDialog
      :open="open"
      title="Options de test"
      :description="DEV_DESCRIPTION"
      dismissible
      medium
      @close="close"
    >
      <!-- Always there, at one height: a choice made further down moves nothing. -->
      <div class="dev-changed" :class="{ on: changed.length }">
        <span role="status">
          {{ changed.length ? changedCount(changed.length) : DEV_NONE_CHANGED }}
        </span>
        <button
          v-if="changed.length || measureKept"
          type="button"
          class="ac-btn ac-btn--outline ac-btn--sm"
          @click="resetAll"
        >
          {{ DEV_RESET_LABEL }}
        </button>
      </div>
      <section v-for="s in DEV_SECTIONS" :key="s.id" class="dev-section">
        <h3>{{ s.title }}</h3>
        <p class="sec-intro">{{ s.intro }}</p>
        <div
          v-for="o in rowsOf(s.id)"
          :key="o.key"
          class="opt"
          role="group"
          :aria-label="changed.includes(o) ? `${o.label} (${DEV_CHANGED_MARK})` : o.label"
          :aria-describedby="explainId(o)"
        >
          <div class="opt-head">
            <span class="opt-name">{{ o.label }}</span>
            <span v-if="changed.includes(o)" class="opt-changed">{{ DEV_CHANGED_MARK }}</span>
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
          <!-- What the page knows of the device, under the « Niveau » row. -->
          <dl v-if="o.key === 'ac:tier'" class="dev-facts">
            <div v-for="f in deviceFacts" :key="f.label">
              <dt>{{ f.label }}</dt>
              <dd>{{ f.value }}</dd>
            </div>
          </dl>
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

/* A choice off its default: the button's count, the row's « modifié », the top line. */
.changed-count,
.opt-changed {
  padding: 0 0.4rem;
  border-radius: 999px;
  background: hsl(38 92% 50%);
  color: hsl(240 10% 10%);
  font-size: var(--text-caption);
  font-weight: 700;
}

/* One line down to a phone's width: the button never drops under the count. */
.dev-changed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 2.8rem;
  margin-bottom: 1rem;
  padding: 0.35rem 0.5rem;
  border-radius: 0.45rem;
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
  line-height: 1.2;
}

.dev-changed .ac-btn {
  flex: none;
  padding: 0 0.5rem;
}

.dev-changed.on {
  background: hsl(38 92% 50% / 0.18);
  color: hsl(var(--foreground));
  font-weight: 600;
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

/* What the page knows of the device: a name and its value per line. */
.dev-facts {
  margin: 0;
  padding: 0.5rem 0 0;
  border-top: 1px solid hsl(var(--border));
  font-size: var(--text-ui);
  line-height: 1.4;
}

.dev-facts > div {
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
  padding: 0.1rem 0;
}

.dev-facts dt {
  flex: none;
  color: hsl(var(--muted-foreground));
}

.dev-facts dd {
  margin: 0;
  font-weight: 600;
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
