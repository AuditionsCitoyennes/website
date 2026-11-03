// The flat geometries the mesh worker is sent (meshFlat.ts): a geometry
// flattened and unflattened builds the very bytes of the original
// (Polygon, MultiPolygon with a hole, no geometry, one geometry object as both
// scope and focus, an empty scope), and a mesh's transfer list clones and
// detaches every buffer, whichever sets it has. No __TEST_TOOLS__ stub on
// purpose: nothing here may read it. Run with `node --import tsx --test`
// (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutlineFC } from "../types";
import { buildPlateauMesh, type MeshOut } from "./meshBuild";
import { flatBuffers, flatten, meshBuffers, unflatten, type Geom } from "./meshFlat";

type Feature = OutlineFC["features"][number];
const ring = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
const poly = (id: string, x: number, y: number, s: number, level = "departement"): Feature => ({
  type: "Feature",
  properties: { id, level },
  geometry: { type: "Polygon", coordinates: [ring(x, y, s)] },
});
const multi = (id: string, level = "departement"): Feature => ({
  type: "Feature",
  properties: { id, level },
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      // A polygon with a hole, then an island; one vertex at -0.
      [ring(4, 45, 1), ring(4.3, 45.3, 0.2).reverse()],
      [
        [
          [-0, 46.5],
          [0.4, 46.5],
          [0.4, 46.9],
          [-0, 46.9],
          [-0, 46.5],
        ],
      ],
    ],
  },
});
const none = (id: string): Feature => ({ type: "Feature", properties: { id }, geometry: null });

/** The same features, each geometry flattened and back: new objects. */
const roundTrip = (fs: Feature[]) =>
  fs.map((f) => {
    const flat = flatten(f.geometry as Geom | null);
    return { ...f, geometry: flat ? unflatten(flat) : f.geometry };
  });

const ALL = { merc: true, globe: true, concat: true };

/** Every typed array by its bytes (−0 and NaN seen), the rest strictly. */
function assertSameMesh(a: MeshOut, b: MeshOut) {
  assert.deepEqual(Object.keys(a), Object.keys(b));
  for (const k of Object.keys(a) as (keyof MeshOut)[]) {
    const x = a[k];
    const y = b[k];
    if (ArrayBuffer.isView(x) || ArrayBuffer.isView(y)) {
      assert.ok(ArrayBuffer.isView(x) && ArrayBuffer.isView(y), `${k}: both arrays`);
      assert.ok(
        Buffer.from(x.buffer, x.byteOffset, x.byteLength).equals(
          Buffer.from(y.buffer, y.byteOffset, y.byteLength),
        ),
        `${k}: same bytes`,
      );
    } else {
      assert.deepStrictEqual(x, y, k);
    }
  }
}

function cases() {
  const shared = poly("fr:dep:shared", 2, 44, 0.8);
  return {
    polygon: {
      scope: [poly("fr:dep:1", 4, 45, 1)],
      focus: [poly("fr:com:a", 4.2, 45.2, 0.3, "commune"), none("fr:com:none")],
      context: [poly("fr:dep:2", 5.2, 45, 0.8)],
    },
    multipolygon: {
      scope: [multi("fr:dep:m")],
      focus: [multi("fr:com:m", "commune"), poly("fr:com:b", 4.1, 45.1, 0.1, "commune")],
      context: [none("fr:dep:none"), poly("fr:reg:1", 6, 45, 1, "region")],
    },
    // One geometry object as the scope and as a focus child.
    shared: { scope: [shared], focus: [shared, none("x")], context: [] as Feature[] },
    emptyScope: {
      scope: [] as Feature[],
      focus: [] as Feature[],
      context: [poly("fr:country", 1, 43, 6, "country")],
    },
  };
}

test("flatten → unflatten builds the same bytes as the original geometries", () => {
  for (const [name, c] of Object.entries(cases())) {
    for (const want of [ALL, { merc: true, globe: false, concat: true }]) {
      const raw = buildPlateauMesh(c.scope, 1500, c.focus, c.context, want);
      // The shared object stays shared: one flat, one unflattened object.
      const g = new Map<unknown, Geom>();
      const back = (fs: Feature[]) =>
        fs.map((f) => {
          const flat = flatten(f.geometry as Geom | null);
          if (!flat) return f;
          if (!g.has(f.geometry)) g.set(f.geometry, unflatten(flat));
          return { ...f, geometry: g.get(f.geometry) };
        });
      const rt = buildPlateauMesh(back(c.scope), 1500, back(c.focus), back(c.context), want);
      assert.ok(raw.scopeId === rt.scopeId, name);
      assertSameMesh(raw, rt);
    }
  }
});

test("each feature flattened on its own builds the same bytes too", () => {
  const c = cases().multipolygon;
  const raw = buildPlateauMesh(c.scope, 900, c.focus, c.context, ALL);
  const rt = buildPlateauMesh(
    roundTrip(c.scope),
    900,
    roundTrip(c.focus),
    roundTrip(c.context),
    ALL,
  );
  assertSameMesh(raw, rt);
});

test("the flat layout: offsets, −0 kept, a skipped geometry, another type", () => {
  const flat = flatten(multi("m").geometry as Geom)!;
  assert.equal(flat.type, "MultiPolygon");
  assert.deepEqual([...flat.polyOffsets], [0, 2, 3]);
  assert.deepEqual([...flat.ringOffsets], [0, 5, 10, 15]);
  assert.equal(flat.coords.length, 30);
  assert.ok(Object.is(flat.coords[20], -0));
  assert.ok(Object.is((unflatten(flat).coordinates as number[][][][])[1][0][0][0], -0));
  assert.equal(flatten(null), null);
  assert.equal(flatten({ coordinates: [] }), null);
  // The builder draws no polygon of a LineString: neither side has any.
  const line = flatten({
    type: "LineString",
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  })!;
  assert.equal(line.polyOffsets.length, 1);
  assert.deepEqual(unflatten(line), { type: "LineString", coordinates: [] });
  assert.equal(flatBuffers(flat).length, 3);
});

test("a mesh's transfer list clones it and detaches every buffer", () => {
  const c = cases().polygon;
  const meshes = {
    both: buildPlateauMesh(c.scope, 1500, c.focus, c.context, ALL),
    mercOnly: buildPlateauMesh(c.scope, 1500, c.focus, c.context, { ...ALL, globe: false }),
    globeOnly: buildPlateauMesh(c.scope, 1500, c.focus, c.context, { ...ALL, merc: false }),
    empty: buildPlateauMesh([], 0, [], [], ALL),
  };
  for (const [name, m] of Object.entries(meshes)) {
    const arrays = Object.values(m).filter((v) => ArrayBuffer.isView(v)) as ArrayBufferView[];
    const copy = structuredClone(m, { transfer: meshBuffers(m) });
    for (const a of arrays) assert.equal(a.buffer.byteLength, 0, `${name}: detached`);
    assert.equal(copy.lineVertexCount, m.lineVertexCount);
    assert.equal(copy.gWallPositions === null, name === "mercOnly");
  }
  // Two views over one buffer: named once, or the transfer would throw.
  const buf = new ArrayBuffer(64);
  const m = {
    ...buildPlateauMesh(c.scope, 1500, c.focus, c.context, ALL),
    rim: new Float64Array(buf, 0, 4),
    positions: new Float32Array(buf, 32, 8) as Float32Array<ArrayBuffer>,
  };
  assert.equal(meshBuffers(m).filter((b) => b === buf).length, 1);
  assert.doesNotThrow(() => structuredClone(m, { transfer: meshBuffers(m) }));
});
