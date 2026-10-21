<script lang="ts">
// The dialogs open at this moment, bottom to top. One can open over another
// (an audition's popup, then the form that edits it): only the top one answers
// Escape, each sits above the one it was opened from, and the page stays
// locked until the last one closes.
const openDialogs: symbol[] = [];
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  /** Allow closing via the overlay / Escape. When false the dialog is modal-only. */
  dismissible?: boolean;
  /** Wider dialog (forms with grids, e.g. audition creation). */
  wide?: boolean;
  /** Medium dialog (e.g. the filters popup). */
  medium?: boolean;
  /** As tall as the screen allows, whatever is in it: for a form whose long
   *  text field takes the room that is left (e.g. audition creation). */
  tall?: boolean;
  /** For a dialog with several views: changed by its owner whenever a change
   *  of view puts something new under the pointer, exactly like an opening
   *  does — see `openingGesture`. */
  viewKey?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

// Track where the press STARTED: a text-selection drag that ends over the
// overlay must not dismiss the dialog.
let pressStartedOnOverlay = false;

function onOverlayPointerDown(e: PointerEvent) {
  pressStartedOnOverlay = e.target === e.currentTarget;
}

// The press that opens a dialog may be the first of a double-click. Its 2nd
// click then arrives with the dialog already under the pointer — on the
// overlay, on the close cross, on a form's submit button — and must not act
// there. `openingGesture` is true from the opening until a fresh press (click
// count back to 1) is seen; any later click, quick or not, counts normally.
let openingGesture = false;

function onWindowMouseDown(e: MouseEvent) {
  if (e.detail <= 1) openingGesture = false;
}

// Same hazard when the dialog changes view under a double-click: its 2nd click
// would press whatever the new view put there (a "create" button, say).
watch(
  () => props.viewKey,
  () => {
    if (props.open) openingGesture = true;
  },
);

function onClickCapture(e: MouseEvent) {
  if (e.detail > 1 && openingGesture) {
    e.stopPropagation();
    e.preventDefault();
  }
}

function onOverlayClick(e: MouseEvent) {
  // Swallowed just above (the capture handler sits on this same element).
  if (e.defaultPrevented) {
    pressStartedOnOverlay = false;
    return;
  }
  if (props.dismissible && pressStartedOnOverlay && e.target === e.currentTarget) {
    emit("close");
  }
  pressStartedOnOverlay = false;
}

// Focus follows the dialog: into it when it opens (so the keyboard scrolls and
// tabs inside it, and a screen reader announces it), back to where it was when
// it closes.
const dialogEl = ref<HTMLElement | null>(null);
let restoreFocusTo: HTMLElement | null = null;

function restoreFocus() {
  if (restoreFocusTo?.isConnected) restoreFocusTo.focus({ preventScroll: true });
  restoreFocusTo = null;
}

// This dialog's place in the pile (1 = alone or at the bottom).
const id = Symbol("dialog");
const level = ref(0);

function leavePile() {
  const i = openDialogs.indexOf(id);
  if (i !== -1) openDialogs.splice(i, 1);
  if (openDialogs.length === 0) document.body.style.overflow = "";
}

// The keyboard belongs to the top dialog of the pile, wherever the focus is
// (the overlay itself is not focusable, so an element listener would miss most
// keydowns).
function onWindowKeydown(e: KeyboardEvent) {
  if (openDialogs.at(-1) !== id) return;
  if (e.key === "Escape") {
    // One keypress, one dialog: a key held down does not unpile them all.
    if (props.dismissible && !e.repeat) emit("close");
  } else if (e.key === "Tab") {
    keepTabInside(e);
  }
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Tab goes round inside the dialog instead of walking out of it — onto the
// page behind, or onto the buttons of the dialog underneath.
function keepTabInside(e: KeyboardEvent) {
  const el = dialogEl.value;
  if (!el) return;
  const stops = [...el.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (n) => n.getClientRects().length > 0,
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) {
    e.preventDefault();
    el.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  const outside = active === el || !el.contains(active);
  if (outside || active === (e.shiftKey ? first : last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener("keydown", onWindowKeydown);
      window.addEventListener("mousedown", onWindowMouseDown, true);
      openingGesture = true;
      if (!openDialogs.includes(id)) openDialogs.push(id);
      level.value = openDialogs.length;
      document.body.style.overflow = "hidden";
      restoreFocusTo =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void nextTick(() => {
        const el = dialogEl.value;
        // Unless something inside took the focus already.
        if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
      });
    } else {
      window.removeEventListener("keydown", onWindowKeydown);
      window.removeEventListener("mousedown", onWindowMouseDown, true);
      leavePile();
      restoreFocus();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("mousedown", onWindowMouseDown, true);
  leavePile();
  restoreFocus();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-overlay"
      :style="{ zIndex: 1500 + level }"
      @pointerdown="onOverlayPointerDown"
      @click.capture="onClickCapture"
      @click="onOverlayClick"
    >
      <div
        ref="dialogEl"
        class="dialog elevation-2xl"
        :class="{ wide, medium, tall }"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <header class="dialog-head">
          <div class="dialog-head-main">
            <!-- What comes before the title, in the top-left corner: the "back"
                 arrow of a dialog that has more than one view. -->
            <slot name="lead" />
            <div>
              <h2 class="dialog-title">{{ title }}</h2>
              <p v-if="description" class="dialog-desc">{{ description }}</p>
            </div>
          </div>
          <!-- Only where closing is allowed at all: a modal-only dialog (no
               overlay / Escape dismissal) must not offer a way out here either. -->
          <button
            v-if="dismissible"
            type="button"
            class="ac-btn ac-btn--ghost ac-btn--icon ac-btn--sm dialog-close"
            aria-label="Fermer"
            @click="emit('close')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="18"
              height="18"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div class="dialog-body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgb(0 0 0 / 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.dialog {
  width: 100%;
  max-width: 28rem;
}

.dialog.wide {
  max-width: 52rem;
}

.dialog.medium {
  max-width: 34rem;
}

.dialog {
  max-height: calc(100dvh - 2rem);
  overflow-y: auto;
  background: hsl(var(--card));
  color: hsl(var(--card-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: 0.9rem;
  padding: 1.5rem;
  animation: dialog-in 0.2s ease-out;
}

/* Tall: the height of the screen (less the overlay's margin — never beyond it),
   up to a comfortable page; its body is a column whose content may stretch to
   fill it. Nothing in it shrinks below its own size: on a screen too short for
   it all, the dialog scrolls as any other does. */
.dialog.tall {
  display: flex;
  flex-direction: column;
  height: min(calc(100dvh - 2rem), 60rem);
  /* The width of its content never depends on whether it scrolls: a
     v-autogrow field collapses for an instant to measure itself, and must not
     find a scrollbar gone — and the text rewrapped wider — while it does. */
  scrollbar-gutter: stable;
}

.dialog.tall > .dialog-head {
  flex-shrink: 0;
}

.dialog.tall > .dialog-body {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
}

/* Focused by script on opening, never by the Tab key: no ring around it. */
.dialog:focus {
  outline: none;
}

@keyframes dialog-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(6px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1.1rem;
}

.dialog-head-main {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  min-width: 0;
}

/* Pulled into the dialog's padding so the cross sits in the corner rather than
   level with the title's left edge. */
.dialog-close {
  flex-shrink: 0;
  margin: -0.45rem -0.5rem 0 0;
  color: hsl(var(--muted-foreground));
}

.dialog-close:hover {
  color: hsl(var(--foreground));
}

.dialog-title {
  font-family: var(--font-display);
  font-size: var(--text-title);
  letter-spacing: 0.04em;
  color: hsl(var(--foreground));
}

.dialog-desc {
  margin-top: 0.35rem;
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}
</style>
