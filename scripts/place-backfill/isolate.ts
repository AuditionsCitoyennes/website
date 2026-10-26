// Imported first by generate.ts. The generator never needs the API's
// configuration (apps/api/src/config.ts, which loads a .env through dotenv and
// may find a service-role key there); should anything load it all the same,
// it stops on these values instead of reaching whatever database a .env names.
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.SUPABASE_URL = "place-backfill: no API configuration";
process.env.SUPABASE_ANON_KEY = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
