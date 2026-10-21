<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRouter } from "vue-router";
import { useMapStage, type StageRect } from "@/composables/useMapStage";
import { headerBottomPx, isPhone } from "@/shared/dom/header";

// The one testimonies map (see useMapStage): mounted in whichever place a page
// lends it — the home page's card, or /temoignages — and moved, not rebuilt,
// from one to the other. Opening the card grows it into the page: the map is
// lifted out of the card (fixed, where the card was), grows to the page's
// area while the home page fades away, and the route changes under it.

const Temoignages = defineAsyncComponent(() => import("@/pages/Temoignages.vue"));

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
    if (to && from && to !== from) window.dispatchEvent(new Event("ac:map-moved"));
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

const GROW_MS = 650;

/** A frame painted — or a moment, where frames are held back (a hidden tab). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 60);
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
}

/** The growth's end — or its time, should the event never come. */
function grown(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      resolve();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === "height") done();
    };
    el.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(done, GROW_MS + 150);
  });
}

/** Where the page will hold the map: under the header — or right from the
 *  top on a phone, where the header floats over the map page. */
function pageRect(): StageRect {
  const top = isPhone() ? 0 : headerBottomPx();
  const width = document.documentElement.clientWidth;
  return { top, left: 0, width, height: window.innerHeight - top };
}

/** The page's address, for the card's link (a new tab, a middle click). */
const pageHref = computed(() => router.resolve({ name: "temoignages" }).href);

/** A plain click opens the card in place; any other (modifier keys, middle
 *  button) is left to the browser — a new tab, a new window. */
function onCardClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  e.preventDefault();
  void open();
}

// ---- Trying to move the map opens it, like a click ------------------------
// A drag with the mouse, a pinch — two fingers on a touch screen, or on a
// trackpad (which the browser reports as a wheel with ctrlKey, no key held).
// Not the plain wheel, a one-finger swipe or a pen stroke: those scroll the
// home page, and must keep doing so over the card. Nor ctrl/⌘ + wheel with the
// key really held: that is the browser's own zoom.
const DRAG_PX = 6;
let press: { id: number; x: number; y: number } | null = null;
const fingers = new Set<number>();
/** Ctrl or ⌘ physically held — a trackpad pinch sets ctrlKey with none. */
let modifierHeld = false;

function onCardPointerDown(e: PointerEvent) {
  if (e.pointerType === "touch") {
    fingers.add(e.pointerId);
    if (fingers.size >= 2) void open();
    return;
  }
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // as for clicks
  press = { id: e.pointerId, x: e.clientX, y: e.clientY };
}

function onCardPointerMove(e: PointerEvent) {
  if (!press || e.pointerId !== press.id) return;
  // The button went up somewhere this card never heard of (a context menu).
  if ((e.buttons & 1) === 0) {
    press = null;
    return;
  }
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
  press = null;
  void open();
}

function onCardPointerEnd(e: PointerEvent) {
  if (press?.id === e.pointerId) press = null;
}

/** A context menu takes the button's release: no press is left armed. */
function onCardContextMenu() {
  press = null;
}

function onCardWheel(e: WheelEvent) {
  if ((!e.ctrlKey && !e.metaKey) || modifierHeld) return;
  e.preventDefault(); // not the browser's own pinch zoom
  void open();
}

// Fingers lifted anywhere (the card's link is gone the moment it opens, and
// with it the events of the fingers still down): forgotten, wherever.
function onWindowPointerEnd(e: PointerEvent) {
  fingers.delete(e.pointerId);
}
function onKey(e: KeyboardEvent) {
  modifierHeld = e.ctrlKey || e.metaKey;
}
function onBlur() {
  modifierHeld = false;
}
onMounted(() => {
  window.addEventListener("pointerup", onWindowPointerEnd, true);
  window.addEventListener("pointercancel", onWindowPointerEnd, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("blur", onBlur);
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerup", onWindowPointerEnd, true);
  window.removeEventListener("pointercancel", onWindowPointerEnd, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
  window.removeEventListener("blur", onBlur);
});

/** The rest of a pinch that opened the card: no browser zoom under it. */
function swallowPinch(e: WheelEvent) {
  if ((e.ctrlKey || e.metaKey) && !modifierHeld) e.preventDefault();
}

async function open() {
  const card = stage.card.value;
  if (!card || stage.opening.value) return;
  // Whatever was pressed on the card is over: the card's link goes now.
  press = null;
  fingers.clear();
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
      await router.push({ name: "temoignages" });
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
  /* The card's own corners (Landing's .map-card), at first. */
  border-radius: 1.5rem;
  box-shadow: var(--shadow-2xl);
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
