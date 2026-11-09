// The client relief's shell (demClient.ts) against a fake Worker: the worker's
// `ready` kept out of the answer policy, and its health — an error event, a
// constructor that throws, a worker silent 10 s after its first job — each
// ending on the main thread, and both renderers failing calling onLost once.
// Run with `node --import tsx --test` (root "test:scripts"). No DOM: the fake
// worker runs the real worker core (demWorkerCore.ts) in this thread.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { keyJson, keyOfJson, polysOf } from "./demGeometry";
import { GROUND_DATA_URL } from "./demGround";
import { FrameBudget } from "./demTiles";
import { createDemWorkerCore, type DemJob, type DemReply } from "./demWorkerCore";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean };
g.__TEST_TOOLS__ = false;
const { READY_TIMEOUT_MS, commitHold, createReliefClient } = await import("./demClient");
const { DEFAULT_RELIEF_COMMIT_HOLD_MS } = await import("./reliefSwitch");
type ReliefWorker = import("./demClient").ReliefWorker;

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

// Lyon-sized, so the z10 tile 525/365 holds its edge.
const RING = [
  [4.77, 45.7],
  [4.9, 45.7],
  [4.9, 45.8],
  [4.77, 45.8],
  [4.77, 45.7],
];
const lyon = () => [{ type: "Feature", geometry: { type: "Polygon", coordinates: [RING] } }];
const EDGE = "10/525/365";

type Behaviour = "core" | "silent" | "tile-error";

class FakeWorker implements ReliefWorker {
  onmessage: ReliefWorker["onmessage"] = null;
  onerror: ReliefWorker["onerror"] = null;
  onmessageerror: ReliefWorker["onmessageerror"] = null;
  posted: DemJob[] = [];
  terminated = false;
  private core = createDemWorkerCore((r) => this.send(r));
  constructor(
    private behaviour: Behaviour,
    hello: boolean,
  ) {
    if (hello) this.send({ t: "ready" });
  }
  send(m: DemReply | { t: "ready" }) {
    setImmediate(() => {
      if (!this.terminated) this.onmessage?.({ data: m });
    });
  }
  postMessage(m: DemJob) {
    this.posted.push(m);
    if (this.behaviour === "silent") return;
    if (this.behaviour === "tile-error" && m.t === "tile")
      return this.send({ id: m.id, error: "x" });
    this.core.receive(m);
  }
  terminate() {
    this.terminated = true;
  }
}

function rig(
  behaviour: Behaviour,
  over: { hello?: boolean; throws?: boolean; raster?: boolean } = {},
) {
  const workers: FakeWorker[] = [];
  let lost = 0;
  const c = createReliefClient({
    makeWorker: () => {
      if (over.throws) throw new Error("no module workers");
      const w = new FakeWorker(behaviour, over.hello ?? true);
      workers.push(w);
      return w;
    },
    loadRaster: () =>
      over.raster === false ? Promise.reject(new Error("chunk")) : import("./demRaster"),
    budget: new FrameBudget(0),
    stats: true,
    onLost: () => lost++,
  });
  return { c, workers, lost: () => lost };
}

const expectedKey = () => keyOfJson(keyJson(polysOf(lyon()), 40.4));

test("the worker's ready is no reply: the worker keys and renders", async () => {
  const { c, workers } = rig("core");
  c.warm();
  assert.equal(c.mode, "worker");
  await flush();
  const { key } = await c.registerSelection(lyon(), 40.4);
  assert.equal(key, await expectedKey());
  const { url } = await c.answer(`ac-dem://${key}/${EDGE}`);
  assert.match(url, /^data:image\/png;base64,/);
  assert.notEqual(url, GROUND_DATA_URL);
  assert.equal(c.stats()?.late, 0);
  assert.equal(c.mode, "worker");
  assert.deepEqual(
    workers[0].posted.map((m) => m.t),
    ["set", "tile"],
  );
});

test("an error event: terminated, the pending call answered on the main thread", async () => {
  const { c, workers } = rig("silent");
  c.warm();
  const p = c.registerSelection(lyon(), 40.4);
  await flush();
  workers[0].onerror?.(new Event("error"));
  assert.equal(workers[0].terminated, true);
  assert.equal(c.mode, "main");
  const { key } = await p;
  assert.equal(key, await expectedKey());
  const { url } = await c.answer(`ac-dem://${key}/${EDGE}`);
  assert.notEqual(url, GROUND_DATA_URL);
  assert.equal(workers[0].posted.length, 1); // the set only: nothing more went to it
});

test("a Worker constructor that throws: the main thread from the start", async () => {
  const { c } = rig("core", { throws: true });
  c.warm();
  assert.equal(c.mode, "main");
  const { key } = await c.registerSelection(lyon(), 40.4);
  assert.equal(key, await expectedKey());
});

test("a worker silent 10 s after its first job: the main thread", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { c, workers } = rig("silent", { hello: false });
  c.warm();
  mock.timers.tick(5 * READY_TIMEOUT_MS); // no job yet: nothing armed
  assert.equal(c.mode, "worker");
  const p = c.registerSelection(lyon(), 40.4);
  await flush();
  mock.timers.tick(READY_TIMEOUT_MS - 1);
  assert.equal(c.mode, "worker");
  mock.timers.tick(1);
  mock.timers.tick(0);
  assert.equal(c.mode, "main");
  assert.equal(workers[0].terminated, true);
  assert.equal((await p).key, await expectedKey());
});

test("a late ready disarms the timer: the worker stays", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { c, workers } = rig("silent", { hello: false });
  void c.registerSelection(lyon(), 40.4);
  await flush();
  mock.timers.tick(READY_TIMEOUT_MS - 1);
  workers[0].onmessage?.({ data: { t: "ready" } });
  mock.timers.tick(10 * READY_TIMEOUT_MS);
  assert.equal(c.mode, "worker");
  assert.equal(workers[0].terminated, false);
  assert.equal(c.stats()?.late, 0);
});

test("both renderers failing: ground, and onLost once", async () => {
  const { c, lost } = rig("tile-error", { raster: false });
  const { key } = await c.registerSelection(lyon(), 40.4);
  const a = await c.answer(`ac-dem://${key}/${EDGE}`);
  const b = await c.answer(`ac-dem://${key}/9/262/182`);
  assert.equal(a.url, GROUND_DATA_URL);
  assert.equal(b.url, GROUND_DATA_URL);
  assert.equal(c.stats()?.failedRender, 2);
  assert.equal(lost(), 1);
  // Lost for the session: a later selection's registration rejects (no plateau).
  await assert.rejects(c.registerSelection(lyon(), 80), /relief client lost/);
});

test("commitHold: resolves once the default hold has passed, not before", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const p = commitHold().then(() => (done = true));
    mock.timers.tick(DEFAULT_RELIEF_COMMIT_HOLD_MS - 1);
    await flush();
    assert.equal(done, false);
    mock.timers.tick(1);
    await p;
    assert.equal(done, true);
  } finally {
    mock.timers.reset();
  }
});

test("commitHold: another hold is kept to, and 0 sets no timer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const p = commitHold(30).then(() => (done = true));
    mock.timers.tick(29);
    await flush();
    assert.equal(done, false);
    mock.timers.tick(1);
    await p;
    assert.equal(done, true);
    let zero = false;
    const z = commitHold(0).then(() => (zero = true));
    await flush(); // no tick: resolved without a timer
    assert.equal(zero, true);
    await z;
  } finally {
    mock.timers.reset();
  }
});
