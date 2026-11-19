// The switch of a lieu with one audition (lieuSingleSwitch.ts), run with
// `node --import tsx --test` (root "test:scripts"): a build without the
// testing tools never reads its storage (a counting stub holding another
// value) and keeps the default; with the testing tools a kept key keeps its
// mode, the setter keeps the new one, and an unknown value or a storage that
// throws gives the default. The module is imported after the stubs (its mode
// is read at load), under a fresh query each time, as slowSignSwitch.test.ts
// does.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };

let reads = 0;
const keeping = (values: Record<string, string>) => ({
  getItem(k: string) {
    reads++;
    return values[k] ?? null;
  },
  setItem(k: string, v: string) {
    values[k] = v;
  },
});

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./lieuSingleSwitch.ts?mode=${++n}`)) as typeof import("./lieuSingleSwitch");
}

test("without the testing tools: the default (ouvrir), storage unread, the setter ignored", async () => {
  const values = { "ac:lieu-single": "lister" };
  g.localStorage = keeping(values);
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.DEFAULT_LIEU_SINGLE, "ouvrir");
    assert.ok(m.LIEU_SINGLE_MODES.includes(m.DEFAULT_LIEU_SINGLE));
    assert.equal(m.lieuSingleMode.value, m.DEFAULT_LIEU_SINGLE);
    m.setLieuSingleMode("lister");
    assert.equal(m.lieuSingleMode.value, m.DEFAULT_LIEU_SINGLE);
    assert.equal(values["ac:lieu-single"], "lister");
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: a kept key keeps its mode, and the setter keeps the new one", async () => {
  const values: Record<string, string> = { "ac:lieu-single": "lister" };
  g.localStorage = keeping(values);
  try {
    const m = await load(true);
    assert.equal(m.lieuSingleMode.value, "lister");
    m.setLieuSingleMode("ouvrir");
    assert.equal(m.lieuSingleMode.value, "ouvrir");
    assert.deepEqual(values, { "ac:lieu-single": "ouvrir" });
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: an unknown value or a storage that throws gives the default", async () => {
  g.localStorage = keeping({ "ac:lieu-single": "toujours" });
  try {
    assert.equal((await load(true)).lieuSingleMode.value, "ouvrir");
  } finally {
    delete g.localStorage;
  }
  g.localStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  try {
    const m = await load(true);
    assert.equal(m.lieuSingleMode.value, "ouvrir");
    m.setLieuSingleMode("lister"); // lasts for this page
    assert.equal(m.lieuSingleMode.value, "lister");
  } finally {
    delete g.localStorage;
  }
});
