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
 * Geocoding QA for GDN events: runs each fullAddress through the BAN geocoder
 * (throttled ≤10 req/s, a few requests in flight), compares BAN coordinates
 * with the coordinates shipped in the dataset, derives geocode_precision from
 * the BAN result type, and flags rows where the two disagree by more than
 * 500 m (probable commune-centroid fallback in the source data).
 *
 * BAN responses are cached on disk (data/interim/gdn/geocode-cache.ndjson) so
 * re-runs are incremental and the pipeline can be replayed fully offline with
 * --offline once the cache is warm.
 *
 * Usage: npm run geocode [-- --limit N] [-- --rps N] [-- --offline]
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { readNdjson, createNdjsonWriter } from "./lib/ndjson.js";
import { geocodeBan, banTypeToPrecision, type BanHit } from "./lib/ban.js";
import { RateLimiter } from "./lib/http.js";
import { haversineMeters, toFiniteOrNull } from "./lib/geo.js";
import { INTERIM_DIR } from "./lib/paths.js";

const { values: flags } = parseArgs({
  options: {
    limit: { type: "string" },
    rps: { type: "string" },
    offline: { type: "boolean", default: false },
  },
});

const GDN_DIR = path.join(INTERIM_DIR, "gdn");
const IN_PATH = path.join(GDN_DIR, "events.scrubbed.ndjson");
const OUT_PATH = path.join(GDN_DIR, "events.geocoded.ndjson");
const CACHE_PATH = path.join(GDN_DIR, "geocode-cache.ndjson");
const REPORT_PATH = path.join(GDN_DIR, "geocode-qa-report.json");
const CENTROID_THRESHOLD_M = 500;
const CONCURRENCY = 5;

if (!fs.existsSync(IN_PATH)) {
  console.error(`missing ${IN_PATH} — run "npm run scrub" first`);
  process.exit(1);
}

const rps = Math.min(10, Number(flags.rps ?? 10) || 10); // spec: throttle ≤10 req/s
const limit = flags.limit ? Number(flags.limit) : Infinity;
const limiter = new RateLimiter(rps);

function normalizeQuery(address: string): string {
  return address.trim().replace(/\s+/g, " ");
}

// --- phase 1: warm cache from disk, collect unique addresses ----------------
type CacheEntry = { q: string; hit: BanHit | null };
const cache = new Map<string, BanHit | null>();
if (fs.existsSync(CACHE_PATH)) {
  for await (const entry of readNdjson<CacheEntry>(CACHE_PATH)) cache.set(entry.q, entry.hit);
  console.log(`geocode cache: ${cache.size} addresses`);
}

const uniqueAddresses = new Set<string>();
let eventCount = 0;
for await (const event of readNdjson<Record<string, unknown>>(IN_PATH)) {
  eventCount++;
  if (typeof event.fullAddress === "string" && event.fullAddress.trim()) {
    uniqueAddresses.add(normalizeQuery(event.fullAddress));
  }
}
const missing = [...uniqueAddresses].filter((q) => !cache.has(q)).slice(0, limit);
console.log(
  `${eventCount} events, ${uniqueAddresses.size} unique addresses, ${missing.length} to geocode`,
);

// --- phase 2: geocode missing addresses (worker pool, rate-limited) ---------
if (!flags.offline && missing.length > 0) {
  const cacheWriter = createNdjsonWriter(CACHE_PATH, { append: true });
  let next = 0;
  let done = 0;
  let failed = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= missing.length) return;
      const q = missing[index];
      let hit: BanHit | null = null;
      try {
        hit = await geocodeBan(q, limiter);
      } catch (err) {
        failed++;
        if (failed <= 5) console.warn(`  ! BAN error for "${q.slice(0, 60)}": ${String(err)}`);
        continue; // not cached — retried on next run
      }
      cache.set(q, hit);
      await cacheWriter.write({ q, hit } satisfies CacheEntry);
      done++;
      if (done % 500 === 0) console.log(`  … ${done}/${missing.length} geocoded`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await cacheWriter.close();
  console.log(`geocoded ${done} addresses (${failed} failures will retry next run)`);
} else if (flags.offline && missing.length > 0) {
  console.warn(`--offline: ${missing.length} addresses stay ungeocoded (precision "unknown")`);
}

// --- phase 3: annotate events from the cache --------------------------------
const report = {
  events: 0,
  with_address: 0,
  geocoded: 0,
  ban_miss: 0,
  not_queried: 0,
  centroid_suspect: 0,
  centroid_threshold_m: CENTROID_THRESHOLD_M,
  by_precision: { housenumber: 0, street: 0, venue: 0, municipality: 0, unknown: 0 } as Record<
    string,
    number
  >,
};

const writer = createNdjsonWriter(OUT_PATH);
for await (const event of readNdjson<Record<string, unknown>>(IN_PATH)) {
  report.events++;
  const address = typeof event.fullAddress === "string" ? normalizeQuery(event.fullAddress) : "";
  if (address) report.with_address++;
  const known = address !== "" && cache.has(address);
  const hit = known ? (cache.get(address) ?? null) : null;
  if (known && hit) report.geocoded++;
  else if (known) report.ban_miss++;
  else if (address) report.not_queried++;

  const srcLat = toFiniteOrNull(event.lat);
  const srcLng = toFiniteOrNull(event.lng);
  const distance =
    hit && srcLat != null && srcLng != null
      ? Math.round(haversineMeters(srcLat, srcLng, hit.lat, hit.lng))
      : null;
  const precision = hit ? banTypeToPrecision(hit.type) : "unknown";
  const flagged = distance != null && distance > CENTROID_THRESHOLD_M;
  report.by_precision[precision]++;
  if (flagged) report.centroid_suspect++;

  await writer.write({
    ...event,
    _geo: {
      precision,
      ban: hit && {
        lat: hit.lat,
        lng: hit.lng,
        type: hit.type,
        score: hit.score,
        label: hit.label,
        housenumber: hit.housenumber,
        street: hit.street,
        postcode: hit.postcode,
        city: hit.city,
      },
      distance_m: distance,
      // distance source↔BAN > 500 m: source coords are probably a commune
      // centroid fallback rather than the actual venue.
      centroid_suspect: flagged,
    },
  });
}
await writer.close();

fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`geocoded events → ${OUT_PATH}`);
console.log(`QA report → ${REPORT_PATH}`);
if (report.not_queried > 0) {
  console.warn(
    `${report.not_queried} events have an address not yet geocoded — re-run without --offline/--limit to complete the cache`,
  );
}
