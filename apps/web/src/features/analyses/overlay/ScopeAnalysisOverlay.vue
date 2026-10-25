<script setup lang="ts">
// The analysis of the raised unit, ON the map: two slabs of it — small pieces
// of ground just outside its edge, the themes over the middle of its box's top
// edge, the plaque under the middle of its bottom edge, with raised pieces on
// them at the plateau's height (GeoDrillMap draws them): the plaque one piece;
// the themes three in a row — the ring, each of its parts raised in its
// colour, the bar of the theme named, the label's box. And here, their words,
// lying on those pieces' lids, glued to the map: they move, grow, shrink, tilt
// and turn with it, as any piece of it. The label's box and the plaque are
// glass ("Verre", the default): their words lie on a glass of their own here,
// the map seen through it.
//
// The words' CONTENT is ordinary Vue (it changes with the scope, a theme
// picked): this file. Their PLACE is not: each frame of the map (GeoDrillMap's
// frame bus) hands over each box's four corners on screen at its lid's height,
// and the box is mapped onto them by a projective transform written straight
// to the DOM (useSlabLayout — no reactive write, no layout read per frame).
// Three boxes: the ring's (its parts' targets and focus ring, over the parts
// raised: they are GeoDrillMap's, told the pick and the hover here, setRing),
// the label's, the plaque's. Their boxes are laid out at the type scale's
// sizes (analyses/content/slabSizes), and the slabs are sized on the map so
// that right after the camera frames the territory the reader sees a set
// share of those sizes (map/lib/slabs: TEXT_SCALE) — the CSS keeps its tokens,
// the map draws the boxes smaller. The ring's reader — the part picked,
// hovered, focused, said — is useRingPick's.
//
// Shown only while the slabs stand: the plateau raised, these slabs its own,
// risen — they fade in and out with its rise, nothing else hides them.
import {
  computed,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  shallowRef,
  useId,
  watch,
} from "vue";
import type { ScopeAnalysis } from "../stats/scopeStats";
import { emptyTextOf, fmtN, shortName } from "../content/text";
import { ringReading } from "../content/summary";
import { RING_LABEL } from "../content/ring";
import type { SlabSizes } from "../content/slabSizes";
import { frameFill, ringBandMode, slabLidMode, slabTextMode, slabTextScale } from "../devSwitch";
import type { FrameSource } from "./frameSource";
import { useRingPick } from "./useRingPick";
import { stretchOf, useSlabLayout, type SlabName } from "./useSlabLayout";
import DevSlabSwitch from "./DevSlabSwitch.vue";

const props = defineProps<{
  analysis: ScopeAnalysis;
  /** The slabs' content boxes for `analysis` (GeoNav: slabSizes) — the same
   *  boxes GeoDrillMap's slabs are sized for. */
  sizes: SlabSizes;
  /** Whether the words may show at all (the parent's view of the page). */
  visible: boolean;
  /** The safe rect inside the map container, px: clear of the panel, and on a
   *  phone of the header's tiles and the lowered sheet (the reading notes
   *  stay inside it, and the DEV switch). */
  insets: { top: number; right: number; bottom: number; left: number };
  frames: FrameSource | null;
  /** A phone: the reading notes' words for a finger, the DEV switch's place. */
  compact: boolean;
  /** Filters are on: every figure counts only what they let through. */
  filtered: boolean;
  /** The themes picked in Filtres (canonical names): each testimony counted
   *  cites one of them by construction, so they are no finding here. */
  themeFilter: string[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const uid = useId();
const isDev = import.meta.env.DEV;
// The DEV switch (DevSlabSwitch): the dev server and staging (the testing tools).
const testTools = __TEST_TOOLS__;

// ---- Content -------------------------------------------------------------------

// What the slabs say, and their boxes. They trail `analysis` on a scope
// change: the old unit's slabs sink with its plateau still saying what they
// said there, and the words change once the new unit's slabs come (onFrame).
const content = shallowRef(props.analysis);
const contentSizes = shallowRef(props.sizes);
const a = computed(() => content.value);
const sz = computed(() => contentSizes.value);

const howOpen = ref(false);

// Kept off the plaque's lines: a tooltip on the counts.
const concentrationText = computed(() => {
  const c = a.value.concentration;
  return c ? `Dont ${fmtN(c.count)} lors d'une seule audition : ${c.lieu}` : "";
});

const emptyText = computed(() => emptyTextOf(props.filtered));

const summaryLabel = computed(() => `Analyses : ${a.value.label}`);

// ---- Themes --------------------------------------------------------------------

/** The ring, as its content box was laid out for (analyses/content/slabSizes:
 *  slabSizes) — the very parts GeoDrillMap raises. */
const ring = computed(() => sz.value.themes?.ring ?? null);

/** Its reader: the part picked (the largest until the reader picks another),
 *  hovered, focused, said; the radio group its targets make. */
const {
  picked,
  ringPicked,
  hovered,
  said,
  tabStop,
  shownPart,
  labelSaid,
  focusPath,
  ringEl,
  onRingFocusIn,
  onRingFocusOut,
  onPartEnter,
  onPartLeave,
  onRingKey,
  onPartClick,
  reset: resetRing,
} = useRingPick(ring);

// What the ring leaves unsaid — how many testimonies it is read from, how far
// to trust it, what the filters do to it —, for the reading notes.
const themesReading = computed(() => ringReading(a.value, props.themeFilter));

// ---- The words on their lids (useSlabLayout: plain records, written per frame) ------

const rootEl = ref<HTMLElement | null>(null);
const howEl = ref<HTMLElement | null>(null);
const howBtn = ref<HTMLButtonElement | null>(null);

/** A slab's box of words, CSS px (null: none). */
function boxOf(name: SlabName): { w: number; h: number } | null {
  const z = contentSizes.value;
  if (name === "plaque") return z.plaque;
  if (!z.themes) return null;
  return name === "ring" ? z.themes.ringBox : z.themes.labelBox;
}

const slabs = useSlabLayout({
  rootEl,
  howEl,
  insets: () => props.insets,
  boxOf,
  onSwap: () => swapContent(props.analysis),
  frames: props.frames,
  visible: props.visible,
  scopeId: props.analysis.scopeId,
});

// ---- Wiring --------------------------------------------------------------------

function swapContent(next: ScopeAnalysis) {
  content.value = next;
  contentSizes.value = props.sizes;
  slabs.setContent(next.scopeId);
  // Another territory: its largest theme picked, and not said.
  resetRing();
  howOpen.value = false;
}

watch(
  () => props.analysis,
  (next) => {
    slabs.setTarget(next.scopeId);
    if (next.scopeId === slabs.contentScope) {
      // The same territory, other figures (a filter, the data reloaded): the
      // label takes them quietly — GeoNav's summary says what changed.
      said.value = null;
      content.value = next;
      contentSizes.value = props.sizes;
      return;
    }
    // Nothing on show: the new words at once. Else the old slabs sink with
    // their plateau as they are; the frame that brings the new ones swaps.
    if (!slabs.anyDrawn()) swapContent(next);
    slabs.layout();
  },
);

watch(
  () => props.sizes,
  (z) => {
    if (props.analysis.scopeId === slabs.contentScope) contentSizes.value = z;
  },
);

watch(
  () => props.frames,
  (src) => {
    slabs.setSource(src);
    sendRing();
    slabs.layout();
  },
);

/** The ring's pick and hover, to the map: its raised parts and the bar
 *  follow (the territory the words are about: its own ring). */
function sendRing() {
  props.frames?.setRing(a.value.scopeId, ringPicked.value, hovered.value);
}
watch(() => [a.value.scopeId, ringPicked.value, hovered.value], sendRing);

watch(
  () => props.visible,
  (v) => {
    slabs.setVisible(v);
    if (!v) {
      // Hidden under the mouse, a part never hears it leave.
      hovered.value = null;
      howOpen.value = false;
    }
    slabs.layout();
  },
);

// The reading notes close on a press anywhere else.
function onDocPointerDown(e: PointerEvent) {
  const t = e.target as Node | null;
  if (!t || howEl.value?.contains(t) || howBtn.value?.contains(t)) return;
  howOpen.value = false;
}
watch(howOpen, (open) => {
  if (open) document.addEventListener("pointerdown", onDocPointerDown, true);
  else document.removeEventListener("pointerdown", onDocPointerDown, true);
});

/** Escape: the reading notes first (the focus back on their button), then
 *  the analyses. */
function onEscape(e: KeyboardEvent) {
  if (howOpen.value) {
    e.stopPropagation();
    const inNotes = howEl.value?.contains(document.activeElement);
    howOpen.value = false;
    if (inNotes) howBtn.value?.focus({ preventScroll: true });
    return;
  }
  emit("close");
}

// The words are not the map's: mapbox listens for the wheel on its own
// canvas container only, so a zoom would stop dead the moment a part or a
// button slid under the cursor. Their wheel is passed on (the listener is not
// passive: the page must not scroll instead) — but for the reading notes,
// which scroll.
function onWheel(e: WheelEvent) {
  if (howEl.value?.contains(e.target as Node)) return;
  props.frames?.forwardWheel(e);
}

/** Takes the focus to the plaque's title. Nothing when it is not on screen (a
 *  hidden slab is inert). */
function focusPlaque(): void {
  slabs.focusPlaque();
}

defineExpose({ focusPlaque });

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// The DEV probe (window.__acAnalyses), for checking the layout in a browser.
function probe() {
  const state = slabs.snapshot();
  const out: Record<string, unknown> = {};
  // Each slab: its lid on screen, its box, the scales its words are drawn at
  // (on screen px per CSS px: across its far edge, its near edge, and down
  // its sides), its render scale.
  for (const s of state.slabs) {
    const box = boxOf(s.name);
    const q = s.quad;
    const len = (i: number, j: number) =>
      Math.hypot(q[2 * j] - q[2 * i], q[2 * j + 1] - q[2 * i + 1]);
    out[s.name] = {
      present: s.present,
      ok: s.ok,
      drawn: s.drawn,
      shown: s.live,
      opacity: s.opacity,
      box,
      r: s.r,
      quad: Array.from(q, r1),
      sMax: box ? r3(stretchOf(s, box)) : null,
      farScale: box ? r3(len(0, 1) / box.w) : null,
      nearScale: box ? r3(len(3, 2) / box.w) : null,
      heightRatio: box ? r3((len(0, 3) + len(1, 2)) / 2 / box.h) : null,
    };
  }
  const r = ring.value;
  return {
    visible: state.visible,
    open: state.open,
    frameScope: state.frameScope,
    scope: state.scope,
    target: state.target,
    rise: Math.round(state.rise * 100) / 100,
    lid: slabLidMode.value,
    text: slabTextMode.value,
    textScale: slabTextScale.value,
    frameFill: frameFill.value,
    ringBand: ringBandMode.value,
    resting: state.resting,
    sizes: contentSizes.value,
    slabs: out,
    donut: r
      ? {
          picked: ringPicked.value,
          byReader: picked.value !== null && picked.value === ringPicked.value,
          labelShown: shownPart.value?.theme ?? null,
          slices: r.parts.map((p) => ({
            theme: p.theme,
            colour: p.color,
            pastel: p.theme !== ringPicked.value,
            share: Math.round(p.share * 10000) / 10000,
            pct: p.pct,
            mentions: p.mentions,
          })),
        }
      : null,
  };
}

onMounted(() => {
  slabs.mount();
  sendRing();
  if (isDev) (window as unknown as { __acAnalyses?: () => unknown }).__acAnalyses = probe;
});

onUpdated(slabs.syncDom);

onBeforeUnmount(() => {
  slabs.dispose();
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  if (isDev) {
    const w = window as unknown as { __acAnalyses?: () => unknown };
    if (w.__acAnalyses === probe) delete w.__acAnalyses;
  }
});
</script>

<template>
  <!-- No z-index: the panel, after it in the page, must paint over it. -->
  <div
    ref="rootEl"
    class="analyses-layer"
    :class="[slabLidMode, { compact }]"
    role="region"
    :aria-label="summaryLabel"
    @keydown.esc="onEscape"
    @wheel="onWheel"
  >
    <!-- 1. The plaque, on the slab under the middle of the territory: what
         this unit is, and how much was heard there. Its box is the size
         estimate's (analyses/content/slabSizes), mapped onto the lid. -->
    <section data-slab="plaque" class="slab slab-plaque" :aria-labelledby="`${uid}-title`">
      <div class="slab-zoom">
        <div
          class="slab-body lid-glass"
          :style="{ width: `${sz.plaque.w}px`, height: `${sz.plaque.h}px` }"
        >
          <header class="plaque-head">
            <p class="plaque-kicker">
              <span class="kicker-text">{{ a.levelLabel }}</span>
              <span
                v-if="filtered"
                class="rel-badge"
                title="Les chiffres ne comptent que ce que les filtres retiennent"
                >filtré</span
              >
            </p>
            <button
              ref="howBtn"
              type="button"
              class="plate-icon"
              aria-label="Comment lire ?"
              title="Comment lire ?"
              :aria-expanded="howOpen"
              :aria-controls="`${uid}-howto`"
              @click="howOpen = !howOpen"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="11" x2="12" y2="16.5" />
                <line x1="12" y1="7.5" x2="12" y2="7.6" />
              </svg>
            </button>
            <button
              type="button"
              class="plate-icon"
              aria-label="Masquer les analyses"
              title="Masquer les analyses"
              @click="emit('close')"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2.4"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </header>
          <h2 :id="`${uid}-title`" class="plaque-title" tabindex="-1">{{ a.label }}</h2>
          <p v-if="a.testimonies" class="plaque-counts" :title="concentrationText || undefined">
            <span v-for="(line, i) in sz.plaque.countLines" :key="i" class="count-line">
              <template v-for="(c, j) in line" :key="c.key">
                <span v-if="j" class="sep" aria-hidden="true"> · </span>
                <span class="count"
                  ><strong>{{ fmtN(c.n) }}</strong> {{ c.word }}</span
                >
              </template>
            </span>
          </p>
          <p v-else class="plaque-empty">{{ emptyText }}</p>
        </div>
      </div>
    </section>

    <!-- 2. Thèmes, on the slab over the middle of the territory: a ring of
         every theme cited here, one colour each — no legend —, twice as tall
         as the bar of the theme named and its label beside it, three pieces
         in a row. One part is always picked, the largest until the reader
         picks another: it keeps its colour, the others turn pastel, and it is
         named beside the ring (a part hovered, for a preview), its short name
         — each part says its own in full. The parts and the bar are
         GeoDrillMap's, raised in their colours (setRing tells it the pick and
         the hover); here, over them, the ring's targets and its focus ring.
         The label's room is kept whatever it names. -->
    <section v-if="ring && sz.themes" class="slab-group" :aria-labelledby="`${uid}-themes`">
      <h3 :id="`${uid}-themes`" class="vh">Thèmes abordés</h3>
      <div data-slab="ring" class="slab slab-ring">
        <div class="slab-zoom">
          <div
            class="slab-body"
            :style="{ width: `${sz.themes.ringBox.w}px`, height: `${sz.themes.ringBox.h}px` }"
          >
            <!-- One radio group, one tab stop (a roving tabindex): each part
                 is a radio named in full, its figures with it, checked while
                 picked; the arrows go round it picking as they go, Enter or
                 Space picks the part focused (see onRingKey). A press keeps
                 the focus where it was (mousedown): the label says the pick,
                 the part's name would say it again. The focus ring is a path
                 of its own. Each part's full name is its target's tooltip (a
                 radio's children are not read: no name twice). -->
            <svg
              ref="ringEl"
              class="ring"
              :viewBox="`0 0 ${ring.box} ${ring.box}`"
              :width="ring.box"
              :height="ring.box"
              role="radiogroup"
              :aria-label="RING_LABEL"
              @keydown="onRingKey"
              @focusin="onRingFocusIn"
              @focusout="onRingFocusOut"
            >
              <g
                v-for="p in ring.parts"
                :key="p.theme"
                class="part"
                role="radio"
                :tabindex="p.theme === tabStop ? 0 : -1"
                :aria-checked="p.theme === ringPicked"
                :aria-label="p.aria"
                :data-theme="p.theme"
                @mousedown.prevent
                @click="onPartClick($event, p.theme)"
                @pointerenter="onPartEnter($event, p.theme)"
                @pointerleave="onPartLeave(p.theme)"
              >
                <path class="part-hit" :d="p.hit">
                  <title>{{ p.theme }}</title>
                </path>
              </g>
              <template v-if="focusPath">
                <path class="part-focus-halo" :d="focusPath" aria-hidden="true" />
                <path class="part-focus" :d="focusPath" aria-hidden="true" />
              </template>
            </svg>
          </div>
        </div>
      </div>
      <!-- The theme picked with a pointer is said as it shows; one picked
           with the keyboard, the largest, picked by default, and a preview
           are not (see `said`). Remade for each, so that it is said each
           time. Its share first — what the part's size shows —, then the
           count it is read from. -->
      <div data-slab="label" class="slab slab-label">
        <div class="slab-zoom">
          <div
            class="slab-body lid-glass"
            :style="{ width: `${sz.themes.labelBox.w}px`, height: `${sz.themes.labelBox.h}px` }"
          >
            <div class="ring-label" :style="{ width: `${sz.themes.labelW}px` }" aria-live="polite">
              <p
                v-if="shownPart"
                :key="`${shownPart.theme}${labelSaid ? '' : ':quiet'}`"
                :aria-hidden="labelSaid ? undefined : 'true'"
              >
                <strong class="label-name"
                  ><span class="label-pct">{{ shownPart.pct }}</span>
                  {{ shortName(shownPart.theme) }}</strong
                >
                <span class="label-cited">{{ shownPart.cited }}</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- The reading notes: no room on the plaque's lid, so a small upright
         card over its top edge, following it (placeHowto). They also say what
         the ring leaves unsaid: what its parts are a share of, how to read
         it, how many testimonies it is read from, how far to trust it. -->
    <div v-if="howOpen" :id="`${uid}-howto`" ref="howEl" class="howto-pop">
      <ul class="howto">
        <li>Pas un sondage : des voix recueillies où les bénévoles sont allés.</li>
        <li>
          Le cercle : la part de chaque thème parmi les thèmes cités ici. Un témoignage en aborde
          souvent plusieurs (ils sont attribués automatiquement) : ce n'est pas la part des
          témoignages qui l'abordent. Une couleur par thème, la même partout. Le thème le plus cité
          est montré d'abord ;
          <template v-if="compact">touchez une autre part pour afficher son thème.</template>
          <template v-else>cliquez sur une autre part pour afficher son thème.</template>
        </li>
        <li v-if="themesReading">{{ themesReading }}</li>
        <li>
          Pour chaque thème, sa part des thèmes cités, puis le nombre de témoignages qui l'abordent.
          Sous 100 témoignages analysés, la part est arrondie à 5&nbsp;% près («&nbsp;≈&nbsp;»). La
          base est « solide » avec 30 témoignages ou plus, d'au moins 3 auditions d'une même
          période, aucune au-delà de la moitié ; sinon, le cercle n'est qu'indicatif. Sous 5
          témoignages, pas de cercle.
        </li>
      </ul>
    </div>

    <!-- Testing tools only (dev server, staging): the slabs' lid, words and
         size, the territory's framing, the ring's band (DevSlabSwitch,
         analyses/devSwitch). Apart from them; on a phone folded. -->
    <DevSlabSwitch v-if="testTools" v-show="visible" :compact="compact" :insets="insets" />
  </div>
</template>

<style scoped>
/* Over the map, the same box as its container (its px are the frame's px). */
.analyses-layer {
  position: absolute;
  inset: 0;
  overflow: clip;
  pointer-events: none;
}

/* ---- Slabs ---- */

/* Laid on its lid by its transform (written per frame, mapped from its top
   left corner). Its body lets the pointer through, as the ground does: a drag
   on it moves the map; only the ring's parts, the buttons and the tooltips
   (the counts', the "filtré" badge's) take it. Its content is drawn at a
   render scale (.slab-zoom, at rest). Nothing here may fade, filter, clip
   or mask the box (no opacity, no filter, no clip-path, no mask): that would
   make it the glass's backdrop root, and the glass would blur nothing — its
   body fades instead. */
.slab {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  backface-visibility: hidden;
  pointer-events: none;
}

/* The box the estimate laid out (analyses/content/slabSizes — keep in
   step): every word at --text-caption, the title at --text-title. No
   transition: it fades with the lid's rise, frame by frame (written there).
   Its ground is its lid's — the map draws it exactly where the lid stands: a
   ground here, the box mapped by its corners, would be a pixel or so inside
   the lid on the globe, where the lid follows the sphere, more zoomed in —,
   but for glass (.lid-glass), the words' own. Under a 3D transform the words
   are smoothed the same either way. */
.slab-body {
  box-sizing: border-box;
  color: hsl(var(--slab-ink, var(--card-foreground)));
  font-size: var(--text-caption);
  line-height: 1.3;
  opacity: 0;
}

/* "Verre" (the default): the label's box and the plaque are glass — their
   pieces' lids are not drawn (GeoDrillMap), the map under them shows here,
   blurred, brightened, its colours lifted, through a light white — enough
   for the words to read should a browser drop the blur under the 3D
   transform —; a bright rim along the top edge and round it, a sheen
   across; rounded as their pieces' outlines (map/lib/slabs: SLAB_RADIUS_PX).
   Chromium computes the blur in the box's own plane (the backdrop mapped
   into it): it lies on the lid with the words. The map keeps the style's own
   light (Standard, "dawn": pale warm ground, dark place names) whatever the
   site's theme — the dark theme would write the words light on a light map
   —, so the words take a dark ink of their own here, and a light halo
   against what shows through. */
.verre {
  --slab-ink: 240 10% 10%;
  --slab-muted: 240 6% 30%;
  --slab-accent: 270 62% 44%;
  --slab-hover: 0 0% 100% / 0.6;
}

.verre .lid-glass {
  border-radius: 6px;
  background:
    linear-gradient(
      160deg,
      hsl(0 0% 100% / 0.45),
      hsl(0 0% 100% / 0.12) 42%,
      hsl(0 0% 100% / 0.04) 58%,
      hsl(0 0% 100% / 0.2)
    ),
    hsl(0 0% 100% / 0.45);
  -webkit-backdrop-filter: blur(9px) saturate(1.8) brightness(1.08);
  backdrop-filter: blur(9px) saturate(1.8) brightness(1.08);
  box-shadow:
    inset 0 1px 0 hsl(0 0% 100% / 0.85),
    inset 0 0 0 1px hsl(0 0% 100% / 0.4),
    inset 0 -1px 2px hsl(0 0% 100% / 0.3);
  text-shadow: 0 0 2px hsl(0 0% 100% / 0.8);
}

/* No backdrop filter: frosted, not blurred — a white the words read on over
   the map as it is. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .verre .lid-glass {
    background-color: hsl(0 0% 100% / 0.74);
  }
}

/* Less transparency asked for: no blur, a white the words read on, barely
   letting the map through. */
@media (prefers-reduced-transparency: reduce) {
  .verre .lid-glass {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    background-color: hsl(0 0% 100% / 0.9);
  }
}

/* "Carte" (DEV): the lid shows the raised map; the words haloed over it. */
.carte .slab-body {
  text-shadow:
    0 0 2px hsl(var(--card)),
    0 0 2px hsl(var(--card)),
    0 0 4px hsl(var(--card));
}

.slab p {
  margin: 0;
}

.slab :focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
}

/* Visually hidden, still read: a heading, a value said in full. */
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ---- Plaque ---- */

.slab-plaque .slab-body {
  padding: 0.35rem 0.5rem;
}

/* The head row, 16 px: the level and its badge, then the two buttons (24 px,
   drawn into the padding above and below, the last into it at the right). */
.plaque-head {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  height: 16px;
}

.plaque-kicker {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.2;
  text-transform: uppercase;
  white-space: nowrap;
  color: hsl(var(--slab-accent, var(--primary)));
}

.kicker-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The filters are on: the figures are theirs. */
.rel-badge {
  flex: none;
  padding: 0 0.35rem;
  border-radius: 999px;
  border: 1px solid hsl(var(--slab-accent, var(--primary)) / 0.3);
  background: hsl(var(--slab-accent, var(--primary)) / 0.1);
  letter-spacing: normal;
  text-transform: none;
  line-height: 1.15;
}

.plate-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: -4px 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: hsl(var(--slab-muted, var(--muted-foreground)));
  cursor: pointer;
}

.plate-icon:last-child {
  margin-right: -4px;
}

.plate-icon:hover {
  color: hsl(var(--slab-ink, var(--foreground)));
  background: hsl(var(--slab-hover, var(--muted)));
}

.plaque-title {
  margin: 0.15rem 0 0;
  font-family: var(--font-display);
  font-size: var(--text-title);
  font-weight: 400;
  letter-spacing: 0.04em;
  line-height: 1;
  color: hsl(var(--slab-ink, var(--foreground)));
  overflow-wrap: anywhere;
}

.plaque-title:focus:not(:focus-visible) {
  outline: none;
}

/* The counts in the lines the estimate laid them out on: one, but on a
   screen too narrow for them. */
.plaque-counts,
.plaque-empty {
  margin-top: 0.2rem;
  color: hsl(var(--slab-ink, var(--foreground)));
}

.count-line {
  display: block;
  white-space: nowrap;
}

.count strong {
  font-weight: 700;
}

.count-line:first-child .count:first-of-type strong {
  color: hsl(var(--slab-accent, var(--primary)));
}

.sep {
  color: hsl(var(--slab-muted, var(--muted-foreground)) / 0.7);
}

/* ---- Thèmes ---- */

/* Only the targets and the focus ring: the parts themselves are the map's,
   raised in their colours (vivid picked or hovered, pastel otherwise) right
   under this box. The browser hit-tests the ring as it is laid on the lid,
   its targets and its focus ring with it. */
.ring {
  display: block;
  overflow: visible;
}

.part {
  cursor: pointer;
}

/* The focus ring is drawn as a path (.part-focus), never as an outline. */
.slab-ring .part:focus,
.slab-ring .part:focus-visible {
  outline: none;
}

/* Where a part takes the pointer: its span, gaps included, a little inside
   and outside the ring (whatever its fill: none is painted). */
.part-hit {
  fill: transparent;
  fill-rule: evenodd;
}

/* Only the parts, the buttons, the counts and the "filtré" badge (their
   tooltips) take the pointer, and only on a slab on show (an inert one takes
   nothing anyway). */
[data-live] .part-hit {
  pointer-events: fill;
}

[data-live] .plate-icon,
[data-live] .plaque-counts,
[data-live] .rel-badge {
  pointer-events: auto;
}

.part-focus-halo,
.part-focus {
  fill: none;
  stroke-linejoin: round;
  pointer-events: none;
}

.part-focus-halo {
  stroke: hsl(var(--background));
  stroke-width: 3;
}

.part-focus {
  stroke: hsl(var(--ring));
  stroke-width: 1.5;
}

/* The label's box, right of the bar of the theme's colour (the map's): two
   lines — its share and short name, its count —, each on one line (the room
   is measured for the widest part; an ellipsis only should a font come out
   wider). */
.slab-label .slab-body {
  display: flex;
  align-items: center;
  padding: 0.3rem 0.45rem;
}

.ring-label {
  flex: none;
  min-width: 0;
  pointer-events: none;
}

.label-name,
.label-cited {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.label-name {
  font-weight: 700;
  line-height: 1.2;
  color: hsl(var(--slab-ink, var(--foreground)));
}

.label-cited {
  margin-top: 0.1rem;
  line-height: 1.3;
  color: hsl(var(--slab-muted, var(--muted-foreground)));
}

/* ---- The reading notes: upright, over the plaque's top edge ---- */

.howto-pop {
  position: absolute;
  left: 0;
  top: 0;
  box-sizing: border-box;
  max-width: min(18rem, calc(100% - 16px));
  max-height: 40%;
  overflow: auto;
  padding: 0.5rem 0.65rem;
  border: 1px solid hsl(var(--border));
  border-radius: 0.6rem;
  background: hsl(var(--card));
  color: hsl(var(--card-foreground));
  box-shadow: var(--shadow-lg);
  font-size: var(--text-caption);
  line-height: 1.35;
  pointer-events: auto;
}

.howto {
  margin: 0;
  padding: 0 0 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  color: hsl(var(--foreground) / 0.85);
}

.howto li::marker {
  color: hsl(var(--primary));
}
</style>
