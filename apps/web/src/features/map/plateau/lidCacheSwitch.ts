// Whether the lid pictures already shot are kept for a unit selected again,
// compared live in the builds with the testing tools (the dev server and
// staging: __TEST_TOOLS__, vite.config), kept in localStorage like the answer
// to a tap (tapAnswerSwitch.ts) and drawn as the Témoignages page's DEV
// dialog's "Images gardées" row:
//
// - "on" (the default): the whole-unit pictures uploaded are kept, a few of
//   them, by bytes of graphics memory (lidCache.ts: less on a weak device).
//   A unit selected again shows its kept picture at once — no hidden-map
//   shot, no upload — and rises with its lid on. The shot of a run the
//   visitor has left is kept too when it lands, for the way back.
// - "off": as before — one lid texture, a shot for every selection.
//
// Under `ac:lid` "ancien" or "aucun" nothing is kept either way. Read at
// each ask: switching needs no reload (off drops what was kept). Production
// has neither key nor row: DEFAULT_LID_CACHE.

import { ref } from "vue";

export type LidCacheMode = "on" | "off";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_LID_CACHE: LidCacheMode = "on";

export const LID_CACHE_MODES: readonly LidCacheMode[] = ["on", "off"];

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
export const lidCacheMode = ref<LidCacheMode>(
  __TEST_TOOLS__ ? stored("ac:lid-cache", LID_CACHE_MODES, DEFAULT_LID_CACHE) : DEFAULT_LID_CACHE,
);

/** Another mode: kept, and in force from the next lid asked. */
export function setLidCacheMode(mode: LidCacheMode) {
  if (!__TEST_TOOLS__) return;
  lidCacheMode.value = mode;
  try {
    localStorage.setItem("ac:lid-cache", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
