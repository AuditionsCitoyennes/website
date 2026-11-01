// The web's plateau relief renderer (apps/web/src/features/map/relief/demRaster.ts)
// against the API's (apps/api/src/modules/dem/service.ts), and against the
// golden hashes that outlive the API module. Run with `node --import tsx --test`
// (root "test:scripts").
//
// - "server parity": per fixture and height, the version key and every chosen
//   tile, texel for texel (the server's PNG decoded by ./pngRgb). It is the only
//   block that needs the API: removing the API renderer removes this block.
// - "golden": the web renderer's tiles hashed per fixture|height|z against
//   demRelief.golden.json. A missing or stale line fails; a plain run never writes.
//
// Update mode, the one way to write demRelief.golden.json and demGround.ts
// (from the SERVER's tiles; every client == server assert still runs, only the
// client == golden block is skipped; refused on CI):
//   UPDATE_GOLDEN=1 node --import tsx scripts/parity/demRelief.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { before, describe, test } from "node:test";
import {
  SIZE,
  constantRgb,
  demKey,
  encodeHeight,
  encodePNG,
  makeSelection,
  pngDataUrl,
  polysOf,
  renderDemTile,
  tileTouches,
  type DemSelection,
  type Polygon,
} from "../../apps/web/src/features/map/relief/demRaster";
import { decodeRgbPng } from "./pngRgb";

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
const serverHashes = new Map<string, ZHashes>();

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

function differingTexels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < SIZE * SIZE * 3; i += 3) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
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

describe("server parity", () => {
  let S: typeof import("../../apps/api/src/modules/dem/service");
  before(async () => {
    S = await import("../../apps/api/src/modules/dem/service");
  });

  for (const f of FIXTURES) {
    for (const height of f.heights) {
      test(`${f.name} at ${height} m`, async (t) => {
        const t0 = performance.now();
        const { features, polys, tiles } = planOf(f);
        const id = pairId(f, height);
        // The store holds 40 versions: post right before rendering.
        const version = S.setSelection(features, height);
        const keyEqual = (await demKey(polys, height)) === version;
        const sel = makeSelection(polys, height);
        let edgeTiles = 0;
        let constantTiles = 0;
        let texels = 0;
        let pngBytesEqual = 0;
        const differing: string[] = [];
        for (const { z, x, y, far } of tiles) {
          const png = S.renderTile(version, z, x, y);
          assert.ok(png, `${z}/${x}/${y}: the server lost version ${version}`);
          const server = Buffer.from(decodeRgbPng(png).rgb);
          const client = renderDemTile(sel, z, x, y);
          const d = differingTexels(server, client.rgb);
          if (d) differing.push(`${z}/${x}/${y}: ${d} texels`);
          texels += d;
          const touches = tileTouches(sel.bbox, z, x, y);
          if (!touches) assert.ok(server.equals(GROUND), `${z}/${x}/${y}: untouched, not ground`);
          if (far) {
            assert.equal(touches, false, `${z}/${x}/${y}: far tile touches`);
            assert.equal(client.constant, "ground", `${z}/${x}/${y}: far tile not ground`);
          }
          if (client.constant === null) edgeTiles++;
          else constantTiles++;
          if (Buffer.from(await encodePNG(client.rgb, SIZE, SIZE)).equals(png)) pngBytesEqual++;
          push(serverHashes, id, z, sha256(server));
          push(clientHashes, id, z, sha256(client.rgb));
        }
        t.diagnostic(
          JSON.stringify({
            fixture: f.name,
            height,
            tiles: tiles.length,
            edgeTiles,
            constantTiles,
            differingTexels: texels,
            keyEqual,
            pngBytesEqual,
            ms: Math.round(performance.now() - t0),
          }),
        );
        assert.equal(keyEqual, true, `${id}: demKey !== the server's version ${version}`);
        assert.deepEqual(differing, [], `${id}: tiles differ`);
      });
    }
  }

  test("the stored height is the first one posted, unrounded; the key rounds it", async () => {
    const square = FIXTURES.find((f) => f.name === "square")!;
    const { features, polys, tiles } = planOf(square);
    // A key no other test posts (41): the server memoises tiles per version, so
    // a key rendered before would answer from that memo whatever the store holds.
    const first = S.setSelection(features, 41.4);
    assert.equal(S.setSelection(features, 41), first);
    assert.equal(await demKey(polys, 41), first);
    const top = tiles.find((t) => t.constant === "plateau")!;
    const server = decodeRgbPng(S.renderTile(first, top.z, top.x, top.y)!).rgb;
    assert.equal((server[0] << 16) | (server[1] << 8) | server[2], 100414);
    assert.deepEqual([...server.subarray(0, 3)], encodeHeight(41.4));
    const client = renderDemTile(makeSelection(polys, 41.4), top.z, top.x, top.y);
    assert.ok(Buffer.from(server).equals(client.rgb));
  });

  if (UPDATE) {
    test("UPDATE_GOLDEN: writes the golden and demGround.ts from the server's tiles", async () => {
      const lines: string[] = [];
      for (const f of FIXTURES) {
        for (const h of f.heights) {
          const byZ = serverHashes.get(pairId(f, h));
          assert.ok(byZ, `${pairId(f, h)}: no server tiles`);
          for (const [k, v] of goldenLines(pairId(f, h), byZ)) {
            lines.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
          }
        }
      }
      fs.writeFileSync(GOLDEN, `{\n${lines.join(",\n")}\n}\n`);
      const empty = S.setSelection([], 0);
      const url = pngDataUrl(S.renderTile(empty, 0, 0, 0)!);
      fs.writeFileSync(
        GROUND_TS,
        "// The ground tile (0 m everywhere) as a data: URL. Generated from the API's\n" +
          "// renderer by `UPDATE_GOLDEN=1 node --import tsx scripts/parity/demRelief.test.ts`:\n" +
          "// do not edit by hand.\n" +
          `export const GROUND_DATA_URL =\n  ${JSON.stringify(url)};\n`,
      );
    });
  }
});

describe("golden", { skip: UPDATE && "UPDATE_GOLDEN: written from the server" }, () => {
  let golden: Record<string, { n: number; h: string }>;
  before(() => {
    assert.ok(fs.existsSync(GOLDEN), "no golden: run UPDATE_GOLDEN=1 (header)");
    assert.ok(fs.statSync(GOLDEN).size <= GOLDEN_MAX_BYTES, "golden over 60 KB");
    golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  });

  const expected = new Set<string>();
  for (const f of FIXTURES) {
    for (const height of f.heights) {
      test(`${f.name} at ${height} m`, () => {
        const id = pairId(f, height);
        // The parity block's hashes when it ran, else the client renders alone.
        if (!clientHashes.has(id)) {
          const { polys, tiles } = planOf(f);
          const sel = makeSelection(polys, height);
          for (const { z, x, y } of tiles)
            push(clientHashes, id, z, sha256(renderDemTile(sel, z, x, y).rgb));
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
