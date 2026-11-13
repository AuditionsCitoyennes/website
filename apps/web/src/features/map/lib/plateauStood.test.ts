// The first-plateau latch (plateauStood.ts): it rises once per map, its
// listeners hear the rise once, a removed listener hears nothing, a throwing
// listener does not stop the others, and a new map lowers it. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markPlateauStood,
  onPlateauStood,
  plateauHasStood,
  resetPlateauStood,
} from "./plateauStood";

test("the latch rises once, its listeners hear it once, a new map lowers it", () => {
  resetPlateauStood();
  assert.equal(plateauHasStood(), false);
  const heard: string[] = [];
  const offA = onPlateauStood(() => heard.push("a"));
  const offB = onPlateauStood(() => heard.push("b"));
  offB();
  markPlateauStood();
  markPlateauStood();
  assert.equal(plateauHasStood(), true);
  assert.deepEqual(heard, ["a"]);
  resetPlateauStood(); // a new map
  assert.equal(plateauHasStood(), false);
  markPlateauStood();
  assert.deepEqual(heard, ["a", "a"]);
  offA();
  resetPlateauStood();
});

test("a listener that throws does not keep the others from hearing", () => {
  resetPlateauStood();
  const heard: string[] = [];
  const error = console.error;
  console.error = () => {};
  try {
    const offA = onPlateauStood(() => {
      throw new Error("boom");
    });
    const offB = onPlateauStood(() => heard.push("b"));
    markPlateauStood();
    offA();
    offB();
  } finally {
    console.error = error;
  }
  assert.deepEqual(heard, ["b"]);
  resetPlateauStood();
});
