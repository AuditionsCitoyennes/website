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
// time cap: a hidden map that never renders keeps the old slot until it does,
// and a fast drill's spare slot waits for that frame too (its wait ends
// without a removal on abort, on the map's `remove`, or when the slot is
// re-added).

export type DemSlot = "plateau-dem-a" | "plateau-dem-b";

/** What the slots need of a mapbox map (`mapboxgl.Map` is one). */
export interface DemSlotMap<Spec = unknown> {
  once(type: "render" | "remove", listener: () => void): unknown;
  off(type: "render" | "remove", listener: () => void): unknown;
  getSource(id: string): unknown;
  addSource(id: string, spec: Spec): unknown;
  removeSource(id: string): unknown;
  getTerrain(): { source?: string } | null | undefined;
  triggerRepaint(): void;
}

/** The slot a swap left stays at least this long (ms). */
export const DROP_FLOOR_MS = 500;

export interface DemSlotsInputs<Spec> {
  /** The map of the moment: null once unmounted, another one after a remount. */
  getMap: () => DemSlotMap<Spec> | null;
  /** The slot the terrain is on (usePlateau's `terrainSrc`). */
  terrainSrc: () => DemSlot;
  /** A slot the swap left, removed by its drop (the client relief lets its key go). */
  onDrop?: (id: DemSlot) => void;
}

/** The slot `id`, the terrain itself, given new tiles in place (never removed:
 *  no generation bump either). `maxzoom` given: written into the source's
 *  options first — INTERNAL to mapbox-gl 3.34 (checked on 3.34.1, the range is
 *  ^3.34.1; re-check on upgrade): setTiles only replaces `_options.tiles` and
 *  its reload re-reads `_options`, so the old maxzoom would stay. */
export function repointDemSlot(map: DemSlotMap, id: DemSlot, template: string, maxzoom?: number) {
  const src = map.getSource(id) as
    { _options?: { maxzoom?: number }; setTiles?(tiles: string[]): unknown } | undefined;
  if (!src?.setTiles) return;
  if (maxzoom !== undefined && src._options) src._options.maxzoom = maxzoom;
  src.setTiles([template]);
}

export function createDemSlots<Spec>({ getMap, terrainSrc, onDrop }: DemSlotsInputs<Spec>) {
  // Bumped each time a slot is (re-)added: a drop scheduled for an older
  // generation of that slot is void.
  const slotGen: Record<DemSlot, number> = { "plateau-dem-a": 0, "plateau-dem-b": 0 };
  // The last swap: no frame rendered since, and the slot it left. One render
  // listener at a time: a newer swap replaces it.
  let swapRenderPending = false;
  let swapLeft: DemSlot | null = null;
  let offSwapRender: (() => void) | null = null;
  // What abort() clears: one pending drop per slot (a newer drop of the same
  // slot replaces it), and the spare slot's waits (each one's ending, by slot).
  const drops = new Map<DemSlot, () => void>();
  const waits = new Map<(proceed: boolean) => void, DemSlot>();

  /** The one place a slot's generation moves: removed if present, then added.
   *  A wait for this slot still pending is superseded: it ends, not to proceed. */
  function addDemSlot(map: DemSlotMap<Spec>, id: DemSlot, spec: Spec) {
    for (const [end, slot] of [...waits]) if (slot === id) end(false);
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

  /** Whether `id` is the slot the last swap left, with no frame rendered since
   *  — and still a source: one never added (the first swap's `old`) cannot be
   *  named by the evaluated terrain. */
  function spareNeedsFrame(map: DemSlotMap<Spec>, id: DemSlot): boolean {
    return swapRenderPending && swapLeft === id && !!map.getSource(id);
  }

  /** Before the spare slot `id` is removed: one repaint asked, then `true` at
   *  the first rendered frame, however long it takes (removing before it is the
   *  race). `false`, not to proceed, when no frame can come for this wait:
   *  abort(), the map's `remove`, `id` re-added, or a throw from the map. */
  function waitForFrame(map: DemSlotMap<Spec>, id: DemSlot): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const end = (proceed: boolean) => {
        if (settled) return;
        settled = true;
        waits.delete(end);
        try {
          map.off("render", onRender);
          map.off("remove", onRemove);
        } catch {
          /* a removed map */
        }
        resolve(proceed);
      };
      const onRender = () => end(true);
      const onRemove = () => end(false);
      waits.set(end, id);
      try {
        map.once("render", onRender);
        map.once("remove", onRemove);
        map.triggerRepaint();
      } catch {
        end(false);
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
          onDrop?.(id);
        }
      } catch {
        /* leave it resident — retried implicitly on the next swap into this slot */
      }
      cancel();
    };
    timer = setTimeout(tryDrop, DROP_FLOOR_MS);
    drops.set(id, cancel);
  }

  /** Unmount: no timer left, no listener left, every wait ended (not to proceed). */
  function abort() {
    offSwapRender?.();
    for (const cancel of [...drops.values()]) cancel();
    for (const end of [...waits.keys()]) end(false);
  }

  return { addDemSlot, swapped, spareNeedsFrame, waitForFrame, dropDemSourceSoon, abort };
}
