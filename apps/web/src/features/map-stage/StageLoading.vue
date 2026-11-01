<script setup lang="ts">
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
</script>

<template>
  <div class="stage-loading" aria-hidden="true">
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
</style>
