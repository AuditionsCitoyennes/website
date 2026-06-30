<script setup lang="ts">
const questions = [
  {
    q: "Comment allez-vous ?",
    hint: "Une entrée en matière simple et humaine, pour ouvrir le dialogue.",
  },
  {
    q: "Comment trouvez-vous que la France va ?",
    hint: "On passe du ressenti personnel au regard sur la société.",
  },
  {
    q: "Si vous pouviez changer les choses, que feriez-vous ?",
    hint: "La question qui fait émerger les propositions et les priorités.",
  },
  {
    q: "Puis-je vous demander votre adresse email ?",
    hint: "Pour envoyer un lien de vérification et publier le témoignage avec son accord.",
  },
];
</script>

<template>
  <div class="container-page page">
    <header class="page-head">
      <h1>Participer</h1>
      <p class="lead">
        Une audition citoyenne, c'est aller à la rencontre des gens là où ils sont
        et les écouter vraiment. Voici comment faire.
      </p>
    </header>

    <section class="block">
      <h2>Les quatre questions</h2>
      <ol class="questions">
        <li v-for="(item, i) in questions" :key="i" class="question">
          <span class="num">{{ i + 1 }}</span>
          <div>
            <p class="q">{{ item.q }}</p>
            <p class="hint">{{ item.hint }}</p>
          </div>
        </li>
      </ol>
    </section>

    <section class="block">
      <h2>Notez à la main</h2>
      <p>
        Prenez des notes sur papier pendant l'échange. C'est plus chaleureux qu'un
        écran, ça met les gens en confiance et ça les encourage à partager.
      </p>
    </section>

    <section class="block">
      <h2>Publiez les témoignages</h2>
      <p>
        Connectez-vous à votre compte, créez une audition (date et lieu) et ajoutez
        les témoignages recueillis. Chaque personne ayant laissé son email reçoit un
        lien pour relire, corriger et valider son témoignage avant publication.
      </p>
      <div class="cta">
        <RouterLink to="/auth" class="btn btn-primary">Créer un compte / Se connecter</RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  padding-block: 3rem;
  max-width: 820px;
}

.page-head h1 {
  font-size: 3rem;
  color: hsl(var(--foreground));
}

.lead {
  color: hsl(var(--muted-foreground));
  font-size: 1.1rem;
  margin-top: 0.5rem;
}

.block {
  margin-top: 2.5rem;
}

.block h2 {
  font-size: 1.7rem;
  color: hsl(var(--foreground));
  margin-bottom: 0.75rem;
}

.block p {
  color: hsl(var(--foreground));
  line-height: 1.65;
}

.questions {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.question {
  display: flex;
  gap: 1rem;
  padding: 1.25rem;
  border-radius: 0.75rem;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  box-shadow: var(--shadow-sm);
}

.num {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  background: var(--gradient-hero);
  color: #fff;
  font-family: var(--font-display);
}

.q {
  font-weight: 600;
  color: hsl(var(--foreground));
}

.hint {
  color: hsl(var(--muted-foreground)) !important;
  font-size: 0.95rem;
  margin-top: 0.2rem;
}

.cta {
  margin-top: 1.25rem;
}

.btn {
  display: inline-flex;
  padding: 0.7rem 1.4rem;
  border-radius: 0.6rem;
  font-weight: 600;
  transition: var(--transition-smooth);
}

.btn-primary {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

.btn-primary:hover {
  filter: brightness(1.08);
  box-shadow: var(--shadow-glow);
}
</style>
