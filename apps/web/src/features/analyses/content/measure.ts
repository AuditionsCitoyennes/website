// Type: the type scale's sizes at a viewport width, and the width a text takes
// — measured on a canvas once its font is in, estimated before. The canvas and
// the widths measured are kept here, once: every module imports measureText
// from this one.

/** The type scale at a viewport width, px (shared/styles/tokens.css; `rem`: the root's size). */
export interface TypePx {
  caption: number;
  ui: number;
  title: number;
  rem: number;
}
export function typePx(vw: number, rem: number): TypePx {
  const fluid = (lo: number, at: number, slope: number, hi: number) =>
    Math.min(hi * rem, Math.max(lo * rem, at * rem + slope * vw));
  return {
    caption: fluid(0.75, 0.7255, 0.001087, 0.8125),
    ui: fluid(0.84375, 0.8193, 0.001087, 0.90625),
    title: fluid(1.25, 1.1522, 0.004348, 1.5),
    rem,
  };
}

/** A text's width, px, as drawn in `family` ("sans": Source Sans 3; "display":
 *  Bebas Neue) at `px` and `weight`, its letters spaced `spacingEm` apart. */
export type Measure = (
  text: string,
  px: number,
  weight: number,
  family: "sans" | "display",
  spacingEm?: number,
) => number;

// Until the fonts are in (or with no DOM: offline), widths from each face's
// mean advance in French text, spaces included (a little over): Source Sans 3
// regular, bold, bold capitals; Bebas Neue's capitals.
const EM_REGULAR = 0.46;
const EM_STRONG = 0.5;
const EM_CAPS = 0.66;
const EM_DISPLAY = 0.4;

const FAMILIES = { sans: '"Source Sans 3"', display: '"Bebas Neue"' } as const;
const FACE_NAMES = { sans: "Source Sans 3", display: "Bebas Neue" } as const;
const facesIn = new Set<string>();

/** Whether the site's own face for `family` at `weight` is loaded — not only
 *  "nothing to wait for" (document.fonts.check says so of a face the page has
 *  not even declared yet, and the canvas would measure a fallback). */
function faceLoaded(family: "sans" | "display", weight: number): boolean {
  const key = `${family}${weight}`;
  if (facesIn.has(key)) return true;
  try {
    for (const f of document.fonts ?? []) {
      if (f.status !== "loaded" || f.family.replace(/["']/g, "") !== FACE_NAMES[family]) continue;
      // "400", or a range "300 700".
      const [lo, hi = lo] = String(f.weight).split(/\s+/).map(Number);
      if (weight >= lo && weight <= hi) {
        facesIn.add(key);
        return true;
      }
    }
  } catch {
    /* no FontFaceSet: estimated */
  }
  return false;
}
let canvasCtx: CanvasRenderingContext2D | null | undefined;
const measured = new Map<string, number>();

/** The width a text takes (see Measure): measured on a canvas once its font
 *  is in, estimated before — GeoNav sizes again once the fonts are ready. */
export const measureText: Measure = (text, px, weight, family, spacingEm = 0) => {
  const spacing = spacingEm * px * [...text].length;
  if (typeof document !== "undefined") {
    const font = `${weight} ${px}px ${FAMILIES[family]}`;
    const key = `${font}|${text}`;
    const known = measured.get(key);
    if (known !== undefined) return known + spacing;
    if (canvasCtx === undefined) {
      try {
        canvasCtx = document.createElement("canvas").getContext("2d");
      } catch {
        canvasCtx = null;
      }
    }
    if (canvasCtx && faceLoaded(family, weight)) {
      canvasCtx.font = font;
      const w = canvasCtx.measureText(text).width;
      if (measured.size > 2000) measured.clear();
      measured.set(key, w);
      return w + spacing;
    }
  }
  const caps = text === text.toUpperCase() && text !== text.toLowerCase();
  const em =
    family === "display" ? EM_DISPLAY : weight >= 600 ? (caps ? EM_CAPS : EM_STRONG) : EM_REGULAR;
  return text.length * px * em + spacing;
};

/** The lines a text takes in `width` px, broken as a browser breaks it:
 *  between words, after a hyphen, and inside a word too wide for a line
 *  (overflow-wrap: anywhere). */
export function wrapLines(text: string, width: number, w: (s: string) => number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const space = w(" ");
  let lines = 1;
  let at = 0;
  for (const word of words) {
    const pieces = word.match(/[^-]+-?|-/g) ?? [word];
    pieces.forEach((piece, i) => {
      let lead = i === 0 && at > 0 ? space : 0;
      const pw = w(piece);
      if (at > 0 && at + lead + pw > width + 0.5) {
        lines++;
        at = 0;
        lead = 0;
      }
      if (pw > width + 0.5) {
        for (const ch of piece) {
          const cw = w(ch);
          if (at > 0 && at + cw > width + 0.5) {
            lines++;
            at = 0;
          }
          at += cw;
        }
        return;
      }
      at += lead + pw;
    });
  }
  return lines;
}
