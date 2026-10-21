<script setup lang="ts">
import { useToast } from "@/composables/useToast";

const { toasts, dismiss } = useToast();
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="{ destructive: t.variant === 'destructive' }"
        role="status"
      >
        <div class="toast-body">
          <p class="toast-title">{{ t.title }}</p>
          <p v-if="t.description" class="toast-desc">{{ t.description }}</p>
        </div>
        <button class="toast-close" aria-label="Fermer" @click="dismiss(t.id)">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="14"
            height="14"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  max-width: min(380px, calc(100vw - 2.5rem));
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-radius: 0.65rem;
  background: hsl(var(--card));
  color: hsl(var(--card-foreground));
  border: 1px solid hsl(var(--border));
  box-shadow: var(--shadow-lg);
}

.toast.destructive {
  border-color: hsl(var(--destructive) / 0.5);
  background: hsl(var(--destructive));
  color: hsl(var(--destructive-foreground));
}

.toast-body {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-weight: 600;
  font-size: var(--text-ui);
}

.toast-desc {
  font-size: var(--text-ui);
  margin-top: 0.15rem;
  opacity: 0.85;
}

.toast-close {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 0.35rem;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  border: none;
}

.toast-close:hover {
  opacity: 1;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
