import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeAtomic } from "./diskCache";

// `node --import tsx --test src/lib/diskCache.test.ts` (npm test in apps/api).

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ac-diskcache-"));
}

test("writeAtomic creates the directory, writes the bytes and leaves no temporary file", async () => {
  const dir = await scratch();
  try {
    const file = join(dir, "nested", "cache.json");
    await writeAtomic(file, JSON.stringify({ a: 1 }));
    assert.equal(await readFile(file, "utf8"), '{"a":1}');
    assert.deepEqual(await readdir(join(dir, "nested")), ["cache.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent writeAtomic calls each leave the file whole", async () => {
  const dir = await scratch();
  try {
    const file = join(dir, "cache.json");
    const bodies = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({ i, pad: "x".repeat(50_000) }),
    );
    await Promise.all(bodies.map((b) => writeAtomic(file, b)));
    // One of the writes, intact — never a mix of two.
    const final = await readFile(file, "utf8");
    assert.ok(bodies.includes(final));
    assert.deepEqual(await readdir(dir), ["cache.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJson: undefined for a missing file and for one that is not JSON", async () => {
  const dir = await scratch();
  try {
    assert.equal(await readJson(join(dir, "missing.json")), undefined);
    await writeAtomic(join(dir, "half.json"), '{"a":');
    assert.equal(await readJson(join(dir, "half.json")), undefined);
    await writeAtomic(join(dir, "whole.json"), '{"a":1}');
    assert.deepEqual(await readJson(join(dir, "whole.json")), { a: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
