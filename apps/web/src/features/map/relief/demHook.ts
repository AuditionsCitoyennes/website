// The map's door to the client relief: the transformRequest the map is
// given, and the lazy client behind it. Tiny on purpose: the map imports it statically, and the
// client (demClient.ts: the answer policy, the worker, the main-thread
// renderer) is a chunk of its own, loaded on first use.
//
// Mapbox calls transformRequest on the main thread for EVERY resource the map
// loads (style, tiles, sprites, glyphs) and awaits it: anything but our
// template gets `undefined` at once (the URL left as it is); ours resolves
// `{ url: <data: PNG> }`, never rejects.

import { GROUND_DATA_URL } from "./demGround";
import { DEM_SCHEME } from "./demTiles";

type DemClient = typeof import("./demClient");

let client: Promise<DemClient> | null = null;

/** The client relief, loaded once; a chunk that failed to load is asked again at the next call. */
export function loadReliefClient(): Promise<DemClient> {
  return (client ??= import("./demClient").catch((e: unknown) => {
    client = null;
    throw e;
  }));
}

/** The map's transformRequest: our `ac-dem://` tiles answered, every other URL left alone. */
export function demTransformRequest(
  url: string,
  _type?: string,
  opts?: { signal?: AbortSignal },
): Promise<{ url: string }> | undefined {
  if (!url.startsWith(DEM_SCHEME)) return undefined;
  // A client that never loaded registered no selection either: ground.
  return loadReliefClient().then(
    (c) => c.answer(url, opts),
    () => ({ url: GROUND_DATA_URL }),
  );
}
