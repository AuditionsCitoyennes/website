// What the map does where the graphics are the slow part (a graphics chip
// played by the processor, or frames measured slow while the page's thread
// was free: `gpuWeak` of shared/device/deviceTier), and how the page comes to
// know it. Three switches of the Témoignages page's DEV dialog, « Appareil »
// section:
//
// `ac:msaa` (« Lissage »): the map's multisampling, a setting of its WebGL
// context, fixed when the map is created.
// - "auto" (the default): on, except where the graphics are slow. Mapbox's
//   own layers smooth their edges in their shaders either way; without it
//   the plateau's wall, lid and lines (raw geometry) show slightly
//   stair-stepped edges. The audit of 2026-11-12 measured it on a software
//   renderer: about 13 % less time from a tap to the plateau, 35 % less time
//   in long frames; nothing on a real graphics chip.
// - "on": always, as before. "off": never.
//
// `ac:dpr` (« Finesse »): how many pixels the map draws per CSS pixel.
// - "native": the screen's own ratio, as before.
// - "1.5": at most 1.5 (pixelRatio.ts); the map and its labels are slightly
//   softer on a denser screen, the rest of the page keeps the screen's ratio.
//   The audit measured it on a software renderer at a ratio of 3: about 18 %
//   less time from a tap to the plateau, 31 % less time in long frames.
// - "auto" (the default): "native" on every device. mapbox-gl 3.34.1 has no
//   pixel-ratio setting: the cap stands on the page's `devicePixelRatio`
//   being answered for it (pixelRatio.ts), which Mapbox does not support, so
//   no device gets it unasked. "1.5" is there to judge it by eye.
//
// `ac:frame-measure` (« Mesure »): whether the map times the frames of its
// first flight to a territory and reports them to the device's tier
// (composables/useFlightMeasure.ts).
// - "on" (the default): timed; slow frames step the tier down, kept 30 days.
// - "off": nothing is timed, as before.
//
// Each is read once per page load: switching reloads the page. Production has
// neither keys nor switches: the three defaults.
//
// No import but the device's tier and the cap (themselves loadable under
// node) and nothing run at load but the switches' reads: loadable under node
// (graphicsSwitch.test.ts).
import { gpuWeak, probeRenderer } from "../../shared/device/deviceTier";
import { capPixelRatio } from "./pixelRatio";

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

// ---- ac:msaa -----------------------------------------------------------------------

export type MsaaChoice = "auto" | "on" | "off";
/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_MSAA: MsaaChoice = "auto";
export const MSAA_CHOICES: readonly MsaaChoice[] = ["auto", "on", "off"];

/** This page load's choice. */
export const msaaChoice: MsaaChoice = __TEST_TOOLS__
  ? stored("ac:msaa", MSAA_CHOICES, DEFAULT_MSAA)
  : DEFAULT_MSAA;

/** Another choice: kept, and the page loaded again with it. */
export function setMsaaChoice(choice: MsaaChoice) {
  if (!__TEST_TOOLS__ || choice === msaaChoice) return;
  keep("ac:msaa", choice);
  window.location.reload();
}

/** The map's `antialias` option: the choice, or under "auto" on unless the
 *  graphics are slow. */
export function antialiasFor(choice: MsaaChoice, slowGraphics: boolean): boolean {
  return choice === "auto" ? !slowGraphics : choice === "on";
}

/** The `antialias` option of a map created now. Under "auto" the graphics
 *  chip's name is read first, from a throwaway context (once per page: the
 *  map has no context yet, and the option cannot change after). */
export function antialiasNow(): boolean {
  if (msaaChoice !== "auto") return antialiasFor(msaaChoice, false);
  probeRenderer();
  return antialiasFor("auto", gpuWeak());
}

// ---- ac:dpr ------------------------------------------------------------------------

export type DprChoice = "auto" | "native" | "1.5";
/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_DPR: DprChoice = "auto";
export const DPR_CHOICES: readonly DprChoice[] = ["auto", "native", "1.5"];
/** The cap of "1.5". */
export const DPR_CAP = 1.5;

/** This page load's choice. */
export const dprChoice: DprChoice = __TEST_TOOLS__
  ? stored("ac:dpr", DPR_CHOICES, DEFAULT_DPR)
  : DEFAULT_DPR;

/** Another choice: kept, and the page loaded again with it. */
export function setDprChoice(choice: DprChoice) {
  if (!__TEST_TOOLS__ || choice === dprChoice) return;
  keep("ac:dpr", choice);
  window.location.reload();
}

/** The most pixels per CSS pixel the maps draw at, or null: the screen's own
 *  ratio. "auto" never caps, slow graphics or not (see the header). */
export function pixelRatioCapFor(choice: DprChoice): number | null {
  return choice === "1.5" ? DPR_CAP : null;
}

/** This page load's cap put in force, if any: called before the first map is
 *  created (pixelRatio.ts). The testing tools only. */
export function capMapsNow() {
  if (!__TEST_TOOLS__) return;
  const cap = pixelRatioCapFor(dprChoice);
  if (cap !== null) capPixelRatio(cap);
}

// ---- ac:frame-measure --------------------------------------------------------------

export type FrameMeasure = "on" | "off";
/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_FRAME_MEASURE: FrameMeasure = "on";
export const FRAME_MEASURES: readonly FrameMeasure[] = ["on", "off"];

/** This page load's choice. */
export const frameMeasure: FrameMeasure = __TEST_TOOLS__
  ? stored("ac:frame-measure", FRAME_MEASURES, DEFAULT_FRAME_MEASURE)
  : DEFAULT_FRAME_MEASURE;

/** Another choice: kept, and the page loaded again with it. */
export function setFrameMeasure(choice: FrameMeasure) {
  if (!__TEST_TOOLS__ || choice === frameMeasure) return;
  keep("ac:frame-measure", choice);
  window.location.reload();
}
