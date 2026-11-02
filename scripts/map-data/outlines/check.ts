// Step `check` of build-outlines.sh: the gates of docs/map-outlines.md over a
// built set. `check()` is pure (the fixture test runs it); the CLI loads
// <out>/<build>/, adds DuckDB's ST_IsValid to gate 6 and the site's own ids to
// gate 4, prints the offenders and exits 1 when a gate fails.
//   npx tsx check.ts <work-dir> <out-dir> <build>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_VERTICES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_SELF_VERTICES,
  coincidence,
  isSubset,
  keyOf,
  polygonsOf,
  ringProblems,
  segmentKeys,
  setDiff,
  unionBoundary,
  validateFileV1,
  vertexCount,
  windings,
  type Coincidence,
  type Geometry,
  type OutlineFileV1,
  type RootV1,
} from "./lib";

export interface CheckOptions {
  /** Each région's reference outline at its tier (Etalab's, or its family run's). */
  regionRefs: Map<string, Geometry>;
  /** The site's ids (gate 4): FR_REGIONS names, FR_DEPARTMENTS codes, seed fixture commune ids. */
  expected?: { regionNames: string[]; depCodes: string[]; fixtureIds: string[] };
  /** Files in the build, NOTICE and manifest included (default: the outline files). */
  fileCount?: number;
}
export interface Gate {
  name: string;
  ok: boolean;
  offenders: string[];
}
export interface ParentRow extends Coincidence {
  id: string;
  tier: string;
  children: number;
  segmentsEqual: boolean;
}
export interface CheckResult {
  gates: Gate[];
  warnings: string[];
  parents: ParentRow[];
  /** The heaviest selves and bundles, for the margins the doc reports. */
  heaviest: { self: string[]; bundle: string[] };
}

const ZERO_M = 0.001;
const ringCounts = (g: Geometry) => {
  const polys = polygonsOf(g);
  return `${polys.length} polygons, ${polys.reduce((n, p) => n + p.length - 1, 0)} holes`;
};

export function check(files: Map<string, unknown>, opts: CheckOptions): CheckResult {
  const gates: Gate[] = [];
  const warnings: string[] = [];
  const gate = (name: string, offenders: string[]) =>
    gates.push({ name, ok: offenders.length === 0, offenders });
  const root = files.get("root.json") as RootV1;
  const outlines = new Map<string, OutlineFileV1>();
  const shape: string[] = [];
  for (const [p, body] of files) {
    if (p === "root.json") continue;
    const v = validateFileV1(body);
    if (!v.ok) shape.push(`${p}: ${v.reason}`);
    else if (v.file.build !== root.build) shape.push(`${p}: build ${v.file.build}`);
    else outlines.set(p, v.file);
  }
  const bundles = [...outlines].filter(([p]) => p.startsWith("k/")) as [
    string,
    OutlineFileV1 & { kind: "k" },
  ][];
  const rowOf = new Map(root.units.map((r) => [r.id, r]));

  // 1. Coincidence: a parent's edge is its children's outer lines.
  const g1: string[] = [];
  const parents: ParentRow[] = [];
  for (const [p, f] of bundles) {
    const self = f.self.g;
    const kids = f.units.map((u) => u.g);
    const segs = segmentKeys(self);
    let equal: boolean;
    let metricKids = kids;
    if (f.id === "FR") {
      const all = new Set(kids.flatMap((g) => [...segmentKeys(g)]));
      const union = unionBoundary(kids);
      const holes = polygonsOf(self).flatMap((poly) => poly.slice(1));
      equal = isSubset(segs, all);
      if (!equal) g1.push(`${p}: ${setDiff(segs, all).onlyA} self segments in no région`);
      for (const h of holes)
        if (!isSubset(segmentKeys({ type: "Polygon", coordinates: [h] }), union))
          g1.push(`${p}: a hole at ${h[0]} is no hole of the régions' union`);
      // The régions on France's own ground (the overseas ones lie elsewhere).
      const [w, s, e, n] = f.self.bbox;
      metricKids = f.units
        .filter((u) => u.bbox[0] <= e && u.bbox[2] >= w && u.bbox[1] <= n && u.bbox[3] >= s)
        .map((u) => u.g);
    } else {
      const d = setDiff(segs, unionBoundary(kids));
      equal = !d.onlyA && !d.onlyB;
      if (!equal)
        g1.push(
          `${p}: ${d.onlyA} segments only in the self, ${d.onlyB} only in the children's union`,
        );
      if (f.id.startsWith("fr:reg:")) {
        const ref = opts.regionRefs.get(f.id);
        const r = ref ? setDiff(segs, segmentKeys(ref)) : null;
        if (!ref || !r || r.onlyA || r.onlyB)
          g1.push(
            `${p}: self differs from the région (${r ? `${r.onlyA}/${r.onlyB} one-sided segments` : "no reference"})`,
          );
        if (ref && ringCounts(ref) !== ringCounts(self))
          g1.push(`${p}: ${ringCounts(self)} against the région's ${ringCounts(ref)}`);
        equal &&= !!r && !r.onlyA && !r.onlyB;
      }
    }
    const c = coincidence(self, metricKids);
    if (c.childToSelfM > ZERO_M || c.selfToChildM > ZERO_M || c.sharedPct < 100)
      g1.push(
        `${p}: children → self ${c.childToSelfM.toFixed(2)} m, self → children ${c.selfToChildM.toFixed(2)} m, shared ${c.sharedPct.toFixed(2)} %`,
      );
    parents.push({ id: f.id, tier: f.tier, children: f.units.length, segmentsEqual: equal, ...c });
  }
  gate("1 coincidence", g1);

  // 2. Same id@tier ⇒ byte-identical geometry, in every file.
  const g2: string[] = [];
  const seen = new Map<string, { json: string; at: string }>();
  const same = (id: string, tier: string, g: Geometry, at: string) => {
    const json = JSON.stringify(g);
    const prev = seen.get(`${id}@${tier}`);
    if (!prev) seen.set(`${id}@${tier}`, { json, at });
    else if (prev.json !== json) g2.push(`${id}@${tier}: ${prev.at} and ${at} differ`);
  };
  for (const [p, f] of outlines) {
    same(f.id, f.tier, f.self.g, `${p} self`);
    if (f.kind === "k") for (const u of f.units) same(u.id, f.tier, u.g, `${p} entry`);
  }
  gate("2 identity", g2);

  // 3. Budgets.
  const g3: string[] = [];
  const selfN: [number, string][] = [];
  const bundleN: [number, string][] = [];
  for (const [p, f] of outlines) {
    const raw = Buffer.byteLength(JSON.stringify(f));
    const n = vertexCount(f.self.g);
    selfN.push([n, `${p} ${n}`]);
    if (n > MAX_SELF_VERTICES) g3.push(`${p}: self of ${n} vertices > ${MAX_SELF_VERTICES}`);
    if (raw > MAX_FILE_BYTES) g3.push(`${p}: ${raw} B > ${MAX_FILE_BYTES}`);
    if (f.kind !== "k") continue;
    const total = n + f.units.reduce((s, u) => s + vertexCount(u.g), 0);
    bundleN.push([total, `${p} ${total} vertices ${raw} B`]);
    if (total > MAX_BUNDLE_VERTICES)
      g3.push(`${p}: bundle of ${total} vertices > ${MAX_BUNDLE_VERTICES}`);
    if (raw > MAX_BUNDLE_BYTES) g3.push(`${p}: bundle of ${raw} B > ${MAX_BUNDLE_BYTES}`);
  }
  const count = opts.fileCount ?? files.size;
  if (count > MAX_FILES) g3.push(`${count} files > ${MAX_FILES}`);
  gate("3 budgets", g3);
  const top = (a: [number, string][]) =>
    a
      .sort((x, y) => y[0] - x[0])
      .slice(0, 5)
      .map((x) => x[1]);

  // 4. Ids.
  const g4: string[] = [];
  const ids = new Set<string>();
  for (const r of root.units) {
    if (ids.has(r.id)) g4.push(`row ${r.id} twice`);
    ids.add(r.id);
  }
  const entryIn = new Map<string, string>();
  for (const [p, f] of bundles)
    for (const u of f.units) {
      if (entryIn.has(u.id)) g4.push(`${u.id} is an entry of ${entryIn.get(u.id)} and ${p}`);
      entryIn.set(u.id, p);
    }
  for (const r of root.units)
    if (r.parent !== null && !rowOf.has(r.parent))
      g4.push(`row ${r.id}: parent ${r.parent} has no row`);
  for (const [p, f] of bundles)
    if (!rowOf.has(f.id) && !entryIn.has(f.id))
      g4.push(`${p}: ${f.id} is neither a row nor an entry`);
  if (opts.expected) {
    const regionNames = new Set(root.units.filter((r) => r.level === "region").map((r) => r.name));
    for (const n of opts.expected.regionNames)
      if (!regionNames.has(n)) g4.push(`région ${n} absent`);
    const deps = new Set(opts.expected.depCodes.map((c) => `fr:dep:${c}`));
    for (const id of deps) if (!rowOf.has(id)) g4.push(`${id} absent`);
    const names = new Set(opts.expected.regionNames);
    for (const r of root.units)
      if ((r.level === "region" && !names.has(r.name)) || (r.level === "dep" && !deps.has(r.id)))
        warnings.push(`${r.id} ${r.name}: not in apps/api frDepartments.ts`);
    const fine = (p: string) => p.startsWith("k/fr_dep_") || p.startsWith("k/fr_com_");
    for (const id of opts.expected.fixtureIds)
      if (!fine(entryIn.get(id) ?? "")) g4.push(`fixture unit ${id} absent`);
  }
  gate("4 ids", g4);

  // 5. Closure: every flag has its file, every file a flag; rows match their self files.
  const g5: string[] = [...shape];
  const declared = new Set<string>();
  const flag = (what: string, id: string, kind: "k" | "u" | "g", on: 0 | 1 | undefined) => {
    const p = `${kind}/${keyOf(id)}.json`;
    if (on) declared.add(p);
    if (!!on !== outlines.has(p))
      g5.push(
        `${what} ${id}: ${kind}=${on ?? 0} but ${p} ${outlines.has(p) ? "exists" : "is missing"}`,
      );
  };
  for (const r of root.units) {
    (["k", "u", "g"] as const).forEach((kind) => flag("row", r.id, kind, r[kind]));
    const s = outlines.get(`u/${keyOf(r.id)}.json`) ?? outlines.get(`k/${keyOf(r.id)}.json`);
    if (s && (s.tier !== r.st || JSON.stringify(s.self.bbox) !== JSON.stringify(r.bbox)))
      g5.push(`row ${r.id}: st ${r.st} / bbox against ${s.tier} / ${JSON.stringify(s.self.bbox)}`);
  }
  for (const [p, f] of outlines) {
    if (f.self.n !== vertexCount(f.self.g)) g5.push(`${p}: self.n ${f.self.n}`);
    if (f.kind !== "k") continue;
    for (const u of f.units) {
      flag(`entry of ${p}`, u.id, "k", u.k);
      flag(`entry of ${p}`, u.id, "u", u.u);
      if (u.n !== vertexCount(u.g)) g5.push(`${p}: ${u.id}.n ${u.n} against ${vertexCount(u.g)}`);
    }
  }
  for (const p of outlines.keys())
    if (!declared.has(p)) g5.push(`${p}: declared by no row or entry`);
  gate("5 closure", g5);

  // 6. Validity (the GEOS part is the CLI's).
  const g6: string[] = [];
  for (const [p, f] of outlines) {
    const wrap = f.wrap === 1;
    const geoms = [f.self, ...(f.kind === "k" ? f.units : [])];
    const ext = new Set<number>();
    const hole = new Set<number>();
    for (const u of geoms) {
      for (const m of ringProblems(u.g, wrap)) g6.push(`${p} ${u.id}: ${m}`);
      const w = windings(u.g);
      w.ext.forEach((s) => ext.add(s));
      w.hole.forEach((s) => hole.add(s));
    }
    if (ext.size > 1 || hole.size > 1 || (ext.size && [...hole].some((s) => ext.has(s))))
      g6.push(`${p}: exteriors ${[...ext]} / holes ${[...hole]}: windings mixed`);
  }
  gate("6 validity", g6);
  return { gates, warnings, parents, heaviest: { self: top(selfN), bundle: top(bundleN) } };
}

// ---- CLI ------------------------------------------------------------------------

function duckdbInvalid(work: string, outlines: Map<string, unknown>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [p, body] of outlines) {
    const f = body as OutlineFileV1;
    if (!f.self) continue;
    for (const u of [f.self, ...(f.kind === "k" ? f.units : [])]) {
      const key = `${u.id}@${f.tier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(JSON.stringify({ key: `${p} ${key}`, g: JSON.stringify(u.g) }));
    }
  }
  const file = path.join(work, "validity.ndjson");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  // This DuckDB spatial has no ST_IsValidReason: the reason is told apart
  // from the boundary's simplicity.
  const reason = `CASE WHEN ST_IsSimple(ST_Boundary(geom)) THEN 'rings touch, cross or nest wrongly' ELSE 'a ring intersects itself' END`;
  const sql = `LOAD spatial; SELECT key, ${reason} AS reason FROM (SELECT key, ST_GeomFromGeoJSON(g) AS geom FROM read_json('${file}', format = 'newline_delimited', columns = {key: 'VARCHAR', g: 'VARCHAR'})) WHERE NOT ST_IsValid(geom);`;
  const out = execFileSync("duckdb", ["-no-agent", "-json", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }).trim();
  const rows: { key: string; reason: string }[] = out ? JSON.parse(out) : [];
  console.log(`check: ST_IsValid over ${lines.length} distinct geometries, ${rows.length} invalid`);
  return rows.map((r) => `${r.key}: ${r.reason}`);
}

async function main(work: string, out: string, build: string) {
  const dir = path.join(out, build);
  const files = new Map<string, unknown>();
  const all = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile());
  for (const d of all) {
    const p = path.relative(dir, path.join(d.parentPath, d.name));
    if (p === "root.json" || /^[kug]\//.test(p))
      files.set(p, JSON.parse(fs.readFileSync(path.join(dir, p), "utf8")));
  }
  const refs = fs
    .readFileSync(path.join(work, "region-refs.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean);
  const { FR_DEPARTMENTS, FR_REGIONS } =
    await import("../../../apps/api/src/modules/geo/frDepartments");
  const fixture: { id: string }[] = JSON.parse(
    fs.readFileSync(new URL("../../seed/fixtures/fr-units.json", import.meta.url), "utf8"),
  );
  const t = Date.now();
  const res = check(files, {
    regionRefs: new Map(refs.map((l) => JSON.parse(l)).map((r) => [r.id, r.g])),
    expected: {
      regionNames: Object.keys(FR_REGIONS),
      depCodes: Object.keys(FR_DEPARTMENTS),
      fixtureIds: fixture.map((u) => u.id).filter((id) => id.startsWith("fr:com:")),
    },
    fileCount: all.length,
  });
  const invalid = duckdbInvalid(work, files);
  const g6 = res.gates.find((g) => g.name === "6 validity")!;
  g6.offenders.push(...invalid);
  g6.ok = g6.offenders.length === 0;
  fs.writeFileSync(path.join(work, "check.json"), JSON.stringify(res, null, 1));
  for (const g of res.gates) {
    console.log(`check: gate ${g.name}: ${g.ok ? "pass" : `FAIL (${g.offenders.length})`}`);
    for (const o of g.offenders.slice(0, 25)) console.log(`    ${o}`);
  }
  for (const w of res.warnings) console.log(`check: warning: ${w}`);
  const exact = res.parents.filter((r) => r.segmentsEqual && r.sharedPct === 100).length;
  console.log(
    `check: ${res.parents.length} parents, ${exact} exact; heaviest selves: ${res.heaviest.self.join(", ")}`,
  );
  console.log(
    `check: ${((Date.now() - t) / 1000).toFixed(1)} s, details in ${path.join(work, "check.json")}`,
  );
  if (res.gates.some((g) => !g.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [work, out, build] = process.argv.slice(2);
  await main(work, out, build);
}
