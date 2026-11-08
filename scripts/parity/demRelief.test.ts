// The web's plateau relief renderer (apps/web/src/features/map/relief/demRaster.ts)
// against its golden. Run with `node --import tsx --test` (root "test:scripts").
//
// The golden was produced by apps/api's DEM service at 0e926bf (#140, the
// relief-raster PR) and verified unchanged in pr-remove-dem, which also added
// the service's version keys before deleting it; regenerating it is a
// deliberate visual change (bump RENDER_REV).
//
// - "golden": per fixture and height, the client's tiles hashed per z, and its
//   version key, against demRelief.golden.json; every far sample is ground by
//   the box cull (tileTouches) and by a full render alike. A missing or stale
//   line fails; a plain run never writes.
//
// Update mode, the one way to write demRelief.golden.json and demGround.ts
// (from the CLIENT renderer; the golden block is skipped; refused on CI):
//   UPDATE_GOLDEN=1 node --import tsx scripts/parity/demRelief.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { before, describe, test } from "node:test";
import {
  SIZE,
  constantRgb,
  demKey,
  encodePNG,
  makeSelection,
  pngDataUrl,
  polysOf,
  renderDemTile,
  tileTouches,
  type DemSelection,
  type Polygon,
} from "../../apps/web/src/features/map/relief/demRaster";

const UPDATE = process.env.UPDATE_GOLDEN === "1";
if (UPDATE && process.env.CI) throw new Error("UPDATE_GOLDEN writes files: not on CI");

const FIXTURES_DIR = new URL("./fixtures/dem/", import.meta.url);
const GOLDEN = new URL("./demRelief.golden.json", import.meta.url);
const GROUND_TS = new URL("../../apps/web/src/features/map/relief/demGround.ts", import.meta.url);
const GOLDEN_MAX_BYTES = 60_000;
/** Tiles per zoom from z4 up: up to PER_Z - EDGE_ROOM edge tiles, the rest split
 *  between the plateau and the ground tiles, each by an even stride (planOf). */
const PER_Z = 24;
/** Slots per zoom the edge tiles leave to the constant ones. */
const EDGE_ROOM = 4;
const T0 = performance.now();

interface Fixture {
  name: string;
  file: string;
  zMax: number;
  heights: number[];
}

// zMax: the canonical DEM zoom the site would ask for such a unit (usePlateau
// clamps it to 4..15). Heights as sent, unrounded: 37.5 m is the floor, and
// 1234.567 keys as 1235 but encodes as 112346.
const FIXTURES: Fixture[] = [
  { name: "metropole", file: "metropole.geojson", zMax: 7, heights: [37.5, 1234.567] },
  { name: "region-84", file: "region-84.geojson", zMax: 9, heights: [37.5, 1234.567] },
  { name: "departement-69", file: "departement-69.geojson", zMax: 11, heights: [37.5, 1234.567] },
  { name: "departement-83", file: "departement-83.geojson", zMax: 11, heights: [37.5, 1234.567] },
  { name: "square", file: "square.geojson", zMax: 15, heights: [37.5, 1234.567, 800] },
  { name: "hole", file: "hole.geojson", zMax: 15, heights: [37.5, 1234.567] },
  { name: "seam", file: "seam.geojson", zMax: 15, heights: [37.5, 1234.567] },
  { name: "antimeridian", file: "antimeridian.geojson", zMax: 15, heights: [37.5, 1234.567] },
  { name: "cull-edge", file: "cull-edge.geojson", zMax: 15, heights: [37.5, 1234.567] },
  { name: "empty", file: "empty.geojson", zMax: 15, heights: [37.5, 1234.567] },
];
/** Fixtures whose plateau tiles must show at z >= 12. */
const PLATEAU_AT_12 = new Set(["square", "hole", "antimeridian"]);
/** The empty selection: a fixed list, all ground. */
const EMPTY_TILES: [number, number, number][] = [
  [0, 0, 0],
  [4, 8, 5],
  [15, 16384, 16384],
];

interface PlanTile {
  z: number;
  x: number;
  y: number;
  /** The client's answer (height-blind: it counts plateau texels). */
  constant: "ground" | "plateau" | null;
  /** A far sample: 2-3 tiles off the selection, or the world's far corner. */
  far: boolean;
}

interface Plan {
  features: { geometry?: { type?: string; coordinates?: unknown } }[];
  polys: Polygon[];
  tiles: PlanTile[];
}

// Whether any polygon's box comes near the padded tile: when none does, the
// client's tile is ground without being rendered (the renderer's own cull).
function nearAnyPolygon(sel: DemSelection, z: number, x: number, y: number): boolean {
  const b = sel.pboxes;
  for (let i = 0; i < b.length; i += 4) {
    if (tileTouches([b[i], b[i + 1], b[i + 2], b[i + 3]], z, x, y)) return true;
  }
  return false;
}

/** k items spread evenly over `list`, its first and last included. */
function spread<T>(list: T[], k: number): T[] {
  if (list.length <= k) return list;
  if (k <= 0) return [];
  if (k === 1) return [list[0]];
  return Array.from({ length: k }, (_, i) => list[Math.round((i * (list.length - 1)) / (k - 1))]);
}

const byYX = (a: PlanTile, b: PlanTile) => a.z - b.z || a.y - b.y || a.x - b.x;

function farSample(sel: DemSelection, z: number, taken: Set<string>): PlanTile[] {
  const n = 2 ** z;
  const [tx0, ty0, tx1, ty1] = sel.bbox.map((c) => Math.floor(c * n));
  const mx = Math.floor((tx0 + tx1) / 2);
  const my = Math.floor((ty0 + ty1) / 2);
  const cu = (sel.bbox[0] + sel.bbox[2]) / 2;
  const cv = (sel.bbox[1] + sel.bbox[3]) / 2;
  const out: PlanTile[] = [];
  for (const [x, y] of [
    [tx0 - 2, ty0 - 2],
    [tx1 + 2, ty0 - 2],
    [tx0 - 2, ty1 + 2],
    [tx1 + 2, ty1 + 2],
    [mx, ty0 - 3],
    [mx, ty1 + 3],
    [tx0 - 3, my],
    [tx1 + 3, my],
    [cu < 0.5 ? n - 1 : 0, cv < 0.5 ? n - 1 : 0],
  ]) {
    const id = `${z}/${x}/${y}`;
    if (x < 0 || y < 0 || x >= n || y >= n || taken.has(id)) continue;
    taken.add(id);
    out.push({ z, x, y, constant: "ground", far: true });
  }
  return out;
}

const plans = new Map<string, Plan>();

/** The fixture's tiles: every tile for z 0..3, then per z the bbox ± 1 tile
 *  (clamped to the world) cut to PER_Z, edge tiles first, plus the far sample. */
function planOf(f: Fixture): Plan {
  const cached = plans.get(f.name);
  if (cached) return cached;
  const json = JSON.parse(fs.readFileSync(new URL(f.file, FIXTURES_DIR), "utf8"));
  const features = json.type === "FeatureCollection" ? json.features : [json];
  const polys = polysOf(features);
  const sel = makeSelection(polys, 0);
  const tiles: PlanTile[] = [];
  const classify = (z: number, x: number, y: number) =>
    nearAnyPolygon(sel, z, x, y) ? renderDemTile(sel, z, x, y).constant : "ground";
  if (!polys.length) {
    for (const [z, x, y] of EMPTY_TILES) tiles.push({ z, x, y, constant: "ground", far: false });
  } else {
    for (let z = 0; z <= Math.min(3, f.zMax); z++) {
      for (let y = 0; y < 2 ** z; y++) {
        for (let x = 0; x < 2 ** z; x++)
          tiles.push({ z, x, y, constant: classify(z, x, y), far: false });
      }
    }
    for (let z = 4; z <= f.zMax; z++) {
      const n = 2 ** z;
      const clamp = (c: number) => Math.min(n - 1, Math.max(0, c));
      const [x0, y0, x1, y1] = sel.bbox.map((c, i) => clamp(Math.floor(c * n) + (i < 2 ? -1 : 1)));
      const edges: PlanTile[] = [];
      const plateau: PlanTile[] = [];
      const ground: PlanTile[] = [];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t: PlanTile = { z, x, y, constant: classify(z, x, y), far: false };
          (t.constant === null ? edges : t.constant === "plateau" ? plateau : ground).push(t);
        }
      }
      // Edges leave EDGE_ROOM slots, shared between the plateau and the ground
      // tiles (a stride over each), so a z with a plateau tile shows one.
      const chosenEdges = spread(edges, PER_Z - EDGE_ROOM);
      const room = PER_Z - chosenEdges.length;
      const nGround = Math.min(ground.length, room - Math.min(plateau.length, Math.ceil(room / 2)));
      const chosen = [
        ...chosenEdges,
        ...spread(plateau, room - nGround),
        ...spread(ground, nGround),
      ];
      chosen.sort(byYX);
      tiles.push(...chosen);
      tiles.push(...farSample(sel, z, new Set(chosen.map((t) => `${t.z}/${t.x}/${t.y}`))));
    }
  }
  const plan = { features, polys, tiles };
  plans.set(f.name, plan);
  return plan;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();
const pairId = (f: Fixture, h: number) => `${f.name}|${h}`;

/** Per pair, per z: the tiles' sha256(rgb), in plan order. */
type ZHashes = Map<number, Buffer[]>;
const clientHashes = new Map<string, ZHashes>();

function push(store: Map<string, ZHashes>, id: string, z: number, hash: Buffer): void {
  let byZ = store.get(id);
  if (!byZ) store.set(id, (byZ = new Map()));
  let list = byZ.get(z);
  if (!list) byZ.set(z, (list = []));
  list.push(hash);
}

/** The golden's lines for one pair: fixture|height|z → {n, h}. */
function goldenLines(id: string, byZ: ZHashes): [string, { n: number; h: string }][] {
  return [...byZ.entries()].map(([z, hashes]) => [
    `${id}|${z}`,
    { n: hashes.length, h: sha256(Buffer.concat(hashes)).toString("hex") },
  ]);
}

const GROUND = Buffer.from(constantRgb(0));

test("every fixture raises an edge tile and a plateau tile among the chosen ones", () => {
  for (const f of FIXTURES) {
    const { polys, tiles } = planOf(f);
    if (!polys.length) {
      assert.ok(tiles.every((t) => t.constant === "ground"));
      continue;
    }
    assert.ok(
      tiles.some((t) => t.constant === null),
      `${f.name}: no edge tile`,
    );
    assert.ok(
      tiles.some((t) => t.constant === "plateau"),
      `${f.name}: no plateau tile`,
    );
    if (PLATEAU_AT_12.has(f.name)) {
      assert.ok(
        tiles.some((t) => t.z >= 12 && t.constant === "plateau"),
        `${f.name}: z >= 12`,
      );
    }
  }
});

if (UPDATE) {
  test("UPDATE_GOLDEN: writes the golden and demGround.ts from the client's tiles", async () => {
    const lines: string[] = [];
    const keys: string[] = [];
    for (const f of FIXTURES) {
      const { polys, tiles } = planOf(f);
      for (const h of f.heights) {
        const id = pairId(f, h);
        const sel = makeSelection(polys, h);
        for (const { z, x, y } of tiles)
          push(clientHashes, id, z, sha256(renderDemTile(sel, z, x, y).rgb));
        for (const [k, v] of goldenLines(id, clientHashes.get(id)!)) {
          lines.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
        }
        keys.push(
          `${JSON.stringify(`${id}|key`)}: ${JSON.stringify({ key: await demKey(polys, h) })}`,
        );
      }
    }
    fs.writeFileSync(GOLDEN, `{\n${[...lines, ...keys].join(",\n")}\n}\n`);
    const url = pngDataUrl(await encodePNG(constantRgb(0), SIZE, SIZE));
    fs.writeFileSync(
      GROUND_TS,
      "// The ground tile (0 m everywhere) as a data: URL. Generated from the client's\n" +
        "// renderer by `UPDATE_GOLDEN=1 node --import tsx scripts/parity/demRelief.test.ts`:\n" +
        "// do not edit by hand.\n" +
        `export const GROUND_DATA_URL =\n  ${JSON.stringify(url)};\n`,
    );
  });
}

describe("golden", { skip: UPDATE && "UPDATE_GOLDEN: written from the client" }, () => {
  let golden: Record<string, { n?: number; h?: string; key?: string }>;
  before(() => {
    assert.ok(fs.existsSync(GOLDEN), "no golden: run UPDATE_GOLDEN=1 (header)");
    assert.ok(fs.statSync(GOLDEN).size <= GOLDEN_MAX_BYTES, "golden over 60 KB");
    golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  });

  const expected = new Set<string>();
  for (const f of FIXTURES) {
    for (const height of f.heights) {
      test(`${f.name} at ${height} m`, async () => {
        const id = pairId(f, height);
        // The version key, as the server gave it when the golden was written.
        expected.add(`${id}|key`);
        assert.equal(
          await demKey(planOf(f).polys, height),
          golden[`${id}|key`]?.key,
          `${id}: demKey left the golden`,
        );
        const { polys, tiles } = planOf(f);
        const sel = makeSelection(polys, height);
        for (const { z, x, y, far } of tiles) {
          const { rgb } = renderDemTile(sel, z, x, y);
          if (far) {
            assert.equal(tileTouches(sel.bbox, z, x, y), false, `${z}/${x}/${y}: far tile touches`);
            assert.ok(Buffer.from(rgb).equals(GROUND), `${z}/${x}/${y}: far tile not ground`);
          }
          push(clientHashes, id, z, sha256(rgb));
        }
        const byZ = clientHashes.get(id)!;
        const lines = goldenLines(id, byZ);
        for (const [k] of lines) expected.add(k);
        for (const [k, v] of lines) {
          const tilesOfZ = planOf(f).tiles.filter((t) => `${id}|${t.z}` === k);
          assert.deepEqual(
            golden[k],
            v,
            `${k}: the client's tiles left the golden; per tile:\n` +
              tilesOfZ
                .map((t, i) => `${t.z}/${t.x}/${t.y} ${byZ.get(t.z)![i].toString("hex")}`)
                .join("\n"),
          );
        }
      });
    }
  }

  test("the golden holds no other line", () => {
    assert.deepEqual(
      Object.keys(golden).filter((k) => !expected.has(k)),
      [],
    );
  });
});

test("wall time", (t) => {
  t.diagnostic(`demRelief total ${Math.round(performance.now() - T0)} ms`);
});
