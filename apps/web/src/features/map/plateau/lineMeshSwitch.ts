// How the boundary lines' mesh is laid out (gl/meshBuild.ts builds it,
// PlateauWallLayer draws it), compared live in the builds with the testing
// tools (`ac:line-mesh`, the Témoignages page's DEV dialog, « Traits ») and
// kept in localStorage like the mesh's mode (meshSwitch.ts):
//
// - "lean" (the default): one record per segment, its two ends, drawn as
//   instances of one six-corner quad (gl/lineSegments.ts): 24 bytes a segment
//   in the flat view's buffer instead of 192, 72 instead of 480 in the
//   globe's. On the lid, a segment two units share is kept once and blended
//   at the opacity two passes give. The same pixels.
// - "full": six vertices a segment, each with both ends, and every unit's
//   whole ring: the layout as before.
//
// Read once per page load (the layer compiles the line programs of one
// layout): switching reloads the page. Production has neither key nor
// switch: DEFAULT_LINE_MESH.
//
// No import and nothing run at load but the switch's read: loadable under
// node (lineMeshSwitch.test.ts). The mesh builder never imports this (it
// runs in a worker, without storage): the choice travels with each build.

export type LineMesh = "lean" | "full";

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_LINE_MESH: LineMesh = "lean";

export const LINE_MESHES: readonly LineMesh[] = ["lean", "full"];

/** The kept choice, else the default (garbage or blocked storage too). */
export function storedLineMesh(): LineMesh {
  try {
    const raw = localStorage.getItem("ac:line-mesh");
    return (LINE_MESHES as readonly string[]).includes(raw ?? "")
      ? (raw as LineMesh)
      : DEFAULT_LINE_MESH;
  } catch {
    return DEFAULT_LINE_MESH;
  }
}

/** This page load's choice. */
export const lineMesh: LineMesh = __TEST_TOOLS__ ? storedLineMesh() : DEFAULT_LINE_MESH;

/** Whether this page load's lines are in the lean layout. */
export const leanLines = lineMesh === "lean";

/** Another choice: kept, and the page loaded again with it. */
export function setLineMesh(choice: LineMesh) {
  if (!__TEST_TOOLS__ || choice === lineMesh) return;
  try {
    localStorage.setItem("ac:line-mesh", choice);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
