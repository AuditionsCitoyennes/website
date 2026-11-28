<script setup lang="ts">
import { CAPTCHA_UNAVAILABLE_TEXT, captchaConfigured, type FormCaptcha } from "./turnstile";

// A form's place for its captcha (turnstile.ts): where the widget shows when
// Cloudflare wants the visitor to tick it, and, when the captcha could not be
// had, the reason with « Réessayer ». Nothing at all in a build without one.
const props = defineProps<{ captcha: FormCaptcha }>();

// The ref itself, for the template to fill with the element.
const host = props.captcha.host;
</script>

<template>
  <div v-if="captchaConfigured()" class="captcha-zone">
    <div ref="host" class="captcha-widget"></div>
    <p v-if="captcha.unavailable.value" class="captcha-note" role="alert">
      {{ CAPTCHA_UNAVAILABLE_TEXT }}
      <button type="button" class="captcha-retry" @click="captcha.retry()">Réessayer</button>
    </p>
  </div>
</template>

<style scoped>
.captcha-widget {
  display: flex;
  justify-content: center;
}

.captcha-note {
  font-size: var(--text-caption);
  line-height: var(--lh-body);
  text-align: center;
  color: hsl(var(--muted-foreground));
}

.captcha-retry {
  background: none;
  border: none;
  padding: 0;
  font-size: inherit;
  font-weight: 600;
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
</style>
