import type { FastifyInstance, FastifyRequest } from "fastify";
import { config, hasServiceRole } from "../../config";
import { byteLrus } from "../../lib/byteLru";
import { cacheFamilies, storeStats } from "../../lib/cache";
import { dbGate } from "../../lib/dbGate";
import { visitorIp } from "../../lib/visitor";
import { boundariesMemoryStats } from "../boundaries/service";
import { demTileStats } from "../dem/service";

export default async function healthRoutes(app: FastifyInstance) {
  // Also under /api: the path the site's proxy forwards, so that a check
  // through it sees what the API makes of a visitor coming that way.
  app.get("/health", health);
  app.get("/api/health", health);
}

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

async function health(req: FastifyRequest<{ Querystring: { details?: string } }>) {
  return {
    status: "ok",
    serviceRole: hasServiceRole,
    version: config.APP_VERSION,
    // Outside production: the caller's address as the rate limits read it, to
    // see at a glance whether TRUST_PROXY and the site's proxy hand it over
    // (one shared address would put every visitor under the same limit).
    ...(config.APP_ENV !== "production" && { ip: visitorIp(req) }),
    // ?details=1, on staging or with the testing tools: the process memory
    // budget (design A19) as it stands — never in production.
    ...(req.query.details === "1" &&
      (config.APP_ENV === "staging" || config.TEST_TOOLS) && { details: memoryDetails() }),
  };
}

/** Where the process memory is: the heap, the Buffers outside it, and each bounded store (MB). */
function memoryDetails() {
  const m = process.memoryUsage();
  const families = cacheFamilies().map((f) => f.stats());
  const lrus = byteLrus().map((l) => l.stats());
  const boundaries = boundariesMemoryStats();
  const store = storeStats();
  const dem = demTileStats();
  return {
    memoryMb: {
      rss: mb(m.rss),
      heapUsed: mb(m.heapUsed),
      heapTotal: mb(m.heapTotal),
      external: mb(m.external),
      arrayBuffers: mb(m.arrayBuffers),
    },
    budgetMb: {
      families: mb(families.reduce((s, f) => s + f.bytes, 0)),
      familiesMax: mb(families.reduce((s, f) => s + f.maxBytes, 0)),
      lrus: mb(lrus.reduce((s, l) => s + l.bytes, 0)),
      lrusMax: mb(lrus.reduce((s, l) => s + l.maxBytes, 0)),
    },
    families: families.map((f) => ({ ...f, mb: mb(f.bytes), maxMb: mb(f.maxBytes) })),
    lrus: lrus.map((l) => ({ ...l, mb: mb(l.bytes), maxMb: mb(l.maxBytes) })),
    boundariesOnDisk: boundaries.onDisk,
    // The static responses (boundary levels and départements) and the DEM tiles.
    staticResponses: { entries: store.entries, mb: mb(store.bytes) },
    demTiles: { entries: dem.entries, mb: mb(dem.bytes) },
    dbGate: dbGate.stats(),
  };
}
