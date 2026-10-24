<script setup lang="ts">
// The frame of the auth pages: the gradient backdrop and, over it, the glass
// card the page's content sits in — or, while the page waits for something
// (`loading`), a spinner where the card will be.
defineProps<{
  /** No card yet: a spinner in its place (waiting for the recovery session). */
  loading?: boolean;
}>();
</script>

<template>
  <div class="backdrop gradient-hero" aria-hidden="true"></div>
  <div v-if="loading" class="loader">
    <span class="spinner spinner-lg" aria-label="Chargement"></span>
  </div>
  <div v-else class="card glass-strong elevation-2xl fade-in">
    <slot />
  </div>
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  opacity: 0.3;
}

.card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 28rem;
  border-radius: 1rem;
  padding: 2rem;
}

.loader {
  position: relative;
  z-index: 1;
}
</style>
