import { buildServer } from "./server";
import { config, hasServiceRole } from "./config";
import { warmLocationGeocodes } from "./modules/map/locationGroups";
import { prewarmPublicCaches } from "./prewarm";

const app = buildServer();

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
