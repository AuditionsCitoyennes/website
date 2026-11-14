// The sign of a long wait, compared live in the builds with the testing tools
// (the dev server and staging: __TEST_TOOLS__, vite.config), kept in
// localStorage like what a pan does to the selected zone (model/scopeHold.ts)
// and drawn as the Témoignages page's DEV dialog's "Attente longue" row:
//
// - "on" (the default): a tapped territory whose plateau is still on its way
//   once the camera has landed, SLOW_SIGN_FLOOR_MS at least after the tap,
//   gets a small moving sign on its pill and beside its name in the panel's
//   breadcrumb; SLOW_WAIT_MS after the tap the mark goes and the panel says
//   the map is taking longer than expected, with a « Réessayer » button
//   (model/tapPendingCore.ts has the rule).
// - "off": no sign and no sentence: the pending mark alone, until its
//   PENDING_CAP_MS, as before.
//
// Read at each tap: no reload. Production has neither key nor row:
// DEFAULT_SLOW_SIGN.

import { ref } from "vue";

export type SlowSignMode = "on" | "off";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_SLOW_SIGN: SlowSignMode = "on";

export const SLOW_SIGN_MODES: readonly SlowSignMode[] = ["on", "off"];

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
export const slowSignMode = ref<SlowSignMode>(
  __TEST_TOOLS__ ? stored("ac:slow-sign", SLOW_SIGN_MODES, DEFAULT_SLOW_SIGN) : DEFAULT_SLOW_SIGN,
);

/** Another mode: kept, and in force from the next tap. */
export function setSlowSignMode(mode: SlowSignMode) {
  if (!__TEST_TOOLS__) return;
  slowSignMode.value = mode;
  try {
    localStorage.setItem("ac:slow-sign", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
