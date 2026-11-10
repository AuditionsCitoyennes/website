// The elevated-terrain capability (terrainSwitch.ts), run with
// `node --import tsx --test` (root "test:scripts"): a build without the
// testing tools never reads its storage (a counting stub holding "off") and
// stands terrain in node (no OffscreenCanvas, so no noise); with the testing
// tools a kept "off" goes flat, garbage and a throwing storage give the
// default; the setter stores and reloads, as lidSwitch.check.test.ts; the
// canvas read against a fake OffscreenCanvas, as Mapbox runs it; and a drift
// guard on Mapbox's own text. The module is imported after the stubs (its
// values are read at load), under a fresh query each time, as meshSwitch.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
  window?: unknown;
};

let reads = 0;
const keeping = (stored: string) => ({
  getItem(k: string) {
    reads++;
    return k === "ac:terrain" ? stored : null;
  },
});

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./terrainSwitch.ts?mode=${++n}`)) as typeof import("./terrainSwitch");
}

test("terrainMode: the default without the testing tools, storage unread, terrain in node", async () => {
  g.localStorage = keeping("off");
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.terrainMode, "auto");
    assert.equal(m.DEFAULT_TERRAIN_MODE, "auto");
    assert.deepEqual(m.TERRAIN_MODES, ["auto", "off"]);
    assert.equal(m.canvasNoise, false);
    assert.equal(m.terrainAvailable, true);
  } finally {
    delete g.localStorage;
  }
});

test("terrainMode: a kept off goes flat, garbage and a throwing storage give auto, with the testing tools", async () => {
  try {
    g.localStorage = keeping("off");
    reads = 0;
    const off = await load(true);
    assert.equal(reads, 1);
    assert.deepEqual([off.terrainMode, off.terrainAvailable], ["off", false]);
    for (const garbage of ["", "Off", "auto ", "flat", "on"]) {
      g.localStorage = keeping(garbage);
      const m = await load(true);
      assert.deepEqual([m.terrainMode, m.terrainAvailable], ["auto", true], garbage);
    }
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    assert.equal((await load(true)).terrainMode, "auto");
  } finally {
    delete g.localStorage;
  }
});

test("setTerrainMode: kept and reloaded, a no-op without the testing tools or on the same mode", async () => {
  let stored: Record<string, string> = {};
  let reloads = 0;
  g.localStorage = {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
  };
  g.window = { location: { reload: () => reloads++ } };
  try {
    const m = await load(true); // "auto"
    assert.equal(m.canvasNoise, false); // a window, still no OffscreenCanvas
    m.setTerrainMode("auto");
    assert.deepEqual([stored, reloads], [{}, 0]);
    m.setTerrainMode("off");
    assert.deepEqual([stored, reloads], [{ "ac:terrain": "off" }, 1]);
    stored = {};
    const without = await load(false);
    g.__TEST_TOOLS__ = false;
    without.setTerrainMode("off");
    assert.deepEqual([stored, reloads], [{}, 1]);
  } finally {
    delete g.localStorage;
    delete g.window;
  }
});

/** A fake OffscreenCanvas: its 2D context records the calls and reads back what was drawn. */
function fakeCanvas(
  opts: {
    noise?: (data: Uint8ClampedArray) => void;
    noContext?: boolean;
    readThrows?: boolean;
  } = {},
) {
  const seen = {
    sizes: [] as [number, number][],
    options: [] as unknown[],
    fillStyles: [] as string[],
    rects: 0,
  };
  class FakeOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      seen.sizes.push([width, height]);
    }
    getContext(kind: string, options?: unknown) {
      assert.equal(kind, "2d");
      seen.options.push(options);
      if (opts.noContext) return null;
      const px = new Uint8ClampedArray(this.width * this.height * 4);
      let style = "";
      return {
        set fillStyle(v: string) {
          style = v;
          seen.fillStyles.push(v);
        },
        fillRect: (x: number) => {
          seen.rects++;
          const [r, gr, b, a] = /rgba\((\d+),(\d+),(\d+), (\d+)\)/
            .exec(style)!
            .slice(1)
            .map(Number);
          px.set([r, gr, b, a], x * 4);
        },
        getImageData: () => {
          if (opts.readThrows) throw new Error("blocked");
          const data = new Uint8ClampedArray(px);
          opts.noise?.(data);
          return { data };
        },
      };
    }
  }
  const env = {
    OffscreenCanvas: FakeOffscreenCanvas,
    createImageBitmap: () => {},
  } as unknown as typeof globalThis;
  return { env, seen };
}

test("canvasReadsNoisy: Mapbox's read, against a fake OffscreenCanvas", async () => {
  const m = await load(false);
  const exact = fakeCanvas();
  assert.equal(m.canvasReadsNoisy(exact.env), false);
  assert.deepEqual(exact.seen.sizes, [
    [1, 1],
    [85, 1],
  ]);
  assert.deepEqual(exact.seen.options[1], { willReadFrequently: true });
  assert.equal(exact.seen.rects, 85);
  assert.equal(exact.seen.fillStyles[0], "rgba(0,1,2, 255)");
  assert.equal(exact.seen.fillStyles.at(-1), "rgba(252,253,254, 255)");
  // A red, green or blue byte one off, none at 0 or 255 (the array clamps).
  for (const at of [1, 2, 4, 41 * 4 + 1, 84 * 4 + 1]) {
    for (const d of [1, -1]) {
      const noisy = fakeCanvas({
        noise: (data) => {
          data[at] += d;
        },
      });
      assert.equal(m.canvasReadsNoisy(noisy.env), true, `byte ${at} ${d}`);
    }
  }
  const alphaOnly = fakeCanvas({
    noise: (data) => {
      data[3] -= 1;
    },
  });
  assert.equal(m.canvasReadsNoisy(alphaOnly.env), false);
  const { OffscreenCanvas } = exact.env;
  assert.equal(m.canvasReadsNoisy({} as typeof globalThis), false);
  assert.equal(m.canvasReadsNoisy({ OffscreenCanvas } as typeof globalThis), false);
  assert.equal(m.canvasReadsNoisy(fakeCanvas({ noContext: true }).env), false);
  assert.equal(m.canvasReadsNoisy(fakeCanvas({ readThrows: true }).env), false);
});

test("terrainAvailableFor: terrain only on auto with clean reads", async () => {
  const m = await load(false);
  assert.equal(m.terrainAvailableFor("auto", false), true);
  assert.equal(m.terrainAvailableFor("auto", true), false);
  assert.equal(m.terrainAvailableFor("off", false), false);
  assert.equal(m.terrainAvailableFor("off", true), false);
});

test("drift guard: Mapbox's fingerprint test is still the one canvasReadsNoisy runs", () => {
  const require = createRequire(import.meta.url);
  const dist = join(dirname(require.resolve("mapbox-gl/package.json")), "dist/mapbox-gl-dev.js");
  const src = readFileSync(dist, "utf8");
  for (const piece of [
    "new OffscreenCanvas(255 / 3, 1)",
    'getContext("2d", { willReadFrequently: true })',
    "`rgba(${inc++},${inc++},${inc++}, 255)`",
    "i % 4 !== 3 && inc++ !== readData.data[i]",
    "Terrain and hillshade are disabled because of Canvas2D limitations when fingerprinting protection is enabled",
  ]) {
    assert.ok(
      src.includes(piece),
      `Mapbox changed its fingerprint test: re-check terrainSwitch.ts (${piece})`,
    );
  }
});
