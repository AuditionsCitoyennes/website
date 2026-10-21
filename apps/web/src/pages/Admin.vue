<script setup lang="ts">
import { computed, ref, watch, watchEffect } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useToast } from "@/shared/ui/toast/useToast";
import { useIdleTimeout } from "@/composables/useIdleTimeout";
import { usePendingRegistrations } from "@/composables/usePendingRegistrations";
import { useCreateAudition } from "@/composables/useCreateAudition";
import UsernamePromptDialog from "@/components/UsernamePromptDialog.vue";
import PendingApprovalCard from "@/components/admin/PendingApprovalCard.vue";
import AccountSection from "@/components/admin/AccountSection.vue";
import PendingRegistrations from "@/components/admin/PendingRegistrations.vue";
import RoleManagement from "@/components/admin/RoleManagement.vue";
import AuditLogTable from "@/components/admin/AuditLogTable.vue";
import AuditionAdminList from "@/components/admin/AuditionAdminList.vue";

const router = useRouter();
const auth = useAuthStore();
const { toast } = useToast();
useIdleTimeout();

const usernamePromptDone = ref(false);
const roleManagementRef = ref<InstanceType<typeof RoleManagement> | null>(null);
const auditionListRef = ref<InstanceType<typeof AuditionAdminList> | null>(null);
const auditLogRef = ref<InstanceType<typeof AuditLogTable> | null>(null);

// The "Nouvelle Audition" popup belongs to the whole app (see app/AppDialogs.vue): it is
// also opened from the nav bar. An audition created from either place shows up
// in the list here — or in the audit log — when that is the feature open.
const createAudition = useCreateAudition();
watch(createAudition.createdCount, () => {
  auditionListRef.value?.refresh();
  auditLogRef.value?.refresh();
});

async function handleSignOut() {
  await auth.signOut();
  router.push("/auth");
}

// Registrations waiting for a decision (super admins only; none otherwise).
const { count: pendingCount } = usePendingRegistrations();
const pendingLabel = computed(() =>
  pendingCount.value > 1
    ? `${pendingCount.value} inscriptions en attente`
    : "1 inscription en attente",
);

// The page is a row of feature buttons with at most ONE feature open beneath
// them — "Auditions" on arrival. A feature is mounted only while it is open,
// so it loads its data when asked for and comes back fresh each time.
// "Administrateurs" is two panels under one button: the registrations waiting
// for approval, then the administrators they become once approved. It and the
// audit log are for super admins only: a plain admin does not get the buttons.
type Feature = "account" | "admins" | "audit" | "auditions";
const features = computed<{ id: Feature; label: string; alert?: string }[]>(() => [
  { id: "account", label: "Mon compte" },
  ...(auth.isSuperAdmin
    ? [
        {
          id: "admins" as const,
          label: "Administrateurs",
          // A red dot on the button while someone is waiting.
          alert: pendingCount.value > 0 ? pendingLabel.value : undefined,
        },
        { id: "audit" as const, label: "Journal d'audit" },
      ]
    : []),
  { id: "auditions", label: "Auditions" },
]);
const requestedFeature = ref<Feature | null>("auditions");
// Checked against the buttons actually on offer: losing super-admin rights
// mid-session must not leave one of its features open.
const openFeature = computed(() =>
  features.value.some((f) => f.id === requestedFeature.value) ? requestedFeature.value : null,
);
function toggleFeature(id: Feature) {
  requestedFeature.value = openFeature.value === id ? null : id;
}

watchEffect(() => {
  if (!auth.loading && !auth.user) {
    router.replace("/auth");
  }
});

// OAuth users arrive without a username — prompt once.
const showUsernamePrompt = computed(
  () =>
    !auth.loading && !!auth.user && !auth.user.user_metadata?.username && !usernamePromptDone.value,
);

function onProfileComplete() {
  usernamePromptDone.value = true;
  toast({ title: "Bienvenue !", description: "Votre profil a été enregistré." });
}
</script>

<template>
  <div v-if="auth.loading || !auth.user" class="loading">
    <span class="spinner spinner-lg" aria-label="Chargement"></span>
  </div>

  <div v-else class="admin container-page">
    <UsernamePromptDialog
      :open="showUsernamePrompt"
      @complete="onProfileComplete"
      @sign-out="handleSignOut"
    />

    <header class="page-head">
      <h1>Administration</h1>
      <span v-if="auth.isSuperAdmin" class="chip chip--amber">Super Admin</span>
      <span v-else-if="auth.isAdmin" class="chip chip--green">Admin</span>
      <!-- Someone still waiting for approval signs out from their card below. -->
      <button
        v-if="auth.isAdmin"
        type="button"
        class="ac-btn ac-btn--outline sign-out"
        @click="handleSignOut"
      >
        Déconnexion
      </button>
    </header>

    <!-- Awaiting approval -->
    <PendingApprovalCard v-if="!auth.isAdmin" />

    <template v-else>
      <nav
        class="features"
        aria-label="Fonctionnalités d'administration"
        :style="{ '--feature-count': features.length }"
      >
        <button
          v-for="f in features"
          :key="f.id"
          type="button"
          class="ac-btn"
          :class="openFeature === f.id ? 'ac-btn--primary' : 'ac-btn--outline'"
          :aria-expanded="openFeature === f.id"
          aria-controls="admin-feature"
          :title="f.alert"
          @click="toggleFeature(f.id)"
        >
          {{ f.label }}
          <template v-if="f.alert">
            <span class="feature-dot" aria-hidden="true"></span>
            <span class="visually-hidden">({{ f.alert }})</span>
          </template>
        </button>
      </nav>

      <div id="admin-feature">
        <AccountSection v-if="openFeature === 'account'" />
        <template v-else-if="openFeature === 'admins'">
          <!-- Approving a registration creates an administrator: refresh the
               list below so the newcomer shows up without reopening it. -->
          <PendingRegistrations @approved="roleManagementRef?.refresh()" />
          <RoleManagement ref="roleManagementRef" />
        </template>
        <AuditLogTable v-else-if="openFeature === 'audit'" ref="auditLogRef" />
        <template v-else-if="openFeature === 'auditions'">
          <button
            type="button"
            class="ac-btn ac-btn--primary ac-btn--block new-audition"
            @click="createAudition.show"
          >
            + Nouvelle Audition
          </button>

          <AuditionAdminList ref="auditionListRef" />
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem;
}

.admin {
  max-width: 900px;
  padding-block: 2.5rem 4rem;
}

.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.7rem;
  margin-bottom: 1.8rem;
}

.page-head h1 {
  font-size: var(--text-page);
  color: hsl(var(--foreground));
}

/* At the far end of the title's line. */
.sign-out {
  margin-left: auto;
}

/* Equal-width buttons that together fill the row. When the row is too narrow to
   give each one room for its label, they ALL drop to full width at once — never
   an uneven last line. That is what the flex-basis does: below the threshold
   (count × room per button) it turns huge and every button takes a line of its
   own; above it, it goes negative, which clamps to 0, and they share the row. */
.features {
  --feature-room: 10rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-bottom: 1.6rem;
}

.features .ac-btn {
  flex: 1 1 calc((var(--feature-count) * var(--feature-room) - 100%) * 999);
  min-width: 0;
  position: relative;
}

/* "Someone is waiting": a small red light riding the button's top-right corner,
   ringed in the page colour so it reads as sitting ON the button, whatever its
   fill, and pulsing — a halo of the same red that swells and fades. */
.feature-dot {
  position: absolute;
  top: -0.2rem;
  right: -0.2rem;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: hsl(var(--destructive));
  box-shadow:
    0 0 0 2px hsl(var(--background)),
    0 0 6px 2px hsl(var(--destructive) / 0.55);
  pointer-events: none;
}

.feature-dot::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: hsl(var(--destructive));
  animation: feature-dot-pulse 1.6s ease-out infinite;
}

@keyframes feature-dot-pulse {
  from {
    transform: scale(1);
    opacity: 0.75;
  }
  to {
    transform: scale(3);
    opacity: 0;
  }
}

/* No motion asked for: the light stays lit, with a still halo. */
@media (prefers-reduced-motion: reduce) {
  .feature-dot::after {
    animation: none;
    transform: scale(1.9);
    opacity: 0.3;
  }
}

/* Said, not shown: what the dot means, for a screen reader. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.new-audition {
  margin-bottom: 1.6rem;
}
</style>
