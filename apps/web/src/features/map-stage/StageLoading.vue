<script setup lang="ts">
import { markRaw, shallowRef, type Component } from "vue";
import MapCurtain from "@/shared/ui/MapCurtain.vue";

// The stage while the map's code is still coming (MapStage's async explorer):
// the card reached, opened, or /temoignages landed on before it is in. The
// map's loading curtain (shared/ui/MapCurtain.vue), as GeoNav's boot curtain
// draws it the moment the explorer mounts: the same France, spinner and words
// at the same places, so the card, the growing box and the page are never
// blank, and the hand-over is not seen. Hidden from assistive technologies:
// it cannot tell the card from the page, and on the home page it must not be
// announced; on the page, GeoNav's curtain announces right after.

// The async wrapper hands its props over (`preview`).
defineOptions({ inheritAttrs: false });
defineProps<{ preview?: boolean }>();

// France, its own small file, asked for only then: this curtain is in every
// page's code. Until it is in, the curtain is its background alone.
const poster = shallowRef<Component | null>(posterIn);
if (!posterIn) {
  posterAsked ??= import("@/shared/ui/CurtainPoster.vue").then(
    (m) => (posterIn = markRaw(m.default)),
    () => (posterAsked = null), // a later curtain asks again
  );
  void posterAsked.then(() => (poster.value = posterIn));
}
</script>

<script lang="ts">
/** Once its file is in, for every later curtain of the visit. */
let posterIn: Component | null = null;
let posterAsked: Promise<unknown> | null = null;
</script>

<template>
  <div class="stage-loading" aria-hidden="true">
    <MapCurtain :poster="poster" :preview="preview" :from="{ stage: 'stage' }" />
  </div>
</template>

<style scoped>
.stage-loading {
  position: absolute;
  inset: 0;
  z-index: 10;
}
</style>
