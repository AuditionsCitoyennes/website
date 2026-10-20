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
import { z } from "zod";

export const GEOCODE_PRECISIONS = [
  "housenumber",
  "street",
  "venue",
  "municipality",
  "unknown",
] as const;

// ISO 8601 with offset ("2019-01-15T18:30:00+01:00"), or a reduced-precision
// date ("2019", "2019-01", "2019-01-15") for sources that only publish those.
const isoDateTime = z
  .string()
  .regex(
    /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/,
    "expected ISO 8601 datetime with offset, or a reduced-precision date",
  );

export const NormalizedEventSchema = z.object({
  source: z.string().min(1),
  source_id: z.string().min(1),
  title: z.string().min(1),
  description_text: z.string().nullable(),
  start_at: isoDateTime.nullable(),
  end_at: isoDateTime.nullable(),
  address_raw: z.string().nullable(),
  street: z.string().nullable(),
  postcode: z.string().nullable(),
  city: z.string().nullable(),
  country_code: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  lat: z.number().gte(-90).lte(90).nullable(),
  lng: z.number().gte(-180).lte(180).nullable(),
  geocode_precision: z.enum(GEOCODE_PRECISIONS),
  url: z.string().url().nullable(),
  license: z.string().min(1),
  attribution: z.string().min(1),
  retrieved_at: z.string().datetime({ offset: true }),
});

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

export function toGeoJsonFeature(event: NormalizedEvent): object | null {
  if (event.lat == null || event.lng == null) return null;
  const { lat, lng, ...properties } = event;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties,
  };
}
