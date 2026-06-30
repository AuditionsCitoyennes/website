<script setup lang="ts">
import { useRouter } from "vue-router";

const router = useRouter();

const questions = [
  "Comment allez-vous ?",
  "Comment trouvez-vous que la France va ?",
  "Si vous pouviez changer les choses, que feriez-vous ?",
  "Puis-je vous demander votre adresse email ?",
];

const cards = [
  {
    to: "/temoignages",
    title: "Témoignages",
    text: "Parcourez la carte et lisez les paroles recueillies lors des auditions.",
  },
  {
    to: "/analyses",
    title: "Analyses",
    text: "Découvrez les grands thèmes qui ressortent des témoignages citoyens.",
  },
  {
    to: "/participer",
    title: "Participer",
    text: "Organisez une audition près de chez vous et faites entendre des voix.",
  },
];
</script>

<template>
  <div class="landing">
    <section class="hero gradient-hero">
      <div class="hero-content fade-in">
        <p class="eyebrow">Démocratie participative</p>
        <h1 class="hero-title">Auditions Citoyennes</h1>
        <p class="hero-lead">
          Nous allons à la rencontre des citoyens, sur les marchés et les places,
          pour écouter comment ils vont, comment ils voient la France, et ce qu'ils
          changeraient. Chaque parole est recueillie, vérifiée, puis partagée.
        </p>
        <div class="hero-actions">
          <button class="btn btn-light" @click="router.push('/temoignages')">
            Découvrir les témoignages
          </button>
          <button class="btn btn-ghost-light" @click="router.push('/analyses')">
            Voir les analyses
          </button>
        </div>
      </div>
    </section>

    <section class="container-page section">
      <h2 class="section-title">Les quatre questions</h2>
      <p class="section-sub">
        Une audition, c'est une conversation simple autour de quatre questions.
      </p>
      <ol class="questions">
        <li v-for="(q, i) in questions" :key="i" class="question-card">
          <span class="question-num">{{ i + 1 }}</span>
          <span class="question-text">{{ q }}</span>
        </li>
      </ol>
    </section>

    <section class="container-page section">
      <div class="cards">
        <RouterLink v-for="card in cards" :key="card.to" :to="card.to" class="explore-card">
          <h3>{{ card.title }}</h3>
          <p>{{ card.text }}</p>
          <span class="explore-arrow">→</span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing {
  display: flex;
  flex-direction: column;
}

.hero {
  padding: 5rem 1.5rem 6rem;
  color: #fff;
  text-align: center;
}

.hero-content {
  max-width: 760px;
  margin-inline: auto;
}

.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-size: 0.8rem;
  font-weight: 600;
  opacity: 0.85;
}

.hero-title {
  font-size: clamp(3rem, 8vw, 5.5rem);
  margin: 0.5rem 0 1rem;
  color: #fff;
}

.hero-lead {
  font-size: 1.15rem;
  line-height: 1.6;
  opacity: 0.95;
  max-width: 640px;
  margin-inline: auto;
}

.hero-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 2rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.7rem 1.4rem;
  border-radius: 0.6rem;
  font-weight: 600;
  border: 1px solid transparent;
  transition: var(--transition-smooth);
}

.btn-light {
  background: #fff;
  color: hsl(270 60% 40%);
}

.btn-light:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-lg);
}

.btn-ghost-light {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.4);
}

.btn-ghost-light:hover {
  background: rgba(255, 255, 255, 0.22);
}

.section {
  padding-block: 3.5rem;
}

.section-title {
  font-size: 2.2rem;
  color: hsl(var(--foreground));
}

.section-sub {
  color: hsl(var(--muted-foreground));
  margin-top: 0.35rem;
  margin-bottom: 1.75rem;
}

.questions {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.question-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem;
  border-radius: 0.75rem;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  box-shadow: var(--shadow-sm);
}

.question-num {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  background: var(--gradient-hero);
  color: #fff;
  font-family: var(--font-display);
  font-size: 1.2rem;
}

.question-text {
  font-weight: 500;
  color: hsl(var(--foreground));
}

.cards {
  display: grid;
  gap: 1.25rem;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.explore-card {
  position: relative;
  padding: 1.75rem;
  border-radius: 0.9rem;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  box-shadow: var(--shadow-sm);
  transition: var(--transition-smooth);
}

.explore-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lg);
  border-color: hsl(var(--primary) / 0.5);
}

.explore-card h3 {
  font-size: 1.6rem;
  color: hsl(var(--foreground));
  margin-bottom: 0.5rem;
}

.explore-card p {
  color: hsl(var(--muted-foreground));
}

.explore-arrow {
  position: absolute;
  top: 1.5rem;
  right: 1.5rem;
  color: hsl(var(--primary));
  font-size: 1.3rem;
}
</style>
