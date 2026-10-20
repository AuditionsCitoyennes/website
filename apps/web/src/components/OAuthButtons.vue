<script setup lang="ts">
import { ref } from "vue";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/composables/useToast";

const { toast } = useToast();
const loading = ref(false);

async function handleGoogle() {
  loading.value = true;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/admin` },
  });
  if (error) {
    toast({ title: "Erreur", description: error.message, variant: "destructive" });
  }
  loading.value = false;
}
</script>

<template>
  <div class="oauth">
    <button type="button" class="google-btn" :disabled="loading" @click="handleGoogle">
      <template v-if="loading">Connexion...</template>
      <template v-else>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        Continuer avec Google
      </template>
    </button>

    <div class="divider" role="separator">
      <span class="divider-line"></span>
      <span class="divider-text">ou</span>
      <span class="divider-line"></span>
    </div>
  </div>
</template>

<style scoped>
.google-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  width: 100%;
  height: 3rem;
  border-radius: 0.6rem;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  font-weight: 600;
  font-size: var(--text-ui);
  letter-spacing: 0.02em;
  transition: var(--transition-smooth);
}

.google-btn:hover:not(:disabled) {
  background: hsl(var(--accent) / 0.5);
}

.google-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1.4rem;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: hsl(var(--border));
}

.divider-text {
  font-size: var(--text-caption);
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
}
</style>
