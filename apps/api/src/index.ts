import { buildServer } from "./server";
import { config, hasServiceRole } from "./config";
import { warmLocationGeocodes } from "./services/locations";

const app = buildServer();

// Warm the location geocode cache in the background on boot.
void warmLocationGeocodes();

if (!hasServiceRole) {
  app.log.warn(
    "SUPABASE_SERVICE_ROLE_KEY non défini — les opérations privilégiées (analyse IA, emails, gestion des rôles) seront indisponibles.",
  );
}

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
