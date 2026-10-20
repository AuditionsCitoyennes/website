<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useTheme } from "@/composables/useTheme";
import { useCreateAudition } from "@/composables/useCreateAudition";
import { useSubmitTestimony } from "@/composables/useSubmitTestimony";

const auth = useAuthStore();
const { isDark, toggle } = useTheme();
const route = useRoute();
const createAudition = useCreateAudition();
const submitTestimony = useSubmitTestimony();
const mobileOpen = ref(false);
const menuToggle = ref<HTMLButtonElement | null>(null);

// On phones the header is no bar: its tiles float over the page. On the map
// page they always stay (nothing scrolls there).
const immersive = computed(() => route.path === "/temoignages");

// Elsewhere they get out of the way while the page is read downwards, and come
// back as soon as it goes up — or near the top, where they cover nothing.
const tucked = ref(false);
const phone = window.matchMedia("(max-width: 899px)");
/** Scroll, in px, before the tiles react: a finger resting on the screen trembles. */
const TUCK_SLACK = 8;
/** Near the top of the page the tiles always show: they sit in its margin. */
const TUCK_FROM = 64;
let lastY = 0;
let scrollFrame = 0;
function onScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const y = Math.max(0, window.scrollY); // iOS bounces above 0
    if (!phone.matches || immersive.value || mobileOpen.value || y < TUCK_FROM) {
      tucked.value = false;
      lastY = y;
    } else if (y - lastY > TUCK_SLACK) {
      tucked.value = true;
      lastY = y;
    } else if (lastY - y > TUCK_SLACK) {
      tucked.value = false;
      lastY = y;
    }
  });
}
onMounted(() => window.addEventListener("scroll", onScroll, { passive: true }));
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  cancelAnimationFrame(scrollFrame);
});
// A new page: the tiles show.
watch(
  () => route.fullPath,
  () => {
    tucked.value = false;
    lastY = Math.max(0, window.scrollY);
  },
);

const links = [
  { to: "/", label: "Accueil" },
  { to: "/temoignages", label: "Témoignages" },
];

function closeMobile() {
  mobileOpen.value = false;
}

// From the phone menu, the entry just pressed leaves the page with the menu:
// the hamburger takes the focus, for the popup to give it back there when it
// closes.
function leaveMenu() {
  if (!mobileOpen.value) return;
  closeMobile();
  menuToggle.value?.focus({ preventScroll: true });
}

// "Nouvelle Audition": the popup opens over whichever page this is. (Signing
// out is on the admin page.)
function newAudition() {
  leaveMenu();
  createAudition.show();
}

// "Témoigner", for everyone: the same, with the visitors' form.
function testify() {
  leaveMenu();
  submitTestimony.show();
}

// The bar is fuller for admins ("+ Nouvelle Audition", "Admin"): their
// "Témoigner" folds down to its icon sooner.
const crowded = computed(() => Boolean(auth.user) && (auth.isAdmin || auth.loading));
</script>

<template>
  <!-- Keyboard focus coming into it brings the tiles back. -->
  <header
    class="header glass-strong"
    :class="{ 'header--tucked': tucked }"
    @focusin="tucked = false"
  >
    <div class="header-inner">
      <RouterLink to="/" class="brand" @click="closeMobile">
        <span class="brand-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="22"
            height="22"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </span>
        <span class="brand-text">Auditions Citoyennes</span>
      </RouterLink>

      <nav class="nav-desktop" aria-label="Navigation principale">
        <RouterLink v-for="link in links" :key="link.to" :to="link.to" class="nav-link">
          {{ link.label }}
        </RouterLink>
      </nav>

      <div class="header-actions">
        <button class="icon-btn" :title="isDark ? 'Mode clair' : 'Mode sombre'" @click="toggle">
          <svg
            v-if="isDark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="18"
            height="18"
          >
            <circle cx="12" cy="12" r="5" />
            <path
              d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
            />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="18"
            height="18"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>

        <div class="auth-desktop">
          <button
            type="button"
            class="btn btn-primary testify"
            :class="{ 'testify--crowded': crowded }"
            aria-label="Témoigner"
            title="Témoigner"
            @click="testify"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="16"
              height="16"
              aria-hidden="true"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <line x1="12" y1="7" x2="12" y2="13" />
              <line x1="9" y1="10" x2="15" y2="10" />
            </svg>
            <span class="testify-label">Témoigner</span>
          </button>
          <template v-if="auth.user">
            <!-- While the role is still being checked (each page load) its place
                 is kept, unseen: the bar does not shift under the pointer when
                 the answer comes. -->
            <button
              v-if="auth.isAdmin || auth.loading"
              type="button"
              class="btn btn-outline new-audition"
              :class="{ 'new-audition--pending': !auth.isAdmin }"
              aria-label="Nouvelle audition"
              title="Nouvelle audition"
              @click="newAudition"
            >
              <span aria-hidden="true">+</span>
              <span class="new-audition-label">Nouvelle Audition</span>
            </button>
            <RouterLink to="/admin" class="btn btn-ghost">Admin</RouterLink>
          </template>
          <RouterLink v-else to="/auth" class="btn btn-ghost">Connexion</RouterLink>
        </div>

        <button
          ref="menuToggle"
          class="icon-btn menu-toggle"
          :aria-expanded="mobileOpen"
          aria-label="Menu"
          @click="mobileOpen = !mobileOpen"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="20"
            height="20"
          >
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
          <button type="button" class="nav-link-mobile nav-link-mobile-btn" @click="testify">
            Témoigner
          </button>
          <template v-if="auth.user">
            <button
              v-if="auth.isAdmin"
              type="button"
              class="nav-link-mobile nav-link-mobile-btn"
              @click="newAudition"
            >
              + Nouvelle Audition
            </button>
            <RouterLink to="/admin" class="nav-link-mobile" @click="closeMobile">Admin</RouterLink>
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
  font-size: var(--text-title);
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
  font-size: var(--text-ui);
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
  font-size: var(--text-ui);
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

/* "+ Nouvelle Audition" (admins). One line, never squeezed by the nav links —
   and where the bar is too narrow for all of it (just above the width at which
   the nav folds into the hamburger), only its "+" is left. */
.new-audition {
  flex-shrink: 0;
  gap: 0.4rem;
  white-space: nowrap;
}

@media (max-width: 1099px) {
  .new-audition-label {
    display: none;
  }
}

/* "Témoigner", for everyone: never wrapped, and down to its icon where the
   bar gets short — sooner for admins, whose bar holds more. */
.testify {
  flex-shrink: 0;
  gap: 0.45rem;
  white-space: nowrap;
  /* As tall as its neighbours when only its icon is left. */
  min-height: 2.45rem;
}

@media (max-width: 959px) {
  .testify-label {
    display: none;
  }
}

@media (max-width: 1099px) {
  .testify--crowded .testify-label {
    display: none;
  }
}

/* Just above the width where the nav folds into the hamburger, the links
   tighten a little to leave the buttons their room. */
@media (min-width: 900px) and (max-width: 999px) {
  .nav-link {
    padding-inline: 0.6rem;
  }
}

/* Not known to be an admin yet: there, but neither seen nor pressable. */
.new-audition--pending {
  visibility: hidden;
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

/* Phones: no bar. The tiles (brand, theme, menu — each on its own solid
   ground) float over the page, which runs to the very top of the screen: the
   map, the home photo, or a page's own top margin (App.vue). */
@media (max-width: 899px) {
  .header {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    padding-top: env(safe-area-inset-top, 0px);
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-color: transparent;
    /* Taps between the tiles fall through to the page; the tiles take theirs. */
    pointer-events: none;
    transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .header .brand,
  .header .header-actions {
    pointer-events: auto;
  }

  /* Out of the way while the page is read downwards. */
  .header--tucked {
    transform: translateY(-100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .header {
    transition: none;
  }
}
</style>
