<script setup lang="ts">
// The analysis of the raised unit, ON the map: two slabs of it — small pieces
// of ground just outside its edge, the themes over the middle of its box's top
// edge, the plaque under the middle of its bottom edge, with raised pieces on
// them at the plateau's height (GeoDrillMap draws them): the plaque one piece;
// the themes three in a row — the ring, each of its parts raised in its
// colour, the bar of the theme named, the label's box. And here, their words,
// lying on those pieces' lids, glued to the map: they move, grow, shrink, tilt
// and turn with it, as any piece of it. The label's box and the plaque are
// glass ("Verre", the default): their words lie on a glass of their own here,
// the map seen through it.
//
// The words' CONTENT is ordinary Vue (it changes with the scope, a theme
// picked). Their PLACE is not: each frame of the map (GeoDrillMap's frame bus)
// hands over each box's four corners on screen at its lid's height, projected
// with the very camera the lids are drawn with, and the box is mapped onto
// them by a projective transform (matrix3d) written straight to the DOM — no
// reactive write, no layout read per frame. A plane seen in perspective IS a
// projective map of it: the words lie exactly on the lid, corner to corner.
// Three boxes: the ring's (its parts' targets and focus ring, over the parts
// raised: they are GeoDrillMap's, told the pick and the hover here, setRing),
// the label's, the plaque's. Their boxes are laid out at the type scale's
// sizes (analyses/content/analysisPlates), and the slabs are sized on the map so that right
// after the camera frames the territory the reader sees a set share of those
// sizes (map/lib/slabs: TEXT_SCALE) — the CSS keeps its tokens, the map draws the
// boxes smaller.
//
// Shown only while the slabs stand: the plateau raised, these slabs its own,
// risen — they fade in and out with its rise, nothing else hides them.
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  shallowRef,
  useId,
  watch,
} from "vue";
import type { AuditionTheme } from "@ac/shared";
import type { PlateauFrame } from "@/features/map/types";
import type { ScopeAnalysis } from "../stats/scopeStats";
import {
  emptyTextOf,
  fmtN,
  plural,
  RING_LABEL,
  shortName,
  type SlabSizes,
} from "../content/analysisPlates";
import { homography, matrix3dOf } from "@/features/map/lib";
import {
  frameFill,
  ringBandMode,
  SCALE_CHOICES,
  setFrameFill,
  setRingBandMode,
  setSlabLidMode,
  setSlabTextMode,
  setSlabTextScale,
  slabLidMode,
  slabTextMode,
  slabTextScale,
  type RingBandMode,
  type SlabLidMode,
  type SlabTextMode,
} from "../devSwitch";

/** What the overlay needs of the map: GeoDrillMap's exposed frame bus. */
interface FrameSource {
  onFrame(cb: (f: PlateauFrame) => void): () => void;
  /** A wheel turned over the words, passed on to the map as its own. */
  forwardWheel(e: WheelEvent): void;
  /** The ring's part picked and the one hovered on unit `scopeId`'s: the
   *  parts raised and the bar follow. */
  setRing(scopeId: string, picked: string | null, hovered: string | null): void;
}

const props = defineProps<{
  analysis: ScopeAnalysis;
  /** The slabs' content boxes for `analysis` (GeoNav: slabSizes) — the same
   *  boxes GeoDrillMap's slabs are sized for. */
  sizes: SlabSizes;
  /** Whether the words may show at all (the parent's view of the page). */
  visible: boolean;
  /** The safe rect inside the map container, px: clear of the panel, and on a
   *  phone of the header's tiles and the lowered sheet (the reading notes
   *  stay inside it, and the DEV switch). */
  insets: { top: number; right: number; bottom: number; left: number };
  frames: FrameSource | null;
  /** A phone: the reading notes' words for a finger, the DEV switch's place. */
  compact: boolean;
  /** Filters are on: every figure counts only what they let through. */
  filtered: boolean;
  /** The themes picked in Filtres (canonical names): each testimony counted
   *  cites one of them by construction, so they are no finding here. */
  themeFilter: string[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const uid = useId();
const isDev = import.meta.env.DEV;
// The DEV switch below: the dev server and staging (the testing tools).
const testTools = __TEST_TOOLS__;

// ---- Content -------------------------------------------------------------------

// What the slabs say, and their boxes. They trail `analysis` on a scope
// change: the old unit's slabs sink with its plateau still saying what they
// said there, and the words change once the new unit's slabs come (onFrame).
const content = shallowRef(props.analysis);
const contentSizes = shallowRef(props.sizes);
const a = computed(() => content.value);
const sz = computed(() => contentSizes.value);

/** The part of the ring the reader picked (null: none yet — the largest
 *  stands picked, see ringPicked). */
const picked = ref<AuditionTheme | null>(null);
const howOpen = ref(false);

// Kept off the plaque's lines: a tooltip on the counts.
const concentrationText = computed(() => {
  const c = a.value.concentration;
  return c ? `Dont ${fmtN(c.count)} lors d'une seule audition : ${c.lieu}` : "";
});

const emptyText = computed(() => emptyTextOf(props.filtered));

const summaryLabel = computed(() => `Analyses : ${a.value.label}`);

// ---- Themes --------------------------------------------------------------------

/** The ring, as its content box was laid out for (analyses/content/analysisPlates:
 *  slabSizes) — the very parts GeoDrillMap raises. */
const ring = computed(() => sz.value.themes?.ring ?? null);

/** The part picked: the reader's pick while the ring has it, else the
 *  largest (the ring runs largest first) — one always is, once there are
 *  parts. Another territory, or the pick taken out of the ring by the filters,
 *  starts again from the largest (see swapContent, the watcher on the ring). */
const ringPicked = computed(() => {
  const parts = ring.value?.parts;
  if (!parts?.length) return null;
  const t = picked.value;
  return t && parts.some((p) => p.theme === t) ? t : parts[0].theme;
});
/** The part a mouse is over, and the part with the focus — and whether that
 *  focus is a keyboard's (then its focus ring is drawn). */
const hovered = ref<AuditionTheme | null>(null);
const focused = ref<AuditionTheme | null>(null);
const focusShown = ref(false);
/** The ring's one tab stop (a roving tabindex): the picked part — or, while
 *  the focus is in the ring on another (a pointer picked elsewhere, a screen
 *  reader moved it), the part it is on, so that Tab and Shift+Tab leave the
 *  ring from there. */
const rover = ref<AuditionTheme | null>(null);
const tabStop = computed(() => {
  const r = rover.value;
  return r && ring.value?.parts.some((p) => p.theme === r) ? r : ringPicked.value;
});

/** A part only looked at — under the mouse —: named in the pick's stead for
 *  as long, then the picked one again. (The keyboard picks as it goes: the
 *  part it is on is the picked one.) */
const previewPart = computed(() => {
  const t = hovered.value;
  return t && t !== ringPicked.value ? t : null;
});
/** The part the label names: a preview, else the picked one. */
const shownPart = computed(() => {
  const t = previewPart.value ?? ringPicked.value;
  return t ? (ring.value?.parts.find((p) => p.theme === t) ?? null) : null;
});
/** The theme a pointer has just picked, said as its label shows. Not one the
 *  keyboard picks (nor a screen reader's own press): the focus is on its
 *  part, whose name and state say the whole label — said here as well, it
 *  would be heard twice. Nor the largest, picked by default (each territory
 *  the map crossed would be read out), nor a preview (the part's own name
 *  says it all), nor the pick shown again after one: whatever else the label
 *  shows lets it go. */
const said = ref<AuditionTheme | null>(null);
watch(
  () => shownPart.value?.theme ?? null,
  (t) => {
    if (t !== said.value) said.value = null;
  },
);
const labelSaid = computed(() => said.value !== null && said.value === shownPart.value?.theme);

/** The focus ring, around the focused part (grown out when picked or hovered). */
const focusPath = computed(() => {
  const t = focusShown.value ? focused.value : null;
  const p = t ? ring.value?.parts.find((x) => x.theme === t) : undefined;
  if (!p) return null;
  return p.theme === ringPicked.value || p.theme === hovered.value ? p.focusOut : p.focus;
});

const ringEl = ref<SVGSVGElement | null>(null);

function partOf(target: EventTarget | null) {
  const t = (target as Element | null)?.getAttribute?.("data-theme");
  return t ? (ring.value?.parts.find((p) => p.theme === t) ?? null) : null;
}

function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true; // no :focus-visible: always drawn
  }
}

function onRingFocusIn(e: FocusEvent) {
  const p = partOf(e.target);
  if (!p) return;
  focused.value = p.theme;
  rover.value = p.theme;
  focusShown.value = keyboardFocus(e.target as Element);
}

// Out of the ring, its tab stop is the picked part again.
function onRingFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  if (next && ringEl.value?.contains(next)) return;
  focused.value = null;
  focusShown.value = false;
  rover.value = null;
}

function onPartEnter(e: PointerEvent, theme: AuditionTheme) {
  if (e.pointerType === "mouse") hovered.value = theme;
}

function onPartLeave(theme: AuditionTheme) {
  if (hovered.value === theme) hovered.value = null;
}

// The ring is one radio group, as any (WAI-ARIA's radio group): the arrows go
// round it (in its order, largest first, wrapping), Home and End to its ends,
// and the part reached is picked as the focus lands on it; Enter or Space
// picks the part focused too. Escape is left to the layer (onEscape).
function onRingKey(e: KeyboardEvent) {
  const parts = ring.value?.parts;
  const at = parts ? parts.findIndex((p) => p.theme === focused.value) : -1;
  if (!parts || at < 0) return;
  const n = parts.length;
  let to: number;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      to = (at + 1) % n;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      to = (at - 1 + n) % n;
      break;
    case "Home":
      to = 0;
      break;
    case "End":
      to = n - 1;
      break;
    case "Enter":
    case " ":
      to = at;
      break;
    default:
      return;
  }
  e.preventDefault();
  pick(parts[to].theme, false);
  if (to === at) return;
  rover.value = parts[to].theme;
  // Once the part is drawn checked (and the tab stop): the focus landing on
  // it reads it so.
  void nextTick(() =>
    ringEl.value?.querySelectorAll<SVGGElement>(".part")[to]?.focus({ preventScroll: true }),
  );
}

/** A part pressed with a pointer (`detail` ≥ 1, the presses counted): said.
 *  A click with no press behind it is a screen reader's own: it acts on the
 *  part its cursor is on, which says itself. */
function onPartClick(e: MouseEvent, theme: AuditionTheme) {
  pick(theme, e.detail > 0);
}

// The themes picked in Filtres, as the reading notes name them.
const filteredThemes = computed(() => {
  const named = new Set<string>(props.themeFilter);
  return a.value.themes.filter((t) => named.has(t.theme)).map((t) => t.theme);
});

// What the ring leaves unsaid — how many testimonies it is read from, how far
// to trust it, what the filters do to it —, for the reading notes.
const themesReading = computed(() => {
  const s = a.value;
  if (!s.testimonies) return "";
  const analysed = plural(s.themeBase, "témoignage analysé", "témoignages analysés");
  const parts = [s.untagged ? `${analysed}, ${fmtN(s.untagged)} pas encore` : analysed];
  const reason = s.reliabilityReason;
  if (s.reliability === "solide") parts.push("fiabilité solide");
  else if (s.reliability === "indicatif")
    parts.push(reason ? `indicatif : ${reason}` : "indicatif");
  else if (s.reliability === "chips") parts.push("peu de témoignages : parts très approximatives");
  else parts.push("trop peu de témoignages pour en tirer les thèmes");
  if (s.approx) {
    parts.push(`${fmtN(s.approx)} ${s.approx > 1 ? "rattachés" : "rattaché"} à un thème voisin`);
  }
  const f = filteredThemes.value.map((t) => `« ${shortName(t)} »`);
  if (f.length === 1)
    parts.push(`${f[0]} présent dans tous, par le filtre, et laissé hors du cercle`);
  else if (f.length > 1) {
    parts.push(
      `${f.slice(0, -1).join(", ")} ou ${f[f.length - 1]} dans chacun, par le filtre, et laissés hors du cercle`,
    );
  }
  return `Thèmes ici : ${parts.join(" · ")}.`;
});

/** A part picked by the reader: it stays picked — pressed again, it is kept —
 *  until another is, or the territory changes. Said only when asked (a
 *  pointer's pick, see `said`). */
function pick(theme: AuditionTheme, say: boolean) {
  picked.value = theme;
  said.value = say ? theme : null;
}

// ---- DEV switch: the slabs' lid, words, size, the framing, the ring's band ----------

const LID_MODES: readonly { id: SlabLidMode; label: string }[] = [
  { id: "verre", label: "Verre" },
  { id: "opaque", label: "Opaque" },
  { id: "carte", label: "Carte" },
];
const TEXT_MODES: readonly { id: SlabTextMode; label: string }[] = [
  { id: "redresse", label: "Redressé" },
  { id: "plat", label: "À plat" },
];
/** "Taille" (the words' share of their sizes) and "Cadrage" (the territory's
 *  share of its rectangle): the same steps. */
const SHARES = SCALE_CHOICES.map((v) => ({ v, label: `${Math.round(v * 100)} %` }));
const RING_MODES: readonly { id: RingBandMode; label: string }[] = [
  { id: "fin", label: "Fin" },
  { id: "moyen", label: "Moyen" },
  { id: "epais", label: "Épais" },
];

// Apart from the slabs: on a desktop under the panel, above mapbox's
// attribution (painted over the panel); on a phone at the safe rect's top
// right, under the header's tiles, folded until opened: its five rows would
// cover the themes there, the fold alone stands clear of them (centred, they
// span at most ~237 px right after a fit, and on a 320 px phone stand some
// 26 px away from it at the least). DEV only.
const switchStyle = computed(() =>
  props.compact
    ? { right: `${props.insets.right + 8}px`, top: `${props.insets.top + 8}px` }
    : { right: "12px", bottom: "36px", zIndex: 5 },
);

// ---- Imperative layout state (plain, never reactive) -----------------------------

/** At rest once the frames have stopped for this long. */
const REST_MS = 250;
/** The rise from which a slab's words show, and over which they fade in. */
const RISE_SHOW = 0.05;
const RISE_FADE = 0.3;
/** The scales a slab's words are drawn at, before the browser maps them onto
 *  the lid (see rest): 1, 2, 4 — never under 1 (a browser's least font size
 *  would then break the layout). Up a step past each bound × 1.1, down one
 *  under bound ÷ 1.1. */
const RENDER_SCALES = [1, 2, 4] as const;
const RENDER_BOUNDS = [1.15, 2.3] as const;

/** A box of words on a lid (see PlateauSlabs): the plaque's, the ring's, the
 *  label's. */
type SlabName = "plaque" | "ring" | "label";

interface Slab {
  name: SlabName;
  /** The outer box (its transform, written here), its zoomed inner box, and
   *  its body: the words' ground (a glass, "Verre"), which fades — never an
   *  ancestor of the glass, which would then blur nothing (see the style). */
  el: HTMLElement | null;
  zoomEl: HTMLElement | null;
  bodyEl: HTMLElement | null;
  /** This frame: the lid stands (present), all its corners in front (ok),
   *  its corners on screen (NW, NE, SE, SW). */
  present: boolean;
  ok: boolean;
  quad: Float64Array;
  /** Drawn on its lid now, and taking the pointer, the focus, read. */
  drawn: boolean;
  live: boolean;
  /** As last written (NaN, '': not yet). */
  opacity: number;
  matrix: string;
  size: string;
  /** Its render scale (see RENDER_SCALES). */
  r: number;
}

function makeSlab(name: SlabName): Slab {
  return {
    name,
    el: null,
    zoomEl: null,
    bodyEl: null,
    present: false,
    ok: false,
    quad: new Float64Array(8),
    drawn: false,
    live: false,
    opacity: NaN,
    matrix: "",
    size: "",
    r: 1,
  };
}

const plaqueSlab = makeSlab("plaque");
const ringSlab = makeSlab("ring");
const labelSlab = makeSlab("label");
/** Reading order (the page's). */
const SLABS = [plaqueSlab, ringSlab, labelSlab];
/** The themes' two boxes are shown and hidden together, as their group (its
 *  element: inert, out of the reading, or not), as last written. */
let themesEl: HTMLElement | null = null;
let themesLive = false;

// The last frame, copied: the words are laid out again between frames (the
// content changing, the parent hiding them, the slabs coming to rest) — and
// the frame object is the map's.
const snap = { live: false, scopeId: "", rise: 0, w: 0, h: 0 };

// Mirrors of the props read per frame.
let source: FrameSource | null = props.frames;
let isVisible = props.visible;
let targetScope = props.analysis.scopeId;
let contentScope = props.analysis.scopeId;

let lastOpen = false;
let resting = true;

const rootEl = ref<HTMLElement | null>(null);
const howEl = ref<HTMLElement | null>(null);
const howBtn = ref<HTMLButtonElement | null>(null);
/** The reading notes' card size, px (ResizeObserver). */
let howW = 0;
let howH = 0;
let howPos = "";

/** The projective map being written (reused frame after frame). */
const homBuf = new Float64Array(8);

let restTimer = 0;
let lastFrameAt = 0;
let unsubscribe: (() => void) | null = null;

/** A slab's box of words, CSS px (null: none). */
function boxOf(s: Slab): { w: number; h: number } | null {
  const z = contentSizes.value;
  if (s.name === "plaque") return z.plaque;
  if (!z.themes) return null;
  return s.name === "ring" ? z.themes.ringBox : z.themes.labelBox;
}

// ---- Per frame ------------------------------------------------------------------

function onFrame(f: PlateauFrame) {
  // The bus sends a frame only when something moved.
  resting = false;
  snap.live = true;
  snap.scopeId = f.slabs.scopeId;
  snap.rise = f.slabs.rise;
  snap.w = f.w;
  snap.h = f.h;
  for (const s of SLABS) {
    const sf = f.slabs[s.name];
    s.present = sf !== null;
    s.ok = sf?.ok ?? false;
    if (sf) for (let i = 0; i < 8; i++) s.quad[i] = sf.lid[i];
  }
  // The new unit's slabs have come (or the old ones are down): its words.
  if (
    contentScope !== targetScope &&
    (snap.scopeId === targetScope || snap.scopeId === "" || snap.rise < RISE_SHOW)
  ) {
    swapContent(props.analysis);
  }
  layout();
  scheduleRest();
}

function setShown(el: HTMLElement, show: boolean) {
  el.inert = !show;
  if (show) {
    el.removeAttribute("aria-hidden");
    el.setAttribute("data-live", "");
  } else {
    el.setAttribute("aria-hidden", "true");
    el.removeAttribute("data-live");
  }
}

// With nothing on show the region is empty: out of the landmarks too.
function hideRegion(root: HTMLElement, hidden: boolean) {
  if (hidden) root.setAttribute("aria-hidden", "true");
  else root.removeAttribute("aria-hidden");
}

/** Lay every slab's words on its lid, from the last frame. Per frame, and on
 *  any change. */
function layout() {
  const root = rootEl.value;
  if (!root) return;
  const own = snap.live && snap.scopeId !== "" && snap.scopeId === contentScope;
  const fade = own ? Math.min(1, Math.max(0, (snap.rise - RISE_SHOW) / RISE_FADE)) : 0;
  for (const s of SLABS) {
    const box = boxOf(s);
    let drawn = false;
    if (own && s.el && box && s.present && s.ok && snap.rise >= RISE_SHOW) {
      const m = homography(s.quad, box.w * s.r, box.h * s.r, homBuf);
      if (m) {
        drawn = true;
        const t = matrix3dOf(m);
        if (t !== s.matrix) {
          s.matrix = t;
          s.el.style.transform = t;
        }
        const size = `${box.w * s.r}x${box.h * s.r}`;
        if (size !== s.size) {
          s.size = size;
          s.el.style.width = `${box.w * s.r}px`;
          s.el.style.height = `${box.h * s.r}px`;
        }
      }
    }
    s.drawn = drawn;
    // Sinking (the analyses turned off, another unit raised), they fade with
    // their lid — but no longer take the pointer or the focus.
    const opacity = drawn ? Math.round(fade * 100) / 100 : 0;
    if (s.bodyEl && opacity !== s.opacity) {
      s.opacity = opacity;
      s.bodyEl.style.opacity = String(opacity);
    }
  }
  const shown = isVisible && source !== null;
  const plaque = plaqueSlab.drawn && shown;
  if (plaqueSlab.el && plaque !== plaqueSlab.live) setShown(plaqueSlab.el, plaque);
  plaqueSlab.live = plaque;
  // The ring without its label (or the label without its ring) says nothing.
  const themes = ringSlab.drawn && labelSlab.drawn && shown;
  ringSlab.live = themes;
  labelSlab.live = themes;
  if (themesEl && themes !== themesLive) setShown(themesEl, themes);
  themesLive = themes;
  const open = plaque || themes;
  if (open !== lastOpen) {
    lastOpen = open;
    hideRegion(root, !open);
  }
  placeHowto();
}

/** The reading notes: a small upright card over the plaque's top edge, kept
 *  inside the safe rect, following the plaque frame by frame. */
function placeHowto() {
  const el = howEl.value;
  if (!el) return;
  const s = plaqueSlab;
  if (!s.live) {
    if (howPos !== "hidden") {
      howPos = "hidden";
      el.style.visibility = "hidden";
    }
    return;
  }
  const q = s.quad;
  const x = (q[0] + q[2]) / 2;
  const y = Math.min(q[1], q[3]);
  const ins = props.insets;
  const m = 8;
  const left = Math.min(
    Math.max(ins.left + m, x - howW / 2),
    Math.max(ins.left + m, snap.w - ins.right - m - howW),
  );
  const top = Math.min(
    Math.max(ins.top + m, y - m - howH),
    Math.max(ins.top + m, snap.h - ins.bottom - m - howH),
  );
  const pos = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  if (pos !== howPos) {
    howPos = pos;
    el.style.transform = pos;
    el.style.visibility = "";
  }
}

/** The render scale for a slab drawn `sMax` × its box at the most (see
 *  RENDER_SCALES), from `r`. */
function renderScale(sMax: number, r: number): number {
  let lvl = Math.max(0, RENDER_SCALES.indexOf(r as 1 | 2 | 4));
  while (lvl < RENDER_BOUNDS.length && sMax > RENDER_BOUNDS[lvl] * 1.1) lvl++;
  while (lvl > 0 && sMax < RENDER_BOUNDS[lvl - 1] / 1.1) lvl--;
  return RENDER_SCALES[lvl];
}

/** How much larger than its box a slab is drawn at the most: its longest
 *  edge on screen over the same edge of the box. */
function stretchOf(s: Slab, box: { w: number; h: number }): number {
  const q = s.quad;
  const len = (i: number, j: number) =>
    Math.hypot(q[2 * j] - q[2 * i], q[2 * j + 1] - q[2 * i + 1]);
  return Math.max(len(0, 1) / box.w, len(3, 2) / box.w, len(0, 3) / box.h, len(1, 2) / box.h);
}

/**
 * Everything still: each slab's words drawn afresh at the scale they are seen
 * at. A box mapped onto its lid is drawn flat first, at the screen's pixel
 * density, then resampled through the map: about 1 : 1 right after a fit (the
 * slabs are sized so), sharp; zoomed in, enlarged — so drawn at 2 or 4 ×
 * first (CSS zoom), the lid then mapped from that larger box.
 */
function rest() {
  if (resting) return;
  resting = true;
  let changed = false;
  for (const s of SLABS) {
    const box = boxOf(s);
    if (!box || !s.drawn || !s.zoomEl) continue;
    const r = renderScale(stretchOf(s, box), s.r);
    if (r === s.r) continue;
    s.r = r;
    s.zoomEl.style.zoom = r === 1 ? "" : String(r);
    changed = true;
  }
  if (changed) layout();
}

// At rest once REST_MS have gone by with no frame. Frames come at 60 Hz in a
// flight: each only notes its time, and the one timer, when it fires early,
// waits out the rest instead of being cancelled and remade.
function scheduleRest() {
  lastFrameAt = performance.now();
  if (!restTimer) restTimer = window.setTimeout(restCheck, REST_MS);
}

function restCheck() {
  const idle = performance.now() - lastFrameAt;
  if (idle < REST_MS) {
    restTimer = window.setTimeout(restCheck, REST_MS - idle);
    return;
  }
  restTimer = 0;
  rest();
}

// ---- The DOM behind the records ----------------------------------------------------

const howRO =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const e of entries) {
          const box = e.borderBoxSize?.[0];
          howW = box ? box.inlineSize : (e.target as HTMLElement).offsetWidth;
          howH = box ? box.blockSize : (e.target as HTMLElement).offsetHeight;
        }
        howPos = "";
        placeHowto();
      });
let howObserved: Element | null = null;

// After every render (content only: nothing per frame is reactive): find the
// boxes Vue (re)created — hidden until laid on their lids.
function syncDom() {
  const root = rootEl.value;
  if (!root) return;
  for (const s of SLABS) {
    const el = root.querySelector<HTMLElement>(`[data-slab="${s.name}"]`);
    if (el !== s.el) {
      s.el = el;
      s.zoomEl = el?.querySelector<HTMLElement>(".slab-zoom") ?? null;
      s.bodyEl = el?.querySelector<HTMLElement>(".slab-body") ?? null;
      s.live = false;
      s.drawn = false;
      s.opacity = NaN;
      s.matrix = "";
      s.size = "";
      s.r = 1;
      if (el && s === plaqueSlab) setShown(el, false);
    }
  }
  const themes = root.querySelector<HTMLElement>(".slab-group");
  if (themes !== themesEl) {
    themesEl = themes;
    themesLive = false;
    if (themes) setShown(themes, false);
  }
  const how = howEl.value;
  if (how !== howObserved) {
    if (howObserved) howRO?.unobserve(howObserved);
    howObserved = how;
    howPos = "";
    if (how) {
      how.style.visibility = "hidden";
      howRO?.observe(how);
    }
  }
  layout();
}

// ---- Wiring --------------------------------------------------------------------

function swapContent(next: ScopeAnalysis) {
  content.value = next;
  contentSizes.value = props.sizes;
  contentScope = next.scopeId;
  // Another territory: its largest theme picked, and not said.
  picked.value = null;
  said.value = null;
  howOpen.value = false;
  hovered.value = null;
  rover.value = null;
}

watch(
  () => props.analysis,
  (next) => {
    targetScope = next.scopeId;
    if (next.scopeId === contentScope) {
      // The same territory, other figures (a filter, the data reloaded): the
      // label takes them quietly — GeoNav's summary says what changed.
      said.value = null;
      content.value = next;
      contentSizes.value = props.sizes;
      return;
    }
    // Nothing on show: the new words at once. Else the old slabs sink with
    // their plateau as they are; the frame that brings the new ones swaps.
    if (!SLABS.some((s) => s.drawn)) swapContent(next);
    layout();
  },
);

watch(
  () => props.sizes,
  (z) => {
    if (props.analysis.scopeId === contentScope) contentSizes.value = z;
  },
);

watch(
  () => props.frames,
  (src) => {
    unsubscribe?.();
    unsubscribe = null;
    source = src;
    if (!src) snap.live = false;
    if (src) unsubscribe = src.onFrame(onFrame);
    sendRing();
    layout();
  },
);

/** The ring's pick and hover, to the map: its raised parts and the bar
 *  follow (the territory the words are about: its own ring). */
function sendRing() {
  source?.setRing(a.value.scopeId, ringPicked.value, hovered.value);
}
watch(() => [a.value.scopeId, ringPicked.value, hovered.value], sendRing);

watch(
  () => props.visible,
  (v) => {
    isVisible = v;
    if (!v) {
      // Hidden under the mouse, a part never hears it leave.
      hovered.value = null;
      howOpen.value = false;
    }
    layout();
  },
);

// A theme picked in Filtres leaves the ring (it is in every testimony
// counted): picked on the ring, it is let go — the largest left is picked.
watch(ring, (r) => {
  const t = picked.value;
  if (t && !r?.parts.some((p) => p.theme === t)) picked.value = null;
});

// The reading notes close on a press anywhere else.
function onDocPointerDown(e: PointerEvent) {
  const t = e.target as Node | null;
  if (!t || howEl.value?.contains(t) || howBtn.value?.contains(t)) return;
  howOpen.value = false;
}
watch(howOpen, (open) => {
  if (open) document.addEventListener("pointerdown", onDocPointerDown, true);
  else document.removeEventListener("pointerdown", onDocPointerDown, true);
});

/** Escape: the reading notes first (the focus back on their button), then
 *  the analyses. */
function onEscape(e: KeyboardEvent) {
  if (howOpen.value) {
    e.stopPropagation();
    const inNotes = howEl.value?.contains(document.activeElement);
    howOpen.value = false;
    if (inNotes) howBtn.value?.focus({ preventScroll: true });
    return;
  }
  emit("close");
}

// The words are not the map's: mapbox listens for the wheel on its own
// canvas container only, so a zoom would stop dead the moment a part or a
// button slid under the cursor. Their wheel is passed on (the listener is not
// passive: the page must not scroll instead) — but for the reading notes,
// which scroll.
function onWheel(e: WheelEvent) {
  if (howEl.value?.contains(e.target as Node)) return;
  source?.forwardWheel(e);
}

/** Takes the focus to the plaque's title. Nothing when it is not on screen (a
 *  hidden slab is inert). */
function focusPlaque(): void {
  const root = rootEl.value;
  if (!root || !lastOpen || !plaqueSlab.live) return;
  root.querySelector<HTMLElement>(".plaque-title")?.focus({ preventScroll: true });
}

defineExpose({ focusPlaque });

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// The DEV probe (window.__acAnalyses), for checking the layout in a browser.
function probe() {
  const out: Record<string, unknown> = {};
  // Each slab: its lid on screen, its box, the scales its words are drawn at
  // (on screen px per CSS px: across its far edge, its near edge, and down
  // its sides), its render scale.
  for (const s of SLABS) {
    const box = boxOf(s);
    const q = s.quad;
    const len = (i: number, j: number) =>
      Math.hypot(q[2 * j] - q[2 * i], q[2 * j + 1] - q[2 * i + 1]);
    out[s.name] = {
      present: s.present,
      ok: s.ok,
      drawn: s.drawn,
      shown: s.live,
      opacity: s.opacity,
      box,
      r: s.r,
      quad: Array.from(q, r1),
      sMax: box ? r3(stretchOf(s, box)) : null,
      farScale: box ? r3(len(0, 1) / box.w) : null,
      nearScale: box ? r3(len(3, 2) / box.w) : null,
      heightRatio: box ? r3((len(0, 3) + len(1, 2)) / 2 / box.h) : null,
    };
  }
  const r = ring.value;
  return {
    visible: isVisible,
    open: lastOpen,
    frameScope: snap.scopeId,
    scope: contentScope,
    target: targetScope,
    rise: Math.round(snap.rise * 100) / 100,
    lid: slabLidMode.value,
    text: slabTextMode.value,
    textScale: slabTextScale.value,
    frameFill: frameFill.value,
    ringBand: ringBandMode.value,
    resting,
    sizes: contentSizes.value,
    slabs: out,
    donut: r
      ? {
          picked: ringPicked.value,
          byReader: picked.value !== null && picked.value === ringPicked.value,
          labelShown: shownPart.value?.theme ?? null,
          slices: r.parts.map((p) => ({
            theme: p.theme,
            colour: p.color,
            pastel: p.theme !== ringPicked.value,
            share: Math.round(p.share * 10000) / 10000,
            pct: p.pct,
            mentions: p.mentions,
          })),
        }
      : null,
  };
}

onMounted(() => {
  if (rootEl.value) hideRegion(rootEl.value, true);
  syncDom();
  if (source && !unsubscribe) unsubscribe = source.onFrame(onFrame);
  sendRing();
  if (isDev) (window as unknown as { __acAnalyses?: () => unknown }).__acAnalyses = probe;
});

onUpdated(syncDom);

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
  window.clearTimeout(restTimer);
  howRO?.disconnect();
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  if (isDev) {
    const w = window as unknown as { __acAnalyses?: () => unknown };
    if (w.__acAnalyses === probe) delete w.__acAnalyses;
  }
});
</script>

<template>
  <!-- No z-index: the panel, after it in the page, must paint over it. -->
  <div
    ref="rootEl"
    class="analyses-layer"
    :class="[slabLidMode, { compact }]"
    role="region"
    :aria-label="summaryLabel"
    @keydown.esc="onEscape"
    @wheel="onWheel"
  >
    <!-- 1. The plaque, on the slab under the middle of the territory: what
         this unit is, and how much was heard there. Its box is the size
         estimate's (analyses/content/analysisPlates: slabSizes), mapped onto the lid. -->
    <section data-slab="plaque" class="slab slab-plaque" :aria-labelledby="`${uid}-title`">
      <div class="slab-zoom">
        <div
          class="slab-body lid-glass"
          :style="{ width: `${sz.plaque.w}px`, height: `${sz.plaque.h}px` }"
        >
          <header class="plaque-head">
            <p class="plaque-kicker">
              <span class="kicker-text">{{ a.levelLabel }}</span>
              <span
                v-if="filtered"
                class="rel-badge"
                title="Les chiffres ne comptent que ce que les filtres retiennent"
                >filtré</span
              >
            </p>
            <button
              ref="howBtn"
              type="button"
              class="plate-icon"
              aria-label="Comment lire ?"
              title="Comment lire ?"
              :aria-expanded="howOpen"
              :aria-controls="`${uid}-howto`"
              @click="howOpen = !howOpen"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="11" x2="12" y2="16.5" />
                <line x1="12" y1="7.5" x2="12" y2="7.6" />
              </svg>
            </button>
            <button
              type="button"
              class="plate-icon"
              aria-label="Masquer les analyses"
              title="Masquer les analyses"
              @click="emit('close')"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2.4"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </header>
          <h2 :id="`${uid}-title`" class="plaque-title" tabindex="-1">{{ a.label }}</h2>
          <p v-if="a.testimonies" class="plaque-counts" :title="concentrationText || undefined">
            <span v-for="(line, i) in sz.plaque.countLines" :key="i" class="count-line">
              <template v-for="(c, j) in line" :key="c.key">
                <span v-if="j" class="sep" aria-hidden="true"> · </span>
                <span class="count"
                  ><strong>{{ fmtN(c.n) }}</strong> {{ c.word }}</span
                >
              </template>
            </span>
          </p>
          <p v-else class="plaque-empty">{{ emptyText }}</p>
        </div>
      </div>
    </section>

    <!-- 2. Thèmes, on the slab over the middle of the territory: a ring of
         every theme cited here, one colour each — no legend —, twice as tall
         as the bar of the theme named and its label beside it, three pieces
         in a row. One part is always picked, the largest until the reader
         picks another: it keeps its colour, the others turn pastel, and it is
         named beside the ring (a part hovered, for a preview), its short name
         — each part says its own in full. The parts and the bar are
         GeoDrillMap's, raised in their colours (setRing tells it the pick and
         the hover); here, over them, the ring's targets and its focus ring.
         The label's room is kept whatever it names. -->
    <section v-if="ring && sz.themes" class="slab-group" :aria-labelledby="`${uid}-themes`">
      <h3 :id="`${uid}-themes`" class="vh">Thèmes abordés</h3>
      <div data-slab="ring" class="slab slab-ring">
        <div class="slab-zoom">
          <div
            class="slab-body"
            :style="{ width: `${sz.themes.ringBox.w}px`, height: `${sz.themes.ringBox.h}px` }"
          >
            <!-- One radio group, one tab stop (a roving tabindex): each part
                 is a radio named in full, its figures with it, checked while
                 picked; the arrows go round it picking as they go, Enter or
                 Space picks the part focused (see onRingKey). A press keeps
                 the focus where it was (mousedown): the label says the pick,
                 the part's name would say it again. The focus ring is a path
                 of its own. Each part's full name is its target's tooltip (a
                 radio's children are not read: no name twice). -->
            <svg
              ref="ringEl"
              class="ring"
              :viewBox="`0 0 ${ring.box} ${ring.box}`"
              :width="ring.box"
              :height="ring.box"
              role="radiogroup"
              :aria-label="RING_LABEL"
              @keydown="onRingKey"
              @focusin="onRingFocusIn"
              @focusout="onRingFocusOut"
            >
              <g
                v-for="p in ring.parts"
                :key="p.theme"
                class="part"
                role="radio"
                :tabindex="p.theme === tabStop ? 0 : -1"
                :aria-checked="p.theme === ringPicked"
                :aria-label="p.aria"
                :data-theme="p.theme"
                @mousedown.prevent
                @click="onPartClick($event, p.theme)"
                @pointerenter="onPartEnter($event, p.theme)"
                @pointerleave="onPartLeave(p.theme)"
              >
                <path class="part-hit" :d="p.hit">
                  <title>{{ p.theme }}</title>
                </path>
              </g>
              <template v-if="focusPath">
                <path class="part-focus-halo" :d="focusPath" aria-hidden="true" />
                <path class="part-focus" :d="focusPath" aria-hidden="true" />
              </template>
            </svg>
          </div>
        </div>
      </div>
      <!-- The theme picked with a pointer is said as it shows; one picked
           with the keyboard, the largest, picked by default, and a preview
           are not (see `said`). Remade for each, so that it is said each
           time. Its share first — what the part's size shows —, then the
           count it is read from. -->
      <div data-slab="label" class="slab slab-label">
        <div class="slab-zoom">
          <div
            class="slab-body lid-glass"
            :style="{ width: `${sz.themes.labelBox.w}px`, height: `${sz.themes.labelBox.h}px` }"
          >
            <div class="ring-label" :style="{ width: `${sz.themes.labelW}px` }" aria-live="polite">
              <p
                v-if="shownPart"
                :key="`${shownPart.theme}${labelSaid ? '' : ':quiet'}`"
                :aria-hidden="labelSaid ? undefined : 'true'"
              >
                <strong class="label-name"
                  ><span class="label-pct">{{ shownPart.pct }}</span>
                  {{ shortName(shownPart.theme) }}</strong
                >
                <span class="label-cited">{{ shownPart.cited }}</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- The reading notes: no room on the plaque's lid, so a small upright
         card over its top edge, following it (placeHowto). They also say what
         the ring leaves unsaid: what its parts are a share of, how to read
         it, how many testimonies it is read from, how far to trust it. -->
    <div v-if="howOpen" :id="`${uid}-howto`" ref="howEl" class="howto-pop">
      <ul class="howto">
        <li>Pas un sondage : des voix recueillies où les bénévoles sont allés.</li>
        <li>
          Le cercle : la part de chaque thème parmi les thèmes cités ici. Un témoignage en aborde
          souvent plusieurs (ils sont attribués automatiquement) : ce n'est pas la part des
          témoignages qui l'abordent. Une couleur par thème, la même partout. Le thème le plus cité
          est montré d'abord ;
          <template v-if="compact">touchez une autre part pour afficher son thème.</template>
          <template v-else>cliquez sur une autre part pour afficher son thème.</template>
        </li>
        <li v-if="themesReading">{{ themesReading }}</li>
        <li>
          Pour chaque thème, sa part des thèmes cités, puis le nombre de témoignages qui l'abordent.
          Sous 100 témoignages analysés, la part est arrondie à 5&nbsp;% près («&nbsp;≈&nbsp;»). La
          base est « solide » avec 30 témoignages ou plus, d'au moins 3 auditions d'une même
          période, aucune au-delà de la moitié ; sinon, le cercle n'est qu'indicatif. Sous 5
          témoignages, pas de cercle.
        </li>
      </ul>
    </div>

    <!-- Testing tools only (dev server, staging): the slabs' lid, words and
         size, the territory's framing, the ring's band (analyses/devSwitch).
         Apart from them; on a phone folded, see switchStyle. -->
    <component
      :is="compact ? 'details' : 'div'"
      v-if="testTools"
      v-show="visible"
      class="slab-switch"
      :style="switchStyle"
      role="group"
      aria-label="Dalles des analyses (DEV)"
    >
      <summary v-if="compact" class="switch-fold">DEV</summary>
      <div class="switch-rows">
        <div class="seg" role="group" aria-label="Dalle">
          <span class="seg-label">Dalle</span>
          <button
            v-for="m in LID_MODES"
            :key="m.id"
            type="button"
            class="seg-btn"
            :aria-pressed="slabLidMode === m.id"
            @click="setSlabLidMode(m.id)"
          >
            {{ m.label }}
          </button>
        </div>
        <div class="seg" role="group" aria-label="Texte">
          <span class="seg-label">Texte</span>
          <button
            v-for="m in TEXT_MODES"
            :key="m.id"
            type="button"
            class="seg-btn"
            :aria-pressed="slabTextMode === m.id"
            @click="setSlabTextMode(m.id)"
          >
            {{ m.label }}
          </button>
        </div>
        <div class="seg" role="group" aria-label="Taille du texte">
          <span class="seg-label">Taille</span>
          <button
            v-for="m in SHARES"
            :key="m.v"
            type="button"
            class="seg-btn"
            :aria-pressed="slabTextScale === m.v"
            @click="setSlabTextScale(m.v)"
          >
            {{ m.label }}
          </button>
        </div>
        <div class="seg" role="group" aria-label="Cadrage">
          <span class="seg-label">Cadrage</span>
          <button
            v-for="m in SHARES"
            :key="m.v"
            type="button"
            class="seg-btn"
            :aria-pressed="frameFill === m.v"
            @click="setFrameFill(m.v)"
          >
            {{ m.label }}
          </button>
        </div>
        <div class="seg" role="group" aria-label="Anneau">
          <span class="seg-label">Anneau</span>
          <button
            v-for="m in RING_MODES"
            :key="m.id"
            type="button"
            class="seg-btn"
            :aria-pressed="ringBandMode === m.id"
            @click="setRingBandMode(m.id)"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
    </component>
  </div>
</template>

<style scoped>
/* Over the map, the same box as its container (its px are the frame's px). */
.analyses-layer {
  position: absolute;
  inset: 0;
  overflow: clip;
  pointer-events: none;
}

/* ---- Slabs ---- */

/* Laid on its lid by its transform (written per frame, mapped from its top
   left corner). Its body lets the pointer through, as the ground does: a drag
   on it moves the map; only the ring's parts, the buttons and the tooltips
   (the counts', the "filtré" badge's) take it. Its content is drawn at a
   render scale (.slab-zoom, at rest). Nothing here may fade, filter, clip
   or mask the box (no opacity, no filter, no clip-path, no mask): that would
   make it the glass's backdrop root, and the glass would blur nothing — its
   body fades instead. */
.slab {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  backface-visibility: hidden;
  pointer-events: none;
}

/* The box the estimate laid out (analyses/content/analysisPlates: slabSizes — keep in
   step): every word at --text-caption, the title at --text-title. No
   transition: it fades with the lid's rise, frame by frame (written there).
   Its ground is its lid's — the map draws it exactly where the lid stands: a
   ground here, the box mapped by its corners, would be a pixel or so inside
   the lid on the globe, where the lid follows the sphere, more zoomed in —,
   but for glass (.lid-glass), the words' own. Under a 3D transform the words
   are smoothed the same either way. */
.slab-body {
  box-sizing: border-box;
  color: hsl(var(--slab-ink, var(--card-foreground)));
  font-size: var(--text-caption);
  line-height: 1.3;
  opacity: 0;
}

/* "Verre" (the default): the label's box and the plaque are glass — their
   pieces' lids are not drawn (GeoDrillMap), the map under them shows here,
   blurred, brightened, its colours lifted, through a light white — enough
   for the words to read should a browser drop the blur under the 3D
   transform —; a bright rim along the top edge and round it, a sheen
   across; rounded as their pieces' outlines (map/lib/slabs: SLAB_RADIUS_PX).
   Chromium computes the blur in the box's own plane (the backdrop mapped
   into it): it lies on the lid with the words. The map keeps the style's own
   light (Standard, "dawn": pale warm ground, dark place names) whatever the
   site's theme — the dark theme would write the words light on a light map
   —, so the words take a dark ink of their own here, and a light halo
   against what shows through. */
.verre {
  --slab-ink: 240 10% 10%;
  --slab-muted: 240 6% 30%;
  --slab-accent: 270 62% 44%;
  --slab-hover: 0 0% 100% / 0.6;
}

.verre .lid-glass {
  border-radius: 6px;
  background:
    linear-gradient(
      160deg,
      hsl(0 0% 100% / 0.45),
      hsl(0 0% 100% / 0.12) 42%,
      hsl(0 0% 100% / 0.04) 58%,
      hsl(0 0% 100% / 0.2)
    ),
    hsl(0 0% 100% / 0.45);
  -webkit-backdrop-filter: blur(9px) saturate(1.8) brightness(1.08);
  backdrop-filter: blur(9px) saturate(1.8) brightness(1.08);
  box-shadow:
    inset 0 1px 0 hsl(0 0% 100% / 0.85),
    inset 0 0 0 1px hsl(0 0% 100% / 0.4),
    inset 0 -1px 2px hsl(0 0% 100% / 0.3);
  text-shadow: 0 0 2px hsl(0 0% 100% / 0.8);
}

/* No backdrop filter: frosted, not blurred — a white the words read on over
   the map as it is. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .verre .lid-glass {
    background-color: hsl(0 0% 100% / 0.74);
  }
}

/* Less transparency asked for: no blur, a white the words read on, barely
   letting the map through. */
@media (prefers-reduced-transparency: reduce) {
  .verre .lid-glass {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    background-color: hsl(0 0% 100% / 0.9);
  }
}

/* "Carte" (DEV): the lid shows the raised map; the words haloed over it. */
.carte .slab-body {
  text-shadow:
    0 0 2px hsl(var(--card)),
    0 0 2px hsl(var(--card)),
    0 0 4px hsl(var(--card));
}

.slab p {
  margin: 0;
}

.slab :focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
}

/* Visually hidden, still read: a heading, a value said in full. */
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ---- Plaque ---- */

.slab-plaque .slab-body {
  padding: 0.35rem 0.5rem;
}

/* The head row, 16 px: the level and its badge, then the two buttons (24 px,
   drawn into the padding above and below, the last into it at the right). */
.plaque-head {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  height: 16px;
}

.plaque-kicker {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.2;
  text-transform: uppercase;
  white-space: nowrap;
  color: hsl(var(--slab-accent, var(--primary)));
}

.kicker-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The filters are on: the figures are theirs. */
.rel-badge {
  flex: none;
  padding: 0 0.35rem;
  border-radius: 999px;
  border: 1px solid hsl(var(--slab-accent, var(--primary)) / 0.3);
  background: hsl(var(--slab-accent, var(--primary)) / 0.1);
  letter-spacing: normal;
  text-transform: none;
  line-height: 1.15;
}

.plate-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: -4px 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: hsl(var(--slab-muted, var(--muted-foreground)));
  cursor: pointer;
}

.plate-icon:last-child {
  margin-right: -4px;
}

.plate-icon:hover {
  color: hsl(var(--slab-ink, var(--foreground)));
  background: hsl(var(--slab-hover, var(--muted)));
}

.plaque-title {
  margin: 0.15rem 0 0;
  font-family: var(--font-display);
  font-size: var(--text-title);
  font-weight: 400;
  letter-spacing: 0.04em;
  line-height: 1;
  color: hsl(var(--slab-ink, var(--foreground)));
  overflow-wrap: anywhere;
}

.plaque-title:focus:not(:focus-visible) {
  outline: none;
}

/* The counts in the lines the estimate laid them out on: one, but on a
   screen too narrow for them. */
.plaque-counts,
.plaque-empty {
  margin-top: 0.2rem;
  color: hsl(var(--slab-ink, var(--foreground)));
}

.count-line {
  display: block;
  white-space: nowrap;
}

.count strong {
  font-weight: 700;
}

.count-line:first-child .count:first-of-type strong {
  color: hsl(var(--slab-accent, var(--primary)));
}

.sep {
  color: hsl(var(--slab-muted, var(--muted-foreground)) / 0.7);
}

/* ---- Thèmes ---- */

/* Only the targets and the focus ring: the parts themselves are the map's,
   raised in their colours (vivid picked or hovered, pastel otherwise) right
   under this box. The browser hit-tests the ring as it is laid on the lid,
   its targets and its focus ring with it. */
.ring {
  display: block;
  overflow: visible;
}

.part {
  cursor: pointer;
}

/* The focus ring is drawn as a path (.part-focus), never as an outline. */
.slab-ring .part:focus,
.slab-ring .part:focus-visible {
  outline: none;
}

/* Where a part takes the pointer: its span, gaps included, a little inside
   and outside the ring (whatever its fill: none is painted). */
.part-hit {
  fill: transparent;
  fill-rule: evenodd;
}

/* Only the parts, the buttons, the counts and the "filtré" badge (their
   tooltips) take the pointer, and only on a slab on show (an inert one takes
   nothing anyway). */
[data-live] .part-hit {
  pointer-events: fill;
}

[data-live] .plate-icon,
[data-live] .plaque-counts,
[data-live] .rel-badge {
  pointer-events: auto;
}

.part-focus-halo,
.part-focus {
  fill: none;
  stroke-linejoin: round;
  pointer-events: none;
}

.part-focus-halo {
  stroke: hsl(var(--background));
  stroke-width: 3;
}

.part-focus {
  stroke: hsl(var(--ring));
  stroke-width: 1.5;
}

/* The label's box, right of the bar of the theme's colour (the map's): two
   lines — its share and short name, its count —, each on one line (the room
   is measured for the widest part; an ellipsis only should a font come out
   wider). */
.slab-label .slab-body {
  display: flex;
  align-items: center;
  padding: 0.3rem 0.45rem;
}

.ring-label {
  flex: none;
  min-width: 0;
  pointer-events: none;
}

.label-name,
.label-cited {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.label-name {
  font-weight: 700;
  line-height: 1.2;
  color: hsl(var(--slab-ink, var(--foreground)));
}

.label-cited {
  margin-top: 0.1rem;
  line-height: 1.3;
  color: hsl(var(--slab-muted, var(--muted-foreground)));
}

/* ---- The reading notes: upright, over the plaque's top edge ---- */

.howto-pop {
  position: absolute;
  left: 0;
  top: 0;
  box-sizing: border-box;
  max-width: min(18rem, calc(100% - 16px));
  max-height: 40%;
  overflow: auto;
  padding: 0.5rem 0.65rem;
  border: 1px solid hsl(var(--border));
  border-radius: 0.6rem;
  background: hsl(var(--card));
  color: hsl(var(--card-foreground));
  box-shadow: var(--shadow-lg);
  font-size: var(--text-caption);
  line-height: 1.35;
  pointer-events: auto;
}

.howto {
  margin: 0;
  padding: 0 0 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  color: hsl(var(--foreground) / 0.85);
}

.howto li::marker {
  color: hsl(var(--primary));
}

/* ---- DEV only, apart from the slabs (see the template) ---- */

.slab-switch {
  position: absolute;
  padding: 0.15rem;
  border-radius: 0.45rem;
  background: hsl(var(--muted));
  box-shadow: var(--shadow-sm);
  font-size: var(--text-caption);
  white-space: nowrap;
  pointer-events: auto;
}

/* A phone's fold: as narrow as it reads, no marker. */
.switch-fold {
  display: block;
  padding: 0.05rem 0.3rem;
  color: hsl(var(--muted-foreground));
  font-weight: 600;
  cursor: pointer;
}

.switch-fold::-webkit-details-marker {
  display: none;
}

.slab-switch[open] .switch-fold {
  margin-bottom: 0.15rem;
}

.switch-rows {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.seg {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}

.seg-label {
  min-width: 3.6rem;
  padding: 0 0.3rem;
  color: hsl(var(--muted-foreground));
}

.seg-btn {
  padding: 0.05rem 0.45rem;
  border: none;
  border-radius: 0.3rem;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
}

.seg-btn[aria-pressed="true"] {
  background: hsl(var(--card));
  color: hsl(var(--primary));
  box-shadow: var(--shadow-sm);
}
</style>
