// The client relief's answer policy (demAnswer.ts) behind a fake worker port:
// which tiles go to the worker, what is cached, the re-registration of a lost
// key, the main-thread fallbacks and the failover. Run with `node --import tsx
// --test` (root "test:scripts"). Pure: no Worker, no DOM, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemAnswer, type DemAnswerPort } from "./demAnswer";
import { SelectionTooLarge, type Polygon } from "./demGeometry";
import { makeSelection } from "./demRaster";
import { FrameBudget, fnv1a64, type FrameScheduler } from "./demTiles";
import type { DemJob, DemReply } from "./demWorkerCore";

const flush = () => new Promise((r) => setImmediate(r));

function rect(lng0: number, lat0: number, lng1: number, lat1: number) {
  const ring = [
    [lng0, lat0],
    [lng1, lat0],
    [lng1, lat1],
    [lng0, lat1],
    [lng0, lat0],
  ];
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] } };
}

type Handler = (m: DemJob) => Omit<DemReply, "id"> | null;

// The worker as the tests' puppet: a set answers a key and the box, a tile a URL.
const worker: Handler = (m) => {
  if (m.t === "tile") return { url: `w:${m.key}/${m.z}/${m.x}/${m.y}`, kind: "raster", ms: 1 };
  const { polys } = JSON.parse(m.json) as { polys: Polygon[] };
  return { key: "f" + fnv1a64(m.json), bbox: makeSelection(polys, m.height).bbox, vertices: 5 };
};

const mainSet: DemAnswerPort["mainSet"] = async (json, height) => {
  const { polys } = JSON.parse(json) as { polys: Polygon[] };
  return { key: "f" + fnv1a64(json), bbox: makeSelection(polys, height).bbox, vertices: 5 };
};

function rig(over: Partial<DemAnswerPort> = {}) {
  const sent: DemJob[] = [];
  const queue: DemJob[] = [];
  let handler: Handler = worker;
  const a = createDemAnswer({
    post: (m) => (sent.push(m), queue.push(m)),
    ground: "G",
    now: () => performance.now(),
    budget: new FrameBudget(0),
    stats: true,
    ...over,
  });
  let tilesFirst = false;
  /** Answer everything posted, as often as it takes, until nothing more is posted. */
  async function drain() {
    for (let quiet = 0; quiet < 3;) {
      await flush();
      const ms = queue.splice(0);
      // A hostile worker: the batch's tiles before its sets.
      if (tilesFirst) ms.sort((p, q) => (p.t === q.t ? 0 : p.t === "tile" ? -1 : 1));
      quiet = ms.length ? 0 : quiet + 1;
      for (const m of ms) {
        const r = handler(m);
        if (r) a.receive({ id: m.id, ...r });
      }
    }
  }
  const use = (h: Handler, hostile = false) => ((handler = h), (tilesFirst = hostile));
  const tiles = () => sent.filter((m) => m.t === "tile");
  const sets = () => sent.filter((m) => m.t === "set");
  return { a, sent, queue, drain, use, tiles, sets };
}

async function registered(r: ReturnType<typeof rig>, features: object[], height = 40) {
  const p = r.a.registerSelection(features, height);
  await r.drain();
  return (await p).key;
}

const url = (key: string, z: number, x: number, y: number) => `ac-dem://${key}/${z}/${x}/${y}`;

async function answered(r: ReturnType<typeof rig>, u: string, signal?: AbortSignal) {
  const p = r.a.answer(u, { signal });
  await r.drain();
  return (await p).url;
}

test("memo: the same geometries register once; another second feature registers again", async () => {
  const r = rig();
  const f1 = rect(2, 45, 3, 46);
  const f2 = rect(4, 45, 5, 46);
  const k1 = await registered(r, [f1, f2]);
  assert.equal(await registered(r, [f1, f2], 40.4), k1); // same rounded height
  assert.equal(r.sets().length, 1);
  const k2 = await registered(r, [f1, rect(4, 45, 5, 46.5)]);
  assert.notEqual(k2, k1);
  assert.equal(r.sets().length, 2);
  assert.equal(r.a.stats()!.registerHits, 1);
});

test("classification: z0 touches, a seam's neighbour within PAD touches, the next does not", async () => {
  const r = rig();
  // West of the Greenwich meridian, ending on it: at z4 the seam is x = 7 | 8.
  const key = await registered(r, [rect(-10, 40, 0, 50)]);
  assert.equal(await answered(r, url(key, 0, 0, 0)), `w:${key}/0/0/0`);
  assert.equal(await answered(r, url(key, 4, 7, 5)), `w:${key}/4/7/5`);
  assert.equal(await answered(r, url(key, 4, 8, 5)), `w:${key}/4/8/5`); // within PAD
  assert.equal(await answered(r, url(key, 4, 9, 5)), "G");
  assert.equal(r.tiles().length, 3); // ground never went to the worker
});

test("classification: PAD + 1 texel, at z10, both sides of the limit", async () => {
  const r = rig();
  const ws = 256 * 2 ** 10;
  const lng = (px: number) => (px / ws) * 360 - 180;
  const limit = 600 * 256 - 5 - 1; // tileTouches: x * SIZE - PAD - 1
  const near = await registered(r, [rect(lng(limit - 400), 0, lng(limit + 0.25), 0.1)]);
  const far = await registered(r, [rect(lng(limit - 400), 0, lng(limit - 0.25), 0.1)]);
  const y = 511; // the row just north of the equator
  assert.equal(await answered(r, url(near, 10, 600, y)), `w:${near}/10/600/${y}`);
  assert.equal(await answered(r, url(far, 10, 600, y)), "G");
});

test("classification: a ring at lng 179.9 touches the last column, not the first (no wrap)", async () => {
  const r = rig();
  const key = await registered(r, [rect(179.5, 10, 179.9, 11)]);
  assert.equal(await answered(r, url(key, 3, 7, 3)), `w:${key}/3/7/3`);
  assert.equal(await answered(r, url(key, 3, 0, 3)), "G");
  assert.equal(r.tiles().length, 1);
});

test("ground and malformed: a non-touching tile is cached, malformed and orphans are not", async () => {
  const r = rig();
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  await answered(r, url(key, 5, 0, 0));
  await answered(r, url(key, 5, 0, 0));
  assert.equal(await answered(r, "ac-dem://x/1/9/9"), "G");
  assert.equal(await answered(r, url("f00", 1, 0, 0)), "G");
  assert.equal(await answered(r, url("f00", 1, 0, 0)), "G"); // asked again: not a cache hit
  const s = r.a.stats()!;
  assert.deepEqual([s.ground, s.cached, s.malformed, s.orphan], [1, 1, 1, 2]);
  assert.equal(r.tiles().length, 0);
});

test("a lost key: the set is re-sent once, with the first unrounded height, awaited, then the tile", async () => {
  const r = rig();
  const key = await registered(r, [rect(2, 45, 3, 46)], 37.6);
  // Equal coordinates in other objects, a height with the same rounding: same key, first record kept.
  assert.equal(await registered(r, [rect(2, 45, 3, 46)], 38.4), key);
  let lost = true;
  r.use((m) => {
    if (m.t === "tile" && lost) return { kind: "unknown", ms: 0 };
    if (m.t === "set") lost = false;
    return worker(m);
  }, true);
  const urls = await Promise.all([
    answered(r, url(key, 0, 0, 0)),
    answered(r, url(key, 1, 1, 0)), // both see "unknown": still one set
  ]);
  assert.deepEqual(urls, [`w:${key}/0/0/0`, `w:${key}/1/1/0`]);
  const sets = r.sets() as Extract<DemJob, { t: "set" }>[];
  assert.equal(sets.length, 3);
  assert.equal(sets[2].height, 37.6);
  // The retried tiles were posted only after the re-sent set.
  const order = r.sent.map((m) => m.t).slice(2);
  assert.deepEqual(order, ["tile", "tile", "set", "tile", "tile"]);
});

test("a failing job is not cached: main render once, then retried by the next request", async () => {
  const lost: string[] = [];
  let mainOk = true;
  const r = rig({
    mainRender: async (rec, z, x, y) => {
      if (!mainOk) throw new Error("no renderer");
      return `m:${rec.key}/${z}/${x}/${y}`;
    },
    onClientLost: () => lost.push("lost"),
  });
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  r.use((m) => (m.t === "tile" ? { error: "boom" } : worker(m)));
  assert.equal(await answered(r, url(key, 0, 0, 0)), `m:${key}/0/0/0`);
  mainOk = false;
  assert.equal(await answered(r, url(key, 0, 0, 0)), "G"); // both failed: ground, uncached
  assert.deepEqual(lost, ["lost"]);
  r.use(worker);
  assert.equal(await answered(r, url(key, 0, 0, 0)), `w:${key}/0/0/0`);
  assert.equal(r.tiles().length, 3);
  assert.equal(r.a.stats()!.failedRender, 1);
});

test("an aborted request is not posted and not cached", async () => {
  const r = rig();
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await answered(r, url(key, 0, 0, 0), ac.signal), "G");
  assert.equal(r.tiles().length, 0);
  assert.equal(await answered(r, url(key, 0, 0, 0)), `w:${key}/0/0/0`);
});

test("an aborted request's job: a live request sharing it still gets the worker render", async () => {
  const r = rig();
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  const ac = new AbortController();
  const first = r.a.answer(url(key, 0, 0, 0), { signal: ac.signal });
  ac.abort();
  const live = r.a.answer(url(key, 0, 0, 0)); // a cache hit on the first one's job
  await r.drain();
  assert.equal((await first).url, "G");
  assert.equal((await live).url, `w:${key}/0/0/0`);
  assert.equal(r.tiles().length, 1);
});

test("an abort while the lost key's set is re-sent skips the retried tile", async () => {
  const r = rig();
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  const ac = new AbortController();
  const p = r.a.answer(url(key, 0, 0, 0), { signal: ac.signal });
  await flush();
  const [tile] = r.queue.splice(0);
  r.a.receive({ id: tile.id, kind: "unknown", ms: 0 });
  await flush();
  assert.deepEqual(
    r.queue.map((m) => m.t),
    ["set"],
  );
  ac.abort();
  await r.drain();
  assert.equal((await p).url, "G");
  assert.deepEqual(
    r.sent.map((m) => m.t),
    ["set", "tile", "set"],
  );
  assert.equal(await answered(r, url(key, 0, 0, 0)), `w:${key}/0/0/0`); // not cached
});

test("failover: every pending call resolves on the main thread, late replies are dropped", async () => {
  const r = rig({ mainSet, mainRender: async (rec, z, x, y) => `m:${rec.key}/${z}/${x}/${y}` });
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  const tile = r.a.answer(url(key, 0, 0, 0));
  const reg = r.a.registerSelection([rect(5, 45, 6, 46)], 40);
  await flush();
  const stuck = r.queue.splice(0); // the worker never answers these
  assert.equal(stuck.length, 2);
  r.a.failover();
  assert.equal(r.a.mode, "main");
  assert.equal((await tile).url, `m:${key}/0/0/0`);
  const k2 = (await reg).key;
  assert.equal((await r.a.answer(url(k2, 0, 0, 0))).url, `m:${k2}/0/0/0`);
  for (const m of stuck) r.a.receive({ id: m.id, ...worker(m) });
  assert.equal(r.a.stats()!.late, 2);
  assert.equal(r.queue.length, 0); // nothing posted after the failover
});

test("main mode: a tile failing on the main thread is not rendered there twice", async () => {
  const lost: string[] = [];
  let renders = 0;
  const r = rig({
    mainSet,
    mainRender: async () => {
      renders++;
      throw new Error("no renderer");
    },
    onClientLost: () => lost.push("lost"),
  });
  r.a.failover();
  const { key } = await r.a.registerSelection([rect(2, 45, 3, 46)], 40);
  assert.equal((await r.a.answer(url(key, 0, 0, 0))).url, "G");
  assert.equal(renders, 1);
  assert.deepEqual(lost, ["lost"]);
  assert.equal(r.sent.length, 0);
});

test("SelectionTooLarge above MAX_SELECTION_VERTICES, nothing posted", async () => {
  const r = rig();
  const ring = Array.from({ length: 250_001 }, (_, i) => [i / 1e6, 0]);
  const big = { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] } };
  await assert.rejects(r.a.registerSelection([big], 40), SelectionTooLarge);
  assert.equal(r.sent.length, 0);
});

test("records: a held key survives the 40-entry LRU, an unheld one is evicted", async () => {
  const r = rig();
  const first = await registered(r, [rect(0, 0, 0.5, 0.5)]);
  const second = await registered(r, [rect(1, 0, 1.5, 0.5)]);
  r.a.holdSlot("a", first);
  for (let i = 0; i < 40; i++) await registered(r, [rect(2 + i, 0, 2.5 + i, 0.5)]);
  assert.equal(await answered(r, url(first, 0, 0, 0)), `w:${first}/0/0/0`);
  assert.equal(await answered(r, url(second, 0, 0, 0)), "G");
  assert.equal(r.a.stats()!.orphan, 1);
  // The held key went to the worker as a pin with every later set.
  const last = r.sets().at(-1) as Extract<DemJob, { t: "set" }>;
  assert.deepEqual(last.pins, [first]);
  r.a.releaseSlot("a");
});

test("stats off: no counters", async () => {
  const r = rig({ stats: false });
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  await answered(r, url(key, 0, 0, 0));
  assert.equal(r.a.stats(), null);
});

// demTiles.test.ts's scheduler: frames and timers run only when the test says.
function fakeScheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let n = 0;
  const run = (m: Map<number, () => void>) => {
    const cbs = [...m.values()];
    m.clear();
    for (const cb of cbs) cb();
  };
  const sched: FrameScheduler = {
    frame: (cb) => (frames.set(++n, cb), n),
    cancelFrame: (h) => frames.delete(h as number),
    timer: (cb) => (timers.set(++n, cb), n),
    cancelTimer: (h) => timers.delete(h as number),
  };
  return { sched, frames, timers, frame: () => run(frames), timer: () => run(timers) };
}

/** Each answer's settlements, counted: every request resolves exactly once. */
function settled(p: Promise<{ url: string }>, log: string[]) {
  return p.then((r) => (log.push(r.url), r.url));
}

test("groundFree: box-test and cached ground skip the budget, a rendered answer waits its turn", async () => {
  const f = fakeScheduler();
  const r = rig({ budget: new FrameBudget(1, f.sched), groundFree: true });
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  const log: string[] = [];
  const box = settled(r.a.answer(url(key, 5, 0, 0)), log); // misses the box: ground
  const rendered = settled(r.a.answer(url(key, 0, 0, 0)), log);
  await r.drain();
  assert.deepEqual(log, ["G"]); // no turn taken
  assert.equal(f.frames.size, 1); // the rendered one is queued
  const cachedGround = settled(r.a.answer(url(key, 5, 0, 0)), log);
  await r.drain();
  assert.deepEqual(log, ["G", "G"]);
  assert.equal(r.a.stats()!.budgetWaitMax, 0); // ground never waited
  f.frame();
  await r.drain();
  assert.deepEqual(await Promise.all([box, rendered, cachedGround]), ["G", `w:${key}/0/0/0`, "G"]);
  assert.deepEqual(log, ["G", "G", `w:${key}/0/0/0`]);
  const s = r.a.stats()!;
  assert.deepEqual([s.ground, s.cached, s.rasterised, s.budgetSkips], [1, 1, 1, 2]);
});

test("groundFree off: every answer waits for a turn (one per frame), each resolves once", async () => {
  const f = fakeScheduler();
  const r = rig({ budget: new FrameBudget(1, f.sched) });
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  const log: string[] = [];
  const all = [
    settled(r.a.answer(url(key, 5, 0, 0)), log),
    settled(r.a.answer(url(key, 5, 1, 0)), log),
    settled(r.a.answer(url(key, 0, 0, 0)), log),
  ];
  await r.drain();
  assert.deepEqual(log, []);
  for (let i = 1; i <= 3; i++) {
    f.frame();
    await r.drain();
    assert.equal(log.length, i);
  }
  f.frame();
  await r.drain();
  assert.deepEqual(await Promise.all(all), ["G", "G", `w:${key}/0/0/0`]);
  assert.equal(log.length, 3);
  assert.equal(r.a.stats()!.budgetSkips, 0);
});

test("groundFree: the delay arm still delays a ground answer", async () => {
  const f = fakeScheduler();
  const r = rig({ budget: new FrameBudget(1, f.sched), groundFree: true, delayMs: 30 });
  const key = await registered(r, [rect(2, 45, 3, 46)]);
  const log: string[] = [];
  const p = settled(r.a.answer(url(key, 5, 0, 0)), log);
  await r.drain();
  assert.deepEqual(log, []);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(await p, "G");
  assert.deepEqual(log, ["G"]);
  assert.equal(f.frames.size, 0); // no turn asked for
});
