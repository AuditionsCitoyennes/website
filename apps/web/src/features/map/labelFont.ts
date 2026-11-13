// The labels' font for this page load (the switch and the plan: glyphSwitch.ts).
//
// When the labels are drawn on the device, the site's font must be in before
// the map draws its first letter: Mapbox rasterises each letter once, on a
// canvas, and keeps it for the visit, so a letter drawn before the font landed
// would stay in the system's font. The face is declared and loaded as soon as
// this module is evaluated (with the map's code), and the map is made only
// once it is in (`whenLabelFont`), or after LABEL_FONT_WAIT_MS with the
// system's font alone. Both maps (the live one and the plateau lid's hidden
// one, plateau/mapSnapshot.ts) are made with the same plan
// (`labelGlyphOptions`), so the lid's picture shows the labels the map shows.

import { deviceTier, probeRenderer } from "@/shared/device/deviceTier";
import { perfNote, perfProbe } from "@/shared/perf/perf";
import latinUrl from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url";
import latinExtUrl from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-normal.woff2?url";
import {
  LABEL_FACE,
  LABEL_FONT_WAIT_MS,
  LABEL_SUBSETS,
  LABEL_WEIGHTS,
  glyphMapOptions,
  glyphs,
  labelFontPlan,
  labelsLocal,
  settleWithin,
  type LabelFont,
} from "./glyphSwitch";

const URLS: Record<(typeof LABEL_SUBSETS)[number]["subset"], string> = {
  latin: latinUrl,
  "latin-ext": latinExtUrl,
};

/** Whether this page load's labels are local, read once. The WebGL renderer
 *  is probed (a throwaway context) only when the hints alone say "full" and
 *  the switch leaves it to the device. */
let local: boolean | undefined;
function wantLocal(): boolean {
  if (local === undefined) {
    local =
      glyphs === "auto"
        ? labelsLocal(glyphs, deviceTier()) || labelsLocal(glyphs, deviceTier(probeRenderer()))
        : labelsLocal(glyphs, "full");
  }
  return local;
}

let faces: FontFace[] = [];
let loading: Promise<boolean> | null = null;

/** The labels' faces declared and their two files loaded (once). True when all are in. */
function loadFace(): Promise<boolean> {
  if (loading) return loading;
  try {
    faces = LABEL_SUBSETS.flatMap(({ subset, unicodeRange }) =>
      LABEL_WEIGHTS.map(
        (weight) =>
          new FontFace(LABEL_FACE, `url(${URLS[subset]}) format("woff2")`, {
            weight,
            unicodeRange,
            display: "block",
          }),
      ),
    );
    for (const f of faces) document.fonts.add(f);
    loading = Promise.all(faces.map((f) => f.load())).then(
      () => true,
      () => false,
    );
  } catch {
    loading = Promise.resolve(false); // no FontFace API: the system's font
  }
  return loading;
}

const faceIn = () => faces.length > 0 && faces.every((f) => f.status === "loaded");

/** This page load's plan, once decided (null: no map asked yet). */
let plan: LabelFont | null = null;

// Started with the map's code, long before the map is made.
if (typeof document !== "undefined" && wantLocal()) void loadFace();

perfProbe("labelFont", { read: () => ({ mode: glyphs, local: wantLocal(), plan }) });

/**
 * Runs `make` (the map's creation) once the labels' font is settled: at once
 * when the labels are the style's, or the face is already in; else when it is
 * in, or after LABEL_FONT_WAIT_MS. Returns a cancel, for a component unmounted
 * meanwhile.
 */
export function whenLabelFont(make: () => void): () => void {
  if (!plan) {
    if (!wantLocal()) plan = "mapbox";
    else if (faceIn()) plan = "site";
  }
  if (plan) {
    make();
    return () => {};
  }
  let cancelled = false;
  const t0 = performance.now();
  void settleWithin(loadFace(), LABEL_FONT_WAIT_MS).then((ok) => {
    plan ??= labelFontPlan(true, ok ? "loaded" : "missing");
    perfNote("map.label-font-wait", performance.now() - t0, { plan });
    if (!cancelled) make();
  });
  return () => {
    cancelled = true;
  };
}

/** The glyph options of a map made now (the plan decided now if no map was
 *  made through `whenLabelFont`). */
export function labelGlyphOptions(): { localFontFamily?: string } {
  plan ??= labelFontPlan(wantLocal(), faceIn() ? "loaded" : "missing");
  return glyphMapOptions(plan);
}
