<script setup lang="ts">
// The long wait's sentence and its « Réessayer » (model/tapPendingCore: the
// wait is "late"): the map has been five seconds without raising the tapped
// territory. In the panel's head, under the trail; `floating`, over the top
// of the map — a phone whose sheet is lowered shows nothing of the panel but
// its strip, and the reader is looking at the map. Still: nothing moves here.
// The sentence is read out by GeoNav's live region, not from here (it would
// be said twice).
import { LATE_SENTENCE } from "../model/tapPendingCore";

defineProps<{
  /** Over the map's top instead of in the panel's head. */
  floating?: boolean;
}>();

const emit = defineEmits<{
  /** « Réessayer » pressed. */
  retry: [];
}>();
</script>

<template>
  <div class="slow-wait" :class="{ floating, 'elevation-lg': floating }">
    <p class="slow-wait-text">{{ LATE_SENTENCE }}</p>
    <button
      type="button"
      class="ac-btn ac-btn--outline ac-btn--sm slow-wait-retry"
      @click="emit('retry')"
    >
      Réessayer
    </button>
  </div>
</template>

<style scoped>
.slow-wait {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 0.6rem;
  padding: 0.45rem 0.5rem 0.45rem 0.75rem;
  border: 1px solid hsl(var(--border) / 0.8);
  border-radius: 0.6rem;
  background: hsl(var(--accent) / 0.35);
}

.slow-wait-text {
  margin: 0;
  font-size: var(--text-ui);
  line-height: 1.3;
  color: hsl(var(--foreground));
}

.slow-wait-retry {
  flex: none;
}

/* Over the map, under the floating header's tiles, clear of the map's own
   controls and credits (all at the bottom on a phone). */
.slow-wait.floating {
  position: absolute;
  top: calc(var(--header-space) + 0.5rem);
  left: 0.75rem;
  right: 0.75rem;
  margin-top: 0;
  background: hsl(var(--card) / 0.96);
}
</style>
