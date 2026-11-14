// The measure the device's tier asks of the map (shared/device/deviceTier
// `reportFrameTimes`): the frames of its first flight to a territory, timed
// once per page load. The only signal a browser that hides its hardware
// gives (Safari, Firefox), and the only one that tells slow graphics behind
// an ordinary renderer name. Slow frames step the tier down, kept 30 days;
// the lighter variants read it from the next territory (the flat ground) or
// the next page load (the multisampling, graphicsSwitch.ts).
//
// Which flight: one a camera command starts (`begin()`, called by the shell
// right after it runs the command) — not the intro's tilt, not a padding
// ease, not a gesture — and only once the map has come to rest since its
// load (`attach()`: its first `idle`), so the page's own boot is not what is
// timed. A flight whose frames are too few to judge (an instant move, one
// cut short) or that the page was hidden during is dropped, and the next one
// is tried.
//
// How: lib/flightFrames.ts. The map's own `render` events give the frames (a
// flight draws them anyway: nothing is asked of the map, no repaint, no
// loop), and a zero-delay timer chained for the length of the flight tells
// how much of each frame the page's thread worked. Everything is taken down
// when the flight lands, and at the latest FLIGHT_MAX_MS after it began.
//
// `ac:frame-measure=off` (graphicsSwitch.ts, the testing tools): no measure.
// With the testing tools the outcome is a `flight.frames` note in the perf
// dump (its length; detail: frames, slow, verySlow, workShare, told — false:
// too few frames, dropped —, tier and kind — the step the device stands at).

import type mapboxgl from "mapbox-gl";
import {
  MIN_FLIGHT_FRAMES,
  MIN_FLIGHT_MS,
  SLOW_FRAME_MS,
  VERY_SLOW_FRAME_MS,
  reportFrameTimes,
  type FrameSample,
  type MeasuredStep,
} from "@/shared/device/deviceTier";
import { perfNote, perfOn } from "@/shared/perf/perf";
import { frameMeasure } from "../graphicsSwitch";
import { flightFrames, flightTells, type FlightFrames } from "../lib/flightFrames";

/** A flight still in the air this long after it began is let go. */
const FLIGHT_MAX_MS = 10_000;

/** The flight's outcome in the perf dump (testing tools). */
function note(samples: readonly FrameSample[], told: boolean, step: MeasuredStep | null) {
  let total = 0;
  let work = 0;
  let slow = 0;
  let verySlow = 0;
  for (const s of samples) {
    if (typeof s === "number") continue;
    total += s.ms;
    work += s.workMs ?? 0;
    if (s.ms >= SLOW_FRAME_MS) slow++;
    if (s.ms > VERY_SLOW_FRAME_MS) verySlow++;
  }
  perfNote("flight.frames", total, {
    frames: samples.length,
    slow,
    verySlow,
    workShare: total > 0 ? +(work / total).toFixed(2) : 0,
    told,
    tier: step?.tier ?? "full",
    kind: step?.kind ?? "none",
  });
}

/** This page load's measure is made (or was never wanted). */
let measured = frameMeasure === "off";

export function useFlightMeasure({ getMap }: { getMap: () => mapboxgl.Map | null }) {
  /** The map has come to rest once since its load. */
  let rested = false;
  /** The flight being timed: its recorder and what takes it down. */
  let flight: { rec: FlightFrames; stop: () => void } | null = null;

  /** The map, once created: flights count from its first rest. */
  function attach(map: mapboxgl.Map) {
    if (measured) return;
    void map.once("idle", () => {
      rested = true;
    });
  }

  /** Take the flight being timed down, its frames dropped. */
  function drop() {
    flight?.stop();
    flight = null;
  }

  /** A camera command has just run: time its flight, if it is one. */
  function begin() {
    if (measured || !rested) return;
    const map = getMap();
    if (!map || !map.isEasing() || document.visibilityState !== "visible") return;
    drop(); // a command replacing the flight being timed: this one is timed
    const rec = flightFrames(performance.now());
    let timer = 0;
    const ping = () => {
      rec.ping(performance.now());
      if (rec.full()) drop();
      else timer = window.setTimeout(ping, 0);
    };
    const onRender = () => rec.frame(performance.now());
    const onHidden = () => {
      if (document.visibilityState !== "visible") drop();
    };
    const onLanded = () => {
      // A `moveend` with the flight still in the air is a resize's, not a landing.
      if (map.isEasing()) return;
      const samples = rec.end(performance.now());
      drop();
      // Too few frames to judge (an instant move, a flight cut short): the next one.
      const told = flightTells(samples, MIN_FLIGHT_FRAMES, MIN_FLIGHT_MS);
      const step = told ? reportFrameTimes(samples) : null;
      if (told) measured = true;
      if (perfOn) note(samples, told, step);
    };
    const giveUp = window.setTimeout(drop, FLIGHT_MAX_MS);
    map.on("render", onRender);
    map.on("moveend", onLanded);
    document.addEventListener("visibilitychange", onHidden);
    timer = window.setTimeout(ping, 0);
    flight = {
      rec,
      stop: () => {
        window.clearTimeout(timer);
        window.clearTimeout(giveUp);
        map.off("render", onRender);
        map.off("moveend", onLanded);
        document.removeEventListener("visibilitychange", onHidden);
      },
    };
  }

  return { attach, begin, dispose: drop };
}
