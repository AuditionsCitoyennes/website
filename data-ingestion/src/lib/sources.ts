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
import { parse } from "yaml";
import { z } from "zod";
import { SOURCES_YML } from "./paths.js";

const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["datagouv", "decidim", "csv-manual", "cite-and-link"]),
  urls: z.record(z.string(), z.string()).default({}),
  license: z.string(),
  license_url: z.string().nullable().default(null),
  attribution: z.string(),
  pii_policy: z.string(),
  // Nothing from a source with publish:false may enter the merged exports.
  publish: z.boolean(),
  // CC BY-NC-SA content: normalized under data/nc-sa/, never merged.
  non_commercial: z.boolean().default(false),
  notes: z.string().optional(),
  datagouv: z
    .object({
      dataset_api: z.string(),
      resources: z.record(
        z.string(),
        z.object({
          title_match: z.string(),
          fallback_url: z.string().nullable().default(null),
          optional: z.boolean().default(false),
          // When several resources share a title (same file in json/csv/zip),
          // restrict the API match to this data.gouv format (e.g. "csv").
          format: z.string().nullable().default(null),
        }),
      ),
    })
    .optional(),
  decidim: z
    .object({
      host: z.string(),
      locales: z.array(z.string()).default(["fr", "en", "es", "ca"]),
      country_code: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .nullable()
        .default(null),
    })
    .optional(),
});

export type Source = z.infer<typeof SourceSchema>;

const RegistrySchema = z.object({
  version: z.number(),
  sources: z.array(SourceSchema),
  excluded: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })),
});

export type Registry = z.infer<typeof RegistrySchema>;

export function loadRegistry(): Registry {
  const raw = parse(fs.readFileSync(SOURCES_YML, "utf8"));
  return RegistrySchema.parse(raw);
}

export function getSource(registry: Registry, id: string): Source {
  const source = registry.sources.find((s) => s.id === id);
  if (!source) throw new Error(`source "${id}" not found in data/sources.yml`);
  return source;
}
