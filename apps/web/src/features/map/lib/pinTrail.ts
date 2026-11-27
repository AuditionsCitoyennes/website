// Where the lieux' dots went while the camera flew (useMapPins). Pure: no
// Vue, no DOM.
//
// A finger aims at a dot moving across the screen and lands where the dot
// was a moment before: by the time the touch arrives, the dot has gone on
// and the touch is the canvas's. A touch stops the flight; its click then
// reads the dot whose path passed under the finger just before the press,
// as a press on the dot itself — that lieu opens as it opens at rest. Only
// where the dot went slowly enough for an eye to follow it: a dot swept
// across the screen in the flight's fast stretch was aimed at nowhere on
// that stretch, and a tap there stays the map's. A press with the map at
// rest, a drag or a pinch is not looked at here.

/** A lieu's dot on the screen (px, the map's container), as drawn. */
export interface TrailPin {
  id: string;
  x: number;
  y: number;
}

/** The dots drawn on one frame of a flight, at a clock time (ms). */
export interface TrailSample {
  t: number;
  pins: TrailPin[];
}

/** How far back (ms) the trail is kept: well past TRAIL_WINDOW_MS. */
export const TRAIL_KEEP_MS = 1000;

/** How far back (ms) before the press a dot's path is read: the time a
 *  finger takes to land on what the eye aimed at. */
export const TRAIL_WINDOW_MS = 350;

/** How far (px) past a dot's rim the path is still under the finger. Kept
 *  small: a tap beside a dot's path stays a tap on the map. */
export const TRAIL_SLOP_PX = 10;

/** The fastest (px/ms) a dot goes, between two frames, where it can still
 *  have been aimed at: about a phone's width in a third of a second. Taps
 *  on a moving dot, measured, aimed where it went at 0.6 px/ms or less; the
 *  flight's fast stretch sweeps the dots at 1.5 to 6 px/ms. */
export const TRAIL_AIM_SPEED = 1;

/** The trail with `sample` added, the samples older than `keepMs` before it
 *  dropped (in place). */
export function pushTrail(trail: TrailSample[], sample: TrailSample, keepMs = TRAIL_KEEP_MS): void {
  trail.push(sample);
  let old = 0;
  while (old < trail.length - 1 && sample.t - trail[old].t > keepMs) old++;
  if (old) trail.splice(0, old);
}

/** The squared distance from (px, py) to the segment (ax, ay)–(bx, by). */
function segmentDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const k = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const ex = ax + k * dx - px;
  const ey = ay + k * dy - py;
  return ex * ex + ey * ey;
}

/**
 * The dot whose path passed within `hitPx` of the press (x, y) in the
 * `windowMs` before it (the press's time `t`), or null: between two frames
 * a dot is taken to have gone straight from one point to the next, and a
 * stretch it went faster than `aimSpeed` (px/ms) along is not looked at;
 * the frames drawn after the press neither (a mouse's press does not stop
 * the flight). Of several, the one whose path went nearest the press — in a
 * flight the dots follow one another, and the one behind passes beside the
 * point the one ahead was aimed at; at the same distance, the one there
 * latest.
 */
export function pinOnTrail(
  trail: readonly TrailSample[],
  press: { x: number; y: number; t: number },
  o: { windowMs: number; hitPx: number; aimSpeed: number },
): string | null {
  const from = press.t - o.windowMs;
  let best: string | null = null;
  let bestD2 = o.hitPx * o.hitPx;
  for (let i = trail.length - 1; i >= 0; i--) {
    const now = trail[i];
    if (now.t < from) break;
    if (now.t > press.t) continue;
    const before = i > 0 && trail[i - 1].t >= from ? trail[i - 1] : null;
    const was = before ? new Map(before.pins.map((p) => [p.id, p])) : null;
    const dt = before ? now.t - before.t : 0;
    for (const p of now.pins) {
      const q = was?.get(p.id) ?? p;
      const len = Math.hypot(p.x - q.x, p.y - q.y);
      if (len > 0 && (dt <= 0 || len / dt > o.aimSpeed)) continue;
      const d2 = segmentDist2(press.x, press.y, q.x, q.y, p.x, p.y);
      // Newest first: a later frame keeps a tie.
      if (d2 < bestD2 || (best === null && d2 === bestD2)) {
        best = p.id;
        bestD2 = d2;
      }
    }
  }
  return best;
}
