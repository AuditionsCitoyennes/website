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
// France is drawn as the map shows it when the curtain starts leaving: flat
// where the map then tilts in its entrance, tilted where it tilts in one step
// first (the device's motion, read as the camera will read it, the WebGL
// renderer included). Where nobody has asked for the renderer yet, the
// curtain asks after its first frame: the probe (a throwaway WebGL context)
// can take a long moment, a second or more where the processor draws, and
// the spinner and the words do not wait for it; France fades in after it.
//
// France is `poster` (CurtainPoster.vue, its own file). The spinner and the
// words show as soon as the box is measured: their place does not depend on
// France, which fades in where it goes if its file comes after them (only
// MapStage's StageLoading can be first; GeoNav's curtain has it with the
// map's code, so the hand-over neither blinks nor fades it). The words are
// said by the wrapper (GeoNav's curtain has role="status"); this only draws.
//
// `bare`: France alone, on no background (GeoDrillMap's fallback, over its
// own background). With `centred` (the page's
// fallback, which shows no panel), France as large as the curtain drew it,
// in the middle of the whole box.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from "vue";
import { CURTAIN_PEEK_PX, curtainLayout, type Rect } from "@/shared/boot/curtainFrame";
import { deviceTier, probeRenderer, rendererKnown } from "@/shared/device/deviceTier";
import { motionFor, prefersReducedMotion, type Motion } from "@/shared/device/motion";

const props = defineProps<{
  /** France (CurtainPoster.vue), null while its file is coming. */
  poster: Component | null;
  /** The home page's card. */
  preview?: boolean;
  /** France alone: no background, no spinner, no words. */
  bare?: boolean;
  /** France in the middle of the box (the map's fallback, with no panel
   *  beside it), as large as on the curtain. */
  centred?: boolean;
}>();

/** The map's entrance (features/map useMapCamera.beginIntro reads motionNow
 *  then): the renderer is the probe the map's code asks for before the map
 *  starts (graphicsSwitch, cacheBudget: one probe, kept), so both stages and
 *  the camera read the same tier. */
const entrance = (): Motion => motionFor(deviceTier(probeRenderer()), prefersReducedMotion());

/** The entrance, once known (null: the probe waits for the visit's first
 *  curtain frame; a curtain after it asks at once). */
const motion = shallowRef<Motion | null>(rendererKnown() || painted ? entrance() : null);

/** France not there at the first render: it fades in when it comes, once
 *  (the stage moved from the card to the page re-inserts it, which would
 *  replay the fade). */
const posterLate = ref(!props.poster || !motion.value);

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
let gone = false;
onMounted(() => {
  measure();
  // The map's code may have asked meanwhile (GeoDrillMap creates its map
  // as it mounts); else after this first frame is painted (a task queued
  // from its animation frame).
  if (!motion.value && rendererKnown()) motion.value = entrance();
  else if (!motion.value)
    requestAnimationFrame(() => {
      painted = true;
      setTimeout(() => {
        if (!gone) motion.value = entrance();
      }, 0);
    });
  // The card growing into the page, a turned phone, a resized window.
  if (typeof ResizeObserver !== "undefined" && root.value) {
    ro = new ResizeObserver(measure);
    ro.observe(root.value);
  }
});
onBeforeUnmount(() => {
  gone = true;
  ro?.disconnect();
});

// France and the words are laid out where the camera frames them; `centred`
// moves them whole (curtainLayout's centred drawing is that same drawing,
// moved), as a transform: so a curtain told `centred` while it shows (GeoNav's,
// the map's failure learned under it) glides there rather than jumping, and
// is only then faded onto the fallback, which draws its France at the same
// spot (GeoNav's `.boot-failed`).
const layout = computed(() => {
  const b = box.value;
  if (!b || !(b.w > 0) || !(b.h > 0)) return null;
  const o = {
    w: b.w,
    h: b.h,
    desktop: b.desktop,
    preview: !!props.preview,
    peekPx: CURTAIN_PEEK_PX + b.safe,
    motion: motion.value ?? "short",
  };
  const at = curtainLayout(o);
  if (!props.centred) return { ...at, dx: 0, dy: 0 };
  const mid = curtainLayout({ ...o, centred: true });
  return { ...at, dx: mid.say.left - at.say.left, dy: mid.say.top - at.say.top };
});

/** `centred` turned on while France or the words show: they glide there
 *  (the transition below), until its end. */
const gliding = ref(false);
watch(
  () => !!props.centred,
  (on, was) => {
    if (on && !was && layout.value) gliding.value = true;
  },
  { flush: "pre" },
);
const moveStyle = computed(() => {
  const l = layout.value;
  return l && (l.dx || l.dy) ? { transform: `translate(${l.dx}px, ${l.dy}px)` } : undefined;
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

<script lang="ts">
/** A curtain frame has been painted in this visit. */
let painted = false;
</script>

<template>
  <div ref="root" class="map-curtain" :class="{ bare }">
    <span ref="safe" class="curtain-safe" aria-hidden="true"></span>
    <div
      v-if="layout"
      class="curtain-move"
      :class="{ 'curtain-gliding': gliding }"
      :style="moveStyle"
      @transitionend.self="gliding = false"
    >
      <component
        :is="poster"
        v-if="poster && motion"
        :class="{ 'curtain-poster-late': posterLate }"
        :poster="layout.poster"
        @animationend="posterLate = false"
      />
      <div v-if="!bare" class="curtain-say" :style="rectStyle(layout.say)">
        <span ref="spin" class="spinner spinner-lg" aria-hidden="true"></span>
        <p>Chargement de la carte…</p>
      </div>
    </div>
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

/* France and the words, moved whole when `centred`. */
.curtain-move {
  position: absolute;
  inset: 0;
}

/* Told `centred` while showing: the glide (GeoNav's failed curtain fades out
   only once it is over: its .boot-failed waits as long). */
.curtain-gliding {
  transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}

@media (prefers-reduced-motion: reduce) {
  .curtain-gliding {
    transition: none;
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
