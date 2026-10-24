import { buildServer } from "./server";
import { config, emailMode, hasServiceRole } from "./config";
import { loadBoundariesCache } from "./modules/boundaries/service";
import { loadGeocodeCache } from "./modules/geo/geocode";
import { warmLocationGeocodes } from "./modules/map/locationGroups";
import { prewarmPublicCaches } from "./prewarm";

const app = buildServer();
app.log.info({ env: config.APP_ENV, version: config.APP_VERSION, emailMode }, "starting");

// The two disk caches are read before anything can ask for them — the warm
// pass and the prewarm below, the first requests once listening — so that no
// lieu already geocoded is queried again and no commune already fetched is
// fetched again on a cold start. (The boundaries read also splits the one-file
// cache of earlier versions into its directory, the one time it finds it.)
const [geocode, boundaries] = await Promise.all([loadGeocodeCache(), loadBoundariesCache()]);
app.log.info(
  { geocode: geocode.entries, boundaries: boundaries.keys, migrated: boundaries.migrated },
  "disk caches loaded",
);

// Warm the location geocode cache, then the public read caches, in the
// background on boot (the second needs the first's persisted entries, which
// buildLocationGroups awaits itself).
void warmLocationGeocodes();
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
