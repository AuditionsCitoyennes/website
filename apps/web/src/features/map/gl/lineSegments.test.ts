// The boundary lines' lean layout (lineSegments.ts): which segments are kept,
// paired or left out; the packed buffers and their ranges; and, corner by
// corner through LINE_CORNERS, the same vertices as the full layout's
// (meshBuild.ts), so the two programs are handed the same numbers. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { baseOf, type PBase } from "../lib/mercator";
import type { OutlineFC } from "../types";
import {
  G_LEAN_FLOATS,
  LEAN_FLOATS,
  LINE_CORNERS,
  ONCE,
  OUT,
  SEGMENT_VERTICES,
  TWICE,
  packLeanLines,
  pairSegments,
  type SegmentGroup,
} from "./lineSegments";
import { buildPlateauMesh, type LineRange, type MeshOut } from "./meshBuild";

const P = (lng: number, lat: number) => baseOf(lng, lat);
/** Segments from pairs of [lng, lat]: fresh bases each (as two units' rings). */
const segs = (pairs: [[number, number], [number, number]][]) => ({
  a: pairs.map(([p]) => P(p[0], p[1])),
  b: pairs.map(([, q]) => P(q[0], q[1])),
});

test("pairSegments: without pairing every segment is drawn, but one of no length", () => {
  const { a, b } = segs([
    [
      [0, 0],
      [1, 0],
    ],
    [
      [1, 0],
      [0, 0],
    ],
    [
      [2, 2],
      [2, 2],
    ],
    [
      [0, 0],
      [1, 0],
    ],
  ]);
  assert.deepEqual([...pairSegments(a, b, false)], [ONCE, ONCE, OUT, ONCE]);
  assert.deepEqual([...pairSegments([], [], true)], []);
});

test("pairSegments: the same two ends, in either direction, pair in the order they come", () => {
  const { a, b } = segs([
    [
      [0, 0],
      [1, 0],
    ], // 0: pairs with 2
    [
      [1, 0],
      [1, 1],
    ], // 1: alone
    [
      [1, 0],
      [0, 0],
    ], // 2: 0 reversed
    [
      [0, 0],
      [1, 0],
    ], // 3: a third occurrence, pairs with 5
    [
      [5, 5],
      [5, 5],
    ], // 4: no length
    [
      [0, 0],
      [1, 0],
    ], // 5
    [
      [0, 0],
      [1, 0],
    ], // 6: a fifth, left alone
    [
      [1, 1],
      [1, 0.5],
    ], // 7: shares one end only
  ]);
  assert.deepEqual([...pairSegments(a, b, true)], [TWICE, ONCE, OUT, TWICE, OUT, OUT, ONCE, ONCE]);
});

test("pairSegments: ends are compared exactly (−0 is 0, a last bit apart is another point)", () => {
  const { a, b } = segs([
    [
      [0, 45],
      [1, 45],
    ],
    [
      [1, 45],
      [-0, 45],
    ],
    [
      [0, 45],
      [1 + Number.EPSILON, 45],
    ],
  ]);
  assert.deepEqual([...pairSegments(a, b, true)], [TWICE, OUT, ONCE]);
});

test("pairSegments: many segments, every shared one found whatever the table's collisions", () => {
  // A 40 × 40 grid of unit squares, each drawing its whole ring: the inner
  // edges are shared by two squares, the border ones by none.
  const N = 40;
  const a: PBase[] = [];
  const b: PBase[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = i * 0.01;
      const y = 40 + j * 0.01;
      const ring: [number, number][] = [
        [x, y],
        [(i + 1) * 0.01, y],
        [(i + 1) * 0.01, 40 + (j + 1) * 0.01],
        [x, 40 + (j + 1) * 0.01],
        [x, y],
      ];
      for (let k = 0; k + 1 < ring.length; k++) {
        a.push(P(ring[k][0], ring[k][1]));
        b.push(P(ring[k + 1][0], ring[k + 1][1]));
      }
    }
  }
  const fate = pairSegments(a, b, true);
  const count = (v: number) => fate.reduce((n, f) => n + (f === v ? 1 : 0), 0);
  const inner = 2 * N * (N - 1);
  assert.equal(count(TWICE), inner);
  assert.equal(count(OUT), inner);
  assert.equal(count(ONCE), 4 * N);
  // Layers: every segment of the input is still accounted for.
  assert.equal(count(ONCE) + 2 * count(TWICE), a.length);
});

const group = (over: Partial<SegmentGroup> & { a: PBase[]; b: PBase[] }): SegmentGroup => ({
  width: 1.7,
  alpha: 0.95,
  raised: true,
  alt: 1000,
  ...over,
});

test("packLeanLines: a raised group's segments once, then those that stand for two; a ground group whole", () => {
  const shared: [[number, number], [number, number]] = [
    [1, 45],
    [1, 46],
  ];
  const raised = group(
    segs([
      [
        [0, 45],
        [1, 45],
      ],
      shared,
      [
        [1, 46],
        [0, 46],
      ],
      [shared[1], shared[0]],
      [
        [1, 45],
        [2, 45],
      ],
    ]),
  );
  const ground = group({
    ...segs([shared, [shared[1], shared[0]]]),
    raised: false,
    alpha: 0.85,
    alt: 12,
    width: 0.9,
  });
  const origin: [number, number] = [raised.a[0].x, raised.a[0].y];
  const { lines, gLines, ranges } = packLeanLines([raised, ground], origin, {
    merc: true,
    globe: true,
  });
  assert.deepEqual(ranges, [
    { width: 1.7, alpha: 0.95, raised: true, start: 0, count: 18 },
    { width: 1.7, alpha: 0.95, raised: true, start: 18, count: 6, twice: true },
    { width: 0.9, alpha: 0.85, raised: false, start: 24, count: 12 },
  ]);
  assert.equal(lines!.length, 6 * LEAN_FLOATS);
  assert.equal(gLines!.length, 6 * G_LEAN_FLOATS);
  // Record 3 is the shared segment, in the direction it first came.
  const A = raised.a[1];
  const B = raised.b[1];
  const f = (v: number) => Math.fround(v);
  assert.deepEqual(
    [...lines!.subarray(3 * LEAN_FLOATS, 4 * LEAN_FLOATS)],
    [
      f(A.x - origin[0]),
      f(A.y - origin[1]),
      f(1000 * A.zPerM),
      f(B.x - origin[0]),
      f(B.y - origin[1]),
      f(1000 * B.zPerM),
    ],
  );
  assert.deepEqual(
    [...gLines!.subarray(3 * G_LEAN_FLOATS, 3 * G_LEAN_FLOATS + 9)],
    [
      A.x,
      A.y,
      1000 * A.zPerM,
      ...A.lo,
      A.lo[0] + 1000 * A.d[0],
      A.lo[1] + 1000 * A.d[1],
      A.lo[2] + 1000 * A.d[2],
    ].map(f),
  );
  // The ranges come from the rings alone.
  for (const want of [
    { merc: true, globe: false },
    { merc: false, globe: true },
    { merc: false, globe: false },
  ]) {
    const part = packLeanLines([raised, ground], origin, want);
    assert.deepEqual(part.ranges, ranges);
    assert.equal(part.lines === null, !want.merc);
    assert.equal(part.gLines === null, !want.globe);
    if (part.lines) assert.deepEqual(part.lines, lines);
    if (part.gLines) assert.deepEqual(part.gLines, gLines);
  }
});

test("packLeanLines: nothing to draw gives empty buffers and no range", () => {
  const { lines, gLines, ranges } = packLeanLines([], null, { merc: true, globe: true });
  assert.equal(lines!.length, 0);
  assert.equal(gLines!.length, 0);
  assert.deepEqual(ranges, []);
  const still = group(
    segs([
      [
        [3, 3],
        [3, 3],
      ],
    ]),
  );
  assert.deepEqual(packLeanLines([still], [0, 0], { merc: true, globe: false }).ranges, []);
});

// ---- against the full layout ------------------------------------------------

type Feature = OutlineFC["features"][number];
const poly = (id: string, ring: [number, number][], level = "commune"): Feature => ({
  type: "Feature",
  properties: { id, level },
  geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
});
const rect = (id: string, x0: number, y0: number, x1: number, y1: number, level?: string) =>
  poly(
    id,
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    level,
  );

/** A raised département, three communes on it that share edges (one of them
 *  through a vertex its neighbour does not have: no shared segment there),
 *  a commune off the plateau and two context siblings that share an edge. */
function fixture() {
  return {
    scope: [rect("fr:dep:1", 4, 45, 6, 46, "departement")],
    focus: [
      rect("c1", 4, 45, 5, 46),
      poly("c2", [
        [5, 45],
        [6, 45],
        [6, 45.5],
        [5, 45.5],
      ]),
      poly("c3", [
        [5, 45.5],
        [6, 45.5],
        [6, 46],
        [5, 46],
      ]),
      rect("c4", 9, 47, 9.5, 47.5),
    ],
    context: [
      rect("fr:dep:2", 6, 45, 7, 46, "departement"),
      rect("fr:dep:3", 7, 45, 8, 46, "departement"),
    ],
    heightM: 1500,
  };
}
const build = (lean: boolean, want = { merc: true, globe: true }, fx = fixture()) =>
  buildPlateauMesh(fx.scope, fx.heightM, fx.focus, fx.context, { ...want, concat: true, lean });

/** A lean mesh's lines as the full layout's vertices: each record's six
 *  corners through LINE_CORNERS, as the lean vertex shader reads them — self,
 *  other, offset side, geometric side. A `twice` range is written twice. */
function expand(m: MeshOut, floats: number, at: "linePositions" | "gLinePositions") {
  const src = m[at]!;
  const half = floats / 2;
  const out: { range: LineRange; segments: string[] }[] = [];
  for (const range of m.lineGroups) {
    const segments: string[] = [];
    const first = range.start / SEGMENT_VERTICES;
    for (let s = first; s < first + range.count / SEGMENT_VERTICES; s++) {
      const A = [...src.subarray(s * floats, s * floats + half)];
      const B = [...src.subarray(s * floats + half, (s + 1) * floats)];
      const verts: number[] = [];
      for (let c = 0; c < SEGMENT_VERTICES; c++) {
        const [end, side, geomSide] = LINE_CORNERS.subarray(c * 3, c * 3 + 3);
        verts.push(...(end > 0.5 ? B : A), ...(end > 0.5 ? A : B), side, geomSide);
      }
      const key = verts.join(",");
      segments.push(key);
      if (range.twice) segments.push(key);
    }
    out.push({ range, segments });
  }
  return out;
}

/** A full mesh's lines, one string per segment (its six vertices), by range. */
function fullSegments(m: MeshOut, stride: number, at: "linePositions" | "gLinePositions") {
  const src = m[at]!;
  return m.lineGroups.map((range) => {
    const segments: string[] = [];
    for (let v = range.start; v < range.start + range.count; v += SEGMENT_VERTICES) {
      segments.push([...src.subarray(v * stride, (v + SEGMENT_VERTICES) * stride)].join(","));
    }
    return { range, segments };
  });
}

/** A segment's quad whichever way the segment runs: its four corners, each
 *  the end it stands at, the other end and its offset side (the screen offset
 *  is perp(other − self) × side, so a segment reversed gives the same four). */
const quadKey = (segment: string, stride: number) => {
  const v = segment.split(",").map(Number);
  const half = (stride - 2) / 2;
  const corners = new Set<string>();
  for (let c = 0; c < SEGMENT_VERTICES; c++) {
    const self = v.slice(c * stride, c * stride + half);
    const other = v.slice(c * stride + half, c * stride + 2 * half);
    corners.add(`${self.join()}|${other.join()}|${v[c * stride + 2 * half]}`);
  }
  assert.equal(corners.size, 4);
  return [...corners].sort().join(" ");
};

test("the lean mesh draws the full mesh's segments: ground groups vertex for vertex, raised ones as the same layers", () => {
  const full = build(false);
  const lean = build(true);
  assert.equal(full.lineLayout, "full");
  assert.equal(lean.lineLayout, "lean");
  for (const [floats, stride, at] of [
    [LEAN_FLOATS, 8, "linePositions"],
    [G_LEAN_FLOATS, 20, "gLinePositions"],
  ] as const) {
    const want = fullSegments(full, stride, at);
    const got = expand(lean, floats, at);
    // The full mesh: the raised communes, the commune off the plateau, the context.
    assert.deepEqual(
      want.map((g) => [g.range.raised, g.range.alpha, g.segments.length]),
      [
        [true, 0.95, 12],
        [false, 0.95, 4],
        [false, 0.85, 8],
      ],
    );
    // Ground groups: the same vertices, in the same order.
    const ground = (list: typeof want) => list.filter((g) => !g.range.raised);
    assert.deepEqual(
      ground(got).map((g) => g.segments),
      ground(want).map((g) => g.segments),
      at,
    );
    assert.ok(ground(got).every((g) => !g.range.twice));
    // The raised group: c1's right edge is one segment where c2 and c3 have
    // two (no pair), c2's top is c3's bottom (one pair). 11 records for 12.
    const raised = got.filter((g) => g.range.raised);
    assert.deepEqual(
      raised.map((g) => [g.range.twice ?? false, g.range.count / SEGMENT_VERTICES]),
      [
        [false, 10],
        [true, 1],
      ],
    );
    const layers = (list: string[]) => list.map((s) => quadKey(s, stride)).sort();
    assert.deepEqual(
      layers(raised.flatMap((g) => g.segments)),
      layers(want.filter((g) => g.range.raised).flatMap((g) => g.segments)),
      at,
    );
  }
  // The ranges count vertices drawn; the buffers are 8 and 20/3 times smaller a segment.
  assert.equal(full.lineVertexCount, 24 * 6);
  assert.equal(lean.lineVertexCount, 23 * 6);
  assert.equal(full.linePositions!.byteLength, 24 * 192);
  assert.equal(lean.linePositions!.byteLength, 23 * 24);
  assert.equal(full.gLinePositions!.byteLength, 24 * 480);
  assert.equal(lean.gLinePositions!.byteLength, 23 * 72);
});

test("the lean mesh: everything but the lines is the full mesh's", () => {
  const full = build(false);
  const lean = build(true);
  const bytes = (a: ArrayBufferView | null) =>
    a ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : null;
  for (const k of [
    "rim",
    "positions",
    "lidPositions",
    "haloPositions",
    "gWallPositions",
    "gLidPositions",
    "gHaloPositions",
  ] as const) {
    assert.deepEqual(bytes(lean[k]), bytes(full[k]), k);
  }
  for (const k of [
    "scopeId",
    "heightM",
    "rimCount",
    "vertexCount",
    "lidVertexCount",
    "haloVertexCount",
    "origin",
    "haloW",
    "haloCos",
    "fillRecords",
  ] as const) {
    assert.deepEqual(lean[k], full[k], k);
  }
});

test("the lean mesh: mercator first, then the globe pass, each equal to the eager build's", () => {
  const eager = build(true);
  const first = build(true, { merc: true, globe: false });
  const late = build(true, { merc: false, globe: true });
  assert.deepEqual(first.linePositions, eager.linePositions);
  assert.equal(first.gLinePositions, null);
  assert.deepEqual(late.gLinePositions, eager.gLinePositions);
  assert.equal(late.linePositions, null);
  assert.equal(late.lineVertexCount, 0);
  assert.equal(first.lineVertexCount, eager.lineVertexCount);
  for (const m of [first, late]) {
    assert.deepEqual(m.lineGroups, eager.lineGroups);
    assert.equal(m.lineLayout, "lean");
  }
});

test("the lean mesh at a world scope: the lines alone, no pair on the ground, the origin the first line vertex's", () => {
  const ctx = [rect("FR", -5, 42, 4, 51, "country"), rect("DE", 4, 42, 13, 51, "country")];
  const full = buildPlateauMesh([], 0, ctx, [], { merc: true, globe: true, concat: true });
  const lean = buildPlateauMesh([], 0, ctx, [], {
    merc: true,
    globe: true,
    concat: true,
    lean: true,
  });
  assert.deepEqual(lean.origin, full.origin);
  assert.deepEqual(lean.lineGroups, full.lineGroups);
  assert.deepEqual(
    expand(lean, LEAN_FLOATS, "linePositions").map((g) => g.segments),
    fullSegments(full, 8, "linePositions").map((g) => g.segments),
  );
  assert.deepEqual(
    expand(lean, G_LEAN_FLOATS, "gLinePositions").map((g) => g.segments),
    fullSegments(full, 20, "gLinePositions").map((g) => g.segments),
  );
});
