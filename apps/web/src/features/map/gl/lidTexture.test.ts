// The lid's GL limits read once (readLidGlLimits, from the layer's onAdd) and
// its upload (uploadLidTexture, from render) against a fake GL that logs every
// call: the upload is today's sequence, copied, and makes no GL query, the
// query that #171 found stalling the first lid's frame. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no mapbox.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readLidGlLimits, uploadLidTexture } from "./lidTexture";

type Call = [string, ...unknown[]];

const CONSTANTS = [
  "TEXTURE0",
  "TEXTURE_2D",
  "UNPACK_FLIP_Y_WEBGL",
  "RGBA",
  "UNSIGNED_BYTE",
  "TEXTURE_MIN_FILTER",
  "TEXTURE_MAG_FILTER",
  "TEXTURE_WRAP_S",
  "TEXTURE_WRAP_T",
  "LINEAR_MIPMAP_LINEAR",
  "LINEAR",
  "CLAMP_TO_EDGE",
  "MAX_TEXTURE_SIZE",
];
const STATE_CALLS = [
  "activeTexture",
  "bindTexture",
  "pixelStorei",
  "texImage2D",
  "generateMipmap",
  "texParameteri",
  "texParameterf",
];
const QUERIES = [
  "getParameter",
  "getExtension",
  "getError",
  "finish",
  "readPixels",
  "getProgramParameter",
  "getShaderParameter",
  "getTexParameter",
  "getContextAttributes",
];

const EXT = { MAX_TEXTURE_MAX_ANISOTROPY_EXT: "MAXANISO", TEXTURE_MAX_ANISOTROPY_EXT: "ANISO" };

/** A fake WebGL2 context: constants are their own names, every call is
 *  logged. `strict` makes every query throw (the upload must make none). */
function fakeGl(opts: { ext?: boolean; maxAniso?: number; strict?: boolean } = {}) {
  const log: Call[] = [];
  const gl: Record<string, unknown> = {};
  for (const c of CONSTANTS) gl[c] = c;
  for (const name of STATE_CALLS) gl[name] = (...args: unknown[]) => void log.push([name, ...args]);
  for (const name of QUERIES) {
    gl[name] = (...args: unknown[]) => {
      if (opts.strict) throw new Error(`GL query in the upload: ${name}`);
      log.push([name, ...args]);
      if (name === "getExtension") return opts.ext === false ? null : EXT;
      if (name === "getParameter") {
        if (args[0] === "MAX_TEXTURE_SIZE") return 16384;
        if (args[0] === "MAXANISO") return opts.maxAniso ?? 16;
      }
      return null;
    };
  }
  return { gl: gl as unknown as WebGL2RenderingContext, log };
}

const ext = EXT as unknown as EXT_texture_filter_anisotropic;
const TEX = { tex: 1 } as unknown as WebGLTexture;
const BITMAP = { bitmap: 1 } as unknown as ImageBitmap;

/** Today's upload (PlateauWallLayer.render at dc95e86, the lazy probe
 *  aside), copied: the calls, their order and their arguments. */
function oracle(anisoExt: unknown, maxAniso: number): Call[] {
  const calls: Call[] = [
    ["activeTexture", "TEXTURE0"],
    ["bindTexture", "TEXTURE_2D", TEX],
    ["pixelStorei", "UNPACK_FLIP_Y_WEBGL", false],
    ["texImage2D", "TEXTURE_2D", 0, "RGBA", "RGBA", "UNSIGNED_BYTE", BITMAP],
    ["generateMipmap", "TEXTURE_2D"],
    ["texParameteri", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "LINEAR_MIPMAP_LINEAR"],
    ["texParameteri", "TEXTURE_2D", "TEXTURE_MAG_FILTER", "LINEAR"],
    ["texParameteri", "TEXTURE_2D", "TEXTURE_WRAP_S", "CLAMP_TO_EDGE"],
    ["texParameteri", "TEXTURE_2D", "TEXTURE_WRAP_T", "CLAMP_TO_EDGE"],
  ];
  if (anisoExt && maxAniso > 1) {
    calls.push(["texParameterf", "TEXTURE_2D", "ANISO", Math.min(8, maxAniso)]);
  }
  return calls;
}

const READS: Call[] = [
  ["getParameter", "MAX_TEXTURE_SIZE"],
  ["getExtension", "EXT_texture_filter_anisotropic"],
  ["getParameter", "MAXANISO"],
];

test("readLidGlLimits reads the texture ceiling and the anisotropy once each", () => {
  const { gl, log } = fakeGl();
  const lim = readLidGlLimits(gl);
  assert.deepEqual(log, READS);
  assert.deepEqual(lim, { maxTextureSize: 16384, anisoExt: EXT, maxAniso: 16 });
});

test("no extension: -1 and no second query", () => {
  const { gl, log } = fakeGl({ ext: false });
  const lim = readLidGlLimits(gl);
  assert.deepEqual(lim, { maxTextureSize: 16384, anisoExt: null, maxAniso: -1 });
  assert.equal(log.filter((c) => c[0] === "getParameter").length, 1);
});

test("called again (a re-add): read again", () => {
  const { gl, log } = fakeGl();
  readLidGlLimits(gl);
  readLidGlLimits(gl);
  assert.deepEqual(log, [...READS, ...READS]);
});

const CASES: [string, EXT_texture_filter_anisotropic | null, number][] = [
  ["maxAniso 16", ext, 16],
  ["maxAniso 4", ext, 4],
  ["maxAniso 1", ext, 1],
  ["maxAniso 0", ext, 0],
  ["maxAniso -1", ext, -1],
  ["no extension, maxAniso 16", null, 16],
];

test("the upload is today's sequence, copied", () => {
  for (const [label, anisoExt, maxAniso] of CASES) {
    const { gl, log } = fakeGl();
    uploadLidTexture(gl, TEX, BITMAP, anisoExt, maxAniso);
    assert.deepEqual(log, oracle(anisoExt, maxAniso), label);
  }
  // The anisotropy applied: min(8, max), or none.
  const { gl, log } = fakeGl();
  uploadLidTexture(gl, TEX, BITMAP, ext, 16);
  assert.deepEqual(log.at(-1), ["texParameterf", "TEXTURE_2D", "ANISO", 8]);
});

test("the upload makes no GL query", () => {
  for (const [label, anisoExt, maxAniso] of CASES) {
    const { gl, log } = fakeGl({ strict: true });
    assert.doesNotThrow(() => uploadLidTexture(gl, TEX, BITMAP, anisoExt, maxAniso), label);
    assert.ok(log.length >= 9, label);
  }
});
