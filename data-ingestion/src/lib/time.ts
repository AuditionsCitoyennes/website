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
import { DateTime } from "luxon";

/**
 * GDN datetimes are "YYYY-MM-DD HH:MM:SS" in local French time with no zone
 * marker. Interpret them as Europe/Paris and return ISO 8601 with offset
 * (DST-aware), or null when the input is absent or unparseable.
 */
export function parisLocalToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const dt = DateTime.fromFormat(value.trim(), "yyyy-MM-dd HH:mm:ss", { zone: "Europe/Paris" });
  return dt.isValid ? dt.toISO() : null;
}

/** Passes through an already-ISO timestamp, normalized, or null. */
export function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value.trim(), { setZone: true });
  return dt.isValid ? dt.toISO() : null;
}

/**
 * Participedia dates can be full dates, year-month or year-only. Keep the
 * declared precision rather than inventing a fake midnight: returns
 * "YYYY", "YYYY-MM" or "YYYY-MM-DD" as found, else null.
 */
export function looseDateOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return null;
  return [m[1], m[2], m[3]].filter(Boolean).join("-");
}
