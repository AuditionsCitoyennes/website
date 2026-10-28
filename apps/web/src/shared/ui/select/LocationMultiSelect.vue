<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import LocationTreeNode from "@/shared/ui/select/LocationTreeNode.vue";
import type { LocNode } from "@/shared/ui/select/treeNode";

const props = defineProps<{
  modelValue: string[];
  tree: LocNode[];
  allLabel: string;
  placeholder?: string;
  /** Asks for a lazy node's children, when it is opened (a tree read as it
   *  is opened: see LocNode.lazy). */
  loadChildren?: (node: LocNode) => void;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const root = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const search = ref("");

// Reset to a clean state when the panel closes; focus the search on open.
watch(open, (isOpen) => {
  if (isOpen) nextTick(() => searchInput.value?.focus());
  else search.value = "";
});

const triggerLabel = computed(() => {
  const n = props.modelValue.length;
  if (n === 0) return props.allLabel;
  return `${n} lieu${n > 1 ? "x" : ""} sélectionné${n > 1 ? "s" : ""}`;
});

const selectedSet = computed(() => new Set(props.modelValue));
const searching = computed(() => search.value.trim().length > 0);

function matchNode(n: LocNode, q: string): boolean {
  return n.label.toLowerCase().includes(q) || (n.hint?.toLowerCase().includes(q) ?? false);
}

// Keep a node when it matches (with its full subtree, so descendants stay
// pickable) or when any descendant matches (with the subtree pruned to matches).
function filterTree(nodes: LocNode[], q: string): LocNode[] {
  const out: LocNode[] = [];
  for (const n of nodes) {
    if (matchNode(n, q)) {
      out.push(n);
    } else {
      const kids = n.children ? filterTree(n.children, q) : [];
      if (kids.length) out.push({ ...n, children: kids });
    }
  }
  return out;
}

// Some node's children are not known yet: a search sees only what is.
const incomplete = computed(() => {
  const some = (nodes: LocNode[]): boolean =>
    nodes.some((n) => n.lazy !== undefined || (n.children ? some(n.children) : false));
  return some(props.tree);
});
// Shown while searching, in a live region there as long as the tree is
// incomplete: announced as it appears, the search field already focused.
const searchNote = computed(() => searching.value && incomplete.value);

const visibleTree = computed(() =>
  searching.value ? filterTree(props.tree, search.value.trim().toLowerCase()) : props.tree,
);

// Ancestor + descendant token sets for every node, computed once from the FULL
// tree (not the search-filtered view) so toggling stays correct regardless of
// the current search. The selection is kept an "antichain": no selected token
// is nested inside another, which is exactly right for OR-matching.
const relations = computed(() => {
  const ancestors = new Map<string, string[]>();
  const descendants = new Map<string, string[]>();
  const walk = (node: LocNode, anc: string[]): string[] => {
    ancestors.set(node.token, anc);
    const childAnc = [...anc, node.token];
    const desc: string[] = [];
    for (const c of node.children ?? []) {
      desc.push(c.token, ...walk(c, childAnc));
    }
    descendants.set(node.token, desc);
    return desc;
  };
  for (const r of props.tree) walk(r, []);
  return { ancestors, descendants };
});

// Toggle a node's area token. Selecting an area drops any selected ancestor it
// supersedes and any descendant it subsumes.
function toggle(node: LocNode) {
  const set = new Set(props.modelValue);
  if (set.has(node.token)) {
    set.delete(node.token);
  } else {
    const { ancestors, descendants } = relations.value;
    for (const t of ancestors.get(node.token) ?? []) set.delete(t);
    for (const t of descendants.get(node.token) ?? []) set.delete(t);
    set.add(node.token);
  }
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
    <button
      type="button"
      class="ms-trigger"
      :aria-expanded="open"
      aria-controls="location-ms-panel"
      @click="open = !open"
    >
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

    <div v-if="open" id="location-ms-panel" class="ms-panel">
      <input
        ref="searchInput"
        v-model="search"
        class="ms-search"
        type="search"
        aria-label="Rechercher un lieu"
        :aria-describedby="searchNote ? 'location-ms-note' : undefined"
        :placeholder="placeholder ?? 'Rechercher un lieu, un département, une région...'"
      />
      <div v-if="incomplete" role="status">
        <p v-if="searchNote" id="location-ms-note" class="ms-note">
          La recherche ne voit que les zones déjà dépliées : effacez-la et dépliez-en une pour
          chercher parmi ses lieux.
        </p>
      </div>
      <div class="ms-tree" role="tree" aria-label="Lieux">
        <LocationTreeNode
          v-for="n in visibleTree"
          :key="n.token"
          :node="n"
          :selected="selectedSet"
          :ancestor-selected="false"
          :searching="searching"
          :depth="0"
          :toggle="toggle"
          :load-children="loadChildren"
        />
        <p v-if="visibleTree.length === 0" class="ms-empty">
          {{ searchNote ? "Aucun résultat dans les zones dépliées" : "Aucun résultat" }}
        </p>
      </div>
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
  font-size: var(--text-input);
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

.ms-note {
  margin: 0;
  padding: 0.45rem 0.75rem;
  border-bottom: 1px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-caption);
}

.ms-tree {
  padding: 0.3rem;
  max-height: 300px;
  overflow-y: auto;
}

.ms-empty {
  padding: 0.6rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
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
  font-size: var(--text-ui);
  font-weight: 500;
  cursor: pointer;
}

.ms-clear:hover {
  background: hsl(var(--accent) / 0.5);
  color: hsl(var(--foreground));
}
</style>
