<script setup lang="ts">
// The map's loading curtain: the page's background, France, a spinner and
// « Chargement de la carte… ». Drawn by its two stages one after the other —
// MapStage's StageLoading while the map's code is still coming, then GeoNav's
// boot curtain — each wrapping this, which lays it out by the same rules from
// the same inputs (shared/boot/curtainFrame.ts): its own box, the 900 px line,
// the card or the page, the phone sheet's strip as a constant (safe area
// included). So the hand-over from one stage to the other moves nothing; the
// spinner keeps its turn too (its animation runs on the page's clock, not
// from when its element came).
//
// France is `poster` (CurtainPoster.vue, its own file). The spinner and the
// words show as soon as the box is measured: their place does not depend on
// France, which fades in where it goes if its file comes after them (only
// MapStage's StageLoading can be first; GeoNav's curtain has it with the
// map's code, so the hand-over neither blinks nor fades it). The words are
// said by the wrapper (GeoNav's curtain has role="status"); this only draws.
//
// `bare`: France alone, on no background (GeoDrillMap's « Carte
// indisponible », over its own background): the fallback's France stands
// where the curtain's stood.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from "vue";
import {
  CURTAIN_PEEK_PX,
  curtainLayout,
  type CurtainStage,
  type Rect,
} from "@/shared/boot/curtainFrame";
import { bootPosterMode } from "@/shared/boot/bootPosterSwitch";

const props = defineProps<{
  /** France (CurtainPoster.vue), null while its file is coming. */
  poster: Component | null;
  /** The home page's card. */
  preview?: boolean;
  /** Which stage draws it, and that stage's live measures (for "avant"). */
  from: CurtainStage;
  /** France alone: no background, no spinner, no words. */
  bare?: boolean;
}>();

/** France not there at the first render: it fades in when it comes, once
 *  (the stage moved from the card to the page re-inserts it, which would
 *  replay the fade). */
const posterLate = ref(!props.poster);

const root = ref<HTMLElement | null>(null);
const safe = ref<HTMLElement | null>(null);
const spin = ref<HTMLElement | null>(null);
const box = shallowRef<{ w: number; h: number; desktop: boolean; safe: number } | null>(null);

function measure() {
  const el = root.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const inset = safe.value ? parseFloat(getComputedStyle(safe.value).paddingBottom) || 0 : 0;
  const desktop = window.matchMedia("(min-width: 900px)").matches;
  const now = box.value;
  if (
    now &&
    now.w === r.width &&
    now.h === r.height &&
    now.desktop === desktop &&
    now.safe === inset
  )
    return;
  box.value = { w: r.width, h: r.height, desktop, safe: inset };
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  measure();
  // The card growing into the page, a turned phone, a resized window.
  if (typeof ResizeObserver !== "undefined" && root.value) {
    ro = new ResizeObserver(measure);
    ro.observe(root.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());

const SAME_FOR_BOTH: CurtainStage = { stage: "stage" };
const layout = computed(() => {
  const b = box.value;
  if (!b || !(b.w > 0) || !(b.h > 0)) return null;
  return curtainLayout({
    w: b.w,
    h: b.h,
    desktop: b.desktop,
    preview: !!props.preview,
    peekPx: CURTAIN_PEEK_PX + b.safe,
    mode: bootPosterMode,
    // Read only for "avant": the boot curtain's live measures, a new object
    // at each of its renders, must not redraw the others.
    from: bootPosterMode === "avant" ? props.from : SAME_FOR_BOTH,
  });
});

const rectStyle = (r: Rect) => ({
  left: `${r.left}px`,
  top: `${r.top}px`,
  width: `${r.width}px`,
  height: `${r.height}px`,
});

// The spinner turns on the document's clock: the next stage's spinner takes
// over at the same angle. Harmless where animations cannot be read.
watch(spin, (el) => {
  try {
    for (const a of el?.getAnimations?.() ?? []) a.startTime = 0;
  } catch {
    /* no Web Animations: the spinner starts from its own beginning */
  }
});
</script>

<template>
  <div ref="root" class="map-curtain" :class="{ bare }">
    <span ref="safe" class="curtain-safe" aria-hidden="true"></span>
    <template v-if="layout">
      <component
        :is="poster"
        v-if="poster"
        :class="{ 'curtain-poster-late': posterLate }"
        :poster="layout.poster"
        @animationend="posterLate = false"
      />
      <div v-if="!bare" class="curtain-say" :style="rectStyle(layout.say)">
        <span ref="spin" class="spinner spinner-lg" aria-hidden="true"></span>
        <p>Chargement de la carte…</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.map-curtain {
  position: absolute;
  inset: 0;
  background: hsl(var(--background));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}

.map-curtain.bare {
  background: none;
}

/* France come after the spinner and the words: it fades in (to the poster's
   own opacity). */
.curtain-poster-late {
  animation: curtain-poster-in 0.3s ease-out;
}

@keyframes curtain-poster-in {
  from {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .curtain-poster-late {
    animation: none;
  }
}

/* Zero-size probe whose padding resolves the home indicator's inset. */
.curtain-safe {
  position: absolute;
  width: 0;
  height: 0;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  visibility: hidden;
}

/* Centred in the part of the map France is framed in (curtainFrame). */
.curtain-say {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
}
</style>
