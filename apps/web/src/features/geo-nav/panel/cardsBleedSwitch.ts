// Whether the panel's rows and testimonies run to the panel's edges, compared
// live in the builds with the testing tools (the dev server and staging:
// __TEST_TOOLS__, vite.config), kept in localStorage like the sign of a long
// wait (model/slowSignSwitch.ts) and drawn as the Témoignages page's DEV
// dialog's "Cartes sans marge" row:
//
// - "partout" (the default): the list has no side gutter on any screen; the
//   rows (places, auditions) and the open audition's testimonies keep their
//   own inner padding, set to the head's, so their text lines up with the
//   trail and never touches the panel's edge. Their hover ground and the
//   lines between rows span the whole panel.
// - "telephone": the same below 900 px (the phone's bottom sheet) only.
// - "marge": the gutter as before — the list inset from the panel's edges,
//   the testimonies indented under their audition.
//
// Read at each render (GeoPanel's class): no reload. Production has neither
// key nor row: DEFAULT_CARDS_BLEED.

import { ref } from "vue";

export type CardsBleed = "partout" | "telephone" | "marge";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_CARDS_BLEED: CardsBleed = "partout";

export const CARDS_BLEEDS: readonly CardsBleed[] = ["partout", "telephone", "marge"];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The mode now (a ref: the panel and the DEV dialog redraw from it). A build
 *  without the testing tools reads no key: the default. */
export const cardsBleed = ref<CardsBleed>(
  __TEST_TOOLS__
    ? stored("ac:cards-bleed", CARDS_BLEEDS, DEFAULT_CARDS_BLEED)
    : DEFAULT_CARDS_BLEED,
);

/** Another mode: kept, and in force at once. */
export function setCardsBleed(mode: CardsBleed) {
  if (!__TEST_TOOLS__) return;
  cardsBleed.value = mode;
  try {
    localStorage.setItem("ac:cards-bleed", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** The panel list's class for a mode: the bleed everywhere, on phones only
 *  (the media query is the stylesheet's), or none. */
export function cardsBleedClass(mode: CardsBleed): "bleed" | "bleed-phone" | null {
  return mode === "partout" ? "bleed" : mode === "telephone" ? "bleed-phone" : null;
}
