<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { useAuthStore } from "@/features/auth";
import { useTheme } from "@/shared/ui/theme/useTheme";
import { ROUTE } from "@/shared/routes";
import { useCreateAudition } from "@/features/admin";
import { useSubmitTestimony } from "@/features/testify";
import {
  lastTestimonyAt,
  nudgeDue,
  testifyLook,
  testifyNudge,
} from "@/shared/testimony/testifyNudge";
import { DONATION_URL } from "@/features/support";
import HeaderMobileMenu from "./HeaderMobileMenu.vue";
import { useHeaderTuck } from "./useHeaderTuck";

const auth = useAuthStore();
const { isDark, toggle } = useTheme();
const route = useRoute();
const createAudition = useCreateAudition();
const submitTestimony = useSubmitTestimony();
const mobileOpen = ref(false);
const menuToggle = ref<HTMLButtonElement | null>(null);

// On phones the header is no bar: its tiles float over the page. On the map
// page they always stay (nothing scrolls there).
const immersive = computed(() => route.path === ROUTE.temoignages.path);

// Elsewhere they get out of the way while the page is read downwards, and come
// back as soon as it goes up — or near the top, where they cover nothing.
const { tucked } = useHeaderTuck({ immersive, menuOpen: mobileOpen });

// "Soutenir" only once there is a donation link to give (features/support).
const links = [
  { to: ROUTE.home.path, label: "Accueil" },
  { to: ROUTE.temoignages.path, label: "Témoignages" },
  ...(DONATION_URL ? [{ to: ROUTE.support.path, label: "Soutenir" }] : []),
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

// "Nouvelle audition": the popup opens over whichever page this is. (Signing
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

// « Témoigner » invites a little more when this device has sent no testimony
// for a week (shared/testimony/testifyNudge.ts): a violet glow, ring or dot on
// the bar's button, and on phones on the menu's tile (the button is in its
// popup there).
const nudge = computed(() => nudgeDue(testifyNudge.value, lastTestimonyAt.value, Date.now()));
const nudgeClass = computed(() => (nudge.value ? ["nudge", `nudge--${testifyLook.value}`] : []));

// The menu's tile invites only while the menu is shut: open, its « Témoigner »
// row is in view (and the tile is the close button).
const menuNudgeClass = computed(() => (mobileOpen.value ? [] : nudgeClass.value));

// « Nous rejoindre », for a visitor who is not signed in: the sign-up tab.
const joinTo = { path: ROUTE.auth.path, query: { tab: "inscription" } };
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
        <div class="auth-desktop">
          <button
            type="button"
            class="btn btn-primary testify"
            :class="nudgeClass"
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
              <span class="new-audition-label">Nouvelle audition</span>
            </button>
            <RouterLink to="/admin" class="btn btn-ghost">Admin</RouterLink>
          </template>
          <!-- Joining the volunteers: the sign-up tab of /auth, whose other tab
               signs in. -->
          <RouterLink v-else :to="joinTo" class="btn btn-ghost">Nous rejoindre</RouterLink>
        </div>

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

        <button
          ref="menuToggle"
          class="icon-btn menu-toggle"
          :class="menuNudgeClass"
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

  <HeaderMobileMenu
    :open="mobileOpen"
    :links="links"
    :join-to="joinTo"
    :nudge="nudge"
    @close="closeMobile"
    @testify="testify"
    @new-audition="newAudition"
  />
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
  /* One even gap through the bar's right-hand cluster: the nav links, then
     the buttons (.header-actions has the same). */
  gap: 0.5rem;
}

/* The logo on the left; everything else gathers on the right. */
.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-right: auto;
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
  gap: 0.5rem;
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

/* « Admin » and « Nous rejoindre » on their own page: marked like the nav's. */
.btn-ghost.router-link-active {
  color: hsl(var(--primary));
  background: hsl(var(--accent) / 0.5);
}

/* « Témoigner » inviting (shared/testimony/testifyNudge.ts): the bar's button,
   and on phones the menu's tile. Only a layer of its own moves, by its opacity
   and its scale, a few seconds after the page shows; then it holds still.
   Always the site's violet. */
.nudge {
  position: relative;
  /* A ring as wide as tall around a long button and a square tile alike. */
  --nudge-grow-x: 1.1;
  --nudge-grow-y: 1.32;
}

.icon-btn.nudge {
  --nudge-grow-x: 1.3;
  --nudge-grow-y: 1.3;
}

.nudge::before,
.nudge::after {
  content: "";
  position: absolute;
  pointer-events: none;
}

/* « Lueur »: a soft glow, breathing three times, then still. */
.nudge--lueur::after {
  inset: -1px;
  border-radius: inherit;
  box-shadow:
    0 0 0 3px hsl(var(--primary) / 0.3),
    0 0 20px 5px hsl(var(--primary) / 0.55);
  opacity: 0.65;
  animation: nudge-breathe 2.4s ease-in-out 0.6s 3 both;
}

/* « Anneau »: a thin ring, from which a wider one spreads and fades three
   times. */
.nudge--anneau::before,
.nudge--anneau::after {
  inset: -4px;
  border-radius: calc(0.5rem + 4px);
  border: 1.5px solid hsl(var(--primary) / 0.65);
}

.nudge--anneau::after {
  border-width: 2px;
  opacity: 0;
  animation: nudge-ripple 1.8s cubic-bezier(0.2, 0.6, 0.3, 1) 0.6s 3 both;
}

/* « Point »: a small dot on the corner, its glow breathing three times. */
.nudge--point::before,
.nudge--point::after {
  top: -4px;
  right: -4px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.nudge--point::before {
  box-shadow: 0 0 8px 4px hsl(var(--primary) / 0.7);
  opacity: 0.65;
  animation: nudge-glow 2.4s ease-in-out 0.6s 3 both;
}

.nudge--point::after {
  background: hsl(var(--accent-foreground));
}

@keyframes nudge-breathe {
  0%,
  100% {
    opacity: 0.65;
  }
  25% {
    opacity: 1;
  }
  75% {
    opacity: 0.25;
  }
}

@keyframes nudge-glow {
  0%,
  100% {
    opacity: 0.65;
    transform: scale(1);
  }
  25% {
    opacity: 1;
    transform: scale(1.7);
  }
  75% {
    opacity: 0.3;
    transform: scale(1);
  }
}

@keyframes nudge-ripple {
  0% {
    opacity: 0.9;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(var(--nudge-grow-x), var(--nudge-grow-y));
  }
}

/* Less motion asked for: the still look at once. */
@media (prefers-reduced-motion: reduce) {
  .nudge::before,
  .nudge::after {
    animation: none;
  }
}

/* "+ Nouvelle audition" (admins). One line, never squeezed by the nav links —
   and where the bar is too narrow for all of it (just above the width at which
   the nav folds into the hamburger), only its "+" is left: the bar's
   secondary entries fold first, « Témoigner » keeps its word. */
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

/* "Témoigner", for everyone: never wrapped, its word kept at every width of
   the bar (900 px and up: it fits beside the admins' entries too, their
   "Nouvelle audition" folded to its "+"). */
.testify {
  flex-shrink: 0;
  gap: 0.45rem;
  white-space: nowrap;
  min-height: 2.45rem;
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
   menu (HeaderMobileMenu.vue) once the nav collapses into the hamburger. */
.auth-desktop {
  display: none;
}

.menu-toggle {
  display: grid;
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
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
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
