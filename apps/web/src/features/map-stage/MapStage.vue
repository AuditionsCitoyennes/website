<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ROUTE } from "@/shared/routes";
import { MAP_MOVED_EVENT } from "@/features/map/events";
import { loadTemoignagesExplorer } from "@/features/temoignages";
import { useMapStage } from "./useMapStage";
import { useCardOpenGestures } from "./useCardOpenGestures";
import { grown, nextFrame, pageRect } from "./openTransition";
import StageLoading from "./StageLoading.vue";
import StageFailed from "./StageFailed.vue";

// The one testimonies map (see useMapStage): mounted in whichever place a page
// lends it — the home page's card, or /temoignages — and moved, not rebuilt,
// from one to the other. Opening the card grows it into the page: the map is
// lifted out of the card (fixed, where the card was), grows to the page's
// area while the home page fades away, and the route changes under it.

// Its code comes once a place is lent; until then the stage shows the map's
// own curtain (StageLoading) — in the card, growing, on the page alike.
const Temoignages = defineAsyncComponent({
  loader: loadTemoignagesExplorer,
  loadingComponent: StageLoading,
  errorComponent: StageFailed,
  delay: 0,
});

const stage = useMapStage();
const router = useRouter();

const mode = computed(() =>
  stage.opening.value ? "opening" : stage.page.value ? "page" : stage.card.value ? "card" : null,
);
const target = computed(() =>
  stage.opening.value ? "body" : (stage.page.value ?? stage.card.value ?? null),
);

const stageEl = ref<HTMLElement | null>(null);

// Moved to another place in the page (the card, the page, or lifted out over
// both): the map draws again at once — a moved canvas can show blank until
// its next frame.
watch(
  target,
  (to, from) => {
    if (to && from && to !== from) window.dispatchEvent(new Event(MAP_MOVED_EVENT));
  },
  { flush: "post" },
);
/** Growing (rather than just lifted out of the card): rounds its corners off. */
const growing = ref(false);

const openingStyle = computed(() => {
  const r = stage.opening.value;
  return r
    ? { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` }
    : undefined;
});

/** The page's address, for the card's link (a new tab, a middle click). */
const pageHref = computed(() => router.resolve({ name: ROUTE.temoignages.name }).href);

// A click, a drag, a pinch on the card: it opens (see useCardOpenGestures).
const {
  onCardClick,
  onCardPointerDown,
  onCardPointerMove,
  onCardPointerEnd,
  onCardContextMenu,
  onCardWheel,
  reset: resetGestures,
  isModifierHeld,
} = useCardOpenGestures(open);

/** The rest of a pinch that opened the card: no browser zoom under it. */
function swallowPinch(e: WheelEvent) {
  if ((e.ctrlKey || e.metaKey) && !isModifierHeld()) e.preventDefault();
}

async function open() {
  const card = stage.card.value;
  if (!card || stage.opening.value) return;
  // Whatever was pressed on the card is over: the card's link goes now.
  resetGestures();
  window.addEventListener("wheel", swallowPinch, { capture: true, passive: false });
  const html = document.documentElement;
  // The home page fades away and stops scrolling — its scrollbar goes too,
  // and the page reflows wider: the card is measured once that is done.
  html.classList.add("map-opening");
  const from = card.getBoundingClientRect();
  // Any navigation begun meanwhile (a link of the header, its page still
  // downloading) wins over this one.
  let elsewhere = false;
  const stopWatching = router.beforeEach(() => {
    elsewhere = true;
  });
  stage.opening.value = { top: from.top, left: from.left, width: from.width, height: from.height };
  try {
    await nextTick();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Where it starts, computed before it grows — or the growth has no start
      // to transition from and the stage just jumps to its end.
      void stageEl.value?.getBoundingClientRect();
      await nextFrame(); // lifted out where the card was, before it grows
      growing.value = true;
      stage.opening.value = pageRect();
      await nextTick();
      if (stageEl.value) await grown(stageEl.value);
    }
    stopWatching();
    if (!elsewhere) {
      await router.push({ name: ROUTE.temoignages.name });
      await nextTick();
    }
  } finally {
    stopWatching();
    window.removeEventListener("wheel", swallowPinch, true);
    stage.opening.value = null;
    growing.value = false;
    html.classList.remove("map-opening");
  }
  // On the page: the focus goes to its title (the card's link, which had it,
  // is gone).
  if (!elsewhere) {
    await nextTick();
    const title = stageEl.value?.querySelector<HTMLElement>(".panel-head h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }
}
</script>

<template>
  <Teleport v-if="target && mode" :to="target">
    <div
      ref="stageEl"
      class="map-stage"
      :class="[`map-stage--${mode}`, { 'map-stage--growing': growing }]"
      :style="openingStyle"
    >
      <Temoignages :preview="mode !== 'page'" />
      <!-- The card is one link to the page: the map under it takes neither
           pointer nor focus (GeoNav's `preview`). -->
      <a
        v-if="mode === 'card'"
        :href="pageHref"
        class="map-stage-open"
        aria-label="Explorer la carte des témoignages"
        draggable="false"
        @click="onCardClick"
        @pointerdown="onCardPointerDown"
        @pointermove="onCardPointerMove"
        @pointerup="onCardPointerEnd"
        @pointercancel="onCardPointerEnd"
        @pointerleave="onCardPointerEnd"
        @contextmenu="onCardContextMenu"
        @wheel="onCardWheel"
        @dragstart.prevent
      >
        <span class="map-stage-cta">
          Explorer la carte
          <span aria-hidden="true">→</span>
        </span>
      </a>
    </div>
  </Teleport>
</template>

<style scoped>
.map-stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* The page: all of it. */
.map-stage--page {
  flex: 1;
}

/* The card: fills it, with its rounded corners. */
.map-stage--card {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
}

/* Lifted out of the card, over the page, under the header — and growing. */
.map-stage--opening {
  position: fixed;
  z-index: 45;
  overflow: hidden;
  /* The card's own corners (HomePage's .map-card), at first. */
  border-radius: 1.5rem;
  box-shadow: var(--shadow-2xl);
  /* Never see-through, whatever is in it yet: under a live map, never seen. */
  background: hsl(var(--background));
}

.map-stage--growing {
  border-radius: 0;
  box-shadow: none;
  transition:
    top 0.65s cubic-bezier(0.65, 0, 0.35, 1),
    left 0.65s cubic-bezier(0.65, 0, 0.35, 1),
    width 0.65s cubic-bezier(0.65, 0, 0.35, 1),
    height 0.65s cubic-bezier(0.65, 0, 0.35, 1),
    border-radius 0.65s cubic-bezier(0.65, 0, 0.35, 1),
    box-shadow 0.65s ease;
}

.map-stage-open {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  /* Top right: the bottom corners hold Mapbox's logo and attribution. */
  align-items: flex-start;
  justify-content: flex-end;
  padding: 1rem;
  cursor: pointer;
  /* The page still scrolls under a finger; two fingers come to the script. */
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
}

.map-stage-cta {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 1rem;
  border-radius: 999px;
  background: hsl(var(--background) / 0.82);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid hsl(var(--border));
  color: hsl(var(--foreground));
  font-weight: 600;
  font-size: var(--text-ui);
  box-shadow: var(--shadow-lg);
  transition:
    transform 0.25s ease,
    background 0.25s ease;
}

.map-stage-open:hover .map-stage-cta,
.map-stage-open:focus-visible .map-stage-cta {
  transform: translateY(-2px);
  background: hsl(var(--background) / 0.95);
}

.map-stage-open:focus-visible {
  outline: 3px solid hsl(var(--ring));
  outline-offset: -3px;
  border-radius: inherit;
}

@media (prefers-reduced-motion: reduce) {
  .map-stage--growing,
  .map-stage-cta {
    transition: none;
  }
}
</style>
