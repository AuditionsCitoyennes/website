<script setup lang="ts">
import { useAuthStore } from "@/features/auth";
import { ROUTE } from "@/shared/routes";

defineProps<{
  open: boolean;
  links: { to: string; label: string }[];
}>();
const emit = defineEmits<{
  close: [];
  testify: [];
  newAudition: [];
}>();

const auth = useAuthStore();

// The legal pages: on phones the map page has no footer, so the menu carries
// them on every page.
const legal = [
  { to: ROUTE.legalNotice.path, label: "Mentions légales" },
  { to: ROUTE.privacy.path, label: "Confidentialité" },
  { to: ROUTE.rules.path, label: "Règles de publication" },
];
</script>

<template>
  <!-- Mobile menu: a floating popup with a dimmed backdrop (not an in-header
       dropdown), so it overlays the page instead of pushing/attaching to the bar. -->
  <Teleport to="body">
    <div v-if="open" class="nav-overlay">
      <div class="nav-overlay-backdrop" @click="emit('close')"></div>
      <nav class="nav-popup glass-strong" aria-label="Navigation mobile">
        <RouterLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="nav-link-mobile"
          @click="emit('close')"
        >
          {{ link.label }}
        </RouterLink>

        <div class="nav-mobile-auth">
          <button
            type="button"
            class="nav-link-mobile nav-link-mobile-btn"
            @click="emit('testify')"
          >
            Témoigner
          </button>
          <template v-if="auth.user">
            <button
              v-if="auth.isAdmin"
              type="button"
              class="nav-link-mobile nav-link-mobile-btn"
              @click="emit('newAudition')"
            >
              + Nouvelle Audition
            </button>
            <RouterLink to="/admin" class="nav-link-mobile" @click="emit('close')"
              >Admin</RouterLink
            >
          </template>
          <RouterLink v-else to="/auth" class="nav-link-mobile" @click="emit('close')">
            Connexion
          </RouterLink>
        </div>

        <div class="nav-mobile-legal">
          <RouterLink
            v-for="link in legal"
            :key="link.to"
            :to="link.to"
            class="nav-link-legal"
            @click="emit('close')"
          >
            {{ link.label }}
          </RouterLink>
        </div>
      </nav>
    </div>
  </Teleport>
</template>

<style scoped>
.nav-mobile-auth {
  display: flex;
  flex-direction: column;
  margin-top: 0.25rem;
  padding-top: 0.25rem;
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.nav-mobile-legal {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.9rem;
  margin-top: 0.25rem;
  padding: 0.35rem 0.5rem 0.15rem;
  border-top: 1px solid hsl(var(--border) / 0.5);
}

.nav-link-legal {
  display: inline-flex;
  align-items: center;
  min-height: 2.25rem;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.nav-link-legal.router-link-active {
  color: hsl(var(--primary));
}

.nav-link-mobile-btn {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  font: inherit;
  cursor: pointer;
}

/* Mobile menu popup (floating card + dimmed backdrop). */
.nav-overlay {
  position: fixed;
  inset: 0;
  /* Below the header (z 50) so the bar + close button stay crisp and clickable;
     above the page content, which the backdrop dims. */
  z-index: 45;
}

.nav-overlay-backdrop {
  position: absolute;
  inset: 0;
  background: hsl(var(--background) / 0.55);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
}

.nav-popup {
  position: absolute;
  /* Drop in from just below the header bar, near the hamburger. */
  top: 4rem;
  right: 0.75rem;
  display: flex;
  flex-direction: column;
  min-width: 13rem;
  max-width: calc(100vw - 1.5rem);
  padding: 0.5rem;
  border-radius: 0.85rem;
  box-shadow: var(--shadow-lg);
}

.nav-link-mobile {
  padding: 0.75rem 0.5rem;
  border-radius: 0.5rem;
  color: hsl(var(--foreground));
  font-weight: 500;
}

.nav-link-mobile:hover {
  background: hsl(var(--accent) / 0.6);
}

.nav-link-mobile.router-link-active {
  color: hsl(var(--primary));
}

@media (min-width: 900px) {
  /* Safety: if the viewport grows while the popup is open, hide it (the
     hamburger is gone at this width). */
  .nav-overlay {
    display: none;
  }
}
</style>
