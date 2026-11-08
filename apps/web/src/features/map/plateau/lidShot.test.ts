// The lid shot's end (lidShot.ts settleAndGrab, settleAndGrabPixels) against a
// fake hidden map: a frame that was never drawn, cleared or lost ends without
// a lid and without a pixel read under "signaux", a map error since the jump
// brings the 8×8 readback back, and "pixels" keeps the shot as it was before
// lid-readback. Run with `node --import tsx --test` (root "test:scripts"). No
// DOM, no mapbox-gl: the fake's timers are node's mocked setTimeout and Date.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  READY_TIMEOUT_MS,
  SETTLE_MS,
  settleAndGrab,
  settleAndGrabPixels,
  uniformSample,
  type Shot,
  type ShotIO,
} from "./lidShot";
import type { LidCheck } from "./lidSwitch";

interface Bmp {
  id: number;
  blank: boolean;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A hidden map: settable readiness, its signals, and a count of what the shot did. */
function fakeMap() {
  const sig = { renders: 0, clearedAt: 0, lost: false, errors: 0 };
  const st = {
    loaded: true,
    drawOnFrame: true, // the shot's animation frame draws what its jump asked for
    glLost: false,
    alive: true,
    current: true,
    nextBlank: false,
    rejectNext: false,
    onGrab: null as null | (() => void),
    grabs: 0,
    readbacks: 0,
    closed: [] as number[],
    order: [] as string[],
  };
  let ids = 0;
  const io: ShotIO<Bmp> = {
    map: { loaded: () => st.loaded },
    signals: sig,
    alive: () => st.alive,
    current: () => st.current,
    glLost: () => st.glLost,
    frame: async () => {
      st.order.push("frame");
      if (st.drawOnFrame) sig.renders++;
    },
    wait: (ms) => (st.order.push(`wait ${ms}`), sleep(ms)),
    // The manager's loop, on Date (mock.timers does not mock performance.now()).
    until: async (cond, ms) => {
      st.order.push("until");
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) return false;
        await sleep(40);
      }
      return true;
    },
    grab: async () => {
      st.order.push("grab");
      st.grabs++;
      st.onGrab?.();
      if (st.rejectNext) throw new Error("grab failed");
      return { id: ++ids, blank: st.nextBlank };
    },
    close: (b) => void st.closed.push(b.id),
    blank: (b) => (st.order.push("blank"), st.readbacks++, b.blank),
  };
  return {
    io,
    st,
    render: () => void sig.renders++,
    resize: () => void (sig.clearedAt = sig.renders),
    /** The context is lost: isContextLost() says so at once… */
    lose: () => void (st.glLost = true),
    /** …and the canvas's queued event reaches the manager a task later. */
    deliverLost: () => void (sig.lost = true),
    restore: () => void Object.assign(sig, { lost: (st.glLost = false), clearedAt: sig.renders }),
    error: () => void sig.errors++,
  };
}

type Fake = ReturnType<typeof fakeMap>;

/** Start a shot right after its jump; `result()` is undefined while it runs. */
async function shoot(f: Fake, check: LidCheck, before?: () => void) {
  const at = { renders: f.io.signals.renders, errors: f.io.signals.errors };
  before?.(); // what happens between the jump and the first poll
  let result: Shot<Bmp> | undefined;
  let error: unknown;
  const run = check === "signaux" ? settleAndGrab(f.io, at) : settleAndGrabPixels(f.io);
  void run.then(
    (r) => (result = r),
    (e: unknown) => (error = e),
  );
  await flush();
  return { result: () => result, error: () => error };
}

/** The shot's end, whether it returned a bitmap, and the fake's counts. */
function seen(f: Fake, s: { result(): Shot<Bmp> | undefined }) {
  const r = s.result();
  return [r?.end, !!r?.bitmap, f.st.grabs, f.st.readbacks, f.st.closed];
}

/** One poll at a time: each poll sets its next timer only after a microtask. */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 40) {
    mock.timers.tick(Math.min(40, ms - t));
    await flush();
  }
}

function withTimers(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  });
}

withTimers("signaux: a drawn map is grabbed once after the 60 ms settle, no readback", async () => {
  const f = fakeMap();
  const s = await shoot(f, "signaux");
  await advance(SETTLE_MS - 1);
  assert.deepEqual(seen(f, s), [undefined, false, 0, 0, []]);
  await advance(1);
  assert.deepEqual(seen(f, s), ["ok", true, 1, 0, []]);
  assert.deepEqual(f.st.order, ["frame", "until", `wait ${SETTLE_MS}`, "grab"]);
});

withTimers("a map whose first capture would be blank is not shown", async () => {
  // loaded() at once, but no frame drawn since the jump: nothing is grabbed.
  const f = fakeMap();
  f.st.drawOnFrame = false;
  const s = await shoot(f, "signaux");
  await advance(5_000);
  assert.deepEqual(seen(f, s), [undefined, false, 0, 0, []]);
  f.render();
  await advance(40 + SETTLE_MS);
  assert.deepEqual(seen(f, s), ["ok", true, 1, 0, []]);

  // No frame ever: the ready wait times out at its first poll past 12 s.
  const g = fakeMap();
  g.st.drawOnFrame = false;
  const t = await shoot(g, "signaux");
  await advance(READY_TIMEOUT_MS);
  assert.equal(t.result(), undefined);
  await advance(40);
  assert.deepEqual(seen(g, t), ["timeout", false, 0, 0, []]);

  // "pixels" grabs that frame and rejects it on its readback: no lid either.
  const h = fakeMap();
  h.st.drawOnFrame = false;
  h.st.nextBlank = true;
  const u = await shoot(h, "pixels");
  await advance(SETTLE_MS);
  assert.deepEqual(seen(h, u), ["blank", false, 1, 1, [1]]);
});

withTimers("a canvas cleared during the settle ends undrawn, with nothing grabbed", async () => {
  const f = fakeMap();
  const s = await shoot(f, "signaux");
  await advance(30);
  f.resize();
  await advance(30);
  assert.deepEqual(seen(f, s), ["undrawn", false, 0, 0, []]);

  const g = fakeMap();
  const t = await shoot(g, "signaux");
  await advance(30);
  g.resize();
  g.render(); // drawn again after the clear
  await advance(30);
  assert.deepEqual(seen(g, t), ["ok", true, 1, 0, []]);
});

withTimers(
  "a lost context ends lost; after a restore and a render the next shot lands",
  async () => {
    // Lost before ready: never drawn since, so no grab (the wait ends at its timeout).
    const f = fakeMap();
    const s = await shoot(f, "signaux", () => (f.lose(), f.deliverLost()));
    await advance(READY_TIMEOUT_MS + 40);
    assert.ok(["timeout", "lost"].includes(s.result()?.end ?? ""), s.result()?.end);
    assert.equal(f.st.grabs, 0);

    // Lost during the settle, the event delivered; restored and drawn, the next shot lands.
    const g = fakeMap();
    const t = await shoot(g, "signaux");
    await advance(30);
    g.lose();
    g.deliverLost();
    await advance(40);
    assert.deepEqual(seen(g, t), ["lost", false, 0, 0, []]);
    g.restore();
    const t2 = await shoot(g, "signaux");
    await advance(SETTLE_MS);
    assert.deepEqual(seen(g, t2), ["ok", true, 1, 0, []]);

    // Lost during the settle, the canvas's event not delivered yet.
    const h = fakeMap();
    const u = await shoot(h, "signaux");
    await advance(30);
    h.lose();
    await advance(40);
    assert.deepEqual(seen(h, u), ["lost", false, 0, 0, []]);

    // Lost between the grab's call and its resolve: the copy is closed.
    const k = fakeMap();
    k.st.onGrab = k.lose;
    const v = await shoot(k, "signaux");
    await advance(SETTLE_MS);
    assert.deepEqual(seen(k, v), ["lost", false, 1, 0, [1]]);

    // A grab that rejects: "signaux" ends failed, "pixels" rejects as before.
    const m = fakeMap();
    m.st.rejectNext = true;
    const w = await shoot(m, "signaux");
    await advance(SETTLE_MS);
    assert.deepEqual([...seen(m, w), w.error()], ["failed", false, 1, 0, [], undefined]);
    const n = fakeMap();
    n.st.rejectNext = true;
    const x = await shoot(n, "pixels");
    await advance(SETTLE_MS);
    assert.equal(x.result(), undefined);
    assert.match(String(x.error()), /grab failed/);
  },
);

withTimers("an error since the jump runs the pixel check once", async () => {
  const f = fakeMap();
  f.st.nextBlank = true;
  const s = await shoot(f, "signaux", f.error);
  await advance(SETTLE_MS);
  assert.deepEqual(seen(f, s), ["blank", false, 1, 1, [1]]);

  const g = fakeMap();
  const t = await shoot(g, "signaux", g.error);
  await advance(SETTLE_MS);
  assert.deepEqual(seen(g, t), ["ok", true, 1, 1, []]);

  // An error before the jump is already in `at`.
  const h = fakeMap();
  h.error();
  const u = await shoot(h, "signaux");
  await advance(SETTLE_MS);
  assert.deepEqual(seen(h, u), ["ok", true, 1, 0, []]);
});

withTimers("pixels = today: loaded() alone, one readback per grab, in today's order", async () => {
  // No render since the jump: still grabbed (the ready condition is loaded()).
  const f = fakeMap();
  f.st.drawOnFrame = false;
  f.st.loaded = false;
  const s = await shoot(f, "pixels");
  await advance(80);
  assert.equal(f.st.grabs, 0);
  f.st.loaded = true;
  await advance(40 + SETTLE_MS);
  assert.deepEqual(seen(f, s), ["ok", true, 1, 1, []]);
  assert.deepEqual(f.st.order, ["frame", "until", `wait ${SETTLE_MS}`, "grab", "blank"]);

  const g = fakeMap();
  g.st.nextBlank = true;
  const t = await shoot(g, "pixels");
  await advance(SETTLE_MS);
  assert.deepEqual(seen(g, t), ["blank", false, 1, 1, [1]]);

  // "pixels" ignores the signals: a lost flag does not stop it.
  const h = fakeMap();
  const u = await shoot(h, "pixels", h.lose);
  await advance(SETTLE_MS);
  assert.deepEqual(seen(h, u), ["ok", true, 1, 1, []]);
});

withTimers("superseded at each await, the grab closed, no readback", async () => {
  for (const check of ["signaux", "pixels"] as const) {
    // After the ready wait.
    const f = fakeMap();
    f.st.loaded = false;
    const s = await shoot(f, check);
    await advance(40);
    f.st.current = false;
    f.st.loaded = true;
    await advance(40);
    assert.deepEqual(seen(f, s), ["superseded", false, 0, 0, []], check);
    // After the settle.
    const g = fakeMap();
    const t = await shoot(g, check);
    await advance(30);
    g.st.current = false;
    await advance(40);
    assert.deepEqual(seen(g, t), ["superseded", false, 0, 0, []], check);
    // After the grab.
    const h = fakeMap();
    h.st.onGrab = () => (h.st.current = false);
    const u = await shoot(h, check);
    await advance(SETTLE_MS);
    assert.deepEqual(seen(h, u), ["superseded", false, 1, 0, [1]], check);
  }
});

withTimers("a superseded shot does not poll to the timeout", async () => {
  // "signaux": ends within one poll of being superseded.
  const f = fakeMap();
  f.st.loaded = false;
  const s = await shoot(f, "signaux");
  await advance(200);
  f.st.current = false;
  await advance(40);
  assert.equal(s.result()?.end, "superseded");
  // "pixels" (the map still alive): within one poll of the shared map's next load.
  const g = fakeMap();
  g.st.loaded = false;
  const t = await shoot(g, "pixels");
  await advance(200);
  g.st.current = false;
  await advance(1_000);
  assert.equal(t.result(), undefined);
  g.st.loaded = true;
  await advance(40);
  assert.deepEqual(seen(g, t), ["superseded", false, 0, 0, []]);
});

test("uniformSample: a luminance range under 4, alpha ignored", () => {
  const px = (rgba: number[]) => Array.from({ length: 64 }, () => rgba).flat();
  assert.equal(uniformSample(px([120, 130, 140, 255])), true);
  const one = px([120, 120, 120, 255]);
  one.splice(20, 3, 124, 124, 124); // pixel 5, 4 luminance above the rest
  assert.equal(uniformSample(one), false);
  const alpha = px([10, 10, 10, 255]);
  alpha[3] = 0;
  alpha[7] = 128; // the stride skips alpha
  assert.equal(uniformSample(alpha), true);
  const near = px([0, 0, 0, 255]);
  near.splice(0, 3, 4, 4, 3.97); // range 3.99
  assert.equal(uniformSample(near), true);
});
