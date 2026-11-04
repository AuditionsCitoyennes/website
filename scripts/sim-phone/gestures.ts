// W3C Actions for one- and two-finger touch gestures (pure): a tap, a pan and
// a pinch, in viewport CSS pixels. Coordinates are integers kept one pixel
// inside the viewport, since a driver refuses a pointer move outside it.

import type { ActionSequence } from "./webdriver";

export type Point = readonly [number, number];
export interface Viewport {
  width: number;
  height: number;
}

const clamp = ([x, y]: Point, v: Viewport): [number, number] => [
  Math.min(Math.max(Math.round(x), 1), v.width - 2),
  Math.min(Math.max(Math.round(y), 1), v.height - 2),
];

/** One finger: down at `from`, moved to `to` over `ms`, up. */
function finger(id: string, from: Point, to: Point, ms: number, v: Viewport): ActionSequence {
  const [x0, y0] = clamp(from, v);
  const [x1, y1] = clamp(to, v);
  return {
    type: "pointer",
    id,
    parameters: { pointerType: "touch" },
    actions: [
      { type: "pointerMove", duration: 0, origin: "viewport", x: x0, y: y0 },
      { type: "pointerDown", button: 0 },
      {
        type: "pointerMove",
        duration: Math.max(0, Math.round(ms)),
        origin: "viewport",
        x: x1,
        y: y1,
      },
      { type: "pointerUp", button: 0 },
    ],
  };
}

/** A one-finger tap held `ms`. In the iOS Simulator, the element click endpoint starts a touch
 *  that never ends (no pointerup, no click); a tap as actions fires the whole sequence. */
export function touchTap(at: Point, ms: number, viewport: Viewport): { actions: ActionSequence[] } {
  const [x, y] = clamp(at, viewport);
  return {
    actions: [
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x, y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: Math.max(0, Math.round(ms)) },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  };
}

/** A one-finger pan from `from` by `delta` over `ms`. */
export function touchPan(
  from: Point,
  delta: Point,
  ms: number,
  viewport: Viewport,
): { actions: ActionSequence[] } {
  return {
    actions: [finger("finger1", from, [from[0] + delta[0], from[1] + delta[1]], ms, viewport)],
  };
}

/** A two-finger pinch about `center`, the fingers on a horizontal line `2·r0` apart at the
 *  start and `2·r1` at the end (r1 > r0 spreads them: a zoom in). */
export function touchPinch(
  center: Point,
  r0: number,
  r1: number,
  ms: number,
  viewport: Viewport,
): { actions: ActionSequence[] } {
  const [cx, cy] = center;
  return {
    actions: [
      finger("finger1", [cx - r0, cy], [cx - r1, cy], ms, viewport),
      finger("finger2", [cx + r0, cy], [cx + r1, cy], ms, viewport),
    ],
  };
}
