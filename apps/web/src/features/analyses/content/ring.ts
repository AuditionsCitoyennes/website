// Themes: the ring. Its parts' spans, shares and targets, as the overlay lays
// them out in SVG and GeoDrillMap raises them.
import type { AuditionTheme } from "@ac/shared";
import type { ScopeAnalysis } from "../stats/scopeStats";
import { fmtN, plural } from "./text";
import { THEME_COLORS, THEME_PASTELS } from "./themeColors";

// A testimony cites several themes (about four): the ring's parts are each
// theme's share of the THEME MENTIONS in the territory — they add up to the
// whole — never a share of the testimonies (those would add up to ~400 %).
// Every theme cited here has its part, however small; the ring alone, no
// legend: the part picked — the largest, until the reader picks another — is
// named beside it (a part hovered, for a preview).

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
