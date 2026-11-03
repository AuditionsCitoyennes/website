<script setup lang="ts">
import { computed } from "vue";
import { reportHref } from "@/shared/contact";

// « Signaler »: an email to the site naming the testimony (the « Règles de
// publication » say what happens next). The page named is the audition's
// when there is one, else the page the testimony was seen on.
const props = defineProps<{
  testimony: { id: string; person_name: string };
  auditionId?: string | null;
}>();

const href = computed(() =>
  reportHref(
    props.testimony,
    props.auditionId
      ? `${window.location.origin}/audition/${props.auditionId}`
      : window.location.href,
  ),
);
</script>

<template>
  <a :href="href" class="report" title="Signaler ce témoignage par email">Signaler</a>
</template>

<style scoped>
.report {
  display: inline-flex;
  align-items: center;
  min-height: 1.75rem;
  margin-left: auto;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground) / 0.8);
  transition: var(--transition-smooth);
}

.report:hover,
.report:focus-visible {
  color: hsl(var(--destructive));
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
</style>
