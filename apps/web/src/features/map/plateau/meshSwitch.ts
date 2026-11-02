// How the plateau's mesh is assembled (PlateauWallLayer.setGeometry), compared
// live in the builds with the testing tools — the dev server and staging
// (__TEST_TOOLS__, vite.config), kept in localStorage like the plateau lid's
// mode (lidSwitch.ts) and drawn as the Témoignages page's DEV switch's
// "Maillage" row:
//
// - "ancien" (the default): the mesh as before — each boundary line group
//   pushed value by value into one number[], then copied into a Float32Array.
// - "concat": the same groups, each copied once into one Float32Array
//   (TypedArray.set, gl/meshConcat.ts): the same values, the same draw ranges.
//
// "merc" (the mercator set first, the globe set later) and "worker" (the mesh
// built in a Web Worker) will come. Read once per page load: switching reloads
// the page. Production has neither key nor switch: DEFAULT_MESH_MODE.

export type MeshMode = "ancien" | "concat";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_MESH_MODE: MeshMode = "ancien";

export const MESH_MODES: readonly MeshMode[] = ["ancien", "concat"];

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
