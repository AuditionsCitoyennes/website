// The map credit's fold: the compact « i » (GeoDrillMap's own attribution
// control) shown opened at first, then folded once. Pure: a map-like object and
// a box getter, no mapbox import — run with `node --import tsx --test` (root
// "test:scripts").
//
// Why: the OpenStreetMap Foundation's attribution guidelines let an interactive
// map collapse its credit only after it has been shown — on a dismiss, on map
// interaction or after 5 s. Mapbox's explicit `compact: true` never opens the
// « i » by itself (AttributionControl.onAdd adds `mapboxgl-compact` and stops
// there; only its click handler, _toggleAttribution, shows it). So the caller
// arms this the first time the credit may be shown opened (`openCredit`), and
// it writes the very state that toggle's "show" branch writes, then its "hide"
// branch, once.
//
// What folds it: the user's own move — a `dragstart`/`zoomstart`/`pitchstart`/
// `rotatestart` that carries a DOM event (camera commands, the intro tilt and
// the drills carry none: the camera's own markInteracted rule), a wheel turn
// (a single notch's zoomstart has no event, mapbox starts it from its own
// 40 ms timer) and the box zoom (its flight has none either); 5 s; or the
// caller's "fold now" (the credit leaves the layout where it may be open: back
// in the card, the sheet raised, a narrow window). A click on the « i » while
// open is the visitor's dismiss: mapbox's toggle has closed it, nothing to write.
//
// Once, then never again: idle → open → done, never back. After that, and
// after a dismiss, the visitor's clicks are mapbox's alone; the fold sets
// explicit states and never toggles, so that click works from whatever is shown.

/** The fold comes at the latest this long after the credit opens (ms). */
export const FOLD_MS = 5000;
/** The starts that fold the credit when they carry a DOM event. */
export const FOLD_ON = ["dragstart", "zoomstart", "pitchstart", "rotatestart"] as const;
/** Mapbox's class for an opened compact control (its CSS shows the text). */
export const SHOW = "mapboxgl-compact-show";

type Listener = (e: { originalEvent?: { deltaY?: number } | null }) => void;

/** What the fold needs of a mapbox map (`mapboxgl.Map` is one). */
export interface FoldMap {
  on(type: string, fn: Listener): unknown;
  off(type: string, fn: Listener): unknown;
}

/** The compact control's container and « i » button now, or null (no control, or not compact). */
export interface CreditBox {
  container: { classList: { add(c: string): void; remove(c: string): void } };
  button: {
    setAttribute(n: string, v: string): void;
    addEventListener(t: "click", fn: () => void): void;
    removeEventListener(t: "click", fn: () => void): void;
  };
}

export interface CreditFold {
  /** The credit may be shown opened: open it (the first time only). */
  arm(): void;
  /** Fold it now, if still open. */
  fold(): void;
  /** A new control replaced the old one: open it too, if the fold is still due. */
  replaced(): void;
  /** The map goes: stop listening, write nothing. */
  dispose(): void;
  state(): "idle" | "open" | "done";
}

export function creditFold(
  map: FoldMap,
  box: () => CreditBox | null,
  timers: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void } = {
    set: (f, ms) => setTimeout(f, ms),
    clear: (id) => clearTimeout(id as number),
  },
): CreditFold {
  let state: "idle" | "open" | "done" = "idle";
  let bound: CreditBox | null = null;
  let timer: unknown = null;

  // Mapbox's _toggleAttribution, its "show" branch; plus our dismiss listener
  // (after mapbox's own, bound at onAdd: it has closed the control by then).
  const open = (b: CreditBox) => {
    b.container.classList.add(SHOW);
    b.button.setAttribute("aria-expanded", "true");
    b.button.addEventListener("click", dismissed);
    bound = b;
  };
  const end = () => {
    state = "done";
    timers.clear(timer);
    timer = null;
    for (const type of FOLD_ON) map.off(type, onStart);
    map.off("wheel", onWheel);
    map.off("boxzoomstart", fold);
    bound?.button.removeEventListener("click", dismissed);
    bound = null;
  };
  // …and its "hide" branch.
  function fold() {
    if (state !== "open") return;
    const b = bound;
    end();
    if (!b) return;
    b.container.classList.remove(SHOW);
    b.button.setAttribute("aria-expanded", "false");
  }
  // Named: a harness can tell this timer from the page's others.
  function foldOnTimer() {
    fold();
  }
  const onStart: Listener = (e) => {
    if (e.originalEvent) fold();
  };
  const onWheel: Listener = (e) => {
    if (e.originalEvent?.deltaY) fold();
  };
  const dismissed = () => end();

  return {
    arm() {
      if (state !== "idle") return;
      const b = box();
      if (!b) {
        state = "done"; // not compact: mapbox's to decide
        return;
      }
      state = "open";
      open(b);
      for (const type of FOLD_ON) map.on(type, onStart);
      map.on("wheel", onWheel);
      map.on("boxzoomstart", fold);
      timer = timers.set(foldOnTimer, FOLD_MS);
    },
    fold,
    replaced() {
      if (state !== "open") return;
      // The old button is detached (onRemove): let our listener go with it.
      bound?.button.removeEventListener("click", dismissed);
      bound = null;
      const b = box();
      if (b) open(b);
      else end();
    },
    dispose() {
      if (state === "open") end();
      else state = "done";
    },
    state: () => state,
  };
}
