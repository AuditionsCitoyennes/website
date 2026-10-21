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
 * GDN curation, stage 4b: attach the INSEE commune code (`citycode`).
 *
 * The map fetches commune boundary geometry BY INSEE CODE
 * (GeoNav → /api/boundaries/commune/{insee}); a unit with no citycode simply
 * gets no outline. The ingestion geocoder captured city + postcode but not the
 * INSEE code, so this step reverse-geocodes each row's (already trusted) BAN
 * coordinates through the BAN /reverse endpoint to recover it.
 *
 * Results are cached on disk, so a re-run is free and works offline.
 *
 * Usage: npm run enrich:citycode
 */
import fs from "node:fs";
import path from "node:path";
import { readNdjson, createNdjsonWriter } from "./lib/ndjson.js";
import { fetchWithRetry, RateLimiter } from "./lib/http.js";
import { INTERIM_DIR } from "./lib/paths.js";

const DIR = path.join(INTERIM_DIR, "gdn", "curation");
const IN = path.join(DIR, "curated-anonymised.ndjson");
const CACHE = path.join(DIR, "citycode-cache.json");

if (!fs.existsSync(IN)) {
  console.error(`missing ${IN} — run "npm run curate:gdn:redact:apply" first`);
  process.exit(1);
}

const limiter = new RateLimiter(10); // BAN: stay at/below 10 req/s
const cache: Record<string, { citycode: string | null; city: string | null }> = fs.existsSync(CACHE)
  ? JSON.parse(fs.readFileSync(CACHE, "utf8"))
  : {};

/** BAN reverse-geocode → INSEE citycode (+ commune name) for a coordinate. */
async function reverse(lat: number, lng: number) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (key in cache) return cache[key];
  await limiter.take();
  let out: { citycode: string | null; city: string | null } = { citycode: null, city: null };
  try {
    const res = await fetchWithRetry(
      `https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lng}`,
      {},
      { retries: 2 },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        features?: { properties?: { citycode?: string; city?: string } }[];
      };
      const p = body.features?.[0]?.properties;
      if (p) out = { citycode: p.citycode ?? null, city: p.city ?? null };
    }
  } catch (err) {
    console.warn(`  ! reverse failed for ${key}: ${String(err)}`);
    return out; // not cached — retried on the next run
  }
  cache[key] = out;
  return out;
}

interface Row {
  id: string;
  location?: {
    lat?: number | null;
    lng?: number | null;
    citycode?: string | null;
    city?: string | null;
  };
}

const rows: Row[] = [];
for await (const r of readNdjson<Row>(IN)) rows.push(r);

let resolved = 0;
let missing = 0;
let done = 0;
for (const r of rows) {
  const lat = r.location?.lat;
  const lng = r.location?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") {
    missing++;
    continue;
  }
  const hit = await reverse(lat, lng);
  if (hit.citycode) {
    r.location!.citycode = hit.citycode;
    // BAN reverse names the commune authoritatively — prefer it for the label so
    // places group under the same ville node the INSEE code belongs to.
    if (hit.city) r.location!.city = hit.city;
    resolved++;
  } else {
    missing++;
  }
  if (++done % 200 === 0) {
    console.log(`  … ${done}/${rows.length}`);
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  }
}
fs.writeFileSync(CACHE, JSON.stringify(cache));

const writer = createNdjsonWriter(IN);
for (const r of rows) await writer.write(r);
await writer.close();

const distinct = new Set(rows.map((r) => r.location?.citycode).filter(Boolean)).size;
console.log(
  `citycode resolved: ${resolved}/${rows.length} (${missing} without) — ${distinct} distinct communes`,
);
console.log(`updated ${IN}`);
console.log("Next: npm run load:gdn -- --execute --status published");
