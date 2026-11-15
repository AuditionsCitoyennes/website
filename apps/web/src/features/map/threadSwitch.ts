// Where four pieces of the map's work run during a selection: on the page's
// thread, inside the visitor's act, or off it. Four switches of the
// Témoignages page's DEV dialog, « Carte » section; each has the value that
// runs the work where it ran before.
//
// `ac:lines-mesh` (« Traits seuls »): the layer's mesh when no unit is raised
// — Monde, a scope with no outline of its own, a plateau that failed: the
// boundary lines alone, some thousands of vertices at Monde.
// - "worker" (the default): built by the mesh worker like every plateau, the
//   page applying it once the old plateau has sunk. Needs ac:mesh=worker and
//   a live worker; else "page".
// - "page": built on the page, in the run that clears the plateau.
//
// `ac:globe-late` (« Globe »): a plateau fitted past the globe gets its
// mercator set first and its globe set later (gl/globeDeferral.ts). What
// happens when the globe is drawn before that set is there:
// - "page": the worker is asked for it at the map's next idle; a globe frame
//   that comes first builds it on the page, inside the frame, and the
//   worker's copy is dropped.
// - "wait": the worker is asked as the mesh is, and again at once by a frame
//   that nears the globe; a globe frame that still comes first draws no
//   plateau and no boundary line until the set lands (one repaint then).
// - "auto" (the default): the worker asked as in "wait"; a globe frame that
//   comes first builds on the page on a device whose tier is "full", waits on
//   every other (`lateGlobeFor`).
//
// `ac:tint-cut` (« Gris »): the flat view's grey sheet, cut around the
// selection (gl/tintSheet.ts).
// - "worker": cut by the mesh worker, asked at the act and laid when it
//   answers, a few frames later (the clicked territory clears then, not in
//   the click's own frame). Needs a live worker; else "page".
// - "page": cut on the page, in the act.
// - "auto" (the default): "worker" on a device whose tier is "light" or
//   "minimal", where the page's thread is the slow part; "page" on every
//   other, where the cut takes less than the worker's round trip
//   (`tintCutFor`).
//
// `ac:pins-rebuild` (« Points »): the pins and the hit rings, brought in line
// with the units to plot.
// - "next" (the default): after the frame that follows the act, so the act's
//   frame does not carry it.
// - "now": in the act.
//
// Each is read where it is used, at each use: a choice applies from the next
// selection, without a reload; under "auto" the device's tier is read then
// too (shared/device/deviceTier: a tier measured in the first flight applies
// from the next selection). Production has neither keys nor switches: the
// four defaults.
//
// No import but vue's ref (the DEV dialog redraws on them) and nothing run at
// load but the switches' reads: loadable under node (threadSwitch.test.ts).
import { ref } from "vue";

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

// ---- ac:lines-mesh -----------------------------------------------------------------

export type LinesMesh = "worker" | "page";
/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_LINES_MESH: LinesMesh = "worker";
export const LINES_MESHES: readonly LinesMesh[] = ["worker", "page"];

/** The choice now. */
export const linesMesh = ref<LinesMesh>(
  __TEST_TOOLS__ ? stored("ac:lines-mesh", LINES_MESHES, DEFAULT_LINES_MESH) : DEFAULT_LINES_MESH,
);

/** Another choice: kept, and read by the next run that clears a plateau. */
export function setLinesMesh(choice: LinesMesh) {
  if (!__TEST_TOOLS__) return;
  linesMesh.value = choice;
  keep("ac:lines-mesh", choice);
}

// ---- ac:globe-late -----------------------------------------------------------------

export type GlobeLate = "auto" | "page" | "wait";
/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_GLOBE_LATE: GlobeLate = "auto";
export const GLOBE_LATES: readonly GlobeLate[] = ["auto", "page", "wait"];

/** The choice now. */
export const globeLate = ref<GlobeLate>(
  __TEST_TOOLS__ ? stored("ac:globe-late", GLOBE_LATES, DEFAULT_GLOBE_LATE) : DEFAULT_GLOBE_LATE,
);

/** Another choice: kept, and read by the next mesh and the next globe frame. */
export function setGlobeLate(choice: GlobeLate) {
  if (!__TEST_TOOLS__) return;
  globeLate.value = choice;
  keep("ac:globe-late", choice);
}

/** What the choice asks of a deferred globe set: `ahead`, the worker asked as
 *  the mesh is (and by a frame nearing the globe), not at the map's next idle;
 *  `wait`, a globe frame that finds no set draws no plateau until the worker
 *  answers, instead of building it on the page. */
export function lateGlobeFor(
  choice: GlobeLate,
  tier: "full" | "light" | "minimal",
): { ahead: boolean; wait: boolean } {
  if (choice === "page") return { ahead: false, wait: false };
  if (choice === "wait") return { ahead: true, wait: true };
  return { ahead: true, wait: tier !== "full" };
}

// ---- ac:tint-cut -------------------------------------------------------------------

export type TintCut = "auto" | "worker" | "page";
/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_TINT_CUT: TintCut = "auto";
export const TINT_CUTS: readonly TintCut[] = ["auto", "worker", "page"];

/** The choice now. */
export const tintCut = ref<TintCut>(
  __TEST_TOOLS__ ? stored("ac:tint-cut", TINT_CUTS, DEFAULT_TINT_CUT) : DEFAULT_TINT_CUT,
);

/** Another choice: kept, and read by the next cut. */
export function setTintCut(choice: TintCut) {
  if (!__TEST_TOOLS__) return;
  tintCut.value = choice;
  keep("ac:tint-cut", choice);
}

/** Who cuts a grey sheet asked for now: the choice, or under "auto" the
 *  worker on a device whose tier is not "full". */
export function tintCutFor(choice: TintCut, tier: "full" | "light" | "minimal"): "worker" | "page" {
  if (choice !== "auto") return choice;
  return tier === "full" ? "page" : "worker";
}

// ---- ac:pins-rebuild ---------------------------------------------------------------

export type PinsRebuild = "next" | "now";
/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_PINS_REBUILD: PinsRebuild = "next";
export const PINS_REBUILDS: readonly PinsRebuild[] = ["next", "now"];

/** The choice now. */
export const pinsRebuild = ref<PinsRebuild>(
  __TEST_TOOLS__
    ? stored("ac:pins-rebuild", PINS_REBUILDS, DEFAULT_PINS_REBUILD)
    : DEFAULT_PINS_REBUILD,
);

/** Another choice: kept, and read at the next change of the units to plot. */
export function setPinsRebuild(choice: PinsRebuild) {
  if (!__TEST_TOOLS__) return;
  pinsRebuild.value = choice;
  keep("ac:pins-rebuild", choice);
}
