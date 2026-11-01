<script setup lang="ts">
import { useRouter } from "vue-router";
import { ROUTE } from "@/shared/routes";

// The stage when the map's code could not be fetched (a flaky network): said,
// rather than a loading curtain left up for good. The link loads the page
// anew — a plain one, not the router's: a failed import is not tried again.
const pageHref = useRouter().resolve({ name: ROUTE.temoignages.name }).href;
</script>

<template>
  <div class="stage-failed">
    <p>La carte n'a pas pu être chargée.</p>
    <a :href="pageHref">Réessayer</a>
  </div>
</template>

<style scoped>
/* The box of StageLoading (GeoNav.vue's .boot). */
.stage-failed {
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

.stage-failed a {
  color: hsl(var(--primary));
  font-weight: 600;
}
</style>
