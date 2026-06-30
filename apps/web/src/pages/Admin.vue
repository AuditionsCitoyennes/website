<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useToast } from "@/composables/useToast";
import { useIdleTimeout } from "@/composables/useIdleTimeout";
import UsernamePromptDialog from "@/components/UsernamePromptDialog.vue";
import PendingApprovalCard from "@/components/admin/PendingApprovalCard.vue";
import AccountSection from "@/components/admin/AccountSection.vue";
import PendingRegistrations from "@/components/admin/PendingRegistrations.vue";
import RoleManagement from "@/components/admin/RoleManagement.vue";
import AuditLogTable from "@/components/admin/AuditLogTable.vue";
import CreateAuditionDialog from "@/components/admin/CreateAuditionDialog.vue";
import AuditionAdminList from "@/components/admin/AuditionAdminList.vue";

const router = useRouter();
const auth = useAuthStore();
const { toast } = useToast();
useIdleTimeout();

const createDialogOpen = ref(false);
const usernamePromptDone = ref(false);
const roleManagementRef = ref<InstanceType<typeof RoleManagement> | null>(null);
const auditionListRef = ref<InstanceType<typeof AuditionAdminList> | null>(null);

watchEffect(() => {
  if (!auth.loading && !auth.user) {
    router.replace("/auth");
  }
});

// OAuth users arrive without a username — prompt once.
const showUsernamePrompt = computed(
  () =>
    !auth.loading &&
    !!auth.user &&
    !auth.user.user_metadata?.username &&
    !usernamePromptDone.value,
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
    <UsernamePromptDialog :open="showUsernamePrompt" @complete="onProfileComplete" />

    <header class="page-head">
      <h1>Administration</h1>
      <span v-if="auth.isSuperAdmin" class="chip chip--amber">Super Admin</span>
      <span v-else-if="auth.isAdmin" class="chip chip--green">Admin</span>
    </header>

    <!-- Awaiting approval -->
    <PendingApprovalCard v-if="!auth.isAdmin" />

    <template v-else>
      <AccountSection />

      <template v-if="auth.isSuperAdmin">
        <PendingRegistrations @approved="roleManagementRef?.refresh()" />
        <RoleManagement ref="roleManagementRef" />
        <AuditLogTable />
      </template>

      <button
        type="button"
        class="ac-btn ac-btn--primary ac-btn--block new-audition"
        @click="createDialogOpen = true"
      >
        + Nouvelle Audition
      </button>

      <CreateAuditionDialog
        :open="createDialogOpen"
        @close="createDialogOpen = false"
        @created="auditionListRef?.refresh()"
      />

      <AuditionAdminList ref="auditionListRef" />
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
  font-size: 2.6rem;
  color: hsl(var(--foreground));
}

.new-audition {
  margin-bottom: 1.6rem;
}
</style>
