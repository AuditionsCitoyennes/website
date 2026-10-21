<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type Directive } from "vue";
import { AUDITION_QUESTIONS } from "@ac/shared";
import { useAuthStore } from "@/features/auth";
import { useMapStage } from "@/composables/useMapStage";
import { useSubmitTestimony } from "@/features/testify";
import { HERO_IMAGE as hero, PROJECT_IMAGE as project, srcFor, srcsetFor } from "./homeImages";

const auth = useAuthStore();
const testify = useSubmitTestimony();
const stage = useMapStage();

// ---- The map card: lent to the one testimonies map (MapStage) -------------
// Taken once the page itself is in — the document loaded, the hero photograph
// shown (the map must not compete with it) — and the browser has a moment: the
// map loads meanwhile, and is ready to be opened into the testimonies page by
// the time it is reached. Reached before that (a quick scroll): at once. And
// at once when the map already exists (back from /temoignages: it comes
// straight back into its card).
const mapCard = ref<HTMLElement | null>(null);
const heroImg = ref<HTMLImageElement | null>(null);
let cardIO: IntersectionObserver | null = null;
let idleId = 0;
let timerId = 0;
let waiting: { target: EventTarget; type: string; fn: () => void }[] = [];

function stopWaiting() {
  cardIO?.disconnect();
  cardIO = null;
  for (const w of waiting) w.target.removeEventListener(w.type, w.fn);
  waiting = [];
  if (idleId) window.cancelIdleCallback(idleId);
  idleId = 0;
  window.clearTimeout(timerId);
}

/** `fn` once `target` fires `type` (or any of `types`) — forgotten on unmount. */
function once(target: EventTarget, types: string[], fn: () => void) {
  const run = () => {
    for (const w of waiting.filter((w) => w.fn === run)) w.target.removeEventListener(w.type, run);
    waiting = waiting.filter((w) => w.fn !== run);
    fn();
  };
  for (const type of types) {
    target.addEventListener(type, run);
    waiting.push({ target, type, fn: run });
  }
}

onMounted(() => {
  const el = mapCard.value;
  if (!el) return;
  if (stage.alive.value) {
    stage.card.value = el;
    return;
  }
  const take = () => {
    stopWaiting();
    if (mapCard.value === el && !stage.card.value) stage.card.value = el;
  };
  cardIO = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) take();
    },
    { rootMargin: "300px 0px" },
  );
  cardIO.observe(el);
  const whenIdle = () => {
    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(take, { timeout: 2000 });
    } else timerId = setTimeout(take, 200) as unknown as number;
  };
  const afterHero = () => {
    const img = heroImg.value;
    if (!img || img.complete) whenIdle();
    else once(img, ["load", "error"], whenIdle);
  };
  if (document.readyState === "complete") afterHero();
  else once(window, ["load"], afterHero);
});
onBeforeUnmount(() => {
  stopWaiting();
  stage.release(stage.card, mapCard.value);
});

// ---- Sections come in as they are scrolled to ------------------------------
const vReveal: Directive<HTMLElement> = {
  mounted(el) {
    el.classList.add("reveal");
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        el.classList.add("revealed");
        io.disconnect();
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    (el as HTMLElement & { _reveal?: IntersectionObserver })._reveal = io;
  },
  unmounted(el) {
    (el as HTMLElement & { _reveal?: IntersectionObserver })._reveal?.disconnect();
  },
};

/**
 * A title's text in pieces, so that words joined by a hyphen ("allez-vous")
 * never break at it, and "?" stays with its word (French spacing).
 */
function unbreakable(text: string): { part: string; keep: boolean }[] {
  return text
    .replace(/ \?/g, "\u00a0?")
    .split(/(\S+-\S+)/)
    .filter(Boolean)
    .map((part) => ({ part, keep: part.includes("-") }));
}

/**
 * "Découvrir": glide down to the project (the link alone would jump there).
 * Focus follows, for the keyboard. Reduced motion: straight there.
 */
function toProject(e: MouseEvent) {
  const target = document.getElementById("le-projet");
  if (!target) return;
  e.preventDefault();
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  target.focus({ preventScroll: true });
}

const steps = [
  {
    title: "Des volontaires s'installent dans un lieu public",
    text: "Un marché, une place, un parvis\u00a0: quelques affiches vous signalent que nous sommes là pour écouter.",
  },
  {
    title: "On recueille votre témoignage",
    text: "À travers quelques questions, on vous écoute, sans débattre ni chercher à convaincre. Chacun répond comme il le veut, aussi longtemps qu'il le veut.",
  },
  {
    title: "On prend note",
    text: "À l'écrit ou avec un micro, on note vos réponses en entier\u00a0: rien n'est coupé.",
  },
  {
    title: "On publie",
    text: "L'audition est mise en ligne avec ses témoignages. Ceux qui ont laissé leur email reçoivent un lien pour relire, modifier, valider ou supprimer le leur.",
  },
];
</script>

<template>
  <!-- While its map card grows into the map page, the rest of the page fades
       away — and nothing in it can be reached any more. -->
  <div class="landing" :inert="Boolean(stage.opening.value) || undefined">
    <!-- 1. Full screen: the photograph, the name, the promise. -->
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
      </div>
      <a href="#le-projet" class="hero-next" @click="toProject">
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

    <!-- 2. The project — and the invitation to testify. -->
    <section id="le-projet" class="band" tabindex="-1">
      <div class="container-page split">
        <div v-reveal class="copy">
          <p class="eyebrow">Le projet</p>
          <h2 class="title">Une plateforme,<br />vos témoignages</h2>
          <p class="lead">
            Auditions Citoyennes rassemble les témoignages de chacun, en ligne comme sur place. Des
            volontaires présents sur les marchés, sur les places ou dans tout autre lieu public
            recueillent votre avis à travers quelques questions simples. Vous avez tout le temps
            pour répondre.
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

    <!-- 3. What becomes of the testimonies — beside the map itself. -->
    <section id="les-temoignages" class="band band--alt">
      <div class="container-page split split--reverse">
        <div v-reveal class="copy">
          <p class="eyebrow">Les témoignages</p>
          <h2 class="title">Une parole publiée,<br />placée sur la carte</h2>
          <p class="lead">
            Chaque témoignage recueilli lors d'une audition publique y est rattaché, avec son lieu
            et sa date. Chaque témoignage déposé en ligne rejoint l'audition en ligne de sa commune
            pour le mois en cours.
          </p>
          <p class="lead lead--next">
            Chaque audition est ensuite placée sur notre carte. Ensemble, elles dessinent l'opinion
            de nos villes, de nos départements, de nos régions&nbsp;: de notre pays.
          </p>
          <ul class="points">
            <li>
              Publiés tels quels, sous le nom ou le pseudonyme choisi par la personne, ou sous
              «&nbsp;Anonyme&nbsp;».
            </li>
            <li>
              Validés par leurs auteurs quand ils ont laissé leur email&nbsp;: un lien leur permet
              de relire, modifier, valider ou supprimer leur témoignage.
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
    </section>

    <!-- 4. Public auditions: how they are held — and joining in. -->
    <section id="auditions-publiques" class="band">
      <div class="container-page split">
        <div v-reveal class="copy">
          <p class="eyebrow">Les auditions publiques</p>
          <h2 class="title">Comment se passe<br />une audition</h2>
          <ol class="steps">
            <li v-for="(s, i) in steps" :key="s.title">
              <span class="step-num" aria-hidden="true">{{ String(i + 1).padStart(2, "0") }}</span>
              <div>
                <h3 class="step-title">{{ s.title }}</h3>
                <p class="step-text">{{ s.text }}</p>
              </div>
            </li>
          </ol>
        </div>

        <aside v-reveal class="join">
          <p class="join-kicker">Devenez volontaire</p>
          <h3 class="join-title">Organisez des auditions près de chez vous</h3>
          <p class="join-text">
            Rejoignez l'équipe des volontaires. Créez votre compte&nbsp;: une fois votre inscription
            validée, vous pourrez publier les auditions que vous menez et les témoignages
            recueillis.
          </p>
          <!-- Who is visiting is known only once the session is read: until
               then, the room for the buttons is kept and nothing is offered. -->
          <div v-if="auth.loading" class="join-actions join-actions--wait" aria-hidden="true">
            <span class="cta-btn cta-btn--primary">&nbsp;</span>
          </div>
          <div v-else class="join-actions">
            <template v-if="auth.isAdmin">
              <RouterLink to="/admin" class="cta-btn cta-btn--primary">
                Mon espace volontaire
              </RouterLink>
            </template>
            <template v-else-if="auth.user">
              <RouterLink to="/admin" class="cta-btn cta-btn--primary">
                Suivre mon inscription
              </RouterLink>
            </template>
            <template v-else>
              <RouterLink
                :to="{ path: '/auth', query: { tab: 'inscription' } }"
                class="cta-btn cta-btn--primary"
              >
                Devenir volontaire
              </RouterLink>
              <RouterLink to="/auth" class="cta-btn cta-btn--ghost">J'ai déjà un compte</RouterLink>
            </template>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing {
  display: flex;
  flex-direction: column;
  transition: opacity 0.4s ease;
}

/* The map card opening into the map page (MapStage): everything else goes. */
:global(html.map-opening) .landing {
  opacity: 0;
}

/* ---- 1. Hero --------------------------------------------------------------- */
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

.hero--top .hero-shade {
  background:
    linear-gradient(
      to bottom,
      rgb(12 8 22 / 0.8) 0%,
      rgb(12 8 22 / 0.55) 28%,
      rgb(12 8 22 / 0.15) 46%,
      transparent 56%
    ),
    linear-gradient(to top, rgb(12 8 22 / 0.35) 0%, transparent 18%);
}

/* All of the text in that band: a little tighter than over a calm photo. */
.hero--top .hero-slogan {
  margin-top: 0.7rem;
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

.credit {
  position: absolute;
  right: 1rem;
  bottom: 0.7rem;
  margin: 0;
  font-size: var(--text-caption);
  color: rgb(255 255 255 / 0.6);
}

.nowrap {
  white-space: nowrap;
}

/* ---- Bands --------------------------------------------------------------- */
.band {
  padding-block: clamp(4rem, 9vw, 7.5rem);
  scroll-margin-top: 4rem;
}

/* Focused only by script (the "Découvrir" link): no ring around the band. */
.band:focus {
  outline: none;
}

.band--alt {
  background: var(--gradient-surface);
}

.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  gap: clamp(2.5rem, 6vw, 5.5rem);
}

/* The other side first: the bands alternate. */
.split--reverse > :first-child {
  order: 2;
}

.eyebrow {
  margin: 0 0 0.8rem;
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: hsl(var(--primary));
}

.title {
  margin: 0 0 1.4rem;
  font-size: var(--text-page);
  line-height: 0.95;
  color: hsl(var(--foreground));
}

.lead {
  font-size: var(--text-lead);
  line-height: var(--lh-body);
  color: hsl(var(--foreground) / 0.85);
}

/* A second paragraph after the intro: reading text, no longer the lead. */
.lead--next {
  margin-top: 0.9rem;
  font-size: var(--text-body);
  line-height: var(--lh-body);
}

.body {
  margin-top: 1.4rem;
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

/* ---- 2. The project ------------------------------------------------------- */
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

.credit--in {
  top: 0.8rem;
  bottom: auto;
}

/* ---- Buttons ---------------------------------------------------------------- */
.cta-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 3rem;
  padding: 0.55rem 1.4rem;
  border: 1px solid transparent;
  border-radius: 999px;
  text-align: center;
  background: #fff;
  color: hsl(270 60% 35%);
  font-weight: 700;
  font-size: var(--text-ui);
  cursor: pointer;
  transition:
    transform 0.25s ease,
    box-shadow 0.25s ease,
    filter 0.25s ease;
}

.cta-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.3);
}

.cta-btn--primary {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

.cta-btn--primary:hover {
  filter: brightness(1.08);
  box-shadow: var(--shadow-glow);
}

.cta-btn--ghost {
  background: transparent;
  border-color: hsl(var(--border));
  color: hsl(var(--foreground));
}

.cta-btn--ghost:hover {
  background: hsl(var(--accent) / 0.5);
  box-shadow: none;
}

/* ---- 3. The testimonies ------------------------------------------------------ */
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

/* ---- 4. Public auditions ---------------------------------------------------- */
.steps {
  list-style: none;
  margin: 0.4rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1.6rem;
}

.steps li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1.1rem;
}

.step-num {
  font-family: var(--font-display);
  font-size: var(--text-section);
  line-height: 0.9;
  color: hsl(var(--primary) / 0.55);
}

.step-title {
  margin: 0 0 0.3rem;
  font-size: var(--text-title);
  color: hsl(var(--foreground));
}

.step-text {
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

/* Centred against the steps beside it (the grid row aligns its items). */
.join {
  padding: clamp(1.8rem, 3vw, 2.6rem);
  border-radius: 1.5rem;
  color: #fff;
  /* The hero gradient's hues, deep enough for white text (AA) in both themes. */
  background: linear-gradient(135deg, hsl(270 55% 36%) 0%, hsl(290 50% 40%) 100%);
  box-shadow: var(--shadow-2xl);
}

.join-kicker {
  margin: 0 0 0.6rem;
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgb(255 255 255 / 0.8);
}

.join-title {
  margin: 0 0 0.9rem;
  font-size: var(--text-section);
  line-height: 0.95;
  color: #fff;
}

.join-text {
  line-height: var(--lh-body);
  color: rgb(255 255 255 / 0.9);
}

.join-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  margin-top: 1.6rem;
}

.join-actions--wait .cta-btn {
  visibility: hidden;
}

.join .cta-btn--primary {
  background: #fff;
  color: hsl(270 60% 35%);
}

.join .cta-btn--ghost {
  border-color: rgb(255 255 255 / 0.5);
  color: #fff;
}

.join .cta-btn--ghost:hover {
  background: rgb(255 255 255 / 0.14);
}

/* ---- Coming in on scroll ------------------------------------------------------ */
.reveal {
  opacity: 0;
  translate: 0 28px;
  transition:
    opacity 0.8s ease,
    translate 0.9s cubic-bezier(0.22, 1, 0.36, 1);
}

.reveal.revealed {
  opacity: 1;
  translate: 0 0;
}

.split > .reveal:nth-child(2) {
  transition-delay: 0.12s;
}

/* ---- Phones and tablets ------------------------------------------------------- */
@media (max-width: 899px) {
  .split {
    grid-template-columns: 1fr;
  }

  .split--reverse > :first-child {
    order: 0;
  }

  .photo-card {
    aspect-ratio: 4 / 4.6;
  }

  .map-card {
    aspect-ratio: 1 / 1;
  }

  /* Bullets of several lines each: equal rows would pad them with blanks. */
  .points {
    grid-auto-rows: auto;
  }

  /* One under the other, full width, rather than squeezed side by side. */
  .join-actions .cta-btn {
    flex: 1 1 100%;
  }

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
}

/* The smallest phones: the photo's caption must fit in its card. */
@media (max-width: 380px) {
  .photo-card {
    aspect-ratio: 3 / 4.4;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-img,
  .hero-title,
  .hero-slogan,
  .hero-next svg {
    animation: none;
  }

  .reveal {
    opacity: 1;
    translate: none;
    transition: none;
  }

  .landing,
  .photo-card img,
  .cta-btn {
    transition: none;
  }
}
</style>
