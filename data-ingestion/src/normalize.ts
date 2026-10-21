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
 * Normalizes every ingested source into the shared "audition-like" schema
 * (see lib/schema.ts), validates each row with zod, and writes:
 *
 * - data/processed/auditions.parquet + auditions.geojson
 *     merged exports — ONLY sources with publish: true and a permissive
 *     license (non_commercial: false);
 * - data/processed/by-source/<id>.geojson
 *     per-source files for every harvested source, including publish: false
 *     ones (display-only-with-link on the site, license pending);
 * - data/nc-sa/participedia/processed/participedia.parquet + .geojson
 *     CC BY-NC-SA content, segregated, never merged.
 *
 * Invalid rows are skipped and logged to data/interim/normalize-errors.log.
 */
import fs from "node:fs";
import path from "node:path";
import parquet from "@dsnp/parquetjs";
import { readNdjson } from "./lib/ndjson.js";
import { NormalizedEventSchema, toGeoJsonFeature, type NormalizedEvent } from "./lib/schema.js";
import { htmlToText } from "./lib/html.js";
import { parisLocalToIso, isoOrNull } from "./lib/time.js";
import { toFiniteOrNull } from "./lib/geo.js";
import { INTERIM_DIR, PROCESSED_DIR, NC_SA_DIR, ensureDir } from "./lib/paths.js";
import { loadRegistry, type Source } from "./lib/sources.js";
import { manifestEntry } from "./lib/manifest.js";

const registry = loadRegistry();
const errorLog: string[] = [];

function fillDate(attribution: string, retrievedAt: string): string {
  return attribution.replace("{date}", retrievedAt.slice(0, 10));
}

function validateRows(sourceId: string, rows: unknown[]): NormalizedEvent[] {
  const valid: NormalizedEvent[] = [];
  for (const row of rows) {
    const parsed = NormalizedEventSchema.safeParse(row);
    if (parsed.success) valid.push(parsed.data);
    else {
      errorLog.push(
        `${sourceId} ${(row as { source_id?: string }).source_id ?? "?"}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
  }
  if (valid.length < rows.length) {
    console.warn(`  ! ${sourceId}: ${rows.length - valid.length} invalid row(s) skipped`);
  }
  return valid;
}

// --- GDN --------------------------------------------------------------------
interface GdnGeo {
  precision: NormalizedEvent["geocode_precision"];
  ban: {
    lat: number | null;
    lng: number | null;
    housenumber: string | null;
    street: string | null;
    postcode: string | null;
    city: string | null;
  } | null;
}

// Tiers where BAN placed the address at a real point. Coarser tiers
// (municipality/unknown) get NULL coordinates — we never dress a commune-level
// (or ungeocodable) event as a precise point.
const PRECISE_TIERS = new Set<NormalizedEvent["geocode_precision"]>([
  "housenumber",
  "street",
  "venue",
]);

async function normalizeGdn(source: Source): Promise<NormalizedEvent[] | null> {
  const inPath = path.join(INTERIM_DIR, "gdn", "events.geocoded.ndjson");
  if (!fs.existsSync(inPath)) {
    console.warn(`  gdn: ${inPath} missing — run scrub + geocode first; skipped`);
    return null;
  }
  const retrievedAt = manifestEntry("gdn", "events")?.retrieved_at ?? new Date().toISOString();
  const rows: unknown[] = [];
  for await (const ev of readNdjson<Record<string, unknown> & { _geo?: GdnGeo }>(inPath)) {
    const geo = ev._geo;
    const ban = geo?.ban ?? null;
    const precision = geo?.precision ?? "unknown";
    const street = ban ? [ban.housenumber, ban.street].filter(Boolean).join(" ") || null : null;
    // Place at the BAN-geocoded point, NOT the platform's source lat/lng (the
    // latter is a commune centroid ~28% of the time). Coarse tiers → no point.
    const precise = PRECISE_TIERS.has(precision);
    rows.push({
      source: "gdn",
      source_id: String(ev.id ?? ""),
      title: typeof ev.title === "string" && ev.title.trim() ? ev.title.trim() : "Réunion locale",
      description_text: typeof ev.body === "string" ? htmlToText(ev.body) || null : null,
      start_at: parisLocalToIso(ev.startAt as string | undefined),
      end_at: parisLocalToIso(ev.endAt as string | undefined),
      address_raw: typeof ev.fullAddress === "string" ? ev.fullAddress : null,
      street,
      postcode: ban?.postcode ?? null,
      city: ban?.city ?? null,
      country_code: "FR",
      lat: precise ? toFiniteOrNull(ban?.lat) : null,
      lng: precise ? toFiniteOrNull(ban?.lng) : null,
      geocode_precision: precision,
      url: typeof ev.url === "string" && ev.url ? ev.url : null,
      license: source.license,
      attribution: fillDate(source.attribution, retrievedAt),
      retrieved_at: retrievedAt,
    });
  }
  return validateRows("gdn", rows);
}

// --- Decidim ----------------------------------------------------------------
async function normalizeDecidim(source: Source): Promise<NormalizedEvent[] | null> {
  const inPath = path.join(INTERIM_DIR, "decidim", `${source.id}.ndjson`);
  if (!fs.existsSync(inPath)) {
    console.warn(`  ${source.id}: ${inPath} missing — run harvest:decidim; skipped`);
    return null;
  }
  const rows: unknown[] = [];
  for await (const m of readNdjson<Record<string, unknown>>(inPath)) {
    if (!m.title) continue; // meetings without any usable translation
    rows.push({
      source: source.id,
      source_id: String(m.id ?? ""),
      title: m.title,
      description_text:
        typeof m.description === "string" ? htmlToText(m.description) || null : null,
      start_at: isoOrNull(m.start_time as string | undefined),
      end_at: isoOrNull(m.end_time as string | undefined),
      address_raw: (m.address as string | null) ?? null,
      street: null,
      postcode: null,
      city: null,
      country_code: source.decidim?.country_code ?? null,
      lat: toFiniteOrNull(m.latitude),
      lng: toFiniteOrNull(m.longitude),
      geocode_precision: toFiniteOrNull(m.latitude) != null ? "venue" : "unknown",
      url: (m.url as string | null) ?? null,
      license: source.license,
      attribution: fillDate(source.attribution, String(m.retrieved_at ?? "")),
      retrieved_at: m.retrieved_at,
    });
  }
  return validateRows(source.id, rows);
}

// --- Participedia (CC BY-NC-SA — segregated) ---------------------------------
async function normalizeParticipedia(source: Source): Promise<NormalizedEvent[] | null> {
  const inDir = path.join(NC_SA_DIR, "participedia", "interim");
  if (!fs.existsSync(inDir)) {
    console.warn(`  participedia: ${inDir} missing — run parse:participedia; skipped`);
    return null;
  }
  const rows: unknown[] = [];
  for (const file of fs.readdirSync(inDir).filter((f) => f.endsWith(".ndjson"))) {
    for await (const c of readNdjson<Record<string, unknown>>(path.join(inDir, file))) {
      if (!c.id || !c.title) continue;
      const lat = toFiniteOrNull(c.latitude);
      rows.push({
        source: "participedia",
        source_id: String(c.id),
        title: c.title,
        description_text: (c.description as string | null) ?? null,
        start_at: (c.start_date as string | null) ?? null,
        end_at: (c.end_date as string | null) ?? null,
        address_raw: (c.address_raw as string | null) ?? null,
        street: null,
        postcode: (c.postal_code as string | null) ?? null,
        city: (c.city as string | null) ?? null,
        country_code: null, // country is free text in the export; kept in address_raw context
        lat,
        lng: toFiniteOrNull(c.longitude),
        geocode_precision: lat != null ? "municipality" : "unknown",
        url: (c.url as string | null) ?? null,
        license: source.license,
        attribution: fillDate(source.attribution, String(c.retrieved_at ?? "")),
        retrieved_at: c.retrieved_at,
      });
    }
  }
  return validateRows("participedia", rows);
}

// --- writers ------------------------------------------------------------------
const PARQUET_SCHEMA = new parquet.ParquetSchema({
  source: { type: "UTF8" },
  source_id: { type: "UTF8" },
  title: { type: "UTF8" },
  description_text: { type: "UTF8", optional: true },
  start_at: { type: "UTF8", optional: true },
  end_at: { type: "UTF8", optional: true },
  address_raw: { type: "UTF8", optional: true },
  street: { type: "UTF8", optional: true },
  postcode: { type: "UTF8", optional: true },
  city: { type: "UTF8", optional: true },
  country_code: { type: "UTF8", optional: true },
  lat: { type: "DOUBLE", optional: true },
  lng: { type: "DOUBLE", optional: true },
  geocode_precision: { type: "UTF8" },
  url: { type: "UTF8", optional: true },
  license: { type: "UTF8" },
  attribution: { type: "UTF8" },
  retrieved_at: { type: "UTF8" },
});

async function writeParquet(filePath: string, events: NormalizedEvent[]): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const writer = await parquet.ParquetWriter.openFile(PARQUET_SCHEMA, filePath);
  for (const event of events) {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event)) row[k] = v ?? undefined;
    await writer.appendRow(row);
  }
  await writer.close();
}

function writeGeoJson(filePath: string, events: NormalizedEvent[]): number {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const features = events.map(toGeoJsonFeature).filter(Boolean);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ type: "FeatureCollection", features }, null, 0)}\n`,
  );
  return features.length;
}

// --- main ---------------------------------------------------------------------
const merged: NormalizedEvent[] = [];
const summary: string[] = [];

for (const source of registry.sources) {
  let events: NormalizedEvent[] | null = null;
  if (source.id === "gdn") events = await normalizeGdn(source);
  else if (source.kind === "decidim") events = await normalizeDecidim(source);
  else if (source.id === "participedia") events = await normalizeParticipedia(source);
  else continue; // cite-and-link sources have nothing to normalize
  if (!events || events.length === 0) continue;

  if (source.non_commercial) {
    // CC BY-NC-SA: segregated output, never merged with permissive data.
    const base = path.join(NC_SA_DIR, source.id, "processed", source.id);
    await writeParquet(`${base}.parquet`, events);
    const nFeatures = writeGeoJson(`${base}.geojson`, events);
    summary.push(
      `${source.id}: ${events.length} rows → ${base}.{parquet,geojson} [NC-SA, segregated]`,
    );
    void nFeatures;
    continue;
  }

  const bySource = path.join(PROCESSED_DIR, "by-source", `${source.id}.geojson`);
  writeGeoJson(bySource, events);

  if (source.publish) {
    merged.push(...events);
    summary.push(`${source.id}: ${events.length} rows → merged + ${bySource}`);
  } else {
    summary.push(
      `${source.id}: ${events.length} rows → ${bySource} only (publish: false — display-only-with-link)`,
    );
  }
}

if (merged.length > 0) {
  const parquetPath = path.join(ensureDir(PROCESSED_DIR), "auditions.parquet");
  const geojsonPath = path.join(PROCESSED_DIR, "auditions.geojson");
  await writeParquet(parquetPath, merged);
  const nFeatures = writeGeoJson(geojsonPath, merged);
  summary.push(
    `merged: ${merged.length} rows → auditions.parquet, ${nFeatures} with coordinates → auditions.geojson`,
  );
}

if (errorLog.length > 0) {
  const logPath = path.join(ensureDir(INTERIM_DIR), "normalize-errors.log");
  fs.writeFileSync(logPath, `${errorLog.join("\n")}\n`);
  console.warn(`${errorLog.length} invalid rows logged → ${logPath}`);
}
console.log(summary.map((l) => `  ${l}`).join("\n") || "  nothing to normalize yet");
