import "dotenv/config";
import { dirname, join } from "node:path";
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
  })
  .refine((c) => c.EMAIL_MODE !== "redirect" || c.EMAIL_REDIRECT_TO, {
    message: "EMAIL_MODE=redirect needs EMAIL_REDIRECT_TO",
    path: ["EMAIL_REDIRECT_TO"],
  })
  // The outbox shows every email to whoever opens the site: real people's
  // emails must never land there.
  .refine((c) => !(c.EMAIL_MODE === "outbox" && c.APP_ENV === "production"), {
    message: "EMAIL_MODE=outbox is refused in production",
    path: ["EMAIL_MODE"],
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Configuration invalide:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  /** The apps/api directory, where the geocode and boundary caches are kept on disk. */
  CACHE_DIR: join(dirname(fileURLToPath(import.meta.url)), ".."),
};

/** Whether privileged operations (analysis, emails, role mgmt) are available. */
export const hasServiceRole = config.SUPABASE_SERVICE_ROLE_KEY.length > 0;

/** Local development, and nothing else: the only place shortcuts are allowed. */
export const isDev = config.APP_ENV === "local";

/** How emails leave (see EMAIL_MODE above). */
export const emailMode = config.EMAIL_MODE ?? (config.APP_ENV === "production" ? "live" : "log");

/** Whether emails go out (or, in log and outbox modes, are accounted for without a Resend key). */
export const hasEmail =
  emailMode === "log" ||
  (emailMode === "outbox" ? hasServiceRole : config.RESEND_API_KEY.length > 0);
