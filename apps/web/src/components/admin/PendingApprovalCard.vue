<script setup lang="ts">
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

async function handleSignOut() {
  await auth.signOut();
  router.push("/auth");
}
</script>

<template>
  <section class="pending-card">
    <h2 class="pending-title">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        width="20"
        height="20"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      Inscription en cours de traitement
    </h2>

    <div class="steps">
      <div class="step">
        <span class="step-icon done">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="18"
            height="18"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        <div>
          <p class="step-label done">Email vérifié</p>
          <p class="step-desc">Votre adresse email a été confirmée</p>
        </div>
      </div>

      <div class="step">
        <span class="step-icon current">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="18"
            height="18"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </span>
        <div>
          <p class="step-label current">Validation en cours</p>
          <p class="step-desc">Un administrateur examinera votre demande sous 24 à 48 heures</p>
        </div>
      </div>

      <div class="step">
        <span class="step-icon todo">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="18"
            height="18"
          >
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
            <polyline points="22,6 12,13 2,6" />
          </svg>
        </span>
        <div>
          <p class="step-label">Notification par email</p>
          <p class="step-desc">Vous recevrez un email dès que votre compte sera validé</p>
        </div>
      </div>
    </div>

    <button type="button" class="ac-btn ac-btn--outline ac-btn--block" @click="handleSignOut">
      Se déconnecter
    </button>
  </section>
</template>

<style scoped>
.pending-card {
  background: hsl(38 80% 50% / 0.07);
  border: 1px solid hsl(38 80% 50% / 0.3);
  border-radius: 0.85rem;
  padding: 1.4rem;
  margin-bottom: 1.6rem;
}

.pending-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-display);
  font-size: var(--text-title);
  letter-spacing: 0.04em;
  color: hsl(38 90% 45%);
  margin-bottom: 1.25rem;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  margin-bottom: 1.4rem;
}

.step {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.step-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
}

.step-icon.done {
  background: hsl(var(--civic-green) / 0.15);
  color: hsl(var(--civic-green));
}

.step-icon.current {
  background: hsl(38 80% 50% / 0.18);
  color: hsl(38 90% 45%);
  animation: pulse 2s ease-in-out infinite;
}

.step-icon.todo {
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.step-label {
  font-weight: 600;
  color: hsl(var(--muted-foreground));
}

.step-label.done {
  color: hsl(var(--civic-green));
}

.step-label.current {
  color: hsl(38 90% 45%);
}

.step-desc {
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}
</style>
