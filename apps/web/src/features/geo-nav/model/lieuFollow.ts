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
// view has really moved from where the gesture found it — its centre by
// PAN_PX screen pixels, its zoom by ZOOM_STEP, or its bearing or pitch by
// TURN_DEG. Measured from the camera at the gesture's first signal
// (`anchor`), so the moves of a series of gestures with no camera command
// between them add up; a camera command (a click's flight, a crumb's, the
// ring's fit) starts the count again. The camera's centre is the padded
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

/** Screen pixels the centre must have travelled: past a click's slop and a
 *  finger's wobble on a tap, well short of a drag that means it. */
export const PAN_PX = 30;
/** Zoom levels: one notch of a mouse wheel (about half a level) closes, a
 *  trackpad grazed or the wobble of two fingers resting does not. */
export const ZOOM_STEP = 0.25;
/** Degrees of bearing or pitch: a rotation that means it. */
export const TURN_DEG = 10;
/** After a lieu is opened, the time its own tap may go on moving the map. */
export const OPEN_TAIL_MS = 400;

const TILE = 512;

/** A point's position in mercator world pixels at `zoom`. */
function worldPx(lng: number, lat: number, zoom: number): [number, number] {
  const size = TILE * 2 ** zoom;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [((lng + 180) / 360) * size, y * size];
}

/** How far the centre moved, in screen pixels at the anchor's zoom (the
 *  shorter way round the antimeridian). */
export function panPx(from: CameraAt, to: CameraAt): number {
  let dLng = to.lng - from.lng;
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;
  const [x0, y0] = worldPx(from.lng, from.lat, from.zoom);
  const [x1, y1] = worldPx(from.lng + dLng, to.lat, from.zoom);
  return Math.hypot(x1 - x0, y1 - y0);
}

/** The angle between two bearings, in degrees (0–180). */
function turn(a: number, b: number): number {
  const d = Math.abs(((((b - a) % 360) + 540) % 360) - 180);
  return d;
}

/** The view has really moved from `from` to `to`. */
export function gestureMoved(from: CameraAt, to: CameraAt): boolean {
  return (
    Math.abs(to.zoom - from.zoom) >= ZOOM_STEP ||
    turn(from.bearing, to.bearing) >= TURN_DEG ||
    Math.abs(to.pitch - from.pitch) >= TURN_DEG ||
    panPx(from, to) >= PAN_PX
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
  /** The last camera command's key (navState's cameraKey). */
  commandKey: () => number;
  gate: () => FollowGate;
  /** Closes the lieu (once per gesture that moved the view enough). */
  close: () => void;
}

/**
 * The rule above, fed by the map: `gesture()` at each signal of the
 * visitor's own gesture (GeoDrillMap's `userGesture`, which repeats while it
 * goes on), `view()` at each view the map reports.
 */
export function createLieuFollow({ cameraNow, commandKey, gate, close }: LieuFollowInputs) {
  let anchor: { at: CameraAt; key: number } | null = null;

  function check() {
    if (!anchor) return;
    // A camera command since the anchor: its move is not the visitor's.
    if (anchor.key !== commandKey()) {
      anchor = null;
      return;
    }
    const now = cameraNow();
    if (!now || !gestureMoved(anchor.at, now)) return;
    anchor = null;
    close();
  }

  return {
    gesture() {
      if (!gestureCanClose(gate())) {
        anchor = null;
        return;
      }
      if (!anchor || anchor.key !== commandKey()) {
        const at = cameraNow();
        anchor = at ? { at, key: commandKey() } : null;
      } else check();
    },
    view() {
      if (!gestureCanClose(gate())) {
        anchor = null;
        return;
      }
      check();
    },
    /** Where the count starts, null when none (testing). */
    anchor: () => anchor?.at ?? null,
  };
}

export type LieuFollow = ReturnType<typeof createLieuFollow>;
