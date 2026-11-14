// Whether a touch screen fetches outline files ahead of a tap, compared live
// in the builds with the testing tools (the dev server and staging:
// __TEST_TOOLS__, vite.config), kept in localStorage like what a pan does to
// the selected zone (model/scopeHold.ts) and drawn as the Témoignages page's
// DEV dialog's "Contours d'avance" row:
//
// - "idle" (the default): on a screen no pointer hovers, once the first
//   plateau and its lid have landed and the map is at rest, the one or two
//   units under it that hold the most testimonies have the file their plateau
//   would wait for asked ahead (data/idlePrefetch.ts, GeoNav).
// - "off": nothing is asked ahead on a touch screen, as before.
//
// A mouse's row hover asks ahead either way (data/hoverPrefetch.ts).
// Production has neither key nor row: DEFAULT_PREFETCH.

import { ref } from "vue";

export type PrefetchMode = "idle" | "off";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_PREFETCH: PrefetchMode = "idle";

export const PREFETCH_MODES: readonly PrefetchMode[] = ["idle", "off"];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The mode now (a ref: the DEV dialog redraws its row from it). A build
 *  without the testing tools reads no key: the default. */
export const prefetchMode = ref<PrefetchMode>(
  __TEST_TOOLS__ ? stored("ac:outlines-ahead", PREFETCH_MODES, DEFAULT_PREFETCH) : DEFAULT_PREFETCH,
);

/** Another mode: kept, and read when the map next comes to rest (a file
 *  already asked ahead stays asked). */
export function setPrefetchMode(mode: PrefetchMode) {
  if (!__TEST_TOOLS__) return;
  prefetchMode.value = mode;
  try {
    localStorage.setItem("ac:outlines-ahead", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
