// The ac:relief switch (reliefSwitch.ts) against a stubbed localStorage, run
// with `node --import tsx --test` (root "test:scripts"): the default is
// "client", a build without the testing tools ignores the key, and with them
// a kept "serveur" still opts out (the module read again under a fresh query).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
};
let stored: Record<string, string> = {};
let throwing = false;
g.localStorage = {
  getItem(k: string) {
    if (throwing) throw new Error("blocked");
    return stored[k] ?? null;
  },
  setItem(k: string, v: string) {
    if (throwing) throw new Error("blocked");
    stored[k] = v;
  },
};

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./reliefSwitch.ts?mode=${++n}`)) as typeof import("./reliefSwitch");
}

test("DEFAULT_RELIEF_MODE is client", async () => {
  assert.equal((await load(false)).DEFAULT_RELIEF_MODE, "client");
});

test("without the testing tools: client, the kept key ignored", async () => {
  stored = { "ac:relief": "serveur" };
  const m = await load(false);
  assert.equal(m.reliefMode, "client");
  assert.equal(m.reliefRoute(), "client");
});

test("with the testing tools: a kept serveur opts out, anything else is client", async () => {
  stored = { "ac:relief": "serveur" };
  assert.equal((await load(true)).reliefMode, "serveur");
  stored = { "ac:relief": "client" };
  assert.equal((await load(true)).reliefMode, "client");
  for (const garbage of ["", "Serveur", "server", "garbage", " client"]) {
    stored = { "ac:relief": garbage };
    assert.equal((await load(true)).reliefMode, "client", garbage);
  }
  stored = {};
  assert.equal((await load(true)).reliefMode, "client");
  throwing = true;
  assert.equal((await load(true)).reliefMode, "client");
  throwing = false;
});
