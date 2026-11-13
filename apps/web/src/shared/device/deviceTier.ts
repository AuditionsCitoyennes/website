// How strong the visitor's device is, as one of three tiers: "full" (the
// locked design), "light" and "minimal" (the lighter variants a weak device
// may get). Read by nothing yet but the DEV dialog, which shows it: the
// variants themselves come later, each one reading this module.
//
// In "auto" the tier comes from three kinds of signal:
//
// - Hints the browser gives before the map starts, on Chrome-family browsers
//   only (Safari and Firefox give none, and an unknown is never read as weak):
//   little memory (navigator.deviceMemory <= 2), few cores
//   (hardwareConcurrency <= 2), the Save-Data setting, a slow-2g / 2g / 3g
//   link. Any of them: "light". The core count is trusted only beside a
//   reported deviceMemory: elsewhere it can be a clamped constant (privacy
//   settings), which would put a whole browser family in "light".
// - The WebGL renderer's name: a software renderer (SwiftShader, llvmpipe,
//   Microsoft Basic Render Driver…) is "minimal". The name is an argument, for
//   the caller that already has a context; `probeRenderer()` reads it once
//   from a throwaway context for the one that has none.
// - A measure, the only signal an iPhone gives: `reportFrameTimes(samples)`
//   takes the frame times of the first camera flight. Past the thresholds
//   below the step down is kept in localStorage (`ac:tier-measured`) for the
//   next visits, 30 days, and applies to this session at once.
//
// Two kinds of weak, because their remedies differ: a slow processor
// (`cpuWeak`: less work per frame on the page's thread) and slow graphics
// (`gpuWeak`: fewer pixels, no multisampling).
//
// `ac:tier` (the DEV dialog's « Appareil » row, testing tools only): "auto"
// (the default) or a forced tier, to look at each variant on any machine.
// Forced "light" reads as a slow processor, forced "minimal" as both. Read
// once per page load: switching reloads the page. Production has neither key
// nor switch: DEFAULT_TIER_CHOICE.
//
// No import and nothing run at load but the switch's read: loadable under
// node (deviceTier.test.ts).

export type DeviceTier = "full" | "light" | "minimal";
export type TierChoice = "auto" | DeviceTier;

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_TIER_CHOICE: TierChoice = "auto";
export const TIER_CHOICES: readonly TierChoice[] = ["auto", "full", "light", "minimal"];

// ---- The hints ---------------------------------------------------------------------

/** What the browser says about the device; null: it does not say. */
export interface DeviceHints {
  /** navigator.deviceMemory, in GB (Chrome-family only; capped at 8). */
  deviceMemory: number | null;
  /** navigator.hardwareConcurrency. */
  hardwareConcurrency: number | null;
  /** The Save-Data setting (navigator.connection.saveData). */
  saveData: boolean;
  /** navigator.connection.effectiveType: "slow-2g", "2g", "3g", "4g". */
  effectiveType: string | null;
}

/** deviceMemory at or under this (GB) is little memory. Not 4: that is an
 *  ordinary mid-range phone. */
export const LOW_MEMORY_GB = 2;
/** hardwareConcurrency at or under this is few cores. */
export const FEW_CORES = 2;
const SLOW_LINKS: readonly string[] = ["slow-2g", "2g", "3g"];

interface NavigatorLike {
  deviceMemory?: unknown;
  hardwareConcurrency?: unknown;
  connection?: { saveData?: unknown; effectiveType?: unknown } | null;
}

const positive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** The hints of a navigator (none: every hint unknown). */
export function readHints(nav: NavigatorLike | null | undefined): DeviceHints {
  const c = nav?.connection;
  return {
    deviceMemory: positive(nav?.deviceMemory),
    hardwareConcurrency: positive(nav?.hardwareConcurrency),
    saveData: c?.saveData === true,
    effectiveType: typeof c?.effectiveType === "string" ? c.effectiveType : null,
  };
}

/** A WebGL renderer name that is the processor drawing in place of a graphics
 *  chip: SwiftShader, llvmpipe, softpipe, lavapipe, "Software Rasterizer",
 *  "Apple Software Renderer", "Microsoft Basic Render Driver". */
export function isSoftwareRenderer(name: string | null | undefined): boolean {
  return !!name && /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(name);
}

// ---- The measure -------------------------------------------------------------------

/** A frame of the flight: how long after the frame before it came (`ms`) and,
 *  when the caller timed it, how much of that the page's thread worked
 *  (`workMs`). A bare number is `ms` alone. */
export type FrameSample = number | { ms: number; workMs?: number };

/** Which part was slow: the processor, the graphics, or not told (no `workMs`). */
export type WeakKind = "cpu" | "gpu" | "unknown";

/** A step down, as measured and as kept. */
export interface MeasuredStep {
  tier: Exclude<DeviceTier, "full">;
  kind: WeakKind;
  /** When it was measured (ms since the epoch). */
  at: number;
}

// The thresholds, from the audit's flights (2026-11-12, frames counted at
// 60 Hz, per selection flight):
//                    frames over 33 ms   frames over 100 ms   worst frame
//   desktop                0-2                 0-1              17-100 ms
//   weak phone (x6)        3-9                 0-2              67-183 ms
//   Game Boy (x20)         3-17                3-7             283-583 ms
//   software GL            4-11                3-9              83-1267 ms
// Counts, not the worst frame: every flight opens with one heavy frame, on
// every device.
/** A frame this long is slow. Over 33.3 ms, so that a display capped at 30
 *  frames a second (a phone saving power) is not read as slow; at 60 Hz it is
 *  the audit's "over 33 ms" (the next step is 50 ms). */
export const SLOW_FRAME_MS = 40;
/** A frame this long is very slow (the audit's "over 100 ms"). */
export const VERY_SLOW_FRAME_MS = 100;
/** This many slow frames in one flight: "light" (the desktop's worst is 2). */
export const LIGHT_SLOW_FRAMES = 4;
/** This many very slow frames in one flight: "minimal" (the weak phone's worst is 2). */
export const MINIMAL_VERY_SLOW_FRAMES = 3;
/** A report shorter than this (frames, ms) judges nothing. */
export const MIN_FLIGHT_FRAMES = 5;
export const MIN_FLIGHT_MS = 250;
/** The page's thread working this share of the slow frames: the processor is
 *  the slow part; under it, the graphics. */
export const CPU_SHARE = 0.5;
/** A kept step is read for this long, then the device is judged again. */
export const MEASURE_KEPT_MS = 30 * 24 * 3600 * 1000;

const MEASURED_KEY = "ac:tier-measured";

const sampleMs = (s: FrameSample) => (typeof s === "number" ? s : s.ms);
const sampleWork = (s: FrameSample) => (typeof s === "number" ? undefined : s.workMs);

/** The step down a flight's frames ask for, or null: none (a strong device,
 *  or too short a flight to tell). */
export function judgeFrameTimes(
  samples: readonly FrameSample[],
): { tier: Exclude<DeviceTier, "full">; kind: WeakKind } | null {
  const frames = samples.filter((s) => Number.isFinite(sampleMs(s)) && sampleMs(s) > 0);
  const total = frames.reduce<number>((a, s) => a + sampleMs(s), 0);
  if (frames.length < MIN_FLIGHT_FRAMES || total < MIN_FLIGHT_MS) return null;
  const slow = frames.filter((s) => sampleMs(s) >= SLOW_FRAME_MS);
  const verySlow = slow.filter((s) => sampleMs(s) > VERY_SLOW_FRAME_MS);
  const tier =
    verySlow.length >= MINIMAL_VERY_SLOW_FRAMES
      ? "minimal"
      : slow.length >= LIGHT_SLOW_FRAMES
        ? "light"
        : null;
  if (!tier) return null;
  // The kind, from the slow frames the caller timed (all of them, or not told).
  let kind: WeakKind = "unknown";
  if (slow.every((s) => Number.isFinite(sampleWork(s)))) {
    const work = slow.reduce<number>((a, s) => a + Math.max(0, sampleWork(s) ?? 0), 0);
    const span = slow.reduce<number>((a, s) => a + sampleMs(s), 0);
    kind = work / span >= CPU_SHARE ? "cpu" : "gpu";
  }
  return { tier, kind };
}

const RANK: Record<DeviceTier, number> = { full: 0, light: 1, minimal: 2 };

/** The lower of two steps (null: none); of two at the same tier, the first,
 *  unless only the second says which part is slow. */
export function lowerStep(a: MeasuredStep | null, b: MeasuredStep | null): MeasuredStep | null {
  if (!a || !b) return a ?? b;
  if (RANK[b.tier] > RANK[a.tier]) return b;
  if (RANK[b.tier] === RANK[a.tier] && a.kind === "unknown" && b.kind !== "unknown") return b;
  return a;
}

/** A kept step, read back: null for anything that is not one, or one past its time. */
export function parseStoredStep(raw: string | null | undefined, now: number): MeasuredStep | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MeasuredStep> | null;
    if (!v || (v.tier !== "light" && v.tier !== "minimal")) return null;
    if (v.kind !== "cpu" && v.kind !== "gpu" && v.kind !== "unknown") return null;
    if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
    if (v.at > now || now - v.at > MEASURE_KEPT_MS) return null;
    return { tier: v.tier, kind: v.kind, at: v.at };
  } catch {
    return null;
  }
}

// ---- The decision ------------------------------------------------------------------

/** Everything the decision reads. */
export interface DeviceSignals extends DeviceHints {
  /** The WebGL renderer's name, when somebody gave it. */
  renderer: string | null;
  /** The step down measured (this session's or the kept one). */
  measured: MeasuredStep | null;
}

/** Why a device is not "full". */
export type TierReason =
  "forced" | "memory" | "cores" | "save-data" | "link" | "renderer" | "frames";

export interface TierVerdict {
  tier: DeviceTier;
  /** A slow processor. */
  cpuWeak: boolean;
  /** Slow graphics. */
  gpuWeak: boolean;
  reasons: TierReason[];
}

/** The tier of a device, from its signals and the switch's choice. */
export function decideTier(signals: DeviceSignals, choice: TierChoice = "auto"): TierVerdict {
  if (choice !== "auto") {
    return {
      tier: choice,
      cpuWeak: choice !== "full",
      gpuWeak: choice === "minimal",
      reasons: ["forced"],
    };
  }
  const reasons: TierReason[] = [];
  let tier: DeviceTier = "full";
  let cpuWeak = false;
  let gpuWeak = false;
  const down = (to: DeviceTier, why: TierReason) => {
    if (RANK[to] > RANK[tier]) tier = to;
    reasons.push(why);
  };
  const memory = signals.deviceMemory;
  if (memory !== null && memory <= LOW_MEMORY_GB) {
    cpuWeak = true;
    down("light", "memory");
  }
  // Trusted only beside a reported memory (see the header).
  const cores = signals.hardwareConcurrency;
  if (memory !== null && cores !== null && cores <= FEW_CORES) {
    cpuWeak = true;
    down("light", "cores");
  }
  if (signals.saveData) down("light", "save-data");
  if (signals.effectiveType !== null && SLOW_LINKS.includes(signals.effectiveType)) {
    down("light", "link");
  }
  if (isSoftwareRenderer(signals.renderer)) {
    gpuWeak = true;
    down("minimal", "renderer");
  }
  if (signals.measured) {
    // Not told which part: read as the processor (its remedies lose the least).
    if (signals.measured.kind === "gpu") gpuWeak = true;
    else cpuWeak = true;
    down(signals.measured.tier, "frames");
  }
  return { tier, cpuWeak, gpuWeak, reasons };
}

// ---- This page load ----------------------------------------------------------------

function storedChoice(): TierChoice {
  try {
    const raw = localStorage.getItem("ac:tier");
    return (TIER_CHOICES as readonly string[]).includes(raw ?? "")
      ? (raw as TierChoice)
      : DEFAULT_TIER_CHOICE;
  } catch {
    return DEFAULT_TIER_CHOICE;
  }
}

/** This page load's choice. */
export const tierChoice: TierChoice = __TEST_TOOLS__ ? storedChoice() : DEFAULT_TIER_CHOICE;

/** Another choice: kept, and the page loaded again with it. */
export function setTierChoice(choice: TierChoice) {
  if (!__TEST_TOOLS__ || choice === tierChoice) return;
  try {
    localStorage.setItem("ac:tier", choice);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** The renderer's name, once somebody gave it (undefined: nobody yet). */
let rendererName: string | null | undefined;
/** The step measured in this session, or read from the storage (undefined: not read yet). */
let measured: MeasuredStep | null | undefined;

function measuredNow(): MeasuredStep | null {
  if (measured === undefined) {
    try {
      measured = parseStoredStep(localStorage.getItem(MEASURED_KEY), Date.now());
    } catch {
      measured = null; // storage blocked, or none (a worker, node)
    }
  }
  return measured;
}

/** The renderer's name, from a caller that has a WebGL context: kept for the session. */
export function noteRenderer(name: string | null) {
  rendererName = name;
}

/** The renderer's name read once from a throwaway WebGL context, released at
 *  once; afterwards the name kept. Null where it cannot be read. */
export function probeRenderer(): string | null {
  if (rendererName !== undefined) return rendererName;
  let name: string | null = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const read: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      if (typeof read === "string" && read) name = read;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* no WebGL here */
  }
  rendererName = name;
  return name;
}

/** The signals now. `renderer`: the WebGL renderer's name from a caller that
 *  has a context (kept for the session); left out, the name kept, if any. */
export function deviceSignals(renderer?: string | null): DeviceSignals {
  if (renderer !== undefined) noteRenderer(renderer);
  const nav = typeof navigator === "undefined" ? null : (navigator as NavigatorLike);
  return { ...readHints(nav), renderer: rendererName ?? null, measured: measuredNow() };
}

/** The verdict now: the tier, the two kinds of weak and the reasons. */
export function deviceVerdict(renderer?: string | null): TierVerdict {
  return decideTier(deviceSignals(renderer), tierChoice);
}

/** The device's tier now. */
export function deviceTier(renderer?: string | null): DeviceTier {
  return deviceVerdict(renderer).tier;
}

/** A slow processor (the hints, or the measure). */
export const cpuWeak = (): boolean => deviceVerdict().cpuWeak;
/** Slow graphics (a software renderer, or the measure). */
export const gpuWeak = (): boolean => deviceVerdict().gpuWeak;
/** The visitor asked the browser to save data. */
export const saveData = (): boolean => deviceSignals().saveData;

/** The frame times of the first camera flight, from the map. A step down is
 *  kept for the next visits and applies to this session at once; a step
 *  already as low stays as it is. Returns the step now (null: none). */
export function reportFrameTimes(samples: readonly FrameSample[]): MeasuredStep | null {
  const before = measuredNow();
  const judged = judgeFrameTimes(samples);
  if (!judged) return before;
  const next = lowerStep(before, { ...judged, at: Date.now() });
  if (next !== before && next) {
    measured = next;
    try {
      localStorage.setItem(MEASURED_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: the step lasts for this page */
    }
  }
  return next;
}

/** The measured step forgotten, here and in the storage (the DEV dialog's reset). */
export function forgetMeasuredStep() {
  measured = null;
  try {
    localStorage.removeItem(MEASURED_KEY);
  } catch {
    /* storage blocked: nothing was kept */
  }
}
