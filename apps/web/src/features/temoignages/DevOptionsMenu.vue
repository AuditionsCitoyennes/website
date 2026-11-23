<script setup lang="ts">
// The Témoignages page's testing options, all in one dialog: a small « DEV »
// button over the map's bottom-right corner (GeoNav's `map-tools` slot: on a
// desktop left of the panel, its width followed through --panel-cover, above
// mapbox's attribution button; on a phone above the lowered sheet) opens
// « Options de test », a row for each switch of devOptions.ts — the map's
// fallback (map/fallbackSwitch), the height of a phone's raised sheet and
// how a late list re-frames it (geo-nav/panel/sheetFitSwitch), when the panel
// shows while the page loads (geo-nav/panelBootSwitch), the analyses' slabs
// (analyses/devSwitch; their section only in a build with the analyses), the
// device's tier (shared/device/deviceTier) with what the page knows of the
// device listed under it, the map's pixel ratio and whether it times its
// first flight (map/graphicsSwitch) —, each with its sentences for a tester
// and a mark on the ones that reload the page. A choice that is not its
// switch's default is marked: a count on the button, « modifié » on its row,
// and at the top of the dialog the count again with « Tout remettre par
// défaut », which removes the stored keys (and the device tier's kept
// measure) and loads the page again. The testing tools only: the explorer
// loads it behind `__TEST_TOOLS__`.
import { computed, nextTick, ref, useId } from "vue";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import {
  decideTier,
  deviceSignals,
  deviceVerdict,
  forgetMeasuredStep,
  measureRecord,
  probeRenderer,
  setTierChoice,
  tierChoice,
} from "@/shared/device/deviceTier";
import {
  pendingAnalysesMode,
  ringBandMode,
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
  panelBootMode,
  setPanelBootMode,
  setSheetFitMode,
  setSheetLateMode,
  sheetFitMode,
  sheetLateMode,
  setSheetMapMode,
  sheetMapMode,
} from "@/features/geo-nav";
import {
  dprChoice,
  frameMeasure,
  mapFallback,
  setDprChoice,
  setFrameMeasure,
  setMapFallback,
} from "@/features/map";
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
import { bootPosterMode, setBootPosterMode } from "@/shared/boot/bootPosterSwitch";

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
  "ac:analyses-pending": bind(() => pendingAnalysesMode.value, setPendingAnalysesMode),
  "ac:slab-lid-verre": bind(() => slabLidMode.value, setSlabLidMode),
  "ac:slab-text": bind(() => slabTextMode.value, setSlabTextMode),
  "ac:slab-size": share(() => slabTextScale.value, setSlabTextScale),
  "ac:ring-band": bind(() => ringBandMode.value, setRingBandMode),
  "ac:tier": bind(() => tierChoice, setTierChoice),
  "ac:map-fallback": bind(() => mapFallback, setMapFallback),
  "ac:boot-poster": bind(() => bootPosterMode, setBootPosterMode),
  "ac:sheet-fit": bind(() => sheetFitMode.value, setSheetFitMode),
  "ac:sheet-late": bind(() => sheetLateMode.value, setSheetLateMode),
  "ac:panel-boot": bind(() => panelBootMode, setPanelBootMode),
  "ac:dpr": bind(() => dprChoice, setDprChoice),
  "ac:frame-measure": bind(() => frameMeasure, setFrameMeasure),
  "ac:sheet-map": bind(() => sheetMapMode.value, setSheetMapMode),
};

const now = (key: DevKey) => BINDINGS[key].now();
const set = (key: DevKey, id: string) => BINDINGS[key].set(id);
const rowsOf = (section: string) => DEV_OPTIONS.filter((o) => o.section === section);
/** The sections drawn: « Analyses » only in a build with the analyses (its
 *  rows set nothing in one without). */
const sections = DEV_SECTIONS.filter((s) => s.id !== "analyses" || __ANALYSES__);

/** The rows off their default: what this browser shows differently. */
const changed = computed(() => changedOptions(now));
const buttonLabel = computed(
  () =>
    "Options de test (DEV)" +
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
  return tierFacts(signals, decideTier(signals), deviceVerdict(), measureRecord());
});
/** A measured step down stands or is kept, or a slow flight is noted: the
 *  reset is offered for it alone too. */
const measureKept = computed(
  () => open.value && (deviceSignals().measured !== null || measureRecord().note !== null),
);

// Back on the button once closed. ModalDialog puts the focus back where it
// was at the opening, but WebKit does not focus a button on a click: there it
// was the page's body.
function close() {
  open.value = false;
  void nextTick(() => btn.value?.focus({ preventScroll: true }));
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
      DEV
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
      <section v-for="s in sections" :key="s.id" class="dev-section">
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
          </div>
          <div class="seg">
            <button
              v-for="c in o.choices"
              :key="c.id"
              type="button"
              class="seg-btn"
              :aria-pressed="now(o.key) === c.id"
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
     buttons and the logo at the left, the attribution button at the right);
     over a raised sheet that leaves the map room above it, clear of that
     sheet's top and of the controls gone up with it (GeoNav's
     `--sheet-tools`, unset otherwise), moving as the sheet does: in one step
     when the sheet's refit is made in one (`--sheet-follow`, set by GeoNav),
     eased otherwise. */
  .dev-options {
    right: 12px;
    bottom: max(
      calc(11.5rem + env(safe-area-inset-bottom)),
      calc(var(--sheet-tools, -100vh) + 7rem)
    );
    transition:
      right 0.55s cubic-bezier(0.22, 1, 0.36, 1),
      bottom var(--sheet-follow, 0.35s) cubic-bezier(0.22, 1, 0.36, 1);
  }
}

@media (max-width: 899px) and (prefers-reduced-motion: reduce) {
  .dev-options {
    transition: none;
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
