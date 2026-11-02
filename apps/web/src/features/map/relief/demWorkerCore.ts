// The relief worker's body, pure so the tests run it without a Worker
// (demWorker.ts is the thin entry that wires it to `self`). It holds the
// selections by version key and renders one tile per request with
// demRaster.ts, answering a data: URL of the PNG.
//
// Messages: {t:"set", id, json, height, pins} -> {id, key, bbox, vertices, ms};
// {t:"tile", id, key, z, x, y} -> {id, url, kind, ms, msRaster, msEncode}, kind
// "unknown" (no url) when the key is not held; any throw -> {id, error}.
//
// Ordering: `receive` only enqueues; one pump handles the jobs one at a time,
// every queued `set` before any queued `tile`, so a new selection never waits
// behind the previous one's renders. The main side posts a key's tiles only
// after its `set` reply, so the priority cannot reorder a dependency.
//
// The key is the server's SHA-1 key (keyOfJson): computed here, off the main
// thread. Without crypto.subtle it is the page-local "f" fallback; without
// CompressionStream the PNG is stored-block zlib (encodePNG).

import {
  SIZE,
  constantRgb,
  encodePNG,
  makeSelection,
  pngDataUrl,
  renderDemTile,
  type DemSelection,
} from "./demRaster";
import { keyOfJson, vertexCount, type Polygon } from "./demGeometry";

export type DemSetJob = { t: "set"; id: number; json: string; height: number; pins: string[] };
export type DemTileJob = { t: "tile"; id: number; key: string; z: number; x: number; y: number };
export type DemJob = DemSetJob | DemTileJob;

export interface DemReply {
  id: number;
  error?: string;
  // set
  key?: string;
  bbox?: [number, number, number, number];
  vertices?: number;
  // tile
  url?: string;
  kind?: "raster" | "raster-ground" | "raster-plateau" | "unknown";
  ms?: number;
  msRaster?: number;
  msEncode?: number;
}

/** The store's bounds: versions, and projected vertices held across them. */
export const MAX_VERSIONS = 40;
export const MAX_STORED_VERTICES = 1_000_000;

export interface DemWorkerCoreOptions {
  /** Test seam: `null` stands for an engine without crypto.subtle. */
  digest?: ((bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>) | null;
}

export function createDemWorkerCore(
  post: (reply: DemReply) => void,
  opts: DemWorkerCoreOptions = {},
) {
  const store = new Map<string, { sel: DemSelection; vertices: number }>();
  let storedVertices = 0;
  const constants = new Map<number, Promise<string>>();
  const sets: DemJob[] = [];
  const tiles: DemJob[] = [];
  let pumping = false;

  function constantUrl(h: number): Promise<string> {
    let p = constants.get(h);
    if (!p) {
      const mine = encodePNG(constantRgb(h), SIZE, SIZE).then(pngDataUrl);
      constants.set(h, mine);
      // A failed encode is not memoised: the next constant tile tries again.
      mine.catch(() => {
        if (constants.get(h) === mine) constants.delete(h);
      });
      p = mine;
    }
    return p;
  }

  // Oldest first, never the key just set nor a key a live slot holds.
  function evict(keep: Set<string>): void {
    for (const k of [...store.keys()]) {
      if (store.size <= MAX_VERSIONS && storedVertices <= MAX_STORED_VERTICES) return;
      if (keep.has(k)) continue;
      storedVertices -= store.get(k)!.vertices;
      store.delete(k);
    }
  }

  async function handle(m: DemJob, t0: number): Promise<DemReply> {
    if (m.t === "set") {
      const key = await keyOfJson(m.json, opts.digest);
      let held = store.get(key);
      if (held) {
        store.delete(key); // a hit keeps the first height, refreshed
      } else {
        const polys = (JSON.parse(m.json) as { polys: Polygon[] }).polys;
        const vertices = vertexCount(polys);
        // The stored height is the first registered, unrounded one (the server's).
        held = { sel: makeSelection(polys, m.height), vertices };
        storedVertices += vertices;
      }
      store.set(key, held);
      evict(new Set([key, ...m.pins]));
      const { bbox } = held.sel;
      return { id: m.id, key, bbox, vertices: held.vertices, ms: performance.now() - t0 };
    }
    const held = store.get(m.key);
    if (!held) return { id: m.id, kind: "unknown", ms: performance.now() - t0 };
    store.delete(m.key);
    store.set(m.key, held);
    const tile = renderDemTile(held.sel, m.z, m.x, m.y);
    const t1 = performance.now();
    const url =
      tile.constant === "ground"
        ? await constantUrl(0)
        : tile.constant === "plateau"
          ? await constantUrl(held.sel.height)
          : pngDataUrl(await encodePNG(tile.rgb, SIZE, SIZE));
    const t2 = performance.now();
    return {
      id: m.id,
      url,
      kind: tile.constant ? `raster-${tile.constant}` : "raster",
      ms: t2 - t0,
      msRaster: tile.msRaster,
      msEncode: t2 - t1,
    };
  }

  async function pump(): Promise<void> {
    pumping = true;
    for (let m = sets.shift() ?? tiles.shift(); m; m = sets.shift() ?? tiles.shift()) {
      let reply: DemReply;
      try {
        reply = await handle(m, performance.now());
      } catch (e) {
        reply = { id: m.id, error: String(e) };
      }
      post(reply);
    }
    pumping = false;
  }

  return {
    /** Synchronous: enqueue, and start the pump if it is idle. */
    receive(m: DemJob): void {
      (m.t === "set" ? sets : tiles).push(m);
      if (!pumping) void pump();
    },
    /** Test seam: the keys held, oldest first. */
    keys: () => [...store.keys()],
  };
}
