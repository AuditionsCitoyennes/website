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
import crypto from "node:crypto";

export const EMAIL_PLACEHOLDER = "[courriel supprimé]";
export const PHONE_PLACEHOLDER = "[téléphone supprimé]";

const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
// French phone numbers: +33 or 0, then 9 digits with optional space/dot/dash
// separators. Digit look-arounds keep longer digit runs (SIRET, ids…) intact.
const FR_PHONE_RE = /(?<!\d)(?:\+33|0)\s?[1-9](?:[\s.\-]?\d{2}){4}(?!\d)/g;

export interface ScrubStats {
  emails: number;
  phones: number;
}

export function scrubText(text: string, stats?: ScrubStats): string {
  let out = text.replace(EMAIL_RE, () => {
    if (stats) stats.emails++;
    return EMAIL_PLACEHOLDER;
  });
  out = out.replace(FR_PHONE_RE, () => {
    if (stats) stats.phones++;
    return PHONE_PLACEHOLDER;
  });
  return out;
}

/**
 * Recursively scrubs every string value of an object/array, except values
 * whose key is in `skipKeys` (URLs, ids, dates, addresses needed downstream).
 */
export function scrubDeep<T>(value: T, skipKeys: ReadonlySet<string>, stats?: ScrubStats): T {
  if (typeof value === "string") return scrubText(value, stats) as T;
  if (Array.isArray(value)) {
    return value.map((v) => scrubDeep(v, skipKeys, stats)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = skipKeys.has(k) ? v : scrubDeep(v, skipKeys, stats);
    }
    return out as T;
  }
  return value;
}

/**
 * PII policy for GDN rows (see data/sources.yml):
 * - emails and FR phone numbers removed from every free-text field;
 * - `authorId` dropped. When a `hmacSecret` is provided, a keyed pseudonym
 *   `author_ref` (HMAC-SHA256, truncated) is kept instead so events and
 *   comptes-rendus can still be deduplicated per author without storing the
 *   platform identifier;
 * - `authorZipCode` kept: commune-level granularity, no direct identification.
 */
const GDN_SKIP_KEYS = new Set([
  "id",
  "url",
  "fullAddress",
  "createdAt",
  "updatedAt",
  "startAt",
  "endAt",
  "publishedAt",
  "trashedAt",
  "reference",
  "authorZipCode",
  "authorType",
]);

export function scrubGdnRecord(
  record: Record<string, unknown>,
  { hmacSecret, stats }: { hmacSecret?: string; stats?: ScrubStats } = {},
): Record<string, unknown> {
  const { authorId, ...rest } = record;
  const scrubbed = scrubDeep(rest, GDN_SKIP_KEYS, stats);
  if (hmacSecret && typeof authorId === "string" && authorId) {
    scrubbed.author_ref = crypto
      .createHmac("sha256", hmacSecret)
      .update(authorId)
      .digest("hex")
      .slice(0, 16);
  }
  return scrubbed;
}
