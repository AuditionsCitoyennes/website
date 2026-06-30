<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useTheme } from "@/composables/useTheme";

const auth = useAuthStore();
const { isDark, toggle } = useTheme();
const router = useRouter();
const route = useRoute();
const mobileOpen = ref(false);

// On the full-bleed map page, the mobile header floats transparently so the
// map fills to the top of the screen (other pages keep the solid bar).
const immersive = computed(() => route.path === "/temoignages");

const links = [
  { to: "/", label: "Accueil" },
  { to: "/temoignages", label: "Témoignages" },
  { to: "/analyses", label: "Analyses" },
  { to: "/participer", label: "Participer" },
];

function closeMobile() {
  mobileOpen.value = false;
}

async function handleSignOut() {
  await auth.signOut();
  closeMobile();
  router.push("/");
}
</script>

<template>
  <header class="header glass-strong" :class="{ 'header--immersive': immersive }">
    <div class="header-inner">
      <RouterLink to="/" class="brand" @click="closeMobile">
        <span class="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" width="22" height="22">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </span>
        <span class="brand-text">Auditions Citoyennes</span>
      </RouterLink>

      <nav class="nav-desktop" aria-label="Navigation principale">
        <RouterLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="nav-link"
        >
          {{ link.label }}
        </RouterLink>
      </nav>

      <div class="header-actions">
        <button class="icon-btn" :title="isDark ? 'Mode clair' : 'Mode sombre'" @click="toggle">
          <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>

        <div class="auth-desktop">
          <template v-if="auth.user">
            <RouterLink to="/admin" class="btn btn-ghost">Admin</RouterLink>
            <button class="btn btn-outline" @click="handleSignOut">Déconnexion</button>
          </template>
          <RouterLink v-else to="/auth" class="btn btn-primary">Connexion</RouterLink>
        </div>

        <button
          class="icon-btn menu-toggle"
          :aria-expanded="mobileOpen"
          aria-label="Menu"
          @click="mobileOpen = !mobileOpen"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
            <line v-if="!mobileOpen" x1="3" y1="6" x2="21" y2="6" />
            <line v-if="!mobileOpen" x1="3" y1="12" x2="21" y2="12" />
            <line v-if="!mobileOpen" x1="3" y1="18" x2="21" y2="18" />
            <line v-if="mobileOpen" x1="18" y1="6" x2="6" y2="18" />
            <line v-if="mobileOpen" x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>

  </header>

  <!-- Mobile menu: a floating popup with a dimmed backdrop (not an in-header
       dropdown), so it overlays the page instead of pushing/attaching to the bar. -->
  <Teleport to="body">
    <div v-if="mobileOpen" class="nav-overlay">
      <div class="nav-overlay-backdrop" @click="closeMobile"></div>
      <nav class="nav-popup glass-strong" aria-label="Navigation mobile">
        <RouterLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="nav-link-mobile"
          @click="closeMobile"
        >
          {{ link.label }}
        </RouterLink>

        <div class="nav-mobile-auth">
          <template v-if="auth.user">
            <RouterLink to="/admin" class="nav-link-mobile" @click="closeMobile">Admin</RouterLink>
            <button type="button" class="nav-link-mobile nav-link-mobile-btn" @click="handleSignOut">
              Déconnexion
            </button>
          </template>
          <RouterLink v-else to="/auth" class="nav-link-mobile" @click="closeMobile">
            Connexion
          </RouterLink>
        </div>
      </nav>
    </div>
  </Teleport>
</template>

<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 50;
}

.header-inner {
  max-width: 1200px;
  margin-inline: auto;
  padding: 0.75rem 1.5rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-weight: 600;
}

.brand-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 0.6rem;
  background: var(--gradient-hero);
  color: hsl(var(--primary-foreground));
}

.brand-text {
  font-family: var(--font-display);
  font-size: 1.35rem;
  letter-spacing: 0.04em;
  color: hsl(var(--foreground));
}

.nav-desktop {
  display: none;
  gap: 0.25rem;
  margin-inline: auto;
}

.nav-link {
  padding: 0.5rem 0.9rem;
  border-radius: 0.5rem;
  color: hsl(var(--muted-foreground));
  font-weight: 500;
  transition: var(--transition-smooth);
}

.nav-link:hover {
  color: hsl(var(--foreground));
  background: hsl(var(--accent) / 0.6);
}

.nav-link.router-link-active {
  color: hsl(var(--primary));
  background: hsl(var(--accent) / 0.5);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 0.5rem;
  border: 1px solid hsl(var(--border));
  /* Solid, opaque fill (no glassy translucency). */
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  transition: var(--transition-smooth);
}

.icon-btn:hover {
  background: hsl(var(--accent) / 0.6);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  font-weight: 600;
  font-size: 0.9rem;
  border: 1px solid transparent;
  transition: var(--transition-smooth);
}

.btn-primary {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

.btn-primary:hover {
  filter: brightness(1.08);
  box-shadow: var(--shadow-glow);
}

.btn-outline {
  border-color: hsl(var(--border));
  background: transparent;
  color: hsl(var(--foreground));
}

.btn-outline:hover {
  background: hsl(var(--accent) / 0.6);
}

.btn-ghost {
  background: transparent;
  color: hsl(var(--foreground));
}

.btn-ghost:hover {
  background: hsl(var(--accent) / 0.6);
}

/* Auth buttons live in the header bar on desktop, and move into the mobile
   menu (below) once the nav collapses into the hamburger. */
.auth-desktop {
  display: none;
}

.menu-toggle {
  display: grid;
}

.nav-mobile-auth {
  display: flex;
  flex-direction: column;
  margin-top: 0.25rem;
  padding-top: 0.25rem;
  border-top: 1px solid hsl(var(--border) / 0.5);
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
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
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
  .nav-desktop {
    display: flex;
  }
  /* contents → the auth buttons sit directly in .header-actions (with its gap). */
  .auth-desktop {
    display: contents;
  }
  .menu-toggle {
    display: none;
  }
  /* Safety: if the viewport grows while the popup is open, hide it (the
     hamburger is gone at this width). */
  .nav-overlay {
    display: none;
  }
}

/* Hide the wordmark once the nav collapses into the hamburger. */
@media (max-width: 899px) {
  .brand-text {
    display: none;
  }
}

/* Immersive header (map page, mobile): drop the bar background and float over
   the content so it fills to the very top of the screen. */
@media (max-width: 899px) {
  .header--immersive {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-color: transparent;
    /* Taps fall through to the map; the brand + controls re-enable themselves. */
    pointer-events: none;
  }

  .header--immersive .brand,
  .header--immersive .header-actions {
    pointer-events: auto;
  }
}
</style>
