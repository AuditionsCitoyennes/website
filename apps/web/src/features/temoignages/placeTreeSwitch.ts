// The place picker's tree (map phase 1, design A20), compared live in the
// builds with the testing tools — the dev server and staging (__TEST_TOOLS__,
// vite.config), kept in localStorage like the analyses' DEV switches
// (analyses/devSwitch.ts): « Arbre des lieux », the arrondissements of Paris,
// Lyon and Marseille flattened into their commune ("sans"), or kept as a level
// ("avec").
//
// Production has no key and no switch: "sans".
import { ref } from "vue";

export type PlaceTreeMode = "sans" | "avec";

const TREE_KEY = "ac:place-tree";

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

export const placeTreeMode = ref<PlaceTreeMode>(
  __TEST_TOOLS__ ? stored(TREE_KEY, ["sans", "avec"], "sans") : "sans",
);

export function setPlaceTreeMode(mode: PlaceTreeMode) {
  if (!__TEST_TOOLS__) return;
  placeTreeMode.value = mode;
  try {
    localStorage.setItem(TREE_KEY, mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
