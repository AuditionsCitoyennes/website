// Whether the standing plateau wears its halo, compared live in the builds
// with the testing tools (the Témoignages page's DEV dialog, « Halo des
// frontières ») and kept in localStorage like the rise's choices
// (riseSwitch.ts):
//
// - "avec" (the default): today's look — the static violet glow ribbon that
//   fades outward from the foot of the plateau's wall, all along the chosen
//   territory's boundary (gl/PlateauWallLayer's halo pass, both regimes).
// - "sans": that pass is skipped (no draw call, no blending): the boundary is
//   the wall and its line alone. The ribbon's mesh is still built with the
//   plateau, so "avec" comes back at the next frame.
//
// The boundary lines themselves have no glow to switch: their one-pixel edge
// is their antialiasing (gl/plateauShaders' LINE_FS). The analyses' slabs keep
// their own glow either way: it rings their boxes, not a boundary.
//
// Applied live (PlateauWallLayer.setHaloShown, the map's watcher): no reload.
// Production has neither key nor switch: DEFAULT_BOUNDARY_HALO.
//
// No import but vue's ref (the DEV dialog redraws on it) and nothing run at
// load but the switch's read: loadable under node (haloSwitch.test.ts).
import { ref } from "vue";

export type BoundaryHalo = "avec" | "sans";

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_BOUNDARY_HALO: BoundaryHalo = "avec";

export const BOUNDARY_HALOS: readonly BoundaryHalo[] = ["avec", "sans"];

/** The kept choice, else the default (garbage or blocked storage too). */
export function storedBoundaryHalo(): BoundaryHalo {
  try {
    const raw = localStorage.getItem("ac:boundary-halo");
    return (BOUNDARY_HALOS as readonly string[]).includes(raw ?? "")
      ? (raw as BoundaryHalo)
      : DEFAULT_BOUNDARY_HALO;
  } catch {
    return DEFAULT_BOUNDARY_HALO;
  }
}

/** The choice now. */
export const boundaryHalo = ref<BoundaryHalo>(
  __TEST_TOOLS__ ? storedBoundaryHalo() : DEFAULT_BOUNDARY_HALO,
);

/** Another choice: kept, and drawn from the next frame (no reload). */
export function setBoundaryHalo(choice: BoundaryHalo) {
  if (!__TEST_TOOLS__) return;
  boundaryHalo.value = choice;
  try {
    localStorage.setItem("ac:boundary-halo", choice);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** Whether the plateau's halo pass draws under `choice`. */
export const haloShown = (choice: BoundaryHalo): boolean => choice === "avec";
