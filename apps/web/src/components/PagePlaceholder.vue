<script setup lang="ts">
defineProps<{ title: string; note?: string }>();
</script>

<template>
  <div class="placeholder container-page">
    <span class="badge">En construction</span>
    <h1>{{ title }}</h1>
    <p v-if="note" class="note">{{ note }}</p>
    <slot />
  </div>
</template>

<style scoped>
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  padding-block: 3.5rem;
}

.badge {
  display: inline-block;
  padding: 0.2rem 0.7rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: hsl(var(--accent) / 0.6);
  color: hsl(var(--accent-foreground));
}

.placeholder h1 {
  font-size: 2.6rem;
  color: hsl(var(--foreground));
}

.note {
  color: hsl(var(--muted-foreground));
  max-width: 560px;
}
</style>
