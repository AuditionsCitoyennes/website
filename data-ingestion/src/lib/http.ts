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
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const USER_AGENT = "AuditionsCitoyennes-ingestion/1.0 (+https://github.com/AuditionsCitoyennes)";

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  { retries = 3, backoffMs = 1500 }: { retries?: number; backoffMs?: number } = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
      });
      // Retry server-side errors and rate limiting; 4xx (other than 429) are final.
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Streams a URL to disk and returns the sha256 + size of what was written. */
export async function downloadToFile(
  url: string,
  destPath: string,
): Promise<{ sha256: string; bytes: number }> {
  const res = await fetchWithRetry(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const body = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  await pipeline(body, fs.createWriteStream(tmpPath));
  fs.renameSync(tmpPath, destPath);
  return { sha256: hash.digest("hex"), bytes };
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/** Token-bucket limiter: at most `perSecond` calls per rolling second. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(private perSecond: number) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 1000);
      if (this.stamps.length < this.perSecond) {
        this.stamps.push(now);
        return;
      }
      const waitMs = 1000 - (now - this.stamps[0]) + 5;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
