import { nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ROUTE } from "@/shared/routes";

// ---- Analyses (drawn by GeoNav on the map, around the raised territory) -----

export function useAnalysesToggle(preview: () => boolean) {
  const analyses = ref(false);
  const analysesBtn = ref<HTMLButtonElement | null>(null);
  // A build without the analyses (vite.config's __ANALYSES__) reads and writes
  // no address and moves no focus: they stay off.
  if (!__ANALYSES__) return { analyses, analysesBtn };

  // Kept in the address (?analyses=1, where the old /analyses page now leads),
  // but only while this is the page: the same map is also the home page's card,
  // whose reset must not write onto "/".
  const route = useRoute();
  const router = useRouter();
  watch(
    [() => route.name, () => route.query.analyses],
    ([name, flag]) => {
      if (name === ROUTE.temoignages.name) analyses.value = flag === "1";
    },
    { immediate: true },
  );
  // Turned off from the plates (their close button, Esc), the focus was on them
  // and they are gone: it comes back to the toggle, rather than to the top of
  // the page. Only when it has nowhere else to be. (Read before they go: this
  // runs before GeoNav takes them off the page.)
  watch(analyses, (on) => {
    if (!on && !preview() && document.activeElement?.closest(".analyses-layer")) {
      void nextTick(() => {
        const active = document.activeElement;
        if (!active || active === document.body) analysesBtn.value?.focus({ preventScroll: true });
      });
    }
    if (preview() || route.name !== ROUTE.temoignages.name) return;
    if ((route.query.analyses === "1") === on) return;
    void router.replace({
      query: { ...route.query, analyses: on ? "1" : undefined },
      hash: route.hash,
    });
  });

  return { analyses, analysesBtn };
}
