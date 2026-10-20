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
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = path.resolve(here, "..", "..");
export const REPO_ROOT = path.resolve(PKG_ROOT, "..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const RAW_DIR = path.join(DATA_DIR, "raw");
export const INTERIM_DIR = path.join(DATA_DIR, "interim");
export const PROCESSED_DIR = path.join(DATA_DIR, "processed");
// CC BY-NC-SA content is quarantined here and must never be merged into the
// permissive exports under data/processed/.
export const NC_SA_DIR = path.join(DATA_DIR, "nc-sa");
export const SOURCES_YML = path.join(DATA_DIR, "sources.yml");
export const LICENSES_MD = path.join(DATA_DIR, "DATA_LICENSES.md");
export const MANIFEST_PATH = path.join(RAW_DIR, "manifest.json");

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
