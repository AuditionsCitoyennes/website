<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

// A commune — never a street — picked from the official geocoder (the IGN's
// Géoplateforme, successor of the BAN, which tolerates typos: "villeurbane"
// finds Villeurbanne). Paris, Lyon and Marseille are split into
// arrondissements: picking the city as a whole asks for one of them.
//
// Only the INSEE code matters: the server resolves the rest itself.

export interface Commune {
  /** INSEE code of the commune or arrondissement. */
  code: string;
  /** "Villeurbanne (69)", "Lyon 7e Arrondissement (69)". */
  label: string;
}

interface Municipality {
  properties: {
    name: string;
    citycode: string;
    postcode?: string;
    context?: string;
  };
}

// The attributes given to the component (its aria-labelledby) belong on the
// control itself, not on the wrapper around it.
defineOptions({ inheritAttrs: false });

defineProps<{ modelValue: Commune | null; placeholder?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: Commune | null] }>();

const SPLIT: Record<string, { name: string; first: number; count: number; dep: string }> = {
  "75056": { name: "Paris", first: 75101, count: 20, dep: "75" },
  "69123": { name: "Lyon", first: 69381, count: 9, dep: "69" },
  "13055": { name: "Marseille", first: 13201, count: 16, dep: "13" },
};

const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const valueId = `commune-value-${Math.random().toString(36).slice(2, 8)}`;
const open = ref(false);
const search = ref("");
const results = ref<Municipality[]>([]);
const loading = ref(false);
/** Paris, Lyon or Marseille, picked as a whole: its arrondissements are listed. */
const splitCity = ref<string | null>(null);
let debounce: ReturnType<typeof setTimeout> | null = null;
let seq = 0; // drops out-of-order responses

watch(open, async (o) => {
  if (!o) {
    splitCity.value = null;
    return;
  }
  await nextTick();
  searchEl.value?.focus();
});

/** The département, to tell homonyms apart: Saint-Denis (93), Saint-Denis (974). */
function depOf(m: Municipality): string {
  return m.properties.context?.split(",")[0]?.trim() ?? "";
}

function labelOf(m: Municipality): string {
  const dep = depOf(m);
  return dep ? `${m.properties.name} (${dep})` : m.properties.name;
}

watch(search, (q) => {
  if (debounce) clearTimeout(debounce);
  splitCity.value = null;
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
        `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(query)}&type=municipality&autocomplete=1&limit=8`,
      );
      if (id !== seq) return;
      if (res.ok) {
        const data = (await res.json()) as { features?: Municipality[] };
        if (id !== seq) return;
        results.value = data.features ?? [];
      }
    } catch {
      /* the list just stays empty; typing again retries */
    } finally {
      if (id === seq) loading.value = false;
    }
  }, 250);
});

function pick(m: Municipality) {
  if (SPLIT[m.properties.citycode]) {
    splitCity.value = m.properties.citycode;
    // The keyboard goes on into the list of arrondissements.
    void nextTick(() => listEl.value?.querySelector<HTMLElement>(".combo-item")?.focus());
    return;
  }
  choose({ code: m.properties.citycode, label: labelOf(m) });
}

/** Enter in the search field picks its first result — never sends the form
 *  around it (the testimony would go with whatever commune was there). */
function onEnter() {
  if (loading.value || splitCity.value) return;
  const first = results.value[0];
  if (first) pick(first);
}

/** Back on the field, for the keyboard to carry on from there. */
function closePanel() {
  open.value = false;
  void nextTick(() => triggerEl.value?.focus());
}

function arrondissements(code: string): Commune[] {
  const city = SPLIT[code];
  return Array.from({ length: city.count }, (_, i) => ({
    code: String(city.first + i),
    label: `${city.name} ${i === 0 ? "1er" : `${i + 1}e`} Arrondissement (${city.dep})`,
  }));
}

function choose(c: Commune) {
  emit("update:modelValue", c);
  search.value = "";
  results.value = [];
  closePanel();
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
    <button
      ref="triggerEl"
      type="button"
      class="combo-trigger"
      :aria-expanded="open"
      aria-haspopup="listbox"
      v-bind="$attrs"
      :aria-describedby="valueId"
      @click="open = !open"
    >
      <span v-if="modelValue" :id="valueId" class="combo-value">{{ modelValue.label }}</span>
      <span v-else :id="valueId" class="combo-placeholder">{{
        placeholder ?? "Choisir votre commune..."
      }}</span>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        width="15"
        height="15"
        class="combo-chevron"
        aria-hidden="true"
      >
        <polyline points="7 15 12 20 17 15" />
        <polyline points="7 9 12 4 17 9" />
      </svg>
    </button>

    <div v-if="open" class="combo-panel">
      <input
        ref="searchEl"
        v-model="search"
        class="combo-search"
        placeholder="Nom de la commune..."
        aria-label="Rechercher une commune"
        autocomplete="off"
        @keydown.enter.prevent="onEnter"
        @keydown.esc.stop.prevent="closePanel"
      />
      <div ref="listEl" class="combo-list" role="listbox" @keydown.esc.stop.prevent="closePanel">
        <!-- Paris, Lyon, Marseille: which arrondissement. -->
        <template v-if="splitCity">
          <p class="combo-note">Choisissez votre arrondissement de {{ SPLIT[splitCity].name }} :</p>
          <button
            v-for="c in arrondissements(splitCity)"
            :key="c.code"
            type="button"
            role="option"
            class="combo-item"
            @click="choose(c)"
          >
            {{ c.label }}
          </button>
        </template>
        <div v-else-if="loading" class="combo-state">
          <span class="spinner" aria-label="Recherche"></span>
        </div>
        <p v-else-if="search.trim().length >= 2 && results.length === 0" class="combo-state">
          Aucune commune trouvée.
        </p>
        <p v-else-if="search.trim().length < 2" class="combo-state">
          Tapez le nom de votre commune.
        </p>
        <template v-else>
          <button
            v-for="m in results"
            :key="m.properties.citycode"
            type="button"
            role="option"
            class="combo-item"
            @click="pick(m)"
          >
            {{ labelOf(m) }}
            <span v-if="SPLIT[m.properties.citycode]" class="combo-hint">
              — choisir l'arrondissement
            </span>
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
  /* Looks like a field, so it reads like one. */
  font-size: var(--text-input);
  text-align: left;
}

.combo-trigger:focus-visible {
  outline: none;
  border-color: hsl(var(--ring));
  box-shadow: 0 0 0 3px hsl(var(--ring) / 0.2);
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

.combo-state,
.combo-note {
  display: flex;
  justify-content: center;
  padding: 1rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
}

/* A label for the arrondissement rows under it: a step smaller than they are. */
.combo-note {
  justify-content: flex-start;
  padding: 0.6rem 0.75rem 0.3rem;
  font-size: var(--text-caption);
}

.combo-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.55rem 0.75rem;
  background: transparent;
  border: none;
  color: hsl(var(--foreground));
  font-size: var(--text-ui);
  cursor: pointer;
}

.combo-item:hover,
.combo-item:focus-visible {
  background: hsl(var(--accent) / 0.6);
  outline: none;
}

.combo-hint {
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
}
</style>
