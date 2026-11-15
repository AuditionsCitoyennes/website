// The device tier (deviceTier.ts), run with `node --import tsx --test` (root
// "test:scripts"): the hints read from a navigator, an unknown never read as
// weak, the software renderers' names, a flight's frames judged against the
// audit's four profiles, the kept step's validity, the decision and its two
// kinds of weak; then the module's own state under stubbed globals (imported
// under a fresh query each time, its choice being read at load, as
// meshSwitch.test.ts): the switch read only with the testing tools, a step
// kept for the next visit and applied to the session, the reset.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
  navigator?: unknown;
};
g.__TEST_TOOLS__ = false;
const tier = await import("./deviceTier");
const {
  LIGHT_SLOW_FRAMES,
  MEASURE_KEPT_MS,
  MINIMAL_VERY_SLOW_FRAMES,
  SLOW_FRAME_MS,
  decideTier,
  isSoftwareRenderer,
  judgeFrameTimes,
  lowerStep,
  parseStoredStep,
  readHints,
} = tier;
type DeviceSignals = import("./deviceTier").DeviceSignals;
type MeasuredStep = import("./deviceTier").MeasuredStep;

const NONE: DeviceSignals = {
  deviceMemory: null,
  hardwareConcurrency: null,
  saveData: false,
  effectiveType: null,
  renderer: null,
  measured: null,
};
const strong: DeviceSignals = {
  ...NONE,
  deviceMemory: 8,
  hardwareConcurrency: 10,
  effectiveType: "4g",
  renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)",
};

test("the hints are a navigator's own, and what it does not say is unknown", () => {
  assert.deepEqual(readHints(null), {
    deviceMemory: null,
    hardwareConcurrency: null,
    saveData: false,
    effectiveType: null,
  });
  assert.deepEqual(readHints({ hardwareConcurrency: 4 }), {
    deviceMemory: null,
    hardwareConcurrency: 4,
    saveData: false,
    effectiveType: null,
  });
  assert.deepEqual(
    readHints({
      deviceMemory: 2,
      hardwareConcurrency: 8,
      connection: { saveData: true, effectiveType: "3g" },
    }),
    { deviceMemory: 2, hardwareConcurrency: 8, saveData: true, effectiveType: "3g" },
  );
  // Not numbers, not a boolean: unknown, never weak.
  assert.deepEqual(
    readHints({
      deviceMemory: "2",
      hardwareConcurrency: 0,
      connection: { saveData: "on", effectiveType: 3 },
    }),
    { deviceMemory: null, hardwareConcurrency: null, saveData: false, effectiveType: null },
  );
});

test("a software renderer is told by its name", () => {
  for (const name of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "Google SwiftShader",
    "ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)",
    "llvmpipe (LLVM 12.0.0, 256 bits)",
    "softpipe",
    "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "Apple Software Renderer",
    "Software Rasterizer",
    "lavapipe (LLVM 16.0.6)",
  ]) {
    assert.equal(isSoftwareRenderer(name), true, name);
  }
  for (const name of [
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)",
    "Apple GPU",
    "Mali-G52",
    "Adreno (TM) 610",
    "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "PowerVR Rogue GE8320",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isSoftwareRenderer(name), false, String(name));
  }
});

/** A flight of `n` frames at 60 Hz with some of them long. */
const flight = (n: number, long: number[] = []) => [
  ...long,
  ...Array.from({ length: Math.max(0, n - long.length) }, () => 16.7),
];

test("a flight's frames: the audit's profiles land on their tier", () => {
  // Desktop: at most 2 frames over 33 ms, at most 1 over 100 ms.
  assert.equal(judgeFrameTimes(flight(33)), null);
  assert.equal(judgeFrameTimes(flight(33, [100, 50])), null);
  assert.equal(judgeFrameTimes(flight(33, [117, 50, 50])), null);
  // Weak phone: 3 to 9 frames over 33 ms, at most 2 over 100 ms.
  assert.deepEqual(judgeFrameTimes(flight(20, [133, 50, 50, 67])), {
    tier: "light",
    kind: "unknown",
  });
  assert.deepEqual(judgeFrameTimes(flight(20, [183, 150, 50, 50, 67, 50, 50, 50, 50])), {
    tier: "light",
    kind: "unknown",
  });
  // Game Boy and software GL: 3 and more frames over 100 ms.
  assert.deepEqual(judgeFrameTimes(flight(8, [467, 283, 117, 50, 50, 50])), {
    tier: "minimal",
    kind: "unknown",
  });
  assert.deepEqual(judgeFrameTimes(flight(7, [1267, 533, 217, 150])), {
    tier: "minimal",
    kind: "unknown",
  });
});

test("the thresholds are counts of slow frames, exactly", () => {
  const slow = (n: number) => Array.from({ length: n }, () => SLOW_FRAME_MS);
  assert.equal(judgeFrameTimes(flight(30, slow(LIGHT_SLOW_FRAMES - 1))), null);
  assert.equal(judgeFrameTimes(flight(30, slow(LIGHT_SLOW_FRAMES)))?.tier, "light");
  // A display capped at 30 frames a second is not slow.
  assert.equal(judgeFrameTimes(Array.from({ length: 20 }, () => 33.4)), null);
  const very = (n: number) => Array.from({ length: n }, () => 101);
  assert.equal(judgeFrameTimes(flight(30, very(MINIMAL_VERY_SLOW_FRAMES - 1))), null);
  assert.equal(
    judgeFrameTimes(flight(30, [...very(MINIMAL_VERY_SLOW_FRAMES - 1), 50, 50]))?.tier,
    "light",
  );
  assert.equal(judgeFrameTimes(flight(30, very(MINIMAL_VERY_SLOW_FRAMES)))?.tier, "minimal");
  // Exactly 100 ms is slow, not very slow.
  assert.equal(judgeFrameTimes(flight(30, [100, 100, 100, 100]))?.tier, "light");
});

test("too short a report judges nothing, and bad samples are left out", () => {
  assert.equal(judgeFrameTimes([]), null);
  assert.equal(judgeFrameTimes([500, 500, 500, 500]), null); // 4 frames
  assert.equal(judgeFrameTimes([45, 45, 45, 45, 45]), null); // 225 ms
  assert.equal(judgeFrameTimes([50, 50, 50, 50, 50])?.tier, "light");
  assert.equal(judgeFrameTimes([NaN, -5, 0, Infinity, 500, 500, 500, 500]), null);
});

test("the slow part is the processor or the graphics, from the page's own work", () => {
  const frames = (workMs: number) => [
    ...Array.from({ length: 4 }, () => ({ ms: 60, workMs })),
    ...Array.from({ length: 10 }, () => ({ ms: 16.7, workMs: 2 })),
  ];
  assert.deepEqual(judgeFrameTimes(frames(45)), { tier: "light", kind: "cpu" });
  assert.deepEqual(judgeFrameTimes(frames(30)), { tier: "light", kind: "cpu" }); // half
  assert.deepEqual(judgeFrameTimes(frames(8)), { tier: "light", kind: "gpu" });
  // One slow frame not timed: not told.
  const mixed = [...frames(45), 60];
  assert.deepEqual(judgeFrameTimes(mixed), { tier: "light", kind: "unknown" });
});

const step = (t: MeasuredStep["tier"], kind: MeasuredStep["kind"] = "unknown", at = 1000) => ({
  tier: t,
  kind,
  at,
});

test("of two steps the lower stays, and a told kind replaces an untold one", () => {
  assert.equal(lowerStep(null, null), null);
  const light = step("light");
  const minimal = step("minimal");
  assert.equal(lowerStep(light, null), light);
  assert.equal(lowerStep(null, light), light);
  assert.equal(lowerStep(light, minimal), minimal);
  assert.equal(lowerStep(minimal, light), minimal);
  const later = step("light", "unknown", 2000);
  assert.equal(lowerStep(light, later), light);
  const told = step("light", "gpu", 2000);
  assert.equal(lowerStep(light, told), told);
  assert.equal(lowerStep(told, step("light", "cpu", 3000)), told);
});

test("a kept step is read back whole, for 30 days, and anything else is none", () => {
  const now = 1_800_000_000_000;
  const kept = { tier: "light", kind: "cpu", at: now - 1000 };
  assert.deepEqual(parseStoredStep(JSON.stringify(kept), now), kept);
  assert.deepEqual(parseStoredStep(JSON.stringify({ ...kept, more: 1 }), now), kept);
  assert.equal(parseStoredStep(JSON.stringify(kept), now + MEASURE_KEPT_MS), null);
  assert.deepEqual(parseStoredStep(JSON.stringify(kept), now + MEASURE_KEPT_MS - 2000), kept);
  for (const raw of [
    null,
    undefined,
    "",
    "light",
    "{",
    "null",
    "[]",
    JSON.stringify({ ...kept, tier: "full" }),
    JSON.stringify({ ...kept, kind: "ram" }),
    JSON.stringify({ ...kept, at: "yesterday" }),
    JSON.stringify({ ...kept, at: now + 5000 }), // a clock set back
  ]) {
    assert.equal(parseStoredStep(raw, now), null, String(raw));
  }
});

test("auto: a strong or silent device is full", () => {
  assert.deepEqual(decideTier(strong), {
    tier: "full",
    cpuWeak: false,
    gpuWeak: false,
    reasons: [],
  });
  // Safari, Firefox: no hint at all.
  assert.deepEqual(decideTier(NONE), { tier: "full", cpuWeak: false, gpuWeak: false, reasons: [] });
  // 4 GB is an ordinary phone.
  assert.equal(decideTier({ ...strong, deviceMemory: 4 }).tier, "full");
  assert.equal(decideTier({ ...strong, hardwareConcurrency: 4 }).tier, "full");
});

test("auto: each hint alone gives light, and only memory and cores say the processor", () => {
  assert.deepEqual(decideTier({ ...strong, deviceMemory: 2 }), {
    tier: "light",
    cpuWeak: true,
    gpuWeak: false,
    reasons: ["memory"],
  });
  assert.deepEqual(decideTier({ ...strong, deviceMemory: 0.5 }).reasons, ["memory"]);
  assert.deepEqual(decideTier({ ...strong, hardwareConcurrency: 2 }), {
    tier: "light",
    cpuWeak: true,
    gpuWeak: false,
    reasons: ["cores"],
  });
  assert.deepEqual(decideTier({ ...strong, saveData: true }), {
    tier: "light",
    cpuWeak: false,
    gpuWeak: false,
    reasons: ["save-data"],
  });
  for (const link of ["slow-2g", "2g", "3g"]) {
    assert.deepEqual(decideTier({ ...strong, effectiveType: link }), {
      tier: "light",
      cpuWeak: false,
      gpuWeak: false,
      reasons: ["link"],
    });
  }
  assert.deepEqual(
    decideTier({ ...strong, deviceMemory: 1, hardwareConcurrency: 2, saveData: true }).reasons,
    ["memory", "cores", "save-data"],
  );
});

test("auto: a core count without a reported memory is not trusted", () => {
  assert.equal(decideTier({ ...NONE, hardwareConcurrency: 2 }).tier, "full");
  assert.equal(decideTier({ ...NONE, hardwareConcurrency: 1 }).tier, "full");
});

test("auto: a software renderer is minimal, slow graphics", () => {
  assert.deepEqual(decideTier({ ...strong, renderer: "Google SwiftShader" }), {
    tier: "minimal",
    cpuWeak: false,
    gpuWeak: true,
    reasons: ["renderer"],
  });
  assert.deepEqual(
    decideTier({ ...NONE, renderer: "llvmpipe (LLVM 12.0.0, 256 bits)" }).tier,
    "minimal",
  );
  assert.deepEqual(decideTier({ ...strong, deviceMemory: 2, renderer: "Google SwiftShader" }), {
    tier: "minimal",
    cpuWeak: true,
    gpuWeak: true,
    reasons: ["memory", "renderer"],
  });
});

test("auto: a measured step counts, as the processor unless the graphics were told", () => {
  assert.deepEqual(decideTier({ ...NONE, measured: step("light") }), {
    tier: "light",
    cpuWeak: true,
    gpuWeak: false,
    reasons: ["frames"],
  });
  assert.deepEqual(decideTier({ ...NONE, measured: step("minimal", "gpu") }), {
    tier: "minimal",
    cpuWeak: false,
    gpuWeak: true,
    reasons: ["frames"],
  });
  assert.deepEqual(decideTier({ ...strong, saveData: true, measured: step("light", "cpu") }), {
    tier: "light",
    cpuWeak: true,
    gpuWeak: false,
    reasons: ["save-data", "frames"],
  });
  // A measured light never lifts a software renderer's minimal.
  assert.equal(
    decideTier({ ...strong, renderer: "Google SwiftShader", measured: step("light") }).tier,
    "minimal",
  );
});

test("a forced tier ignores the signals: light is a slow processor, minimal both", () => {
  const weak = {
    ...strong,
    deviceMemory: 1,
    renderer: "Google SwiftShader",
    measured: step("minimal"),
  };
  assert.deepEqual(decideTier(weak, "full"), {
    tier: "full",
    cpuWeak: false,
    gpuWeak: false,
    reasons: ["forced"],
  });
  assert.deepEqual(decideTier(strong, "light"), {
    tier: "light",
    cpuWeak: true,
    gpuWeak: false,
    reasons: ["forced"],
  });
  assert.deepEqual(decideTier(strong, "minimal"), {
    tier: "minimal",
    cpuWeak: true,
    gpuWeak: true,
    reasons: ["forced"],
  });
});

// ---- The module's own state, under stubbed globals -----------------------------------

function storage(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  let reads = 0;
  return {
    kept,
    reads: () => reads,
    getItem(k: string) {
      reads++;
      return kept.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      kept.set(k, v);
    },
    removeItem(k: string) {
      kept.delete(k);
    },
  };
}

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./deviceTier.ts?load=${++n}`)) as typeof import("./deviceTier");
}
function setNavigator(nav: unknown) {
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
}

test("the switch: unread without the testing tools, kept and checked with them", async () => {
  const s = storage({ "ac:tier": "minimal" });
  g.localStorage = s;
  setNavigator({ deviceMemory: 8, hardwareConcurrency: 8 });
  const prod = await load(false);
  assert.equal(prod.tierChoice, "auto");
  assert.equal(prod.DEFAULT_TIER_CHOICE, "auto");
  assert.equal(s.reads(), 0);
  assert.equal(prod.deviceTier(), "full");

  const dev = await load(true);
  assert.equal(dev.tierChoice, "minimal");
  assert.deepEqual(dev.deviceVerdict(), {
    tier: "minimal",
    cpuWeak: true,
    gpuWeak: true,
    reasons: ["forced"],
  });
  g.localStorage = storage({ "ac:tier": "tiny" });
  assert.equal((await load(true)).tierChoice, "auto");
  g.localStorage = {
    getItem() {
      throw new Error("blocked");
    },
  };
  const blocked = await load(true);
  assert.equal(blocked.tierChoice, "auto");
  assert.equal(blocked.deviceTier(), "full"); // the kept step unreadable too: none
});

test("the session: the navigator's hints, the renderer once given, save-data", async () => {
  g.localStorage = storage();
  setNavigator({ deviceMemory: 2, hardwareConcurrency: 8, connection: { saveData: true } });
  const m = await load(false);
  assert.equal(m.deviceTier(), "light");
  assert.equal(m.cpuWeak(), true);
  assert.equal(m.gpuWeak(), false);
  assert.equal(m.saveData(), true);
  assert.deepEqual(m.deviceVerdict().reasons, ["memory", "save-data"]);
  // A caller with a context gives the name: kept for the calls after it.
  assert.equal(m.deviceTier("Google SwiftShader"), "minimal");
  assert.equal(m.deviceTier(), "minimal");
  assert.equal(m.gpuWeak(), true);
  assert.equal(m.deviceSignals().renderer, "Google SwiftShader");
  // The probe answers the name kept, without a document.
  assert.equal(m.probeRenderer(), "Google SwiftShader");
  m.noteRenderer(null);
  assert.equal(m.deviceTier(), "light");
});

test("the probe without a document answers null, once", async () => {
  g.localStorage = storage();
  setNavigator({});
  const m = await load(false);
  assert.equal(m.probeRenderer(), null);
  assert.equal(m.deviceSignals().renderer, null);
  assert.equal(m.deviceTier(), "full");
});

test("a slow first flight steps down at once and is kept for the next visit", async () => {
  const s = storage();
  g.localStorage = s;
  setNavigator({}); // an iPhone: no hint
  const m = await load(false);
  assert.equal(m.deviceTier(), "full");
  assert.equal(m.reportFrameTimes(flight(33, [100, 50])), null); // a fine flight
  assert.equal(m.deviceTier(), "full");
  assert.equal(s.kept.size, 0);

  const stepped = m.reportFrameTimes(flight(20, [133, 50, 50, 67]));
  assert.equal(stepped?.tier, "light");
  assert.equal(m.deviceTier(), "light");
  assert.equal(m.cpuWeak(), true);
  const kept = JSON.parse(s.kept.get("ac:tier-measured")!) as MeasuredStep;
  assert.deepEqual({ tier: kept.tier, kind: kept.kind }, { tier: "light", kind: "unknown" });

  // A fine flight afterwards lifts nothing; a worse one steps further.
  assert.equal(m.reportFrameTimes(flight(33))?.tier, "light");
  assert.equal(m.reportFrameTimes(flight(8, [467, 283, 117, 50]))?.tier, "minimal");
  assert.equal(m.deviceTier(), "minimal");

  // The next visit reads it; the reset forgets it.
  const next = await load(false);
  assert.equal(next.deviceTier(), "minimal");
  assert.deepEqual(next.deviceVerdict().reasons, ["frames"]);
  next.forgetMeasuredStep();
  assert.equal(next.deviceTier(), "full");
  assert.equal(s.kept.has("ac:tier-measured"), false);
  assert.equal((await load(false)).deviceTier(), "full");
});

test("a step measured with the storage blocked lasts for the page", async () => {
  g.localStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  setNavigator({});
  const m = await load(false);
  assert.equal(m.reportFrameTimes(flight(20, [133, 50, 50, 67]))?.tier, "light");
  assert.equal(m.deviceTier(), "light");
  m.forgetMeasuredStep();
  assert.equal(m.deviceTier(), "full");
});
