<script setup lang="ts">
// The slabs' choices, compared live (analyses/devSwitch): a segmented switch
// for each — the lid, the words, their size, the territory's framing, the
// ring's band. Testing tools only (the dev server, staging): the overlay
// draws it behind `__TEST_TOOLS__`. Apart from the slabs: on a desktop under
// the panel, at the map's bottom right (painted over the panel); on a phone
// at the safe rect's top right, under the header's tiles, folded until
// opened: its five rows would cover the themes there, the fold alone stands
// clear of them (centred, they span at most ~237 px right after a fit, and on
// a 320 px phone stand some 26 px away from it at the least).
import { computed } from "vue";
import {
  frameFill,
  ringBandMode,
  SCALE_CHOICES,
  setFrameFill,
  setRingBandMode,
  setSlabLidMode,
  setSlabTextMode,
  setSlabTextScale,
  slabLidMode,
  slabTextMode,
  slabTextScale,
  type RingBandMode,
  type SlabLidMode,
  type SlabTextMode,
} from "../devSwitch";

const props = defineProps<{
  /** A phone: folded, at the safe rect's top right. */
  compact: boolean;
  /** The safe rect inside the map container, px (the overlay's). */
  insets: { top: number; right: number; bottom: number; left: number };
}>();

const LID_MODES: readonly { id: SlabLidMode; label: string }[] = [
  { id: "verre", label: "Verre" },
  { id: "opaque", label: "Opaque" },
  { id: "carte", label: "Carte" },
];
const TEXT_MODES: readonly { id: SlabTextMode; label: string }[] = [
  { id: "redresse", label: "Redressé" },
  { id: "plat", label: "À plat" },
];
/** "Taille" (the words' share of their sizes) and "Cadrage" (the territory's
 *  share of its rectangle): the same steps. */
const SHARES = SCALE_CHOICES.map((v) => ({ v, label: `${Math.round(v * 100)} %` }));
const RING_MODES: readonly { id: RingBandMode; label: string }[] = [
  { id: "fin", label: "Fin" },
  { id: "moyen", label: "Moyen" },
  { id: "epais", label: "Épais" },
];

const switchStyle = computed(() =>
  props.compact
    ? { right: `${props.insets.right + 8}px`, top: `${props.insets.top + 8}px` }
    : { right: "12px", bottom: "36px", zIndex: 5 },
);
</script>

<template>
  <component
    :is="compact ? 'details' : 'div'"
    class="slab-switch"
    :style="switchStyle"
    role="group"
    aria-label="Dalles des analyses (DEV)"
  >
    <summary v-if="compact" class="switch-fold">DEV</summary>
    <div class="switch-rows">
      <div class="seg" role="group" aria-label="Dalle">
        <span class="seg-label">Dalle</span>
        <button
          v-for="m in LID_MODES"
          :key="m.id"
          type="button"
          class="seg-btn"
          :aria-pressed="slabLidMode === m.id"
          @click="setSlabLidMode(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="seg" role="group" aria-label="Texte">
        <span class="seg-label">Texte</span>
        <button
          v-for="m in TEXT_MODES"
          :key="m.id"
          type="button"
          class="seg-btn"
          :aria-pressed="slabTextMode === m.id"
          @click="setSlabTextMode(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="seg" role="group" aria-label="Taille du texte">
        <span class="seg-label">Taille</span>
        <button
          v-for="m in SHARES"
          :key="m.v"
          type="button"
          class="seg-btn"
          :aria-pressed="slabTextScale === m.v"
          @click="setSlabTextScale(m.v)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="seg" role="group" aria-label="Cadrage">
        <span class="seg-label">Cadrage</span>
        <button
          v-for="m in SHARES"
          :key="m.v"
          type="button"
          class="seg-btn"
          :aria-pressed="frameFill === m.v"
          @click="setFrameFill(m.v)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="seg" role="group" aria-label="Anneau">
        <span class="seg-label">Anneau</span>
        <button
          v-for="m in RING_MODES"
          :key="m.id"
          type="button"
          class="seg-btn"
          :aria-pressed="ringBandMode === m.id"
          @click="setRingBandMode(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
    </div>
  </component>
</template>

<style scoped>
/* Apart from the slabs (see the script): over the map, taking the pointer
   where the layer around it does not. */
.slab-switch {
  position: absolute;
  padding: 0.15rem;
  border-radius: 0.45rem;
  background: hsl(var(--muted));
  box-shadow: var(--shadow-sm);
  font-size: var(--text-caption);
  white-space: nowrap;
  pointer-events: auto;
}

/* A phone's fold: as narrow as it reads, no marker. */
.switch-fold {
  display: block;
  padding: 0.05rem 0.3rem;
  color: hsl(var(--muted-foreground));
  font-weight: 600;
  cursor: pointer;
}

.switch-fold::-webkit-details-marker {
  display: none;
}

.slab-switch[open] .switch-fold {
  margin-bottom: 0.15rem;
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
  min-width: 3.6rem;
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
