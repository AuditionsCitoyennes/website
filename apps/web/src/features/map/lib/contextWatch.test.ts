// The map's WebGL context, lost and given back (contextWatch.ts): a restore
// runs every step once and in order, a step that throws keeps none of the
// others from running and is named, a loss told twice counts once, a restore
// with no loss told runs the steps too, and the state the probe shows follows.
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createContextWatch } from "./contextWatch";

function rig(throwing: string[] = []) {
  const ran: string[] = [];
  const errors: [string, unknown][] = [];
  const step = (name: string) => ({
    name,
    run: () => {
      ran.push(name);
      if (throwing.includes(name)) throw new Error(`${name} failed`);
    },
  });
  const watch = createContextWatch([step("tint"), step("plateau"), step("lid")], (name, err) =>
    errors.push([name, err]),
  );
  return { watch, ran, errors };
}

test("a new watch has lost nothing and runs nothing", () => {
  const { watch, ran } = rig();
  assert.deepEqual(watch.state(), { lost: false, losses: 0, restores: 0, failed: [] });
  assert.deepEqual(ran, []);
});

test("a loss runs no step; its restore runs each once, in order", () => {
  const { watch, ran, errors } = rig();
  watch.lost();
  assert.deepEqual(ran, []);
  assert.deepEqual(watch.state(), { lost: true, losses: 1, restores: 0, failed: [] });
  assert.deepEqual(watch.restored(), []);
  assert.deepEqual(ran, ["tint", "plateau", "lid"]);
  assert.deepEqual(watch.state(), { lost: false, losses: 1, restores: 1, failed: [] });
  assert.deepEqual(errors, []);
});

test("a step that throws is named and the steps after it still run", () => {
  const { watch, ran, errors } = rig(["tint", "lid"]);
  watch.lost();
  assert.deepEqual(watch.restored(), ["tint", "lid"]);
  assert.deepEqual(ran, ["tint", "plateau", "lid"]);
  assert.deepEqual(
    errors.map(([name]) => name),
    ["tint", "lid"],
  );
  assert.match(String(errors[0][1]), /tint failed/);
  assert.deepEqual(watch.state().failed, ["tint", "lid"]);
});

test("the failed steps are those of the last restore only", () => {
  const ran: string[] = [];
  let fail = true;
  const watch = createContextWatch([
    {
      name: "plateau",
      run: () => {
        ran.push("plateau");
        if (fail) throw new Error("no");
      },
    },
  ]);
  watch.lost();
  assert.deepEqual(watch.restored(), ["plateau"]); // no onError given: still caught
  fail = false;
  watch.lost();
  assert.deepEqual(watch.restored(), []);
  assert.deepEqual(watch.state(), { lost: false, losses: 2, restores: 2, failed: [] });
  assert.deepEqual(ran, ["plateau", "plateau"]);
});

test("a loss told twice before its restore counts once", () => {
  const { watch } = rig();
  watch.lost();
  watch.lost();
  assert.equal(watch.state().losses, 1);
  watch.restored();
  watch.lost();
  assert.equal(watch.state().losses, 2);
  assert.equal(watch.state().lost, true);
});

test("a restore with no loss told before it runs the steps all the same", () => {
  const { watch, ran } = rig();
  watch.restored();
  assert.deepEqual(ran, ["tint", "plateau", "lid"]);
  assert.deepEqual(watch.state(), { lost: false, losses: 0, restores: 1, failed: [] });
});

test("the state handed out is a copy", () => {
  const { watch } = rig(["lid"]);
  watch.restored();
  const s = watch.state();
  s.failed.push("x");
  s.losses = 9;
  assert.deepEqual(watch.state(), { lost: false, losses: 0, restores: 1, failed: ["lid"] });
});
