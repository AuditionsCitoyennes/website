<script setup lang="ts">
import { ROUTE } from "@/shared/routes";
</script>

<!-- Above a testimony typed in by a volunteer: what the witness must have
     agreed to before it is published (the « Règles de publication »). -->
<template>
  <p class="consent-note">
    Seulement avec l'accord de la personne&nbsp;: dites-lui que son témoignage sera public, sous le
    nom de son choix ou « Anonyme », qu'il peut révéler ses opinions, et qu'elle peut le faire
    retirer à tout moment. Moins de 15 ans&nbsp;: avec l'accord d'un parent.
    <a :href="ROUTE.rules.path" target="_blank" rel="noopener">Les règles</a>
  </p>
</template>

<style scoped>
.consent-note {
  padding: 0.6rem 0.8rem;
  border: 1px solid hsl(var(--primary) / 0.3);
  border-radius: 0.6rem;
  background: hsl(var(--accent) / 0.6);
  font-size: var(--text-caption);
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

.consent-note a {
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
</style>
