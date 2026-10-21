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
 * Parses the raw GDN exports (data/raw/gdn/) into NDJSON under
 * data/interim/gdn/. The source files are JSON arrays laid out one object per
 * line with known malformed lines, hence the tolerant streaming parser.
 *
 * - events.json → events.ndjson (deduplicated by id, later file wins)
 * - cr-ril.json → cr-ril.ndjson, kept as a linked table; the schema of its
 *   first rows is inspected and reported, and if a plausible join key to
 *   events (event id / URL) is present its coverage is measured.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseJsonObjectStream, type ParseFailure } from "./lib/gdnParser.js";
import { createNdjsonWriter } from "./lib/ndjson.js";
import { RAW_DIR, INTERIM_DIR, ensureDir } from "./lib/paths.js";

const RAW_GDN = path.join(RAW_DIR, "gdn");
const OUT_DIR = ensureDir(path.join(INTERIM_DIR, "gdn"));

function lineStream(filePath: string): readline.Interface {
  return readline.createInterface({
    input: fs.createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
}

async function parseFile(
  name: string,
  inPath: string,
  outPath: string,
  dedupeKey?: string,
): Promise<{ objects: Record<string, unknown>[]; failures: ParseFailure[] }> {
  const failures: ParseFailure[] = [];
  const seen = new Map<string, Record<string, unknown>>();
  const anonymous: Record<string, unknown>[] = [];
  let parsedCount = 0;

  for await (const parsed of parseJsonObjectStream<Record<string, unknown>>(
    lineStream(inPath),
    (f) => failures.push(f),
  )) {
    parsedCount++;
    const key = dedupeKey ? parsed.value[dedupeKey] : undefined;
    if (typeof key === "string" && key) seen.set(key, parsed.value);
    else anonymous.push(parsed.value);
  }

  const objects = [...seen.values(), ...anonymous];
  if (dedupeKey && objects.length < parsedCount) {
    console.log(
      `  ${name}: ${parsedCount} objects parsed, ${parsedCount - objects.length} duplicate ${dedupeKey}(s) removed`,
    );
  }
  const writer = createNdjsonWriter(outPath);
  for (const obj of objects) await writer.write(obj);
  await writer.close();

  if (failures.length > 0) {
    const logPath = path.join(OUT_DIR, `${name}.parse-errors.log`);
    fs.writeFileSync(
      logPath,
      failures
        .map((f) => `lines ${f.startLine}-${f.endLine}: ${f.error}\n  ${f.snippet}`)
        .join("\n") + "\n",
    );
    console.warn(`  ! ${failures.length} unparseable chunk(s) skipped — see ${logPath}`);
  }
  console.log(`  ${name}: ${objects.length} objects → ${outPath}`);
  return { objects, failures };
}

// --- events ---------------------------------------------------------------
const eventsRaw = path.join(RAW_GDN, "events.json");
if (!fs.existsSync(eventsRaw)) {
  console.error(`missing ${eventsRaw} — run "npm run download" first`);
  process.exit(1);
}
console.log("Parsing GDN events…");
const { objects: events } = await parseFile(
  "events",
  eventsRaw,
  path.join(OUT_DIR, "events.ndjson"),
  "id",
);

// --- comptes-rendus (cr-ril) ----------------------------------------------
const crRaw = path.join(RAW_GDN, "cr_ril.json");
if (!fs.existsSync(crRaw)) {
  console.warn(`missing ${crRaw} — comptes-rendus step skipped`);
} else {
  console.log("Parsing GDN comptes-rendus (cr-ril)…");
  const { objects: crRows } = await parseFile("cr-ril", crRaw, path.join(OUT_DIR, "cr-ril.ndjson"));

  // Schema inspection: report the fields present and look for a join key.
  const fieldCounts = new Map<string, number>();
  for (const row of crRows) {
    for (const key of Object.keys(row)) fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
  }
  const eventIds = new Set(events.map((e) => String(e.id)));
  const eventUrls = new Set(
    events.map((e) => (typeof e.url === "string" ? e.url : "")).filter(Boolean),
  );
  const candidateKeys = [...fieldCounts.keys()].filter((k) => /event|meeting|reunion/i.test(k));
  const joinStats: Record<string, number> = {};
  for (const key of candidateKeys) {
    joinStats[key] = crRows.filter((r) => {
      const v = r[key];
      return typeof v === "string" && (eventIds.has(v) || eventUrls.has(v));
    }).length;
  }
  const report = {
    rows: crRows.length,
    fields: Object.fromEntries([...fieldCounts.entries()].sort((a, b) => b[1] - a[1])),
    join_candidates: joinStats,
    note: Object.values(joinStats).some((n) => n > 0)
      ? "join key found — see join_candidates coverage"
      : "no field joins onto events (id/url); cr-ril is kept as a linked table only",
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "cr-ril.schema-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `  cr-ril schema report → ${path.join(OUT_DIR, "cr-ril.schema-report.json")} (${report.note})`,
  );
}
