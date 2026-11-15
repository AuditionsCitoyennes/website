// The page's side of the mesh worker (meshClientCore.ts), over a fake
// transport: a real worker core (meshCore.ts) in this thread, every message
// structured-cloned with its transfer list both ways, and a fake clock. Token
// reuse, eviction and resend, pinned tokens, the miss safety net, single
// flight, superseding, every way the worker can be lost, dispose — and
// build() never rejecting; the grey sheet's cuts (cutTint) over the same
// tokens, never cut here. No __TEST_TOOLS__ stub on purpose: nothing here
// may read it. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { OutlineFC } from "../types";
import { buildPlateauMesh } from "./meshBuild";
import { createMeshClient, type MeshInputs, type MeshResult } from "./meshClientCore";
import {
  createMeshCore,
  type MeshMessage,
  type MeshReply,
  type MeshRequest,
  type TintRequest,
} from "./meshCore";
import { meshBuffers, type Geom } from "./meshFlat";
import { cutTintSheet } from "./tintSheet";

const rejections: unknown[] = [];
process.on("unhandledRejection", (e) => rejections.push(e));
after(() => assert.deepEqual(rejections, [], "build() never rejects"));

type Feature = OutlineFC["features"][number];
const square = (id: string, x: number, y: number, s: number, level = "departement"): Feature => ({
  type: "Feature",
  properties: { id, level },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x, y],
        [x + s, y],
        [x + s, y + s],
        [x, y + s],
        [x, y],
      ],
    ],
  },
});

/** A scope, a child, a context sibling: 3 geometries of 5 vertices. Fresh
 *  objects each call (tokens are per geometry object). */
function inputs(x = 4, heightM = 1500): MeshInputs {
  return {
    features: [square(`fr:dep:${x}`, x, 45, 1)],
    focus: [
      square(`fr:com:${x}`, x + 0.2, 45.2, 0.3, "commune"),
      { type: "Feature", properties: { id: "none" }, geometry: null } as Feature,
    ],
    context: [square(`fr:reg:${x}`, x + 1.2, 45, 0.8, "region")],
    heightM,
  };
}

const BOTH = { merc: true, globe: true };

function rig(
  opts: {
    cap?: number;
    knobs?: Pick<MeshRequest, "delayMs" | "slow" | "fail">;
    noTransport?: boolean;
    dropPuts?: boolean;
    fallbackThrows?: boolean;
    leanLines?: boolean;
  } = {},
) {
  let now = 0;
  let timers: { fn: () => void; at: number }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { fn, at: now + ms };
    timers.push(t);
    return () => {
      timers = timers.filter((x) => x !== t);
    };
  };
  /** Every task due within `ms`, in time order (those they add included). */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = end;
  };
  const inbox: MeshMessage[] = [];
  const outbox: MeshReply[] = [];
  const posted: MeshMessage[] = [];
  let terminated = 0;
  let handlers: { reply(m: MeshReply): void; fail(why: string): void } | null = null;
  const core = createMeshCore({
    post: (r) =>
      outbox.push(
        structuredClone(r, {
          transfer:
            r.t === "mesh" ? meshBuffers(r.mesh) : r.t === "tint" ? [r.positions.buffer] : [],
        }),
      ),
    schedule: (fn, ms) => void schedule(fn, ms),
  });
  let fallbacks = 0;
  const client = createMeshClient({
    transport(on) {
      if (opts.noTransport) throw new Error("no module workers");
      handlers = on;
      return {
        post(msg, transfer) {
          posted.push(msg);
          inbox.push(structuredClone(msg, { transfer }));
        },
        terminate: () => void terminated++,
      };
    },
    now: () => now,
    schedule,
    fallbackBuild(i, want) {
      fallbacks++;
      if (opts.fallbackThrows) throw new Error("baseOf");
      return buildPlateauMesh(i.features, i.heightM, i.focus, i.context, { ...want, concat: true });
    },
    capVertices: () => opts.cap ?? 300_000,
    knobs: () => opts.knobs ?? {},
    leanLines: opts.leanLines,
  });
  /** The worker reads what was posted and runs its due tasks. */
  const work = () => {
    while (inbox.length) {
      const m = inbox.shift()!;
      core.receive(opts.dropPuts && m.t === "build" ? { ...m, puts: [] } : m);
    }
    advance(0);
  };
  /** Its replies reach the page; then the promise jobs run. */
  const deliver = async () => {
    while (outbox.length) handlers!.reply(outbox.shift()!);
    await new Promise((r) => setImmediate(r));
  };
  /** Back and forth until quiet. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      work();
      await deliver();
      if (!inbox.length && !outbox.length) break;
    }
  };
  const builds = () => posted.filter((m): m is MeshRequest => m.t === "build");
  const tints = () => posted.filter((m): m is TintRequest => m.t === "tint");
  const releases = () => posted.filter((m) => m.t === "release");
  return {
    client,
    core,
    work,
    deliver,
    flush,
    advance,
    builds,
    tints,
    releases,
    fail: (why: string) => handlers!.fail(why),
    terminated: () => terminated,
    fallbacks: () => fallbacks,
  };
}

test("a geometry travels once: the next request names its tokens only", async () => {
  const r = rig();
  const fx = inputs();
  const p1 = r.client.build(fx, BOTH);
  await r.flush();
  const a = (await p1)!;
  assert.equal(a.via, "worker");
  assert.equal(a.mesh.scopeId, "fr:dep:4");
  assert.equal(r.builds()[0].puts.length, 3);
  // The geometries' buffers went transferred: the page kept no copy.
  assert.equal(r.builds()[0].puts[0].flat.coords.byteLength, 0);
  const p2 = r.client.build({ ...fx, heightM: 1600 }, BOTH);
  await r.flush();
  assert.equal((await p2)!.via, "worker");
  assert.equal(r.builds()[1].puts.length, 0);
  assert.deepEqual(r.builds()[1].scope.tokens, r.builds()[0].scope.tokens);
  // The same bytes as a build here.
  const here = buildPlateauMesh(fx.features, 1500, fx.focus, fx.context, { ...BOTH, concat: true });
  assert.deepEqual(
    Buffer.from(a.mesh.linePositions!.buffer),
    Buffer.from(here.linePositions!.buffer),
  );
});

test("the session's line layout goes with every build: the worker's, the globe pass's and the fallback's", async () => {
  const r = rig({ leanLines: true });
  const fx = inputs();
  const p = r.client.build(fx, { merc: true, globe: false });
  await r.flush();
  const a = (await p)!;
  assert.equal(a.via, "worker");
  assert.deepEqual(r.builds()[0].want, { merc: true, globe: false, lean: true });
  assert.equal(a.mesh.lineLayout, "lean");
  const g = r.client.buildGlobe(fx);
  await r.flush();
  assert.deepEqual(r.builds()[1].want, { merc: false, globe: true, lean: true });
  const globe = (await g)!;
  assert.equal(globe.mesh.lineLayout, "lean");
  // 4 + 4 segments, one record each.
  assert.equal(a.mesh.linePositions!.length, 8 * 6);
  assert.equal(globe.mesh.gLinePositions!.length, 8 * 18);
  // The worker lost: the fallback builds the same layout.
  r.fail("error");
  const here = (await r.client.build(inputs(8), BOTH))!;
  assert.equal(here.via, "main");
  assert.equal(here.mesh.lineLayout, "lean");
  // A session without it asks for nothing more than before.
  const plain = rig();
  const q = plain.client.build(inputs(), BOTH);
  await plain.flush();
  assert.deepEqual(plain.builds()[0].want, BOTH);
  assert.equal((await q)!.mesh.lineLayout, "full");
});

test("a mesh with no unit, the lines alone, is the page's own bit for bit", async () => {
  const r = rig();
  const fx = { ...inputs(), features: [], heightM: 0 };
  const p = r.client.build(fx, BOTH);
  await r.flush();
  const a = (await p)!;
  assert.equal(a.via, "worker");
  assert.equal(a.mesh.scopeId, "");
  assert.equal(a.mesh.vertexCount, 0);
  assert.ok(a.mesh.lineVertexCount > 0);
  // Only the lines' geometries travelled: the focus square and the context one.
  assert.equal(r.builds()[0].puts.length, 2);
  assert.deepEqual(r.builds()[0].scope, { tokens: [], meta: [] });
  const here = buildPlateauMesh([], 0, fx.focus, fx.context, { ...BOTH, concat: true });
  for (const k of [
    "rim",
    "positions",
    "lidPositions",
    "linePositions",
    "haloPositions",
    "gWallPositions",
    "gLidPositions",
    "gLinePositions",
    "gHaloPositions",
  ] as const) {
    assert.deepEqual(Buffer.from(a.mesh[k]!.buffer), Buffer.from(here[k]!.buffer), k);
  }
  for (const k of [
    "scopeId",
    "heightM",
    "rimCount",
    "vertexCount",
    "lidVertexCount",
    "lineVertexCount",
    "haloVertexCount",
    "origin",
    "lineGroups",
    "haloW",
    "haloCos",
    "fillRecords",
  ] as const) {
    assert.deepEqual(a.mesh[k], here[k], k);
  }
});

test("eviction past the cap, then the same geometry asked again: sent again", async () => {
  // Room for one request's 15 vertices: least recently used first, down to the cap.
  const r = rig({ cap: 15 });
  const fx = inputs(4);
  const p1 = r.client.build(fx, BOTH);
  await r.flush();
  await p1;
  // Not applied, not in flight: the first request's tokens go.
  const p2 = r.client.build(inputs(8), BOTH);
  await r.flush();
  assert.equal((await p2)!.via, "worker");
  assert.equal(r.releases().length, 1);
  assert.deepEqual(r.releases()[0], { t: "release", tokens: [1, 2, 3] });
  assert.deepEqual(r.core.held(), { tokens: 3, vertices: 15 });
  const p3 = r.client.build(fx, BOTH);
  await r.flush();
  const c = (await p3)!;
  assert.equal(c.via, "worker");
  const resend = r.builds()[2];
  assert.equal(resend.puts.length, 3);
  assert.deepEqual(resend.scope.tokens, [7]);
  const s = r.client.stats();
  assert.equal(s.evicted, 6);
  assert.equal(s.misses, 0);
  assert.equal(s.liveVertices, 15);
});

test("pinned tokens (in flight, last applied) are never released", async () => {
  const r = rig({ cap: 10 });
  const fx = inputs(4);
  const p1 = r.client.build(fx, BOTH);
  await r.flush();
  r.client.applied((await p1)!);
  // In flight and last applied: both pinned, over the cap (allowed).
  const p2 = r.client.build(inputs(8), BOTH);
  const p3 = r.client.build(inputs(12), BOTH);
  assert.equal(r.releases().length, 0);
  assert.equal(r.client.stats().pinnedVertices, 45);
  await r.flush();
  assert.equal(await p2, null); // superseded while queued
  r.client.applied((await p3)!);
  // Now only p3's tokens are pinned: p1's and p2's may go.
  r.client.build(inputs(16), BOTH);
  await r.flush();
  const released = r.releases().flatMap((m) => (m.t === "release" ? m.tokens : []));
  assert.deepEqual(
    released.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(r.client.stats().droppedBeforeStart, 1);
});

test("a miss: the geometries sent once more; a second miss builds it here", async () => {
  const r = rig();
  const fx = inputs();
  const p1 = r.client.build(fx, BOTH);
  await r.flush();
  await p1;
  r.core.release([1, 2, 3]); // the worker lost them (the page did not say so)
  const p2 = r.client.build(fx, BOTH);
  await r.flush();
  assert.equal((await p2)!.via, "worker");
  assert.deepEqual(
    r.builds().map((b) => [b.id, b.puts.length]),
    [
      [1, 3],
      [2, 0],
      [2, 3],
    ],
  );
  let s = r.client.stats();
  assert.deepEqual([s.misses, s.resends, s.fallbacks], [1, 1, 0]);

  const lossy = rig({ dropPuts: true });
  const p3 = lossy.client.build(inputs(), BOTH);
  await lossy.flush();
  const res = (await p3)!;
  assert.equal(res.via, "main");
  s = lossy.client.stats();
  assert.deepEqual([s.misses, s.resends, s.fallbacks, s.mode], [2, 1, 1, "worker"]);
});

test("a miss for a superseded request: not sent again, resolved null", async () => {
  const r = rig();
  const fx = inputs();
  const p1 = r.client.build(fx, BOTH);
  await r.flush();
  await p1;
  r.core.release([1, 2, 3]); // the worker lost them (the page did not say so)
  const pA = r.client.build(fx, BOTH);
  r.work(); // the worker answers A `missing`, the reply not read yet
  const pB = r.client.build(inputs(8), BOTH);
  await r.flush();
  assert.equal(await pA, null);
  assert.equal((await pB)!.mesh.scopeId, "fr:dep:8");
  assert.deepEqual(
    r.builds().map((b) => [b.id, b.puts.length]),
    [
      [1, 3],
      [2, 0],
      [3, 3],
    ],
  );
  const s = r.client.stats();
  assert.deepEqual([s.misses, s.resends, s.droppedBeforeStart, s.fallbacks], [1, 0, 1, 0]);
});

test("a geometry the flattening cannot read: built here, never thrown", async () => {
  const r = rig();
  const fx = inputs();
  const bad = {
    ...fx,
    focus: [
      ...fx.focus,
      { type: "Feature", properties: { id: "bad" }, geometry: { type: "Polygon" } },
    ],
  } as MeshInputs;
  let p!: Promise<MeshResult | null>;
  assert.doesNotThrow(() => (p = r.client.build(bad, BOTH)));
  // The builder cannot read it either: null, the caller builds and fails as before.
  assert.equal(await p, null);
  assert.equal(r.builds().length, 0);
  let s = r.client.stats();
  assert.deepEqual([s.liveTokens, s.liveVertices, s.pinnedVertices, s.mode], [0, 0, 0, "worker"]);
  // The geometries it had flattened were never sent: they go with the next build.
  const ok = r.client.build(fx, BOTH);
  await r.flush();
  assert.equal((await ok)!.via, "worker");
  assert.equal(r.builds()[0].puts.length, 3);
  s = r.client.stats();
  assert.deepEqual([s.misses, s.liveTokens], [0, 3]);
});

test("single flight joins a build in flight only, with no new id", async () => {
  const r = rig();
  const fx = inputs();
  const p1 = r.client.build(fx, BOTH);
  const p2 = r.client.build({ ...fx }, BOTH); // the same objects, a new container
  assert.equal(p1, p2);
  assert.notEqual(r.client.build({ ...fx, heightM: 1500.0001 }, BOTH), p1);
  assert.notEqual(r.client.build(fx, { merc: true, globe: false }), p1);
  assert.equal(r.builds().length, 3);
  assert.equal(r.client.stats().deduped, 1);
  await r.flush();
  // Answered: nothing kept, the same call builds again.
  const p3 = r.client.build(fx, { merc: true, globe: false });
  assert.notEqual(p3, p1);
  assert.equal(r.builds().length, 4);
  await r.flush();
  assert.equal((await p3)!.via, "worker");
});

test("a newer build: a queued older one resolves null, a started one finishes", async () => {
  const r = rig();
  const fxA = inputs(4);
  const pA = r.client.build(fxA, BOTH);
  const pB = r.client.build(inputs(8), BOTH);
  // A superseded request is not joined either.
  const pA2 = r.client.build(fxA, BOTH);
  assert.notEqual(pA2, pA);
  await r.flush();
  assert.equal(await pA, null);
  assert.equal(await pB, null);
  assert.equal((await pA2)!.mesh.scopeId, "fr:dep:4");
  assert.equal(r.client.stats().droppedBeforeStart, 2);

  // Started (built, its reply not read yet) when the newer one comes: it finishes.
  const pC = r.client.build(inputs(12), BOTH);
  r.work();
  const pD = r.client.build(inputs(16), BOTH);
  await r.flush();
  const c = (await pC)!;
  const d = (await pD)!;
  assert.equal(c.mesh.scopeId, "fr:dep:12");
  r.client.applied(d);
  const s = r.client.stats();
  // pA2 and pC resolved and were never applied: dropped.
  assert.deepEqual([s.applied, s.dropped, s.built], [1, 2, 3]);
});

test("a globe follow-up supersedes nothing", async () => {
  const r = rig();
  const fx = inputs();
  const p1 = r.client.build(fx, { merc: true, globe: false });
  const g = r.client.buildGlobe(fx);
  await r.flush();
  const m = (await p1)!;
  const globe = (await g)!;
  assert.equal(m.mesh.gWallPositions, null);
  assert.ok(globe.mesh.gWallPositions && globe.mesh.positions === null);
  // A new build supersedes a queued follow-up, though.
  const g2 = r.client.buildGlobe(fx);
  r.client.build(inputs(8), BOTH);
  await r.flush();
  assert.equal(await g2, null);
});

for (const why of ["error", "messageerror"]) {
  test(`the worker's ${why} mid-flight: every pending build made here`, async () => {
    const r = rig();
    const pA = r.client.build(inputs(4), BOTH);
    const pB = r.client.build(inputs(8), BOTH);
    r.work(); // the worker answers B (A skipped), the replies not read yet
    r.fail(why);
    assert.equal(await pA, null); // superseded: null, not built here
    const b = (await pB)!;
    assert.equal(b.via, "main");
    assert.equal(b.mesh.scopeId, "fr:dep:8");
    assert.equal(r.client.mode, "main");
    assert.equal(r.terminated(), 1);
    // Its late replies are ignored; later builds run here.
    await r.deliver();
    const later = (await r.client.build(inputs(12), BOTH))!;
    assert.equal(later.via, "main");
    const s = r.client.stats();
    assert.deepEqual([s.built, s.fallbacks, s.failure, s.liveTokens], [0, 2, why, 0]);
    assert.equal(r.builds().length, 2);
  });
}

test("an error reply ends the worker for the session", async () => {
  const r = rig({ knobs: { fail: "throw" } });
  const p = r.client.build(inputs(), BOTH);
  await r.flush();
  assert.equal((await p)!.via, "main");
  assert.equal(r.client.stats().failure, "error");
});

test("a silent worker: the watchdog at 3 s, one task late", async () => {
  const r = rig({ knobs: { fail: "hang" } });
  const out: { settled?: MeshResult | null } = {};
  void r.client.build(inputs(), BOTH).then((v) => (out.settled = v));
  await r.flush();
  r.advance(2999);
  await r.deliver();
  assert.ok(!("settled" in out), "still pending at 2999 ms");
  r.advance(1);
  await r.deliver();
  assert.equal(out.settled?.via, "main");
  assert.equal(r.client.stats().failure, "timeout");
  assert.equal(r.terminated(), 1);
});

test("a reply re-arms the watchdog of the requests queued behind it", async () => {
  const r = rig({ knobs: { delayMs: 2000 } });
  const p1 = r.client.build(inputs(4), { merc: true, globe: false });
  r.work();
  r.advance(1000);
  const g = r.client.buildGlobe(inputs(4)); // posted at 1000: its reply at ~3000+
  r.work();
  r.advance(1500); // p1's reply at 2000
  await r.deliver();
  assert.equal((await p1)!.via, "worker");
  r.advance(1600); // g at 4100 from its post: alive, as p1 said
  await r.deliver();
  assert.equal(r.client.mode, "worker");
  assert.equal((await g)!.via, "worker");
});

test("dispose: pending builds resolve null, late replies are ignored", async () => {
  const r = rig();
  const p = r.client.build(inputs(), BOTH);
  r.work();
  r.client.dispose();
  assert.equal(await p, null);
  await r.deliver();
  assert.equal(await r.client.build(inputs(), BOTH), null);
  assert.equal(r.terminated(), 1);
  assert.equal(r.client.stats().built, 0);
  assert.equal(r.client.stats().liveTokens, 0);
});

test("no worker at all: the session builds here from the start", async () => {
  const r = rig({ noTransport: true });
  assert.equal(r.client.mode, "main");
  assert.equal((await r.client.build(inputs(), BOTH))!.via, "main");
  assert.equal(r.client.stats().failure, "constructor");
  // A build that throws here too resolves null (the caller builds and fails as before).
  const t = rig({ noTransport: true, fallbackThrows: true });
  assert.equal(await t.client.build(inputs(), BOTH), null);
});

const geomsOf = (fx: MeshInputs) => fx.features.map((f) => f.geometry as Geom);

test("cutTint: the worker's sheet is the page's bit for bit, its geometry travelling once", async () => {
  const r = rig();
  const fx = inputs();
  const here = cutTintSheet(geomsOf(fx));
  const cut = r.client.cutTint(geomsOf(fx));
  const mesh = r.client.build(fx, BOTH);
  await r.flush();
  const sheet = (await cut)!;
  assert.deepEqual(Buffer.from(sheet.positions.buffer), Buffer.from(here.positions.buffer));
  assert.deepEqual(sheet.origin, here.origin);
  assert.equal(typeof sheet.ms, "number");
  // The scope's geometry went with the cut; the build names its token.
  assert.equal(r.tints()[0].puts.length, 1);
  assert.equal(r.builds()[0].puts.length, 2);
  assert.deepEqual(r.builds()[0].scope.tokens, r.tints()[0].scope.tokens);
  // The cut superseded no build, and the build no cut.
  assert.equal((await mesh)!.via, "worker");
  const s = r.client.stats();
  assert.equal(s.tints, 1);
  assert.equal(s.tintsCut, 1);
  assert.equal(s.droppedBeforeStart, 0);
  // After a build the same way round: nothing to send.
  const again = r.client.cutTint(geomsOf(fx));
  await r.flush();
  assert.ok(await again);
  assert.equal(r.tints()[1].puts.length, 0);
});

test("cutTint: a newer cut supersedes the one queued, which resolves null", async () => {
  const r = rig();
  const a = r.client.cutTint(geomsOf(inputs(4)));
  const b = r.client.cutTint(geomsOf(inputs(8)));
  await r.flush();
  assert.equal(await a, null);
  assert.ok(await b);
  assert.equal(r.client.stats().tintsCut, 1);
});

test("cutTint: its tokens are pinned while it is in flight", async () => {
  // Room for one geometry: the cut's own is not evicted by the build's puts.
  const r = rig({ cap: 5 });
  const fx = inputs();
  const cut = r.client.cutTint(geomsOf(fx));
  const mesh = r.client.build(inputs(8), BOTH);
  const token = r.tints()[0].scope.tokens[0];
  for (const rel of r.releases()) {
    assert.ok(!(rel as { tokens: number[] }).tokens.includes(token!));
  }
  await r.flush();
  assert.ok(await cut);
  assert.ok(await mesh);
});

test("cutTint: a token the worker lacks is sent again once, then no sheet", async () => {
  const lossy = rig({ dropPuts: true });
  const fx = inputs();
  const cut = lossy.client.cutTint(geomsOf(fx));
  await lossy.flush();
  // dropPuts drops a build's puts only: the cut's geometry arrives.
  assert.ok(await cut);
  // A store emptied behind the page's back: the miss, the resend, the sheet.
  const r = rig();
  const g = geomsOf(inputs());
  const first = r.client.cutTint(g);
  await r.flush();
  await first;
  r.core.release(r.tints()[0].scope.tokens as number[]);
  const second = r.client.cutTint(g);
  await r.flush();
  assert.ok(await second);
  assert.equal(r.client.stats().misses, 1);
  assert.equal(r.client.stats().resends, 1);
  assert.equal(r.tints().length, 3);
  assert.equal(r.tints()[2].puts.length, 1);
});

test("cutTint: never cut here — null once the worker is lost, hangs, or is disposed", async () => {
  // Lost while the cut is in flight: null at once, the build made here.
  const r = rig();
  const fx = inputs();
  const cut = r.client.cutTint(geomsOf(fx));
  const mesh = r.client.build(fx, BOTH);
  r.fail("error");
  assert.equal(await cut, null);
  assert.equal((await mesh)!.via, "main");
  assert.equal(r.fallbacks(), 1);
  // Lost for the session: no cut is asked any more.
  assert.equal(await r.client.cutTint(geomsOf(fx)), null);
  assert.equal(r.tints().length, 1);

  // No answer: the watchdog ends the worker, the cut resolves null.
  const h = rig({ knobs: { fail: "hang" } });
  const hung = h.client.cutTint(geomsOf(inputs()));
  h.work();
  h.advance(3001);
  assert.equal(await hung, null);
  assert.equal(h.client.stats().failure, "timeout");
  assert.equal(h.terminated(), 1);

  // An error reply.
  const t = rig({ knobs: { fail: "throw" } });
  const thrown = t.client.cutTint(geomsOf(inputs()));
  await t.flush();
  assert.equal(await thrown, null);
  assert.equal(t.client.stats().failure, "error");

  // No worker at all, and disposed.
  const none = rig({ noTransport: true });
  assert.equal(await none.client.cutTint(geomsOf(inputs())), null);
  const d = rig();
  const pending = d.client.cutTint(geomsOf(inputs()));
  d.client.dispose();
  assert.equal(await pending, null);
  assert.equal(await d.client.cutTint(geomsOf(inputs())), null);
});

test("cutTint: a geometry the flattening cannot read gives no sheet and posts nothing", async () => {
  const r = rig();
  const bad = { type: "Polygon", coordinates: [[[1, 2], null]] } as unknown as Geom;
  assert.equal(await r.client.cutTint([bad]), null);
  assert.equal(r.tints().length, 0);
  assert.equal(r.client.stats().liveTokens, 0);
});
