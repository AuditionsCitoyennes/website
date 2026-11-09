<script setup lang="ts">
// Breadcrumb: where the map is; click a crumb to fly back out. One line only
// — leading crumbs collapse into "…" when room runs out, and the "…" flies
// back to the deepest ancestor it wraps. With a lieu open the trail stays and
// ends at the lieu itself; an arrow before it goes one level up (backTarget.ts).
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { GeoUnit } from "@/features/geo";
import { backTarget } from "./backTarget";

const props = defineProps<{
  /** The trail, root first, ending at the scope or at the open lieu. */
  trail: GeoUnit[];
}>();

const emit = defineEmits<{
  /** A crumb (or the "…") clicked: fly back to that unit. */
  go: [id: string];
}>();

// ---- Breadcrumb overflow: the trail must stay ONE line. When there's no room
// left, the LEADING crumbs collapse into a single "…" (Monde › France › … ›
// Lyon › Lyon 3ᵉ) and clicking the "…" flies back to the deepest hidden
// ancestor. `crumbsCollapsed` = how many leading crumbs are wrapped in it;
// fitCrumbs re-measures from zero (collapse one at a time until the row fits,
// the current unit always stays visible) on every trail change and resize. ----
const crumbsEl = ref<HTMLElement | null>(null);
const crumbsCollapsed = ref(0);
let crumbsFitSeq = 0; // a newer fit run supersedes an in-flight one (awaits nextTick)
async function fitCrumbs() {
  const seq = ++crumbsFitSeq;
  crumbsCollapsed.value = 0;
  await nextTick();
  while (
    seq === crumbsFitSeq &&
    crumbsEl.value &&
    crumbsEl.value.scrollWidth > crumbsEl.value.clientWidth + 1 &&
    crumbsCollapsed.value < props.trail.length - 1
  ) {
    crumbsCollapsed.value++;
    await nextTick();
  }
}
watch(
  () => props.trail,
  () => void fitCrumbs(),
  { flush: "post" },
);
// The nav mounts/unmounts with the place detail (v-if) and the panel width can
// change with the viewport — re-fit on both (observe() fires once immediately).
let crumbsRO: ResizeObserver | null = null;
watch(crumbsEl, (el) => {
  crumbsRO?.disconnect();
  crumbsRO = null;
  if (el && typeof ResizeObserver !== "undefined") {
    crumbsRO = new ResizeObserver(() => void fitCrumbs());
    crumbsRO.observe(el);
  }
});
onBeforeUnmount(() => crumbsRO?.disconnect());
const visibleCrumbs = computed(() => props.trail.slice(crumbsCollapsed.value));
/** The deepest ancestor wrapped in the "…" — where its click flies back to. */
const crumbsHidden = computed(() =>
  crumbsCollapsed.value > 0 ? props.trail[crumbsCollapsed.value - 1] : undefined,
);

// ---- The back arrow: one level up, through the same `go` as a crumb click;
// none at the root. Pressed into the root it goes away with its focus: the
// focus moves to the root's crumb, not to the page. ----
const backEl = ref<HTMLButtonElement | null>(null);
const back = computed(() => backTarget(props.trail));
function goBack() {
  const to = back.value;
  if (!to) return;
  const focused = document.activeElement === backEl.value;
  emit("go", to.id);
  if (focused && props.trail[0] === to) {
    void nextTick(() => crumbsEl.value?.querySelector<HTMLElement>(".crumb.current")?.focus());
  }
}
</script>

<template>
  <nav ref="crumbsEl" class="crumbs" aria-label="Fil d'Ariane">
    <button
      v-if="back"
      ref="backEl"
      type="button"
      class="crumb crumb-back"
      :aria-label="`Niveau précédent : ${back.label}`"
      :title="`Niveau précédent : ${back.label}`"
      @click="goBack"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        width="16"
        height="16"
        aria-hidden="true"
      >
        <polyline points="15 6 9 12 15 18" />
      </svg>
    </button>
    <template v-if="crumbsHidden">
      <button
        type="button"
        class="crumb crumb-more"
        :title="crumbsHidden.label"
        :aria-label="`Revenir à ${crumbsHidden.label}`"
        @click="emit('go', crumbsHidden.id)"
      >
        …
      </button>
      <span class="crumb-sep" aria-hidden="true">›</span>
    </template>
    <template v-for="(c, i) in visibleCrumbs" :key="c.id">
      <button
        type="button"
        class="crumb"
        :class="{ current: i === visibleCrumbs.length - 1 }"
        @click="emit('go', c.id)"
      >
        {{ c.label }}
      </button>
      <span v-if="i < visibleCrumbs.length - 1" class="crumb-sep" aria-hidden="true">›</span>
    </template>
  </nav>
</template>

<style scoped>
.crumbs {
  margin-top: 0.7rem;
  display: flex;
  /* ONE line: no wrap — when room runs out the leading crumbs collapse into
     "…" (measured against scrollWidth, so nothing here may flex-shrink). */
  flex-wrap: nowrap;
  overflow: hidden;
  align-items: center;
  gap: 0.15rem 0.3rem;
  /* On the row, not the crumbs: the "›" between them is the same size. */
  font-size: var(--text-ui);
  /* As tall with the back arrow as without it (none at the root). */
  min-height: 1.5rem;
}

.crumb {
  border: none;
  background: transparent;
  padding: 0.1rem 0.25rem;
  border-radius: 0.3rem;
  color: hsl(var(--muted-foreground));
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
}

/* A single over-long crumb (deep lieu names) caps at the row and ellipsizes. */
.crumb.current {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crumb:hover {
  background: hsl(var(--accent) / 0.5);
  color: hsl(var(--foreground));
}

.crumb.current {
  color: hsl(var(--primary));
}

.crumb-sep {
  color: hsl(var(--muted-foreground) / 0.6);
  flex: none;
}

/* After `.crumb` (same specificity): a 24 px target, its colours and hover
   the crumbs'. The ring is inset: the row clips what is drawn outside it. */
.crumb-back {
  display: inline-grid;
  place-items: center;
  min-width: 1.5rem;
  min-height: 1.5rem;
  padding: 0;
}

.crumb-back:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: -2px;
}
</style>
