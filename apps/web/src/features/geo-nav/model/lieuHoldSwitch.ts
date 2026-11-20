// What an open lieu does when the visitor starts using the map, compared live
// in the builds with the testing tools (the dev server and staging:
// __TEST_TOOLS__, vite.config), kept in localStorage like the one of a lieu
// with one audition (model/lieuSingleSwitch.ts) and drawn as the Témoignages
// page's DEV dialog's « Lieu ouvert et carte » row:
//
// - "suit" (the default): a gesture of the visitor's own that really moves the
//   map (model/lieuFollow.ts has the rule and its thresholds) closes the lieu,
//   and the panel follows the map live again, as when no lieu is open. The
//   panel stays where it is on a desktop; a phone's sheet lowers.
// - "reste": the lieu stays open whatever the map does (only the trail, or
//   another lieu, leaves it); the wide panel folds aside while the map is used
//   and comes back as it was.
//
// Read at each gesture: no reload. Production has neither key nor row:
// DEFAULT_LIEU_HOLD.

import { ref } from "vue";

export type LieuHoldMode = "suit" | "reste";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_LIEU_HOLD: LieuHoldMode = "suit";

export const LIEU_HOLD_MODES: readonly LieuHoldMode[] = ["suit", "reste"];

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
export const lieuHoldMode = ref<LieuHoldMode>(
  __TEST_TOOLS__ ? stored("ac:lieu-hold", LIEU_HOLD_MODES, DEFAULT_LIEU_HOLD) : DEFAULT_LIEU_HOLD,
);

/** Another mode: kept, and in force from the next gesture on the map. */
export function setLieuHoldMode(mode: LieuHoldMode) {
  if (!__TEST_TOOLS__) return;
  lieuHoldMode.value = mode;
  try {
    localStorage.setItem("ac:lieu-hold", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
