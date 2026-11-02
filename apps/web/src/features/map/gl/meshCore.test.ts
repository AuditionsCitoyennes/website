// The mesh worker's core (meshCore.ts): the token store (put, release, a
// request naming a token it lacks), the stored object reused across requests,
// the sets a request asks for, a worker-built mesh hashed against the one the
// page builds itself, and the queue (superseded requests skipped, the testing
// tools' delay, throw and hang). No __TEST_TOOLS__ stub on purpose: nothing
// here may read it. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutlineFC } from "../types";
import { buildPlateauMesh, type MeshOut } from "./meshBuild";
import { createMeshCore, type MeshReply, type MeshRequest, type MeshSet } from "./meshCore";
import { digestParts } from "./meshDigest";
import { flatten, type Geom } from "./meshFlat";

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

function fixture() {
  return {
    scope: [square("fr:dep:1", 4, 45, 1)],
    focus: [
      square("fr:com:in", 4.2, 45.2, 0.3, "commune"),
      { type: "Feature", properties: { id: "fr:com:none" }, geometry: null } as Feature,
    ],
    context: [square("fr:reg:2", 5.2, 45, 0.8, "region")],
    heightM: 1500,
  };
}

/** A fixture as a request: tokens from 1 in feature order, every geometry put. */
function requestOf(fx = fixture(), over: Partial<MeshRequest> = {}): MeshRequest {
  let token = 1;
  const puts: MeshRequest["puts"] = [];
  const setOf = (fs: Feature[]): MeshSet => ({
    tokens: fs.map((f) => {
      const flat = flatten(f.geometry as Geom | null);
      if (!flat) return null;
      puts.push({ token, flat });
      return token++;
    }),
    meta: fs.map((f) => ({
      id: String(f.properties.id ?? ""),
      level: String(f.properties.level ?? ""),
      hasGeom: !!(f.geometry as Geom | null)?.type,
    })),
  });
  return {
    t: "build",
    id: 1,
    want: { merc: true, globe: true },
    heightM: fx.heightM,
    scope: setOf(fx.scope),
    focus: setOf(fx.focus),
    context: setOf(fx.context),
    puts,
    supersede: true,
    ...over,
  };
}

/** The parts meshDigest hashes, from a MeshOut. */
const digestOf = (m: MeshOut) =>
  digestParts([
    ["positions", m.positions],
    ["lidPositions", m.lidPositions],
    ["linePositions", m.linePositions],
    ["haloPositions", m.haloPositions],
    ["gWallPositions", m.gWallPositions],
    ["gLidPositions", m.gLidPositions],
    ["gLinePositions", m.gLinePositions],
    ["gHaloPositions", m.gHaloPositions],
    ["rim", m.rim],
    [
      "state",
      JSON.stringify({
        rimCount: m.rimCount,
        heightM: m.heightM,
        haloW: m.haloW,
        haloCos: m.haloCos,
        origin: m.origin,
        lineGroups: m.lineGroups,
        scopeId: m.scopeId,
        fillRecords: m.fillRecords,
      }),
    ],
  ]);

/** A core whose replies are collected and whose tasks run on `flush()`. */
function harness() {
  const replies: MeshReply[] = [];
  let tasks: { fn: () => void; at: number }[] = [];
  let now = 0;
  const core = createMeshCore({
    post: (r) => replies.push(r),
    schedule: (fn, ms) => void tasks.push({ fn, at: now + ms }),
  });
  /** Runs every task due within `ms` from now, in order. */
  const flush = (ms = 0) => {
    const end = now + ms;
    for (;;) {
      const due = tasks.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      tasks = tasks.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = end;
  };
  return { core, replies, flush };
}

test("put, build, release; a token it lacks is answered `missing`", () => {
  const { core } = harness();
  const req = requestOf();
  const r1 = core.build(req);
  assert.equal(r1.t, "mesh");
  // Three geometries (the child without one is not sent): 3 × 5 vertices.
  assert.deepEqual(core.held(), { tokens: 3, vertices: 15 });
  // A later request names the tokens only.
  const r2 = core.build({ ...req, id: 2, puts: [] });
  assert.equal(r2.t, "mesh");
  core.release([1, 3]);
  assert.deepEqual(core.held(), { tokens: 1, vertices: 5 });
  const r3 = core.build({ ...req, id: 3, puts: [] });
  assert.deepEqual(r3, { t: "missing", id: 3, tokens: [1, 3] });
  assert.doesNotThrow(() => core.release([99]));
});

test("a token's stored object is reused by every request naming it", () => {
  const { core } = harness();
  const req = requestOf();
  core.build(req);
  const g = core.geometryOf(1);
  assert.ok(g);
  core.build({ ...req, id: 2, puts: [] });
  assert.equal(core.geometryOf(1), g);
  // A put again under the same token replaces it (a resend after a miss).
  core.put(1, req.puts[0].flat);
  assert.notEqual(core.geometryOf(1), g);
  assert.deepEqual(core.held(), { tokens: 3, vertices: 15 });
});

test("the sets asked for, and the same digest as the page's own build", () => {
  const { core } = harness();
  const fx = fixture();
  for (const want of [
    { merc: true, globe: true },
    { merc: true, globe: false },
    { merc: false, globe: true },
  ]) {
    const r = core.build(requestOf(fixture(), { want }));
    assert.equal(r.t, "mesh");
    if (r.t !== "mesh") continue;
    assert.equal(r.mesh.positions === null, !want.merc);
    assert.equal(r.mesh.gWallPositions === null, !want.globe);
    assert.ok(r.ms >= 0);
    const page = buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, {
      ...want,
      concat: true,
    });
    assert.deepEqual(digestOf(r.mesh), digestOf(page));
    // concat off (ac:mesh=ancien) hands the GPU the same bytes too. (A
    // globe-only build is the deferred pass's: always concat.)
    if (!want.merc) continue;
    const ancien = buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, {
      ...want,
      concat: false,
    });
    assert.deepEqual(digestOf(r.mesh).parts, digestOf(ancien).parts);
  }
});

test("the queue: one build per task, superseded ones skipped, puts kept", () => {
  const { core, replies, flush } = harness();
  const a = requestOf(fixture(), { id: 1 });
  core.receive(a);
  core.receive({ ...requestOf(fixture(), { id: 2 }), puts: [] });
  // A globe follow-up supersedes nothing.
  core.receive({ ...requestOf(fixture(), { id: 3, supersede: false }), puts: [] });
  assert.equal(replies.length, 0);
  flush();
  assert.deepEqual(
    replies.map((r) => [r.t, r.id]),
    [
      ["skipped", 1],
      ["mesh", 2],
      ["mesh", 3],
    ],
  );
  // The skipped request's geometries were stored all the same.
  assert.equal(core.held().tokens, 3);
  core.receive({ t: "release", tokens: [1, 2, 3] });
  assert.equal(core.held().tokens, 0);
});

test("the testing tools' knobs: delay, slow, throw, hang", () => {
  const { core, replies, flush } = harness();
  core.receive(requestOf(fixture(), { id: 1, delayMs: 400, slow: 3 }));
  flush();
  assert.equal(replies.length, 0);
  flush(400);
  assert.deepEqual(
    replies.map((r) => r.t),
    ["mesh"],
  );
  core.receive(requestOf(fixture(), { id: 2, fail: "throw" }));
  core.receive(requestOf(fixture(), { id: 3, fail: "hang", supersede: false }));
  flush(10_000);
  assert.equal(replies.length, 2);
  assert.equal(replies[1].t, "error");
  assert.equal(replies[1].id, 2);
});
