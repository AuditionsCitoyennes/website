// What the map does when the request for its style fails (`ac:recover`
// "auto", shared/net/recoverSwitch.ts). Mapbox asks for the style once: when
// that request fails, the map stays an empty dark box for good. Here the
// style is asked again by itself, a bounded number of times with a growing
// pause (STYLE_RETRY_WAITS_MS); after the last failure the map's box says so
// ("down": GeoDrillMap shows the fallback of `ac:map-fallback` and a
// « Réessayer »), and from then on only the visitor's button, the browser
// back online or the page shown again ask again — once each. The style
// arriving at any moment ends it all ("in").
//
// A failure a new attempt would not change (`final`: the server answered
// that the style is not there) skips the pauses and goes "down" at once: the
// button still asks again.
//
// Pure: the timers and the request are injected (styleRecovery.test.ts).

/** The pauses before each new attempt by itself, ms. */
export const STYLE_RETRY_WAITS_MS: readonly number[] = [1000, 2000, 4000];

/**
 * - "loading": the style is on its way (the first request, or a new attempt
 *   made by itself).
 * - "waiting": a request failed, the next attempt waits for its pause.
 * - "down": every attempt failed; the box shows its message and its button.
 * - "asking": the message still up, an attempt asked for is on its way.
 * - "in": the style is there.
 */
export type StyleState = "loading" | "waiting" | "down" | "asking" | "in";

type Timer = unknown;

export function createStyleRecovery(o: {
  /** Ask for the style again. */
  ask: () => void;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
  /** The state changed. */
  onState?: (state: StyleState) => void;
  /** The pauses (default STYLE_RETRY_WAITS_MS). */
  waits?: readonly number[];
}) {
  const waits = o.waits ?? STYLE_RETRY_WAITS_MS;
  let state: StyleState = "loading";
  /** The attempts made by themselves so far. */
  let n = 0;
  let timer: Timer | undefined;

  function set(next: StyleState) {
    if (next === state) return;
    state = next;
    o.onState?.(next);
  }
  function clear() {
    if (timer === undefined) return;
    o.clearTimer(timer);
    timer = undefined;
  }

  return {
    /** The style's request failed. `final`: a new attempt now would get the
     *  same answer. */
    failed(final = false) {
      if (state === "in" || state === "down" || state === "waiting") return;
      if (state === "asking" || final || n >= waits.length) {
        set("down");
        return;
      }
      const ms = waits[n++];
      set("waiting");
      timer = o.setTimer(() => {
        timer = undefined;
        set("loading");
        o.ask();
      }, ms);
    },
    /** The style is there. */
    arrived() {
      clear();
      set("in");
    },
    /** The visitor asks, or the network may be back: an attempt now, where
     *  one is waited for ("down": the message stays up meanwhile; "waiting":
     *  the pause is cut short). Whether one was made. */
    retry(): boolean {
      if (state === "down") {
        set("asking");
        o.ask();
        return true;
      }
      if (state === "waiting") {
        clear();
        set("loading");
        o.ask();
        return true;
      }
      return false;
    },
    /** The map is gone. */
    stop: clear,
    state: () => state,
  };
}

export type StyleRecovery = ReturnType<typeof createStyleRecovery>;

/** What a map's `error` event must look like to be the style's own request
 *  failing: no style yet, and nothing naming a source or a tile (theirs
 *  cannot fail before the style is in, but the check costs nothing). */
export function isStyleRequestError(
  e: { sourceId?: unknown; tile?: unknown; source?: unknown },
  styleIn: boolean,
): boolean {
  return !styleIn && e.sourceId === undefined && e.tile === undefined && e.source === undefined;
}

/** An HTTP answer a new attempt would not change: the request was understood
 *  and refused (4xx), except a timeout (408) and « too many requests » (429). */
export function finalStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
