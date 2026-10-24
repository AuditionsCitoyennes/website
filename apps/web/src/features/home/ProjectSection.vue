<script setup lang="ts">
import { AUDITION_QUESTIONS } from "@ac/shared";
import { useSubmitTestimony } from "@/features/testify";
import { PROJECT_IMAGE as project, srcFor, srcsetFor } from "./homeImages";
import { vReveal } from "./vReveal";

const testify = useSubmitTestimony();

/**
 * A title's text in pieces, so that words joined by a hyphen ("allez-vous")
 * never break at it, and "?" stays with its word (French spacing).
 */
function unbreakable(text: string): { part: string; keep: boolean }[] {
  return text
    .replace(/ \?/g, " ?")
    .split(/(\S+-\S+)/)
    .filter(Boolean)
    .map((part) => ({ part, keep: part.includes("-") }));
}
</script>

<template>
  <section id="le-projet" class="band" tabindex="-1">
    <div class="container-page split">
      <div v-reveal class="copy">
        <p class="eyebrow">Le projet</p>
        <h2 class="title">Une plateforme,<br />vos témoignages</h2>
        <p class="lead">
          Auditions Citoyennes rassemble les témoignages de chacun, en ligne comme sur place. Des
          volontaires présents sur les marchés, sur les places ou dans tout autre lieu public
          recueillent votre avis à travers quelques questions simples. Vous avez tout le temps pour
          répondre.
        </p>
        <ol class="questions">
          <li v-for="(q, i) in AUDITION_QUESTIONS" :key="q">
            <span class="q-num" aria-hidden="true">{{ i + 1 }}</span>
            <span
              ><template v-for="(seg, j) in unbreakable(q)" :key="j"
                ><span v-if="seg.keep" class="nowrap">{{ seg.part }}</span
                ><template v-else>{{ seg.part }}</template></template
              ></span
            >
          </li>
        </ol>
        <p class="body">
          Votre adresse email&nbsp;: facultative sur place, demandée en ligne. Elle vous permet de
          relire, modifier, valider ou supprimer votre témoignage, et n'est jamais publiée. Votre
          témoignage, lui, peut l'être de façon anonyme.
        </p>
      </div>

      <figure v-reveal class="photo-card">
        <img
          :src="srcFor(project, 1200)"
          :srcset="srcsetFor(project, [640, 960, 1200, 1600])"
          sizes="(min-width: 1200px) 560px, (min-width: 900px) calc(50vw - 4rem), calc(100vw - 3rem)"
          :alt="project.alt"
          :style="{ objectPosition: project.position ?? '50% 50%' }"
          loading="lazy"
          decoding="async"
        />
        <div class="photo-shade" aria-hidden="true"></div>
        <figcaption class="photo-cta">
          <p class="catch">Votre opinion compte</p>
          <p class="catch-sub">Partagez votre témoignage.</p>
          <button type="button" class="cta-btn" @click="testify.show()">
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            Témoigner
          </button>
        </figcaption>
        <p class="credit credit--in">Photo&nbsp;: {{ project.credit }}</p>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.nowrap {
  white-space: nowrap;
}

.body {
  margin-top: 1.4rem;
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

/* Equal rows (the tallest sets them all): the numbers fall at an even pitch
   whether a question takes one line or two. */
.questions {
  list-style: none;
  margin: 1.6rem 0 0;
  padding: 0;
  display: grid;
  grid-auto-rows: 1fr;
  gap: 0.65rem;
}

/* The number on the baseline of the question's first line. */
.questions li {
  display: flex;
  align-items: baseline;
  gap: 0.85rem;
  font-family: var(--font-display);
  font-size: var(--text-title);
  letter-spacing: 0.02em;
  line-height: 1.1;
  color: hsl(var(--foreground));
}

.q-num {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  background: var(--gradient-hero);
  color: #fff;
  /* Too small for Bebas (which the question line sets): sans, semibold. */
  font-family: var(--font-sans);
  font-size: var(--text-body);
  font-weight: 600;
  letter-spacing: normal;
}

.photo-card {
  position: relative;
  margin: 0;
  /* Landscape: a conversation is people side by side — a tall crop keeps one
     of them and cuts the others out. */
  aspect-ratio: 4 / 3.3;
  border-radius: 1.5rem;
  overflow: hidden;
  box-shadow: var(--shadow-2xl);
  background: hsl(var(--muted));
}

.photo-card img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 1.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.photo-card:hover img {
  transform: scale(1.03);
}

.photo-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to top,
    rgb(12 8 22 / 0.88) 0%,
    rgb(12 8 22 / 0.35) 32%,
    transparent 55%
  );
}

.photo-cta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* Low in the frame: the faces of the people talking stay clear above it. */
  padding: clamp(1.2rem, 2.4vw, 1.7rem);
  color: #fff;
}

.catch {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-section);
  line-height: 0.95;
  letter-spacing: 0.02em;
}

.catch-sub {
  margin: 0.45rem 0 1rem;
  font-size: var(--text-body);
  color: rgb(255 255 255 / 0.85);
}

/* ---- Phones and tablets ------------------------------------------------------- */
@media (max-width: 899px) {
  .photo-card {
    aspect-ratio: 4 / 4.6;
  }
}

/* The smallest phones: the photo's caption must fit in its card. */
@media (max-width: 380px) {
  .photo-card {
    aspect-ratio: 3 / 4.4;
  }
}

@media (prefers-reduced-motion: reduce) {
  .photo-card img {
    transition: none;
  }
}
</style>
