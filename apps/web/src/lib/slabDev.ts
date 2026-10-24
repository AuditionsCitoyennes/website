// The analyses' slabs' choices, compared live (the overlay's DEV switch), in
// the builds with the testing tools — the dev server and staging
// (__TEST_TOOLS__, vite.config): shared by GeoNav (the camera's room, the
// slabs' spec) and the overlay (the words' ground). Production keeps the
// defaults, which these refs never leave there (no switch is drawn).
//
// - The lid of the words' pieces (the label's box, the plaque): "verre" (the
//   default) — glass, the map under it seen blurred and brightened, the words
//   in a dark ink of their own —, "opaque": the site's card colour, so that
//   the map's own labels never show through the words —, or "carte": the
//   raised map seen through it, as on the plateau's lid, the words haloed.
// - The words: "redresse" (the default) — the slab drawn long, as road
//   markings are, so that seen at the fit's pitch its words read at their
//   proportions —, or "plat": the slab as wide as tall in metres as its box,
//   its words squashed by the tilt like any ground.
// - "Taille": the words right after a fit, as a share of the type scale's
//   sizes — the slabs drawn that much smaller (lib/slabs: TEXT_SCALE, the
//   default).
// - "Cadrage": how much of its rectangle a clicked territory fills once
//   framed, on the axis that limits it (lib/slabs: FRAME_FILL, the default) —
//   every territory's fit, the analyses shown or not (the switch is drawn
//   with them).
// - "Anneau": the themes' ring's band, per px of its outer diameter — "fin"
//   (the band of before, its hole the larger), "moyen" (lib/analysisPlates:
//   RING_THICK, the default) or "epais". The ring's box stays as it is: no
//   room, no slab moves.
import { ref } from "vue";
import { RING_THICK } from "@/lib/analysisPlates";
import { FRAME_FILL, TEXT_SCALE } from "@/lib/slabs";

export type SlabLidMode = "verre" | "opaque" | "carte";
export type SlabTextMode = "redresse" | "plat";
export type RingBandMode = "fin" | "moyen" | "epais";

const enabled = __TEST_TOOLS__;
// (Not "ac:slab-lid", which kept the choice made while Opaque was the
// default: Verre is shown first once again.)
const LID_KEY = "ac:slab-lid-verre";
const TEXT_KEY = "ac:slab-text";
const SIZE_KEY = "ac:slab-size";
const FILL_KEY = "ac:frame-fill";
const RING_KEY = "ac:ring-band";

/** The shares the switch offers, "Taille" and "Cadrage" alike. */
export const SCALE_CHOICES = [0.7, 0.8, 0.9, 1] as const;

/** "Anneau": each band, per px of the ring's outer diameter. */
export const RING_BANDS: Readonly<Record<RingBandMode, number>> = {
  fin: 0.125,
  moyen: RING_THICK,
  epais: 0.28,
};

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (!enabled) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** A share kept as its percentage ("80"), one of SCALE_CHOICES. */
function storedShare(key: string, fallback: number): number {
  const pct = stored(
    key,
    SCALE_CHOICES.map((v) => String(Math.round(v * 100))),
    String(Math.round(fallback * 100)),
  );
  return Number(pct) / 100;
}

export const slabLidMode = ref<SlabLidMode>(stored(LID_KEY, ["verre", "opaque", "carte"], "verre"));
export const slabTextMode = ref<SlabTextMode>(stored(TEXT_KEY, ["redresse", "plat"], "redresse"));
export const slabTextScale = ref<number>(storedShare(SIZE_KEY, TEXT_SCALE));
export const frameFill = ref<number>(storedShare(FILL_KEY, FRAME_FILL));
export const ringBandMode = ref<RingBandMode>(stored(RING_KEY, ["fin", "moyen", "epais"], "moyen"));

export function setSlabLidMode(m: SlabLidMode) {
  if (!enabled) return;
  slabLidMode.value = m;
  store(LID_KEY, m);
}

export function setSlabTextMode(m: SlabTextMode) {
  if (!enabled) return;
  slabTextMode.value = m;
  store(TEXT_KEY, m);
}

export function setSlabTextScale(v: number) {
  if (!enabled || !SCALE_CHOICES.includes(v as (typeof SCALE_CHOICES)[number])) return;
  slabTextScale.value = v;
  store(SIZE_KEY, String(Math.round(v * 100)));
}

export function setFrameFill(v: number) {
  if (!enabled || !SCALE_CHOICES.includes(v as (typeof SCALE_CHOICES)[number])) return;
  frameFill.value = v;
  store(FILL_KEY, String(Math.round(v * 100)));
}

export function setRingBandMode(m: RingBandMode) {
  if (!enabled) return;
  ringBandMode.value = m;
  store(RING_KEY, m);
}
