<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { supabase } from "@/shared/api/supabase";
import { CONTACT_EMAIL } from "@/shared/contact";
import { ROUTE } from "@/shared/routes";
import { useToast } from "@/shared/ui/toast/useToast";
import { secondFactorError } from "../authErrors";
import { owesSecondFactor } from "../lib/secondFactor";
import { useAuthStore } from "../store";
import AuthCard from "../components/AuthCard.vue";
import SecondFactorCode from "../components/SecondFactorCode.vue";

// « Double authentification »: the signed-in account's second factor, a code
// from an authenticator app (TOTP). One page for its whole life:
// - `challenge`: the account has one and this session has not given its code
//   yet (the admin page and the API's `mfa_required` lead here);
// - `offer`: the account has none, and may add one;
// - `enrol`: one is being added (the QR code, then its first code);
// - `active`: the account has one and the session gave its code: it may be
//   removed.
type View = "loading" | "failed" | "challenge" | "offer" | "enrol" | "active";

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const { toast } = useToast();

const view = ref<View>("loading");
const busy = ref(false);
/** The account's confirmed factor, when it has one. */
const factorId = ref<string | null>(null);
/** The factor being added: what the authenticator app needs of it. */
const enrolment = ref<{ id: string; qr: string; secret: string } | null>(null);

// `?requise=1`: the API refused an admin route for want of a second factor.
const required = route.query.requise === "1";

function refuse(error: unknown) {
  toast({ title: "Erreur", description: secondFactorError(error), variant: "destructive" });
}

async function load() {
  view.value = "loading";
  const { data: kept } = await supabase.auth.getSession();
  if (!kept.session) {
    router.replace(ROUTE.auth.path);
    return;
  }
  // The account as Auth has it now: a factor may have been added or removed
  // from another device since this session began.
  const { data: factors, error } = await supabase.auth.mfa.listFactors();
  if (error) {
    view.value = "failed";
    return;
  }
  factorId.value = factors.totp[0]?.id ?? null;
  if (!factorId.value) {
    // The kept session still lists a factor the account no longer has (it
    // was removed from another device, or by the team): the admin page sent
    // it here for a code nobody can give. A renewed session says what the
    // account is now, and the admin area opens again.
    if (owesSecondFactor(kept.session)) {
      const { data: renewed, error: renewal } = await supabase.auth.refreshSession();
      if (isAuthRetryableFetchError(renewal)) {
        view.value = "failed";
        return;
      }
      // A session Auth no longer renews was dropped by that call.
      if (renewal) {
        router.replace(ROUTE.auth.path);
        return;
      }
      if (!required && !owesSecondFactor(renewed.session)) {
        router.replace(ROUTE.admin.path);
        return;
      }
    }
    view.value = "offer";
    return;
  }
  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  view.value = level?.currentLevel === "aal2" ? "active" : "challenge";
}

onMounted(load);

async function startEnrolment() {
  busy.value = true;
  try {
    // A factor begun and never confirmed stands in the way of a new one.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const factor of factors?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      issuer: "Auditions Citoyennes",
    });
    if (error) {
      refuse(error);
      return;
    }
    enrolment.value = { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    view.value = "enrol";
  } finally {
    busy.value = false;
  }
}

async function cancelEnrolment() {
  const begun = enrolment.value;
  enrolment.value = null;
  view.value = "offer";
  if (begun) await supabase.auth.mfa.unenroll({ factorId: begun.id });
}

function onEnrolled() {
  factorId.value = enrolment.value?.id ?? null;
  enrolment.value = null;
  view.value = "active";
  toast({
    title: "Double authentification activée",
    description: "Un code vous sera demandé à chaque connexion.",
  });
}

function onChallengePassed() {
  router.replace(ROUTE.admin.path);
}

async function removeFactor() {
  if (!factorId.value) return;
  if (
    !confirm(
      "Désactiver la double authentification ? Votre compte ne sera plus protégé que par son mot de passe.",
    )
  ) {
    return;
  }
  busy.value = true;
  try {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factorId.value });
    if (error) {
      refuse(error);
      return;
    }
    // The session's token still says « second level »: a new one says what
    // the account is now.
    await supabase.auth.refreshSession();
    factorId.value = null;
    view.value = "offer";
    toast({ title: "Double authentification désactivée" });
  } finally {
    busy.value = false;
  }
}

async function handleSignOut() {
  await auth.signOut();
  router.push(ROUTE.auth.path);
}
</script>

<template>
  <div class="mfa-page">
    <AuthCard v-if="view === 'loading'" loading />

    <AuthCard v-else-if="view === 'failed'">
      <h1 class="card-title">Double authentification</h1>
      <p class="card-desc center">
        Le service de connexion ne répond pas. Veuillez réessayer dans un instant.
      </p>
      <button type="button" class="btn-primary-block" @click="load">Réessayer</button>
    </AuthCard>

    <!-- The code this session owes -->
    <AuthCard v-else-if="view === 'challenge' && factorId">
      <h1 class="card-title">Double authentification</h1>
      <p class="card-desc center">
        Saisissez le code affiché par votre application d'authentification pour accéder à
        l'administration.
      </p>
      <div class="stack">
        <SecondFactorCode :factor-id="factorId" action="Vérifier" @verified="onChallengePassed" />
        <button type="button" class="btn-ghost-block" @click="handleSignOut">Se déconnecter</button>
        <p class="note">
          Vous n'avez plus accès à cette application&nbsp;? Écrivez à
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a
          >.
        </p>
      </div>
    </AuthCard>

    <!-- No second factor yet -->
    <AuthCard v-else-if="view === 'offer'">
      <h1 class="card-title">Double authentification</h1>
      <p class="card-desc center">
        En plus de votre mot de passe, un code à 6&nbsp;chiffres donné par une application de votre
        téléphone (Aegis, Google Authenticator, 1Password…) vous sera demandé à chaque connexion.
      </p>
      <div class="stack">
        <p v-if="required" class="notice" role="status">
          Ce site demande la double authentification aux comptes d'administration&nbsp;: activez-la
          pour continuer.
        </p>
        <button type="button" class="btn-primary-block" :disabled="busy" @click="startEnrolment">
          {{ busy ? "Préparation..." : "Activer la double authentification" }}
        </button>
        <RouterLink :to="ROUTE.admin.path" class="btn-ghost-block link-block">
          Retour à l'administration
        </RouterLink>
        <!-- The admin area is closed to this session meanwhile. -->
        <button
          v-if="required || auth.secondFactorOwed"
          type="button"
          class="btn-ghost-block"
          @click="handleSignOut"
        >
          Se déconnecter
        </button>
      </div>
    </AuthCard>

    <!-- A factor being added -->
    <AuthCard v-else-if="view === 'enrol' && enrolment">
      <h1 class="card-title">Double authentification</h1>
      <div class="stack">
        <p class="step">
          <strong>1.</strong> Dans votre application d'authentification, ajoutez un compte en
          scannant ce QR code.
        </p>
        <img class="qr" :src="enrolment.qr" alt="QR code à scanner" width="200" height="200" />
        <p class="note">
          Impossible de scanner&nbsp;? Saisissez cette clé dans l'application&nbsp;:
          <code class="secret">{{ enrolment.secret }}</code>
        </p>
        <p class="step"><strong>2.</strong> Saisissez le code à 6&nbsp;chiffres qu'elle affiche.</p>
        <SecondFactorCode :factor-id="enrolment.id" action="Activer" @verified="onEnrolled" />
        <button type="button" class="btn-ghost-block" @click="cancelEnrolment">Annuler</button>
        <p class="note">
          Si vous perdez l'accès à cette application, écrivez à
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a> pour que l'équipe
          réinitialise votre double authentification.
        </p>
      </div>
    </AuthCard>

    <!-- A factor in place, its code given -->
    <AuthCard v-else>
      <div class="icon-wrap success">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="38"
          height="38"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h1 class="card-title">Double authentification</h1>
      <p class="card-desc center">
        Elle est active sur ce compte&nbsp;: un code vous est demandé à chaque connexion.
      </p>
      <div class="stack">
        <RouterLink :to="ROUTE.admin.path" class="btn-primary-block link-block">
          Retour à l'administration
        </RouterLink>
        <button type="button" class="btn-ghost-block" :disabled="busy" @click="removeFactor">
          Désactiver la double authentification
        </button>
      </div>
    </AuthCard>
  </div>
</template>

<style scoped>
.mfa-page {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 1.5rem;
  overflow: hidden;
}

.icon-wrap {
  display: grid;
  place-items: center;
  width: 4.6rem;
  height: 4.6rem;
  margin: 0 auto 1.25rem;
  border-radius: 1.1rem;
}

.icon-wrap.success {
  background: hsl(var(--civic-green) / 0.12);
  color: hsl(var(--civic-green));
}

.card-title {
  font-size: var(--text-section);
  text-transform: uppercase;
  text-align: center;
  color: hsl(var(--foreground));
}

.card-desc {
  margin-top: 0.4rem;
  margin-bottom: 1.4rem;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}

.center {
  text-align: center;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.card-title + .stack {
  margin-top: 1.4rem;
}

.step {
  font-size: var(--text-body);
  color: hsl(var(--foreground));
}

.note,
.notice {
  font-size: var(--text-caption);
  line-height: var(--lh-body);
  color: hsl(var(--muted-foreground));
}

.note {
  text-align: center;
}

.note a {
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.notice {
  padding: 0.7rem 0.85rem;
  border-radius: 0.6rem;
  border: 1px solid hsl(var(--primary) / 0.2);
  background: hsl(var(--primary) / 0.1);
  color: hsl(var(--foreground));
}

/* A QR code is read dark on light, in either theme. */
.qr {
  align-self: center;
  padding: 0.6rem;
  border-radius: 0.6rem;
  background: hsl(0 0% 100%);
}

.secret {
  display: block;
  margin-top: 0.3rem;
  font-family: inherit;
  font-weight: 600;
  letter-spacing: 0.08em;
  overflow-wrap: anywhere;
  color: hsl(var(--foreground));
}

.link-block {
  text-decoration: none;
}
</style>
