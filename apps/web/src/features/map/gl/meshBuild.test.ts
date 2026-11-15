// The plateau's pure mesh builder (meshBuild.ts): what it returns for a small
// scope, the equivalences the layer's three modes rest on (concat packing on
// or off, the mercator-first build and its globe-only pass), the hover fills'
// records, and its exact field list. No __TEST_TOOLS__ stub on purpose: the
// builder's import closure must not read it (it would throw here). Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutlineFC } from "../types";
import { WALL_OVERSHOOT } from "./mesh";
import { buildPlateauMesh, fillsFromRecords, type MeshOut } from "./meshBuild";

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

/** A raised scope, a child inside its box, one outside it, a context sibling
 *  and a child without geometry. Fresh objects each time (the projection
 *  caches are keyed by identity). */
function fixture() {
  const scope = [square("fr:dep:1", 4, 45, 1)];
  const focus = [
    square("fr:com:in", 4.2, 45.2, 0.3, "commune"),
    square("fr:com:out", 8, 47, 0.2, "commune"),
    { type: "Feature", properties: { id: "fr:com:none" }, geometry: null } as Feature,
  ];
  const context = [square("fr:dep:2", 5.2, 45, 0.8)];
  return { scope, focus, context, heightM: 1500 };
}

const ALL = { merc: true, globe: true, concat: true };
const MERC_ARRAYS = ["positions", "lidPositions", "linePositions", "haloPositions"] as const;
const GLOBE_ARRAYS = [
  "gWallPositions",
  "gLidPositions",
  "gLinePositions",
  "gHaloPositions",
] as const;
const bytes = (a: ArrayBufferView | null) =>
  a ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : null;

function build(want = ALL, fx = fixture()) {
  return { fx, m: buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, want) };
}

test("a raised scope: counts, origin, lifted and ground line groups", () => {
  const { m } = build();
  // 4 edges × 6 vertices, 3 floats each; the lid is earcut + subdivision.
  assert.equal(m.vertexCount, 24);
  assert.equal(m.positions!.length, 24 * 3);
  assert.ok(m.lidVertexCount > 0 && m.lidVertexCount % 3 === 0);
  assert.equal(m.lineVertexCount, 3 * 4 * 6);
  assert.ok(m.haloVertexCount > 0);
  assert.equal(m.gWallPositions!.length, 24 * 9);
  assert.equal(m.gLinePositions!.length, m.lineVertexCount * 20);
  assert.equal(m.scopeId, "fr:dep:1");
  assert.equal(m.heightM, 1500);
  assert.ok(m.rimCount > 0 && m.rim!.length === m.rimCount * 11);
  // The origin: the first vertex of the scope's first ring, in mercator.
  assert.deepEqual(m.origin, [(180 + 4) / 360, m.origin![1]]);
  assert.ok(m.haloW! > 0 && m.haloCos! > 0 && m.haloCos! < 1);
  // The child inside the box rides the lid; the one outside and the context
  // stay on the ground, each group in first-seen order.
  assert.deepEqual(
    m.lineGroups.map(({ width, alpha, raised, start, count }) => [
      width,
      alpha,
      raised,
      start,
      count,
    ]),
    [
      [1.7, 0.95, true, 0, 24],
      [1.7, 0.95, false, 24, 24],
      [1.7, 0.85, false, 48, 24],
    ],
  );
});

test("nothing raised: no origin, the halo untouched, no fills", () => {
  const m = buildPlateauMesh([], 0, [], [], ALL);
  assert.equal(m.origin, null);
  assert.equal(m.haloW, null);
  assert.equal(m.haloCos, null);
  assert.deepEqual(m.fillRecords, []);
  assert.equal(m.scopeId, "");
  assert.equal(m.heightM, 0);
  assert.equal(m.rimCount, 0);
  assert.equal(m.vertexCount + m.lidVertexCount + m.lineVertexCount + m.haloVertexCount, 0);
});

test("a world scope (a context outline only): origin from the first line vertex, halo 0", () => {
  const ctx = [square("FR", -5, 42, 9, "country")];
  const m = buildPlateauMesh([], 0, [], ctx, ALL);
  assert.deepEqual(m.origin, [(180 - 5) / 360, m.origin![1]]);
  assert.equal(m.haloW, 0);
  assert.deepEqual(m.fillRecords, []);
  assert.equal(m.vertexCount, 0);
  assert.equal(m.lineVertexCount, 24);
  assert.deepEqual(m.lineGroups, [{ width: 0.9, alpha: 0.85, raised: false, start: 0, count: 24 }]);
});

test("concat on and off: the same bytes in every array", () => {
  const fx = fixture();
  const on = buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, ALL);
  const off = buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, {
    ...ALL,
    concat: false,
  });
  for (const k of [...MERC_ARRAYS, ...GLOBE_ARRAYS, "rim"] as const) {
    assert.ok(on[k], k);
    assert.deepEqual(bytes(on[k]), bytes(off[k]), k);
  }
  assert.deepEqual(on.lineGroups, off.lineGroups);
});

test("mercator first, then the globe pass: each set equal to the eager build's", () => {
  const fx = fixture();
  const run = (merc: boolean, globe: boolean) =>
    buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, { merc, globe, concat: true });
  const eager = run(true, true);
  const first = run(true, false);
  const late = run(false, true);
  for (const k of MERC_ARRAYS) assert.deepEqual(bytes(first[k]), bytes(eager[k]), k);
  assert.deepEqual(bytes(first.rim), bytes(eager.rim));
  for (const k of GLOBE_ARRAYS) {
    assert.equal(first[k], null, k);
    assert.deepEqual(bytes(late[k]), bytes(eager[k]), k);
  }
  for (const k of [...MERC_ARRAYS, "rim"] as const) assert.equal(late[k], null, k);
  assert.equal(late.rimCount, 0);
  for (const m of [first, late]) {
    assert.deepEqual(m.lineGroups, eager.lineGroups);
    assert.deepEqual(m.origin, eager.origin);
    assert.deepEqual(m.fillRecords, eager.fillRecords);
    assert.equal(m.haloW, eager.haloW);
    assert.equal(m.haloCos, eager.haloCos);
  }
});

test("fill records: lifted above the lid, the rest on the ground, focus then context", () => {
  const { fx, m } = build();
  const h = fx.heightM * WALL_OVERSHOOT;
  assert.deepEqual(m.fillRecords, [
    { id: "fr:com:in", kind: "focus", index: 0, altM: h * 1.001, raised: true },
    { id: "fr:com:out", kind: "focus", index: 1, altM: 12, raised: false },
    { id: "fr:dep:2", kind: "context", index: 0, altM: 12, raised: false },
  ]);
  const fills = fillsFromRecords(m.fillRecords, fx.focus, fx.context);
  assert.deepEqual([...fills.keys()], ["fr:com:in", "fr:com:out", "fr:dep:2"]);
  // The geometry objects themselves (fillBasesOf caches on them).
  assert.equal(fills.get("fr:com:in")!.g, fx.focus[0].geometry);
  assert.equal(fills.get("fr:dep:2")!.g, fx.context[0].geometry);
});

test("one id in focus and context: the context's record wins, its geometry", () => {
  const fx = fixture();
  fx.context.push(square("fr:com:in", 9, 47, 0.1, "commune"));
  const m = buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, ALL);
  assert.deepEqual(
    m.fillRecords.map((r) => [r.id, r.kind, r.index]),
    [
      ["fr:com:in", "focus", 0],
      ["fr:com:out", "focus", 1],
      ["fr:dep:2", "context", 0],
      ["fr:com:in", "context", 1],
    ],
  );
  const fills = fillsFromRecords(m.fillRecords, fx.focus, fx.context);
  const hit = fills.get("fr:com:in")!;
  assert.equal(hit.g, fx.context[1].geometry);
  assert.equal(hit.altM, 12);
  assert.equal(hit.raised, false);
  assert.equal(fills.size, 3);
});

test("MeshOut has exactly its fields", () => {
  const { m } = build();
  const want: (keyof MeshOut)[] = [
    "scopeId",
    "heightM",
    "rim",
    "rimCount",
    "positions",
    "lidPositions",
    "linePositions",
    "haloPositions",
    "gWallPositions",
    "gLidPositions",
    "gLinePositions",
    "gHaloPositions",
    "vertexCount",
    "lidVertexCount",
    "lineVertexCount",
    "haloVertexCount",
    "lineLayout",
    "origin",
    "lineGroups",
    "haloW",
    "haloCos",
    "fillRecords",
  ];
  assert.deepEqual(Object.keys(m).sort(), [...want].sort());
});
