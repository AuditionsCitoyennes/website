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
 * Downloads the raw snapshots declared in data/sources.yml (currently the
 * Grand Débat National resources, enumerated live through the data.gouv.fr
 * dataset API with pinned static URLs as fallback).
 *
 * Idempotent: a resource already present with a recorded checksum is skipped.
 * Usage: npm run download [-- --force] [-- --all]  (--all includes the four
 * large thematic online-contribution files, zipcode granularity only).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fetchWithRetry, downloadToFile, sha256File } from "./lib/http.js";
import { RAW_DIR, ensureDir } from "./lib/paths.js";
import { loadRegistry, getSource } from "./lib/sources.js";
import { manifestEntry, saveManifestEntry, repoRelative } from "./lib/manifest.js";

const { values: flags } = parseArgs({
  options: {
    force: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
  },
});

interface DataGouvResource {
  id: string;
  title: string;
  url: string;
  format?: string;
  filesize?: number;
}

function normalize(s: string): string {
  // NFD + strip combining marks: accent-insensitive resource-title matching.
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

async function listDataGouvResources(datasetApi: string): Promise<DataGouvResource[]> {
  const res = await fetchWithRetry(datasetApi);
  if (!res.ok) throw new Error(`data.gouv.fr API returned HTTP ${res.status}`);
  const body = (await res.json()) as { resources?: DataGouvResource[] };
  return body.resources ?? [];
}

async function fetchResource(
  sourceId: string,
  resourceKey: string,
  url: string,
  destPath: string,
): Promise<void> {
  const existing = manifestEntry(sourceId, resourceKey);
  if (!flags.force && existing && fs.existsSync(destPath)) {
    if (sha256File(destPath) === existing.sha256) {
      console.log(
        `  ✓ ${resourceKey}: already downloaded (sha256 ${existing.sha256.slice(0, 12)}…)`,
      );
      return;
    }
    console.warn(`  ! ${resourceKey}: checksum mismatch with manifest, re-downloading`);
  }
  console.log(`  ↓ ${resourceKey}: ${url}`);
  const { sha256, bytes } = await downloadToFile(url, destPath);
  saveManifestEntry({
    source: sourceId,
    resource: resourceKey,
    url,
    path: repoRelative(destPath),
    sha256,
    bytes,
    retrieved_at: new Date().toISOString(),
  });
  console.log(`    ${(bytes / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…`);
}

async function downloadDataGouvSource(sourceId: string): Promise<void> {
  const registry = loadRegistry();
  const source = getSource(registry, sourceId);
  if (!source.datagouv) throw new Error(`source "${sourceId}" has no datagouv section`);
  console.log(`Source ${sourceId} — ${source.name}`);

  let apiResources: DataGouvResource[] = [];
  try {
    apiResources = await listDataGouvResources(source.datagouv.dataset_api);
    console.log(`  dataset API lists ${apiResources.length} resources`);
  } catch (err) {
    console.warn(`  dataset API unreachable (${String(err)}), falling back to pinned URLs`);
  }

  for (const [key, spec] of Object.entries(source.datagouv.resources)) {
    if (spec.optional && !flags.all) {
      console.log(`  – ${key}: optional, skipped (pass --all to include)`);
      continue;
    }
    const matcher = new RegExp(normalize(spec.title_match));
    let matched = apiResources.filter((r) => matcher.test(normalize(r.title)));
    if (spec.format) {
      matched = matched.filter((r) => (r.format ?? "").toLowerCase() === spec.format);
    }
    const url = matched[0]?.url ?? spec.fallback_url;
    if (matched.length > 1) {
      console.warn(`  ! ${key}: ${matched.length} resources match, using "${matched[0].title}"`);
    }
    if (!url) {
      console.error(`  ✗ ${key}: no API match and no fallback URL — skipped`);
      continue;
    }
    if (!matched[0] && spec.fallback_url) {
      console.warn(`  ! ${key}: no API match, using pinned fallback URL`);
    }
    const ext = path.extname(new URL(url).pathname) || ".json";
    const destPath = path.join(ensureDir(path.join(RAW_DIR, sourceId)), `${key}${ext}`);
    await fetchResource(sourceId, key, url, destPath);
  }
}

const registry = loadRegistry();
for (const source of registry.sources) {
  if (source.kind === "datagouv") {
    await downloadDataGouvSource(source.id);
  }
}
console.log("Done. Raw snapshots and checksums recorded in data/raw/manifest.json");
