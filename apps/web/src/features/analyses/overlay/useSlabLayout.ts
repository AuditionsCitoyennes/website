// The words' PLACE, frame by frame — nothing here is reactive. Each frame of
// the map (GeoDrillMap's frame bus) hands over each box's four corners on
// screen at its lid's height, projected with the very camera the lids are
// drawn with, and the box is mapped onto them by a projective transform
// (matrix3d) written straight to the DOM — no reactive write, no layout read
// per frame. A plane seen in perspective IS a projective map of it: the words
// lie exactly on the lid, corner to corner. Three boxes: the ring's (its
// parts' targets and focus ring, over the parts raised), the label's, the
// plaque's — plain records owned here, found again in the DOM after every
// render (syncDom). The words' CONTENT (what the slabs say, their boxes) is
// the overlay's, ordinary Vue: it comes in through `boxOf` and the setters.
import type { Ref } from "vue";
import type { PlateauFrame } from "@/features/map/types";
import { homography, matrix3dOf } from "@/features/map/lib";
import type { FrameSource } from "./frameSource";

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
export type SlabName = "plaque" | "ring" | "label";

export interface Slab {
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

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SlabLayoutOpts {
  /** The layer's root (the region), and the reading notes' card. */
  rootEl: Ref<HTMLElement | null>;
  howEl: Ref<HTMLElement | null>;
  /** The safe rect inside the map container, px (the reading notes stay inside it). */
  insets: () => Insets;
  /** A slab's box of words, CSS px (null: none) — the content boxes shown. */
  boxOf: (name: SlabName) => { w: number; h: number } | null;
  /** The new unit's slabs have come (or the old ones are down): its words. */
  onSwap: () => void;
  /** As first given: the frame bus, whether the words may show, the unit. */
  frames: FrameSource | null;
  visible: boolean;
  scopeId: string;
}

/** The state behind the words, for the DEV probe. */
export interface SlabLayoutSnapshot {
  visible: boolean;
  open: boolean;
  frameScope: string;
  scope: string;
  target: string;
  rise: number;
  resting: boolean;
  slabs: readonly Slab[];
}

export interface SlabLayout {
  /** Lay every slab's words on its lid, from the last frame. Per frame, and
   *  on any change. */
  layout(): void;
  /** After every render (content only: nothing per frame is reactive): find
   *  the boxes Vue (re)created — hidden until laid on their lids. */
  syncDom(): void;
  snapshot(): SlabLayoutSnapshot;
  /** The unit the words shown are about. */
  readonly contentScope: string;
  /** The unit whose words are wanted. */
  setTarget(scopeId: string): void;
  /** The words shown are now `scopeId`'s. */
  setContent(scopeId: string): void;
  /** Whether the words may show at all (the parent's view of the page). */
  setVisible(visible: boolean): void;
  /** Another frame bus, or none: the old one left, the new one listened to. */
  setSource(src: FrameSource | null): void;
  /** Whether any slab's words are drawn on a lid. */
  anyDrawn(): boolean;
  /** Takes the focus to the plaque's title. Nothing when it is not on screen
   *  (a hidden slab is inert). */
  focusPlaque(): void;
  /** Mounted: the region hidden, the DOM found, the frames listened to. */
  mount(): void;
  /** About to unmount. */
  dispose(): void;
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
export function stretchOf(s: Slab, box: { w: number; h: number }): number {
  const q = s.quad;
  const len = (i: number, j: number) =>
    Math.hypot(q[2 * j] - q[2 * i], q[2 * j + 1] - q[2 * i + 1]);
  return Math.max(len(0, 1) / box.w, len(3, 2) / box.w, len(0, 3) / box.h, len(1, 2) / box.h);
}

export function useSlabLayout(opts: SlabLayoutOpts): SlabLayout {
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
  let source: FrameSource | null = opts.frames;
  let isVisible = opts.visible;
  let targetScope = opts.scopeId;
  let contentScope = opts.scopeId;

  let lastOpen = false;
  let resting = true;

  /** The reading notes' card size, px (ResizeObserver). */
  let howW = 0;
  let howH = 0;
  let howPos = "";

  /** The projective map being written (reused frame after frame). */
  const homBuf = new Float64Array(8);

  let restTimer = 0;
  let lastFrameAt = 0;
  let unsubscribe: (() => void) | null = null;

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
      opts.onSwap();
    }
    layout();
    scheduleRest();
  }

  /** Lay every slab's words on its lid, from the last frame. Per frame, and on
   *  any change. */
  function layout() {
    const root = opts.rootEl.value;
    if (!root) return;
    const own = snap.live && snap.scopeId !== "" && snap.scopeId === contentScope;
    const fade = own ? Math.min(1, Math.max(0, (snap.rise - RISE_SHOW) / RISE_FADE)) : 0;
    for (const s of SLABS) {
      const box = opts.boxOf(s.name);
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
    const el = opts.howEl.value;
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
    const ins = opts.insets();
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
      const box = opts.boxOf(s.name);
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
    const root = opts.rootEl.value;
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
    const how = opts.howEl.value;
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

  // ---- What the overlay drives --------------------------------------------------------

  function setSource(src: FrameSource | null) {
    unsubscribe?.();
    unsubscribe = null;
    source = src;
    if (!src) snap.live = false;
    if (src) unsubscribe = src.onFrame(onFrame);
  }

  /** Takes the focus to the plaque's title. Nothing when it is not on screen (a
   *  hidden slab is inert). */
  function focusPlaque(): void {
    const root = opts.rootEl.value;
    if (!root || !lastOpen || !plaqueSlab.live) return;
    root.querySelector<HTMLElement>(".plaque-title")?.focus({ preventScroll: true });
  }

  function snapshot(): SlabLayoutSnapshot {
    return {
      visible: isVisible,
      open: lastOpen,
      frameScope: snap.scopeId,
      scope: contentScope,
      target: targetScope,
      rise: snap.rise,
      resting,
      slabs: SLABS,
    };
  }

  return {
    layout,
    syncDom,
    snapshot,
    get contentScope() {
      return contentScope;
    },
    setTarget(scopeId) {
      targetScope = scopeId;
    },
    setContent(scopeId) {
      contentScope = scopeId;
    },
    setVisible(visible) {
      isVisible = visible;
    },
    setSource,
    anyDrawn: () => SLABS.some((s) => s.drawn),
    focusPlaque,
    mount() {
      const root = opts.rootEl.value;
      if (root) hideRegion(root, true);
      syncDom();
      if (source && !unsubscribe) unsubscribe = source.onFrame(onFrame);
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      window.clearTimeout(restTimer);
      howRO?.disconnect();
    },
  };
}
