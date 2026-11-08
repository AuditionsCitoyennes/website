// The row-hover prefetch (the outline files, model/outlineRules rule 7): a
// panel row held under the pointer (or the keyboard's focus) HOVER_HOLD_MS
// asks for its unit's bundle ahead of the click, through the loader's own
// request, so the click joins it or finds it in the HTTP cache. One at a
// time: a row held while one is under way is asked once that one settles,
// if it is still held. Pure: the request, the guard and the timers are
// handed in (GeoNav: k/ files only, no prefetch without a hovering pointer
// or under Save-Data).

export const HOVER_HOLD_MS = 150;

export interface HoverPrefetchOptions {
  prefetch: (id: string) => Promise<void>;
  /** Read once a row is held: false asks nothing. */
  allowed: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

export function hoverPrefetch(o: HoverPrefetchOptions) {
  let timer: unknown = null;
  /** The row held HOVER_HOLD_MS and still hovered. */
  let held: string | null = null;
  let busy = false;
  const ask = (id: string) => {
    busy = true;
    const done = () => {
      busy = false;
      if (held !== null && held !== id) ask(held);
    };
    o.prefetch(id).then(done, done);
  };
  const stop = () => {
    if (timer !== null) o.clearTimer(timer);
    timer = null;
    held = null;
  };
  return {
    /** The hovered row changed (null: none). */
    hover(id: string | null) {
      stop();
      if (id === null) return;
      timer = o.setTimer(() => {
        timer = null;
        if (!o.allowed()) return;
        held = id;
        if (!busy) ask(id);
      }, HOVER_HOLD_MS);
    },
    stop,
  };
}
