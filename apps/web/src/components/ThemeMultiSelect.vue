<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

interface Option {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string[];
  options: Option[];
  allLabel: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const search = ref("");

const triggerLabel = computed(() =>
  props.modelValue.length === 0
    ? props.allLabel
    : `${props.modelValue.length} thème${props.modelValue.length > 1 ? "s" : ""} sélectionné${props.modelValue.length > 1 ? "s" : ""}`,
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.label.toLowerCase().includes(q));
});

function isChecked(value: string) {
  return props.modelValue.includes(value);
}

function toggle(value: string) {
  const set = new Set(props.modelValue);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  emit("update:modelValue", [...set]);
}

function clearAll() {
  emit("update:modelValue", []);
}

function onDocMouseDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown));
</script>

<template>
  <div ref="root" class="ms">
    <button type="button" class="ms-trigger" @click="open = !open">
      <span class="ms-value" :class="{ muted: modelValue.length === 0 }">{{ triggerLabel }}</span>
      <svg
        class="ms-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        width="16"
        height="16"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <div v-if="open" class="ms-panel">
      <input v-model="search" class="ms-search" :placeholder="placeholder ?? 'Rechercher...'" />
      <ul class="ms-list">
        <li v-for="o in filtered" :key="o.value">
          <button type="button" class="ms-item" @click="toggle(o.value)">
            <span class="ms-box" :class="{ checked: isChecked(o.value) }">
              <svg
                v-if="isChecked(o.value)"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
                width="12"
                height="12"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span class="ms-label">{{ o.label }}</span>
          </button>
        </li>
        <li v-if="filtered.length === 0" class="ms-empty">Aucun résultat</li>
      </ul>
      <button v-if="modelValue.length > 0" type="button" class="ms-clear" @click="clearAll">
        Tout effacer ({{ modelValue.length }})
      </button>
    </div>
  </div>
</template>

<style scoped>
.ms {
  position: relative;
}

.ms-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  font-size: 0.9rem;
  text-align: left;
}

.ms-trigger:hover {
  background: hsl(var(--accent) / 0.5);
}

.ms-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms-value.muted {
  color: hsl(var(--muted-foreground));
}

.ms-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}

.ms-panel {
  position: absolute;
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

.ms-search {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: none;
  border-bottom: 1px solid hsl(var(--border));
  background: transparent;
  color: hsl(var(--foreground));
  outline: none;
}

.ms-list {
  list-style: none;
  margin: 0;
  padding: 0.25rem;
  max-height: 220px;
  overflow-y: auto;
}

.ms-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  text-align: left;
  padding: 0.45rem 0.55rem;
  border-radius: 0.4rem;
  background: transparent;
  color: hsl(var(--foreground));
  font-size: 0.88rem;
}

.ms-item:hover {
  background: hsl(var(--accent) / 0.6);
}

.ms-box {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 1.05rem;
  height: 1.05rem;
  border-radius: 0.3rem;
  border: 1.5px solid hsl(var(--border));
  color: hsl(var(--primary-foreground));
}

.ms-box.checked {
  background: hsl(var(--primary));
  border-color: hsl(var(--primary));
}

.ms-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms-empty {
  padding: 0.6rem;
  color: hsl(var(--muted-foreground));
  font-size: 0.85rem;
  text-align: center;
}

.ms-clear {
  display: block;
  width: 100%;
  padding: 0.5rem;
  border: none;
  border-top: 1px solid hsl(var(--border));
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}

.ms-clear:hover {
  background: hsl(var(--accent) / 0.5);
  color: hsl(var(--foreground));
}
</style>
