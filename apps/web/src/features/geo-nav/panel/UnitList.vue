<script setup lang="ts">
// Unit list: children of the scope. The level is swapped as ONE block, keyed by
// scope id — drilling in slides the new list in from the right, stepping back
// out reverses it.
import { abbrevCount, type GeoUnit } from "@/features/geo";
import LoadingDots from "@/shared/ui/feedback/LoadingDots.vue";
import { rowHoverGate } from "./rowHover";

defineProps<{
  units: GeoUnit[];
  /** The scope's id: the list is swapped as one block when it changes. */
  scopeId: string;
  /** The level swap's transition (GeoNav's slideName): going deeper brings the
   *  new list in from the right (`level-in`), stepping back out reverses it
   *  (`level-out`). */
  slide: "level-in" | "level-out";
  /** The scope's units are on their way (the server's tree, lazy): loading. */
  pending?: boolean;
}>();

const emit = defineEmits<{
  activate: [unit: GeoUnit];
  /** The row under a mouse pointer (or focus), null when none — handed to the
   *  map so it runs its own hover highlight for that unit; a touch's
   *  mouseenter does not hover a row (rowHover.ts), though a tap that focuses
   *  it (Chrome on Android) still does. */
  hover: [id: string | null];
}>();

// A tap's compatibility mouseenter must not hover the row: on iOS it would
// reveal the unit's pill and withhold the tap's click. A mouse still previews;
// mouseleave and blur always clear.
const hoverGate = rowHoverGate();
function onPointerEnter(e: PointerEvent) {
  hoverGate.pointerEnter(e.pointerType);
}
function onMouseEnter(id: string) {
  if (hoverGate.mouseEnterHovers()) emit("hover", id);
}
</script>

<template>
  <!-- NOT a per-row TransitionGroup: on a full swap every row leaves at
       once, and a leaving row was taken out of flow with no `top`, so once
       its previous siblings were out of flow too their auto positions all
       collapsed to the same y — the whole list piled up on one line and
       then dropped as the new rows animated down. -->
  <div class="unit-viewport">
    <Transition :name="slide">
      <div :key="scopeId" class="unit-list">
        <LoadingDots v-if="pending" label="Chargement des lieux…" />
        <button
          v-for="u in units"
          :key="u.id"
          type="button"
          class="unit-row"
          @click="emit('activate', u)"
          @pointerenter="onPointerEnter"
          @mouseenter="onMouseEnter(u.id)"
          @mouseleave="emit('hover', null)"
          @focus="emit('hover', u.id)"
          @blur="emit('hover', null)"
        >
          <span class="unit-label">{{ u.label }}</span>
          <span class="unit-count">{{ abbrevCount(u.count) }}</span>
          <svg
            v-if="u.levelKey !== 'place'"
            class="unit-chevron"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="16"
            height="16"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span v-else class="unit-leaf-tag">lieu</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.unit-list {
  display: flex;
  flex-direction: column;
}

/* Anchors the outgoing level while it slides out. */
.unit-viewport {
  position: relative;
}

/* Level swap — only the ARRIVING level animates: it slides in from the right
   when drilling deeper (`level-in`) and from the left on the way back up
   (`level-out`). */
.level-in-enter-active,
.level-out-enter-active {
  transition:
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.45s ease;
}

.level-in-enter-from {
  opacity: 0;
  transform: translateX(28px);
}

.level-out-enter-from {
  opacity: 0;
  transform: translateX(-28px);
}

/* The outgoing level is not animated, but it cannot simply be left alone: Vue
   keeps it in the DOM until its transition resolves. Declaring NO transition
   here makes that a single frame — and for that frame it is hidden, out of
   flow so it cannot jump the panel's height, and click-through so a second
   click cannot drill from the level just left. `top: 0` matters: an
   out-of-flow element otherwise falls back to a static position that means
   nothing once its siblings are out of flow too — that was exactly what piled
   the old per-row transitions onto one line. */
.level-in-leave-active,
.level-out-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  opacity: 0;
  pointer-events: none;
}

.unit-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.7rem 0.6rem;
  background: transparent;
  border: none;
  border-radius: 0.5rem;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s ease;
}

.unit-row + .unit-row {
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.unit-row:hover {
  background: hsl(var(--accent) / 0.45);
}

.unit-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: var(--text-body);
  color: hsl(var(--foreground));
}

.unit-count {
  flex-shrink: 0;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-size: var(--text-caption);
  font-weight: 700;
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
}

.unit-chevron {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}

.unit-leaf-tag {
  flex-shrink: 0;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
