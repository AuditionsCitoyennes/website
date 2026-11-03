<script setup lang="ts">
import { ROUTE } from "@/shared/routes";

/** Ticked: the volunteer certifies that every witness agreed. */
const certified = defineModel<boolean>({ required: true });
</script>

<!-- Above the button that sends testimonies typed in by a volunteer: what
     every witness agreed to (the « Règles de publication »), certified once
     for the whole submission. The API requires it (consent_certified) and
     keeps who ticked it and when. Its parent focuses it by its name. -->
<template>
  <div class="consent-check">
    <label class="consent-box">
      <input v-model="certified" name="consent-certified" type="checkbox" required />
      <span>
        Je certifie que chaque personne dont je publie le témoignage a accepté qu'il soit publié sur
        ce site, sous le nom ou le pseudonyme qu'elle a choisi, en sachant qu'il peut révéler ses
        opinions et qu'elle peut le faire retirer à tout moment&nbsp;; pour les moins de 15 ans,
        avec l'accord d'un parent.
      </span>
    </label>
    <!-- A new tab: the form stays as it was filled in. -->
    <a class="consent-rules" :href="ROUTE.rules.path" target="_blank" rel="noopener">
      Règles de publication
    </a>
  </div>
</template>

<style scoped>
.consent-check {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.6rem 0.8rem;
  border: 1px solid hsl(var(--primary) / 0.3);
  border-radius: 0.6rem;
  background: hsl(var(--accent) / 0.6);
}

.consent-box {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  font-size: var(--text-body);
  line-height: var(--lh-body);
  color: hsl(var(--foreground));
  cursor: pointer;
}

.consent-box input {
  flex-shrink: 0;
  width: 1.05rem;
  height: 1.05rem;
  margin-top: 0.2rem;
  accent-color: hsl(var(--primary));
}

/* Under the box, aligned with its text. */
.consent-rules {
  align-self: flex-start;
  margin-left: 1.65rem;
  font-size: var(--text-ui);
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
</style>
