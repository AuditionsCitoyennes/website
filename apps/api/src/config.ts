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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Configuration invalide:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/** Whether privileged operations (analysis, emails, role mgmt) are available. */
export const hasServiceRole = config.SUPABASE_SERVICE_ROLE_KEY.length > 0;
