<script lang="ts">
// Type exports live in a plain <script> block — `<script setup>` can't export.
import type { PublicTestimony } from "@ac/shared";

/** An audition with the testimonies that matched the current filters. */
export interface AuditionGroupLite {
  id: string;
  title: string;
  date: string | null;
  testimonies: PublicTestimony[];
}

/** A node in the location hierarchy (country → … → lieu). */
export interface ResultNode {
  level: "country" | "region" | "dep" | "city" | "arr" | "place";
  key: string;
  label: string;
  /** Merged "A › B › C" label for single-child chains (compact mode only). */
  breadcrumb?: string;
  testimonies: number;
  auditionCount: number;
  date: string | null;
  children: ResultNode[];
  /** Only populated on `place` leaves. */
  auditions: AuditionGroupLite[];
}

/** Shared state + callbacks threaded down the tree (defined once at the root). */
export interface TreeCtx {
  isExpanded: (key: string) => boolean;
  toggleNode: (key: string, e: MouseEvent) => void;
  isAuditionOpen: (id: string) => boolean;
  toggleAudition: (id: string, placeKey: string, e: MouseEvent) => void;
  formatDate: (d: string) => string;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import TestimonyCard from "@/components/TestimonyCard.vue";
import ExpandTransition from "@/components/ExpandTransition.vue";
// Self-import for recursion (each structural level renders its children).
import ResultTreeNode from "@/components/ResultTreeNode.vue";

const props = defineProps<{
  node: ResultNode;
  mode: "flatten" | "expand" | "collapse";
  depth: number;
  ctx: TreeCtx;
  highlight: string;
}>();

const headerLabel = computed(() => props.node.breadcrumb ?? props.node.label);
const isPlace = computed(() => props.node.level === "place");

// Structural levels are always open in flatten/expand; a click-toggle in collapse.
const collapsible = computed(() => props.mode === "collapse");
const open = computed(() => (collapsible.value ? props.ctx.isExpanded(props.node.key) : true));

// Indentation grows with depth; flatten mode compresses depth at single-child
// chains so it stays shallow. Capped so deep trees never push content off-screen.
const indent = computed(() => `${Math.min(props.depth, 6) * 0.5}rem`);
</script>

<template>
  <!-- ── Leaf: a precise lieu with its audition accordion ───────────────── -->
  <div v-if="isPlace" class="rt-place" :style="{ '--rt-indent': indent }">
    <component
      :is="collapsible ? 'button' : 'div'"
      class="rt-head rt-place-head"
      :class="{ 'rt-toggle': collapsible, open }"
      :type="collapsible ? 'button' : undefined"
      :aria-expanded="collapsible ? open : undefined"
      @click="collapsible && ctx.toggleNode(node.key, $event)"
    >
      <svg
        v-if="collapsible"
        class="rt-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        width="16"
        height="16"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <h2 class="rt-place-title">{{ headerLabel }}</h2>
      <span class="rt-count">
        {{ node.testimonies
        }}<span class="rt-count-word"> témoignage{{ node.testimonies > 1 ? "s" : "" }}</span>
      </span>
    </component>

    <ExpandTransition>
      <div v-if="open" class="rt-auditions">
        <div v-for="g in node.auditions" :key="g.id" class="aud-group">
          <button
            type="button"
            class="aud-header"
            :class="{ open: ctx.isAuditionOpen(g.id) }"
            :aria-expanded="ctx.isAuditionOpen(g.id)"
            @click="ctx.toggleAudition(g.id, node.key, $event)"
          >
            <div class="aud-info">
              <h3 class="aud-title">{{ g.title }}</h3>
              <p v-if="g.date" class="aud-meta">
                <span class="aud-date">{{ ctx.formatDate(g.date) }}</span>
              </p>
            </div>
            <span class="aud-count">
              {{ g.testimonies.length
              }}<span class="count-word"> témoignage{{ g.testimonies.length > 1 ? "s" : "" }}</span>
            </span>
            <svg
              class="aud-chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="18"
              height="18"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          <ExpandTransition>
            <div v-if="ctx.isAuditionOpen(g.id)" class="aud-body">
              <TestimonyCard
                v-for="t in g.testimonies"
                :key="t.id"
                :testimony="t"
                :highlight="highlight"
                hide-audition
              />
            </div>
          </ExpandTransition>
        </div>
      </div>
    </ExpandTransition>
  </div>

  <!-- ── Structural level: country / région / département / ville / arr ──── -->
  <section v-else class="rt-node">
    <component
      :is="collapsible ? 'button' : 'div'"
      class="rt-head"
      :class="[`rt-head--${node.level}`, { 'rt-toggle': collapsible, open }]"
      :style="{ '--rt-indent': indent }"
      :type="collapsible ? 'button' : undefined"
      :aria-expanded="collapsible ? open : undefined"
      @click="collapsible && ctx.toggleNode(node.key, $event)"
    >
      <svg
        v-if="collapsible"
        class="rt-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        width="16"
        height="16"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span class="rt-label">{{ headerLabel }}</span>
      <span class="rt-count"> {{ node.testimonies }}<span class="rt-count-word"> tém.</span> </span>
    </component>

    <ExpandTransition>
      <div v-if="open" class="rt-children">
        <ResultTreeNode
          v-for="child in node.children"
          :key="child.key"
          :node="child"
          :mode="mode"
          :depth="depth + 1"
          :ctx="ctx"
          :highlight="highlight"
        />
      </div>
    </ExpandTransition>
  </section>
</template>

<style scoped>
/* ── Structural headers (country → arrondissement) ───────────────────────── */
.rt-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.32rem 0.5rem 0.32rem calc(0.5rem + var(--rt-indent, 0rem));
  text-align: left;
  background: transparent;
  border: none;
  font: inherit;
}

.rt-toggle {
  border-radius: 0.45rem;
  cursor: pointer;
  transition: background 0.2s ease;
}

.rt-toggle:hover {
  background: hsl(var(--accent) / 0.4);
}

.rt-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
  transition: transform 0.28s ease;
}

.rt-toggle.open > .rt-chevron {
  transform: rotate(180deg);
}

.rt-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: hsl(var(--foreground));
}

/* Typographic hierarchy: upper levels are quieter, the ville is the anchor. */
.rt-head--country .rt-label,
.rt-head--region .rt-label {
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
}

.rt-head--dep .rt-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
}

.rt-head--city .rt-label {
  font-size: clamp(0.9rem, 0.74rem + 0.7vw, 1.02rem);
  font-weight: 700;
  color: hsl(var(--primary));
}

.rt-head--arr .rt-label {
  font-size: clamp(0.82rem, 0.7rem + 0.5vw, 0.9rem);
  font-weight: 600;
  color: hsl(var(--foreground) / 0.85);
}

.rt-count {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 500;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}

.rt-children {
  display: flex;
  flex-direction: column;
}

/* ── Place leaf (the lieu) ───────────────────────────────────────────────── */
.rt-place {
  display: flex;
  flex-direction: column;
}

.rt-place-head {
  align-items: baseline;
  gap: 0.6rem;
  padding-top: 0.3rem;
  padding-bottom: 0.25rem;
}

.rt-place-head.rt-toggle {
  align-items: center;
}

.rt-place-title {
  flex: 1;
  min-width: 0;
  font-family: var(--font-sans);
  font-size: clamp(0.86rem, 0.7rem + 0.7vw, 0.98rem);
  font-weight: 700;
  color: hsl(var(--primary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-auditions {
  display: flex;
  flex-direction: column;
  padding-left: calc(0.35rem + var(--rt-indent, 0rem));
}

/* ── Audition accordion (flat: hairline dividers, no per-item box) ───────── */
.aud-group + .aud-group {
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.aud-header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  width: 100%;
  padding: 0.7rem 0.6rem;
  background: transparent;
  border: none;
  border-radius: 0.5rem;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s ease;
}

.aud-header:hover {
  background: hsl(var(--accent) / 0.4);
}

.aud-info {
  flex: 1;
  min-width: 0;
}

.aud-title {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: clamp(0.86rem, 0.7rem + 0.7vw, 0.98rem);
  letter-spacing: 0;
  color: hsl(var(--foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aud-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: hsl(var(--muted-foreground));
  margin-top: 0.15rem;
}

.aud-date {
  flex-shrink: 0;
  white-space: nowrap;
}

.aud-count {
  flex-shrink: 0;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 600;
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
  white-space: nowrap;
}

.aud-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
  transition: transform 0.28s ease;
}

.aud-header.open .aud-chevron {
  transform: rotate(180deg);
}

.aud-body {
  display: flex;
  flex-direction: column;
  padding: 0.1rem 0.6rem 0.7rem 1.1rem;
}

.aud-body :deep(.testimony) {
  padding: 0.85rem 0;
}

.aud-body :deep(.testimony):first-child {
  padding-top: 0.2rem;
}

.aud-body :deep(.testimony) + :deep(.testimony) {
  border-top: 1px solid hsl(var(--border) / 0.45);
}

/* ── Phones: tighter vertical rhythm (mirrors the panel's mobile spacing) ── */
@media (max-width: 899px) {
  .rt-head {
    padding-top: 0.25rem;
    padding-bottom: 0.25rem;
  }

  .aud-header {
    padding: 0.5rem 0.5rem;
  }

  .aud-meta {
    margin-top: 0.05rem;
  }

  .aud-body {
    padding: 0.05rem 0.5rem 0.45rem 0.9rem;
  }

  .aud-body :deep(.testimony) {
    padding: 0.55rem 0;
  }

  .aud-body :deep(.testimony):first-child {
    padding-top: 0.1rem;
  }

  .count-word,
  .rt-count-word {
    display: none;
  }
}
</style>
