// The labels' font for this page load (the switch and the plan: glyphSwitch.ts).
//
// When the labels are drawn on the device, the site's font must be in before
// a map draws its first letter: Mapbox rasterises each letter once, on a
// canvas, and keeps it for the visit, so a letter drawn before the font landed
// would stay in the system's font. The face is declared and its files asked
// for as soon as this module is evaluated (with the map's code).
//
// The map does not wait for it: it is made at once, and its style, its sprite
// and the page's own requests load while the font does. What waits is a map's
// tile requests (`labelTileGate`, the map's `transformRequest`): Mapbox draws
// a label's letters when a tile's data is in, and never before. The verdict
// is taken when the first tile is asked for: the site's font if it is in by
// then, or within what is left of LABEL_FONT_WAIT_MS since the first map was
// made; else the system's font alone, for the whole visit — the site's faces
// are then taken away from the page, so that the file landing later changes
// nothing. On the bench's weak phone the font is in 0.8 s before the first
// tile is asked for (3 s on its slowest profile): no tile is held.
//
// Both maps (the live one and the plateau lid's hidden one,
// plateau/mapSnapshot.ts) are made with the same options (`labelGlyphOptions`)
// and the same gate, so the lid's picture shows the labels the map shows.

import { deviceTier, probeRenderer } from "@/shared/device/deviceTier";
import { perfNote, perfProbe } from "@/shared/perf/perf";
import latinUrl from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url";
import latinExtUrl from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-normal.woff2?url";
import {
  LABEL_FACE,
  LABEL_SUBSETS,
  LABEL_WEIGHTS,
  fontHoldMs,
  glyphMapOptions,
  glyphs,
  labelFontPlan,
  labelsLocal,
  settleWithin,
  tilesAfterFont,
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

/** The site's faces taken away from the page: from here on the labels'
 *  family names nothing the browser knows, and every letter comes from the
 *  system's font, whatever lands later. */
function dropFaces() {
  for (const f of faces) {
    try {
      document.fonts.delete(f);
    } catch {
      /* no FontFaceSet: nothing was added either */
    }
  }
  faces = [];
}

/** This page load's plan, once decided (null: no verdict yet). */
let plan: LabelFont | null = null;
/** When the first map was made with the site's font still on its way
 *  (performance.now()); null: none was. */
let madeAt: number | null = null;
/** The verdict on its way (a tile is waiting for it), else null. */
let deciding: Promise<void> | null = null;
/** How long tiles waited for the verdict, ms (0: none did). */
let heldMs = 0;

// Started with the map's code, before the map is made.
if (typeof document !== "undefined" && wantLocal()) void loadFace();

perfProbe("labelFont", {
  read: () => ({
    mode: glyphs,
    local: wantLocal(),
    plan,
    heldMs,
    faces: faces.map((f) => f.status),
  }),
});

/** The plan when it can be said at once: the style's letters, or the site's
 *  font already in. Null: the font is still on its way. */
function planNow(): LabelFont | null {
  if (!plan) {
    if (!wantLocal()) plan = "mapbox";
    else if (faceIn()) plan = "site";
  }
  return plan;
}

/**
 * What a tile request waits for: null when the labels' font is settled (the
 * request goes at once), else the verdict, taken once — the font's load, or
 * what is left of LABEL_FONT_WAIT_MS since the first map was made, whichever
 * ends first.
 */
function fontPending(): Promise<void> | null {
  if (planNow()) return null;
  if (deciding) return deciding;
  const t0 = performance.now();
  deciding = settleWithin(loadFace(), fontHoldMs(madeAt, t0)).then((ok) => {
    plan ??= labelFontPlan(true, ok && faceIn() ? "loaded" : "missing");
    if (plan === "system") dropFaces();
    heldMs = performance.now() - t0;
    deciding = null;
    perfNote("map.label-font-wait", heldMs, { plan });
  });
  return deciding;
}

/**
 * The `transformRequest` of a map made with `labelGlyphOptions`: its tile
 * requests wait for the labels' font while it is not settled (see the head of
 * this file), every other request and every later one goes straight to
 * `next`, the map's own `transformRequest` if it has one. With the font
 * settled already (the style's letters, or the site's font in), `next`
 * itself: the map is made exactly as without this.
 */
export function labelTileGate<A extends unknown[], R>(
  next?: (url: string, type?: string, ...rest: A) => R,
) {
  return planNow() ? next : tilesAfterFont(fontPending, next);
}

/**
 * The glyph options of a map made now. The style's letters: none. Else the
 * labels' family, the site's faces first: in already, or on their way — the
 * map's tiles then wait for the verdict (`labelTileGate`), and a verdict for
 * the system's font takes the faces away. After such a verdict, the system's
 * family alone.
 */
export function labelGlyphOptions(): { localFontFamily?: string } {
  const now = planNow();
  if (now) return glyphMapOptions(now);
  madeAt ??= performance.now();
  return glyphMapOptions("site");
}
