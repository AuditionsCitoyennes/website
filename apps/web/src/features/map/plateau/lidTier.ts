// The plateau lid's pixel budget from the screen ("ecran", plateau/lidSwitch):
// the backing-store sizes the hidden map may capture at, read from the WINDOW
// (not the map's canvas), so the home card's lid is already sized for the page
// it opens into. Pure: no DOM, no Vue — the caller reads the window and
// `matchMedia("(pointer: coarse)")`. Run with `node --import tsx --test`
// (root "test:scripts").
//
// - The floor sizes a select's shot taken before its camera flight, and is the
//   least any shot takes: a unit framed whole fills about the window's short
//   side, so its device pixels are what the screen can show of it. 1024 at
//   least (a small window still zooms in), 2048 at most (today's fixed shot).
// - The ceiling caps every shot sized from the camera, the refines over the
//   visible slice above all: they ask for 1.7× the slice (LID_MARGIN on each
//   side, usePlateauLid), so 1.7× the window's width.
//   A phone (a coarse pointer, the short side under 600 css px) stops at 2048:
//   its tall canvas asks for ~4096 (64 MiB) to sharpen a strip it shows at
//   ~1179 device px.
// - A known low-memory device (deviceMemory <= 4) keeps today's flat 1024.

export interface LidTierInput {
  innerW: number;
  innerH: number;
  dpr: number;
  /** navigator.deviceMemory — undefined where the browser hides it (Safari, Firefox). */
  deviceMemory?: number;
  /** matchMedia("(pointer: coarse)").matches */
  coarse: boolean;
}

export interface LidTier {
  floor: number;
  ceiling: number;
}

/** The floor per device pixel of the window's short side. */
const FLOOR_PER_SCREEN = 1;
const FLOOR_MIN = 1024;
const FLOOR_MAX = 2048;
const CEILING_MAX = 4096;
/** A refine's ask over the window's width: the slice plus LID_MARGIN on each side. */
const REFINE_PER_WIDTH = 1.7;
const PHONE_SHORT_CSS = 600;
const PHONE_CEILING = 2048;
const LOW_MEMORY_PX = 1024;

const roundUp256 = (px: number) => Math.ceil(Math.max(px, 1) / 256) * 256;

export function lidTier({ innerW, innerH, dpr, deviceMemory, coarse }: LidTierInput): LidTier {
  if (deviceMemory !== undefined && deviceMemory <= 4) {
    return { floor: LOW_MEMORY_PX, ceiling: LOW_MEMORY_PX };
  }
  const ratio = dpr > 0 ? dpr : 1;
  const short = Math.min(innerW, innerH);
  const floor = Math.min(
    FLOOR_MAX,
    Math.max(FLOOR_MIN, roundUp256(short * ratio * FLOOR_PER_SCREEN)),
  );
  let ceiling = Math.min(
    CEILING_MAX,
    Math.max(floor, roundUp256(REFINE_PER_WIDTH * innerW * ratio)),
  );
  if (coarse && short < PHONE_SHORT_CSS) ceiling = Math.min(ceiling, PHONE_CEILING);
  return { floor, ceiling };
}

/**
 * The backing-store size of a shot, in pixels of the hidden map's canvas:
 * what the caller wants (`wantPx`, sized against the main map's canvas),
 * rounded up to a multiple of 256 so ordinary window resizes do not churn
 * the hidden map, and held between the tier's floor and its ceiling and
 * under `hardMax` (GL_MAX_TEXTURE_SIZE: a larger bitmap fails to upload;
 * `noHardMax` when the layer has not read it yet).
 *
 * The tier is in SCREEN pixels. `screenPerMapPx` (pixelRatio.ts) is how many
 * of them a pixel of the maps' canvases covers along a side: 1 everywhere,
 * unless the maps draw under the screen's ratio. The size is settled in
 * screen pixels and comes back in the canvas's own, so the hidden map keeps
 * the CSS size, the zoom, the tiles and the labels it has at the screen's
 * ratio, with fewer pixels — as the main map does.
 */
export function shotPixels(
  wantPx: number,
  hardMax: number,
  tier: LidTier,
  noHardMax: number,
  screenPerMapPx = 1,
): number {
  const k = screenPerMapPx > 1 ? screenPerMapPx : 1;
  const ceil = Math.min(tier.ceiling, hardMax > 0 ? hardMax * k : noHardMax);
  const want = roundUp256(wantPx * k);
  const screenPx = Math.max(Math.min(want, ceil), Math.min(tier.floor, ceil));
  return k === 1 ? screenPx : Math.round(screenPx / k);
}
