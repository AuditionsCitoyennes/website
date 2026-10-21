/*
 * Auditions Citoyennes — data ingestion pipeline
 * Copyright (C) 2026 Auditions Citoyennes
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed WITHOUT ANY WARRANTY;
 * see the GNU Affero General Public License for more details:
 * <https://www.gnu.org/licenses/>.
 */

/**
 * Parses Participedia CSV exports dropped MANUALLY into data/raw/participedia/
 * (the bulk export sits behind an Auth0 login — do not automate it; log in,
 * download the cases CSV from participedia.net/search?selectedCategory=case&returns=csv
 * and save it in that directory).
 *
 * LICENSE (strict): CC BY-NC-SA 3.0 — everything derived from these files is
 * written under data/nc-sa/participedia/ and must NEVER be merged into the
 * permissive exports (data/processed/) or into our own dataset. Site sections
 * displaying it must stay non-monetized.
 *
 * Column names come from the public codebook
 * (participedia.net/docs/Participedia_Codebook_-_Case.pdf); the parser maps
 * aliases defensively and reports unmapped headers instead of guessing.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { createNdjsonWriter } from "./lib/ndjson.js";
import { RAW_DIR, NC_SA_DIR, ensureDir } from "./lib/paths.js";
import { toFiniteOrNull } from "./lib/geo.js";
import { looseDateOrNull } from "./lib/time.js";

const IN_DIR = path.join(RAW_DIR, "participedia");
const OUT_DIR = ensureDir(path.join(NC_SA_DIR, "participedia", "interim"));

if (
  !fs.existsSync(IN_DIR) ||
  fs.readdirSync(IN_DIR).filter((f) => f.endsWith(".csv")).length === 0
) {
  console.error(
    [
      `No CSV found in ${IN_DIR}.`,
      "The Participedia bulk export requires a free account (Auth0) — download it manually:",
      "  1. log in on https://participedia.net",
      "  2. download https://participedia.net/search?selectedCategory=case&returns=csv",
      `  3. save the file under ${IN_DIR}/ (e.g. cases.csv) and re-run this script`,
    ].join("\n"),
  );
  process.exit(1);
}

/** normalized header → canonical field. First alias found wins. */
const FIELD_ALIASES: Record<string, string[]> = {
  id: ["id", "case_id", "post_id"],
  title: ["title", "name"],
  description: ["description", "brief_description", "body", "summary"],
  url: ["url", "permalink", "link"],
  city: ["city"],
  province: ["province", "state", "region"],
  postal_code: ["postal_code", "postal", "zip"],
  country: ["country"],
  latitude: ["latitude", "lat"],
  longitude: ["longitude", "lng", "lon"],
  start_date: ["start_date", "start"],
  end_date: ["end_date", "end"],
  address1: ["address1", "address"],
  address2: ["address2"],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

function buildColumnMap(headers: string[]): { map: Map<string, string>; unmapped: string[] } {
  const normalized = headers.map(normalizeHeader);
  const map = new Map<string, string>(); // canonical → actual header
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) {
        map.set(canonical, headers[idx]);
        break;
      }
    }
  }
  const mappedActuals = new Set(map.values());
  return { map, unmapped: headers.filter((h) => !mappedActuals.has(h)) };
}

for (const file of fs.readdirSync(IN_DIR).filter((f) => f.endsWith(".csv"))) {
  const inPath = path.join(IN_DIR, file);
  const outPath = path.join(OUT_DIR, `${path.basename(file, ".csv")}.ndjson`);
  console.log(`Parsing ${inPath}…`);

  const parser = fs
    .createReadStream(inPath)
    .pipe(parse({ columns: true, bom: true, relax_quotes: true, skip_empty_lines: true }));

  const writer = createNdjsonWriter(outPath);
  let columnMap: Map<string, string> | null = null;
  let rows = 0;
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    if (!columnMap) {
      const { map, unmapped } = buildColumnMap(Object.keys(record));
      columnMap = map;
      console.log(`  mapped columns: ${[...map.keys()].join(", ")}`);
      if (unmapped.length > 0) {
        console.log(
          `  unmapped columns kept in "extra": ${unmapped.slice(0, 15).join(", ")}${unmapped.length > 15 ? "…" : ""}`,
        );
      }
      const required = ["id", "title"];
      const missing = required.filter((f) => !map.has(f));
      if (missing.length > 0) {
        throw new Error(
          `cannot map required column(s) ${missing.join(", ")} in ${file} — check the codebook`,
        );
      }
    }
    const get = (canonical: string): string | null => {
      const actual = columnMap!.get(canonical);
      const v = actual ? record[actual]?.trim() : "";
      return v ? v : null;
    };
    rows++;
    await writer.write({
      id: get("id"),
      title: get("title"),
      description: get("description"),
      url: get("url") ?? (get("id") ? `https://participedia.net/case/${get("id")}` : null),
      city: get("city"),
      province: get("province"),
      postal_code: get("postal_code"),
      country: get("country"),
      latitude: toFiniteOrNull(get("latitude")),
      longitude: toFiniteOrNull(get("longitude")),
      start_date: looseDateOrNull(get("start_date")),
      end_date: looseDateOrNull(get("end_date")),
      address_raw: [get("address1"), get("address2")].filter(Boolean).join(", ") || null,
      retrieved_at: fs.statSync(inPath).mtime.toISOString(), // manual download date
    });
  }
  await writer.close();
  console.log(`  ${rows} rows → ${outPath}`);
}
console.log("Reminder: CC BY-NC-SA 3.0 — this data stays under data/nc-sa/, never merged.");
