// The waits of a committed plateau's rise (riseSequence.ts). Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RiseStart } from "./riseHold";
import { RISE_GATE_ROUNDS, riseSequence } from "./riseSequence";

/** Gates answered in turn (the last one repeats), waits recorded. */
function script(gates: number[], ends: RiseStart[] = []) {
  const log: string[] = [];
  let g = 0;
  let w = 0;
  return {
    log,
    gate: () => {
      const ms = gates[Math.min(g++, gates.length - 1)] ?? 0;
      log.push(`gate ${ms}`);
      return ms;
    },
    wait: (ms: number, landing: boolean) => {
      log.push(`wait ${ms}${landing ? " +landing" : ""}`);
      return Promise.resolve(ends[w++] ?? "start");
    },
  };
}

test("nothing holds the rise: no wait at all", async () => {
  const s = script([0]);
  assert.deepEqual(await riseSequence({ waits: false, ...s }), { how: "start", waited: false });
  assert.deepEqual(s.log, ["gate 0"]);
});

test("the gate only: waited for, then read again", async () => {
  const s = script([25, 0]);
  assert.deepEqual(await riseSequence({ waits: false, ...s }), { how: "start", waited: true });
  assert.deepEqual(s.log, ["gate 25", "wait 25", "gate 0"]);
});

test("the landing first, the gate read only after it", async () => {
  const s = script([10, 0]);
  assert.deepEqual(await riseSequence({ waits: true, ...s }), { how: "start", waited: true });
  assert.deepEqual(s.log, ["wait 0 +landing", "gate 10", "wait 10", "gate 0"]);
});

test("the landing with the fill already gone: no further wait", async () => {
  const s = script([0]);
  assert.deepEqual(await riseSequence({ waits: true, ...s }), { how: "start", waited: true });
  assert.deepEqual(s.log, ["wait 0 +landing", "gate 0"]);
});

test("the gate is waited for again while it is not 0", async () => {
  const s = script([100, 40, 8, 0]);
  assert.deepEqual(await riseSequence({ waits: false, ...s }), { how: "start", waited: true });
  assert.deepEqual(s.log, [
    "gate 100",
    "wait 100",
    "gate 40",
    "wait 40",
    "gate 8",
    "wait 8",
    "gate 0",
  ]);
});

test("a gate that never falls (no frame drawn): the rise comes after a bounded number of rounds", async () => {
  const s = script([50]);
  assert.deepEqual(await riseSequence({ waits: false, ...s }), { how: "start", waited: true });
  assert.equal(s.log.filter((l) => l.startsWith("wait")).length, RISE_GATE_ROUNDS);
  assert.equal(s.log.filter((l) => l.startsWith("gate")).length, RISE_GATE_ROUNDS);
});

test("taken or dropped at any step ends it there", async () => {
  let s = script([10], ["dropped"]);
  assert.deepEqual(await riseSequence({ waits: true, ...s }), { how: "dropped", waited: true });
  assert.deepEqual(s.log, ["wait 0 +landing"]);
  s = script([10, 10], ["start", "taken"]);
  assert.deepEqual(await riseSequence({ waits: true, ...s }), { how: "taken", waited: true });
  assert.deepEqual(s.log, ["wait 0 +landing", "gate 10", "wait 10"]);
  s = script([30, 30], ["start", "dropped"]);
  assert.deepEqual(await riseSequence({ waits: false, ...s }), { how: "dropped", waited: true });
  assert.deepEqual(s.log, ["gate 30", "wait 30", "gate 30", "wait 30"]);
});
