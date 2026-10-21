import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  PUBLIC_APP_URL: z.string().default("http://localhost:5173"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
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

/** Whether emails can be sent (Resend). */
export const hasEmail = config.RESEND_API_KEY.length > 0;

/** Not production (local development). */
export const isDev = process.env.NODE_ENV !== "production";
