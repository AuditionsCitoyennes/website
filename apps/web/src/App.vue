<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute } from "vue-router";
import AppHeader from "@/app/header/AppHeader.vue";
import AppDialogs from "@/app/AppDialogs.vue";
import MapStage from "@/components/MapStage.vue";
import ToastHost from "@/shared/ui/toast/ToastHost.vue";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const route = useRoute();

onMounted(() => {
  auth.init();
});
</script>

<template>
  <AppHeader />
  <main class="app-main" :class="{ 'app-main--bleed': route.meta.bleed }">
    <RouterView />
  </main>
  <!-- The testimonies map, once for the whole site: a card on the home page,
       the whole of /temoignages (see useMapStage). -->
  <MapStage />
  <!-- The two site-wide popups ("Nouvelle Audition", "Témoigner"), each
       downloaded only once it is first asked for. -->
  <AppDialogs />
  <ToastHost />
</template>

<style>
/* A card opening into the map page: the page behind it holds still. */
html.map-opening {
  overflow: hidden;
}
</style>

<style scoped>
.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* Phones: the header floats over the page and takes no room of its own, so
   the page leaves it its space — unless the page runs under it (`bleed`). */
@media (max-width: 899px) {
  .app-main:not(.app-main--bleed) {
    padding-top: var(--header-space);
  }
}
</style>
