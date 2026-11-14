// Writes apps/web/src/shared/ui/francePoster.ts from the outline build the site
// reads (apps/web/outlines.lock.json): metropolitan France's régions, simplified
// to a few kilobytes of SVG path data (lib.ts). Run again when the lock moves
// to a build whose France changes:
//
//   npx tsx scripts/map-data/poster/build.ts [<outlines folder>]
//
// The folder holds the unpacked builds (<folder>/<build>/k/FR.json); the
// default is ~/.cache/ac-map-data/outlines, where build-outlines.sh puts them.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoster, posterModule, type PosterUnit } from "./lib";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const lock = JSON.parse(readFileSync(join(root, "apps/web/outlines.lock.json"), "utf8")) as {
  build: string;
};
const folder = process.argv[2] ?? join(homedir(), ".cache/ac-map-data/outlines");
const file = join(folder, lock.build, "k/FR.json");
const fr = JSON.parse(readFileSync(file, "utf8")) as { units: PosterUnit[] };
const poster = buildPoster(fr.units);
const out = join(root, "apps/web/src/shared/ui/francePoster.ts");
const text = posterModule(poster, lock.build);
writeFileSync(out, text);
console.log(`${out}: ${poster.regions.length} régions, ${text.length} bytes (${poster.viewBox})`);
