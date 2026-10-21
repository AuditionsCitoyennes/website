<script setup lang="ts">
defineProps<{ chips: { id: string; label: string }[] }>();

const emit = defineEmits<{ remove: [id: string] }>();
</script>

<template>
  <div class="chips">
    <button
      v-for="chip in chips"
      :key="chip.id"
      type="button"
      class="chip"
      :title="`Retirer : ${chip.label}`"
      @click="emit('remove', chip.id)"
    >
      <span class="chip-label">{{ chip.label }}</span>
      <svg
        class="chip-x"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        width="12"
        height="12"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
    <!-- Optional trailing content (e.g. a reset button) flowing inline with the
         chips, on the same row as the last chip. -->
    <slot name="trailing" />
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 100%;
  padding: 0.22rem 0.4rem 0.22rem 0.6rem;
  border-radius: 999px;
  border: 1px solid hsl(var(--primary) / 0.35);
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
  font-size: var(--text-caption);
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition-smooth);
}

.chip:hover {
  background: hsl(var(--destructive) / 0.12);
  border-color: hsl(var(--destructive) / 0.4);
  color: hsl(var(--destructive));
}

.chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 16rem;
}

.chip-x {
  flex-shrink: 0;
  opacity: 0.8;
}
</style>
