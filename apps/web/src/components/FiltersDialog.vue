<script setup lang="ts">
import { computed } from "vue";
import ModalDialog from "@/components/ModalDialog.vue";
import ThemeMultiSelect from "@/components/ThemeMultiSelect.vue";
import LocationMultiSelect from "@/components/LocationMultiSelect.vue";
import type { LocNode } from "@/components/LocationTreeNode.vue";
import FilterChips from "@/components/FilterChips.vue";

interface Option {
  value: string;
  label: string;
  hint?: string;
}

withDefaults(
  defineProps<{
    open: boolean;
    chips: { id: string; label: string }[];
    locationTree: LocNode[];
    /** Earliest/latest audition date in the data — bounds the picker. */
    dateBounds: { min: string | null; max: string | null };
    topicOptions: Option[];
    /** null: not known yet (what it depends on is still loading). */
    resultCount: number | null;
    /** What is being filtered — the same filters serve more than one list. */
    description?: string;
    searchPlaceholder?: string;
    /** What the results are, in the singular ("résultat", "audition"). */
    resultNoun?: string;
  }>(),
  {
    description: "Affinez la liste des témoignages",
    searchPlaceholder: "Mot ou phrase à rechercher dans les témoignages...",
    resultNoun: "résultat",
  },
);

const emit = defineEmits<{
  close: [];
  remove: [id: string];
  reset: [];
}>();

// Two-way filter values (the page owns the source refs).
const locations = defineModel<string[]>("locations", { default: () => [] });
const dateFrom = defineModel<string | null>("dateFrom", { default: null });
const dateTo = defineModel<string | null>("dateTo", { default: null });
const topics = defineModel<string[]>("topics", { default: () => [] });
const sort = defineModel<"recent" | "ancien">("sort", { default: "recent" });
const text = defineModel<string>("text", { default: "" });
const verified = defineModel<boolean>("verified", { default: false });

// `<input type="date">` speaks "" for empty and YYYY-MM-DD otherwise — exactly
// the format the filter already compares on, so no parsing either way. These
// only bridge "" ↔ null so an emptied field clears the filter.
const dateFromInput = computed({
  get: () => dateFrom.value ?? "",
  set: (v: string) => (dateFrom.value = v || null),
});
const dateToInput = computed({
  get: () => dateTo.value ?? "",
  set: (v: string) => (dateTo.value = v || null),
});
</script>

<template>
  <ModalDialog
    :open="open"
    title="Filtres"
    :description="description"
    dismissible
    medium
    @close="emit('close')"
  >
    <div class="filters-form">
      <FilterChips
        v-if="chips.length"
        :chips="chips"
        class="dialog-chips"
        @remove="emit('remove', $event)"
      />

      <div class="field-row">
        <label id="filters-verified-label">Témoignages vérifiés uniquement</label>
        <button
          type="button"
          class="switch"
          :class="{ on: verified }"
          role="switch"
          :aria-checked="verified"
          aria-labelledby="filters-verified-label"
          @click="verified = !verified"
        >
          <span class="switch-thumb" />
        </button>
      </div>

      <div class="field">
        <label>Lieu</label>
        <LocationMultiSelect
          v-model="locations"
          :tree="locationTree"
          all-label="Tous les lieux"
          placeholder="Rechercher un lieu, un département, une région..."
        />
      </div>

      <div class="field">
        <label id="filters-date-label">Date</label>
        <div class="date-range" role="group" aria-labelledby="filters-date-label">
          <div class="date-field">
            <input
              v-model="dateFromInput"
              type="date"
              class="form-input date-input"
              aria-label="Date de début"
              :min="dateBounds.min ?? undefined"
              :max="dateTo ?? dateBounds.max ?? undefined"
            />
            <button
              v-if="dateFrom"
              type="button"
              class="date-clear"
              aria-label="Effacer la date de début"
              @click="dateFrom = null"
            >
              ×
            </button>
          </div>
          <span class="arrow" aria-hidden="true">→</span>
          <div class="date-field">
            <input
              v-model="dateToInput"
              type="date"
              class="form-input date-input"
              aria-label="Date de fin"
              :min="dateFrom ?? dateBounds.min ?? undefined"
              :max="dateBounds.max ?? undefined"
            />
            <button
              v-if="dateTo"
              type="button"
              class="date-clear"
              aria-label="Effacer la date de fin"
              @click="dateTo = null"
            >
              ×
            </button>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Thèmes</label>
        <ThemeMultiSelect
          v-model="topics"
          :options="topicOptions"
          all-label="Tous les thèmes"
          placeholder="Rechercher un thème..."
        />
      </div>

      <div class="field">
        <label for="filters-sort">Tri</label>
        <select id="filters-sort" v-model="sort" class="sort-select">
          <option value="recent">Plus récents d'abord</option>
          <option value="ancien">Plus anciens d'abord</option>
        </select>
      </div>

      <div class="field">
        <label for="filters-text">Recherche</label>
        <input
          id="filters-text"
          v-model="text"
          class="form-input"
          type="search"
          :placeholder="searchPlaceholder"
        />
      </div>

      <div class="dialog-actions">
        <button
          type="button"
          class="ac-btn ac-btn--ghost"
          :disabled="chips.length === 0"
          @click="emit('reset')"
        >
          Réinitialiser
        </button>
        <button type="button" class="ac-btn ac-btn--primary" @click="emit('close')">
          <template v-if="resultCount === null">Chargement…</template>
          <template v-else>
            Voir {{ resultCount }} {{ resultNoun }}{{ resultCount > 1 ? "s" : "" }}
          </template>
        </button>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.filters-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.dialog-chips {
  padding-bottom: 0.4rem;
  border-bottom: 1px solid hsl(var(--border) / 0.6);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.field > label {
  font-size: var(--text-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: hsl(var(--muted-foreground));
}

/* On/off row (label left, switch right). */
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.field-row > label {
  font-size: var(--text-ui);
  font-weight: 500;
  color: hsl(var(--foreground));
}

.switch {
  flex-shrink: 0;
  position: relative;
  width: 2.6rem;
  height: 1.5rem;
  padding: 0;
  border-radius: 999px;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--muted));
  cursor: pointer;
  transition: var(--transition-smooth);
}

.switch.on {
  background: hsl(var(--primary));
  border-color: hsl(var(--primary));
}

.switch-thumb {
  position: absolute;
  top: 50%;
  left: 0.18rem;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: hsl(var(--background));
  transform: translateY(-50%);
  transition: left 0.2s ease;
}

.switch.on .switch-thumb {
  left: calc(100% - 1.1rem - 0.18rem);
  background: hsl(var(--primary-foreground));
}

.date-range {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.5rem;
}

.date-field {
  position: relative;
  min-width: 0;
}

.date-input {
  width: 100%;
  height: 2.7rem;
  /* Room for the clear button, which overlays the field's right edge. */
  padding-right: 2rem;
}

/* The native indicator sits at the right edge of the control; nudge it clear of
   the clear button so the two are not stacked on top of each other. */
.date-input::-webkit-calendar-picker-indicator {
  margin-right: 1.1rem;
  cursor: pointer;
}

.date-clear {
  position: absolute;
  top: 50%;
  right: 0.45rem;
  transform: translateY(-50%);
  width: 1.25rem;
  height: 1.25rem;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
  line-height: 1;
  cursor: pointer;
}

.date-clear:hover {
  background: hsl(var(--accent));
  color: hsl(var(--foreground));
}

.arrow {
  color: hsl(var(--muted-foreground));
}

.sort-select {
  width: 100%;
  height: 2.7rem;
  padding: 0 0.75rem;
  border-radius: 0.5rem;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  font-size: var(--text-input);
}

.dialog-actions {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
  margin-top: 0.4rem;
  padding-top: 0.9rem;
  border-top: 1px solid hsl(var(--border) / 0.6);
}
</style>
