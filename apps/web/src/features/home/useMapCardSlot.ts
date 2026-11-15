import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { useMapStage } from "@/features/map-stage";
import { deviceTier } from "@/shared/device/deviceTier";
import {
  DEFAULT_HOME_MAP,
  HOME_MAP_KEY,
  needsProbe,
  resolveHomeMap,
  storedHomeMap,
  type HomeMapPolicy,
} from "./homeMapPolicy";
import { probeWebgl2 } from "./webglProbe";

// The map card: lent to the one testimonies map (MapStage) — and lending it is
// what loads the map: its code, both Mapbox maps, the map's data. So it is
// lent only to a visitor on the way to it; one who stays on the hero, or reads
// the project and leaves, loads none of it.
// - Reached (within NEAR_MARGIN of the screen: a quick scroll, a reload half
//   way down): at once, whatever the policy — even before the page is in.
// - Heading there ("proche", what "auto" is on a strong device): from the visitor's first scroll away from the top on, a screen
//   ahead (LEAD_MARGIN) — the map loads while the copy beside it is read, and
//   is ready to be opened into the testimonies page by the time it is
//   reached. Never on the layout alone, nor on the router's own scroll to the
//   top: a visitor who does not scroll lends it nothing, however tall the
//   screen.
// - And at once when the map already exists (back from /temoignages: it comes
//   straight back into its card).
//
// Compared live in the builds with the testing tools (the dev server and
// staging, __TEST_TOOLS__) through `ac:home-map`, with "auto" the default: on
// a weak device, or one without WebGL 2, the card is never lent and shows a
// still picture (homeMapPolicy.ts has every policy and the rule).

export { DEFAULT_HOME_MAP, HOME_MAP_POLICIES, type HomeMapPolicy } from "./homeMapPolicy";

/** Reached: the card this close to the screen is lent at once, in every policy. */
const NEAR_MARGIN = "300px 0px";
/** Heading there ("proche"): a screen ahead — to tune once phones are measured. */
const LEAD_MARGIN = "100% 0px";

/** This page load's policy (the switch's choice; "auto" is resolved per card). */
export const homeMapPolicy: HomeMapPolicy = __TEST_TOOLS__ ? storedHomeMap() : DEFAULT_HOME_MAP;

/** Another policy: kept, and the page loaded again with it. */
export function setHomeMapPolicy(policy: HomeMapPolicy) {
  if (!__TEST_TOOLS__ || policy === homeMapPolicy) return;
  try {
    localStorage.setItem(HOME_MAP_KEY, policy);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/**
 * Lends `mapCard` to the map for as long as the calling component is mounted.
 * `heroReady`: the hero photograph is shown (HeroSection's `ready`) — what the
 * "tot" policy waits for. Returns `still`: the card is not lent and shows its
 * still picture instead ("statique", or "auto" on a weak device).
 */
export function useMapCardSlot(mapCard: Ref<HTMLElement | null>, heroReady: Ref<boolean>) {
  const stage = useMapStage();
  /** The policy now: "auto" read from the browser's hints, probed later. */
  const hintTier = deviceTier();
  let policy = resolveHomeMap(homeMapPolicy, hintTier);
  // Back from the map page, "auto" lends the map that is there (nothing more
  // to download); "statique" chosen never lends it.
  const still = ref(policy === "statique" && !(homeMapPolicy === "auto" && stage.alive.value));
  let cardIO: IntersectionObserver[] = [];
  let idleId = 0;
  let timerId = 0;
  let waiting: { target: EventTarget; type: string; fn: () => void }[] = [];
  let stopHeroWatch: (() => void) | null = null;

  function stopWaiting() {
    for (const io of cardIO) io.disconnect();
    cardIO = [];
    for (const w of waiting) w.target.removeEventListener(w.type, w.fn);
    waiting = [];
    stopHeroWatch?.();
    stopHeroWatch = null;
    if (idleId) window.cancelIdleCallback(idleId);
    idleId = 0;
    window.clearTimeout(timerId);
  }

  /** `fn` once `target` fires `type` (or any of `types`) — forgotten on unmount. */
  function once(
    target: EventTarget,
    types: string[],
    fn: () => void,
    options?: AddEventListenerOptions,
  ) {
    const run = () => {
      for (const w of waiting.filter((w) => w.fn === run))
        w.target.removeEventListener(w.type, run);
      waiting = waiting.filter((w) => w.fn !== run);
      fn();
    };
    for (const type of types) {
      target.addEventListener(type, run, options);
      waiting.push({ target, type, fn: run });
    }
  }

  onMounted(() => {
    const el = mapCard.value;
    if (!el || still.value) return; // never lent
    if (stage.alive.value) {
      stage.card.value = el;
      return;
    }
    const take = () => {
      stopWaiting();
      // "auto" on a device the hints call strong: the browser is probed once,
      // here, before the map's download starts (a software renderer, or no
      // WebGL 2: the still picture after all).
      if (needsProbe(homeMapPolicy, hintTier)) {
        const webgl2 = probeWebgl2();
        policy = resolveHomeMap(homeMapPolicy, deviceTier(), webgl2);
        if (policy === "statique") {
          still.value = true;
          return;
        }
      }
      if (mapCard.value === el && !stage.card.value) {
        // What the testing tools' walks time the lending by.
        if (__TEST_TOOLS__) performance.mark("ac:home-card-lent");
        stage.card.value = el;
      }
    };
    /** Taken once the card comes within `rootMargin` of the screen. */
    const takeWithin = (rootMargin: string) => {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) take();
        },
        { rootMargin },
      );
      io.observe(el);
      cardIO.push(io);
    };
    takeWithin(NEAR_MARGIN);
    if (policy === "contact") return;
    if (policy === "proche") {
      // Passive: the page's scrolling never waits on it. Only a scroll that
      // leaves the top counts: the router's own scroll-to-top, on arriving
      // from a page that was scrolled, is not the visitor heading down.
      const onScroll = () => {
        if (window.scrollY <= 0) return;
        window.removeEventListener("scroll", onScroll);
        waiting = waiting.filter((w) => w.fn !== onScroll);
        takeWithin(LEAD_MARGIN);
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      waiting.push({ target: window, type: "scroll", fn: onScroll });
      return;
    }
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
  return { still };
}
