// The map's WebGL context, lost and given back. A browser takes a page's
// context away when the graphics memory runs short (a phone under memory
// pressure, a tab kept in the background, a driver reset) and hands back an
// empty one later: every program, buffer and texture made on the old one is
// gone. Mapbox rebuilds its own and fires `webglcontextrestored`; it does not
// run `onAdd` again for a custom layer, so what the map's own layers hold has
// to be made again by hand.
//
// `createContextWatch(steps)` is that hand, without the map: `lost()` and
// `restored()` are called from mapbox's two events (composables/
// useContextRestore.ts); a restore runs every step once, in order.
//
// - A step that throws does not keep the next ones from running: a lid that
//   cannot be shot again must not leave the walls unbuilt. Its name is kept
//   (`state().failed`) and handed to `onError`.
// - The loss is counted once however many times it is told before the
//   restore. A restore with no loss told before it runs the steps all the
//   same: the event says the context is a new one.
// - `state()` is what the testing probe shows (`__acPlateau().context`).
//
// No import: loadable under node (contextWatch.test.ts).

export interface ContextStep {
  /** What it rebuilds, for the probe and the error line. */
  name: string;
  run: () => void;
}

export interface ContextState {
  /** Between a loss and its restore. */
  lost: boolean;
  /** Losses so far on this map. */
  losses: number;
  /** Restores so far on this map. */
  restores: number;
  /** The steps that threw at the last restore (empty: none). */
  failed: string[];
}

export function createContextWatch(
  steps: readonly ContextStep[],
  onError?: (name: string, err: unknown) => void,
) {
  let lost = false;
  let losses = 0;
  let restores = 0;
  let failed: string[] = [];

  return {
    /** Mapbox's `webglcontextlost`. */
    lost() {
      if (lost) return;
      lost = true;
      losses++;
    },
    /** Mapbox's `webglcontextrestored`: every step, in order. Returns the
     *  names of those that threw. */
    restored(): string[] {
      lost = false;
      restores++;
      failed = [];
      for (const step of steps) {
        try {
          step.run();
        } catch (err) {
          failed.push(step.name);
          onError?.(step.name, err);
        }
      }
      return [...failed];
    },
    state(): ContextState {
      return { lost, losses, restores, failed: [...failed] };
    },
  };
}
