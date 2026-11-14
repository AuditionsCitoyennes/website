<script setup lang="ts">
// The panel: the aside beside the map (a bottom sheet on a phone) — the strip
// that is the sheet's handle, the title row and the page's slots, the
// breadcrumb, and the scrolling list area whose content GeoNav chooses. Its
// state comes in as props; what the layout and the sheet measure (the aside,
// the strip, the safe-area probe, the list's scroller) is exposed. The aside's
// own listeners (a click, a key, the wheel, the pointer resting on it) are
// GeoNav's, attached to the root as fallthrough attributes.
import { ref, type StyleValue } from "vue";
import type { GeoUnit } from "@/features/geo";
import PanelBreadcrumb from "./PanelBreadcrumb.vue";

defineProps<{
  /** An audition is open on a desktop: the panel widens (`.panel.wide`). */
  wide: boolean;
  /** The wide panel slid aside while the map is used (`.panel.folded`). */
  folded: boolean;
  /** Grown down to the page's bottom edge (`.panel.flush`). */
  flush: boolean;
  /** A phone's sheet at rest, lowered (`.panel.sheet-lowered`). */
  sheetLowered: boolean;
  /** The sheet under a finger (`.panel.sheet-dragging`). */
  sheetDragging: boolean;
  /** The sheet's own translate and lowered offset (useBottomSheet's sheetStyle). */
  sheetStyle?: StyleValue;
  /** The sheet is raised. */
  sheetOpen: boolean;
  /** Lowered and at rest: everything under the strip is off screen, and inert. */
  sheetHidden: boolean;
  /** The breadcrumb's trail; null while the results are listed (no trail). */
  crumbs: GeoUnit[] | null;
  /** A territory was tapped and its plateau is on its way: the list is
   *  the new level's already, the map is not there yet (`aria-busy`). */
  busy?: boolean;
  /** That plateau is long in coming: the breadcrumb's dots (the sign of a
   *  long wait). */
  waiting?: boolean;
}>();

const emit = defineEmits<{
  /** The grip tapped: raise or lower the sheet. */
  toggleSheet: [];
  /** The strip's pointer gesture (useBottomSheet's handlers). */
  sheetPointerdown: [e: PointerEvent];
  sheetPointermove: [e: PointerEvent];
  sheetPointerup: [e: PointerEvent];
  /** A crumb clicked: fly back to that unit. */
  crumb: [id: string];
}>();

const el = ref<HTMLElement | null>(null);
/** Grip + title row — what stays on screen when lowered, and the drag handle. */
const peekEl = ref<HTMLElement | null>(null);
/** Zero-size probe whose padding resolves `env(safe-area-inset-bottom)`. */
const safeEl = ref<HTMLElement | null>(null);
/** The list's scroller (`.panel-list`). */
const listEl = ref<HTMLElement | null>(null);
defineExpose({ el, peekEl, safeEl, listEl });
</script>

<template>
  <aside
    ref="el"
    class="panel glass-strong elevation-xl"
    :class="{
      wide,
      folded,
      flush,
      'sheet-lowered': sheetLowered,
      'sheet-dragging': sheetDragging,
    }"
    :style="sheetStyle"
  >
    <span ref="safeEl" class="sheet-safe" aria-hidden="true"></span>
    <header class="panel-head">
      <!-- On a phone this strip is all that shows of the lowered sheet, and
           it is the handle: drag it up to raise the panel, down to lower it. -->
      <div
        ref="peekEl"
        class="sheet-peek"
        @pointerdown="emit('sheetPointerdown', $event)"
        @pointermove="emit('sheetPointermove', $event)"
        @pointerup="emit('sheetPointerup', $event)"
        @pointercancel="emit('sheetPointerup', $event)"
      >
        <button
          type="button"
          class="sheet-grip"
          :aria-expanded="sheetOpen"
          :aria-label="sheetOpen ? 'Réduire le panneau' : 'Afficher le panneau'"
          @click="emit('toggleSheet')"
        >
          <span aria-hidden="true"></span>
        </button>
        <div class="title-row">
          <h1>Témoignages</h1>
          <!-- Filter entry point (the "Filtres" button + its active count).
               The page owns the filter state, so it fills these slots rather
               than the state being drilled down into this component. -->
          <slot name="head-actions" />
        </div>
      </div>

      <!-- Search field, active-filter chips, filter notices — same reason.
           (Everything under the strip is off screen while the sheet is
           lowered, so it is made inert: no focus, no screen-reader stops.) -->
      <div :inert="sheetHidden || undefined">
        <slot name="head-below" />
      </div>

      <!-- Breadcrumb: where the map is; click a crumb to fly back out. One
           line only — leading crumbs collapse into "…" when room runs out,
           and the "…" flies back to the deepest ancestor it wraps. With a
           lieu open the trail stays and ends at the lieu itself; an arrow
           before it goes one level up (backTarget.ts). -->
      <PanelBreadcrumb
        v-if="crumbs"
        :trail="crumbs"
        :waiting="waiting"
        :inert="sheetHidden || undefined"
        @go="emit('crumb', $event)"
      />

      <!-- What the page has to say about the map under the trail (the long
           wait's sentence and its « Réessayer »): GeoNav fills it. -->
      <div :inert="sheetHidden || undefined">
        <slot name="head-notice" />
      </div>
    </header>

    <div
      ref="listEl"
      class="panel-list"
      :inert="sheetHidden || undefined"
      :aria-busy="busy || undefined"
    >
      <slot />
    </div>
  </aside>
</template>

<style scoped>
/* The panel arriving as the card becomes the page — after the map has started
   making room for it (GeoNav's `panel-arrive` transition). `translate`, not
   `transform`: the fold and the phone sheet own the transform. (Doubled
   classes: the panel's own `transition`, in the media queries below, would
   otherwise win.) */
.panel.panel-arrive-enter-active {
  transition:
    opacity 0.45s ease 0.12s,
    translate 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.12s;
}

.panel.panel-arrive-enter-from {
  opacity: 0;
  translate: 2.5rem 0;
}

.panel.panel-arrive-leave-active {
  transition: opacity 0.2s ease;
}

.panel.panel-arrive-leave-to {
  opacity: 0;
}

@media (max-width: 899px) {
  .panel.panel-arrive-enter-from {
    translate: 0 2.5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .panel.panel-arrive-enter-active,
  .panel.panel-arrive-leave-active {
    transition: none;
  }
}

/* Panel geometry. MUST stay in sync with PANEL_BASE_PX / PANEL_WIDE_RATIO in
   usePanelLayout.ts — the camera padding is what keeps the map clear of the
   panel, and a mismatch parks the content under it. */
.panel {
  position: absolute;
  top: 2rem;
  right: 0;
  max-height: calc(100% - 2rem);
  width: min(30rem, 100%);
  display: flex;
  flex-direction: column;
  border-radius: 0.9rem 0 0 0.9rem;
  overflow: hidden;
}

/* Grown down to the bottom edge (measured in script — `panelFlush`), that corner
   sits flush against it and has nothing left to round. */
.panel.flush {
  border-bottom-left-radius: 0;
}

/* An open audition widens the panel so its testimonies get a comfortable
   measure. In its own min-width query: the mobile block below sets `width:
   auto` at lower specificity, which `.panel.wide` would otherwise beat. */
@media (min-width: 900px) {
  .panel {
    /* Matches the map's padding ease in GeoDrillMap — the two run together, so
       a mismatch reads as the map lagging behind the panel. */
    transition:
      width 0.55s cubic-bezier(0.22, 1, 0.36, 1),
      transform 0.55s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .panel.wide {
    width: 75%;
  }

  /* Out of the way while the user is on the map: slid to the right until only
     the panel's narrow width is left in sight (the rest is clipped by the
     page). A transform — the text keeps its layout, nothing reflows. */
  .panel.folded {
    /* (Never to the left: with a large default font 30rem can exceed 75%.) */
    transform: translateX(max(0px, calc(100% - 30rem)));
  }
}

@media (min-width: 900px) and (prefers-reduced-motion: reduce) {
  .panel {
    transition: none;
  }
}

.panel-head {
  flex-shrink: 0;
  padding: 1rem 1.1rem 0.85rem;
  border-bottom: 1px solid hsl(var(--border) / 0.6);
}

.title-row {
  display: flex;
  align-items: center;
  /* Title left, the head-actions slot (Filtres) hard right. */
  justify-content: space-between;
  gap: 0.75rem;
}

.title-row h1 {
  /* The panel's title, not the page's: panels top out at --text-title. */
  font-size: var(--text-title);
  color: hsl(var(--foreground));
}

.mode-toggle {
  margin-left: auto;
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.2rem;
  border-radius: 0.55rem;
  background: hsl(var(--muted) / 0.6);
}

.mode-btn {
  padding: 0.25rem 0.7rem;
  border-radius: 0.4rem;
  border: none;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition-smooth);
}

.mode-btn.active {
  background: hsl(var(--card));
  color: hsl(var(--primary));
  box-shadow: var(--shadow-sm);
}

.level-bar {
  margin-top: 0.7rem;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.level-name {
  font-size: var(--text-body);
  font-weight: 700;
  color: hsl(var(--primary));
}

.level-hint {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.panel-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* The level swap slides sideways: `overflow-y: auto` alone computes
     `overflow-x` to `auto` as well, flashing a scrollbar on every swap. */
  overflow-x: hidden;
  padding: 0.6rem 0.7rem 0.9rem;
}

/* Bottom-sheet parts: phone only (shown in the media query below). */
.sheet-grip,
.sheet-safe {
  display: none;
}

@media (max-width: 899px) {
  /* A bottom sheet. Its box is the RAISED position; lowered, it is slid down
     until only the grip + title strip is left on screen (`--sheet-lowered` is
     measured in script — the fallback only covers the first frame). */
  .panel {
    top: 4.05rem;
    left: 0.4rem;
    right: 0.4rem;
    bottom: 0;
    width: auto;
    max-height: none;
    border-radius: 0.9rem 0.9rem 0 0;
    transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .panel.sheet-lowered {
    transform: translateY(var(--sheet-lowered, calc(100% - 4.5rem)));
  }

  /* Under the finger the sheet follows 1:1 (inline transform) — no easing. */
  .panel.sheet-dragging {
    transition: none;
  }

  .panel-head {
    padding: 0 0.8rem 0.5rem;
  }

  /* The strip is the handle, so the browser must leave vertical drags on it to
     us instead of scrolling or pulling the page. */
  .sheet-peek {
    touch-action: none;
    cursor: grab;
  }

  .sheet-grip {
    display: flex;
    justify-content: center;
    width: 100%;
    padding: 0.5rem 0 0.45rem;
    border: none;
    background: transparent;
    cursor: inherit;
  }

  .sheet-grip span {
    width: 2.4rem;
    height: 0.25rem;
    border-radius: 999px;
    background: hsl(var(--muted-foreground) / 0.45);
  }

  /* Resolves the home-indicator inset for the script (see measureSheet). */
  .sheet-safe {
    display: block;
    position: absolute;
    height: 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    visibility: hidden;
    pointer-events: none;
  }

  .panel-list {
    padding: 0.5rem 0.6rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  }
}

@media (max-width: 899px) and (prefers-reduced-motion: reduce) {
  .panel {
    transition: none;
  }
}
</style>
