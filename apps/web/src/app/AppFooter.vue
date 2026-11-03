<script setup lang="ts">
import { CONTACT_EMAIL, SOURCE_URL, mailto } from "@/shared/contact";
import { ROUTE } from "@/shared/routes";

// The legal pages, reachable from every page that scrolls (the law asks for
// them "easily, directly and permanently"); the map page, which does not
// scroll, has them in the phone menu.
const links = [
  { to: ROUTE.legalNotice.path, label: "Mentions légales" },
  { to: ROUTE.privacy.path, label: "Confidentialité" },
  { to: ROUTE.rules.path, label: "Règles de publication" },
];
</script>

<template>
  <footer class="footer">
    <div class="footer-inner container-page">
      <p class="footer-brand">
        <span class="footer-name">Auditions Citoyennes</span>
        <span class="footer-tagline">Projet citoyen et bénévole, sans publicité.</span>
      </p>
      <nav class="footer-links" aria-label="Informations légales">
        <RouterLink v-for="l in links" :key="l.to" :to="l.to" class="footer-link">
          {{ l.label }}
        </RouterLink>
        <a :href="SOURCE_URL" target="_blank" rel="noopener" class="footer-link"> Code source </a>
        <a :href="mailto(CONTACT_EMAIL, 'Auditions Citoyennes')" class="footer-link">Contact</a>
      </nav>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--background));
}

.footer-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem 2rem;
  padding-block: 1.75rem calc(1.75rem + env(safe-area-inset-bottom));
}

.footer-brand {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.footer-name {
  font-family: var(--font-display);
  font-size: var(--text-title);
  letter-spacing: 0.04em;
  line-height: 1;
  color: hsl(var(--foreground));
}

.footer-tagline {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.footer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.25rem;
}

.footer-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.25rem;
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
  transition: var(--transition-smooth);
}

.footer-link:hover,
.footer-link.router-link-exact-active {
  color: hsl(var(--foreground));
}
</style>
