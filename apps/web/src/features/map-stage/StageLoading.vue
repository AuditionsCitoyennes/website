<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { curtainPoster, poster } from "@/shared/ui/posterSwitch";

// The stage while the map's code is still coming (MapStage's async explorer):
// the card reached, opened, or /temoignages landed on before it is in. The
// look of the map's own boot curtain (GeoNav's .boot), which takes over from
// it the moment the explorer mounts — so the card, the growing box and the
// page are never blank, and the hand-over is not seen. Hidden from assistive
// technologies: it cannot tell the card from the page, and on the home page
// it must not be announced; on the page, GeoNav's curtain announces right
// after.

// The async wrapper hands its props over (`preview`): declared so that they
// are not left on the root as attributes, and not used.
defineOptions({ inheritAttrs: false });
defineProps<{ preview?: boolean }>();

// France behind the spinner, as GeoNav's curtain (`ac:poster`, shared/ui/posterSwitch).
// Its own small file, asked for only then: this curtain is in every page's code.
const withPoster = curtainPoster(poster);
const FrancePoster = withPoster
  ? defineAsyncComponent(() => import("@/shared/ui/FrancePoster.vue"))
  : null;
</script>

<template>
  <div class="stage-loading" aria-hidden="true">
    <FrancePoster v-if="FrancePoster" class="loading-poster" />
    <span class="spinner spinner-lg"></span>
    <p>Chargement de la carte…</p>
  </div>
</template>

<style scoped>
/* GeoNav.vue's .boot, verbatim. */
.stage-loading {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  background: hsl(var(--background));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}

/* GeoNav.vue's .boot-poster, verbatim: under the spinner and its words. */
.loading-poster {
  position: absolute;
  top: 10%;
  left: 10%;
  width: 80%;
  height: 80%;
  opacity: 0.45;
}

.stage-loading > :not(.loading-poster) {
  position: relative;
}
</style>
