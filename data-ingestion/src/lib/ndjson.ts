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
import readline from "node:readline";

export async function* readNdjson<T = unknown>(filePath: string): AsyncGenerator<T> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed) as T;
  }
}

export interface NdjsonWriter {
  write(obj: unknown): Promise<void>;
  close(): Promise<void>;
  count(): number;
}

export function createNdjsonWriter(filePath: string, { append = false } = {}): NdjsonWriter {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: append ? "a" : "w", encoding: "utf8" });
  let written = 0;
  return {
    async write(obj: unknown) {
      written++;
      if (!stream.write(`${JSON.stringify(obj)}\n`)) {
        await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
      }
    },
    close: () =>
      new Promise((resolve, reject) =>
        stream.end((err?: Error) => (err ? reject(err) : resolve())),
      ),
    count: () => written,
  };
}
