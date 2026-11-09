<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { normalizeLocation, type BanPick } from "@ac/shared";
import { banSearchUrl, isPickType, preciseSuggestions, typedCommune } from "./banSuggestions";

// Location autocomplete backed by the Base Adresse Nationale (the official
// French geocoder — replaces the old app's Nominatim, which rate-limits).
// Besides the label, a pick hands over where BAN puts it (its commune's
// INSEE code and its point): the audition is placed there. Only precise
// results are offered (banSuggestions.ts): never a whole commune.

interface BanFeature {
  geometry?: { coordinates?: [number, number] };
  properties: {
    id: string;
    label: string;
    name?: string;
    city?: string;
    postcode?: string;
    municipality?: string;
    citycode?: string;
    type?: string;
  };
}

/** The picked suggestion: its label (the location) and where BAN puts it. */
export type LocationPick = Omit<BanPick, "kind"> & { label: string };

defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  pick: [value: LocationPick];
}>();

const hintId = useId();
const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const open = ref(false);
const search = ref("");
const results = ref<BanFeature[]>([]);
const commune = ref<string | null>(null); // the commune typed, not offered
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
  return p.label
    .split(",")
    .slice(0, 2)
    .map((s) => s.trim())
    .join(", ");
}

watch(search, (q) => {
  if (debounce) clearTimeout(debounce);
  const query = q.trim();
  if (query.length < 2) {
    seq++;
    results.value = [];
    commune.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  debounce = setTimeout(async () => {
    const id = ++seq;
    try {
      const res = await fetch(banSearchUrl(query));
      if (id !== seq) return; // a newer query superseded this one
      if (res.ok) {
        const data = (await res.json()) as { features?: BanFeature[] };
        if (id !== seq) return;
        results.value = preciseSuggestions(data.features ?? []);
        commune.value = typedCommune(data.features ?? []);
      }
    } catch {
      /* silently ignore network errors */
    } finally {
      if (id === seq) loading.value = false;
    }
  }, 300);
});

function select(f: BanFeature) {
  const label = normalizeLocation(shortLabel(f));
  emit("update:modelValue", label);
  const [lng, lat] = f.geometry?.coordinates ?? [];
  const { citycode, type } = f.properties;
  if (citycode && typeof lat === "number" && typeof lng === "number" && isPickType(type)) {
    emit("pick", { label, citycode, lat, lng, type });
  }
  search.value = "";
  results.value = [];
  commune.value = null;
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
    <div class="combo-anchor">
      <button type="button" class="combo-trigger" :aria-describedby="hintId" @click="open = !open">
        <span v-if="modelValue" class="combo-value">{{ modelValue }}</span>
        <span v-else class="combo-placeholder">{{ placeholder ?? "Rechercher un lieu..." }}</span>
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
          placeholder="Rue, place ou lieu-dit, puis la ville..."
          :aria-describedby="hintId"
        />
        <div class="combo-list">
          <div v-if="loading" class="combo-state">
            <span class="spinner" aria-label="Recherche"></span>
          </div>
          <template v-else>
            <p v-if="commune" class="combo-state" role="status">
              «&nbsp;{{ commune }}&nbsp;» est une commune&nbsp;: ajoutez le nom de la rue ou de la
              place.
            </p>
            <p
              v-else-if="search.trim().length >= 2 && results.length === 0"
              class="combo-state"
              role="status"
            >
              Aucune adresse précise trouvée&nbsp;: ajoutez la rue ou la place.
            </p>
            <button
              v-for="f in results"
              :key="f.properties.id"
              type="button"
              class="combo-item"
              @click="select(f)"
            >
              {{ shortLabel(f) }}
              <span v-if="f.properties.postcode" class="combo-postcode">{{
                f.properties.postcode
              }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
    <p :id="hintId" class="combo-hint">
      Choisissez une adresse précise (rue, place, lieu-dit) dans la liste.
    </p>
  </div>
</template>

<style scoped>
.combo {
  position: relative;
}

/* The panel opens under the trigger, not under the hint. */
.combo-anchor {
  position: relative;
}

.combo-hint {
  margin-top: 0.35rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
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
  font-size: var(--text-input);
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
  font-size: var(--text-ui);
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

/* Tells same-named places apart ("Bron, Tourch" is in Finistère). */
.combo-postcode {
  margin-left: 0.35rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
}

.combo-item:hover {
  background: hsl(var(--accent) / 0.6);
}
</style>
