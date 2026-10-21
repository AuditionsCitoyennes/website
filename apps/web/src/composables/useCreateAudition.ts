import { ref } from "vue";

// The "Nouvelle Audition" popup is asked for from the nav bar — on any page —
// and from the admin page. There is ONE popup, mounted once (App.vue), so what
// was typed in it is kept wherever it is reopened from.
const open = ref(false);
/** Bumped each time an audition is created: whoever lists them refreshes. */
const createdCount = ref(0);

export function useCreateAudition() {
  return {
    open,
    createdCount,
    show: () => {
      open.value = true;
    },
    hide: () => {
      open.value = false;
    },
    notifyCreated: () => {
      createdCount.value++;
    },
  };
}
