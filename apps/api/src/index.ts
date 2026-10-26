import { buildServer } from "./server";
import { config, emailMode, hasServiceRole, mapSource } from "./config";
import { loadBoundariesCache } from "./modules/boundaries/service";
import { loadGeocodeCache } from "./modules/geo/geocode";
import { warmLocationGeocodes } from "./modules/map/locationGroups";
import { startPlacementJob } from "./modules/places/placementJob";
import { prewarmPublicCaches } from "./prewarm";

const app = buildServer();
app.log.info(
  {
    env: config.APP_ENV,
    version: config.APP_VERSION,
    emailMode,
    mapSource,
    placementJob: config.PLACEMENT_JOB,
  },
  "starting",
);
if (config.MAP_SOURCE === "db" && mapSource !== "db") {
  app.log.warn("MAP_SOURCE=db without SUPABASE_SERVICE_ROLE_KEY: the map is built by the geocoder");
}

// The two disk caches are read before anything can ask for them — the
// placement job and the prewarm below, the first requests once listening — so
// that no lieu already geocoded is queried again and no commune already
// fetched is fetched again on a cold start. (The boundaries read also splits
// the one-file cache of earlier versions into its directory, the one time it
// finds it.)
const [geocode, boundaries] = await Promise.all([loadGeocodeCache(), loadBoundariesCache()]);
app.log.info(
  { geocode: geocode.entries, boundaries: boundaries.keys, migrated: boundaries.migrated },
  "disk caches loaded",
);

// Auditions not placed yet are placed by the job (10 s after boot, then every
// 10 minutes) where PLACEMENT_JOB turns it on. The geocoder's build of the
// map warms its cache itself.
startPlacementJob(app.log);
if (mapSource === "geocoder") void warmLocationGeocodes();
void prewarmPublicCaches(app.log);

if (!hasServiceRole) {
  app.log.warn(
    "SUPABASE_SERVICE_ROLE_KEY non défini — les opérations privilégiées (analyse IA, emails, gestion des rôles) seront indisponibles.",
  );
}

app.listen({ port: config.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// A deploy stops the container with SIGTERM: stop taking requests, let the
// ones in flight finish, then exit — or give up after 10 s rather than hang.
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    setTimeout(() => {
      app.log.error("shutdown took over 10 s, exiting");
      process.exit(1);
    }, 10_000).unref();
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  });
}
