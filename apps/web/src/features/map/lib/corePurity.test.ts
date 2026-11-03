// The plateau mesh's pure core loads where neither mapbox-gl nor the page is
// (a worker): from each file listed, every RELATIVE runtime import is followed
// transitively, and none may import mapbox-gl, vue or an `@/` module at run
// time (the app's modules may touch `window` at import: shared/perf/perf.ts
// installs itself). `import type` / `export type` are erased, so they are
// allowed. Static: the files are read, not run. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The core's entry files, relative to features/map. */
const CORE = [
  "lib/mercator.ts",
  "lib/projection.ts",
  "lib/polygon.ts",
  "gl/mesh.ts",
  "gl/meshBuild.ts",
  "gl/meshConcat.ts",
  // The mesh worker's entry (ac:mesh=worker) and what it loads.
  "gl/meshWorker.ts",
  "gl/meshCore.ts",
  "gl/meshFlat.ts",
];

const FORBIDDEN = (spec: string) =>
  spec === "mapbox-gl" || spec.startsWith("mapbox-gl/") || spec === "vue" || spec.startsWith("@/");

/** A file's runtime import specifiers: `import … from`, `export … from`,
 *  `import "…"` and `import("…")`, the type-only forms left out. */
function runtimeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  const fromRe = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const m of code.matchAll(fromRe)) if (!m[2]) out.push(m[4]);
  for (const m of code.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

function resolveRelative(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const file of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(file) && file.endsWith(".ts")) return file;
  }
  throw new Error(`${relative(MAP, from)}: cannot resolve ${spec}`);
}

/** Every file the entries reach by relative runtime imports, and the
 *  forbidden specifiers found on the way (file → specifier). */
function closure(entries: string[]) {
  const seen = new Set<string>();
  const bad: string[] = [];
  const stack = entries.map((e) => join(MAP, e));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) stack.push(resolveRelative(file, spec));
      else if (FORBIDDEN(spec)) bad.push(`${relative(MAP, file)} → ${spec}`);
    }
  }
  return { files: [...seen].map((f) => relative(MAP, f)).sort(), bad };
}

test("the import scan sees runtime imports and skips type-only ones", () => {
  const src = [
    'import mapboxgl from "mapbox-gl";',
    'import type { A } from "@/x";',
    'import earcut, { flatten } from "earcut";',
    'export { baseOf, type PBase } from "./mercator";',
    'export type { B } from "@/y";',
    'import "./side";',
    "// import nope from 'vue';",
    'const late = import("./late");',
  ].join("\n");
  assert.deepEqual(runtimeImports(src).sort(), [
    "./late",
    "./mercator",
    "./side",
    "earcut",
    "mapbox-gl",
  ]);
});

test("the mesh core imports no mapbox-gl, vue or @/ module at run time", () => {
  const { files, bad } = closure(CORE);
  assert.deepEqual(bad, []);
  // The scan did follow the imports (mesh.ts → lib/mercator.ts, …).
  for (const f of CORE) assert.ok(files.includes(f), `${f} scanned`);
});
