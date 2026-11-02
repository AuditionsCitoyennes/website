// What a plateau run does with the spare DEM slot (usePlateau's ensurePlateau),
// pure: no mapbox import, no __TEST_TOOLS__ read — run with
// `node --import tsx --test` (root "test:scripts").
//
// The slot: a spare slot that already is the terrain (a superseded run left it
// there under ac:relief-prefetch=terrain0, relief/reliefSwitch.ts) must never
// be removed — mapbox breaks on a terrain source removed — so it is re-pointed
// at the new template, or kept as it is when it already loads it. That test
// holds in every mode and route: a run that fell back to "serveur" after a
// terrain0 run meets the same slot. Otherwise the slot is added as today.
//
// The prefetch: the invisible hillshade (today), unless a "client" run's
// prefetch is terrain0 — then no hillshade, and the new slot becomes the root
// terrain at exaggeration 0 at once when nothing of ours stands. The QUIET swap
// keeps the hillshade: its wait for the new tiles only ends on tiles if
// something makes the spare slot request them (a raster-dem source with no
// layer that is not the terrain reads loaded with none).

import type { ReliefMode, ReliefPrefetch } from "./reliefSwitch";

export interface PrefetchInputs {
  prefetch: ReliefPrefetch;
  /** This run's route (after a fallback: "serveur"). */
  route: ReliefMode;
  /** A plateau of ours stands (`plateauVersion !== ""`). */
  standing: boolean;
  /** The quiet-swap condition: the same unit, a plateau standing, a terrain set. */
  quiet: boolean;
  /** The spare slot is the terrain (`getTerrain()?.source === next`). */
  nextIsTerrain: boolean;
  /** The spare slot is a source. */
  nextExists: boolean;
  /** The spare slot's template and maxzoom as last set (`serialize()`, not `.tiles`). */
  nextTemplate?: string;
  nextMaxzoom?: number;
  /** This run's template and canonical zoom. */
  template: string;
  zCanon: number;
}

export interface PrefetchPlan {
  /** "add": addDemSlot; "repoint": new tiles on the standing source; "keep": nothing. */
  slot: "add" | "repoint" | "keep";
  /** "repoint": the source's maxzoom changes too. */
  setMaxzoom: boolean;
  /** The invisible prefetch hillshade on the slot. */
  hillshade: boolean;
  /** The slot becomes the root terrain at exaggeration 0 now. */
  earlyTerrain: boolean;
}

export function planPrefetch(i: PrefetchInputs): PrefetchPlan {
  const dropHillshade = i.route === "client" && i.prefetch !== "hillshade" && !i.quiet;
  let slot: PrefetchPlan["slot"] = "add";
  let setMaxzoom = false;
  if (i.nextIsTerrain && i.nextExists) {
    setMaxzoom = i.nextMaxzoom !== i.zCanon;
    slot = i.nextTemplate === i.template && !setMaxzoom ? "keep" : "repoint";
  }
  return {
    slot,
    setMaxzoom,
    hillshade: !dropHillshade,
    earlyTerrain: dropHillshade && !i.standing && !i.nextIsTerrain,
  };
}
