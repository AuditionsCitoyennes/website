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
 * RGPD scrubbing pass — MANDATORY before GDN content leaves data/raw/.
 * The Licence Ouverte permits reuse but does not waive data-protection
 * obligations, and free-text fields frequently contain organizer names,
 * emails and phone numbers.
 *
 * - emails and French phone numbers are removed from every free-text field;
 * - `authorId` is dropped. Set GDN_HMAC_SECRET to keep a keyed HMAC-SHA256
 *   pseudonym (`author_ref`) instead when per-author dedupe is needed;
 * - `authorZipCode` is kept (commune-level, already coarse).
 *
 * Reads  data/interim/gdn/{events,cr-ril}.ndjson
 * Writes data/interim/gdn/{events,cr-ril}.scrubbed.ndjson
 */
import fs from "node:fs";
import path from "node:path";
import { readNdjson, createNdjsonWriter } from "./lib/ndjson.js";
import { scrubGdnRecord, type ScrubStats } from "./lib/scrub.js";
import { INTERIM_DIR } from "./lib/paths.js";

const GDN_DIR = path.join(INTERIM_DIR, "gdn");
const hmacSecret = process.env.GDN_HMAC_SECRET || undefined;

if (hmacSecret) {
  console.log("GDN_HMAC_SECRET set — authorId replaced by keyed pseudonym author_ref");
} else {
  console.log("GDN_HMAC_SECRET not set — authorId dropped entirely");
}

async function scrubFile(name: string): Promise<void> {
  const inPath = path.join(GDN_DIR, `${name}.ndjson`);
  if (!fs.existsSync(inPath)) {
    console.warn(`missing ${inPath} — skipped`);
    return;
  }
  const outPath = path.join(GDN_DIR, `${name}.scrubbed.ndjson`);
  const stats: ScrubStats = { emails: 0, phones: 0 };
  const writer = createNdjsonWriter(outPath);
  let rows = 0;
  for await (const row of readNdjson<Record<string, unknown>>(inPath)) {
    rows++;
    await writer.write(scrubGdnRecord(row, { hmacSecret, stats }));
  }
  await writer.close();
  console.log(
    `${name}: ${rows} rows scrubbed (${stats.emails} emails, ${stats.phones} phone numbers removed) → ${outPath}`,
  );
}

await scrubFile("events");
await scrubFile("cr-ril");
