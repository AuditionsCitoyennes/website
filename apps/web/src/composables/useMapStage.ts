import { computed, nextTick, shallowRef, type ShallowRef } from "vue";

// The testimonies map exists ONCE, above the pages (MapStage, in App): a card
// on the home page, the whole of /temoignages. Going from one to the other
// moves that same map — it is neither reloaded nor billed again — and opening
// the card grows it into the page while the rest of the home page fades away.
//
// The pages only lend it a place: the home page its card, /temoignages its
// whole area.

export interface StageRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The home page's card, once it is near the screen. */
const card = shallowRef<HTMLElement | null>(null);
/** The /temoignages page's place for the map. */
const page = shallowRef<HTMLElement | null>(null);
/** The card growing into the page: where the map is drawn meanwhile (fixed,
 *  in viewport coordinates). */
const opening = shallowRef<StageRect | null>(null);

const alive = computed(() => Boolean(card.value || page.value || opening.value));

/**
 * Give the map its place back — after the current render: the page coming
 * next (the router swaps the two in one go) lends its own place in the
 * meantime, so the map moves over instead of being torn down and rebuilt.
 */
function release(slot: ShallowRef<HTMLElement | null>, el: HTMLElement | null) {
  void nextTick(() => {
    if (slot.value === el) slot.value = null;
  });
}

export function useMapStage() {
  return { card, page, opening, alive, release };
}
