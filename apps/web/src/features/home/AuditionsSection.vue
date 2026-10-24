<script setup lang="ts">
import { useAuthStore } from "@/features/auth";
import { STEPS as steps } from "./content";
import { vReveal } from "./vReveal";

const auth = useAuthStore();
</script>

<template>
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
          validée, vous pourrez publier les auditions que vous menez et les témoignages recueillis.
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
</template>

<style scoped>
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

/* ---- Phones and tablets ------------------------------------------------------- */
@media (max-width: 899px) {
  /* One under the other, full width, rather than squeezed side by side. */
  .join-actions .cta-btn {
    flex: 1 1 100%;
  }
}
</style>
