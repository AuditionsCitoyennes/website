<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useSubmitTestimony } from "@/features/testify";
import { ROUTE } from "@/shared/routes";
import { HERO_IMAGE as hero, srcFor, srcsetFor } from "./homeImages";

// `ready` once the photograph is shown — or could not be: at once when it is
// there already (cached, or decoded before this ran), else when it loads or
// fails. The map card's "tot" policy waits for it (useMapCardSlot, testing tools only).
const emit = defineEmits<{ ready: [] }>();

const heroImg = ref<HTMLImageElement | null>(null);
let stopWaiting: (() => void) | null = null;

onMounted(() => {
  const img = heroImg.value;
  if (!img || img.complete) {
    emit("ready");
    return;
  }
  const shown = () => {
    stopWaiting?.();
    emit("ready");
  };
  img.addEventListener("load", shown);
  img.addEventListener("error", shown);
  stopWaiting = () => {
    img.removeEventListener("load", shown);
    img.removeEventListener("error", shown);
    stopWaiting = null;
  };
});
onBeforeUnmount(() => stopWaiting?.());

const testify = useSubmitTestimony();

/**
 * "Découvrir" (to the project) and the organise link (to the public
 * auditions): glide down to the band (the link alone would jump there).
 * Focus follows, for the keyboard. Reduced motion: straight there.
 */
function glideTo(e: MouseEvent, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  e.preventDefault();
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  target.focus({ preventScroll: true });
}
</script>

<template>
  <section
    class="hero"
    :class="{ 'hero--top': hero.textAt === 'top' }"
    aria-labelledby="hero-title"
  >
    <img
      ref="heroImg"
      class="hero-img"
      :src="srcFor(hero, 1920)"
      :srcset="srcsetFor(hero, [960, 1440, 1920, 2560])"
      sizes="(max-aspect-ratio: 3/2) calc((100vh - 4rem) * 1.5), 100vw"
      :alt="hero.alt"
      :style="{ objectPosition: hero.position ?? '50% 50%' }"
      fetchpriority="high"
      decoding="async"
    />
    <div class="hero-shade" aria-hidden="true"></div>
    <div class="hero-content container-page">
      <h1 id="hero-title" class="hero-title">Auditions<br />Citoyennes</h1>
      <p class="hero-slogan">Chaque voix compte</p>
      <p class="hero-message">
        La parole de chacun est recueillie telle quelle, puis mise en commun pour qu'elle pèse.
        Lisez les témoignages, ajoutez le vôtre ou
        <a href="#auditions-publiques" @click="glideTo($event, 'auditions-publiques')"
          >organisez des auditions</a
        >.
      </p>
      <div class="hero-actions">
        <button type="button" class="cta-btn" @click="testify.show()">Témoigner</button>
        <RouterLink :to="ROUTE.temoignages.path" class="cta-btn cta-btn--ghost">
          Lire les témoignages
        </RouterLink>
      </div>
    </div>
    <a href="#le-projet" class="hero-next" @click="glideTo($event, 'le-projet')">
      Découvrir
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
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </a>
    <p class="credit">Photo&nbsp;: {{ hero.credit }}</p>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  /* The whole screen under the header. */
  min-height: calc(100svh - 4rem);
  display: flex;
  align-items: flex-end;
  overflow: hidden;
  color: #fff;
  background: hsl(260 30% 8%);
}

.hero-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: hero-in 1.6s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes hero-in {
  from {
    opacity: 0;
    transform: scale(1.06);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.hero-shade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(to top, rgb(12 8 22 / 0.88) 0%, rgb(12 8 22 / 0.35) 45%, transparent 75%),
    linear-gradient(to right, rgb(12 8 22 / 0.5), transparent 60%);
}

.hero-content {
  position: relative;
  padding-block: 6rem 7.5rem;
}

/* The title at the top (a photo whose people fill its lower part): the shade
   comes from the top, and the people below stay as bright as they are. */
.hero--top {
  align-items: flex-start;
}

/* The text keeps its height when the window is short, but the hero does not:
   the shade then holds down to below the text (27rem) instead of fading
   over its last lines. From a full screen up, the percentages win. */
.hero--top .hero-shade {
  --shade-hold: 27rem;
  --shade-end: 31rem;
  background:
    linear-gradient(
      to bottom,
      rgb(12 8 22 / 0.8) 0%,
      rgb(12 8 22 / 0.6) 30%,
      rgb(12 8 22 / 0.6) max(52%, var(--shade-hold)),
      transparent max(60%, var(--shade-end))
    ),
    linear-gradient(to top, rgb(12 8 22 / 0.35) 0%, transparent 18%);
}

/* All of the text in that band: a little tighter than over a calm photo. */
.hero--top .hero-slogan {
  margin-top: 0.7rem;
}

.hero--top .hero-message {
  margin-top: 0.6rem;
}

.hero--top .hero-actions {
  margin-top: 1rem;
}

.hero--top .hero-content {
  padding-block: clamp(1.8rem, 5vh, 3.5rem) 6rem;
}

.hero-title {
  margin: 0;
  font-size: var(--text-display);
  line-height: 0.88;
  letter-spacing: 0.02em;
  color: #fff;
  text-shadow: 0 2px 30px rgb(0 0 0 / 0.35);
  animation: rise-in 1s cubic-bezier(0.22, 1, 0.36, 1) 0.25s both;
}

.hero-slogan {
  margin-top: 1.1rem;
  max-width: 34rem;
  font-size: var(--text-lead);
  line-height: 1.35;
  font-weight: 500;
  color: rgb(255 255 255 / 0.92);
  text-shadow: 0 1px 14px rgb(0 0 0 / 0.55);
  animation: rise-in 1s cubic-bezier(0.22, 1, 0.36, 1) 0.45s both;
}

/* Why it matters, and what can be done here: reading text, under the slogan. */
.hero-message {
  margin-top: 1rem;
  max-width: 32rem;
  font-size: var(--text-body);
  line-height: var(--lh-body);
  color: rgb(255 255 255 / 0.92);
  text-shadow: 0 1px 14px rgb(0 0 0 / 0.55);
  animation: rise-in 1s cubic-bezier(0.22, 1, 0.36, 1) 0.65s both;
}

.hero-message a {
  color: #fff;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  margin-top: 1.4rem;
  animation: rise-in 1s cubic-bezier(0.22, 1, 0.36, 1) 0.65s both;
}

/* On the photo, whatever the theme (as the volunteers' block on its dark ground). */
.hero-actions .cta-btn--ghost {
  border-color: rgb(255 255 255 / 0.5);
  color: #fff;
}

.hero-actions .cta-btn--ghost:hover {
  background: rgb(255 255 255 / 0.14);
}

/* The site's ring colour is weak on the dark shade: white here. */
.hero :focus-visible {
  outline: 2px solid #fff;
  outline-offset: 3px;
}

/* The buttons can sit over a bright part of the photo: the ring then gets a
   dark edge on its inner side. */
.hero-actions .cta-btn:focus-visible {
  box-shadow: 0 0 0 5px rgb(12 8 22 / 0.6);
}

@keyframes rise-in {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.hero-next {
  position: absolute;
  left: 50%;
  bottom: 1.6rem;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgb(255 255 255 / 0.8);
}

.hero-next svg {
  animation: nudge 2.2s ease-in-out infinite;
}

.hero-next:hover {
  color: #fff;
}

@keyframes nudge {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(5px);
  }
}

/* ---- Phones and tablets ------------------------------------------------------- */
@media (max-width: 899px) {
  .hero-content {
    padding-block: 5rem 6.5rem;
  }

  /* The header floats over the photo here (AppHeader): the photo takes the
     whole screen, and its title starts below the header's tiles. */
  .hero {
    min-height: 100svh;
  }

  .hero--top .hero-content {
    padding-top: calc(var(--header-space) + clamp(1rem, 3vh, 2rem));
  }

  /* The photo takes the whole screen: the shade follows it alone. */
  .hero--top .hero-shade {
    --shade-hold: 0rem;
    --shade-end: 0rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-img,
  .hero-title,
  .hero-slogan,
  .hero-message,
  .hero-actions,
  .hero-next svg {
    animation: none;
  }
}
</style>
