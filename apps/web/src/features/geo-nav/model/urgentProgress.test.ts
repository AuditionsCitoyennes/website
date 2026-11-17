// The share of a tapped unit's outline file(s) that has arrived
// (urgentProgress.ts): a file's share at its headers, as its bytes come (a
// known size, an unknown one), once whole; the mean over the files expected
// or seen; the cap until the file is stored; nothing without a unit waited
// for. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  URGENT_ANSWERED,
  URGENT_BODY,
  URGENT_BODY_SCALE,
  URGENT_CAP,
  createUrgentProgress,
} from "./urgentProgress";

const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("one file of a known size: the headers, the bytes, the whole", () => {
  const p = createUrgentProgress();
  p.begin("fr:reg:84", 1);
  near(p.note("u/fr_reg_84", "answered", 0, 1000), URGENT_ANSWERED);
  near(p.note("u/fr_reg_84", "bytes", 250, 1000), URGENT_ANSWERED + URGENT_BODY * 0.25);
  near(p.note("u/fr_reg_84", "bytes", 1000, 1000), URGENT_ANSWERED + URGENT_BODY);
  near(p.note("u/fr_reg_84", "landed", 1000, 1000), URGENT_CAP); // whole, not stored yet
  assert.equal(p.note("u/fr_reg_84", "landed", 1000, 1000), null); // nothing new
});

test("a size unknown (a compressed transfer): it moves with every piece and never ends early", () => {
  const p = createUrgentProgress();
  p.begin("fr:reg:84", 1);
  p.note("u/fr_reg_84", "answered", 0, null);
  let last = URGENT_ANSWERED;
  for (const bytes of [16_000, 60_000, 120_000, 190_000, 290_000, 5_000_000]) {
    const v = p.note("u/fr_reg_84", "bytes", bytes, null)!;
    assert.ok(v > last, `${bytes} bytes: ${v} > ${last}`);
    assert.ok(v < URGENT_ANSWERED + URGENT_BODY + 1e-12);
    last = v;
  }
  near(
    p.note("u/k", "bytes", URGENT_BODY_SCALE, null),
    (last + URGENT_ANSWERED + URGENT_BODY * (1 - Math.exp(-1))) / 2,
  );
});

test("the bytes never pull a file back, and bytes with no headers count from the headers' share", () => {
  const p = createUrgentProgress();
  p.begin("a", 1);
  near(p.note("k/a", "bytes", 500, 1000), URGENT_ANSWERED + URGENT_BODY * 0.5);
  assert.equal(p.note("k/a", "bytes", 100, 1000), null);
  assert.equal(p.note("k/a", "answered", 0, 1000), null);
  assert.equal(p.note("k/a", "bytes", Number.NaN, 1000), null); // no number: nothing
});

test("several files: the mean over those expected, or seen if more came", () => {
  const p = createUrgentProgress();
  p.begin("fr:com:69123", 3);
  near(p.note("k/fr_reg_84", "landed", 10, 10), 1 / 3);
  near(p.note("k/fr_dep_69", "answered", 0, null), (1 + URGENT_ANSWERED) / 3);
  near(p.note("k/fr_dep_69", "landed", 10, null), 2 / 3);
  near(p.note("k/fr_com_69123", "landed", 10, null), URGENT_CAP); // all three whole: capped
  // A fourth file nobody expected: the mean is over four.
  const q = createUrgentProgress();
  q.begin("x", 1);
  q.note("k/1", "landed", 1, 1);
  near(q.note("k/2", "answered", 0, null), (1 + URGENT_ANSWERED) / 2);
});

test("nothing waited for: no share; a new unit starts from nothing", () => {
  const p = createUrgentProgress();
  assert.equal(p.note("k/a", "landed", 1, 1), null);
  p.begin("a", 1);
  p.note("k/a", "answered", 0, null);
  p.begin("b", 1); // another unit: a's files count for nothing
  assert.equal(p.scope(), "b");
  near(p.note("k/b", "answered", 0, null), URGENT_ANSWERED);
  p.end();
  assert.equal(p.scope(), "");
  assert.equal(p.note("k/b", "landed", 1, 1), null);
  p.begin("c", 0); // a count that is no count: one file
  near(p.note("k/c", "landed", 1, 1), URGENT_CAP);
});
