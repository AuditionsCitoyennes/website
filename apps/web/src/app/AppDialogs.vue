<script setup lang="ts">
import { watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useAuthStore } from "@/stores/auth";
import { useCreateAudition } from "@/composables/useCreateAudition";
import { useSubmitTestimony } from "@/composables/useSubmitTestimony";
import { useLazyDialog } from "./useLazyDialog";

const auth = useAuthStore();
const queryClient = useQueryClient();

// The "Nouvelle Audition" popup, opened from the nav bar on any page (and from
// the admin page). Admins only — nobody else downloads it. If it cannot be
// downloaded, the buttons that open it must not simply do nothing: it is tried
// again, then said (useLazyDialog).
const createAudition = useCreateAudition();
const { component: CreateAuditionDialog, unavailable: dialogUnavailable } = useLazyDialog({
  loader: () => import("@/components/admin/CreateAuditionDialog.vue"),
  open: createAudition.open,
  hide: createAudition.hide,
});

// The visitors' "Témoigner" popup: for everyone, but downloaded only once it is
// first asked for (most visits never testify). Same failure handling.
const submitTestimony = useSubmitTestimony();
const { component: SubmitTestimonyDialog } = useLazyDialog({
  loader: () => import("@/components/SubmitTestimonyDialog.vue"),
  open: submitTestimony.open,
  hide: submitTestimony.hide,
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
</script>

<template>
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
</template>
