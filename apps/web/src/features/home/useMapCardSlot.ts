import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { useMapStage } from "@/features/map-stage";

// The map card: lent to the one testimonies map (MapStage).
// Taken once the page itself is in — the document loaded, the hero photograph
// shown (the map must not compete with it) — and the browser has a moment: the
// map loads meanwhile, and is ready to be opened into the testimonies page by
// the time it is reached. Reached before that (a quick scroll): at once. And
// at once when the map already exists (back from /temoignages: it comes
// straight back into its card).

/**
 * Lends `mapCard` to the map for as long as the calling component is mounted.
 * `heroReady`: the hero photograph is shown (HeroSection's `ready`).
 */
export function useMapCardSlot(mapCard: Ref<HTMLElement | null>, heroReady: Ref<boolean>) {
  const stage = useMapStage();
  let cardIO: IntersectionObserver | null = null;
  let idleId = 0;
  let timerId = 0;
  let waiting: { target: EventTarget; type: string; fn: () => void }[] = [];
  let stopHeroWatch: (() => void) | null = null;

  function stopWaiting() {
    cardIO?.disconnect();
    cardIO = null;
    for (const w of waiting) w.target.removeEventListener(w.type, w.fn);
    waiting = [];
    stopHeroWatch?.();
    stopHeroWatch = null;
    if (idleId) window.cancelIdleCallback(idleId);
    idleId = 0;
    window.clearTimeout(timerId);
  }

  /** `fn` once `target` fires `type` (or any of `types`) — forgotten on unmount. */
  function once(target: EventTarget, types: string[], fn: () => void) {
    const run = () => {
      for (const w of waiting.filter((w) => w.fn === run))
        w.target.removeEventListener(w.type, run);
      waiting = waiting.filter((w) => w.fn !== run);
      fn();
    };
    for (const type of types) {
      target.addEventListener(type, run);
      waiting.push({ target, type, fn: run });
    }
  }

  onMounted(() => {
    const el = mapCard.value;
    if (!el) return;
    if (stage.alive.value) {
      stage.card.value = el;
      return;
    }
    const take = () => {
      stopWaiting();
      if (mapCard.value === el && !stage.card.value) stage.card.value = el;
    };
    cardIO = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) take();
      },
      { rootMargin: "300px 0px" },
    );
    cardIO.observe(el);
    const whenIdle = () => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(take, { timeout: 2000 });
      } else timerId = setTimeout(take, 200) as unknown as number;
    };
    const afterHero = () => {
      if (heroReady.value) whenIdle();
      else {
        // Synchronous, like the load listener it replaces: the moment the
        // photograph is in, not a tick later.
        stopHeroWatch = watch(
          heroReady,
          (ready) => {
            if (!ready) return;
            stopHeroWatch?.();
            stopHeroWatch = null;
            whenIdle();
          },
          { flush: "sync" },
        );
      }
    };
    if (document.readyState === "complete") afterHero();
    else once(window, ["load"], afterHero);
  });
  onBeforeUnmount(() => {
    stopWaiting();
    stage.release(stage.card, mapCard.value);
  });
}
