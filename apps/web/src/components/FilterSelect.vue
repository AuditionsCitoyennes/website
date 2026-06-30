<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

interface Option {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string | null;
  options: Option[];
  allLabel: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const search = ref("");

const selectedLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? null,
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.label.toLowerCase().includes(q));
});

function select(value: string | null) {
  emit("update:modelValue", value);
  open.value = false;
  search.value = "";
}

function toggle() {
  open.value = !open.value;
  if (open.value) search.value = "";
}

function onDocMouseDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown));
</script>

<template>
  <div ref="root" class="filter-select">
    <div class="fs-row">
      <button type="button" class="fs-trigger" @click="toggle">
        <span class="fs-value" :class="{ muted: !selectedLabel }">
          {{ selectedLabel ?? allLabel }}
        </span>
        <svg class="fs-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button
        v-if="modelValue"
        type="button"
        class="fs-clear"
        aria-label="Effacer"
        @click="select(null)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <div v-if="open" class="fs-panel">
      <input
        v-model="search"
        class="fs-search"
        :placeholder="placeholder ?? 'Rechercher...'"
      />
      <ul class="fs-list">
        <li>
          <button type="button" class="fs-item" @click="select(null)">
            {{ allLabel }}
          </button>
        </li>
        <li v-for="o in filtered" :key="o.value">
          <button
            type="button"
            class="fs-item"
            :class="{ active: o.value === modelValue }"
            @click="select(o.value)"
          >
            {{ o.label }}
          </button>
        </li>
        <li v-if="filtered.length === 0" class="fs-empty">Aucun résultat</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.filter-select {
  position: relative;
}

.fs-row {
  display: flex;
  gap: 0.25rem;
}

.fs-trigger {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  font-size: 0.9rem;
  min-width: 0;
}

.fs-trigger:hover {
  background: hsl(var(--accent) / 0.5);
}

.fs-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fs-value.muted {
  color: hsl(var(--muted-foreground));
}

.fs-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}

.fs-clear {
  display: grid;
  place-items: center;
  width: 34px;
  border-radius: 0.5rem;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--card));
  color: hsl(var(--muted-foreground));
}

.fs-clear:hover {
  color: hsl(var(--foreground));
  background: hsl(var(--accent) / 0.5);
}

.fs-panel {
  position: absolute;
  /* Below the sticky header (z 50): the panel only needs to beat page content. */
  z-index: 40;
  top: calc(100% + 0.35rem);
  left: 0;
  right: 0;
  background: hsl(var(--popover));
  border: 1px solid hsl(var(--border));
  border-radius: 0.6rem;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.fs-search {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: none;
  border-bottom: 1px solid hsl(var(--border));
  background: transparent;
  color: hsl(var(--foreground));
  outline: none;
}

.fs-list {
  list-style: none;
  margin: 0;
  padding: 0.25rem;
  max-height: 230px;
  overflow-y: auto;
}

.fs-item {
  width: 100%;
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-radius: 0.4rem;
  background: transparent;
  color: hsl(var(--foreground));
  font-size: 0.9rem;
}

.fs-item:hover {
  background: hsl(var(--accent) / 0.6);
}

.fs-item.active {
  color: hsl(var(--primary));
  font-weight: 600;
}

.fs-empty {
  padding: 0.6rem;
  color: hsl(var(--muted-foreground));
  font-size: 0.85rem;
  text-align: center;
}
</style>
