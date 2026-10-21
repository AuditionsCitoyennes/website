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
import fs from "node:fs";
import path from "node:path";
import { MANIFEST_PATH, REPO_ROOT } from "./paths.js";

/** One entry per downloaded/harvested raw artifact, keyed by source:resource. */
export interface ManifestEntry {
  source: string;
  resource: string;
  url: string;
  path: string; // repo-relative
  sha256: string;
  bytes: number;
  retrieved_at: string; // ISO 8601
}

type Manifest = Record<string, ManifestEntry>;

export function loadManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

export function saveManifestEntry(entry: ManifestEntry): void {
  const manifest = loadManifest();
  manifest[`${entry.source}:${entry.resource}`] = entry;
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function manifestEntry(source: string, resource: string): ManifestEntry | undefined {
  return loadManifest()[`${source}:${resource}`];
}

export function repoRelative(absPath: string): string {
  return path.relative(REPO_ROOT, absPath);
}
