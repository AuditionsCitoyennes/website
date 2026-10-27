import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const schema = z
  .object({
    // Where the API runs. Anything but "local" behaves as production: a server
    // whose environment was forgotten fails closed (no development shortcut).
    APP_ENV: z.enum(["local", "staging", "production"]).default("production"),
    // How emails leave: "live" to their recipients; "redirect" to
    // EMAIL_REDIRECT_TO but for EMAIL_ALLOWLIST's; "outbox" not at all, kept in the database for the
    // site's test outbox (staging: testers read what their actions sent, and
    // never email real people); "log" not at all, only written to the log.
    // Default: live in production, log elsewhere. Never outbox in production.
    EMAIL_MODE: z.enum(["live", "redirect", "outbox", "log"]).optional(),
    EMAIL_REDIRECT_TO: z.string().email().optional(),
    // Redirect mode only: recipients still reached directly — the testers' own
    // addresses, so each gets their own links. Comma-separated addresses or
    // "@domain" entries; every other recipient is redirected.
    EMAIL_ALLOWLIST: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean),
      ),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    // The version running: the commit its image was built from (the Dockerfile
    // sets it), "dev" otherwise. /health shows it, so a deploy can wait for it.
    APP_VERSION: z.string().default("dev"),
    PORT: z.coerce.number().default(3000),
    WEB_ORIGIN: z.string().default("http://localhost:5173"),
    PUBLIC_APP_URL: z.string().default("http://localhost:5173"),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    // Supabase Auth's Send Email hook ("v1,whsec_…", from the project's Auth
    // Hooks page): set, the API takes Auth's emails (sign-up confirmation,
    // password reset…) at /api/hooks/send-email and sends them like its own —
    // into the outbox on staging.
    SEND_EMAIL_HOOK_SECRET: z.string().optional().default(""),
    RESEND_API_KEY: z.string().optional().default(""),
    // The reverse proxies the API sits behind, as a comma-separated list of IP
    // addresses or CIDR ranges (in production: the proxy's addresses, e.g.
    // Cloudflare's published ranges or the private network between the proxy
    // and the container). Only X-Forwarded-* headers written by one of them are
    // believed when reading the visitor's address (rate limits of the public
    // "Témoigner" form), so a client can't spoof it. Empty when the API is
    // reached directly; "0", the old hop-count spelling, also means no proxy.
    TRUST_PROXY: z
      .string()
      .default("")
      .transform((s) => (s.trim() === "0" ? "" : s.trim())),
    // Shared with the site's own proxy (the Cloudflare Worker in front of the
    // web app, apps/web/worker): requests through it come from Cloudflare, so
    // it passes the visitor's address in X-Visitor-IP, believed only with this
    // secret (see lib/visitor). At least 32 characters; empty: no such proxy.
    PROXY_SECRET: z
      .string()
      .default("")
      .refine((s) => s === "" || s.length >= 32, "PROXY_SECRET: 32 characters at least"),
    // "true": the API answers only requests that come through the site's
    // proxy (with PROXY_SECRET), so that the gate in front of the site
    // (Cloudflare Access) cannot be walked around by calling the API's own
    // address. Still open: /health, /api/health, and the Supabase Auth hook
    // (signed with its own secret).
    REQUIRE_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Where the geocode and boundary caches live on disk (a volume, in a
    // container). Empty: the apps/api directory, as always for a developer.
    CACHE_DIR: z.string().optional().default(""),
    // The Base Adresse Nationale the geocoder asks (its /search/ and
    // /reverse/ live under it): api-adresse.data.gouv.fr, or its successor
    // https://data.geopf.fr/geocodage.
    BAN_BASE_URL: z
      .string()
      .url()
      .default("https://api-adresse.data.gouv.fr")
      .transform((s) => s.replace(/\/+$/, "")),
    // Where /api/map and the admin list read where each audition is: "db",
    // the place columns the API stores when an audition is written (map phase
    // 1); "geocoder", the geocode cache, at read time, as before (the
    // default, until a database has been placed). Without the service role,
    // or when the stored places cannot be read, "db" falls back to
    // "geocoder" (geo_units is server only).
    MAP_SOURCE: z.enum(["db", "geocoder"]).default("geocoder"),
    // "true": the placement job runs (modules/places/placementJob.ts): it
    // places, through the service role, every audition the old app wrote or
    // moved, and re-places the lieux a LOCATION_RULES change moves. Off by
    // default: a database is placed for the first time by its reviewed
    // backfill or the super admin's sweep (dry run first), never by whichever
    // API happens to boot against it. Needs MAP_SOURCE=db.
    PLACEMENT_JOB: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // "true": the testing tools (staging, local), such as ?source=geocoder on
    // /api/map and the admin list, which serves the other build. Refused in
    // production.
    TEST_TOOLS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .refine((c) => c.EMAIL_MODE !== "redirect" || c.EMAIL_REDIRECT_TO, {
    message: "EMAIL_MODE=redirect needs EMAIL_REDIRECT_TO",
    path: ["EMAIL_REDIRECT_TO"],
  })
  .refine((c) => !c.REQUIRE_PROXY || c.PROXY_SECRET, {
    message: "REQUIRE_PROXY=true needs PROXY_SECRET",
    path: ["PROXY_SECRET"],
  })
  // The outbox shows every email to whoever opens the site: real people's
  // emails must never land there.
  .refine((c) => !(c.EMAIL_MODE === "outbox" && c.APP_ENV === "production"), {
    message: "EMAIL_MODE=outbox is refused in production",
    path: ["EMAIL_MODE"],
  })
  .refine((c) => !(c.TEST_TOOLS && c.APP_ENV === "production"), {
    message: "TEST_TOOLS=true is refused in production",
    path: ["TEST_TOOLS"],
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Configuration invalide:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

/** The apps/api directory: src/.. for tsx, dist/.. once bundled. */
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  ...parsed.data,
  /** The directory the geocode and boundary caches are kept in (CACHE_DIR, else apps/api). */
  CACHE_DIR: parsed.data.CACHE_DIR ? resolve(parsed.data.CACHE_DIR) : APP_DIR,
  /** Static data shipped with the API (apps/api/data): the france-geojson levels. */
  DATA_DIR: join(APP_DIR, "data"),
};

/** Whether privileged operations (analysis, emails, role mgmt) are available. */
export const hasServiceRole = config.SUPABASE_SERVICE_ROLE_KEY.length > 0;

/**
 * Where /api/map and the admin list read places from: MAP_SOURCE, but the
 * geocode cache without the service role (geo_units is server only). The
 * stored build also falls back to the geocoder's, per request, when the
 * place columns or geo_units cannot be read (a database without them yet).
 */
export const mapSource: "db" | "geocoder" =
  config.MAP_SOURCE === "db" && hasServiceRole ? "db" : "geocoder";

/** Local development, and nothing else: the only place shortcuts are allowed. */
export const isDev = config.APP_ENV === "local";

const databaseHost = new URL(config.SUPABASE_URL).hostname;

/** Whether SUPABASE_URL is a stack on this machine (`supabase start`, tests), not a hosted project. */
export const localDatabase =
  ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(databaseHost) ||
  databaseHost.endsWith(".localhost") ||
  databaseHost.endsWith(".test");

/** How emails leave (see EMAIL_MODE above). */
export const emailMode = config.EMAIL_MODE ?? (config.APP_ENV === "production" ? "live" : "log");

/** Whether emails go out (or, in log and outbox modes, are accounted for without a Resend key). */
export const hasEmail =
  emailMode === "log" ||
  (emailMode === "outbox" ? hasServiceRole : config.RESEND_API_KEY.length > 0);
