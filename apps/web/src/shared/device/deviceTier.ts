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
//   below the device steps down for this page load at once, and the slow
//   flight is noted in localStorage (`ac:tier-measured`). The step is kept
//   for the next visits, 30 days, only at the second strike: another page
//   load, started at least a minute after the note, measuring slow again. A
//   flight that is not slow forgets the note. One bad moment (a phone busy
//   with something else) therefore costs one page load, not a month
//   (`strikeRule`).
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
/** A kept step is read for this long, then the device is judged again; a
 *  note waits as long for its second strike. */
export const MEASURE_KEPT_MS = 30 * 24 * 3600 * 1000;
/** The second strike is another page load, started at least this long after
 *  the first slow flight was noted: the same bad moment is not counted twice. */
export const SECOND_STRIKE_GAP_MS = 60_000;

const MEASURED_KEY = "ac:tier-measured";

const sampleMs = (s: FrameSample) => (typeof s === "number" ? s : s.ms);
const sampleWork = (s: FrameSample) => (typeof s === "number" ? undefined : s.workMs);

/** The frames that count: timed, and longer than nothing. */
const timedFrames = (samples: readonly FrameSample[]) =>
  samples.filter((s) => Number.isFinite(sampleMs(s)) && sampleMs(s) > 0);

/** Whether a flight's frames are enough to judge a device by (a shorter
 *  flight says neither slow nor fine). */
export function framesTell(samples: readonly FrameSample[]): boolean {
  const frames = timedFrames(samples);
  const total = frames.reduce<number>((a, s) => a + sampleMs(s), 0);
  return frames.length >= MIN_FLIGHT_FRAMES && total >= MIN_FLIGHT_MS;
}

/** The step down a flight's frames ask for, or null: none (a strong device,
 *  or too short a flight to tell). */
export function judgeFrameTimes(
  samples: readonly FrameSample[],
): { tier: Exclude<DeviceTier, "full">; kind: WeakKind } | null {
  if (!framesTell(samples)) return null;
  const frames = timedFrames(samples);
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

/** A step as stored: null for anything that is not one, or one past its time. */
function validStep(v: unknown, now: number): MeasuredStep | null {
  if (!v || typeof v !== "object") return null;
  const { tier, kind, at } = v as Partial<MeasuredStep>;
  if (tier !== "light" && tier !== "minimal") return null;
  if (kind !== "cpu" && kind !== "gpu" && kind !== "unknown") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (at > now || now - at > MEASURE_KEPT_MS) return null;
  return { tier, kind, at };
}

/** A kept step, read back: null for anything that is not one, or one past its time. */
export function parseStoredStep(raw: string | null | undefined, now: number): MeasuredStep | null {
  return parseStoredRecord(raw, now).step;
}

/** What the browser keeps of the measure: the step kept (two page loads
 *  measured slow) and the note of one slow flight, waiting for its second
 *  strike. Stored as the step's own fields, the note beside them (`note`). */
export interface MeasureRecord {
  step: MeasuredStep | null;
  note: MeasuredStep | null;
}

/** The record read back; whatever is not valid, or past its time, is null. */
export function parseStoredRecord(raw: string | null | undefined, now: number): MeasureRecord {
  if (!raw) return { step: null, note: null };
  try {
    const v: unknown = JSON.parse(raw);
    const note = v && typeof v === "object" ? (v as { note?: unknown }).note : null;
    return { step: validStep(v, now), note: validStep(note, now) };
  } catch {
    return { step: null, note: null };
  }
}

/** The record as stored; null: nothing to keep. */
export function storedRecord(record: MeasureRecord): string | null {
  if (!record.step && !record.note) return null;
  return JSON.stringify({ ...record.step, ...(record.note ? { note: record.note } : {}) });
}

/**
 * The two strikes. A flight that told something was measured at `now`, in a
 * page load started at `loadStart`; `judged` is the step its frames ask for
 * (null: the flight was not slow). Returns the step this page load stands at
 * (`session`) and what the browser keeps.
 *
 * - Not slow: the note, if any, is forgotten. A step already kept stays (a
 *   lighter page is expected to fly well).
 * - Slow, but no lower than the step kept: nothing new, and a note asking
 *   for more is forgotten (this flight did not confirm it).
 * - Slow, with no note yet, or a note younger than SECOND_STRIKE_GAP_MS at
 *   this page load's start (the same page load, or one right after it): the
 *   page load steps down; the first note stays as it is, or this one is noted.
 * - Slow, with a note old enough: the second strike. The milder of the two
 *   steps is kept (both page loads agree on that much), the note is used up.
 */
export function strikeRule(
  record: MeasureRecord,
  judged: { tier: Exclude<DeviceTier, "full">; kind: WeakKind } | null,
  at: { now: number; loadStart: number },
): { session: MeasuredStep | null; record: MeasureRecord } {
  const { step, note } = record;
  const noteless = note ? { step, note: null } : record;
  if (!judged) return { session: step, record: noteless };
  const measured: MeasuredStep = { ...judged, at: at.now };
  const session = lowerStep(step, measured);
  if (session === step) return { session, record: noteless };
  if (!note || at.loadStart - note.at < SECOND_STRIKE_GAP_MS) {
    return { session, record: { step, note: note ?? measured } };
  }
  const milder = RANK[note.tier] < RANK[judged.tier] ? note : judged;
  // Which part is slow: this flight's word, else the note's.
  const kind =
    milder.kind === "unknown" && note.tier === judged.tier
      ? judged.kind !== "unknown"
        ? judged.kind
        : note.kind
      : milder.kind;
  return {
    session,
    record: { step: lowerStep(step, { tier: milder.tier, kind, at: at.now }), note: null },
  };
}

// ---- The decision ------------------------------------------------------------------

/** Everything the decision reads. */
export interface DeviceSignals extends DeviceHints {
  /** The WebGL renderer's name, when somebody gave it. */
  renderer: string | null;
  /** The step down measured (this page load's or the kept one). */
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
/** The step this page load stands at: the one measured in it, or the one
 *  kept in the storage (undefined: not read yet). */
let measured: MeasuredStep | null | undefined;
/** When this page load started (ms since the epoch): what the second strike
 *  is counted from. */
const LOAD_START =
  typeof performance !== "undefined" && performance.timeOrigin > 0
    ? performance.timeOrigin
    : Date.now();

/** What the storage keeps of the measure now (the DEV dialog shows it). */
export function measureRecord(now: number = Date.now()): MeasureRecord {
  try {
    return parseStoredRecord(localStorage.getItem(MEASURED_KEY), now);
  } catch {
    return { step: null, note: null }; // storage blocked, or none (a worker, node)
  }
}

function measuredNow(): MeasuredStep | null {
  if (measured === undefined) measured = measureRecord().step;
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

/** The frame times of the first camera flight, from the map. A slow flight
 *  steps this page load down at once; the step is kept for the next visits
 *  only at the second strike (`strikeRule`), and a flight that is not slow
 *  forgets a first strike. A flight too short to judge changes nothing.
 *  Returns the step this page load stands at (null: none). `clock`: for the
 *  tests. */
export function reportFrameTimes(
  samples: readonly FrameSample[],
  clock: { now: number; loadStart: number } = { now: Date.now(), loadStart: LOAD_START },
): MeasuredStep | null {
  const before = measuredNow();
  if (!framesTell(samples)) return before;
  const kept = measureRecord(clock.now);
  const out = strikeRule(kept, judgeFrameTimes(samples), clock);
  measured = lowerStep(before, out.session);
  if (out.record !== kept) {
    try {
      const raw = storedRecord(out.record);
      if (raw === null) localStorage.removeItem(MEASURED_KEY);
      else localStorage.setItem(MEASURED_KEY, raw);
    } catch {
      /* storage blocked: the step lasts for this page */
    }
  }
  return measured;
}

/** The measured step and the note forgotten, here and in the storage (the DEV dialog's reset). */
export function forgetMeasuredStep() {
  measured = null;
  try {
    localStorage.removeItem(MEASURED_KEY);
  } catch {
    /* storage blocked: nothing was kept */
  }
}
