// Step `prep` of build-outlines.sh: Etalab 50 m (régions, départements,
// communes with the 45 arrondissements) → <work>/prep/*.ndjson with the site's
// unit ids (fr:reg:84, fr:dep:69, fr:com:69123; an arrondissement's parent is
// its commune), every coordinate through clean5. Also writes the sha256 of
// each input and the French families too heavy for the 20,000-vertex self
// budget, with their inputs for one joint mapshaper run (gate 3).
//   npx tsx prep.ts <raw-dir> <work-dir>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_SELF_VERTICES, clean5, vertexCount, type Geometry, type Level } from "./lib";

export interface PrepFeature {
  type: "Feature";
  properties: { id: string; name: string; level: Level; parent: string; code: string };
  geometry: Geometry;
}
interface EtalabFeature {
  properties: Record<string, string | null>;
  geometry: Geometry;
}

export const INPUTS = ["regions", "departements", "communes"].map((l) => `etalab-${l}-50m.geojson`);
export const readNdjson = (file: string): PrepFeature[] =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
export const writeNdjson = (file: string, feats: PrepFeature[]): void =>
  fs.writeFileSync(file, feats.map((f) => JSON.stringify(f)).join("\n") + "\n");

function main(raw: string, work: string): void {
  const read = (f: string): EtalabFeature[] =>
    JSON.parse(fs.readFileSync(path.join(raw, f), "utf8")).features;
  const [regions, deps, communes] = INPUTS.map(read);
  const feat = (id: string, name: string, level: Level, parent: string, f: EtalabFeature) => {
    const geometry = clean5(f.geometry);
    if (!geometry) throw new Error(`${id} collapses at 5 decimals`);
    const code = String(f.properties.code);
    return { type: "Feature", properties: { id, name, level, parent, code }, geometry } as const;
  };
  const p = (f: EtalabFeature, k: string) => String(f.properties[k]);
  const out: Record<string, PrepFeature[]> = {
    regions: regions.map((f) => feat(`fr:reg:${p(f, "code")}`, p(f, "nom"), "region", "FR", f)),
    deps: deps.map((f) =>
      feat(`fr:dep:${p(f, "code")}`, p(f, "nom"), "dep", `fr:reg:${p(f, "region")}`, f),
    ),
    communes: communes
      .filter((f) => !f.properties.commune)
      .map((f) =>
        feat(`fr:com:${p(f, "code")}`, p(f, "nom"), "city", `fr:dep:${p(f, "departement")}`, f),
      ),
    arr: communes
      .filter((f) => f.properties.commune)
      .map((f) =>
        feat(`fr:com:${p(f, "code")}`, p(f, "nom"), "arr", `fr:com:${p(f, "commune")}`, f),
      ),
  };
  fs.mkdirSync(path.join(work, "prep"), { recursive: true });
  for (const [k, feats] of Object.entries(out))
    writeNdjson(path.join(work, "prep", `${k}.ndjson`), feats);

  // A région whose own outline or one of whose départements' is over the
  // self budget: the whole family (région + départements + communes) is cut
  // again by one joint run at the smallest tolerance that fits (simplify.sh).
  const families: string[] = [];
  for (const r of out.regions) {
    const kids = out.deps.filter((d) => d.properties.parent === r.properties.id);
    if (![r, ...kids].some((f) => vertexCount(f.geometry) > MAX_SELF_VERTICES)) continue;
    const dir = path.join(work, "fam", r.properties.code);
    fs.mkdirSync(dir, { recursive: true });
    const depIds = new Set(kids.map((d) => d.properties.id));
    const coms = out.communes.filter((c) => depIds.has(c.properties.parent));
    const comIds = new Set(coms.map((c) => c.properties.id));
    if (out.arr.some((a) => comIds.has(a.properties.parent)))
      throw new Error(`family ${r.properties.id} holds a city with arrondissements: not supported`);
    writeNdjson(path.join(dir, "regions.ndjson"), [r]);
    writeNdjson(path.join(dir, "deps.ndjson"), kids);
    writeNdjson(path.join(dir, "communes.ndjson"), coms);
    families.push(r.properties.code);
  }
  fs.writeFileSync(path.join(work, "prep", "families.txt"), families.join("\n") + "\n");
  const sha = (f: string) =>
    createHash("sha256")
      .update(fs.readFileSync(path.join(raw, f)))
      .digest("hex");
  fs.writeFileSync(
    path.join(work, "prep", "inputs.json"),
    JSON.stringify(Object.fromEntries(INPUTS.map((f) => [f, sha(f)]))),
  );
  const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
  console.log(
    `prep: ${JSON.stringify(counts)}, families to rebuild: ${families.join(" ") || "none"}`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main(process.argv[2], process.argv[3]);
}
