import "dotenv/config";
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
  // How many reverse proxies stand in front of the API (production: usually 1).
  // Their hops are taken off X-Forwarded-For to find the visitor's address —
  // only theirs: the entries a client writes itself are never trusted. 0 when
  // the API is reached directly.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Configuration invalide:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/** Whether privileged operations (analysis, emails, role mgmt) are available. */
export const hasServiceRole = config.SUPABASE_SERVICE_ROLE_KEY.length > 0;

/** Whether emails can be sent (Resend). */
export const hasEmail = config.RESEND_API_KEY.length > 0;

/** Not production (local development). */
export const isDev = process.env.NODE_ENV !== "production";
