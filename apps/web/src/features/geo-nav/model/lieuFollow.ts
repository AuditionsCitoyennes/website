// When the visitor's own gesture on the map closes the open lieu (the
// « Suit la carte » mode of `ac:lieu-hold`, model/lieuHoldSwitch.ts). No
// import: loadable under node (lieuFollow.test.ts).
//
// The panel follows the map: once the visitor takes the map somewhere else
// by hand — a drag, the wheel or a pinch, a double-click or double-tap zoom,
// the keys on the map, a rotation — the lieu they were reading closes and the
// panel shows what is in view, as when no lieu is open. The trigger is the
// gesture, never a view change: the camera's own moves (the flight after a
// click, the results' arc, the padding ease, a resize) report views too, and
// close nothing.
//
// A grazed map is not taken somewhere else: the lieu closes only once the
// view has really moved from where the gesture found it — the ground point
// that stood at the view's centre by PAN_PX on screen (measured on the screen
// as it is now, so under the tilt a pixel is a pixel wherever the hand
// grabbed), its zoom by ZOOM_STEP, or its bearing or pitch by TURN_DEG.
// Measured from where the camera last came to rest, when nothing has moved
// it since (`rest`: mapbox moves the camera on the very event that starts a
// touch pan, by the 15-odd pixels it held back to tell a pan from a tap, so
// the camera at that first signal is already past them), else from the
// camera at the gesture's first signal (`anchor`); and within that one
// gesture only: a drag with its glide, a run of wheel events,
// a pinch. The camera coming to rest ends it (`end`), so two nudges minutes
// apart never add up; a camera command (a click's flight, a crumb's, the
// ring's fit) starts the count again too. The camera's centre is the padded
// view's: the padding ease and a resize leave it where it is.
//
// Not closed:
// - with filters on (the results' list): its open audition belongs to a list
//   that does not follow the map;
// - in the moments right after the lieu was opened (OPEN_TAIL_MS): the second
//   tap of a double-tap on its dot zooms the map, and is part of opening it.
//   Its zoom is counted from where it is once that time is over.

/** Where the camera is (map.getCenter / getZoom / getBearing / getPitch). */
export interface CameraAt {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Screen pixels the ground point at the view's centre must have travelled:
 *  past a click's slop and a finger's wobble on a tap, well short of a drag
 *  that means it. */
export const PAN_PX = 30;
/** Zoom levels. A lone notch of a mouse wheel on Windows or Linux zooms
 *  0.15 (Chrome) to 0.18 (Firefox) of a level at mapbox's wheel rate, and
 *  closes; a Mac's notch is about 0.03, so a short roll closes, one click
 *  does not. A grazed trackpad (a few pixels of scroll: about 0.05) and two
 *  fingers resting (mapbox's pinch starts at 0.1) do not. The wheel zooms
 *  around the pointer, so off the centre the pan's count can close first. */
export const ZOOM_STEP = 0.12;
/** Degrees of bearing or pitch: a rotation that means it. */
export const TURN_DEG = 10;
/** After a lieu is opened, the time its own tap may go on moving the map. */
export const OPEN_TAIL_MS = 400;

/** The angle between two bearings, in degrees (0–180). */
function turn(a: number, b: number): number {
  const d = Math.abs(((((b - a) % 360) + 540) % 360) - 180);
  return d;
}

/** The view has really moved from `from` to `to`, the ground point at
 *  `from`'s centre standing `shiftPx` screen pixels from the view's centre
 *  (NaN, a point the camera can no longer place, counts as moved). */
export function gestureMoved(from: CameraAt, to: CameraAt, shiftPx: number): boolean {
  return (
    Math.abs(to.zoom - from.zoom) >= ZOOM_STEP ||
    turn(from.bearing, to.bearing) >= TURN_DEG ||
    Math.abs(to.pitch - from.pitch) >= TURN_DEG ||
    !(shiftPx < PAN_PX)
  );
}

/** What says whether a gesture may close the lieu now. */
export interface FollowGate {
  /** The switch says « Suit la carte ». */
  follows: boolean;
  /** A lieu is open. */
  lieuOpen: boolean;
  /** Filters are on: the results' list. */
  listMode: boolean;
  /** Since the lieu was opened, in ms. */
  sinceOpenMs: number;
}

/** A gesture may close the lieu: see the head of the file. */
export function gestureCanClose(g: FollowGate): boolean {
  return g.follows && g.lieuOpen && !g.listMode && g.sinceOpenMs >= OPEN_TAIL_MS;
}

export interface LieuFollowInputs {
  /** The camera now; null while there is no map. */
  cameraNow: () => CameraAt | null;
  /** How far, in screen pixels, the ground point at `at`'s centre stands from
   *  the view's centre now; null while there is no map. */
  shiftPx: (at: CameraAt) => number | null;
  /** The last camera command's key (navState's cameraKey). */
  commandKey: () => number;
  gate: () => FollowGate;
  /** Closes the lieu (once per gesture that moved the view enough). */
  close: () => void;
}

/**
 * The rule above, fed by the map: `gesture()` at each signal of the
 * visitor's own gesture (GeoDrillMap's `userGesture`, which repeats while it
 * goes on), `view()` at each view the map reports, `due()` at each frame the
 * gesture moves the map (GeoDrillMap's `gestureMove`), `end()` when the
 * camera comes to rest (GeoDrillMap's `cameraRest`).
 */
export function createLieuFollow({
  cameraNow,
  shiftPx,
  commandKey,
  gate,
  close,
}: LieuFollowInputs) {
  let anchor: { at: CameraAt; key: number } | null = null;
  // Where the camera came to rest (`end`), until a view or an uncounted
  // gesture says it has moved since: where the next gesture starts from.
  let rest: { at: CameraAt; key: number } | null = null;

  /** The view has moved enough from the anchor (one `project` call). */
  function movedFrom(at: CameraAt): boolean {
    const now = cameraNow();
    const shift = shiftPx(at);
    return !!now && shift !== null && gestureMoved(at, now, shift);
  }

  function check() {
    if (!anchor) return;
    // A camera command since the anchor: its move is not the visitor's.
    if (anchor.key !== commandKey()) {
      anchor = null;
      return;
    }
    if (!movedFrom(anchor.at)) return;
    anchor = null;
    close();
  }

  return {
    gesture() {
      if (!gestureCanClose(gate())) {
        anchor = null;
        rest = null;
        return;
      }
      if (!anchor || anchor.key !== commandKey()) {
        const key = commandKey();
        const at = rest && rest.key === key ? rest.at : cameraNow();
        rest = null;
        anchor = at ? { at, key } : null;
      } else check();
    },
    view() {
      rest = null; // the camera has moved since it rested
      if (!gestureCanClose(gate())) {
        anchor = null;
        return;
      }
      check();
    },
    /**
     * At each frame the visitor's gesture moves the map (GeoDrillMap's
     * `gestureMove`, between its views, which come at most every 250 ms):
     * whether the view has now moved enough to close. Closes nothing: the
     * caller has the map report its view at once, and `view()` closes on it —
     * so the lieu closes on the frame the threshold is crossed, the scope
     * derived from that same view.
     */
    due(): boolean {
      if (!anchor || anchor.key !== commandKey() || !gestureCanClose(gate())) return false;
      return movedFrom(anchor.at);
    },
    end() {
      // The last view of the gesture is counted, then the gesture is over.
      if (gestureCanClose(gate())) check();
      anchor = null;
      const at = cameraNow();
      rest = at ? { at, key: commandKey() } : null;
    },
    /** Where the count starts, null when none (testing). */
    anchor: () => anchor?.at ?? null,
  };
}

export type LieuFollow = ReturnType<typeof createLieuFollow>;
