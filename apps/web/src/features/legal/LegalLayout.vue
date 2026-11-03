<script setup lang="ts">
import { ROUTE } from "@/shared/routes";
import { UPDATED } from "./content";

defineProps<{
  title: string;
  lead?: string;
}>();

// The three pages point at each other at the bottom.
const pages = [
  { to: ROUTE.legalNotice.path, label: "Mentions légales" },
  { to: ROUTE.privacy.path, label: "Confidentialité" },
  { to: ROUTE.rules.path, label: "Règles de publication" },
];
</script>

<template>
  <article class="legal container-page">
    <header class="legal-head">
      <p class="eyebrow">Informations légales</p>
      <h1 class="legal-title">{{ title }}</h1>
      <p v-if="lead" class="legal-lead">{{ lead }}</p>
      <p class="legal-updated">Mis à jour le {{ UPDATED }}</p>
    </header>

    <div class="legal-prose">
      <slot />
    </div>

    <nav class="legal-nav" aria-label="Informations légales">
      <RouterLink v-for="p in pages" :key="p.to" :to="p.to" class="legal-nav-link">
        {{ p.label }}
      </RouterLink>
    </nav>
  </article>
</template>

<style scoped>
.legal {
  max-width: 50rem;
  padding-block: clamp(2.5rem, 7vw, 5rem);
}

.legal-head {
  margin-bottom: clamp(2rem, 5vw, 3rem);
}

.eyebrow {
  margin-bottom: 0.8rem;
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: hsl(var(--primary));
}

.legal-title {
  margin-bottom: 1rem;
  line-height: 0.95;
}

.legal-lead {
  font-size: var(--text-lead);
  line-height: var(--lh-body);
  color: hsl(var(--foreground) / 0.85);
}

.legal-updated {
  margin-top: 0.8rem;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.legal-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: clamp(2.5rem, 6vw, 4rem);
  padding-top: 1.5rem;
  border-top: 1px solid hsl(var(--border));
}

.legal-nav-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.5rem;
  padding: 0.4rem 1rem;
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  font-size: var(--text-ui);
  font-weight: 600;
  transition: var(--transition-smooth);
}

.legal-nav-link:hover {
  background: hsl(var(--accent) / 0.6);
}

.legal-nav-link.router-link-exact-active {
  border-color: hsl(var(--primary) / 0.5);
  color: hsl(var(--primary));
}
</style>

<style>
/* The text, as the pages write it in the slot: not scoped (slot content is
   the page's), namespaced by .legal-prose instead. */
.legal-prose {
  line-height: var(--lh-body);
  color: hsl(var(--foreground) / 0.9);
}

.legal-prose section {
  margin-bottom: clamp(2rem, 4vw, 2.75rem);
}

.legal-prose section > * + * {
  margin-top: 0.8rem;
}

.legal-prose h2 {
  margin-bottom: 1rem;
  font-size: var(--text-title);
  color: hsl(var(--foreground));
}

.legal-prose h3 {
  margin-top: 1.4rem;
  font-family: var(--font-sans);
  font-size: var(--text-body);
  font-weight: 600;
  letter-spacing: normal;
  line-height: 1.3;
  color: hsl(var(--foreground));
}

.legal-prose ul {
  padding-left: 1.2rem;
}

.legal-prose li + li {
  margin-top: 0.4rem;
}

.legal-prose a {
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 0.15em;
  overflow-wrap: anywhere;
}

.legal-prose strong {
  color: hsl(var(--foreground));
}

.legal-prose .legal-box {
  padding: 1rem 1.2rem;
  border: 1px solid hsl(var(--primary) / 0.3);
  border-radius: 0.85rem;
  background: hsl(var(--accent) / 0.6);
}

/* Tables: a row per entry; on phones each row stacks its cells. */
.legal-prose table {
  width: 100%;
  border-collapse: collapse;
}

.legal-prose th,
.legal-prose td {
  padding: 0.6rem 0.75rem 0.6rem 0;
  border-bottom: 1px solid hsl(var(--border));
  text-align: left;
  vertical-align: top;
}

.legal-prose th {
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
}

.legal-prose td:first-child {
  font-weight: 600;
  color: hsl(var(--foreground));
}

@media (max-width: 639px) {
  .legal-prose thead {
    display: none;
  }

  .legal-prose tr {
    display: block;
    padding-block: 0.6rem;
    border-bottom: 1px solid hsl(var(--border));
  }

  .legal-prose td {
    display: block;
    padding: 0.1rem 0;
    border: none;
  }

  /* The column's name, which the hidden header no longer gives. */
  .legal-prose td[data-label]::before {
    content: attr(data-label) "\00a0: ";
    font-size: var(--text-caption);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: hsl(var(--muted-foreground));
  }
}
</style>
