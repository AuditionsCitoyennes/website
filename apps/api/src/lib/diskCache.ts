// What the geocode cache uses: a write a reader can never catch half done,
// and a read that treats "no file" like "no cache".

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write `data` to `path` atomically: the bytes go to a temporary file beside
 * it, renamed over it once they are all there (rename is atomic on POSIX). A
 * crash mid-write leaves a `.tmp` file at worst — never a truncated cache
 * that the next boot reads as empty and rebuilds from upstream.
 */
export async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * The JSON in `path`, or `undefined` when there is no such file or what is
 * there is not JSON (a file an older version wrote by halves). Any other
 * failure (permissions…) is thrown.
 */
export async function readJson<T>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
