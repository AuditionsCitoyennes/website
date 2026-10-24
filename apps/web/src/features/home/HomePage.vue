<script setup lang="ts">
import { ref } from "vue";
import { useMapStage } from "@/composables/useMapStage";
// First: the classes the sections share must come before the sections' own
// styles in the cascade (a section's modifier of one of them wins by order).
import "./home.css";
import HeroSection from "./HeroSection.vue";
import ProjectSection from "./ProjectSection.vue";
import TestimoniesSection from "./TestimoniesSection.vue";
import AuditionsSection from "./AuditionsSection.vue";

const stage = useMapStage();

// The hero photograph is shown (or could not be): from then on the map may
// load into its card (TestimoniesSection) — it must not compete with it.
const heroReady = ref(false);
</script>

<template>
  <!-- While its map card grows into the map page, the rest of the page fades
       away — and nothing in it can be reached any more. -->
  <div class="landing" :inert="Boolean(stage.opening.value) || undefined">
    <!-- 1. Full screen: the photograph, the name, the promise. -->
    <HeroSection @ready="heroReady = true" />

    <!-- 2. The project — and the invitation to testify. -->
    <ProjectSection />

    <!-- 3. What becomes of the testimonies — beside the map itself. -->
    <TestimoniesSection :hero-ready="heroReady" />

    <!-- 4. Public auditions: how they are held — and joining in. -->
    <AuditionsSection />
  </div>
</template>

<style scoped>
.landing {
  display: flex;
  flex-direction: column;
  transition: opacity 0.4s ease;
}

/* The map card opening into the map page (MapStage): everything else goes. */
:global(html.map-opening) .landing {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .landing {
    transition: none;
  }
}
</style>
