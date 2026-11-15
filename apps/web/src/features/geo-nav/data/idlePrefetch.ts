// The idle prefetch (the outline files, ac:outlines-ahead "idle"): a touch screen
// has no pointer to hover a row with, so nothing is asked ahead of its taps
// (data/hoverPrefetch.ts). Once the FIRST plateau stands, its lid has landed
// and the map is at rest, the one or two units under it that hold the most
// testimonies have the file their plateau would wait for asked, one at a
// time, through the loader's own prefetch (the HTTP cache only, at low
// priority): the tap on one of them then finds its file there. Each file waits for a map at rest of its own,
// so none is asked during a gesture, a flight or a rise; a visitor who never
// stops moving the map gets none. Once per page. Pure: the request, the
// guard and the wait are handed in (GeoNav: not under Save-Data, not on a
// slow link, not with a hovering pointer).

import type { DeviceTier } from "@/shared/device/deviceTier";

/** How many units are asked ahead on a device whose tier is "full", and on a
 *  weaker one. */
export const PREFETCH_UNITS = 2;
export const PREFETCH_UNITS_WEAK = 1;

/** The links that are too slow to spend on a file nobody asked for
 *  (navigator.connection.effectiveType, Chrome-family browsers only). */
const SLOW_LINKS: readonly string[] = ["slow-2g", "2g", "3g"];

export interface PrefetchGuard {
  /** The switch (data/prefetchSwitch.ts). */
  mode: "idle" | "off";
  /** The outline files are the session's source (not the fallback). */
  files: boolean;
  /** The main pointer hovers (a mouse): the row hover asks ahead there. */
  hover: boolean;
  /** The visitor asked the browser to save data. */
  saveData: boolean;
  /** navigator.connection.effectiveType; null: the browser does not say. */
  effectiveType: string | null;
}

/** Whether a file may be asked ahead now. A browser that says nothing of its
 *  link (Safari, Firefox) is not read as slow. */
export function prefetchAllowed(g: PrefetchGuard): boolean {
  if (g.mode !== "idle" || !g.files || g.hover || g.saveData) return false;
  return g.effectiveType === null || !SLOW_LINKS.includes(g.effectiveType);
}

/** How many units a device of this tier asks ahead. */
export const prefetchUnits = (tier: DeviceTier): number =>
  tier === "full" ? PREFETCH_UNITS : PREFETCH_UNITS_WEAK;

export interface PrefetchRow {
  id: string;
  /** The testimonies it holds. */
  count: number;
}

/** The `n` rows holding the most testimonies, the most first (ties: the
 *  list's order), among those that hold any and whose file can be asked
 *  (`fetchable`). */
export function pickPrefetch(
  rows: readonly PrefetchRow[],
  n: number,
  fetchable: (id: string) => boolean,
): string[] {
  return rows
    .map((r, at) => ({ r, at }))
    .filter(({ r }) => r.count > 0 && fetchable(r.id))
    .sort((a, b) => b.r.count - a.r.count || a.at - b.at)
    .slice(0, Math.max(0, n))
    .map(({ r }) => r.id);
}

export interface IdlePrefetchOptions {
  /** Read at each rest, before each file: false ends the prefetch. */
  allowed: () => boolean;
  /** The units to ask ahead under the unit `scopeId`, the first one first:
   *  read once, at the first rest. */
  targets: (scopeId: string) => string[];
  /** The loader's prefetch: settles with its request, never fails. */
  prefetch: (id: string) => Promise<void>;
  /** Runs `job` once the map is at rest (its lid landed, nothing moving, no
   *  pointer down); returns its cancellation. */
  whenAtRest: (job: () => void) => () => void;
}

export function idlePrefetch(o: IdlePrefetchOptions) {
  let state: "waiting" | "armed" | "done" = "waiting";
  let cancel: (() => void) | null = null;
  let queue: string[] | null = null;
  const asked: string[] = [];
  const end = () => {
    state = "done";
    cancel = null;
  };
  /** The next file, at the next rest. */
  const next = (scopeId: string) => {
    cancel = o.whenAtRest(() => {
      cancel = null;
      if (state !== "armed") return;
      if (!o.allowed()) return end();
      queue ??= o.targets(scopeId);
      const id = queue.shift();
      if (id === undefined) return end();
      asked.push(id);
      const after = () => {
        if (state !== "armed") return;
        if (queue?.length) next(scopeId);
        else end();
      };
      o.prefetch(id).then(after, after);
    });
  };
  return {
    /** A run of the plateau pipeline came to its verdict (GeoDrillMap's
     *  `plateauSettled`): the first plateau standing arms the prefetch. */
    settled(scopeId: string, how: string) {
      if (state !== "waiting" || !scopeId || how === "cleared" || how === "failed") return;
      state = "armed";
      next(scopeId);
    },
    /** The page is leaving: nothing more is asked. */
    stop() {
      cancel?.();
      end();
    },
    /** The files asked ahead so far (the testing tools read it). */
    asked: (): readonly string[] => asked,
    state: () => state,
  };
}
