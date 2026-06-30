<script setup lang="ts"></script>

<template>
  <div class="notfound container-page">
    <h1>404</h1>
    <p>Cette page n'existe pas.</p>
    <RouterLink to="/" class="btn">Retour à l'accueil</RouterLink>
  </div>
</template>

<style scoped>
.notfound {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding-block: 5rem;
  text-align: center;
}

.notfound h1 {
  font-size: 5rem;
  color: hsl(var(--primary));
}

.notfound p {
  color: hsl(var(--muted-foreground));
}

.btn {
  margin-top: 0.5rem;
  padding: 0.6rem 1.3rem;
  border-radius: 0.6rem;
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-weight: 600;
}
</style>
