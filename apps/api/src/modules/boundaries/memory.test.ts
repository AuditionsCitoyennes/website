import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeEnv } from "../../testing/fakes";

// The boundaries kept in memory are bounded (32 MB of the heap, weighed at
// their parsed size): past the budget the least recently used go, and one
// asked again is read back from its file, never fetched from the Géo API
// again.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-boundaries-memory-"));
fakeEnv(cacheDir);

/** A commune's contour: a ring of `points` vertices around (lng, lat). */
function contour(code: string, points: number) {
  const lng = 2 + Number(code) / 1e5;
  const lat = 46;
  const ring = Array.from({ length: points }, (_, i) => {
    const a = (2 * Math.PI * i) / points;
    return [+(lng + 0.05 * Math.cos(a)).toFixed(6), +(lat + 0.05 * Math.sin(a)).toFixed(6)];
  });
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

const upstream: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const code = /^\/communes\/(\d{5})$/.exec(url.pathname)?.[1];
  if (url.origin !== "https://geo.api.gouv.fr" || !code) throw new Error(`unexpected ${url}`);
  upstream.push(code);
  return Response.json({
    type: "Feature",
    properties: { nom: `Commune ${code}`, code },
    geometry: contour(code, 40_000),
  });
}) as typeof fetch;

const service = await import("./service");
await service.loadBoundariesCache();

after(async () => {
  await service.flushBoundariesCache();
  globalThis.fetch = realFetch;
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("past the budget the least recently used go; asked again, read back from disk", async () => {
  await service.getCommune("01001");
  const one = service.boundariesMemoryStats();
  assert.equal(one.entries, 1);
  // Weighed at about 3.5 times its JSON: the heap a parsed contour takes.
  const json = JSON.stringify(await service.getCommune("01001")).length;
  assert.ok(one.bytes >= 3 * json, `${one.bytes} for ${json} bytes of JSON`);

  const fit = Math.floor(one.maxBytes / one.bytes);
  for (let i = 2; i <= fit + 2; i++) await service.getCommune(String(1000 + i).padStart(5, "0"));
  await service.flushBoundariesCache();
  const full = service.boundariesMemoryStats();
  assert.ok(full.evictions >= 1, JSON.stringify(full));
  assert.ok(full.bytes <= full.maxBytes);
  assert.equal(full.onDisk, fit + 2);

  const fetched = upstream.length;
  const back = await service.getCommune("01001");
  assert.equal(back.properties.code, "01001");
  assert.equal(upstream.length, fetched, "read back from its file, not fetched again");
  const batch = await service.getCommunes(["01001", "01002", "01003"]);
  assert.equal(batch.features.length, 3);
  assert.equal(upstream.length, fetched);
});
