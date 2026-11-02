<script setup lang="ts">
import { useSubmitTestimony } from "@/features/testify";
import { ROUTE } from "@/shared/routes";
import { useToast } from "@/shared/ui/toast/useToast";
import { COSTS, DONATION_PLATFORM, DONATION_URL, RECIPIENT } from "../content";

const testify = useSubmitTestimony();
const { toast } = useToast();

// "En parler": the phone's share sheet where there is one, else the site's
// address copied.
async function shareSite() {
  const url = window.location.origin;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Auditions Citoyennes", url });
    } catch {
      // Closed without sharing: nothing to say.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast({ title: "Lien copié", description: url });
  } catch {
    toast({ title: "Copie impossible", description: url, variant: "destructive" });
  }
}
</script>

<template>
  <div class="support container-page">
    <header class="intro">
      <p class="eyebrow">Nous soutenir</p>
      <h1 class="title">Faites vivre<br />la plateforme</h1>
      <p class="lead">
        Auditions Citoyennes est un projet bénévole, sans publicité et sans financement. Vos dons
        paient ce qui fait tourner le site, rien d'autre.
      </p>
    </header>

    <div class="grid">
      <section class="card donate" aria-labelledby="donate-title">
        <h2 id="donate-title" class="card-title">Ce que paient vos dons</h2>
        <ul class="costs">
          <li v-for="c in COSTS" :key="c.title" class="cost">
            <span class="cost-dot" aria-hidden="true"></span>
            <div>
              <p class="cost-title">{{ c.title }}</p>
              <p class="cost-text">{{ c.text }}</p>
            </div>
          </li>
        </ul>

        <a
          v-if="DONATION_URL"
          :href="DONATION_URL"
          target="_blank"
          rel="noopener"
          class="cta"
          :aria-label="`Faire un don sur ${DONATION_PLATFORM} (nouvel onglet)`"
        >
          Faire un don sur {{ DONATION_PLATFORM }}
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
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </a>
        <p v-else class="soon">Le lien pour faire un don arrive très bientôt.</p>
      </section>

      <aside class="card notice" aria-labelledby="notice-title">
        <h2 id="notice-title" class="card-title">Où va votre don&nbsp;?</h2>
        <p>
          Le projet n'a pas encore d'association. En attendant qu'elle soit créée, les dons arrivent
          sur le compte personnel de {{ RECIPIENT }}, qui porte le projet. Ils servent uniquement à
          payer les frais du site.
        </p>
        <p>
          <strong>Pas de reçu fiscal.</strong> Un don à une personne ne donne pas droit à une
          réduction d'impôt.
        </p>
        <p>Dès que l'association existera, les dons iront directement à elle.</p>
      </aside>
    </div>

    <section class="other" aria-labelledby="other-title">
      <h2 id="other-title" class="other-title">D'autres façons d'aider</h2>
      <ul class="ways">
        <li class="way">
          <h3 class="way-title">Témoigner</h3>
          <p class="way-text">
            Quelques questions simples, et tout le temps qu'il vous faut pour y répondre.
          </p>
          <button type="button" class="way-btn" @click="testify.show()">
            Partager mon témoignage
          </button>
        </li>
        <li class="way">
          <h3 class="way-title">Devenir volontaire</h3>
          <p class="way-text">Tenez des auditions près de chez vous, sur un marché ou une place.</p>
          <RouterLink
            :to="{ path: ROUTE.auth.path, query: { tab: 'inscription' } }"
            class="way-btn"
          >
            Rejoindre les volontaires
          </RouterLink>
        </li>
        <li class="way">
          <h3 class="way-title">En parler</h3>
          <p class="way-text">
            Plus il y a de témoignages, plus ils comptent. Faites connaître la plateforme.
          </p>
          <button type="button" class="way-btn" @click="shareSite">Partager le site</button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.support {
  display: flex;
  flex-direction: column;
  gap: clamp(2.5rem, 6vw, 4.5rem);
  padding-block: clamp(2.5rem, 7vw, 5.5rem);
}

/* ---- Intro ------------------------------------------------------------------ */
.intro {
  max-width: 44rem;
}

.eyebrow {
  margin-bottom: 0.8rem;
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: hsl(var(--primary));
}

.title {
  margin-bottom: 1.2rem;
  line-height: 0.95;
}

.lead {
  font-size: var(--text-lead);
  line-height: var(--lh-body);
  color: hsl(var(--foreground) / 0.85);
}

/* ---- The two cards ------------------------------------------------------------ */
.grid {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  align-items: start;
  gap: 1.5rem;
}

.card {
  padding: clamp(1.5rem, 3vw, 2.25rem);
  border: 1px solid hsl(var(--border));
  border-radius: 1.25rem;
}

.card-title {
  margin-bottom: 1.2rem;
  font-size: var(--text-title);
}

.donate {
  background: hsl(var(--card));
  box-shadow: var(--shadow-lg);
}

.costs {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.2rem 1.5rem;
}

.cost {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.75rem;
}

.cost-dot {
  width: 0.6rem;
  height: 0.6rem;
  margin-top: 0.5rem;
  border-radius: 50%;
  background: var(--gradient-hero);
}

.cost-title {
  font-weight: 600;
  color: hsl(var(--foreground));
}

.cost-text {
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

.cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 3rem;
  margin-top: 1.8rem;
  padding: 0.55rem 1.5rem;
  border-radius: 999px;
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-weight: 700;
  font-size: var(--text-ui);
  transition:
    transform 0.25s ease,
    box-shadow 0.25s ease,
    filter 0.25s ease;
}

.cta:hover {
  transform: translateY(-2px);
  filter: brightness(1.08);
  box-shadow: var(--shadow-glow);
}

.soon {
  margin-top: 1.8rem;
  padding: 0.85rem 1.1rem;
  border: 1px dashed hsl(var(--border));
  border-radius: 0.75rem;
  color: hsl(var(--muted-foreground));
}

.notice {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  border-color: hsl(var(--primary) / 0.3);
  background: hsl(var(--accent) / 0.6);
  line-height: var(--lh-body);
}

.notice .card-title {
  margin-bottom: 0.3rem;
}

.notice strong {
  color: hsl(var(--foreground));
}

/* ---- Other ways to help ---------------------------------------------------------- */
.other-title {
  margin-bottom: 1.5rem;
}

.ways {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}

.way {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1.5rem;
  border: 1px solid hsl(var(--border));
  border-radius: 1.25rem;
  background: var(--gradient-card);
}

.way-text {
  flex: 1;
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

.way-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  margin-top: 0.4rem;
  padding: 0.5rem 1.2rem;
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  background: transparent;
  color: hsl(var(--foreground));
  font-weight: 600;
  font-size: var(--text-ui);
  transition: var(--transition-smooth);
}

.way-btn:hover {
  background: hsl(var(--accent) / 0.6);
}

/* ---- Phones and tablets ------------------------------------------------------------ */
@media (max-width: 899px) {
  .grid,
  .ways {
    grid-template-columns: 1fr;
  }

  .cta {
    width: 100%;
  }
}

@media (max-width: 559px) {
  .costs {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cta,
  .way-btn {
    transition: none;
  }
}
</style>
