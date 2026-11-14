// The device tier (deviceTier.ts), run with `node --import tsx --test` (root
// "test:scripts"): the hints read from a navigator, an unknown never read as
// weak, the software renderers' names, a flight's frames judged against the
// audit's four profiles, the kept step's validity, the decision and its two
// kinds of weak; then the module's own state under stubbed globals (imported
// under a fresh query each time, its choice being read at load, as
// meshSwitch.test.ts): the switch read only with the testing tools, a slow
// flight stepping its page load down and noted, the step kept at the second
// strike (strikeRule), the reset.

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
  SECOND_STRIKE_GAP_MS,
  lowerStep,
  parseStoredRecord,
  parseStoredStep,
  readHints,
  storedRecord,
  strikeRule,
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

test("the record: a kept step, a note, both or neither, each valid for itself", () => {
  const now = 1_800_000_000_000;
  const kept = { tier: "light", kind: "cpu", at: now - 5000 } as const;
  const note = { tier: "minimal", kind: "gpu", at: now - 1000 } as const;
  const NONE_KEPT = { step: null, note: null };
  assert.deepEqual(parseStoredRecord(null, now), NONE_KEPT);
  assert.deepEqual(parseStoredRecord("{", now), NONE_KEPT);
  assert.deepEqual(parseStoredRecord(JSON.stringify(kept), now), { step: kept, note: null });
  assert.deepEqual(parseStoredRecord(JSON.stringify({ note }), now), { step: null, note });
  assert.deepEqual(parseStoredRecord(JSON.stringify({ ...kept, note }), now), { step: kept, note });
  // A note alone is not a step; a note past its time or malformed is none.
  assert.equal(parseStoredStep(JSON.stringify({ note }), now), null);
  assert.deepEqual(parseStoredRecord(JSON.stringify({ note }), now + MEASURE_KEPT_MS), NONE_KEPT);
  assert.deepEqual(parseStoredRecord(JSON.stringify({ ...kept, note: "light" }), now), {
    step: kept,
    note: null,
  });
  assert.deepEqual(parseStoredRecord(JSON.stringify({ note: { ...note, at: now + 9 } }), now), {
    step: null,
    note: null,
  });
  // Written and read back.
  assert.equal(storedRecord(NONE_KEPT), null);
  for (const record of [
    { step: kept, note: null },
    { step: null, note },
    { step: kept, note },
  ]) {
    assert.deepEqual(parseStoredRecord(storedRecord(record), now), record);
  }
});

test("two strikes: the rule", () => {
  const t0 = 1_800_000_000_000;
  const GAP = SECOND_STRIKE_GAP_MS;
  const EMPTY = { step: null, note: null };
  const light = { tier: "light", kind: "unknown" } as const;
  const lightCpu = { tier: "light", kind: "cpu" } as const;
  const minimal = { tier: "minimal", kind: "gpu" } as const;
  const at = (now: number, loadStart = now - 3000) => ({ now, loadStart });

  // A fine flight on a clean record: nothing, the very same record.
  const fine = strikeRule(EMPTY, null, at(t0));
  assert.equal(fine.session, null);
  assert.equal(fine.record, EMPTY);

  // First strike: down for the page, noted, nothing kept.
  const one = strikeRule(EMPTY, light, at(t0));
  assert.deepEqual(one.session, { ...light, at: t0 });
  assert.deepEqual(one.record, { step: null, note: { ...light, at: t0 } });

  // Slow again in a page load started under a minute after the note (the
  // same one, or a reload): down for the page, the first note as it was.
  for (const loadStart of [t0 - 3000, t0 + 1000, t0 + GAP - 1]) {
    const again = strikeRule(one.record, light, { now: loadStart + 5000, loadStart });
    assert.deepEqual(again.session, { ...light, at: loadStart + 5000 });
    assert.deepEqual(again.record, one.record, String(loadStart - t0));
  }

  // Second strike: a page load started a minute after the note, slow again.
  const two = strikeRule(one.record, lightCpu, { now: t0 + GAP + 4000, loadStart: t0 + GAP });
  assert.deepEqual(two.session, { ...lightCpu, at: t0 + GAP + 4000 });
  assert.deepEqual(two.record, { step: { ...lightCpu, at: t0 + GAP + 4000 }, note: null });
  // …which part is slow: this flight's word, else the note's.
  const noteTold = { step: null, note: { ...lightCpu, at: t0 } };
  assert.equal(strikeRule(noteTold, light, at(t0 + GAP + 4000)).record.step?.kind, "cpu");

  // A fine flight in between forgets the note: the next slow one is a first strike.
  const forgot = strikeRule(one.record, null, at(t0 + GAP + 4000));
  assert.equal(forgot.session, null);
  assert.deepEqual(forgot.record, EMPTY);
  assert.deepEqual(strikeRule(forgot.record, light, at(t0 + 3 * GAP)).record, {
    step: null,
    note: { ...light, at: t0 + 3 * GAP },
  });

  // The two strikes disagree: the milder is kept, the page stands at what it measured.
  const mixed = strikeRule(one.record, minimal, at(t0 + 2 * GAP));
  assert.equal(mixed.session?.tier, "minimal");
  assert.deepEqual(mixed.record, { step: { ...light, at: t0 + 2 * GAP }, note: null });
  const noteMinimal = { step: null, note: { ...minimal, at: t0 } };
  const mixed2 = strikeRule(noteMinimal, lightCpu, at(t0 + 2 * GAP));
  assert.deepEqual(mixed2.record, { step: { ...lightCpu, at: t0 + 2 * GAP }, note: null });

  // A step already kept: a fine flight keeps it, a flight no lower changes
  // nothing, a lower one takes its own two strikes.
  const kept = { step: { ...light, at: t0 }, note: null };
  assert.equal(strikeRule(kept, null, at(t0 + GAP)).record, kept);
  const same = strikeRule(kept, light, at(t0 + GAP));
  assert.equal(same.session, kept.step);
  assert.equal(same.record, kept);
  const lower1 = strikeRule(kept, minimal, at(t0 + GAP));
  assert.equal(lower1.session?.tier, "minimal");
  assert.deepEqual(lower1.record, { step: kept.step, note: { ...minimal, at: t0 + GAP } });
  // …that note forgotten by a flight that is slow but no lower than the kept step…
  assert.deepEqual(strikeRule(lower1.record, light, at(t0 + 3 * GAP)).record, kept);
  // …or confirmed.
  const lower2 = strikeRule(lower1.record, minimal, at(t0 + 3 * GAP));
  assert.deepEqual(lower2.record, { step: { ...minimal, at: t0 + 3 * GAP }, note: null });
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

test("a slow first flight steps this page load down, and is only noted", async () => {
  const s = storage();
  g.localStorage = s;
  setNavigator({}); // an iPhone: no hint
  // In the past of the real clock: the module reads the kept step at Date.now().
  const t0 = Date.now() - 3_600_000;
  const m = await load(false);
  assert.equal(m.deviceTier(), "full");
  assert.equal(m.reportFrameTimes(flight(33, [100, 50]), { now: t0, loadStart: t0 - 5000 }), null);
  assert.equal(m.deviceTier(), "full"); // a fine flight
  assert.equal(s.kept.size, 0);

  const stepped = m.reportFrameTimes(flight(20, [133, 50, 50, 67]), {
    now: t0,
    loadStart: t0 - 5000,
  });
  assert.equal(stepped?.tier, "light");
  assert.equal(m.deviceTier(), "light");
  assert.equal(m.cpuWeak(), true);
  assert.deepEqual(JSON.parse(s.kept.get("ac:tier-measured")!), {
    note: { tier: "light", kind: "unknown", at: t0 },
  });
  assert.deepEqual(m.measureRecord(t0), {
    step: null,
    note: { tier: "light", kind: "unknown", at: t0 },
  });

  // A fine flight afterwards lifts nothing in this page load; a worse one steps further.
  const sameLoad = { now: t0 + 2000, loadStart: t0 - 5000 };
  assert.equal(m.reportFrameTimes(flight(33), sameLoad)?.tier, "light");
  assert.equal(s.kept.has("ac:tier-measured"), false, "…but it forgets the note");
  assert.equal(m.reportFrameTimes(flight(8, [467, 283, 117, 50]), sameLoad)?.tier, "minimal");
  assert.equal(m.deviceTier(), "minimal");
  assert.deepEqual(JSON.parse(s.kept.get("ac:tier-measured")!), {
    note: { tier: "minimal", kind: "unknown", at: t0 + 2000 },
  });

  // The next page load starts from the full tier: nothing was kept.
  const next = await load(false);
  assert.equal(next.deviceTier(), "full");
  assert.deepEqual(next.deviceVerdict().reasons, []);
});

test("the second strike keeps the step; a fine flight in between forgets the note", async () => {
  const s = storage();
  g.localStorage = s;
  setNavigator({});
  // In the past of the real clock: the module reads the kept step at Date.now().
  const t0 = Date.now() - 3_600_000;
  const slow = flight(20, [133, 50, 50, 67]);
  const MIN = 60_000;

  // First page load: slow, noted.
  const first = await load(false);
  first.reportFrameTimes(slow, { now: t0, loadStart: t0 - 4000 });
  // A reload right away (started 30 s after the note), slow again: the same
  // bad moment. Down for the page, nothing kept, the first note as it was.
  const soon = await load(false);
  assert.equal(soon.deviceTier(), "full");
  assert.equal(
    soon.reportFrameTimes(slow, { now: t0 + 40_000, loadStart: t0 + 30_000 })?.tier,
    "light",
  );
  assert.deepEqual(soon.measureRecord(t0 + 40_000), {
    step: null,
    note: { tier: "light", kind: "unknown", at: t0 },
  });
  // A page load started a minute after the note, slow again: kept.
  const second = await load(false);
  assert.equal(second.deviceTier(), "full");
  assert.equal(
    second.reportFrameTimes(slow, { now: t0 + MIN + 9000, loadStart: t0 + MIN })?.tier,
    "light",
  );
  assert.deepEqual(JSON.parse(s.kept.get("ac:tier-measured")!), {
    tier: "light",
    kind: "unknown",
    at: t0 + MIN + 9000,
  });
  // The visits after it start light, with the reason; a fine flight there lifts nothing.
  const third = await load(false);
  assert.equal(third.deviceTier(), "light");
  assert.deepEqual(third.deviceVerdict().reasons, ["frames"]);
  assert.equal(third.reportFrameTimes(flight(33))?.tier, "light");
  assert.equal(s.kept.has("ac:tier-measured"), true);
  // The reset forgets it.
  third.forgetMeasuredStep();
  assert.equal(third.deviceTier(), "full");
  assert.equal(s.kept.has("ac:tier-measured"), false);

  // Again from nothing: slow, then a fine page load, then slow — the note
  // was forgotten in between, so the third page load is a first strike.
  const a = await load(false);
  a.reportFrameTimes(slow, { now: t0, loadStart: t0 - 4000 });
  assert.equal(s.kept.has("ac:tier-measured"), true);
  const b2 = await load(false);
  assert.equal(
    b2.reportFrameTimes(flight(33), { now: t0 + 2 * MIN, loadStart: t0 + 2 * MIN }),
    null,
  );
  assert.equal(s.kept.has("ac:tier-measured"), false, "the note is forgotten");
  const c = await load(false);
  assert.equal(
    c.reportFrameTimes(slow, { now: t0 + 4 * MIN, loadStart: t0 + 4 * MIN })?.tier,
    "light",
  );
  assert.deepEqual(c.measureRecord(t0 + 4 * MIN), {
    step: null,
    note: { tier: "light", kind: "unknown", at: t0 + 4 * MIN },
  });
  assert.equal((await load(false)).deviceTier(), "full");

  // A flight too short to judge is neither a strike nor a fine flight.
  const d = await load(false);
  assert.equal(
    d.reportFrameTimes([200, 200], { now: t0 + 6 * MIN, loadStart: t0 + 6 * MIN }),
    null,
  );
  assert.equal(d.reportFrameTimes(flight(4), { now: t0 + 6 * MIN, loadStart: t0 + 6 * MIN }), null);
  assert.equal(s.kept.has("ac:tier-measured"), true, "the note stays");
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
