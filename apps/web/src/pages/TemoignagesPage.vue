<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useMapStage } from "@/composables/useMapStage";

// /temoignages: the map page. The map itself is not mounted here — it lives
// once, above the pages (MapStage), and this page lends it its whole area:
// coming from the home page's card, it is the same map, grown.

const stage = useMapStage();
const el = ref<HTMLElement | null>(null);

onMounted(() => {
  stage.page.value = el.value;
});
onBeforeUnmount(() => stage.release(stage.page, el.value));
</script>

<template>
  <div ref="el" class="stage-page"></div>
</template>

<style scoped>
.stage-page {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
</style>
