<script setup lang="ts">
import { PASSWORD_REQUIREMENTS } from "../lib/password";

// The password rules as a checklist that lights up as the password is typed:
// the same rules the schema enforces (lib/password), under every password
// field of the site — sign-up, reset, and the account dialog.
defineProps<{
  /** The password as typed so far. */
  password: string;
  /** Smaller marks, tighter lines: the account dialog's denser form. */
  compact?: boolean;
}>();
</script>

<template>
  <ul class="requirements" :class="{ compact }">
    <li
      v-for="req in PASSWORD_REQUIREMENTS"
      :key="req.label"
      class="requirement"
      :class="{ ok: req.test(password) }"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        :width="compact ? 13 : 15"
        :height="compact ? 13 : 15"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      {{ req.label }}
    </li>
  </ul>
</template>

<style scoped>
.requirements {
  list-style: none;
  padding: 0;
  margin: -0.3rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.requirement {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}

.requirement svg {
  color: hsl(var(--muted-foreground) / 0.4);
  flex-shrink: 0;
}

.requirement.ok,
.requirement.ok svg {
  color: hsl(var(--civic-green));
}

/* The account dialog's form: flush with its label, lines closer together. */
.requirements.compact {
  margin: 0;
  gap: 0.25rem;
}

.compact .requirement {
  gap: 0.45rem;
}
</style>
