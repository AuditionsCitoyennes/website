<script setup lang="ts">
import { computed, ref, watch } from "vue";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import type { LocNode } from "@/shared/ui/select/treeNode";

const props = defineProps<{
  node: LocNode;
  selected: Set<string>;
  // True when an ancestor's area token is selected (this node is covered).
  ancestorSelected: boolean;
  searching: boolean;
  depth: number;
  toggle: (node: LocNode) => void;
  /** Asks for a lazy node's children (see LocNode.lazy). */
  loadChildren?: (node: LocNode) => void;
}>();

const open = ref(false);

const hasChildren = computed(() => (props.node.children?.length ?? 0) > 0);
// Its children are not known yet: opening it asks for them.
const lazy = computed(() => props.node.lazy);
const expandable = computed(() => hasChildren.value || lazy.value !== undefined);
const selfSelected = computed(() => props.selected.has(props.node.token));
const checked = computed(() => selfSelected.value || props.ancestorSelected);

function anyDescendantSelected(node: LocNode): boolean {
  return (node.children ?? []).some((c) => props.selected.has(c.token) || anyDescendantSelected(c));
}

// A partially-selected branch (some descendant chosen, but not this node/ancestor).
const indeterminate = computed(
  () => !checked.value && hasChildren.value && anyDescendantSelected(props.node),
);
// Covered by a selected ancestor → can't be individually unchecked here.
const disabled = computed(() => props.ancestorSelected && !selfSelected.value);
// While searching, branches stay expanded so matches deep in the tree are
// visible — not a lazy one: only opening it asks for its children.
const effectiveOpen = computed(() => (props.searching && !lazy.value) || open.value);

// Open and its children not known: asked for — at its opening, again when
// opened after they failed, and anew when a reloaded tree forgot them.
watch(
  () => (open.value ? (lazy.value ?? "known") : "closed"),
  (state, prev) => {
    if (state === "idle" || (state === "failed" && prev === "closed")) {
      props.loadChildren?.(props.node);
    }
  },
);

function onCheck() {
  if (!disabled.value) props.toggle(props.node);
}
</script>

<template>
  <div
    class="tn"
    role="treeitem"
    :aria-selected="checked"
    :aria-expanded="expandable ? effectiveOpen : undefined"
    :aria-busy="effectiveOpen && lazy === 'loading' ? 'true' : undefined"
  >
    <div class="tn-row" :style="{ paddingLeft: `${depth * 1.05}rem` }">
      <button
        v-if="expandable"
        type="button"
        class="tn-caret"
        :class="{ open: effectiveOpen }"
        :aria-label="`${effectiveOpen ? 'Réduire' : 'Développer'} ${node.label}`"
        :aria-expanded="effectiveOpen"
        @click="open = !open"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="14"
          height="14"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      <span v-else class="tn-caret-spacer" />

      <button
        type="button"
        class="tn-check"
        role="checkbox"
        :aria-checked="checked ? 'true' : indeterminate ? 'mixed' : 'false'"
        :aria-label="node.label"
        :disabled="disabled"
        :title="disabled ? 'Inclus via une zone parente déjà sélectionnée' : undefined"
        @click="onCheck"
      >
        <span class="tn-box" :class="{ checked, indeterminate }">
          <svg
            v-if="checked"
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
          <span v-else-if="indeterminate" class="tn-dash" />
        </span>
        <span class="tn-label">{{ node.label }}</span>
        <span v-if="node.hint" class="tn-hint">{{ node.hint }}</span>
        <span v-if="node.count != null" class="tn-count">{{ node.count }}</span>
      </button>
    </div>

    <div
      v-if="lazy && effectiveOpen"
      class="tn-pending"
      :style="{ paddingLeft: `${(depth + 1) * 1.05}rem` }"
    >
      <p v-if="lazy === 'failed'" class="tn-note">
        Impossible de charger ces lieux.
        <button type="button" class="tn-retry" @click="loadChildren?.(node)">Réessayer</button>
      </p>
      <LoadingDots v-else class="tn-dots" label="Chargement des lieux…" />
    </div>
    <div v-else-if="hasChildren && effectiveOpen" class="tn-children" role="group">
      <LocationTreeNode
        v-for="c in node.children"
        :key="c.token"
        :node="c"
        :selected="selected"
        :ancestor-selected="checked"
        :searching="searching"
        :depth="depth + 1"
        :toggle="toggle"
        :load-children="loadChildren"
      />
    </div>
  </div>
</template>

<style scoped>
.tn-row {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  border-radius: 0.4rem;
}

.tn-row:hover {
  background: hsl(var(--accent) / 0.5);
}

.tn-caret {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 1.4rem;
  height: 1.7rem;
  background: transparent;
  border: none;
  color: hsl(var(--muted-foreground));
  cursor: pointer;
  transition: transform 0.18s ease;
}

.tn-caret.open {
  transform: rotate(90deg);
}

.tn-caret-spacer {
  flex-shrink: 0;
  width: 1.4rem;
}

.tn-check {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex: 1;
  min-width: 0;
  padding: 0.4rem 0.4rem;
  background: transparent;
  border: none;
  text-align: left;
  color: hsl(var(--foreground));
  font-size: var(--text-ui);
  cursor: pointer;
}

.tn-check:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.tn-box {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 1.05rem;
  height: 1.05rem;
  border-radius: 0.3rem;
  border: 1.5px solid hsl(var(--border));
  color: hsl(var(--primary-foreground));
}

.tn-box.checked,
.tn-box.indeterminate {
  background: hsl(var(--primary));
  border-color: hsl(var(--primary));
}

.tn-dash {
  width: 0.55rem;
  height: 2px;
  border-radius: 1px;
  background: hsl(var(--primary-foreground));
}

.tn-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tn-hint {
  flex-shrink: 0;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  font-variant-numeric: tabular-nums;
}

.tn-dots {
  justify-content: flex-start;
  padding: 0.45rem 0 0.45rem 1.95rem;
}

.tn-note {
  margin: 0;
  padding: 0.35rem 0.4rem 0.45rem 1.95rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
}

.tn-retry {
  padding: 0;
  border: none;
  background: transparent;
  color: hsl(var(--primary));
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}

.tn-count {
  flex-shrink: 0;
  margin-left: auto;
  min-width: 1.4rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: hsl(var(--secondary));
  color: hsl(var(--secondary-foreground));
  font-size: var(--text-caption);
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
