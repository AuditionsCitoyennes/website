<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { normalizeLocation } from "@ac/shared";

// Location autocomplete backed by the Base Adresse Nationale (the official
// French geocoder — replaces the old app's Nominatim, which rate-limits).

interface BanFeature {
  properties: {
    id: string;
    label: string;
    name?: string;
    city?: string;
    municipality?: string;
  };
}

defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const open = ref(false);
const search = ref("");
const results = ref<BanFeature[]>([]);
const loading = ref(false);
let debounce: ReturnType<typeof setTimeout> | null = null;
let seq = 0; // drops out-of-order BAN responses

// The HTML autofocus attribute is inert on dynamically inserted elements —
// focus explicitly when the panel opens.
watch(open, async (o) => {
  if (o) {
    await nextTick();
    searchEl.value?.focus();
  }
});

function shortLabel(f: BanFeature): string {
  const p = f.properties;
  const city = p.city || p.municipality || "";
  const place = p.name || "";
  if (place && city && place !== city) return `${place}, ${city}`;
  if (city) return city;
  if (place) return place;
  return p.label.split(",").slice(0, 2).map((s) => s.trim()).join(", ");
}

watch(search, (q) => {
  if (debounce) clearTimeout(debounce);
  const query = q.trim();
  if (query.length < 2) {
    seq++;
    results.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  debounce = setTimeout(async () => {
    const id = ++seq;
    try {
      const res = await fetch(
        `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=5`,
      );
      if (id !== seq) return; // a newer query superseded this one
      if (res.ok) {
        const data = (await res.json()) as { features?: BanFeature[] };
        if (id !== seq) return;
        results.value = data.features ?? [];
      }
    } catch {
      /* silently ignore network errors */
    } finally {
      if (id === seq) loading.value = false;
    }
  }, 300);
});

function select(f: BanFeature) {
  emit("update:modelValue", normalizeLocation(shortLabel(f)));
  search.value = "";
  results.value = [];
  open.value = false;
}

function onDocMouseDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocMouseDown);
  if (debounce) clearTimeout(debounce);
});
</script>

<template>
  <div ref="root" class="combo">
    <button type="button" class="combo-trigger" @click="open = !open">
      <span v-if="modelValue" class="combo-value">{{ modelValue }}</span>
      <span v-else class="combo-placeholder">{{ placeholder ?? "Rechercher un lieu..." }}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" width="15" height="15" class="combo-chevron">
        <polyline points="7 15 12 20 17 15" />
        <polyline points="7 9 12 4 17 9" />
      </svg>
    </button>

    <div v-if="open" class="combo-panel">
      <input
        ref="searchEl"
        v-model="search"
        class="combo-search"
        placeholder="Rechercher une adresse..."
      />
      <div class="combo-list">
        <div v-if="loading" class="combo-state">
          <span class="spinner" aria-label="Recherche"></span>
        </div>
        <p v-else-if="search.trim().length >= 2 && results.length === 0" class="combo-state">
          Aucun résultat trouvé.
        </p>
        <template v-else>
          <button
            v-for="f in results"
            :key="f.properties.id"
            type="button"
            class="combo-item"
            @click="select(f)"
          >
            {{ shortLabel(f) }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.combo {
  position: relative;
}

.combo-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  height: 3rem;
  padding: 0 0.85rem;
  border-radius: 0.6rem;
  border: 1px solid hsl(var(--input));
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  font-size: 0.95rem;
  text-align: left;
}

.combo-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.combo-placeholder {
  color: hsl(var(--muted-foreground) / 0.7);
}

.combo-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}

.combo-panel {
  position: absolute;
  z-index: 45;
  top: calc(100% + 0.35rem);
  left: 0;
  right: 0;
  background: hsl(var(--popover));
  border: 1px solid hsl(var(--border));
  border-radius: 0.6rem;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.combo-search {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: none;
  border-bottom: 1px solid hsl(var(--border));
  background: transparent;
  color: hsl(var(--foreground));
  outline: none;
}

.combo-list {
  max-height: 15rem;
  overflow-y: auto;
}

.combo-state {
  display: flex;
  justify-content: center;
  padding: 1rem;
  color: hsl(var(--muted-foreground));
  font-size: 0.85rem;
}

.combo-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.55rem 0.75rem;
  background: transparent;
  border: none;
  color: hsl(var(--foreground));
  font-size: 0.9rem;
  cursor: pointer;
}

.combo-item:hover {
  background: hsl(var(--accent) / 0.6);
}
</style>
