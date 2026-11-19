// What opening a lieu with one audition does, compared live in the builds
// with the testing tools (the dev server and staging: __TEST_TOOLS__,
// vite.config), kept in localStorage like the sign of a long wait
// (model/slowSignSwitch.ts) and drawn as the Témoignages page's DEV dialog's
// "Lieu à une audition" row:
//
// - "ouvrir" (the default): the lieu opens with its audition open, as if the
//   visitor had then chosen it in the lieu's list (model/lieuSingle.ts has
//   the rule).
// - "lister": the lieu's list of auditions, one line to open, as before.
//
// Read at each lieu opened: no reload. Production has neither key nor row:
// DEFAULT_LIEU_SINGLE.

import { ref } from "vue";

export type LieuSingleMode = "ouvrir" | "lister";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_LIEU_SINGLE: LieuSingleMode = "ouvrir";

export const LIEU_SINGLE_MODES: readonly LieuSingleMode[] = ["ouvrir", "lister"];

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
export const lieuSingleMode = ref<LieuSingleMode>(
  __TEST_TOOLS__
    ? stored("ac:lieu-single", LIEU_SINGLE_MODES, DEFAULT_LIEU_SINGLE)
    : DEFAULT_LIEU_SINGLE,
);

/** Another mode: kept, and in force from the next lieu opened. */
export function setLieuSingleMode(mode: LieuSingleMode) {
  if (!__TEST_TOOLS__) return;
  lieuSingleMode.value = mode;
  try {
    localStorage.setItem("ac:lieu-single", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
