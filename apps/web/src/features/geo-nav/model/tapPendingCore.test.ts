// The pending state of a tapped territory (tapPendingCore.ts): when it
// begins, each way it ends (its plateau commits, the scope moves without a
// tap, nothing will rise, a newer tap, the safety cap), what the map and the
// screen reader are told, and the frame the mark may get to itself. Fake
// map, fake timers. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWN_FRAME_CAP_MS,
  PENDING_CAP_MS,
  createTapFrame,
  createTapPending,
  readySentence,
  type PendingUnit,
} from "./tapPendingCore";

const RHONE: PendingUnit = { id: "fr:dep:69", label: "Rhône", count: 152 };
const ISERE: PendingUnit = { id: "fr:dep:38", label: "Isère", count: 15 };

/** Timers by hand: `run(ms)` moves the clock and fires what is due. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    live: () => timers.size,
    run(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now && timers.delete(id)) t.fn();
      }
    },
  };
}

function harness(opts: { off?: boolean } = {}) {
  const clock = fakeTimers();
  const log: string[] = [];
  const s = { scope: "fr:reg:84", micro: false, busy: null as string | null, said: "" };
  const core = createTapPending({
    mark: (unit) => {
      if (opts.off) return false;
      log.push(`mark ${unit.id}`);
      return true;
    },
    unmark: (how) => log.push(`unmark ${how}`),
    scopeId: () => s.scope,
    inMicroZone: () => s.micro,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: (unit) => (s.busy = unit?.id ?? null),
    say: (text) => (s.said = text),
    onEnd: (unit, end, heldMs) => log.push(`end ${unit.id} ${end} ${heldMs}`),
    now: clock.now,
  });
  /** The selection written, as the page's sync watcher reports it. */
  const writeScope = (id: string) => {
    s.scope = id;
    core.scopeChanged(id);
  };
  return { core, clock, log, s, writeScope };
}

test("a tap marks the unit, and its plateau's commit ends it: the mark fades as it rises", () => {
  const { core, clock, log, s, writeScope } = harness();
  assert.equal(core.begin(RHONE), true);
  assert.deepEqual(log, ["mark fr:dep:69"]);
  assert.equal(s.busy, "fr:dep:69");
  assert.equal(core.pending()?.id, "fr:dep:69");
  writeScope("fr:dep:69");
  clock.run(240);
  core.settled("fr:dep:69", "rise");
  assert.deepEqual(log.slice(1), ["end fr:dep:69 risen 240", "unmark rise"]);
  assert.equal(s.busy, null);
  assert.equal(s.said, "Rhône affiché sur la carte : 152 témoignages.");
  assert.equal(core.pending(), null);
  assert.equal(clock.live(), 0); // the safety timer is gone
});

test("a unit standing already or refined in place is ready too", () => {
  for (const how of ["same", "quiet"] as const) {
    const { core, log, writeScope } = harness();
    core.begin(RHONE);
    writeScope("fr:dep:69");
    core.settled("fr:dep:69", how);
    assert.equal(log.at(-1), "unmark rise", how);
  }
});

test("a cold tap holds: nothing ends the state until a verdict comes", () => {
  const { core, clock, log, s, writeScope } = harness();
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(1200);
  assert.equal(s.busy, "fr:dep:69");
  assert.deepEqual(log, ["mark fr:dep:69"]);
  core.settled("fr:dep:69", "rise");
  assert.equal(log.at(-1), "unmark rise");
});

test("the last tap wins: the newer mark replaces the older, which says nothing", () => {
  const { core, log, s, writeScope } = harness();
  core.begin(ISERE);
  writeScope("fr:dep:38");
  core.begin(RHONE);
  assert.deepEqual(log, ["mark fr:dep:38", "end fr:dep:38 replaced 0", "mark fr:dep:69"]);
  assert.equal(s.busy, "fr:dep:69");
  // The older unit's plateau landing late is not this one's.
  core.settled("fr:dep:38", "rise");
  assert.equal(s.busy, "fr:dep:69");
  writeScope("fr:dep:69");
  core.settled("fr:dep:69", "rise");
  assert.equal(s.said, readySentence(RHONE));
});

test("a pan that leaves the scope alone ends nothing; a scope gone elsewhere does, at once", () => {
  const { core, log, s, writeScope } = harness();
  core.begin(RHONE);
  writeScope("fr:dep:69");
  core.scopeChanged("fr:dep:69"); // a view that confirms the scope
  assert.equal(s.busy, "fr:dep:69");
  writeScope("fr:reg:84"); // a zoom out changed it
  assert.deepEqual(log.slice(1), ["end fr:dep:69 moved 0", "unmark off"]);
  assert.equal(s.busy, null);
  assert.equal(s.said, ""); // nothing is said of a unit that did not rise
});

test("nothing rises for the unit: the mark goes at once, nothing is said", () => {
  for (const how of ["cleared", "failed"] as const) {
    const { core, log, s, writeScope } = harness();
    core.begin(RHONE);
    writeScope("fr:dep:69");
    core.settled(how === "cleared" ? "" : "fr:dep:69", how);
    assert.deepEqual(log.slice(1), ["end fr:dep:69 none 0", "unmark off"], how);
    assert.equal(s.said, "");
  }
});

test("deep among the lieux a clear says nothing of the unit yet", () => {
  const { core, s, log, writeScope } = harness();
  s.micro = true;
  core.begin(RHONE);
  writeScope("fr:dep:69");
  core.settled("", "cleared");
  assert.equal(s.busy, "fr:dep:69");
  s.micro = false;
  core.settled("fr:dep:69", "rise");
  assert.equal(log.at(-1), "unmark rise");
});

test("a failure of another unit's run is not this one's", () => {
  const { core, s, writeScope } = harness();
  core.begin(RHONE);
  writeScope("fr:dep:69");
  core.settled("fr:dep:38", "failed");
  assert.equal(s.busy, "fr:dep:69");
});

test("the mark in a frame of its own: what the map says before the scope is written is ignored", () => {
  const { core, log, s, writeScope } = harness();
  core.begin(RHONE); // the scope is still the région
  core.settled("fr:reg:84", "rise"); // the unit being left, still landing
  core.settled("", "cleared");
  core.scopeChanged("FR"); // a view-derived scope in that frame
  assert.equal(s.busy, "fr:dep:69");
  assert.deepEqual(log, ["mark fr:dep:69"]);
  writeScope("fr:dep:69");
  core.settled("fr:dep:69", "rise");
  assert.equal(log.at(-1), "unmark rise");
});

test("a selection that will not be written is abandoned: the mark goes", () => {
  const { core, log, s } = harness();
  core.begin(RHONE);
  core.abandon();
  assert.deepEqual(log.slice(1), ["end fr:dep:69 moved 0", "unmark off"]);
  assert.equal(s.busy, null);
});

test("a tap on the unit already in scope is pending from the start", () => {
  const { core, s } = harness();
  s.scope = "fr:dep:69";
  core.begin(RHONE);
  core.settled("fr:dep:69", "same");
  assert.equal(s.busy, null);
});

test("no verdict within the cap: the mark goes, nothing is said", () => {
  const { core, clock, log, s, writeScope } = harness();
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(PENDING_CAP_MS - 1);
  assert.equal(s.busy, "fr:dep:69");
  clock.run(1);
  assert.deepEqual(log.slice(1), [`end fr:dep:69 timeout ${PENDING_CAP_MS}`, "unmark off"]);
  assert.equal(s.busy, null);
  assert.equal(s.said, "");
  // A verdict after it changes nothing.
  core.settled("fr:dep:69", "rise");
  assert.equal(log.length, 3);
});

test("switched off: no state, no mark, nothing busy — and a mark left by the tap before goes", () => {
  const off = harness({ off: true });
  assert.equal(off.core.begin(RHONE), false);
  assert.deepEqual(off.log, []);
  assert.equal(off.s.busy, null);
  assert.equal(off.clock.live(), 0);
  // On, a tap; then off (the switch is live), another tap.
  let on = true;
  const clock = fakeTimers();
  const log: string[] = [];
  const core = createTapPending({
    mark: (u) => (on ? (log.push(`mark ${u.id}`), true) : false),
    unmark: (how) => log.push(`unmark ${how}`),
    scopeId: () => "x",
    inMicroZone: () => false,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: () => {},
    say: () => {},
    now: clock.now,
  });
  core.begin(ISERE);
  on = false;
  assert.equal(core.begin(RHONE), false);
  assert.deepEqual(log, ["mark fr:dep:38", "unmark off"]);
  assert.equal(clock.live(), 0);
});

test("the same territory twice is said twice: the sentence is cleared at each tap", () => {
  const { core, s, writeScope } = harness();
  core.begin(RHONE);
  writeScope("fr:dep:69");
  core.settled("fr:dep:69", "rise");
  assert.notEqual(s.said, "");
  writeScope("fr:reg:84");
  core.begin(RHONE);
  assert.equal(s.said, "");
});

test("dispose drops the state and its timer without touching the map", () => {
  const { core, clock, log } = harness();
  core.begin(RHONE);
  core.dispose();
  assert.equal(clock.live(), 0);
  assert.deepEqual(log, ["mark fr:dep:69"]);
  assert.equal(core.pending(), null);
});

test("the sentence: the name, then its testimonies, in French", () => {
  assert.equal(readySentence(RHONE), "Rhône affiché sur la carte : 152 témoignages.");
  assert.equal(
    readySentence({ id: "x", label: "Cantal", count: 1 }),
    "Cantal affiché sur la carte : 1 témoignage.",
  );
  assert.equal(
    readySentence({ id: "x", label: "Guyane", count: 0 }),
    "Guyane affiché sur la carte : aucun témoignage.",
  );
});

// ---- the frame the mark gets to itself -----------------------------------------

function frameHarness() {
  const clock = fakeTimers();
  const paints: (() => void)[] = [];
  const frame = createTapFrame({
    afterPaint: (fn) => paints.push(fn),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  /** A frame is painted: every callback waiting for it runs. */
  const paint = () => paints.splice(0).forEach((fn) => fn());
  return { frame, clock, paint };
}

test("the selection is written once the mark's frame is painted, once", () => {
  const { frame, clock, paint } = frameHarness();
  const ran: string[] = [];
  frame.after(() => ran.push("a"));
  assert.deepEqual(ran, []);
  assert.equal(frame.waiting(), true);
  paint();
  assert.deepEqual(ran, ["a"]);
  assert.equal(frame.waiting(), false);
  assert.equal(clock.live(), 0);
  clock.run(OWN_FRAME_CAP_MS * 2); // the cap's timer was cleared
  paint();
  assert.deepEqual(ran, ["a"]);
});

test("no frame painted (a hidden tab): written at the cap", () => {
  const { frame, clock, paint } = frameHarness();
  const ran: string[] = [];
  frame.after(() => ran.push("a"));
  clock.run(OWN_FRAME_CAP_MS - 1);
  assert.deepEqual(ran, []);
  clock.run(1);
  assert.deepEqual(ran, ["a"]);
  paint(); // the frame comes at last: nothing more
  assert.deepEqual(ran, ["a"]);
});

test("the last tap wins: a newer selection replaces the one waiting", () => {
  const { frame, paint } = frameHarness();
  const ran: string[] = [];
  frame.after(() => ran.push("a"));
  frame.after(() => ran.push("b"));
  paint();
  assert.deepEqual(ran, ["b"]);
});

test("cancelled: the selection waiting is never written", () => {
  const { frame, clock, paint } = frameHarness();
  const ran: string[] = [];
  frame.after(() => ran.push("a"));
  frame.cancel();
  assert.equal(frame.waiting(), false);
  paint();
  clock.run(OWN_FRAME_CAP_MS);
  assert.deepEqual(ran, []);
  assert.equal(clock.live(), 0);
});
