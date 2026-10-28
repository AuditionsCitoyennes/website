// Where the Témoignages page's figures come from (map phase 1, design A20),
// compared live in the builds with the testing tools — the dev server and
// staging (__TEST_TOOLS__, vite.config), kept in localStorage like the
// analyses' DEV switches (analyses/devSwitch.ts):
//
// - "Données": "corpus" — today: every testimony downloaded, the tree, counts
//   and figures made in the page; "serveur" — the tree, its counts, the
//   analyses' figures, the filter dialog's facets and the result count from
//   /api/places, the auditions' lists from its siblings (PR K): neither the
//   corpus nor /api/map is asked for; "comparer" — the server's on screen,
//   the corpus' made beside it, and every difference listed in
//   window.__acCompare and __acCompareLists (compare.ts), a badge counting
//   them. Read once per page load: switching reloads the page (a
//   picked place is a name in one, an id in the other).
// - "Arbre des lieux": the place picker's tree from the server, the
//   arrondissements of Paris, Lyon and Marseille flattened into their commune
//   as today ("sans"), or kept as a level ("avec").
//
// Production has neither: DEFAULT_SOURCE (PR L flips it), no key, no switch.
import { ref } from "vue";

export type DataSource = "corpus" | "serveur" | "comparer";
export type PlaceTreeMode = "sans" | "avec";

/** The source of a build without the testing tools. */
export const DEFAULT_SOURCE: DataSource = "corpus";

export const DATA_SOURCES: readonly DataSource[] = ["corpus", "serveur", "comparer"];
const SOURCE_KEY = "ac:data-source";
const TREE_KEY = "ac:place-tree";

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

/** This page load's source. */
export const dataSource: DataSource = __TEST_TOOLS__
  ? stored(SOURCE_KEY, DATA_SOURCES, DEFAULT_SOURCE)
  : DEFAULT_SOURCE;

/** Another source: kept, and the page loaded again with it. */
export function setDataSource(source: DataSource) {
  if (!__TEST_TOOLS__ || source === dataSource) return;
  store(SOURCE_KEY, source);
  window.location.reload();
}

export const placeTreeMode = ref<PlaceTreeMode>(
  __TEST_TOOLS__ ? stored(TREE_KEY, ["sans", "avec"], "sans") : "sans",
);

export function setPlaceTreeMode(mode: PlaceTreeMode) {
  if (!__TEST_TOOLS__) return;
  placeTreeMode.value = mode;
  store(TREE_KEY, mode);
}
