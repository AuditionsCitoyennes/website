// The map's two motion counters on the page (testing tools only; their
// definitions are in motionCounters.ts), read through `__acPerf.dump()`'s
// `probes` (shared/perf):
//
//   motion-mutations  the map's mutators are wrapped on the instance, a
//                     source's setData on the sources `getSource` hands out;
//                     "in motion" is the still-map scheduler's `busy()`
//                     (lib/stillMap.ts). A caller labels its mutations with
//                     `mutationScope(label)` and declares them planned with
//                     `mutationScope(label, { planned: true })`.
//   plateau-runs      usePlateau notes each run of its pipeline
//                     (`notePlateauRun`).
//
// Only what the app calls on the map is seen: mapbox-gl's own changes go
// through its style, not through these methods. The lid's hidden map is not
// wrapped. Every call from the product is gated on `perfOn`, like the
// engine's: a production build has none of this.

import type mapboxgl from "mapbox-gl";
import { perfOn, perfProbe } from "@/shared/perf/perf";
import { stillMap } from "../lib/stillMap";
import {
  MAP_MUTATORS,
  createMutationCounter,
  createPlateauRuns,
  mutationTarget,
} from "./motionCounters";

const mutations = perfOn ? createMutationCounter(() => stillMap.busy()) : null;
const runs = perfOn ? createPlateauRuns(() => performance.now()) : null;

const noop = () => {};

/** Label the map mutations issued until the function returned is called;
 *  `planned`: they are meant to happen in motion. Synchronous code only: call
 *  the function before any await. */
export function mutationScope(label: string, opts?: { planned?: boolean }): () => void {
  return mutations ? mutations.scope(label, opts) : noop;
}

/** The plateau pipeline runs for the unit `scope` ("": the plateau cleared). */
export function notePlateauRun(scope: string) {
  runs?.note(scope);
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/** Wrap the map's mutators and register the two probes; returns what unmount
 *  calls (the instance's own methods back). */
export function installMotionProbes(map: mapboxgl.Map): () => void {
  if (!mutations || !runs) return noop;
  const counter = mutations;
  const m = map as unknown as Record<string, AnyFn>;
  for (const name of MAP_MUTATORS) {
    const original = m[name];
    m[name] = function (...args) {
      counter.note(name, mutationTarget(name, args));
      return original.apply(this, args);
    };
  }
  // A source's setData, on each source as it is first handed out.
  const getSource = m.getSource;
  const wrapped = new WeakSet<object>();
  m.getSource = function (...args) {
    const source = getSource.apply(this, args) as { setData?: AnyFn } | undefined;
    if (source && typeof source.setData === "function" && !wrapped.has(source)) {
      wrapped.add(source);
      const setData = source.setData;
      const id = String(args[0]);
      source.setData = function (...a) {
        counter.note("setData", id);
        return setData.apply(this, a);
      };
    }
    return source;
  };
  perfProbe("motion-mutations", { read: counter.read, reset: counter.reset });
  perfProbe("plateau-runs", { read: runs.read, reset: runs.reset });
  return () => {
    // The instance's own properties removed: the prototype's methods again.
    for (const name of MAP_MUTATORS) delete m[name];
    delete m.getSource;
  };
}
