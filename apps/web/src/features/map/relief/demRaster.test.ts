// The relief renderer's own pieces (demRaster.ts): the encoding, the tile
// touch test, the key, the PNG writer and both of its deflates.
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no
// alias at run time. Its parity with the API's renderer is
// scripts/parity/demRelief.test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { decodeRgbPng } from "../../../../../../scripts/parity/pngRgb";
import {
  PAD,
  SIZE,
  constantRgb,
  demKey,
  encodeHeight,
  encodePNG,
  keyJson,
  makeSelection,
  pngDataUrl,
  polysOf,
  rasterizeMask,
  renderDemTile,
  tileTouches,
  zlibStored,
  type Polygon,
} from "./demRaster";

const RAW_BYTES = SIZE * (SIZE * 3 + 1); // 196,864: the filter byte + a row, per row
// Signature, IHDR, IDAT (zlib header, 4 stored-block headers, the raw rows, Adler-32), IEND.
const STORED_PNG_BYTES = 8 + (12 + 13) + (12 + 2 + 4 * 5 + RAW_BYTES + 4) + 12;

/** A 256 px tile with every byte varying, so a misplaced row or block shows. */
function pattern(): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 7 + (i >> 9)) & 255;
  return px;
}

function chunksOf(png: Uint8Array): { type: string; data: Buffer; crc: number }[] {
  const b = Buffer.from(png);
  const out = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o);
    out.push({
      type: b.toString("ascii", o + 4, o + 8),
      data: b.subarray(o + 8, o + 8 + len),
      crc: b.readUInt32BE(o + 8 + len),
    });
    o += 12 + len;
  }
  return out;
}

const SQUARE: Polygon = [
  [
    [-10, -10],
    [10, -10],
    [10, 10],
    [-10, 10],
    [-10, -10],
  ],
];

test("terrain-RGB: ground is 1,134,160; 0.1 m steps from -10,000 m", () => {
  assert.deepEqual(encodeHeight(0), [1, 134, 160]);
  const v = (c: number[]) => (c[0] << 16) | (c[1] << 8) | c[2];
  assert.equal(v(encodeHeight(37.5)), 100375);
  assert.equal(v(encodeHeight(1234.567)), 112346);
  assert.equal(v(encodeHeight(1235)), 112350);
});

test("constantRgb repeats one height over the tile", () => {
  const rgb = constantRgb(800);
  assert.equal(rgb.length, SIZE * SIZE * 3);
  const c = encodeHeight(800);
  for (let i = 0; i < rgb.length; i += 3) {
    assert.ok(rgb[i] === c[0] && rgb[i + 1] === c[1] && rgb[i + 2] === c[2], `texel ${i / 3}`);
  }
});

test("tileTouches reaches PAD + 1 texels past each tile edge, no further", () => {
  // z1: the world is 512 texels; tile 1/1/1 spans 256..512 on both axes.
  const ws = 512;
  const reach = PAD + 1;
  const at = (u0: number, v0: number, u1: number, v1: number) =>
    tileTouches([u0 / ws, v0 / ws, u1 / ws, v1 / ws], 1, 1, 1);
  assert.equal(at(0, 300, 256 - reach, 310), true);
  assert.equal(at(0, 300, 256 - reach - 0.01, 310), false);
  assert.equal(at(300, 0, 310, 256 - reach), true);
  assert.equal(at(300, 0, 310, 256 - reach - 0.01), false);
  // Tile 1/0/0 spans 0..256: its far edges.
  const far = (u0: number, v0: number) => tileTouches([u0 / ws, v0 / ws, 1, 1], 1, 0, 0);
  assert.equal(far(256 + reach, 0), true);
  assert.equal(far(256 + reach + 0.01, 0), false);
  assert.equal(far(0, 256 + reach), true);
  assert.equal(far(0, 256 + reach + 0.01), false);
  // The empty selection touches nothing.
  assert.equal(tileTouches(makeSelection([], 37.5).bbox, 0, 0, 0), false);
});

test("keyJson and demKey: the server's string and hash, the height rounded", async () => {
  const polys = polysOf([{ type: "Feature", geometry: { type: "Polygon", coordinates: SQUARE } }]);
  const json = `{"polys":[${JSON.stringify(SQUARE)}],"height":38}`;
  assert.equal(keyJson(polys, 37.5), json);
  assert.equal(keyJson(polys, 38.4), json);
  assert.notEqual(keyJson(polys, 38.5), json);
  const sha1 = createHash("sha1").update(`1\n${json}`).digest("hex").slice(0, 32);
  assert.equal(await demKey(polys, 37.5), sha1);
  // The digest is injectable: it gets exactly the hashed bytes.
  let hashed = "";
  await demKey(polys, 37.5, async (b) => {
    hashed = new TextDecoder().decode(b);
    return new ArrayBuffer(20);
  });
  assert.equal(hashed, `1\n${json}`);
});

test("encodePNG round-trips, every chunk's CRC valid", async () => {
  const px = pattern();
  const png = await encodePNG(px, SIZE, SIZE);
  const back = decodeRgbPng(png);
  assert.equal(back.w, SIZE);
  assert.equal(back.h, SIZE);
  assert.ok(Buffer.from(back.rgb).equals(px));
  const small = await encodePNG(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 2, 2);
  assert.deepEqual([...decodeRgbPng(small).rgb], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const p of [png, small, await encodePNG(px, SIZE, SIZE, zlibStored)]) {
    const chunks = chunksOf(p);
    assert.deepEqual(
      chunks.map((c) => c.type),
      ["IHDR", "IDAT", "IEND"],
    );
    for (const c of chunks) {
      assert.equal(c.crc, crc32(c.data, crc32(c.type)), `${c.type} CRC`);
    }
  }
});

test("zlibStored: stored blocks of 65,535 bytes and the Adler-32 (inflate checks both)", async () => {
  const px = pattern();
  const png = await encodePNG(px, SIZE, SIZE, zlibStored);
  // 196,864 raw bytes: three full blocks and a last one, three block seams crossed.
  assert.equal(png.length, STORED_PNG_BYTES);
  assert.ok(Buffer.from(decodeRgbPng(png).rgb).equals(px));
  for (const n of [0, 1, 65535, 65536, 3 * 65535 + 7]) {
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = (i * 31) & 255;
    assert.ok(inflateSync(zlibStored(raw)).equals(raw), `${n} bytes`);
  }
});

test("encodePNG falls back to stored blocks when CompressionStream is missing", async () => {
  const g = globalThis as { CompressionStream?: unknown };
  const saved = g.CompressionStream;
  const px = pattern();
  try {
    delete g.CompressionStream;
    const png = await encodePNG(px, SIZE, SIZE);
    assert.equal(png.length, STORED_PNG_BYTES);
    assert.ok(Buffer.from(decodeRgbPng(png).rgb).equals(px));
  } finally {
    g.CompressionStream = saved;
  }
  assert.ok((await encodePNG(px, SIZE, SIZE)).length < STORED_PNG_BYTES / 10);
});

test("pngDataUrl encodes a stored-block tile whole", async () => {
  const png = await encodePNG(pattern(), SIZE, SIZE, zlibStored);
  const url = pngDataUrl(png);
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.ok(Buffer.from(url.slice(22), "base64").equals(png));
});

test("a tile inside the plateau is constantRgb(height), one outside is constantRgb(0)", () => {
  const sel = makeSelection([SQUARE], 1234.567);
  // z6 32/32 spans lng 0..5.6 and lat 0..-5.6: deep inside the ±10° square.
  const inside = renderDemTile(sel, 6, 32, 32);
  assert.equal(inside.constant, "plateau");
  assert.ok(Buffer.from(inside.rgb).equals(constantRgb(1234.567)));
  const outside = renderDemTile(sel, 6, 0, 0);
  assert.equal(outside.constant, "ground");
  assert.ok(Buffer.from(outside.rgb).equals(constantRgb(0)));
  const edge = renderDemTile(sel, 2, 2, 2);
  assert.equal(edge.constant, null);
  const empty = renderDemTile(makeSelection([], 37.5), 15, 16384, 16384);
  assert.equal(empty.constant, "ground");
});

test("the per-polygon box cull leaves the mask, so the bytes, as no cull does", () => {
  const url = new URL(
    "../../../../../../scripts/parity/fixtures/dem/cull-edge.geojson",
    import.meta.url,
  );
  const fc = JSON.parse(fs.readFileSync(url, "utf8"));
  const [cx8, cy8] = fc.features[0].properties.corner as number[];
  const sel = makeSelection(polysOf(fc.features), 37.5);
  let culled = 0;
  let kept = 0;
  for (let z = 8; z <= 12; z++) {
    const s = 2 ** (z - 8);
    // The four tiles meeting at the corner the fixture's squares hug.
    for (const [x, y] of [
      [cx8 * s - 1, cy8 * s - 1],
      [cx8 * s, cy8 * s - 1],
      [cx8 * s - 1, cy8 * s],
      [cx8 * s, cy8 * s],
    ]) {
      // The mask, not only the tile: the erosion clears squares this small, so
      // a cull a few texels too eager would still render the same bytes.
      const maskOn = rasterizeMask(sel, z, x, y, PAD, true);
      const maskOff = rasterizeMask(sel, z, x, y, PAD, false);
      assert.ok(Buffer.from(maskOn).equals(maskOff), `${z}/${x}/${y}: mask`);
      const on = renderDemTile(sel, z, x, y, true);
      const off = renderDemTile(sel, z, x, y, false);
      assert.ok(Buffer.from(on.rgb).equals(off.rgb), `${z}/${x}/${y}`);
      // Not vacuous: boxes within 2 texels of the cull line, on both sides of it.
      const d = 2 / (SIZE * 2 ** z);
      const b = sel.pboxes;
      for (let i = 0; i < b.length; i += 4) {
        const grown = tileTouches([b[i] - d, b[i + 1] - d, b[i + 2] + d, b[i + 3] + d], z, x, y);
        const shrunk = tileTouches([b[i] + d, b[i + 1] + d, b[i + 2] - d, b[i + 3] - d], z, x, y);
        if (grown === shrunk) continue;
        if (tileTouches([b[i], b[i + 1], b[i + 2], b[i + 3]], z, x, y)) kept++;
        else culled++;
      }
    }
  }
  assert.ok(culled > 0 && kept > 0, `culled ${culled}, kept ${kept}`);
});
