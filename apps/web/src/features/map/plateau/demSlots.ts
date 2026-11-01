// The plateau's two DEM source slots (usePlateau): a slot added, the swap onto
// it, and the slot the swap left dropped once that is safe. Pure: a map-like
// object, no mapbox import — run with `node --import tsx --test` (root
// "test:scripts").
//
// Why a RENDERED frame: mapbox's removeSource re-runs its terrain update at
// once, and that reads the terrain's source as last EVALUATED, which only a
// rendered frame refreshes; getTerrain() reads the stylesheet, which
// setTerrain changes at once. So removing the slot a swap left before any
// frame has rendered since finds the evaluated terrain still naming it
// ("Couldn't find terrain source", a stale frame) and no getTerrain() guard
// can see it. One rendered frame since the swap is enough.
//
// Removing a raster-dem source in the SAME tick as a terrain change crashes
// inside mapbox's updateTerrain on globe with fragment styles ("Cannot read
// properties of undefined (reading 'get')") — hit both when a swap replaced the
// fragment's own terrain (after a teardown's setTerrain(null)) and when it
// replaced ours. So the slot a swap left is dropped LATER, in a terrain-quiet
// task (a timer, never inside mapbox's render handler), guarded and swallowed:
// a stale resident source is harmless, a crashed pipeline is not. There is no
// time cap: a hidden map that never renders keeps the old slot until it does.

export type DemSlot = "plateau-dem-a" | "plateau-dem-b";

/** What the slots need of a mapbox map (`mapboxgl.Map` is one). */
export interface DemSlotMap<Spec = unknown> {
  once(type: "render", listener: () => void): unknown;
  off(type: "render", listener: () => void): unknown;
  getSource(id: string): unknown;
  addSource(id: string, spec: Spec): unknown;
  removeSource(id: string): unknown;
  getTerrain(): { source?: string } | null | undefined;
  triggerRepaint(): void;
}

/** The slot a swap left stays at least this long (ms). */
export const DROP_FLOOR_MS = 500;
/** The spare slot waits at most this long (ms) for the frame after a swap. */
export const SPARE_WAIT_CAP_MS = 1000;

export interface DemSlotsInputs<Spec> {
  /** The map of the moment: null once unmounted, another one after a remount. */
  getMap: () => DemSlotMap<Spec> | null;
  /** The slot the terrain is on (usePlateau's `terrainSrc`). */
  terrainSrc: () => DemSlot;
}

export function createDemSlots<Spec>({ getMap, terrainSrc }: DemSlotsInputs<Spec>) {
  // Bumped each time a slot is (re-)added: a drop scheduled for an older
  // generation of that slot is void.
  const slotGen: Record<DemSlot, number> = { "plateau-dem-a": 0, "plateau-dem-b": 0 };
  // The last swap: no frame rendered since, and the slot it left. One render
  // listener at a time: a newer swap replaces it.
  let swapRenderPending = false;
  let swapLeft: DemSlot | null = null;
  let offSwapRender: (() => void) | null = null;
  // What abort() clears: one pending drop per slot (a newer drop of the same
  // slot replaces it), and the spare slot's waits.
  const drops = new Map<DemSlot, () => void>();
  const waits = new Set<() => void>();

  /** The one place a slot's generation moves: removed if present, then added. */
  function addDemSlot(map: DemSlotMap<Spec>, id: DemSlot, spec: Spec) {
    if (map.getSource(id)) map.removeSource(id);
    slotGen[id]++;
    map.addSource(id, spec);
  }

  /** After a setTerrain that moved the terrain off `left`: no frame has rendered since. */
  function swapped(map: DemSlotMap<Spec>, left: DemSlot) {
    offSwapRender?.();
    swapRenderPending = true;
    swapLeft = left;
    const onRender = () => {
      offSwapRender = null;
      swapRenderPending = false;
    };
    map.once("render", onRender);
    offSwapRender = () => {
      map.off("render", onRender);
      offSwapRender = null;
    };
  }

  /** Whether `id` is the slot the last swap left, with no frame rendered since. */
  function spareNeedsFrame(id: DemSlot): boolean {
    return swapRenderPending && swapLeft === id;
  }

  /** One repaint asked, then the first rendered frame or SPARE_WAIT_CAP_MS,
   *  whichever comes first (abort() resolves it too). */
  function waitForFrame(map: DemSlotMap<Spec>): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waits.delete(done);
        try {
          map.off("render", done);
        } catch {
          /* a removed map */
        }
        resolve();
      };
      const timer = setTimeout(done, SPARE_WAIT_CAP_MS);
      waits.add(done);
      try {
        map.once("render", done);
        map.triggerRepaint();
      } catch {
        done();
      }
    });
  }

  /** The slot `id` a swap just left, removed DROP_FLOOR_MS later — and only
   *  once a frame has rendered since the swap, on the same map, while no newer
   *  addDemSlot re-used it and the terrain is not on it. */
  function dropDemSourceSoon(map: DemSlotMap<Spec>, id: DemSlot) {
    // Never added (the first swap's `old`): nothing to drop.
    if (!map.getSource(id)) return;
    drops.get(id)?.();
    const gen = slotGen[id];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onRender: (() => void) | null = null;
    const cancel = () => {
      clearTimeout(timer);
      if (onRender) map.off("render", onRender);
      onRender = null;
      if (drops.get(id) === cancel) drops.delete(id);
    };
    const tryDrop = () => {
      timer = undefined;
      try {
        if (getMap() !== map || slotGen[id] !== gen) return cancel();
        if (swapRenderPending) {
          // Out of mapbox's render handler: the next try runs in its own task.
          onRender = () => {
            onRender = null;
            timer = setTimeout(tryDrop, 0);
          };
          map.once("render", onRender);
          map.triggerRepaint();
          return;
        }
        if (terrainSrc() !== id && map.getTerrain()?.source !== id && map.getSource(id)) {
          map.removeSource(id);
        }
      } catch {
        /* leave it resident — retried implicitly on the next swap into this slot */
      }
      cancel();
    };
    timer = setTimeout(tryDrop, DROP_FLOOR_MS);
    drops.set(id, cancel);
  }

  /** Unmount: no timer left, no listener left, every wait resolved. */
  function abort() {
    offSwapRender?.();
    for (const cancel of [...drops.values()]) cancel();
    for (const done of [...waits]) done();
  }

  return { addDemSlot, swapped, spareNeedsFrame, waitForFrame, dropDemSourceSoon, abort };
}
