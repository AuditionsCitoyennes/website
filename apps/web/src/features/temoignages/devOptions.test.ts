// The testing options as data (devOptions.ts) against the switch modules they
// stand for: every key a switch reads has its row (and a later key without
// one fails), the sentences are plain French with their no-break spaces, the
// reload mark follows the setter, the choices and the marked default are the
// module's, a row off its default is found and every row's key cleared. The
// modules without imports are loaded (a build without the
// testing tools: storage unread); analyses/devSwitch.ts, which imports
// "@/features/map/lib", and the defaults passed as arguments are read as
// text. Run with `node --import tsx --test` (root "test:scripts"). Pure: no
// Vue component, no DOM.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEV_CHANGED_MARK,
  DEV_DESCRIPTION,
  DEV_NONE_CHANGED,
  DEV_OPTIONS,
  DEV_RESET_LABEL,
  DEV_SECTIONS,
  changedCount,
  changedOptions,
  clearOptions,
  tierFacts,
  type DevKey,
} from "./devOptions";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const data = await import("./dataSource");
const lid = await import("../map/plateau/lidSwitch");
const mesh = await import("../map/plateau/meshSwitch");
const relief = await import("../map/relief/reliefSwitch");
const tier = await import("../../shared/device/deviceTier");
const bootListSwitch = await import("../geo-nav/bootListSwitch");
const bootWorkersSwitch = await import("../map/bootWorkersSwitch");
const outlinesDecorSwitch = await import("../geo-nav/data/outlinesDecorSwitch");
const glyphSwitch = await import("../map/glyphSwitch");
const mapPreloadPlan = await import("../../shared/boot/mapPreloadPlan");
const glassSwitch = await import("../../shared/device/glassSwitch");
const authClientSwitch = await import("../../shared/api/authClientSwitch");

const MODULES = {
  data: "./dataSource.ts",
  lid: "../map/plateau/lidSwitch.ts",
  mesh: "../map/plateau/meshSwitch.ts",
  relief: "../map/relief/reliefSwitch.ts",
  slabs: "../analyses/devSwitch.ts",
  tier: "../../shared/device/deviceTier.ts",
  bootList: "../geo-nav/bootListSwitch.ts",
  bootWorkers: "../map/bootWorkersSwitch.ts",
  outlinesDecor: "../geo-nav/data/outlinesDecorSwitch.ts",
  glyphs: "../map/glyphSwitch.ts",
  mapPreloadPlan: "../../shared/boot/mapPreloadPlan.ts",
  mapPreload: "../../shared/boot/mapPreload.ts",
  glass: "../../shared/device/glassSwitch.ts",
  authClient: "../../shared/api/authClientSwitch.ts",
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
  "ac:tier",
  "ac:boot-list",
  "ac:boot-workers",
  "ac:outlines-decor",
  "ac:glyphs",
  "ac:map-preload",
  "ac:glass",
  "ac:auth-client",
];
/** Measurement arms, kept in localStorage only, and the device tier's kept
 *  measure (not a choice: the dialog's reset forgets it apart): no row by design. */
const NO_ROW = [
  "ac:relief-budget",
  "ac:relief-budget-ground",
  "ac:relief-delay",
  "ac:relief-commit-hold",
  "ac:tier-measured",
];
const row = (key: DevKey) => DEV_OPTIONS.find((o) => o.key === key)!;

test("every switch key has exactly one row, in the four sections in order", () => {
  assert.equal(DEV_OPTIONS.length, 20);
  for (const key of KEYS) {
    assert.equal(DEV_OPTIONS.filter((o) => o.key === key).length, 1, key);
  }
  for (const o of DEV_OPTIONS) assert.ok(KEYS.includes(o.key), o.key);
  assert.deepEqual(
    DEV_SECTIONS.map((s) => s.title),
    ["Données", "Carte", "Analyses", "Appareil", "Site"],
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
    DEV_CHANGED_MARK,
    DEV_NONE_CHANGED,
    DEV_RESET_LABEL,
    changedCount(1),
    changedCount(3),
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
  "ac:tier": ["tier", "setTierChoice"],
  "ac:boot-list": ["bootList", "setBootList"],
  "ac:boot-workers": ["bootWorkers", "setBootWorkers"],
  "ac:outlines-decor": ["outlinesDecor", "setOutlinesDecor"],
  "ac:glyphs": ["glyphs", "setGlyphs"],
  "ac:map-preload": ["mapPreload", "setMapPreload"],
  "ac:glass": ["glass", "setGlass"],
  "ac:auth-client": ["authClient", "setAuthClient"],
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
    [
      "Données",
      "Couvercle",
      "Contrôle",
      "Maillage",
      "Préchargement",
      "Liste",
      "Assistants",
      "Contours voisins",
      "Police des noms",
      "Code de la carte",
      "Niveau",
      "Verre dépoli",
      "Connexion",
    ],
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
  assert.deepEqual(ids("ac:tier"), [...tier.TIER_CHOICES]);
  assert.deepEqual(ids("ac:boot-list"), [...bootListSwitch.BOOT_LISTS]);
  assert.deepEqual(ids("ac:boot-workers"), [...bootWorkersSwitch.BOOT_WORKERS]);
  assert.deepEqual(ids("ac:outlines-decor"), [...outlinesDecorSwitch.OUTLINES_DECORS]);
  assert.deepEqual(ids("ac:glyphs"), [...glyphSwitch.GLYPHS]);
  assert.deepEqual(ids("ac:map-preload"), [...mapPreloadPlan.MAP_PRELOADS]);
  assert.deepEqual(ids("ac:glass"), [...glassSwitch.GLASSES]);
  assert.deepEqual(ids("ac:auth-client"), [...authClientSwitch.AUTH_CLIENTS]);
  assert.deepEqual(ids("ac:slab-lid-verre"), storedCall("slabs", "LID_KEY").ids);
  assert.deepEqual(ids("ac:slab-text"), storedCall("slabs", "TEXT_KEY").ids);
  assert.deepEqual(ids("ac:ring-band"), storedCall("slabs", "RING_KEY").ids);
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
    "ac:tier": tier.DEFAULT_TIER_CHOICE,
    "ac:boot-list": bootListSwitch.DEFAULT_BOOT_LIST,
    "ac:boot-workers": bootWorkersSwitch.DEFAULT_BOOT_WORKERS,
    "ac:outlines-decor": outlinesDecorSwitch.DEFAULT_OUTLINES_DECOR,
    "ac:glyphs": glyphSwitch.DEFAULT_GLYPHS,
    "ac:map-preload": mapPreloadPlan.DEFAULT_MAP_PRELOAD,
    "ac:glass": glassSwitch.DEFAULT_GLASS,
    "ac:auth-client": authClientSwitch.DEFAULT_AUTH_CLIENT,
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

const defaults = Object.fromEntries(DEV_OPTIONS.map((o) => [o.key, o.defaultId]));
const changedWith = (now: Partial<Record<DevKey, string>>) =>
  changedOptions((key) => now[key] ?? defaults[key]).map((o) => o.key);

test("the rows off their default are found, in the menu's order", () => {
  assert.deepEqual(changedWith({}), []);
  assert.deepEqual(changedWith({ "ac:data-source": "corpus" }), ["ac:data-source"]);
  assert.deepEqual(changedWith({ "ac:data-source": "comparer" }), ["ac:data-source"]);
  // A share is read as the switch stores it, and a default kept on purpose is not a change.
  assert.deepEqual(
    changedWith({ "ac:ring-band": "fin", "ac:frame-fill": "100", "ac:lid": "ecran" }),
    ["ac:frame-fill", "ac:ring-band"],
  );
  // Every other choice of every row counts, alone.
  for (const o of DEV_OPTIONS) {
    for (const c of o.choices) {
      assert.deepEqual(changedWith({ [o.key]: c.id }), c.id === o.defaultId ? [] : [o.key]);
    }
  }
  assert.equal(changedCount(1), "1 choix modifié");
  assert.equal(changedCount(2), "2 choix modifiés");
});

test("the reset removes the key of every row, and no other", () => {
  const kept = new Map<string, string>([
    ...KEYS.map((k): [string, string] => [k, "x"]),
    ...NO_ROW.map((k): [string, string] => [k, "x"]),
    ["sb-auth-token", "x"],
  ]);
  clearOptions((key) => kept.delete(key));
  assert.deepEqual([...kept.keys()], [...NO_ROW, "sb-auth-token"]);
});

test("« Données » says what the map loses with the corpus and the comparer", () => {
  const { explain } = row("ac:data-source");
  const after = explain.split("par défaut")[1];
  assert.match(
    after,
    /Avec «\u00a0Corpus\u00a0» et «\u00a0Comparer\u00a0», la carte ne montre que les points des lieux/,
  );
  for (const lost of ["contour", "relief", "analyses"]) assert.ok(after.includes(lost), lost);
});

test("« Appareil » lists the tier detected, the two kinds of weak and every signal", () => {
  const strong = {
    deviceMemory: 8,
    hardwareConcurrency: 10,
    saveData: false,
    effectiveType: "4g",
    renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)",
    measured: null,
  };
  const auto = tier.decideTier(strong);
  assert.deepEqual(tierFacts(strong, auto, auto), [
    { label: "Niveau détecté", value: "Complet" },
    { label: "Processeur lent", value: "non" },
    { label: "Affichage lent", value: "non" },
    { label: "Mémoire", value: "8 Go" },
    { label: "Cœurs", value: "10" },
    { label: "Économie de données", value: "non" },
    { label: "Connexion", value: "4g" },
    { label: "Puce graphique", value: strong.renderer },
    { label: "Images mesurées", value: "aucune descente" },
  ]);
  // A phone that says nothing, a slow first flight kept, the switch forcing « Minimal ».
  const silent = {
    deviceMemory: null,
    hardwareConcurrency: null,
    saveData: true,
    effectiveType: null,
    renderer: null,
    measured: { tier: "light" as const, kind: "unknown" as const, at: Date.UTC(2026, 10, 13, 12) },
  };
  const facts = tierFacts(silent, tier.decideTier(silent), tier.decideTier(silent, "minimal"));
  const value = (label: string) => facts.find((f) => f.label === label)?.value;
  assert.equal(value("Niveau détecté"), "Léger (économie de données, images lentes mesurées)");
  assert.equal(value("Niveau imposé"), "Minimal");
  assert.equal(value("Processeur lent"), "oui");
  assert.equal(value("Affichage lent"), "oui");
  assert.equal(value("Mémoire"), "non indiquée");
  assert.equal(value("Cœurs"), "non indiqué");
  assert.equal(value("Économie de données"), "oui");
  assert.equal(value("Connexion"), "non indiquée");
  assert.equal(value("Puce graphique"), "non lue");
  assert.match(value("Images mesurées")!, /^Léger \(cause non mesurée\), le \d{2}\/11\/2026$/);
  // Every reason and every kind has its words, with no loose space.
  const every = tierFacts(
    { ...silent, measured: { ...silent.measured, kind: "gpu" } },
    {
      tier: "minimal",
      cpuWeak: true,
      gpuWeak: true,
      reasons: ["memory", "cores", "save-data", "link", "renderer", "frames"],
    },
    tier.decideTier(silent, "full"),
  );
  assert.equal(
    every[0].value,
    "Minimal (peu de mémoire, peu de cœurs, économie de données, connexion lente, affichage sans puce graphique, images lentes mesurées)",
  );
  assert.equal(every[1].value, "Complet");
  assert.match(every.at(-1)!.value, /^Léger \(affichage\)/);
  for (const f of [...facts, ...every]) {
    assert.doesNotMatch(f.label, LOOSE_SPACE);
    assert.doesNotMatch(f.value, LOOSE_SPACE);
  }
});
