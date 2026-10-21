import { ref } from "vue";

// The "Témoigner" popup, for every visitor: asked for from the nav bar on any
// page. ONE popup, mounted once (app/AppDialogs.vue) — and only from the first time it is
// asked for, so a visit that never testifies never downloads it.
const open = ref(false);
/** Asked for at least once: from then on it stays mounted (and keeps the draft). */
const wanted = ref(false);

export function useSubmitTestimony() {
  return {
    open,
    wanted,
    show: () => {
      wanted.value = true;
      open.value = true;
    },
    hide: () => {
      open.value = false;
    },
  };
}
