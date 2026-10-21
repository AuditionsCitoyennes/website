import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { useRoute } from "vue-router";

/** Scroll, in px, before the tiles react: a finger resting on the screen trembles. */
const TUCK_SLACK = 8;
/** Near the top of the page the tiles always show: they sit in its margin. */
const TUCK_FROM = 64;

/**
 * On phones the header is no bar: its tiles float over the page, and get out
 * of the way while the page is read downwards, and come back as soon as it
 * goes up — or near the top, where they cover nothing. Never while `immersive`
 * (the map page: nothing scrolls there) nor while the phone menu is open; and
 * a new page shows them again. Keyboard focus coming into the header brings
 * them back too (AppHeader.vue).
 */
export function useHeaderTuck(options: {
  immersive: Readonly<Ref<boolean>>;
  menuOpen: Readonly<Ref<boolean>>;
}) {
  const route = useRoute();
  const tucked = ref(false);
  const phone = window.matchMedia("(max-width: 899px)");
  let lastY = 0;
  let scrollFrame = 0;
  function onScroll() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const y = Math.max(0, window.scrollY); // iOS bounces above 0
      if (!phone.matches || options.immersive.value || options.menuOpen.value || y < TUCK_FROM) {
        tucked.value = false;
        lastY = y;
      } else if (y - lastY > TUCK_SLACK) {
        tucked.value = true;
        lastY = y;
      } else if (lastY - y > TUCK_SLACK) {
        tucked.value = false;
        lastY = y;
      }
    });
  }
  onMounted(() => window.addEventListener("scroll", onScroll, { passive: true }));
  onBeforeUnmount(() => {
    window.removeEventListener("scroll", onScroll);
    cancelAnimationFrame(scrollFrame);
  });
  // A new page: the tiles show.
  watch(
    () => route.fullPath,
    () => {
      tucked.value = false;
      lastY = Math.max(0, window.scrollY);
    },
  );
  return { tucked };
}
