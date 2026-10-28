// The server's results pages as the panel holds them (map phase 1, PR K): a
// new key listing the same auditions is the same list (no scroll to the top,
// no new frame), a new answer is read as far as the audition being read or
// as the same list on screen reached — never short of a page —, and a read
// through an audition extends the pages loaded. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no request.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaceResultRow, PlaceResultsPage } from "@ac/shared";
import {
  firstPageOnly,
  orderSig,
  readTarget,
  rowsOf,
  setSig,
  withThrough,
  type ResultsData,
  type ResultsPage,
} from "./resultsPages";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIEU = {
  id: "l:0000000000000001",
  key: "Place Jean Macé, Lyon",
  unit: "fr:com:69387",
  path: ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123", "fr:com:69387"],
  lat: 45.74,
  lng: 4.84,
  city: "Lyon",
};
const row = (n: number, count = 1): PlaceResultRow => ({
  id: id(n),
  title: `Audition ${n}`,
  date: "2026-10-01",
  n: count,
  lieu: LIEU,
});
/** The whole list: auditions 1..`total`, in the server's order. */
const ALL = (total: number, count = 1) =>
  Array.from({ length: total }, (_, i) => row(i + 1, count));
const cursor = (r: PlaceResultRow) =>
  [r.date, "2026-10-01", r.id, r.id] as [string, string, string, string];

/** A first page of `limit` rows of `total` (key and order as given). */
function firstPage(total: number, limit: number, key = "qa", count = 1): ResultsPage {
  const rows = ALL(total, count);
  const auditions = rows.slice(0, limit);
  return {
    auditions,
    next: rows.length > limit ? cursor(auditions[auditions.length - 1]) : null,
    total: { auditions: total, lieux: 1, n: total * count },
    frame: [45.7, 4.8, 45.8, 4.9],
    key,
    sort: "recent",
  };
}
/** The next page after `from` rows. */
function laterPage(total: number, from: number, limit: number, key = "qa"): ResultsPage {
  const rows = ALL(total);
  const auditions = rows.slice(from, from + limit);
  return {
    auditions,
    next: rows.length > from + limit ? cursor(auditions[auditions.length - 1]) : null,
    key,
    sort: "recent",
  };
}
/** The answer to results?through=<audition `at` (1-based)>. */
function throughPage(total: number, at: number): PlaceResultsPage {
  const rows = ALL(total);
  const auditions = rows.slice(0, at);
  return {
    auditions,
    next: rows.length > at ? cursor(auditions[auditions.length - 1]) : null,
    total: { auditions: total, lieux: 1, n: total },
    frame: [45.7, 4.8, 45.8, 4.9],
    throughFound: true,
  };
}

test("a new key listing the same auditions in the same order is the same list", () => {
  // «a» then «ar»: the same 64 auditions; their counts differ (other testimonies match).
  const a = firstPage(64, 50, "qa", 1);
  const ar = firstPage(64, 50, "qar", 3);
  assert.equal(orderSig(a), orderSig(ar));
  assert.equal(setSig(a), setSig(ar));
  // A page appended changes neither: they read the first page only.
  assert.equal(orderSig(a), orderSig({ ...a }));
  // Whole on its first page: every id, as the corpus' signatures are.
  const small = firstPage(12, 50);
  assert.equal(
    orderSig(small),
    ALL(12)
      .map((r) => r.id)
      .join(","),
  );
  assert.equal(
    setSig(small),
    ALL(12)
      .map((r) => r.id)
      .sort()
      .join(","),
  );
});

test("another order of the same set: a new list, not a new set", () => {
  const recent = firstPage(64, 50);
  const ancien: ResultsPage = {
    ...recent,
    auditions: [...ALL(64)].reverse().slice(0, 50),
    sort: "ancien",
  };
  assert.notEqual(orderSig(recent), orderSig(ancien));
  assert.equal(setSig(recent), setSig(ancien));
  // Whole: the same set, sorted ids.
  const small = firstPage(12, 50);
  const reversed = { ...small, auditions: [...small.auditions].reverse() };
  assert.notEqual(orderSig(small), orderSig(reversed));
  assert.equal(setSig(small), setSig(reversed));
});

test("another set: a new list and a new set", () => {
  const a = firstPage(64, 50);
  const fewer = firstPage(63, 50);
  assert.notEqual(orderSig(a), orderSig(fewer));
  assert.notEqual(setSig(a), setSig(fewer));
});

test("a new answer is read as far as the audition being read, opened from the list on screen", () => {
  const shown = [firstPage(64, 50), laterPage(64, 50, 50)];
  const nextKey = [{ ...firstPage(64, 50, "qe"), auditions: ALL(64).slice(1, 51) }];
  // On the first page: nothing to read.
  assert.equal(readTarget(nextKey, { pages: shown }, id(10)), null);
  // Further down: read as far as it (never a shorter page: the first stays).
  assert.equal(readTarget(nextKey, { pages: shown }, id(60)), id(60));
  // Opened elsewhere (a lieu's list before list mode): not the list's.
  assert.equal(readTarget(nextKey, { pages: [firstPage(64, 50)] }, id(60)), null);
  assert.equal(readTarget(nextKey, null, id(60)), null);
  // Kept open, whether it matched unknown: read again.
  assert.equal(
    readTarget(nextKey, { pages: [firstPage(64, 50)], unknown: id(60) }, id(60)),
    id(60),
  );
  // Every result on the first page: nothing further to read.
  assert.equal(readTarget([firstPage(30, 50, "qe")], { pages: shown }, id(60)), null);
});

test("the same list as on screen is read as far as it was", () => {
  const shown = [firstPage(64, 50, "qa"), laterPage(64, 50, 50, "qa")];
  const same = [firstPage(64, 50, "qar", 2)];
  assert.equal(readTarget(same, { pages: shown }, null), id(64));
  // No further than it was: one page on screen, one page in.
  assert.equal(readTarget(same, { pages: [firstPage(64, 50, "qa")] }, null), null);
});

test("a read through an audition extends the pages loaded, never shortens them", () => {
  const old: ResultsData = { pages: [firstPage(120, 50)], pageParams: [null] };
  const through = throughPage(120, 72);
  const out = withThrough(old, through, "qa", "recent")!;
  assert.equal(out.pages.length, 2);
  assert.deepEqual(
    rowsOf(out.pages).map((r) => r.id),
    ALL(72).map((r) => r.id),
  );
  // The next page asked after it starts where it ends.
  assert.deepEqual(out.pages[1].next, cursor(ALL(120)[71]));
  assert.deepEqual(out.pageParams, [null, old.pages[0].next]);
  // Shorter than the pages loaded: unchanged.
  assert.equal(withThrough(old, throughPage(120, 3), "qa", "recent"), old);
  // The rows moved under the pages loaded: that read stands for them.
  const moved = { ...through, auditions: [row(999), ...through.auditions.slice(1)] };
  const replaced = withThrough(old, moved, "qa", "recent")!;
  assert.equal(replaced.pages.length, 1);
  assert.equal(replaced.pages[0].auditions.length, 72);
  assert.deepEqual(replaced.pageParams, [null]);
});

test("a key come back to keeps its first page alone", () => {
  const pages = [firstPage(120, 50), laterPage(120, 50, 50)];
  const data: ResultsData = { pages, pageParams: [null, pages[0].next] };
  const first = firstPageOnly(data)!;
  assert.equal(first.pages.length, 1);
  assert.equal(first.pages[0], pages[0]);
  assert.deepEqual(first.pageParams, [null]);
  const one: ResultsData = { pages: [pages[0]], pageParams: [null] };
  assert.equal(firstPageOnly(one), one);
  assert.equal(firstPageOnly(undefined), undefined);
});
