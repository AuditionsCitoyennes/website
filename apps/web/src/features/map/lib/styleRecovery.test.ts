// The map's style asked again after its request failed (styleRecovery.ts),
// run with `node --import tsx --test` (root "test:scripts"): a bounded number
// of attempts with a growing pause, then "down" until somebody asks.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStyleRecovery,
  finalStatus,
  isStyleRequestError,
  STYLE_RETRY_WAITS_MS,
  type StyleState,
} from "./styleRecovery";

function setup(waits?: readonly number[]) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  let asks = 0;
  const states: StyleState[] = [];
  const r = createStyleRecovery({
    ask: () => asks++,
    setTimer: (fn, ms) => {
      timers.set(++seq, { fn, ms });
      return seq;
    },
    clearTimer: (t) => timers.delete(t as number),
    onState: (s) => states.push(s),
    waits,
  });
  return {
    r,
    states,
    asks: () => asks,
    /** The one pause armed, ms (undefined: none). */
    pause: () => [...timers.values()][0]?.ms,
    armed: () => timers.size,
    /** The pause elapses. */
    fire() {
      const [id, t] = [...timers.entries()][0];
      timers.delete(id);
      t.fn();
    },
  };
}

test("the pauses grow and are few", () => {
  assert.ok(STYLE_RETRY_WAITS_MS.length >= 2 && STYLE_RETRY_WAITS_MS.length <= 5);
  for (let i = 1; i < STYLE_RETRY_WAITS_MS.length; i++) {
    assert.ok(STYLE_RETRY_WAITS_MS[i] > STYLE_RETRY_WAITS_MS[i - 1]);
  }
});

test("one failure: asked again after the first pause, and the style arriving ends it", () => {
  const s = setup();
  assert.equal(s.r.state(), "loading");
  s.r.failed();
  assert.equal(s.r.state(), "waiting");
  assert.equal(s.pause(), STYLE_RETRY_WAITS_MS[0]);
  assert.equal(s.asks(), 0, "not before the pause");
  s.fire();
  assert.equal(s.asks(), 1);
  assert.equal(s.r.state(), "loading");
  s.r.arrived();
  assert.equal(s.r.state(), "in");
  assert.deepEqual(s.states, ["waiting", "loading", "in"]);
  // Nothing after it: a later error is not the style's.
  s.r.failed();
  assert.equal(s.r.state(), "in");
  assert.equal(s.armed(), 0);
});

test("every attempt failing: each pause in turn, then down, nothing armed", () => {
  const s = setup();
  for (const ms of STYLE_RETRY_WAITS_MS) {
    s.r.failed();
    assert.equal(s.pause(), ms);
    s.fire();
  }
  assert.equal(s.asks(), STYLE_RETRY_WAITS_MS.length);
  s.r.failed();
  assert.equal(s.r.state(), "down");
  assert.equal(s.armed(), 0);
  // A failure reported twice changes nothing.
  s.r.failed();
  assert.equal(s.r.state(), "down");
  assert.equal(s.asks(), STYLE_RETRY_WAITS_MS.length);
});

test("down: the button asks once; a failure brings the message back at once", () => {
  const s = setup([10]);
  s.r.failed();
  s.fire();
  s.r.failed();
  assert.equal(s.r.state(), "down");
  assert.equal(s.r.retry(), true);
  assert.equal(s.r.state(), "asking");
  assert.equal(s.asks(), 2);
  assert.equal(s.r.retry(), false, "pressed again while asking: nothing more");
  assert.equal(s.asks(), 2);
  s.r.failed();
  assert.equal(s.r.state(), "down");
  assert.equal(s.armed(), 0, "no series by itself after the message");
  // The network back: the button works.
  assert.equal(s.r.retry(), true);
  s.r.arrived();
  assert.equal(s.r.state(), "in");
  assert.equal(s.r.retry(), false);
});

test("the network may be back during a pause: the attempt is made now", () => {
  const s = setup();
  s.r.failed();
  assert.equal(s.r.retry(), true);
  assert.equal(s.armed(), 0);
  assert.equal(s.asks(), 1);
  assert.equal(s.r.state(), "loading");
  // …and while the style is on its way, nothing.
  assert.equal(s.r.retry(), false);
  assert.equal(s.asks(), 1);
});

test("a final failure skips the pauses", () => {
  const s = setup();
  s.r.failed(true);
  assert.equal(s.r.state(), "down");
  assert.equal(s.armed(), 0);
  assert.equal(s.asks(), 0);
  assert.equal(s.r.retry(), true);
});

test("stop drops the pause armed", () => {
  const s = setup();
  s.r.failed();
  s.r.stop();
  assert.equal(s.armed(), 0);
});

test("which error is the style's request, and which answer is final", () => {
  assert.equal(isStyleRequestError({}, false), true);
  assert.equal(isStyleRequestError({}, true), false);
  assert.equal(isStyleRequestError({ sourceId: "composite" }, false), false);
  assert.equal(isStyleRequestError({ tile: {} }, false), false);
  for (const status of [400, 404, 410]) assert.equal(finalStatus(status), true, String(status));
  for (const status of [undefined, 0, 200, 408, 429, 500, 502, 503]) {
    assert.equal(finalStatus(status), false, String(status));
  }
});
