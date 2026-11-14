// The relief worker's body (demWorkerCore.ts), run without a Worker: the job
// order (sets before queued tiles), the key, the store's bounds and pins, the
// error replies. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRgbPng } from "../../../../../../scripts/parity/pngRgb";
import { demKey, keyJson, type Polygon } from "./demGeometry";
import { encodeHeight } from "./demRaster";
import { createDemWorkerCore, type DemJob, type DemReply } from "./demWorkerCore";

function square(lng: number, lat: number, d: number): Polygon {
  return [
    [
      [lng, lat],
      [lng + d, lat],
      [lng + d, lat + d],
      [lng, lat + d],
      [lng, lat],
    ],
  ];
}

function core(digest?: null) {
  const replies: DemReply[] = [];
  let waiters: (() => void)[] = [];
  const c = createDemWorkerCore(
    (r) => {
      replies.push(r);
      for (const w of waiters) w();
      waiters = [];
    },
    digest === null ? { digest: null } : {},
  );
  let id = 1;
  const send = (m: Omit<DemSetJob, "id"> | Omit<DemTileJob, "id">) => {
    const job = { ...m, id: id++ } as DemJob;
    c.receive(job);
    return job.id;
  };
  /** Resolves once `n` replies in all have come back. */
  const until = async (n: number) => {
    while (replies.length < n) await new Promise<void>((r) => waiters.push(r));
  };
  return { c, replies, send, until };
}
type DemSetJob = Extract<DemJob, { t: "set" }>;
type DemTileJob = Extract<DemJob, { t: "tile" }>;

const set = (polys: Polygon[], height: number, pins: string[] = []) =>
  ({ t: "set", json: keyJson(polys, height), height, pins }) as const;

test("order: a set goes before the tiles queued ahead of it, so its own tile renders", async () => {
  const w = core();
  const polysA = [square(2, 45, 1)];
  const polysB = [square(5, 45, 1)];
  const keyA = await demKey(polysA, 40);
  const keyB = await demKey(polysB, 40);
  w.send(set(polysA, 40));
  await w.until(1);
  const tA = w.send({ t: "tile", key: keyA, z: 6, x: 32, y: 22 }); // the pump takes it at once
  const tB1 = w.send({ t: "tile", key: keyB, z: 0, x: 0, y: 0 });
  const sB = w.send(set(polysB, 40));
  const tB2 = w.send({ t: "tile", key: keyB, z: 0, x: 0, y: 0 });
  await w.until(5);
  assert.deepEqual(
    w.replies.slice(1).map((r) => r.id),
    [tA, sB, tB1, tB2],
  );
  assert.equal(w.replies[2].key, keyB); // the server's key, computed here
  for (const r of w.replies.slice(3)) {
    assert.notEqual(r.kind, "unknown");
    assert.match(r.url!, /^data:image\/png;base64,/);
  }
});

test("a key not held answers unknown, a throw answers an error", async () => {
  const w = core();
  w.send({ t: "tile", key: "f00", z: 0, x: 0, y: 0 });
  w.send({ t: "set", json: "{not json", height: 40, pins: [] });
  await w.until(2);
  assert.equal(w.replies[0].kind, "unknown");
  assert.equal(w.replies[0].url, undefined);
  assert.ok(w.replies[1].error);
});

test("no crypto.subtle: the page-local f-key; a hit keeps the first height", async () => {
  const w = core(null);
  const polys = [square(2, 45, 4)];
  w.send(set(polys, 37.6));
  w.send(set(polys, 38.4)); // same rounded height: the same key
  await w.until(2);
  const key = w.replies[0].key!;
  assert.match(key, /^f[0-9a-f]{16}$/);
  assert.equal(w.replies[1].key, key);
  // A tile inside the square: the plateau constant, at the first height (37.6 m).
  w.send({ t: "tile", key, z: 10, x: 520, y: 360 });
  await w.until(3);
  assert.equal(w.replies[2].kind, "raster-plateau");
  const { rgb } = decodeRgbPng(Buffer.from(w.replies[2].url!.split(",")[1], "base64"));
  assert.deepEqual([...rgb.subarray(0, 3)], encodeHeight(37.6));
  assert.deepEqual(w.c.keys(), [key]);
});

test("a constant tile whose encode failed is not memoised: the next one encodes again", async () => {
  const w = core();
  const polys = [square(2, 45, 4)];
  w.send(set(polys, 40));
  await w.until(1);
  const key = w.replies[0].key!;
  const real = globalThis.CompressionStream;
  globalThis.CompressionStream = class {
    constructor() {
      throw new Error("deflate down");
    }
  } as unknown as typeof CompressionStream;
  try {
    w.send({ t: "tile", key, z: 10, x: 0, y: 0 }); // far from the square: the ground constant
    await w.until(2);
  } finally {
    globalThis.CompressionStream = real;
  }
  assert.ok(w.replies[1].error);
  w.send({ t: "tile", key, z: 10, x: 0, y: 0 });
  await w.until(3);
  assert.equal(w.replies[2].kind, "raster-ground");
  assert.equal(w.replies[2].error, undefined);
});

test("store: 40 versions, never a pinned key nor the one just set; and a vertex cap", async () => {
  const w = core(null);
  w.send(set([square(0, 0, 0.5)], 40));
  await w.until(1);
  const first = w.replies[0].key!;
  for (let i = 1; i <= 40; i++) w.send(set([square(i, 0, 0.5)], 40, [first]));
  await w.until(41);
  const keys = w.c.keys();
  assert.equal(keys.length, 40);
  assert.ok(keys.includes(first));
  assert.ok(!keys.includes(w.replies[1].key!)); // the oldest unpinned one went
  // Two selections of 500,001 vertices: past 1,000,000 the older one goes.
  const ring = (lng: number) => Array.from({ length: 500_001 }, (_, i) => [lng + i / 1e7, 0]);
  w.send({ t: "set", json: keyJson([[ring(10) as never]], 40), height: 40, pins: [first] });
  w.send({ t: "set", json: keyJson([[ring(20) as never]], 40), height: 40, pins: [first] });
  await w.until(43);
  const after = w.c.keys();
  assert.ok(after.includes(first));
  assert.ok(!after.includes(w.replies[41].key!));
  assert.equal(after.at(-1), w.replies[42].key);
});

test("store: the bounds a set carries are the ones in force, the pinned key and the one just set stay", async () => {
  const w = core(null);
  w.send(set([square(0, 0, 0.5)], 40));
  await w.until(1);
  const first = w.replies[0].key!;
  for (let i = 1; i <= 5; i++) w.send(set([square(i, 0, 0.5)], 40, [first]));
  await w.until(6);
  assert.equal(w.c.keys().length, 6); // no bounds carried: the store's own (40)
  // Three versions from now on: the pinned one, and the two newest.
  w.send({ ...set([square(6, 0, 0.5)], 40, [first]), caps: { versions: 3, vertices: 1_000_000 } });
  await w.until(7);
  assert.deepEqual(w.c.keys(), [first, w.replies[5].key, w.replies[6].key]);
  // A vertex bound under what is stored: only the pinned key and the one just set stay.
  w.send({ ...set([square(7, 0, 0.5)], 40, [first]), caps: { versions: 3, vertices: 1 } });
  await w.until(8);
  assert.deepEqual(w.c.keys(), [first, w.replies[7].key]);
});
