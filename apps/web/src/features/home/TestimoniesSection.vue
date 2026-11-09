<script setup lang="ts">
import { defineAsyncComponent, ref, toRef } from "vue";
import { useMapCardSlot } from "./useMapCardSlot";
import { vReveal } from "./vReveal";

const props = defineProps<{
  /** The hero photograph is shown (HeroSection): what the "tot" policy waits for. */
  heroReady: boolean;
}>();

// The map comes into this card (MapStage); clicking it opens the page, the
// card growing into it.
const mapCard = ref<HTMLElement | null>(null);
useMapCardSlot(mapCard, toRef(props, "heroReady"));

// The testing tools only: when the card is lent (useMapCardSlot's policies).
const DevHomeMapSwitch = __TEST_TOOLS__
  ? defineAsyncComponent(() => import("./DevHomeMapSwitch.vue"))
  : null;
</script>

<template>
  <section id="les-temoignages" class="band band--alt">
    <div class="container-page split split--reverse">
      <div v-reveal class="copy">
        <p class="eyebrow">Les témoignages</p>
        <h2 class="title">Des paroles écoutées,<br />qui pèsent ensemble</h2>
        <p class="lead">
          Chaque témoignage recueilli lors d'une audition publique y est rattaché, avec son lieu et
          sa date. Chaque témoignage déposé en ligne rejoint l'audition en ligne de sa commune pour
          le mois en cours.
        </p>
        <p class="lead lead--next">
          Chaque audition est ensuite placée sur notre carte. Ensemble, elles dessinent l'opinion de
          nos villes, de nos départements, de nos régions&nbsp;: de notre pays.
        </p>
        <ul class="points">
          <li>
            Publiés tels quels, sous le nom ou le pseudonyme choisi par la personne, ou sous
            «&nbsp;Anonyme&nbsp;».
          </li>
          <li>
            Validés par leurs auteurs quand ils ont laissé leur email&nbsp;: un lien leur permet de
            relire, modifier, valider ou supprimer leur témoignage.
          </li>
          <li>Analysés dans leur ensemble, pour faire ressortir le pouls de chaque localité.</li>
        </ul>
      </div>

      <!-- The map comes into this card (MapStage); clicking it opens the
           page, the card growing into it. -->
      <div ref="mapCard" v-reveal class="map-card">
        <div class="map-card-wait" aria-hidden="true">
          <span class="spinner"></span>
        </div>
      </div>
    </div>
    <!-- Under the card, not in it: the card's link covers all of it. -->
    <div v-if="DevHomeMapSwitch" class="container-page">
      <DevHomeMapSwitch />
    </div>
  </section>
</template>

<style scoped>
/* Equal rows here too: the bullets fall at an even pitch. */
.points {
  list-style: none;
  margin: 1.6rem 0 0;
  padding: 0;
  display: grid;
  grid-auto-rows: 1fr;
  gap: 0.85rem;
}

.points li {
  position: relative;
  padding-left: 1.9rem;
  line-height: var(--lh-body);
  color: hsl(var(--foreground) / 0.85);
}

.points li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.35rem;
  width: 1.05rem;
  height: 1.05rem;
  border-radius: 50%;
  background: hsl(var(--primary) / 0.15);
  box-shadow: inset 0 0 0 4px hsl(var(--primary) / 0.15);
  border: 2px solid hsl(var(--primary));
}

.map-card {
  position: relative;
  aspect-ratio: 4 / 3.4;
  border-radius: 1.5rem;
  overflow: hidden;
  box-shadow: var(--shadow-2xl);
  background: hsl(var(--muted));
  border: 1px solid hsl(var(--border));
}

/* Before the map is there (or while it loads behind its own curtain). */
.map-card-wait {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--gradient-surface);
}

/* ---- Phones and tablets ------------------------------------------------------- */
@media (max-width: 899px) {
  .map-card {
    aspect-ratio: 1 / 1;
  }

  /* Bullets of several lines each: equal rows would pad them with blanks. */
  .points {
    grid-auto-rows: auto;
  }
}
</style>
