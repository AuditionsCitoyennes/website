<script setup lang="ts">
import { computed } from "vue";
import type { AuditionArea } from "@ac/shared";
import { placementNote } from "./placement";

// On an audition's line, after its lieu: how the map places it, when not on a
// point or a commune. How to fix it is in the tooltip (and in the popup).
const props = defineProps<{ area?: AuditionArea | null }>();
const note = computed(() => placementNote(props.area));
</script>

<template>
  <span v-if="note?.off" class="chip chip--amber mark mark--off" :title="note.hint">{{
    note.label
  }}</span>
  <span v-else-if="note" class="mark" :title="note.hint">· {{ note.label }}</span>
</template>

<style scoped>
/* The tooltip says how to fix it: the cursor and the dotted line say there is one. */
.mark {
  cursor: help;
  text-decoration: underline dotted hsl(var(--muted-foreground) / 0.6);
  text-underline-offset: 0.2em;
}

.mark--off {
  margin-left: 0.4rem;
  text-decoration: none;
}
</style>
