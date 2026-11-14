// The pending state of a tapped territory (tapPendingCore.ts): when it
// begins, each way it ends (its plateau commits, the scope moves without a
// tap, nothing will rise, a newer tap, the safety cap), what the map and the
// screen reader are told, the frame the mark may get to itself, and the sign
// of a long wait: when it moves, when the wait turns late, what « Réessayer »
// starts over. Fake map, fake timers. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LANDING_CAP_MS,
  LATE_SENTENCE,
  OWN_FRAME_CAP_MS,
  PENDING_CAP_MS,
  SLOW_SIGN_FLOOR_MS,
  SLOW_WAIT_MS,
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

function harness(opts: { off?: boolean; slow?: boolean } = {}) {
  const clock = fakeTimers();
  const log: string[] = [];
  const s = {
    scope: "fr:reg:84",
    micro: false,
    busy: null as string | null,
    said: "",
    /** `mark` answers false from now (the plateau stands, the switch went off). */
    noMark: false,
  };
  const core = createTapPending({
    mark: (unit) => {
      if (opts.off || s.noMark) return false;
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
    ...(opts.slow
      ? {
          slowSign: () => true,
          onWait: (stage, unit) => log.push(`wait ${stage}${unit ? ` ${unit.id}` : ""}`),
          reask: (unit) => log.push(`reask ${unit.id}`),
        }
      : {}),
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

// ---- The sign of a long wait (ac:slow-sign) ----

test("a plateau that commits before the floor shows no sign at all", () => {
  const { core, clock, log, writeScope } = harness({ slow: true });
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(300);
  core.landed();
  clock.run(SLOW_SIGN_FLOOR_MS - 301);
  core.settled("fr:dep:69", "rise");
  assert.deepEqual(log, ["mark fr:dep:69", "end fr:dep:69 risen 799", "unmark rise"]);
  assert.equal(clock.live(), 0);
  clock.run(SLOW_WAIT_MS);
  assert.equal(log.length, 3);
});

test("the sign moves once the flight has landed AND the floor has passed, whichever comes last", () => {
  // Landed early: the sign waits for the floor.
  const early = harness({ slow: true });
  early.core.begin(RHONE);
  early.writeScope("fr:dep:69");
  early.clock.run(650);
  early.core.landed();
  assert.equal(early.core.wait(), "none");
  early.clock.run(SLOW_SIGN_FLOOR_MS - 650);
  assert.equal(early.core.wait(), "moving");
  assert.equal(early.log.at(-1), "wait moving fr:dep:69");
  // Landed late: the floor alone shows nothing, the landing does.
  const late = harness({ slow: true });
  late.core.begin(RHONE);
  late.writeScope("fr:dep:69");
  late.clock.run(1400);
  assert.equal(late.core.wait(), "none");
  late.core.landed();
  assert.equal(late.core.wait(), "moving");
  // The plateau commits: the sign goes with the mark, the sentence is said.
  late.core.settled("fr:dep:69", "rise");
  assert.deepEqual(late.log.slice(-3), ["end fr:dep:69 risen 1400", "wait none", "unmark rise"]);
  assert.equal(late.s.said, readySentence(RHONE));
  assert.equal(late.clock.live(), 0);
});

test("a view reported before the scope is written is not the flight's landing", () => {
  const { core, clock, writeScope } = harness({ slow: true });
  core.begin(RHONE); // ac:tap-frame=own: the scope follows a frame later
  core.landed(); // the view of the unit being left
  writeScope("fr:dep:69");
  clock.run(SLOW_SIGN_FLOOR_MS);
  assert.equal(core.wait(), "none");
  core.landed();
  assert.equal(core.wait(), "moving");
});

test("a landing never reported counts as landed at the cap", () => {
  const { core, clock, writeScope } = harness({ slow: true });
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(LANDING_CAP_MS - 1);
  assert.equal(core.wait(), "none");
  clock.run(1);
  assert.equal(core.wait(), "moving");
  clock.run(SLOW_WAIT_MS - LANDING_CAP_MS);
  assert.equal(core.wait(), "late");
});

test("five seconds with nothing: the mark goes, the list is free, the sentence is said — and no timeout", () => {
  const { core, clock, log, s, writeScope } = harness({ slow: true });
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(700);
  core.landed();
  clock.run(SLOW_WAIT_MS - 701);
  assert.equal(core.wait(), "moving");
  assert.equal(s.busy, "fr:dep:69");
  clock.run(1);
  assert.equal(core.wait(), "late");
  assert.deepEqual(log.slice(-2), ["unmark off", "wait late fr:dep:69"]);
  assert.equal(s.busy, null);
  assert.equal(s.said, LATE_SENTENCE);
  assert.equal(core.pending()?.id, "fr:dep:69"); // still awaited
  assert.equal(clock.live(), 0); // nothing moves, nothing ticks
  clock.run(PENDING_CAP_MS);
  assert.equal(core.wait(), "late"); // no cap ends it
  assert.ok(!log.some((l) => l.includes("timeout")));
});

test("a late wait whose plateau commits after all: the sentence of the unit, no second unmark", () => {
  const { core, clock, log, s, writeScope } = harness({ slow: true });
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(SLOW_WAIT_MS);
  const before = log.length;
  core.settled("fr:dep:69", "rise");
  assert.deepEqual(log.slice(before), [`end fr:dep:69 risen ${SLOW_WAIT_MS}`, "wait none"]);
  assert.equal(s.said, readySentence(RHONE));
  assert.equal(core.pending(), null);
});

test("a late wait ends with the scope gone elsewhere, a verdict that nothing rises, or a newer tap", () => {
  const moved = harness({ slow: true });
  moved.core.begin(RHONE);
  moved.writeScope("fr:dep:69");
  moved.clock.run(SLOW_WAIT_MS);
  moved.writeScope("fr:reg:84");
  assert.equal(moved.core.wait(), "none");
  assert.equal(moved.s.said, ""); // the late sentence holds no more
  assert.equal(moved.log.at(-1), "wait none");

  const none = harness({ slow: true });
  none.core.begin(RHONE);
  none.writeScope("fr:dep:69");
  none.clock.run(SLOW_WAIT_MS);
  none.core.settled("", "cleared");
  assert.equal(none.core.wait(), "none");
  assert.equal(none.s.said, "");

  const tap = harness({ slow: true });
  tap.core.begin(RHONE);
  tap.writeScope("fr:dep:69");
  tap.clock.run(SLOW_WAIT_MS);
  tap.core.begin(ISERE);
  assert.deepEqual(tap.log.slice(-3), [
    `end fr:dep:69 replaced ${SLOW_WAIT_MS}`,
    "wait none",
    "mark fr:dep:38",
  ]);
  assert.equal(tap.s.busy, "fr:dep:38");
  assert.equal(tap.s.said, "");
});

test("« Réessayer »: marked again, the sign at once, the missing piece asked, late again five seconds on", () => {
  const { core, clock, log, s, writeScope } = harness({ slow: true });
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(SLOW_WAIT_MS);
  const before = log.length;
  assert.equal(core.retry(), true);
  assert.deepEqual(log.slice(before), [
    "mark fr:dep:69",
    "wait moving fr:dep:69",
    "reask fr:dep:69",
  ]);
  assert.equal(s.busy, "fr:dep:69");
  assert.equal(s.said, "");
  assert.equal(core.wait(), "moving");
  clock.run(SLOW_WAIT_MS - 1);
  assert.equal(core.wait(), "moving");
  clock.run(1);
  assert.equal(core.wait(), "late");
  assert.equal(s.said, LATE_SENTENCE);
  // Again, and this time the plateau commits: its mark fades as it rises.
  assert.equal(core.retry(), true);
  core.settled("fr:dep:69", "rise");
  assert.equal(log.at(-1), "unmark rise");
  assert.equal(s.said, readySentence(RHONE));
  assert.equal(clock.live(), 0);
});

test("« Réessayer » outside a late wait does nothing; with no mark to be had the state ends", () => {
  const { core, clock, log, s, writeScope } = harness({ slow: true });
  assert.equal(core.retry(), false);
  core.begin(RHONE);
  writeScope("fr:dep:69");
  clock.run(1000);
  assert.equal(core.retry(), false); // pending, not late
  assert.ok(!log.some((l) => l.startsWith("reask")));
  clock.run(SLOW_WAIT_MS);
  s.noMark = true; // its plateau stands after all
  assert.equal(core.retry(), false);
  assert.equal(core.pending(), null);
  assert.equal(core.wait(), "none");
  assert.ok(!log.some((l) => l.startsWith("reask")));
  assert.equal(clock.live(), 0);
});

test("the sign off (or not wired): the state before it — the cap, no stage, landings ignored", () => {
  const { core, clock, log, writeScope } = harness();
  core.begin(RHONE);
  writeScope("fr:dep:69");
  core.landed();
  clock.run(SLOW_WAIT_MS);
  assert.equal(core.wait(), "none");
  assert.deepEqual(log, ["mark fr:dep:69"]);
  assert.equal(core.retry(), false);
  clock.run(PENDING_CAP_MS - SLOW_WAIT_MS);
  assert.equal(log.at(-1), "unmark off");
});

test("dispose drops a long wait's timers too", () => {
  const { core, clock } = harness({ slow: true });
  core.begin(RHONE);
  assert.equal(clock.live(), 3);
  core.dispose();
  assert.equal(clock.live(), 0);
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
