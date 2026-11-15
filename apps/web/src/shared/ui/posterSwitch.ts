// Whether the map's loading curtain shows a still picture of France (our own
// outlines, FrancePoster.vue) behind its spinner, compared live in the builds
// with the testing tools (the dev server and staging, __TEST_TOOLS__), kept in
// localStorage and drawn as the DEV dialog's « Image d'attente » row:
//
// - "non" (the default): as before, the spinner and its sentence on the
//   page's ground (map-stage/StageLoading.vue, geo-nav/GeoNav.vue's .boot).
// - "france": metropolitan France and its régions, muted, behind them: a
//   picture in the map's box at the first paint, until the live map lifts the
//   curtain. A change of look, not measured yet: off by default.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_POSTER.
//
// Pure: loadable under node (posterSwitch.test.ts).

export type Poster = "non" | "france";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_POSTER: Poster = "non";

export const POSTERS: readonly Poster[] = ["non", "france"];

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedPoster(): Poster {
  try {
    const raw = localStorage.getItem("ac:poster");
    return (POSTERS as readonly string[]).includes(raw ?? "") ? (raw as Poster) : DEFAULT_POSTER;
  } catch {
    return DEFAULT_POSTER;
  }
}

/** This page load's mode. */
export const poster: Poster = __TEST_TOOLS__ ? storedPoster() : DEFAULT_POSTER;

/** Another mode: kept, and the page loaded again with it. */
export function setPoster(mode: Poster) {
  if (!__TEST_TOOLS__ || mode === poster) return;
  try {
    localStorage.setItem("ac:poster", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** Whether the curtain shows France, in a mode. */
export const curtainPoster = (mode: Poster) => mode === "france";
