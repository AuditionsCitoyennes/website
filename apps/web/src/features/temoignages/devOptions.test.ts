// The testing options as data (devOptions.ts) against the switch modules they
// stand for: every key a switch reads has its row (and a later key without
// one fails), the sentences are plain French with their no-break spaces, the
// reload mark follows the setter, the choices and the marked default are the
// module's. The modules without imports are loaded (a build without the
// testing tools: storage unread); analyses/devSwitch.ts, which imports
// "@/features/map/lib", and the defaults passed as arguments are read as
// text. Run with `node --import tsx --test` (root "test:scripts"). Pure: no
// Vue component, no DOM.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEV_DESCRIPTION, DEV_OPTIONS, DEV_SECTIONS, type DevKey } from "./devOptions";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const data = await import("./dataSource");
const lid = await import("../map/plateau/lidSwitch");
const mesh = await import("../map/plateau/meshSwitch");
const relief = await import("../map/relief/reliefSwitch");
const terrain = await import("../map/plateau/terrainSwitch");

const MODULES = {
  data: "./dataSource.ts",
  lid: "../map/plateau/lidSwitch.ts",
  mesh: "../map/plateau/meshSwitch.ts",
  relief: "../map/relief/reliefSwitch.ts",
  slabs: "../analyses/devSwitch.ts",
  terrain: "../map/plateau/terrainSwitch.ts",
} as const;
const source = (m: keyof typeof MODULES) =>
  readFileSync(new URL(MODULES[m], import.meta.url), "utf8");
/** The code alone, as corePurity.test.ts reads it. */
const code = (m: keyof typeof MODULES) =>
  source(m)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const KEYS: readonly DevKey[] = [
  "ac:data-source",
  "ac:analyses-pending",
  "ac:place-tree",
  "ac:lid",
  "ac:lid-check",
  "ac:mesh",
  "ac:relief-prefetch",
  "ac:slab-lid-verre",
  "ac:slab-text",
  "ac:slab-size",
  "ac:frame-fill",
  "ac:ring-band",
  "ac:terrain",
];
/** Measurement arms, kept in localStorage only: no row by design. */
const NO_ROW = [
  "ac:relief-budget",
  "ac:relief-budget-ground",
  "ac:relief-delay",
  "ac:relief-commit-hold",
];
const row = (key: DevKey) => DEV_OPTIONS.find((o) => o.key === key)!;

test("every switch key has exactly one row, in the three sections in order", () => {
  assert.equal(DEV_OPTIONS.length, 13);
  for (const key of KEYS) {
    assert.equal(DEV_OPTIONS.filter((o) => o.key === key).length, 1, key);
  }
  for (const o of DEV_OPTIONS) assert.ok(KEYS.includes(o.key), o.key);
  assert.deepEqual(
    DEV_SECTIONS.map((s) => s.title),
    ["Données", "Carte", "Analyses"],
  );
  const ids = DEV_SECTIONS.map((s) => s.id);
  const order = DEV_OPTIONS.map((o) => ids.indexOf(o.section));
  assert.ok(!order.includes(-1));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});

test("every ac:* key a switch module reads is a row or a measurement arm", () => {
  const seen = new Set<string>();
  for (const m of Object.keys(MODULES) as (keyof typeof MODULES)[]) {
    for (const k of code(m).matchAll(/["'](ac:[a-z0-9-]+)["']/g)) seen.add(k[1]);
  }
  for (const k of seen) {
    assert.ok(KEYS.includes(k as DevKey) || NO_ROW.includes(k), `${k}: no row`);
  }
  for (const k of KEYS) assert.ok(seen.has(k), `${k}: read by no module`);
});

const JARGON = /\b(dem|worker|float32array|lru|readback|hillshade|mesh)\b/i;
// An ordinary space after « or before » ; : ? % (a no-break space belongs there).
const LOOSE_SPACE = /« |[ ][»;:?%]/;

test("the sentences are plain French, long enough, with their no-break spaces", () => {
  const texts = [
    DEV_DESCRIPTION,
    ...DEV_SECTIONS.flatMap((s) => [s.title, s.intro]),
    ...DEV_OPTIONS.flatMap((o) => [o.label, o.explain]),
  ];
  for (const t of texts) {
    assert.ok(t.trim().length > 0);
    assert.doesNotMatch(t, JARGON);
    assert.doesNotMatch(t, LOOSE_SPACE, t);
  }
  for (const o of DEV_OPTIONS) {
    assert.ok(o.explain.length >= 60, o.key);
    const ids = o.choices.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, o.key);
    for (const c of o.choices) {
      assert.ok(c.label.trim().length > 0, o.key);
      assert.doesNotMatch(c.label, LOOSE_SPACE, c.label);
    }
  }
});

/** The setter of each key: its module and its name. */
const SETTERS: Record<DevKey, [keyof typeof MODULES, string]> = {
  "ac:data-source": ["data", "setDataSource"],
  "ac:place-tree": ["data", "setPlaceTreeMode"],
  "ac:lid": ["lid", "setLidMode"],
  "ac:lid-check": ["lid", "setLidCheck"],
  "ac:mesh": ["mesh", "setMeshMode"],
  "ac:relief-prefetch": ["relief", "setReliefPrefetch"],
  "ac:frame-fill": ["slabs", "setFrameFill"],
  "ac:analyses-pending": ["slabs", "setPendingAnalysesMode"],
  "ac:slab-lid-verre": ["slabs", "setSlabLidMode"],
  "ac:slab-text": ["slabs", "setSlabTextMode"],
  "ac:slab-size": ["slabs", "setSlabTextScale"],
  "ac:ring-band": ["slabs", "setRingBandMode"],
  "ac:terrain": ["terrain", "setTerrainMode"],
};

/** A function's body, from `export function <name>(` to its closing brace. */
function body(m: keyof typeof MODULES, name: string): string {
  const src = code(m);
  const at = src.indexOf(`export function ${name}(`);
  assert.ok(at >= 0, `${name} in ${MODULES[m]}`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name}: no closing brace`);
}

test("the reload mark is on exactly the rows whose setter reloads the page", () => {
  for (const o of DEV_OPTIONS) {
    const [m, name] = SETTERS[o.key];
    assert.equal(body(m, name).includes("location.reload("), o.reloads, o.key);
  }
  assert.deepEqual(
    DEV_OPTIONS.filter((o) => o.reloads).map((o) => o.label),
    ["Données", "Couvercle", "Contrôle", "Maillage", "Préchargement", "Relief"],
  );
});

/** The allowed list and the fallback of a `stored(<first>, [...], "<id>")` call. */
function storedCall(m: keyof typeof MODULES, first: string): { ids: string[]; fallback: string } {
  const at = code(m).indexOf(`stored(${first}, [`);
  assert.ok(at >= 0, `stored(${first}, …) in ${MODULES[m]}`);
  const call = /\[([^\]]*)\],\s*"([^"]+)"\)/.exec(code(m).slice(at))!;
  return { ids: [...call[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), fallback: call[2] };
}

const ids = (key: DevKey) => row(key).choices.map((c) => c.id);
const pct = (v: number) => String(Math.round(v * 100));
const constant = (name: string) => {
  const src = readFileSync(new URL("../map/lib/slabs/constants.ts", import.meta.url), "utf8");
  return Number(new RegExp(`export const ${name} = ([0-9.]+);`).exec(src)![1]);
};

test("the choices are the modules' own, in today's order", () => {
  assert.deepEqual(ids("ac:data-source"), [...data.DATA_SOURCES]);
  assert.deepEqual(ids("ac:place-tree"), storedCall("data", "TREE_KEY").ids);
  assert.deepEqual(ids("ac:lid"), [...lid.LID_MODES]);
  assert.deepEqual(ids("ac:lid-check"), [...lid.LID_CHECKS]);
  assert.deepEqual(ids("ac:mesh"), [...mesh.MESH_MODES]);
  assert.deepEqual(ids("ac:relief-prefetch"), [...relief.RELIEF_PREFETCHES]);
  assert.deepEqual(ids("ac:slab-lid-verre"), storedCall("slabs", "LID_KEY").ids);
  assert.deepEqual(ids("ac:slab-text"), storedCall("slabs", "TEXT_KEY").ids);
  assert.deepEqual(ids("ac:ring-band"), storedCall("slabs", "RING_KEY").ids);
  assert.deepEqual(ids("ac:terrain"), [...terrain.TERRAIN_MODES]);
  assert.deepEqual(ids("ac:analyses-pending"), storedCall("slabs", '"ac:analyses-pending"').ids);
  const shares = /export const SCALE_CHOICES = \[([^\]]*)\]/.exec(code("slabs"))![1];
  const scale = shares.split(",").map((v) => pct(Number(v)));
  assert.deepEqual(ids("ac:slab-size"), scale);
  assert.deepEqual(ids("ac:frame-fill"), scale);
  assert.deepEqual(row("ac:lid-check").inactiveWhen, { key: "ac:lid", id: "aucun" });
  assert.equal(DEV_OPTIONS.filter((o) => o.inactiveWhen).length, 1);
});

test("the default marked in each sentence is the module's", () => {
  const defaults: Record<DevKey, string> = {
    "ac:data-source": data.DEFAULT_SOURCE,
    "ac:place-tree": storedCall("data", "TREE_KEY").fallback,
    "ac:lid": lid.DEFAULT_LID_MODE,
    "ac:lid-check": lid.DEFAULT_LID_CHECK,
    "ac:mesh": mesh.DEFAULT_MESH_MODE,
    "ac:relief-prefetch": relief.DEFAULT_RELIEF_PREFETCH,
    "ac:frame-fill": pct(constant("FRAME_FILL")),
    "ac:analyses-pending": storedCall("slabs", '"ac:analyses-pending"').fallback,
    "ac:slab-lid-verre": storedCall("slabs", "LID_KEY").fallback,
    "ac:slab-text": storedCall("slabs", "TEXT_KEY").fallback,
    "ac:slab-size": pct(constant("TEXT_SCALE")),
    "ac:ring-band": storedCall("slabs", "RING_KEY").fallback,
    "ac:terrain": terrain.DEFAULT_TERRAIN_MODE,
  };
  assert.match(code("slabs"), /storedShare\(FILL_KEY, FRAME_FILL\)/);
  assert.match(code("slabs"), /storedShare\(SIZE_KEY, TEXT_SCALE\)/);
  for (const o of DEV_OPTIONS) {
    assert.equal(o.defaultId, defaults[o.key], o.key);
    const parts = o.explain.split("par défaut");
    assert.equal(parts.length, 2, `${o.key}: « par défaut » once`);
    const before = parts[0];
    const quoted = [...before.matchAll(/« ([^»]+) »/g)].at(-1)?.[1];
    const label = o.choices.find((c) => c.id === o.defaultId)!.label;
    if (o.key === "ac:mesh") {
      assert.ok(before.endsWith("Le dernier choix ("), o.key);
      assert.equal(o.defaultId, o.choices.at(-1)!.id);
    } else if (o.key === "ac:frame-fill" || o.key === "ac:slab-size") {
      assert.ok(before.endsWith(`${o.defaultId} % `), o.key);
    } else {
      assert.equal(quoted, label, o.key);
    }
  }
});

test("the Relief row closes the Carte section", () => {
  assert.equal(DEV_OPTIONS.filter((o) => o.section === "carte").at(-1)!.key, "ac:terrain");
});
