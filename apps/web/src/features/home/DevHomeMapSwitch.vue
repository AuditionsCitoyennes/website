<script setup lang="ts">
// When the home page's map card is lent to the map (useMapCardSlot): "proche"
// (heading there, the default), "tôt" (as before: once the page is in, at
// idle), "contact" (reached only) — the page loads again with the choice. The
// testing tools only: TestimoniesSection loads it behind `__TEST_TOOLS__`.
// Folded by default, under the card — not in it: the card's link covers it
// all. From the console too: window.__acHomeMap("proche" | "tot" | "contact").
import { homeMapPolicy, setHomeMapPolicy, type HomeMapPolicy } from "./useMapCardSlot";

const POLICIES: readonly { id: HomeMapPolicy; label: string }[] = [
  { id: "proche", label: "Proche" },
  { id: "tot", label: "Tôt" },
  { id: "contact", label: "Contact" },
];

(window as unknown as { __acHomeMap?: (p: HomeMapPolicy) => void }).__acHomeMap = setHomeMapPolicy;
</script>

<template>
  <details class="dev-home-map" aria-label="Chargement de la carte (DEV)">
    <summary class="switch-fold">DEV · carte : {{ homeMapPolicy }}</summary>
    <div class="seg" role="group" aria-label="Carte chargée">
      <span class="seg-label">Carte chargée</span>
      <button
        v-for="p in POLICIES"
        :key="p.id"
        type="button"
        class="seg-btn"
        :aria-pressed="homeMapPolicy === p.id"
        @click="setHomeMapPolicy(p.id)"
      >
        {{ p.label }}
      </button>
    </div>
  </details>
</template>

<style scoped>
.dev-home-map {
  display: inline-block;
  margin-top: 0.75rem;
  padding: 0.15rem;
  border-radius: 0.45rem;
  background: hsl(var(--muted));
  box-shadow: var(--shadow-sm);
  font-size: var(--text-caption);
  white-space: nowrap;
}

.switch-fold {
  padding: 0.05rem 0.3rem;
  color: hsl(var(--muted-foreground));
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}

.switch-fold::-webkit-details-marker {
  display: none;
}

.dev-home-map[open] .switch-fold {
  margin-bottom: 0.15rem;
}

.seg {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}

.seg-label {
  padding: 0 0.3rem;
  color: hsl(var(--muted-foreground));
}

.seg-btn {
  padding: 0.05rem 0.45rem;
  border: none;
  border-radius: 0.3rem;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
}

.seg-btn[aria-pressed="true"] {
  background: hsl(var(--card));
  color: hsl(var(--primary));
  box-shadow: var(--shadow-sm);
}
</style>
