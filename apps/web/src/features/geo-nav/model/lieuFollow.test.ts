// When the visitor's gesture closes the open lieu (lieuFollow.ts), run with
// `node --import tsx --test` (root "test:scripts"): the thresholds, the gate
// (the switch, filters on, the tail of the opening tap), and the feed — a
// gesture that moves the view far enough closes, once; a nudge does not; the
// camera's own moves (no gesture, or a command since the gesture began)
// never do.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPEN_TAIL_MS,
  PAN_PX,
  TURN_DEG,
  ZOOM_STEP,
  createLieuFollow,
  gestureCanClose,
  gestureMoved,
  panPx,
  type CameraAt,
  type FollowGate,
} from "./lieuFollow";

const LYON: CameraAt = { lng: 4.835, lat: 45.767, zoom: 16, bearing: 0, pitch: 45 };
/** `px` screen pixels east of `from`, at its zoom. */
const east = (from: CameraAt, px: number): CameraAt => ({
  ...from,
  lng: from.lng + (px / (512 * 2 ** from.zoom)) * 360,
});

test("the pan is measured in screen pixels at the anchor's zoom, both ways round", () => {
  assert.ok(Math.abs(panPx(LYON, east(LYON, 100)) - 100) < 1e-6);
  // North: mercator, not degrees.
  const north = { ...LYON, lat: LYON.lat + 0.001 };
  const px = panPx(LYON, north);
  assert.ok(px > 0 && Math.abs(px - panPx(north, LYON)) < 1);
  // Across the antimeridian: the short way.
  const a = { ...LYON, lng: 179.999, zoom: 10 };
  const b = { ...LYON, lng: -179.999, zoom: 10 };
  assert.ok(panPx(a, b) < 10);
});

test("the thresholds: a pan, a zoom or a turn that means it; a nudge does not", () => {
  assert.equal(PAN_PX, 30);
  assert.equal(ZOOM_STEP, 0.25);
  assert.equal(TURN_DEG, 10);
  assert.equal(gestureMoved(LYON, east(LYON, PAN_PX - 1)), false);
  assert.equal(gestureMoved(LYON, east(LYON, PAN_PX + 1)), true);
  assert.equal(gestureMoved(LYON, { ...LYON, zoom: LYON.zoom + 0.2 }), false);
  assert.equal(gestureMoved(LYON, { ...LYON, zoom: LYON.zoom - 0.3 }), true); // a wheel notch out
  assert.equal(gestureMoved(LYON, { ...LYON, bearing: 9 }), false);
  assert.equal(gestureMoved(LYON, { ...LYON, bearing: -12 }), true);
  assert.equal(gestureMoved({ ...LYON, bearing: 355 }, { ...LYON, bearing: 3 }), false); // 8°
  assert.equal(gestureMoved(LYON, { ...LYON, pitch: 30 }), true);
});

const open: FollowGate = { follows: true, lieuOpen: true, listMode: false, sinceOpenMs: 5000 };

test("the gate: « Suit la carte », a lieu open, no filters, past the opening tap", () => {
  assert.equal(gestureCanClose(open), true);
  assert.equal(gestureCanClose({ ...open, follows: false }), false); // « Reste ouvert »
  assert.equal(gestureCanClose({ ...open, lieuOpen: false }), false);
  assert.equal(gestureCanClose({ ...open, listMode: true }), false); // the results' list
  assert.equal(gestureCanClose({ ...open, sinceOpenMs: OPEN_TAIL_MS - 1 }), false);
  assert.equal(gestureCanClose({ ...open, sinceOpenMs: OPEN_TAIL_MS }), true);
});

/** A follow fed by a fake map: `cam` is where the camera is, `key` the last
 *  command's, `gate` what the page says. */
function rig(gate: Partial<FollowGate> = {}) {
  const s = { cam: LYON as CameraAt | null, key: 7, gate: { ...open, ...gate }, closed: 0 };
  const follow = createLieuFollow({
    cameraNow: () => s.cam,
    commandKey: () => s.key,
    gate: () => s.gate,
    close: () => s.closed++,
  });
  return { s, follow };
}

test("a drag that passes the threshold closes the lieu, once", () => {
  const { s, follow } = rig();
  follow.gesture(); // movestart
  s.cam = east(LYON, 12);
  follow.view(); // the first throttled view
  assert.equal(s.closed, 0);
  s.cam = east(LYON, 80);
  follow.gesture(); // said again as it goes on
  assert.equal(s.closed, 1);
  s.cam = east(LYON, 200);
  follow.view();
  follow.gesture();
  follow.view();
  assert.equal(s.closed, 1, "the count starts again, from the next gesture only");
});

test("a wheel notch out closes; a tiny nudge does not", () => {
  const wheel = rig();
  wheel.follow.gesture(); // the wheel event, before the zoom
  wheel.s.cam = { ...LYON, zoom: LYON.zoom - 0.55 };
  wheel.follow.view(); // its views, whoever mapbox says moved
  assert.equal(wheel.s.closed, 1);

  const nudge = rig();
  nudge.follow.gesture();
  nudge.s.cam = east(LYON, 6);
  nudge.follow.view();
  nudge.follow.view(); // the moveend view
  assert.equal(nudge.s.closed, 0);
});

test("nudges with no camera command between them add up", () => {
  const { s, follow } = rig();
  for (let i = 1; i <= 4; i++) {
    follow.gesture();
    s.cam = east(LYON, 10 * i);
    follow.view();
  }
  assert.equal(s.closed, 1); // at the third: 30 px from where the first one found it
});

test("the camera's own moves close nothing", () => {
  // No gesture: a flight landing far away, the padding ease, a resize.
  const quiet = rig();
  quiet.s.cam = east(LYON, 500);
  quiet.follow.view();
  quiet.s.cam = { ...LYON, zoom: 12 };
  quiet.follow.view();
  assert.equal(quiet.s.closed, 0);

  // A command after the gesture began: its flight is not the visitor's move.
  const cmd = rig();
  cmd.follow.gesture();
  cmd.s.key++; // a row of the lieu pressed: the map flies back to it
  cmd.s.cam = east(LYON, 400);
  cmd.follow.view();
  assert.equal(cmd.s.closed, 0);
  assert.equal(cmd.follow.anchor(), null);
  // The next gesture counts from where that flight left the camera.
  const landed = cmd.s.cam;
  cmd.follow.gesture();
  assert.deepEqual(cmd.follow.anchor(), landed);
  cmd.s.cam = east(landed, 10);
  cmd.follow.view();
  assert.equal(cmd.s.closed, 0);
  cmd.s.cam = east(landed, 40);
  cmd.follow.gesture();
  assert.equal(cmd.s.closed, 1);
});

test("filters on, « Reste ouvert », no lieu: a gesture closes nothing", () => {
  for (const gate of [{ listMode: true }, { follows: false }, { lieuOpen: false }]) {
    const { s, follow } = rig(gate);
    follow.gesture();
    s.cam = east(LYON, 300);
    follow.gesture();
    follow.view();
    assert.equal(s.closed, 0, JSON.stringify(gate));
    assert.equal(follow.anchor(), null);
  }
});

test("the tail of the opening tap is not counted; what follows it is, from where it is", () => {
  const { s, follow } = rig({ sinceOpenMs: 100 });
  follow.gesture(); // the double-tap's zoom, right after the tap that opened the lieu
  s.cam = { ...LYON, zoom: LYON.zoom + 0.8 };
  follow.view();
  assert.equal(s.closed, 0);
  assert.equal(follow.anchor(), null);
  s.gate.sinceOpenMs = OPEN_TAIL_MS + 50; // its ease ends
  const tail = s.cam;
  follow.gesture();
  s.cam = { ...tail, zoom: tail.zoom + 0.1 };
  follow.view();
  assert.equal(s.closed, 0);
  s.cam = east(tail, 60); // then a real drag
  follow.gesture();
  assert.equal(s.closed, 1);
});

test("no map yet: nothing to measure, nothing closed", () => {
  const { s, follow } = rig();
  s.cam = null;
  follow.gesture();
  follow.view();
  assert.equal(follow.anchor(), null);
  assert.equal(s.closed, 0);
});
