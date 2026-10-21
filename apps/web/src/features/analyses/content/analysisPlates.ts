// The analyses' slabs on the raised territory (ScopeAnalysisOverlay, GeoDrillMap):
// what they say, how large their content boxes are, and the room the camera
// leaves them. Pure — no Vue — because GeoNav has to make room for them before
// they are drawn (the camera moves as the analyses turn on, or as another
// territory is chosen), and so that the layout can be checked offline.
//
// Each analysis is a SLAB: a small piece of ground just outside the
// territory's edge — the themes over the middle of its box's top edge, the
// plaque under the middle of its bottom edge — with raised pieces standing on
// it at the plateau's height, its words lying on their lids, glued to the map
// (map/lib/slabs: how big it is on the map). The plaque is one piece; the themes
// are three in a row, the ground between them: the ring (each part a piece of
// its own), the picked theme's bar, the label's box. Their content boxes are
// laid out here at the type scale's sizes, the very boxes the overlay's style
// draws: right after the camera frames the territory, the words read at a set
// share of those sizes (map/lib/slabs: TEXT_SCALE — the slabs drawn that much
// smaller, never the CSS); zoomed in or out, they grow and shrink with the
// map, as any piece of it.
import { themeShortLabel, type AuditionTheme } from "@ac/shared";
import type { ScopeAnalysis } from "../stats/scopeStats";
import { FIT_PITCH_DEG, SLAB_SAFETY, type PieceBox } from "@/features/map/lib";

export { FIT_PITCH_DEG };

const NUM = new Intl.NumberFormat("fr-FR");
export const fmtN = (n: number) => NUM.format(n);
/** "1 témoignage", "247 témoignages" (French: 0 and 1 take the singular). */
export const plural = (n: number, one: string, many: string) => `${fmtN(n)} ${n > 1 ? many : one}`;

/** A theme's name in a word or two. */
export const shortName = (theme: string) => themeShortLabel(theme as AuditionTheme) || theme;

// ---- Text ----------------------------------------------------------------------

export interface CountPart {
  key: string;
  n: number;
  word: string;
}

export function countsOf(s: ScopeAnalysis, compact: boolean): CountPart[] {
  // Within a ville the commune count says nothing (it is one).
  const local = s.levelLabel === "Ville" || s.levelLabel === "Arrondissement";
  const parts: CountPart[] = [
    { key: "t", n: s.testimonies, word: s.testimonies > 1 ? "témoignages" : "témoignage" },
    { key: "a", n: s.auditions, word: s.auditions > 1 ? "auditions" : "audition" },
    { key: "l", n: s.lieux, word: s.lieux > 1 ? "lieux" : "lieu" },
  ];
  if (!local && !compact && s.communes) {
    parts.push({ key: "c", n: s.communes, word: s.communes > 1 ? "communes" : "commune" });
  }
  return parts;
}

/** The plaque's counts in the lines they are drawn on: all on one line
 *  (`fits` says it does) — only past the screen's width, as many on each
 *  line as fit, in their order (a count never split). */
function countLinesOf(parts: CountPart[], fits: (line: CountPart[]) => boolean): CountPart[][] {
  const lines: CountPart[][] = [];
  for (const p of parts) {
    const line = lines[lines.length - 1];
    if (line && fits([...line, p])) line.push(p);
    else lines.push([p]);
  }
  return lines;
}

export const emptyTextOf = (filtered: boolean) =>
  filtered
    ? "Aucun témoignage de l'association ne correspond aux filtres ici"
    : "Aucune audition de l'association ici pour l'instant";

// ---- Themes: the ring -------------------------------------------------------------

// A testimony cites several themes (about four): the ring's parts are each
// theme's share of the THEME MENTIONS in the territory — they add up to the
// whole — never a share of the testimonies (those would add up to ~400 %).
// Every theme cited here has its part, however small; the ring alone, no
// legend: the part picked — the largest, until the reader picks another — is
// named beside it (a part hovered, for a preview).

/**
 * One colour per theme, the same in every territory, so that a reader learns
 * them. Sixteen vivid hues around the wheel, each as saturated as sRGB allows
 * at its hue and lightness (OKLCH L 0.60–0.72, C up to 0.27, in the comments):
 * the pinks, the red, the green, the blue, the violets and the magentas reach
 * C 0.20–0.27; the orange, the ochre, the olive, the teals and the cyan blues
 * stop at C 0.11–0.16, all sRGB holds at that lightness — lighter, they would
 * wash out on a pale map; darker, they would turn muddy.
 * Each theme keeps its hue of before within 15°, so that a reader who learned
 * them still knows them; set so that the themes often large together, and
 * neighbours in the ring (largest first), stand furthest apart: Démocratie,
 * Justice sociale, Services publics, Fiscalité, Emploi, Pouvoir d'achat,
 * Environnement, Santé, Retraites keep OKLab ΔE 13 or more between any two of
 * them, and any two of the sixteen 10.8 or more. Colour alone cannot carry
 * sixteen categories for every eye: under protanopia or deuteranopia about a
 * dozen pairs fall under ΔE 5 — Santé / Environnement the one most often large
 * together, then Démocratie / Guerre, Éducation / Guerre, Médias / Guerre,
 * Éducation / Médias, Justice sociale / Immigration, Pouvoir d'achat / Culture,
 * Sécurité / Fiscalité… — the gaps between parts and the label named on hover,
 * focus or pick are what tell them apart, never the colour alone (the palette
 * before had more such pairs). Plain sRGB hex: every browser draws them the same, and
 * they read on a light map and a dark one alike (each part stands raised, its
 * walls a shade darker: they keep it off a pale ground).
 */
export const THEME_COLORS: Record<AuditionTheme, string> = {
  "Justice sociale et inégalités": "#fe619c", // oklch(0.71 0.197 0)
  Logement: "#e90d71", // oklch(0.604 0.239 4)
  "Santé et accès aux soins": "#fe3209", // oklch(0.644 0.24 32)
  "Emploi et conditions de travail": "#e58d10", // oklch(0.719 0.157 66)
  Fiscalité: "#a3780a", // oklch(0.6 0.121 83)
  "Sécurité et police": "#62910a", // oklch(0.6 0.156 129)
  "Environnement et écologie": "#1db80c", // oklch(0.681 0.225 142)
  Immigration: "#10bf92", // oklch(0.716 0.143 168)
  Retraites: "#0c957b", // oklch(0.599 0.112 174)
  "Services publics": "#14b4e9", // oklch(0.72 0.139 229)
  "Culture et loisirs": "#0f90bd", // oklch(0.612 0.119 230)
  "Guerre et géopolitique": "#0f82fd", // oklch(0.619 0.205 256)
  "Démocratie et institutions": "#7a60fd", // oklch(0.602 0.223 285)
  Éducation: "#c56efd", // oklch(0.695 0.213 310)
  "Pouvoir d'achat et inflation": "#d30ec2", // oklch(0.601 0.265 333)
  "Médias et information": "#fd47e9", // oklch(0.714 0.27 333)
};

/**
 * Each theme's colour as a pastel, for the parts NOT picked (one always is):
 * the same hue, light and soft (OKLCH C 0.065, less where sRGB stops it), its
 * lightness 0.85–0.91 after the colour's own (L 0.85 + (L − 0.60) / 2), so
 * that the pairs of a hue told apart by lightness alone (Pouvoir d'achat /
 * Médias, Culture / Services publics, Retraites / Immigration, Logement /
 * Justice sociale) stay apart as pastels too. Opaque: the picked part, vivid,
 * stands out of them; they keep the ring whole. On a pale map their darker
 * walls outline them; on a dark one they stand out as they are.
 */
export const THEME_PASTELS: Record<AuditionTheme, string> = {
  "Justice sociale et inégalités": "#fed2de", // oklch(0.905 0.052 360)
  Logement: "#f4bdc9", // oklch(0.851 0.065 4)
  "Santé et accès aux soins": "#fdc6ba", // oklch(0.872 0.065 32)
  "Emploi et conditions de travail": "#fedab7", // oklch(0.91 0.061 66)
  Fiscalité: "#e3cb9e", // oklch(0.851 0.065 83)
  "Sécurité et police": "#c1d7aa", // oklch(0.851 0.065 129)
  "Environnement et écologie": "#c3e7bf", // oklch(0.891 0.066 142)
  Immigration: "#b7efd9", // oklch(0.908 0.065 169)
  Retraites: "#a2dcca", // oklch(0.85 0.065 174)
  "Services publics": "#bee9fe", // oklch(0.91 0.053 229)
  "Culture et loisirs": "#a4d8f2", // oklch(0.855 0.065 230)
  "Guerre et géopolitique": "#b5d3fc", // oklch(0.859 0.066 256)
  "Démocratie et institutions": "#c9c9f8", // oklch(0.851 0.065 285)
  Éducation: "#ead2fe", // oklch(0.897 0.065 310)
  "Pouvoir d'achat et inflation": "#e9bfe0", // oklch(0.851 0.064 334)
  "Médias et information": "#fcd1f3", // oklch(0.907 0.065 333)
};

interface RingSpec {
  /** The ring's outer diameter, px. */
  outer: number;
  /** Its thickness, px. */
  thick: number;
  /** How much thicker (outward) the picked part grows, and a part hovered, px. */
  pick: number;
  hover: number;
}

/** The ring's outer diameter, as many times the label's box's height (the
 *  bar's, beside it): twice — the ring the row's tallest piece, the bar and
 *  the label's box centred on it. */
export const RING_OVER_LABEL = 2;
/** The ring's band, per px of its outer diameter: a fifth — its hole three
 *  fifths of it (the DEV switch, "Anneau", compares others: analyses/devSwitch). */
export const RING_THICK = 0.2;
/** How far out the picked part and a part hovered reach, per px of the
 *  ring's outer diameter — a desktop's 2.5 and 1.25 px at 40 px across, a
 *  phone's 2 and 1 at 34, the same at any size (RING_OVER_LABEL sets it). */
const RING_GROWTH_WIDE = { pick: 2.5 / 40, hover: 1.25 / 40 };
const RING_GROWTH_COMPACT = { pick: 2 / 34, hover: 1 / 34 };
/** Between two parts, px along the ring's middle: a real gap, the ground in it. */
const RING_GAP = 1;
/** The focus ring: this far out of its part, px (and 2 px thick). */
const FOCUS_OFF = 2;
/** Room around the ring in its box: the picked part grown out, its focus ring
 *  and that ring's halo. */
const ringPad = (spec: RingSpec) => spec.pick + FOCUS_OFF + 2;
/** The ring's box, px: the ring and that room around it, to the whole px
 *  above (a desktop's 107, a phone's 102 — label boxes 44 and 42 px tall). */
const ringBox = (spec: RingSpec) => Math.ceil(spec.outer + 2 * ringPad(spec) - 1e-6);
/** A part is drawn at least this wide along the ring's middle, px, however
 *  small its share (0.1 % of a ring is a third of a pixel): its figures stay
 *  exact, only the larger parts give up the width. */
const MIN_ARC = 2;
/** And it takes the pointer over at least this much, px along its target's
 *  middle — borrowed from its neighbours' targets, never from what they draw. */
const HIT_MIN = 12;
/** A part takes the pointer this far inside the ring too, px (it reaches the
 *  box's edge outward): a thin ring is still a fair target, a finger's too. */
const HIT_IN = 6;
/** The ring's accessible name (its parts carry their own). */
export const RING_LABEL = "Thèmes abordés : part de chaque thème parmi les thèmes cités";

export interface RingPart {
  theme: AuditionTheme;
  /** Its colour, and its pastel (drawn while another part is picked). */
  color: string;
  pastel: string;
  /** Testimonies citing it (k), and its share of the mentions (0–1). */
  mentions: number;
  share: number;
  /** Its share as printed: "12 %"; under 100 testimonies read, "≈ 10 %";
   *  a sliver, "< 1 %" ("< 5 %"). */
  pct: string;
  /** "12 témoignages sur 40", under the theme's name (said in full by its
   *  part: `aria`). */
  cited: string;
  aria: string;
  /** Its span, as drawn (radians, clockwise from 3 o'clock, the box's y
   *  growing down): GeoDrillMap raises it, a sector of the ring. */
  a0: number;
  a1: number;
  /** Where it takes the pointer: its span, gaps included, inside and out. */
  hit: string;
  /** Its focus ring, around it as drawn (and as hovered or picked). */
  focus: string;
  focusOut: string;
}

export interface Ring {
  parts: RingPart[];
  /** The ring's box (the ring, a part grown out of it, its focus ring), px. */
  box: number;
  /** In that box, px: its centre (on both axes), its outer and inner radii, and
   *  how much farther out the picked part reaches, and a part hovered. */
  c: number;
  R: number;
  r: number;
  pick: number;
  hover: number;
}

/**
 * The parts' shares of the mentions, as printed: whole steps — 1 % from 100
 * testimonies read, 5 % ("≈") under — each rounded on its own, so that two
 * themes cited as often read the same and a larger one never reads smaller.
 * They are read one at a time (in the label), never side by side: forcing
 * their sum to 100 % split ties ("≈ 5 %" and "< 5 %" for the same count),
 * and the ring itself stays exact. A part rounded to nothing reads "< 1 %"
 * ("< 5 %").
 */
function sharesOf(counts: number[], total: number, base: number): string[] {
  const step = base >= 100 ? 1 : 5;
  return counts.map((n) => {
    const k = Math.round((100 * n) / total / step);
    if (!k) return step === 1 ? "< 1 %" : "< 5 %";
    return step === 1 ? `${k} %` : `≈ ${k * step} %`;
  });
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** An annular sector from angle a0 to a1 (radians, clockwise from 3 o'clock). */
function sectorPath(c: number, R: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 >= 2 * Math.PI - 1e-6) {
    // The whole ring: two circles (filled even-odd, see the style).
    return (
      `M${r2(c + R)} ${r2(c)}A${R} ${R} 0 1 1 ${r2(c - R)} ${r2(c)}` +
      `A${R} ${R} 0 1 1 ${r2(c + R)} ${r2(c)}Z` +
      `M${r2(c + r)} ${r2(c)}A${r} ${r} 0 1 0 ${r2(c - r)} ${r2(c)}` +
      `A${r} ${r} 0 1 0 ${r2(c + r)} ${r2(c)}Z`
    );
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const ox0 = r2(c + R * Math.cos(a0));
  const oy0 = r2(c + R * Math.sin(a0));
  const ox1 = r2(c + R * Math.cos(a1));
  const oy1 = r2(c + R * Math.sin(a1));
  const ix1 = r2(c + r * Math.cos(a1));
  const iy1 = r2(c + r * Math.sin(a1));
  const ix0 = r2(c + r * Math.cos(a0));
  const iy0 = r2(c + r * Math.sin(a0));
  return `M${ox0} ${oy0}A${R} ${R} 0 ${large} 1 ${ox1} ${oy1}L${ix1} ${iy1}A${r} ${r} 0 ${large} 0 ${ix0} ${iy0}Z`;
}

/**
 * Where each part's target starts (radians; each ends where the next starts,
 * the last at the first, a turn on). A target is its part and half of each
 * gap — unless that is under `min`: a run of slivers then widens its targets
 * to `min` each, shared evenly over the run, taking the room from the parts on
 * either side of the run (never below `min` themselves). Everything else stays
 * exactly over its own part: only the targets next to a run move.
 */
function hitStarts(spans: [number, number][], gap: number, min: number): number[] {
  const n = spans.length;
  const own = spans.map(([a0, a1]) => a1 - a0 + gap);
  const at = spans.map(([a0]) => a0 - gap / 2);
  const short = own.map((w) => w < min);
  const first = short.indexOf(false);
  if (n < 2 || first < 0) {
    // All slivers (or one part): an even share each, from the first.
    return at.map((_, i) => at[0] + (i * 2 * Math.PI) / Math.max(n, 1));
  }
  const given = new Array<number>(n).fill(0);
  const room = (i: number) => Math.max(0, own[i] - min - given[i]);
  // Walk once round from a roomy part, run by run.
  for (let k = 1; k < n; k++) {
    const p = (first + k) % n;
    if (!short[p] || short[(p - 1 + n) % n]) continue; // not the start of a run
    let len = 0;
    while (short[(p + len) % n]) len++;
    const before = (p - 1 + n) % n;
    const after = (p + len) % n;
    const start = at[p];
    // The run's end is where the part after it starts — a turn on past 0.
    let end = at[after];
    if (end <= start) end += 2 * Math.PI;
    const need = len * min - (end - start);
    const rb = room(before);
    const ra = after === before ? 0 : room(after);
    const take = Math.min(need, rb + ra);
    const fromB = Math.min(rb, Math.max(take / 2, take - ra));
    const fromA = take - fromB;
    given[before] += fromB;
    given[after] += fromA;
    const s = start - fromB;
    const e = end + fromA;
    // Past the last part the angles are a turn on: brought back to their own.
    const back = (k: number) => (k >= n ? 2 * Math.PI : 0);
    for (let j = 0; j < len; j++) at[(p + j) % n] = s + (j * (e - s)) / len - back(p + j);
    at[after] = e - back(p + len);
  }
  return at;
}

export interface RingOpts {
  compact: boolean;
  /** The themes picked in Filtres: in every testimony counted, no finding here. */
  themeFilter: readonly string[];
  /** The ring's band, per px of its outer diameter (RING_THICK). */
  ringThick: number;
}

/** A share as said aloud: "environ 10 %", "moins de 1 %". */
const pctWords = (p: string) => p.replace("≈ ", "environ ").replace("< ", "moins de ");

/** The themes' ring, `outer` px across (its band: `ringThick`; its parts'
 *  growth: a phone's or a desktop's), or null when there is nothing to draw:
 *  no testimony read, or too few to tell ("trop-peu"). */
export function ringOf(s: ScopeAnalysis, o: RingOpts, outer: number): Ring | null {
  if (!s.testimonies || !s.themeBase || s.reliability === "trop-peu") return null;
  const growth = o.compact ? RING_GROWTH_COMPACT : RING_GROWTH_WIDE;
  const spec: RingSpec = {
    outer,
    thick: o.ringThick * outer,
    pick: growth.pick * outer,
    hover: growth.hover * outer,
  };
  const left = new Set<string>(o.themeFilter);
  const rows = s.themes.filter((t) => t.count > 0 && !left.has(t.theme));
  const total = rows.reduce((n, t) => n + t.count, 0);
  if (!total) return null;
  // In percentages, each part rounded on its own (see sharesOf). On a
  // base short of solid too: the coarser steps under 100 testimonies (and the
  // reading notes) say how far to trust them.
  const pct = sharesOf(
    rows.map((t) => t.count),
    total,
    s.themeBase,
  );
  const box = ringBox(spec);
  const c = box / 2;
  const R = spec.outer / 2;
  const r = R - spec.thick;
  // The gaps are taken out of the whole turn first, the parts sharing the rest
  // in proportion: a small part is not made smaller still by its gaps.
  const n = rows.length;
  const gap = n > 1 ? RING_GAP / (R - spec.thick / 2) : 0;
  const turn = 2 * Math.PI - n * gap;
  const hitIn = r - HIT_IN;
  const hitOut = box / 2;
  const fIn = r - FOCUS_OFF;
  // The focus ring's sides: clear of the part at its inner edge, the tightest.
  const fSide = FOCUS_OFF / fIn;
  const base = fmtN(s.themeBase);
  // What each part draws: its share of the turn, a sliver widened to MIN_ARC
  // at the expense of the parts that can spare it.
  const minArc = n > 1 ? MIN_ARC / (R - spec.thick / 2) : 0;
  const raw = rows.map((t) => (turn * t.count) / total);
  const need = raw.reduce((sum, v) => sum + Math.max(0, minArc - v), 0);
  const spare = raw.reduce((sum, v) => sum + (v >= minArc ? v : 0), 0);
  const scale = need > 0 && spare > 0 ? 1 - need / spare : 1;
  const spans: [number, number][] = [];
  let at = -Math.PI / 2 + gap / 2; // from 12 o'clock, clockwise, largest first
  for (const v of raw) {
    const w = v < minArc ? minArc : v * scale;
    spans.push([at, at + w]);
    at += w + gap;
  }
  const starts = hitStarts(spans, gap, HIT_MIN / ((hitIn + hitOut) / 2));
  const parts: RingPart[] = [];
  rows.forEach((t, i) => {
    const [a, a1] = spans[i];
    const hit0 = n < 2 ? a : starts[i];
    const hit1 = n < 2 ? a1 : i + 1 < n ? starts[i + 1] : starts[0] + 2 * Math.PI;
    const p = pct[i];
    // k ≤ n: "sur" takes the base's number as it is.
    const k = plural(t.count, "témoignage", "témoignages");
    const among = `${k} sur ${base}`;
    parts.push({
      theme: t.theme,
      color: THEME_COLORS[t.theme],
      pastel: THEME_PASTELS[t.theme],
      mentions: t.count,
      share: t.count / total,
      pct: p,
      // Under the name: "Démocratie / 386 témoignages sur 575".
      cited: among,
      // Said in full: the label shows the share bare, ahead of the short name.
      aria: `${t.theme} : ${pctWords(p)} des thèmes cités ici, abordé dans ${among}`,
      a0: a,
      a1,
      hit: sectorPath(c, hitOut, hitIn, hit0, hit1),
      focus: sectorPath(c, R + FOCUS_OFF, fIn, a - fSide, a1 + fSide),
      focusOut: sectorPath(c, R + spec.pick + FOCUS_OFF, fIn, a - fSide, a1 + fSide),
    });
  });
  return { parts, box, c, R, r, pick: spec.pick, hover: spec.hover };
}

// ---- Type -----------------------------------------------------------------------

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
function wrapLines(text: string, width: number, w: (s: string) => number): number {
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

// ---- The slabs' content boxes ----------------------------------------------------
// As the overlay's style lays them out (ScopeAnalysisOverlay: keep in step).

// The themes' slab: three pieces in a row, each raised on its own — the
// ring's box, the bar of the theme shown, the label's box —, this much ground
// between two (px: what is seen between them, the ring's box keeping room of
// its own around the ring, see ringPad); the bar's width (px); the label's
// box's padding (rem).
const GROUP_GAP = 6;
const BAR_W = 4;
const LABEL_PAD_Y = 0.3;
const LABEL_PAD_X = 0.45;
/** Over each line measured, px: what rounding and kerning may add. */
const LINE_SLACK = 2;
// The plaque: its padding (rem); its head row, px — the level, the "filtré"
// badge, the ⓘ and × buttons (24 px, the last drawn 4 px into the padding),
// the gaps between (rem); the title's gap and the text's (rem).
const PLAQUE_PAD_Y = 0.35;
const PLAQUE_PAD_X = 0.5;
const HEAD_H = 16;
const HEAD_GAP = 0.25;
const ICON = 24;
const ICON_PULL = 4;
const BADGE_PAD_X = 0.35;
const TITLE_GAP = 0.15;
const TEXT_GAP = 0.2;
/** The plaque's text column, px: at least; at most for its title (a desktop,
 *  a phone) — never narrower than its counts on one line and its head row. */
const PLAQUE_MIN = 120;
const PLAQUE_MAX_WIDE = 230;
const PLAQUE_MAX_COMPACT = 200;

export interface SlabSizes {
  /** Null: no ring to draw (too few testimonies). */
  themes: {
    /** The whole row's box: the slab's. */
    w: number;
    h: number;
    /** Its pieces in it, px from its top left: the ring's box, the bar, the
     *  label's box (vertically centred). */
    ringBox: PieceBox;
    barBox: PieceBox;
    labelBox: PieceBox;
    /** The label's text column, kept whatever it names: no line moves as
     *  another part is picked. */
    labelW: number;
    /** The ring itself: what the overlay lays its targets for, and the parts
     *  GeoDrillMap raises. */
    ring: Ring;
  } | null;
  plaque: {
    w: number;
    h: number;
    /** Its text column, px. */
    inner: number;
    /** The counts in their lines (none: the empty text instead). */
    countLines: CountPart[][];
    titleLines: number;
    /** The lines under the title: the counts', or the empty text's. */
    textLines: number;
  };
}

export interface SizeOpts {
  compact: boolean;
  /** The viewport's width, px (the type scale is fluid with it). */
  vw: number;
  /** The root's font size, px. */
  rem: number;
  /** Filters are on (the "filtré" badge, the empty text's words). */
  filtered: boolean;
  /** The themes picked in Filtres: in every testimony counted, no part. */
  themeFilter: readonly string[];
  /** The ring's band, per px of its outer diameter (RING_THICK). */
  ringThick: number;
  /** The safe rect's width, px: the plaque, as drawn right after a fit, is
   *  never wider (its counts then take more lines). Absent or 0: no bound. */
  safeW?: number;
  /** The slabs' words on screen right after a fit, per CSS px of their boxes
   *  (map/lib/slabs: TEXT_SCALE). */
  textScale: number;
}

/**
 * The slabs' content boxes, px, at the type scale's sizes: every word at
 * --text-caption, the plaque's title in Bebas at --text-title (the least Bebas
 * is drawn at) — drawn on the map at `textScale` of them. The themes' label is
 * as wide as its widest part needs — the share and the short name, the count
 * line —, measured over every part, so that nothing moves as another is
 * picked. The themes' row: the ring's box — the ring RING_OVER_LABEL times as
 * tall as the label's box, the row's height —, GROUP_GAP of ground from the
 * ring at its farthest (a part picked) to the bar, the bar as tall as the
 * label's box, GROUP_GAP, the label's box (both centred on the ring), and the
 * room the ring's box keeps beside the ring at rest, so that the row is
 * centred on what is seen. The plaque: as wide as its counts need on ONE line
 * and its head row (the level, the badge, the buttons), or half its title (on
 * two lines) within the title's bounds — the title wraps, never the counts —;
 * only should that be wider than the safe rect once drawn (`safeW`), as wide
 * as that, the counts then on as many lines as they take.
 */
export function slabSizes(
  s: ScopeAnalysis,
  o: SizeOpts,
  measure: Measure = measureText,
): SlabSizes {
  const t = typePx(o.vw, o.rem);
  const c = t.caption;
  const rem = t.rem;
  const m = (text: string, px: number, weight: number, display = false, sp = 0) =>
    measure(text, px, weight, display ? "display" : "sans", sp);

  let themes: SlabSizes["themes"] = null;
  // The label's box: its two lines and its padding; the bar as tall, the
  // ring twice as tall.
  const labelH = Math.ceil(1.2 * c + 0.1 * rem + 1.3 * c + 2 * LABEL_PAD_Y * rem);
  const ring = ringOf(s, o, RING_OVER_LABEL * labelH);
  if (ring) {
    let text = 0;
    for (const p of ring.parts) {
      text = Math.max(text, m(`${p.pct} ${shortName(p.theme)}`, c, 700), m(p.cited, c, 400));
    }
    const labelW = Math.ceil(text + LINE_SLACK);
    const h = Math.max(ring.box, labelH);
    // The ring's box keeps its focus ring's room past the part picked; the
    // row, as much past the label's box as there is in it beside the ring at
    // rest: what is seen stands in its middle.
    const reach = ring.box / 2 - (ring.R + ring.pick);
    const barX = ring.box + Math.max(0, GROUP_GAP - reach);
    const labelX = barX + BAR_W + GROUP_GAP;
    const labelBoxW = Math.ceil(labelW + 2 * LABEL_PAD_X * rem);
    const y = (h - labelH) / 2;
    themes = {
      w: Math.ceil(labelX + labelBoxW + ring.box / 2 - ring.R),
      h,
      ringBox: { x: 0, y: (h - ring.box) / 2, w: ring.box, h: ring.box },
      barBox: { x: barX, y, w: BAR_W, h: labelH },
      labelBox: { x: labelX, y, w: labelBoxW, h: labelH },
      labelW,
      ring,
    };
  }

  const parts = s.testimonies ? countsOf(s, o.compact) : [];
  const sep = m(" · ", c, 400);
  const lineW = (line: CountPart[]) =>
    line.reduce(
      (sum, p, i) => sum + (i ? sep : 0) + m(fmtN(p.n), c, 700) + m(` ${p.word}`, c, 400),
      0,
    ) + LINE_SLACK;
  // All the counts on one line.
  const countW = parts.length ? lineW(parts) : 0;
  const kicker = m(s.levelLabel.toUpperCase(), c, 700, false, 0.08);
  const badge = o.filtered ? m("filtré", c, 700) + 2 * BADGE_PAD_X * rem + 2 : 0;
  const head =
    kicker +
    (badge ? HEAD_GAP * rem + badge : 0) +
    2 * (HEAD_GAP * rem + ICON) -
    ICON_PULL +
    LINE_SLACK;
  const titleW = (text: string) => m(text, t.title, 400, true, 0.04);
  const max = o.compact ? PLAQUE_MAX_COMPACT : PLAQUE_MAX_WIDE;
  // The widest the plaque may be drawn: the safe rect less its margins, the
  // slab drawn at textScale, its safety, its near edge the wider.
  const pad = 2 * PLAQUE_PAD_X * rem;
  const bound =
    o.safeW && o.safeW > 0
      ? Math.max(
          PLAQUE_MIN,
          Math.floor(
            (o.safeW - 2 * edgeMargin(o.compact)) / (o.textScale * SLAB_SAFETY * NEAR_GROWTH) - pad,
          ),
        )
      : Infinity;
  let inner = Math.min(
    bound,
    Math.ceil(
      Math.max(
        countW,
        head,
        Math.min(max, Math.max(PLAQUE_MIN, (titleW(s.label) + LINE_SLACK) / 2)),
      ),
    ),
  );
  // Half the title is not always two lines (its words break where they
  // break: "Provence-Alpes- / Côte / d'Azur"): wider, as far as the bounds go.
  const titleMax = Math.min(max, bound);
  let titleLines = Math.max(1, wrapLines(s.label, inner, titleW));
  while (titleLines > 2 && inner < titleMax) {
    inner = Math.min(titleMax, inner + 4);
    titleLines = Math.max(1, wrapLines(s.label, inner, titleW));
  }
  const countLines = countLinesOf(parts, (line) => lineW(line) <= inner + 0.5);
  const textLines =
    countLines.length || wrapLines(emptyTextOf(o.filtered), inner, (x) => m(x, c, 400));
  return {
    themes,
    plaque: {
      w: Math.ceil(inner + pad),
      h: Math.ceil(
        2 * PLAQUE_PAD_Y * rem +
          HEAD_H +
          TITLE_GAP * rem +
          titleLines * t.title +
          TEXT_GAP * rem +
          textLines * 1.3 * c,
      ),
      inner,
      countLines,
      titleLines,
      textLines,
    },
  };
}

// ---- The room the camera leaves around the plateau ---------------------------------

/** From the safe rect's edges to a slab, px: a desktop, a phone. */
export const edgeMargin = (compact: boolean) => (compact ? 8 : 12);
/** From the territory's lid to a slab's near edge, on screen right after a
 *  fit, px: a phone, a desktop. */
export const slabGap = (compact: boolean) => (compact ? 10 : 12);

// mapbox's logo along the map's bottom edge (on a phone, the strip's, above
// the sheet), px from the container's edges, with a little air: the plaque
// stands above its strip wherever it reaches over it.
const LOGO_W = 98;
const LOGO_H = 33;
/** Kept between the plaque and a control, px. */
const CONTROL_GAP = 6;
/** A slab is sized at its far edge: its near edge comes out up to this much
 *  wider (the perspective along its length). */
const NEAR_GROWTH = 1.1;

/** How far the plateau's box should stay from each edge of the safe rect, px,
 *  for its slabs to stand around it. */
export interface PlateRoom {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
/** The screen the slabs stand on. */
export interface ScreenOpts {
  compact: boolean;
  /** The safe rect's width, px. */
  safeW: number;
  /** The viewport's width, px (the type scale is fluid with it). */
  vw: number;
  /** The root's font size, px. */
  rem: number;
}
export interface RoomOpts extends ScreenOpts {
  /** Slabs drawn long ("Redressé"): each comes out as tall as its box. */
  anamorphic: boolean;
  /** The slabs on screen right after a fit, per CSS px of their boxes
   *  (map/lib/slabs: TEXT_SCALE). */
  textScale: number;
}

/**
 * The ring of room the slabs need around the plateau, so that right after a
 * camera command both stand inside the safe rect. A slab takes a band along
 * ONE side of the box: the themes above it, the plaque below it — none beside
 * it (left and right: 0), each centred on the box's middle, which a fit puts
 * on the safe rect's. The box is the plateau's silhouette, its lid included:
 * that is what a fit frames (GeoDrillMap, map/lib/slabs' fitSilhouette).
 *
 * Above: the margin, the themes' slab as drawn (its box's height at textScale
 * and the safety the slabs are sized with: drawn long, as tall as that; "À
 * plat", the tilt's cos 45° of it), the gap. Below: the margin — or, where
 * the plaque (its near edge the wider) reaches over mapbox's logo, the logo's
 * strip and a gap —, the plaque as drawn (its box's height at textScale and
 * the safety), the gap.
 */
export function plateRoom(z: SlabSizes | null, o: RoomOpts): PlateRoom {
  if (!z) return { top: 0, bottom: 0, left: 0, right: 0 };
  const k = SLAB_SAFETY * o.textScale;
  // "À plat", the themes are seen flatter than the fit's 45° (higher up the
  // screen): at most cos 45° of their box; the plaque, seen more steeply, up
  // to its box — counted whole.
  const f = o.anamorphic ? 1 : Math.cos((FIT_PITCH_DEG * Math.PI) / 180);
  const gap = slabGap(o.compact);
  const top = z.themes ? Math.ceil(edgeMargin(o.compact) + z.themes.h * k * f + gap) : 0;
  const reach = o.safeW / 2 - (z.plaque.w * k * NEAR_GROWTH) / 2;
  const logo = reach < LOGO_W + CONTROL_GAP ? LOGO_H + CONTROL_GAP : 0;
  const bottom = Math.ceil(Math.max(edgeMargin(o.compact), logo) + z.plaque.h * k + gap);
  return { top, bottom, left: 0, right: 0 };
}

/**
 * The least rectangle GeoNav frames the territory in, px: the slabs' bands
 * win over the territory's size down to it, then give way, sharing what is
 * left — the slabs then reach past the safe rect's edges, but the camera
 * still frames for the rectangle (with none, it could not, and its fallback
 * fit ignores the ring). The bands never reach its width (none beside the
 * box). A phone's: 80 px tall; a desktop's: 220.
 */
export const FRAME_MIN_WIDE = { w: 280, h: 220 };
export const FRAME_MIN_COMPACT = { w: 200, h: 80 };
