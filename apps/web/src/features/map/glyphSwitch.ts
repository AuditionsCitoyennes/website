// Where the letters of the map's labels come from, compared live in the builds
// with the testing tools (the dev server and staging, __TEST_TOOLS__), kept in
// localStorage like the plateau lid's mode (plateau/lidSwitch.ts) and drawn as
// the DEV dialog's « Police des noms » row:
//
// - "mapbox": as before. Mapbox downloads the style's letter files (DIN Pro,
//   with Arial Unicode MS behind it): a dozen range files, about 400 kB on a
//   first visit, and the map's `load` waits for the last of them.
// - "local": Mapbox draws every letter on the device, with the site's own
//   font (Source Sans 3, which the page already has), and downloads no letter
//   file. The labels change look: Source Sans in place of DIN Pro, and Mapbox
//   keeps only the weight of a font name (light, regular, medium, bold), so
//   the italics of the seas and rivers are drawn upright.
// - "auto" (the default): "local" on a weak device (the device tier "light"
//   or "minimal", shared/device/deviceTier.ts), "mapbox" on every other.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_GLYPHS, so "auto".
//
// The browser part (the font loaded before the map is made, the options both
// maps get) is labelFont.ts; this module is pure, loadable under node
// (glyphSwitch.test.ts).

import type { DeviceTier } from "@/shared/device/deviceTier";

export type Glyphs = "auto" | "mapbox" | "local";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_GLYPHS: Glyphs = "auto";

export const GLYPHS: readonly Glyphs[] = ["auto", "mapbox", "local"];

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedGlyphs(): Glyphs {
  try {
    const raw = localStorage.getItem("ac:glyphs");
    return (GLYPHS as readonly string[]).includes(raw ?? "") ? (raw as Glyphs) : DEFAULT_GLYPHS;
  } catch {
    return DEFAULT_GLYPHS;
  }
}

/** This page load's mode. */
export const glyphs: Glyphs = __TEST_TOOLS__ ? storedGlyphs() : DEFAULT_GLYPHS;

/** Another mode: kept, and the page loaded again with it. */
export function setGlyphs(mode: Glyphs) {
  if (!__TEST_TOOLS__ || mode === glyphs) return;
  try {
    localStorage.setItem("ac:glyphs", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** Whether the labels are drawn on the device, for a mode and a device tier. */
export function labelsLocal(mode: Glyphs, tier: DeviceTier): boolean {
  if (mode === "auto") return tier !== "full";
  return mode === "local";
}

// ---- The font the labels are drawn with ---------------------------------------------

/**
 * The family name of the labels' own face: the site's Source Sans 3 files
 * (the same files, so the same download), declared a second time under
 * another name with a narrower weight range. Mapbox asks the canvas for 900
 * for every "Bold" font of the style (and 500 for "Medium", 200 for "Light",
 * 400 for the rest): 900 is Source Sans' Black, far heavier than the style's
 * DIN Pro Bold. Declared up to 700, the face draws a request for 900 at its
 * nearest weight, the Bold, with no synthetic emboldening (700 is a bold face).
 */
export const LABEL_FACE = "AC Map Labels";
export const LABEL_WEIGHTS = "200 700";

/**
 * What draws the labels for this page load:
 * - "mapbox": the style's letter files, downloaded (today's look);
 * - "site": the device, with the site's font (LABEL_FACE, loaded before the
 *   map is made);
 * - "system": the device, with the system's sans-serif alone: the site's font
 *   did not come in time (a very slow link) or failed. Never the site's font
 *   later in the visit: Mapbox keeps each letter it drew, so a font landing
 *   midway would mix two faces inside one name.
 */
export type LabelFont = "mapbox" | "site" | "system";

/** The labels' CSS font family, for each local plan. Letters the face lacks
 *  (another script than the Latin ones) come from the system's sans-serif. */
export const LABEL_FAMILIES = {
  site: `"${LABEL_FACE}", system-ui, sans-serif`,
  system: "system-ui, sans-serif",
} as const;

/** How long the map waits for the site's font, ms, when it is not in yet. On
 *  the audit's weak phone the font was in 3 s before the map was made: a wait
 *  is the exception, and a link too slow for 90 kB in this time would be slower
 *  still for the 400 kB of letter files. */
export const LABEL_FONT_WAIT_MS = 1500;

/** The subsets of the labels' face, as the site's stylesheet declares them
 *  (@fontsource-variable/source-sans-3, its "wght-normal" files; the test
 *  checks the ranges against the package): Latin, which French needs, and
 *  Latin Extended, for the names abroad (ł, ő, ș…). Both are loaded before the
 *  map is made. No other script: its letters come from the system's font, all
 *  of them, rather than a face landing midway (see LabelFont). */
export const LABEL_SUBSETS = [
  {
    subset: "latin",
    unicodeRange:
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
  {
    subset: "latin-ext",
    unicodeRange:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
] as const;

/** Whether `load` gives true within `ms`: false when it gives false, fails, or
 *  is not done in time. */
export function settleWithin(
  load: Promise<boolean>,
  ms: number,
  timer: (run: () => void, ms: number) => unknown = setTimeout,
): Promise<boolean> {
  return new Promise((resolve) => {
    timer(() => resolve(false), ms);
    load.then(resolve, () => resolve(false));
  });
}

/** The plan, from whether the labels are local and how the font's load went
 *  ("loaded", or "missing": failed, or not in after the wait). */
export function labelFontPlan(local: boolean, font: "loaded" | "missing"): LabelFont {
  if (!local) return "mapbox";
  return font === "loaded" ? "site" : "system";
}

/** The options a map is made with for a plan: none for "mapbox" (the style's
 *  letters), Mapbox's `localFontFamily` for the others. */
export function glyphMapOptions(plan: LabelFont): { localFontFamily?: string } {
  return plan === "mapbox" ? {} : { localFontFamily: LABEL_FAMILIES[plan] };
}
