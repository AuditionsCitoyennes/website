// Step `pack` of build-outlines.sh: the prepared and simplified layers →
// the files of format v1 (docs/map-outlines.md). `pack()` is pure (the
// fixture test runs it); the CLI reads <work>, writes <out>/<build>/ and the
// references check.ts compares the régions with.
//   npx tsx pack.ts <work-dir> <out-dir> <build> <fr-tier-metres> <etalab-year> <mapshaper-version>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  MAX_SELF_VERTICES,
  clean5,
  enrich,
  keyOf,
  rewind,
  vertexCount,
  type Geometry,
  type Level,
  type OutlineEntry,
  type OutlineFileV1,
  type OutlineSelf,
  type RootRow,
  type RootV1,
} from "./lib";
import { readNdjson, type PrepFeature } from "./prep";

export interface PackUnit {
  id: string;
  name: string;
  level: Level;
  parent: string;
  g: Geometry;
}
/** One family's joint run at one tolerance (prep.ts, simplify.sh). */
export interface FamilyRun {
  tolM: number;
  region: PackUnit;
  regionSelf: Geometry;
  deps: PackUnit[];
  communes: PackUnit[];
}
export interface PackInput {
  build: string;
  /** k/FR: the 26 régions of one run at `tolM`, France's outline dissolved from it. */
  fr: { tolM: number; self: Geometry; regions: PackUnit[] };
  /** As delivered (e50). */
  regions: PackUnit[];
  regionSelves: Map<string, Geometry>;
  deps: PackUnit[];
  communes: PackUnit[];
  arrondissements: PackUnit[];
  /** Per family région id, its runs by ascending tolerance. */
  families: Map<string, FamilyRun[]>;
}
export interface PackOutput {
  files: Map<string, OutlineFileV1 | RootV1>;
  /** The région outline each région's self must equal (gate 1), at its tier. */
  regionRefs: Map<string, Geometry>;
  escalations: string[];
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Etalab draws exteriors clockwise, mapshaper's dissolve counter-clockwise:
// every geometry leaves in RFC 7946 order, so a file never mixes the two.
const selfOf = (id: string, geom: Geometry): OutlineSelf => {
  const g = rewind(geom);
  return { id, ...enrich(g), n: vertexCount(g), g };
};

export function pack(input: PackInput): PackOutput {
  const { build } = input;
  const files = new Map<string, OutlineFileV1 | RootV1>();
  const rows: RootRow[] = [];
  const regionRefs = new Map<string, Geometry>();
  const escalations: string[] = [];
  const frTier = `fr${input.fr.tolM}`;
  const tiers: RootV1["tiers"] = {
    e50: { tolM: 0, source: "etalab-50m" },
    [frTier]: { tolM: input.fr.tolM, source: "etalab-50m" },
  };
  const cities = new Map<string, PackUnit[]>();
  for (const a of input.arrondissements) cities.set(a.parent, [...(cities.get(a.parent) ?? []), a]);

  const entry = (u: PackUnit, k: 0 | 1, uu: 0 | 1): OutlineEntry => {
    const { bbox, center, n, g } = selfOf(u.id, u.g);
    return { id: u.id, name: u.name, level: u.level, k, u: uu, bbox, center, n, g };
  };
  const put = (kind: "k" | "u", self: OutlineSelf, tier: string, units?: OutlineEntry[]) => {
    const head = { v: 1 as const, build, kind, id: self.id, tier, tolM: tiers[tier].tolM, self };
    files.set(
      `${kind}/${keyOf(self.id)}.json`,
      kind === "k" ? { ...head, kind, units: units ?? [] } : { ...head, kind },
    );
  };
  const row = (
    u: { id: string; name: string; level: Level; parent: string | null },
    s: OutlineSelf,
    st: string,
    uu: 0 | 1,
  ) =>
    rows.push({
      id: u.id,
      parent: u.parent,
      level: u.level,
      name: u.name,
      bbox: s.bbox,
      center: s.center,
      st,
      k: 1,
      u: uu,
      g: 0,
    });

  // France: its own outline and the 26 régions of the same run.
  const fr = selfOf("FR", input.fr.self);
  put(
    "k",
    fr,
    frTier,
    [...input.fr.regions].sort(byId).map((r) => entry(r, 1, 1)),
  );
  row({ id: "FR", name: "France", level: "country", parent: null }, fr, frTier, 0);

  for (const region of [...input.regions].sort(byId)) {
    const runs = input.families.get(region.id);
    let tier = "e50";
    let regionSelf = input.regionSelves.get(region.id);
    let ref = region.g;
    let deps = input.deps.filter((d) => d.parent === region.id);
    let communes = input.communes;
    if (runs) {
      const fit = runs.find((r) =>
        [r.regionSelf, ...r.deps.map((d) => d.g)].every((g) => vertexCount(g) <= MAX_SELF_VERTICES),
      );
      if (!fit)
        throw new Error(`family ${region.id}: no tolerance of ${runs.map((r) => r.tolM)} fits`);
      tier = `fam${fit.tolM}`;
      tiers[tier] = { tolM: fit.tolM, source: "etalab-50m" };
      [regionSelf, ref, deps, communes] = [fit.regionSelf, fit.region.g, fit.deps, fit.communes];
      escalations.push(
        `${region.id} and its départements → ${tier} (${vertexCount(fit.regionSelf)} vertices)`,
      );
    }
    if (!regionSelf) throw new Error(`${region.id}: no dissolved self`);
    regionRefs.set(region.id, ref);
    deps = [...deps].sort(byId);
    const rs = selfOf(region.id, regionSelf);
    put(
      "k",
      rs,
      tier,
      deps.map((d) => entry(d, 1, 1)),
    );
    put("u", rs, tier);
    row(region, rs, tier, 1);
    for (const dep of deps) {
      const ds = selfOf(dep.id, dep.g);
      const kids = communes.filter((c) => c.parent === dep.id).sort(byId);
      put(
        "k",
        ds,
        tier,
        kids.map((c) => entry(c, cities.has(c.id) ? 1 : 0, 0)),
      );
      put("u", ds, tier);
      row(dep, ds, tier, 1);
      for (const city of kids.filter((c) => cities.has(c.id))) {
        if (tier !== "e50") throw new Error(`${city.id}: arrondissements inside a family`);
        put(
          "k",
          selfOf(city.id, city.g),
          tier,
          cities
            .get(city.id)!
            .sort(byId)
            .map((a) => entry(a, 0, 0)),
        );
      }
    }
  }
  files.set("root.json", { v: 1, build, tiers, units: rows });
  return { files, regionRefs, escalations };
}

// ---- CLI ------------------------------------------------------------------------

const unitOf = (f: PrepFeature): PackUnit => {
  const p = f.properties;
  const g = clean5(f.geometry);
  if (!g) throw new Error(`${p.id} collapses at 5 decimals`);
  return { id: p.id, name: p.name, level: p.level, parent: p.parent, g };
};
/** A mapshaper output line: a Feature, or a bare geometry when it has no properties. */
const geometries = (file: string): { props: Record<string, string>; g: Geometry }[] =>
  readNdjson(file).map((f) => {
    const o = f as unknown as { properties?: Record<string, string>; geometry?: Geometry };
    const g = clean5(o.geometry ?? (o as unknown as Geometry));
    if (!g) throw new Error(`${file}: a geometry collapses at 5 decimals`);
    return { props: o.properties ?? {}, g };
  });

function main(
  work: string,
  out: string,
  build: string,
  frTolM: number,
  etalabYear: string,
  mapshaper: string,
) {
  const P = (f: string) => path.join(work, "prep", f);
  const S = (f: string) => path.join(work, "simp", f);
  const units = (file: string) => readNdjson(file).map(unitOf);
  const famCodes = fs.readFileSync(P("families.txt"), "utf8").split("\n").filter(Boolean);
  const families = new Map<string, FamilyRun[]>();
  for (const code of famCodes) {
    const runs = [30, 50, 100, 300].map((tolM) => {
      const d = S(`fam${tolM}-${code}`);
      return {
        tolM,
        region: units(path.join(d, "regions.ndjson"))[0],
        regionSelf: geometries(path.join(d, "region-selves.ndjson"))[0].g,
        deps: units(path.join(d, "deps.ndjson")),
        communes: units(path.join(d, "communes.ndjson")),
      };
    });
    families.set(`fr:reg:${code}`, runs);
  }
  const { files, regionRefs, escalations } = pack({
    build,
    fr: {
      tolM: frTolM,
      self: geometries(S(`fr${frTolM}-self.ndjson`))[0].g,
      regions: units(S(`fr${frTolM}-regions.ndjson`)),
    },
    regions: units(P("regions.ndjson")),
    regionSelves: new Map(
      geometries(S("e50-region-selves.ndjson")).map((x) => [x.props.parent, x.g]),
    ),
    deps: units(P("deps.ndjson")),
    communes: units(P("communes.ndjson")),
    arrondissements: units(P("arr.ndjson")),
    families,
  });

  const dir = path.join(out, build);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const sub of ["k", "u"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const bytes: Record<string, { files: number; raw: number; gz: number }> = {};
  for (const [name, body] of files) {
    const buf = Buffer.from(JSON.stringify(body));
    fs.writeFileSync(path.join(dir, name), buf);
    const kind = name.includes("/") ? name.split("/")[0] : "root";
    const b = (bytes[kind] ??= { files: 0, raw: 0, gz: 0 });
    b.files++;
    b.raw += buf.length;
    b.gz += zlib.gzipSync(buf, { level: 9 }).length;
  }
  fs.writeFileSync(
    path.join(dir, "NOTICE.txt"),
    [
      `Auditions Citoyennes — administrative outlines, build ${build}`,
      "",
      "France (régions, départements, communes, arrondissements municipaux):",
      `Etalab / IGN contours-administratifs ${etalabYear}, 50 m generalisation`,
      "(https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/),",
      "under the Licence Ouverte / Open Licence 2.0 (https://www.etalab.gouv.fr/licence-ouverte-open-licence/).",
      "Derived work: coordinates rounded to 5 decimals; France's outline, the",
      "régions' outlines and the coarser tiers simplified and dissolved with mapshaper.",
      "",
    ].join("\n"),
  );
  const root = files.get("root.json") as RootV1;
  const level = (l: Level) => root.units.filter((r) => r.level === l).length;
  const k = [...files.values()].filter(
    (f): f is OutlineFileV1 & { kind: "k" } => "kind" in f && f.kind === "k",
  );
  const manifest = {
    v: 1,
    build,
    created: new Date().toISOString(),
    sources: { etalab: `${etalabYear}/50m` },
    inputs: JSON.parse(fs.readFileSync(P("inputs.json"), "utf8")),
    mapshaper,
    counts: {
      rows: { country: level("country"), region: level("region"), dep: level("dep") },
      entries: k.reduce((n, f) => n + f.units.length, 0),
      tiers: Object.keys(root.tiers),
      escalations,
    },
    bytes,
    files: files.size + 2, // + NOTICE.txt and manifest.json
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  fs.writeFileSync(
    path.join(work, "region-refs.ndjson"),
    [...regionRefs].map(([id, g]) => JSON.stringify({ id, g })).join("\n") + "\n",
  );
  console.log(
    `pack: ${manifest.files} files in ${dir}; ${escalations.join("; ") || "no escalation"}`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [work, out, build, frTolM, etalabYear, mapshaper] = process.argv.slice(2);
  main(work, out, build, Number(frTolM), etalabYear, mapshaper);
}
