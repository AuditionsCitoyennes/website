<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import AppHeader from "@/components/AppHeader.vue";
import MapStage from "@/components/MapStage.vue";
import ToastHost from "@/components/ToastHost.vue";
import { useAuthStore } from "@/stores/auth";
import { useCreateAudition } from "@/composables/useCreateAudition";
import { useSubmitTestimony } from "@/composables/useSubmitTestimony";
import { useToast } from "@/composables/useToast";

const auth = useAuthStore();
const route = useRoute();
const queryClient = useQueryClient();
const { toast } = useToast();
const createAudition = useCreateAudition();

// The "Nouvelle Audition" popup, opened from the nav bar on any page (and from
// the admin page). Admins only — nobody else downloads it. If it cannot be
// downloaded (connection lost, or a tab older than the last deployment), the
// buttons that open it must not simply do nothing: it is tried again, then
// said.
const dialogUnavailable = ref(false);
const CreateAuditionDialog = defineAsyncComponent({
  loader: () => import("@/components/admin/CreateAuditionDialog.vue"),
  onError(_error, retry, fail, attempts) {
    if (attempts <= 2) return retry();
    dialogUnavailable.value = true;
    fail();
  },
});
// A press after the failure — or one made while it was still loading.
watch([dialogUnavailable, createAudition.open], ([unavailable, open]) => {
  if (!unavailable || !open) return;
  createAudition.hide();
  toast({
    title: "Formulaire indisponible",
    description: "Le formulaire n'a pas pu être chargé. Rechargez la page.",
    variant: "destructive",
  });
});

// The visitors' "Témoigner" popup: for everyone, but downloaded only once it is
// first asked for (most visits never testify). Same failure handling.
const submitTestimony = useSubmitTestimony();
const testifyUnavailable = ref(false);
const SubmitTestimonyDialog = defineAsyncComponent({
  loader: () => import("@/components/SubmitTestimonyDialog.vue"),
  onError(_error, retry, fail, attempts) {
    if (attempts <= 2) return retry();
    testifyUnavailable.value = true;
    fail();
  },
});
watch([testifyUnavailable, submitTestimony.open], ([unavailable, open]) => {
  if (!unavailable || !open) return;
  submitTestimony.hide();
  toast({
    title: "Formulaire indisponible",
    description: "Le formulaire n'a pas pu être chargé. Rechargez la page.",
    variant: "destructive",
  });
});

function onAuditionCreated() {
  createAudition.notifyCreated();
  // The public pages show what they loaded a moment ago: the new audition
  // belongs on them now, wherever it was created from.
  for (const key of ["testimonies", "map"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

// Signed out (or no longer an admin): the popup goes, and does not come back
// open — with someone's draft in it — at the next sign-in.
watch(
  () => auth.isAdmin,
  (isAdmin) => {
    if (isAdmin) return;
    createAudition.hide();
    // The next sign-in mounts the popup anew, and loads it again.
    dialogUnavailable.value = false;
  },
);

onMounted(() => {
  auth.init();
});
</script>

<template>
  <AppHeader />
  <main class="app-main" :class="{ 'app-main--bleed': route.meta.bleed }">
    <RouterView />
  </main>
  <!-- The testimonies map, once for the whole site: a card on the home page,
       the whole of /temoignages (see useMapStage). -->
  <MapStage />
  <CreateAuditionDialog
    v-if="auth.isAdmin"
    :open="createAudition.open.value"
    @close="createAudition.hide"
    @created="onAuditionCreated"
  />
  <SubmitTestimonyDialog
    v-if="submitTestimony.wanted.value"
    :open="submitTestimony.open.value"
    @close="submitTestimony.hide"
  />
  <ToastHost />
</template>

<style>
/* A card opening into the map page: the page behind it holds still. */
html.map-opening {
  overflow: hidden;
}
</style>

<style scoped>
.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* Phones: the header floats over the page and takes no room of its own, so
   the page leaves it its space — unless the page runs under it (`bleed`). */
@media (max-width: 899px) {
  .app-main:not(.app-main--bleed) {
    padding-top: var(--header-space);
  }
}
</style>
