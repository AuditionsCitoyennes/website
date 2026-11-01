import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { useMapStage } from "@/features/map-stage";

// The map card: lent to the one testimonies map (MapStage) — and lending it is
// what loads the map: its code, both Mapbox maps, the map's data. So it is
// lent only to a visitor on the way to it; one who stays on the hero, or reads
// the project and leaves, loads none of it.
// - Reached (within NEAR_MARGIN of the screen: a quick scroll, a reload half
//   way down): at once, whatever the policy — even before the page is in.
// - Heading there ("proche", the policy of every build without the testing
//   tools): from the visitor's first scroll on, a screen ahead (LEAD_MARGIN) —
//   the map loads while the copy beside it is read, and is ready to be opened
//   into the testimonies page by the time it is reached. Never on the layout
//   alone: a visitor who does not scroll lends it nothing, however tall the
//   screen.
// - And at once when the map already exists (back from /temoignages: it comes
//   straight back into its card).
//
// Compared live in the builds with the testing tools (the dev server and
// staging, __TEST_TOOLS__), kept in localStorage like the Témoignages page's
// data switches (temoignages/dataSource.ts) and read once per page load —
// switching reloads the page (DevHomeMapSwitch, window.__acHomeMap):
// - "proche": as above;
// - "tot": as before — taken as well once the page itself is in (the document
//   loaded, the hero photograph shown: the map must not compete with it) and
//   the browser has a moment, whether the visitor heads there or not;
// - "contact": reached only (NEAR_MARGIN) — the least loaded, the latest.

export type HomeMapPolicy = "proche" | "tot" | "contact";

/** The policy of a build without the testing tools, and the switch's default. */
export const DEFAULT_HOME_MAP: HomeMapPolicy = "proche";

export const HOME_MAP_POLICIES: readonly HomeMapPolicy[] = ["proche", "tot", "contact"];
const POLICY_KEY = "ac:home-map";

/** Reached: the card this close to the screen is lent at once, in every policy. */
const NEAR_MARGIN = "300px 0px";
/** Heading there ("proche"): a screen ahead — to tune once phones are measured. */
const LEAD_MARGIN = "100% 0px";

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** This page load's policy. */
export const homeMapPolicy: HomeMapPolicy = __TEST_TOOLS__
  ? stored(POLICY_KEY, HOME_MAP_POLICIES, DEFAULT_HOME_MAP)
  : DEFAULT_HOME_MAP;

/** Another policy: kept, and the page loaded again with it. */
export function setHomeMapPolicy(policy: HomeMapPolicy) {
  if (!__TEST_TOOLS__ || policy === homeMapPolicy) return;
  store(POLICY_KEY, policy);
  window.location.reload();
}

/**
 * Lends `mapCard` to the map for as long as the calling component is mounted.
 * `heroReady`: the hero photograph is shown (HeroSection's `ready`) — what the
 * "tot" policy waits for.
 */
export function useMapCardSlot(mapCard: Ref<HTMLElement | null>, heroReady: Ref<boolean>) {
  const stage = useMapStage();
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
    if (!el) return;
    if (stage.alive.value) {
      stage.card.value = el;
      return;
    }
    const take = () => {
      stopWaiting();
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
    if (homeMapPolicy === "contact") return;
    if (homeMapPolicy === "proche") {
      // Passive: the page's scrolling never waits on it.
      once(window, ["scroll"], () => takeWithin(LEAD_MARGIN), { passive: true });
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
}
