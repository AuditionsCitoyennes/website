// How the plateau's mesh is assembled (gl/meshBuild.ts buildPlateauMesh, called
// by PlateauWallLayer.setGeometry), compared live in the builds with the
// testing tools — the dev server and staging (__TEST_TOOLS__, vite.config),
// kept in localStorage like the plateau lid's mode (lidSwitch.ts) and drawn as
// the Témoignages page's DEV switch's "Maillage" row:
//
// - "ancien" (the default): the mesh as before — each boundary line group
//   pushed value by value into one number[], then copied into a Float32Array.
// - "concat": the same groups, each copied once into one Float32Array
//   (TypedArray.set, gl/meshConcat.ts): the same values, the same draw ranges.
// - "merc": "concat", the mercator set first — a plateau fitted past the globe
//   regime and built with the camera clear of it gets its globe set after the
//   map's next idle, or on the first globe frame before that
//   (gl/globeDeferral.ts); any other build has both at once.
// - "worker": merc's sets, built in a Web Worker (gl/meshClient.ts), the
//   page only applying them; its globe set, when it waits, asked of the
//   worker at the map's next idle. Lost (it fails, or says nothing for 3 s),
//   the session builds on the page: each mesh as its run starts, the globe
//   sets that wait as merc's.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_MESH_MODE.

export type MeshMode = "ancien" | "concat" | "merc" | "worker";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_MESH_MODE: MeshMode = "ancien";

export const MESH_MODES: readonly MeshMode[] = ["ancien", "concat", "merc", "worker"];

function storedMeshMode(): MeshMode {
  try {
    const raw = localStorage.getItem("ac:mesh");
    return (MESH_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as MeshMode)
      : DEFAULT_MESH_MODE;
  } catch {
    return DEFAULT_MESH_MODE;
  }
}

/** This page load's mode. */
export const meshMode: MeshMode = __TEST_TOOLS__ ? storedMeshMode() : DEFAULT_MESH_MODE;

/** Another mode: kept, and the page loaded again with it. */
export function setMeshMode(mode: MeshMode) {
  if (!__TEST_TOOLS__ || mode === meshMode) return;
  try {
    localStorage.setItem("ac:mesh", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
