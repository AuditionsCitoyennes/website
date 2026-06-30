<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";

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

function onOverlayClick(e: MouseEvent) {
  if (props.dismissible && pressStartedOnOverlay && e.target === e.currentTarget) {
    emit("close");
  }
  pressStartedOnOverlay = false;
}

// Escape works regardless of where focus is (the overlay itself is not
// focusable, so an element listener would miss most keydowns).
function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.dismissible) emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener("keydown", onWindowKeydown);
      document.body.style.overflow = "hidden";
    } else {
      window.removeEventListener("keydown", onWindowKeydown);
      document.body.style.overflow = "";
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown);
  document.body.style.overflow = "";
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-overlay"
      @pointerdown="onOverlayPointerDown"
      @click="onOverlayClick"
    >
      <div
        class="dialog elevation-2xl"
        :class="{ wide, medium }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <header class="dialog-head">
          <h2 class="dialog-title">{{ title }}</h2>
          <p v-if="description" class="dialog-desc">{{ description }}</p>
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
  margin-bottom: 1.1rem;
}

.dialog-title {
  font-family: var(--font-display);
  font-size: 1.45rem;
  letter-spacing: 0.04em;
  color: hsl(var(--foreground));
}

.dialog-desc {
  margin-top: 0.35rem;
  font-size: 0.88rem;
  color: hsl(var(--muted-foreground));
}
</style>
